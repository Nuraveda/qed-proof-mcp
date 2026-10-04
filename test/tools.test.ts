import { describe, expect, it } from "vitest";
import { PROFILES } from "../src/generated/spec.js";
import { connect, fakeApi, text, vector } from "./helpers.js";

const KEY = "qed_sk_test_0000000000000000";
const EXPECTED = ["get_log_head", "get_receipt", "get_verdict", "list_claims", "list_connections", "submit_claim", "verify_receipt"];

describe("tools/list", () => {
  it("exposes exactly the seven tools", async () => {
    const c = await connect({ apiKey: KEY, fetch: fakeApi({}).fetch });
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED);
  });

  it("gives every tool the Directory's required annotations and a title, and names ≤ 64 chars", async () => {
    const c = await connect({ apiKey: KEY, fetch: fakeApi({}).fetch });
    for (const t of (await c.listTools()).tools) {
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.title ?? t.annotations?.title, `${t.name} title`).toBeTruthy();
      expect(typeof t.annotations?.readOnlyHint, `${t.name} readOnlyHint`).toBe("boolean");
      expect(typeof t.annotations?.destructiveHint, `${t.name} destructiveHint`).toBe("boolean");
      expect(t.inputSchema.type).toBe("object");
    }
  });

  it("marks only submit_claim as a write, and nothing as destructive", async () => {
    const c = await connect({ apiKey: KEY, fetch: fakeApi({}).fetch });
    const tools = (await c.listTools()).tools;
    expect(tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name)).toEqual(["submit_claim"]);
    expect(tools.filter((t) => t.annotations?.destructiveHint)).toEqual([]);
  });

  it("never tells the model how to behave (Directory review: prompt-injection rule)", async () => {
    const c = await connect({ apiKey: KEY, fetch: fakeApi({}).fetch });
    for (const t of (await c.listTools()).tools) {
      expect(t.description, t.name).not.toMatch(
        /\b(you must|you should|always call|never call|ignore (previous|prior)|before doing anything)\b/i,
      );
    }
  });

  it("advertises exactly the documented verifier profiles, and no other action", async () => {
    const c = await connect({ apiKey: KEY, fetch: fakeApi({}).fetch });
    const submit = (await c.listTools()).tools.find((t) => t.name === "submit_claim");
    const advertised = [...(submit?.description ?? "").matchAll(/^- ([a-z0-9]+(?:\.[a-z0-9_]+){2}):/gm)].map((m) => m[1]).sort();
    expect(advertised).toEqual(PROFILES.map((p) => p.action).sort());
    expect(advertised.length).toBeGreaterThan(0);
  });

  it("offers no way to connect, disconnect, or manage keys", async () => {
    const c = await connect({ apiKey: KEY, fetch: fakeApi({}).fetch });
    for (const t of (await c.listTools()).tools) expect(t.name).not.toMatch(/connect_|disconnect|revoke|create_key|delete/);
  });
});

describe("auth failures become tool errors with a next step", () => {
  it("no key configured", async () => {
    const api = fakeApi({});
    const c = await connect({ fetch: api.fetch });
    const r = await c.callTool({ name: "get_verdict", arguments: { claim_id: "c1" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/No QED Proof API key is configured.*QED_API_KEY/);
    expect(api.calls).toEqual([]);
  });

  it("a key the API rejects", async () => {
    const c = await connect({
      apiKey: "bad",
      fetch: fakeApi({ "GET /v1/claims/c1": () => [401, { detail: "invalid or missing API key" }] }).fetch,
    });
    const r = await c.callTool({ name: "get_verdict", arguments: { claim_id: "c1" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/rejected the API key \(401\)/);
  });

  it("the Free cap refusal (402) says no receipt was created", async () => {
    const c = await connect({
      apiKey: KEY,
      fetch: fakeApi({ "POST /v1/claims": () => [402, { detail: "This workspace has used its 1,000 receipts." }] }).fetch,
    });
    const r = await c.callTool({ name: "submit_claim", arguments: { action: "github.commit.push", target: "o/r", params: {} } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/refused before it was accepted \(402\).*No receipt was created/s);
  });

  it("rate limiting passes Retry-After through", async () => {
    const c = await connect({
      apiKey: KEY,
      fetch: fakeApi({ "GET /v1/claims/c1": () => [429, { detail: "rate limit exceeded" }, { "Retry-After": "5" }] }).fetch,
    });
    expect(text(await c.callTool({ name: "get_verdict", arguments: { claim_id: "c1" } }))).toMatch(/Retry after 5 seconds/);
  });
});

describe("round trip against a mocked API: submit → verdict → receipt → verify", () => {
  const RECEIPT = vector("018-inclusion-middle-leaf.json");
  const KEYS = vector("keys.json");
  const api = fakeApi({
    "POST /v1/claims": () => [202, { claim_id: "c1", created: true, state: "queued", attempts: 1, receipt_id: null, verdict: null }],
    "GET /v1/claims/c1": () => [200, { claim_id: "c1", state: "decided", attempts: 2, receipt_id: "rcpt_1", verdict: "verified" }],
    "GET /v1/receipts/rcpt_1": () => [200, RECEIPT],
    "GET /.well-known/poaw-keys.json": () => [200, KEYS],
  });

  it("works end to end, passes the key, and sends a well-formed claim", async () => {
    const c = await connect({ apiKey: KEY, fetch: api.fetch, defaultAgentId: "release-bot" });

    const sub = await c.callTool({
      name: "submit_claim",
      arguments: { action: "github.commit.push", target: "acme/app", params: { branch: "main", sha: "a".repeat(40) } },
    });
    expect(sub.isError).toBeFalsy();
    expect(text(sub)).toMatch(/Accepted; state queued/);
    const sent = api.calls[0];
    expect(sent.auth).toBe(`Bearer ${KEY}`);
    expect(sent.body).toMatchObject({ agent_id: "release-bot", action: "github.commit.push", target: "acme/app" });
    const body = sent.body as { claimed_at: string; client_claim_id: string };
    expect(Number.isNaN(Date.parse(body.claimed_at))).toBe(false);
    expect(body.client_claim_id).toMatch(/^[0-9a-f-]{36}$/);

    const v = await c.callTool({ name: "get_verdict", arguments: { claim_id: "c1" } });
    expect(text(v)).toMatch(/^verified: The destination shows the claimed outcome/);
    expect(v.structuredContent).toMatchObject({ receipt_id: "rcpt_1", receipt_url: "https://qedproof.site/r/rcpt_1/" });

    const g = await c.callTool({ name: "get_receipt", arguments: { receipt_id: "rcpt_1" } });
    expect((g.structuredContent as { receipt: { body: unknown } }).receipt.body).toBeTruthy();

    const chk = await c.callTool({ name: "verify_receipt", arguments: { receipt_id: "rcpt_1" } });
    expect(chk.isError).toBeFalsy();
    expect(chk.structuredContent).toMatchObject({ valid: true, achieved_trust_level: 1, checks: { inclusion: true } });
    expect(text(chk)).toMatch(/Valid at trust level 1/);
  });

  it("verifies fully offline from receipt_json + keys_json, without calling the API", async () => {
    const quiet = fakeApi({});
    const c = await connect({ apiKey: KEY, fetch: quiet.fetch });
    const r = await c.callTool({ name: "verify_receipt", arguments: { receipt_json: RECEIPT, keys_json: KEYS } });
    expect(r.structuredContent).toMatchObject({ valid: true, fetched_from_api: [] });
    expect(quiet.calls).toEqual([]);
  });

  it("reports a tampered receipt as not valid and names the failed checks", async () => {
    const c = await connect({ apiKey: KEY, fetch: fakeApi({}).fetch });
    const r = await c.callTool({
      name: "verify_receipt",
      arguments: { receipt_json: vector("007-tampered-verdict.json"), keys_json: KEYS },
    });
    expect(r.structuredContent).toMatchObject({ valid: false, achieved_trust_level: 0 });
    expect(text(r)).toMatch(/^Not valid\. Failed checks: .*signature/);
  });
});

describe("list tools before their API routes are deployed", () => {
  it.each(["list_claims", "list_connections"])("%s says it's not available yet instead of inventing a list", async (name) => {
    const c = await connect({ apiKey: KEY, fetch: fakeApi({}).fetch });
    const r = await c.callTool({ name, arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not available on this server yet/);
  });

  it("list_claims passes filters as query parameters once the route exists", async () => {
    const api = fakeApi({ "GET /v1/claims": () => [200, { claims: [], next_cursor: null }] });
    const c = await connect({ apiKey: KEY, fetch: api.fetch });
    const r = await c.callTool({ name: "list_claims", arguments: { limit: 5, verdict: "failed", state: "decided" } });
    expect(r.isError).toBeFalsy();
    const q = new URL(api.calls[0].url).searchParams;
    expect(Object.fromEntries(q)).toEqual({ limit: "5", verdict: "failed", state: "decided" });
  });
});

describe("get_log_head", () => {
  const KEYS = vector("keys.json");
  const head = (file: string) => ({
    tree_head: JSON.parse(vector(file)),
    anchor: { chain: "base-sepolia", tx_hash: "0xabc", tree_size: 7 },
  });

  it("returns the head and anchor with a verified signature; works without an API key", async () => {
    const api = fakeApi({
      "GET /v1/log/head": () => [200, head("036-tree-head-valid.json")],
      "GET /.well-known/poaw-keys.json": () => [200, KEYS],
    });
    const c = await connect({ fetch: api.fetch });
    const r = await c.callTool({ name: "get_log_head", arguments: {} });
    expect(r.isError).toBeFalsy();
    const out = r.structuredContent as {
      signature_valid: boolean;
      tree_head: { body: { tree_size: number } };
      anchor: { tx_hash: string };
    };
    expect(out.signature_valid).toBe(true);
    expect(out.tree_head.body.tree_size).toBe(7);
    expect(out.anchor.tx_hash).toBe("0xabc");
    expect(text(r)).toMatch(/7 entries.*verifies/s);
    expect(api.calls.every((x) => x.auth === null)).toBe(true);
  });

  it.each(["037-tree-head-tampered.json", "038-tree-head-signed-as-receipt.json", "039-tree-head-extra-field.json"])(
    "reports an invalid signature for %s",
    async (file) => {
      const api = fakeApi({
        "GET /v1/log/head": () => [200, head(file)],
        "GET /.well-known/poaw-keys.json": () => [200, KEYS],
      });
      const c = await connect({ fetch: api.fetch });
      const r = await c.callTool({ name: "get_log_head", arguments: {} });
      expect((r.structuredContent as { signature_valid: boolean }).signature_valid).toBe(false);
      expect(text(r)).toMatch(/does not verify/);
    },
  );

  it("handles a null anchor and an API that doesn't have the endpoint yet", async () => {
    const ok = fakeApi({
      "GET /v1/log/head": () => [200, { tree_head: JSON.parse(vector("036-tree-head-valid.json")), anchor: null }],
      "GET /.well-known/poaw-keys.json": () => [200, KEYS],
    });
    const r = await (await connect({ fetch: ok.fetch })).callTool({ name: "get_log_head", arguments: {} });
    expect((r.structuredContent as { anchor: unknown }).anchor).toBeNull();
    const missing = await (await connect({ fetch: fakeApi({}).fetch })).callTool({ name: "get_log_head", arguments: {} });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/The log head was not found \(404\)/);
  });
});
