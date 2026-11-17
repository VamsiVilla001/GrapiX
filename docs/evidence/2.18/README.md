# 2.18 — a console window close ends the engine in order (17 Nov 2026)

Row 2.16 left a named limit: Ctrl+C and Ctrl+Break ended the engine in order, but
a console window close wrote `engine.stop` and not `log.stop`, so the next start
reported an engine that was closed on purpose as one that died. The user allowed
a small `unsafe` block to close it (17 Nov 2026). This row is that fix.

## Done-when

> An engine ended by closing its console window writes `engine.stop` naming that
> event, then `log.stop`, and exits 0, as Ctrl+C and Ctrl+Break do; each of the
> three is named by its own reason; the next start names none of them as
> unfinished.

## What was built

- **`Shared/console-stop`** (`gx-console-stop`), a new workspace crate. One safe
  function, `on_console_event(closure)`, registers a Windows console control
  handler and calls the closure with the event that came (`CtrlC`, `CtrlBreak`,
  `Close`, `Logoff`, `Shutdown`) **on the system's handler thread, before the
  handler returns**. That ordering is the fix: Windows ends the process when the
  handler for a close returns, and `ctrlc` (2.16) ran the closure on another
  thread, which lost the race. The crate holds the one `unsafe` block in the
  stop path (a single call to `SetConsoleCtrlHandler`); it is `deny(unsafe_code)`
  with one `allow`. A panic in the closure is caught and does not unwind into the
  system. One handler per process; a second is refused.
- **The engine** (`services/render-engine/worker/src/main.rs`) uses that crate
  instead of `ctrlc`, keeps `#![forbid(unsafe_code)]`, and writes `engine.stop`
  with the exact event as its reason: "Ctrl+C at the console", "Ctrl+Break at the
  console", "the console window was closed", "the user logged off", "the system
  is shutting down". Before, one generic reason named all five. The handler
  takes the log before it writes, so when two events come close together (Ctrl+C
  pressed twice) only the first writes `engine.stop`; the second waits and writes
  nothing. That was found on review (below), not designed in.
- **No download.** `windows-sys 0.61.2` with `Win32_System_Console` was already
  in the lockfile (through `ctrlc`). `Cargo.lock` gains only the new workspace
  crate and moves `ctrlc` from the worker to it. `ctrlc` is now used only off
  Windows, inside `gx-console-stop`.

## What was run

- `cargo test -p gx-console-stop`: 3 of 3 (each control code maps to its own
  event and reserved codes to none; every event has its own reason; the closure
  gets each event before the handler returns, a panic is caught, a second
  handler is refused).
- `cargo test -p gx-render-worker --bin gx-render-worker`: 2 of 2 (a console
  event leaves `engine.stop` naming it and then `log.stop`; a second event that
  arrives while the first is finishing the log waits and writes nothing).
- **Live, on the real engine binary** (`node docs/evidence/2.18/live-check.mjs`,
  result in `live-check-result.json`): **15 of 15**. Three engines, each in its
  own console window, ended by a real Ctrl+C, a real Ctrl+Break and the window's
  own close request. Each exited 0, wrote `engine.stop` at info with its own
  reason, and had `engine.stop`, `log.stop` as its last two records. A fourth
  engine named none of them, was killed outright and wrote no stop record; a
  fifth named it once (pid, last sequence number, last timestamp), so the 2.16
  naming of a real kill holds beside the new handler.
- The gate (`cargo fmt --check`, `cargo clippy -D warnings`, `npm run check`) exited 0: 424 Editor tests, 963 Rust tests passed, 0 failed, 38 ignored, conformance 610 passed, 0 failed, 9 skipped. It is also
  recorded in the plan row and `memory.md`.

## Mutations

14, one at a time, each restored byte-identical, each made a named check fail
(`mutations.log`, the runner's own output: the first run of 13, then the reruns
on the handler as changed after review, D6 added; the runner writes to a file, kills the
process tree on timeout and sweeps scratch engines).

| # | Mutation | Fails |
|---|---|---|
| C1 | a window close is not a known event | `each_control_code_is_its_own_event_and_the_reserved_ones_are_none` |
| C2 | a reserved code is taken for a shutdown | the same test |
| C3 | a panic in the closure is not caught | `the_closure_gets_each_event_before_the_handler_returns_and_a_second_is_refused` |
| C4 | a second handler is accepted | the same test |
| C5 | a logoff and a shutdown give the same reason | `every_event_has_its_own_reason` |
| C6 | the close reason says something else | worker `an_interrupt_writes_engine_stop_and_finishes_the_log` |
| C7 | the closure runs on another thread and the handler returns at once (the 2.16 behaviour) | live: "a window close: the last two records are engine.stop and log.stop", its exit code, and "the next engine names none of the three" |
| C8 | the handler is removed, not added | live: every Ctrl+C and Ctrl+Break check |
| D1 | a console event writes no `engine.stop` | worker `an_interrupt_writes_engine_stop_and_finishes_the_log` |
| D2 | a console event does not finish the log | the same test |
| D3 | every event is recorded as Ctrl+C | live: the Ctrl+Break reason and the close reason |
| D4 | the handler ends the process with code 1 | live: exit code 0, all three events |
| D5 | the handler records the stop and returns without ending the process | live: exit code 0, all three events |
| D6 | the stop is written before the log is taken (a second event writes `engine.stop` again) | worker `a_second_event_during_the_first_waits_and_writes_nothing` |

D1 to D6 and C6 were run again after the handler changed on review. A first
version of the second-event test called the handler twice in a row and D6
survived it (the sink already drops a write made after the log is finished), so
the test was rewritten to hold the first event half way while the second arrives.

C7 is the one that matters most: it puts the 2.16 behaviour back, the unit tests
still pass, and only the live window close catches it.

## Jev and Laya

Design consult (`jev-laya-design.json`): both chose an own handler in a new crate
(Jev 0.92) and the `unsafe` block in its own crate (Jev 1.00). Jev thought keeping
`ctrlc` for Ctrl+C carried less risk to the proven path (0.83); decided by hand
for one handler, because one path names the exact event for every case and the
Ctrl+C path was proven again by the same live check and by C8, D3, D4 and D5. On
logoff and shutdown Jev chose "handle them if they arrive and name the limit"
(1.00) and Laya chose "ignore and do not mention"; decided by hand for Jev's: a
gap is never left unnamed.

Slice review (`jev-laya.json`, run before the second-event fix): Jev close orderly
0.97, Ctrl+C still orderly 0.95, the unsafe block sound 0.90, mutations can fail
0.98, silent substitution 0.37, must fix 0.36, weakest point "logoff and shutdown
not run" (0.86). Jev gave 0.72 to "the handler can deadlock or lose records in a
way the evidence does not name". Looking for such a case found one: two events
close together each wrote `engine.stop`, the second possibly after the first had
begun finishing the log. Fixed (the log is taken first), tested, mutated (D6).
Laya answered 0.94 to 0.99 on every yes/no question, contraries included: no
signal from it on yes/no, as on 2.16; its weakest point was "only the engine has
a handler".

## Limits and readings

1. **Logoff and shutdown were not run.** They would end the user's session.
   Windows also documents that a process which has loaded `user32.dll` or
   `gdi32.dll` is not sent them, and the engine loads a GPU stack, so it probably
   gets neither. They are handled the same way if they arrive. If they do not, the
   engine is ended without a stop record and the next start names it (2.16).
2. **A stop from the console that arrives during a fatal exit** (the engine is
   already ending with code 1 and finishing its log) waits for that log and then
   exits 0 from the handler thread; which exit code wins is a race. The log is
   whole either way.
3. **The closure has about five seconds** after a window close before Windows
   ends the process anyway. Finishing the log took well under that in every run;
   an engine whose log disk is stalled would still be cut off, and named by the
   next start.
4. **Only the engine has a handler.** The engine host and the MCP servers still
   run no code on Ctrl+C or a window close (unchanged from 2.16); the crate is
   there for them to use.
5. **A process with no console gets no event**, and a process can inherit "ignore
   Ctrl+C" from the one that started it (unchanged from 2.16).
6. **Off Windows is compiled nowhere on this machine and not run** (user decision,
   17 Nov 2026: Windows-supported work first). There the crate hands the closure
   to `ctrlc` with the one event `Interrupt`.
7. **There is still no stop request on the control plane.** That is row 2.19.
8. **2.16's live check** asserted the old generic reason; its pattern now accepts
   the new reasons too, and its `--close` note is out of date (this row's check is
   the one that covers a window close).
