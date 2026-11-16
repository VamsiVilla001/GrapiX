# 2.12 — Every process logs through the sink (in progress)

Build-plan row `2.12` (ADR-0004). Done when: in a conformance run each process
writes its file; every ADR-0004 info-catalogue event appears when its action is
driven; a late frame and a refusal each produce their record; the default level
is every state change and anomaly at info plus a once-a-second engine
heartbeat. **Active.** Done: the render engine worker, the engine host, the Playout
shell, the Editor shell and every MCP server (at their one gate). Still to do:
a conformance run that reads every process's file, and stop records for the
shells and the worker (none of them has a clean-shutdown hook yet).

## The render engine worker (16 Nov 2026)

- `services/render-engine/worker/src/log.rs` names every engine event once:
  `program.cue`, `program.take`, `program.clear`, `program.phase`,
  `output.configure` and `render.request` at info with `result`
  (`committed`, `configured`, `rendered`, `refused`), the committed `frame`,
  the take, revision and pinned hash, and for a refusal its `refusal` code and
  detail; `engine.capability`, `engine.status` and `engine.performance` (polls)
  at debug; `publish.accepted` and `publish.refused`; `frame.late` (info) and
  `frame.missed` (warn, with how many); `engine.heartbeat` once a second
  (frame, rendered, late, missed, dropped, what is on Program, output
  inhibited, clock source and reference); `clock.changed` when the source or
  reference differs from the last heartbeat's (so within a second).
- `Engine::handle` (the control plane's one entry) notes each request,
  answers it, and logs the answer; the frame path logs anomalies and the
  heartbeat where the engine already measures them; the asset plane's publish
  is logged with its result.
- `main.rs` starts the sink first (`gx_telemetry::sink::init_process_logging`,
  `GX_LOG_DIR` or the platform log root; a sink that cannot start is reported
  and the engine runs on, by the user's rule that a logging fault never stops
  Program), writes `engine.start` (epoch, clock source and reference, version,
  tier, live capability, adapter,
  rate, locality, the bound control and asset addresses, whether a token is
  required, the log directory) and `recovery.restored`, and sends every fatal
  start-up error to the log as well as stderr before exiting.

**Executed.**

- `cargo test -p gx-render-worker --lib -- on_record emitting_frames_writes`
  (4): a take, an unknown take, a status poll and a clear through
  `Engine::handle` leave `program.take committed` (take, revision, hash,
  frame, epoch), `program.take refused` (`unknownTake`, the detail),
  `program.clear committed` and `engine.status` at debug; a publish accepted
  and one refused (a non-finite position) are both on record; an on-time frame
  writes nothing, a late one `frame.late` with its render time, a run of three
  missed frames `frame.missed`; the heartbeat writes once a second, not once a
  call, carries the clock, and a reference that locks between two beats writes
  one `clock.changed` naming both; three frames emitted inside a second write
  exactly one heartbeat.
- `cargo test -p gx-render-worker --test log_file`: the shipped binary,
  started with `GX_LOG_DIR`, writes `log.start`, `engine.start` (epoch, clock,
  tier, rate, the 127.0.0.1 control address) and a heartbeat from its live
  frame path.
- Mutations (`mutate_212.py`), one at a time, restored byte-identical: a
  request not logged, a late frame not logged, the frame path's heartbeat
  replaced by a fresh one each frame (survived the first test; the test was
  tightened to exactly one heartbeat a second), a poll logged at info, a
  publish not logged, `engine.start` renamed. 6 of 6 fail named tests.

**Jev and Laya on this slice** (`jev-laya-engine.json`). Jev scored the slice
0.33 complete and 0.58 that something must be fixed; Laya above 0.95 on every
question. Checked against the ADR's engine catalogue, Jev was right: the epoch,
clock source and reference were missing from `engine.start`, and clock changes
were not logged at all. Both are added above and tested. Still missing, named:
`engine.stop` (the worker has no shutdown hook; a killed engine's last record
is its last heartbeat, at most a second before it stopped).

**Not yet shown.** The call from the frame path to the anomaly log is not
mutation-tested (the late-frame test calls the logger directly; a late frame
cannot be forced on demand). No conformance check reads the engine's file yet.

## The engine host, Playout, the Editor and the MCP servers (16 Nov 2026)

- **Engine host** (`host/src/main.rs`): `host.start` (port, worker path),
  `host.engine_ready` (adopted or spawned, epoch, frame, tier, clock,
  reference, live allowed), `host.exit`, and `host.failed` with the reason
  before any exit; the log is written out before the process ends.
- **Playout shell** (`Playout/shell/src/lib.rs`): `operator.connect` (endpoint,
  whether a token was supplied, never the token; epoch, frame, tier, clock,
  reference), `operator.cue`, `operator.take`, `operator.clear`,
  `operator.phase`, `operator.configure_output`, each with the take, revision,
  pinned hash and when it was asked for, and the committed frame, or `refused`
  with the refusal code, or `failed` with the reason; `operator.status` polls
  at debug; `playout.start` in `run()`.
- **Editor shell** (`Editor/shell/src/lib.rs`): `editor.command` for every
  command through `execute` (the one the Tauri layer calls): its name, target
  (session or project/scene), the `ifRevision` named, the revision produced,
  how many edits, the effects, or the refusal code; `editor.publish` with the
  take, revision, pinned hash and hand-off, or the failure; `editor.start`.
- **MCP servers** (`services/mcp-server/src/lib.rs`): `mcp.call` for every
  `tools/call` on every path, at the one scope gate: tool, effect, the scope
  it needs, `ok` or
  `refused` with the code, `ifRevision`, idempotency key, argument size and
  duration, never the arguments; `editor-mcp` writes `mcp.start` and logs to a
  file only, since its stdout is the protocol.
- Every test that launches a product binary (ten sites in the MCP, host,
  Editor and conformance tests) now gives it `GX_LOG_DIR` in the temp folder,
  so the gate does not write into the operator's log root.

**Executed.** `cargo test -p gx-engine-host --test log_file` (2: the shipped
host adopting a running worker records the engine it found and finishes its
log; one that cannot ensure an engine records why before it exits);
`cargo test -p gx-playout-shell --lib` (5, two new: a take before connecting,
a bad endpoint and a malformed token on record with no token text; a take
committed and one refused, and a clear, through the real control transport to
a mock engine, with the committed frame, the refusal code, and the status poll
at debug); `cargo test -p gx-editor-shell --lib every_editor_command` (an
applied edit with its target and effects, a refused edit with its code, the
open); `cargo test -p gx-editor-mcp --test log_file` (the shipped binary over
stdio: `mcp.start`, a successful write with its idempotency key and duration,
a refusal with `projectNotFound`, and every stdout line JSON-RPC).

**Mutations** (`mutate_212b.py`), one at a time, restored byte-identical: the
host not recording the engine it found; a Playout take not recorded; the
token a caller passes written to the log; an MCP call not recorded; an Editor
command not recorded. 5 of 5 fail named tests (a first version of the token
mutation injected a constant into a record no test read for secrets, and
survived; the realistic leak, logging the caller's token, fails).

**Jev and Laya on this slice** (`jev-laya-slice2.json`): agreed that the MCP
arguments are rightly not logged (0.91 / 0.95) and the tests drive real paths
(0.90 / 0.96); Jev 0.19 that a token can reach the log (Laya 0.91, against
the code and the leak mutation). Jev scored the catalogue coverage 0.57; by
hand three gaps were real: the MCP record lacked the tool's scope (added,
tested); Playout records the take but not the take page, which never reaches
the shell today (the page travels with the correlation id in `2.13`); an
import records that it imported, not each substitution in its report (the
report is kept with the scene). Named, with the stop records and the
conformance read, as what keeps the row active.

**Gate.** The first `npm run check` on this slice failed one conformance
check, "headless renders while Program runs add no late or missed Program
frame": with 5 headless renders, 1 of 163 Program frames was late. Two
conformance reruns and a full gate rerun passed (594/0/9). The engine writes
on its frame path only when a frame is late or missed and once a second, so
the reading is the GPU this machine shares with other applications (see
3.21); it is recorded rather than explained away. Final gate: `npm run check`
exit 0 (46 Node, 412 Editor, 915 Rust passed, 0 failed, 38 ignored;
conformance 594/0/9); clippy `-D warnings` and fmt clean.
