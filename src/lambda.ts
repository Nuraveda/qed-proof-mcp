/**
 * AWS Lambda Function URL adapter (payload v2) around `handleHttp`. CloudFront terminates TLS for mcp.qedproof.site
 * and forwards with the origin's own Host and an `x-qed-edge` secret known only to the edge.
 */
import * as Sentry from "@sentry/aws-serverless";
import { handleHttp } from "./http.js";
import { scrubEvent } from "./scrub.js";

type UrlEvent = {
  rawPath: string;
  rawQueryString?: string;
  headers: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string } };
};

const oauth =
  process.env.QED_OAUTH_ISSUER && process.env.QED_OAUTH_MCP_URL
    ? { issuer: process.env.QED_OAUTH_ISSUER.replace(/\/+$/, ""), resourceUrl: process.env.QED_OAUTH_MCP_URL }
    : undefined;

const opts = {
  oauth,
  apiBaseUrl: process.env.QED_API_URL,
  allowedOrigins: (process.env.QED_MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  edgeSecret: process.env.QED_EDGE_SECRET || undefined,
};

async function handle(event: UrlEvent) {
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers ?? {})) if (v !== undefined) headers.set(k, v);
  const method = event.requestContext.http.method;
  const body =
    event.body === undefined ? undefined : event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  const url = `https://${headers.get("host") ?? "localhost"}${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ""}`;
  const res = await handleHttp(new Request(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body }), opts);
  const outHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    outHeaders[k] = v;
  });
  return { statusCode: res.status, headers: outHeaders, body: await res.text() };
}

// Error reporting for the hosted deployment only: off unless QED_SENTRY_DSN is set (self-hosters and the npm package,
// which doesn't include this file, send nothing). Errors only, no PII, scrubbed (scrub.ts).
const dsn = process.env.QED_SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.QED_ENV ?? "dev",
    release: process.env.QED_RELEASE || undefined,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: ["user-agent", "content-type", "accept"] }, response: false },
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
      genAI: { inputs: false, outputs: false },
    },
    tracesSampleRate: 0,
    maxBreadcrumbs: 20,
    beforeSend: (e) => scrubEvent(e),
  });
}

export const handler = dsn ? Sentry.wrapHandler(handle) : handle;
