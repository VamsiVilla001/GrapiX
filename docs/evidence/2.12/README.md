# 2.12 — Every process logs through the sink

Build-plan row `2.12` (ADR-0004). Done when: in a conformance run each process
writes its file; every ADR-0004 info-catalogue event appears when its action is
driven; a late frame and a refusal each produce their record; the default level
is every state change and anomaly at info plus a once-a-second engine
heartbeat. Done in three slices (16 Nov 2026): the render engine worker; the
engine host, Playout shell, Editor shell and MCP servers; then the control
transport's own records, the stop records, and a conformance run that reads every
process's file (**Slice 3**, last section). Named gaps that stay open are listed
there.

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

## Slice 3 — the transport's records, stop records, and the conformance read (16 Nov 2026)

**Built.**

- **Control transport** (`Shared/control-transport/src/server.rs`): a connection
  is on record from accept to close: `control.connected` (peer address, whether
  the engine requires a credential), `control.authenticated` (subject, role and
  scopes the credential proved; never the credential), `control.refused` for
  every request the transport answers before the engine sees it (no credential,
  a credential that does not verify, a scope the credential lacks; with the
  request, the refusal code and who asked), and `control.disconnected` (requests
  served, and why it ended). A credential that does not verify is recorded by a
  fixed word (`macMismatch`, `unknownPrefix`, ...), not by the error's own text,
  because an unknown-prefix error quotes what was presented.
- **A defect the new test found:** a dropped control `Client` never closed its
  socket. Its reader thread held the other half of the connection, so the
  engine kept a thread and an open connection per departed client until the
  process ended, and could never log the client leaving. `Client` now closes its
  connection when dropped (`ControlWriteHalf::close`, shutdown both directions
  on TCP and Unix sockets; a Windows named pipe has no such call and closes with
  its halves). The first run of the test hung on exactly this; it now has a
  20-second watchdog.
- **A gap I found reading the path:** the transport hands a headless render to the
  engine through `handle_detached`, which does not pass through `handle`, so a
  render served over the wire was never logged. It is now recorded where it is
  answered (refused while the engine is held, or drawn after it is released),
  once, whichever entry reaches it.
- **Stop records.** Both windowed shells write `editor.stop` / `playout.stop`
  and finish their log when the window closes (`RunEvent::Exit`; Tauri's event
  loop does not return to `run`, so nothing after it would be reached). The
  Editor MCP server writes `mcp.stop` when its client closes or its transport
  fails. The engine host already wrote `host.exit`. The engine worker writes
  `engine.stop` when its listener ends by its own code.
- **The conformance run reads every process's file**
  (`conformance/src/process_logs.rs`, 16 new checks): every launch in the run
  logs into one scratch folder at the default level; the run then reads back, by
  pid, the render worker it drove (file opens with `log.start` and `engine.start`
  for that control address; a committed take with its take, revision and frame; a
  refused request with its code and detail; a publish and a headless render; a
  client connecting and leaving; heartbeats a second apart and no status poll
  written), the protected worker (the credential accepted by subject, role and
  scopes; a request outside its scopes with who asked), the engine host it runs
  against that engine (start, the engine it adopted with its epoch, exit, log
  finished), and the Editor MCP server it starts and speaks to (start, a call
  answered with tool, scope, duration and idempotency key, a call refused with
  `projectNotFound`, stop, and a stdout that carries only JSON-RPC). Then every
  file of the run: each line parses and has the schema's fields; no sequence
  gap that a `log.lost` does not state; every late or missed frame a heartbeat
  counts has its own record; no credential the run used, and no `gx1.` token, in
  any file.

**Executed.**

- `cargo test -p gx-control-transport --lib log_tests` (1): three clients on a
  protected server (none, a credential made with another secret, one that may cue
  but not take) leave `control.connected` x3, one `control.authenticated`
  (`cue-operator`, `[Cue]`), `control.refused` for the missing credential
  (`unauthenticated`), the wrong one (`macMismatch`), and the take outside the
  scope (`scopeNotGranted`, subject and role), and `control.disconnected` x3 with
  the request count; no credential, MAC or payload text in any line.
- `cargo test -p gx-render-worker --lib -- on_record emitting_frames_writes`
  (6): the four earlier tests, plus frames the clock passed on record from the
  frame path itself (`frame.missed` at warn, 4 missed), and a headless render on
  record once by either entry (4 requests: rendered, refused, rendered, refused).
- `cargo test -p gx-editor-shell -p gx-playout-shell --lib closing_writes` (2):
  closing writes the product's stop record and finishes the log (`*.stop` then
  `log.stop` are the file's last two records).
- `cargo test -p gx-conformance --lib process_logs` (4): the file-name parser, the
  sequence-gap rule, the heartbeat/anomaly agreement rule and the schema rule
  each accept a whole file and refuse a broken one.
- `npm run conformance`: **610 passed, 0 failed, 9 skipped** (was 594/0/9: the 16
  new checks pass, the skip count is unchanged). "Every late frame ... has its own
  record" ran against a file with late frames (a skip is reported when none
  occur).
- **Live, on the real windows** (not part of the automated run: a conformance run
  opens no window). The shipped `gx-editor.exe` and `gx-playout.exe`, started with
  `GX_LOG_DIR` in a scratch folder and closed with `CloseMainWindow` (a graceful
  close), write: Editor `log.start`, `editor.start`, `editor.command` (`openScene`,
  from the live front end), `editor.stop` ("the window closed"), `log.stop`
  (lastSeq 4), exit 0; Playout `log.start`, `playout.start`, `operator.connect`
  (its front end tried the default engine address and was refused, on record),
  `playout.stop`, `log.stop`, exit 0. A force-terminated Editor (exit 15) leaves its
  file whole up to its last record and no stop record, as a kill must.

**Mutations** (`mutate_212c.py`), one at a time, restored byte-identical: 16 of 16 fail a named check (after the C3 check was strengthened):

| Mutation | Failing check |
| --- | --- |
| T1 a scope denial not recorded | `log_tests` |
| T2 a refused credential recorded with the error's text | `log_tests` |
| T3 a departed client does not end its connection | `log_tests` (the watchdog) |
| T4 the presented credential written when it verifies | `log_tests` |
| W1 a render drawn after release not recorded | `a_headless_render_is_on_record_once_by_either_entry` |
| W2 an in-process render recorded twice | the same |
| W3 the frame path writes no anomalies | `frames_the_clock_passed_are_on_record_from_the_frame_path` |
| S1 the Editor leaves its log unfinished on close | `closing_writes_a_stop_record_and_ends_the_log` |
| S2 Playout writes no stop record | the same |
| C1 the MCP server writes no stop record | conformance: the MCP file "does not end with mcp.stop and log.stop" |
| C2 the engine does not record a client leaving | conformance: "no control.disconnected for a client that left" |
| C3 a status poll written at the default level | conformance: "a debug record at the default level". The first version of this check looked only for debug-level records, so the mutation (the poll written at info) **survived**; it now looks for the poll events themselves, and the mutation fails it |
| C4 the host does not say it is leaving | conformance: the host file "ends with log.stop, not host.exit" |
| C5 a late frame counted and not written | conformance: "every late frame and missed frame a heartbeat counts has its own record" |
| C6 the heartbeat written every frame | conformance: "two heartbeats less than a second apart" |
| C7 the engine writes the control secret it was started with | conformance: "no credential the run used is in any log file" |

**Named gaps (not closed by this row).**

1. **A killed or interrupted engine writes no `engine.stop`.** The worker writes it
   only when its listener ends by its own code. Ctrl+C and a forced kill end a
   Windows process without running any of our code; catching Ctrl+C needs a
   console-control handler, which the crate's `#![forbid(unsafe_code)]` rules out
   by hand and which the `ctrlc` crate would give (a download, not in the lock
   file, so not added without the user's approval). Today a stopped engine's last
   record is its last heartbeat, at most a second before it ended, and the next
   start's `log.start`/`engine.start` follows it. Closing this needs either that
   crate or an orderly-stop request on the control plane. The one path that does
   write `engine.stop` (the listener ending on a persistent accept failure) is
   built and reviewed but no test drives it: that failure cannot be produced on
   demand.
2. **The windowed shells are covered by unit tests and the live launch above, not by
   the automated conformance run.** The run opens no window.
3. **`cargo test -p gx-engine-host --test ensure` fails two tests on this machine,
   before and after this work:** they start a worker with no
   `--recovery-journal`, so it reads the user's own journal at
   `%APPDATA%\GrapiX\GrapiX\data\render-engine\recovery.json`, written by an
   older worker (schema 1; the worker supports 3). The journal is the user's and is
   left alone; the repository gate excludes `gx-engine-host` (`test:rust:host`) for
   this kind of reason.
4. The take page and the import report's per-substitution detail are not in the
   logs yet; they travel with the correlation id in `2.13`.

**Jev and Laya on this slice** (`jev-laya-slice3.json`; Laya is laya-multilingual at
max_len 8192, 6948 tokens, not truncated). Laya answers about 0.95 to nearly every
yes/no question whatever its polarity, so a split is decided by hand.

| Question | Jev | Laya | Decided |
| --- | --- | --- | --- |
| the done-when met by execution | 0.80 | 0.96 | yes |
| the engine-stop gap is named, with its reason and its remedy | 0.98 | 0.95 | yes |
| the mutations can fail | 0.96 | 0.91 | yes |
| every process, shells included, is read back from its own file | 0.41 | 0.91 | **no, for the automated run**: the shells are covered by unit tests and a live launch (named gap 2). Jev is right. |
| a credential can reach a log | 0.19 | 0.96 | no: Jev is right. No path writes one; mutations T2, T4 and C7 (and P2 earlier) show the checks catch one |
| a silent substitution | 0.28 | 0.97 | no: Jev is right; the engine stop, the shells, the stale journal and the take page are each named |
| weakest point | engine stop | shells not in conformance | both are named gaps (1 and 2) |
| a defect to fix before committing | 0.39 | 0.91 | my own review found two: a fixed 300 ms sleep before reading the engine's file (now a bounded wait for the record, up to five seconds), and a check that a mutation survived (C3, strengthened) |

**Gate.** `npm run check` exit 0 (46 Node, 412 Editor, 924 Rust passed, 0 failed, 38 ignored; conformance
610/0/9); `cargo fmt --all --check` and `cargo clippy --workspace --all-targets
-- -D warnings` clean.
