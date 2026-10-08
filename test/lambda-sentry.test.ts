import { createServer as createHttp } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, expect, it } from "vitest";
import { scrubEvent } from "../src/scrub.js";

it("scrubEvent keeps method, path and allowlisted headers only", () => {
  const e = scrubEvent({
    request: {
      method: "POST",
      url: "https://mcp.qedproof.site/mcp?token=T0K",
      headers: { authorization: "Bearer k", "x-qed-edge": "edge", "User-Agent": "ua", cookie: "c" },
      data: "{}",
      cookies: { c: "1" },
      query_string: "token=T0K",
    },
    user: { ip_address: "1.2.3.4" },
    breadcrumbs: [{ data: { url: "https://api.qedproof.site/v1/whoami?x=1" } }],
  });
  expect(e.request).toEqual({ method: "POST", url: "https://mcp.qedproof.site/mcp", headers: { "User-Agent": "ua" } });
  expect(e.user).toBeUndefined();
  expect(e.breadcrumbs[0].data.url).toBe("https://api.qedproof.site/v1/whoami");
});

const received: string[] = [];
const ingest = createHttp((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    received.push(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200).end("{}");
  });
});
afterAll(() => ingest.close());

it("the hosted handler reports a crash to Sentry without the credential or query", async () => {
  await new Promise<void>((r) => ingest.listen(0, "127.0.0.1", r));
  const port = (ingest.address() as AddressInfo).port;
  // Built at runtime so the source-context lines of this file can't produce a false match.
  const key = `qed_sk_${"secretkey"}`;
  const tok = `oauth${"tok"}`;
  process.env.QED_SENTRY_DSN = `http://pub@127.0.0.1:${port}/1`;
  const { handler } = await import("../src/lambda.js");
  const ctx = { functionName: "qed-dev-mcp", awsRequestId: "r1", getRemainingTimeInMillis: () => 30_000 };
  // requestContext missing → the adapter throws a TypeError before any network call.
  const bad = { rawPath: "/mcp", rawQueryString: `token=${tok}`, headers: { authorization: `Bearer ${key}`, host: "mcp" } };
  // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed event
  await expect((handler as any)(bad, ctx)).rejects.toThrow(TypeError);
  for (let i = 0; i < 50 && !received.some((b) => b.includes('"exception"')); i++) await new Promise((r) => setTimeout(r, 50));
  const blob = received.join("\n");
  expect(blob).toContain("TypeError");
  expect(blob).not.toContain(key);
  expect(blob).not.toContain(tok);
}, 15_000);
