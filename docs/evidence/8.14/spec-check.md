# 8.14: the MCP wire set beside the specification and the Rust SDK (25 Nov 2026, claude-grapix-f1)

Row 8.14 says it "targets the MCP 2026-07-28 specification, verified against the official spec and the Rust SDK before coding". Codex's
review of the row (Panchayati 695) found no record of that check. **There is none to find, and this file cannot be the one the row asks for:
the wire was built on 7 Nov (docs/log/2026-11-07.md) and this check is made on 25 Nov, after the fact.** What it can be is the specification's
own words, read on 25 Nov, set beside what the shipped transport answers when it is asked, by running it. Where the two differ, the
difference is named below and left for the owner of 8.14.

## What was read, and by whom

- **The specification.** A read-only fetch agent read these pages on 25 Nov 2026 and reported them to me; I did not read the pages
  myself, so the quoted words are the agent's report of them:
  `https://modelcontextprotocol.io/specification`, `.../specification/versioning`, `.../specification/2026-07-28/changelog`,
  `.../2026-07-28/basic/versioning`, `.../2026-07-28/basic/transports/streamable-http`, `.../2026-07-28/basic/authorization`,
  `.../2026-07-28/server/tools`. The versioning page: "The **current** protocol version is **2026-07-28**."
- **The Rust SDK, as pinned.** `rmcp = "3.9"` (`services/mcp-server/Cargo.toml`), `3.9.0` in `Cargo.lock`. I read its source from the local
  cargo registry, `rmcp-3.9.0/src/model.rs`: `ProtocolVersion::KNOWN_VERSIONS` is 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25 and
  2026-07-28; `LATEST` and `NO_INITIALIZE` (the first revision with no `initialize`) are 2026-07-28; `LATEST_WITH_INITIALIZE` is 2025-11-25;
  `ErrorCode::UNSUPPORTED_PROTOCOL_VERSION` is -32022. So the SDK we ship knows the revision the row names.
- **Not established.** Whether 3.9.0 is the newest `rmcp`, and what its repository says: github.com, crates.io and docs.rs were each
  refused to the fetch tool in this session ("don't ask" mode), so the "latest release" half of the check is open.

## The specification beside the transport

Each "answered" below was run on 25 Nov against the real HTTP transport (`serve_http_listener`, loopback, a gx1 credential) by
`services/mcp-server/tests/http/spec_probe.rs::the_transport_answers_as_the_2026_07_28_specification_says_where_it_decides`, unless another test is named.

| The specification | The transport | |
|---|---|---|
| No handshake: every request carries its revision in `_meta` and, on HTTP, in `MCP-Protocol-Version`, and they "must match". | A header that disagrees with `_meta`, and a body that names a revision with no header, are each refused: HTTP 400, code -32020, before any tool is reached. | answered |
| A server that does not know the requested revision "MUST respond with an `UnsupportedProtocolVersionError` listing the versions it does support" (code -32022, HTTP 400, `data.supported`). | `2099-01-01` in header and `_meta`: HTTP 400, code -32022, `data.requested = "2099-01-01"`, `data.supported = ["2025-06-18", "2026-07-28"]`. | answered |
| Protocol-level sessions are removed; a server "do[es] not mint or echo session IDs". | A call carrying `Mcp-Session-Id` is served (200) and no `Mcp-Session-Id` comes back. | answered |
| "HTTP GET or DELETE on the MCP endpoint should get 405 Method Not Allowed". | Both: 405, `Allow: POST`. | answered |
| A method nobody defined is JSON-RPC "method not found". | HTTP 404, code -32601. | answered |
| A local server "SHOULD bind only to localhost"; it "MUST validate the `Origin` header" and answer 403 if present and invalid. | Binds 127.0.0.1 only; a foreign `Host` and any browser `Origin`, even a local one, are refused 403. | `a_foreign_host_or_any_browser_origin_is_refused` (already in the tree) |
| Authorization is optional. A server that does it answers invalid tokens 401 and insufficient scope 403 with a `WWW-Authenticate` challenge. | No credential, or one that does not verify: HTTP 401 with `WWW-Authenticate: Bearer`, refusal `unauthenticated`, the credential never echoed. Insufficient scope: see S3. | the 2.23 tests already in the tree |

## Where the transport departs from the specification

These are not defects found today in a sense that needs a fix today; each is something the owner of 8.14 should decide knowingly. The
first is pinned by the test above, so changing it fails that test until this file is updated.

- **S1. A refusal is a JSON-RPC error with code -32000, never a tool result with `isError: true`.** The specification (server/tools)
  separates protocol errors (its example for an unknown tool is code -32602) from tool execution errors, which "are reported in tool
  results with `isError: true`" so the model can correct itself. This server answers every refusal, a refused write (`revisionMismatch`)
  and an unknown tool alike, as `{"error": {"code": -32000, "data": {"code": {"refusal": ...}, ...}}}` at HTTP 200 (`wire.rs`: "Refusals
  are not tool results", a deliberate choice). The cost is real for an agent: a client that shows a model only tool results, and surfaces
  protocol errors to a person, does not show the model the refusal that would let it recover. The unknown-tool case is pinned in the probe.
- **S2. Two revisions are claimed, the SDK knows five.** `SUPPORTED_PROTOCOL_VERSIONS` is 2025-06-18 and 2026-07-28, and a 2025-11-25
  client's `initialize` is answered 2025-06-18 ("Nothing between them is claimed", `wire.rs`). The specification's own predecessor of
  2026-07-28 is 2025-11-25 and rmcp 3.9.0 can serve its handshake (`LATEST_WITH_INITIALIZE`). Answering an older revision is legal
  negotiation; a client that will not speak 2025-06-18 gets no answer. Cheap to widen if a client needs it.
- **S3. Insufficient scope is not HTTP 403.** The specification says a server that finds insufficient scope "SHOULD" answer 403 with
  `WWW-Authenticate: ... error="insufficient_scope"`. A credential that verifies but lacks the scope gets HTTP 200 and the JSON-RPC
  refusal `unauthenticated` (the test `the_scopes_come_from_the_credential_not_from_the_server`). That is also the refusal an agent
  gets for a missing or wrong credential at the tool level; the two cases are told apart only by the HTTP status.
- **S4. The credential is not the specification's OAuth profile.** The specification says a server that implements authorization "MUST
  implement OAuth 2.0 Protected Resource Metadata (RFC 9728)" and validate the token's audience. 2.23 decided a gx1 HMAC bearer
  credential on a loopback port instead; there is no metadata document and no audience. The specification makes authorization optional,
  so this is a decision to keep on record, not a breach, but a client written to the specification's OAuth flow will not log in.

## What this does not show

It does not show the stdio transport against the specification, nor tool `outputSchema` or `annotations`, nor pagination (`nextCursor`,
`ttlMs`, `cacheScope` in `tools/list`), nor that a real third-party client (Claude Desktop, an SDK client) completes a session; the last is the
test that would settle S1 and S2 in practice, and no one has run it against this server.
