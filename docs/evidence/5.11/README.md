# 5.11: the engine restores asset-bearing scenes after a forced kill

Row 5.11 (added 8 Nov 2026 by user decision, from the 5.8 review). Since 5.9
a killed `gx-render-worker` could not restart after any publish with a font.
It exited 1 with "cannot restore recovery journal: … prepared scene … cannot
be rebuilt: asset missing: 3127f0b8…", because the journal kept asset hashes
and the bytes lived only in memory. This was reproduced on both routes
before the fix.

## Design and decisions

The design was mapped and drafted by a read-only workflow: three readers,
three designs, a judge and a completeness critic
(`design-synthesis.json`). Jev and Laya were asked every open question
(`design-jev-laya.json`).

| Question | Decision | By |
|---|---|---|
| Persist, re-hash on restore, drop a bad scene by name, still start | adopted | user, 8 Nov (Jev 0.98; Laya near-random) |
| A scene whose bytes verify but that no longer prepares | still refuses to start; the journal is left untouched | Jev and Laya agreed |
| Store cleanup | none in 5.11; Panchayati task #108 | Jev and Laya agreed |
| Naming drops durably | `recovery.json.dropped.json` written before the journal is rewritten, plus a bounded stderr summary | user (Jev 0.78; Laya stderr only 0.53) |
| Revision after a drop | a journaled floor (`revisionFloors`), so a number is never reused | user (Laya 0.63; Jev reuse 0.97) |

The critic's gaps, all applied:
- a restart that does not answer is a FAIL, not a SKIP;
- the take check depends on the tier (Taken below T0 is a FAIL);
- no filesystem path appears in `AssetStoreFailed`;
- store reads are bounded;
- `publish()` checks the store before acknowledging;
- the Editor's two read-back copies go through `read_verified` (invariant 27);
- the store location is checked independently of the derivation under test;
- the lock-independence test signals at the transfer's Begin;
- `AssetMissing` and `AssetStoreFailed` are driven through `EnginePeer` in
  the refusal audit.

## What was built

- **The store.** `<journal file name>.assets` beside the journal (production:
  `%APPDATA%\GrapiX\GrapiX\data\render-engine\recovery.json.assets`). It
  reuses `AssetStore::at_root`, which writes atomically and re-hashes.
  `RecoveryJournal::asset_store_directory` is the one derivation.
- **Write path.** The asset port writes each asset to the store, *without
  holding the engine*, before the engine is handed it. On the chunked route
  that is `PeerAssets::accept`; by path it is `store_packaged`, before
  `deliver_packaged`. New `AssetPublishPeer::asset_store()` (default `None`).
  The engine refuses bytes its store does not hold (`AssetStoreFailed`).
  `publish()` refuses `AssetMissing` for a declared asset the store does not
  hold, before anything changes.
- **Restore.** Every asset each journaled scene declares, images included, is
  read back with `AssetStore::read_verified`: content-address check, plain
  file only, bounded by `MAX_PACKAGE_BYTES`, re-hashed. A scene with a
  missing, altered or unreadable asset is dropped:
  - it leaves `published`, which closes the identifier-only take bypass;
  - Program and the cue are cleared only if they name it;
  - its revision becomes the take's journaled floor;
  - an in-memory record refuses Cue, Take and Render with the reason.

  The engine still starts at epoch+1, output-inhibited. The drop report is
  written, then the journal. Schema stays 3, so a journal written before
  5.11 starts with its asset scenes dropped by name.
- **Naming.** `recovery: N journaled scene(s) dropped; re-publish them`,
  then one line per scene within a 2 KB budget, then a pointer to the report.
- **New refusal.** `Refusal::AssetStoreFailed { hash, detail }`; TS
  regenerated.
- **Runbook.** `docs/engine-recovery-runbook.md` (schema 3, the store, drops,
  store failures).

## Executed

See the gate figures in `memory.md`, 8 Nov 2026.

- `cargo test -p gx-asset-plane`:
  - store: read_verified with altered, truncated, grown and non-address
    hashes; the store-failure refusal without a path;
  - handoff: each route stores before the peer receives; an unwritable store
    refuses by name on both routes; the store write never waits for the
    held peer.
- `cargo test -p gx-render-worker`: 9 restore tests:
  - restore from the store, unstored bytes refused, an entry removed while
    running;
  - removed and altered drops; Program and cue clearing; every scene
    dropped; a journal written before 5.11;
  - the refusal by reason and the journaled floor;
  - plus the journal-naming and floor-validation tests.
- Conformance, against four real workers killed with TerminateProcess
  and started again on their journals: 15 new checks pass, both restored
  takes and the intact scene's take are Taken (T0, RTX 3070 Ti), and
  conformance is 561 passed, 0 failed, 9 skipped.
- Mutations: see the table below, each restored byte-identical.

## Mutations

| # | Mutation | Check that fails |
|---|---|---|
| C1 | restore without the stored bytes (HEAD behaviour) | `a worker killed after a by-path publish restarts on its journal at the next epoch` |
| C2 | a restore that hangs past the start deadline | `a worker killed after a by-path publish restarts on its journal at the next epoch` |
| C3 | drops not named on stderr | `the restart names both dropped scenes and their reasons` |
| M1 | chunked store write removed | `each_route_stores_the_bytes_before_the_peer_receives_them` |
| M2 | by-path store write removed | `each_route_stores_the_bytes_before_the_peer_receives_them` |
| M3 | chunked store write under the peer lock | `the_store_write_never_waits_for_the_peer` |
| M4 | read_verified skips the re-hash | `removed_and_altered_stored_bytes_drop_their_scenes_by_name` |
| M5 | read_verified without the content-address check | `read_verified_never_makes_a_path_of_a_hash_that_is_not_a_content_address` |
| M6 | restore re-hashes only fonts | `removed_and_altered_stored_bytes_drop_their_scenes_by_name` |
| M7 | a bad scene stops the whole restore | `removed_and_altered_stored_bytes_drop_their_scenes_by_name` |
| M8 | a dropped take stays published | `removed_and_altered_stored_bytes_drop_their_scenes_by_name` |
| M9 | a cue on a dropped take is kept | `removed_and_altered_stored_bytes_drop_their_scenes_by_name` |
| M10 | Program cleared whenever any scene drops | `a_drop_clears_only_the_program_and_cue_that_name_the_dropped_take` |
| M11 | no refusal by reason for a dropped take | `removed_and_altered_stored_bytes_drop_their_scenes_by_name` |
| M12 | no revision floor on re-publish | `a_dropped_take_is_refused_with_its_reason_and_continues_its_revisions_when_republished` |
| M13 | publish acknowledged without the store holding the bytes | `an_entry_removed_while_the_engine_runs_is_missing_and_blocks_a_publish` |
| M14 | accept keeps bytes the store does not hold | `bytes_the_store_does_not_hold_are_refused_by_name_and_change_nothing` |
| M15 | no drop report | `removed_and_altered_stored_bytes_drop_their_scenes_by_name` |
| M16 | preflight answers from memory only | `an_entry_removed_while_the_engine_runs_is_missing_and_blocks_a_publish` |
| M17 | store at a fixed name beside the journal | `the_store_and_the_drop_report_are_named_after_their_journal_file` |

Each mutation was one exact replacement in one file, run alone; each file was restored byte-identical (compared byte for byte). C1-C3 ran against the real workers: C1 (restore without the stored bytes, the pre-5.11 behaviour) exits the restarted worker 1, a FAIL; C2 (a restore that hangs 20 s) is a FAIL, never a SKIP; C3 (no stderr lines) fails the naming check. The runner is `scratchpad/mutate_511.py` (not committed).

## Not in this row

- **Store cleanup**: task #108.
- **Pre-existing, found while verifying: re-publishing a take while an
  older revision of it is on Program fails.** `publish()` moves `published`
  to N+1, the journal check then refuses a Program at N, and the publish is
  refused while output is inhibited. Reproduced in process on T0 with a
  throwaway test. User decision (`republish-jev-laya.json`): the journal keeps
  every revision Program or the cue names; new row `5.12`, built before 5.10.
- **Mock parity.** The mock engine keeps no journal or store, so it has no
  `AssetStoreFailed` and no restore drops; its comment says so.
- **Wire visibility.** Output inhibition cannot be observed over the wire on
  these free-running workers (`live_allowed` is false either way). It is
  proved by the in-process tests.
