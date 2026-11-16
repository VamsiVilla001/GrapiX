# 8.12 — if_revision, idempotency keys, batch-as-one-undo

Build-plan row `8.12`. Done when: **a retry after a timeout does not
duplicate.** Reopened because no crate depended on `gx-write-semantics` and no
MCP edit carried `if_revision` or an idempotency key; it closes again "when the
editor MCP edit path takes both through `gx-write-semantics` and the
retry-after-timeout test runs against that path". The user decided on 16 Nov
2026 that 8.12 has `if_revision`, and that Jev and Laya agree the design and
the acceptance and review what is built.

## What a write does now

- **`ifRevision` (Editor command, checked in the store).** `editScene` and
  `deleteScene` carry `ifRevision`, the stored scene's authoring revision the
  caller read (`SceneDocument.revision`; absent reads as 0). A stored edit
  takes the project's write lock, reads the scene, checks the revision with
  `gx_write_semantics::guarded`, applies the batch, and writes it at the next
  revision, all as one step. A stale revision is refused `revisionMismatch`
  naming the current one, before any edit is applied, and nothing is written.
  A batch is one write and one revision however many edits it holds; a batch
  that changes nothing writes nothing and answers the revision it found. The
  Editor's own unconditional writes (a person's Save, a create) also move the
  revision, so an agent holding an old one cannot overwrite them blind.
- **Required over MCP.** `scenes.edit` on a stored scene and `scenes.delete`
  refuse `revisionRequired` without it. The command keeps it optional: the
  Editor's project panel deletes without one.
- **The Editor's Save to its origin** is refused `revisionMismatch` when the
  stored scene moved on since the session read it (an agent edited it), so the
  agent's work is not overwritten; the session keeps its work, which still
  saves to a file. A save moves the revision in the session and its history
  base, so undo, redo and a second save still work.
- **A session target names no revision** (`commandUnknownField` at
  `ifRevision`): an open session has no stored revision, and accepting the
  field would let a caller believe a check ran.
- **`idempotencyKey` (every Editor MCP write).** `project.create`,
  `scenes.create`, `scenes.delete`, `scenes.edit`, `scenes.import` and
  `designsystem.commit` take an optional key. The handler strips it before the
  strict parse and fingerprints the rest of the request (SHA-256 over the
  command name and canonical JSON). The ledger lives in the project store
  (`<root>/.idempotency.json`, `gx_write_semantics::LedgerFile`) and is locked
  for the whole of lookup, execution and record, so a retry that reaches a
  restarted or second server process, or arrives while the first attempt is
  still running, replays the first answer. The same key with other arguments is
  refused `idempotencyKeyReused`. A refused write is not recorded. The ledger
  keeps 256 answers or 2 MB, oldest first out.
- **Results carry the revision.** `CommandOutcome.revision` is the stored
  scene's revision after a command that addressed one (0 for a new scene);
  `scenes.get` reports a never-edited scene at revision 0.
- **The lock** is `gx_fs::FileLock` (`File::lock`, an OS lock on
  `<project>/.scenes.lock`), so it holds across the Editor shell and every MCP
  process and is released if a process dies. Lock order is always ledger then
  scene, or scene alone.
- **Wire protocol 6.** The stored-scene write is now a compare-and-swap that an
  agent built for 5 must change for, and the tool schema is versioned with the
  protocol (8.1), so `PROTOCOL_VERSION` is 6.

## Design, agreed by Jev and Laya first (`design-jev-laya.json`)

| Question | Jev | Laya | Decided |
| --- | --- | --- | --- |
| what `ifRevision` compares against | authoring revision (1.0) | published revision | **authoring revision** |
| required on a stored write | required (0.98) | required | required |
| where the check lives | in the store write (1.0) | MCP wrapper only | **in the store write** |
| the Editor's Save | check and bump (1.0) | unchanged | **check and bump** |
| where the ledger lives | durable in the store (1.0) | durable in the store | durable |
| a reused key with other arguments | refuse by name (1.0) | return the first result | **refuse by name** |
| the crash window | the revision guard covers it (1.0) | the ledger must be in the scene file | **revision guard** (see below) |
| which writes take which guard | revision on edit and delete, key on all (0.94) | same | same |
| must the user approve | 0.29 | 0.97 | see below |

Decided by hand where they split. The published Take revision is issued by the
engine at publish and is owned by Playout; an unpublished scene has none, and
`SceneDocument.revision` is documented as the authoring token, so it is the
token. A check in the MCP wrapper only would leave the Editor's own writes able
to overwrite an agent's blind, and two copies would be invariant 27. Leaving
Save unchanged is the silent loss of an agent's edit (invariant 18). Returning
the first result for a different request is a silent substitution. Keeping the
ledger inside each scene file does not cover creates or project writes; the
revision guard turns the crash window into a refusal rather than a duplicate
for every write but one (named below). On "must the user approve": the user
asked for `if_revision` and delegated the design to Jev and Laya; the one
behaviour a person sees, Save refusing over an agent's newer edit, is reported
to the user.

## Code review by Jev and Laya (`review-jev-laya.json`)

Run on the code as built (the stored edit, Save, delete, the store lock, the
MCP handler, both ledgers), with the tests that had run. Laya read it whole:
5424 tokens, not truncated.

| Question | Jev | Laya |
| --- | --- | --- |
| the lock covers read, check and write | 0.80 | 0.97 |
| a stale revision is refused before applying | 0.89 | 0.94 |
| Save refuses an overwrite and keeps the session in step | 0.90 | 0.95 |
| a retry with the same key can duplicate | 0.24 | 0.95 |
| a reused key is refused | 0.97 | 0.95 |
| the two locks can deadlock | 0.44 | 0.96 |
| weakest point | crash window (0.21) | damaged stored revision |
| a defect must be fixed first | 0.54 | 0.92 |

Laya answered about 0.95 to every yes/no question, whichever way it was put
(that a duplicate is possible, and that it is not), so its answers do not
discriminate here. Jev was unsure on the deadlock and on a blocking defect.
Checked by hand:

- **Deadlock.** The ledger lock is taken only by a keyed MCP write, before the
  command runs; the scene lock only inside a stored edit, a save, a create, a
  duplicate or a delete, none of which takes the ledger lock or a second scene
  lock. No path takes them in the other order, so there is no cycle.
- **Duplicate on retry.** With the ledger intact, the lookup and the execution
  are one call under the ledger lock, so a key seen before replays. The race
  tests run this across processes.
- **Blocking defect.** None found. Two weak points are real and are named under
  "Not in this row": the crash window for `designsystem.commit`, and a damaged
  scene file having no revision to check.

## Verified by execution

- `cargo test -p gx-editor-mcp --test write_semantics_surface` (6 passed), the
  shipped `gx-editor-mcp` binary over stdio with a real handshake:
  - **the done-when**: `a_retry_after_a_lost_reply_returns_the_first_answer_and_writes_once`.
    A keyed `scenes.edit` that creates an object lands; its reply is read off
    the pipe and dropped, and the process exits. The same request through a new
    process returns the first answer value for value, the scene still holds one
    object, and the revision is 1. The same key with other arguments is
    refused `idempotencyKeyReused` and writes nothing; a new key is a new write.
  - `a_retry_racing_the_first_attempt_waits_for_it_and_replays_it`: three
    processes send one keyed request at once; all get one answer, one object.
  - `writers_racing_on_one_revision_land_exactly_once`: four processes write at
    revision 0 at once; one lands, three are refused `revisionMismatch`.
  - `a_stale_or_missing_revision_writes_nothing_and_says_which_is_current`: no
    `ifRevision` on `scenes.edit` or `scenes.delete` refuses `revisionRequired`;
    a batch of three edits is revision 1; a stale edit is refused naming
    "expected 0, got 1" with the stored scene unchanged; a stale delete keeps
    the scene; `scenes.get` reports revision 1; a current delete removes it.
  - `a_create_retried_with_its_key_is_answered_not_refused`: a keyed
    `scenes.create` retried through a new process gets its first answer
    (revision 0); unkeyed it is refused `sceneAlreadyExists`; an empty key is
    refused by name before anything runs.
  - `every_editor_write_lists_the_key_and_the_revision_in_its_schema`: in
    `tools/list`, every write lists `idempotencyKey`; edit and delete list
    `ifRevision`.
- `cargo test -p gx-editor --lib` (84 passed), the Editor command executor:
  a stored batch is one revision and a stale one lands nothing; a no-op batch
  answers the revision it found; the Editor's own write moves the revision; a
  session target naming a revision is refused; Save over an agent's edit is
  refused and the session still saves to a file; a save moves the revision in
  the session and its base, so undo, redo and a second save work; a stale
  delete keeps the scene; and
  `writers_released_together_on_one_revision_land_exactly_once_per_round`
  (eight workspaces on one store, released by a barrier, 50 rounds: one write
  per round, revision 50).
- `cargo test -p gx-write-semantics` (12) and `cargo test -p gx-fs` (17): a key
  reused for another request is refused and runs nothing; a refusal is not
  recorded; the fingerprint ignores key order but not edit order; the byte
  bound evicts the oldest and keeps the newest; a new `LedgerFile` over the same
  path replays; a damaged ledger refuses loudly; four threads never hold the
  file lock together, and it is released on drop.
- Conformance refusal audit, over the Editor MCP server's JSON-RPC:
  `RevisionRequired`, `IdempotencyKeyReused` and a stale-revision
  `RevisionMismatch` are each produced with nothing written.
- `cargo tree -i gx-write-semantics` now shows `gx-editor` and `gx-editor-mcp`
  (the plan's reopening condition was that it showed none).
- npm run check exit 0 on the final tree (46 Node, 412 Editor, 895 Rust passed,
  0 failed, 37 ignored; conformance 594/0/9); `cargo clippy --workspace
  --all-targets -D warnings` and `cargo fmt --all` clean.

**Batch as one undo.** Unchanged and still held: a batch is applied to one
candidate and lands whole or not at all (`apply_edits`), is one undo entry in a
session (the existing history tests), and is now one revision against the store.

## Jev and Laya acceptance (`jev-laya-acceptance.json`)

Run on this record. Laya read it whole: 4145 tokens, nothing truncated or
dropped.

| Question | Jev | Laya |
| --- | --- | --- |
| done-when met by execution | 0.97 | 0.92 |
| evidence names execution | 0.99 | 0.92 |
| silent substitution risk | 0.41 | 0.97 |
| weakest point | none (0.37) | vague record |
| what was not run is named | 0.43 | 0.88 |
| mutations can fail | 0.98 | 0.87 |
| a retry after a lost reply does not duplicate | 0.98 | 0.91 |
| `ifRevision` enforced | 0.98 | 0.91 |
| through `gx-write-semantics` | 0.98 | 0.97 |
| races covered | 0.99 | 0.89 |

They agree the done-when is met. They split on what was not run and on the
silent-substitution risk. By hand: the record pointed to `memory.md` for the
gate after the last test, which was vague, and did not say the Editor app
itself was not run. The gate was re-run on the final tree (above) and the app
is named under "Not in this row". The one substitution
a caller could miss, a replayed answer looking like a fresh one, is named. The
split is reported to the user.

## Mutations

One exact replacement each, run alone against the tests named, each file
restored byte-identical (`mutate_812.py` in the session scratchpad). All 13 fail.

| # | Mutation | Failing |
| --- | --- | --- |
| W1 | a stored edit ignores a stale `ifRevision` | the batch test, the in-process race |
| W2 | a stored write does not move the revision | the batch, delete and save tests |
| W3 | a no-op batch still writes and moves the revision | `a_stored_batch_is_one_revision_and_a_stale_one_lands_nothing` |
| W4 | the stored edit takes no lock | `writers_released_together_on_one_revision_land_exactly_once_per_round` |
| W5 | Save overwrites a scene an agent changed | `saving_over_a_scene_an_agent_changed_is_refused_and_the_work_still_saves_to_a_file` |
| W6 | Save leaves the session base at the old revision | the same |
| W7 | a delete ignores its `ifRevision` | `a_delete_naming_a_stale_revision_keeps_the_scene` |
| W8 | the MCP surface does not require `ifRevision` | `a_stale_or_missing_revision_writes_nothing_and_says_which_is_current` |
| W9 | a reused key is answered with the first result | `a_key_reused_for_another_request_is_refused_and_runs_nothing` |
| W10 | the ledger is not saved to its file | the lost-reply, racing-retry and keyed-create wire tests |
| W11 | the ledger lock is released before the write runs | `a_retry_racing_the_first_attempt_waits_for_it_and_replays_it` |
| W12 | the tool schema does not list `idempotencyKey` | `every_editor_write_lists_the_key_and_the_revision_in_its_schema` |
| W13 | a session target accepts `ifRevision` and ignores it | `a_session_target_names_no_revision` |

## Not in this row, by name

- **`designsystem.commit` has no revision guard.** A design-system confirm
  makes the next version. Retried with its key it replays; retried without a
  key, or in the crash window (the confirm landed and the process died before
  the ledger was saved), it makes a second version. Every other write turns
  that window into a named refusal (`revisionMismatch`, `sceneAlreadyExists`,
  `projectAlreadyExists`).
- **A damaged scene file has no revision to compare.** Save to origin and a
  delete with `ifRevision` go through for a scene file that does not parse as
  JSON, as Save did before revisions; an agent cannot edit such a scene at all,
  because the stored edit reads it through the closed reader first.
- **The lock waits without a bound.** A writer that hangs while holding it
  blocks the others in that project until it exits (the OS releases the lock
  then).
- **The Editor's own delete** from the project panel sends no `ifRevision`.
- **Program-side writes** (`playout.*`, `outputs.configure`, `packages.*`) take
  no idempotency key; cue and take are pinned by revision and content hash
  (11.38). Not this row's surface.
- **Not run: the Editor app.** Save refusing over an agent's edit is shown in
  the command executor the Tauri shell calls; the running Editor app was not
  driven, so how it shows that refusal to a person was not seen.
- **No replay marker.** A replayed answer is the first answer exactly; the
  reply does not say it was replayed.
