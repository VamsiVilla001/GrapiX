# 11.122 backend: project-wide asset usage for the Library panel (Panchayati task 119)

Built 25 Nov 2026 by claude-grapix-f1 (the UI session asked codex for tasks 119 to 123 for its Library, Data, Start and Publish panels; the
board was then cleared by the user, nobody had claimed 119, and the user told me to start the next backend task). Task 119 only: 120 to 123
are untouched. Nothing is committed.

## What it is

One rule, in one place (invariant 27), where the Editor used to read every stored scene itself and work usage out in TypeScript:

- **`Shared/contracts/src/asset_usage.rs`**: four types (`AssetUsageReport`, `AssetUsageEntry`, `SceneUse`, `UsageProblem`, generated to TypeScript)
  and the pure rule. **The key is the content hash**, else `id:<assetId>` (the same file in two scenes has two asset ids and one hash). **An
  asset is used by a scene when an object draws it**: an image object's `asset_id`, a mesh's `model_asset_id`, a texture of a material bound to
  one of the object's slots, or a font file named by a face of the font a text object uses. A scene counts **once**, scenes are listed in the
  order given, and a **scene that cannot be read is named** in `problems` with its reason, never silently left out. Every asset the library or
  any scene declares has an entry; `scenes: []` means "nothing uses it" (an answer, not a gap). The direct references are an exhaustive
  `match` over the object kinds, so a new kind of object cannot be added without deciding whether it draws an asset.
- **`services/editor/src/asset_usage.rs`**: reads a project's library and its stored scenes (sorted by scene id, the store's order) and applies
  the rule. A single unreadable scene is a problem in the report; only an unreadable project is an error.
- **`cmd_project_asset_usage(project)`** in `Editor/shell/src/lib.rs` (a thin wrapper, with its name in `tools/check-boundaries.mjs`'s read-only
  list), agreed with the UI session, which holds uncommitted edits in that file and wired the Library to it.

## Two decisions

- **Hidden objects count as drawing**, for images, models and fonts alike (the client rule never looked at `visible` either). `visible: false`
  is a toggle; the object needs its file when it is shown again, and the answer exists so that nobody deletes an asset a graphic still depends
  on. A text style that names a font does not count by itself (it is copied onto a text object when applied; removing a font a style names is
  refused separately by `font_edit`).
- **Fonts are counted here and were not by the old client rule** (slice 1b). The real project "Fonts 11.13" showed it: all four font files were
  reported unused. The UI session said yes; the fixture therefore holds no font and says so, and the font cases are tested in Rust only.

## Verification (25 Nov 2026, `agent/worktree`, own `CARGO_TARGET_DIR` on D:, under LOCK gate)

- **Rule: 18 tests** (`cargo test -p gx-contracts --lib asset_usage`): the key; image, model and bound-material texture; a material bound through any slot; a file
  shared by two scenes (one entry, each scene once, in the order given); the same file imported twice in one scene counts once; library and scene
  naming one asset the same way list its id once; a scene named by its store id, not the id inside its document; nothing using an asset is an
  empty list; an unreadable scene named and the others still counted; the same project gives the same report; no hash is kept apart by id; four
  font cases (a font used by text with all faces of that font; one declared and unused; a face from a stylesheet or an unknown font id counts no
  file and does not fail; hidden text, image and font count); and the shared fixture.
- **Service: 4 tests** on a real project store on disk (stored order with scenes written out of order; a corrupt scene file named with its reason
  while the rest still count; a library record no scene declares reported unused; an empty project and a missing one refused by name) and **1
  ignored test** that reads a real store by hand (below).
- **Parity with the client:** `Shared/contracts/fixtures/asset-usage.json` is built by the Rust test (rewritten with `GX_WRITE_FIXTURES=1`,
  otherwise the test fails on drift) and read by `Editor/tests/asset-usage-parity.test.ts` (new, read-only on the client), which runs the client's
  own `projectAssetUsage`, `assetUsers` and `usageKey` on it: **5 of 5**. It covers a file shared across two scenes under two asset ids, an unused
  asset, a mesh model asset and a bound-material texture.
- **Codegen:** `codegen:check` OK, 568 files current; the run changed exactly the four new type files and `index.ts`, nothing of anyone else's.
- **Gates that cover these files:** `check:boundaries` OK (56 tests); `cargo check -p gx-editor-shell` compiles with the command; the full
  suites of gx-contracts (389), gx-editor (161, 1 ignored), gx-contract-codegen and gx-editor-shell pass; the whole Editor suite: 100 files,
  1,518 tests; both new Rust files are rustfmt-clean; strict typecheck of the parity test.
- **Mutation: 20 of 20 caught** (`mutation-log.txt`, `tools/`): key ignoring the hash; image, model and mesh references dropped; any material
  counting, bound or not; a texture counting whatever asset it names; a scene counted per object; a scene that merely declares an asset counting;
  an unreadable scene swallowed; duplicate asset ids; the library not entered; scenes reversed; the document's id used for the store's; the
  service reading scenes in reverse, not reading the library, dropping unreadable scenes, losing the reason; and four on fonts. **The first
  run left four survivors that were real test gaps** (a scene declaring two assets of one hash; the library and a scene naming one asset the
  same way; a store id that differs from the document's id; a service test with no library asset); the tests were added and all four are now caught.
- **Real data** (`real-data-check.txt`): the rule run over copies of six real projects from the Editor's store (never the originals). It named a
  real unreadable scene in the user's `material-demo` ("missing field `r`"), and after slice 1b it reports a used font as used. None of the
  real projects has an image or model that an object draws, so the "used" path for those rests on the fixtures.
- **In the real Editor window**, by the UI session (debug build, scratch project): two scenes drawing one file under different asset ids read
  "2 scenes" and named both; an unreadable scene appeared as `usage-bad: scene document is not readable: missing field r`; a command failure
  shows a message, not counts.

**Not verified:** the rest of `npm run check` (others' Rust and conformance work is in flight).

## Open

- Tasks 120 (virtual folders and Import folder), 121 (local CSV source), 122 (test every record against the layout) and 123 (per-graphic
  readiness, last-opened and package fingerprint) were asked of codex by the UI session and are not started by me.
- `assets.list`, `objects.list` and `fonts.list` are declared in the MCP tool table with no handler (finding in `docs/evidence/8.14`); this
  report would be the natural content of an `assets.list`, but whether to serve it is the owner of 8.3 and 8.4's decision.
