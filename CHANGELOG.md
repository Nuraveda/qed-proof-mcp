# Changelog

## 0.1.0 (unreleased)

- Six tools: `submit_claim`, `get_verdict`, `get_receipt`, `verify_receipt` (offline), `list_claims`, `list_connections`.
- Local stdio server (`npx @qed-proof/mcp`) and a stateless Streamable HTTP handler for the hosted server.
- `verify_receipt` agrees with the spec's reference checker on every published test vector.
