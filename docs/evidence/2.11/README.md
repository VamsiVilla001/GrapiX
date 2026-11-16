# 2.11 — The structured JSON Lines log sink

Build-plan row `2.11` (ADR-0004, accepted by the user 16 Nov 2026). Done when:
a test floods the sink faster than it writes: the caller never waits, every
written line parses against the ADR-0004 schema, `seq` has no gaps except those
a `log.lost` record states, files rotate by size and expire after 30 days, and
no credential appears in any line.

## What it is

`Shared/telemetry/src/sink.rs`:

- **One schema.** Each event is one JSON object per line: `ts` (UTC, RFC 3339,
  microseconds), `mono` (ns since the sink started), `seq` (per process, from
  1), `process`, `pid`, `version`, `level`, `target`, `event`, then `corr`,
  `epoch`, `frame` and `refusal` lifted to the top when the event names them,
  and every other field under `fields`. An event's name is its `event` field;
  a dependency's plain message becomes `<target>.message` with the message
  kept as a field.
- **The caller never waits.** `JsonLayer` (a `tracing` layer) numbers each
  event and `try_send`s it to a bounded queue (65,536 by default). A full
  queue means the line is not written and nothing else happens on the calling
  thread.
- **Losses are on record.** The writer thread sees every gap in `seq` and
  writes a `log.lost` record with `count`, `fromSeq` and `toSeq` (and no `seq`
  of its own); at shutdown it states any loss after the last written line.
  `LogGuard::finish` (or drop) sends the writer an explicit stop: it drains
  what is queued, states any loss, writes `log.stop` with the last number, and
  flushes. The stop is explicit because the globally installed subscriber
  holds a layer for the life of the process, so the queue never closes by
  itself (found by the code review below; the first version would have hung
  at shutdown).
- **Files.** `<log root>/<product>/<process>-<UTC start>-<pid>-<part>.jsonl`,
  a new part at 50 MB; at start, `.jsonl` files older than 30 days are
  removed and the sweep is itself recorded (`log.expired`). The first line of
  every file's run is `log.start`. Other files are never touched; the as-run
  log (12.11) will live in its own directory.
- **Filter.** `init_logging` installs the sink with `GX_LOG` (or `RUST_LOG`),
  default `info` (the user's decision: every state change and anomaly at
  info).
- No new dependency: `serde_json` was already in the workspace; the UTC
  formatting is written out (civil-date algorithm), tested against fixed
  instants including a leap day.

## Verified by execution

`cargo test -p gx-telemetry`: 8 passed, 0 failed.

- `a_flood_never_makes_the_caller_wait_and_every_loss_is_stated`: a 32-event
  queue and a writer held to 1 ms a line; 5,000 events are emitted in under
  1.5 s (writing them would take 5 s), no single event takes 50 ms; every line
  parses and carries the schema's keys; every number from 1 to 5,001 is either
  written once or inside exactly one `log.lost` range, never both, and the
  stated counts match their ranges.
- `a_line_carries_the_schema_and_never_a_credential`: a token passed as
  `Redacted` appears only as `<redacted>` and its value nowhere in the file;
  `corr`, `epoch` and `frame` are at the top; `ts` is RFC 3339 UTC; the first
  line is `log.start`; a plain message is kept.
- `files_rotate_by_size_and_the_numbering_runs_on`: 4 KB parts; 401 lines over
  more than five files, none over its size, `seq` running 1, 2, 3... across
  parts, nothing lost.
- `expired_files_are_removed_at_start_and_others_kept`: a 31-day-old log is
  removed, a recent log and a non-log file of the same age are kept, the sweep
  is recorded.
- `finishing_returns_while_a_subscriber_still_holds_the_layer`: a subscriber
  keeps a layer alive, as the global one does; `finish` returns within 10 s,
  the file ends with `log.stop` naming the last number, and a late event from
  the held layer neither writes nor hangs.
- `utc_time_is_formatted_from_the_epoch`.
- The two existing audit tests still pass.

**Mutations**, one at a time, files restored byte-identical
(`mutate_211.py`): the caller waiting for room in the queue; a gap not stated;
a loss at the end not stated; files never rotating; expired files kept; `corr`
left inside `fields`; a secret rendered as nothing rather than the marker. 7
of 7 fail named tests. An eighth, the guard not sending the stop, hangs every
test that finishes a guard, so the suite does not pass (it ends on the
mutation script's timeout rather than a named failure).

## Jev and Laya

The code review (`jev-laya.json`, first version of the code) split: Jev 0.49
that the done-when is met and 0.42 that a defect must be fixed; Laya above
0.95 on every yes/no question, including "can a caller wait" and "can a
credential reach a line", which the code and the tests answer no, so its
answers do not discriminate here. Checking the weak points by hand found the
real defect above (a global subscriber holding a sender, so finishing would
never return); it is fixed and tested. The re-run on the fixed code is
`jev-laya-final.json`:

| Question | Jev | Laya |
| --- | --- | --- |
| done-when met by execution | 0.69 | 0.99 |
| a caller can wait | 0.19 | 0.98 |
| losses stated exactly | 0.92 | 0.98 |
| finishing writes everything queued | 0.80 | 0.98 |
| a credential can reach a line | 0.15 | 0.39 |
| weakest point | the global subscriber (0.69) | none |
| a defect to fix first | 0.35 | 0.98 |

Jev's weakest point, checked again, found one more silent case:
`init_logging` ignored a subscriber already installed, so the sink would have
received nothing. It now refuses with an error naming that. Laya's "a caller
can wait" and "a defect to fix" are contradicted by the code (`try_send` only)
and by the tests; the split is reported to the user.

## Not in this row

- An event from the global subscriber after the guard has finished (late in
  process exit) is not written and not counted.
- `init_logging`'s refusal of an already-installed subscriber is not tested
  (a test would have to install a process-wide subscriber); it is a direct
  `map_err` on `set_global_default`.

- No process uses the sink yet; that is `2.12` (engine, host, shells,
  services, MCP servers), with correlation ids and front-end capture in `2.13`.
- A writer that cannot write (disk full) ends with an error that
  `LogGuard::finish` returns and drop prints to stderr; telling the operator
  through the engine's status is `2.12`.
- The as-run log (synced, hash-chained) is `12.11`.
