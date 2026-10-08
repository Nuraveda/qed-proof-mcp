# Changelog

All notable changes to `@qed-proof/mcp` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.1] - 2026-10-08

### Changed

- The bundled copy of the receipt schema matches the current spec: a trust-level-3 receipt's attestation carries
  `document_sha256`, and the attestation document travels beside the signed body instead of inside it. This server does
  not verify attestations itself; `verify_receipt` gives the same result as 0.3.0 on every receipt test vector.

### Added

- The hosted Lambda entry (`lambda.ts`, not part of the npm package) can report errors to Sentry when `QED_SENTRY_DSN`
  is set. Off by default; the stdio and HTTP servers in the package send nothing. Errors only: no PII, headers outside
  a short allowlist, bodies or query strings.

### Fixed

- The Lambda bundle's `createRequire` banner is aliased, so a bundled dependency importing the same name can't make the
  bundle fail to load; the build now smoke-loads the bundle with reporting off and on.

### Security

- `@modelcontextprotocol/sdk` now requires `^1.32.1`, so installs can't resolve a version affected by
  [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h). The advisory is in the SDK's OAuth client,
  which this server does not use.

## [0.3.0] - 2026-10-04

### Added

- New read-only tool `get_log_head`: the public Merkle log's signed tree head and latest anchor, with the head's signature
  checked against the published keys (SPEC §8.5). Needs no API key.
- The HTTP handler can act as an **OAuth protected resource** (MCP authorization, RFC 9728) when given an `oauth` option:
  it serves `/.well-known/oauth-protected-resource`, answers a missing or invalid credential with `401` and
  `WWW-Authenticate: Bearer resource_metadata=…` (which starts a client's sign-in), checks every credential with the API
  (`GET /v1/whoami`, cached for 60 seconds, fail closed), and refuses an OAuth token issued for a different server. A token
  in the URL is never read. Without the option nothing changes.

## [0.2.0] - 2026-10-01

### Added

- `verify_receipt` also verifies **change entries** (SPEC §14, an unclaimed change recorded in the log) and takes an optional
  `pipeline` document to check an entry's `policy` (SPEC §15.2). The result reports `entry_kind` and `policy`.

### Changed

- Accepts `poaw/0.1` and `poaw/0.2` receipts.

## [0.1.1] - 2026-10-01

### Changed

- Release runs need a maintainer's approval (the `npm` environment), and the repo moved to `Nuraveda/qed-proof-mcp`.

### Fixed

- The API client calls `fetch` as a plain function, so it works in browsers and Workers (it threw "Illegal invocation"
  there; Node was unaffected).
- The hosted HTTP handler reads the request body as a stream and stops at 256 KB, instead of buffering the whole body
  before checking its size.

## [0.1.0] - 2026-09-27

### Added

- Six tools: `submit_claim`, `get_verdict`, `get_receipt`, `verify_receipt` (offline), `list_claims`, `list_connections`.
- Local stdio server (`npx @qed-proof/mcp`) and a stateless Streamable HTTP handler for the hosted server.
- `verify_receipt` agrees with the spec's reference checker on every published test vector.

[Unreleased]: https://github.com/Nuraveda/qed-proof-mcp/compare/mcp-v0.3.1...HEAD
[0.3.1]: https://github.com/Nuraveda/qed-proof-mcp/compare/mcp-v0.3.0...mcp-v0.3.1
[0.3.0]: https://github.com/Nuraveda/qed-proof-mcp/compare/mcp-v0.2.0...mcp-v0.3.0
[0.2.0]: https://github.com/Nuraveda/qed-proof-mcp/compare/mcp-v0.1.1...mcp-v0.2.0
[0.1.1]: https://github.com/Nuraveda/qed-proof-mcp/compare/mcp-v0.1.0...mcp-v0.1.1
[0.1.0]: https://github.com/Nuraveda/qed-proof-mcp/releases/tag/mcp-v0.1.0
