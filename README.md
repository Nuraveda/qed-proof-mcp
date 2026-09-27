# @qed-proof/mcp

QED Proof as an [MCP](https://modelcontextprotocol.io) server. An AI agent says it did something; QED Proof reads the
destination itself — never the agent's own report — decides a verdict, and issues a signed receipt anyone can check.

This server lets any MCP client (Claude, Claude Code, Cursor, and others) submit claims, read verdicts, fetch receipts
and verify them offline, with no code.

## Tools

| Tool | What it does |
|---|---|
| `submit_claim` | Records a claim (an action on a target) for QED Proof to verify. Returns a `claim_id`, and the verdict when the check finishes inline. |
| `get_verdict` | A claim's state, verdict (`verified`, `late`, `mismatch`, `failed`, `unverifiable`), what it means, and the `receipt_id`. |
| `get_receipt` | The full signed receipt, with a shareable link. Receipts are public. |
| `verify_receipt` | Checks a receipt **offline**: schema, integer-only encoding, key validity, Ed25519 signature, claim digest, and Merkle inclusion. It doesn't read the chain, so the anchor is reported as not checked and the achieved trust level is at most 1. |
| `list_claims` | Recent claims in your workspace, with filters. |
| `list_connections` | Destinations your workspace has connected read-only, and whether a verifier is live for each. |

There are no tools to connect accounts, disconnect them or manage keys: those stay in the console.

**Actions verified today** are the ones with a published verifier profile in the QED Proof spec: `github.commit.push`,
`github.pr.open`, `github.checks.pass`, `x.post.publish` and `slack.message.post`. Any other action is accepted and
decided as `unverifiable` — QED Proof never guesses.

## Use it

You need a workspace API key from the console (**Developers** → **API keys**).

**Local (stdio):**

```bash
claude mcp add qed-proof --env QED_API_KEY=<your key> -- npx -y @qed-proof/mcp
```

Environment: `QED_API_KEY` (required for everything but offline verification), `QED_AGENT_ID` (the default `agent_id`
for claims; otherwise the MCP client's name), `QED_API_URL` (defaults to `https://api.qedproof.site`, e.g. for a
self-hosted node).

**Hosted (Streamable HTTP):** `https://mcp.qedproof.site/mcp` with `Authorization: Bearer <your key>`.

```bash
claude mcp add --transport http qed-proof https://mcp.qedproof.site/mcp --header "Authorization: Bearer <your key>"
```

The hosted server keeps no state and stores nothing. It forwards your key to the QED Proof API for each request, so
the API's own workspace scoping and rate limits apply, and it logs only the method, tool name, status and latency.

## Data

`target` and `params` of a claim are copied into its receipt, which is **public and permanent**. Receipts record
fingerprints and the facts a verifier read (a commit SHA, an HTTP status), never content.

## Develop

```bash
npm install
npm test          # includes every spec test vector
npm run build
```

Apache-2.0. QED Proof has no token.
