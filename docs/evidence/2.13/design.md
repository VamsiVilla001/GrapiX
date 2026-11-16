# 2.13 design: correlation ids end to end, and front-end capture

Row `2.13` (ADR-0004 §2, §6, §9). Done when: one Editor edit and one Playout take,
driven from each front end, can each be followed by one correlation id from the
front end through the shell, the MCP server or control plane, and the engine; an
uncaught front-end error reaches the shell log with its id.

Written 16 Nov 2026, from reading the code, before building.

## What exists

- The sink lifts an event's `corr` field to the record's top level (2.11). Nothing
  sets it.
- Both front ends reach their shell through one bridge: the Editor's `shell()`
  (`Editor/src/command-client.ts`, 30 call sites in `Editor/web/main.ts`) and
  Playout's `invoke()` (`Playout/web/main.js`, 13 call sites).
- Every `cmd_*` in both shells is a synchronous function, so a command runs on the
  thread that received it.
- Tauri passes a command's request headers to the shell
  (`Invoke::message.headers()`), and the JS `invoke` accepts `{ headers }`.
- The control plane's envelope carries a free-form `MessageId` string
  (`req.<n>`); the server reads it for every request; ids starting `reply.` or
  `event.` mean replies and events, nothing else is reserved.
- The asset plane (the Editor's publish) sends one framed JSON header per request,
  parsed with serde; an unknown key is ignored.
- `mcp.call` is logged at the one gate every MCP request passes through, on a
  single driver thread.

## Design

1. **Minted at the front end, once per shell call.** The front end's bridge makes
   an id (`ed-` or `po-`, a random part, a count) for each call to its shell and
   sends it as the header `x-gx-corr`. One id is one call, not one operator
   gesture: a gesture that makes three calls has three ids. The three are
   related by time and by the front end's own start/end records, which carry the
   same ids, not by a fourth id. (A gesture id is a later refinement, not needed
   by the done-when.)
2. **The shell scopes it.** One wrapper around each shell's invoke handler reads
   `x-gx-corr`, validates it (1 to 64 characters of `A-Z a-z 0-9 _ : -`; anything
   else is replaced by a fresh shell-minted id and the replacement is logged as
   `corr.rejected` without the presented text, so a front end cannot smuggle text, a
   line break or a `gx1.` token into a log. The first version of the rule allowed
   the dot, and the unit test that offers a `gx1.` token as an id caught it: a
   token is only letters, digits and dots. The check is of shape, not meaning), and runs the command inside a correlation scope.
3. **The scope is a thread-local** (`gx_telemetry::corr`). While it is entered,
   every log record the thread writes without its own `corr` carries the scope's
   id. No function signature changes. It works because the commands, the control
   client, the transport's per-connection handler and the MCP gate each do their
   work on one thread. An id that must cross a thread is passed explicitly and
   entered again on the other side.
4. **To the engine, in the control envelope's `MessageId`.** The client builds the
   request id from the scope: `req.<n>` becomes `req.<n>.<corr>` when a scope is
   entered. The transport's handler reads the id, enters the same scope around the
   engine's handling, and every engine record that request causes carries it. No
   wire-version change: ids are opaque strings and an old peer that sends or reads
   `req.<n>` is unaffected.
5. **To the engine over the asset plane**, the same way: the publish client adds a
   `corr` key to the request header from the scope; the asset-plane server reads it
   before parsing the request and enters the scope around the publish.
6. **MCP.** The gate mints an id for each `tools/call` (`mcp-` and a count) and
   enters it around the call, so `mcp.call` and everything the call writes carry
   it; an MCP tool that talks to an engine (Playout's) therefore sends it in the
   envelope. The gate does not accept an id from the caller: an MCP client is
   untrusted input to the log, and its idempotency key already names a retry.
7. **Front-end capture through one shell command, `cmd_log`.** The bridge reports
   each call's end (command name, id, duration, ok or the error's code), never its
   arguments, because a connect call carries a token. Handlers for
   `window.onerror`, `unhandledrejection` and `console.error` report the error
   with an id of its own. `cmd_log` validates level and event name against a short
   list (`ui.call`, `ui.error`, `ui.rejection`, `ui.console`), bounds the text to
   2 000 characters, and writes it to the shell's log as `ui.*` events with the id.
   An error that comes back from a shell call carries the call's id, and the
   front end shows it, so an operator can quote it.
8. **Not in this row:** a gesture id, correlation through the MCP *client's* own
   request id, and the as-run record's use of the id (12.11).

## Questions put to Jev and Laya

See `design-jev-laya.json`.
