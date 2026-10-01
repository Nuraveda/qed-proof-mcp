/**
 * Browsers and Workers require fetch to be called with the global (or undefined) as `this`, and throw "Illegal
 * invocation" otherwise. 0.1.0 stored fetch on the client and called `this.fetchImpl(...)`, which Node accepts and every
 * browser rejects. The same bug as @qed-proof/sdk 0.1.0–0.1.3 (lane mcp-fetch-binding).
 */
import { afterEach, describe, expect, it } from "vitest";
import { QedApi } from "../src/api.js";

const realFetch = globalThis.fetch;

/** A fetch that behaves like a browser's: it refuses to be called as a method of some other object. */
function browserLikeFetch(calls: string[]) {
  return function fetch(this: unknown, input: RequestInfo | URL): Promise<Response> {
    if (this !== undefined && this !== globalThis) {
      return Promise.reject(new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation"));
    }
    calls.push(String(input));
    return Promise.resolve(new Response(JSON.stringify({ keys: [] }), { status: 200 }));
  } as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fetch binding", () => {
  it("the default (global) fetch is called as a plain function", async () => {
    const calls: string[] = [];
    globalThis.fetch = browserLikeFetch(calls);
    const api = new QedApi({ baseUrl: "https://api.example.test" });
    await api.getKeys();
    expect(calls).toEqual(["https://api.example.test/.well-known/poaw-keys.json"]);
  });

  it("a fetch passed in options is called as a plain function too", async () => {
    const calls: string[] = [];
    const api = new QedApi({ baseUrl: "https://api.example.test", fetch: browserLikeFetch(calls) });
    await api.getKeys();
    expect(calls).toHaveLength(1);
  });
});

describe("VERSION", () => {
  it("matches package.json, so the server and User-Agent report the published version", async () => {
    const { VERSION } = await import("../src/api.js");
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});
