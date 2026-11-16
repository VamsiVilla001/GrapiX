# 2.13 — Correlation ids end to end; front-end errors, rejections and shell calls captured through `cmd_log`

Build-plan row `2.13` (ADR-0004 §2, §6, §9), 16 Nov 2026. Done when: one Editor
edit and one Playout take, driven from each front end, can each be followed by
one correlation id from the front end through the shell, the MCP server or
control plane, and the engine; an uncaught front-end error reaches the shell log
with its id.

The design, written before building, is `design.md`; the questions put to Jev
and Laya about it are `design-jev-laya.json`.

## What was built

- **The id.** `gx_telemetry::corr` (new): an id is 1 to 64 characters of
  `A-Z a-z 0-9 _ : -`; `mint(prefix)` makes `ed-…`, `po-…` or `mcp-…`; `enter(id)`
  puts one in a thread-local scope that nests, restores on drop (also out of
  order) and is per thread; the sink writes the scope's id as `corr` on every
  record the thread writes that does not name its own. The dot is not allowed,
  so a `gx1.` token is never a valid id: the first draft allowed it and the unit
  test that offers a token as an id failed it.
- **Front end to shell.** Each front end has one bridge (Editor
  `Editor/src/shell-bridge.ts`, Playout `Playout/web/shell-bridge.js`). It mints
  an id per shell call, sends it as the invoke header `x-gx-corr`, and reports
  the call's end (`ui.call`: command, id, duration, result code) through the new
  shell command `cmd_log`. It never reports a call's arguments, because a connect
  call carries a token. A failure remembers its call's id, and the line an
  operator reads quotes it (`… [po-ef46b859-11]`). `window.onerror`,
  `unhandledrejection` and `console.error` are reported under ids of their own
  (`ui.error`, `ui.rejection`, `ui.console`); `console.error` still prints; at
  most 60 reports in 10 seconds, and the next window says how many were dropped.
- **The shell.** `gx_shell_log::scoped` (new crate `Shared/shell-log`) wraps each
  shell's invoke handler: it reads the header, validates it (an invalid or absent
  id is replaced by a shell-minted one and `corr.rejected` is written without the
  presented text), and runs the command inside the scope. `cmd_log` accepts only
  the four `ui.*` kinds and a fixed set of fields, bounds the text, and replaces
  anything shaped like a credential before it is written
  (`gx_telemetry::ui`, `deny_unknown_fields`).
- **To the engine.** The control client builds the request's `MessageId` as
  `req.<n>.<corr>` from the scope; the transport's handler reads it, validates it
  and enters it around the engine's handling, so every engine record a request
  causes carries it. No protocol bump: an old peer reads `req.<n>`. The asset
  plane (the Editor's publish) puts a `corr` member in the request header JSON,
  on the first frame of a connection only; the engine's publish listener
  (`handle_publish`) removes it, validates it and enters it for the whole
  connection. (The library's stand-alone `AssetTransferServer`, which only the
  tests use, reads past the member and enters nothing.)
- **MCP.** The gate mints `mcp-…` for each `tools/call` and enters it; it never
  accepts the caller's id (the caller is untrusted input to the log).
- **The boundary guard** (`tools/check-boundaries.mjs`, R1/R4): the literal
  command list gains `cmd_log`, and `Editor/src/shell-bridge.ts` is the one file
  allowed to call the shell with a variable command name.

## Executed

**Live, on the real windows** (`live-check.mjs`, result in `live-check-result.json`):
a real `gx-render-worker`, then the real Playout window, then the real Editor
window, each started with `GX_LOG_DIR` in a scratch folder and a WebView2
remote-debugging port, driven through the DevTools protocol as an operator would
(clicks, typed fields, the Editor's `window.prompt` answered), closed with
`CloseMainWindow`, and the three files read back. 17 of 17 checks pass:

- One Playout take. Its id (`po-6312a22c-9` in the recorded run) is on exactly
  three records: the front end's `ui.call` (`cmd_take`, ok), the shell's
  `operator.take` (committed) and the engine's `program.take` (committed); the
  shell and the engine name the same committed frame (208).
- One refused take (`live/not-published`). The engine's `program.take` (refused,
  `unknownTake`), the shell's `operator.take` and the front end's `ui.call`
  (`refused:unknownTake`) carry the id the front end gave the call; the operator
  can read the id in the line that shows the refusal.
- An uncaught error and an unhandled rejection thrown in the Playout page are in
  the shell's file as `ui.error` (with source and stack) and `ui.rejection`, each
  with a `po-…` id.
- One Editor edit (a rectangle added from the front end): `ui.call cmd_execute`
  and the shell's `editor.command editScene (applied)` carry one `ed-…` id.
- One Editor publish: `ui.call cmd_publish`, the shell's `editor.publish
  (published)` and the engine's `publish.accepted` carry one `ed-…` id, over the
  asset plane.
- Both windows closed gracefully (exit 0, `playout.stop` / `editor.stop`, then
  `log.stop`), and no token or credential text is in any of the files.

The first runs of this script failed for reasons in the script, not the product:
Playout ignores a click while its start-up attach is running; a hung DevTools
call (the Editor asks for an object's name with `window.prompt`, which holds the
page until answered) had no timeout; the "refusal" it waited for was Playout's
first attempt at its default endpoint; and a check counted files instead of
records. The script now times each call out, accepts dialogs, runs under a
4-minute watchdog and names its last step.

**Unit and integration tests added.**
`gx-telemetry` `corr` (6), `ui` (6), `sink` (1: a record carries the entered
scope unless it names its own); control plane `MessageId` (1); control transport
(the connection test reads the id from the request and writes the refusal
records with it); asset plane (4: the header carries the id as its first member,
the listener enters it around a publish, a frame with an id reads as the same
request, and **the real client puts the id on its first frame and no other**);
`gx-shell-log` (1: a command runs inside the scope of its call's id); the engine
worker over a real connection (`log_corr`: every record a request causes carries
its id); the Editor MCP server (`log_file`: every tool call has an `mcp-…` id);
Editor front end (12, vitest) and Playout front end (11, node:test); the
boundary guard (the log command and the one bridge file are allowed; nothing
else).

**Mutations** (`mutate_213.py`, one at a time, restored byte-identical, each
must fail a named check): 19 of 19 caught.

| | Mutation | Failing check |
|---|---|---|
| A1 | the sink ignores the scope | `sink::tests::a_record_carries_the_entered_correlation_scope_unless_it_names_its_own` |
| A2 | a dot is a valid id character | `corr::tests::only_a_short_plain_id_is_valid` and 2 more |
| A3 | a front-end credential written as it came | `ui::tests::what_is_not_plain_is_replaced_cut_or_dropped_and_no_credential_is_written` |
| A4 | any kind of front-end entry accepted | `ui::tests::an_entry_of_another_kind_or_with_another_field_is_refused` |
| B1 | the control client sends no id | `log_corr::the_engine_writes_a_requests_correlation_id_on_every_record_the_request_causes` |
| B2 | the control server does not enter the id | the same test |
| B3 | the control server enters an id unchecked | `server::log_tests::connections_credentials_and_refusals_are_on_record_without_a_credential` |
| C1 | the asset-plane client adds no id | `publish::tests::the_server_enters_the_requests_correlation_scope_around_the_publish` |
| C2 | the asset-plane server does not enter it | the same test |
| C3 | the transfer client does not tag its first frame | **survived** (no test drove the client); fixed with `preflight::tests::the_client_names_its_action_in_its_first_frame_and_in_no_other`, which now fails it |
| D1 | the MCP gate enters no id | `log_file::every_tool_call_is_on_record_and_stdout_carries_only_the_protocol` |
| E1 | the shell wrapper enters no scope | `gx-shell-log::tests::a_command_runs_inside_the_scope_of_the_id_its_call_carried` |
| F1 | the Editor bridge sends no header | 3 tests in `Editor/tests/shell-bridge.test.ts` |
| F2 | the Editor bridge forgets which call an error came from | 2 tests there |
| F3 | the Editor does not capture rejections | 1 test there |
| F4 | the Editor reports a call with its arguments | 2 tests there (the secret is in the log) |
| G1 | Playout sends no header | 2 tests in `Playout/tests/shell-bridge.test.mjs` |
| G2 | Playout forgets which call an error came from | 1 test there |
| H1 | the boundary guard exempts a second file | `the bridge's exemption is that one file only` |

**Gate.** `cargo fmt --all --check` and `cargo clippy --workspace --all-targets
-D warnings` clean; `npm run check` exit 0: boundaries and codegen current, 60
Node tests, 424 Editor tests, 944 Rust tests, conformance 610 passed, 0 failed,
9 skipped (as at 2.12: the conformance run reads every process's file and was
not changed by this row).

## Jev and Laya

On the design (`design-jev-laya.json`): both classifiers agreed on where the id
is minted (the front end), how the engine's records get it (a thread-local scope),
that per-call ids are enough, and that the shell must validate the front end's
id. They split on two carriers, and their splits were decided by hand:

- *Carrier to the shell.* Jev: the invoke header (1.0). Laya: shared state, with
  probabilities 0.37 / 0.35 / 0.28, which is no signal (confidence 0.007). Built
  as a header, which is the one carrier that is the call's own and cannot be
  attached to the wrong call.
- *Carrier to the engine.* Jev: the `MessageId` (1.0). Laya: an envelope field,
  0.37 / 0.34 / 0.29 (confidence 0.005). Built in `MessageId`, because a new
  envelope field is a wire-version change and `MessageId` is already a free-form
  string the server reads for every request.
- Laya's four yes/no answers on the design were 0.96 to 0.98 and contradict each
  other (it says to accept the MCP caller's id and to replace the front end's;
  that the design needs a user decision and that it is enough), so I read them
  as no signal. Jev's were consistent (0.12 for accepting a caller's MCP id, 0.93
  that per-call is enough, 0.92 that the shell must validate). The MCP gate does
  not accept the caller's id.

On the slice and the row's acceptance (`jev-laya-slice.json`, the evidence and
the code together; Laya read all 7 716 tokens, `truncated: false`):

| Question | Jev | Laya |
|---|---|---|
| a Playout take followed by one id, front end to engine, executed | 0.90 yes | 0.98 yes |
| a front-end error and a rejection reach the shell log with an id, executed | 0.97 yes | 0.97 yes |
| **one Editor edit followed by one id all the way to the engine** | **0.07 no** | 0.99 yes |
| a credential can reach a log through this path | 0.24 no | 0.91 yes |
| something silently approximated or skipped | 0.34 no | 0.97 yes |
| the mutations show the checks can fail | 0.94 yes | 0.92 yes |
| weakest point | `editor_two_ids` (confidence 0.6) | `stale` |
| a defect to fix before committing | 0.55 | 0.93 |

Laya answered yes to every yes/no question (0.91 to 0.99), including ones that
contradict each other, as it did on the design; I read it as no signal. Jev's
answers follow the evidence, and its one *no* is the gap this README names first
(reading 1 below): the Editor's edit and the publish that carries it to the engine
have two ids, so one id does not run from an edit to the engine. That is the
weakest point of this row, not a hidden one.

Jev's 0.55 on "a defect to fix" was not left as it came. A code-only run
(`jev-laya-code.json`, Laya 3 856 tokens, not truncated) asked where a defect
could be: can invalid text reach a log as an id (Jev 0.31, no), can a scope leak
to a later request (0.24, no), is the asset-plane id entered for the right span
(0.62, yes), do old peers still work (0.89, yes); and "is there a defect": Jev
0.70, Laya 0.90. I read the code it was shown (the scope stack and its drop
order, `adopt`, the control server's per-request scope, the asset plane's
first-frame removal and span, `with_correlation`) and found none; the 0.70 is a
lean, not a finding. Reading it produced one correction, to this README: only the
engine's publish listener enters the id, not the stand-alone test listener.

## Named readings and gaps

1. **"One Editor edit … through … the engine" is read as two chains.** An Editor
   edit is followed from the front end to the shell (`cmd_execute`, then the
   shell's `editor.command`); it does not reach the engine, because the Editor's
   scene is local until it is published. What reaches the engine is the
   **publish**, which carries its own id (`ed-…`, `cmd_publish` →
   `editor.publish` → `publish.accepted`). The edit's id and the publish's id are
   two ids. One id across a gesture (an edit, then the publish of it) is the
   *gesture id* of design item 8, not built. If the row's done-when means one id
   from an edit to the engine, this is the gap to close: **Jev says it is not met
   on that reading (0.07)**, so it is a new row, `2.17`, and the user decides
   whether 2.13 stands on the two-chain reading.
2. **An id is one shell call, not one operator gesture** (design item 1).
3. A successful `cmd_status` poll is written at debug by the front end (its
   failure at info), so it is not in a default-level file.
4. The MCP gate's id reaches an engine only through a tool that talks to one
   (Playout's); that path is covered by the control-plane test and the MCP
   gate's own test separately, not by a run that drives an MCP tool to an engine.
5. Not in this row: a gesture id, the MCP *client's* own request id, the
   as-run record's use of the id (12.11).
6. **Observed in the hung live run, not a 2.13 matter:** the engine (a debug
   build) was late on every frame (render about 51 ms against a 20 ms interval)
   and wrote a `frame.missed` and a `frame.late` record for each one: 207 255
   lines in about 90 minutes (38 a second). Each is a true
   anomaly under ADR-0004, but a continuous stream of them buries the rest of the
   file. A coalescing rule for a run of late frames is worth deciding
   (open question for the user; it is a change to 2.12's catalogue).
