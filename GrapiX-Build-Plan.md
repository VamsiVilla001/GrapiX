# GrapiX — Sequenced Build Plan

Built from scratch, in dependency order. Backend, contracts and platform
work come first because everything else reads them. Interface work is
deferred to Phases 11 and 12 — the application is fully operable and
automatable before it is clickable.

| | |
|---|---|
| **Status** | Proposed |
| **Date** | 9 September 2026 |
| **Tracker** | `progress.html` — keep it in the repo, commit `progress.json` |
| **Rule** | A phase does not start until every dependency listed in it is done. |

**Tracks:** `CON` Contracts · `PLAT` Platform · `BE` Backend · `UI` Interface · `RES` Research · `EXT` External gate · `AI` Gen-AI

---

**171 steps across 19 phases.**


## Phase P — Parallel tracks — start on day one

Long lead times. Nothing here is code, and all of it blocks something later.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `P.1` | Procure GPU, DeckLink/AJA hardware, NDI SDK access, lab time | EXT | — | Purchase orders raised and dates confirmed |
| `P.2` | Licensing decisions: Adobe/AE, FFmpeg LGPL vs GPL, H.264/HEVC/ProRes, font embedding | EXT | — | Written position per item, owner named |
| `P.3` | UI research programme (Phase 9) kicked off | RES | — | Participants recruited, first sessions booked |

## Phase 0 — Repository foundations

Blocks literally everything. Nothing else starts until this is green.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `0.1` | Clean branch; one Cargo workspace, one lockfile | CON | — | cargo build at root builds all crates |
| `0.2` | Pin toolchains: Rust, Node, wgpu 26 across every crate | CON | 0.1 | Versions pinned in-tree, CI enforces |
| `0.3` | CI matrix on Windows and macOS from the first commit | PLAT | 0.1 | Both platforms green on an empty tree |
| `0.4` | Dependency and licence policy; SBOM generated in CI | PLAT | 0.3 | SBOM artifact on every build |
| `0.5` | tracing + OpenTelemetry skeleton | BE | 0.1 | A span reaches a collector |
| `0.6` | Structured refusal type — code, field, given, allowed, severity | CON | 0.1 | Serialises identically in Rust and TS |
| `0.7` | RationalRate type (num/den). No float rates anywhere | CON | 0.1 | Lint or test forbids float rates |
| `0.8` | Stable ID and Revision types; if_revision semantics | CON | 0.1 | Conflict returns current revision |
| `0.9` | Contracts package; Rust is source of truth, TS generated | CON | 0.6 | No hand-written TS type duplicates a Rust one |
| `0.10` | Conformance harness scaffold and mock-peer pattern | CON | 0.9 | An empty conformance suite runs in CI |

## Phase 1 — Domain contracts

Defined before any implementation reads them. This is what makes three products buildable in parallel.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `1.1` | Scene document schema | CON | 0.9 | Round-trips through both languages |
| `1.2` | Object type catalogue and full property surface | CON | 1.1 | Every authorable object is representable |
| `1.3` | Material model; fit and blend enums as the single source of truth | CON | 1.1 | One enum, consumed by validator, engine and UI |
| `1.4` | Colour types: linear working space, tagged sources, output transforms | CON | 1.1 | sRGB and Rec.709 transforms named and testable |
| `1.5` | Design system token schema | CON | 1.1 | W3C Design Tokens JSON maps in cleanly |
| `1.6` | Motion token and preset schema: phases, 0–1 time, stagger modes | CON | 1.5 | A preset resolves to frames at any rate |
| `1.7` | Asset addressing: content hash plus project-relative path | CON | 1.1 | Replacing a file in place keeps bindings |
| `1.8` | .gpxpkg format and manifest | CON | 1.7 | Per-file SHA-256, verified after write |
| `1.9` | Protocol v3 message set — intent-based take, committed frame returned | CON | 0.7 | No message carries wall-clock time |
| `1.10` | Capability: locality, device tier, clock source, reference state | CON | 1.9 | Mismatch has a dedicated error code |
| `1.11` | Mock engine, mock playout, mock editor | CON | 1.10 | Each product can run with zero real peers |
| `1.12` | Conformance suite green against all three mocks | CON | 1.11 | CI gate on every PR |

> **Milestone.** Three products can be built in parallel from here.


## Phase 2 — Platform primitives

No UI. These are the things every later layer depends on and that fail quietly if rushed.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `2.1` | Atomic write helper: unique temp, fsync, retry on contention, directory fsync | PLAT | 0.1 | Both known rename races closed; one implementation only |
| `2.2` | Filename sanitiser: reserved names, illegal characters, length, NFC | PLAT | 0.1 | Passes a hostile-name corpus on both platforms |
| `2.3` | Case canonicalisation policy: compare insensitively, preserve for display | PLAT | 2.2 | A case-sensitive volume behaves identically |
| `2.4` | OS directory conventions; the in-repo default removed | PLAT | 0.1 | AppData and Application Support used correctly |
| `2.5` | File watching with debounce, both platforms | PLAT | 2.4 | Equivalent event streams from FSEvents and Win32 |
| `2.6` | Project store: JSON, backups, autosave ring | BE | 2.1 | Kill -9 mid-write leaves a valid project |
| `2.7` | Asset store: SHA-256 dedupe, two-address, geometry read from headers | BE | 1.7 | Same asset imported twice stores once |
| `2.8` | Font subsystem ported across unchanged | BE | 2.7 | All sources resolve on both platforms |
| `2.9` | gx1 HMAC tokens; roles and scopes | BE | 0.1 | Algorithm fixed by prefix at parse time |
| `2.10` | Audit and operations logging, sanitised | BE | 0.5 | No credentials in any log line |

## Phase 3 — Render engine core

Headless. The engine must be complete and testable before anything draws a pixel of UI.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `3.1` | wgpu init; backend selection D3D12 / Metal / Vulkan | BE | 0.2 | Runs headless on both platforms |
| `3.2` | Device tier negotiation T0–T3 | BE | 3.1 | Tier reported in capability |
| `3.3` | Colour pipeline: linear internal, tagged textures, sRGB and Rec.709 output | BE | 1.4 | Colour ramp renders identically on both platforms |
| `3.4` | Scene parse to prepared scene | BE | 1.1 | Unknown fields refuse, never ignore |
| `3.5` | PathRasteriser trait; lyon implementation behind it | BE | 3.1 | Swappable without touching scene logic |
| `3.6` | Text via cosmic-text: shaping, fallback, bidi, OpenType | BE | 2.8 | Missing font refuses, never substitutes |
| `3.7` | Meshes, glTF, materials, lights, cameras | BE | 3.4 | Per-object, per-face and per-element assignment |
| `3.8` | ProgramClock: rational rate, absolute deadlines, ClockSource abstraction | BE | 0.7 | Late frames dropped, never queued |
| `3.9` | Tiling with overscan above the GPU texture limit | BE | 3.1 | Seam-free composite proven byte-identical |
| `3.10` | OutputAdapter trait; null, virtual, recording | BE | 3.8 | Unknown adapter id refused with the offered list |
| `3.11` | Preview and Program frame emission; bounded queue, counted drops | BE | 3.10 | Stall drops frames, never blocks the clock |
| `3.12` | WAL recovery journal; restore starts output-inhibited | BE | 2.1 | Forced kill restores without an unrecovered output |
| `3.13` | Refusal coverage audit — every unsupported case refuses by name | BE | 0.6 | No silent fallback anywhere; blend and fit modes included |

**Open defect — the engine-host test leg does not terminate (found 13 September 2026).**
`cargo test -p gx-engine-host` hangs indefinitely in
`the_host_spawns_when_nothing_is_listening` (`services/render-engine/host/tests/ensure.rs`).
The sibling `ensure_refuses_a_reserved_port` passes in the same run, so this is
neither a compile cost nor an environment problem: it is the spawn-and-adopt
path itself. The hang survives an external `timeout`, which points at a spawned
`gx-render-worker` the harness never reaps.

Because of it, `npm run test:rust` runs `cargo test --workspace --exclude
gx-engine-host` so the gate terminates, and `npm run test:rust:host` runs the
host leg alone. **That exclusion is a named hole, not a permanent carve-out**,
and it is recorded here rather than left in a script where nobody would find
it. Until the hang is fixed, no run of `npm run check` has exercised host
supervision, and no claim about it should rest on that gate.

This was invisible until today because `npm run check` referenced a `test:rust`
script that did not exist, so the gate died before the Rust leg for as long as
that chain has been in place.

## Phase 4 — Pixel gate

The instrument. Built before anything that could change pixels, so there is a baseline to compare against.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `4.1` | Reference scene set: colour ramp, safe areas, text, vector, 3D, every rate family | BE | 3.13 | Covers each supported fit and blend mode |
| `4.2` | Headless render harness on both platforms | PLAT | 4.1 | Runs in CI without a display |
| `4.3` | Baseline capture, committed to the repo | BE | 4.2 | Reference images versioned |
| `4.4` | CI gate with a diff threshold that fails the build | PLAT | 4.3 | A deliberate one-pixel change is caught |
| `4.5` | Cross-platform pixel equality: Windows versus macOS | PLAT | 4.4 | Any difference is explained or fixed, not accepted |

> **Milestone.** There is now an instrument. Nothing after this changes pixels unmeasured.


## Phase 5 — Transport — local

Location-transparent from the first line. Local is an optimisation, not a different code path.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `5.1` | Control plane over named pipe and unix socket | BE | 1.9 | Ordered, acknowledged, sequenced |
| `5.2` | Session, auth, epoch, reconnect and reconciliation | BE | 2.9 | Program survives a control disconnect |
| `5.3` | Asset plane local: hash preflight, transfer only the difference | BE | 2.7 | Re-publish moves no unchanged bytes |
| `5.4` | Media plane local: shared memory or handle passing | BE | 3.11 | Frames reach a consumer with no copy |
| `5.5` | Locality declared in the capability exchange | BE | 1.10 | Consumers adapt without code change |
| `5.6` | Conformance suite passes over the real transport, not just mocks | BE | 1.12 | Same suite, both paths |

## Phase 6 — Playout service

Headless and fully testable before its UI exists.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `6.1` | Published library store; stable Take IDs | BE | 1.8 | IDs stable across republish |
| `6.2` | Cue, take, continue, out, clear as intent; committed frame returned | BE | 5.1 | No caller can specify wall-clock time |
| `6.3` | Revision pinning; refusal on mismatch | BE | 0.8 | Stale revision cannot go to air |
| `6.4` | Rundown persistence and sequence engine | BE | 6.1 | Cursor survives restart |
| `6.5` | Output configuration; is_live gated on tier, platform and reference | BE | 3.2 | Live refused below T0, naming the failing condition |
| `6.6` | Automation trigger evaluation; execution explicitly deferred | BE | 6.4 | Deferral is a named refusal, not silence |

## Phase 7 — Editor service

Also headless. Import, validation and publish must work before a designer sees a window.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `7.1` | Project and scene CRUD | BE | 2.6 | Refuses writes until a project folder exists |
| `7.2` | Import pipeline: four tiers, compatibility report, source retained | BE | 1.1 | Every substitution named in the report |
| `7.3` | Import fidelity gate: source reference render versus imported render | BE | 4.3 | Diff stored with the template |
| `7.4` | Scene validator: every unsupported case refused by name | BE | 3.13 | Shares one enum with the engine |
| `7.5` | Design system enforcement: three severities plus override log | BE | 1.5 | Overrides recorded with a reason |
| `7.6` | Package build, verify, publish; design-system version stamped | BE | 1.8 | Publishing is all-or-nothing |
| `7.7` | Preflight | BE | 7.4 | Returns structured refusals with allowed values |

## Phase 8 — MCP automation surface

Deliberately before the UI. The application becomes fully operable and automatable while still headless.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `8.1` | Tool schema generated from contracts; versioned alongside protocol v3 | BE | 0.9 | No hand-written schema |
| `8.2` | system.capability — supported enums, tier, versions, build hash | BE | 1.10 | An agent never has to guess |
| `8.3` | project, scenes, objects | BE | 7.1 | Full property surface reachable |
| `8.4` | materials, assets, fonts | BE | 7.1 | Including relink and usage lookup |
| `8.5` | animation, including apply_preset | BE | 1.6 | Presets parameterised, never authored by the caller |
| `8.6` | bindings | BE | 1.1 | Data schema discoverable |
| `8.7` | designsystem.* and motion.* | BE | 1.6 | Import and commit are admin-scoped |
| `8.8` | validate.* | BE | 7.7 | Refusals machine-parseable |
| `8.9` | render.preview returning a real frame | BE | 3.11 | An agent can see its own output |
| `8.10` | packages.* | BE | 7.6 | Publish returns Take ID and revision |
| `8.11` | playout.* and outputs.*, scope-gated | BE | 6.5 | author token refused on take and configure |
| `8.12` | if_revision, idempotency keys, batch-as-one-undo | BE | 0.8 | Retry after timeout does not duplicate |
| `8.13` | Scope enforcement tests | BE | 8.11 | Every scope violation covered |

> **Milestone.** The application is fully operable and automatable with no interface at all.


## Phase 9 — UI research

Started on day one in parallel. Must land before Phase 11 begins — it produces the constraints Phase 11 builds against.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `9.1` | Artifact teardown of comparable professional tools | RES | P.3 | Vocabulary of density, chrome and controls |
| `9.2` | Recruit designers, operators, producers | RES | P.3 | Segments filled, including macOS-primary designers |
| `9.3` | Contextual interviews in the suite and the control room | RES | 9.2 | Not remote. Lighting and viewing distance observed |
| `9.4` | Card sort for panel and function grouping | RES | 9.3 | Information architecture proposal |
| `9.5` | Usability baseline against the previous build | RES | 9.2 | Timed tasks including the disconnected-engine task |
| `9.6` | Concept reaction across three divergent directions | RES | 9.1 | Tested on calibrated and uncalibrated displays |
| `9.7` | Synthesis: design constraints document and anti-pattern list | RES | 9.6 | Density scale, chrome range, type at viewing distance |

## Phase 10 — Design system implementation

Backend first — ingest and enforcement land before the panels that surface them.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `10.1` | Token ingest from W3C Design Tokens JSON | BE | 1.5 | Round-trips without loss |
| `10.2` | Token ingest from Figma and Claude Design | BE | 10.1 | Variables and published styles mapped |
| `10.3` | Unexpressible report at ingest | BE | 10.1 | Names what the source held and tokens cannot |
| `10.4` | Versioned, immutable store with provenance | BE | 10.1 | Human confirmation before v1 |
| `10.5` | Drift report across published templates | BE | 7.6 | Lists every template behind the current version |

## Phase 11 — Editor UI

Deferred to here on purpose. Everything above is usable without it, and this is built against research output, not guesswork.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `11.1` | Tauri 2 shell on both platforms; signed and notarised | UI | 0.3 | Installers produced by CI |
| `11.2` | WebGPU capability probe on both target OS versions | PLAT | 11.1 | Result recorded; decides the WASM fallback |
| `11.3` | DPI: fractional scaling, scale change, monitor move | UI | 11.1 | Correct at 100, 125, 150 and 200 per cent |
| `11.4` | Colour management in the browser layer, matching the engine | UI | 3.3 | Colour ramp matches the engine render |
| `11.5` | Dockable workspace | UI | 9.7 | Layout follows the card sort |
| `11.6` | Three.js viewport: 2D on an orthographic camera plus 3D | UI | 11.4 | A 2D object renders between two 3D objects |
| `11.7` | Overlay layer: handles, guides, selection, marquee | UI | 11.6 | Structured so the engine can take over the raster |
| `11.8` | Object manager treegrid | UI | 11.5 | Hierarchy, visibility, lock, alpha, transforms |
| `11.9` | Type-aware inspector | UI | 11.8 | Multi-select Mixed state, one undo transaction |
| `11.10` | Timeline: virtualised rows, canvas layers, dirty-rect repaint | UI | 11.5 | Node count flat from 100 to 100,000 keys |
| `11.11` | Speed graph and curve editing | UI | 11.10 | Scrub causes no static-layer repaint |
| `11.12` | Material manager | UI | 11.9 | Shared instances, relink, usage lookup |
| `11.13` | Font manager panel | UI | 2.8 | Ported, not redesigned |
| `11.14` | Design system panel; tokens as editor defaults | UI | 10.4 | Palette and type scale are the path of least resistance |
| `11.15` | Motion preset browser; save selection as preset | UI | 1.6 | Library grows from real designer work |
| `11.16` | Live conformance indicator | UI | 7.5 | Drift visible as it happens, not at publish |
| `11.17` | Import UI with tier and substitution report | UI | 7.2 | Nothing substituted without being named |

| `11.18` | Editor 1.x panel parity in the Editor 2.0 workspace | UI | 11.5, 11.8, 11.9, 11.12, 11.13, 11.16, 7.1 | Templates/scenes CRUD, object creation and management, object details/properties, fonts, assets and materials are reachable and functional in Tauri; reuse existing modules, preserve selection, validate writes, undo and save/reopen |
| `11.19` | Data binding panel integrated with object properties | UI | 11.18, 8.6 | Discover the data schema; create, edit and remove property bindings, preview sample data, show invalid paths/types explicitly and preserve bindings through save/reopen |
| `11.20` | Editable animation contract and service integration | CON | 1.6, 7.1, 8.12 | Document existing timeline/preset consumers and extend only missing scene channels, easing and validated edit operations; Rust/TS round-trip keys, evaluate rational-rate frames consistently, preserve old scenes and undo/revision semantics without widening preset-only MCP authoring |
| `11.21` | Inspector keyframe diamonds and Auto-Key | UI | 11.9, 11.20 | Position, Scale, Rotation, Opacity, Size and other supported properties show empty/filled current-playhead diamonds; toggling keys and Auto-Key creates or updates exactly one key, with defined first-key/base-value/off behavior, multi-select and undo/redo |
| `11.22` | Selection-driven timeline and keyframe editing | UI | 11.10, 11.21 | Object selection automatically reveals property tracks; expand/collapse, select, drag/move, delete and copy/paste keys with frame snapping, explicit collision behavior and one undo per gesture; preserve flat node count from 100 to 100,000 keys |
| `11.23` | Simple easing, Custom Bezier and starter presets | UI | 11.11, 11.15, 11.22 | Linear, Ease In, Ease Out, Ease In-Out and Custom Bezier persist and evaluate correctly; Fade, Slide, Scale and Pop use the existing preset library, supported parameters and save-selection workflow; advanced curves appear on demand and scrubbing avoids static-layer repaint |
| `11.24` | Spacebar preview and integrated Editor parity verification | UI | 11.6, 11.19, 11.23 | Spacebar smoothly plays/pauses local animation without stealing typing/control shortcuts; verify panel-to-animation workflows, frame-consistent scrubbing, undo/redo and save/reopen in Tauri on Windows/macOS, measure playback on target hardware and confirm no Program/output side effects |
| `11.25` | Named animation phases on the scene timeline | CON | 11.20, 11.22 | The scene timeline carries named `in`, `hold`, `out`, `continue` and `update` phases as frame spans over the existing channels, matching the `MOTION_PHASES` vocabulary presets already use; phases round-trip Rust/TS, are authored and previewed independently in the Editor, refuse overlap and out-of-range spans by name, and a scene authored before phases existed still parses unchanged |
| `11.26` | Template control contract: declared operator fields | CON | 11.18, 11.19 | A scene declares which object properties an operator may fill, as a typed, named field list carried on the document; each field names its target object/property, its type and its default, refuses an unknown or non-fillable target by name, round-trips Rust/TS, and is authored in the Editor without widening the preset-only MCP authoring surface |
| `11.27` | Take-page authoring: fill and save a template instance | UI | 11.26 | The Editor renders the operator form generated from 11.26's declared fields, fills values against a template, reports a value the field's type refuses rather than coercing it, previews the filled result in the viewport, and saves and reopens named instances without mutating the template they were filled from |
| `11.28` | Named text style presets | UI | 11.13, 11.14 | Font, size, tracking, line height, case and fill/stroke are saved as one named, reusable style; applying a style to a text object sets exactly those properties as one undo entry; a style whose font the scene does not carry refuses by name; styles resolve design-system tokens rather than duplicating their values, and survive save/reopen |
| `11.29` | Multi-scene workspace: scenes as first-class entities | UI | 11.18 | A broadcast carries many graphics, so each open scene is a distinct session owning its own document, selection, playhead, collapse state and undo history; one workspace module lists every open scene and switches the active one; viewport, object manager, inspector, timeline, animation and binding panels are children of the active scene and render it alone; switching preserves each scene's own state, an edit or undo in one scene cannot alter another, and closing a scene with unsaved changes refuses by name |

### Phase 11 UI requirements — Editor 2.0 parity and animation

**Status: Planned.** The new requirements are tracked by 11.18–11.24; they do not claim that the existing component-level steps deliver a complete editor. All dependencies listed in a row must be done before that step starts.

**Inspection baseline (12 September 2026):** `Editor/web/main.ts` mounts object-manager and inspector projections and the Three.js viewport. Reusable scene/template, font, material and motion-preset modules exist under `Editor/src`, but are not all integrated into the shell entry point. No interactive timeline module is present there. `Shared/contracts/src/scene.rs` currently stores scene timeline duration; `design_system.rs` already defines normalized motion channels, keys and outgoing easing token references. These are foundations to extend, not systems to replace. Verify current wiring again when implementation begins.

- Visual direction: keep the UI clean, minimal and Figma-like; target roughly 70% Figma simplicity and 30% simplified After Effects animation control. Reveal advanced controls only when needed; do not copy After Effects complexity.

- Editor 1.x parity is required in Editor 2.0: restore the templates/scenes manager, object creation and object manager, object details and type-aware property inspector, data binding panel, font manager, asset browser and material manager as reachable, functional panels in the Tauri workspace.

- Inspect and reuse the existing architecture before implementation. Extend the current object-manager, inspector, scene-manager, font-manager, material-manager, motion-preset-browser, agent-surface and viewport modules and Rust editor services; do not unnecessarily rewrite working systems or create a second scene model.

- Place keyframe diamonds beside supported animatable properties, including Position, Scale, Rotation, Opacity and Size. Empty means no keyframe at the current playhead; filled means a keyframe exists there. Indicate animation elsewhere separately so an empty diamond does not imply the whole track is unanimated. Clicking adds or removes the current-frame key, with accessible labels and keyboard operation.

- Provide a clearly visible Auto-Key mode. When enabled, changing an animatable property at a new timeline position creates a keyframe; editing an existing key updates it without duplicates. Specify base-value and first-key behavior, multi-selection, undo/redo and Auto-Key-off behavior before implementation so edits do not unexpectedly alter other frames.

- Selecting an object automatically reveals its animation tracks. Expand/collapse tracks by property and keep selection synchronized across viewport, object manager, inspector and timeline. Support selecting, dragging/moving, deleting and copying/pasting keyframes, with frame snapping, defined collision behavior and one undo transaction per gesture.

- Offer Linear, Ease In, Ease Out, Ease In-Out and Custom Bezier easing. Keep common easing one action away and show the curve editor on demand. Add simple Fade, Slide, Scale and Pop presets through the existing preset library, with adjustable supported parameters and save-selection-as-preset.

- Spacebar toggles smooth local animation preview and pause from the current playhead; it must not steal typing or native control shortcuts when an input, editable field or button has focus. Scrubbing and playback evaluate the same animation at the scene rational frame rate, preserve editing state and never send Program/take/output commands.

- Preserve Rust-owned contracts and generated TypeScript, validated writes, revision checks, undo transactions, design-system motion tokens and the existing preview/production separation. Reconcile editable scene channels with existing normalized preset channels and easing tokens; extend contracts only where necessary. Human keyframe authoring must not silently widen the agent/MCP surface, which selects and parameterizes presets under ADR Part G.

- Acceptance requires actual Tauri workflows on Windows and macOS: create/open a scene or template, add/select/edit objects, bind data, manage fonts/assets/materials, animate with diamonds and Auto-Key, edit/copy keys, apply easing/presets, preview, undo/redo, save and reopen. Verify animation persistence and evaluated values, report unsupported cases, and retain the 11.10 flat-node-count and 11.11 no-static-repaint gates. Isolated panel projections or headless tests alone do not establish Editor 1.x parity.

### Phase 11 additions — broadcast CG editor parity (13 September 2026)

**Status: Planned.** Tracked by 11.25–11.28. Added after comparing the Editor
against the authoring UI of established broadcast real-time graphics tools:
Vizrt (Viz Artist Stage/Directors, Viz Trio Page Editor and Tab Fields, Viz
Template Wizard variants), Ross XPression (Scene Director, Take Item Template
Data, Font Manager), Singular.live Composer (In/Out timelines, Control Nodes,
subcompositions), and the CasparCG ecosystem (Loopic, the OGraf typed template
definition). These four rows are the modules that survived that comparison as
genuinely missing rather than merely different.

- **11.25 exists because the contract is already half-committed.** `MOTION_PHASES`
  (`in`, `out`, `hold`, `continue`, `update`) is in `Shared/contracts/src/mcp.rs`
  and `MotionPhases` in `design_system.rs` — but only presets speak it. The scene
  timeline is one linear span, so an authored scene cannot say where its take-in
  ends and its take-out begins. Every tool surveyed models this. Without it
  Playout (Phase 12) can only cut.

- **11.26 is the typed handoff Phase 12 consumes.** Four independent tools
  converged on the same idea: Viz Trio Tab Fields, XPression's Template Data
  tab, Singular Control Nodes and Loopic's OGraf definition all let the author
  declare which properties an operator may drive. 11.19 binds data *into*
  properties; nothing declares the outward contract. Invariants 4 and 5 split
  authoring from taking, so this interface is load-bearing rather than cosmetic.

- **11.27 separates the template from a filled instance**, as Viz Trio's Page
  Editor and XPression's take items do. A filled page must never mutate the
  template it came from.

- **11.28 is a named applyable style, which design tokens are not.** 10.x tokens
  are defaults; Viz's Fontstyle Editor and XPression's style reuse are saved
  bundles an author applies. 11.28 resolves tokens rather than copying them, so
  the two do not become two sources of brand truth.

**Deliberately not added, and why.** Rundown and playlist authoring belong to
Playout (Phase 12) — CasparCG's client, SOFIE and Singular Studio all place it
in the control application, not the design editor. In-editor scripting (Viz
scene scripts, Singular composition scripts, Loopic actions) is refused because
ADR Part G routes programmatic authoring through MCP agents. A Graphic Hub-style
asset database browser duplicates Phases 7–9. Viz's full spline editor is
excluded by this phase's own "do not copy After Effects complexity" rule.

**Deferred pending a scoping decision, not dropped.** Live data-source connectors
(XPression DataLinq, Viz DataPool, Singular's Sheets widget and Data Streams)
have no home in the plan today: 8.6 makes a data *schema* discoverable and
`Editor/src/bindings.ts` resolves against a static `dataContext`, but no step
authors where live data comes from. The authoring surface would be Phase 11 and
the ingest runtime would not. Subcompositions as addressable overlay units,
template variants and a selectable poster frame are also recorded here as
understood gaps that depend on 11.26/11.27 landing first.

## Phase 12 — Playout UI

Second because the control surface is smaller and the service beneath it is already proven.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `12.1` | Tauri 2 shell | UI | 0.3 | Signed on both platforms |
| `12.2` | Scene manager with Take IDs | UI | 6.1 | Search, import, fetch, direct recall |
| `12.3` | Take list and rundown | UI | 6.4 | Persisted cursor, continue behaviour |
| `12.4` | Transport controls: cue, take, continue, out, clear | UI | 6.2 | Committed frame number shown |
| `12.5` | Confidence monitors, fill and key | UI | 5.4 | Native-resolution tier available |
| `12.6` | Status surface: tier, reference lock, free-run, clock source | UI | 6.5 | Free-run is unmissable |
| `12.7` | Output configuration with refusal reasons shown | UI | 6.5 | A refused live adapter names the failing condition |

## Phase 13 — Parity — the engine renders the viewport

The gap-register item. Only possible once both the engine and the overlay architecture exist.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `13.1` | Measure viewport interaction latency on the existing stream | BE | 5.4 | Handle-drag round trip recorded on target hardware |
| `13.2` | Binary alpha frames | BE | 13.1 | Alpha correct at the viewport edge |
| `13.3` | Picking and bounds metadata from the engine | BE | 13.2 | Hit-testing without a browser renderer |
| `13.4` | Adaptive resolution | BE | 13.2 | Degrades resolution before latency |
| `13.5` | Browser reduced to overlays only | UI | 11.7 | Three.js draws no scene content |
| `13.6` | Pixel gate: viewport equals Program | BE | 4.4 | Byte-identical across the reference set |

> **Milestone.** What a designer approves is what goes to air.


## Phase 14 — Remote engine

Deployment change, not an architecture change — if the earlier phases held the line.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `14.1` | QUIC with rustls; mTLS | BE | 5.1 | Certificates and rotation documented |
| `14.2` | Control plane over the remote transport | BE | 14.1 | Same messages, same semantics |
| `14.3` | Resumable asset transfer | BE | 5.3 | Survives a disconnect mid-package |
| `14.4` | Media codec negotiation by locality and consumer role | BE | 5.5 | Interactive and observational streams differ |
| `14.5` | NVENC encode; VideoToolbox decode on macOS clients | BE | 14.4 | Bandwidth within a LAN budget |
| `14.6` | Two engine instances by role: design and program | BE | 3.2 | Design engine structurally cannot go live |
| `14.7` | Build hash pinned at publish; skew warning in Playout | BE | 7.6 | Version skew is visible, not silent |
| `14.8` | Conformance suite passes at L1 exactly as at L0 | BE | 5.6 | Same suite, remote transport |

## Phase 15 — Output server and genlock

External gate. Cannot be closed by engineering. Started at day one via P.1.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `15.1` | Hardware, SDKs and lab access in hand | EXT | P.1 | Devices on a bench, SDKs licensed |
| `15.2` | DeckLink integration via thin FFI | EXT | 15.1 | C++ confined to the boundary |
| `15.3` | AJA integration | EXT | 15.1 | Same wrapper shape |
| `15.4` | Reference input and lock detection | EXT | 15.2 | Lock state in capability and status |
| `15.5` | ProgramClock slaved to the card timebase; free-run reported | BE | 15.4 | Cadence never a function of transport |
| `15.6` | Scheduled playback in the card timebase | EXT | 15.5 | Frames presented on the reference cadence |
| `15.7` | NDI adapter certification against real receivers | EXT | 15.1 | Documented certification record |
| `15.8` | SRT and OMT adapters | BE | 3.10 | IP output not tied to one vendor |
| `15.9` | 8-hour nightly protocol soak | EXT | 15.6 | Runs clean for a sustained period |
| `15.10` | 24-hour hardware release gate | EXT | 15.9 | Passes on release-candidate hardware |
| `15.11` | Device-loss and driver-reset recovery tests | EXT | 3.12 | Restores without an unrecovered output interruption |

> **Milestone.** The only phase engineering cannot finish alone.


## Phase 16 — Content depth

Feature work that is not release-blocking. Sequenced after parity and reliability.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `16.1` | Video decoder tier: FFmpeg with NVDEC | BE | P.2 | Licence position settled first |
| `16.2` | VideoToolbox decode on macOS | BE | 16.1 | One trait, two backends |
| `16.3` | Transitions beyond cut, dual-target | BE | 3.8 | Dropped-frame behaviour certified |
| `16.4` | Script sandbox on rquickjs | BE | 2.9 | CPU and memory bounded, disposable |
| `16.5` | Lottie import path | BE | 7.2 | Reduces the Adobe dependency |
| `16.6` | 3D: shadows | BE | 3.7 | Separate branch, own pixel gate |
| `16.7` | 3D: transparent depth ordering | BE | 3.7 | Separate branch, own pixel gate |
| `16.8` | 3D: camera parity in Program | BE | 13.6 | Perspective and orthographic match |
| `16.9` | Rasteriser benchmark; Vello evaluated against the gate | BE | 4.4 | Measured on broadcast content, not demos |

## Phase 17 — Gen-AI template factory

Depends only on Phases 1–8 plus the design system. Independent of the certification gates, so it moves at its own pace.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `17.1` | Reproduction test on an already-shipped esports pack | AI | 8.13 | Blind comparison; designer states faster or slower |
| `17.2` | Design system as constraints inside the loop | AI | 10.4 | Agent works in the brand-and-renderer overlap |
| `17.3` | Motion preset library authored by a designer | AI | 11.15 | 10–15 presets covering the common builds |
| `17.4` | Scene assembly agent over MCP | AI | 8.9 | Batch edits arrive as one undo entry |
| `17.5` | Correction capture from the very first draft | AI | 7.6 | Every generated-versus-shipped diff stored |
| `17.6` | Visual critique loop | AI | 8.9 | With-loop beats without-loop in blind ranking |
| `17.7` | Batch generation from a template list | AI | 17.4 | A full tournament pack generated as drafts |
| `17.8` | Zero-edit publish rate reported per class | AI | 17.7 | Reportable metric, per tournament |
| `17.9` | Per-class graduation with a named sign-off owner | AI | 17.8 | One class auto-publishing, with an owner |

---

## Why the order is this order

**Contracts before anything reads them.** Three products developing
against each other serialises three teams on whoever's build is broken.
Against mock peers and a conformance suite, they move independently.

**The pixel gate before anything that changes pixels.** Capture the
baseline first or the reference is gone permanently.

**The MCP surface before the interface.** It exercises the whole domain
headlessly, it is the automation story, and it means the interface gets
built against an API that is already proven.

**Research before the interface, not after.** Phase 11 builds against the
constraints Phase 9 produces. Starting Phase 11 first means rebuilding it.

**External gates started on day one.** Hardware, SDKs, lab time and
licensing have the longest lead time in the plan and no amount of
engineering shortens them.
