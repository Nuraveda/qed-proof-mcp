import { describe, expect, it } from "vitest";
import { handleHttp } from "../src/http.js";
import { fakeApi, vector } from "./helpers.js";

const MCP = "https://mcp.qedproof.site/mcp";
const HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const init = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(MCP, {
    method: "POST",
    headers: { ...HEADERS, Authorization: "Bearer qed_sk_test", ...headers },
    body: JSON.stringify(body),
  });

describe("the hosted handler", () => {
  it("answers /healthz separately from /mcp", async () => {
    const r = await handleHttp(new Request("https://mcp.qedproof.site/healthz"));
    expect(r.status).toBe(200);
  });

  it("requires a Bearer key on /mcp", async () => {
    const r = await handleHttp(new Request(MCP, { method: "POST", headers: HEADERS, body: JSON.stringify(init) }));
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  it("rejects a foreign Origin (DNS-rebinding protection) and allows a listed one", async () => {
    expect((await handleHttp(post(init, { Origin: "https://evil.example" }))).status).toBe(403);
    const ok = await handleHttp(post(init, { Origin: "https://qedproof.site" }), {
      allowedOrigins: ["https://qedproof.site"],
      log: () => {},
    });
    expect(ok.status).toBe(200);
  });

  it("is stateless: GET and DELETE on /mcp are 405", async () => {
    for (const method of ["GET", "DELETE"]) {
      expect((await handleHttp(new Request(MCP, { method, headers: { Authorization: "Bearer k" } }))).status).toBe(405);
    }
  });

  it("refuses the origin path unless CloudFront's edge secret is present", async () => {
    expect((await handleHttp(post(init), { edgeSecret: "s3cret" })).status).toBe(403);
    expect((await handleHttp(post(init, { "x-qed-edge": "s3cret" }), { edgeSecret: "s3cret", log: () => {} })).status).toBe(200);
  });

  it("initializes and lists tools over JSON, without a session", async () => {
    const r = await handleHttp(post(init), { log: () => {} });
    expect(r.status).toBe(200);
    expect(r.headers.get("mcp-session-id")).toBeNull();
    const j = (await r.json()) as { result: { serverInfo: { name: string } } };
    expect(j.result.serverInfo.name).toBe("qed-proof");
  });

  it("serves get_log_head over HTTP and verifies the head's signature", async () => {
    const api = fakeApi({
      "GET /v1/log/head": () => [200, { tree_head: JSON.parse(vector("036-tree-head-valid.json")), anchor: null }],
      "GET /.well-known/poaw-keys.json": () => [200, vector("keys.json")],
    });
    const call = { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_log_head", arguments: {} } };
    const r = await handleHttp(post(call, { Authorization: "Bearer qed_sk_k" }), {
      fetch: api.fetch,
      apiBaseUrl: "https://api.example.test",
      log: () => {},
    });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { result: { structuredContent: { signature_valid: boolean } } };
    expect(j.result.structuredContent.signature_valid).toBe(true);
  });

  it("passes the caller's key to the API for tool calls and logs neither the key nor the arguments", async () => {
    const api = fakeApi({ "GET /v1/claims/c1": () => [200, { claim_id: "c1", state: "decided", receipt_id: "r1", verdict: "failed" }] });
    const lines: Record<string, unknown>[] = [];
    const call = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_verdict", arguments: { claim_id: "c1" } } };
    const r = await handleHttp(post(call, { Authorization: "Bearer qed_sk_secret_value" }), {
      fetch: api.fetch,
      apiBaseUrl: "https://api.example.test",
      log: (l) => lines.push(l),
    });
    expect(r.status).toBe(200);
    expect(api.calls[0].auth).toBe("Bearer qed_sk_secret_value");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "mcp.request", method: "tools/call", tool: "get_verdict", status: 200 });
    expect(JSON.stringify(lines)).not.toMatch(/qed_sk_secret_value|c1/);
  });

  it("returns a JSON-RPC parse error for a non-JSON body", async () => {
    const r = await handleHttp(new Request(MCP, { method: "POST", headers: { ...HEADERS, Authorization: "Bearer k" }, body: "{not json" }));
    expect(r.status).toBe(400);
  });

  it("refuses an oversized body without buffering it (#142)", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(64 * 1024).fill(0x20));
      },
    });
    const req = new Request(MCP, {
      method: "POST",
      headers: { ...HEADERS, Authorization: "Bearer qed_sk_test" },
      body: endless,
      // @ts-expect-error duplex is required for a streamed body in Node's fetch
      duplex: "half",
    });
    const r = await handleHttp(req, { log: () => {} });
    expect(r.status).toBe(413);
    expect(pulled).toBeLessThan(10);
  });

  it("refuses a declared Content-Length over the cap before reading", async () => {
    const r = await handleHttp(post(init, { "Content-Length": String(10 * 1024 * 1024) }), { log: () => {} });
    expect(r.status).toBe(413);
  });
});

describe("OAuth protected resource (lane mcp-oauth)", () => {
  const oauth = { resourceUrl: MCP, issuer: "https://api.qedproof.site" };
  const PRM = "https://mcp.qedproof.site/.well-known/oauth-protected-resource";
  const who = (over: Record<string, unknown> = {}) => ({
    "GET /v1/whoami": () => [200, { workspace_id: "w", kind: "key", scopes: null, audience: null, ...over }] as [number, unknown],
  });
  const opts = (api: ReturnType<typeof fakeApi>) => ({ oauth, fetch: api.fetch, log: () => {}, apiBaseUrl: "https://api.example.test" });
  const text = async (r: Response) => await r.text();

  it("serves its metadata at the root and the /mcp path, and nowhere else", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const r = await handleHttp(new Request(`https://mcp.qedproof.site${path}`), { oauth });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({
        resource: MCP,
        authorization_servers: ["https://api.qedproof.site"],
        scopes_supported: ["claims:submit", "claims:read"],
        bearer_methods_supported: ["header"],
      });
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
    }
    expect((await handleHttp(new Request(`${PRM}/other`), { oauth })).status).toBe(404);
    expect((await handleHttp(new Request(PRM, { method: "POST" }), { oauth })).status).toBe(405);
    // without OAuth configured (a self-host), there is no such page
    expect((await handleHttp(new Request(PRM))).status).toBe(404);
  });

  it("a missing credential gets 401 pointing at the metadata, which is what starts the client's sign-in", async () => {
    const r = await handleHttp(new Request(MCP, { method: "POST", headers: HEADERS, body: JSON.stringify(init) }), { oauth });
    expect(r.status).toBe(401);
    const h = r.headers.get("www-authenticate") ?? "";
    expect(h).toMatch(/^Bearer resource_metadata="https:\/\/mcp\.qedproof\.site\/\.well-known\/oauth-protected-resource\/mcp"/);
    expect(h).toContain('scope="claims:read claims:submit"');
    expect(h).not.toContain("error=");
    expect(r.headers.get("x-qed-challenge")).toBe(h); // the hosted edge restores WWW-Authenticate from this (Function URLs rename it)
  });

  it("checks every credential with the API before using it, and caches a good answer", async () => {
    const api = fakeApi(who());
    const { clearCredentialCache } = await import("../src/http.js");
    clearCredentialCache();
    for (let i = 0; i < 3; i++) expect((await handleHttp(post(init), opts(api))).status).toBe(200);
    expect(api.calls.filter((c) => c.url.endsWith("/v1/whoami"))).toHaveLength(1);
    expect(api.calls[0]?.auth).toBe("Bearer qed_sk_test");
  });

  it("an unknown or revoked credential is 401 invalid_token, so the client refreshes or re-signs in, and it is not cached", async () => {
    const api = fakeApi({ "GET /v1/whoami": () => [401, { detail: "invalid or missing API key" }] });
    const { clearCredentialCache } = await import("../src/http.js");
    clearCredentialCache();
    for (let i = 0; i < 2; i++) {
      const r = await handleHttp(post(init), opts(api));
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toContain('error="invalid_token"');
    }
    expect(api.calls).toHaveLength(2);
  });

  it("an OAuth token issued for some other resource is refused", async () => {
    const { clearCredentialCache } = await import("../src/http.js");
    for (const [audience, status] of [
      ["https://other.example.test/mcp", 401],
      [null, 401],
      [MCP, 200],
    ] as const) {
      clearCredentialCache();
      const api = fakeApi(who({ kind: "oauth", scopes: ["claims:read"], audience }));
      expect((await handleHttp(post(init), opts(api))).status, String(audience)).toBe(status);
    }
  });

  it("fails closed when the API can't be reached or errors: 503, never a pass-through", async () => {
    const { clearCredentialCache } = await import("../src/http.js");
    clearCredentialCache();
    const boom: typeof fetch = async () => {
      throw new Error("network down");
    };
    expect((await handleHttp(post(init), { oauth, fetch: boom, log: () => {} })).status).toBe(503);
    const api = fakeApi({ "GET /v1/whoami": () => [500, { detail: "x" }] });
    const r = await handleHttp(post(init), opts(api));
    expect(r.status).toBe(503);
    expect(await text(r)).not.toContain("qed_sk_test");
  });

  it("never reads a token from the URL", async () => {
    const api = fakeApi(who());
    const r = await handleHttp(
      new Request(`${MCP}?access_token=qed_sk_test&token=qed_sk_test&key=qed_sk_test`, {
        method: "POST",
        headers: HEADERS,
        body: JSON.stringify(init),
      }),
      opts(api),
    );
    expect(r.status).toBe(401);
    expect(api.calls).toHaveLength(0);
  });

  it("without OAuth configured it behaves as before: no whoami call, the key goes straight through", async () => {
    const api = fakeApi({});
    expect((await handleHttp(post(init), { fetch: api.fetch, log: () => {} })).status).toBe(200);
    expect(api.calls).toHaveLength(0);
  });
});
