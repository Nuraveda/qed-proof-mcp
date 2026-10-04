/**
 * The hosted server's request handler: stateless Streamable HTTP with JSON responses (no SSE, no sessions), as a
 * web-standard `Request -> Response` function, so the same code runs in a Lambda, in tests, or behind any server.
 *
 * - `GET /healthz` is separate from `/mcp` (hosts poll it).
 * - `/mcp` needs `Authorization: Bearer <workspace API key>`. The key is passed through to the QED Proof API for this
 *   one request and never stored or logged. The API's own per-key limits and workspace scoping apply.
 * - With `oauth` configured (the hosted service), this is also an OAuth protected resource (MCP authorization, RFC 9728):
 *   it serves its metadata, answers a missing or invalid credential with 401 + `WWW-Authenticate: Bearer resource_metadata=…`
 *   (which is what starts a client's sign-in), and checks every credential with the API (`GET /v1/whoami`, cached for a
 *   minute) before using it, including that an OAuth token was issued for THIS server. A token in the URL is never read.
 * - A request that carries an `Origin` must carry an allowed one (MCP spec MUST, against DNS rebinding). Server-to-
 *   server clients send no Origin and are unaffected.
 * - One log line per request: the JSON-RPC method, the tool name, the status and the latency. Never the key, the
 *   target or the params.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { DEFAULT_API, QedApi } from "./api.js";
import { createServer } from "./tools.js";

export type OAuthOptions = {
  /** This server's own URL, e.g. https://mcp.qedproof.site/mcp: the audience OAuth tokens must have been issued for. */
  resourceUrl: string;
  /** The authorization server's issuer, e.g. https://api.qedproof.site. */
  issuer: string;
  scopes?: string[];
};

export type HttpOptions = {
  oauth?: OAuthOptions;
  apiBaseUrl?: string;
  /** Origins allowed to call /mcp from a browser. Requests without an Origin header are always allowed. */
  allowedOrigins?: string[];
  /** When set, requests must carry `x-qed-edge: <secret>` (set by CloudFront), so the origin can't be called around the edge. */
  edgeSecret?: string;
  fetch?: typeof fetch;
  log?: (line: Record<string, unknown>) => void;
};

const MAX_BODY = 256 * 1024;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    // A Lambda Function URL renames WWW-Authenticate to x-amzn-remapped-www-authenticate, which no client reads. The same
    // challenge goes out as X-Qed-Challenge too, and the hosted edge turns that back into WWW-Authenticate.
    headers: {
      "Content-Type": "application/json",
      ...headers,
      ...(headers["WWW-Authenticate"] ? { "X-Qed-Challenge": headers["WWW-Authenticate"] } : {}),
    },
  });

/** The body as text, or null once it passes `limit` bytes. Reads the stream and stops early, so a huge body is never buffered. */
async function readCapped(req: Request, limit: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const CREDENTIAL_TTL_MS = 60_000;
const CREDENTIAL_CACHE_MAX = 1000;
const credentialCache = new Map<string, number>();
export const clearCredentialCache = () => credentialCache.clear();

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Is this bearer token live, and meant for this server? Only a positive answer is cached, and only its hash is kept. */
async function checkCredential(token: string, oauth: OAuthOptions, opts: HttpOptions): Promise<"ok" | "invalid" | "unavailable"> {
  const id = await sha256Hex(token);
  const now = Date.now();
  const hit = credentialCache.get(id);
  if (hit !== undefined && hit > now) return "ok";
  try {
    const f = opts.fetch ?? globalThis.fetch;
    const res = await f(`${(opts.apiBaseUrl ?? DEFAULT_API).replace(/\/+$/, "")}/v1/whoami`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401 || res.status === 403) return "invalid";
    if (!res.ok) return "unavailable";
    const who = (await res.json()) as { kind?: string; audience?: string | null };
    if (who.kind === "oauth" && who.audience !== oauth.resourceUrl) return "invalid"; // issued for some other resource
  } catch {
    return "unavailable"; // fail closed: never pass an unchecked credential through
  }
  if (credentialCache.size >= CREDENTIAL_CACHE_MAX) credentialCache.clear();
  credentialCache.set(id, now + CREDENTIAL_TTL_MS);
  return "ok";
}

const metadataUrl = (o: OAuthOptions) => {
  const u = new URL(o.resourceUrl);
  return `${u.origin}/.well-known/oauth-protected-resource${u.pathname === "/" ? "" : u.pathname}`;
};

export async function handleHttp(req: Request, opts: HttpOptions = {}): Promise<Response> {
  const started = Date.now();
  const url = new URL(req.url);
  const log = opts.log ?? ((l) => console.log(JSON.stringify(l)));

  if (opts.edgeSecret && !timingSafeEqual(req.headers.get("x-qed-edge") ?? "", opts.edgeSecret)) {
    return json(403, { error: "forbidden" });
  }
  if (url.pathname === "/healthz") return json(200, { ok: true });
  if (opts.oauth && url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
    // RFC 9728. Served at the root path too, because some clients (ChatGPT) look there first. Public, so any origin may read it.
    const rest = url.pathname.slice("/.well-known/oauth-protected-resource".length);
    if (rest !== "" && rest !== new URL(opts.oauth.resourceUrl).pathname) return json(404, { error: "not found" });
    if (req.method !== "GET") return json(405, { error: "method not allowed" }, { Allow: "GET" });
    return json(
      200,
      {
        resource: opts.oauth.resourceUrl,
        authorization_servers: [opts.oauth.issuer],
        scopes_supported: opts.oauth.scopes ?? ["claims:submit", "claims:read"],
        bearer_methods_supported: ["header"],
        resource_name: "QED Proof",
        resource_documentation: "https://docs.qedproof.site/mcp-server",
      },
      { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" },
    );
  }
  if (url.pathname !== "/mcp") return json(404, { error: "not found" });

  const origin = req.headers.get("origin");
  if (origin && !(opts.allowedOrigins ?? []).includes(origin)) return json(403, { error: "origin not allowed" });

  // Stateless: there's no session to resume (GET) or end (DELETE).
  if (req.method !== "POST") return json(405, { error: "method not allowed" }, { Allow: "POST" });

  // 401 starts a client's OAuth sign-in when it carries `resource_metadata`; without OAuth it just names the key.
  const challenge = (error?: string) =>
    opts.oauth
      ? `Bearer resource_metadata="${metadataUrl(opts.oauth)}", scope="${(opts.oauth.scopes ?? ["claims:read", "claims:submit"]).join(" ")}"${error ? `, error="${error}"` : ""}`
      : 'Bearer realm="qed-proof"';
  const auth = req.headers.get("authorization") ?? "";
  const [scheme, key] = auth.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !key || key.length > 256) {
    return json(
      401,
      { error: "authorization required: sign in with OAuth, or send a QED Proof workspace API key as Authorization: Bearer <key>" },
      { "WWW-Authenticate": challenge() },
    );
  }
  if (opts.oauth) {
    const verdict = await checkCredential(key, opts.oauth, opts);
    if (verdict === "invalid")
      return json(401, { error: "invalid or expired credential" }, { "WWW-Authenticate": challenge("invalid_token") });
    if (verdict === "unavailable") return json(503, { error: "could not check the credential, try again" }, { "Retry-After": "5" });
  }

  const text = await readCapped(req, MAX_BODY);
  if (text === null) return json(413, { error: "request body too large" });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null });
  }

  const api = new QedApi({ apiKey: key, baseUrl: opts.apiBaseUrl, fetch: opts.fetch });
  const server = createServer({ api });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  let res: Response;
  try {
    res = await transport.handleRequest(new Request(req.url, { method: "POST", headers: req.headers, body: text }), { parsedBody: body });
  } finally {
    await transport.close();
    await server.close();
  }
  const first = (Array.isArray(body) ? body[0] : body) as { method?: string; params?: { name?: string } } | undefined;
  log({
    event: "mcp.request",
    method: first?.method,
    tool: first?.method === "tools/call" ? first.params?.name : undefined,
    status: res.status,
    ms: Date.now() - started,
  });
  return res;
}
