# 5.12 — publishing is additive on air

**Done-when.** The recovery journal records a prepared scene for every revision
Program or the cue names, as well as each take's latest. Its check accepts
Program or the cue on any journaled revision of a published take. A test on a
real worker publishes a take, takes it, and publishes an edit while revision 1
is on Program: the edit is Published as revision 2, Program keeps revision 1
and is never inhibited, and revision 2 can be cued and taken. After a forced
kill and restart both revisions are restored and Program is revision 1.
`npm run check` passes.

## The defect (found while verifying 5.11, 8 Nov 2026)

`Engine::publish` moved `published[take]` to revision N+1 and then wrote the
journal. The journal recorded a prepared scene only for each take's latest
revision and refused Program or the cue on any other. So a take published
again while revision N was on Program was refused with `PreparationRefused {
TransportFailed "recovery journal write failed: ... program state T/N is not a
published revision" }` and output was inhibited. Row 5.10 makes the Editor
publish on every save, so editing a live graphic would have blacked out
Program.

## What changed

- **One rule for what the journal keeps.** `Engine::recovery_state` records
  each published take's latest revision and any earlier revision Program or
  the cue names. The rule is `RecoveryState::names`, which `validate` uses as
  well (invariant 27).
- **The check accepts what it can rebuild and nothing else.** An earlier
  revision is valid only if it is older than the published one, named by
  Program or the cue, and held by a record. A record of a take that is not
  published, of a revision newer than the published one, or of an earlier
  revision nobody names is refused. Program or the cue on an earlier revision
  the journal does not hold is refused. The pin check stays on the latest
  revision.
- **Restore judges a take's revisions as one.** Every record's assets are read
  back and re-hashed first. A take with a bad asset in any journaled revision is
  dropped whole and once: one `DroppedScene` at its latest revision (the floor),
  Program and the cue cleared if they name it. Before this change a take with
  two records would have been dropped twice.
- Schema stays 3: the shape is unchanged, the list has more entries.
- Runbook: the journal table says which revisions `preparedScenes` holds.

## Executed

| Check | Result |
| --- | --- |
| `cargo test -p gx-render-worker --lib restore_tests` | 14 passed (4 new for 5.12) |
| `a_take_published_again_while_its_earlier_revision_is_on_program_is_accepted` | Published as revision 2, Program still revision 1, output not inhibited, both journaled, the edit cued, a stale cue refused, both restored with Program on revision 1 and the cue on revision 2 after a restart |
| `an_earlier_revision_is_journaled_only_while_program_or_the_cue_names_it` | revision 1 leaves the journal once nothing names it |
| `the_journal_check_accepts_only_what_it_can_rebuild` | an unreferenced earlier revision, a missing record and Program ahead of the published revision are each refused |
| `a_take_with_a_bad_asset_in_any_journaled_revision_is_dropped_whole_and_once` | the damaged revision is either 1 or 2: one drop at revision 2, Program cleared, the other take untouched, publishing again gives revision 3 |
| `npm run conformance`, real worker `gx-render-worker` | 5 new checks in plane "recovery", all PASS on this T0 machine (below) |
| Gate | cargo fmt --check and clippy -D warnings exit 0; npm run check exit 0 (44 Node, 412 Editor, 817 Rust / 0 failed / 26 ignored, conformance 567/0/9) |

The conformance checks (`conformance/src/asset_restart.rs`, `republish_on_air`),
on the worker that is killed and restarted by the 5.11 suite:

1. a take is published and taken;
2. an edit is published while it is on Program: Published as revision 2, and
   `Status.program` is still revision 1;
3. the journal, read independently, holds revisions 1 and 2, and revision 2 is
   cued;
4. after a forced kill (TerminateProcess) the epoch has advanced by one, nothing
   was dropped, `Status.program` is still revision 1 and the journal still holds
   both;
5. revision 2 is taken and Program moves to it.

On an engine below T0 the checks skip by name: it cannot put revision 1 on
Program.

**Not observable over the wire.** "Never inhibited" is proved in process
(`output_inhibited()` is false after the publish). On these free-running
workers `live_allowed` is false either way, so the wire cannot show it. The
wire check is that the publish is Published, where it was refused before, and
that Program stays on revision 1.

## Mutations

Each is one exact replacement, run alone against `restore_tests`, with the file
restored byte-identical afterwards (compared byte for byte).

| # | Mutation | Failing tests |
| --- | --- | --- |
| M1 | the journal keeps only the latest revision | the accepted-republish, the forgets-when-unnamed, the check, and the dropped-whole tests |
| M2 | the check refuses any earlier revision | the same four |
| M3 | the check accepts an unnamed earlier revision | `the_journal_check_accepts_only_what_it_can_rebuild` |
| M4 | Program on an earlier revision needs no journaled record | `the_journal_check_accepts_only_what_it_can_rebuild` |
| M5 | Program may run ahead of the published revision | `the_journal_check_accepts_only_what_it_can_rebuild` |
| M6 | restore reads back only the first record of a take | `a_take_with_a_bad_asset_in_any_journaled_revision_is_dropped_whole_and_once` |
| M7 | a drop floors the wrong revision | the dropped-whole test and `a_dropped_take_is_refused_with_its_reason_and_continues_its_revisions_when_republished` |

M5 survived on the first run. The "ahead" case also left revision 1 unnamed, so
the check refused it for the wrong reason. The case now keeps revision 1 named
by the cue, so Program ahead is the only fault, and M5 fails it.

## Jev and Laya (run after the row was done)

Run on 15 Nov 2026, after both were reinstalled with the user's approval. The
same typed questions went to both: Jev `jev-1.14.0` (the numbers below are its
confidences, not versions) and `laya-multilingual` 0.4.28 at `max_len=8192`
(2155 state tokens, `truncated: false`). The state was the done-when as the plan
words it, this README in full and the gate facts. Both answers, with the
questions, are in `jev-laya-acceptance.json`. These answers are about the
record: the tests were not re-run for the review (the gate at `245859d` ran
them).

| Question | Jev | Laya |
| --- | --- | --- |
| `done_when_met` | 0.89 | 0.97 |
| `evidence_names_execution` | 0.99 | 0.98 |
| `silent_substitution_risk` | 0.39 | 0.98 |
| `weakest` | `platform_gap` | `vague_record` |
| `unrun_is_named` | 0.67 | 0.97 |
| `mutations_can_fail` | 0.76 | 0.98 |
| `after_kill_both_revisions` | 0.92 | 0.99 |
| `edit_does_not_inhibit` | 0.89 | 0.99 |
| `check_still_refuses_bad` | 0.94 | 0.99 |

Read by hand against this README. On the three clauses specific to this row
(the forced kill, the edit that does not inhibit Program, and the check that
still refuses) both say yes, and Jev is at 0.89 or above. Laya answers 0.97 or
more to every yes/no question, including `silent_substitution_risk` (0.98)
beside `done_when_met` (0.97), which contradict each other, and its `weakest`
answer `vague_record` is wrong for a record that names tests, commands and
counts: it is uncalibrated, so it is a second opinion and never a vote. Jev's
`platform_gap` is the T0 skip this README already names (below T0 the
real-worker checks skip by name; the done-when names no platform). No clause
without an executed check was found. The row is unchanged.

## Not in this row

- **Jev and Laya were not run when the row was built.** Their environments were
  gone from this machine. They were reinstalled with the user's approval on 15
  Nov 2026 and run afterwards; see "Jev and Laya (run after the row was done)"
  below. The acceptance rests on the execution above.
- **The engine keeps every published revision prepared in memory.** That is
  older than this row and unchanged: only the journal is bounded.
- **Taking revision 2 while revision 1 is on Program** uses the existing
  cue-then-take path. Stale references for new cues and takes are still
  refused: only the latest published revision can be cued or taken.
