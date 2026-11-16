# GrapiX debugging model and broadcast logging

Date: 16 November 2026. Status: **Proposed**. Nothing in this ADR is built yet
beyond what "Today" lists; `GrapiX-Build-Plan.md` remains the only
implementation plan, and the rows proposed at the end enter it when the user
accepts this design.

## The request (user, 16 November 2026)

> Write a debugging model for backend and front end, where if any issues faced
> can be debugged. Also when the application is finished, we need to have a
> log of whatever is being run, as it's a broadcast. Everything being logged is
> a good thing, so nothing randomly is flagged.

Two needs, kept apart on purpose:

1. **Debugging.** When something goes wrong on any machine, in any product, an
   engineer can find out what happened from the logs alone: what each process
   did, in order, joined across processes by the action that caused it.
2. **The broadcast record (as-run).** What went to air, when, at whose
   command, and what the engine actually committed, kept as a record that
   cannot silently lose or change a line.

"Nothing randomly flagged" is read as: the logs are complete enough that every
alarm, refusal or odd frame can be explained by what is in them, and nothing
appears without a cause on record.

## Today

- `gx-telemetry` (rows 0.5, 2.10) has typed audit and operations events and
  `Redacted`, which keeps credentials out of every log line (invariant 54).
  `init()` writes formatted text to stdout. No product depends on it.
- The render engine prints plain `eprintln!` lines; the Editor and Playout
  front ends log nothing; there is no log file anywhere.
- `platform::log_root()` names the per-user log directory.
- Row `12.11` (as-run record, first-release scope) is pending; its
  dependencies (2.9, 2.10, 6.2) are done. It names a "JSON Lines audit sink"
  that was never built.

## Decision (proposed)

### 1. One event, one schema

Every log line in every process is one JSON object on one line (JSON Lines),
built by `gx-telemetry`, never by `format!`:

| Field | Meaning |
| --- | --- |
| `ts` | UTC wall time, RFC 3339 with microseconds |
| `mono` | nanoseconds since the process started (orders events when the wall clock jumps) |
| `seq` | per-process sequence, from 1, no gaps; a gap means lost lines |
| `process`, `pid`, `version`, `build` | which binary, which run, which build |
| `level` | `error`, `warn`, `info`, `debug`, `trace` |
| `event` | a stable dotted name (`take.committed`, `edit.refused`, `frame.late`), defined once in `gx-telemetry` |
| `corr` | the correlation id of the action that caused it, when there is one |
| `epoch`, `frame` | the engine epoch and frame, when the event is about Program |
| `fields` | the event's typed fields; secrets only through `Redacted` |
| `refusal` | the named refusal code and detail, when the event is a refusal |

Field names are defined once, as the existing `frame_span` and `take_span`
are, so a search or a dashboard breaks loudly on a rename rather than silently.

### 2. One file per process, joined by a correlation id

Each process writes its own file:
`<log_root>/<product>/<process>-<UTC start>-<pid>.jsonl`. There is no central
collector to fail, and a crashed process still leaves its own file. A
**correlation id** is minted where an action starts (a front-end click, an MCP
call, a control-plane intent) and carried with it: the Tauri command, the MCP
request, the control-plane intent id, and every engine record that action
causes. Following one id across files reconstructs one action end to end.

### 3. Logging never stalls Program

Events go into a bounded in-memory queue; one writer thread per process
drains it to disk. The frame path never waits for a disk (invariant 14). If
the queue is full, events are counted, not written, and as soon as there is
room a `log.lost` record states how many and between which sequence numbers:
the loss is itself on record, never a silent gap, and `seq` shows it too. A
writer that cannot write at all (disk full) says so on stderr and in the
engine's status, so the operator learns that logging stopped.

### 4. What is logged, by default

Every **state change, command, refusal, connection change, publish,
configuration change and anomaly** is logged at `info`, in every process,
always. That is the "log everything" the request asks for, at the level of
what happened. Per-frame detail is not written for every frame by default; the
engine instead writes:

- every **late, missed or repeated** Program frame individually (`frame.late`,
  `frame.missed`), with its frame number and timing;
- a **heartbeat** once a second (`engine.heartbeat`: frames emitted, late,
  missed, ring state, GPU and output health), so the log is continuous and a
  quiet minute is visibly quiet rather than missing.

`debug` and `trace` (every frame's span, every layer) are switched on per
process (`GX_LOG`, as `RUST_LOG`) for deep debugging, never in a show by
default.

The catalogue of `info` events, by component:

| Component | Logged at `info` |
| --- | --- |
| Engine | start and stop (version, adapter, backend, tier), epoch, recovery restore, each publish received and prepared or refused, each Cue, Take, Update, Continue, Out and Clear accepted or refused with the committed frame, output armed, disarmed or failed, clock source and reference changes, frame anomalies, heartbeat |
| Editor shell and service | start and stop, project and scene opened, saved, created, deleted, every edit batch (command name, target, revision before and after, result), every refusal, publish attempts and results, imports with their reports |
| Playout shell and service | start and stop, connection and authentication (never the token), every operator command with page, take, revision and hash and its result, output configuration |
| MCP servers | start and stop, every `tools/call` (tool, scope, correlation id, idempotency key, result or refusal, duration), scope denials |
| Front ends | every shell call (start, end, result or refusal, duration), uncaught errors, unhandled promise rejections, `console.error`, page load and reload |

### 5. The as-run log (row 12.11)

A separate file per channel and day, `<log_root>/as-run/<channel>-<date>.jsonl`,
written by Playout from what the engine reports as committed:

- **Contents:** every Cue, Take, Update, Continue, Out and Clear, accepted or
  refused, with the 12.11 fields (sequence, intent id, operator identity and
  scope, page, revision, content hash, channel and layer, result, the
  engine-committed frame and its timecode), plus Program events that matter on
  air: output started or stopped, a device error, a late or missed frame while
  a graphic was up.
- **Durable:** each record is flushed and synced before the command's result
  is shown to the operator. It never goes through the bounded queue, so it is
  never one of the "lost" events; if it cannot be written, the operator is
  told at once.
- **Tamper-evident:** each record carries the SHA-256 of the record before it,
  so a removed, reordered or edited line breaks the chain where it happened.
- **Kept:** never rotated during a show; kept until an operator archives it.

### 6. Front ends

Both front ends install handlers for uncaught errors, unhandled promise
rejections and `console.error`, and wrap every shell call so its start, end,
result and duration are logged with a correlation id. All of it goes through
one shell command (`cmd_log`) into the shell's own file. The browser's
developer tools stay available in development builds.

### 7. Retention

Operational logs rotate by size (proposed 50 MB per file) and are kept 30
days. As-run logs are kept until archived (above).

### 8. The diagnostic bundle

One command (`gx-diag`, and a menu item in each shell) collects the last N
hours of every process's log, the as-run log, versions and build hashes, the
capability surface, the device and adapter, and the sanitised configuration
and recovery journal, into one archive for a bug report.

### 9. How an issue is debugged

1. The operator or author sees an error. Every error shown in a UI carries the
   action's correlation id and refusal code.
2. Open the bundle (or `<log_root>`) and search every file for that `corr`:
   the front end's call, the shell's command, the MCP or control-plane
   request, the engine's acceptance or refusal, in order.
3. For anything about Program, the engine's `frame.*` events and heartbeat
   around that time show cadence and output health; the as-run log shows what
   was on air.
4. If more detail is needed, reproduce with `GX_LOG=debug` (or `trace` for
   one process) and the same steps.
5. `seq` gaps and `log.lost` records say whether anything is missing from the
   picture.

## Rows proposed for the build plan

| Row | Work | Done when |
| --- | --- | --- |
| `2.11` | Structured JSON Lines log sink in `gx-telemetry`: the schema above, one file per process, bounded queue and writer thread, `log.lost`, size rotation and 30-day retention | A test floods the sink faster than it writes: the frame path never waits, every written line parses, `seq` has no gaps except those a `log.lost` record states; no credential appears in any line |
| `2.12` | Every process uses it: engine, host, Editor and Playout shells and services, both MCP servers; the info catalogue above; engine heartbeat and frame anomalies | Each process writes its file in a conformance run; every catalogue event appears when its action is driven; a late frame and a refusal each produce their record |
| `2.13` | Correlation ids end to end, and front-end capture through `cmd_log` | One Editor edit and one Playout take, driven from each front end, can each be followed by one id from the front end's call through the shell, the MCP or control plane and the engine |
| `2.14` | Diagnostic bundle (`gx-diag` and a shell menu item) | A bundle from a conformance run holds every process's log, the as-run log and the versions, and no credential |
| `12.11` | As-run record (existing row), written as section 5 says: synced per record, hash-chained, separate file | The existing done-when, plus: removing or editing one line is detected at that line |

## Jev and Laya on the design (`docs/evidence/logging/design-jev-laya.json`)

| Question | Jev | Laya |
| --- | --- | --- |
| format | JSON Lines (1.0) | JSON Lines |
| where events go | one file per process, one schema (1.0) | same |
| when logging cannot keep up | bounded queue, the loss logged (1.0) | same |
| the as-run log | separate, synced, hash-chained (1.0) | same |
| front ends | through the shell (1.0) | same |
| default verbosity | every state change at info (1.0) | trace always |
| retention | 30 days, as-run kept (1.0) | same |
| issue reports | one-command bundle (1.0) | same |
| must the user approve first | 0.66 | 0.71 |

They agree on everything but the default verbosity, and both say the user
should approve before it is built. On verbosity, this ADR proposes Jev's
answer with the heartbeat and every frame anomaly at `info`: tracing every
layer of every frame at 50 fps would cost disk and CPU next to the Program
clock and bury the events that explain an incident, while state changes,
anomalies and a once-a-second heartbeat already account for everything that
happened. The user decides.

## Jev and Laya on this record (`docs/evidence/logging/adr-acceptance-jev-laya.json`)

| Question | Jev | Laya |
| --- | --- | --- |
| how a backend issue is debugged | 0.96 | 0.93 |
| how a front-end issue is captured and traced | 0.97 | 0.92 |
| a complete record of what went to air | 0.87 | 0.92 |
| nothing left unexplained, losses on record | 0.92 | 0.91 |
| logging never stalls Program | 0.95 | 0.92 |
| the proposed rows are checkable | 0.92 | 0.93 |
| weakest point | operator identity (0.53) | the verbosity choice |

## Open questions for the user

1. **Default verbosity.** Every state change and anomaly at `info` with a
   once-a-second engine heartbeat (proposed, Jev), or every frame's trace
   always (Laya).
2. **Operator identity in the as-run log.** Today a Playout command carries a
   credential with scopes (2.9), not a named person. The as-run can record the
   credential's label and scopes now; a named operator login would be new work.
3. **When the as-run log cannot be written** (disk full, a failed drive):
   tell the operator at once and keep taking (proposed: a log fault must not
   take a graphic off air), or refuse further Program commands until it can.
4. **Retention.** 30 days of operational logs, as-run kept until archived.
