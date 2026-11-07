# GrapiX — Sequenced Build Plan

Built from scratch, in dependency order. GrapiX is After Effects-style
composition authoring with a Scene Manager, plus XPression/Viz-style live
playout; the Render Engine owns time and Program pixels. Backend, contracts
and platform work come first because everything else reads them, and the
application is operable and automatable before it is clickable.

| | |
|---|---|
| **Status** | In execution |
| **Date** | 9 September 2026; direction amended 15 October 2026; decisions recorded 16 October 2026 |
| **Tracker** | `progress.html` — keep it in the repo, commit `progress.json` |
| **Rule** | A phase does not start until every dependency listed in it is done. |

**Tracks:** `CON` Contracts · `PLAT` Platform · `BE` Backend · `UI` Interface · `RES` Research · `EXT` External gate · `AI` Gen-AI

---

**254 steps across 19 phases.**

**Product direction — 15 October 2026 (user):** GrapiX combines After
Effects-style composition authoring with Scene Manager and live broadcast
playout like XPression/VizRT. Authoring covers layers, editable properties,
keyframes, curves, effects and composition previews. Scene Manager groups
multiple independent graphics in one saved container. Playout cues, takes,
continues and clears published graphics; the Render Engine owns the frame
clock and production pixels sent to outputs, including DeckLink SDI (Phase
15). This is a functional product requirement as well as an interface
reference. Editor, Playout and Render Engine keep their existing authority
boundaries. SDI readiness requires the SDK, hardware and timing tests in
Phase 15; discovering a card does not satisfy those gates.

**Authoring follow-up — 15 October 2026 (user):** Properties must expose
inline value edits and visible keyframe controls, with values evaluated at
the playhead and edits to animated properties keyed there. Scene Manager
must show a preview for each graphic. Current authoring thumbnails reuse the
existing viewport and explicitly identify partial previews; engine-backed
preview/Program parity remains 13.5/13.6. These follow-ups belong to 11.9,
11.21, 11.63 and 11.64 and require desktop interaction verification.

**Product amendment — 15 October 2026:** the user removed the design-system
concept from the current authoring workflow. Scene Manager is now one saved
container holding multiple independent graphics, each with its own layers,
timeline and undo history (11.64), analogous to compositions inside an `.aep`.
Phase 10 and design-system-only portions of earlier rows are historical
compatibility work, not requirements for creating, saving or browsing graphics.
Do not introduce new token-ingest, brand-pack confirmation or drift workflows.
Existing saved metadata remains readable and is not deleted by this change.

**Decisions — 16 October 2026 (user).** From the Editor UX/direction and
Playout workflow reviews (`docs/proposals/GrapiX-Editor-UX-Direction-Review.md`,
Decisions Q1–Q8; `docs/proposals/GrapiX-Broadcast-Playout-Workflow-Review.md`):
Phase 9 validates rather than gates (Q1); the engine preview comes before
further Editor polish, so 11.41 is next and 11.65 follows it (Q2); explicit
save is the only project writer, with crash-recovery snapshots kept apart
(Q3); on-air Update touches only fields marked `liveUpdate` (default false)
and Continue advances a stop point (Q4); operator pages live in Playout, with
the Editor keeping a Test fill (Q5); the glossary is Project → Graphic →
Layer with a "Composition" viewer, and Take, Page and Playout library on the
operator side (Q6); 17.2 uses project variables (Q7); the first release
targets sports/esports with one Program channel (Q8). No existing step
changed state because of these decisions.


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
| `0.11` | Consolidate all project agents into one shared worktree and enforce LLM workspace governance | PLAT | 0.1 | All former worktree heads and pending source edits are preserved in `agent/shared`; only the primary checkout and `agent/worktree` are registered; obsolete agent folders and temp captures are removed from the live project; private settings and legacy source are preserved; workspace guard rejects alternate paths/branches and the product gate passes |

## Phase 1 — Domain contracts

Defined before any implementation reads them. This is what makes three products buildable in parallel.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `1.1` | Scene document schema | CON | 0.9 | Round-trips through both languages |
| `1.2` | Object type catalogue and full property surface | CON | 1.1 | Every authorable object is representable |
| `1.3` | Material model; fit and blend enums as the single source of truth | CON | 1.1 | One enum, consumed by validator, engine and UI |
| `1.4` | Colour types: linear working space, tagged sources, output transforms | CON | 1.1 | sRGB and Rec.709 transforms named and testable |
| `1.5` | Design system token schema | CON | 1.1 | W3C Design Tokens JSON maps in cleanly |
| `1.6` | Motion token and preset schema: phases, 0–1 time, stagger modes | CON | 1.1 | A preset resolves to frames at any rate |
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
| `2.8` | Font subsystem ported across unchanged | BE | 2.7 | All sources resolve on Windows (the macOS run was dropped from this step by user decision, 18 Oct 2026) |
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
| `3.14` | Pinned EffectCraft render/GPU compatibility spike on Windows (ADR-0003); no production cutover | BE | 3.1, 3.4, 4.4 | Pinned, reproducible evidence for each executed ADR-0003 gate, each reported PASS/FAIL/SKIP with limitations; no skipped GPU execution counted as PASS; a failed required gate halts the spike; the adoption decision is recorded in ADR-0003 |
| `3.15` | Project working colour space: compositing follows the project's declared colour space | CON | 3.3, 7.1 | `WorkingColorSpace` offers sRGB (display-referred) and linear sRGB, with no default. A project declares one — new projects sRGB; a project created before 3.15, with no declaration, reads as linear sRGB, the space it was authored in — and an unreadable declaration refuses by name. Every scene carries its project's space (scene schema 3; a schema 1 or 2 scene upgrades losslessly to linear sRGB, proven against a witness saved by the schema-2 build), and reading or writing a scene whose space differs from its project's refuses by name. The engine converts tagged sources into the scene's space once, composites there, and applies the sRGB Preview or Rec.709/BT.1886 Program transform once: a rendered 50% black-over-white overlap gives each space's independently computed reference value to ±1 code value at both outputs, and the reference operations for anti-aliased coverage, gradient interpolation and blur averaging, which 3.16, 3.17 and 3.22 must match, are tested in both spaces. The pixel-gate baselines and the colour ramp are unchanged; ADR-0002 B.1 and the contract docs state the rule |
| `3.16` | GrapiX-owned GPU compositor: layer stack, transforms, opacity and composition on the GPU | BE | 3.1, 3.4, 3.9, 3.13, 3.15 | Preview and Program frames for a fixture scene are composited on the GPU from SceneDocument's effective order across object types, in the 3.15 working space; pipelines and resources are built at prepare, never per frame (invariant 35); a trace of the reference lower third shows no CPU full-frame rasterisation on the frame path; an unsupported mapping refuses by object id and document path; a stage above the texture limit composites seam-free from tiles (invariants 37, 38) |
| `3.17` | GPU 2D drawing: paths, strokes, gradients and images | BE | 3.5, 3.16 | Fills, strokes (joins, caps, dashes), linear and radial gradients and tagged image quads draw on the GPU with anti-aliasing and match their CPU reference within the 4.4 threshold; gradients are no longer refused; lyon-on-GPU and Vello are benchmarked on the reference workloads and the chosen drawing backend is recorded with its measurements |
| `3.18` | GPU text: real glyph outlines from packaged fonts | BE | 3.6, 3.16, 3.17 | Text shaped by cosmic-text from package-owned font bytes only is drawn on the GPU as glyph outlines, replacing advance rectangles; Latin, Telugu, Hindi and mixed-bidi fixtures match reference glyph pixels within the 4.4 threshold; a missing glyph refuses (invariant 66); no installed system font is read |
| `3.19` | GPU masks, clip groups, track mattes and trim paths | BE | 3.16, 3.17 | Masks (add, subtract, intersect, difference; feather; expansion), clip groups, alpha and luma mattes and trim start/end/offset render on the GPU and match CPU references; the scene contract's trim values are honoured (they are silently ignored today); an unsupported combination refuses by name |
| `3.20` | Full blend-mode set on the GPU | BE | 3.15, 3.16 | The contract's blend modes cover the 27 Photoshop and the After Effects modes, ported from EffectCraft's formulas with attribution; each composites on the GPU in both working spaces and matches its CPU reference per mode; no declared mode is refused; NaN or infinity never reaches output, with EffectCraft's non-deterministic DX12 32-bit NaN failures (Darken on 11 October, ClassicDifference on 12 October) kept as regression tests |
| `3.21` | GPU Program/Preview output: encode, quantise once, bounded asynchronous readback | BE | 3.11, 3.15, 3.16 | Frames leave the GPU through the 3.15 output transforms with exactly one quantisation, via a bounded asynchronous readback ring that never stalls the Program clock; a lower third, a scorebug with about 20 live text fields and a full-screen stats page each render at p99 ≤ 10 ms end to end at 1080p50 and 2160p50 on DX12 on the reference GPU (ADR-0003's proposed target, or the confirmed show target if set first), with the method recorded; a headless render (11.41) issued while Program runs causes no dropped or late Program frame, shown by the engine's frame-timing report over a timed run (invariant 14; moved here from 11.41 by user decision, 16 Oct 2026; the conformance timed run already measures it) |
| `3.22` | Typed effect registry and the broadcast effect set on the GPU | BE | 3.16, 3.20 | Effects are a contract enum with typed parameters, generated TS and JSON Schema, and no string-keyed parameters; an unknown effect refuses by name. First set: Gaussian, box and directional blur, glow, drop shadow, fill, tint, gradient ramp, levels, curves, hue/saturation, brightness/contrast, exposure, and linear, radial and iris wipes, as GPU kernels ported from EffectCraft with attribution; each matches a CPU reference within the 4.4 threshold on DX12 and Vulkan, and every parameter is keyframable |

**11 October 2026 — render-core evaluation authorized.**
[ADR-0003](docs/adr/0003-effectcraft-render-core.md) records the preferred
candidate and preserves GrapiX's ownership boundary. `3.14` begins with an
isolated Windows release build and shared-device pixel probe, using an
explicit candidate toolchain and external temporary checkout. Product
dependencies and output routing do not change in this step. Preview and
Program cutovers require subsequent plan updates and the ADR's acceptance
evidence; existing `done` entries are not evidence that a GPU compositor
already exists.

**GPU-first is an acceptance requirement.** Main production drawing,
transforms, masks, effects and composition must run primarily on the GPU.
CPU scene logic and bounded preparation remain allowed; CPU full-frame
rasterisation or silent fallback cannot qualify the candidate. `3.14` must
report this gate even if a cached-composition benchmark passes.

**12 October 2026 — render-core decision (user).** The main render path is
GPU-first and GrapiX-owned. Whole-core adoption of EffectCraft's `render` and
`gpu` crates is halted: upstream rasterises text, shapes and masks on the CPU
by design, its GPU suite fails on DX12, and 4K misses the 50p frame period
even for two solid layers (ADR-0003). EffectCraft remains the preferred
**component source** — WGSL kernels, blend formulas, layer-style and shading
algorithms, path operators and importers — ported into GrapiX-owned code with
attribution, each under the step that owns it (ADR-0003's reuse catalogue).
Steps `3.15`–`3.22` own the GPU compositor. Until they are done, no `done`
entry is evidence that GrapiX draws on the GPU.

**Colour follows the project (user, 12 October 2026).** Compositing happens in
the project's declared working colour space, not in linear light
unconditionally. This amends ADR-0002 B.1's "render internally in linear,
always" and is owned by `3.15`. `3.3` stays done for what it verified: tagged
sources, the two output transforms and the colour ramp.

**3.15's done-when, corrected 13 October 2026.** As first written it asked
for a rendered anti-aliased edge, gradient and blur, which the engine cannot
draw until `3.17` and `3.22`; it could never have closed before its own
successors. The overlap is checked as an engine render; coverage,
interpolation and averaging are checked as working-space reference
operations that the GPU steps must match. **Named gap:** the Editor's Three.js
viewport (11.6) does not read the scene's declared space, and which space its
blending matches is unmeasured (Three.js applies the output curve per
fragment before hardware blending). The engine is the renderer of record;
`13.5` (the engine renders the viewport) closes the gap, unless a measured
browser fix lands first.

**Reopened 13 October 2026 (user) — done steps contradicted by execution.**
Each step's original evidence was re-run and still passes; a probe against
its done-when failed (`memory.md`, 13 October). They are `active` again.
- `3.13` "No silent fallback anywhere": a stroke with `trim_end` 50% renders
  byte-identically to the untrimmed stroke (3,600 lit pixels both times) and
  prepares without a refusal; glTF geometry draws nothing without a refusal;
  and vector objects ignore `opacity` — a rectangle at 50% opacity renders
  fully opaque, without a refusal (found by 3.15's rendered test, 13 October).
  **Closes again when** non-default trim, object opacity on vector paths and
  unloadable glTF geometry each either render correctly or refuse by name, and the conformance refusal audit
  covers both. Drawing trim on the GPU stays `3.19`'s work.
- `3.7`: a glTF holding one real triangle prepares to 0 vertices and 0
  triangles; sphere and torus are 151-triangle fans sharing vertex 0. **Closes
  again when** glTF primitives load their real vertices and indices and the
  sphere and torus are triangulated grids, tested by counts and a silhouette.
- `8.1`: none of the 30 `tools/list` entries carries an `inputSchema`; each
  names a type instead. **Closes again when** every listed tool carries its
  generated JSON Schema as `inputSchema`, checked by a test over every tool.
- `8.9`: `tools/call render.preview` returns a raw `pixels` number array and
  ignores the requested frame. **Closes again when** it answers with an MCP
  image content block (PNG) for the requested frame, or a named refusal,
  checked over JSON-RPC.
- `8.12`: `cargo tree -i gx-write-semantics` shows no dependent; no MCP edit
  carries `if_revision` or an idempotency key. **Closes again when** the
  editor MCP edit path takes both through `gx-write-semantics` and the
  retry-after-timeout test runs against that path.

Done steps that need a reopened step keep their state, because their own
done-when was not contradicted: `4.1` and `7.4` (need `3.13`) and `11.20`
(needs `8.12`). `3.16` now waits on `3.13`.

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
| `7.5` | Design system enforcement: three severities plus override log (historical compatibility; not required for authoring or publish) | BE | 1.5 | Overrides recorded with a reason |
| `7.6` | Package build, verify, publish; design-system version stamped when present (optional, historical) | BE | 1.8 | Publishing is all-or-nothing |
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
| `8.7` | designsystem.* (historical compatibility) and motion.* | BE | 1.6 | Import and commit are admin-scoped |
| `8.8` | validate.* | BE | 7.7 | Refusals machine-parseable |
| `8.9` | render.preview returning a real frame | BE | 3.11 | An agent can see its own output |
| `8.10` | packages.* | BE | 7.6 | Publish returns Take ID and revision |
| `8.11` | playout.* and outputs.*, scope-gated | BE | 6.5 | author token refused on take and configure |
| `8.12` | if_revision, idempotency keys, batch-as-one-undo | BE | 0.8 | Retry after timeout does not duplicate |
| `8.13` | Scope enforcement tests | BE | 8.11 | Every scope violation covered |
| `8.14` | Tiered MCP surface: read, author on draft handles, propose | BE | 8.13, 11.36, 11.38 | Three tiers. **Read:** scenes, assets, bindings, tokens and engine status. **Author:** 11.36 commands only, on a stateless draft handle. **Propose:** submit a changeset to Playout's approval queue (13.7). Targets the MCP 2026-07-28 specification, verified against the official spec and the Rust SDK before coding. A conformance test enumerates every MCP tool and asserts that none reachable by an author- or agent-scoped token can Cue, Take, Continue, Clear or configure outputs, while 8.11's operator-scoped tools stay behind their scopes (invariant 65). An author tool cannot modify a published revision; an unknown schema version is refused (the server fails closed) |

> **Milestone.** The application is fully operable and automatable with no interface at all.


## Phase 9 — UI research

**Validation, not a gate (user decision Q1, 16 October 2026).** Phase 11 proceeded on the After Effects and XPression/Viz references (11.63, 15 October direction); these steps check that work with designers and operators. No Phase 11 step needs a Phase 9 step. The card sort (old 9.4) and three-direction concept test (old 9.6) were dropped.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `9.1` | Artifact teardown of comparable professional tools | RES | P.3 | Vocabulary of density, chrome and controls |
| `9.2` | Recruit designers, operators, producers | RES | P.3 | Segments filled, including macOS-primary designers |
| `9.3` | Contextual interviews in the suite and the control room | RES | 9.2 | Not remote. Lighting and viewing distance observed |
| `9.5` | Usability baseline against the previous build | RES | 9.2 | Timed tasks on the 11.63 workspace, including the disconnected-engine task; the results validate 11.5's layout |
| `9.7` | Synthesis: validation report and anti-pattern list | RES | 9.3, 9.5 | Density, chrome and type-at-viewing-distance findings against the 11.63 workspace, each with a proposed amendment or a recorded no-change |

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
| `11.5` | Dockable workspace | UI | — | Layout follows the 11.63 EffectCraft/After Effects reference (criterion amended 16 Oct 2026, decision Q1; it formerly read "follows the card sort", which Phase 9 no longer gates); 9.5's timed tasks validate it afterwards |
| `11.6` | Three.js viewport: 2D on an orthographic camera plus 3D | UI | 11.4 | A 2D object renders between two 3D objects |
| `11.7` | Overlay layer: handles, guides, selection, marquee | UI | 11.6 | Structured so the engine can take over the raster |
| `11.8` | Object manager treegrid | UI | 11.5 | Hierarchy, visibility, lock, alpha, transforms |
| `11.9` | Type-aware inspector | UI | 11.8 | Multi-select Mixed state, one undo transaction |
| `11.10` | Timeline: virtualised rows, canvas layers, dirty-rect repaint | UI | 11.5 | Node count flat from 100 to 100,000 keys |
| `11.11` | Speed graph and curve editing | UI | 11.10 | Scrub causes no static-layer repaint |
| `11.12` | Material manager | UI | 11.9 | Shared instances, relink, usage lookup |
| `11.13` | Font manager panel | UI | 2.8 | Ported from the 1.x panel (archive branch), not redesigned, and proven by one strict scripted case: several font files (OTF, TTF, WOFF, WOFF2) ingested in a single action into the running Editor, each content-hashed and deduplicated, registered before any text is measured and usable at once; a font leaves the scene only through an explicit Remove action, never implicitly; removing a font still in use is refused naming the objects that use it; ingest and removal each form one undo entry and survive save/reopen; an unresolved font still blocks the take by name |
| `11.14` | Design system panel; tokens as editor defaults (historical compatibility; not part of the 15 Oct authoring workflow) | UI | 10.4 | Palette and type scale are the path of least resistance |
| `11.15` | Motion preset browser; save selection as preset | UI | 1.6 | Library grows from real designer work |
| `11.16` | Live conformance indicator (historical compatibility) | UI | 7.5 | Drift visible as it happens, not at publish |
| `11.17` | Import UI with tier and substitution report | UI | 7.2 | Nothing substituted without being named |

| `11.18` | Editor 1.x panel parity in the Editor 2.0 workspace | UI | 11.5, 11.8, 11.9, 11.12, 11.13, 11.16, 7.1 | Templates/scenes CRUD, object creation and management, object details/properties, fonts, assets and materials are reachable and functional in Tauri; reuse existing modules, preserve selection, validate writes, undo and save/reopen |
| `11.19` | Data binding panel integrated with object properties | UI | 11.18, 8.6 | Discover the data schema; create, edit and remove property bindings, preview sample data, show invalid paths/types explicitly and preserve bindings through save/reopen |
| `11.20` | Editable animation contract and service integration | CON | 1.6, 7.1, 8.12 | Document existing timeline/preset consumers and extend only missing scene channels, easing and validated edit operations; Rust/TS round-trip keys, evaluate rational-rate frames consistently, preserve old scenes and undo/revision semantics without widening preset-only MCP authoring |
| `11.21` | Inspector keyframe diamonds and Auto-Key | UI | 11.9, 11.20 | Position, Scale, Rotation, Opacity, Size and other supported properties show empty/filled current-playhead diamonds; toggling keys and Auto-Key creates or updates exactly one key, with defined first-key/base-value/off behavior, multi-select and undo/redo |
| `11.22` | Selection-driven timeline and keyframe editing | UI | 11.10, 11.21 | Object selection automatically reveals property tracks; expand/collapse, select, drag/move, delete and copy/paste keys with frame snapping, explicit collision behavior and one undo per gesture; preserve flat node count from 100 to 100,000 keys |
| `11.23` | Simple easing, Custom Bezier and starter presets | UI | 11.11, 11.15, 11.22 | Linear, Ease In, Ease Out, Ease In-Out and Custom Bezier persist and evaluate correctly; Fade, Slide, Scale and Pop use the existing preset library, supported parameters and save-selection workflow; advanced curves appear on demand and scrubbing avoids static-layer repaint |
| `11.24` | Spacebar preview and integrated Editor parity verification | UI | 11.6, 11.19, 11.23 | Spacebar smoothly plays/pauses local animation without stealing typing/control shortcuts; verify panel-to-animation workflows, frame-consistent scrubbing, undo/redo and save/reopen in Tauri on Windows (the macOS run was dropped from this step by user decision, 7 Nov 2026), measure playback on the Windows workstation and confirm no Program/output side effects |
| `11.25` | Named animation phases on the scene timeline | CON | 11.20, 11.22 | The scene timeline carries named `in`, `hold`, `out`, `continue` and `update` phases as frame spans over the existing channels, matching the `MOTION_PHASES` vocabulary presets already use; phases round-trip Rust/TS, are authored and previewed independently in the Editor, refuse overlap and out-of-range spans by name, and a scene authored before phases existed still parses unchanged |
| `11.26` | Template control contract: declared operator fields | CON | 11.18, 11.19 | A scene declares which object properties an operator may fill, as a typed, named field list carried on the document; each field names its target object/property, its type and its default, refuses an unknown or non-fillable target by name, round-trips Rust/TS, and is authored in the Editor without widening the preset-only MCP authoring surface |
| `11.27` | Test fill in the Editor: fill a template instance (operator pages are 12.8) | UI | 11.26 | The Editor renders the operator form generated from 11.26's declared fields, fills values against a template, reports a value the field's type refuses rather than coercing it, previews the filled result in the viewport, and saves and reopens named instances without mutating the template they were filled from. Amended 16 Oct 2026 (decision Q5): the panel is renamed Test fill; operator pages and their storage are 12.8's work in Playout. The criteria above were verified earlier and stand for the Editor's test fill |
| `11.28` | Named text style presets | UI | 11.13 | Font, size, tracking, line height, case and fill/stroke are saved as one named, reusable style; applying a style to a text object sets exactly those properties as one undo entry; a style whose font the scene does not carry refuses by name; styles survive save/reopen |
| `11.29` | Multi-scene workspace: scenes as first-class entities | UI | 11.18 | A broadcast carries many graphics, so each open scene is a distinct session owning its own document, selection, playhead, collapse state and undo history; one workspace module lists every open scene and switches the active one; viewport, object manager, inspector, timeline, animation and binding panels are children of the active scene and render it alone; switching preserves each scene's own state, an edit or undo in one scene cannot alter another, and closing a scene with unsaved changes refuses by name |
| `11.30` | Save model: Ctrl+S saves in place, Ctrl+Shift+S saves a new version | UI | 11.29, 11.15 | Ctrl+S (Cmd+S on macOS) writes the active scene to its own file or project entry in place, and a saved preset into the project's preset library in place; it never creates a version. Ctrl+Shift+S (Cmd+Shift+S) is the only way to create a new version: the next free numbered copy (`<name>_v002`, `_v003`, …) is written beside the current one, the previous version is left byte-identical, and the session continues in the new version. Neither shortcut fires while a text field has focus; a failed save keeps the unsaved mark and names its reason |
| `11.31` | One command registry behind every menu, toolbar, shortcut and agent action | UI | 11.30, 11.36 | Every user action is one named command with a label, shortcut, enabled state and refusal reason; the menu bar, toolbar, keyboard shortcuts and the agent surface all dispatch the same command, so a disabled menu item and a refused shortcut give the same named reason; every registry command that changes the document dispatches an 11.36 command; no action is reachable by a shortcut alone; shortcuts never fire while a text field has focus |
| `11.32` | Menu bar and toolbar (After Effects conventions) | UI | 11.31 | A classic in-app menu bar — **File**: New Project, Open Project, Open Recent, Save (Ctrl+S), Save New Version (Ctrl+Shift+S), Save As…, Export package (7.6), Close Scene, Exit; **Edit**: Undo, Redo, Cut, Copy, Paste, Duplicate, Delete (Delete key), Select All; **Composition**; **Layer**; **View**; **Window**; **Help** — plus a slim toolbar of the common commands, identical on Windows and macOS. Exit and Close with unsaved scenes refuse by name until each is saved or explicitly discarded; Delete removes the selection as one undo entry |
| `11.33` | Window menu: every module reachable; tabbed docks and saved layouts | UI | 11.5, 11.32 | The Window menu lists every Editor module and shows, focuses or hides it; a hidden panel is never lost and reopens where it was; panels stack as tabs inside any dock and drag between docks and tab groups; the user can save named layouts, switch between them and reset to the card-sort default; layouts survive restart |
| `11.34` | Floating panel windows | UI | 11.33 | Any panel tears off into its own OS window (e.g. a second monitor) and docks back; the main window stays the only owner of the document, and a floating panel is a projection of the active scene that sends commands through 11.31 — never a second copy of the document; floating windows restore to their monitor and bounds on restart, and fall back on screen when that monitor is gone; closing the main window closes them |
| `11.35` | Workspace modes | UI | 11.33 | Named workspace modes — at least Design, Animate and Data binding — each a saved layout of panels and docks, switched from the Window menu and toolbar without touching the document, selection or undo history; a mode the user rearranges can be saved over or saved as a new mode, and reset to its default |
| `11.36` | Typed editor command model: every authoring mutation is a shared command | CON | 1.12, 7.1 | Every mutation of authoring content is a variant of one command type defined in `Shared/`, with TS generated and a JSON Schema (2020-12) generated beside it for every command; the codegen staleness check covers the schemas. Every mutation surface — the Editor shell's commands, the editor MCP tools, and project-api (4100) if it is built (no server binds 4100 today) — accepts only that type, and no surface accepts a client-supplied whole document. A boundary-guard test fails a build that adds a mutation path outside it, and a conformance test shows the Editor's mock Playout peer receives no command that alters Program or outputs (invariant 60) |
| `11.37` | Undo/redo on the command log | BE | 11.36 | Project-level and per-module undo (Ctrl+Z) and redo (Ctrl+Shift+Z) are built on the 11.36 command log, not on per-module state snapshots. Applying N commands to a fixture scene then undoing all N gives a content hash equal to the original; redoing all N gives the post-edit hash exactly; per-module undo affects only commands tagged with that module, shown by a test with interleaved commands from two modules. 11.29's per-scene isolation and 11.9's one-transaction multi-select still hold |
| `11.38` | Immutable, content-hashed scene revisions with review state | CON | 11.36, 6.3, 7.6 | Publishing creates an immutable revision identified by a content hash, carrying a state of `draft`, `proposed` or `approved` that only a human sets. Publishing the same content twice gives the same hash; changing one property changes it. Playout loads revisions by pinned hash only (invariant 61): the Playout mock refuses an unknown or unpinned hash by name (`RevisionMismatch` or a new named code), the real Playout service refuses identically, and the conformance suite confirms both. Invariant 30's additive, all-or-nothing publish still holds |
| `11.39` | Asset provenance and licence fields | CON | 11.36, 2.7 | Every asset record in a `.gpx` project carries origin (`human`, `tool` or `model`), tool or model name and version, provider, licence class, optional prompt hash, source references, approving user and timestamp, and an optional C2PA manifest reference; the fields may be empty for human-made assets, but the schema exists. The `.gpx` schema version is bumped and a migration test upgrades a pre-11.39 project losslessly; save and reload preserve every provenance field byte-for-byte; importing through the asset manager fills `origin` and the tool name automatically |
| `11.40` | Component registry and project variables | CON | 11.36, 11.41 | Named project variables (colour, font, spacing, motion duration and easing) are referenced by name from objects instead of copied; a registry holds reusable components (scorebug, lower third, player card, bracket, …) with typed slots. Changing a variable updates every bound object, shown by 11.41 headless renders of a fixture scene before and after; deleting a variable still referenced is refused by name; components and variables round-trip through `.gpx` save/load. Design-system tokens are not required (15 Oct amendment) |
| `11.41` | Headless render entry point in the Render Engine | BE | 11.38, 3.13, 5.6 | One control request renders revision X at frame N to an image; the golden-frame gate and 8.9's `render.preview` use it, and thumbnails (11.65), approval previews (13.7) and Phase 13 parity use it when they land. The same revision and frame rendered twice on one machine and driver is byte-identical; the cross-machine tolerance is defined in this step's verification record and tested; the engine mock refuses exactly what the engine refuses, e.g. an unknown revision (invariant 45). The Program-timing criterion moved to 3.21 (user decision, 16 Oct 2026): the software Program path cannot hold cadence, so it cannot be shown here |
| `11.42` | Lint framework and first rules | BE | 11.36, 11.41 | A lint command returns structured findings: severity, rule, object and fix hint. First rules: title/action-safe violation; missing glyph for any bound field or target language; text overflow against a worst-case string fixture (longest player names, CJK, Arabic RTL); required template field left unbound. Each rule has one failing and one passing fixture, run as tests. A missing glyph is a refusal-class finding, never resolved by a silent font fallback (invariant 66). Refusal-class findings block publish (7.6) and preflight (7.7); the rest warn. Findings use the 0.6 refusal structure (condition, cause, fix), so 11.58 renders them unchanged |
| `11.43` | Project settings, explicit save and single-file `.gpx` packaging | UI | 11.18, 11.29, 11.30, 11.36, 11.37, 11.38 | Work is saved as a `.gpx` project first. Scene create, rename, duplicate and delete are 11.36 commands, undoable through 11.37; scene settings cover resolution (1080p first), rational frame rate, duration, alpha on/off and background. Unsaved work cannot be published (named refusal); a non-rational frame rate cannot be entered and the attempt is refused. **Explicit save is the only project writer** (decision Q3, 16 Oct 2026): 2.6's autosave ring writes crash-recovery snapshots to a separate recovery folder, never into the project, and they are offered at next launch; 2.6's kill -9 mid-write test still passes |
| `11.44` | Viewport: gizmos, rulers, margins and safe guides | UI | 11.7, 11.36, 11.41, 11.43 | Extends 11.6/11.7. Scene cameras plus an editor camera; move, rotate-XYZ and scale gizmos; single and multi selection; After Effects/Photoshop-style rulers and margins configured in the project tab; title/action-safe guides; an empty scene shows nothing. Every gizmo interaction produces 11.36 commands, never direct state writes; Z position and XYZ rotation visibly change the render, shown by 11.41 headless renders of a fixture scene before and after; guide and margin settings round-trip through save/load |
| `11.45` | Object manager on the command model: parenting, groups, order, unique names | UI | 11.8, 11.36, 11.37, 11.44 | Extends 11.8. The object manager is the authoritative hierarchy driving the viewport, inspector and every scene view; parenting, groups, reordering, show/hide and lock are 11.36 commands and all undoable. A test shows the viewport and inspector reflect hierarchy changes made only through the object manager. A duplicate name is refused by name with a suggested free name (`object1`, `object2`, …) |
| `11.46` | Inspector: per-type property sets, scrub fields, animation stopwatch | UI | 11.9, 11.21, 11.36, 11.37, 11.45 | Extends 11.9/11.21. Each object type in 11.47–11.49 shows exactly its defined property set; numeric fields scrub by dragging and accept negative values, and one scrub is committed as one command, not one per mouse move. Each animatable property carries an After Effects-style stopwatch beside 11.21's current-frame diamond, with no separate Animation tab; toggling it creates a keyframe at the current frame and undo removes it |
| `11.47` | 2D object library: pen paths, masks, clip groups, trim paths | BE | 1.2, 11.41, 11.45, 11.46 | Text, image quad, shapes, pen-tool paths, masks and clip groups (a clip shape plus a content composition), keyframable paths and trim paths. Each object type has an 11.41 golden-frame test; a clip group clips its content correctly in a golden frame; a trim-path animation renders correctly at three sampled frames. This step owns the layer masks that memory rule 24 recorded as unowned |
| `11.48` | 3D object library: assignable-face primitives, extrusion, nulls | BE | 3.7, 11.41, 11.45, 11.46 | Extends 3.7. Real 3D primitives with assignable faces, extruded text and logos, cameras, lights and null/locator objects. 11.41 golden frames show lights, cameras and Z/XYZ transforms affecting the render; assigning a material to one face affects only that face |
| `11.49` | Video layer with alpha | BE | 11.41, 11.45, 11.46, 16.1 | A video layer with alpha, fed by Asset-plane media through 16.1's decoder. A clip with alpha composites correctly in a golden-frame test; a missing media file is a named refusal, never black or a placeholder (invariants 18, 29) |
| `11.50` | One physically lit material type and a material library | CON | 1.3, 11.12, 11.41, 11.48 | Supersedes 1.3's split of `MaterialKind` into solid colour, image, PBR and unlit: one physically lit material type replaces them in Rust, generated TS, validator, engine and UI, still consumed by all three from one Rust definition (the custom `shader` kind is unchanged). Scenes authored with the old kinds migrate losslessly; an unlit lower-third fill renders with no pixel change across the migration (invariant 18). One type covers every fixture in the material test set; an XPression-style library assigns materials to objects and faces and round-trips through `.gpx`; Editor viewport and engine golden frames match within 11.41's tolerance, a forward check for 13.6 |
| `11.51` | Text engine depth: auto-fit, complex scripts, font links | BE | 3.6, 11.13, 11.28, 11.42, 11.47 | Extends 11.13/3.6. OTF, TTF and WOFF files, Adobe font links and CSS embed links resolve through the font manager; tracking, leading and auto-fit/shrink-to-box; complex-script shaping for at least Latin, CJK and Arabic RTL through a HarfBuzz-class shaper. The 11.42 worst-case string fixture renders without overflow or raises an overflow finding; a missing glyph raises a refusal-class finding; Arabic RTL renders correctly in a golden-frame test |
| `11.52` | Asset manager: versioned replace and provenance shown | UI | 2.7, 11.18, 11.39 | Extends 2.7 and 11.18's asset panel. A browser for images, video, 3D and fonts; every asset is a hashed, versioned file on the Asset plane, shown with its 11.39 provenance. Importing the same file twice gives one asset; replacing an asset creates a new version and leaves earlier revisions pinned to the old hash. Resuming an interrupted transfer is 14.3's done-when and is not duplicated here |
| `11.53` | Timeline: named stop points and a looping hold | CON | 11.22, 11.25, 11.36, 11.38 | Extends 11.25's phases, which already give In (`in`), Out (`out`) and the held state (`hold`). A hold phase may be marked looping, and named stop points tell Playout's Continue where to pause. Moving or retiming a key is one 11.36 command; values evaluated at sampled frames match the expected curve exactly in rational time; stop points and the loop flag are carried in the published revision and the Playout mock reads them; Continue on the on-air revision advances to the next named stop point exactly once and never loads a new revision (decision Q4) |
| `11.54` | Template field constraints | CON | 11.26, 11.27, 11.38 | Extends 11.26's declared fields with a range, enum, max length and fallback rule per field; Playout forms, data binding (19.7, 19.8) and the template factory (17.4) fill them. The field schema is part of the published revision; a value outside a field's type, range, enum or length is refused by name by both the Playout mock and real Playout; a fallback rule never produces different pixels without a declared state (invariant 18). Each field also carries `liveUpdate`, default false: Update on air accepts only eligible fields and refuses an ineligible one by name with pixels unchanged; eligibility grants no authority, which stays with operator scope and engine-time intent (decision Q4) |
| `11.55` | Logic: conditional triggers, scene transitions, per-scene JS modules | BE | 6.6, 11.53, 11.54, 16.3, 16.4 | Conditional triggers, transitions between scenes and per-scene JS modules, all running inside 16.4's deterministic sandbox. A fixture trigger fires on the expected frame across two runs; a transition between two scenes renders identically across two runs; any banned API inside a module is refused by name |
| `11.56` | Widgets: clock, countdown, counter, round timer | BE | 11.55, 16.4 | Time is derived from the engine frame count and rational rate, never from the wall clock (invariant 62). At 60000/1001 a countdown shows exactly the rationally computed value after N frames; a long-run test shows zero drift; pause and resume are commands |
| `11.57` | Hash publish to Playout from the engine-rendered preview | UI | 7.6, 8.10, 11.38, 11.53, 11.65 | Builds on 11.65's engine preview monitor (split 16 Oct 2026, decision Q2) and publishes a hashed revision to Playout. Publishing creates a revision the Playout mock lists by hash; the preview frame and an 11.41 render of the same revision and frame match within its tolerance; a conformance test confirms the Editor cannot Cue, Take, Continue or Clear (invariant 4) |
| `11.58` | Console and debugger | UI | 0.6, 11.36, 11.42 | Consoles in the Editor and Playout show every failure with its condition, cause and fix; consoles other than the render engine's run without popping up. Every named refusal code has a console entry with all three parts, and a test enumerates the codes; 11.42 lint findings appear in the console |
| `11.59` | Importers on 2.0 objects: PSD/AI and After Effects | BE | 7.2, 11.39, 11.41, 11.47, 11.48, 11.50, 11.51, 11.53 | PSD/AI and After Effects importers rebuilt on the 2.0 objects (Figma is Phase 18). After Effects precomps import as live scenes, not flattened clips; every imported asset is stamped with an 11.39 provenance record. A fixture file per importer imports and renders with every asset exact in 11.41 golden-frame tests; any unsupported node type produces a named finding, never a silent drop |
| `11.60` | Layer styles: every Photoshop style and its blending options, animatable, on the GPU | BE | 3.19, 3.22, 11.36 | Drop Shadow, Inner Shadow, Outer Glow, Inner Glow, Bevel and Emboss, Satin, Color, Gradient and Pattern Overlay and Stroke, plus fill opacity, knockout, Blend If and several instances of one style, are scene properties with every parameter keyframable, rendered on the GPU in Photoshop's stacking order. Fixture scenes match committed Photoshop reference renders within the 4.4 threshold; the PSD (`lfx2`/`lmfx`) and Figma effect mappings used by 11.59 and 18.4 are specified against them; any style option not yet implemented (for example contours) is a named finding, never dropped |
| `11.61` | Text animators: per-glyph range selectors | BE | 3.18, 11.20, 11.36 | Animators with range selectors (characters, characters excluding spaces, words, lines; start, end and offset; shapes; ease high and low; randomise with a seed derived from the object id) animate per-glyph position, scale, rotation, opacity, fill and tracking through 11.20 channels and render on the GPU from per-glyph instance data without per-frame re-shaping; the selector maths is ported from EffectCraft with attribution; the existing stagger presets are expressed through them; two renders of one frame are byte-identical, and a selector the engine cannot evaluate refuses by name |
| `11.62` | Effects and layer-style controls in the Editor | UI | 3.22, 11.46, 11.60 | Adding, removing, reordering, enabling and duplicating effects and layer styles on any object are 11.36 commands with one undo each; every parameter shows in the inspector with scrub fields and an animation stopwatch; a refused effect or style shows its refusal code and fix |
| `11.63` | EffectCraft / After Effects workspace presentation | UI | 11.5, 11.20, 11.36 | The Editor presents a charcoal workspace with project/layers/assets at left, the composition viewer in the centre, Preview and grouped Properties at right, and a layer timeline below. Menus, creation tools, transport, visibility/lock switches and panel disclosure use the existing command and view-state paths. Both frame readouts use one integer playhead and the scene's rational rate, with fractional timecode labelled NDF. Unanimated objects appear as layer rows; selecting a layer reveals its tracks. Node count remains flat from 100 to 100,000 keys and scrub does not repaint the static layer. Captured Tauri screenshots are compared with the EffectCraft workspace reference, and live create/select/edit, switch, step/play, undo and panel-reopen interactions pass; screenshots or interactions that cannot run are recorded as unverified |
| `11.64` | Scene Manager: one container, multiple independent graphics | UI | 11.5, 11.36, 11.37, 11.38 | A Scene Manager module creates and selects a saved container, adds and saves independent graphics, searches them by name or id, and opens each through the existing Rust command model. Graphic switching preserves separate content, selection, playhead and undo history, including unsaved graphics. The catalog and accessible/agent projections show editing, open, saved, unsaved, unavailable and published-revision status without design-system confirmation, stamps or drift. Existing container/graphic addresses remain compatible and legacy metadata is preserved. Execute a live create-container, add-two-graphics, edit/save/search/switch/undo, restart/reopen check and the complete check gate before marking done. Storage remains the existing project-folder format; single-file `.gpx` packaging remains 11.43 |
| `11.65` | Engine preview monitor in the Editor | UI | 11.41 | The Preview panel shows an engine-rendered frame (11.41) of the active graphic at the playhead, labelled "Engine", within 250 ms of an edit on the reference machine (method recorded); the Three.js viewport is labelled "Draft"; a disconnected or refusing engine shows a named unavailable state, never a stale frame presented as current; parity with Program is not claimed until 13.6. Verified in the running Tauri Editor. Scheduled ahead of 11.31–11.35 (decision Q2) |
| `11.66` | Glossary label lint | UI | 11.63, 11.64 | Every visible Editor label, agent-surface node and MCP tool description uses only the glossary in `docs/README.md` (Project → Graphic → Layer, viewer "Composition"; Take, Page, Playout library; output channel/layer); a test fails on "New scene", "Publish scene" or any term outside the glossary (decision Q6) |

### Phase 11 UI requirements — Editor 2.0 parity and animation

**Status: Planned.** The new requirements are tracked by 11.18–11.24; they do not claim that the existing component-level steps deliver a complete editor. All dependencies listed in a row must be done before that step starts.

**Inspection baseline (12 September 2026):** `Editor/web/main.ts` mounts object-manager and inspector projections and the Three.js viewport. Reusable scene/template, font, material and motion-preset modules exist under `Editor/src`, but are not all integrated into the shell entry point. No interactive timeline module is present there. `Shared/contracts/src/scene.rs` currently stores scene timeline duration; `design_system.rs` already defines normalized motion channels, keys and outgoing easing token references. These are foundations to extend, not systems to replace. Verify current wiring again when implementation begins.

- Visual direction, amended by the user on 15 October 2026: recreate the shared EffectCraft / After Effects workspace structure and presentation under 11.63. Keep advanced panels collapsible and reuse GrapiX's authoring commands and virtualised timeline.

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
scene scripts, Singular composition scripts, Loopic actions) was refused here on
13 September 2026 because ADR Part G routes programmatic authoring through MCP
agents. **That refusal was reversed on 2 October 2026:** per-scene JS modules
now run inside 16.4's deterministic sandbox (11.55), while agent authoring
still goes through MCP. A Graphic Hub-style
asset database browser duplicates Phases 7–9. Viz's full spline editor is
excluded by this phase's own "do not copy After Effects complexity" rule.

**Live data-source connectors — scoped 25 September 2026 as Phase 19.**
(XPression DataLinq, Viz DataPool, Singular's Sheets widget and Data Streams.)
This was deferred: 8.6 makes a data *schema* discoverable and
`Editor/src/bindings.ts` resolves against a static `dataContext`, but no step
said where live data comes from. The user decided on a standalone Data Server
application read by both Editor and Playout; see Phase 19. Subcompositions as addressable overlay units,
template variants and a selectable poster frame are also recorded here as
understood gaps that depend on 11.26/11.27 landing first.

### Phase 11 additions — Editor core and AI readiness (2 October 2026)

**Status: Planned.** Tracked by 11.36–11.59, plus 8.14, 13.7, 13.8, 15.12,
15.13, 16.10–16.13 and 19.10, with folds into 11.31, 15.8, 16.4, 17.4, 17.7,
18.2–18.4, 19.4, 19.6 and 19.8. Merged with the user's approval from
`docs/proposals/GrapiX-Editor-Core-and-AI-Readiness-Proposal.md` (memory,
2 October 2026).

- **11.36–11.42 are foundations:** command model, command-log undo, hashed
  revisions, provenance, token bindings, headless render and lint. The editor
  module rows build on them, and they are cheap now and expensive to retrofit.
- **Overlap rule.** Where a proposal item overlapped a done or active step,
  the new step covers only the missing delta and names the step it extends in
  its Needs. No done step was reopened. Items overlapping a pending step were
  folded into it.
- **Decisions taken at merge.** Per-scene JavaScript is accepted inside 16.4's
  deterministic sandbox, reversing the 13 September refusal above. 8.11's
  operator-scoped Program tools stay; the rule is that no author- or
  agent-scoped tool reaches playout-control. `MaterialKind` collapses into one
  physically lit material (11.50). 2.6's autosave ring is removed (11.43).
  Refusal-class lint findings block publish and the rest warn (11.42). Only
  Admin may approve (13.7).
- **Standing prohibitions, all phases:** no neural frame generation or
  temporal AI upscaling on Program; nothing generative runs at Take time;
  agents never Cue, Take, Continue, Clear or configure outputs. These are
  invariants 60–66.
- The proposal's data-source module was folded into Phase 19, whose Data
  Server owns sources. "Phase 7 done" in the command model's Needs was
  narrowed to 7.1, the only Phase 7 step it reads; 7.2 and 7.3 are import work.

### Phase 11 additions — layer styles, effects and text animators (12 October 2026)

**Status: Planned.** Added at the user's request. 11.60 gives Photoshop layer
styles the owning step `memory.md` rule 24 said they lacked; 3.22 and 11.62
own the effects library; 11.61 owns text animators. All three render on the
GPU compositor of 3.16–3.22 and port EffectCraft algorithms with attribution
(ADR-0003's reuse catalogue). None of them may silently drop an option it
cannot render: a missing capability is a named finding.

## Phase 12 — Playout UI

Second because the control surface is smaller and the service beneath it is already proven. XPression/Viz conventions govern this surface; After Effects conventions govern the Editor.

**First-release scope (user decision Q8, 16 October 2026):** sports/esports first. In scope: overlay layers with channel/layer targeting on one Program channel (12.10) and an as-run record (12.11). **Named out of scope, no rows yet:** MOS/NRCS newsroom integration, mirrored-engine failover, multiple output channels, programmable control panels, XPN/AMCP protocol adapters, switcher automation, GPI/GPO and tally.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `12.1` | Tauri 2 shell | UI | 0.3 | Signed on both platforms |
| `12.2` | Playout library: published graphics by Take ID | UI | 6.1 | Search, import, fetch, direct recall |
| `12.3` | Take list and rundown | UI | 6.4 | Persisted cursor, continue behaviour |
| `12.4` | Transport controls: cue, take, continue, out, clear | UI | 6.2 | Committed frame number shown |
| `12.5` | Confidence monitors, fill and key | UI | 5.4 | Native-resolution tier available |
| `12.6` | Status surface: tier, reference lock, free-run, clock source | UI | 6.5 | Free-run is unmissable |
| `12.7` | Output configuration with refusal reasons shown | UI | 6.5 | A refused live adapter names the failing condition |
| `12.8` | Playout operator fill form and pages | UI | 11.26, 11.54, 12.3 | Publish a graphic with text, colour and required fields; open it in Playout without the Editor project; the form is built from the published package alone; fill valid values, get a named refusal for an invalid or missing required value, save and reopen the rundown and reproduce the same page and revision. A page lives in the rundown, pinned to the published revision, hash and field-schema version (decision Q5) |
| `12.9` | Lower-third operator workflow acceptance (end to end) | UI | 11.25, 11.54, 11.57, 12.1, 12.2, 12.3, 12.4, 12.5, 12.8, 12.10 | In the running Editor, create a lower third with named In/Hold/Continue/Update/Out phases and typed required fields and publish it. In the running Playout, find it in the library, add it to a persisted rundown page, fill it, pass readiness and show it in Preview with its pinned revision and hash; cue, take to Program, update one live-updatable field, continue through a stop point, run Out and clear its layer, recording each engine-committed frame and comparing Preview to Program under the declared tolerance. Repeated requests and a disconnect/restart before send, after send and after reply cause no duplicate take or clear, and reconnect reconciles from engine status. Removing and restoring a font or asset gives a named readiness refusal. `npm run check` passes. Native-resolution monitor claims name the media transport and hardware; hardware tests wait on 15.1 |
| `12.10` | Overlay layers with channel/layer targeting on one Program channel | BE | 1.9, 6.2 | Cue, Take, Update, Continue, Out and Clear carry a `channel` and `layer` target; only the Program channel is accepted and any other channel refuses by name; a bug, a lower third and a ticker on separate layers are cued, taken, updated and cleared independently on one output with deterministic z-order and a named refusal on conflict; a targeted clear removes only its layer when the expected page still matches (decision Q8) |
| `12.11` | As-run record | BE | 2.9, 2.10, 6.2 | Every accepted or refused Cue, Take, Update, Continue, Out and Clear writes one as-run record to the 2.10 JSON Lines audit sink: monotonic sequence, intent id, operator identity and scope (2.9), page, revision, hash, channel/layer target, result and engine-committed frame; replaying a fixture show's records matches the engine's committed events exactly. UI and export follow later (decision Q8) |

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
| `13.7` | Approval pipeline | BE | 8.14, 11.41, 11.42, 13.6 | Changeset → headless engine render (11.41) → lint and conformance gate (11.42) → named human approval → hash-pinned revision (11.38) loadable by Playout. Only the Admin role may approve. A changeset that fails lint cannot be approved; Playout loads only `approved` revisions; the approval record names the approver and the time and is written to the JSON Lines audit trail (2.10) |
| `13.8` | Provenance in use | BE | 11.39, 13.7 | Playout refuses an asset whose licence class is incompatible with the show profile; a per-show AI-usage report is generated; an optional AI-disclosure label element is available. A fixture show profile refuses a fixture asset marked non-commercial; the report lists every model-origin asset used in a show |

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
| `15.8` | SRT and OMT adapters | BE | 3.10 | IP output not tied to one vendor; OMT output passes a receive test |
| `15.9` | 8-hour nightly protocol soak | EXT | 15.6 | Runs clean for a sustained period |
| `15.10` | 24-hour hardware release gate | EXT | 15.9 | Passes on release-candidate hardware |
| `15.11` | Device-loss and driver-reset recovery tests | EXT | 3.12 | Restores without an unrecovered output interruption |
| `15.12` | NDI 6.3 metadata: revision, asset IDs and AI-provenance flags | EXT | 15.7, 11.39 | Revision and asset IDs plus AI-provenance flags are published as NDI metadata, and a receiver reads them back for a fixture frame |
| `15.13` | ST 2110 / IPMX output server | EXT | 14.8 | NMOS IS-04/05, with genlock and PTP owned by the output server. **Done-when not yet defined:** it must be written against the chosen hardware, and PTP's place under invariant 13 (Timing is a cable, never a software transport) settled by ADR, before this step may start |

> **Milestone.** The only phase engineering cannot finish alone.


## Phase 16 — Content depth

Feature work that is not release-blocking. Sequenced after parity and reliability.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `16.1` | Video decoder tier: FFmpeg with NVDEC | BE | P.2 | Licence position settled first |
| `16.2` | VideoToolbox decode on macOS | BE | 16.1 | One trait, two backends |
| `16.3` | Transitions beyond cut, dual-target | BE | 3.8 | Dropped-frame behaviour certified |
| `16.4` | Script sandbox on rquickjs: deterministic per-scene JS | BE | 2.9, 11.36, 11.58 | CPU and memory bounded, disposable. No wall-clock access (`Date.now`, `performance.now`, timers) and no network (`fetch`, sockets); time comes only from the engine frame number and rational rate, data only through bindings, and typed APIs limit which objects a script may touch (invariant 62). A script calling a banned API is refused by name and the console (11.58) shows it; a fixture script driven only by frame number gives identical output across two runs; a script touching an object outside its declared scope is refused |
| `16.5` | Lottie import path | BE | 7.2 | Reduces the Adobe dependency |
| `16.6` | 3D: shadows | BE | 3.7 | Separate branch, own pixel gate |
| `16.7` | 3D: transparent depth ordering | BE | 3.7 | Separate branch, own pixel gate |
| `16.8` | 3D: camera parity in Program | BE | 13.6 | Perspective and orthographic match |
| `16.9` | Rasteriser benchmark; Vello evaluated against the gate | BE | 4.4 | Measured on broadcast content, not demos |
| `16.10` | Generative asset adapters | AI | 11.39, 11.52 | Pluggable generators for images, 3D and video loops, baked offline into hashed assets with a licence class; no GPL or non-commercial model is bundled, and region-restricted models are flagged. Every generated asset carries a complete 11.39 provenance record; an adapter whose model licence class is not set is refused; nothing generative runs at Take time (invariant 63) |
| `16.11` | AI keyer sidecar | BE | 15.6 | Matting runs as a separate supervised process publishing fill+key on the Media plane; the engine uses the latest key that arrives in time and drops late keys (invariant 14). Killing the keyer causes no Program frame drop; the layer goes to its declared "no key" state and the console raises an alarm |
| `16.12` | Gaussian splat layer | BE | 11.48, 13.6 | `KHR_gaussian_splatting` glTF loads with deterministic sorting. Two runs give identical golden frames; the frame-time budget holds at 1080p |
| `16.13` | Interchange: OpenUSD/MaterialX import, OpenTimelineIO export | BE | 11.50, 11.53 | OpenUSD/MaterialX import maps onto 11.50's unified material, and sequencer timelines export as OpenTimelineIO. **Done-when not yet defined:** it must be written before this step may start |

## Phase 17 — Gen-AI template factory

Depends only on Phases 1–8 plus the design system. Independent of the certification gates, so it moves at its own pace.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `17.1` | Reproduction test on an already-shipped esports pack | AI | 8.13 | Blind comparison; designer states faster or slower |
| `17.2` | Brand constraints from project variables inside the loop | AI | 11.40 | Agent works in the brand-and-renderer overlap, using 11.40 project variables (decision Q7) |
| `17.3` | Motion preset library authored by a designer | AI | 11.15 | 10–15 presets covering the common builds |
| `17.4` | Scene assembly agent over MCP: constrained generation | AI | 8.9, 11.40, 11.54 | Batch edits arrive as one undo entry. The agent picks registry components (11.40), fills typed slots (11.54), binds data and adjusts tokens only within allowed ranges; it never invents free-form geometry |
| `17.5` | Correction capture from the very first draft | AI | 7.6 | Every generated-versus-shipped diff stored |
| `17.6` | Visual critique loop | AI | 8.9 | With-loop beats without-loop in blind ranking |
| `17.7` | Batch generation from a template list | AI | 17.4, 13.7 | A full tournament pack generated as drafts; every variant passes or fails the 13.7 gate deterministically, and no variant reaches Playout without approval |
| `17.8` | Zero-edit publish rate reported per class | AI | 17.7 | Reportable metric, per tournament |
| `17.9` | Per-class graduation with a named sign-off owner | AI | 17.8 | One class auto-publishing, with an owner |

## Phase 18 — Figma import at full fidelity

**Status: Planned (added 25 September 2026 at the user's request).** Figma is
the primary design source. "Perfect" is not a feeling; it is defined here as
two measurable things on a real corpus: **(a)** the imported scene renders
within the pixel-gate threshold of Figma's own render of the same frame, and
**(b)** the 7.2 compatibility report names every substitution, with zero
unnamed ones. Anything Figma can express that the engine cannot is refused
or substituted **by name**, never approximated silently (invariant 18). No
Figma desktop or plugin host is required. The source is read through the
Figma REST API and retained beside the template (7.2 "source retained").
Every imported layer stays an ordinary scene object, so every layer is
animatable.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `18.1` | Figma reference corpus | RES | P.3 | At least 20 real broadcast files (lower thirds, scorebugs, full-frames, tickers, vertical social), each with Figma's own PNG render at 1× and 2× committed as the reference |
| `18.2` | Figma REST ingest with the source retained | BE | 7.2, 11.39 | A file key and a token stored in the OS keychain (never in a scene, package or log) fetch the document, components, styles, variables and image fills, with `geometry=paths` and no recursion depth limit; the raw response is stored content-hashed beside the template, so a re-import can be diffed and an offline re-run needs no network; every imported asset carries an 11.39 provenance record |
| `18.3` | Scene boundaries: one Figma frame is one scene | BE | 18.2, 11.29, 11.47 | Each top-level frame the user selects becomes exactly one scene. Its resolution is the frame's width × height, its origin is the frame's top-left, and its background is the frame fill. `clipsContent` is honoured as an 11.47 nested clip composition: content outside a clipping frame is kept but clipped, and never widens the scene. Nothing is re-parented across scenes. Nested frames stay nested groups with their own bounds and clipping. Multi-frame import produces N independent scene sessions |
| `18.4` | Node and property coverage matrix | BE | 18.3, 1.2, 1.3 | Every Figma node type (frame, group, section, rectangle, ellipse, polygon, star, line, vector, boolean operation, text, component, instance, image fill) and property (per-corner radius, strokes with align/dash/cap/join, solid, linear, radial, angular and diamond gradients, image fill modes and crop, drop and inner shadow, layer and background blur, blend modes, opacity, masks, auto-layout resolved to absolute positions, constraints recorded) has a row in a committed coverage table marked **mapped**, **substituted (named)** or **refused (named)**, and each row has a test. Import never stops on an unsupported node: it becomes a named finding and the walk continues |
| `18.5` | Text fidelity | BE | 18.4, 11.13, 3.6 | Per-character style runs, line height, letter spacing, paragraph spacing, alignment, auto-resize modes and text case survive import. Every Figma font is resolved through 11.13 ingest; a font that cannot be resolved blocks the import by name instead of falling back |
| `18.6` | Components, instances and variants | BE | 18.4 | Components import once and instances reference them with their overrides applied. Variants are kept as named alternatives, not flattened copies. An instance's override that the engine cannot express is named in the report |
| `18.7` | Variables and styles to project variables | BE | 11.40, 18.2 | Figma colour, number and string variables and published styles land as 11.40 project variables with provenance, and imported objects reference them instead of copying their values, so a brand change flows through |
| `18.8` | Fidelity gate on the corpus | BE | 18.1, 18.4, 7.3, 4.4 | Every corpus frame's engine render is diffed against Figma's PNG under the 4.4 threshold and the diff is stored with the template (7.3). A regression fails CI. The target is 100% of corpus frames passing with zero unnamed substitutions |
| `18.9` | Re-import updates in place | BE | 18.3, 11.20, 11.19 | Re-importing the same file updates the existing scenes in place, keyed by the Figma node id. Animation channels, phases, bindings and control fields on unchanged nodes are preserved. A deleted node that still carried animation or bindings is reported by name, not dropped silently |
| `18.10` | Import UI for Figma | UI | 18.3, 11.17 | Paste a Figma file or frame link, pick frames from thumbnails, see the coverage and substitution report before confirming, and land in one scene tab per frame |

## Phase 19 — GrapiX Data Server (a DataLinq-class standalone application)

**Status: Planned (added 25 September 2026 at the user's request).** This
resolves the scoping decision deferred in the Phase 11 additions. Live data
lives in its own **standalone application**, like Ross XPression DataLinq
Server. It holds many data sources at once and serves them to both the
Editor and Playout. Because it is a new process in the distributed
architecture, its boundaries are fixed by an ADR before any code (19.1). Two
constraints are carried in from existing invariants and must not be relaxed
by that ADR:
- the engine never fetches data itself, and a take stays intent-based;
- the data a frame was rendered with is recorded with the take, so a frame
  can be reproduced.

| Step | Work | Track | Needs | Done when |
|---|---|---|---|---|
| `19.1` | ADR-0004: Data Server boundaries | CON | 1.9, 5.1 | Accepted ADR fixing: process model (desktop app plus headless service mode), transport (reuses the 5.x control plane and gx1 tokens, 2.9), who resolves a binding at take time (Playout, never the engine), how values reach the engine (as data carried with the take intent), revision pinning of data, and failure policy per field (refuse, hold last good, or warn) |
| `19.2` | Data contract | CON | 19.1 | `DataSource`, `DataTable`, `DataRecord` and typed `DataField` values, plus a source revision and timestamp and a staleness state, defined in Rust (`gx-contracts`) with TS generated; round-trips both ways; a schema change is a named event, never silent |
| `19.3` | Standalone Data Server app | UI | 19.2, 11.1 | Its own Tauri 2 executable, installable separately from Editor and Playout. It lists sources, their status, last update, error and sample rows, and also runs headless as a service on a playout machine |
| `19.4` | Connectors: files and web | BE | 19.2 | CSV, Excel (xlsx), JSON and XML from a file, HTTP (with a poll interval) or WebSocket, RSS/Atom, and manually edited tables. Each connector detects schema drift and names it, and a file watch uses 2.5 |
| `19.5` | Connectors: databases and sheets | BE | 19.4 | SQL through PostgreSQL, MySQL, SQL Server and ODBC; Google Sheets. Source credentials live in the OS keychain and never appear in scenes, packages, logs or the MCP surface |
| `19.6` | Many sources, change propagation and staleness | BE | 19.4 | Multiple sources run concurrently. Subscribers get a snapshot then ordered deltas. The last good value is retained, and staleness past a source's declared limit is surfaced to every subscriber (never silently stale). A deliberately stalled fixture feed produces its declared 19.1 state (hold last good or refuse the update), never a guessed value. Reconnect resumes from a revision without a full reload |
| `19.7` | Editor reads the Data Server | UI | 19.6, 11.19, 8.6 | The Data binding panel browses sources, tables and fields from a running server; binding a property to a server field writes a portable reference, not the value; sample data for preview is a pinned snapshot, so a scene previews offline |
| `19.8` | Playout reads the Data Server | BE | 19.6, 6.2, 6.3 | At cue/take, Playout resolves each bound field from the server and sends the values with the intent. The committed frame records the data revision it used. A missing or stale field follows the 19.1 policy and names the field; a feed value whose type does not match the bound field is refused by name. Output is never blocked on a slow source without saying so |
| `19.9` | Data Server soak and failure tests | BE | 19.8 | Eight hours with at least 20 sources at mixed update rates, source outages, server restarts and network loss; zero silent staleness and zero takes rendered with unrecorded data |
| `19.10` | Live esports data and an AI suggestion lane | BE | 19.8, 11.55 | Esports feeds (GRID or others) ingest into a typed, timestamped model with deterministic triggers; data reaches the engine only as Control-plane intent. Suggestions need producer confirmation unless their class is pre-approved. Replaying a recorded feed produces the same trigger sequence on every run; a suggestion never changes Program without a confirm action or a pre-approved class |

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

**Research validates the interface (amended 16 October 2026).** Phase 9
was planned as a gate before Phase 11. The user superseded that (decision
Q1): Phase 11 builds against the After Effects and XPression/Viz references,
and Phase 9 checks the result with designers and operators.

**External gates started on day one.** Hardware, SDKs, lab time and
licensing have the longest lead time in the plan and no amount of
engineering shortens them.
