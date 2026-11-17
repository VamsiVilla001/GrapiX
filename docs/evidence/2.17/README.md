# 2.17 — one id from an Editor edit to the engine (17 Nov 2026)

Row 2.13 left a named gap: an Editor edit is followed from the front end to the
shell and stops there (the scene is local until published), and the publish that
carries it to the engine has an id of its own. Two unrelated ids, so nobody could
get from an edit to the engine, or from an engine publish back to its edits. Jev
scored the strict reading of 2.13's done-when at 0.07. The user asked for the gap
to be closed (17 Nov 2026).

## Done-when

> An Editor edit, and the publish of the scene that holds it, can be followed by
> one correlation id from the front end through the shell and the asset plane to
> the engine: the front end names a gesture (an edit, then its publish) with one
> id, or the publish names the ids of the edits it carries.

The second form was built: **the publish names the ids of the edits it carries.**

## What was built

- **A carry scope** (`gx_telemetry::corr::carry`). Beside the correlation scope
  (2.13), a thread can enter the list of edit ids a publish holds. Only ids that
  pass the shape check are kept, once each, the newest 64 (`MAX_CARRIED`); every
  one left out is counted.
- **The Editor shell keeps a ledger**: per scene target, the ids of the shell calls
  whose edit applied since that target was last published. Newest 64 per target
  with a count of older ones, at most 256 targets. A refused edit, a command that
  is not an edit, and an edit with no id in scope are not entered. `cmd_execute`
  and `cmd_publish` go through `ShellState::execute_command` and `publish_target`.
- **The publish names them in three places**, all under the publish call's own id:
  the shell's `editor.publish` (`carries`, and `carries_dropped` when some were
  counted, on success and on failure), the asset-plane request header (a new
  optional member `"carries":[...]`), and the engine's `publish.accepted` and
  `publish.refused` (`carries`, the ids comma-separated; no field when there are
  none).
- **Forgotten only when published, by number.** Every edit the ledger notes gets
  a number in the order it applied. A publish takes a mark (the next number) when
  it reads the ledger, and after it succeeds the ledger forgets every edit
  numbered below the mark: exactly the ones the publish held. An edit made while
  the publish ran stays for the next one, and a failed publish forgets nothing.
  The first version forgot by position (the first N ids of the list), which was
  wrong when the list was full: see "Found on review".
- **Read together.** `document_and_edits` copies the document and reads the ledger
  under one hold of the workspace, and `execute_command` notes an edit while it
  still holds the workspace it applied the edit in (lock order: workspace, then
  ledger). So a publish names every edit its document holds and none it does not.
- **Untrusted on arrival.** The engine's publish listener removes `carries` from
  the header before the request's one-member rule, as it does `corr`; ids that
  fail the shape check, repeats, entries that are not strings and any beyond 64
  are counted and never written; a `carries` that is not a list names nothing.
  None of these makes the publish fail.

So one search for an edit's id finds the front end's report of the call, the
shell's `editor.command`, and (through `carries`) the shell's `editor.publish`
and the engine's `publish.accepted`. One search for the publish's id finds the
same publish records and, in `carries`, every edit.

No wire-version change (the asset-plane header is free-form JSON), no download.

## What was run

- Unit tests: telemetry (3: valid distinct ids only and the rest counted; the
  newest kept; scopes nest and stay on their thread), asset plane (2: the header
  member; the listener enters what a header names, from the client's own scope
  and from a hostile header), engine (1: `publish.accepted` names the edits and a
  publish with none has no field), shell (5: the ledger, including the full-list case of "Found on review"; which
  calls are noted; a failed publish names its edits on record and keeps them; and
  two that hold the ledger from the test and assert the workspace stays held while
  the reader or the writer waits on it).
- **A real engine process** (`Editor/shell/tests/edit_carry.rs`): a real shell
  state publishes over the asset plane three times; the engine's own log has
  `publish.accepted` under each publish's id naming exactly the edits since the
  one before (two, one, none), and a search for each edit's id finds the edit and
  the engine's publish.
- **A real Editor window and a real engine** (`live-check.mjs`, result in
  `live-check-result.json`): **20 of 20**, four runs in a row and again after the
  mutations. The page is clicked through the DevTools protocol: three or more
  shapes, Publish, one more, Publish, Publish. The ids are the front end's own
  (`ed-…`). Each publish is on the engine under the publish call's id and names
  the edits since the last; each edit's id finds its shell record and the
  engine's publish; an edit made after a publish is not on that publish; the
  third publish names none; no credential in any file.
- Gate (`cargo fmt --check`, `cargo clippy -D warnings`, `npm run check`) exit 0,
  run on the final code (after the last change to the shell): 424 Editor tests, 985 Rust tests passed, 0 failed, 38 ignored, 60 Node tests,
  conformance 613 passed, 0 failed, 9 skipped.

## Found on review

Jev's "a defect to fix" answer on the first review was 0.72, and its "can a publish
silently fail to name an edit" 0.54. I read the ledger for such a case and found
one. With 64 edits waiting, a publish reads them; one more edit arrives while the
publish is in flight and pushes the oldest id out of the list; the publish
succeeds and the ledger forgot "the first 64 entries", which now included the new
edit. That edit was applied, never carried, and forgotten. The fix is the numbered
ledger above (a mark, not a count of positions), and the same case is a unit test
(`the_ledger_keeps_the_newest_ids…`): a full list, a publish taken, one more edit
during it, a publish succeeding, and exactly the new edit left, with nothing
counted as unnamed. The F18 mutation puts the old rule back and the test fails.

The second review (Jev's "must fix" still 0.57) found a second gap in my own code:
`publish_target` copied the document, and only afterwards read the ledger. An edit
landing between the two would be named by a publish whose document did not hold it.
Both are now read under one hold of the workspace, and an edit is noted under the
hold that applied it.

**The first test I wrote for that did not test it.** It ran a writer making 400
edits while the reader took the pair over and over, and F21 (read the ledger after
releasing the workspace) survived it 3 times of 3, F22 (note the edit after
releasing it) 2 times of 3: the window is too narrow to hit by chance. It was
replaced by two deterministic tests: the test holds the ledger, starts the reader
(or the writer), and asserts the workspace stays held while the thread waits for
the ledger. Both mutations then failed on every run, 3 of 3 each. A race that cannot
be hit by chance is tested by holding the other lock, not by repetition.

## Mutations

25, one at a time, each restored byte-identical, each made a named check fail
(`mutations.txt`, in the order they ran: the first run; the rerun of the two live
ones; the run after the ledger was rewritten, which repeated F10 to F17c and added
F18 to F20; F21 and F22 three times each; and F13 to F17c, with F23, again on the
final code, after the shell took the document and ledger under one lock. F10 to F12
and F18 to F20 touch the ledger, which did not change after their run).

| # | Mutation | Fails |
|---|---|---|
| F1 | the carry scope keeps ids that fail the shape check | `a_carry_scope_names_only_valid_distinct_ids_and_counts_the_rest` |
| F2 | it names a repeated id twice | the same test |
| F3 | it keeps the oldest ids, not the newest | `a_carry_scope_keeps_the_newest_ids_when_there_are_too_many` |
| F4 | the client does not name the edits in its header | `the_server_enters_the_edits_a_publish_names_around_the_publish` |
| F4c | the same, real window and engine | live: both publishes' "the engine names the edits", and every edit's search |
| F5 | the header writes ids that fail the shape check | `a_request_header_names_the_edits_it_carries_as_a_list` |
| F6 | the listener ignores the edits a header names | `the_server_enters_the_edits…` |
| F7 | the listener does not count entries that are not ids | the same test |
| F8 | the `carries` key is left in the request | the same test |
| F9 | the engine writes no `carries` | `a_publish_names_the_edits_it_carries_and_one_that_names_none_has_no_field` |
| F10 | the ledger enters the same call twice | `the_ledger_keeps_the_newest_ids_per_target_and_forgets_only_what_was_published` |
| F11 | the ledger lets the newest ids go | the same test |
| F12 | a publish forgets the edits made while it ran | the same test |
| F13 | a failed publish forgets its edits | `a_failed_publish_names_its_edits_on_record_and_keeps_them_for_the_next_try` |
| F14 | a refused edit is noted as carried | `an_edit_is_noted_by_the_id_of_the_call_that_made_it_and_nothing_else_is` |
| F15 | the publish does not enter the edits it carries | the real-engine test |
| F16 | the shell's own publish record leaves out the edits | `a_failed_publish_names_its_edits…` |
| F17 | a publish looks up another target's edits | the real-engine test |
| F17c | the same, real window | live: both publishes, engine and shell records |
| F18 | a publish forgets by position, not by number (the defect found on review) | `the_ledger_keeps_the_newest_ids_per_target_and_forgets_only_what_was_published` |
| F19 | the count of unnamed edits is not cleared once they are published | the same test |
| F20 | a publish takes no mark of where it stopped | the same test |
| F21 | the document and the ledger are read after the workspace is released | `the_document_and_its_edits_are_read_under_one_hold_of_the_workspace` (3 of 3) |
| F22 | an edit is noted after the workspace is released | `an_edit_is_noted_under_the_same_hold_of_the_workspace_that_applied_it` (3 of 3) |
| F23 | a successful publish forgets another target's edits | the real-engine test |

**The two live mutations did not test anything the first time.** In both runs the
live check stopped before its checks: the first click on "New rectangle" produced
no edit (the page was not yet ready to act on it), which has nothing to do with
either mutation. A run that could not run is not a caught mutation, so I did not
count them. The click now repeats until an edit applies and the checks count the
edits that applied; the clean check then passed four runs in a row, and both
mutations, rerun, failed the checks named above.

## Jev and Laya

Design consult (`jev-laya-design.json`): Jev chose "the publish names the edit
ids" on all five questions (robust to front-end mistakes 0.95, bounded cost 0.81,
least risk to 2.13 0.56, overall 0.25 confidence); Laya chose the front-end gesture
id on all five. Decided by hand for Jev's: it holds whatever the front end does
(the shell decides what an edit and a publish are, and another client gets it for
free), it leaves 2.13's "one id is one call" intact, and its cost is bounded by
construction. The cost is that the follow is a search for the id in two fields
(`corr` and `carries`), not one; that is named below.

Slice review (`jev-laya.json`, run three times, the last on the final evidence and
the diff): followed from an edit to the engine 0.96, the done-when met 0.97, the
two-field reading acceptable 0.91, mutations can fail 0.95. Silent substitution
fell from 0.42 to 0.38 and "a publish names a wrong edit or misses one" from 0.54
to 0.33 across the two fixes above. Not resolved: "can invalid text reach a log
through the header" stayed 0.32 (no: every id is checked at the client, at the
listener and in the carry scope, and tested with a hostile header), and "must fix"
went 0.72, 0.57, 0.64: the first two each led to a defect that is now fixed; the
third pointed at nothing I could find by reading the changed code again, and is
reported as unresolved. Weakest point named by Jev: the live check's first click
(limit 8). Laya answered 0.93 to 0.99 on every yes/no question, as before: no
signal from it on yes/no.

## Limits and readings

1. **"One id" is followed through two fields.** An edit's id is the `corr` of its
   own records and an entry in the `carries` of the publish's records. A plain
   text search for the id finds all of them; a filter on `corr` alone does not.
2. **Only the newest 64 edits are named per publish**, and the count of the rest
   is on the shell's record (`carries_dropped`), not on the engine's: the header
   carries ids only. A person who drags a slider through 200 edits and publishes
   will find the last 64 by id.
3. **Edits the shell did not make are not carried.** The Editor's MCP server is a
   separate process that edits stored scenes under its own `mcp-…` ids; a publish
   from the shell does not name them. An edit made before the shell restarted is
   not named either: the ledger is in memory.
4. **A stored scene is keyed by project and scene id, an open one by session.**
   An edit to a stored scene made through one target and published through the
   other is not matched.
5. **At most 256 targets are followed at once**; an edit to a 257th is applied and
   not carried until another target is published.
6. **An old engine ignores `carries`** only if it is this code or newer: an engine
   built before this row refuses a publish header with a second member. Editor and
   engine are built from one tree; a mixed pair is not supported here (the same is
   true of `corr`, 2.13, which did the same thing).
7. **The live check reads the Editor's project list from the user's own store**
   (read only, as the Editor does at start); its logs, packages and WebView data
   are in a scratch folder.
8. **The live check needed its clicks made to repeat.** In two runs the first click
   on "New rectangle" produced no edit, because the page was not yet ready to act
   on it. The check now repeats the click until an edit applies (up to five tries),
   so it passed four runs in a row, and again after the final change. The edits it
   counts are the ones that applied, not a fixed number. The page's readiness is
   not something this row changes; a click that never lands fails the run.
