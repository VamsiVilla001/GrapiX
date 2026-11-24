# 2.23 MCP HTTP authentication

Done 19 November 2026. User decision (asked, 19 Nov 2026): **require a credential**, not loopback-only.

## What was built
- **`gx-credential`** (`Shared/credential`, new): the gx1 `Token`, `Claims` and their errors moved out of `gx-control-transport` so the MCP server can verify a credential without linking the control-plane client. `gx_control_transport::{Token, Claims, ...}` and `gx_control_transport::auth` still resolve to it. `TokenError::fault_name()` is a word for the fault that is safe to log (the `Display` text of `UnknownPrefix` quotes what the caller sent).
- **`HttpAuth`** (`services/mcp-server/src/wire.rs`): the secret requests are verified against. `Server::serve_http(port, auth, ..)` and `serve_http_listener(.., auth)` cannot be called without one; an empty secret is refused.
- **Every request is judged before rmcp sees it:** `Authorization: Bearer <gx1>` (scheme case-insensitive) is verified against the secret; failure is `401` with `WWW-Authenticate: Bearer` and the `unauthenticated` structured refusal as the body (nothing about why, and nothing the caller sent). The credential is verified per request, which is stricter than the row's "once per connection": the transport is stateless, so there is no connection state to trust.
- **Scopes come from the credential:** `Caller { subject, scopes }` rides the request's extensions to the tool call; `Server::call_tool_for` gates by the caller's scopes (the server's built-in ones apply to stdio only). `mcp.call` records the subject; a refused request is on record as `mcp.unauthenticated` with the fault's word.
- **`gx-editor-mcp`:** `--http` needs `--token <secret>` (the engine's flag) and refuses to start without it; `--token` without `--http` is refused (nothing would use it).
- **Bind policy wording:** the policy said the MCP HTTP transport "verifies no credential"; it now says why it stays loopback-only (a local agent endpoint, never offered a network interface). Invariant 85.

## Evidence
- `gx-credential` 9 tests (moved with the code); `gx-control-transport` 20 + 10 + 7 + 3; `gx-mcp-server` lib 24 (a caller's scopes override the server's) and `tests/http` 8 (no credential: 401, header, refusal by name, the tool not reached, discovery included; a credential made with another secret, an altered one, a non-gx1 one, another scheme, a real credential under another scheme, an empty bearer: each 401 and never echoed; the scheme's case does not matter; scopes come from the credential, not the server; an empty secret is refused); `gx-editor-mcp`: the shipped binary refuses `--http` without a secret, `--token` without `--http` and an empty secret; an anonymous request and one made with another secret get 401; the call log names the subject `http-test`, the refused request is on record as `noCredential`, and neither a credential nor the secret is in any line.
- 15 mutants, one at a time, each failed a named test (no check, secret not verified, any scheme, case-sensitive scheme, caller not attached, caller ignored by the tool call, not 401, no `WWW-Authenticate`, empty secret allowed, refusal unnamed, gate on the server's scopes, subject not recorded, fault word not recorded, the two launcher refusals). First run: a real credential under another scheme and a hanging test (a process that should have refused to start) were the gaps; both are now covered.
- clippy `-D warnings` on the touched crates; `check:boundaries` OK; full gate: see the 19 November log.

## Not done
- A credential for the Playout MCP (`services/playout-mcp`): it has no HTTP transport today; if it gets one it uses the same `HttpAuth`.
- `docs/audit/osi-layering-2026-11-17.md` still lists finding 2 as open; the row closes it.
