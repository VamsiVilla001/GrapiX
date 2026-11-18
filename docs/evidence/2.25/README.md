# 2.25 — the log sink keeps `log.lost` true when threads log at once (18 Nov 2026)

Found by the gate for row 2.21: in the engine's log `log.lost` named number 48, then 49 was written, then 48
(`docs/evidence/2.21/gate-first-run-failure.txt`). `offer()` in `Shared/telemetry/src/sink.rs` took the number, built
the line and then queued it, so two threads could queue in the other order; the writer stated the late one lost and
wrote it after.

## Fix

The number is taken, the line rendered and offered to the queue under one short lock (`Shared::order`), so the queue
receives records in the order of their numbers. The offer still never waits on the queue (`try_send`): a full queue
drops the record and the dropped number is a gap the writer states, as before.

## What was run

- `a_record_held_after_its_number_is_not_overtaken_or_stated_lost`: a test hook holds one thread between taking number
  2 and queueing it while a second thread logs; the file holds 2 then 3, in order, and no `log.lost`. Deterministic:
  the race window is held open, not raced for.
- `threads_logging_at_once_write_every_number_once_and_in_order`: 8 threads x 400 records, five rounds; every number
  written once, in order, nothing stated lost.
- **Mutation:** releasing the lock before the number is taken (`drop(_in_order)`) makes both tests fail by name; the
  file was restored byte-identical. (Removing the guard binding entirely does not compile: Rust refuses a non-binding
  `let` on a lock.)
- Gate on the final tree (separate build folder): `FMT_OK`, clippy exit 0, `npm run check` exit 0 (76 Node, 424 Editor,
  1057 Rust with 38 ignored, conformance 631 passed, 0 failed, 9 skipped).

## Found on the way, not this row's

An earlier gate run failed `every_editor_command_and_its_answer_is_on_record` (Editor shell): 2 runs in 20 in
parallel, the same 2 in 20 with the old sink put back, so it predates this row. Cause: `tracing` decides once per call
site whether anyone listens, and with a single scoped subscriber it decides from the thread that first reaches the
call site. Fixed in the test module: a do-nothing global subscriber is installed once before a log capture (and the
three capture tests take one lock); 40 runs in 40 then passed. A test lock alone made it worse (6 in 40).
