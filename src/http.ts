/**
 * The hosted server's request handler: stateless Streamable HTTP with JSON responses (no SSE, no sessions), as a
 * web-standard `Request -> Response` function, so the same code runs in a Lambda, in tests, or behind any server.
 *
 * - `GET /healthz` is separate from `/mcp` (hosts poll it).
 * - `/mcp` needs `Authorization: Bearer <workspace API key>`. The key is passed through to the QED Proof API for this
 *   one request and never stored or logged. The API's own per-key limits and workspace scoping apply.
 * - A request that carries an `Origin` must carry an allowed one (MCP spec MUST, against DNS rebinding). Server-to-
 *   server clients send no Origin and are unaffected.
 * - One log line per request: the JSON-RPC method, the tool name, the status and the latency. Never the key, the
 *   target or the params.
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { QedApi } from "./api.js";
import { createServer } from "./tools.js";

export type HttpOptions = {
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
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

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

export async function handleHttp(req: Request, opts: HttpOptions = {}): Promise<Response> {
  const started = Date.now();
  const url = new URL(req.url);
  const log = opts.log ?? ((l) => console.log(JSON.stringify(l)));

  if (opts.edgeSecret && !timingSafeEqual(req.headers.get("x-qed-edge") ?? "", opts.edgeSecret)) {
    return json(403, { error: "forbidden" });
  }
  if (url.pathname === "/healthz") return json(200, { ok: true });
  if (url.pathname !== "/mcp") return json(404, { error: "not found" });

  const origin = req.headers.get("origin");
  if (origin && !(opts.allowedOrigins ?? []).includes(origin)) return json(403, { error: "origin not allowed" });

  // Stateless: there's no session to resume (GET) or end (DELETE).
  if (req.method !== "POST") return json(405, { error: "method not allowed" }, { Allow: "POST" });

  const auth = req.headers.get("authorization") ?? "";
  const [scheme, key] = auth.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !key || key.length > 256) {
    return json(
      401,
      { error: "a QED Proof workspace API key is required: Authorization: Bearer <key>" },
      { "WWW-Authenticate": 'Bearer realm="qed-proof"' },
    );
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
