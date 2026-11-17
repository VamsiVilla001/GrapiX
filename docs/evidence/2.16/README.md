# 2.16 — Process end on record: `engine.stop` on Ctrl+C, and a start that finds its predecessor's log unfinished says so

Build-plan row `2.16` (ADR-0004), 16 Nov 2026. Done when: an engine ended by
Ctrl+C or a stop request writes `engine.stop` with its reason and finishes its
log; a process killed without a stop record is named by the next start of the
same process as `log.previous_unfinished` (the file, its last sequence number and
its last timestamp), so a killed engine, shell or MCP server is never
indistinguishable from one still running.

## What was built

- **`engine.stop` on a console interrupt** (`services/render-engine/worker/src/main.rs`).
  The worker installs a handler with the `ctrlc` crate (the user approved it for
  this row on 16 Nov 2026; `#![forbid(unsafe_code)]` rules out a hand-written
  console handler). The handler writes `engine.stop` (info, with its reason),
  finishes the log (so `log.stop` is the last line, nothing queued is lost) and
  ends the process with exit code 0. The log guard is now a shared slot
  (`Arc<Mutex<Option<LogGuard>>>`), and whoever ends the process holds the lock
  while the log finishes, so an interrupt during a normal exit waits for it.
- **`log.previous_unfinished`** (`Shared/telemetry/src/sink.rs`, so every process
  that logs through the sink has it: the engine, the host, both shells, the MCP
  servers). When a sink starts, once it has opened (and so holds) its own file,
  it looks at the other runs of the same process name in the same product folder,
  passing over its own file by name; two runs starting at the same moment so
  each see the other's held file and list it as running (file names are
  `<process>-<UTC start>-<pid>-<part>.jsonl`). Each run that is gone without
  `log.stop` and that no earlier start can have named gets one warn record in the
  new file: `file`, `started`, `predecessor_pid`, `last_seq`, `last_ts` and
  `last_event` (the last whole record: a line cut off by the kill is skipped). A
  kill is named once, by the first start after it, **whether or not runs of the
  process overlap** (two MCP servers for two agent clients, two engines).
- **How a start knows what is still unnamed, without reading every file.** Each
  `log.start` now lists, as `running`, the runs of its process that were still
  running when it started (`<process>-<start>-<pid>`). Walking back from the newest
  run, a start stops at the newest that has such a list: every run already gone
  when that run started was named by it then, so only that run, the runs it
  listed, and any newer run passed on the way (one killed before it wrote its first
  line) can still be unnamed. It probes just those, names each that is gone
  without `log.stop`, and lists those still running in its own `log.start`. Runs
  that started in the same second are taken together, since their order is not
  known. The cost is one directory listing, one first-line read, and a probe and a
  64 KB tail read per candidate (usually none to three). Files written before 2.16
  have no list: the walk then stops at the first such run that is gone, as the
  first rule did, so the first start after the upgrade names one run, not every
  old one, and lists every older run still running so that it is named when it
  ends.
- **Running is told from killed by the file, not by the process id.** A log writer
  now opens its file allowing others to read it and nothing else (Windows
  `FILE_SHARE_READ`; an advisory shared lock elsewhere). Another process that asks
  to write to it is refused exactly while the writer has it open, and the system
  closes a killed process's files, so the probe cannot be fooled by a reused
  process id and needs no `unsafe` and no crate. A second engine started beside
  a running one is not told it has a dead predecessor. A side effect: while a
  writer has its file open, nothing else can delete or rename it, so the retention
  sweep of another process can no longer remove a live run's file from under it
  (before, Windows would have let it, and the writer's later lines would have gone
  with the file).

## Executed

**Live** (`live-check.mjs`; result in `live-check-result.json`): real engines,
each started in its own console window with `GX_LOG_DIR` in a scratch folder.
Ctrl+C is raised in the engine's console by a helper that attaches to it, as a
keystroke would. All 22 checks pass with Ctrl+C and again with Ctrl+Break (17 Nov
2026, on the final code: the redesigned walk, after the mutation run, on rebuilt
unmutated binaries; the default run is the one recorded):

- engine A, interrupted: it ends on its own with exit code 0 and its last two
  records are `engine.stop` (info; reason "a console control event …") and
  `log.stop`;
- engine B, started after A: no `log.previous_unfinished` (A finished); then it is
  killed outright and its file has neither `engine.stop` nor `log.stop`;
- engine C, started after B: `log.previous_unfinished` at warn naming B's file,
  B's pid, and B's last sequence number and last timestamp exactly as they are
  in B's file; it does not name A;
- the same three runs for **the Editor's MCP server, the Playout shell and the
  Editor shell** (4 checks each, real binaries, scratch store, package and
  WebView2 folders): the first run ends in order (the MCP server's input is
  closed; a shell's window is asked to close, as its close button does) and its
  file ends with `mcp.stop` / `playout.stop` / `editor.stop` and `log.stop`; the
  next start does not name it; the second run is killed and writes no stop
  record; the third start names it at warn with its pid, last sequence number and
  last timestamp exactly as in its file. So an ordinary restart of a shell or an
  MCP server raises no false alarm, and a killed one is named.

**Tests added.** `gx-telemetry` sink (13): a start names an earlier run that left
no stop record (every field) and lists nothing running; one that finished is not
named; one still holding its file is not called unfinished, is listed as running,
and is named once it no longer holds it; with overlapping runs a kill is named by
the first start after it although the newest run finished; a kill named once is
not named again while its siblings run, and the start lists them; a run killed
before its first line is named and the walk goes on past it; a rotated run's list
is read from its first part; runs that started in the same second are taken
together; with runs that have no list (before 2.16) only the newest run that is
gone decides and a newer finished run hides an older unfinished one; a run with no
list stops the walk and a run behind it that still holds its file is listed and
named when it ends (renamed after the mutation run from
`before_2_16_a_run_still_running_is_listed_for_later`, body unchanged: a pre-2.16
writer never holds its file, so the old name promised more than the code does);
the last part of a rotated run says how it ended; a
line cut off by a kill is skipped and an empty file is named too; another process
name, including one that starts with this one's, is not mistaken for it. The
worker binary (1): an interrupt leaves `log.start`, `engine.stop` (info, its
reason), `log.stop`, and takes the guard. The worker over real processes (1,
`log_file`): a second engine started beside a running one is not named and lists
the first as running; after both are killed a third names **both**, once each, at
warn, with file, a last sequence number of at least 2 and a last timestamp, and no
`engine.stop` is invented for either. The engines it starts are held by a guard
that kills them when it is dropped, so a failed assertion never leaves one running
(see the mutation run below for why).

**Gate** (17 Nov 2026, on the final tree): `node tools/check-agent-worktree.mjs`
OK; `cargo fmt --all -- --check` and `cargo clippy --workspace --all-targets -- -D
warnings` clean; `npm run check` exit 0 (60 Node, 424 Editor, 959 Rust passed / 0
failed / 38 ignored, conformance 610 passed / 0 failed / 9 skipped).

**Mutations** on the final code (one at a time, each restored byte-identical and
confirmed so; runner kept outside the repo). **26 of 26 make a named check fail**
(up to three of the failing checks are listed; sink tests are `sink::tests::…`):

| # | Mutation | Fails |
|---|---|---|
| A1 | a start never looks at earlier runs | `a_line_cut_off_by_a_kill_is_skipped_and_an_empty_file_is_named_too`, `an_earlier_run_still_holding_its_file_is_not_called_unfinished`, `before_2_16_only_the_newest_run_that_is_gone_decides` |
| A2 | the probe never sees a writer (a running sibling is called killed) | `an_earlier_run_still_holding_its_file_is_not_called_unfinished`, `a_kill_named_once_is_not_named_again_while_its_siblings_run`, `a_run_with_no_list_stops_the_walk_and_held_runs_behind_it_are_listed` |
| A3 | every earlier run is taken for a running one | `a_line_cut_off_by_a_kill_is_skipped_and_an_empty_file_is_named_too`, `before_2_16_only_the_newest_run_that_is_gone_decides`, `a_run_with_no_list_stops_the_walk_and_held_runs_behind_it_are_listed` |
| A4 | a `log.stop` is not recognised as an ending | `an_earlier_run_that_finished_is_not_named`, `the_last_part_of_a_rotated_run_is_the_one_that_decides`, `a_run_with_no_list_stops_the_walk_and_held_runs_behind_it_are_listed` |
| A5 | the walk starts from the oldest run | `a_kill_named_once_is_not_named_again_while_its_siblings_run`, `a_run_killed_before_its_first_line_is_named_and_passed_over`, `a_run_with_no_list_stops_the_walk_and_held_runs_behind_it_are_listed` |
| A6 | the first part found, not the last, says how a run ended | `a_rotated_runs_list_is_read_from_its_first_part`, `the_last_part_of_a_rotated_run_is_the_one_that_decides` |
| A6b | the last part, not the first, is read for the list | `a_rotated_runs_list_is_read_from_its_first_part` |
| A7 | a writer shares its file for writing | `a_run_with_no_list_stops_the_walk_and_held_runs_behind_it_are_listed`, `an_earlier_run_still_holding_its_file_is_not_called_unfinished`, `a_rotated_runs_list_is_read_from_its_first_part` |
| A7b | the same, seen by the real engine binary | `log_file::a_killed_engine_is_named_by_the_next_start_and_a_running_one_is_not` |
| A8 | the first line of the tail is taken for the last record | `a_start_names_an_earlier_run_that_left_no_stop_record`, `a_run_with_no_list_stops_the_walk_and_held_runs_behind_it_are_listed`, `a_run_killed_before_its_first_line_is_named_and_passed_over` |
| A9 | another process whose name starts with this one is taken for it | `another_process_name_is_not_mistaken_for_this_one` |
| A10 | the finding is written at info, not warn | `a_start_names_an_earlier_run_that_left_no_stop_record` |
| A11 | the runs a start found running are not followed | `a_kill_named_once_is_not_named_again_while_its_siblings_run`, `a_rotated_runs_list_is_read_from_its_first_part`, `a_run_killed_before_its_first_line_is_named_and_passed_over` |
| A12 | the walk does not stop at a run with a list | `a_kill_named_once_is_not_named_again_while_its_siblings_run` |
| A13 | runs that started in the same second are not taken together | `runs_that_started_in_the_same_second_are_taken_together` |
| A14 | a run from before 2.16 does not stop the walk | `a_run_with_no_list_stops_the_walk_and_held_runs_behind_it_are_listed`, `before_2_16_only_the_newest_run_that_is_gone_decides` |
| A15 | older runs still running are not listed after an unlisted stop | `a_run_with_no_list_stops_the_walk_and_held_runs_behind_it_are_listed` |
| A16 | a run with no first line stops the walk | `a_run_killed_before_its_first_line_is_named_and_passed_over` |
| A17 | a start does not list the runs still running | `a_kill_named_once_is_not_named_again_while_its_siblings_run`, `a_rotated_runs_list_is_read_from_its_first_part`, `a_run_with_no_list_stops_the_walk_and_held_runs_behind_it_are_listed` |
| A17b | the same, seen by the real engine binary | `log_file::a_killed_engine_is_named_by_the_next_start_and_a_running_one_is_not` |
| A18 | a start does not pass over its own file | `an_earlier_run_still_holding_its_file_is_not_called_unfinished`, `a_run_with_no_list_stops_the_walk_and_held_runs_behind_it_are_listed`, `a_start_names_an_earlier_run_that_left_no_stop_record` |
| A19 | a start looks at earlier runs before its own file exists | `a_flood_never_makes_the_caller_wait_and_every_loss_is_stated`, `a_line_carries_the_schema_and_never_a_credential`, `an_earlier_run_still_holding_its_file_is_not_called_unfinished` |
| B1 | an interrupt writes no `engine.stop` | `tests::an_interrupt_writes_engine_stop_and_finishes_the_log` |
| B2 | an interrupt does not finish the log | `tests::an_interrupt_writes_engine_stop_and_finishes_the_log` |
| B3 | the handler does not record the interrupt | live: `engine A wrote engine.stop at info with its reason`, live: `engine A's last two records are engine.stop and log.stop`, live: `engine B did not name A, which finished` |
| B4 | the handler ends the process with code 1 | live: `engine A ended on its own after the interrupt, with exit code 0` |

While writing these, A6b's case (a rotated run's list must be read from its first
part) was found to have no test, and `a_rotated_runs_list_is_read_from_its_first_part`
was added for it. A check in the first-line reader (a line with no newline is
not a first line) was found to be one no test can reach: a line cut off by a kill
is never whole JSON, so it fails to parse anyway. It was removed rather than kept
untested. A18 and A19 cover the start-order fix below: a start must pass over its
own file, and must look only once that file exists. The race A19 guards against
cannot be staged in a test, so the sink's tests assert the order itself (a
test-only check that the start's own first part exists when it looks).

**The harness incident.** The first mutation run (on the first rule, 15
mutations) hung on A7b for about ten hours (16–17 Nov). The mutation was caught
(the test failed), but the test killed its engines only after its assertions, so
the two it had started kept running; they held the runner's captured output open,
so the runner never returned, and `sink.rs` stayed mutated until it was found,
stopped and restored from its backup (byte-identical). Fixed twice: the test's
guard above, and a runner that writes output to a file, kills the process tree on
a timeout and stops any engine left in a test scratch folder. That run's other 14
mutations all failed named checks; it was superseded by the run above on the
redesigned code. B3 and B4 overwrite `live-check-result.json` with failing runs,
so after each mutation run the binaries were rebuilt unmutated and the live check
rerun (`--break`, then the default) before anything was recorded.

## Review, and the redesign it led to (17 Nov 2026)

**First slice review** (`jev-laya-slice-before-redesign.json`, Jev 1.14.0 and
laya-multilingual at max_len 8192, 6,733 tokens, nothing truncated), on the first
rule (only the newest run that is gone decides). Jev: Ctrl+C orderly 0.97, every
process named after a kill 0.96, no false alarm 0.92, the stop-request reading
acceptable 0.89, mutations can fail 0.95; the probe can be fooled 0.23, the close
limit breaks the done-when 0.29, silent substitution 0.25; weakest point: the
non-Windows path not run (0.77); **must fix 0.44**. Laya answered 0.97 to 0.99 on
every yes/no question, the contrary ones included (the probe can be fooled 0.99, a
defect to fix 0.97), so its yes/no answers carry no signal here; its weakest point
split thinly (only the engine has a handler 0.25, the non-Windows path 0.22).

Jev's undecided `must_fix` led to a second look at the first rule, which found two
gaps when runs of one process overlap (realistic for MCP servers: Claude and Codex
each start their own `editor-mcp`). **A missed kill:** X starts, Y starts beside
it, X is killed, Y ends in order; the next start looked only at Y and stopped, so
X's kill was never named. **A repeat:** while a newer sibling still ran, every new
start skipped it and named the same old kill again. Runs one after another had
neither gap, which is all the first evidence exercised.

**Design consults** (`jev-laya-design.json`, then `jev-laya-design2.json` with a
fourth option added). Options: (a) keep the rule and name the gaps, (b) order runs
by their last record (fails for a quiet run killed long after its last line), (c)
name every unnamed kill by reading every file of the process in the retention
window, (d) the `running` list in `log.start` described above. First round: Jev
(a) 0.75, (c) 0.24, (c)'s cost acceptable 0.20, the gap breaks the done-when 0.53;
Laya (c) 0.42, (b) 0.31, (a) 0.27. Second round, with (d): **Jev (d) 0.96**, (d)
sound 0.77, (c)'s cost acceptable 0.15; **Laya (c) 0.43**, (d) 0.19, (d) sound
0.97 (on its saturated scale). **Decided by hand: (d).** Laya's preference is for
naming every kill, which (d) does; Jev's objection to (c) is its cost, which (d)
does not have. The split is reported, not resolved by either.

**Second slice review, on (d)** (`jev-laya-slice-after-redesign.json`, 7,509
tokens, nothing truncated; the mutation table was given as names and result to
fit Laya's 8,192). Jev: Ctrl+C orderly 0.98, every process named 0.96, **every
overlapping kill named once 0.72**, no false alarm 0.93, the probe can be fooled
0.21, the close limit breaks the done-when 0.32, silent substitution 0.28,
mutations 0.95, weakest point the non-Windows path (0.87), **must fix 0.64**.
Laya again 0.98 to 0.99 on every yes/no question. Jev's raised `must_fix` led to
another look, which found a start-up race in (d) as first built: a start looked
at earlier runs before creating its own file, so two runs starting at the same
moment could each look before the other's file existed, neither would list the
other, and if they fell either side of a second boundary a later kill of the
earlier one was missed. **Fixed:** a start now opens its own file first and passes
over it by name (mutations A18, A19).

**Final slice review** (`jev-laya.json`, on the final code and this record, 7,331
tokens, nothing truncated; this section was given to it as a two-sentence summary,
since its own earlier scores are not evidence). Jev: Ctrl+C orderly 0.97, every
process named 0.96, **every overlapping kill named once 0.68**, no false alarm
0.89, the probe can be fooled 0.21, the stop-request reading acceptable 0.86, the
close limit breaks the done-when 0.31, silent substitution 0.30, mutations 0.94,
weakest point the non-Windows path (0.78), **must fix 0.50**. Laya 0.95 to 0.99
throughout. (A run of the same review before limit 7 was written gave overlap
0.57 and must fix 0.54.)

**Code review by area** (`jev-laya-code.json`): the full code of `start`, the probe,
the walk and the interrupt handler, without the evidence (which the slice review's
excerpts had cut to fit Laya). Jev, probability of a defect: the walk misses a kill
0.77, repeats one 0.68, raises a false alarm 0.61; it reads many files 0.65; the
start order 0.49; the probe 0.39; the interrupt code 0.38. Laya 0.91 to 0.95 on
all. Jev gives no reasons, so every path through the walk was worked by hand
against these. That found three cases the record did not name, all with mixed
builds or runs longer than the retention period, now limit 7; no plain defect was
found (the walk's correctness argument is in its doc comment, and each step of it
is held by a mutation above). The cost: one directory listing and, normally, one
first-line read and a probe and tail read per candidate; every older run is probed
only when the newest run that is gone has no list (once, at the upgrade). **Not
resolved:** Jev ends at 0.50 on `must_fix` and 0.68 on the overlap claim; that
doubt is reported as it stands, for the user, and is not argued away here. The
row's done-when (Ctrl+C on record; a killed engine, shell or MCP server named by
the next start with file, last sequence number and last timestamp; never taken for
a running one) is met by the live run above; the overlap handling goes beyond it.

## Limits and readings

1. **Console window close, logoff and shutdown are not orderly.** The same handler
   is called for them, and on a window close it writes `engine.stop`, but Windows
   ends the process as soon as the `ctrlc` crate's system-level handler returns,
   which is before the engine has finished its log. Run live (`--close`): the file
   ended at `engine.stop` with no `log.stop`, the exit status was
   `STATUS_CONTROL_C_EXIT`, and the next engine named it (`last_event:
   engine.stop`). Holding the system handler open would need `unsafe` code. So the
   reason text names the events the handler is called for, not a promise about
   them, and only Ctrl+C and Ctrl+Break are claimed as orderly.
2. **Only the engine has a handler.** The shells already write `editor.stop` and
   `playout.stop` when their window closes, and the MCP servers and the host write
   theirs when they end by their own code (2.12). A Ctrl+C on the engine host or
   on an MCP server process ends it with no stop record, and the next start of
   that process names it.
3. **Ctrl+C can be inherited as ignored.** A process started by one that has
   Ctrl+C ignored ignores it too, and the harness this was run from had it set:
   the first live run found the engine still running 20 seconds after the
   keystroke. The live script now clears the flag in the shell that launches the
   engine, as an ordinary terminal has it. An engine launched by something that
   ignores Ctrl+C gets no Ctrl+C, so it simply has no console interrupt to record.
4. **Races and clocks.** Two starts at the same moment may both name the same
   kill (a repeat; they see each other's files, so neither misses the other). The
   order runs are walked in is their start time as written in the file name, so a
   wall clock stepped backwards (by hand, or at boot before time sync) can put a
   new run behind older ones, and a kill in that window can be missed. A run
   killed in the microseconds between writing its `log.start` and writing its
   `log.previous_unfinished` records loses those namings (the next start names
   the run itself, not the ones it would have named). A new process that starts
   in the microseconds between one rotated part closing and the next opening could
   see the run as unfinished. Off Windows, two probes of the same file at the same
   moment can each see the other's probe as a writer, which gives a repeat, never
   a miss. A run whose list names a run that the retention sweep has since removed
   has nothing left to name. A run from before 2.16 that was already gone when the
   upgrade's first start ran, and was not the newest, is not named (by design: no
   backlog).
5. **The non-Windows probe has been compiled but not run.** Only the Windows
   target is installed here (a Linux target would be a download). The two
   non-Windows bodies (`lock_shared` in the writer, `try_lock` →
   `TryLockError::WouldBlock` in the probe) were compiled verbatim, without their
   `cfg`, in a scratch program with `-D warnings` and build cleanly; both calls are
   stable since Rust 1.89, the workspace minimum. They cannot be exercised here:
   on Windows a byte-range lock needs a handle opened for reading or writing, and
   the writer's handle is append-only, so `lock_shared` fails and the probe sees no
   holder. Windows does not use that path (it uses the share mode above). On Linux
   and macOS std locks with `flock`, which does not depend on how the file was
   opened. Row 0.3's CI is where the path is first run. A filesystem without
   advisory locks gives the probe no holder to see, so there a running sibling
   could be named as unfinished.
6. **"Or a stop request".** The done-when names an engine "ended by Ctrl+C or a
   stop request". The plan row offers a stop request on the control plane as the
   other way to catch an interrupt, if the crate were not approved; it was, and
   the control protocol has no stop request (the host never stops a worker, by
   design: 2.12). So there is no stop request to test. The one other way the
   engine ends by its own code, its control listener stopping, writes
   `engine.stop` with its reason and finishes the log (2.12, unchanged). A stop
   request, if one is added, would end through the same `finish_log`.
7. **Mixed builds and very long runs.** (a) **The upgrade gives one false alarm
   per process still running.** A process built before 2.16 does not hold its
   file, so while one is still running, the first 2.16 start of the same process
   sees it as gone and names it once; its later end is then not named. The first
   rule had the same false alarm. (b) A downgrade: a pre-2.16 run that starts after
   2.16 runs and is gone stops the walk (it has no list), so a kill among the runs
   behind it that was not yet named can be missed; runs behind it still holding
   their files are listed, so their later ends are named. (c) A run longer than the
   retention period (14 days) that has rotated loses its first part, and with it
   its list: the walk then goes past it to an older list, and kills that run had
   already named can be named again (a repeat, not a miss).
8. The as-run record (12.11) is a separate file with its own integrity rules and
   is not touched by this row.

## New dependency (the user approved it for this row)

`ctrlc 3.5.2`, exact version, in the worker only. `Cargo.lock` gains `ctrlc` and
one transitive crate, `nix 0.31.3`, which `ctrlc` uses only on Unix and which is
not built on Windows; `windows-sys`, `dispatch2`, `bitflags`, `cfg-if`, `libc`
were already in the tree. Nothing was removed or upgraded.
