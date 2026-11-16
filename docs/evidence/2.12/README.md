# 2.12 — Every process logs through the sink (in progress)

Build-plan row `2.12` (ADR-0004). Done when: in a conformance run each process
writes its file; every ADR-0004 info-catalogue event appears when its action is
driven; a late frame and a refusal each produce their record; the default level
is every state change and anomaly at info plus a once-a-second engine
heartbeat. **Active.** Done so far: the render engine worker. Still to do: the
engine host, the Editor and Playout shells and services, both MCP servers, and
a conformance check over all of their files.

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
