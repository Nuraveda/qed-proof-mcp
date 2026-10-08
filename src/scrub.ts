/**
 * Error-report scrubbing for the hosted server (lambda.ts). Requests carry API keys and OAuth tokens, so an event keeps
 * only the method, the path and an allowlist of headers; query strings are cut from every URL. Pure: no Sentry import.
 */
const HEADER_ALLOW = new Set(["user-agent", "content-type", "content-length", "accept", "mcp-protocol-version"]);

const stripQuery = (u: unknown) => (typeof u === "string" ? u.split("?", 1)[0] : u);

// biome-ignore lint/suspicious/noExplicitAny: Sentry event shape, kept structural so this file has no dependency
export function scrubEvent<E extends Record<string, any>>(event: E): E {
  const req = event.request;
  if (req && typeof req === "object") {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) if (HEADER_ALLOW.has(k.toLowerCase())) headers[k] = String(v);
    req.headers = headers;
    for (const k of ["data", "cookies", "query_string", "env"]) delete req[k];
    req.url = stripQuery(req.url);
  }
  delete event.user;
  for (const bc of event.breadcrumbs ?? []) if (bc?.data && typeof bc.data === "object") bc.data.url = stripQuery(bc.data.url);
  return event;
}
