# GrapiX Project Memory

Last consolidated: **2026-07-29**  
Repository: `D:\Project KK\Personal projects\GrapiX`  
Current branch: `Basic-v0.2`
Current baseline: **Basic v0.1 checkpoint**; use `git log -1` for its immutable
commit hash.

This is the durable handoff memory for GrapiX. It records product intent,
architecture boundaries, module ownership, completed work, current local work,
verification evidence, and known gaps. Read this before changing architecture.

The detailed chronological log that predates this consolidation remains in
[`docs/project-memory.md`](docs/project-memory.md). The 35-point reviewed
architecture ledger remains authoritative in
[`docs/architecture-review-compliance.md`](docs/architecture-review-compliance.md).

## Status vocabulary

- **Implemented** means code exists and has automated or live verification.
- **Partial** means the contract or a meaningful path exists, but production
  coverage or parity is incomplete.
- **Planned** means the design is documented but the runtime does not exist.
- **External gate** means completion requires vendor SDKs, hardware, or a long
  certification run that has not happened in this checkout.
- Never describe a Partial, Planned, or External-gate feature as
  production-ready.

## Product intent and user direction

GrapiX is a professional real-time broadcast graphics platform with three major
product surfaces:

1. Graphics Editor
2. Sequencer / Playout Controller
3. Real-Time Program Renderer

The intended product is inspired by Ross XPression, Viz Artist, After Effects,
and Photoshop, but it must have its own stable data contracts and native
broadcast runtime.

Important user requirements, preserved as closely as possible:

- “Use XPression concepts.”
- “Dont separte lit and unit and PBR we one have one type of material but
  lights shall apply on it as per physics.”
- “3D shall not be 2d illustrations but real 3D contains and shall have faces
  where images, textures, materials shall be binded or assigned.”
- Scene Inspector is the authoritative view of what the current scene contains.
  An empty scene must have no unrelated layers and no rendered content.
- Properties belong inside Scene Inspector. A separate Animation tab is not
  required.
- Properties acquire keyframes from a clock/stopwatch icon in the After
  Effects style.
- Timeline keyframes must be movable and must support a curve editor and speed
  graph.
- Layer ordering should be managed at the whole-scene/layer level, not through
  repeated up/down buttons on every object row.
- Lights, cameras, layers, Z position, and XYZ rotation must affect the actual
  rendered canvas.
- Materials must be reusable physical surfaces. Colour, images, textures,
  opacity, metalness, roughness, and emissive values are inputs to that surface.
- Rulers should follow After Effects/Photoshop conventions. Viewport safe
  margins must be configurable from Project settings.
- Font Manager must support packaged OTF/TTF/WOFF/WOFF2 files, Adobe Fonts
  project links, and allowlisted CSS font links.
- Multiple scene-based sequencers/timelines, transition logic, scene triggers,
  conditional behavior, per-scene JavaScript modules, and a JavaScript SDK are
  required parts of the target.
- The reviewed architecture contains 35 pointers. Every pointer must remain
  tracked; hardware-dependent work must not be falsely marked complete.
- GrapiX must become a master workspace containing two independent product
  applications: `Editor/` and `Playout/`, with reusable contracts under
  `Shared/`.
- The complete existing application must first be preserved as Editor without
  feature loss. Playout is then built as a professional operator-facing scene
  library, Scene Manager, Take List, Preview and Program control application.
- Editor must provide a durable **Publish to Playout** workflow that validates,
  packages and versions every scene dependency and receives structured publish
  progress and acknowledgement.
- Playout must continue from previously published scenes when Editor is closed
  or disconnected and must own take-list/timecode/operator state independently.

## Locked architecture decisions

### Process boundary

```text
Tauri 2 desktop supervisor
  ├─ React + TypeScript editor (WebView2)
  │   ├─ PixiJS editor preview for 2D
  │   ├─ Three.js depth layer for 3D
  │   └─ SVG/DOM authoring overlays and dock UI
  ├─ Fastify local project/API service
  └─ Native Rust + wgpu render daemon
      └─ Program output adapters
          ├─ null output for development/CI
          ├─ deterministic BGRA recording
          ├─ NDI feature gate
          └─ future DeckLink/AJA plugins
```

- The browser/editor renderer is for authoring and Preview.
- The native daemon is authoritative for Program state and Program output.
- Closing or crashing an editor/controller must not stop the last valid Program
  scene from rendering.
- The renderer daemon is a WebSocket server because it is the long-lived
  service; editor and sequencer clients come and go.
- REST is used for project/storage/import/publish operations.
- Renderer control uses the versioned `@grapix/renderer-protocol`.
- The render thread must not perform file/network I/O, parsing, asset decode,
  shader compilation, or unbounded allocation.
- Unsupported renderer features are reported explicitly. Silent fake fallback
  is not acceptable for on-air paths.

### Editor / Playout master workspace

**Approved target; Phase 1 scaffold implemented, source not yet physically
migrated:**

```text
GrapiX/
├── Editor/
├── Playout/
├── Shared/
└── package.json
```

- Editor owns authoring, project/source assets, validation and publishing.
- Playout owns published scene versions, the Scene Manager, take lists,
  page recall, operator data, timecode/automation, Preview/Program control,
  control APIs and output operations.
- Shared owns scene, protocol, rundown, transition, package, shader, SDK and
  common utility contracts and cannot depend on applications.
- The Rust/wgpu daemon belongs to the Playout runtime boundary in the final
  structure and remains authoritative for Program output.
- Editor and Playout are independently buildable/runnable Tauri-capable
  applications with separate storage and recovery state.
- Durable package publication uses HTTP(S) for `.gfxpkg` transfer and a
  persistent authenticated WebSocket for health, progress, acknowledgements,
  library events and control events.
- Publishing uses request/sequence IDs, idempotency, duplicate rejection,
  monotonic scene versions, checksum verification and atomic promotion.
- A newly published scene revision never mutates an already online prepared
  version in place.

The complete specification, including scene library metadata, rundown items,
segments, operator actions, Preview/Program statuses, transition/layer
resolution, timecode, live data, control API, reliability and phased migration,
is in
[`docs/editor-playout-workspace.md`](docs/editor-playout-workspace.md).

Migration order:

1. **Complete:** stabilize, verify and checkpoint Basic v0.1 at `a387f5c`.
2. **Complete:** add root Editor/Playout/Shared workspace scaffolding,
   compatibility scripts, independent build/test entry points, and the
   dependency-boundary gate.
3. Mechanically move the existing application into Editor with no redesign.
4. Extract current shared packages into Shared with compatibility exports.
5. Create Playout shell, storage, scene library, rundowns and segments.
6. Implement Publish to Playout with reconnect/version/idempotency tests.
7. Move native daemon ownership to Playout and expose independent continuous
   Preview plus protected Program.
8. Add timecode, automation, layer conflict handling, T1 transitions and the
   external control API.
9. Complete crash/offline recovery, soak and output/hardware certification.

Do not perform a repository-wide move before step 1 has a recoverable commit.

### Editor rendering

- **Locked:** PixiJS v8 renders 2D content.
- **Locked:** Three.js renders real depth-tested 3D content.
- **Locked initial composition:** stacked canvases, with editor overlays above.
- Pixi/Three construction is behind renderer adapters so a later WebGPU,
  OffscreenCanvas, worker, or CanvasKit implementation does not require a
  feature-UI rewrite.
- CanvasKit remains an escape hatch if Pixi path fidelity or per-frame path
  tessellation becomes a bottleneck.

### Durable scene contract

- `SceneDocument` is the content source of truth.
- `SceneDocument` v1 compatibility rules are frozen in
  [`docs/scene-document-v1.md`](docs/scene-document-v1.md).
- New fields must be optional or normalized with deterministic defaults.
- Saved scenes and `.gfxpkg` files must not rely on editor-only transient state.
- Frontend owns draft/editor state.
- Project service owns persisted revisions and atomic storage.
- Native daemon owns resident prepared resources, Preview selection, Program
  selection, frame clock, and output state.

### Material contract

- GrapiX has one user-facing Standard Material model.
- Canonical material type is PBR/physical.
- Legacy solid/image/unlit/basic-lit identifiers are compatibility aliases and
  normalize to the canonical material rather than remaining separate authoring
  families.
- Lights affect the material through physical response parameters.
- Shader definitions are implementation resources and are not material tiles.
- Per-object and per-face material binding is stored in `materialSlots`.
- Slot `main` is always the primary/legacy-compatible surface.

### 3D parity

- Editor Three.js and native wgpu are not required to be bit-identical.
- Native Program is authoritative.
- Parity is governed by a documented coordinate, material, light, alpha,
  colour-space, blend, sampler, and transform contract with tolerance-based
  tests.
- Real geometry, depth, cameras, lights, transforms, culling, and material
  surfaces must never be replaced by 2D illustrations labeled “3D”.

## Repository and module map

### `Editor/apps/desktop-tauri`

Primary Editor desktop shell.

- Tauri 2 + Rust + Windows WebView2.
- Loads the React/Vite editor.
- Runs the project service on 4100 (owned; stopped on window close).
- **Ensures** `grapix-render-engine` on 4400: starts one if none is running,
  adopts one that is, and never stops it — not even one it started. An authoring
  window may not take a show off air.
- Stages the engine binary as the Tauri sidecar.
- Reports each process's reachability and ownership to the editor status bar, and
  nothing about Program: Program state belongs to Playout and the engine.
- Does **not** restart the renderer, restore Program or touch outputs. That is the
  Engine Host's journal-and-verify path (M3) and Playout's authority.
- Root `npm run dev` targets this app.

### `Editor/apps/desktop-electron`

Retained fallback shell from the earlier desktop phase.

- Wraps the same web editor and can start the project service in-process.
- Not the primary architecture after the Tauri 2 decision.
- Holds no renderer or Program authority at all.
- Preserve it until Tauri packaging and workflows fully replace it.

### `Editor/apps/editor-web`

React/Vite professional editor. Core dependencies are React 18, Zustand,
PixiJS 8, Three.js, resizable panels, JSZip, Lucide, and Tauri APIs.

Important component modules:

- `App.tsx` — application composition.
- `DockWorkspace.tsx` — dock stacks, panel placement, resize, active tabs.
- `MenuBar.tsx` — File/Edit/Insert/Windows/Project/Display/Animation/Help.
- `ReferenceTopBar.tsx` — compact working top bar.
- `TemplatesPanel.tsx` — scene/template catalog and template actions.
- `ObjectLibrary.tsx` — creates base, mesh, primitive, light, camera, layer,
  marker, and group objects.
- `SceneInspector.tsx` — XPression-style object/property hierarchy grid.
- `Inspector.tsx` — selected-object Properties content hosted by Scene
  Inspector.
- `MaterialsTab.tsx` — per-face material selection and unbinding.
- `TimelinePanel.tsx` — dope sheet and speed graph.
- `SequencerPanel.tsx` — multi-scene/rundown authoring surface.
- `AutomationPanel.tsx` — scene rules/scripts/conditional behavior UI.
- `FontManagerPanel.tsx` — packaged and linked font management.
- `CanvasStage.tsx` — authoring interaction, tools, guides, overlays.
- `GpuSceneStage.tsx` — GPU preview stage composition.
- `DesignToolToolbar.tsx` — selection/move/rotate/scale/pivot/pen/type/brush/
  eyedropper/marquee tool selection.
- `ProjectViewportDialog.tsx` — project canvas and safe-margin settings.
- `ImportDesignDialog.tsx` — PSD/AI/SVG/Figma design import review/apply.

Important stores:

- `editorStore.ts` — scene state, history, objects, materials, masks, timeline,
  imports, bindings, hierarchy actions, cameras, lights, and persistence-facing
  mutations.
- `templateStore.ts` — scene/template catalog, selection, open state, view mode.
- `timelineAnimation.ts` — property-channel cloning/removal helpers.
- `dockStore.ts` — dock stacks, panel movement, persistence, activation.
- `uiStore.ts` — active tools and editor UI modes.
- `materialManagerStore.ts` — Material Manager view/filter/selection state.

Important rendering modules:

- `GpuSceneRenderer.ts` — PixiJS 2D rendering.
- `PixiPreviewRendererAdapter.ts` — preview contract adapter.
- `ScenePreviewRenderer.ts` — editor-preview interface.
- `ThreeSceneLayer.ts` — real Three.js meshes, active camera, lights,
  materials, transforms, and glTF loading.
- `sceneMaterial.ts` — resolves material slots/instances/assets into renderable
  objects and per-face surface descriptors.
- `slabGeometry.ts` — XPression-style generated Slab mesh.
- `engineClient.ts` — the protocol v3 engine client used by the Render Engine
  panel and diagnostics. The only renderer client the Editor has.

### `Editor/`, `Playout/`, and `Shared/`

The three-product split is in place (migration Phases 2 and 3, 2026-07-29):

- `Editor/` — desktop shells, `editor-web`, `services/project-api`, Publish to
  Playout.
- `Playout/` — `apps/playout-web`, `apps/desktop-tauri`, `services/playout-control`
  (published scene store, Scene Manager and Take List runtime), `tools/dev.mjs`.
- `Shared/` — thirteen contract packages; see `Shared/README.md`.
- `services/` — `render-engine` (the engine, which owns Program and the output
  adapters) and `render-daemon` (its render core library).

Output adapters deliberately live in the engine, not in Playout: the engine owns
Program, and Playout controls outputs over protocol v3 rather than hosting them.

### `Shared/shared-types`

The central durable TypeScript contract.

Owns:

- Scene objects and object-family discriminated unions.
- Canvas, viewport, guides, safe margins, and profiles.
- Materials, shader definitions, material instances, assets, folders,
  readiness, UV transforms, alpha, blend, depth, culling, and colour-space
  rules.
- Per-face material vocabulary and `getBindableFaces`.
- Scene history and revisions.
- Data bindings and typed live patches.
- Scene timeline, legacy keys, per-property animation channels, tangents, path
  animation, and evaluation.
- Bezier paths, shapes, masks, gradients, paint strokes, and design-tool types.
- Cameras, lights, layers, groups, hierarchy resolution, diagnostics.
- Slab-specific properties and deterministic normalization.
- Fonts, rundowns, sequences, transitions, triggers, automation, and script
  references.
- `.gfxpkg` manifest/preflight-related shared structures.
- TypeScript fixtures consumed by Rust contract tests.

Dependency rule: shared contracts must not depend on applications or services.

### `Shared/render-protocol`

TypeScript source of truth for engine protocol **v3**, and the only renderer
client either application has. Protocol v2's client package was deleted on
2026-07-29.

Envelope safety includes:

- protocol version and message ID (duplicate suppression, so a retransmit is safe)
- non-empty request ID
- strictly increasing per-connection sequence
- timestamp
- engine ID (routing when several engines are connected)
- project ID (permission scoping)
- `requiresAck`, stated rather than inferred
- explicit nullable scene ID/revision/channel context
- acknowledgement/error/capability/status/event envelopes
- stale-sequence, revision and state-precondition rejection

Message groups: connection lifecycle, capabilities, scene load/full-sync/patch/
release, preview, asset, diagnostics, output configuration and the full playout
verb set. `EngineConnection` injects everything time-dependent, so reconnect
backoff, heartbeat timeout, retry and resync are tested without real timers.

Rust protocol parsing in `services/render-engine` must change in the same commit
when this package changes.

### `Shared/render-shaders`

Shared WGSL and machine-readable renderer contracts.

- Uniform byte layouts.
- Transform matrix conventions.
- Premultiplied-alpha rules.
- sRGB/linear colour rules.
- Blend-mode IDs and equations.
- Canonical physical mesh shader.
- TypeScript/Rust byte-layout tests protect drift.

### `Shared/grapix-sdk` (`@grapix/sdk`)

JavaScript authoring SDK for scene logic.

Implemented contract:

- `defineSceneScript`
- bounded condition evaluation
- `GrapixSequenceEngine`
- capability-scoped scene API
- typed action collection
- permission and action-count limits

Security boundary:

- Script references are checksummed and versioned.
- Scripts do not run inside the editor, API process, or native renderer.
- Static import rejects host globals, imports, network, Node/filesystem,
  dynamic code generation, WebAssembly, and shared memory.
- Static rejection is defense in depth, not a hostile-code sandbox.
- Production arbitrary JavaScript remains Planned until a disposable isolated
  worker with CPU/wall-time/memory limits and typed-action-only output passes
  escape and flood testing.

### `Editor/services/project-api`

Fastify project service on local port 4100.

Responsibilities:

- Atomic scene save/list/load/recovery.
- Monotonic scene revisions and backups.
- Asset storage, content hashing, references, validation, and relinking.
- `.gfxpkg` preflight and package building.
- Rundown/sequence persistence and conditional event handling.
- Font import/link validation.
- Scene-script import and static restrictions.
- PSD/AI/SVG/Figma design import pipeline.
- Media/model/After Effects compatibility import reports.
- Automation **evaluation** only: it returns the action plan a trigger would
  produce and never executes it. The renderer-daemon bridge was deleted on
  2026-07-29; it let the Editor Take and configure outputs.
- Operator audit logging and read-only show mode.

Storage safety:

- temp + fsync + rename writes
- safe IDs and paths
- SHA-256 references and package checksums
- backups and explicit recovery
- input magic/type/size validation
- remote binding authentication and Origin checks

### `services/render-daemon` — the render core (`grapix-render-core`)

Native Rust 1.87+ crate using Tokio, wgpu 26, glam, glTF, image, serde and an
optional NDI adapter. Consumed by `services/render-engine` as its render core.
Its own protocol v2 binary on 4200 is retired: nothing launches, packages or
falls back to it, and it exists only so the crate's integration tests can drive
the core end to end.

Main module ownership:

- `config.rs` — environment and runtime configuration.
- `protocol.rs` — Rust protocol v2 envelopes and validation (retired binary only).
- `controller.rs` — command handling, renderer/output state.
- `scene/document.rs` — Rust SceneDocument consumption.
- `scene/lifecycle.rs` — registry and residency state.
- `scene/mesh_prepare.rs` — off-thread mesh/material/texture preparation.
- `renderer/frame.rs` — frame representation/timing support.
- `renderer/gpu.rs` — wgpu device/surface/headless GPU work.
- `renderer/mesh.rs` — mesh buffers and drawing.
- `renderer/pipeline.rs` — cached render pipelines and blend/cull state.
- `asset_cache.rs` — content-addressed CPU/GPU cache accounting.
- `media.rs` — media lifecycle and bounded frame queues.
- `resource.rs` — resource profiles and budget enforcement.
- `output/mod.rs` — `VideoOutput` abstraction.
- `output/null.rs` — development/CI output.
- `output/recording.rs` — deterministic raw BGRA recording.
- `output/ndi.rs` — NDI adapter behind Cargo feature.
- `transport/websocket.rs` — authenticated local WebSocket transport (retired
  binary only; the engine has its own protocol v3 server).

Broadcast loop:

- Rational frame rates; 59.94 is `60000/1001`, never a float.
- Integer deadline schedule prevents long-term frame-rate drift.
- Rendering is on a dedicated thread.
- Output sending is on another thread.
- A bounded two-frame channel prevents output stalls from blocking the render
  clock; stalled frames drop and are counted.
- Render thread uses only prepared resources.

Current resident-scene model:

- lifecycle vocabulary includes UNLOADED, METADATA_ONLY, LOADING, WARM,
  PREVIEW, PROGRAM, EVICTABLE, FAILED
- one protected Program scene
- one protected Preview selection
- default bounded three-scene warm LRU
- revision-checked Preview and Take
- Program/Preview are never evicted by profile tightening

Resource profiles:

- `EDITOR_PREVIEW`
- `PROGRAM_HD`
- `PROGRAM_UHD`
- `LOW_LATENCY`
- `SAFE_MODE`

Profiles declare limits for output, warm/prepared/CPU/GPU caches, textures,
decoders, render targets, 3D complexity, shadows, preview, antialiasing,
background work, effects, and diagnostics.

## Scene and object architecture

Core object families currently modeled:

- text
- rect/quad/background
- ellipse
- image
- line
- shape
- paint
- mesh
- light
- camera
- layer
- marker
- group

All objects share stable identity, layer/depth/stack order, visibility, lock,
opacity, fill/stroke, bindings, material slots, masks, transform, and history
semantics where applicable.

### Transform contract

2D transform:

```text
T(x, y) · R(rotation) · S(scaleX, scaleY) · T(-anchorX, -anchorY)
```

- `x/y` is the anchor's world position.
- Anchor movement compensates position so changing pivot does not visually move
  the object.
- Old scenes normalize to scale 1 and anchor 0,0.

3D mesh transform adds:

- `zDepth`
- `rotationX`, `rotationY`, `rotationZ`
- `scaleZ`
- `anchor3d`
- perspective/depth occlusion

### Hierarchy

- Layers and groups are non-pixel transform containers.
- `childIds` describe hierarchy.
- Resolver enforces one effective parent, prevents cycles, and reports invalid
  references.
- Position, rotation, depth, scale, visibility, opacity, and lock state inherit.
- Effective objects feed both PixiJS and Three.js.
- Scene Inspector renders the same hierarchy.

## Editor work completed

### Docking and workspace

- Fixed center viewport with resizable surrounding modules.
- Left/right/bottom dock areas.
- Stack-aware dock tabs.
- Drag-to-stack and dock-position controls.
- Persistent layout with migration from older layout format.
- Menu commands activate the relevant dock panel.
- UI reskinned to neutral near-black with teal accent and compact broadcast-tool
  density.
- Electron retained, Tauri 2 adopted as primary.

### Templates and Scene Inspector

- Templates start empty.
- New creates and opens a genuinely empty scene.
- Numeric padded IDs such as `001`.
- Editable name/ID.
- Thumbnail and list modes.
- Favorites.
- XPression-style context menu.
- Scene Inspector contains Objects, Properties, Materials, Text, and Data
  Binding views.
- XPression-style hierarchy/property table columns include Alpha, XYZ position,
  XYZ rotation, and XYZ scale.
- Whole-level toolbar owns stack movement, duplication, deletion, and layer
  movement.
- Layer visibility/lock/rename/delete act at layer level.
- Scene content, Inspector content, timeline tracks, and viewport rendering all
  derive from the opened scene.

Resolved critical bugs:

- Empty-scene Inspector/viewport contamination was removed by making opened
  scene contents authoritative.
- Template deletion used a window-global Delete handler. Deleting a material
  could bubble to that handler and delete the selected scene. Template Delete
  now requires focus inside the Templates panel.
- Material Library Delete prevents default, propagation, and native immediate
  propagation before deleting a resource.

### Canvas and design tools

Implemented tool foundation:

- Select (`V`)
- Move (`W`)
- Rotate (`E`)
- Scale (`R`)
- Pivot (`Y`)
- Pen (`P`)
- path selection
- horizontal type
- brush
- eyedropper
- rectangular/elliptical marquee family

Implemented behavior includes:

- object-space move/rotate/scale/pivot gizmos
- axis and free-move handles
- rotation ring and snapping
- independent and uniform scale
- movable pivot with position compensation
- selection bounds and locked-object behavior
- one history transaction per gesture
- pen shape creation, append, close, create-time smooth handles
- real-time cubic preview between clicks
- shape vertex editing foundation
- masks with rect/ellipse/pen creation
- mask modes, inversion, opacity, feather, expansion, animation controls
- guides/rulers and project safe-margin settings
- transform-aware hit testing and overlays

### Animation and timeline

- `SceneTimeline` supplies FPS and duration.
- Legacy object-snapshot keyframes remain readable.
- Typed per-property channels are now primary for Alpha, XYZ position, XYZ
  rotation, and XYZ scale.
- Property stopwatch enables/disables a channel.
- Enabling creates a key at the playhead.
- Editing an animated property updates/inserts that property's key.
- Key diamond toggles a key at the current frame.
- Dope-sheet rows are object/property based.
- Keys move by pointer drag or keyboard.
- Arrow moves one frame; Shift+Arrow moves ten.
- Delete removes the selected property key.
- Speed Graph samples values/second.
- Key frame/value/easing controls are editable.
- Incoming/outgoing temporal handles persist as Bezier tangents.
- Path interpolation has a matched-vertex-count guard and never silently
  performs an invalid morph.

### Rendering fixes

- Fixed reversed Pixi draw order after `removeChildren`.
- Fixed Pixi inline canvas dimensions defeating viewport fit.
- Fixed per-panel renderer destruction clearing global Pixi texture resources.
- Renderer error banner clears after a successful render.
- Extension-less API asset URLs select the correct Pixi loader.
- Null asset resolution falls back safely instead of dereferencing
  `texture.source`.
- Material-assigned 2D objects now update both legacy `fill` and active
  `fillStyle`; rich fill styles no longer hide successful material assignment.
- Canonical Standard Material bindings on rect/ellipse/image objects now enter
  the same Three.js physical-surface path as meshes in the editor. Pixi no
  longer paints a duplicate flattened copy over the physical surface.
- The native daemon now prepares canonical PBR-bound rects and ellipses as lit
  planes, retaining base textures, UVs, opacity, metalness/roughness, emissive
  values, blend mode, and authored scene-light response.
- The viewport uses an editor-only neutral grey checkerboard beneath transparent
  Program pixels. New empty scenes/templates default to transparent output.

## Material system knowledge

Primary document: [`docs/material-system.md`](docs/material-system.md).

### Library and assets

Material Manager is a dockable library with:

- search
- folder/filter navigation
- grid/list view
- thumbnail sizing
- image/model/WGSL import
- content-hashed external asset storage
- material creation and inspection
- one-level material instances
- missing-asset reporting and relinking
- Find Usage
- deletion protection
- compatibility-checked assignment
- whole-object and per-face assignment
- undo/redo integration

The “All” library view contains authoring resources: materials, instances, and
assets. Shader definitions remain under Shaders so they cannot be mistaken for
assignable materials.

Every normalized scene receives one real, assignable, idempotent built-in
Standard Material (`grapix.material.default`). It is not merely the PBR shader
definition.

### Physical material behavior

Canonical material surface supports:

- base colour
- base texture
- opacity
- metalness
- roughness
- emissive colour/intensity
- alpha interpretation/test behavior
- blend mode
- culling
- depth rules
- colour space
- filtering
- clamp/repeat/mirror wrap
- UV offset/scale/rotation/pivot/flip
- texture fit behavior

The physical shader uses Cook-Torrance with GGX distribution, Smith geometry,
and Schlick Fresnel. The native path consumes authored directional, point, and
spot lights.

Implemented fixed-function blend modes in editor and native renderer:

- normal
- add
- multiply
- screen
- darken
- lighten

Overlay, subtract, and complex alpha-mask compositing need a shader pass and
must not be silently aliased to another mode.

### Face binding

`getBindableFaces(object)` is the single source of truth.

- cube: Front, Back, Left, Right, Top, Bottom
- cylinder: Side, Top Cap, Bottom Cap
- sphere/torus: one continuous Surface
- imported model: Whole Model plus imported material elements
- text: All Text
- flat objects: one primary surface
- Slab: Face, Bevel, Extrusion, Back Bevel, Back Face

Face index 0 always maps to `main`.

Whole-object assignment can bind all actual mesh faces. Materials view retains
explicit face selection, range/toggle selection, assignment, and unbinding.
Unbinding a face never deletes the shared material.

## Real 3D architecture and completed work

Primary document: [`docs/3d-engine-architecture.md`](docs/3d-engine-architecture.md).

### Editor Three.js

Implemented:

- true cube, sphere, cylinder, torus, and Slab geometry
- imported glTF/GLB scene loading
- depth buffer and face occlusion
- XYZ translation/rotation/scale
- 3D anchors
- perspective and orthographic cameras
- active camera ID with fallback behavior
- camera target, up, FOV/zoom, near/far
- directional, point, and spot lights
- intensity, colour, range/decay, cone, penumbra, target, optional shadows
- authored lights replace the synthetic fallback rig when present
- per-face and per-imported-material-element assignment
- physical material rendering
- texture loading, filtering, wrap, UV transforms, alpha, and culling

### Imported models

- GLB/glTF import exists in API and editor.
- Asset validation and complexity/VRAM reports exist.
- Embedded model data can be packaged.
- Authored glTF PBR base materials are preserved.
- Whole-model override uses `main`.
- Imported material names become `element:N` bindable surfaces.
- Animated glTF target includes node/skeletal/morph clips driven by scene time,
  not a free-running mixer. Full animation/skinning parity remains Partial.

### Native wgpu 3D

Implemented:

- tessellated primitives
- embedded glTF/GLB triangles
- perspective and depth attachment
- model matrices
- per-surface materials and textures
- culling
- UV transforms and samplers
- physical authored lighting
- GPU pixel smoke tests for rotated/textured cube and multi-material glTF

Still Partial:

- native active-camera parity
- hierarchy/timeline-evaluated camera/light transforms
- shadows
- animation/skinning/morph parity
- transparent mesh depth ordering/depthMode
- unified 2D/3D interleaving
- LOD and hardware parity certification

## XPression-style Slab

The old Slab was only a thin `BoxGeometry`. It now has a generated five-region
mesh in `slabGeometry.ts`.

Properties:

- width/height
- extrusion depth
- corner radius
- corner quality/segments
- horizontal skew
- independent “Skew Texture” UV behavior
- front bevel enabled/size/depth
- back bevel enabled/size/depth
- culling: Cull Back, Cull Front, Double Sided

Material regions:

1. Face (`main`)
2. Bevel (`face:bevel`)
3. Extrusion (`face:extrusion`)
4. Back Bevel (`face:back-bevel`)
5. Back Face (`face:back`)

Geometry construction:

- rounded/skewed front, outer, and back profiles
- independently inset front/back cap profiles
- front bevel ring
- extrusion wall ring
- back bevel ring
- separately triangulated front/back caps
- contiguous material groups aligned to the five slots
- generated UVs, normals, bounding box, and bounding sphere
- bevel Z depths clamp proportionally when their requested sum exceeds total
  extrusion

Legacy scenes without Slab properties normalize to deterministic defaults.

## Cameras, lights, layers, and scene hierarchy

- First added camera can become active.
- Deleting the active camera repairs the active reference.
- Camera properties live in Scene Inspector Properties.
- Lights are actual Three.js lights and affect physical meshes.
- Zero authored light intensity can produce a dark physical surface; materials
  are not secretly relit by an editor fallback when authored lights exist.
- Layer/group containers do not draw scene pixels.
- Children inherit container transforms and state.
- Invalid/cyclic/multiply-parented references are diagnosed safely.

Native parity for active camera and resolved hierarchy light/camera transforms
remains a tracked gate.

## Fonts, sequencing, transitions, triggers, and automation

Primary document:
[`docs/fonts-sequencing-automation-sdk.md`](docs/fonts-sequencing-automation-sdk.md).

### Fonts

Scene font registry supports:

- packaged OTF
- packaged TTF
- packaged WOFF/WOFF2
- allowlisted HTTPS CSS sources
- normalized Adobe Fonts project links

The professional project Font Manager now accepts multi-file OTF/TTF/WOFF/
WOFF2 families, Google Fonts, public CSS/`@import`, Adobe project links, and
direct font URLs. The API parses inert font rules, safely resolves public HTTPS
resources, validates and checksum-deduplicates face bytes, preserves source and
license metadata, and packages them for offline Program use.

The editor owns one `ProjectFontRegistry`: every face is registered with
`FontFace`, loading is awaited before final measurement/render, runtime
loading/ready/missing/invalid/unsupported/error states are visible, and loaded
fonts force a viewport rerender. Text stores a stable `fontId`, per-object
fallback stack, weight/style, and bidi direction. Browser horizontal and
vertical paths use shaping engines and never split complex text into
characters.

The Rust daemon now advertises native text and packaged-font support. Font
bytes load during scene preparation; cosmic-text performs Unicode bidi,
OpenType shaping, combining-mark/emoji handling, fallback, wrap, alignment,
weight, and style before glyphs are composited into Program frames. The daemon
still does not execute remote CSS; the API resolves it to packaged faces first.

### Rundowns and multiple sequences

`RundownDocument` owns multiple `SequenceDocument` values.

Sequences can describe:

- own FPS and duration
- Program/overlay/automation/audio tracks
- scene cues
- start/duration/prewarm frames
- transition references
- conditional trigger rules

Scene-local object animation remains in `SceneDocument.timeline`. Cross-scene
playout belongs to the rundown.

The future on-air sequencer process must own active cursor, timecode lock,
retry/idempotency, and automatic cue advancement independently of the editor.

### Transitions

- T0 cut: Implemented in renderer protocol/runtime.
- T1 mix/dip/wipe/push: Planned/Partial data contract only.
- T2 custom WGSL transitions: Planned with strict manifest and bounded-resource
  validation.

The daemon must return deferred/unsupported for unimplemented transitions; it
must not silently substitute a cut.

### Conditional triggers

Bounded declarative AST supports:

- all/any/not
- exists
- typed comparisons
- event payload, scene data, rundown variables, and literals
- priority
- cooldown
- one-shot behavior
- ordered typed actions

Sources include manual, API, webhook, data change, timer, timecode, keyboard,
and scene event. External production sources require authentication,
normalization, replay protection, and audit.

## Design file and media import

Primary document: [`docs/design-file-import.md`](docs/design-file-import.md).

Unified pipeline:

```text
source file/API
  -> format adapter
  -> normalized design document
  -> GrapiX scenes/assets
  -> compatibility validation
  -> structured import report
```

Implemented adapters/contracts:

- PSD through `ag-psd`
- SVG
- SVG-compatible Illustrator data
- PDF-compatible Illustrator fallback/reporting
- exported Figma REST-compatible JSON
- Figma API URL/key/token path
- glTF/GLB model import
- media validation
- After Effects compatibility reporting

Import policy:

1. exact editable GrapiX feature
2. closest editable feature
3. retained source metadata
4. affected-layer raster fallback
5. never silently flatten the entire document

Reports identify imported/converted/rasterized/unsupported items, visual
differences, missing fonts/assets, warnings, and errors.

`.aep` is not executed at runtime. Lottie/alpha media/image-sequence or
structured conversion are the supported architectural paths.

## Package, persistence, and publishing

Package extension: `.gfxpkg`.

`.gfxpkg` v2:

- strict manifest/version
- scene JSON
- materials
- bindings
- timeline
- local embedded assets
- optional fonts and automation metadata
- renderer/features/fonts/shaders/codecs/memory/fallback declarations
- SHA-256 for every file
- final ZIP reopen and checksum verification
- tamper rejection tests

Package preflight checks:

- missing/unready assets
- material readiness and slots
- renderer feature support
- font reliability
- video/decoder availability
- native omitted-content blockers
- hardware/output capability declarations

Project data lives under ignored `data/`. Do not commit local runtime asset
cache or tokens.

### Publish to Playout

**Implemented path (2026-07-29):** `File > Publish to Playout` posts the
`SceneDocument`, a viewport thumbnail, and the project colour space to
`POST /api/playout/scenes`. Playout stores it as a new immutable version, the scene
manager shows it with its thumbnail and Take ID. Certified by
`npm run certify:publish-takelist` (21 checks). The `.gfxpkg` route below remains the
design for the packaged, checksum-revalidated transfer and is still what
`File > Export Package…` produces; the direct publish is the live path.

Editor publication to Playout is distinct from saving an authoring project:

- Editor builds and preflights a complete versioned `.gfxpkg`.
- Playout revalidates checksums/capabilities, stores it in staging and atomically
  promotes the published version into its scene library.
- Scene identity and revision are preserved across updates.
- Playout reports progress, warnings, failures and final acknowledgement.
- Playout retains previously published versions needed by take lists or Program.
- Local and remote endpoints require explicit configuration; remote operation
  adds authentication, TLS, replay protection and audit.

## Native output status

Implemented:

- null output
- raw deterministic BGRA recording
- output configure/start/stop state machine
- rational broadcast formats
- frame/dropped-frame/render-time telemetry
- NDI adapter source behind `ndi` feature

External gates:

- NDI SDK 6.x compile/run and alpha validation
- representative NDI hardware/network certification
- DeckLink SDK/plugin and hardware certification
- AJA SDK/plugin and hardware certification
- interlaced field rendering
- native video codec/hardware decode
- 8/24-hour soak evidence
- device-loss/restart/fallback timing evidence

Never commit proprietary vendor SDK files or binaries.

## Architecture-review status

The 35-row ledger is intentionally not “all complete”.

Complete areas include:

- actual repository architecture documentation
- separation of preview and authoritative renderer contracts
- strict `.gfxpkg` v2
- atomic/revisioned backend storage
- retention of React/TypeScript/npm/shared-contract direction
- explicit final recommendation and evidence tracking
- refusal to claim hardware certification without execution

Most native runtime, lifecycle, 3D, media, recovery, performance, security, and
certification rows are Partial because meaningful foundations exist but full
production evidence does not.

Hardware certification is an External gate.

The required completion order remains:

1. contracts and compatibility
2. editor-preview extraction
3. daemon control safety
4. scene lifecycle/warming
5. asset/resource lifecycle
6. native feature coverage
7. output adapters
8. recovery and observability
9. deterministic integration/soak
10. hardware certification

## Work chronology

### 2026-08-01 — release build, and the sidecar staging that had silently stopped

Packaged both desktop apps from the working tree. Repo typecheck clean, full `npm test` green,
boundaries pass, root build clean.

**The first pair of installers shipped a stale render engine and the build reported success.**
Hashing the staged sidecars after packaging found `binaries/grapix-render-engine-*.exe` in *both*
apps at `1B6AE044…` (mtime 07-30 09:04:24) while `services/render-engine/target/release/` held
`F7C47AD1…` (07-30 13:54:39) — the engine built *after* the 30 July afternoon Rust work on
`text.rs`, `document.rs` and `scene/mod.rs`. The build script's own recorded stamp showed it had
last run at 07-30 13:59:49 and had not run since, through two subsequent release builds including
the first one today: the crate recompiled, the script did not, and the old copy was bundled.

`cargo clean -p app --release` / `-p playout-app --release` forced the scripts to run, after which
all three copies hash `F7C47AD1…`. Note `fs::copy` on Windows preserves the *source* mtime, so a
staged sidecar's timestamp is the engine's build time, not the staging time — which is what makes
the mismatch legible at all.

I did not establish why the `rerun-if-changed` trigger failed to fire; the engine's mtime
(13:54:39) is older than the script's last run (13:59:49), so cargo was arguably right to skip it,
and the copy made at 13:59:49 nonetheless carried a 09:04 binary. The mechanism is not understood,
so it is not to be trusted — hence rule 88.

**Artifacts** (2026-08-01 00:22 / 00:24): `GrapiX_0.1.0_x64-setup.exe` (7.2 MB),
`GrapiX_0.1.0_x64_en-US.msi` (10.2 MB), `GrapiX Playout_0.2.0_x64-setup.exe` (6.8 MB),
`GrapiX Playout_0.2.0_x64_en-US.msi` (9.8 MB). The Editor `app.exe` embeds
`index-HJ1EZY-H.js`/`index-BX7kMiO4.css`, the content-hashed names of the bundle that greps
positive for this session's UI — the assets themselves are compressed inside the binary, so the
asset name is the evidence, not the string. Playout carries none of the editor-web work; it was
rebuilt so both installers come from one tree.

### 2026-08-01 — the pen drew nothing, and the pen has options now

**The pen's fill was in the scene and was never the field anyone drew from.** `createPenShape`
asked for a `#7c5cff` fill and a white stroke, but passed only the legacy `fill`/`stroke` strings.
`createShapeObject` spreads `createBaseObject`, which sets the *unassigned* `fillStyle`
(`#00000000`) and `strokeStyle` (`#8fa6b6`), and the renderers read the rich style first
(`pixiColorValue(fillStyle, fill)`). So every pen path was filled with fully transparent black and
outlined in grey while its saved `fill` said purple. Confirmed on a live pen shape before
touching anything: `fill: "#7c5cff"` beside `fillStyle: {solid, "#00000000"}`.

`store/objectColorStyles.ts` fixes the class rather than the instance: `withColorStyles` derives
the rich style from a colour a factory names, an explicitly passed style always wins, and
`transparent` becomes `{type: "none"}` rather than a transparent paint. `createShapeObject` runs
both its own defaults and the caller's patch through it — its declared `#f7fbff` stroke had the
same silent disagreement, invisible only because library shapes are born with the stroke off.
This is the same defect the `normalizedObjectFillStyle` text special-case patches for *old saved
scenes*; that stays as the migration path, but new objects no longer create it.

**Fill and Stroke are pen tool options.** `penOptions` in the ui store, both on by default,
surfaced as two checkboxes in the tool options bar with swatches that dim when their half is off.
They set what the next path is painted with *and* apply to the path in hand, so toggling mid-draw
is visible immediately. Both off draws nothing, so the bar says so rather than letting the
operator conclude the tool is broken again.

**Verification.** editor-web 73/0 (+4), typecheck clean, boundaries pass. In the app: a pen shape
created after the fix carries `fillStyle: #7c5cff` and `strokeStyle: #ffffff` against the
pre-fix shape's `#00000000`/`#8fa6b6` in the same scene; both checkboxes flip the in-progress
shape's `fillEnabled`/`strokeEnabled` and the both-off warning appears. **Not visually confirmed:**
the Browser pane was not displayed this session, so screenshots and coordinate clicks were
unavailable and no multi-vertex path could be drawn by hand — the evidence is the scene data plus
the renderer's own `pixiColorValue(fillStyle, fill)` call, not a picture of a filled path.

### 2026-07-31 — per-type Object Inspector properties and per-template dimension conversion

Two asks: the tools were not showing their full properties in the Object Inspector, and a
template's canvas needed converting to custom sizes.

**Six object types had no type section at all.** The Inspector covered the shared transform,
colour and mask properties plus type sections for text, mesh, light and camera. An image had no
`objectFit`, a line had no `points`, a shape had no fill rule or path readout, a paint layer had
no strokes, a marker had no `markerKind`/`eventName`, and a group had no child list — every one of
them a property the object carries, saves and publishes with no way to see it. They are now in
`components/ObjectTypeProperties.tsx`, one section per type.

**Where a property is not drawn, the control says so instead of accepting the value.** Checked
each against both renderers before exposing it. `objectFit`, line `points`, shape toggles, paint
stroke size/opacity/flow/colour, group children and marker fields are consumed, so they are
editable. `fillRule`, `paintBlendMode`, mesh clip playback, `textIndent` and `overflow` are
consumed by nothing, so they render disabled beside a note naming what is missing. Text
decoration is the one preview-only control left enabled, with the note saying the engine's text
renderer does not draw it — image, line, shape and paint are already Editor-only object types the
engine reports as unsupported, so their sections carry that warning rather than implying parity.

**Two copies of one rule had drifted.** `isPropertySupported` existed in both `Inspector.tsx` and
`PropertiesSidebar.tsx`: the first offered `rotationX`/`rotationY`/`rotationZ` on layers and
groups, the second on meshes only. Both were wrong against
`resolveSceneObjectHierarchy`, which inherits `scaleZ` but never X/Y rotation and reads
`rotationZ` from meshes alone — so a layer's bound `rotationX` moved nothing. One definition in
`store/objectPropertySupport.ts`, pinned by tests. The field primitives were duplicated the same
way (one `SelectField` could relabel options, the other could not) and are now
`components/inspectorFields.tsx`.

**The Object Inspector's Text tab was unreachable.** Found while verifying in the app: the text
descriptor listed `Text` as both the type tab and an optional tab, so the strip rendered two tabs
named `Text`. React logged duplicate keys and clicking either selected the same tab. The type tab
already carries the full text editor, so the repeat is removed and `objectInspectorTabsFor`
de-duplicates by name — a repeated name is not cosmetic, it is a tab that cannot be selected.

**"Convert Dimensions…" is implemented.** It had been in the Templates context menu since the
panel was built, raising an alert about a future tooling pass. `lib/convertSceneDimensions.ts`
converts one scene's canvas with three explicit content modes — `fit` (uniform, centred),
`stretch` (per-axis) and `canvas-only` — because converting is an authoring decision, unlike
`conformScene`, which repairs a canvas and must never move an operator's graphics. Only scene
pixels scale: rotation, opacity and the unitless scale factors are left alone, and keyframe
*frames* never move, only the pixel values on the X, Y and depth channels. The open template
converts through a new `convertCanvasDimensions` store action so it is one undo step; a closed one
is written straight to the catalogue. Project Settings still lists the result as needing
conforming when it leaves the project resolution, and the dialog says so before converting.

**Verification.** editor-web 69/0 (was 64, +5 new suites), typecheck 0 errors, `check:boundaries`
passes. Driven in the running app: line/marker/group/text sections render and edit, group child
assignment moves the count 0 → 1, HD 1080 → HD 720 on the open template scaled every object by 2/3
and undid in one step, and 1920×1080 → 1080×1920 `fit` on a *closed* template produced the
predicted 0.5625 scale with a 656.25 px centring offset while leaving the open template untouched.

**Not done:** underline and strikethrough in the native text renderer, so decorated captions still
differ between Preview and Program. Even-odd fill, paint blend and hardness/spacing/roundness, and
glTF clip playback remain unimplemented in both renderers and are disabled rather than lying.

### 2026-07-30 — texture orientation, texture resolution, and two stale certifications

Seven asks in one message about the Editor after the Scene Manager work. Five landed cleanly;
the two rendering ones needed the Rust side too, and chasing them turned up three unrelated
defects worth more than the asks.

**The flip was a parent reflection, not a UV bug.** `ThreeSceneLayer` carried
`content.scale.y = -1` to convert GrapiX's y-down canvas into three.js's y-up world. It places
objects correctly and quietly breaks every textured surface: reflecting a parent mirrors its
children's geometry, so UVs flip *and* triangle winding inverts, and under back-face culling you
see the back face. Together that reads as a texture flipped on both axes - the reported symptom,
and why it looked like a 180-degree rotation rather than one flip. Guessing a compensating
`flipY` would have masked it. The fix is what `docs/3d-engine-architecture.md` already
specified: negate Y in the *positions* (`canvasToWorldY`), leave geometry handedness alone.
Negating an axis reverses rotations about the other two, so `rotationX`/`rotationZ` are negated
and `rotationY` is not - free under a reflection, explicit without one, and invisible until
something is rotated, so it has a test. `projectMeshBounds` composes the identical transform
because selection handles come from it. `projectPoint` used to apply its own `-point.y` "to match
the content root"; with callers converting, that made two owners of one convention, so it now
takes world space. Proved by counterfactual: restoring the mirror made the quad *vanish*
(inverted winding, culled), removing it rendered the probe's TL-red/TR-green/BL-blue/BR-white
exactly as authored.

**"Texture resolutions are ignored" was literally true.** `TextureFitMode` has eight modes, the
inspector offered all eight, `getMaterialReadiness` warned about only `tile`/`nine-slice` - and
the renderers consumed `slot.fit` *nowhere*. Switching `fill` to `original` produced a
byte-identical render (41.18 KB both), so all six "supported" modes were `stretch`. Now
`resolveTextureFit` (shared-types) and `resolve_texture_fit` (mesh_prepare.rs) are one definition
in two languages pinned to the same numbers by tests on both sides, because Preview and Program
sampling different rectangles of one texture is a parity break. Implemented: `stretch`, `fill`,
`crop` (centred cover crop). Refused *and disabled in the UI*: `fit`, `original`,
`pixel-perfect`, `tile`, `nine-slice`. The dividing line is not effort - a cover crop only ever
samples inside [0,1], so clamp and repeat cannot disagree and every renderer can honour it with
the sampler transform it already has; the excluded modes draw the texture *smaller* than the
surface and need a transparent border the material pipeline cannot express. Shipping four of them
as "stretch with a nicer name" is what created this bug. Measured in-app with a circle probe:
`stretch` 76x88 (aspect 0.864, predicted 0.857), `fill` 88x88 (aspect 1.000), area ratio 1.1674
against 1.1667 predicted. Fit applies to planar surfaces and a mesh's `main` face; bevel and
extrusion faces pass no surface rather than a plausible wrong crop.

**A green certification I had not actually run.** `hub`'s port readiness is satisfied by *any*
listener on the port. Port 4400 was still held by the packaged Editor's sidecar from 05:46, so
`engine5` reported "ready" without ever binding, and every certification I ran hit a binary
predating my changes. Confirmed with `Get-NetTCPConnection -LocalPort 4400` and the owning
process's `Path`. **Check who owns the port before trusting a suite that talks to it** - a
readiness probe proves something is listening, never that it is yours. Killing the stale sidecar
and rebinding turned one of my "fixes" from unverified into genuinely verified.

**Two harnesses were asserting on arbitrary order.** Both surfaced only once a fresh engine held
the port. `certify:engine` read `scenes[0].revision` - the engine reports every loaded scene and
their order is not in the protocol, so it was reading a different scene's revision (382, expected
2); it now looks the scene up by id. `status_payload` summed `total_tiles` across every loaded
scene while reporting one stage's `gridColumns`/`gridRows`, so a 25x5 stage reported 126 tiles
(125 + another scene's single tile). `totalTiles` is now that grid's own count; the occupancy
numbers beside it stay cross-scene because that is what they describe. `certify:parity` crashed
outright: it relies on `preview.request` without a `sceneId`, and the engine deliberately stopped
falling back to an arbitrary scene in HashMap order ("a refusal is actionable; a confident wrong
picture on a confidence monitor is not"). The harness loads two scenes and compares them, so it
now names which one it is measuring.

**Verification.** boundaries pass; typecheck 0 errors; JS 0 failing suites; render-core 66 Rust
tests; `certify:engine` **52/0** (was 50/2), `certify:parity` **8/0** +1 documented browser skip
(was crashing), `publish-takelist` 27/0, `ipc` 11/0, `playout-engine` 33/0, `monitors` 21/0,
`take-animation` 9/0, `materials` 76/0. Both desktop apps rebuilt; all five staged
`grapix-render-engine.exe` copies identical at 07:17:43, so the packaged apps carry the fit
change - the `rerun-if-changed` fix from the previous session holding up.

**Not done, and not pretended otherwise:** `fit`, `original` and `pixel-perfect` need a
transparent-border capability in both renderers before they can be honest; they are disabled
rather than lying. The browser-vs-native parity leg remains a documented manual step.

### 2026-07-29 — the retired v2 daemon binary is gone

Asked whether port 4300 belonged to the new engine or the old rust daemon, and to free it if
it was the old one. It is neither: **4300 is `playout-control`**, the Playout control API, and
removing it would take Playout off the air. The port map:

| Port | Owner |
| --- | --- |
| 4100 | `project-api` (Editor) |
| 4200 | the retired protocol-v2 daemon — **was free, now unbindable** |
| 4300 | `playout-control` — current, required |
| 4400 | `grapix-render-engine` — the only renderer |

But the question was worth asking, because the daemon leftovers were real. `services/render-daemon`
still built a `grapix-render-daemon` **binary** from `main.rs` that bound 4200 and drove its own
outputs. Its README claimed the binary was kept "only so the crate's own integration tests can
drive the render core end to end without the engine". **That was false** — `tests/` imports only
`scene` and `renderer`, never `transport` or `controller`. Nothing launched it either: no package
script (`dev:daemon` was already gone), no desktop shell, no service.

Deleted, about 3,250 lines: `main.rs`, `transport/`, `controller.rs`, `protocol.rs` (v2),
`resource.rs`, `asset_cache.rs`, `media.rs`, and `DaemonConfig`/auth-token handling from
`config.rs` — which is where the `4200` default lived. Kept what the engine actually imports:
`scene`, `renderer`, `output`, and the output-format half of `config`. Verified by reference
analysis first: the engine uses only `grapix_render_core::{scene, renderer, output}`.

Dependency fallout, pruned: `futures-util`, `tokio-tungstenite`, `tracing-subscriber` and
`getrandom` were used only by the deleted code. `tokio` dropped from
`rt-multi-thread, macros, net, sync, time, signal` to just `sync, time`, with `macros` and
`rt-multi-thread` moved to `[dev-dependencies]` for `#[tokio::test]` in `gpu_smoke.rs` — so the
engine no longer compiles a multi-thread runtime it does not use.

Also renamed the package `grapix-render-daemon` → `grapix-render-core`, which let the engine drop
its `{ package = ... }` alias. The directory stays `services/render-daemon` so git history stays
attached to the surviving files.

Why it mattered beyond tidiness: a second renderer able to bind a port and transmit is exactly
what invariants 1 and 7 forbid. Leaving it also cost me real time this session — it is the kind
of stale artifact that makes "which renderer am I looking at?" a question at all.

Verification: render-core 6 suites / 0 failures, engine 11 suites / 0 failures,
`--no-default-features` 6/6, `certify:render-core` 3/3, boundaries clean, typecheck 0, 15 JS
suites clean, and `publish-takelist` 26/26 + `take-animation` 9/9 + `monitors` 21/21 against the
rebuilt engine. The `ndi` feature still fails to *build* here only because `grafton-ndi` needs
the NDI SDK, which is pre-existing and documented.

### 2026-07-29 — the animation did not play on take

Reported symptom: "the animation is of 20 frames, that means it is animating from A to B, but
Preview and Program show only B." Two independent causes, and each one alone hid the other.

**1. Nothing advanced the playhead.** `program.rs` kept a private `frame` counter and passed
it to `render_program_frame`, which never wrote it back to the scene. `render_stream_frame`
renders `scene.frame`, and only `handle_cue` (→ 0 or `startFrame`) and `handle_stop` (→ 0) ever
set it. So every monitor was frozen on one frame forever. Measured: five monitor frames over
five seconds, byte-identical.

The renderer was never the problem. `preview.request` with explicit frames 0/5/10/15/20/30
produced five distinct pictures (20 and 30 identical, correctly holding at the last key) while
the implicit frame stayed at 0. `certify:animation` had always passed because it asks for
explicit frame numbers — it proved the renderer and said nothing about the playhead.

Fixes: `Engine::advance_program_playhead(elapsed)`, called from the clock; the clock now ticks
whenever `has_program_scene()` even with no running output, because an operator confirms a
graphic before any SDI/NDI output exists; `handle_take_online` rewinds to 0 so an "in"
animation replays on every take; `handle_cue` refuses to rewind a scene already on Program,
because Preview and Program can name the same `LoadedScene` and share one playhead — a cue
would otherwise yank live air back to the start. `engine.getStatus` now reports each scene's
`frame`, which is how the GPU-free protocol tests observe it.

Advance is by **elapsed** frames, not an absolute number, so each scene is timed from its own
take and a dropped frame moves the animation on by the time that really passed rather than
playing it in slow motion. Measured at 49.9 fps against a configured 50/1.

**2. The monitor started too late to see it.** `preview.streamStart` refuses while a channel
is empty, so a monitor opened before anything was cued sat on the hub's 2 s retry. A 20-frame
animation at 50 fps is over in 0.4 s, so the operator reliably saw only the finished graphic —
which is exactly "shows only B". The hub now acts on the engine's `event.channelChanged`, which
is emitted at +0 ms on take. First frame went from +911 ms to +52 ms.

Also reduced the clock's idle poll from 250 ms to 40 ms: that interval *is* the delay between a
take and the playhead starting, and 250 ms of a 400 ms animation is most of the motion. It only
applies with no running output; real air keeps the loop hot. And the playhead advance moved off
`spawn_blocking` onto a short async lock — it is a counter increment, and sending it through the
thread pool 50 times a second on an idle machine bought nothing.

**Proof:** `certify:take-animation` holds a monitor open across a take and counts distinct
pictures in the window the animation occupies: 7 distinct in the first 400 ms, then one for the
hold. It warms the render path first, deliberately — the first preview frame of a scene costs a
~500 ms preparation, and gating on that would measure a one-off startup cost instead of the
behaviour under test. A frozen playhead fails the warm case just as loudly.

**Time lost to my own tooling, and a diagnosis I had to retract.** Two traps, one real and one
of my own making.

*Real:* a failed `restart` left the **old** build serving 4300, so a fix looked inert while I
hunted it in source. `GET /api/playout/health` now reports `pid` and `buildAtMs` — the mtime of
the bundle the process actually loaded — so comparing it with `dist/index.js` answers "is this
my build?" in one command. Measured drift 0 ms after a clean relaunch.

*Retracted:* I concluded a second `playout-control` was fighting the first for the engine
connection, citing two live processes and a `socket closed (code 1006)` loop. **That evidence
was contaminated.** `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like
'*playout-control*' }` matches the PowerShell running the query, because the filter string is
in its own command line. One of my "two processes" was the query. Re-measured with a filter on
`Name -eq 'node.exe'` and excluding `$PID`: exactly one service, holding 4300, `lastError:
null`, engine clients flat at 4 over 20s with no churn. The 1006 loop was a transient from an
engine restart mid-flight plus a `nohup` instance that died on `EADDRINUSE`; I cannot attribute
it to duplicate services and should not have.

The fix stands on its own merits regardless: a duplicate launch *is* harmful, because
`EngineSupervisor` connects from its constructor while Fastify binds last, so the duplicate is a
phantom engine client for its whole startup and then dies on a raw `EADDRINUSE` stack.
`preflight.ts` probes the port **before** the supervisor exists and refuses with the cause and
the remedy (`GRAPIX_PLAYOUT_PORT`). Proven: exit 1 in 0.3s with the engine's client count
unchanged, so it never connects. `listen` also handles the race and releases the engine first.

`project-api` does not share the hazard: the Editor's engine connection lives in the browser, so
a duplicate there merely fails to bind with nothing to fight over.

### 2026-07-29 — frame transport: the operator monitors show a picture

**The Preview and Program panels had never shown a rendered frame.** They drew a *slate* —
a clapperboard card built from scene metadata. The engine could always stream
(`preview.streamStart` renders JPEGs on its own cadence, certified since the engine went
standalone); the Editor viewport consumed it and nothing else did. The missing piece was a
consumer, not a renderer. The engine README's refusal table claiming
`preview.streamStart`/`streamStop`/`setViewport` were `CAPABILITY_UNSUPPORTED` was stale by
several sessions and sent me looking for work that was already done.

`MonitorHub` in `playout-control` owns one engine stream per channel and republishes it as
`multipart/x-mixed-replace` MJPEG at `GET /api/playout/monitor/{preview,program}`, with
`GET /api/playout/monitors` reporting viewers, cadence and last frame. MJPEG rather than a
WebSocket or base64 over the event bus: an `<img>` consumes it directly, so the browser
decodes off the main thread and two monitors open for a whole show cost no per-frame
JavaScript — and it needed no new dependency.

**Refcounted per channel.** First viewer starts the engine stream, last one stops it, so an
unattended station renders nothing. Proven live: three viewers → one engine stream,
surviving two of them leaving, released on the last. The engine allows four concurrent
streams, so a stream per page load would have exhausted it in four reloads.

**Frames are decoded once** and the same `Buffer` is written to every viewer; the HTTP write
drops on `writableNeedDrain` rather than queueing, because a monitor behind on the socket
must show the next frame late, not a growing backlog of the past.

**Two bugs found by building this:**

1. `PlayoutEngineController.connect()` builds a **new** `EngineConnection` every reconnect
   (`autoReconnect: false` — the supervisor owns retries), so a listener attached with
   `connection.on` silently stopped firing the first time the engine restarted. Event
   subscription now lives on the controller and outlives any socket. Same lesson as the SSE
   refcount fix: consumers must not have to know about connection churn.
2. My first UI gate keyed the picture on `slate !== null`, i.e. on Playout's in-memory
   `programRef`. That record is empty after a control-service restart while the engine keeps
   rendering — so the panel would have said "No scene assigned" over a live Program. Now
   gated on the engine connection alone, with the picture layered *over* the slate so a gap
   reveals the slate rather than a blank box.

**Retry belongs in the hub, not the browser.** The MJPEG connection never needs reopening:
the hub can start the engine stream later and frames flow into the already-open response.
So a panel opened before anything is cued starts painting the moment a scene is taken — no
reconnect, no reload — and one refusal per interval instead of one per client.

**`certify:monitors` measures deltas, not absolutes.** A running GrapiX Playout window is
itself a viewer holding both monitors open, and the harness first reported eight failures
for that reason. It now baselines viewer counts and stream ids, and puts a scene on air
itself if Program is empty rather than depending on `certify:publish-takelist` having run.
16/16 with the operator app open.

**My monitors broke `certify:engine`** — it asserted `previewStreams[0].streamId ===
"stream_e2e"`, true only while nothing else streamed. It now finds its stream by id. A
latent assumption, not a new fault, but worth the note: these harnesses share one engine.

**Then: alpha, and the research that killed the plan.** The ask was to move MJPEG to ffmpeg
with an alpha channel. I started it — engine PNG streaming, VP9 `yuva420p` over WebM to a
`<video>` — then checked how broadcast graphics software actually does this before paying for
it. It does not do this at all:

- **SDI carries no alpha.** Transparency is split into a dedicated physical **key** signal.
- **The key is monitored as a greyscale image**: white opaque, black transparent, grey for
  feathered shadows and anti-aliased text. Ross calls it "Show Alpha"; the switcher routes
  the key to a preview monitor as greyscale.
- **CasparCG and Viz Engine both do the same**: fill on one SDI output, key on the adjacent
  one, recombined by a downstream keyer (DSK) with shaped/straight keying.

Checkerboard transparency is a *design-tool* convention (Photoshop, After Effects), not a
broadcast one. So the correct feature was **fill/key views**, not an alpha codec — and a key
is greyscale, which JPEG already carries. I reverted the PNG streaming, kept MJPEG, and
added `PreviewView { Fill, Key }` as a render mode in `preview.rs`: one branch in the
existing BGRA→RGB loop writing `[a, a, a]`, so zero extra allocation. Correct for shaped and
straight fill alike, because premultiplication scales the colour and never the alpha.

ffmpeg turned out to be the right tool for *measuring* the result and unnecessary in the
product. Measured on `Test-scene-1`: key background `[0,0,0]` (transparent canvas), key rect
`[75,75,75]` = **29%** against an authored opacity of **0.3** — JPEG quantisation only. The
same rect in the fill is `[180,180,180]`, indistinguishable from opaque. The key is the only
place that 30% is visible, which is exactly the operator value.

**Two more real bugs, both found by tooling rather than reasoning:**

1. `reply.raw.writeHead()` **buffers the header until the first body write**, so a monitor
   opened on an empty channel left the client waiting on headers for a frame that might never
   come. The certification harness hung for 300 s on undici's headers timeout; curl had been
   hiding it because frames arrived in ~70 ms. Fixed with an explicit `flushHeaders()`.
2. **Chromium does not close an MJPEG connection when its `<img>` is detached.** Keying the
   element on the view remounted it per switch and stranded the old stream server-side —
   measured as `program/fill` stuck at 2 while `program/key` was 1. One reused `<img>` with a
   changing `src` aborts the previous load. Verified: switching drops fill 1→0, and six more
   switches change nothing.

Certified 21/21 (`certify:monitors`), 39 control-service tests, 5 new Rust preview tests, and
driven in a real browser: PREVIEW on FILL beside PROGRAM on KEY, both painting.


### 2026-07-29 — animation runtime, live Editor link, XPression operator model

**Program was rendering a still image.** The engine had no animation runtime at all:
`render_program_frame(frame)` passed the frame number only as `video.frame_index`, and the
prepared scene was cached on `(sceneId, revision, bounds)`. Program ran at the right rate with
zero dropped frames and never moved. The Editor viewport animated (it calls
`evaluateSceneAtFrame`); the engine did not.

Fixed with `services/render-engine/src/animation.rs`, mirroring the TypeScript evaluator
exactly: per-property channels and legacy keyframes, channels winning; independent per-property
sampling; hold rather than extrapolate outside the keyed range; easing from the *outgoing* key;
bezier tangents overriding named easing. Applied by patching the animatable numeric fields of
already-prepared objects, **not** by re-preparing — full preparation costs 482 ms against a
20 ms budget. Needed two additive render-core functions (`build_frame_quads_from`,
`composite_texts`) because cloning `PreparedScene` per frame would copy font file bytes.
15 unit tests, plus `npm run certify:animation` which compares real rendered pixels at several
frames.

**`preview.request` ignored an explicit `sceneId`** and fell back to `self.scenes.keys().next()`
— an arbitrary scene in HashMap order. Preview could show a scene the operator never selected,
and which one depended on hash ordering. Caught by the animation proof, whose "still" scene
rendered the moving scene's frames. It now honours `sceneId` and refuses when nothing is cued.

**The Editor→Playout link is live.** The library was fetched on mount and then only on an
explicit refresh press, so a published scene sat invisible. `PlayoutEventBus` +
`GET /api/playout/events` (SSE) pushes `library.changed`; the UI refetches. Polling stays as
the floor. Also fixed a leak I introduced: an unmemoised `refreshEngine` in the effect's
dependency array reopened the stream every render.

**The rundown is gone, replaced by XPression's model** — Scene Manager keyed by Take ID plus an
optional ordered Take List. The full table of what moved is in
`docs/editor-playout-workspace.md`, Phase 4b. Take Out and Continue were dead buttons and are
now implemented.

**Scene data cleaned:** 100 scenes to 1. 93 generated "Lower Third Starter", plus fixtures,
empty placeholders, orphan `.gfxpkg`, stale backups and the whole published library. Archive at
`data/backups/pre-cleanup-scenes-*.tar.gz`.

### 2026-07-29 — repository restructure and protocol v2 retirement

Structure and cleanup only; no feature redesign. The full rationale for each removal
is in `docs/editor-playout-workspace.md`, Phase 4a.

**Protocol v2 retired from both applications.** `Shared/renderer-protocol` deleted
outright. Editor lost a dead `RendererClient.ts`, the `renderDaemon.ts` bridge and
every `/api/render-daemon/*` route — which included `take`, `output.configure`,
`output.start` and `output.stop`, so the Editor's own HTTP surface was violating
invariant 4, not just its UI. Editor automation now evaluates and returns a plan;
it never executes. Playout lost `NativeRendererClient` and the runtime fallback,
and `activeRenderer` left `PlayoutRuntimeStatus` because there is one renderer.

**Editor desktop shell rewritten** (`supervisor.rs`, ~600 → ~430 lines). It was a
Program supervisor: it staged the v2 daemon as a Tauri sidecar, watched frame
counters, restarted the renderer, re-took the Program scene and restarted outputs,
and killed the daemon on window close. Every one of those breaks invariants 3, 4
or 5. It now runs the project service (owned) and *ensures* the engine (never
owned, never stopped). Both shells now leave the engine running even when they
started it — asserted by a unit test in each.

**Boundary guard strengthened.** `check:boundaries` previously inspected only the
three domain-root manifests and two hardcoded package names; it would not have
seen `Editor/apps/editor-web` depending on `@grapix/playout-control`. It now walks
every manifest in each domain, derives the forbidden set from what each domain
actually owns, and fails on any dependency or import of a retired package. Both
halves were verified by deliberately introducing a violation.

**Command surface rebuilt.** Root `package.json` went from 28 scripts with stale
aliases and hand-maintained package lists to a flat delegating surface:
`dev/build/typecheck/test` per domain, `test:engine`, `test:core`,
`check:boundaries`, and seven `certify:*` harnesses. Deleted `certify:e2e` and
`certify:soak` with their scripts — both drove the v2 path, and `run-local-e2e.mjs`
still pointed at the pre-migration `services/api-server/dist`, so it had been
broken since Phase 2 without anyone noticing.

**Docs consolidated.** `docs/README.md` states the authority order. Three
superseded documents deleted. `rendering-engine.md` retitled to what it is — the
Editor's *current, temporary* browser viewport — and its roadmap items that belong
to the engine were removed rather than duplicated. The 35-point ledger is marked
historical with a refreshed, measured evidence table.

**Disk reclaimed: ~8.4 GB.** Two stale agent worktrees (7.4 GB; branches kept),
`.codex-run/` (26 MB of logs, one 24.9 MB), a root `target/` holding two scratch
build dirs (983 MB), `data/.codex-test-trash/`, a Chrome smoke profile and stray
logs. `.gitignore` rewritten with the classes that produced them.

**Verification:** 826 automated tests pass (439 Shared, 68 Editor, 9 Playout, 97
render core, 217 engine — Playout gained 4 supervisor tests and 2 runtime tests),
plus `npm run typecheck` and `npm run check:boundaries`.

### 2026-07-05 — workspace/editor foundation

- XPression/After Effects-style fixed viewport and dockable modules.
- Empty template workflow, numeric IDs, thumbnails/list view, context actions.
- Scene Inspector object operations and early timeline.
- Fastify persistence/publishing.
- Electron shell.
- PixiJS GPU preview and Object Library.
- Layer/depth/stack model.

### 2026-07-14 — dock stacks

- Stack-aware persistent dock layout and migration.
- Active tabs, tab switching, drag-to-stack, panel movement.

### 2026-07-15 — native daemon and Material Manager v1

- Rust/wgpu daemon, protocol, rational frame loop, null/NDI seams.
- Shared WGSL contracts and TypeScript/Rust fixtures.
- API bridge and token/origin hardening.
- Material Manager, content-hashed assets, instances, assignment, readiness,
  relinking, usage, and deletion protection.
- Dependency/security major-version refresh.

### 2026-07-16 — viewport fault correction and Scene Inspector naming

- Draw-order, canvas-fit, texture-pool destruction, and error recovery fixes.
- Compact top bar.
- Scene Manager renamed Scene Inspector.
- Layer management and undo integration.

### 2026-07-17 to 2026-07-18 — blend and UV systems

- Six blend modes in Pixi and wgpu.
- Alpha-aware real PNG import fixtures.
- UV offset/scale/rotation, wrap, filtering, and tiled preview.

### 2026-07-22 to 2026-07-23 — face binding and early 3D/path architecture

- Central bindable-face model and face selection.
- Materials tab and atomic multi-face assignment/unbind.
- Per-face preview regions, then real 3D plan.
- Typed animation engine and pen/path work.

### 2026-07-24 — professional design-tool controls

- Shape controls and After Effects-style masks.
- UI cleanup/reskin and removal of dead placeholder chrome.

### 2026-07-25 — Tauri, renderer architecture, real 3D, protocol v2

- Tauri 2 became primary desktop shell.
- Viz/XPression menu and broadcast design system.
- Transform tools and live pen preview.
- Pixi/Three renderer boundary.
- Real editor 3D and native Program mesh rendering.
- Renderer protocol v2.
- Scene registry, Preview/Program lifecycle, warm LRU.
- Resource governor and desktop watchdog/recovery.
- 35-point architecture implementation/compliance pass.
- Font/rundown/automation/SDK extensions.

### 2026-07-26 — Scene Inspector/timeline/camera/light/hierarchy

- XPression property grid and toolbar-level object operations.
- Properties/Materials/Text/Data Binding moved into Scene Inspector.
- Per-property stopwatch channels and key diamonds.
- Movable dope-sheet keys and Speed Graph.
- Real active cameras, authored lights, and hierarchy containers.
- Design-system/token unification.

### 2026-07-27 — material/render correction

- Diagnosed persisted material bindings versus renderer classification.
- Corrected physical lighting/opacity/texture fallback behavior.
- Added native authored-light consumption and all-face assignment.
- Later unified the visible authoring model to one Standard Material; historical
  separate Unlit/Basic Lit/PBR UI notes are superseded.

### 2026-07-28 — material deletion/visibility and Slab

- Fixed 2D material assignment being hidden by stale `fillStyle`.
- Added a real default Standard Material to normalized scenes.
- Removed shaders from the “All” authoring library.
- Isolated material Delete from template/scene Delete.
- Scoped template keyboard deletion to focus inside Templates.
- Replaced thin-box Slab with XPression-style generated geometry.
- Added Slab corner, skew, texture-skew, front/back bevel, culling, extrusion,
  and five material regions.

### 2026-07-28 — unified material-to-viewport contract

- Removed the native contract mismatch where current `pbr` materials assigned
  to flat objects were rejected by the legacy `solid-color`-only quad path.
- Flat Standard Material surfaces now use real physical planes in both editor
  and native renderers, including texture decode/sampling and authored lights.
- CanvasStage passes the evaluated scene—not the unevaluated authoring scene—to
  the preview renderer, keeping timeline/material/camera state synchronized.
- Added the grey transparency checkerboard and transparent empty-scene default.
- Live daemon verification prepared a canonical PBR rect as one mesh surface
  with no warnings or Take blockers.

### 2026-07-28 — Basic v0.1 checkpoint and v0.2 workspace scaffold

- Committed the fully verified Basic v0.1 baseline as `a387f5c`.
- Created `Basic-v0.2` from that exact checkpoint.
- Added first-class `Editor/`, `Playout/`, and `Shared/` npm workspaces without
  prematurely moving working source.
- Added independent Editor, Playout, and Shared build/verification entry points
  while retaining every Basic v0.1 root compatibility command.
- Added `npm run check:boundaries` to reject forbidden Editor ↔ Playout and
  Shared → application dependencies.
- Verified all three new workspace build entry points.

### 2026-07-28 — Playout foundation vertical slice

- Added shared published-scene, Playout rundown/segment/item, transition and
  runtime status contracts.
- Added `Playout/services/playout-control` with atomic file-backed persistence,
  immutable monotonic scene versions, rundown revision/autosave, connection
  health, and a Playout-owned renderer protocol client.
- Added Cue-to-Preview and cut-to-Program runtime state transitions while
  keeping Preview and Program independent.
- Added `Playout/apps/playout-web`, a professional operator surface with scene
  library, segmented rundown, Preview/Program monitors, connection state,
  timecode display and protected Cue/Take controls.
- Added `npm run dev:playout` supervision for Playout web, control and native
  daemon, plus independent build/typecheck/test commands.
- Live verification confirmed all three processes, authenticated renderer
  heartbeat, persisted Main Rundown restoration and the full-window operator
  layout.

### 2026-07-28 — standalone render engine separation

Separated the rendering engine into an independent application, in the same
relationship to Editor and Playout as Viz Engine is to Viz Artist and Viz Trio.
The driving requirement was a logical stage of at least 50,000 × 50,000, which
cannot be one GPU texture on any hardware.

Assessment first (recorded in `docs/render-engine-assessment.md`, since folded
into [`docs/local-v1-system-design.md`](docs/local-v1-system-design.md) §3): the
existing `SceneCanvas` was a single flat `width`/`height` pair, so stage size,
render size and output size were the *same number* everywhere in the repository,
and `RendererPatch` had exactly three operations. Protocol v2 had no `messageId`,
so duplicate suppression was impossible, and no `engineId`, so multi-engine
routing was impossible.

**Eleven new contract packages** (created under `packages/`, now `Shared/`), all pure TypeScript with no
DOM or GPU access:

- `stage-model` — virtual canvas in f64 up to 50,000², origin anchors, regions,
  viewports, cameras, outputs, output mappings, render scale, pixel aspect,
  physical measurements, tiling config, validation against engine capabilities.
- `surface-model` — LED/curved/projection/ribbon/scoreboard/multi-monitor/
  stadium/virtual-production/irregular surfaces, bezel compensation, warp, edge
  blend, colour profiles, and the stage↔surface↔device mapping maths.
- `tile-system` — tile grid, object→tile incremental index, selection by
  viewport/output/preview/export/dirtiness, filter overscan, LRU eviction, and
  seam-free composite verification.
- `render-protocol` — protocol v3 with all six message groups, engine state
  machine, capability negotiation, dedupe, ordering, retry, `EngineConnection`,
  WebSocket transport, and a multi-engine registry with failover selection.
- `scene-model` — revision-gated incremental patches, ordered ingestion with
  duplicate/gap/conflict detection, and state-separation enforcement.
- `animation-engine` — exact rational frame clock, frame-based playback with
  continue and pause points, frame-accurate transitions, determinism
  fingerprinting.
- `asset-manager`, `output-contracts`, `renderer-contracts`, `shader-library`.

**`services/render-engine`** — an independently buildable, configurable and
deployable `grapix-render-engine` binary. It reuses `services/render-daemon` as
`grapix-render-core` by path dependency, so roughly ten thousand lines of tested
scene parsing, mesh preparation, text shaping, pipeline caching and output
adapters are reused unchanged and the daemon's 97 tests stay green.

Key decisions worth not relitigating:

- **The precision rule.** Absolute stage coordinates are never handed to the GPU.
  The tile origin is subtracted in f64 first, then narrowed to f32. At 50,000 the
  f32 spacing is 0.0039 px; after rebasing it is ~6e-5. Asserted by tests
  requiring at least a 32× improvement, in both TypeScript and Rust.
- **Tile rendering reuses the core pipeline** by rebasing the scene *document*
  into tile-local coordinates in f64 and setting its canvas to the tile's padded
  bounds. Rebasing at document level rather than uniform level is required
  because `PreparedScene` stores positions as f32 — by the time a coordinate
  reaches a transform it has already lost precision.
- **Seam-freedom is proven, not claimed.** Every tile draws every object it
  overlaps with the same world transform; only the inner rectangle is
  composited. `verify_seamless_coverage` asserts exact tiling with no gap and no
  overlap over a full 625-tile 50,000² stage.
- **A non-loopback bind with no token refuses to start**, with exit code 1.
- Editor and Playout share one `EngineConnection` implementation. The Editor
  wrapper deliberately omits `takeOnline`; the Playout wrapper deliberately
  omits every content mutation.

### 2026-08-01 — Editor MCP server

Added `Editor/services/editor-mcp` (`@grapix/editor-mcp`), a Model Context
Protocol server that connects Claude, Codex, Gemini, Kimi or any other MCP client
to the Editor. stdio by default; streamable HTTP on 4150 with DNS-rebinding
protection for clients that attach to a running server; `--read-only` omits every
mutating tool.

**53 tools**, all prefixed `grapix_editor_` so they stay unambiguous alongside a
future Playout server: knowledge (8), scenes (8), objects (7), materials (5),
assets and fonts (7), structured imports (6), live data and automation (4),
publish and status (4), rundowns (4). Plus 8 resources (`grapix://primer`,
`authority`, `capabilities`, `rules`, and templates for documents, scenes and
asset bytes) and 5 prompts.

**It goes through `project-api` on 4100, never `data/`.** That is what keeps an
agent under the same origin allow-list, bearer token, read-only show mode,
operator audit hook, per-scene write lock, scene backup and revision counter a
human author works under. A file-system shortcut would bypass every one of them.

**The knowledge half is the reason the authoring half is safe to hand to an
agent.** It ingests `docs/`, the READMEs, this file, and the `Shared/` contract
sources from the working tree — not a bundled snapshot, which would be wrong the
first time someone edited the original. From the contracts it derives a
capability map that reports **declared** and **implemented** separately for every
enum, because this repository has repeatedly shipped options the renderers ignore
(six of eight `TextureFitMode` values drew as `stretch`). `analyze_scene` audits a
stored scene against that gap alongside `resolveSceneObjectHierarchy` and
`preflightScenePackage`, and the object factory writes both colour
representations, so rule 88 holds for agent-authored objects too.

**The boundary is a build-time guard, not a comment.** `assertEditorAuthority`
runs at server construction and in the test suite, and throws if any tool name
contains `take`, `cue`, `continue`, `clear_program`, `on_air`, `output` or
`program`. `publish_scene` builds a `.gfxpkg` and says in its own description
that it does not put anything on air.

Verified: 34 tests across three suites (the authority guard, knowledge
extraction, and a real MCP `Client` driving a spawned `dist/index.js` over
stdio); `npm run check:boundaries` passes with Editor at 6 packages; and a live
run against a project service on 4100 created a scene, added objects, bound live
data, keyframed a 20-frame in-move, created and assigned a material, analysed
clean, and published a 3.3 KB package, then deleted and recovered.

Known limits, stated rather than hidden: `POST /api/scenes` takes no
expected-revision field, so whole-document writes re-read immediately before
saving and refuse a moved revision — this narrows the race, it does not close it.
Search ranking biases toward documentation authority but does not force it; a
detail document can and does outrank `architecture.md` when it is the better
match, and each hit reports its authority rank so the caller can apply the order
itself.

## Basic v0.1 checkpoint scope

The Basic v0.1 checkpoint consolidates the previously local editor, native
renderer, material, font, camera, Slab, and architecture work into one durable
baseline:

- a unified Standard Material contract from authoring through editor preview to
  the native renderer, including physically lit flat planes and texture sampling;
- scoped material/template deletion, real default material normalization, and
  regression tests for the destructive shortcut bug;
- XPression-style generated Slab geometry, five material regions, bevel/skew/
  extrusion/culling controls, and matching shared scene schema;
- authored camera and light consumption in the editor and native renderer,
  including real-GPU camera verification;
- the Font Manager pipeline for uploaded and CSS/Adobe-linked fonts, API
  validation/metadata, project font registration, and native text layout/render;
- grey transparency checkerboard behavior and synchronized evaluated scene state;
- the approved Editor/Playout/Shared target architecture, migration order,
  publishing boundary, rundown ownership, and 35-point compliance updates.

## Last verification evidence

After the material, Slab, font, and unified surface changes:

- editor tests: **27/27 passed**
- API tests: **18/18 passed**
- shared-types tests: **40/40 passed**
- native daemon tests: **84 unit + 3 certification + 4 GPU smoke + 4 layout
  contract + 2 scene contract passed**
- all workspace tests: passed
- full production build: passed
- full workspace `npm run typecheck`: passed
- Tauri Rust `cargo check`: passed
- `git diff --check`: passed apart from Windows line-ending warnings
- live browser verification:
  - Standard Material appeared as a real assignable material
  - assignment increased usage on a selected object
  - Slab rendered as one real 3D object
  - Scene Inspector exposed Slab Shape, Corner Radius, Corner Quality, Skew,
    Skew Texture, Front Bevel, Back Bevel, Extrusion, and Culling
  - Slab Materials exposed Face, Bevel, Extrusion, Back Bevel, Back Face
  - editing Skew kept the scene rendered and selected
  - transparent new scenes reveal the neutral grey checkerboard
  - assigning Standard Material to a flat Background creates a Three.js
    physical surface without a viewport renderer error
  - the running native daemon reported the canonical PBR rect as `meshCount: 1`,
    `warnings: []`, and `takeReady: true`

After the standalone render engine separation (2026-07-28), all re-verified:

- new contract packages: **339 passed** — stage-model 29, surface-model 20,
  tile-system 45, scene-model 28, animation-engine 35, asset-manager 31,
  output-contracts 10, renderer-contracts 12, shader-library 25,
  render-protocol 102
- render engine Rust tests: **114 passed** — stage precision 20, tile system 27,
  config and security 39, live protocol server 28
- native daemon tests: **97 passed**, unchanged by the engine work
- editor tests: **45/45 passed** (27 pre-existing plus 18 for the engine client,
  renderer preference policy and diagnostic overlay)
- API tests: **18/18 passed**; shared-types **40/40 passed**
- `npm run check:boundaries`: passed
- full workspace `npm run typecheck`: passed
- full production build: passed
- `cargo check --all-targets` on the engine: clean
- live CLI verification of the engine binary:
  - `--help` and `--version` work
  - `--print-config` resolves the whole precedence chain with no GPU present
  - file → env → CLI precedence confirmed: port 4300 → 4999 → 5555
  - `--bind 0.0.0.0` with no token refused to start with exit code 1
  - an unknown flag is a hard error, not a silent default

Two real bugs were caught by these tests rather than by review:

- `retryDelayMs` with `jitterRatio: 1` produced delays above `maxDelayMs`. Jitter
  is now subtractive, so the cap is a true ceiling.
- The Rust `MessageDeduplicator` expired an entry recorded at t=0 on its first
  lookup, because `saturating_sub` clamped the cutoff to zero. It now compares
  ages. The TypeScript twin was unaffected because its arithmetic can go
  negative — exactly the divergence parallel implementations exist to surface.

Useful gates:

```bash
npm run typecheck
npm run check:boundaries
npm run test:contracts
npm test -w @grapix/editor-web
npm test -w @grapix/shared-types
npm test -w @grapix/api-server
npm run test:daemon
npm run test:engine
npm run check:engine
npm run certify:control
npm run certify:e2e
```

Soak, with API and daemon already running:

```bash
npm run certify:soak
```

Use `GRAPIX_SOAK_MINUTES=480` or `1440` for 8/24-hour runs.

## Running the application

Primary:

```bash
npm install
npm run dev            # Editor desktop: project service + ensured render engine
npm run dev:playout    # Playout: engine + control service + operator UI
```

Individual development processes:

```bash
npm run dev:web        # editor UI in a browser
npm run dev:api        # project service only
npm run dev:engine     # render engine only
npm run dev:mcp        # MCP server for AI clients, watching sources
```

Default local endpoints:

- editor: `http://127.0.0.1:5173`
- playout: `http://127.0.0.1:5174`
- project API: `http://127.0.0.1:4100`
- editor MCP (HTTP transport only): `http://127.0.0.1:4150/mcp`
- playout control API: `http://127.0.0.1:4300`
- render engine WebSocket: `ws://127.0.0.1:4400`

Both desktop shells adopt an already-running service instead of replacing it, and
neither ever stops the render engine — including one it started itself.

`npm run dev:daemon` no longer exists: the protocol v2 daemon on 4200 is retired.
Its crate is the engine's render core; run its tests with `npm run test:core`.

## Known gaps and next priorities

### Editor / Playout workspace migration

- **Complete:** checkpoint the Editor/native-renderer/font work as Basic v0.1.
- **Complete:** scaffold the master `Editor/`, `Playout/`, `Shared/` workspaces
  with compatibility commands and an executable dependency-boundary gate.
- **In progress:** independent Playout foundation now includes the web operator,
  durable control service, scene versions, rundowns/segments, autosave,
  connection health and Preview/Program Cue/Take.
- Move existing source mechanically into Editor and restore every build/test/dev
  command before moving legacy paths.
- Add the Playout Tauri shell, package publishing/promotion, deeper rundown
  editing and restart/on-air reconciliation.
- Extract shared contracts with compatibility exports.
- Build Playout scene library, rundown/segment persistence and autosave.
- Implement Publish to Playout and its reconnect/idempotency/version tests.
- Add independent native Preview and Program operator control.
- Add page recall, timecode, automation, layer conflict and transition runtime.
- Add Playout restart/offline/on-air-state reconciliation tests.

### 2026-07-29 — outputs, Program clock, publish to Playout

- Project resolution and colour space settings governing every scene
  (`packages/shared-types/src/project.ts`, `ProjectSettingsDialog`), square pixels
  fixed at PAR 1, even dimensions for 4:2:0.
- Output adapters: live (`ndi`, `decklink`, `aja`) versus not live (`null`, `virtual`,
  `recording`), with an `enabled-adapters` allowlist. The virtual output is a headless
  render of the on-air graphic that never leaves the machine.
- `ProgramClock` renders Program at rate and feeds every running output;
  `playout.takeOnline` starts them and says what reached air.
- `ProgramRenderer` keeps pipelines, target and prepared scene across frames:
  482 ms per frame to 5.6 ms, 50.0 fps sustained.
- `File > Publish to Playout` with a real viewport thumbnail; published metadata
  carries resolution, colour space and the exact rational rate.
- Playout scene manager drag-and-drop into the rundown, and `PlayoutRuntime` drives
  the standalone engine for cue and take.
- Four live-path bugs fixed with regression tests: heartbeat liveness, supervisor
  reachability, `reply.outputs` dispatch, stale Program scene cache on data update.
- Gates: engine Rust **217**, render-daemon **97**, render-protocol **139**,
  shared-types **62**, editor **45**, api **18**, playout **3**;
  `certify:engine` **52/52**, `certify:playout-engine` **32/32**,
  `certify:publish-takelist` **21/21**, `certify:ipc` **11/11**,
  `certify:parity` **8/8 with the browser capture skipped**; boundaries, full
  typecheck and production build all passing.

### Standalone render engine — status and remaining work

The engine **listens, renders, holds Program at rate, and feeds outputs**, and is
wired into both applications. Verified live
on an NVIDIA RTX 3070 Ti (Vulkan, `maxTextureDimension2d` 32768) by two
certification gates that drive the real Rust engine over protocol v3:

- `npm run certify:engine` — 27/27. The real TypeScript `EngineConnection` against
  the running engine: capability negotiation, a 50,000 x 10,000 stage, scene load
  and prepare over 125 tiles, playout gating, a 960x192 scaled preview of the full
  stage in ~550 ms, refusal of a full-resolution huge preview, duplicate
  suppression.
- `npm run certify:playout-engine` — 32/32. Publish, load, prepare, cue, take to
  Program, data update, clear, unload — all through Playout's HTTP API — plus the
  whole output path: adapter listing with live/unavailable reasons, refusal of an
  adapter the deployment did not enable, a virtual output configured and started by
  the take, real frames from the Program clock, and outputs stopped by a clear.
- `npm run certify:publish-takelist` — 21/21. The designer-to-operator path:
  the Editor publishes with a thumbnail, the scene appears in the manager with its
  resolution, colour space and exact rational rate, it is placed in a rundown pinned
  to its version, and a Take from the rundown drives the standalone engine, which
  starts the outputs.

Everything the protocol declares is now implemented. What remains genuinely outside
this checkout is hardware and a browser:

- **Live output hardware.** NDI compiles behind `--features ndi`; DeckLink and AJA are
  declared and report themselves unavailable with a reason. None has been run against a
  device, and `hardware_certified` is false for all three.
- **Browser-side pixel capture.** The parity harness proves the native side exactly
  (tile composite pixel-identical to single pass, far edge identical to near edge) and
  compares a browser capture when one is on disk, but there is no browser automation in
  this repository, so it reports SKIP rather than a pass. See `docs/pixel-parity.md`.
- **HTTP asset fetching.** The allowlist is enforced and the refusal names it; the fetch
  itself is not implemented, so an allowlisted host is still refused with a reason.
- **Decode-on-preload.** `asset.preload` reports readiness; decode and GPU upload happen
  during scene preparation, and the reply says so rather than implying otherwise.
- **Raw and WebRTC preview encodings.** JPEG and PNG are implemented; the others are
  refused explicitly rather than substituted.
- **Live output hardware.** The adapter layer, the allowlist, the Program clock and
  the virtual output are implemented and certified. NDI compiles behind
  `--features ndi` and still reports `hardwareCertified: false`; DeckLink and AJA are
  declared and report themselves unavailable with a reason. None has been run against
  a device.
- **Phase L, out of scope:** interlaced output, warp and edge-blend maths, WebRTC
  preview, distributed orchestration.

**Outputs — implemented (2026-07-29).** Two kinds, and the difference is never
implied by a name: live (`ndi`, `decklink`, `aja`) and not live (`null`, `virtual`,
`recording`). `is_live()` is reported per output and per adapter and the Playout panel
colours from that field alone. `outputs.enabled-adapters` is an allowlist so a remote
client cannot instantiate a live output the deployment did not sanction; the default
set contains nothing live. An unavailable live adapter refuses to configure rather than
accepting and discarding frames. `playout.takeOnline` starts every configured output
and says which reached air, which are headless, and — the case that matters most —
when nothing is rendering anywhere. `takeOffline` and `clear` stop them.

**The virtual output** is a headless render of the on-air graphic at full Program
resolution that never leaves the machine, retaining exactly one frame for inspection.
It exists so a take can be confirmed through the real render path with no risk of
going live, which is why it is in the default adapter set.

**Program performance.** `ProgramClock` computes absolute deadlines from the frame
number (never accumulated, so 60000/1001 cannot drift) and drops late frames rather
than catching up. Measured 1920x1080 at 50 fps on the RTX 3070 Ti, debug build:
**5.6 ms average per frame against a 20 ms budget, 50.0 fps sustained**. Getting there
required `ProgramRenderer`: the first version called the core's `render_single_frame`,
which compiles both shader pipelines and allocates a render target per call — 482 ms
per frame, 9,304 dropped in three minutes. Pipelines, target, text renderer, prepared
scene and mesh frame are now kept across frames and rebuilt only when what they depend
on changes.

**Asset synchronisation — implemented (2026-07-29).** `services/render-engine/src/assets.rs`.
Content addressed by SHA-256, so a logo shared by twenty scenes transfers once and a scene
republished unchanged transfers nothing. Uploads are chunked, resumable (the progress reply
names the missing indices), and verified before publication — a digest mismatch discards the
whole transfer, because half a JPEG decodes to something rather than failing. Written to a
temporary file and renamed, so a crash cannot leave a truncated file in a cache whose names
claim verification. Reference counted per scene: releasing an asset a loaded scene needs is
refused unless forced, and scene preparation reports missing assets as take blockers, so a
scene cannot go on air with a hole where its logo should be.

**Incremental scene patches — implemented (2026-07-29).** `services/render-engine/src/patch.rs`,
the Rust counterpart to `packages/scene-model/src/patch.ts` with an identical operation set.
Revision-gated and atomic: operations apply to a clone and the clone replaces the document
only if every one succeeded. Reports which objects it touched, so a moved rectangle dirties
the tiles it left and entered rather than the whole scene. `certify:engine` applies a patch
built by the shared TypeScript helper and asserts the two implementations agree.

**Preview streaming — implemented (2026-07-29).** `services/render-engine/src/stream.rs`.
Frames are addressed to the subscribing client, not broadcast: a JPEG of an Editor's viewport
has no business arriving at Playout. Bounded by `preview.max-stream-fps`, skipping ticks it
cannot serve rather than queueing, and streams die with their client so a reconnecting Editor
cannot accumulate them. Making it usable required the same caching fix as Program: previews
also rebuilt both pipelines per call, which delivered about two frames a second against a
target of eight. `SceneRenderer` is now shared by Program and Preview as separate instances —
sharing one would resize the on-air target to serve a thumbnail.

**Local IPC transport — implemented (2026-07-29).** `services/render-engine/src/ipc.rs` and
`packages/render-protocol/src/ipc-transport.ts`. Named pipe on Windows, socket file elsewhere.
Four-byte big-endian length prefix then UTF-8 JSON: newline framing would break the first time
a scene's text contained a newline. Both transports call the same `process_frame`, so the size
limit, rate limit, authentication, ordering and dedupe rules cannot drift between two ways of
reaching the same engine. `certify:ipc` starts its own engine and proves the whole path,
including that a second client can connect after the first leaves — on Windows each pipe
instance serves one client, and getting that wrong makes the endpoint work exactly once.

**Pixel parity — implemented (2026-07-29).** `tools/certification/pixel-parity.mjs` (the
comparison, with 20 unit tests) and `run-pixel-parity.mjs` (the harness). Previews can now be
requested as lossless PNG, and `forceTiled` renders a region by the tile-composite route
without drawing on it, so the two paths can be compared exactly. Results on the RTX 3070 Ti:
the tile composite is **pixel-identical** to a single pass over the same region (0 of 540,000
pixels differ), and content at x=49,000 renders identically to the same content at x=0. That
turns the seam-free and precision claims from algorithmic arguments into photographic ones.
The browser half needs a browser; the harness compares a capture when one is present and
reports SKIP — never a pass — when it is not.

**Publish to Playout — implemented (2026-07-29).** `File > Publish to Playout` in the
Editor saves, captures a thumbnail from the live viewport (Pixi `extract` on the scene
root, so no overlay can leak in), and posts the document plus the project colour space
to `POST /api/playout/scenes`. `PublishedSceneMetadata` now carries `canvasWidth`,
`canvasHeight`, `colorSpace` and the exact rational rate, so Playout can configure an
output from the published scene without opening the document. The Playout scene manager
shows the thumbnail, cards drag into the rundown (drop on a segment appends, drop on a
row inserts above it, rows reorder across segments), and `PlayoutRuntime` prefers the
standalone engine for cue and take — reporting which renderer carried it in
`activeRenderer` — so a Take from the rundown is what starts the outputs.

Four more real bugs were found by running the live path, each with a regression test:

6. **Heartbeats never confirmed liveness.** Nothing called `recordReceived`, so
   `lastReceivedMs` stayed at construction time and *every* connection timed out
   `timeoutMs` after it opened, reconnected, and died again. Playout looked like it
   had an unstable engine while the engine was answering every heartbeat. Any inbound
   frame now counts as liveness, and a heartbeat ack measures latency (which had
   always reported 0).
7. **The supervisor treated `preparing` as a lost connection.** `connected` was
   `isEngineOperational(state)`, so a normal prepare tore down a healthy socket and
   commands failed with "not connected". Reachability and readiness are now separate
   questions: `isEngineReachable` for the link, `requiresReconnect` for when to retry.
8. **`reply.outputs` was missing from the client's dispatch switch.** The engine
   answered `output.list` immediately and the caller still waited out the full 15 s
   reply timeout. Replies are now matched by `reply.` prefix, so a reply type added on
   the engine side cannot strand a caller.
9. **A data update left the Program renderer rendering stale values.** `playout.update`
   does not bump the revision, which is what the prepared-scene cache is keyed on. The
   cache is now invalidated explicitly on update, load, full sync and unload.

Five real bugs were found by the live gates rather than by review, and each has a
regression test:

1. **Reply/event `messageId` collision.** Replies were numbered from the
   connection's outbound sequence and events from the engine's event sequence, both
   starting at 1, so the first reply and first event both claimed `<engine>-1` and
   the client's deduplicator silently dropped one. Ids are now namespaced `r`/`e`.
2. **Dedupe before ordering wedged the connection.** A retransmit reuses its
   `messageId` but carries a fresh sequence; because dedupe short-circuited first,
   that sequence was never consumed and every later message looked early. The
   connection wedged permanently on the first retransmission. Sequence handling now
   runs before deduplication.
3. **Previews rendered tile-by-tile.** A 960x192 preview of a 50,000-wide stage was
   rendering 125 separate tile passes with a pipeline build each, burning a minute
   of GPU time. Tiling exists to work around the texture limit; when the scaled
   output fits one texture the engine now does a single rebased pass (~550 ms).
4. **A heartbeat could kill Playout.** `EngineConnection.tick` runs from a
   `setInterval`; when the socket had gone half-open the send threw, the exception
   escaped the interval callback, and the whole playout-control process died —
   taking Program with it. `tick` now never throws, treats a failed send as a lost
   connection, and the controller guards the interval as defence in depth.
5. **Each reconnect leaked a connection.** `PlayoutEngineController.connect` did not
   close the previous `EngineConnection`, so every retry left a socket and a retry
   loop alive; the engine accumulated phantom clients. `connect` now disconnects
   first, and `autoReconnect` is off on the connection because the supervisor owns
   reconnection — only it can re-run hello, authenticate and capabilities, and two
   independent retry loops fought each other.

Verified by killing the engine mid-session: playout-control survived, reported
`state: error`, and reconnected unaided once the engine came back.

Cross-language contract drift was also caught: the Rust capability and stage
structs serialised snake_case while the TypeScript contract expects camelCase, so
no client could ever have read them. Both are now `rename_all = "camelCase"`, and
`hardwareCertified` was missing from the TypeScript adapter type.

### Highest renderer gaps

- Native general 2D image, shape, line, paint, mask, and effect coverage.
- Native video codec and hardware decode.
- Continuous native Preview output independent of Program.
- Native active-camera and resolved hierarchy/timeline parity.
- Transparent 3D ordering/depth-mode parity.
- Shadows and full glTF animation/skinning/morph support.
- Unified 2D/3D interleaving if stacked canvases become insufficient.

### Authoring gaps

- Finish advanced path editing: insert/delete existing vertices, break/join
  handles, corner/smooth conversion, trim paths, shape operators.
- Continue curve editor ergonomics and multi-property graph workflows.
- Complete professional material folders/thumbnails/drag-and-drop workflows
  where still partial.
- Complete native-equivalent previews for unsupported imported effects.
- Expand sequencer from authoring to an independent on-air cursor/timecode
  runtime.
- Add T1 transitions and transition compositor.
- Build and certify the isolated JavaScript worker.

### Production/certification gaps

- NDI SDK compilation and real output test.
- DeckLink/AJA implementation and device certification.
- Interlaced output.
- Device-loss/restart/fallback timing tests.
- Long-run 8/24-hour soak evidence.
- Published HD Basic/Advanced/UHD/3D hardware tier measurements.
- Release signing and deployment hardening.

## Documentation map

- [`README.md`](README.md) — repository entry point and commands.
- [`docs/README.md`](docs/README.md) — **the documentation index and authority
  order.** Start here; it states which document wins when two disagree.
- [`docs/architecture.md`](docs/architecture.md) — canonical local V1 product and
  runtime architecture, invariants and acceptance gates.
- [`docs/local-v1-system-design.md`](docs/local-v1-system-design.md) — the design
  review behind it: findings, alternatives, M1–M4 plan, acceptance tests.
- [`docs/editor-playout-workspace.md`](docs/editor-playout-workspace.md) —
  workspace ownership, publishing, rundown architecture and the phase log.
- [`docs/architecture-review-compliance.md`](docs/architecture-review-compliance.md)
  — historical 35-point ledger; its evidence table is current.
- [`docs/render-engine-architecture.md`](docs/render-engine-architecture.md) —
  virtual canvas, tile rendering, stage versus output resolution, surface
  mapping, protocol v3, frame clock.
- [`services/render-engine/README.md`](services/render-engine/README.md) — engine
  operation, precision rule, seam proof, honesty rules, current status.
- [`services/render-engine/engine.toml`](services/render-engine/engine.toml) —
  annotated configuration reference and deployment examples.
- [`docs/render-daemon-architecture.md`](docs/render-daemon-architecture.md) —
  render-core design, the shared-shader decision, TypeScript↔Rust scene contract.
- [`services/render-daemon/README.md`](services/render-daemon/README.md) — the
  render core library, and why its v2 binary is retired.
- [`docs/rendering-engine.md`](docs/rendering-engine.md) — the Editor's current
  browser viewport, explicitly temporary.
- [`docs/scene-document-v1.md`](docs/scene-document-v1.md) — durable scene
  compatibility.
- [`docs/material-system.md`](docs/material-system.md) — material/asset/shader
  contract.
- [`docs/3d-engine-architecture.md`](docs/3d-engine-architecture.md) — 3D,
  animation, pen/path strategy.
- [`docs/fonts-sequencing-automation-sdk.md`](docs/fonts-sequencing-automation-sdk.md)
  — fonts, rundowns, transitions, triggers, scripts, SDK.
- [`docs/design-file-import.md`](docs/design-file-import.md) — PSD/AI/SVG/Figma
  normalized import.
- [`docs/pixel-parity.md`](docs/pixel-parity.md) — how Editor, Preview and Program
  pixels are compared.
- [`docs/hardware-certification-template.md`](docs/hardware-certification-template.md)
  — external certification record.
- [`docs/project-memory.md`](docs/project-memory.md) — older detailed build log.
- [`Shared/render-shaders/docs/shader-contract.md`](Shared/render-shaders/docs/shader-contract.md)
  — GPU byte/layout/blend/colour contract.
- [`Editor/services/editor-mcp/README.md`](Editor/services/editor-mcp/README.md) —
  the MCP server: its tool surface, the ingested knowledge layer, the authority
  guard, and client configuration for Claude/Codex/Gemini/Kimi.

Deleted 2026-07-29 as superseded: `docs/render-engine-assessment.md` (folded into
`local-v1-system-design.md` §3), `docs/render-engine-migration.md` (folded into
§11's M1–M4 plan), `docs/renderer-control-architecture.md` (described protocol v2
and files that no longer exist).

## Rules for the next session

1. Read this file and the relevant linked architecture document first.
2. Inspect `git status` before editing; preserve uncommitted user/agent work.
3. Do not reintroduce separate user-facing Unlit/Basic Lit/PBR material types.
4. Do not allow global Delete shortcuts to cross panel ownership.
5. Keep opened-scene contents authoritative for Inspector, Timeline, preview,
   and template thumbnails.
6. Keep `main` as material face index 0 for compatibility.
7. Update TypeScript and Rust protocol/contracts together.
8. Normalize new scene fields for old scenes.
9. Keep Program output isolated from editor lifecycle.
10. Report unsupported native features explicitly.
11. Do not claim NDI/DeckLink/AJA/video/hardware readiness without execution.
12. Run targeted tests, full typecheck, production build, and live UI
    verification for rendering/UI changes.
13. Update this memory when architecture, module ownership, status, or major
    verified work changes.
14. Before moving repository paths, read `docs/README.md` for the authority order
    and `docs/editor-playout-workspace.md` for the phase log. Phases 0–3 and 4a
    are complete; the next implementation step is milestone M2 in
    `docs/local-v1-system-design.md`, not another move. Gate any move on
    `npm run check:boundaries`, `npm run typecheck`, `npm test` **and** probing
    the running system — every fault the previous two moves caused was silent.
15. Keep Playout independent from Editor lifecycle and never let Editor become
    authoritative for on-air Program state.
16. Never represent a large stage as one GPU texture. A 50,000 × 50,000 RGBA8
    target is 10 GB and three times over the texture limit of typical hardware.
    Only tiles become render targets.
17. Never hand absolute stage coordinates to the GPU. Subtract the tile or
    viewport origin in f64 first, then narrow to f32. Both `stage-model` and the
    engine's `stage.rs` enforce this, and tests assert the improvement — do not
    add a path that bypasses them.
18. `Shared/tile-system` and `services/render-engine/src/tile.rs` are parallel
    implementations of one specification. Change them together; the two test
    suites exist to catch the divergences that follow from not doing so.
19. Keep the Editor's engine wrapper free of `takeOnline` and the Playout wrapper
    free of content mutation. The command surfaces enforce the authority split by
    omission, which is stronger than a comment.
20. Do not weaken the engine's path restriction. A remote client supplies a
    relative, traversal-free path resolved inside a configured root, re-checked
    after canonicalisation. A syntax check alone cannot see a symlink.
21. A non-loopback engine bind with no configured token must keep refusing to
    start. Do not turn that into a warning.
22. Only the cut transition is implemented. Refuse anything else rather than
    substituting a cut, and never set `hardware_certified` from a compile-time
    feature flag.
23. The render engine listens on 4400 and is the only renderer either application
    speaks to. Asset sync, incremental patches, preview streaming and renderer
    restart are still refused with an explicit code — keep them refused rather
    than stubbed, and keep `services/render-engine/README.md` honest about which
    is which.
24. Replies and events must never share a `messageId`, and sequence handling must
    run before deduplication. Both were real faults that wedged a live connection;
    `protocol_server.rs` has a regression test for each.
25. A preview whose scaled output fits one texture must use the single-pass path.
    Rendering it tile-by-tile costs a pipeline build per tile and turns a
    thumbnail into a minute of GPU time.
26. Ports: 4100 project API, 4300 playout-control, 4400-4403 engine and render
    nodes, 5173/5174 web. 4200 belonged to the retired v2 daemon — do not put
    anything new there, and do not reuse any of the others.
27. `is_live()` is the only thing that may decide whether an output is described as
    live, in the engine, the API and the UI. Never infer it from an adapter name, and
    never let an unavailable live adapter accept frames — an output that swallows
    Program shows the operator a healthy row and the audience nothing.
28. `outputs.enabled-adapters` is a security boundary, not a convenience. The default
    set must stay free of live adapters, and a client must not be able to instantiate
    one that is not listed.
29. Nothing that can be built once may be built per Program frame. Pipelines, render
    target, prepared scene and mesh frame live in `ProgramRenderer`; building them per
    frame cost 482 ms a frame. If a cache is added there, invalidate it on update,
    load, full sync and unload — `playout.update` does not bump the revision.
30. Any inbound frame proves the engine is alive. Do not narrow heartbeat liveness back
    to heartbeat replies only, and keep reachability (`isEngineReachable`) separate
    from readiness (`isEngineOperational`) — conflating them made every prepare tear
    down a working socket.
31. Match replies by their `reply.` prefix. An enumerated switch is how `reply.outputs`
    came to hang every `output.list` call for 15 s.
32. Asset bytes are verified before they are cached, and written to a temporary file then
    renamed. Do not relax either: a truncated file in a content-addressed cache carries a
    name that claims it was verified.
33. An asset a loaded scene declares is a take blocker until its bytes arrive. Do not let a
    scene prepare as ready with a missing asset — the operator would find out from a hole in
    the picture.
34. Preview streams are addressed to one client. Never broadcast frames; Playout does not
    want the Editor's viewport, and at 30fps it is real bandwidth.
35. Both transports must keep calling the same `process_frame`. A second copy of the
    reliability chain would drift, and the drift would be a security difference between two
    ways of reaching the same engine.
36. `forceTiled` and `showTileDebug` are different things. One renders by the other route,
    the other draws on the image. Only the first is usable for comparison.
37. The parity harness reports SKIP, not PASS, when there is no browser capture. Do not make
    it pass by default — the whole point is knowing which half was actually proven.
38. Publishing is additive. Every publish is a new version and rundown items pin the
    version they were built against; do not make a rundown follow the latest publish
    by default.
39. The canonical V1 product boundary is now `docs/architecture.md`: Editor,
    Playout and Render Engine are the three applications. `Shared/` is contracts,
    not a fourth runtime. Remote publishing, remote engines and multi-machine
    failover are V2.
40. Editor and Playout use native Render View extensions of the main render-core.
    A Render View changes viewport, cadence, metadata and priority; it must not
    fork material, font, lighting, 3D or animation semantics into a browser or
    application-owned renderer.
41. Render View cached last-good frames are for operator continuity only and
    must never be transmitted as fresh Program frames.
42. An Editor Render View is never eligible to own Program. A separate Playout
    standby worker may be promoted only after exact journal/checksum agreement,
    first-frame validation and transfer of a fenced output lease.
43. A same-machine standby covers a worker-process failure, not shared GPU,
    driver, OS or machine failure. Do not describe it as hardware redundancy.
44. The target V1 lifecycle is a persistent single-instance Engine Host that
    neither Editor nor Playout stops on window close. It supervises the worker,
    journals Program mutations and performs verified restore without replaying a
    Take.
45. `npm run check:boundaries` is the structural guard, and it is cheap. Run it
    after touching any manifest or moving any file. It fails on a cross-domain
    dependency, a relative import that climbs into another product, and any
    dependency on a retired package — that last rule is what stops protocol v2
    coming back one convenient import at a time.
46. Neither desktop shell may stop the render engine, including one it started
    itself. Each has a unit test asserting it; do not "fix" that test.
47. The Editor evaluates automation and returns the plan. It does not execute it,
    and it has no HTTP route that can Take or configure an output. If a feature
    seems to need one, the feature belongs in Playout.
48. The 8/24-hour soak gate has no harness. Do not mark it met, and do not
    resurrect the deleted one — it drove the retired v2 daemon through Editor
    routes that no longer exist. A replacement drives the engine over protocol v3
    with Playout as the only controller.
49. Program samples animation every frame from `services/render-engine/src/animation.rs`, which
    is the parallel implementation of `evaluateSceneAtFrame` in `Shared/shared-types`. Change
    them together, the way `Shared/tile-system` and `tile.rs` are changed together. Never fix
    an animation bug by re-preparing the scene per frame: that path costs 482 ms a frame.
50. `zDepth` is deliberately not animated. Render order is resolved during preparation, so
    moving depth without re-sorting would look like it worked and produce wrong occlusion.
51. `preview.request` honours an explicit `sceneId` and refuses when nothing is cued. Do not
    reinstate a "pick any loaded scene" fallback — it showed operators a scene they had not
    selected, chosen by HashMap order.
52. The operator model is Scene Manager + Take List, not a rundown. Take IDs start at 101 and
    are stable across republishes because operators memorise them. A direct recall is tracked
    as `scene:take-<id>`, never as a borrowed take-list entry id.
53. A command that names both a Take ID and a take-list entry is refused. Do not "helpfully"
    pick one.
54. `RundownDocument` in `Shared/shared-types` is the Editor's authoring-time sequencing model
    for `@grapix/sdk`. It is not the operator running order and was deliberately left alone.
55. Operator monitor streams are refcounted per channel. The first viewer starts the engine
    stream and the last one stops it. Do not start a stream eagerly at boot or keep one alive
    "just in case": the engine allows four concurrent and an unattended station must render
    nothing.
56. Do not gate the monitor picture on Playout's `programRef`/`previewRef`. Those live in the
    control service's memory and are empty after a restart while the engine keeps rendering —
    gating on them blanks a monitor over a live Program. The engine is the authority on what
    is on a channel; a frame arriving is the proof.
57. The picture is layered *over* the slate, never swapped with it. A gap must reveal the
    slate, not a blank box.
58. Retry for a monitor stream belongs in `MonitorHub`, not in the browser. The MJPEG
    connection stays open, so the hub starting a stream later is enough — reopening from the
    client multiplies refusals by the number of viewers.
59. `MonitorHub` decodes each frame once and shares the `Buffer`. Do not decode per
    subscriber, and do not queue frames: drop on `writableNeedDrain`, because a monitor
    behind on the socket must show the next frame late rather than a backlog of the past.
60. Subscribe to engine events through `PlayoutEngineController.onEngineEvent`, never
    `connection.on`. `connect()` builds a new `EngineConnection` on every reconnect, so a
    socket-scoped listener stops firing the first time the engine restarts.
61. Certification harnesses share one engine, and a running GrapiX Playout window holds two
    monitor streams. Assert on deltas and find your own stream by id — never `previewStreams[0]`,
    and never assume an idle machine.
62. Transparency for operators is **fill and key**, not an alpha channel. SDI carries no
    alpha, so broadcast splits it into a greyscale key signal and the downstream keyer
    recombines them; operators read the key as a greyscale picture. Do not reintroduce an
    alpha-capable codec (PNG streams, VP9 `yuva420p`, ffmpeg) for a monitor — a key is
    greyscale, JPEG carries it exactly, and checkerboard transparency is a design-tool
    convention no operator uses.
63. `PreviewView::Key` writes the alpha to all three channels. Correct for shaped and
    straight fill alike, because premultiplication scales the colour and never the alpha. Do
    not "fix" it by unpremultiplying first.
64. Engine preview streams stay JPEG-only. The key is a render mode, not an encoding.
65. An unknown `view` is refused, never defaulted to fill. Showing an operator the fill when
    they asked for the key misreports what is being keyed on air.
66. A long-lived HTTP stream MUST call `reply.raw.flushHeaders()`. Node buffers the header
    until the first body write, so a monitor on an empty channel would leave the client
    waiting for a frame that may never arrive.
67. The operator UI reuses one `<img>` per monitor and changes its `src`. NEVER key the
    element on the view: Chromium does not close an MJPEG connection when an `<img>` is
    detached, so remounting strands the old stream server-side and spends an engine slot.
68. `playout-control` refuses to start when its port is taken, and it checks **before** the
    engine supervisor exists. Keep that ordering: the supervisor connects from its constructor
    and Fastify binds last, so a duplicate launch otherwise spends its whole startup as a
    phantom engine client and then dies on a raw `EADDRINUSE` stack.
    `inspectPort`/`duplicateInstanceMessage` in `preflight.ts`; `listen` also handles the
    `EADDRINUSE` race and releases the engine first.
    `GET /api/playout/health` reports `pid` and `buildAtMs` (mtime of the loaded bundle) so a
    stale process serving the port is visible instead of looking like a fix that did not work.
    Check it before concluding a fix did not work.
69. The Program clock advances the on-air scene's **playhead** (`advance_program_playhead`).
    Preview streams render `scene.frame`, so if nothing writes it back every monitor freezes on
    one picture while the renderer animates perfectly. Do not make the clock's counter private
    again.
70. The playhead advances whenever a scene is on air, NOT only when an output is running. An
    operator confirms a graphic on the monitors before any SDI/NDI output exists.
71. Advance by **elapsed** frames, never an absolute frame number: each scene is timed from its
    own take, and a dropped frame must move the animation on by the time that passed instead of
    playing it in slow motion.
72. `playout.takeOnline` rewinds the playhead to 0 so an "in" animation replays on every take.
    `playout.cue` MUST NOT rewind a scene already on Program — Preview and Program can name the
    same `LoadedScene` and share one playhead, so cueing would yank live air back to the start.
73. `certify:animation` asks for explicit frame numbers, so it proves the *renderer* and says
    nothing about the playhead. `certify:take-animation` is the one that proves a take actually
    plays. Keep both.
74. `IDLE_POLL_MS` in `program.rs` is the delay between a take and the animation starting. Do
    not raise it back to 250ms; a fifth of a second is most of a 20-frame move.
75. The monitor hub starts a refused stream on `event.channelChanged` rather than waiting for
    its retry. Without it a 0.4s animation was over before the first frame arrived — the
    original "shows only B" report.
76. A WMI/CIM `CommandLine -like '*foo*'` filter **matches the PowerShell running the query**,
    because the pattern is in its own command line. That inflated a process count and cost me a
    wrong root-cause diagnosis about duplicate services. Filter on `Name -eq 'node.exe'` and
    exclude `$PID`, and establish who owns a port with
    `Get-NetTCPConnection -State Listen -LocalPort <p>` rather than by counting processes.
77. Port map: 4100 `project-api`, 4300 `playout-control`, 4400 `grapix-render-engine`. 4200 was
    the retired protocol-v2 daemon and is now unbindable — that binary was deleted on
    2026-07-29. **4300 is not the old daemon**; it is the Playout control API and stopping it
    takes Playout off the air.
78. `services/render-daemon` is a **library only** (`grapix-render-core`): `scene`, `renderer`,
    `output`, and output-format `config`. Do not add a binary, a `main.rs`, a transport or a
    port back to it. A second renderer able to bind a port and drive outputs is what invariants
    1 and 7 forbid, and the engine on 4400 is the single renderer.
79. Before keeping dead code because a comment says something depends on it, check. The
    daemon binary's README claimed the crate's integration tests needed it; they import only
    `scene` and `renderer`. Three thousand lines survived several sessions on that sentence.
80. A port readiness probe proves *something* is listening, not that it is yours. Before
    trusting any suite that talks to a port, confirm the owner:
    `Get-NetTCPConnection -State Listen -LocalPort <p>` then that process's `Path`. A packaged
    app's sidecar held 4400 from an earlier launch, `hub` reported the new engine "ready"
    without it ever binding, and a whole certification run silently exercised a stale binary.
81. Never reflect a parent transform to convert a coordinate system. Reflecting a parent mirrors
    its children's geometry: UVs flip and triangle winding inverts, so textures render flipped
    and back-face culling hides or mirrors the surface. Negate the position instead
    (`canvasToWorldY`), and negate rotations about the two axes the negated one reverses
    (`rotationX`, `rotationZ`; not `rotationY`). Lighting may be reflected - a light has no
    geometry. `ThreeSceneLayer` and `projectMeshBounds` must compose the identical transform or
    selection handles miss the object.
82. Do not offer an authored option the renderers ignore. Six of eight `TextureFitMode` values
    were selectable, saved, validated as fine, and drawn as `stretch`. Either implement a mode in
    both renderers or disable it and warn. `IMPLEMENTED_TEXTURE_FIT_MODES` is the single list;
    `resolveTextureFit` (TS) and `resolve_texture_fit` (Rust) are one definition in two
    languages, pinned by tests on both sides, because Preview and Program must sample the same
    rectangle of the same texture.
83. Never assert on `scenes[0]` or any collection order the protocol does not promise. Two
    certifications read arbitrary order: one compared a different scene's revision, and
    `status_payload` summed every scene's tile count while labelling it one stage's grid. Look
    entities up by id, and report a number beside the thing it actually describes.
84. `store/objectPropertySupport.ts` is the single definition of which properties bind to which
    object type, and it encodes what `resolveSceneObjectHierarchy` actually consumes: `scaleZ` is
    inherited by containers, `rotationX`/`rotationY` are not, and `rotationZ` is read from meshes
    alone. Do not reintroduce a per-panel copy — the two that existed had already drifted, and one
    of them offered layers a rotation binding that moved nothing.
85. Object Inspector tab names are identities, not labels: they key the strip and they are what a
    remembered selection is matched against, so a repeat is a tab that cannot be selected. The text
    descriptor listed "Text" twice and its dedicated panel was unreachable for the whole time the
    module existed. `objectInspectorTabsFor` de-duplicates; keep the test that asserts it.
86. Converting a template's canvas is not conforming it. `conformScene` repairs a canvas and must
    never move objects; `convertSceneDimensions` is an authoring decision and asks which of `fit`,
    `stretch` or `canvas-only` the author wants. It scales scene pixels only — never rotation,
    opacity or the unitless scale factors — and never a keyframe's *frame*, because retiming an
    animation is not a resolution change.
87. **Hash the staged sidecar against the engine after every package build.** The
    `cargo:rerun-if-changed` trigger in each `build.rs` is not sufficient on its own: on
    2026-08-01 both apps packaged a `1B6AE044…` engine while the built engine was `F7C47AD1…`, and
    every command exited 0. `cargo clean -p app --release` / `-p playout-app --release` forces the
    script to run. A green build is not evidence that the bundled engine is the one you built —
    the comparison is
    `Get-FileHash services/render-engine/target/release/grapix-render-engine.exe` against both
    `*/src-tauri/binaries/grapix-render-engine-x86_64-pc-windows-msvc.exe`.
88. An object carries its colour twice — `fill`/`stroke` strings and `fillStyle`/`strokeStyle`
    values — and **the renderers read the rich one first**. A factory that sets only the string
    paints whatever the base object's style was, which is why the pen tool drew nothing for as long
    as it existed. Any factory naming a colour must go through `withColorStyles`
    (`store/objectColorStyles.ts`). Do not fix a future instance of this per object type; the text
    special-case in `normalizedObjectFillStyle` is a migration for old *saved* scenes, not a
    pattern to copy. The MCP server has its own `withColorStyles` in
    `Editor/services/editor-mcp/src/sceneOps.ts`, built on the shared `solidColorValue` rather than
    importing the editor app — a service must not depend on the web application. Both must keep
    writing both representations.
89. **The MCP server may never grow a Program or output verb.** `assertEditorAuthority`
    (`Editor/services/editor-mcp/src/server.ts`) throws at server construction, and its test fails
    the build, if a tool name contains `take`, `cue`, `continue`, `clear_program`, `on_air`,
    `output` or `program`. Do not relax it to add a "convenience" tool that forwards to Playout.
    The engine would refuse the call anyway by authenticated role, but the tool would first have
    told a model that the Editor can put graphics on air, and that is the wrong belief to hand an
    autonomous agent driving a broadcast system.
90. The MCP server talks to `project-api` on 4100 and never to `data/` directly. The origin
    allow-list, bearer token, read-only show mode, audit hook, per-scene write lock, backups and
    revision counter all live in that service; a file-system shortcut for speed would bypass every
    one of them. If a capability is missing, add the route to `project-api` and call it.
91. `POST /api/scenes` replaces a whole document and takes **no** expected-revision field, so any
    read-modify-write races the Editor UI and any other agent. `mutateScene` re-reads immediately
    before saving and refuses a moved revision; that narrows the window, it does not close it, and
    the README says so. Do not upgrade that wording to a guarantee without adding compare-and-swap
    to the route. Note also that the live-data route `/api/scenes/:id/data-patches` compares
    `updatedAt` **timestamps**, not the numeric revision — hence `expected_updated_at` on that one
    tool.
92. The MCP capability map must keep reporting *declared* and *implemented* separately. Collapsing
    them would silently reintroduce exactly the class of bug rule 82 exists for, this time with an
    agent authoring it at speed. Its knowledge is read from the working tree on every fingerprint
    change — never bundle a snapshot of `docs/` or `memory.md` into the package, because it is
    wrong the first time someone edits the original.
