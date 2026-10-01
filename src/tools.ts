/**
 * The six tools. Anthropic Directory rules that shape every line here:
 * - every tool has title + readOnlyHint + destructiveHint; reads and writes are separate tools;
 * - descriptions state what a tool does, returns and can't do, as facts. They never tell the model how to behave;
 * - no description implies a verifier that doesn't exist: the action list is generated from oss/spec/profiles.
 * - nothing here logs a key, a target or params.
 */
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiError, type QedApi, VERSION } from "./api.js";
import { PROFILES } from "./generated/spec.js";
import { checkReceipt, type KeySet } from "./verify.js";

export const SITE = "https://qedproof.site";
const receiptUrl = (id: string) => `${SITE}/r/${id}/`;

/** What each verdict means, from SPEC §6.1, stated as facts. */
export const VERDICT_MEANING: Record<string, string> = {
  verified: "The destination shows the claimed outcome, matching every required field, within the tolerance window.",
  late: "The outcome is there and matches, but it appeared after the tolerance window (and before the deadline).",
  mismatch: "Something landed for the target, but a required field differs (for example the wrong branch, or different content).",
  failed: "The destination was read, and the outcome was not there by the deadline.",
  unverifiable:
    "QED Proof couldn't determine the outcome (no connection, permission denied, rate limited, destination unavailable, unsupported action, ambiguous claim or verifier error). It counts neither for nor against the agent.",
};

function actionCatalog(): string {
  return PROFILES.map((p) => {
    const params = p.params.map((x) => `${x.field}${x.required ? "" : "?"} (${x.type})`).join(", ");
    return `- ${p.action}: ${p.summary} target: ${p.target}; params: ${params}`;
  }).join("\n");
}

type Result = { content: { type: "text"; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

const ok = (data: Record<string, unknown>, lead?: string): Result => ({
  content: [{ type: "text", text: (lead ? `${lead}\n\n` : "") + JSON.stringify(data, null, 2) }],
  structuredContent: data,
});

const fail = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });

/** Every API failure becomes a tool error that says what happened and what would fix it. Never a crash. */
export function explain(err: unknown, what: string): Result {
  if (err instanceof ApiError) {
    switch (err.status) {
      case 401:
        return fail(
          err.detail === "no API key"
            ? "No QED Proof API key is configured. Set QED_API_KEY for the local server, or send `Authorization: Bearer <key>` to the hosted one. Keys are created in the console at https://qedproof.site/app/developers/."
            : "The QED Proof API rejected the API key (401). It may be revoked or mistyped; keys are managed at https://qedproof.site/app/developers/.",
        );
      case 402:
        return fail(`The claim was refused before it was accepted (402): ${err.detail} No receipt was created.`);
      case 404:
        return fail(`${what} was not found (404).`);
      case 405:
        return fail(`${what} is not available on this server yet.`);
      case 422:
        return fail(`The API rejected the input (422): ${err.detail}`);
      case 429:
        return fail(`Rate limited (429). Retry after ${err.retryAfter ?? "a few"} seconds.`);
      default:
        return fail(`The QED Proof API returned HTTP ${err.status}: ${err.detail}`);
    }
  }
  const name = err instanceof Error ? err.name : "Error";
  return fail(
    name === "TimeoutError" ? "The QED Proof API didn't answer within 20 seconds." : `Couldn't reach the QED Proof API (${name}).`,
  );
}

/** List routes that the API adds after this package ships: a 404 on the collection itself means "not deployed yet". */
function notYet(err: unknown, what: string): Result {
  if (err instanceof ApiError && (err.status === 404 || err.status === 405)) return fail(`${what} is not available on this server yet.`);
  return explain(err, what);
}

export type ServerOptions = {
  api: QedApi;
  /** Default agent_id when a call doesn't give one (stdio: QED_AGENT_ID). */
  defaultAgentId?: string;
};

export function createServer({ api, defaultAgentId }: ServerOptions): McpServer {
  const server = new McpServer(
    { name: "qed-proof", version: VERSION, title: "QED Proof" },
    {
      instructions:
        "QED Proof independently verifies an AI agent's claimed work by reading the destination system itself (never the agent's own report) and issues a signed receipt. Flow: submit_claim returns a claim_id; get_verdict returns the verdict and receipt_id once decided; get_receipt returns the receipt; verify_receipt checks a receipt's signature and log inclusion offline.",
    },
  );

  const agentFallback = () => defaultAgentId || server.server.getClientVersion()?.name || "mcp-client";

  server.registerTool(
    "submit_claim",
    {
      title: "Submit a claim for verification",
      description: `Records that an agent says it performed an action, so QED Proof can check the destination and issue a signed receipt. Returns a claim_id and, when the check finishes inline, the verdict and receipt_id; otherwise state is "queued" and get_verdict returns the outcome later.

Documented actions (verifier profiles published in the QED Proof spec):
${actionCatalog()}

Any other action string is accepted and decided as "unverifiable" (reason unsupported_action). target and params are copied into the receipt, which is public and permanent; params are limited to 4 KB. Resubmitting with the same client_claim_id returns the existing claim instead of creating a new one.`,
      inputSchema: {
        action: z
          .string()
          .regex(/^[a-z0-9]+(\.[a-z0-9_]+){2}$/)
          .describe("Action string, e.g. github.commit.push."),
        target: z.string().min(1).max(512).describe("Where the work was meant to land, in the action's own format (e.g. owner/repo)."),
        params: z.record(z.string(), z.unknown()).default({}).describe("The fields the action's profile requires."),
        claimed_at: z
          .string()
          .datetime({ offset: true })
          .optional()
          .describe("When the agent says it did the work (ISO 8601 with a timezone). Defaults to now."),
        agent_id: z.string().min(1).max(256).optional().describe("The agent's own identifier. Defaults to the MCP client's name."),
        client_claim_id: z
          .string()
          .min(1)
          .max(256)
          .optional()
          .describe("A stable id for this claim, so a retry doesn't create a duplicate. Generated when omitted."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ action, target, params, claimed_at, agent_id, client_claim_id }) => {
      try {
        const res = await api.submitClaim({
          action,
          target,
          params,
          claimed_at: claimed_at ?? new Date().toISOString(),
          agent_id: agent_id ?? agentFallback(),
          client_claim_id: client_claim_id ?? randomUUID(),
        });
        const lead = res.verdict
          ? `Decided: ${res.verdict}. ${VERDICT_MEANING[res.verdict] ?? ""}`
          : `Accepted; state ${res.state}. The verdict isn't decided yet.`;
        return ok({ ...res, ...(res.receipt_id ? { receipt_url: receiptUrl(res.receipt_id) } : {}) }, lead);
      } catch (err) {
        return explain(err, "The claims API");
      }
    },
  );

  server.registerTool(
    "get_verdict",
    {
      title: "Get a claim's verdict",
      description:
        'Returns a claim\'s state ("queued" or "decided"), its verdict when decided, and the receipt_id. Verdicts: verified, late, mismatch, failed, unverifiable; the response includes what the verdict means. Only claims in the API key\'s own workspace are visible.',
      inputSchema: { claim_id: z.string().min(1).max(64).describe("The claim_id returned by submit_claim.") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ claim_id }) => {
      try {
        const s = await api.getClaim(claim_id);
        const meaning = s.verdict ? VERDICT_MEANING[s.verdict] : undefined;
        return ok(
          { ...s, ...(meaning ? { meaning } : {}), ...(s.receipt_id ? { receipt_url: receiptUrl(s.receipt_id) } : {}) },
          s.verdict ? `${s.verdict}: ${meaning ?? ""}` : `Not decided yet (state ${s.state}).`,
        );
      } catch (err) {
        return explain(err, `Claim ${claim_id}`);
      }
    },
  );

  server.registerTool(
    "get_receipt",
    {
      title: "Get a signed receipt",
      description:
        "Returns the full signed receipt for a receipt_id: the claim, what the verifier read at the destination (facts and fingerprints, never content), the verdict, the Ed25519 signature, and the log inclusion and anchor proof. Receipts are public, and the response includes a shareable link.",
      inputSchema: { receipt_id: z.string().min(1).max(64).describe("The receipt_id from get_verdict or submit_claim.") },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ receipt_id }) => {
      try {
        const receipt = JSON.parse(await api.getReceiptText(receipt_id)) as Record<string, unknown>;
        return ok({ receipt, receipt_url: receiptUrl(receipt_id) });
      } catch (err) {
        return explain(err, `Receipt ${receipt_id}`);
      }
    },
  );

  server.registerTool(
    "verify_receipt",
    {
      title: "Verify a receipt or change entry offline",
      description:
        "Checks a receipt or a change entry independently of QED Proof's servers, as the reference checker in the QED Proof spec does: the JSON Schema, integer-only encoding, the signing key's validity window, the Ed25519 signature, the claim digest (receipts only; a change entry has no claim) and the Merkle log inclusion proof. A change entry is signed under its own domain and the report carries entry_kind \"change\" with a null verdict. If the body carries a policy, pass the pipeline document to check it (its digest, id and version); without it the policy check is reported as not_checked. It does not read the blockchain, so the on-chain anchor is reported as not checked and the achieved trust level is at most 1. Pass receipt_json (a receipt or a change entry) for a fully offline check, or receipt_id to fetch the receipt first. The public keys come from keys_json or, when omitted, from the issuer's published poaw-keys.json.",
      inputSchema: {
        receipt_json: z.string().max(200_000).optional().describe("The receipt as raw JSON text."),
        receipt_id: z.string().min(1).max(64).optional().describe("A receipt_id to fetch, when receipt_json isn't given."),
        keys_json: z.string().max(200_000).optional().describe("The issuer's poaw-keys.json as raw JSON text."),
        pipeline: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "The pipeline document, to check the receipt's policy against (its id, version and digest). Omit it and the policy check is reported as not_checked.",
          ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ receipt_json, receipt_id, keys_json, pipeline }) => {
      if (!receipt_json && !receipt_id) return fail("Give either receipt_json or receipt_id.");
      let raw = receipt_json;
      const fetched: string[] = [];
      try {
        if (!raw) {
          raw = await api.getReceiptText(receipt_id as string);
          fetched.push("receipt");
        }
        let keysText = keys_json;
        if (!keysText) {
          keysText = await api.getKeys();
          fetched.push("public keys");
        }
        let keys: KeySet;
        try {
          keys = JSON.parse(keysText) as KeySet;
        } catch {
          return fail("keys_json isn't valid JSON.");
        }
        let report: ReturnType<typeof checkReceipt>;
        try {
          report = checkReceipt(raw, keys, pipeline);
        } catch {
          return fail("receipt_json isn't valid JSON.");
        }
        const failed = Object.entries(report.checks)
          .filter(([, v]) => v === false)
          .map(([k]) => k);
        const isChange = report.entry_kind === "change";
        const policyNote =
          report.checks.policy === undefined
            ? ""
            : report.checks.policy === "not_checked"
              ? " The policy was not checked (no pipeline document given)."
              : " The policy matches the pipeline document.";
        const lead = report.valid
          ? `Valid${isChange ? " change entry" : ""} at trust level ${report.achieved_trust_level}: signed by a published key, unaltered${report.checks.inclusion === true ? ", and included in the log" : ""}. ${isChange ? "A change entry carries no verdict." : `Verdict: ${report.verdict}.`} The on-chain anchor was ${report.checks.anchor === "absent" ? "not present" : "not checked (offline check)"}.${policyNote}`
          : `Not valid. Failed checks: ${failed.join(", ") || "none individually; see checks"}.`;
        return ok({ ...report, fetched_from_api: fetched }, lead);
      } catch (err) {
        return explain(err, receipt_id ? `Receipt ${receipt_id}` : "The key set");
      }
    },
  );

  server.registerTool(
    "list_claims",
    {
      title: "List recent claims",
      description:
        "Lists claims in the API key's workspace, newest first, with each claim's state, verdict and receipt_id. Filters: agent_id, action, verdict, state (queued or decided). Paginate with the returned next_cursor.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).describe("Max claims to return."),
        cursor: z.string().max(512).optional().describe("next_cursor from a previous call."),
        agent_id: z.string().max(256).optional(),
        action: z.string().max(128).optional(),
        verdict: z.enum(["verified", "late", "mismatch", "failed", "unverifiable"]).optional(),
        state: z.enum(["queued", "decided"]).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (q) => {
      try {
        return ok((await api.listClaims(q)) as Record<string, unknown>);
      } catch (err) {
        return notYet(err, "Listing claims");
      }
    },
  );

  server.registerTool(
    "list_connections",
    {
      title: "List connected destinations",
      description:
        "Lists the destinations the workspace has connected read-only (for example GitHub, Slack, X) and whether a verifier is live for each. Read-only: connecting or disconnecting happens in the QED Proof console, not here.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return ok((await api.listConnections()) as Record<string, unknown>);
      } catch (err) {
        return notYet(err, "Listing connections");
      }
    },
  );

  return server;
}
