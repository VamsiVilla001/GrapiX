# GrapiX — Editor Core and AI Readiness: Build Plan Proposal

| | |
| --- | --- |
| Status | Merged 2 Oct 2026 with decisions; the build plan is authoritative. ID map and decisions: `memory.md`, 2026-10-02 entry |
| Date | 2 Oct 2026 |
| Owner | Vamsi |
| Merges into | `GrapiX-Build-Plan.md` (Phase 11 first, later phases after) |
| Source | GrapiX 2.0 generative AI research report, Oct 2026 |

> **This file is not a planning document.** `LLM-GOVERNANCE.md` allows exactly two: `GrapiX-Build-Plan.md` and `progress.html`/`progress.json`. This file is a merge proposal. Nothing in it is authoritative until it has been merged into the build plan. After merging, move it to `docs/proposals/` or delete it.

---

## 0. How to execute this file

Any model (Claude, Codex, Kimi or other) follows these steps in order.

1. **Read first.** Read `LLM-GOVERNANCE.md`, `GrapiX-Build-Plan.md`, `progress.json`, the latest entries in `memory.md`, `docs/invariants.md` and ADRs 0001–0005.
2. **Get approval to merge.** Do not merge without Vamsi's approval. Record the approval as a dated entry in `memory.md`.
3. **Check for overlap.** Phase 11 already has steps, including the broadcast-CG-parity additions of 13 Sep 2026. For every step below, search the build plan for a step that already covers the same scope.
   - If one exists, fold this proposal's "Done when" criteria into that step. Do not add a duplicate.
   - If none exists, add the step.
4. **Assign IDs.** Use the build plan's own numbering scheme. Continue after the last existing number. **Never renumber existing steps.** The `A`/`B`/`C` IDs in this file are temporary labels for cross-referencing only. Rewrite every `Needs` reference to the real IDs when merging.
5. **Record as pending.** Add each merged step to `progress.json` (and `progress.html`) as `pending`, in the format already used there.
6. **Propose invariants separately.** Section 5 lists candidate invariants. Invariants are binding, so append them to `docs/invariants.md` only after Vamsi approves each one. Use the next free numbers. Never renumber.
7. **Execute in Needs order** with the mandatory verify-then-record loop:
   1. Confirm every step in `Needs` is `done` in `progress.json`. If not, do not start.
   2. Do the work.
   3. Verify by execution against that step's **Done when**. "It compiles" is not verification.
   4. Report the commands that were run and what they produced.
   5. Only then mark the step `done`, committing tracker and code in the same commit.
   6. Add a dated `memory.md` entry.
8. **`npm run check` must pass** on every commit: boundary guard, codegen staleness, typecheck, TS tests, Rust tests and conformance.

`active`, `pending` and `blocked` are all acceptable states. Never record an unverified `done`.

---

## 1. Constraints every step must respect

These restate existing rules. None of them is new.

- **Three applications only.**
  - Editor owns mutable authoring content and cannot change Program or outputs.
  - Playout alone may Cue, Take, Continue, Clear or configure outputs.
  - Render Engine owns Program pixels and time.
- **Ports.** project-api 4100, playout-control 4300, engine 4400–4403, web dev servers 5173/5174. **Port 4200 is burned.** Never bind to it.
- **Contracts.**
  - Rust in `Shared/` is the source of truth.
  - TypeScript is generated into `Shared/generated-ts` and never hand-edited.
  - There is one Cargo workspace and one lockfile.
- **Mocks.** Each product develops against a mock peer. A mock must refuse exactly where the real engine refuses.
- **Rates and time.** Rates are rational (num/den), never floats. Control messages carry intent (`TakeAt::NextOpportunity`, `Frame(n)`), never "when".
- **Refusal contract.** There is no silent substitution. A refusal names its failing condition. A fallback may never produce visually different pixels.
- **Four planes.** Control, Asset, Media and Timing stay on independent transports. No media path may influence Program cadence.

---

## 2. Track A: Foundations (build first, inside Phase 11)

The Track B modules are built on these. They are cheap to build now and expensive to retrofit.

### A01: Typed editor command model

- **Needs:** Phase 1 (domain contracts) and Phase 7 (editor service) done.
- **Scope:**
  - Every mutation of authoring content is a variant of a command type defined in `Shared/`.
  - Each command has a JSON Schema (2020-12) generated alongside the TS bindings.
  - The UI, console, undo/redo and the future MCP author tools all go through this one path.
- **Done when:**
  1. Every mutation route on project-api (4100) accepts only commands from the shared command type.
  2. JSON Schema 2020-12 is generated for every command, and the codegen staleness check covers it.
  3. A boundary-guard test fails a build that adds a mutation path outside the command type.
  4. A conformance test shows the Editor's mock Playout peer receives no command that alters Program or outputs.
  5. `npm run check` passes.

### A02: Undo/redo on the command log

- **Needs:** A01.
- **Scope:** Project-level and per-module undo/redo on Ctrl+Z and Ctrl+Shift+Z, built on the command log rather than on state snapshots per module.
- **Done when:**
  1. Applying N commands to a fixture scene and then undoing all N gives a scene content hash equal to the original.
  2. Redoing all N gives the post-edit hash exactly.
  3. Per-module undo affects only commands tagged with that module, shown by a test with interleaved commands from two modules.

### A03: Immutable, hashed scene revisions with state

- **Needs:** A01.
- **Scope:**
  - Publishing creates an immutable revision identified by a content hash.
  - Each revision carries a state: `draft`, `proposed` or `approved`. Only humans set these for now.
  - Playout loads revisions by pinned hash only.
- **Done when:**
  1. Publishing the same content twice gives the same hash. Changing one property gives a different hash.
  2. The Playout mock refuses an unknown or unpinned hash with a named refusal (`RevisionMismatch` or a new named code).
  3. The real Playout service refuses the same case identically, which the conformance suite confirms.

### A04: Asset records with provenance and license fields

- **Needs:** A01.
- **Scope:**
  - Every asset record in `.gpx` carries these fields:
    - origin (`human` / `tool` / `model`)
    - tool or model name and version
    - provider
    - license class
    - prompt hash (optional)
    - source references
    - approving user and timestamp
    - an optional attached C2PA manifest reference
  - The fields may stay empty for human-made assets, but the schema must exist now.
- **Done when:**
  1. The `.gpx` schema version is bumped and a migration test upgrades a pre-A04 project losslessly.
  2. Saving and reloading preserves every provenance field byte-for-byte.
  3. Importing an asset through the Asset Manager fills in `origin` and the tool name automatically.

### A05: Project design tokens and component registry

- **Needs:** A01, and Phase 10 (design system implementation) done.
- **Scope:**
  - Named project-level tokens: colors, fonts, spacing and motion durations/easings.
  - A registry of reusable components (scorebug, lower third, player card, bracket and so on), each with typed slots.
  - Objects reference tokens by name rather than copying values.
- **Done when:**
  1. Changing a token value updates every object bound to it, shown by a headless render (A07) of a fixture scene before and after the change.
  2. Deleting a token that is still referenced is refused with a named refusal.
  3. Components and tokens round-trip through `.gpx` save/load.

### A06: Determinism sandbox for scene JavaScript

- **Needs:** A01.
- **Scope:**
  - Per-scene JS modules run without wall-clock access (`Date.now`, `performance.now`, timers) and without network access (`fetch`, sockets).
  - Time comes only from an engine-supplied frame number and rate.
  - Data comes only through bindings.
  - Scripts get typed APIs that limit which objects they may touch.
- **Done when:**
  1. A script calling any banned API is refused with a named refusal that the console shows.
  2. A fixture script driven only by frame number gives identical output across two runs.
  3. A script touching an object outside its declared scope is refused.

### A07: Headless render entry point in the Render Engine

- **Needs:** A03, Phase 3 (engine core) and Phase 5 (local transport) done.
- **Scope:**
  - A control request renders revision X at frame N to an image.
  - This one entry point powers thumbnails, golden-frame tests, approval previews and Phase 13 parity.
  - It must not affect Program cadence.
- **Done when:**
  1. Rendering the same revision and frame twice on the same machine and driver gives byte-identical output.
  2. The cross-machine tolerance is defined, written into the step and tested.
  3. A headless render issued while Program is running causes no dropped or late Program frame, shown by the engine's frame-timing report over a timed run.
  4. The engine mock refuses exactly the cases the real engine refuses, for example an unknown revision.

### A08: Lint framework and first rules

- **Needs:** A01, A07.
- **Scope:**
  - A lint command returns structured findings with severity, rule, object and fix hint.
  - First rules:
    - title/action-safe violation
    - missing glyph for any bound field or target language
    - text overflow against a worst-case string fixture: longest player names, CJK, Arabic RTL
    - required template field left unbound
  - This grows into the full conformance gate in C02.
- **Done when:**
  1. Each rule has one fixture that fails and one that passes, both run as tests.
  2. A missing glyph is reported as a refusal-class finding, never resolved by a silent font fallback.
  3. The console shows lint findings using the same condition, cause and fix structure as refusals.

---

## 3. Track B: Editor modules (Phase 11)

These modules give GrapiX XPression/Vizrt parity. Build them in this order. Equivalent concepts: XPression's Scene Director, DataLinq and take-item data; Vizrt's Stage and control objects.

### B01: Project and Scene Manager

- **Needs:** A01, A03.
- **Scope:**
  - Explicit-save `.gpx` projects (work must be saved as a project first; no autosave).
  - A scene list.
  - Scene settings: resolution (1080p first), rational frame rate, duration, alpha on/off and background.
- **Done when:**
  1. Creating, renaming, duplicating and deleting scenes are all commands (A01) and all undoable (A02).
  2. Unsaved work cannot be published.
  3. A non-rational frame rate cannot be entered; the attempt is refused.

### B02: Viewport

- **Needs:** B01, and Phase 10 done.
- **Scope:**
  - The Three.js canvas.
  - Scene cameras and an editor camera.
  - Transform gizmos (move, rotate XYZ, scale) and single and multi selection.
  - Rulers and margins in After Effects/Photoshop style, configurable in the project tab.
  - Title/action-safe guides.
  - An empty scene shows nothing.
- **Done when:**
  1. Every gizmo interaction produces commands, not direct state writes.
  2. Z position and XYZ rotation visibly change the render, shown by a headless render (A07) of a fixture scene before and after.
  3. Guide and margin settings round-trip through save/load.

### B03: Object Manager

- **Needs:** B02, A01.
- **Scope:**
  - The authoritative hierarchy, which drives the viewport, layer properties and every scene view.
  - Parenting, groups, reordering, show/hide and lock.
  - Duplicate names are rejected with a warning and a suggested name (object1, object2…).
- **Done when:**
  1. A test shows the viewport and inspector reflect hierarchy changes made only through the Object Manager.
  2. A duplicate name is refused with a named refusal and a suggestion.
  3. All operations are undoable.

### B04: Object Inspector with keyframe clock icons

- **Needs:** B03.
- **Scope:**
  - Properties that vary by object type.
  - Numeric fields that scrub by dragging and accept negative values.
  - A clock icon on every animatable property that creates or removes keyframes, After Effects style. There is no separate Animation tab.
- **Done when:**
  1. Each object type in B05 shows exactly its defined property set.
  2. Toggling a clock icon creates a keyframe at the current frame, and undo removes it.
  3. A scrubbed value is committed as one command, not one command per mouse move.

### B05a: Object library, 2D

- **Needs:** B03, B04.
- **Scope:** Text, image quad, shapes, pen-tool paths, masks and clip groups (clip shape plus content composition), keyframable paths and trim paths.
- **Done when:**
  1. Each object type has a headless golden-frame test (A07).
  2. A clip group clips its content correctly, shown by a golden-frame test.
  3. A trim-path animation renders correctly at three sampled frames.

### B05b: Object library, 3D

- **Needs:** B03, B04.
- **Scope:**
  - Real 3D primitives with assignable faces.
  - Extruded text and logos.
  - Cameras, lights and null/locator objects.
- **Done when:**
  1. Golden-frame tests show lights, cameras and Z/XYZ transforms affecting the render.
  2. Assigning a material to one face affects only that face.

### B05c: Object library, video layer

- **Needs:** B03, B04.
- **Scope:** A video layer with alpha, using Asset-plane media.
- **Done when:**
  1. A clip with alpha composites correctly in a golden-frame test.
  2. A missing media file is reported as a named refusal, not shown as black or a placeholder.

### B06: Material Manager

- **Needs:** B05b.
- **Scope:**
  - One unified physically-lit material type; no separate Unlit, Basic Lit or PBR types.
  - An XPression-style material library.
  - Assigning materials to objects and faces.
- **Done when:**
  1. One material type covers every fixture in the material test set.
  2. Library materials round-trip through `.gpx`.
  3. Golden frames match between the Editor viewport and the engine within the tolerance defined in A07. This is a forward check for Phase 13 parity.

### B07: Font Manager and text engine

- **Needs:** B05a, A08.
- **Scope:**
  - OTF, TTF and WOFF files, Adobe font links and CSS embed links.
  - Tracking, leading and auto-fit/shrink-to-box.
  - Complex-script shaping for at least Latin, CJK and Arabic RTL, using a HarfBuzz-class shaper.
- **Done when:**
  1. The A08 worst-case string fixture renders without overflow, or raises an overflow finding.
  2. A missing glyph raises a refusal-class lint finding.
  3. Arabic RTL renders correctly in a golden-frame test.

### B08: Asset Manager

- **Needs:** A04.
- **Scope:**
  - A browser for images, video, 3D and fonts.
  - Every asset stored as a hashed, versioned file on the Asset plane, with its provenance record shown.
- **Done when:**
  1. Importing the same file twice gives one asset, deduplicated by hash.
  2. Replacing an asset creates a new version and leaves earlier revisions pinned to the old hash.
  3. Interrupted asset transfers resume (the Asset plane is restartable).

### B09: Timeline

- **Needs:** B04.
- **Scope:**
  - Movable keys, a curve editor and a speed graph.
  - Scene states In, Loop and Out.
  - Named stop points that tell Playout's Continue where to pause.
- **Done when:**
  1. Moving or retiming a key is a single undoable command.
  2. The values evaluated at sampled frames match the expected curve values exactly, using rational time.
  3. Stop points are carried in the published revision and the Playout mock reads them.

### B10: Template fields (typed slots)

- **Needs:** B04, A01, A03.
- **Scope:**
  - A designer publishes chosen properties as template fields.
  - Each field has a type, range, enum, max length and fallback rule.
  - Playout forms, data binding (B11) and the future template factory (C10) all fill these fields.
- **Done when:**
  1. The field schema is part of the published revision.
  2. A value outside a field's type, range, enum or length is refused with a named refusal by both the Playout mock and real Playout.
  3. A field's fallback rule never produces different pixels without a declared state, per the refusal contract.

### B11: Data binding

- **Needs:** B10.
- **Scope:**
  - CSV, JSON, HTTP and WebSocket sources bound to template fields.
  - Late or missing data produces a declared state (hold last value, or refuse the update). It never produces a guessed value.
- **Done when:**
  1. A fixture feed updates bound fields correctly.
  2. A deliberately stalled feed produces the declared state, which the console shows.
  3. A type mismatch between a feed and a field is refused.

### B12: Logic

- **Needs:** B09, B10, A06.
- **Scope:** Conditional triggers, transitions between scenes and per-scene JS modules, all running inside the A06 sandbox.
- **Done when:**
  1. A fixture trigger fires on the expected frame across two runs.
  2. A transition between two scenes renders identically across two runs.
  3. Any banned API inside a module is refused.

### B13: Widgets

- **Needs:** B12, A06.
- **Scope:**
  - Clock, countdown, counter and round timer.
  - Time is derived from the engine frame count and rational rate, never from the wall clock.
- **Done when:**
  1. At 60000/1001, a countdown shows exactly the rationally computed value after N frames.
  2. A long-run test shows zero drift.
  3. Pausing and resuming are commands.

### B14: Preview and publish to Playout

- **Needs:** A03, A07, B09.
- **Scope:** A preview monitor rendered by the engine, and publishing a hashed revision to Playout.
- **Done when:**
  1. Publishing creates a revision that the Playout mock lists by hash.
  2. The preview frame and a headless render of the same revision and frame match within the A07 tolerance.
  3. The Editor cannot Cue, Take, Continue or Clear, which a conformance test confirms.

### B15: Console and debugger

- **Needs:** A01.
- **Scope:**
  - Consoles in the Editor and Playout show every failure with its condition, cause and fix.
  - Consoles other than the render engine's run without popping up.
- **Done when:**
  1. Every named refusal code has a console entry with all three parts, and a test enumerates the codes.
  2. Lint findings (A08) appear in the console.

### B16: Importers re-enter

- **Needs:** B05a, B05b, B06, B07, B09.
- **Scope:**
  - Figma, PSD/AI and After Effects importers, rebuilt on the 2.0 objects.
  - Rules carried over from 1.x:
    - Figma: fetch with `geometry=paths`, recurse with no depth limit, never stop on unsupported nodes, and model `clipsContent` as a nested clip composition.
    - AE: precomps import as live scenes, not flattened clips.
    - Every imported asset is stamped with provenance (A04).
- **Done when:**
  1. A fixture file per importer imports and renders with all assets exact in golden-frame tests.
  2. Any node type that is not supported produces a named finding instead of being silently dropped.

---

## 4. Track C: Research features (later phases)

Merge these into their target phases. Their `Needs` lists include Track A/B steps, so none can start before the foundations exist.

### C01: Tiered MCP surface (Phases 12–14)

- **Needs:** A01, A03, and Phase 8 (MCP automation surface) done.
- **Scope:**
  - Three tiers:
    - **Read:** scenes, assets, bindings, tokens and engine status.
    - **Author:** typed commands only, on a stateless draft handle.
    - **Propose:** submit a changeset to Playout's approval queue.
  - **No tool may reach playout-control.**
  - Target the MCP 2026-07-28 specification. Verify it against the official spec and the Rust SDK before coding.
- **Done when:**
  1. A conformance test enumerates every MCP tool and asserts that none can Cue, Take, Continue, Clear or configure outputs.
  2. An author tool cannot modify a published revision.
  3. An unknown schema version is refused (the server fails closed).

### C02: Approval pipeline (Phase 13)

- **Needs:** C01, A07, A08, and Phase 13 parity done.
- **Scope:** Changeset → headless engine render → lint/conformance gate → named human approval → hash-pinned revision loadable by Playout.
- **Done when:**
  1. A changeset that fails lint cannot be approved.
  2. Playout loads only `approved` revisions.
  3. The approval record names the approver and the time, and is written to the JSON Lines audit trail.

### C03: Provenance in use (Phases 13–14)

- **Needs:** A04, C02.
- **Scope:**
  - Playout refuses assets whose license class is incompatible with the show profile.
  - A per-show AI-usage report is generated.
  - An optional AI-disclosure label element is available.
- **Done when:**
  1. A fixture show profile refuses a fixture asset marked non-commercial.
  2. The report lists every model-origin asset used in a show.

### C04: Live data service (Phases 14–16)

- **Needs:** B11, B12.
- **Scope:**
  - Esports data ingest (GRID or other feeds) into a typed, timestamped model.
  - Deterministic triggers.
  - An AI suggestion lane: suggestions need producer confirmation unless their class is pre-approved.
  - Data reaches the engine only as Control-plane intent.
- **Done when:**
  1. Replaying a recorded feed produces the same trigger sequence on every run.
  2. A suggestion never changes Program without a confirm action or a pre-approved class.

### C05: NDI 6.3 metadata and OMT output (Phase 15)

- **Needs:** Phase 15 output work.
- **Scope:** Publish revision and asset IDs plus AI-provenance flags as NDI metadata. Add OMT as a second output beside NDI.
- **Done when:** A receiver reads the metadata for a fixture frame, and OMT output passes a receive test.

### C06: ST 2110/IPMX output server (Phase 15)

- **Needs:** Phase 14 (remote engine).
- **Scope:** NMOS IS-04/05, with genlock and PTP owned by the output server.
- **Done when:** It is defined at merge time against the hardware chosen.

### C07: Generative asset adapters (Phases 16–17)

- **Needs:** A04, B08.
- **Scope:**
  - Pluggable generators for images, 3D and video loops, all baked offline into hashed assets with a license class.
  - **Do not bundle GPL or non-commercial models.**
  - Region-restricted models are flagged.
- **Done when:**
  1. Every generated asset carries a complete provenance record.
  2. An adapter whose model license class is not set is refused.

### C08: AI keyer sidecar (Phase 16+)

- **Needs:** Phase 15 output work.
- **Scope:**
  - Matting runs as a separate supervised process that publishes fill+key on the Media plane.
  - The engine uses the latest key that arrives in time and drops late keys.
- **Done when:**
  1. Killing the keyer process causes no Program frame drop.
  2. The layer goes to its declared "no key" state and the console raises an alarm.

### C09: Gaussian splat layer (Phase 16+)

- **Needs:** B05b, Phase 13 parity done.
- **Scope:** Load `KHR_gaussian_splatting` glTF with deterministic sorting.
- **Done when:**
  1. Two runs give identical golden frames.
  2. The frame-time budget holds at 1080p.

### C10: Template factory (Phase 17)

- **Needs:** A05, B10, C02.
- **Scope:**
  - Constrained generation: the LLM picks components, fills typed slots, binds data and adjusts tokens within allowed ranges.
  - It does not invent free-form geometry.
  - Variants go through C02.
- **Done when:**
  1. Every generated variant passes or fails the C02 gate deterministically.
  2. No variant reaches Playout without approval.

### C11: Interchange (Phase 16+)

- **Needs:** B06, B09.
- **Scope:** OpenUSD/MaterialX import mapped to the unified material, and OpenTimelineIO export of sequencer timelines.
- **Done when:** It is defined at merge time.

### Standing prohibitions (all phases)

- No neural frame generation or temporal AI upscaling on Program.
- Nothing generative runs at Take time.
- Agents never Cue, Take, Continue, Clear or configure outputs.

---

## 5. Candidate invariants (need approval before appending)

Check `docs/invariants.md` for an existing equivalent before proposing each one. If Vamsi approves, append with the next free number and never renumber.

1. Every mutation of Editor authoring content is a command defined in `Shared/`; no other mutation path exists.
2. Playout loads scene revisions only by pinned content hash.
3. Scene scripts have no wall-clock or network access; time comes only from the engine frame.
4. No generator or model inference runs on the Take path.
5. No neural frame generation or temporal AI upscaling is applied to Program.
6. No MCP or agent tool can reach playout-control.
7. A missing glyph is a refusal, never a font substitution.

---

## 6. Open questions for Vamsi

- **React.** Does the editor UI stay on React or move off it before B02–B04? The answer changes the implementation of the Track B UI steps.
- **Lint severity.** Should lint findings block publishing or only warn? The proposed default is that refusal-class findings block and the rest warn.
- **Approval roles.** Which roles may approve in C02: Admin only, or Admin and Editor?
