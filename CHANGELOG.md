# Changelog

## 0.1.1

- The API client calls `fetch` as a plain function, so it works in browsers and Workers (it threw "Illegal invocation"
  there; Node was unaffected).
- The hosted HTTP handler reads the request body as a stream and stops at 256 KB, instead of buffering the whole body
  before checking its size (#142).
- Release runs need a maintainer's approval (the `npm` environment), and the repo moved to `Nuraveda/qed-proof-mcp`.

## 0.1.0

- Six tools: `submit_claim`, `get_verdict`, `get_receipt`, `verify_receipt` (offline), `list_claims`, `list_connections`.
- Local stdio server (`npx @qed-proof/mcp`) and a stateless Streamable HTTP handler for the hosted server.
- `verify_receipt` agrees with the spec's reference checker on every published test vector.
