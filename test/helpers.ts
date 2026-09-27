import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { QedApi } from "../src/api.js";
import { createServer } from "../src/tools.js";

export const VEC = join(import.meta.dirname, "vectors");
export const vector = (f: string) => readFileSync(join(VEC, f), "utf8");

export type Call = { url: string; method: string; auth: string | null; body: unknown };

/** A fake QED Proof API. `routes` maps "METHOD /path" (no query) to a handler returning [status, body]. */
export function fakeApi(routes: Record<string, (call: Call) => [number, unknown] | [number, unknown, Record<string, string>]>) {
  const calls: Call[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      auth: headers.get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const route = routes[`${call.method} ${url.pathname}`];
    if (!route) return new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 });
    const [status, body, h] = route(call);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: h });
  };
  return { fetch: f, calls };
}

export async function connect(opts: { apiKey?: string; fetch: typeof fetch; defaultAgentId?: string }) {
  const api = new QedApi({ apiKey: opts.apiKey, baseUrl: "https://api.example.test", fetch: opts.fetch });
  const server = createServer({ api, defaultAgentId: opts.defaultAgentId });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

/** The text of a tool result. callTool's type also admits the legacy `{ toolResult }` shape, which has no content. */
export const text = (r: unknown) =>
  ((r as { content?: { type: string; text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("\n");
