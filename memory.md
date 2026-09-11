# GrapiX 2.0 — session memory

The session log: what changed, when, and what was verified by execution. It
records history and grants no authority — see `docs/README.md` for the
authority order, and `docs/invariants.md` for the binding rules.

Status words are used exactly as `docs/README.md` defines them. **Planned** is
not a euphemism for nearly done.

---

## Rules for the next session

1. Read this file and `docs/invariants.md` before editing. The invariants are
   binding; this file is context.
2. **Read `LLM-GOVERNANCE.md` before any task. It is binding on every LLM and
   platform.** The verify-then-record loop is mandatory: no task is marked
   done without execution evidence against the step's "Done when" criterion in
   `GrapiX-Build-Plan.md`, and only then is it recorded in `progress.html` /
   `progress.json` (kept in sync, committed with the work). `GrapiX-Build-Plan.md`
   is the only build plan; `progress.html` is the only tracker.
3. Inspect `git status` before editing. Preserve uncommitted work.
4. Log every change here: what, why, and what was actually run to verify it.
   An entry with no execution evidence must say so.
5. Never describe anything as working without having run it. "Compiles" is not
   "works", and `cargo check` is not a test.
6. Run `npm run check` before committing. It is cheap and it is the whole gate
   at this stage.
7. Rust is the source of truth for contracts. Never hand-edit
   `Shared/generated-ts` — regenerate and commit the result.
8. Do not add a `Now` variant to `TakeAt`, or any other way for a client to
   send a time. That is invariant 8 and it is the load-bearing decision of the
   whole architecture.
9. `resolve_intent` has exactly one implementation. A mock, a test double or a
   second engine must call it, never reimplement it (invariant 46).
10. The control plane has an L0 transport; the asset and media planes do not.
   Do not describe those two as transported.
11. The L0 transport is loopback TCP, not the named pipe ADR-001 specifies.
   Say so when describing L0 security posture.
12. Authentication lives in the transport. Do not add a credential check to
   the engine or to a request handler.
13. The credential is a shared bearer token over an unencrypted socket. Never
   describe it as mTLS, and never describe L1 as ready.
14. `docs/adr/0002-platform-and-mcp-schema.md` is the accepted handoff and its
   **Part E is the definition of done**. Verify against it; do not claim an
   item without execution evidence.
15. The next implementation steps are **1.3 (material model; fit and blend
   enums as the single source of truth)** and **1.4 (colour types)**. Both are
   unblocked, both are named residuals of 1.2, and 1.4 also gates 3.3. The
   catalogue already has the fields that consume them — an image's fit, a
   slab's culling, `fill`/`stroke` as CSS strings, `material_slots` as an
   opaque map — so those four are the seams to fill, not to redesign.
16. The structured refusal envelope is `StructuredRefusal` in `gx-contracts`
   (0.6). It uses `allowed`, never `supported` — that inconsistency is
   settled. The severity type is `RefusalSeverity`; `Severity` stays with
   clock health. Optional fields are `Option<T>` with `skip_serializing_if`
   **and** `#[ts(optional)]` — ts-rs cannot see serde's skip attribute, and
   one without the other makes the TS shape lie about the wire.
17. CI-only done-when criteria (0.3, 0.4) are not closable from a workstation.
   Mark `active` with the workflow committed and every locally observable
   half verified; `done` needs the CI run's green check plus the SBOM
   artifact, which only exists after a push. Do not mark them `done` because
   the YAML looks right.
18. A detected output card is not a ready one. The DeckLink probe
   (`Shared/decklink`) reports runtime presence; readiness is Phase 15 and
   needs the vendor SDK, which is a separate Blackmagic download not yet in
   the tree. Never set an output capability from a probe or a feature flag
   (invariant 21).
19. A failing-over-the-wire check that unit tests pass is usually a stale
   spawned binary, not a contract break. Rebuild and re-run before treating
   a wire failure as a serialisation bug — the conformance engine is a real
   child process and cargo does not rebuild it between runs of the harness.
20. **Hierarchy resolution walks from the roots, never down the array.** A
   child may be declared before its parent; resolving in array order makes it
   a root and silently drops the parent's transform. Duplicate ids keep the
   *first* object, which is what 1.x did and what keeps resolution
   deterministic while an invalid scene is being repaired.
21. **A kind must never redeclare an `ObjectBase` field.** With
   `#[serde(flatten)]` both are emitted, the reader keeps the last, and an
   authored value is silently lost. `fill` was declared twice until 1.2. The
   catalogue round-trip test uses a fully populated base so any recurrence
   fails.
22. **The generated TS maps `u64` to `bigint`; JSON gives `number`.** That
   affects `Revision`, `Epoch`, `Sequence`, frame numbers, `durationFrames`
   and `sizeBytes` — twelve types. The mapping is deliberate and consistent;
   the conversion is owed by the TypeScript client codec, which does not exist
   yet. Do not "fix" it with a cast in a test.
23. **Never assign a wire literal with `as unknown as T` in a TypeScript
   contract test.** A double cast type-checks anything; it hid two real drifts
   until 1.2 replaced it with a direct assignment. Assign directly and let the
   compiler do the work.
24. 1.x's layer masks, Photoshop layer styles, blending options and
   `importedDesign` provenance have **no owning step in the build plan**. They
   are outside 2.0's planned scope, not a gap in the catalogue. Adding them is
   a plan change and the user's call.
25. **`serde_json` needs `float_roundtrip` and it is not cosmetic.** Every
   scene object flattens `ObjectBase`, and `#[serde(flatten)]` forces
   deserialisation through `deserialize_any`, whose default float parser is
   accurate to a ULP rather than exact. Without the feature a scene written
   and read back is a different scene, and a content hash over the
   re-serialised document differs from the original's — a `.gpxpkg` manifest
   would be wrong about its own contents. `scene.rs` has the regression test.
26. **A worker the test harness leaks holds `gx-render-worker.exe` open**, so
   the next `cargo build` fails with "access is denied" and the *next* test
   run gets a stale binary it then hangs against. `start_worker` in
   `services/render-engine/host/tests/ensure.rs` owns the child from spawn,
   not from successful connect; if you see the access error, kill the image
   with `taskkill /F /IM gx-render-worker.exe` before rebuilding.
27. **The capability exchange declares what a device measured, not what a
   build enabled** (invariant 21). An engine with no rasteriser declares
   `MaterialSupport::none()`, and a validator refusing every mode against
   that list is the correct answer, not a degraded one.

---

## 2026-09-11 — colour and material contracts (1.4, 1.3), atomic write and case policy (2.1, 2.3)

Scoped by the user: "start the remaining Phase 1 & 2". The subagent runtime hit its usage limit twice, so these were done inline.

**2.1 — `Shared/fs` (`gx-fs`), atomic replacement.** Unique temp file created with `create_new`, data `sync_all` before the rename, directory fsync after (Unix only — Windows cannot open a directory through `std::fs::File` without `unsafe` and this crate forbids it; NTFS journals the rename's metadata and the doc says so). A Windows sharing violation from an indexer or scanner is retried with bounded backoff; anything else reports on the first attempt, with the attempt count in the error. One implementation; `fs::write` is never the call for a file that matters. 7 tests, including eight writers racing on one path.

**2.3 — case canonicalisation.** `FileName` in `gx-contracts::platform`: compares case-folded (NFC + locale-independent lowercase) and displays as authored, so the policy is in the type rather than at a call site — a `HashMap<FileName, _>` cannot be built wrong. Proved against a real directory listing, which is what "a case-sensitive volume behaves identically" has to mean.

**1.4 — `gx-contracts::color`.** The working space has one variant, every colour is tagged, and the two output transforms are the piecewise curves from the standards, tested to 1e-9 and at the sRGB knee, with the two curves pinned as measurably different at mid grey. `Rgba::from_css_hex` refuses by name (`InvalidColor`), never defaults — a mistyped colour becoming an invisible graphic on air is the failure this prevents. `ColorValue` (`none | solid | linear-gradient | radial-gradient`) carries the gradient model from 1.x with every stop tagged. `Editor/src/color-policy.ts` now *imports* the generated types rather than hand-mirroring the unions, which is what invariant 22 always required.

**1.3 — `gx-contracts::material`.** One `BlendMode` and one `FitMode`, merged from 1.x's two fit vocabularies (`fit`/`contain` and `fill`/`cover` were pairs; the old spellings are refused). The supported set is **data a peer declares** through its capability (`MaterialSupport`), never a constant and never a build flag — and the real engine, whose `rasterizer_status()` is `NotImplemented`, declares `none()`, so every material currently refuses by name, which is the honest answer. `Refusal::UnsupportedBlendMode` and `UnsupportedFitMode` carry the enum instead of a string, so an unsupported mode cannot be spelled freehand, and `validate_material` attaches the peer's allowed list so the caller corrects in one step. `overlay` has a test named after what it must never do.

**Two faults the work surfaced.** (a) `serde_json` without `float_roundtrip` silently drifts flattened floats by a ULP — found by the scene round-trip failing on `48/255`, fixed at the workspace dependency with the reason in the manifest, regression-tested. (b) The host's integration test leaked a worker process on a failed startup; three leaks later, Windows refused to overwrite `gx-render-worker.exe` and the next test run hung against a stale binary for twenty minutes. The child is now owned from spawn, and memory rule 26 records the operator-facing recovery.

### Verified by execution

| What | Result |
|---|---|
| `cargo test --workspace` | **223 passed, 0 failed** |
| `cargo test -p gx-contracts` | 56 passed — colour 7, material 5, scene 14 |
| `npx vitest run` (Editor) | **9 passed** — paint resolution, geometry, camera, colour policy |
| `node --test` (TS) | 15 passed |
| `npm run check` | **exit 0** — codegen 131 files, conformance **99 passed, 0 failed, 9 skipped** |

### Status after this entry

| Unit | Status |
|---|---|
| 1.3, 1.4, 2.1, 2.3 | **done** |
| `Shared/fs` | **Partial** — atomic write done; file watching (2.5) not started |
| 1.8, 1.11, 1.12, 2.5, 2.6, 2.7, 2.9, 2.10 | **open** |
| 2.8 | **active** — the remote-font resolver is still the open half |

### Not done, and not claimed

- The engine draws nothing. `MaterialSupport::none()` is a true statement about a renderer that does not exist yet; it becomes a measured set at 3.5/3.7.
- The viewport converts solid sRGB and linear colours and reports everything else as unsupported rather than approximating — gradients, Display P3 and Rec.709 source colours are not drawn.
- No `.gpxpkg`, no project store, no asset store, no watcher, no token/role/scope model, no audit log.

Resumed an interrupted session: `Shared/contracts/src/scene.rs` had 664
uncommitted lines — the remaining eight object kinds and a first cut of the
hierarchy resolver — with no tests, and the resolver half-finished. Continued
it to 1.2's done-when rather than starting anything new.

**The catalogue is measured, not asserted.** 1.2's done-when is "every
authorable object is representable", so the kind set is held against 1.x's own
machine-readable claim: `programObjectTypes` + `notRenderedByProgram` in
`Shared/shared-types/contracts/program-object-types.json` on
`Basic-v0.4-2026-09-06-project-container-material-library`. Thirteen kinds —
text, rect, ellipse, image, line, shape, paint, mesh, light, camera, layer,
marker, group. A Rust test compares the serialised tags to that list; a Node
test extracts the tags from the *generated* `SceneObject.ts` and compares the
same way, so a kind that reaches one language and not the other fails.

**The property surface was ported from 1.x's interfaces, field by field**, not
eyeballed: the base box (`width`/`height` — 1.x carries them on
`BaseSceneObject`, and bindings target them, so they belong on the base and not
on three kinds), text typography (layout, auto-fit, writing mode, vertical
align, direction, case, decoration, overflow, align, line height, letter/word/
paragraph spacing, indent — the surface 3.6's shaper consumes), rect corner
radius, AE trim paths on shape, paint stroke dynamics, XPression slab controls
with 1.x's defaults, light decay/cone/penumbra, camera `up`, glTF clip
selection on mesh. What is *not* there is named with the step that owns it:
colour values → 1.4, fit/blend/cull enums → 1.3, keyframe channels → 1.6 and
11.10.

**One scope finding for the user.** 1.x's layer masks, Photoshop layer styles,
blending options and `importedDesign` provenance are not in the catalogue, and
**no step in `GrapiX-Build-Plan.md` owns them** — there is no design-importer
or mask-compositor step in the 164. They are recorded as outside 2.0's planned
scope rather than deferred to an unnamed step. If they are wanted, the plan
needs a step; they are not a contract gap to fill quietly.

### Four faults the work surfaced, each fixed

1. **Forward-declared children lost their parent.** The draft walked the
   `objects` array from the top, so a child listed before its parent resolved
   as a root and the parent's transform vanished — wrong placement, nothing
   reported. The walk now starts from the roots (1.x's own order), with 1.x's
   defensive second pass for malformed duplicate-id documents. A test resolves
   the same two objects in both orders and compares.
2. **Duplicate ids kept the last object; 1.x keeps the first**, deliberately,
   so resolution stays deterministic while the editor repairs an invalid
   scene. Now first-wins, compared by pointer identity as 1.x compares by
   reference.
3. **Mesh X/Y rotation was accumulated and then dropped.** `ResolvedObject`
   had no `rotation_x`/`rotation_y`, so the one rule the mesh doc claims — 3D
   rotation composes down the hierarchy on meshes and nowhere else — was
   computed and discarded. Both are reported now, inherited on meshes and
   authored on every other kind, which is 1.x's rule.
4. **`fill` was declared on both `ObjectBase` and three kinds.** With
   `#[serde(flatten)]` that emits a duplicate JSON key, the reader keeps the
   last, and one of the two authored values is silently lost. The kinds no
   longer redeclare base fields, and the catalogue round-trip runs against a
   base with *every* field set away from its default, so any future shadowing
   fails the test.

**Two drifts the strengthened TypeScript proof caught.** 1.1's "compile-time
half" was `wire as unknown as SceneDocument` — a double cast, which type-checks
anything. It is now a direct assignment, and it immediately found (a)
`AssetAvailability` serialising `"Ready"` on an otherwise camelCase surface —
it was missing `rename_all`, now fixed and regenerated; (b) `Revision`,
`durationFrames` and `sizeBytes` are `u64` → `bigint` in the generated TS,
while `JSON.parse` yields `number`. The bigint mapping is consistent across
twelve generated types (frames, epochs, sequences), so it stays; the test now
states it honestly with `n` literals and records that the conversion belongs to
the TS client codec. **No TypeScript client parses these yet — when one does,
that gap is real work, not a typo.**

**The resolution is a contract type.** `ResolvedObject`, `HierarchyEdge`,
`HierarchyChildren` and `HierarchyResolution` serialise and generate to TS, so
the Editor consumes the one Rust implementation of the composition rules
instead of re-deriving inheritance in the browser. Containers are included in
`effective` and flagged `is_container`, with `renderable()` and `containers()`
as the two views 1.x returned separately.

`Editor/src/viewport.ts` had to grow with the union: its switch now names all
thirteen kinds, so a fourteenth stops the build rather than silently skipping
the object, and each `return null` says which step draws that kind instead. A
rect's authored corner radius is built as a shape rather than dropped —
`rectGeometry` is pure, so it is tested headless.

### Verified by execution

| What | Result |
|---|---|
| `cargo test -p gx-contracts` | **39 passed, 0 failed** (13 scene tests) |
| `cargo test --workspace` | **199 passed, 0 failed** |
| `cargo clippy -p gx-contracts -p gx-contract-codegen --all-targets` | clean |
| `npx tsc --build` | clean — the catalogue literal assigns to the generated types with no cast |
| `node --test` (TS) | **15 passed** incl. the generated-union kind check |
| `npx vitest run` (Editor) | **6 passed** incl. rect geometry with and without a radius |
| `npm run check` | **exit 0** — codegen 111 files, conformance **99 passed, 0 failed, 9 skipped** |

### Status after this entry

| Unit | Status |
|---|---|
| `Shared/contracts/src/scene.rs` | **Implemented** for 1.1, 1.2 and 1.7 — 13 kinds, the authored property surface, the resolver, 13 tests |
| `resolve_hierarchy` | **Implemented** — composition, order independence, four named diagnostics, serialisable result |
| 1.2 | **done** |
| `Editor/src/viewport.ts` | **Partial** — draws rect, ellipse and image placeholders; every other kind returns null by name |
| 1.3, 1.4, 1.8, 1.11, 1.12 | **open** — materials and fit/blend enums, colour types, `.gpxpkg`, mocks' scene surface, conformance |

### Not done, and not claimed

- Nothing renders a catalogue object. The engine has no scene parse (3.4), no
  rasteriser (3.5), no shaper (3.6) and no mesh path (3.7); the viewport draws
  three of the thirteen kinds as flat quads.
- No gradient, no fit mode, no blend mode, no cull mode — 1.3 and 1.4.
- No keyframes. Every animated property in this catalogue carries its static
  authored value only.
- The resolver composes 2D affines. There is no 3D transform hierarchy: mesh
  X/Y rotation is reported as a scalar sum, which is what 1.x did and is not
  the same as composing a 3×3 rotation.
- `.gpxpkg` (1.8) does not exist, the mocks do not serve scenes (1.11) and no
  conformance check exercises a scene (1.12).

---

## 2026-09-11 — the 1.x working tree removed from disk

Requested by the user: remove the 1.x artefacts and files, leave the current
2.0 work alone. No tracked file changed — the whole of 1.x survived on this
branch only as untracked leftovers, because GrapiX-2.0 is an orphan branch and
switching to it never cleaned the working directory.

**What was verified before deleting.** Every 1.x source file on disk was
hashed with `git hash-object` and matched against
`Basic-v0.4-2026-09-06-project-container-material-library` (also on origin).
All of it is committed there. The only 21 files that did not match are
generated or binary: Tauri `gen/schemas`, the bundled sidecar `.exe`s, an
esbuild bundle, and AE certification reference `.tif` frames. Nothing unique
to the working tree was lost.

**Removed.** The 1.x product trees (`Editor/apps`, `Editor/services`,
`Playout/apps`, `Playout/services`, `ae-plugin`, `services/render-daemon`,
`tools/certification`, `tools/figma-motion-bridge`, `tools/kindtest`); the
seventeen 1.x `Shared/*` packages, which by then held nothing but stale
compiled `dist/` — the sources were already gone; 1.x build output
(`services/render-engine/target` at 25.8 GB, `services/render-daemon` at
21.1 GB, the two Tauri targets at 13.5 GB); scratch and cache dirs
(`.tmp-fixture-backup`, `.tmp-p4-data`, `.tmp-preflight`, `cache`, `tmp`,
`output`, `artifacts`); the 1.x runtime data root `data/` (18 scenes, 256
assets, 127 backups, `users.json`) and `Editor/data`, `Playout/data`; the
Adobe AE SDK material (`SDK docs/`, `vendor/adobe`); and 37 empty 1.x package
husks left inside `node_modules`, plus the `grapix-editor-mcp` bin shims.

Deleting `data/` and the Adobe SDK was the user's explicit call, put to them
first because neither exists in git and neither is recoverable.

**Kept.** Everything tracked at HEAD, the 2.0 `target/` and `node_modules/`,
and the 2.0 build output `Editor/dist`, `Playout/dist`,
`Shared/generated-ts/dist`, `services/schema-mcp/dist` and the `.tsbuildinfo`
files. 60.70 GB and 58,245 files freed; the repository is 71.83 GB → 11.13 GB.

**Verified by execution.** `git status` is clean against HEAD `8a03d49` — no
tracked file was deleted, and the only untracked path left is `.codex/`, which
is agent config, not 1.x. `npm run check` passes end to end: boundaries,
codegen check, typecheck, TS tests, `cargo test --workspace`, and conformance
at 99 passed / 0 failed / 9 skipped.

**A trap this surfaced.** The main checkout moved from `b5d7a3d` to `8a03d49`
mid-task — another session committed 1.1/1.7 while this cleanup ran. The
worktree this ran from is still at `b5d7a3d`. Re-read `git rev-parse HEAD` in
the main checkout before trusting a file list taken from a worktree.

---

## 2026-09-11 — fonts ported, platform primitives, DeckLink probe, P.2 positions

Scoped by the user: DeckLink Duo 2 is installed; defer Adobe/AE; do FFmpeg,
video codecs and font embedding now; port the 1.x font manager; start Phase 2.

**P.2 licensing positions** (`docs/p2-licensing-positions.md`). Written
positions for the four codec items and the font-embedding gate, owned by the
user: FFmpeg LGPL-only dynamically linked; H.264/HEVC via hardware/OS
encoders, no x264/x265 shipped; ProRes decode-only until Apple licensing
exists; fonts — `package`/`reference`/`restricted` embedding policy,
Adobe Fonts never packaged, packaged fonts must carry a licence. P.2 stays
`active`: the Adobe position is still open.

**Font subsystem ported (2.8 → active).** The 1.x font manager, carried
forward per ADR-0002 A.4 as *port, don't redesign*, rebuilt in Rust per
invariant 22. Contracts (`Shared/contracts/src/font.rs`): `FontSource`,
`FontDefinition`, `EmbeddingPolicy`, `FontLoadStatus`, the trusted-host
allowlist and URL hygiene. Behaviour in `gx-asset-plane::fonts`: metadata
inspection (ttf-parser replacing fontkit), inert CSS `@font-face`/`@import`
parsing, the manager's content-derived identity (same bytes → same
`font_id`), `buildFontCss` and the family stack, and validation — which now
returns named `Refusal`s rather than 1.x's prose strings, and enforces the
new licence rule: a `package` font with no licence is `FontEmbeddingRefused`.
The network resolver is Editor-service work; shaping (cosmic-text) is 3.6.
28 asset-plane tests pass.

**Platform primitives.** `Shared/contracts/src/platform.rs`: `sanitize_filename`
(2.2 — reserved names, illegal chars, trailing dots, NFC, 128-char bound,
idempotent) against a hostile corpus drawn from ADR-0002 B.3's recorded
failures; and `service_data_root`/`cache_root`/`log_root` via the
`directories` crate (2.4) with a test proving the roots are absolute and
never inside the repository — the 1.x in-repo default is gone.

**DeckLink probe** (`Shared/decklink`). Runtime detection — registry +
`DeckLinkAPI64.dll` on Windows, framework presence on macOS — behind a
crate, reporting `Detected | DriverOnly | NotPresent` as data. Detection is
explicitly not readiness (rule 18); the SDK itself is a separate download,
not vendored. The Windows test asserts the probe finds the installed
runtime — execution evidence for the Duo 2 row of P.1.

**Two real bugs the work surfaced.** (1) `Refusal::UnknownTake.take_id` and
the new `FontSource` variant fields were serialising snake_case on an
otherwise-camelCase surface: `rename_all` renames variants, not their fields.
Fixed with `rename_all_fields`, verified on the wire (`takeId`, `assetId`).
(2) Three conformance failures against the real engine were a stale spawned
worker binary, not a contract break — rule 19 records the trap.

### Verified by execution

| What | Result |
|---|---|
| `cargo test -p gx-asset-plane` | **28 passed, 0 failed** (16 font tests) |
| `cargo test -p gx-contracts` | **26 passed, 0 failed** (font + platform + structured refusal) |
| `cargo test -p gx-decklink` | **3 passed** incl. runtime-found on this machine |
| DeckLink take over a socket | `{"refusal":"unknownTake","takeId":"nosuch"}` — correct camelCase wire shape |
| `npm run check` | **exit 0** — codegen 61 files, conformance **99 passed, 0 failed, 9 skipped** |

### Status after this entry

| Unit | Status |
|---|---|
| `Shared/contracts/src/font.rs` | **Implemented** — types, allowlist, hygiene, tested, TS generated |
| `gx-asset-plane::fonts` | **Partial** — validate/metadata/css/manager/cssgen tested; no network resolver |
| `Shared/contracts/src/platform.rs` | **Implemented** on Windows — sanitiser + OS roots; macOS leg is CI |
| `Shared/decklink` | **Partial** — runtime probe only; no SDK, no frames moved |
| P.1 | **Active** — DeckLink runtime verified; AJA, NDI, lab outstanding |
| P.2 | **Active** — codec/font positions written; Adobe open |

### Not done, and not claimed

- The remote-font *resolver* (HTTPS fetch, SSRF guard, depth-limited imports)
  is not ported — it is Editor-service work, and nothing here downloads.
- No cosmic-text shaping (3.6), no Font Manager UI, no `.gpxpkg` yet.
- DeckLink moves no frames; readiness is Phase 15 and needs the SDK.
- Phase 1's scene schema (1.1–1.4, 1.7, 1.8, 1.11, 1.12) is untouched — the
  design comes next.

---

## 2026-09-11 — scene document schema and asset addressing (1.1, 1.7)

The Phase 1 bottleneck, scoped with the user to a **lean core** rather than
the full 1.x union: the document shell is complete and the object union
carries the five kinds the design system and lower-thirds use (text, rect,
ellipse, image, group). Meshes, lights and cameras are deferred to 1.2's
catalogue step — adding a kind is an additive change to a closed enum, so the
core is not a straitjacket.

**1.1 — `Shared/contracts/src/scene.rs`.** `SceneDocument` (id, name, version,
revision, canvas, timeline, data context, assets, fonts, objects), the
five-object `SceneObject` union (a closed tagged enum, so an unknown kind is
a parse error, never a skipped object — invariant 18), and the supporting
types. The done-when is proven three ways, because "round-trips through both
languages" has two sides and a runtime:

- a Rust test pins the exact wire JSON (camelCase, `type`-tagged);
- a compile-time TS test (`scene-roundtrip.types.ts`, compiled by the gate's
  typecheck) assigns that wire shape to the generated `SceneDocument` — a
  renamed field or missed optional stops the build;
- a runtime TS test (`scene-roundtrip.test.mjs`) round-trips the JSON
  losslessly.

The gate's `test:ts` glob did not reach `Shared/generated-ts/tests`, so the
runtime test was passing silently un-run; the glob now covers it (14 TS
tests, was 12).

**1.7 — asset addressing.** `AssetKind`, `AssetAvailability` and
`AssetLibraryItem` carry both addresses (content hash + project-relative
path), and `SceneDocument::replace_asset_bytes` is the replace-in-place
operation: it moves the hash, leaves the path and the asset id, and the image
object binding the id resolves to the new bytes with no edit (invariant 31).
Proven by a Rust test and its TS mirror; an unknown asset id is reported, not
silently ignored.

### Verified by execution

| What | Result |
|---|---|
| `cargo test -p gx-contracts` (scene) | **3 passed** — round-trip, replace-in-place, unknown-kind refused |
| `npx tsc --build` (with types test) | **clean** — the `@ts-expect-error` on an unknown kind holds, proving the union is closed |
| `node --test` scene round-trip | **2 passed** |
| `npm run check` | **exit 0** — codegen 74 files, 14 TS tests, conformance 99/0/9 |

### Status after this entry

| Unit | Status |
|---|---|
| `Shared/contracts/src/scene.rs` | **Implemented** — lean core, round-trips, 3 tests |
| 1.1, 1.7 | **done** |
| 1.2, 1.3, 1.4, 1.8, 1.11, 1.12 | **open** — object catalogue, materials, colour, .gpxpkg, mocks' scene surface, conformance |

### Not done, and not claimed

- The object union is five kinds. Meshes, lights, cameras, layers, line,
  shape, paint and the hierarchy resolver are 1.2 and not present.
- No `.gpxpkg` format or manifest (1.8).
- The mocks do not yet serve scenes (1.11); conformance does not exercise a
  scene (1.12).

---

## 2026-09-11 — Three.js viewport foundation (11.6, ahead of the shell)

The user directed Three.js for canvas, objects and rendering, per ADR-0002
A.1 (Three.js 0.185, sole browser renderer, WebGL2) and ADR-0001's record
("keep, sole browser renderer; PixiJS removed"). Phase 11's full viewport
(11.6) needs the Tauri shell (11.1) and Phase 9 research, so this is the
**foundation**, not the viewport: the policy and camera that the handoff
makes load-bearing, plus the thin GL construction that needs a context.

**Colour policy (`Editor/src/color-policy.ts`, B.1).** The constants the
browser layer must honour, stated once: linear working space, exactly two
output transforms (sRGB preview, Rec.709 broadcast), and no "unknown" source
space — an untagged texture is a defect, per B.1's "never infer."

**Camera (`Editor/src/camera.ts`, B.2, 11.6).** The scene document is in
scene coordinates; DPI affects display only. `makeOrthographicSceneCamera`
fits the frustum to the scene extent 1:1 (one scene unit = one canvas pixel
at zoom 1); `backingStoreSize` scales the renderer's backing store with
`devicePixelRatio` while the document never changes; `scenePosition` converts
the top-left authoring origin to the camera's centred Y-up space — the single
conversion between the two.

**Viewport (`Editor/src/viewport.ts`).** The thin GL wiring: a WebGL2
renderer with the sRGB preview transform applied, the ortho camera, one mesh
per scene object in scene coordinates. Text renders through the shaped-text
path (cosmic-text on the engine), not a quad, so it returns null here — the
2D-beside-3D case (11.6's done-when) covers it. Groups paint nothing. This
layer is a viewport convenience, not the production pixel path (invariant 2),
and is structured so the engine can take over the raster (13.5).

**Tested headless** — the policy and camera need no GL context, so vitest
covers them (4 tests: preview is sRGB, frustum maps 1:1, backing store scales
with DPI, scene-position conversion). The render loop needs a context and is
typechecked, not run — no headless-GL claim is made. vitest is now wired into
the gate's `test:ts`.

three@0.185 pinned to match the handoff exactly.

### Verified by execution

| What | Result |
|---|---|
| `npx vitest run` (Editor) | **4 passed** — colour policy + camera mapping |
| `npx tsc --build` | clean — viewport.ts typechecked against three@0.185 and the generated scene types |
| `npm run check` | **exit 0** — codegen 74 files, 14 node tests + 4 vitest, conformance 99/0/9 |

### Status after this entry

| Unit | Status |
|---|---|
| `Editor/src/color-policy.ts`, `camera.ts` | **Implemented** — policy + camera, tested headless |
| `Editor/src/viewport.ts` | **Partial** — GL construction typechecked; render loop needs a context, not run |
| 11.6 | **active** — foundation only; the 2D-beside-3D done-when needs the shell |

### Not done, and not claimed

- No render loop run: no GL context exists outside the Tauri shell (11.1).
- No hit-testing, overlays (11.7), or frame scheduling.
- Text and image textures are placeholders; the shaped-text and asset-texture
  paths are separate.
- 2D-beside-3D (11.6's done-when) is not exercised — no 3D objects in the
  lean union yet, and the engine raster path is 13.x.

---

## 2026-09-11 — Phase 0 CI, licence policy, and the revision steps recorded

Assessed every remaining Phase P and Phase 0 step. Phase P is external by
definition (procurement, licensing positions with named owners, participant
recruitment) — nothing executable in-repo, and `active` stands. Phase 0 had
three steps left, two of them partly built and uncommitted from a prior
session.

**0.3 — CI matrix (active).** `.github/workflows/check.yml` was sitting
untracked. It is the right shape: Windows + macOS matrix, the pinned
toolchain (rust-toolchain stable with rustfmt/clippy, Node 22 matching
`engines`), lockfile-keyed cargo cache, fmt+clippy, then the whole gate.
Committed. What cannot be done from here: the done-when is "both platforms
green", and no CI run has ever executed — the workflow's first run happens
on push. The Windows leg's equivalence is locally verified (`npm run check`
exit 0 on Windows), the macOS leg is not observable from a Windows
workstation. Recorded `active`, and rule 17 names this class of trap.

**0.4 — dependency policy and SBOM (active).** `docs/dependency-policy.md`
was also untracked: accepted licences (MIT/Apache-2.0/BSD/ISC/Zlib/Unicode),
written-position-required for LGPL/GPL/patent codecs/font embedding
(cross-referenced to P.2), prohibited classes, review cadence. The workflow
generates both SBOMs and uploads them per-OS. Verified locally, since the
tools exist here: `cargo sbom` produces SPDX 2.3 with 156 packages;
`cyclonedx-npm` produces CycloneDX 1.6 with 5 components. Not `done`: the
criterion is "SBOM artifact on every build", and "every build" means the CI
artifact, which needs a CI run.

**0.8 — revision semantics (done).** Was implemented two sessions ago
(`Revision::check_write` returning `RevisionConflict { expected, current }`)
but never recorded. Re-verified by execution rather than trusted: the three
tests pass — stale write returns the current revision, matching write
advances, and the loser recovers and wins the retry. That is exactly the
done-when, so it is recorded `done` now.

### Verified by execution

| What | Result |
|---|---|
| `cargo sbom` | SPDX 2.3, **156 packages** |
| `npx @cyclonedx/cyclonedx-npm` | CycloneDX 1.6, **5 components** |
| `cargo test -p gx-contracts` (revision + recovery) | **3 passed, 0 failed** |
| `npm run check` | **exit 0** after tracker edits — all six stages green |

### Still open in Phase 0

- **0.3, 0.4** — `active`, waiting on the first CI run (push the branch).
- Phase P — all three tracks external; owners and dates are the user's.

---

## 2026-09-11 — structured refusal envelope reaches TypeScript (0.5, 0.6)

Two phase-0 foundations that were left uncommitted and unlogged at the end of
the previous session, finished and verified.

**Structured refusal (0.6).** `StructuredRefusal` and `RefusalSeverity` in
`Shared/contracts/src/lib.rs`: `code` (the `Refusal`), `field`, `given`,
`allowed`, `severity` — the exact shape ADR-0002 G.4/E.19 requires, which
settles `supported` vs `allowed` in favour of `allowed` and the `Severity`
name collision in favour of `RefusalSeverity`. This session's work was the
TypeScript half of the done-when: the types were missing from the codegen
export list, so "serialises identically in Rust and TS" had no TS side. Both
are now exported; `Shared/generated-ts` regenerated (54 files).

**The wire-shape trap, fixed properly.** ts-rs ignores serde's
`skip_serializing_if` (warns and carries on), so the first export produced
`field: string | null` — a required key — while serde omits the key. The Rust
field was `String`/sentinel-empty, so the two sides disagreed about the wire.
The fields are now honest `Option<String>` / `Option<Vec<Value>>` with both
`skip_serializing_if = "Option::is_none"` and `#[ts(optional)]`, giving
`field?: string` / `allowed?: Array<JsonValue>`: absent is absent on both
sides. Recorded as rule 16, because the next `skip_serializing_if` on an
exported type will hit the same trap.

**One guard widened, found by adding a type.** Exporting pulled ts-rs's
`serde_json::Value` shadow into a new `serde_json/` subdirectory — which the
staleness gate never read: its snapshot was flat-only, so a drifted
`JsonValue.ts` would have passed. `tools/codegen-check.mjs` now recurses; the
count went 51 → 54 files. The boundary guard already recursed and requires
the generated header, which `JsonValue.ts` carries, so no change needed there.

**Telemetry (0.5).** `Shared/telemetry` (`gx-telemetry`): one `init`
installing a tracing subscriber (idempotent, `RUST_LOG`-honouring), typed
`frame_span(frame, committed)` and `take_span(take_id)` constructors so the
span vocabulary is defined once and a rename breaks loudly, and the
done-when test proving a span reaches a collector — in-process, via a
captured-writer subscriber. OTLP export is deliberately absent and the crate
doc says so: wiring an exporter with nothing to observe yet would be
scaffolding dressed as a feature; it lands with the observability series
before the first soak run.

### Verified by execution

| What | Result |
|---|---|
| `cargo test -p gx-contracts -p gx-telemetry` | **18 passed, 0 failed** (17 contracts incl. the pinned refusal JSON round-trip; 1 span-reaches-collector) |
| `cargo run -p gx-contract-codegen` | 50 root types, 54 files incl. `serde_json/JsonValue.ts` |
| `npm run check` | **exit 0** — boundaries, codegen-staleness (54 files), typecheck, TS tests (12), Rust tests (workspace incl. 24 worker), conformance **99 passed, 0 failed, 9 skipped** (same nine named skips as the previous entry) |

### Status after this entry

| Unit | Status |
|---|---|
| `Shared/contracts` `StructuredRefusal` | **Implemented** — envelope + severity, tested, TS generated, in codegen list |
| `Shared/telemetry` | **Partial** — skeleton: init, typed spans, collector test; no OTLP exporter |
| `tools/codegen-check` | **Implemented** — now covers nested generated output |

### Not done, and not claimed

- The refusal envelope has **no consumers yet**: engine and MCP refusals still
  return the bare `Refusal`, not the envelope. Wiring it through the engine,
  the validator and preflight is later-phase work (E.12/E.19 territory).
- OTLP export, as above — the skeleton proves the pipeline, not a collector
  over a network.
- The `Out`-verb question from ADR-0002 is still open; the token schema work
  (rule 15) is untouched by this entry.

---

## 2026-09-10 — render engine, host supervisor, and the design-system schema

The first running product code on the branch: a real render worker, its host
supervisor, and the Part G token/motion schema in contracts. Verified end to
end against the full gate.

**Render worker (`services/render-engine/worker`).** Was a stub returning
`NotImplemented`; now it is a live `EnginePeer` over the control transport.
- `gpu.rs` negotiates the device with wgpu 26 and maps it to a contract
  `DeviceTier` (DiscreteGpu/IntegratedGpu→T0, Cpu→T2, else T3) — the single
  place a tier is decided (invariant 20). On this machine it reports T0.
- `engine.rs` implements `EnginePeer`: capability, status, cue, take, clear,
  output config, sharing `resolve_intent` with the mock (invariant 27). The
  clock is a `ProgramClock` driven by an external frame pump over an
  `Arc<AtomicU64>` — time passes whether or not a request arrives, and no
  client message can set it (ADR-002). It does not implement `FaultInjection`,
  which is why the fault suite skips against it.
- `rasterizer.rs` produces a real Program frame on the software path (T2):
  black with no take, a deterministic take key on a take, back to black on a
  clear. The base frame is built once per take, not per frame (invariant 35).
  There is still no scene-content renderer — the control plane has no scene
  contract — so Program is a take key, not drawn scene content. That is stated
  in the crate doc, not hidden.
- `main.rs` is the binary: `--port/--lan/--rate/--publish/--token`. Found and
  fixed a real bug here: `main` parsed `--port` but the host spawned it without
  one, so the child bound the default 4400 while the host waited on the
  requested port. `ensure` now injects `--port` itself.

**Host (`services/render-engine/host`).** Was a stub exiting 78. Now
`ensure()` adopts a live engine or spawns one, never stops one — no `Drop`
kills the child, and the never-stop property is proven by provenance in the
integration test (a re-ensure after the supervisor drops must find Adopted,
not Spawned). `RestartPolicy` is bounded backoff with a hard attempt cap. The
WAL journal and output-inhibited restore named in the crate README are still
Planned and say so.

**One platform bug fixed in the shared bind.** On Windows, std's
`TcpListener::bind` does not set SO_REUSEADDR, so a port lingering in
TIME_WAIT after `free_port()`/a probe failed the engine's bind with
WSAEADDRINUSE even when free. `bind_listener` in `gx_control_plane::bind` is
now the single place a control-plane socket opens (shared by mock and engine),
with a short retry across the TIME_WAIT window; a genuinely occupied port
still fails by name.

**Design-system schema (`Shared/contracts/design_system.rs`).** The Part G
"one thing to build first": `MotionTokens`, `MotionPreset`, `MotionPhases`,
`Stagger`, `TokenRef`, and `ms_to_frames` — the single ms→whole-frames
conversion against a rational rate (G.6.2). `MotionPreset::validate` refuses a
missing `out` phase by name (G.6.6). Time is normalised, frames resolved at
instantiation, never stored. 8 tests.

**codegen + schema-mcp.** The 11 design-system types are in the codegen export
list; `Shared/generated-ts` regenerated (51 files, gate green).
`services/schema-mcp` is no longer a stub: `getCapabilitySurface()` returns the
supported enums and refusal codes as data (Part D principle 2, capability
discovery), with compile-time assertions that the hand-maintained lists match
the generated unions, so drift fails typecheck. 5 tests.

### Verified by execution

| What | Result |
|---|---|
| `cargo test --workspace` | **140 passed, 0 failed** (incl. 24 worker, 11 contracts) |
| host integration tests (`tests/ensure.rs`) | **3 passed** — adopt, spawn, reserved-port; spawn test takes ~25s and uses a real worker process |
| `cargo run -p gx-conformance` | **99 passed, 0 failed, 9 skipped**, exit 0 — now includes the **real render engine** as a peer (CoLocated, T0, FreeRun) over a socket |
| `node --test` (Playout + schema-mcp) | **12 passed, 0 failed** (`test:ts` glob widened to reach `services/*/tests`) |
| `npm run check` | **exit 0** — boundaries, codegen-staleness (51 files), typecheck, TS tests, rust tests, conformance |

The nine skips, each named: sub-T0 live refusal on T0 peers (mock ×2, transport
×2, real engine ×1), LAN encode-adapt on a co-located peer, reference-loss on
peers that cannot be driven into it (mock ×2), asset-over-wire (no endpoint),
and hardware reference lock (external gate).

### Status after this entry

| Unit | Status |
|---|---|
| `services/render-engine/worker` | **Partial** — live `EnginePeer`, software rasteriser, engine-owned clock; no GPU scene renderer, no tiling, no scene contract |
| `services/render-engine/host` | **Partial** — ensure/adopt/never-stop + bounded restart, tested; no WAL journal, no output-inhibited restore |
| `Shared/contracts/design_system` | **Implemented** — token + motion-preset schema, tested, TS generated |
| `services/schema-mcp` | **Partial** — capability discovery read surface, tested; no JSON-RPC transport, no mutating D.2 groups |
| `conformance` | **Implemented** — 99 checks, real engine now a peer |

### Not done, and not claimed

- No scene-content renderer. Program is a deterministic take key, not drawn
  scene content; the control plane has no scene contract. M2/M3 work.
- No GPU-accelerated rasterisation or tiling. The wgpu device is negotiated
  for tier only; frames come from the software path.
- No WAL/journal/restore in the host.
- schema-mcp is read-only capability discovery, not the full D.2 tool surface
  (no scenes/objects/materials writes, no `render.preview`, no scope-gated
  author/operator/admin tokens).
- The design-system schema has no consumers yet: no Editor panel, no
  preflight enforcement (three severities), no version stamp on packages, no
  `designsystem.*`/`motion.*` MCP tools. Those are M2/M3-sequenced.
- The genlock/PTP clock slave is modelled, not hardware-backed (external gate).

---

## 2026-09-10 — ADR-0002 accepted as the final drafted handoff

`docs/adr/0002-platform-and-mcp-schema.md` is now the authoritative handoff:
platform matrix, colour management, DPI, filename handling, resolution and rate
policy, the MCP tool surface and scopes, the UI research plan (Part F), and the
design-system and motion-library handoff (Part G, which absorbs and supersedes
the standalone 9 September copy). Second in the authority order, after 0001.

**Part E is the definition of done for the platform layer.** Verified against
the branch at `becb09d`, item by item. It is the checklist any claim of
completeness is measured against, so it is recorded here in full.

| # | Item | Status |
|---|---|---|
| 1 | Editor builds, signs, notarises on both; CI installers | **Not present** — no Tauri shell, no CI |
| 2 | WebGPU capability probe on both, recorded | **Not present** |
| 3 | Colour-managed pipeline, colour ramp in reference set | **Not present** |
| 4 | Pixel gate identical on both platforms | **Not present** |
| 5 | DPI correct at 100/125/150/200, survives monitor move | **Not present** |
| 6 | Filename sanitiser with hostile corpus | **Partial, and narrower than it looks** — `is_syntactically_safe` rejects traversal, absolute and drive-letter paths. Zero handling of reserved names (CON/AUX/NUL/LPT), trailing dots, Unicode NFC, or >260-char paths |
| 7 | One atomic-write helper, both races closed | **Not present** — the rule is written in `transfer.rs` docs; no implementation |
| 8 | Service data root uses OS conventions | **Not present** — no `directories` crate, no data root at all |
| 9 | 1080p/720p at all eight rates; interlaced refused by name | **Partial** — six of eight rates exist as constants; **24/1 and 24000/1001 are missing**. No resolution type, no interlaced refusal |
| 10 | Virtual, recording, null adapters on both | **Not present** — `OutputConfig.adapter` is a bare `String` |
| 11 | DeckLink and NDI behind feature flags | **Not present** |
| 12 | MCP: capability, structured refusals, `if_revision`, batch-as-one-undo, `render.preview` | **Partial** — capability discovery is implemented and conformance-checked; refusals are structured but carry no `supported`/`allowed`; **no `if_revision`, no batches, no idempotency keys, no `render.preview`** |
| 13 | Scopes enforced: `author` refused on `playout.take` | **Not present** — one shared bearer token, no scopes. This is the gap in the credential work of the previous entry |
| 14 | Font Manager ported unchanged | **Not present** — 2.0 is an orphan; nothing was ported |
| 15 | Missing font refused at preflight | **Not present** — no preflight |
| 16 | UI built against Part F constraints | **Not present** — Part F research not run |
| 17 | Design reviewed against the anti-pattern list | Not applicable yet |
| 18 | Token schema in contracts before any consumer | **Not present.** The document names this as the one thing to build first |
| 19 | Design-system violations refused with `allowed` values | **Not present** |
| 20 | Every package stamped with design-system version | **Not present** — no package or publish concept |
| 21 | Presets resolve identically at 25/50/59.94/23.976 | **Not present** — and 23.976 is not even a declared rate |
| 22 | A preset with no `out` phase is refused | **Not present** |

Nothing in Part E is complete. Items 12 and 6 are the only ones with anything
behind them, and both are narrower than the item requires.

### Three inconsistencies inside the document, to settle before building

1. **`supported` vs `allowed`.** D.1's refusal shape uses `supported`; G.4's
   and E.19's use `allowed`. Same concept, two names. Pick one before the
   refusal shape is widened, because every consumer parses it.
2. **Is `Out` a verb?** G.6.3 names five operator verbs — Cue, Take, Continue,
   Out, Clear — and gives `out` a required preset phase. D.2's `playout` row
   lists four: cue, take, continue, clear. Either `Out` is a distinct verb or
   it is Clear with a transition, and the preset schema depends on which.
3. **Refusal code casing.** D.1 shows `UNSUPPORTED_BLEND_MODE`; the
   implemented surface is camelCase (`unsupportedBlendMode`). Cosmetic, but it
   is a wire format and worth settling once.

### Two collisions the token schema will hit

`Token` is taken (the auth credential, `export type Token = string`) and
`Severity` is taken (clock health: `Nominal | Warning | Critical`, against the
document's `error | warning | info`). Both need renaming or namespacing before
Part G's schema lands.

### Also noted

`Refusal.unknownTake.take_id` is the one snake_case field on an otherwise
camelCase contract surface: `#[serde(rename_all = "camelCase")]` on an enum
renames variants, not variant fields. Needs `rename_all_fields`. Only visible
on `take_id` because every other variant field is a single word.

**Environment change:** the `figma-import-motion-config-f13e17` worktree is no
longer registered, and `GrapiX-2.0` is now checked out in the main repository
at `D:\Project KK\Personal projects\GrapiX`. Work there.

## 2026-09-10 — credential enforcement and reconnect reconciliation

Closed a hole the previous entry opened, then implemented ADR B.4's first row.

**The hole.** `check_bind` said a token makes a non-loopback address
acceptable, and nothing verified a token on a connection. That is worse than
not having the policy: it reads as a security control while being none. A
network-bound engine would have accepted anybody.

**`Shared/control-plane/src/auth.rs`.** `Token` compares in constant time over
its full length — `==` returns at the first differing byte, which leaks the
matching prefix length to anyone who can time it — and redacts itself in
`Debug`, because every message type derives `Debug` and connection errors are
printed. A token that prints itself reaches a log on the first bad connection.
`Token::new` refuses anything under 32 bytes, which is the case an unset
environment variable produces.

**Enforcement is in the transport, not the engine.** Authentication is a
property of the connection; an engine that re-checked on every request would
eventually miss one. The engine refuses `Authenticate` outright if it ever
sees one, and the compiler's exhaustiveness check is what forced that decision
to be explicit rather than defaulted. A protected connection is refused every
request until authenticated — capability included, since capability carries
device tier, clock source and reference state, none of which is public. A wrong
token gets a named refusal and the connection stays open: a mistyped
credential deserves a retry, and an attacker gains nothing from an open socket
that redialling would not also give.

**Reconnect and reconcile (ADR B.4).** `Client::reconnect` redials,
re-authenticates and returns a `Reconciliation` carrying the previous and
current epoch plus what is now on Program. `engine_restarted()` is the
question that matters. The trap it guards: a restarted engine can republish at
the *same revision*, so a client comparing revisions alone would see no change
and carry on with state that no longer exists. A fresh connection starts
unauthenticated, so a reconnect re-authenticates — which is what makes a
rotated token actually stop working, and there is a test that proves it.

`MockEngine::restart()` models a new incarnation that lost its state, so the
epoch path is reachable in a test rather than argued about.

### One defect the tests found

A `Refused(Unauthenticated)` arriving during the capability exchange came back
to the caller as `InvalidData` with the text "expected a capability reply",
because the client treated every non-capability reply as malformed. "Needs a
credential" and "this peer is broken" are different problems and a caller can
only act differently on them if the error kind says which. There is now one
`kind_for` mapping used by both the authentication step and the capability
exchange, so they cannot classify the same refusal differently — which they
did until the test caught it.

### Verified by execution

| What | Result |
|---|---|
| `cargo test --workspace` | **125 passed, 0 failed** |
| — of which auth/reconnect integration | 10 passed, over real sockets |
| `cargo clippy --workspace --all-targets` | Clean, 0 warnings |
| `cargo run -p gx-conformance` | **88 passed, 0 failed, 8 skipped**, exit 0 |
| — peers exercised | 6, including two over a socket, one requiring a token |
| `node --test` | 7 passed |
| codegen | 37 types; `Token`, `Authenticate`, `Unauthenticated` reached TypeScript |
| `gx-mock-engine --token short` | Refused before binding, exit 1 |
| `gx-mock-engine --token <32 bytes>` | Bound, protected, listening |
| `npm run check` | **exit 0** |

### Still not done, and not claimed

- **A shared token is not mTLS.** ADR-001 specifies mTLS for L1 and this is a
  bearer secret on an unencrypted loopback socket. It is the enforcement half
  of the bind policy, not the L1 credential.
- Nothing is encrypted. At L0 that is defensible; at L1 it would not be.
- No token rotation, no expiry, no per-client identity. One secret, shared.
- Reconnect is client-initiated and manual: nothing reconnects automatically,
  and there is no backoff.
- The asset and media planes still have no transport.
- No renderer, no shell. Nothing has rendered a frame.

## 2026-09-10 — the L0 control transport

The planes had semantics but no transport: everything ran in-process, so
"transport-independent contracts" was an assertion. It is now a thing that runs.

**`Shared/control-plane` gained two pure modules.** `framing`: a four-byte
big-endian length then that many bytes of JSON, with the length validated
against a 1 MiB cap *before* any body is allocated — a peer cannot make the
reader reserve memory by lying (invariant 51). `bind`: the policy deciding
where the engine may listen. `0.0.0.0` and `::` are explicitly not loopback,
which is the case that would otherwise turn invariant 41 into decoration.

**`Shared/control-transport` is new** — both halves of the wire in one crate.
ADR-001 places protocol clients in `Shared`, and the server is the same format
read the other way; two copies of framing and dispatch would be the parallel
implementation invariant 27 forbids. The server is generic over `EnginePeer`
and has never heard of a scene. Three behaviours come straight from the plane's
guarantees: a sequence gap closes the connection (there is no correct way to
continue past a lost message), a duplicate is acknowledged but not re-executed
(a repeated take would reach air twice), and replies carry a `reply.` id while
events do not — which is how the client separates them off one stream, making
invariant 34 load-bearing rather than decorative.

**The conformance suite now runs over a socket.** Because the suite is written
against `EnginePeer` and `Client` implements it, pointing it at a live server
took no change to any check. Twelve control-plane checks now pass across a real
transport. That is ADR-001's L0/L1 exit criterion in miniature.

**The mock engine is runnable.** `cargo run -p gx-mock-engine -- --genlocked
--publish lower-third:4` serves on `127.0.0.1:4400`, with flags for locality,
tier and reference so a client developer can reach every refusal path. Verified
listening, and verified refusing port 4200 with the burned-port reason.

### One real defect, found by its symptom

The first `serve()` printed and continued on *every* accept error. On Windows,
Winsock deinitialises when `main` returns, so the detached listener thread hit
a permanent error and spun, flooding stderr with the same line. The bug is not
Windows-specific: any persistent accept failure would burn a core forever. Now
transient errors (interrupted, aborted, reset, timed out) are retried and
anything else stops the listener (invariant 50).

### One defect in the report itself

With four peers in one run, results were printed with no attribution, so
"SKIP live output refuses below T0" could not be traced to the peer that
skipped it — and I misread the output myself before noticing. `Result_` now
carries the peer, and the report groups by peer then plane.

The codegen guard also did its job unprompted: adding `Refusal::TransportFailed`
made `Refusal.ts` stale and `npm run check` refused to pass until it was
regenerated.

### Verified by execution

| What | Result |
|---|---|
| `cargo test --workspace` | **108 passed, 0 failed** |
| `cargo clippy --workspace --all-targets` | Clean |
| `cargo run -p gx-conformance` | **77 passed, 0 failed, 7 skipped**, exit 0 |
| — of which over a real socket | 11 passed, 1 skipped |
| `node --test` | 7 passed |
| `npx tsc --build` | Clean, 4 projects |
| `gx-mock-engine` serving | Bound and listening on 127.0.0.1:4400 |
| `gx-mock-engine --port 4200` | Refused, exit 1, burned-port reason |
| `npm run check` | **exit 0** |

### Still not done, and not claimed

- **This is loopback TCP, not a named pipe.** ADR-001 specifies a pipe or Unix
  socket at L0. A pipe can carry an OS-level peer identity; loopback TCP
  cannot. Recorded as a gap, not dressed up. What TCP buys is one code path on
  Windows and Unix.
- No reconnect, no reconciliation by revision and epoch. A gap closes the
  connection and nothing dials back.
- **No asset or media transport.** Those planes are still in-process only.
- No token authentication implemented: the bind policy *requires* a token off
  loopback, and nothing yet verifies one on a connection.
- No engine host supervision, no WAL, no renderer, no shell.
- Nothing has rendered a frame.

## 2026-09-10 — ADR-001 and ADR-002 implemented

All six action items across the two ADRs. Every file new; nothing ported from
1.x.

### ADR-001 — four transport planes

**Action 1, plane boundaries in the contracts.** Each plane's failure semantics
are now executable rather than described:

- Control (`Shared/control-plane`, five new modules): `SequenceTracker`
  classifies arriving messages as Accepted / Duplicate / Gap, with **sequence
  handling ordered before deduplication** — the check order *is* the rule, and
  a test proves the retransmission that fills a gap is processed rather than
  discarded. `MessageId::is_reply()` matches the `reply.` prefix, so a reply
  kind nobody enumerated is still recognised.
- Asset (`transfer.rs`): resume-by-chunk, out-of-order chunks refused rather
  than buffered, and **completion separated from verification** — a complete
  transfer is not promotable until `verify` succeeds, and a hash mismatch
  poisons it permanently.
- Media (`slot.rs`): `LatestFrameSlot` holds exactly one frame. `publish`
  returns unit and cannot fail, so a producer has no error path to block on —
  invariant 14 holds by construction, not by review.
- Timing: represented by its *absence*. There is no timing crate, and the
  conformance suite serialises every control request to assert none carries a
  timestamp.

**Action 2, locality in the capability exchange.** `EngineCapability` declares
locality, device tier, clock source, reference state, epoch and the derived
`live_allowed`.

**Action 3, one conformance test per plane.** `conformance` is now a library of
suites generic over `EnginePeer`, plus a runner. It reports PASS / FAIL /
**SKIP**, and a skip is never counted as coverage.

### ADR-002 — clock authority on the render node

**Action 1, intent form.** `TakeAt` is `NextOpportunity | Frame(n)` with no
`Now` variant, and cue and clear take the same form. `resolve_intent` is the
single implementation of the resolution rule, shared by the engine clock and
every mock (invariant 46). A frame that has passed or falls inside the lead is
refused as `FrameNotReachable { requested, earliest }` rather than fired late.

**Action 2, reference lock in status.** `EngineStatus` carries clock, reference,
tier and a `Degradation` list. `ReferenceMonitor` implements the ADR's revisit
note: losing lock **holds the cadence** in use at that moment, reports
`ReferenceLost { was }`, and refuses new live configuration. Regaining lock
clears the hold.

**Action 3, free-run surfaced.** `clock_summary` decides severity and wording
once on the engine side. `Playout/src/clock-display.ts` maps severity to a
required *prominence*: Nominal may be quiet, Warning is persistent, Critical
blocks. Free-run is a Warning, so it can never be rendered quietly.

`ProgramClock` (`services/render-engine/worker/src/clock.rs`) is the first real
code in the worker. `offset_nanos(n)` is a pure function of the frame number in
`u128`, so deadlines cannot compound error.

### One wrong claim, corrected by a failing test

The first version of the drift test asserted that accumulating the frame
interval in `f64` drifts measurably across an 8-hour soak. It does not: the
test failed, reporting 89 ns. Measured properly, the real costs at 29.97 over
863,136 frames are:

| Approach | Drift over 8 hours |
|---|---|
| Rate stored as rounded `29.97` | 28.8 ms — 0.86 of a frame |
| `f32` accumulation | 117 s — 3,513 frames |
| `f64` accumulation of `1001/30000` | 89 ns — negligible |

So the hazard invariant 12 guards against is **rounding the rate**, not
floating point as such. The module doc and three tests now say that, and the
`f64` case is recorded as the negligible one it is.

### Two design corrections found by the compiler and the suite

- `MediaCodec` moved from `gx-control-plane` to `gx-contracts`. The control
  plane offers the codec set and the media plane negotiates from it, so leaving
  it in either one coupled two planes ADR-001 keeps independent.
- The conformance suite skipped "live output refuses below T0" against both
  mock peers, because both were T0. A check that always skips is not a check
  (invariant 47), so the runner now includes a T2 peer and the check passes on
  it.

### Verified by execution

| What | Result |
|---|---|
| `cargo test --workspace` | **86 passed, 0 failed** |
| `cargo clippy --workspace --all-targets` | Clean, no warnings |
| `cargo fmt --all` | Applied |
| `node --test` (Playout clock display) | **7 passed, 0 failed** |
| `cargo run -p gx-conformance` | **66 passed, 0 failed, 6 skipped**, exit 0 |
| `npx tsc --build` | Clean, 4 projects |
| codegen | 37 contract types, one copy each |
| `npm run check` | **exit 0** |

The six skips, each named in the report: two peers are T0 so the sub-T0 refusal
skips on them; a co-located peer has no encode to adapt; two peers are not
locked so lock-loss skips on them; there is no asset endpoint on the control
peer; and hardware reference lock is an external gate.

### Status after this entry

| Unit | Status |
|---|---|
| `Shared/control-plane` | **Partial** — intent, sequencing, status, capability and the message surface, all tested in-process; no transport |
| `Shared/asset-plane`, `media-plane` | **Partial** — plane semantics tested; no transport, no encoder |
| `mocks/mock-engine` | **Implemented** as a peer — in-process, deterministic, no transport |
| `conformance` | **Implemented** — 66 checks across four planes, 6 named skips |
| `services/render-engine/worker` | **Partial** — `ProgramClock` only; no GPU, no rasterizer |
| `services/render-engine/host` | **Planned** — stub, exits 78 |
| `Playout` | **Partial** — clock-display logic tested; no shell |
| `Editor`, `services/schema-mcp` | **Planned** — type-level only |

### Still not done, and not claimed

- **No transport.** Every plane's semantics are implemented and tested
  in-process; nothing crosses a socket, pipe or wire. ADR-001's four transports
  do not exist.
- No engine host supervision, no WAL, no journal, no restore.
- No renderer. `rasterizer_status()` returns `NotImplemented`.
- No Playout or Editor shell. `clock-display.ts` is tested logic with no UI
  rendering it, so "unmissable" is enforced in the model and not yet on screen.
- No pixel gate, no baseline snapshot.
- Nothing has rendered a frame or reached an output.

## 2026-09-10 — M1 skeleton and basic setup on a clean branch

First commit on `GrapiX-2.0`, an orphan branch with no ancestry to 1.x. The
architecture comes from `docs/adr/0001-distributed-architecture.md`, carried in
as given; the invariants were distilled from the 1.x tree so 2.0 does not
re-earn faults that were already paid for once.

**Structure.** One Cargo workspace, one lockfile, eleven crates (invariant 24).
npm workspaces for the four TypeScript packages. Four contract packages, one
per plane, with no plane depending on another.

**Contracts, written to make invariants unbreakable rather than documented:**

- `RationalRate` has no `f64` constructor. 29.97 is 30000/1001, and a test
  asserts the float form is *not* equal to 29.97 (invariant 12).
- `TakeAt` has no `Now` variant, and a test matches it exhaustively so adding
  one stops the build (invariant 8).
- `Refusal` is a tagged enum where every variant names its failing condition
  (invariant 17). `UnsupportedBlendMode` carries the mode, so the `overlay`
  aliasing to `screen` that 1.x shipped cannot recur silently.
- `live_allowed()` in `gx-control-plane` is the single place ADR-005's three
  conditions are evaluated, so tier, platform and reference-lock cannot drift
  between engine, API and UI (invariant 20).
- `negotiate()` in `gx-media-plane` is the single implementation of ADR-004's
  L0/L1 table, which is what makes M4's relocation a deployment change
  (invariant 16).
- `is_syntactically_safe()` in `gx-asset-plane` rejects traversal, absolute and
  drive-letter paths, and carries a test documenting that it is the *first* of
  two gates — a syntax check cannot see a symlink (invariant 42).

**One design correction during the work.** `MediaCodec` was first declared in
`gx-control-plane`, because the capability exchange offers the set. That forced
`gx-media-plane` to depend on `gx-control-plane` — a plane-to-plane dependency,
which contradicts the independent failure semantics in ADR-001. Moved to
`gx-contracts`, which both planes already depend on.

**One real fault found and fixed.** `#[ts(export)]` on the contract types made
ts-rs export bindings during `cargo test`, into a per-crate `bindings/`
directory. The result was four copies of `MediaCodec.ts` and two of
`ContentHash.ts` — precisely the mirroring drift ADR-003 exists to end, arriving
by a different route. Removed the attribute; `gx-contract-codegen` is now the
only generator (invariant 27), writing one copy of each type plus a barrel
`index.ts`.

**Guards.** `tools/check-boundaries.mjs` fails on a cross-domain dependency and
on a hand-authored file in generated output. `tools/codegen-check.mjs` fails if
the committed generated output differs from a fresh run. Both were
negative-tested: a Shared-imports-Editor line, a hand-written file in
`generated-ts/src`, and a doctored `Locality.ts` were each caught, and the tree
restored clean afterwards.

### Verified by execution

| What | Result |
|---|---|
| `cargo check --workspace --all-targets` | Clean, 11 crates |
| `cargo test --workspace` | **29 passed, 0 failed** |
| `cargo fmt --all` | Applied |
| `cargo run -p gx-contract-codegen` | 21 contract types + barrel into one directory |
| `npm install` | Clean, 4 workspace packages linked |
| `npx tsc --build` | Clean, 4 projects |
| `node tools/check-boundaries.mjs` | OK, and caught 2 injected violations |
| `node tools/codegen-check.mjs` | OK (22 files), and caught 1 injected staleness |

### Status after this entry

| Unit | Status |
|---|---|
| `Shared/contracts`, `control-plane`, `asset-plane`, `media-plane` | **Partial** — the types and decision functions in this entry exist and are tested; no transport, no serialisation over a wire |
| `Shared/generated-ts` | **Implemented** — generated, current, checked |
| `tools/contract-codegen`, both guards | **Implemented** — run, and negative-tested |
| `services/render-engine/host`, `worker` | **Planned** — stub, exits 78 |
| `mocks/*`, `conformance` | **Planned** — stubs, exit 78 |
| `services/schema-mcp` | **Planned** — declares read-only capability, no server |
| `Editor`, `Playout` | **Planned** — type-level entry points only, no Tauri shell |

### Not done, and not claimed

- No mock peer behaves like a peer. They exit 78.
- No conformance suite. The merge gate in invariant 26 has nothing behind it.
- No pixel gate, and no baseline snapshot. M1 requires the baseline be captured
  **before** anything changes, and nothing has been captured.
- The `overlay` blend-mode fix is expressible in the refusal type but is not
  implemented, because there is no renderer.
- No Tauri scaffold in either product.
- Nothing has been rendered, transported, published or taken.
