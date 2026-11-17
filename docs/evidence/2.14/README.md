# 2.14 — the diagnostic bundle, module by module (17 Nov 2026)

ADR-0004 §8 promised one command to collect what an engineer needs for a bug report. Until this row an
engineer had to find the log root, pick files by hand, and guess which executable build had run. The user
then asked that the diagnostics be **module by module**, so a report about one product holds that product's
logs and a summary of it.

## Done-when

> A bundle from a conformance run holds every process log, the as-run log, versions and build hashes, the
> capability surface and the sanitised configuration, and no credential.

## What was built

- **`gx-diag`** (new crate `Shared/diag`: a library and a command). `gx-diag [--module NAME]... [--hours N]
  [--out FILE] [--log-root DIR] [--journal FILE] [--bin-dir DIR]...`. Exit 0 written, 1 could not be, 2 usage,
  3 written and a credential was found and replaced.
- **A module** is one product's folder under the log root (`engine`, `editor`, `playout`, `mcp`, ...). In the
  archive, everything it wrote is under `modules/<module>/`:
  - `logs/*.jsonl`: its log files, whole (a file written to within the window is copied from its first line, so
    its `seq` has no gap and a `log.lost` record stays beside what it explains).
  - `summary.json`: which runs it had and how each ended (`ended in order`, or `no log.stop`), records by level,
    refusals, lost-line notices, killed predecessors named, late and missed frames, lines that did not parse,
    its 20 newest errors and warnings (newest first, with correlation ids), its executables with their hashes,
    and the credentials replaced in its files.
  - the engine's module also holds `devices.json` (the device and adapter its `engine.start` records reported)
    and `recovery.json` (what its recovery journal holds: takes, revisions, hashes, program and cue state,
    each scene's size, **never the scene bodies**) and the drop report if there is one.
- **What belongs to no one module is at the top:** `manifest.json` (every member with its size and SHA-256, each
  log's first and last timestamp and sequence, the modules with their errors, warnings and refusals, what was
  left out), `versions.json` (every run with its module, process, pid, start and version; every `gx-*`
  executable beside the collector with its **SHA-256, which is the build hash**, and its module),
  `capability.json` (the capability surface at this protocol), `environment.json` (the `GX_*` variables with
  secret-named ones as `<redacted>`, the platform roots, the OS and architecture; the user's folder shown as
  `<home>`), and `as-run/*.jsonl` when there is an as-run log.
- **Choosing modules.** `gx-diag --module playout` holds that module only; a module asked for by name is in the
  bundle even when it wrote nothing in the window (its summary says so). The Help menu in both shells has two
  items: *Export diagnostic bundle (all modules)* and *(editor only)* / *(playout only)*.
- **The menu** (`Shared/shell-log/src/diagnostics.rs`, used by both shells): the export runs on its own thread
  (hashing the executables takes seconds), under a `diag-…` correlation id, writes into the log root's
  `bundles` folder, writes `diag.bundle` (path, modules, files, bytes, credentials replaced) on the shell's own
  record, and opens the file manager on the file (Windows). A failed export writes `diag.bundle_failed` and
  opens the log folder instead: the shells have no dialog of their own.
- **No credential.** Every byte copied is scanned for `gx1.` followed by token characters and for the values of
  the collector's own secret-named environment variables. Each is replaced in the copy (`gx1.REDACTED`),
  counted per file, named in the manifest and on stderr, and the command exits 3 with the file names: a
  credential in a log is a bug, and a bundle that quietly cleaned it would hide the bug. The warning does not
  repeat the credential.
- **Read back.** The archive is written beside its name, opened again, every member hashed and compared with
  what was meant to go in, and only then renamed into place; one that does not match is removed.
- **No download.** `zip` with its `deflate-zlib` feature (opens in Explorer; `zopfli`, which its `deflate`
  feature needs, is not in the lockfile). `flate2` was already locked; the lockfile gains `gx-diag` and one
  dependency edge.

## What was run

- `gx-diag` unit tests (15): the scrubber (shapes, malformed, bytes that are not UTF-8, secrets, short secrets);
  a full collection against a scratch machine (window, exclusions, manifest hashes against the members, first
  and last timestamps, versions and the executable's hash, capability at this protocol, the engine's device,
  the sanitised configuration with the user's name absent, the journal without its scene); a planted credential
  replaced, counted, named, the lines still JSON; the as-run log present and absent; the size cap; an empty
  machine; a journal that is not JSON; run names; the home folder; module layout and summaries; chosen modules;
  executables by name; and that an archive that does not read back as written is refused.
- `gx-diag` command tests (4), the real binary: a bundle and what it says; a credential gives exit 3, names the
  file, is not in the bundle and not in the warning; bad arguments give exit 2 and write nothing (including
  `--module ../escape`); one module when asked.
- The menu (1, in `gx-shell-log`): under a mock window the Help menu has both items under their exact text;
  another item does nothing; the module item writes the shell's module only, the all item writes both.
- **Conformance** (`npm run conformance`, 619 passed, 0 failed, 9 skipped; six new checks): the real `gx-diag`
  is run over the run's own logs; the bundle holds every log file the run wrote, module by module, as the file
  begins (processes still running have appended since); each module's summary names its runs; versions with a
  SHA-256 and module for each executable, the capability surface at this protocol, the engine's device and
  adapter, the sanitised configuration; the as-run log, or its absence named; no credential the run used.
- **The real Editor and Playout windows** (`live-check.mjs`, result in `live-check-result.json`): **18 of 18**.
  A real engine and each shell are started in a scratch folder. The menu item is chosen the way Windows does when
  a person clicks it: the window's native menu is read (`GetMenu`, `GetSubMenu`, `GetMenuString`) and the item's
  id posted as `WM_COMMAND` (`menu-click.ps1`). Each shell: both items are in the Help menu under their exact
  text; its own-module bundle holds its log and summary and nothing of the engine's; the summary names its run;
  the bundle's SHA-256 of the shell's executable equals the file's own (computed independently in the check);
  the all-modules bundle holds the shell's module, the engine's and the engine's device; no credential, none
  replaced; both exports are on the shell's own record under `diag-…` ids naming their modules; it closes
  gracefully and finishes its log. The check refuses to run if an Editor, Playout or engine is already open on
  the machine, because it closes windows by process name.
- Gate (`cargo fmt --check`, `cargo clippy -D warnings`, `npm run check`): see the plan row.

## Mutations

22, one at a time, each restored byte-identical, each made a named check fail (`mutations.txt`).

| # | Mutation | Fails |
|---|---|---|
| G1 | a credential is not recognised | `a_credential_is_found_and_replaced_wherever_it_is` |
| G2 | known secrets are not replaced | the same test |
| G3 | the time window is ignored | `a_bundle_holds_the_logs_in_the_window…` and others |
| G4 | the bundles folder is collected as a module | `a_bundle_holds_the_logs_in_the_window…`, `each_module_has_its_own_folder…` (after the fix below) |
| G5 | the chosen modules are ignored | `a_bundle_of_chosen_modules_holds_those_modules…` |
| G6 | a module asked for by name that wrote nothing is left out | the same test |
| G7 | the size cap keeps the oldest logs | `the_size_cap_keeps_the_newest_logs…` |
| G8 | a late frame is counted as a missed one | `each_module_has_its_own_folder…` |
| G9 | refusals are not counted | the same test |
| G10 | every run is said to have ended in order | the same test |
| G11 | the manifest names the wrong hash | `a_bundle_holds_the_logs_in_the_window…` |
| G12 | the read-back accepts a member that reads back different | `an_archive_that_does_not_read_back_as_written_is_refused` |
| G13 | an executable is hashed wrongly | `a_bundle_holds_the_logs_in_the_window…` |
| G14 | a credential found still exits 0 | `a_credential_in_a_log_gives_exit_three…` |
| G15 | a module name that escapes the folder is accepted | `bad_arguments_exit_two_and_write_nothing` |
| G16 | the all-modules item exports only this shell's module | the menu test |
| G17 | the module item exports every module | the menu test |
| G18 | the Editor is not given the menu | live: "Editor: the window's Help menu holds both export items" |
| G19 | Playout is not given the menu | live: "Playout: the window's Help menu holds both export items" |
| G20 | an export is not put on the shell's own record | live: both shells' "both exports are on its own record" |
| G21 | the engine's logs are left out of every bundle | conformance: the log, summary and machine checks |
| G22 | the as-run folder is also collected as a module | `the_as_run_log_is_included_when_there_is_one` |

**G4 survived the first run.** Removing the exclusion of the `bundles` folder changed nothing: my fixture's
`bundles` folder held only a `.zip`, which the collector ignores anyway, so the test could not tell. A stray
`.jsonl` is now in that folder and one in `as-run/`, with assertions that neither is collected as a module; G4
then failed two tests, and G22 (the same blind spot for `as-run`, written because of it) failed one.

**G12 is the one mutation I could write but not the one that matters.** It makes the read-back accept a member
that reads back different, and the read-back's own test catches it. Removing the *call* to the read-back is not
caught by any test, because nothing can make a freshly written archive read back wrong. That is named in the
limits.

## Jev and Laya

Design consult (`jev-laya-design.json`): credential handling Jev redact-and-report (0.56) against Laya refuse;
the as-run absence Jev include-if-present-and-name (0.97) against Laya build 12.11 first; whole files in the
window both (1.00); the menu Jev write-to-the-log-root-and-reveal (1.00) against Laya the Desktop; deflate zip
both (1.00); the journal Jev summary-only (0.35, low) against Laya the whole file. Decided by hand for Jev's on
each: the bundle must still be written when a credential is found, and the leak surfaced; the user queued 2.14
before 12.11; a report must not hold a customer's scene bodies by default.

Slice review (`jev-laya.json`): real windows 0.96, module by module 0.98, mutations can fail 0.96, the build-hash
reading acceptable 0.87, the done-when met on the named reading of the as-run log 0.83. Not above 0.5 and reported as
they are: a credential can reach the bundle 0.43 (no: every collected byte is scanned and the warning never repeats it),
silent substitution 0.40, a scene body can reach it 0.30 (no: the journal is summarised from its parsed fields), and
"a defect to fix" 0.49. Jev's weakest point is the one named in limit 4: the call to the read-back is not tested
(0.95). I considered a seam to make it testable and did not add one: the check it guards cannot fail on a freshly
written archive, and a hook added to be mutated is more code to be wrong. Laya answered 0.91 to 0.98 on every yes/no
question, as on every row today: no signal from it on yes/no.

## Limits and readings

1. **No as-run log exists yet** (row 12.11). The bundle includes `as-run/*.jsonl` when there is one and the
   manifest names its absence when there is none; the done-when says the bundle holds it, which is true of every
   bundle made once 12.11 writes one. This is a reading, not a silent substitution, and 12.11's done-when should
   gain the line "and the bundle holds it".
2. **Launch arguments of running processes are not collected** (the engine's `engine.start` says how it
   started; the `--token` argument is exactly what must not be). The user name and host name are not collected.
3. **A build hash is the SHA-256 of the executable beside the collector**, which is not proof that a running
   process was started from that file. The log records carry the workspace version only.
4. **The read-back's call is untested** (see G12).
5. **The hash step takes seconds** with debug executables (several hundred megabytes in `target/debug`); the menu
   exports on a thread and nothing shows until the file manager opens.
6. **The file manager opens on Windows only** (`GX_DIAG_NO_REVEAL` stops it); elsewhere the export is written and
   logged only. A failed export opens the log folder.
7. **Two exports in the same second share a file name**, the later replacing the earlier. Bundles are never
   deleted.
8. **The size cap** is 256 MB of logs, newest first; the rest are named in the manifest as left out.
9. **A stale binary hid the menu.** The first real-window run found no menu (`GetMenu` returned 0) because I had
   not rebuilt `gx-editor.exe` since wiring the menu in. The check's header now says to rebuild the shells first.
   UI Automation cannot see a native menu bar, so the check chooses the item with `WM_COMMAND`, which is what
   Windows sends for a click; it does not move a mouse.
10. **Other platforms** are not built or run (Windows first, the user's decision of 17 Nov 2026).
