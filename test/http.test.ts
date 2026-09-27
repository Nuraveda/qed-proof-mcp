import { describe, expect, it } from "vitest";
import { handleHttp } from "../src/http.js";
import { fakeApi } from "./helpers.js";

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
});
