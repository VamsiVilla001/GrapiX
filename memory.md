# GrapiX Project Memory

Last consolidated: **2026-08-04**  
Repository: `D:\Project KK\Personal projects\GrapiX`  
Current branch: `Basic-v0.4`
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
- Durable package publication uses HTTP(S) for `.gpxpkg` transfer and a
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
- Saved scenes and `.gpxpkg` files must not rely on editor-only transient state.
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
- `ObjectManager.tsx` — XPression-style object hierarchy grid with chosen
  property columns. Dock panel id is still `"scene-manager"` (a persisted
  layout key); there is no `SceneInspector.tsx`.
- `Inspector.tsx` — selected-object Properties content, hosted by the Object
  Inspector dock panel.
- `MaterialsTab.tsx` — per-face material selection and unbinding.
- `TimelinePanel.tsx` — dope sheet and speed graph.
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
- `.gpxpkg` manifest/preflight-related shared structures.
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
- `.gpxpkg` preflight and package building.
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

`.aep` handling is currently the **AEP Static Inspector**: it records static structure for
inspection and evidence, not a renderability, fidelity, or scene-conversion determination.
**AE Runtime Mode** is the planned boundary where a locally installed After Effects runtime
renders; **GrapiX Native Mode** renders an explicitly converted, compatibility-reported GrapiX
scene with wgpu. Neither statement gives the Editor Program or output authority.

### 2026-08-25 — AEP native parser hardened against a real project

The native `.aep` reader (`Shared/adobe-common-schema/src/ae/`: rifx/cos/aepParser/aepxParser, ~3,200
lines) was validated against a real 65.7 MB, 280-composition project — `DYno_Format.aep` at
`D:\Vamsi\Work Files\Assets\AEP\DYno_Format folder\DYno_Format folder\DYno_Format.aep` (user-supplied,
outside the repo). It parsed in ~0.6 s: 2,772 layers, 1,036 keyframes (linear 725 / bezier 301 /
hold 10), 279 masks, 2,156 effects, 204 text layers, 30 warnings — all benign (text with multiple
character/paragraph style runs collapsed to the first, a known GrapiX limitation, not a parse
failure). No exceptions, no degradation warnings.

Three things the real file surfaced that the tiny vendored fixtures never could, each checked and
found **correct**, not a bug: position spatial tangents appear on only 1 of 43 position streams
because the project uses straight-line (linear) moves — the one curved stream proves the
`3d-spatial` decode path works; 64 keyframes at negative times (min = -1/30 s) are fades starting one
frame before the layer in-point, which AE allows; 279 masks are all static (0 animated mask paths),
so the animated-mask-path decode stays synthetic-only for now. Also learned: 137 of 509 streams carry
no keyframes but **all** have an expression — a stream is listed because it is animated *or*
expression-driven, and the regression test now encodes exactly that invariant.

Built this session (all uncommitted, on Basic-v0.4):
- `tools/ae/inspect-aep.mjs` — a committed dev inspector: `node tools/ae/inspect-aep.mjs <file>` prints
  the census + collapsed warnings + decoded samples. Exports `summarise`/`collapseWarnings`, guarded so
  importing it does not run the CLI.
- `Shared/adobe-common-schema/tests/ae-aep-real-project.test.mjs` — **presence-guarded** regression
  test. Reads `GRAPIX_AEP_FIXTURE`; skips cleanly when unset (CI/fresh clone stay green), else asserts
  invariants (parses, no unknown warning shape, finite keyframe times, every stream has keyframes or an
  expression, every mask has vertices) plus a census tripwire pinned to DYno_Format (matched by byte
  size 68,918,829 + comp count) and a concrete 0->1->1->0 opacity-fade decode assertion.
  Run it with: `GRAPIX_AEP_FIXTURE="<path>" npm test -w @grapix/adobe-common-schema`.
- Documented both in `Shared/adobe-common-schema/tests/fixtures/aep/README.md`.

Verification: `npm test -w @grapix/adobe-common-schema` = 60 tests, 59 pass, 1 skipped (the guarded
test, correctly skipped without the env var); with the env var set it runs and passes;
`npm run check:boundaries` passes. The 65 MB project is **not vendored** — too large and not ours to
redistribute; the env-var guard is deliberate for that reason.

### 2026-08-25 — dead AEP conversion code removed

Asked to clean up "unused or waste code," after mapping the AE surface: there are **two separate AE
systems** (they share only the name). (1) **AEP import** — read a `.aep`/`.aepx` into an `AeManifest`
via the native binary parser `Shared/adobe-common-schema/src/ae/` (default) or the installed-AE
ExtendScript exporter `adobe-mcp-gateway/src/aeBridge.ts`; the one wired route
`POST /api/import/after-effects` (`importers/aeImporter.ts`) returns a **static inspector report**, not
a scene. (2) **AE runtime container** — a live installed After Effects driven as a rendering runtime
(`Shared/ae-runtime-contract`, render-engine `ae_ingress/ae_ring_source/ae_runtime_client/ae_schedule`,
Playout's 7 `ae*` services, editor-web `AeControlsPanel`, `/api/ae-runtime/...` +
`/api/playout/ae-runtime/...`); wired, tested, pixel-parity certified. Left fully intact.

Removed the one genuinely-dead thing — the **unwired `.aep` → GrapiX scene converter**, confirmed by
reachability (`convertAeManifestToScenes` had 0 external refs; `aeImportService`/`footageCollector`
imported by nothing):
- `Editor/services/project-api/src/importers/ae/aeImportService.ts` + `footageCollector.ts` (dir removed)
- `Editor/services/project-api/tests/ae-import.test.mjs`
- `Shared/adobe-common-schema/src/ae/sceneConverter.ts` + `tests/ae-converter.test.mjs`
- dropped `export * from "./sceneConverter.js"` from `Shared/adobe-common-schema/src/ae/index.ts`

Left intact deliberately: `afterEffects.ts` is a live types file (11/14 exports used); 3 stray unused
constants there (`AE_OBJECT_TYPE_TO_LAYER`, `AE_TRACK_MATTE`, `AeLayerFlagsView`) were flagged, not
removed — not worth editing a live schema file. Verification after deletion: adobe-common-schema 47
pass/1 skip (was 59/1 — the 12 converter tests gone), api-server 134 pass/0 fail, no missing-module
errors, `npm run check:boundaries` passes.

Stale after this: `docs/ae-runtime-container-phase-plan.md` still names `aeImportService`/`sceneConverter`/
`runAeImport` as part of an intended plan — flagged to the user, not rewritten (roadmap intent is theirs).
NOTE: this supersedes the prior "left untouched" scope note — the converter that earlier work set aside
has now been deleted.

## Package, persistence, and publishing

Package extension: `.gpxpkg`.

`.gpxpkg` v2:

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
`npm run certify:publish-takelist` (21 checks). The `.gpxpkg` route below remains the
design for the packaged, checksum-revalidated transfer and is still what
`File > Export Package…` produces; the direct publish is the live path.

Editor publication to Playout is distinct from saving an authoring project:

- Editor builds and preflights a complete versioned `.gpxpkg`.
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
- strict `.gpxpkg` v2
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

### 2026-09-06 — the asset folder becomes the library

User correction, and it inverted the model that was about to be built: the Material Manager
**reads the project's asset folders and shows a reference per file**, and those references are
directly assignable as materials. Not an import that records an entry in a catalogue — the
directory listing *is* the library. A designer who drops four logos into `Assets/Images` with
Explorer sees four logos; one who deletes a file stops being offered it. It is the XPression and
Viz model, and the only one where the library and the file manager can never disagree.

**Identity is the path, not a hash.** Content addressing is right for the transfer cache beside
this — move identical bytes once — and wrong for a library: replacing `lower-third-bg.png` in
place is routine, and every material pointing at it must keep pointing at it. `projectAssetId()`
derives a stable id from the path (64-bit FNV-1a, forced to `[A-Za-z0-9_-]` because the packager
builds a file name out of it — a path with a space would otherwise author fine and fail at
publish).

**Service.** `Editor/services/project-api/src/projectAssets.ts` walks the six asset folders,
bounded at depth 8, resolving every directory to its real path before entering and refusing
anything outside the project — a junction pointing at a shared media drive is not hypothetical on
Windows, and following it is a scan that never ends and a library the project cannot package.
`GET /api/project/assets` answers `200` with `projectOpen: false` and an empty list when there is
no project, matching `listScenes`. `GET /api/project/assets/content?path=` resolves with three
checks in order — syntactic, inside-root, and containment re-checked **after** `realpath`, because
a syntax check alone cannot see a symlink — and answers one 404 for every refusal so nothing maps
the filesystem a request at a time.

**Scene still records what it uses.** The folder is the browsable library; assignment is what makes
a scene carry the file, because publishing packages `scene.assets` and the renderers resolve
textures from it. `assignAssetToFaces` adopts an unknown id from the library **inside its own
`commitScene`** rather than calling `adoptProjectAsset` first — one gesture must be one undo, and
two entries would make Ctrl+Z leave an asset in the scene bound to nothing. Every existing call
site (grid double-click, context menu, canvas drag-drop) therefore works unchanged.

**Packaging had to learn the new source.** `resolveAssetBytes` only knew data URLs and the
content-addressed store, so a project asset would have authored fine and failed at publish with
"no locally stored bytes". It now reads the file where it lives. Deliberately no checksum
comparison against the document: path identity exists so a replaced file keeps its bindings, and
the package must carry what is in the folder now. The manifest still records the hash of exactly
the bytes packaged, which is what Playout verifies.

**No filesystem watcher.** The list is re-read on panel mount and on window focus — the author
alt-tabs to Explorer, drops a file in, and comes back, which is when the panel is most likely to be
wrong. A watcher holds handles on folders the operator is editing, and on Windows that is how a
directory becomes undeletable.

New: `Shared/shared-types` `ProjectAssetReference`, `PROJECT_ASSET_FOLDERS`, `projectAssetKind`,
`projectAssetMimeType`, `projectAssetId`, `projectAssetContentPath`, `isAssignableProjectAsset`
(one extension table both sides import, because when they disagreed the library offered something
the renderer refused); `Editor/apps/editor-web/src/store/projectAssetStore.ts`;
`projectAssetLibraryItem` in `lib/projectAssets.ts`, shared by the store and the panel so a
reference cannot change identity at the moment it is assigned.

Verification: `typecheck` 0, `check:boundaries` passed, `test:editor` **519/519**, new
`projectAssets.test.mjs` 9/9 (including ten traversal forms), new `project-assets.test.mjs` 8/8.

Found while verifying, filed rather than fixed — a third instance of one pattern, and the worst of
them is not a Windows quirk: `Shared/auth-contract/src/userStore.ts` `save()` writes every save
through a **fixed** `users.json.tmp` with no uniqueness and no lock, so concurrent saves race, one
rename fails `ENOENT`, and a write to the account file can be silently lost.

### 2026-09-06 — one native extension, and a project that actually owns the work

The project became the container it was only described as. Two decisions from the user set the
shape: the project stays a **folder** (not a single sealed archive), and `.gfxpkg` is **replaced**
by `.gpxpkg` rather than kept beside it.

**Format identity.** `PROJECT_FILE_EXTENSION` moved `.gpx` → `.gpxpkg`, and the published scene
package moved `.gfxpkg` → `.gpxpkg`. One extension now carries two formats, so both manifests
declare a `kind` — `GpxpkgKind = "project" | "scene-package"` in `Shared/shared-types/src/`
`projectWorkspace.ts`, written by `createProjectManifest` and `buildScenePackageManifest`, optional
on read so files written before the field still load. `readManifest` was rewritten with it: it now
scans **every** `.gpxpkg` in a root and takes the first that says it is a project. The old
`entries.find(...)` took whichever sorted first, so exporting a package beside a project would have
made the project stop opening — and an unsupported-version project is now remembered rather than
masked by a stray package.

**The project owns scenes.** `storage.ts` resolved seven roots from `dataRoot` at import. Scenes,
backups, autosaves and packages are now resolved per call through `projectFolder()`, which refuses
with `NO_PROJECT_OPEN` when nothing is open — so "you can work, but nothing is written until you
save it somewhere" is true of the *service*, not only of the UI that calls it. Reads degrade
instead of refusing: `listScenes` returns `[]` with no project, because "which scenes are saved?"
has a true answer before a project exists and a scene picker should show an empty list, not an
error. `ensureStorage` creates only the service's own directories now; creating the project's would
have made every read path refuse before it could answer.

Rundowns, the asset store and the AE root registry deliberately stayed on the data root. Rundowns
are Playout's; the asset store is about to become references-plus-collect, and moving those bytes
twice would be a migration for nothing.

**Breaking the cycle.** `projectWorkspace` imported `projectDataRoot` from `storage`, and storage
now needs the project — so the one thing both need moved to its own `dataRoot.ts`. `storage` still
re-exports it, because most of the service already imports it from there.

**`GRAPIX_PROJECT_ROOT`.** A launch may name its project and have it created on demand. That is how
a headless run and the test suite get a project without a file dialog.

**AEP footage** left `Assets/` for a top-level `AEP Footage/` (`PROJECT_FOLDERS.aepFootage`): it is
a copy of somebody else's project structure, not an asset class, and it is the folder an operator
opens by hand when a template loses its footage.

Two test faults found by doing this, both worth keeping:

1. **The module-cache trap, again.** `autosaveStorage.test.mjs` re-imports `dist/storage.js` behind
   a cache-busting query, but the `projectWorkspace.js` *it* imports is not busted — so the module
   holding "which project is open" is shared, and the first test decided for the whole file. Every
   later snapshot went into the first test's project while its own assertions still passed. Fixed
   with one project path per file, emptied before each test.
2. **A before/after snapshot that counted a temp file.** `ae-native-route.test.mjs` compared a
   recursive listing before and after, and caught `users.json.tmp` mid-rename from the concurrent
   first-administrator bootstrap — failing 4 runs in 5 standalone. The helper now ignores `.tmp`.

Still open and deliberately untouched: the existing `data/` (18 scenes, 154 MB of assets, 127
backups) was **not** migrated — no decision was given, so nothing was moved. Nothing registers
`.gpxpkg` as a file type in either `tauri.conf.json`, so "double-clickable" is still aspirational.
`Editor/services/editor-mcp/bundle/grapix-editor-mcp.mjs` still says `.gfxpkg`; it is generated, so
it needs `npm run pack:mcp` rather than an edit. Templates still live in browser `localStorage`
(`templateStore.ts`, key `grapix-template-catalog-v1`) and are not in a project at all.

Found while running the suite five times, filed rather than fixed: `aePackageBuilder.ts` promotes a
staged AE package by renaming a directory, and that `rename` fails `EPERM` on Windows roughly one
run in five under handle contention. It is not test-only — the same path runs on a real publish.

Verification: `npm run build:shared` clean, `npm run typecheck` exit 0, `npm run check:boundaries`
passed (Editor 8, Playout 4, Shared 19), `npm run test:shared` all pass, `npm run test:editor`
**519/519, 0 fail**, and `npm test -w @grapix/api-server` five consecutive runs with the only
failure the pre-existing `EPERM` above.

### 2026-08-12 — LOWER_THIRD becomes a pinned, controllable native fixture

**The narrow BO0a fixture slice is implemented and live-verified.**
`tools/certification/ae-runtime-fixtures/v1/fixtures/lower-third.aep` is an AE 26.3 project pinned by
`lower-third.json` at SHA-256
`903406290b24405d3b1ff1bbd5a6c9999dc3e1e66c53989647d5eb695a06439c`. Its single transparent
`LOWER_THIRD` composition is 1920×1080, square pixel, exact 30000/1001 and 300 frames. It has a
feathered native bar, `PLAYER_IMAGE` solid-footage placeholder, `PLAYER_NAME` and `SCORE` source-text
layers, and `TEAM_COLOR` through AE's built-in `ADBE Fill`.

The local-schema manifest pins AE build, plugin set, cue map, accepted values, update classes,
composition/layer ids and canonical match-name paths. It records the unresolved host-default text font,
production validated-media requirement and missing approved licensed third-party plugin instead of
claiming those dependencies are ready. AE reports unique stream id 0 for these target streams, so the
fixture does not pretend that value is a usable identity; AE-CD1 still owns production stable
descriptor binding.

The BO0a-only `fixture-control` harness resolves composition item plus layer id and accepts exactly four
declared targets. A live restart of AE read `MAYA RIVERA`/`042`/`#0557FF`/`#29303B`, applied
`JORDAN LEE`/`317`/`#FF3B30`/the allowlisted `portrait-gold` replacement, and read back
`JORDAN LEE`/`317`/`#FF3B30`/`#F28C14`. Score 1000, a caller path and an undeclared control were
refused. The mutated 1920×1080 premultiplied-ARGB checkout held 348,476 partial-alpha pixels, no colour
above alpha and no colour at zero alpha; it differed from the pristine frame on 405,016 pixels.

**Scope remains open.** This is fixture/control evidence, not BO0a completion. The approved licensed
third-party plugin is not installed; AE-CD1/3/4 and AE-F2 remain required before the production path,
validated project-store image replacement, dependency preflight or AE-F3 soak can be claimed.

### 2026-08-12 — BO0a's alpha edges try to break the answer, and do not

**The adversarial edge subset passes.** `tools/certification/ae-runtime-fixtures/v1/` now holds the
461,271-byte AE 26.3 project `bo0a-alpha-edges.aep`, pinned at SHA-256
`1cdfb5f808c0104bcd22fadc6c28639d868782d3405a5bd60ce870c882739a06`, with seven isolated
compositions: opaque, zero alpha, axis-aligned hard edge, rotated antialiased edge, feathered alpha
gradient, coloured translucent shadow and a bright premultiplied-black edge. It uses no media, fonts
or effects; every pixel is authored from native AE solids, transforms, opacity and mask feathering.
The adapter's `fixture <path> edge-corpus` verb authors it deterministically, but re-authoring is an
explicit maintenance step — certification starts from the pinned `.aep` and refuses a digest mismatch.

`npm run certify:ae-runtime-fixtures` first re-exports one frame per composition through
`aerender.exe` with **Best Settings / TIFF Sequence with Alpha**, then starts AE and performs fourteen
named checkouts: `premul-black` and `straight` for every composition, always in AE's stable native
ARGB order. Every premultiplied checkout, swizzled to RGBA, matched its independently exported
reference at **zero differing pixels and zero channel tolerance**. The premultiplied invariant held
across all 1,612,800 pixels: no colour channel above alpha, and no colour at zero alpha.

The gate also proves it would catch the wrong answer. Straight alpha differs on **890** antialiased
edge pixels, **140,000** gradient pixels, **64,818** coloured-shadow pixels and **61,838**
premultiplied-black-edge pixels. The gradient alone contains 132,868 partial pixels, **252 distinct
alpha values**, and 464 pixels at exactly `A = 128`. Opaque, zero-alpha and axis-aligned hard edges
agree under both matte modes as they should; they prove those boundary regimes without pretending to
distinguish alpha association.

The versioned manifest has a local JSON Schema and pins the project digest, AE build, plugin set,
empty font/media/dependency sets, exact 640×360 at 25/1 geometry and timing, source alpha mode,
fill/key interpretation, Render Queue templates, zero tolerance and per-case expectations. Large TIFFs
are regenerable and ignored; each tracked reference manifest carries its decoded pixel SHA-256.
`edge-corpus-result.json` is the persisted review record.

**Scope remains honest.** This closes BO0a's alpha-vector subset only. The card remains open for the
`LOWER_THIRD` fixture, declared text/number/image/colour controls, cue map, approved licensed
third-party plugin and the production supervisor/control path.

### 2026-08-12 — After Effects hands over real pixels, and the alpha question is answered

**AE-F0's route exists and its alpha contract is settled by measurement.**
`AEGP_RenderAndCheckoutFrame` → `AEGP_GetReceiptWorld` → `AEGP_GetBaseAddr8/16/32` →
`AEGP_CheckinFrame`, on the adapter's own hook thread, checked in cleanly every time. All three world
types are real and unpadded: 8/16/32-bit at 4/8/16 bytes per pixel with `rowBytes` exactly
`width × bytesPerPixel`. Frame→time goes through `AEGP_GetCompFrameDuration` as an exact rational, so
30000/1001 material cannot drift off a frame boundary.

**The fixture problem, and how it was solved.** Every `.aep` in this repository is a *parser* fixture:
`Layer-01.aep`'s seventeen layers are named after AE layer flags and carry no renderable source, so it
renders uniformly transparent at every frame — which fits every alpha hypothesis equally well and
falsifies none. So the adapter gained a `fixture` verb that authors `AlphaProbe` (640×360: an opaque red
quadrant, a 50 %-opacity green quadrant, an empty bottom half) and **saves it**, so `aerender` can produce
the reference from the same file. A comparison where the adapter is the only thing that has ever seen the
composition proves nothing.

**The answer.** AE's world is natively **ARGB** (`PF_Pixel` is `{alpha, red, green, blue}`).
`AEGP_MatteMode_PREMUL_BLACK` renders the 50 % quadrant as `A 128 / G 128` with **zero** pixels carrying a
colour channel above their alpha, and mapped ARGB→RGBA it is **byte-for-byte identical** to the Render
Queue's TIFF: 921,600 bytes, zero differing bytes. `AEGP_MatteMode_STRAIGHT` renders `A 128 / G 255` and
differs on exactly 57,600 bytes — the quadrant's pixel count — with worst delta 127. The comparison can
therefore tell the two apart, which is what makes the identical result worth anything. After Effects' own
"TIFF Sequence with Alpha" is **premultiplied** while declaring `ExtraSamples = unspecified`: the
container's silence is not evidence that the pixels are straight.

**Two findings that would have shipped bugs.** `AEGP_NewFromItem` inherits the Composition panel's
downsample factor — the first checkout returned **480×270** for a 1920×1080 comp, because the panel sat at
quarter resolution — so resolution and quality are now stated on every request rather than inherited.
And requesting a non-native channel order **corrupts repeat checkouts**: with `BGRA` requested, five
identical checkouts of one unchanged frame alternated BGRA, ARGB, BGRA, ARGB, BGRA, the flip following the
call count rather than the request, while `ARGB` was stable across five. A runtime that asks for BGRA gets
correct pixels on odd calls and channel-swapped pixels on even ones — so GrapiX requests ARGB and swizzles
itself, and **AE-F1's ring descriptor must carry the layout observed, never the layout requested**.

Two smaller ones: a frame index far past the composition's end is **not** refused (frame 99999 of 3600
returned a full frame), so range checking belongs to the caller; and a file-level SHA-256 is not a pixel
oracle, because AE embeds per-render XMP metadata — three renders of one unchanged frame produced three
different file digests over byte-identical pixels. `references/pixel-digest.mjs` digests the decoded strip
payload for exactly that reason.

Evidence: `ae-plugin/runtime-adapter/certification/AE-F0-checkout.json` and `AE-F0-references.json`.
Still open, and named in both: 16/32-bit reference agreement, the cancel path, deadline behaviour on
frames that cost real time, and the wider edge corpus — antialiased and gradient edges, coloured
translucent shadow, premultiplied-black edge — which belongs to **BO0a**.

### 2026-08-12 — After Effects becomes a runtime GrapiX can start and stop, 29 times out of 30

**AE-A0's lifecycle is closed, with one named gap.** `supervise.sh cycle 30` passed **29 of 30** launch →
commandable channel → real property write → graceful shutdown cycles: zero stalls, zero restarts, in **30
distinct After Effects processes**, 70 s min / 71 s median / 85 s max. All 30 wrote `opacity 42.5` and read
back `42.500000`. The authored fixture and the working copy both ended with SHA-256 `658da9de…3363a` —
nothing was ever saved.

The one failure is worth more than the twenty-nine successes. Cycle 12 reported **quit-failed**: the
command succeeded and the project was clean, but After Effects did not exit inside the graceful-quit
window, so the harness force-killed it. Cycle 13 then passed in 85 s against a 71 s median — consistent
with the kill arming the crash dialog and the dialog-clearing loop absorbing it. So recovery works and
**one `WM_CLOSE` is not always enough**: the stop path needs a bounded retry that re-asserts the close
before escalating, because its fallback is the kill that taxes the next start. That is now finding F14
against **AE-A2**.

Two harness defects were found by running the gate twice, and both are fixed. `cycle` wrote to a single
fixed log path and **truncated it**, so a later 3-cycle smoke test destroyed the first run's completed
record — logs are now one file per run, named by UTC start time, with a header stating cycle count,
project and probe layer. And the per-cycle probe was hardcoded to layer 16, which exists only in the
`Layer-01` fixture; on the two-layer alpha probe every cycle reported `command-failed`. The probe layer is
now configurable and defaults to layer 0. Evidence:
`ae-plugin/runtime-adapter/certification/AE-A0-cycles-20260811T212936Z.log` and the result record beside
it, which records the correction rather than hiding it.

**The graceful stop.** `dirty` → `discard` → `WM_CLOSE` on the editor → death hook → exit, in about three
seconds, with no save prompt ever reached. `AEGP_NewProject` is the primitive that makes it possible: it
discards a dirty project with **no modal at all** and, unlike `AEGP_OpenProjectFromPath`, leaves the idle
channel alive. The save prompt has to be avoided rather than answered — AE's dialogs expose no automatable
controls, and `WM_CLOSE` on that particular prompt means Cancel.

**Ownership.** The channel is a file pair in a fixed state directory and carries **no process identity**:
any After Effects with this adapter installed answers on it. So every reply now stamps `hostPid`, and a
claim written at launch records the pid the adapter itself reported. A process that does not match the
claim is *attached*: reads and property writes are allowed, `discard` and `quit` are **refused**, because
it may hold an operator's unsaved work. Both branches are proven against real processes, including one
started by hand outside the harness.

**What cost the most, and what it taught.** After Effects queues modal dialogs across startup, and until
they are answered **its idle loop never runs** — so the adapter loads while no command can reach it. They
cannot be answered the way a person would: `#32770` shells holding one `DroverLord` pane, no automatable
controls, usually empty window text, sometimes never painted at all while AE blocks on them anyway, and
deaf to synthetic keystrokes. Found by *window class* and answered with `WM_CLOSE` per handle they clear,
and `WM_CLOSE` takes each dialog's non-destructive default — proven because the adapter still loaded and
answered after a chain containing **Crash Repair Options** was cleared, whose neighbours are "Start in
Safe Mode" and "Manage Plugins". A start from a host with five modals queued reached a commandable channel
in **12 s**.

Two corollaries that outrank the clearing loop. **Never force-kill After Effects**: a kill invalidates its
plugin cache and arms the crash dialog, so every kill costs the *next* start a modal chain — which is why
the graceful quit is load-bearing rather than tidy. And **provision the host**: a broken third-party plugin
here (a Resolume DXV install) raises a load-failure modal on every cold plugin scan, and no runtime can fix
that from inside.

Two smaller traps, both now closed in the harness. `ready` cannot mean a PID or a window — a fully
commandable AE had `MainWindowHandle == 0`. And it cannot mean the adapter's load marker either: the marker
lives in the reply slot, so the first successful command overwrites it, and an earlier gate sat waiting for
a file that no longer existed while the channel was live underneath it.

Findings F5–F12 in the adapter README carry all of this into **AE-A2**, whose card now states them as
measured constraints rather than as things to discover.

### 2026-08-11 — the adapter loads, and After Effects moves a property because GrapiX told it to

**L0 is closed for V1** and **AE-A0's premise holds**. Kill gate K1 is not triggered.

L0: the determination is recorded in §9 of
[`docs/ae-runtime-licensing-decision-request.md`](docs/ae-runtime-licensing-decision-request.md) as an
**owner** conditional go, scoped to development, testing and internal operation on the owner's own
licensed installation — the slice Adobe Developer Terms §4.1(A)(1) grants in terms ("use and reproduce the
Developer Tools for the development and testing of your Developer Software"). V5 (rendering as a service to
third parties) is refused on GT §6.4 and Software PST §1.4(B)(2). V4 is deferred. Seven conditions now bind
engineering: named-user interactive session (Business PST §4 bans generic-user deployment), no SDK material
in the repository or any package, no copyleft in the adapter binary (Developer Terms §6.6), no model
training on AE output (§6.16), no Adobe mark or the abbreviation "AE" in a customer-facing name (§8.2(D)),
no external distribution before L1, and audit-ready records (GT §15). Distribution (Q2/Q3), V4 and product
naming stay blocked at L1.

AE-A0: `ae-plugin/runtime-adapter/` is a new AEGP plugin — GrapiX source, no Adobe sample code copied —
built by `build.sh` (cl → PiPLtool → rc → link) against the vendored 25.6_61 SDK with MSVC 14.44, and run
against **After Effects 2026 (26.3)** on this workstation. It loads, stays resident, registers idle and
death hooks, and executed 26 bounded commands with no UI interaction. `list` returned Comp 01 and all
seventeen `Layer-01.aep` layers by name; `probe` reported `keyframes 0 / setStreamValueLegal true`; and
`set 0 16 opacity 42.5` read back **42.5** on a fresh stream reference, inside one undo group. 20/20 repeat
commands passed. The authored fixture's SHA-256 is byte-identical afterwards, and AE's own conversion
dialog says "The original file will be unchanged". Evidence:
`ae-plugin/runtime-adapter/certification/AE-A0-result.json`.

Six findings, and the first four change later phases:

- **F1 — After Effects will not let an unattended supervisor near it without handling modals.** AE 2026
  blocks startup behind a chain — System Compatibility Report, then Crash Repair Options after any unclean
  exit, then the project-conversion notice — and it loads plugins *before* its main window exists, so a
  load marker can appear while the app is still unusable. The crash dialog puts **Start in Safe Mode** and
  **Manage Plugins** one keystroke from the default: either would disable the very adapter the runtime
  depends on. AE-A2 owns this, and it is not a detail.
- **F2 — `AEGP_OpenProjectFromPath` is not safe on the idle path.** Called from the idle hook it returned
  `A_Err_NONE`, opened the project, and then no idle callback ever fired again — AE stayed responsive with
  flat CPU, so this reads as wedged idle processing rather than a hang or a crash. Project lifecycle moves
  off the idle hook in AE-A1/AE-A3, and channel silence is a state the supervisor must detect.
- **F3 — the idle hook is not a scheduler.** It fires only once AE reaches its normal idle UI state, which
  is why nothing completed while the modals were up. A frame path cannot be built on it; that is direct
  input to AE-F0/AE-F2.
- **F4 — `AEGP_GetUniqueStreamID` returned 0** for the layer transform streams probed, on streams that were
  otherwise fully readable and writable. AE-A3's stable-identity work cannot rest on it; identity needs
  item/layer ids plus a canonical match-name path, verified per stream class.
- **F5** installing into the Plug-ins folder needs elevation. **F6** AE 2026 converts an older project on
  open and marks it dirty, so the runtime must never save and certification fixtures should be authored on
  the profile under test (BO0a), not converted.

Practical notes for the next session: the SDK ships `Examples/Resources/PiPLtool.exe` and the Windows build
is genuinely three tools — `cl /EP` the `.r`, PiPLtool it into `.rrc`, `rc` it, then link a DLL named
`.aex` exporting `EntryPointFunc`. In this shell `link` resolves to GNU coreutils, so the MSVC linker must
be called by full path, and `cl` needs `INCLUDE`/`LIB` set explicitly because no developer prompt is
available. `AEGP_GetStreamNumKFs` lives in the **Keyframe** suite, not the Stream suite. Still open before
AE-A0's card closes: the 30 launch/attach cycles, attach-to-running with its ownership policy, and clean
detach without a save prompt.

### 2026-08-11 — L0 started: the licensing question, assembled but unsigned

[`docs/ae-runtime-licensing-decision-request.md`](docs/ae-runtime-licensing-decision-request.md) is the
engineering half of phase L0 of the AE Runtime Container phase plan. **The gate is still open** — its
determination block is unsigned, and no engineer can sign it. Registered in `docs/README.md`.

What it contains: the deployment split into five separately rulable variants (attended operator
workstation; dedicated on-prem machine; render-engine install; VM/private data centre; service to third
parties), six questions written to be answered yes/no, every located Adobe term quoted with its URL, a
nine-item risk register, the constraints this codebase already meets, and rescope paths for a negative
answer. Two questions were added beyond the plan's original four: the binary `.aep` reader against the
reverse-engineering clauses, and the AI/ML, copyleft, region, trademark and audit clauses.

The evidence that changes how the module should be built, whatever counsel says:

- **Adobe already contemplates After Effects being driven by another program.** `aerender` exists to
  "automate rendering", `-reuse` hands work to an *already running* instance, watch folders can start
  rendering automatically, and Software Product Specific Terms §2.2 grants **unlimited Render Engines on
  your Intranet** provided one machine there has the full version. Automation as such is not the problem.
- **The sharpest point for counsel is a silence.** The same document, at §2.6, forbids using Adobe Media
  Encoder "for operations that are not initiated by an individual user", with a narrow exception for
  automating the *start*. Adobe knows how to write that limit. It did not write it for After Effects.
  Whether that silence is permission is exactly what we cannot decide ourselves.
- **The adverse text is equally explicit.** General Terms §3.1 ties a licence to "only one (1) person and
  cannot be shared"; §6.4 forbids use "on a service bureau basis … as a part of a hosted service, or on
  behalf of any third party"; Software terms §1.4(B) forbids hosting/streaming the Software or letting
  third parties access it remotely. A GrapiX-operated rendering service reads as prohibited.
- **Business Product Specific Terms §4 bans "generic user" and shift deployments.** So the AE runtime must
  run in the interactive session of a named licensed operator — never a Windows service under a shared
  "playout" account. Engineering adopted this as a design constraint immediately; it costs nothing.
- **Developer Terms §4.1(A) is the only distribution grant, and it is narrow:** SDK material may travel
  "solely in and with your approved Developer Software **in object code form only**". Headers, sample
  source and documentation have no standalone redistribution right — which is exactly the posture
  `.gitignore:44-50` already enforces (`vendor/adobe/` ignored, `git ls-files vendor/adobe` empty, nothing
  in the build reading it). §§5.1–5.2 additionally reserve Adobe **approval** and may confine distribution
  to Adobe Exchange, which is a product-shape risk, not a paperwork risk.
- **Every vendored SDK file says "ADOBE CONFIDENTIAL … Dissemination of this information or reproduction
  of this material is strictly forbidden unless prior written permission is obtained from Adobe Inc."**
  That per-file notice looks broader than the object-code clause and needs reconciling before anything
  sample-derived ships.
- **Third-party plugins are not Adobe's to license.** General Terms §3.12 puts them "solely between you and
  the third party", and Adobe's own network-rendering page tells operators to ask each vendor "Does the
  license agreement for the plug-in allow installing multiple copies on a network for the purposes of
  rendering?" There is no general answer to give a customer — only a dependency report, which the plan
  already requires.
- **Naming is a licence term, not taste.** Developer Terms §8.2(D) forbids Adobe product names "in whole,
  in part, or in any abbreviated form, in the name or product icon" of a plugin, while Adobe's trademark
  guidelines permit referential use ("for use with"). The plan's working names — "AE Runtime Container",
  "AE Runtime Mode" — are an abbreviated Adobe product name. Internal identifiers are fine; the shipped
  product name, installer and icon must be cleared or renamed referentially.
- **The AI/ML clause is absolute:** Developer Terms §6.16 forbids using Adobe Software output to train or
  improve any model. After Effects frames must never become training data.
- **§6.6 forbids combining Developer Tools with GPL/AGPL/LGPL-style licences.** The adapter's dependency
  licences must be audited before it links anything.

Also recorded so it is not rediscovered: the SDK guide PDF shipped inside the vendored SDK now contains
only a pointer to `ae-plugins.docsforadobe.dev`, which is community documentation whose own repository
says "This project exists for educational purposes only. All content is copyright Adobe Systems
Incorporated." It is not an Adobe legal source and nothing operative rests on it.

### 2026-08-11 — the After Effects module turns around, and gets phased

`docs/direct-aep-import-plan.md` was replaced during the session with the **After Effects Runtime
Container and Live Broadcast Control Plan**. Its filename still says import; its primary direction
does not: **AE Runtime Mode** is the planned use of a licensed local After Effects runtime as
renderer, while **GrapiX Native Mode** is explicit, compatibility-reported conversion rendered by
wgpu. The binary reader is reclassified as the **AEP Static Inspector**, retained for static
inspection and evidence rather than a product import-fidelity claim. The earlier recommendation to
delete every JSX/bridge path was a direct-import cutover finding; it does not claim that the
separately planned runtime boundary is built.

[`docs/ae-runtime-container-phase-plan.md`](docs/ae-runtime-container-phase-plan.md) is the council
execution breakdown of that plan: seven tracks (licensing, cutover, adapter, frame bridge,
container/control/data, playout, output/certification), 33 phases, eight milestones,
**196–295 engineer-days** plus 15–29 certification days. **Nothing in it is implemented.** Registered in
`docs/README.md` under plans.

The council rejected the plan's own §36 P0→P9 order for two reasons. It spends P1–P8 building an
unattended AE runtime and defers the legal review to P9, which is backwards for an irreversible
dependency; and it scatters its own §37 "first POC" across P1–P5, P8 and P9, so the POC either cannot be
first or bypasses its own gates. The revised order answers licensing first (L0, a signed determination
naming the approver, the governing SDK distribution terms and the exact unattended deployment), then runs
two time-boxed killable spikes, then builds everything else.

The two spikes are the whole risk. **AE-A0** proves a resident adapter can hold a licensed AE process
open and mutate one declared static property with no panel click and no remote script endpoint — which
the existing `aeBridge.ts` cannot answer, because `afterfx.exe -r` runs one staged JSX and exits.
**AE-F0** proves a non-capture frame route. They are **serial**, not parallel: the checkout needs A0's
host-callback and thread model.

Useful discovery: the repository already vendors the SDK. `vendor/adobe/sdk/ae25.6_61.64bit.AfterEffectsSDK/`
declares `AEGP_RenderAndCheckoutFrame` → `AEGP_GetReceiptWorld` → `AEGP_CheckinFrame`, ships a working
sample in `Examples/AEGP/Grabba/Grabba.cpp`, marks the synchronous UI-thread render deprecated, and says
`AEGP_SetStreamValue` is legal **only** when `AEGP_GetStreamNumKFs == 0` or `NO_DATA` — so "we can write
that property" is a per-property probe, not an assumption. The route exists on paper; nothing here has
executed it.

Three phase-plan traps worth not rediscovering:

- **The alpha contract must be settled before the transport exists.** `services/render-daemon/src/config.rs`
  rejects straight alpha (`StraightAlphaUnsupported`) and accepts only premultiplied BGRA8 sRGB. A frame
  bridge that proves checkout and defers conversion can pass its own gate and still be unusable.
- **A reference oracle captured through the path under test blesses its own defects.** AE-F0's references
  are exported independently from the AE Render Queue with pinned settings and checksums, and the
  tolerance is numeric: byte-exact for an identity conversion, ≤1 LSB per channel for a declared one,
  exact on fully opaque and fully transparent pixels. "Within a defined tolerance" is not a gate.
- **Renaming a command is a product claim.** CB0 *hides* the AE entry point rather than renaming it to
  "Create AE Runtime Container…", and its gate asserts no container-creation command is reachable until
  the admission diagnostic and the container/supervisor phases exist.

Six §36 gates were unfalsifiable as written ("target format", "stable synchronized", "repeatable",
"defined operator-visible behaviour", "certified workflow", "within the defined comparison tolerance")
and now carry numbers: reconciled frame accounting with an enumerated failure taxonomy, ±1 frame-period
cadence with p99 jitter ≤±25%, ≥3 reconnect cycles, zero-line fill/key skew measured from a capture of
both wires, and 3 cold plus 3 warm runs producing an identical performance class every time. Every
threshold lives in the fixture manifest so it is reviewable rather than argued.

Output reality is unchanged and still gates the end of the plan: NDI exists only under `--features ndi`
and self-reports `hardware_certified: false`; `decklink` and `aja` construct `UnavailableLiveSink`.
Virtual and recording outputs prove local path behaviour and never that a frame reached air.

### 2026-08-11 — a direct `.aep` import council, and what bytes cannot give back

[`docs/direct-aep-import-plan.md`](docs/direct-aep-import-plan.md) is a council plan for a direct
binary `.aep` import module: seven seats, one adversarial chair, two amendment rounds.
**Nothing in it is implemented.** Registered in `docs/README.md` under plans.

The ask was a workflow with no plugin export, no `.aepx`, and no After Effects anywhere in it. The
verdict is a conditional GO for a bounded structural converter and a NO-GO for anything framed as
fidelity: a project file holds structure and stored values, so decoding more of it can reveal an
effect's parameters but cannot produce the effect renderer, the plugin host, the expression engine, or
After Effects' text shaping and colour management. `baked` and `sampled` therefore become illegal
outcomes on this path — there is no bake and no sampler — and `missing-plugin` is meaningless in a
runtime that hosts no AE plugins.

What the audit found in the existing AEP Static Inspector research path
(`rifx.ts` → `aepParser.ts` → `AeManifest` → `sceneConverter.ts` → `runAeImport`), which is
evidence rather than a product capability:

- **The browser cannot send a `.aep` at all.** `ImportAfterEffectsDialog.tsx` uploads only `.aepx`;
  the binary path takes a filesystem path the *API host* must be able to read, so the "direct" reader
  is unreachable whenever the browser and the service are on different machines.
- **Copied footage never reaches the scene.** The collector returns stored paths, `runAeImport` does
  not map them back, and the converter writes `assets: []` with an AE item id as an image `src`.
- **Precomp groups reference children that were never inserted** into the owning scene; `parentIndex`,
  track mattes, blend behaviour and layer in/out/start/stretch are parsed and then dropped into
  opaque metadata.
- **29.97 silently becomes 30**, and every keyframe and marker frame is derived from the rounded rate,
  although `SceneTimeline` already carries an exact rational rate.
- **`preferEditability` is accepted by the UI and the route and read by nothing.**
- **AE provenance is written as `sourceFormat: "psd"`** because the shared enum has no After Effects
  member.
- **The transaction is not one.** Failure removes `assets/after-effects/<projectName>` — which can
  belong to a previous or concurrent import — and never removes the scenes it just saved.
- **Scene ids are `ae-scene-<compositionId>` from untrusted bytes**, so two unrelated projects can
  overwrite each other's scenes through `saveScene`.
- **There is no version or profile reader anywhere**, while `IDTA`/`CDTA`/`LDTA`/`TDB4` are global
  offset tables; `RIFX/Egg!` is container identity and cannot stand in for one.
- **Embedded footage paths are dereferenced automatically** — absolute, CWD-relative, and outside a
  collected root — with following `stat`/`readFile`/`copyFile` and no budget, and import routes check
  only that *a* user is signed in, never `scene.write`/`asset.write`.

The 2026-08-11 direct-import cutover recommendation was that unsafe browser/MCP upload,
composition conversion, and bridge fallback must not be left conditionally reachable. Its
evidence remains: GrapiX uses `py-aep` and `boltframe`'s Go reader only as *offline*
differential oracles, never as a shipped runtime; the invented `aepxParser.ts` does not become
a user import path; and an imported image's `src` must remain the asset's `source` URL because
Preview matches on that and a bare asset id recreates the copied-but-unrenderable defect. The
planned AE Runtime Mode is a separate boundary, while the reader remains AEP Static Inspector
evidence.

The evidence rule tightened. E3 — an AE-authored fixture with its writer build, recipe, hash and
independently captured truth — is mandatory for every released field; E4 additionally requires two
pinned *external executable* readers agreeing on that field, because a specification is not a second
parser. That retires the old comment claiming `py-aep` plus the Lottie AEP notes satisfied a
two-implementation standard. The three fixtures here were written by AE 16.0.0 Win build 235
(`Item-01`, `Layer-01`) and AE 22.1.1 Mac build 74 (`Property-01`), measured locally with the open
version-check algorithm; that is a candidate discriminator, not a certified one. If no E4-proven
structural discriminator can be found, no arbitrary customer project is admissible at all — only
hash-listed lab fixtures — and the cutover phase stays blocked.

A council here is a batch of independent read-only seats — binary format, parser architecture,
workflow, conversion fidelity, security, verification — plus an adversarial chair, each returning
file-and-line evidence, then amendment rounds over the written plan. Four of the first seven jobs died
immediately on an external membership error and were re-run; a settled seat is idle rather than gone,
so the chair and the verification seat were woken again to ratify the amendments instead of respawned.

### 2026-08-10 — one native focus order and session-lived disclosures (Inspector plan P5)

P5 of [`docs/object-inspector-plan.md`](docs/object-inspector-plan.md) is implemented. The Object
Inspector's former plain-button strip is now `ObjectInspectorTabStrip`: a labelled horizontal
`tablist`, one `tab` with `aria-selected=true` and `tabIndex=0`, and one `tabpanel` connected through
matching ids. Left/Up and Right/Down wrap; Home and End select the boundaries. The handler ignores
Tab, Enter and Escape, so native form order and field-owned edit transactions remain authoritative.

Every semantic section rendered below that panel is named through `aria-labelledby`; unnamed
containers in the multi-selection surface are non-semantic `div`s instead. Native Tab therefore
leaves the selected tab for controls in DOM order, with no positive `tabIndex` and no competing
Inspector keymap.

`Masks` and `Imported Design` are real disclosures. Their buttons expose `aria-expanded` and
`aria-controls`, their collapsed content is `hidden`, and
`modules/object-inspector/stores/objectInspectorStore.ts` holds only the two collapsed identities.
That Zustand store is deliberately not persisted: a dock move can unmount the panel without losing
the choice, while a new application session starts expanded.

Evidence: targeted P5 semantics tests **13/13**, `@grapix/editor-web` **485/485**,
`@grapix/shared-types` **202/202**, editor typecheck, production build and workspace boundaries pass.
Live on an isolated API/Editor pair, Right/End/Home/Left navigation maintained exactly one selected
and focusable Text Inspector tab with a correctly labelled panel; native Tab walked the visible
controls in order. Masks stayed collapsed when the Object Inspector moved right → left, while the
focused `Search objects` input retained `caret-check`, focus and caret offset 4. All live Inspector
sections were named.

### 2026-08-10 — real primitive conversion, compound paths and material-instance identity (Inspector plan P4)

P4 of [`docs/object-inspector-plan.md`](docs/object-inspector-plan.md) is implemented. The Mesh
Inspector's primitive selector is now a real destructive conversion, not a type cast over stale data.
`MESH_PRIMITIVE_KINDS` in `@grapix/shared-types` is the one ordered catalogue used by the UI and tests;
`convertMeshKind(objectId, next)` removes model-only source/asset/element fields, drops face slots the
destination cannot address, normalises Slab state, preserves the compatible `main` face, and commits
the conversion as one undo step. The full primitive-to-primitive matrix is pinned by
`mesh-kind-conversion.test.ts`.

The Shape Inspector now authors `compoundPaths` rather than merely counting them. The primary
`shape.path` remains first and untouched for compatibility; additional paths can be added, selected,
edited, moved and removed. Every store boundary normalises the three parallel vertex, in-tangent and
out-tangent arrays before fitting bounds, so malformed imported geometry becomes editable without
changing path order or promoting a hole over the primary outline. Live, two added subpaths reordered
and removed correctly, and changing a subpath anchor to `X = 44` produced one labelled undo action.

Material assignment no longer erases instance identity. `assignMaterialToFaces` accepts and validates
the complete `PrimitiveMaterialBinding`, rejects an instance paired with another base, and persists
`{ materialId, instanceId }`. The Materials tab lists base materials and instances distinctly, resolves
the instance overrides for its thumbnail, and exposes a direct route to the instance inspector;
parameter editing remains owned by Material Manager. Live, two objects sharing `Standard Material`
were assigned different instances and their routes resolved to `#ff3344` and `#3366ff`.

Evidence: `@grapix/editor-web` **480/480**, `@grapix/shared-types` **202/202**, editor typecheck,
production build and workspace boundaries pass. Targeted P4 suites cover the complete mesh conversion
matrix, compound-path structural repair and mutations, instance payload preservation, and mismatched
base rejection. On an isolated API/Editor pair, cube → slab exposed Slab controls and five face groups;
slab → model removed those controls and presented model metadata; compound-path add/edit/reorder/remove
and instance inspector routing were exercised through the live UI.

### 2026-08-08 — which value is in force, and the renderer that resolves none (Inspector plan P3)

P3 of [`docs/object-inspector-plan.md`](docs/object-inspector-plan.md) is implemented. A property can
take its number from three places — the authored field, a keyframe channel, a data binding — and the
panel showed only the first two. `Shared/shared-types/src/propertySource.ts` is the one pure resolver,
reporting `static | keyframed | bound | binding-missing | binding-type-mismatch | binding-unsupported`
with the value Preview draws, the value Program draws, and whether they agree.

**The precedence was backwards in the panel.** Preview prepares a scene as channels, then hierarchy, then
bindings (`sceneMaterial.ts:35-38`), so a binding **overwrites** a sampled keyframe. The Inspector's
field sampled only the channel, so a bound-and-keyframed property displayed a number nothing drew.

**The larger fact was recorded nowhere: the native renderer resolves no data bindings at all.**
`SceneDocumentDto` has no `dataContext` field (`services/render-daemon/src/scene/document.rs:41-54`),
nothing under `services/render-engine/src` resolves a path, and `dataContext` is read in exactly one
place in the Editor. Channels *are* sampled on air (`animation.rs:70-86`). So a bound property animates
in rehearsal and holds still on Program.
`services/render-daemon/tests/data_bindings_are_not_resolved.rs` pins that behaviourally — if native
binding resolution is ever built, the test fails and forces the resolver's wording to change with it.

**A sixth state the plan did not name.** `binding-unsupported`: the path resolves, the type is right, and
`assignBoundValue` drops the write because its guard is `object.type === "mesh"`. Without it, a `scaleZ`
binding on a layer reports `bound` — the exact lie the phase exists to remove.

**F13 was decided by measurement, and the measurement contradicted the plan's preferred fix.** A
container's `scaleZ` set *directly* does reach its mesh child; the same property *bound* does not; and
reordering the pipeline would not have fixed it, because the applier never writes a container's `scaleZ`
in either order. So the binding row goes and the grid column stays — one predicate answering both
questions is what advertised the inert option. `BINDABLE_PROPERTIES` moved to `@grapix/shared-types`
beside the applier that honours it.

**F27 was wrong in both directions.** One `supportsDetailedTransform` flag meaning "not a camera and not
a light" hid seven controls; it was right about six and wrong about a light's `opacity`, which **both**
renderers multiply into intensity (`ThreeSceneLayer.ts:412-413`, `document.rs:1092`) — a working dimmer
reachable only by editing the file. `isPropertyAnimatable` now derives from `PROPERTY_RENDERER_SUPPORT`,
so the Timeline also stopped offering a camera's `scaleY`.

The Data Binding tab's `<pre>` dump of the whole data context is gone; each row states its own
resolution. `setDataJson`/`applyDataJson`/`dataError` were dead store fields with no consumer, so the tab
could name paths into data nothing in the application could create — wired back in as the rehearsal
stand-in for rundown data.

Evidence: `@grapix/editor-web` **438/438** (+11), `@grapix/shared-types` **202/202** (+32),
`cargo test --test data_bindings_are_not_resolved` **4/4**, `--lib animation` **30/30**, typecheck and
boundaries clean. A 7-type × 18-property sweep runs the real `applyBindings` and asserts the resolver
said `bound` exactly when the applier wrote. Live on an isolated pair: `X (px)` read 777 and disabled,
stating "Bound: layout.x · Program draws 220, which resolves no bindings"; `W (px)` stated the string/
number mismatch; a bound `fill` disclosed under its own control. **Found and not fixed:** a light's and a
camera's `zDepth` have a control and no channel, so a camera dolly cannot be keyed — the mesh-path
allowlist was written for 2D paint order and catches them incidentally; held in
`KNOWN_CONTROL_WITHOUT_CHANNEL` with a test that fails when either is fixed.

### 2026-08-08 — one editing grammar, measured rather than assumed (Inspector plan P2)

P2 of [`docs/object-inspector-plan.md`](docs/object-inspector-plan.md) is implemented. The Object
Manager's numeric gesture — scrub, Shift-fine, a transaction that opens on focus and closes on blur —
is now one pure reducer plus one hook in `Editor/apps/editor-web/src/lib/numericGesture.ts`, called by
the grid's cells, the Inspector's primitive fields, its animated fields and the multi-selection surface.
Cutting the grid over was an extraction and its suite stayed green; the Inspector's fields had none of
the behaviour before — no scrub, no Shift-fine, and one history entry per keystroke.

**A step is a property of the property, not of the widget.** This is the finding that mattered, and only
a measurement produced it: both panels decided their own step, so the same 27-pixel drag on `x` moved the
object **2.7px in the Object Manager and 27px in the Inspector**. The grid used an inline
`column.startsWith("scale") ? 0.01 : 0.1` and the Inspector's animated field `props.step ?? 1` with
`step={0.05}` at six call sites. `propertyStep` in `Shared/shared-types/src/propertyConstraints.ts` is
the only answer now, and twenty-one Inspector controls read range, step **and** unit from the table via
one `ConstrainedNumberField` rather than restating them — which is also how `W` came to sit unlabelled
beside an `X (px)`, and how a light's cone carried a hand-typed `"Cone °"`.

**Escape cannot revert by writing a number.** The first implementation restored the value the field
displayed. A mixed field displays none, so on a selection that would have written the active object's
value onto every target — the invented data the mixed field exists to prevent, arriving through the
abandon path instead of the edit path. `revert` now calls the store's existing `cancelHistory`, which
restores the scene the transaction opened on: a batch reverts in full, and a mixed field is mixed again
because no write survives. Verified live on three objects at 100, 200 and 300: typing into the mixed `X`
and pressing Escape left all three untouched and the field reading `Mixed — 3 values`.

**Two relationship clamps were missing, not wrong.** `clampPatch` took the object's *type*, so it could
not consult the other half of a pair. Its comment claimed the camera planes were enforced while the
branch it guarded returned its input unchanged, and the slab bevels were never clamped at all: a
500-unit bevel depth on a 100-deep slab saved 500, showed 500 and drew 50. It takes the object now.
`normalizeSlabBevels` is transcribed from `slabGeometry.ts:50-66`, including the detail that each depth
is capped at the extrusion **before** the pair is scaled — so a bevel deeper than the whole slab loses
its proportion, and the store agrees with that rather than inventing a nicer answer the picture would
contradict.

Evidence: `@grapix/editor-web` **427/427** (+31), `@grapix/shared-types` **170/170** (+30),
`cargo test --test renderer_clamps` **5/5** against
`Shared/shared-types/contracts/renderer-clamps.json`, `typecheck` and `check:boundaries` clean. Live on
an isolated pair (4111 + 5199, data root deleted after): 2.7 in both panels, 0.27 with Shift in both,
`W (px)` stepping like `X (px)`, one Ctrl+Z restoring a ten-write scrub and a three-keystroke typed
value in each panel, and the spot light reading `Cone (°)` 1–179 and `Penumbra` 0–1 — the bounds
`services/render-daemon/src/scene/document.rs:1079-1082` clamps to. **Not seen on screen:** the slab
bevel clamp; no UI route creates a slab, so it is covered headlessly only.

### 2026-08-08 — twelve objects, one edit, one undo (Inspector plan P1)

P1 of [`docs/object-inspector-plan.md`](docs/object-inspector-plan.md) is implemented. The panel read
`selectedObjectId` — the *active* member — while the Object Manager maintained the whole set, so
selecting twelve objects and typing an X moved **one** of them and looked exactly as it does for one.

**Every decision is in one pure service**, `modules/object-inspector/services/multiSelection.ts`, with
`SelectionInspector.tsx` drawing the answer. The single-object surface is untouched.

**Eligibility is derived, not tabled.** Position and opacity always; size only where every target's
geometry is drawn from its box; transform, appearance and type style **only for a homogeneous set** —
then everything filtered through `inspectorControl`, so P0's renderer contract governs a batch exactly
as it governs one object. A rect and a mesh share only `x`, `y`, `zDepth`, `width`, `height`, `opacity`:
a mesh's `rotation` is its legacy Z fallback while a rect's is its only angle, and one number written
into two meanings is the edit that looks fine and is not.

**`Mixed` carries no value, enforced by the type.** `BatchValue` is `{ kind: "same"; value }` or
`{ kind: "mixed"; count }` — the mixed arm has **no value field**, so a caller cannot render the first
target's number by accident. `count` is distinct values, not objects: twelve rects with two opacities
read "Mixed — 2 values".

**`updateObjects(ids, patch, label)` was added to the store**, deliberately not a loop over
`updateObject`: that rebuilds and normalises the scene once per target and deposits one entry each
unless every caller remembers to wrap it. One commit, one entry, one Ctrl+Z.

**The lock gate refuses the whole batch rather than writing the unlocked subset**, and it can be opened
from where it is refused — "Unlock all" acts *on* the locked objects, because a gate with no escape
hatch is a dead end. Visibility and lock are **explicit commands**, not tri-state toggles: with a mixed
selection there is no current state to flip, and guessing one is how an author hides the half they meant
to show.

**The numeric readers are explicit typed accessors, not an index.** Indexing a discriminated union
needs a cast that fabricates a shape the compiler never checked; writing them out also puts each default
in one place, so a missing `scaleX` reads 1 and a mesh's `rotationZ` falls back to its legacy `rotation`
exactly as the hierarchy resolver reads it.

**Evidence.** editor-web **396/396** (+30), shared-types 140/140, typecheck and boundaries clean. Live
on an isolated pair with twelve quads given distinct X and two opacities: header "12 Objects", tabs
Selection / Transform / Materials, summary "12 objects selected · 12 rect · 12 visible · 0 hidden · 0
locked"; **X read "Mixed — 12 values" and Opacity "Mixed — 2 values"**; typing 777 into the mixed X moved
**all twelve**, and **one Ctrl+Z restored all twelve distinct originals**. Locking two disabled **all
ten** batch fields with "2 locked objects must be unlocked… Nothing has been changed." and changed
nothing; "Unlock all" cleared it and the same write then succeeded.

### 2026-08-08 — the Object Inspector stops lying, and a parity claim gets one home (Inspector plan P0)

P0 of [`docs/object-inspector-plan.md`](docs/object-inspector-plan.md) is implemented. It adds no
capability on purpose: eleven controls accepted a value nothing consumes, resized something that ignores
the size, or explained a parity gap incorrectly, and a panel that lies cannot be extended honestly.

**The load-bearing piece is a new contract, not a fix.** `PROPERTY_RENDERER_SUPPORT` in
`Shared/shared-types/src/propertyRendererSupport.ts` says, per object type and property, whether the
value reaches `both` renderers, `preview` only, `program` only, `neither`, or is `editor` state — **and
it holds the wording too**, so a note can no longer contradict the verdict it explains. The Editor reads
it through one pure service, `modules/object-inspector/services/inspectorControls.ts`, which also carries
`CONTROL_MANIFEST`: the panel's own declaration of every control it offers, because there is no DOM in
the test runner and the audit has to see the panel somehow. Adding a control without declaring its
renderer support now fails a test.

**Why a fifth verdict exists.** `editor` marks authoring state — a name, a lock — that no renderer is
meant to consume. Without it `locked` reads as a property nothing renders and the audit demands
disabling it. `neither` then means only what it should: a value that was meant to reach the screen and
does not.

**The type-level downgrade does most of the work.** `document.rs:435-448` prepares six object types, so
no property of an `image`, `line`, `paint`, `camera` or `marker` reaches a published frame. The resolver
derives Preview-only from that one verified fact instead of thirty repeated entries — which is why the
camera panel now tells the operator "Program does not render camera objects, so nothing authored here
reaches a published frame".

**Cross-language agreement is behavioural.** `Shared/shared-types/contracts/program-object-types.json`
is read by both sides; `services/render-daemon/tests/program_object_types.rs` pushes one object of every
declared type through `prepare_scene` and asserts exactly the declared types avoid the "are NOT rendered"
warning. A mirrored list would have rotted; a behavioural assertion cannot.

**A council finding was wrong and the plan now says so.** F6 claimed `paint.paintBlendMode` was an
*enabled* select. It was already `disabled` — `git diff` shows this phase added no `disabled`. The real
defect was narrower: disabled with no reason of its own. It is now a read-only value with the contract's
explanation, and the audit fails on any control that is disabled without saying why.

**Two more stale claims found in the shape panel:** its note said extra subpaths are "preserved but not
yet drawn" while `GpuSceneRenderer.ts:764` draws every one, and said both renderers fill non-zero while
Rust branches on even-odd. Both corrected.

**Also shipped:** W/H deleted for `line`/`shape`/`paint` (their draw paths read them zero times);
`marker.eventName` read-only; `paragraphSpacing` disabled beside `textIndent`/`overflow`; parity notes
for cast shadow, `direction`, `wordSpacing` and the whole camera block; the camera chip reworded off
"program camera"; imported-design effects turned into readouts; imported `textCase` disclosed read-only;
`paint` removed from material surfaces via one shared predicate asserted against the tab descriptors;
the duplicate "Main Material" quick field removed; and the dead `TextProperties` route deleted with the
unmounted `PropertiesSidebar` shell and the `propertiesTab` store field it alone read.

**Evidence, after the exit gate closed.** editor-web **366/366** (+27), shared-types **140/140** (+9),
`cargo test --lib scene::mesh_prepare::tests` **14/14** (+2), `--test program_object_types` 2/2, repo
typecheck and boundaries clean.

**The gate took a second pass, and the four clauses left open were the interesting ones.** The
even-odd requirement is now pinned by **tessellated area**, not vertex counts: a square inside a
same-winding square fills 40,000 units² under non-zero and 30,000 under even-odd, so a count
coincidence cannot satisfy it. The imported-`textCase` clause forced the disclosure condition out of
JSX into a pure `importedDisclosures`, because "shown read-only and not settable" is unprovable while
it lives in markup and there is no DOM in the test runner. And the two live clauses needed objects the
Insert menu cannot make: a **paint layer** was drawn with the real Brush tool by driving the mouse
across the canvas, and a **line** plus an object carrying **imported effects** came through the real
Import Design dialog from a hand-written Figma fixture — `LINE` maps to a `line` object
(`grapixObjectConverter.ts:340`) and node effects land in `importedDesign.effects` (`:208`). The
imported section then measured **2 effects, 7 read-only readouts, 0 editable inputs, 0 checkboxes**.

**Still unseen on screen:** the marker event readout. Nothing in the app creates a `marker` object, so
there is nothing to select; it is covered headlessly only, and that is the honest limit.

### 2026-08-08 — the reference products disagree with us about which end of the list is the front

[`docs/object-manager-reference-ux.md`](docs/object-manager-reference-ux.md) measures Ross XPression's
Object Manager and Vizrt Viz Artist's Scene Tree against the shipped GrapiX Object Manager, and plans
six `R` phases. **Nothing in it is implemented.** Registered in `docs/README.md`.

**The finding worth remembering: both named reference products put the front of the stack at the
bottom of the list, and GrapiX puts it at the top.** XPression renders the object list bottom-up, and
Viz Artist under Z-Sort draws lower containers later — so in both, the bottom row appears in front.
GrapiX inverts each band for display (rules 180–181), so a row visually above is later in render order
with a greater `zIndex`: the After Effects, Photoshop and Figma convention.

**This was kept, deliberately**, on four grounds: `docs/3d-engine-architecture.md:4` names After
Effects first in the target; every importer GrapiX has (PSD, AI, SVG, Figma, AE) speaks top-is-front,
so flipping would invert every import against its source; rules 180–181 exist because the inversion is
precisely where drop indicators broke, and the P2 live pass proved the current behaviour; and the panel
and canvas already agree with each other, so it is a convention rather than a correctness bug. What is
genuinely wrong is that the convention is **undiscoverable** — nothing in the panel says which end is
the front. R0 fixes that; R5 offers an opt-in inversion as a *panel preference* that never touches the
document, gated behind re-running the whole 19-case drop grammar under both directions.

**Where the references are ahead, and it is not scattered:** four of the five gaps are about navigating
and diagnosing a big scene. Viz Artist makes the row a **launcher** — geometry/material/transform icons
open their editors, and middle-click gives a Quick Editor popover — while GrapiX's three status dots are
deliberately inert (`ObjectManager.tsx:1606-1609`, `aria-readonly`, `tabIndex={-1}`). Viz has **colour
labels** on containers; GrapiX has `tags` on assets and materials but never on a `SceneObject`. Viz can
**sort the tree by render time or texture size**, which makes the tree answer "what is eating my frame"
— nothing in GrapiX does this (`grep renderTime|renderCost|textureSize ObjectManager.tsx` → 0), and it
is the standout idea to steal. XPression has a per-Layer **Depth Sorting: Manual or Automatic**, where
GrapiX's `sortObjectsForRender` is unconditional `layerId → zDepth → zIndex`
(`rendering/sceneMaterial.ts:192-204`).

**Where GrapiX is ahead of both:** editable, scrubbable property columns inside the tree with a
per-cell stopwatch keying at the playhead; full `treegrid` semantics and keyboard model; persisted
column and width preferences; and multi-selection with anchor/active semantics. Neither reference
product appears to put editable property columns in its tree at all.

**Two things were declined as regressions dressed as parity:** XPression's positional masking (a mask
affecting everything above it in the tree) is more error-prone than the per-object `ObjectMask[]` model
GrapiX shares with After Effects; and "Text Always on Top", a per-object override of global sort order,
makes a scene unexplainable when the depth-sort mode covers the legitimate case.

**Method caveat recorded on purpose:** the vendor claims come from research grounded on `rossvideo.com`,
`rossvideo.community` and `vizrt.com`, each cross-checked across two or three differently-phrased
queries — **the XPression and Viz Artist manuals were not read directly.** The study states a confidence
per claim and names what would settle each. No phase depends on a Medium-confidence claim without
saying so. Do not quote the ordering finding in a release note before checking the primary guide.

### 2026-08-08 — the Object Inspector council: what the panel says versus what the renderers do

[`docs/object-inspector-plan.md`](docs/object-inspector-plan.md) is a council plan for the Object
Inspector: five seats, one adversarial round, 27 findings, eight disagreements resolved and two
dissents recorded. Registered in `docs/README.md` under plans. **Nothing in it is implemented.**

The panel's problem is not missing properties — of 13 object types, only three fields have no editor
anywhere (`textCase`, `blendingOptions`, `zIndex`, and `zIndex` belongs to the Object Manager). The
problem is **honesty**: eleven controls accept a value nothing consumes, resize something that ignores
the size, or explain a parity gap incorrectly. The worst are `W/H` on `line`/`shape`/`paint` (their
draw paths read `object.width/height` **zero** times), editable `importedDesign.effects` parameters
(`IMPLEMENTED_OBJECT_EFFECTS` is `Object.freeze([])`), a writable `marker.eventName` nothing
subscribes to, and a camera button whose title claims Program authority the Editor does not have.

**Three seats refuted the lead's own evidence brief, and being refuted was the point.** Typed
`effects` has no editor at all — the editable controls are `importedDesign.effects` *metadata*.
`compoundPaths` **is** drawn (`GpuSceneRenderer.ts:764`), so its "preserved but not drawn" note is
stale and its uneditability is a real gap. `pathAnimation` is fully editable. And the `fillRule` note
was **confidently wrong in the operator's favour**: it claims both renderers fill non-zero, while
Rust branches on `evenodd` (`mesh_prepare.rs:1366`) and Preview never reads the field at all
(`grep -c fillRule GpuSceneRenderer.ts` → **0**). A wrong parity note is worse than no note, so a
parity claim is now admissible only with a renderer file:line.

**The adversarial round returned `do not execute` on the first draft.** P0's central exit gate —
"no enabled control for a property neither renderer consumes, derived from shared lists" — was
**unprovable**: `IMPLEMENTED_BLEND_MODES`, `IMPLEMENTED_TEXTURE_FIT_MODES`, `IMPLEMENTED_MASK_MODES`
and `IMPLEMENTED_OBJECT_EFFECTS` exist, but **nothing declares per-object-property renderer support**,
so the test could only hard-code the parity list it promised not to. The amendment makes
`PROPERTY_RENDERER_SUPPORT` — a per-type, per-property `both | preview | program | neither` map in
`Shared/shared-types`, mirrored in Rust — the load-bearing item of P0. It also killed a false
guarantee: a "byte-identical round trip" is impossible regardless of this plan, because
`normalizeScene` writes defaults on load (`editorStore.ts:3259-3301`); the real contract is
**deep preservation** of the specific retained fields.

Other decisions worth keeping: a twelve-object selection currently edits **one** object silently
(`Inspector.tsx:36-45` reads `selectedObjectId` while the set lives at `editorStore.ts:143-150`), and
a mixed value must read `Mixed` rather than the active object's number. A binding **overrides** a
keyframe at render time while the field displays the keyframe. Per-face material binding already works
and was wrongly suspected missing. The Object Manager's one-tab-stop treegrid rule **does not**
transfer to a form — only panel scoping, field-owned drafts and conditional focus restoration do.

### 2026-08-08 — a treegrid you can drive from the keyboard, and the measurement that redirected the work (plan P4)

The Object Manager is now navigable without a pointer, describes itself honestly to a reader, and is
fast enough to hold an arrow key down. This closes the four-phase plan in
[`docs/object-manager-plan.md`](docs/object-manager-plan.md).

**One walker.** `modules/object-manager/services/objectManagerTree.ts` owns the row projection:
`buildTreeRows` flattens bands, objects and masks into the list the panel draws, and the render
iterates it. The recursion and the `flatMap` are gone, along with the second walk that used to build
`visibleRowIds` — the draw order, the indentation, the set metadata and the navigation order are now
the same list. The band wrapper `div` went with it: it set a min-width every row already sets, and
while it existed the rows were not siblings, so no `aria-rowindex` over the panel could be true.

**Semantics.** `role="treegrid"` with `aria-colcount`/`aria-rowcount`, `columnheader` headers,
`rowheader` name cells, `gridcell` elsewhere, `aria-colspan` on the mask value cell to match its CSS
span, `aria-readonly` where a cell cannot be edited, and `aria-level`/`aria-posinset`/`aria-setsize`
per row. `aria-expanded` appears only on rows that reveal something. The scene name left the row
collection and became a heading — it was a one-cell `role="row"`, which made every row index off by
one and offered a reader a row with no object in it.

**The keyboard is a pure reducer.** `objectManagerKeymap.ts` answers every key; the handler holds no
opinions. `consumed` is deliberately separate from the intent, because a key can be ours and mean
"do nothing" — End on the last cell must not scroll the panel away. Left/Right resolve by position:
hierarchy on the first cell, movement everywhere else, never both. Ctrl+Alt+A and Ctrl+Alt+C pass
through untouched, and a live edit owns every key including Enter and Escape, whose handlers already
sit next to the input.

**Focus is resolved purely and applied conditionally.** `objectManagerFocus.ts` answers *where* the
tab stop belongs; whether to move the caret is a separate flag, true only when the focus was already
in the panel. After a delete it prefers the next **object** row, then the previous one, then the
heading.

**Three defects the spec did not predict, all found live.**

1. **The column budget belongs to the row, not the grid.** A band draws four cells and a mask five.
   With one width for the grid, arrowing from column 6 of an object row onto a band spent four presses
   walking an invisible index while nothing moved. `TreeRow.cellCount` is part of the projection now.
2. **A plain arrow has to carry the selection.** Moving the tab stop alone left the selection anchor
   behind, so the next Shift+Down claimed everything in between — measured as a three-row gesture
   selecting 197 rows. Plain Up/Down select; the accelerator navigates without disturbing the set.
3. **The DOM is the authority on where the caret is.** Clicking a lock button focused a cell the
   keymap knew nothing about, so the next arrow moved from wherever the keyboard had last been.
   `onFocusCapture` adopts the focused cell.

**The measurement redirected the phase.** The plan said to defer virtualisation past ~250 rows and
record a number. The number said the panel was already unusable at 199 rows: **85 ms per arrow key**,
because moving one tab stop re-rendered every row and every cell, and a selection change did it again.
So the work went into removing those renders, not into windowing. The roving tab stop left React —
it lives in a ref and two DOM writes, re-asserted after each commit — taking pure navigation to
**0.2 ms**. The object row became a module-level `memo` component whose props are primitives plus a
stable handlers **ref**, taking a selecting arrow from **80 ms to 15 ms**. Marginal cost is now
**~14 µs per row**, so windowing at 250 rows would buy under a millisecond. Deferred on evidence.

**Evidence.** `@grapix/editor-web` **339/339** (+57: 14 projection, 30 keymap, 13 focus);
`@grapix/shared-types` 131/131; repo `typecheck` and `check:boundaries` clean. Live on an isolated
pair (4111 + 5199) with a 200-object fixture inserted through the real Insert menu, data root deleted
after: `aria-rowcount` 202 for 201 rows plus a header, 7 `columnheader`s, 201 `rowheader`s, 1,203
`gridcell`s, and **exactly one tab stop** throughout. Keyboard-only navigation, selection, rename and
delete all passed; F2/Enter committed a rename and returned focus to the owning cell; Delete landed on
the successor in the same column; filtering 198 rows to 11 and back never moved the caret out of the
search box. A mask added live reported level 3, contiguous cells 0–4 and `aria-colspan` 3. Drag
reorder, click/Shift/Ctrl selection and `material-drop-blocked` still hold after the row extraction.

### 2026-08-08 — row grammar, and preferences that survive a refresh (plan P3)

The Object Manager's rows are now editable in place and the panel remembers the author's working set.

**Two lifetimes, deliberately different.** `modules/object-manager/stores/objectManagerStore.ts`
persists the chosen **columns, column mode and name-column width** under `grapix-object-manager-v1`;
**collapse is session-scoped** — it survives a re-dock (the original complaint) but not a reload,
because persisting it means a scene-id→node-id map with stale-entry pruning on every projection, for
something an author rebuilds with two clicks. The column state was **removed** from `uiStore` rather
than duplicated. Reading is defensive per field: an unknown column id is dropped (it would otherwise
leave a permanent blank stripe), an unknown mode falls back, and the width is clamped 120–480 on read
so a stored value from a changed clamp cannot break the layout.

**Row grammar.** Double-click or F2 renames in place — draft state, Enter commits, Escape reverts,
blur commits, deliberately *not* the mask row's live input which writes the scene per keystroke. A
colliding rename **holds the field open** with the reason rather than reverting the typing. Per-object
lock sits in its own column; a locked row dims and stops being a drag source. The band chevron is
wired (it was decoration). The disclosure control counts **masks** as children, so a group whose only
contents were masks is no longer unopenable. `window.alert` is gone.

**`window.alert` and the slug.** The old band rename lied twice and then blocked the app: the input
was seeded with the raw slug while the band displayed Title Case, and the alert quoted the raw draft
while the store decided the collision on the **normalised** id — so "Lower Third" collided with
"lower third" and the message named neither. `store/layerIds.ts` now owns `normalizeLayerId` (moved
out of `editorStore`, not copied) and `services/objectManagerNaming.ts` predicts the store's answer,
shown inline with the resulting slug as a live hint.

**Also fixed:** band aggregates read the whole band, not the search-filtered rows — the eye and the
lock write every object in the layer, so under a search the header described one set and acted on
another (`services/objectManagerBands.ts`, and an empty band is *not* "all locked" because `every` on
an empty list is true). Badges: a layer object showed its bare `layerKind`, so `camera` collided with
a camera object's `Persp`/`Ortho`; mesh/light kinds are clipped with the full kind in the title. Mask
indent gained a half-step offset (a mask under a depth-0 object landed on exactly the same 38px as a
depth-2 object). A clipped numeric cell now names its exact value in the title.

**"Hide others" / "Show all", not solo.** Solo would be either a scene field the renderers must honour
or a canvas compositing filter; the third option — writing `visible: false` across the scene while
calling it view state — corrupts the document and loses the author's real visibility on undo. These are
honest visibility writes, one undo step each, and a selected container's descendants stay visible with
it.

**A CSS trap worth knowing:** `nth-child` counted mask rows, so the zebra stripe inverted below every
object owning a mask — and `nth-of-type` does not help, because it counts *tags* and both rows are
`div`. There is no selector for "nth of this class"; the parity is computed from the row's index in the
visible order and applied as a class.

Verified: editor-web **282/282** (+24), repo `typecheck` and `check:boundaries` clean. Live on an
isolated pair (4111 + 5199, own data root, deleted after): rename committed on Enter; a collision held
the field open with `aria-invalid` and **no OS dialog**; a locked row dimmed and reported
`draggable=false`; the band rename seeded with "Main" and hinted `id: lower-third`; the band chevron
collapsed 3 rows to 0; Hide-others kept the selected group's child visible and undid in one step. The
persistence gate: name column dragged to 400px plus a fourth column, then a **reload** restored both
and left the band **expanded**.

### 2026-08-08 — drag to reparent, and two bugs only the live pass could find (plan P2)

Object Manager rows are draggable. The grammar is a pure module,
`modules/object-manager/services/objectManagerDrop.ts`: top/bottom quarter of a row is
`before`/`after`, the middle half of a **container** is `into`, the middle of a leaf takes the nearer
edge (never a dead zone), a band row is `into-layer`, and the scene row places after the band's last
root. Every refusal is decided **on hover**, never after the drop — a target inside the dragged
subtree, a camera layer asked to hold a non-camera, a locked object *anywhere in the dragged subtree*,
a locked `into` target. Dropping something back where it already is is a `noop` with no indicator,
deliberately distinct from `invalid`: an author who put something back has not made a mistake.

`store/objectHierarchy.ts` now holds the four container predicates — `isContainerObject`,
`isAllowedContainerChild`, `containerContains`, `collectContainerSubtreeIds`, plus `parentOfObject`.
They were private to `editorStore`; the resolver needs the same rules to refuse a drop while the
pointer is over it, and a private copy in the panel is how an indicator ends up promising a drop the
store refuses. `applyObjectDrop` sequences the whole gesture in the store (detach → adopt → reorder)
as **one** history step, because a panel that got that order wrong would leave a half-moved subtree.
`moveObjectToLayer` was fixed to carry the subtree and detach from any parent (it had no callers while
it moved a single object, which is why the defect never surfaced). `reorderObjectsInStack` splices the
band's flat render order and finishes through `normalizeObjectStack`.

The search projection moved to `services/objectSearch.ts` and keeps a match's **ancestors** and a
matched container's **descendants**. Filtering the flat list showed a matched group as empty and
lifted a matched child to a root — a misreported parentage that was merely confusing in a read-only
list and is a trap once you can drop against it.

**Two defects the live pass caught and no unit test would have:**
1. **Dragged ids in React state.** `dragover` runs inside its handler and a `dragstart` state update
   has not applied yet, so the first hover read `[]`, resolved `noop`, and drew no indicator until the
   pointer moved again. They live in a **ref** now.
2. **The indicator showed the store's kind, not the author's.** The grid draws each band reversed, so
   the panel flips before/after for the store — and doing that flip *before* choosing the indicator
   drew the insertion line on the opposite edge: hovering the top of a row promised a landing at its
   bottom. `resolveRowDrop` returns screen terms; `inRenderOrder` flips exactly once, on the way in.

Verified: editor-web **258/258** (+38 — 19 grammar, 12 store, 7 search), repo `typecheck` and
`check:boundaries` clean. Live on an isolated pair (4111 + 5199, own data root, deleted after): top
edge drew the line above and bottom edge below; a group showed the accent ring with the line indented
to depth 1 (23px); dropping Background 2 on the **top** edge of Background 3 put it **visually above**
and one Ctrl+Z restored the order; dragging a group onto another band carried its child with it, both
landing with the nesting intact, and one undo returned both; dragging a group onto its own child showed
the danger ring and **mutated nothing**; a material drag over the same row still resolved to
`material-drop-blocked`, so the two gestures never crossed.

### 2026-08-08 — Ctrl+Z, and history steps that say what they are

Undo existed but **had no keyboard binding at all** — a menu item and a top-bar button, nothing
else — and every step was anonymous: `beginHistory(label)` collected a label and `commitHistory`
threw it away, so nothing could tell an author what a keystroke was about to take back.

`SceneHistoryEntry` in `Shared/shared-types` replaces the bare `SceneDocument` snapshots:
`{ scene, label?, scope? }`, where the label describes the change the entry **reverts** and `scope`
is the module that made it. `undoSceneHistory`/`redoSceneHistory` also return `applied`, the entry
they used, so a caller can report what just happened. Redo carries the same description, because it
re-applies the same change.

`Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` are bound on `window` in `App.tsx` through the pure
`lib/historyShortcut.ts` (`resolveHistoryIntent`, `isTextEntryTarget`, `describeHistoryStep`). Two
refusals are the point of that module: a **text-entry target keeps the browser's own text undo**
(stealing it would make typing feel broken *and* silently revert a finished scene edit), and an
**Alt chord is not ours** — Ctrl+Alt+A and Ctrl+Alt+C belong to the assistant and the console.

**Why undo is on `window` when rule 4 forbids a global Delete:** undo is not destructive-in-place. It
moves the document back one step whichever panel made that step, and every surface names the step
first, so nothing is reverted anonymously. Delete acts on whatever the focused panel is pointing at,
which is why it stays panel-scoped.

**Module-level undo, and what it deliberately is not.** Each dock panel that owns scene state gets
its own `HistoryControls` in its header (one wiring point in `DockWorkspace`), and each panel credits
its own edits through `setHistoryScope` on `onPointerDownCapture`/`onFocusCapture`; the canvas does
the same with scope `canvas`. That is **attribution, not a private stack.** Independent per-module
stacks over one shared `SceneDocument` are unsound: popping module A's older snapshot while module
B's newer edit stands yields a document that never existed and silently discards B's work. So a
module's own button drives the one history and *names the owner* — live, the Object Manager's undo
button reads "Undo Timeline · Hide object" when the newest step was the Timeline's, rather than
reverting it without saying so.

`Ctrl+Z` **during a gesture abandons the gesture** instead of popping the stack: an open
`historyTransaction` means a drag/scrub/pen path is in flight and has not been committed, so popping
would take back the *previous* change and leave the half-finished one standing. `undo()` checks for
an open transaction first.

Labels come from `describeObjectPatch` (Hide/Show/Lock/Unlock/Rename/Move/Scale/Rotate object) plus
explicit labels on add, duplicate, delete, rename, stack moves and pen-shape create. An unlabelled
step still undoes; the UI just says "Undo".

Verified: shared-types **131/131** (+2), editor-web **220/220** (+24 — 12 for the shortcut table, 12
driving the store), repo `typecheck` and `check:boundaries` clean. Live on an isolated pair
(4111 + 5199, own data root, deleted after): the Object Manager's tooltip read "Undo Add Cube 1"
then "Undo Hide object"; a real pointerdown in a panel produced "Undo Object Manager · Hide object",
and crediting the Timeline made the Object Manager's own button read "Undo Timeline · Hide object";
Ctrl+Z undid, Ctrl+Shift+Z and Ctrl+Y both redid, and a Ctrl+Z dispatched at the search input left
the scene untouched. Every scene-owning panel header carried a control. No page errors.

Scope was chosen deliberately and is **the open scene only**. Project-level operations —
`templateStore` add/duplicate/rename/**delete** of scenes, asset and font imports — remain outside
undo: several are server-backed or content-addressed on disk, and a scene delete is not reversible
without a soft-delete/trash that does not exist. Do not describe undo as covering the project.

### 2026-08-08 — one object selection, and four things that were never undoable (plan P1)

`editorStore` now owns the whole selection: `selectedObjectIds` (document order),
`selectedObjectId` **unchanged in name and meaning** as the *active* member — which is why ~100
single-object read sites across 14 files needed no edit — and `objectSelectionAnchorId`.
`selectObjects(ids, { active?, anchor? })` is the only writer; `selectObject` is a shim over it.
`uiStore.selectedPathObjectIds` is **deleted**, not aliased.

The gesture table is a pure module, `store/objectSelection.ts`: replace / toggle / range /
rangeAdd / selectAll / clear, plus `normaliseObjectSelection` (order, and the invariant that the
active id is always a member) and `reconcileObjectSelection`. It lives beside the store rather than
in `modules/object-manager/` because three surfaces read the selection and **only the store can
prune it in the same `set` as the mutation that invalidated it** — a `uiStore` copy needs a
reconciling effect, which paints one frame where the alignment toolbar counts deleted ids.

A Shift range spans `visibleRowIds` (what is on screen, collapsed descendants excluded); Ctrl+A
takes `selectableIds` (every search match, collapsed descendants **included**) so Ctrl+A then Delete
cannot orphan a collapsed child. Ctrl+A and Escape are panel-scoped on a focusable
`.scene-grid-scroll`, never on the document (rule 4).

**Four mutations were never undoable and are now.** `updateObject`, `moveObjectInStack`,
`addObject`, `duplicateObjectById`, `deleteObjectById`, `setPropertyAnimationEnabled` and
`setAnimatedPropertyValue` all wrote a bare `set({ scene: touchScene(...) })`, so **deleting an
object produced no undo entry at all**. They route through `commitScene`, which deposits nothing
while a history transaction is open — so a wrapped gesture is still one step. The panel's numeric
scrub had no transaction either (it wrote a scene per pointer move and left nothing to undo); it now
opens on pointer-down and typing opens on focus, closing on blur.

**The playhead no longer re-renders the panel.** `TransformCell` is `memo`ised and split: a cell
with no channel never subscribes to `currentFrame`, and `AnimatedTransformCell` subscribes only for
the cells that display one. The frame is *read* when the author acts (`useUiStore.getState()`), so a
keyframe still lands at the playhead. Before this, one tick re-rendered every row and every cell of
the whole tree.

Other repairs that came with it: `applyMarquee`'s active pick was `next.at(-1)` — whichever object
sorted last — and is now the topmost match, so the panel and the alignment tools agree on the key
object; a Timeline row click preserves membership when the clicked object is already selected rather
than silently collapsing the set; `lib/pointerCapture.ts` extracts the Timeline's private guarded
`capturePointer` (the scrub's unguarded call threw on every synthetic pointer — rule 121); the design
toolbar's "N paths" reads "N selected"; and the panel's dead `PropertyInspectorContent` /
`view` / `selectView` residue is gone.

Verified: editor-web **196/196** (+38 — 21 for the reducer, 17 driving the real store), repo
`npm run typecheck` and `check:boundaries` clean. Live on an isolated pair (4111 + 5199, own data
root, deleted after): a single selection renders byte-identically to before; Ctrl+click gives two
members and one accent bar and *enables the alignment tools*; deleting a four-object selection took
**one** undo to restore; aligning a selection made entirely in the panel moved one object to meet
another and left the unselected one alone; a 12-move scrub wrote one undo entry; the animated cell
followed the playhead 300 → 600 → 900 while still rows did not re-render. No page errors.

A trap worth knowing: Vite's HMR served a **stale broken module** compiled from a mid-edit state and
the page went blank with "does not provide an export named 'ObjectManager'". The code was fine —
restarting the dev server cleared it. Do not debug a phantom export error before restarting Vite.

### 2026-08-08 — the Z column stopped lying (Object Manager plan P0)

[`docs/object-manager-plan.md`](docs/object-manager-plan.md) is a council plan for the Object Manager
panel: five seats, one adversarial round, nine review findings and four authoring-seat corrections
folded in, two dissents recorded rather than resolved. Registered in `docs/README.md` under plans.
**P0 of it is implemented**; P1–P4 are still plan.

The finding the plan exists for: **animating `zDepth` on a 2D object
works in the Editor and does nothing on air.** `evaluatePropertyChannelsAtFrame` patches every
animated channel for every object type (`Shared/shared-types/src/index.ts:582-587`), `CanvasStage`
evaluates per frame (`:223-231`) and `sortObjectsForRender` orders by
`layerId → zDepth → zIndex` (`rendering/sceneMaterial.ts:192-204`) — so Preview re-sorts live.
`animation.rs` discards `AnimatedProperty::Z` for quads (`:498-504`) and texts (`:527-530`) and
never re-sorts, while a **mesh** applies it as a real Z translation (`:569-577`). So rule 50 is
broader than the code it describes: mesh depth animation is implemented and correct. The stopwatch
is offered by both the Object Manager's Z column (`objectManagerColumns.ts:42-71`) and the
Inspector's Position Z field (`Inspector.tsx:151`) because `isPropertySupported` answers `true` by
default (`objectPropertySupport.ts:37-64`), and package preflight cannot consult that rule at all —
it lives in `Shared/shared-types` (`:3967`) and cannot import from `Editor/`. The plan's P0 moves
animatability into `Shared` for that reason.

**P0, as shipped.** `isPropertyAnimatable(objectType, property)` in `Shared/shared-types` is the one
authority, and the gate is **the mesh path, not `mesh`** — a bezier `shape` is tessellated into a
`PreparedMesh` (`services/render-daemon/src/scene/mesh_prepare.rs:740`) and so animates Z exactly as
a mesh does. Gating shapes would have deleted working behaviour; that correction was found before
any code changed. `evaluatePropertyChannelsAtFrame` now skips a rejected channel, so Preview stops
animating what Program discards. `objectManagerColumns.isColumnAnimatable` gates the grid cell (no
stopwatch, no diamond, number still editable, `.no-stopwatch` reclaims the padding) and
`animatedColumns` ignores an inert channel so **Keyframed** cannot show a column nothing plays. The
Inspector's `AnimatedNumberField` gates itself for every property it renders. Preflight emits
`ANIMATION_CHANNEL_NOT_RENDERED` as a **warning** naming the object — a warning, because after the
evaluator fix the scene renders identically with or without the keys, and blocking a package over
inert keys would stop a show for a cleanup. Keys are never stripped.
`fixtures/animatable-properties.json` is emitted from the rule and asserted by `animation.rs`'s
`the_animatability_table_matches_what_this_module_applies`, which also proves both sides
behaviourally in the same test so it is not a second copy of the list.

Verified: shared-types **129/129** (+5), editor-web **158/158** (+3), api-server **118/118** three
runs in a row, `cargo test --lib` animation **30/30** (+1), repo `npm run typecheck`,
`check:boundaries`, `fixtures:check` all clean. Live on an isolated pair (project service on **4111**
with its own data root, Vite on **5199** via `VITE_GRAPIX_API_URL`, per rule 118): a text, a cube and
a rect, all ten columns. Typing 42 into the rect's Z took **and the row re-sorted** — `zDepth` is a
live sort key, which is the whole reason the animation could never have worked. The cube's Z
stopwatch still keyframes and **Keyframed** then resolved to exactly `Z`. Inspector: Position Z had
no stopwatch on the rect with its alignment intact, and a working one on the cube.

**Answered while implementing, and deliberately not gated:** mesh `width`/`height`/`opacity` are the
same defect with a different property — the engine bakes object opacity into the prepared surface
once (`mesh_prepare.rs:555`, `:977`) and the per-frame path skips all three
(`animation.rs:578-582`), while `ThreeSceneLayer` feeds `object.opacity` into the mesh material
(`:227`, `:602`, `:730-736`) so the preview animates it. Not gated because `shape` shares that path
and fading a vector logo is ordinary authoring, so the honest repair is an engine that patches
prepared surfaces per frame. Its own decision, not smuggled into P0.

**Unverified lead, worth a session of its own:** nothing in Rust reads `childIds` — `grep` over
`services/render-daemon/src` and `services/render-engine/src` returns nothing — and
`resolveSceneObjectHierarchy` is called only in the Editor (renderers, store), not in the publish
path, not in Playout. Since `setContainerChild` *localises* a child's transform on adoption
(`editorStore.ts:579-581`), a published group's children may draw at their local coordinates on air.
That would be far larger than an animation gate. It was not chased and is **not** established — the
greps are the whole evidence.

Two stale entries in this file were corrected in passing: the module map listed a
`SceneInspector.tsx` that has not existed since the rename to `ObjectManager.tsx`, and the claim
that chosen columns are "remembered" is true only across a re-dock — `uiStore` is a plain `create`
with no `persist` middleware (`store/uiStore.ts:1`, `:196`), so nothing in it survives a reload.

### 2026-08-04 — Figma clip groups become compositions, and image fills become local files

Two faults, both of which made an imported Figma design look nothing like the file.

**Clipping.** A clipping frame used to push a mask onto every descendant. That is not a structure an
author can edit: the clip existed in as many copies as there were layers, and reshaping it meant
editing all of them. It is now one nested composition, built in `clipResolution.ts`:

```text
Clip Composition        (the frame's identity, position, rotation)
  +- <name> clip shape  (its exact outline: width, height, corner radii, and its paint)
  +- <name> contents    (carries the clip; every original child inside, transforms untouched)
```

The clip reaches the layers that actually draw through `resolveSceneObjectHierarchy`, which now
inherits `masks` down the tree and re-expresses each one in the receiving object's own space
(`inverse(localToScene) · toScene`, so a rotated container's clip arrives rotated, not merely
offset). A clipped frame inside a clipped frame nests, and a descendant carries both clips. The
frame's own paint moved to the clip shape so the composition does not paint it twice.

**Images.** Figma stores nearly every photograph as an `IMAGE` paint on a rectangle — there is no
image node. The importer read only the first fill, ignored strokes, and left the paint's short-lived
S3 URL in the scene, so photos arrived as flat rectangles that would have gone blank within the
hour. Now every `imageRef` in fills *and* strokes is collected, deduplicated per document,
downloaded once, and stored at `images/<scene>/<layer>.png` — a name a designer recognises, in the
project, beside the scene. The scene references that path and nothing else; `scaleMode` maps to
`objectFit` (`FILL`/`CROP` → cover, `FIT` → contain) and the whole paint record — crop matrix,
rotation, opacity, blend mode, filters — travels in `importedDesign.imagePaint`.

A project-relative path is not fetchable from a page, so `resolveProjectAssetUrl`
(`lib/projectAssets.ts`) resolves it against the project service, and every consumer goes through
it: the GPU renderer, the SVG template preview, the material panels, the font registry. Publishing
inlines images as well as fonts (`inlinePublishedAssets`), because Playout keeps rendering after the
Editor closes and cannot resolve a path into the Editor's disk. `apiBaseUrl` now reads
`VITE_GRAPIX_API_URL`, as Playout's already did.

Verified: `figmaClipComposition.test.mjs` (7) and `figmaImageAssets.test.mjs` (8) — the latter runs a
whole import into a scratch `GRAPIX_DATA_ROOT` with a stubbed Figma, then asserts the stored files,
the served route, its cache headers, a refused traversal, and a save/reload round trip. `api-server`
**72/72**, `editor-web` **120/120**, full `npm test` and `npm run typecheck` clean,
`check:boundaries` passes. Live: the editor preview draws an imported checkerboard image clipped to
a rounded card, fetched from `127.0.0.1:4177/images/image-probe/photo.png` and from nowhere else.

Shipped: `npm run build`, then `npm run build -w @grapix/desktop-tauri` and
`npm run build -w @grapix/playout-desktop`, with every application stopped first — a live
`grapix-render-engine.exe` holding `target/release` is what killed a `tauri build` earlier today.
Four installers rebuilt (Editor 58.4 MiB MSI / 39.2 MiB NSIS, Playout 42.0 / 28.9). The engine
sidecar is unchanged (2026-08-02): no Rust was touched. The changes were then read back out of the
shipped files rather than inferred from exit codes — the staged
`services/grapix-api-server.mjs` is byte-identical to the fresh bundle (`dbe9a7b5…`) and carries the
clip-composition names, `storeProjectImage`, `syntheticLayers` and the image route's
`max-age=31536000`; the web bundle carries the minified `resolveProjectAssetUrl` (scheme test plus
`${base}/${path}`), the mask inverse transform, the Pixi `parser: "loadTextures"` hint and the
publish-time asset inlining. Pixi's `loadParser` deprecation warning is gone: the five remaining
occurrences are inside Pixi's own compatibility branch.

**Then it rendered nothing, and why.** The first real file imported through this — a 1920x1080 board —
came out with a completely transparent canvas and correct bounding boxes. `geometry=paths` returns
each outline in the node's *unrotated local* space but with an origin that is not the node's: every
layer's outline arrived around x=14590 regardless of where that layer sat. The old localisation
subtracted the node's absolute position, so a frame's clip outline landed at (10250, -7589) — ten
thousand pixels off the canvas. The clip shape drew off-screen and, worse, the clip mask built from
it masked away all 45 layers beneath it. Note the shape of the failure: before clip compositions this
same bug only misplaced a few vector layers, which is why it survived unnoticed; making one mask
load-bearing for a whole subtree turned it fatal.

`localizeGeometry` now re-originates a node's outlines to their own union bounding box. The
justification is measured, not assumed: across that file the outline's extent matched the node's own
width and height on 40 of 42 vector layers and matched `size` exactly on every rotated one, so the
outline is the node's own shape, only translated — re-originating is exact and cannot be off by an
unbounded amount whatever space the source picked. All subpaths of a node move together, or a
compound path collapses onto itself. Re-running the real document through the fixed pipeline: 45
clipped objects, **0** off-canvas clips, every clip exactly (0,0)-(1920,1080) over the object it
clips. `figmaClipComposition.test.mjs` now has that file's shape as a fixture (**8/8**), `api-server`
**73/73**, full suite and typecheck clean, both desktops rebuilt.

### 2026-08-04 — A published scene is a control message, not a container for pixels

Take failed in Playout with `connection closed: reconnecting` and `engineState: connecting`, a minute
after the operator pressed it. The engine was running and listening; the take list showed ERROR on
one entry only — take `002 · v6`, whose published document was **13.48 MiB** on disk while every
other scene in the library was under 0.64 MiB.

Reproduced against a real engine with the same client, transport and envelope Playout uses:
`rejected a frame code="MESSAGE_TOO_LARGE"`. The engine's `security.max_message_bytes` is 8 MiB and
it is enforced **before parsing**, deliberately, so an unbounded frame can never be a denial of
service. Four faults, in the order they compound:

1. **Publishing inlined image bytes into the scene document.** Fonts had travelled that way since the
   typeface kept disappearing on restart, and images were given the same treatment — 8.79 MiB of data
   URLs in `assets[]`.
2. **The bytes were also copied onto every image object's `src`** — another 4.06 MiB of the same
   pixels. An object names its asset; it does not carry a second copy.
3. **The bytes never needed to be in that message at all.** `ensureSceneAssets` already registers and
   uploads every asset by checksum, chunked to a size the engine chooses, and the engine declares a
   scene's assets from `assets[].assetId` — it never reads `source`. `withoutInlineAssetBytes` now
   replaces an inlined source with `asset:<id>` for the wire, and `asset.register` sends that
   reference as its `uri` rather than a whole base64 payload.
4. **The refusal was unattributable.** A frame rejected before parsing was answered with no
   `requestId`, so the caller could not match it and died on its own timeout — that minute of silence
   is the entire distance between "connection closed: reconnecting" and the limit that was exceeded.
   `request_id_from_frame_head` recovers the id with a bounded scan of the head of the frame, and the
   client now refuses to send a frame larger than the engine's advertised `limits.maxMessageBytes`
   with both numbers in the message.

That guard had a fault of its own, found by the same probe: it consumed a sequence number for a frame
it then refused to send. The receiver *parks* a message that arrives with a gap ahead of it, so the
next real frame sat unanswered — the identical symptom, one layer down. `SequenceGenerator.release`
gives back a number that never went out.

Measured on the real 13.06 MiB scene: as published, refused in **0.27 s** naming both numbers; on the
wire **0.21 MiB (98.4% smaller)** and `scene.load OK`. Before: 60 s of silence.

`render-protocol` **142/142** (3 new: the limit, a frame just under it, and the sequence contract),
`sceneWire.test.mjs` **5/5**, full `npm test` and `npm run typecheck` clean, `check:boundaries`
passes, both desktops rebuilt.

**Found in passing, not caused here:** the engine's own `protocol_server` suite fails **28 tests at
`HEAD`** — its test client sends scene-bearing commands with no `sceneRef`, which the engine has
required since `f0dadfd` (Aug 2). `cargo test` is not part of `npm test`, which is why it went
unseen. `ipc_transport` was worse: it *hung* for 15 minutes on an uncorrelated error reply, and now
passes 11/11. Deriving the ref in the WebSocket client was tried and reverted — it moved the count to
38, because a full sync's ref decides the runtime key and "replace" versus "add a keyed revision" is
an engine-semantics decision, not a test fix.

### 2026-08-04 — Vectors that arrive whole, and text drawn the way it was designed

Two reports against a real import: vector paths not exact, text transforms not applying. Both
measured against the stored provenance of a 66-layer file, and both real.

**Compound paths were imported and then not drawn.** `drawShape` read `object.path` and nothing else,
while the contract has carried `compoundPaths` all along — so every counter in a letter, every hole in
a ring, and 47 of the 48 subpaths of one logo in that file were silently absent. Pixi only treats an
enclosed subpath as a hole for a path added *whole* with `checkForHoles`, so geometry now builds a
`GraphicsPath` (`rendering/shapeGeometry.ts`) and hands it over with `graphics.path()`. Declared fill
rules remain approximate: Pixi decides holes geometrically, which is exact for every letter, ring and
icon a design tool exports and not for even-odd subpaths that overlap without enclosing.

**Closed paths carried a duplicate seam anchor.** A source writes the closing segment explicitly and
then closes (`M a … L a Z`), so 116 of 117 paths in that file ended on a copy of their first anchor.
Worse than redundant: when that last segment is a curve its incoming handle lands on the duplicate,
not on the anchor the curve arrives at, so the seam of a rounded shape draws straight. `finish()` now
merges the two, moving the handle to the anchor it belongs to.

**Text case was never imported.** Figma applies `textCase` at draw time and leaves the characters
alone — a layer typed "mvp" set to UPPER reads MVP on the canvas — and the importer read only
`characters`. Every upper-cased layer therefore arrived lower case with nothing left to recover it
from. `textCase` and `textDecoration` now travel from Figma through `NormalizedDesignText` to
`TextSceneObject`, and the characters stay as typed so a data binding can replace the string and keep
the case. The renderer applies case at draw time (`rendering/textPresentation.ts`) and draws underline
and strikethrough as rules, because Pixi's text style has neither. `small-caps` draws as upper case
and the import report says so per layer.

Verified without a GPU: Pixi's path classes are plain geometry, so `shape-and-text-presentation.test.ts`
(**10/10**) asserts through Pixi's own `ShapePath` that a ring is one primitive with one hole, that
five separate subpaths stay five, and that handles arrive as cubic control points — no screenshot
needed. `figmaVectorAndText.test.mjs` (**9/9**) covers the seam, subpath survival, every Figma text
case, the small-caps report, decoration, and a rotated text layer keeping its own size and angle.
`editor-web` **130/130**, `api-server` **82/82**, full `npm test` and `npm run typecheck` clean,
`check:boundaries` passes.

A live screenshot was not obtainable this session: the harness browser repeatedly died on the Vite
page with "Failed to clear browser request interception" and then a killed tab worker. Reported. The
same page screenshotted successfully earlier today, so the render path itself is not in doubt.

### 2026-08-04 — Everything above, built into both Tauri desktops

`npm run build` (clean dist → Shared → Editor → Playout → stage runtime), then
`npm run build -w @grapix/desktop-tauri` and `npm run build -w @grapix/playout-desktop`. Four
installers produced:

```
GrapiX_0.1.0_x64_en-US.msi          58.4 MiB
GrapiX_0.1.0_x64-setup.exe          39.2 MiB
GrapiX Playout_0.2.0_x64_en-US.msi  42.0 MiB
GrapiX Playout_0.2.0_x64-setup.exe  28.9 MiB
```

**`tauri build` failed the first time with `PermissionDenied` from `tauri-build`, and the message
named nothing.** The cause: a live `grapix-render-engine.exe` running out of
`Editor/apps/desktop-tauri/src-tauri/target/release/`, which is the file `build.rs` stages the
sidecar over. Nothing was on air — it held 4400 but no control service was running on 4300 — so it
was stopped and the build went through. **Before building a desktop, check for an engine running out
of the Tauri target directory**; `wmic process get ProcessId,Name,ExecutablePath` finds it, and the
error will not.

**Verified inside the shipped artefacts, not just in source.** Every feature was grepped in the
staged bundles the installers carry (`grapix-api-server.mjs`, `grapix-playout-control.mjs`, the
playout-web asset) — 15 markers, all present — and then the bundles were *run*: the Editor bundle
advertised itself on the link, the Playout bundle advertised itself and resolved the Editor at
`http://127.0.0.1:4181` by **mDNS alone** (a non-default port, with the configured address pointed at
TEST-NET), and the operator console recorded the fallback route. The engine sidecar is rebuilt from
source by `build.rs`; the Node runtime and `@napi-rs/canvas` bindings are staged by
`stage:runtime` (79.5 MiB + 35.1 MiB per app).

### 2026-08-04 — Figma REST import: no node disappears

**The importer lost layers, and lost them silently.** Nested layers, image assets, vectors, masks
and clipped groups were all reported missing from real imports. Every cause was a different way of
dropping something without saying so:

- **`clipsContent` was read and ignored.** It landed in `sourceData` and nothing acted on it, so a
  clip group imported unclipped: a 1200×800 plate inside a 400×200 clipping frame painted across
  the canvas. Now resolved into real masks on every descendant.
- **A mask group masked with a rectangle.** The old pass took the mask node's *own* path, and a
  group has none, so `nodeAsMask` fell back to its bounding box — a masked logo became a masked
  rectangle. Mask geometry is now the union of the subtree's outlines, in document order.
- **Figma has no `rotation` field.** The code read one and always got 0, so every rotated layer
  imported straight. Rotation comes from `relativeTransform` (`atan2(m10, m00)`, no negation —
  both spaces are y-down), `size` gives the untransformed extent, and the node is pivoted about its
  centre, which is the one placement that reproduces the axis-aligned box Figma reports at any angle.
- **Only the first image fill was collected, and strokes not at all.** Every `imageRef` on fills
  *and* strokes is now an asset, deduplicated per ref across the document.
- **`mapFigmaType` ended in `return "group"`.** A sticky, connector, table, widget or anything Figma
  ships next became an empty group with no report line. Every type is now mapped explicitly, and
  `unsupported` is a real outcome that triggers a render rather than a shrug.
- **Invented geometry.** A vector whose outline Figma withheld was given a rectangle of its bounds —
  indistinguishable from a real rectangle, so the layer looked imported and was wrong. It is now
  left without a path, which is what marks it for rendering.
- **Hidden layers were dropped.** The Figma route now defaults `importHiddenLayers` on: a hidden
  layer is authored information, and one that vanishes cannot be switched back on.

**Clipping and masking are resolved once, for every importer.** `clipResolution.ts` runs inside
`normalizeDesignDocument` — after scaling, so a clip rectangle is in the same space as what it cuts,
and *before* flattening, because `flattenNodes` drops containers and a clip that lived only as a
container property would vanish with it. `roundedRectanglePath` gives a clip its frame's own corners.
Figma, Illustrator, Photoshop and SVG now share one implementation instead of four partial ones.

**Anything GrapiX cannot draw is drawn by Figma.** `/v1/images` in one batched request per format:
SVG for vectors with no returned outline, PNG for annotation types and for alpha/luminance masks
(where the masking layer's *pixels* are the mask — that render becomes the mask's `alphaAssetId`).
Those objects carry `flattenedFromFigma: true`, so they can be re-rendered from source later. A
failed render costs pixels, never the layer: it still arrives with its bounds, name and metadata.

**A generic container never costs its children.** An unknown type becomes a container and its whole
subtree is imported under it; a leaf of that type becomes the render. Recursion is driven by
`children` alone, with no depth limit and no type filter.

**Two bugs the end-to-end run caught, both silent:**

- `importedNodeIds` collected our node ids (`figma-10-9`) while issues carry the source id
  (`10:9`), so the pruning pass deleted *every* per-layer report line on the Figma path and left
  only the document-level ones. Both id forms are now collected, plus the ids of mask layers
  consumed into masks.
- `remapNodeAssets` did not remap `renderedAssetId`, so a flattened node still pointed at its
  pre-storage id: the pixels were downloaded, the converter could not find them, and the node fell
  back to an empty container.

**The report now accounts for every node**: `nodes = native + genericContainers`, and
`nodes = surviving layers + masks`. Plus `flattened`, `clippedContainers`, `assetsDownloaded`,
`assetsFailed` and `missingNodes` — because "did every layer arrive?" is the first question after
importing a real design, and counting objects in the Inspector is not an answer.

**Verification.** A new `figmaLayerCoverage.test.mjs` (15 tests) drives one deliberately awkward
document — four-deep nesting, a rounded clipping frame, a vector mask group, an alpha mask, hidden
layers, an image fill and an image stroke, a boolean operation with no geometry, a 30° rotation, a
sticky note, a slice — and asserts every layer reaches the scene by name, that clips land in the
right coordinate space, that sibling order decides masking, and that a failed render loses nothing
but pixels. api-server 57/57, full workspace `npm test` and `npm run typecheck` clean,
`check:boundaries` passes. End-to-end through `DesignImportManager` with a stubbed Figma: a nine-node
lower third imported as nine objects, four levels deep, three masks resolved, two assets downloaded,
the sticky note an image, the hidden layer hidden, and six report lines naming each decision.

**Not done — the MCP transport is still a screenshot.** `get_metadata` returns a sparse XML tree of
every layer and the importer reads only the root's attributes, so a Dev Mode import is one image per
frame. The work above is the REST route only.

### 2026-08-04 — Link-local discovery: the two applications find each other with no DNS

**The addresses assumed a network that can go away.** Playout reaches the Editor at
`GRAPIX_EDITOR_API_URL` or `127.0.0.1:4100`; the Editor UI is handed `VITE_GRAPIX_PLAYOUT_API_URL`
at *build* time and cannot be re-pointed at run time. A dead uplink, a lost DHCP lease or a machine
name that stops resolving therefore separates two applications that are still sitting on the same
switch — or the same machine — with nothing wrong with the link itself.

**`Shared/service-discovery` is mDNS/DNS-SD (RFC 6762/6763) with no dependencies.** `node:dgram`
and `node:os` only: this is the facility that has to work when nothing else does, and a package in
that path is a liability. Four modules — `dns.ts` (wire codec: PTR, SRV, TXT, A, AAAA, with
compression on read), `socket.ts` (one shared multicast socket), `advertiser.ts`, `browser.ts` —
plus `endpoint.ts`, which is the part that actually fixes anything.

**Reductions, all deliberate, none of which stop a conforming peer resolving us:** no probing or
name-conflict resolution (instance names carry a random suffix), no known-answer suppression, no
AAAA advertising (GrapiX services bind IPv4), no authority section. Writing is uncompressed —
legal, and a compression bug produces a packet that peers silently misread rather than one that
fails here. Reading *must* handle compression: every real responder compresses.

**The policy is the product: `EndpointResolver`.** Configured → remembered → loopback → discovered,
and every candidate is proven with a caller-supplied `verify` before adoption. Each step earns its
place. An explicit address is an instruction, not a hint — a rehearsal that silently drives a
machine something announced would be worse than a failure. Loopback precedes the link because it
survives every interface going down. `verify` checks the peer's `/health` *names itself*
(`grapix-api` / `grapix-playout-control`), because something listening on 4300 is not evidence
that publishing a scene into it is safe. The route taken is reported, never hidden: a fallback
address lands in the operator console as a warning naming what was configured, what answered, and
that the scenes an operator sees now come from there.

**Wired into both directions.** The Editor project service advertises `_grapix-editor._tcp` and
browses for Playout; the control service advertises `_grapix-playout._tcp` and resolves the Editor
for `syncFromEditor`, re-proving after a fetch that fails against an endpoint that had passed its
health check. A browser cannot speak mDNS — there is no multicast API in a page — so the Editor UI
asks its own project service (`GET /api/discovery/playout`) and retries a failed publish once
against a re-proven address. That keeps one discovery implementation in the repository instead of a
second, weaker one written against whatever a page can reach.

**Discovery is never load-bearing.** A socket that cannot open — 5353 held by the system responder,
a firewall profile, no multicast interface — is reported and nothing else changes. The engine is
deliberately *not* advertised: nothing publishes `_grapix-engine._tcp`, so a browse for it would be
a discovery path that silently never resolves. It keeps its configured address and the loopback
port scan `@grapix/render-protocol` already performs.

**Two bugs the live tests caught, both invisible to a fake socket:**

- The goodbye was sent and then the socket was closed in the same turn, so the datagram was
  discarded before the OS had it — a peer kept a withdrawn service for the full 120-second TTL.
  `MdnsSocket.send` now returns a promise and `stop()` awaits it.
- `startApiServer` registered its `onClose` hook *after* `listen`, and Fastify refuses `addHook` on
  a started instance: the Editor service crashed on boot. The hook moved into `createApiServer`.

The Editor project service also had **no signal handling at all**, so every stop was a hard kill
and `onClose` never ran. `closeOnSignal` now closes it on SIGINT/SIGTERM. On Windows a
`TerminateProcess` still bypasses that, which is what the TTL is for.

**Verification.** service-discovery **28/28** (25 protocol and policy tests against a fake socket,
3 over a real multicast socket, skipped rather than failed where 5353 cannot be opened),
playout-control 70/70, api-server 42/42, full workspace `npm test` and `npm run typecheck` clean,
`check:boundaries` passes with Shared at 17 packages. End-to-end on this machine, against real
services and a real socket:

- Editor on **4177** (not its default port), configured Playout address pointed at RFC 5737
  TEST-NET and the loopback candidate at a dead port: the control service resolved the Editor to
  `http://127.0.0.1:4177` by **mDNS alone**, verified it, synced **15 scenes**, and recorded the
  fallback route in the operator console with the configured address, the instance name, the host
  and every published address.
- The same in reverse: an Editor with a dead configured Playout address resolved
  `http://127.0.0.1:4310` through `/api/discovery/playout`.
- Announcements went out on all three interfaces (LAN, WSL bridge, loopback); addresses are tried
  routable-first and `verify` decided — it adopted `127.0.0.1` because the services bind loopback.
- `app.close()` withdrew the advertisement from a live browser within a second.

### 2026-08-04 — Playout operator console, and failures that explain themselves

**`asset asset_b5350b45cd6cca4ff8f7 returned HTTP 404` was the entire report an operator got.**
An opaque id, no asset name, no scene, no URL, no status text, no remedy — and it reads like a
bug in Playout when it is nearly always a published scene pointing at bytes the Editor's project
service no longer holds. It also vanished the moment the next action replaced the banner, and an
operator station has no devtools window and no terminal to fall back on.

**A failure now carries structure, not a string.** `Playout/services/playout-control/src/diagnostics.ts`
defines `PlayoutOperationError` (`code`, `summary`, `cause`, `remedy`, `context`) plus
`describeError` for anything unexpected, which keeps the stack because for an unexpected throw the
throw site is the only useful information. `summary` is also `error.message`, so every path that
only ever read a message improved for free. Thrown where the context still exists — the asset
fetch knows the URL, the status and the scene; the HTTP route two frames up can reconstruct none
of it.

**Asset reading moved to its own module** (`sceneAssets.ts`) because that is the failure operators
actually meet, and it is worth testing alone. Four outcomes are now distinct, each with its own
remedy: content gone (404), the host refusing (any other status, with its own body quoted), the
host unreachable (`fetch` rejected), and a non-absolute source refused before any request. An
embedded data URL never touches the network, which is why "publish with assets embedded" is the
remedy each one names.

**The console** (`DiagnosticsConsole.tsx`, `GET/DELETE /api/playout/diagnostics`) is a bounded
300-record ring buffer the UI reads, live over the existing SSE bus as `diagnostics.logged`. It is
in memory only: a diagnostic is an aid to the operator in front of the machine — the engine keeps
the audit trail — and a log on disk is one more thing that fills a volume on an unattended
station. The UI keeps a matching log of what never reached the service (a request that could not
be sent, an uncaught error, a rejected promise), and shows both merged with `origin`. A refusal
returns `diagnosticSequence`, so the banner's **Details** opens the service's own record instead
of the UI keeping a second copy of one failure.

**Two real bugs fell out of verifying it, both proven before and after:**

- `PlayoutEngineController.connect` rebuilt its profile from the registry record, and the registry
  deliberately does not keep `authToken` or `secure` — its records are reported to operator UIs.
  So Playout could never reach an engine that requires auth: the socket was opened with no
  `bearer.` subprotocol, the engine rejected the upgrade, and all of that surfaced as "could not
  connect". The controller now retains the registered profile.
- CORS was registered with an `origin` check and no `methods`, and the default preflight answer
  was `GET,HEAD,POST`. Every DELETE route — removing a published scene, clearing the log — was
  blocked by the browser before it was sent, and appeared in the UI as a bare "Failed to fetch".
  The methods are now declared.

**Also worth knowing:** the engine's capability matrix does not permit the `playout` role to
`scene.load`, `scene.prepare` or `asset.register`, and an **unauthenticated loopback connection is
an Editor principal**. A development GrapiX therefore works only because Playout connects without
a credential. That is a live conflict in the authority model, not something to change on the way
past — it is recorded here and nothing was touched.

**Verification.** playout-control **70/70** (+14 new, all asserting on the parts an operator needs
rather than on wording), `check:boundaries` pass, playout workspace typecheck clean, `cargo check`
and `cargo test` clean, `playout-web` production build clean. End-to-end against a real engine and
the real Editor project service on 4100, with an isolated engine (4499) and control service (4310)
so the running app was never touched: cueing a scene whose asset the Editor had lost produced
`asset.content-unavailable`, and the operator window showed the summary and remedy in the banner,
a badge on the console button, and — on Details — the failing request with the service's own 404
body, the remedy, and 18 context fields including asset id, name, mime type, checksum, scene, take
and engine state. Level filters, text filter, per-record copy, and Clear (both halves) were each
driven in the browser.

### 2026-08-04 — Shape path animation, alignment tools, project service background autosave & crash recovery

**Shape Path Animation & Bezier Editing.** Enhanced vector path manipulation and keyframed shape morphing. `evaluateSceneAtFrame` evaluates `pathAnimation` keyframes via `interpolatePath` to morph matching-vertex bezier paths across keyframe timelines. Added `tools/bezierEditing.ts` with de Casteljau bezier subdivision for exact point insertion without distorting drawn curves, anchor hit testing, and smooth/corner/broken handle conversions. Covered by direct unit test suites in `shape-path-animation.test.ts` and `bezier-editing.test.ts`.

**Alignment & Distribution Layout System.** Implemented full bounds-aware object alignment and distribution tools (`bounds.ts`, `alignment.ts`, `useAlignmentSelection.ts`, `AlignmentToolbar.tsx`). Object alignment computes exact visual bounds (`objectBoundsInScene`) including rotational and scaling transforms, aligned across selection, canvas, key object, and parent group reference frames. Added edge/centre alignment and horizontal/vertical distribution buttons and state hooks, validated via `bounds.test.mjs` and `alignment.test.ts`.

**Background Autosave Engine & Recovery.** Replaced old inline `useSceneAutosave` hook with a dedicated background autosaving system (`Editor/apps/editor-web/src/lib/autosave.ts`), preference store controls (`preferencesStore.ts`, `PreferencesDialog.tsx`), and a recovery dialog (`AutosaveRecoveryDialog.tsx`). Autosave periodically writes modified dirty scenes to project-api (`/scenes/:id/autosave`), maintains recovery manifests (`storage.ts`), and surfaces recovery options on startup after ungraceful shutdowns.

**Verification.** Full workspace test suites and typecheck pass clean:
- `shared-types`: **89/89 passed** (+49 over baseline)
- `adobe-common-schema`: **117/117 passed**
- `playout-control`: **56/56 passed**
- Tauri desktop applications (`editor` & `playout`): **cargo test 5/5 passed**
- `playout-web`: production Vite build succeeds cleanly
- workspace typecheck: clean across `@grapix/shared-workspace`, `@grapix/editor-workspace`, and `@grapix/playout-workspace`.

### 2026-08-03 — Alignment and distribution, phase 1 of the Photoshop-style layout system

**Editor/Playout parity here is a bounds problem, not a renderer problem.** Alignment writes
`x`/`y` into the scene document and both renderers already read that document, so the two agree
about an aligned graphic **iff** they agree about its edges. The bounds function therefore lives in
`Shared/shared-types/src/bounds.ts`, not in the Editor: `objectBounds` implements the documented
`T(x,y)·R·S·T(-anchor)` transform and takes the extent of the four *transformed* corners, so a
rotated quad aligns by the box an operator can see. No renderer change was required or made.

**The old "Align left" aligned `x`, which is the anchor, not the edge.** Two objects with
different anchors, rotations or scales ended up visibly unaligned while their numbers matched.
`tools/alignment.ts` works on bounds throughout and returns **deltas** — because
`objectBounds` translates rigidly with `x`/`y`, a bounds delta *is* a position delta, exact under
any transform, with no inverse to get wrong.

Delivered: all six alignments, six per-edge distributions, equal horizontal/vertical spacing, and
four reference frames (selection, canvas, key object, parent group). The key object is filtered out
of the movable set rather than given a zero delta, so it stays out of undo. Locked objects are kept
in the bounding box but never moved — a locked graphic is the thing you align *to*. Hidden objects
are dropped.

**A group's box is decoration and would have aligned the wrong thing.** `createGroupObject` fixes
`width`/`height` at 260×170 and never tracks its children, so "groups align as one object" would
have aligned an invisible rectangle. `objectBoundsInScene` resolves a container to the union of its
children, recursing through nesting with a visited set.

**Toolbar.** Existing controls keep their order and grouping and now sit left; the alignment group
follows after a divider, with the reference selector, equal-spacing beside the alignments, and
per-edge distribution in an overflow menu. The top bar's centre column became `auto 1fr auto` so
controls no longer slide sideways as buttons enable and disable. Every button's enabled state comes
from the live selection (`canAlign`/`canDistribute`), so nothing looks available and no-ops.

**Verification.** shared-types 88/0 (+13), editor-web 115/0 (+13), typecheck clean, boundaries
pass. End-to-end in the app: a 360×210 quad with a 1px stroke at (220,220) centred on the canvas
landed at x=780, y=435 — bounds centre exactly (960, 540), i.e. the *visible* edge including half
the stroke, not the layout box.

**Not built — this is phase 1 of the request.** No smart guides, no snapping of any kind (edge,
centre, baseline, object-to-object, canvas centre), no equal-spacing indicators, no live distance
measurements, no snap-tolerance setting and no snap/guide/pixel toggles. Marquee selection already
populated `selectedPathObjectIds` and alignment consumes it, but shift add/remove, a combined
selection-bounds overlay, and entering a group to align its members are not implemented.

### 2026-08-03 — Pen tool add/remove/convert, and a Mask Feather tool

**"Add point" moved the curve it was asked to refine.** `insertPathPoint` put the midpoint of two
*vertices* into the path with zero handles. On a curved segment that point is nowhere near the
curve, so pressing Add point flattened the shape — the operator asked for one more handle and got
a different graphic. `tools/bezierEditing.ts` subdivides with de Casteljau instead, which is the
only insertion that provably leaves the drawn curve alone.

**The pen could not edit a path it had finished.** Once a path was closed or escaped,
`penObjectId` was null and the next click started a *new* shape; add/remove lived on the Direct
Selection tool only. The pen now follows the Illustrator/AE rule — over the **selected** path it
adds on the line, removes on an anchor and (Alt) converts corner ↔ tangent, and only a click in
empty space begins a new shape. Hit tolerances are screen-pixel constants converted to scene units
at use, so the targets stay the same size at any zoom.

**Two of the four path buttons were lies.** "Link handles" issued the byte-identical call to
"Smooth" — a button that could not do anything Smooth had not already done — and "Break handles"
*rewrote* the outgoing handle from the anchor's neighbours, changing the curve rather than
breaking a link. There was nothing to link or break: `BezierPath` stores no linkage, and Direct
Selection dragged every handle independently, so a smooth anchor silently broke the first time it
was touched. Linkage is now **derived from the anchor's own geometry** at drag time
(`moveAnchorHandle` via `patchPathPoint`): a smooth anchor mirrors, a corner or a deliberately
broken one does not. That needs no contract field and cannot go stale. `setShapePointsSmooth` is
replaced by `setShapeAnchorKind` / `toggleShapeAnchorKind`, and the two lying buttons are gone.

**Mask Feather tool.** New `feather` tool beside the pen: drag to feather, Shift-drag to expand,
with Feather X/Y, Link X/Y and Expansion in the options bar, acting on the mask selected in the
Inspector. Drags compute an absolute value from total pointer movement rather than accumulating
per-frame deltas, so the result does not depend on how many pointer events arrived.

**Negative expansion was accepted and dropped.** `buildMaskGraphics` guarded `expansion > 0`, so
an operator could type −20, save it, and see nothing. Contraction now cuts a stroke of width
`2|expansion|` centred on the path: the inner half leaves the filled region, the outer half was
already empty, so the region pulls in by exactly `|expansion|`.

**Verification.** editor-web 102/0 (+10), typecheck clean, boundaries pass. End-to-end in the app
on a curved closed path: adding a point took it 4 → 5 anchors with **max deviation 0** from the
original curve, sampled at 2000 points per segment and compared anchor-relative. (An early
measurement of 14.2 was my comparison ignoring that `fitShapeToPath` re-origins the path and
compensates through `anchor`; a later 1.24 was sampling granularity. Neither was a geometry
error.) The feather tool wrote `feather {24,24}` with Link on and accepted `expansion: -18`.

**Stated, not hidden:** feather is still applied as **one blur per object** —
`applyObjectMasks` takes `Math.max` across every mask — so per-mask feather is not independent.
The tool says so when an object has more than one mask. Making it per-mask needs each mask
rendered and blurred into its own layer before compositing.

### 2026-08-02 — Self-contained installers: knowledge, runtime and native deps

The installers shipped code but not the things the code needs. Everything now lands in one
user-chosen directory, modelled on `C:\Program Files\XPressionDesigner`: executables and
runtime at the root, `services/` and `knowledge/` beside them, all user data in AppData.

```
<chosen folder>\  app.exe  grapix-render-engine.exe  node.exe
                  services\  4 bundles + node_modules\@napi-rs\
                  knowledge\ docs\ Shared\ Editor\ Playout\ README.md memory.md package.json
```

**Knowledge corpus.** The MCP server reads its architecture and contract knowledge from a
checkout, and *throws* when it cannot find one — an installed build reported `MCP error` and
exposed no tools. `tools/packaging/stage-knowledge.mjs` copies the corpus into a
`knowledge/` resource at the same relative paths. The file list comes from
`corpusRelativePaths` in `corpus.ts`, not a second list in the packaging script, so a new
document ships automatically. The supervisor still prefers a live checkout when one exists,
because reading the working tree can never serve a stale invariant.

**Node runtime.** Both supervisors ran `Command::new("node")`. A broadcast machine has no
reason to have Node installed, so on a clean box every service failed to spawn. `node.exe`
(79.5 MiB) now ships as a Tauri `externalBin` sidecar and `RuntimeLayout::node_command`
prefers it, falling back to `PATH` only in a checkout.

**Native dependencies.** `@napi-rs/canvas` is a Skia addon, so esbuild marks it external —
"resolve from node_modules at runtime", which does not exist in an install. The project
service died with `ERR_MODULE_NOT_FOUND`. `stage-native-deps.mjs` stages the package plus
the host-platform binding (35.1 MiB) into `services/node_modules/`, where Node's upward
resolution finds it. Only the host binding ships; all ten would add ~300 MB that could
never load.

**Playout data root.** `playout-control` reads `GRAPIX_PLAYOUT_DATA_DIR` and otherwise
derives a path from its own file location — inside the read-only install directory. The
Playout supervisor now sets it explicitly alongside `GRAPIX_DATA_ROOT`.

**Installer.** `installMode: perMachine` makes the existing NSIS directory page default to
`$PROGRAMFILES64\GrapiX` instead of `$LOCALAPPDATA`; the user can still choose any folder.
`webviewInstallMode: embedBootstrapper` embeds the WebView2 installer so a machine with no
internet can still install.

**Rule: verify a packaging change against an extracted installer, never the source tree.**
An in-repo smoke test passed while the real payload was broken, because `node_modules`
resolved up the tree into the checkout. The `@napi-rs/canvas` failure only appeared once
the NSIS payload was extracted to `D:\tmp` and run with `PATH` reduced to `system32`.

**Verification.** The released folder was extracted from the built NSIS installer and run
with every `NODE_*`/`npm_*`/`GRAPIX_*` variable stripped and `PATH` cut to system32:
project service, Adobe gateway and assistant all answered `200`, MCP reported
`connected` with 54 tools, and the MCP stdio banner read **40 documents, 112 session
rules** — served entirely from the shipped corpus. `@napi-rs/canvas` rendered a real PNG
through the staged Skia binding. Boundaries pass, typecheck clean, 401 Node tests and all
Rust tests green.

Installers: Editor `GrapiX_0.1.0_x64-setup.exe` (30.6 MB) / `.msi` (44.6 MB); Playout
`GrapiX Playout_0.2.0_x64-setup.exe` (28.9 MB) / `.msi` (41.9 MB). Installed footprint
157 MB, the growth being the Node runtime, Skia and the corpus.

### 2026-08-02 — Packaged installers: services actually shipped and reachable

The `Basic-v0.4` installers launched, looked fine, and had no working MCP, AI assistant or
Adobe gateway. Cause: the desktop shells only ever shipped the render engine sidecar. Every
Node service was resolved from the *source tree*, which does not exist beside an installed
`.exe`, so the supervisor reported "could not be reached" for services that were never there.

Five service bundles are now built by `npm run build` and declared in `bundle.resources`:
`grapix-api-server`, `grapix-editor-assistant`, `grapix-adobe-mcp-gateway`,
`grapix-editor-mcp` (Editor) and `grapix-playout-control` (Playout). A `RuntimeLayout`
resolves each from Tauri's `resource_dir` first and the dev tree second, so one code path
serves both. `GRAPIX_DATA_ROOT` is pinned to per-user AppData because a standard account
cannot write under `Program Files`.

Four defects only a packaged run exposes, each fixed at the source:

1. **esbuild's CJS shim throws on `node:` builtins.** Bundling Fastify inlined a `require`
   shim whose fallback threw `Dynamic require of "node:events" is not supported`. Fixed with
   a `createRequire(import.meta.url)` banner and `node:*` marked as passthrough.
2. **Adobe gateway started nothing.** Its entrypoint guard was
   `process.argv[1].endsWith("index.js")`; the bundle has another name, so it exited 0 in
   silence — the literal "gateway could not be reached". Now compares
   `import.meta.url` against `pathToFileURL(process.argv[1])`, which is name-independent.
3. **The assistant could not find the MCP server.** `defaultMcpEntry` resolves
   `../../editor-mcp/dist/index.js` relative to its own file — correct in the repo, absent in
   an install, where both are flat files in one `services/` directory. The supervisor now
   passes `GRAPIX_ASSISTANT_MCP_ENTRY` and `GRAPIX_ASSISTANT_DATA_DIR` explicitly.
4. **WiX ignores a resource rename.** The MSI `File` table records the *source* basename, so
   `grapix-editor-mcp-desktop.mjs` mapped to `services/grapix-editor-mcp.mjs` installed under
   the source name and the supervisor's lookup missed it. Caught by reading the name out of
   the built MSI, not by trusting the config. **Rule: a bundled resource's source basename
   must equal its install basename** — never rely on `bundle.resources` to rename.

**Verification.** Beyond boundaries/typecheck/tests, the installed layout was reproduced
directly: the five bundles copied into a flat `services/` directory with no source tree and
no `node_modules`, then launched exactly as the supervisor launches them. All four HTTP
services answered `200`, and the assistant reported `mcp=connected` with **54 tools**.
`fontkit` was exercised through the bundled project API by importing a real Arial file
(family `Arial`, checksum computed), proving native-ish deps survive inlining. Payload names
were then read back out of both MSIs to confirm what installs, with the stale
`-desktop` name absent.

Installers: Editor `GrapiX_0.1.0_x64-setup.exe` (8.5 MB) / `.msi` (12.4 MB); Playout
`GrapiX Playout_0.2.0_x64-setup.exe` (7.0 MB) / `.msi` (10.0 MB). Sidecar hash identity
across engine and both staged copies: `1f7b3e843b9025e4`.

### 2026-08-02 — Tauri Desktop Release Build & Sidecar Synchronization

Packaged both desktop apps from the `Basic-v0.4` baseline after full Council integration, NDI live output, ResourceGovernor, and Adobe MCP bridge delivery.

**Sidecar Verification**: Hashing the staged sidecars after packaging (`grapix-render-engine-x86_64-pc-windows-msvc.exe`) confirmed **100% hash identity** across all three locations (`1f7b3e843b9025e4`):
- `services/render-engine/target/release/grapix-render-engine.exe` (`1f7b3e843b9025e4`)
- `Editor/apps/desktop-tauri/src-tauri/binaries/grapix-render-engine-*.exe` (`1f7b3e843b9025e4`)
- `Playout/apps/desktop-tauri/src-tauri/binaries/grapix-render-engine-*.exe` (`1f7b3e843b9025e4`)

**Generated Bundles**:
- **Editor Desktop**: `GrapiX_0.1.0_x64-setup.exe` (7.2 MB), `GrapiX_0.1.0_x64_en-US.msi` (11.0 MB)
- **Playout Desktop**: `GrapiX Playout_0.2.0_x64-setup.exe` (6.8 MB), `GrapiX Playout_0.2.0_x64_en-US.msi` (9.7 MB)

Boundaries pass, typechecks clean, 300+ Node unit tests and 60+ Rust tests green.

### 2026-08-02 — GrapiX v0.4 Adobe Bridge, Phase 1 (MCP Foundation)

Full document: [`docs/adobe-integration.md`](docs/adobe-integration.md).

Three new packages, all authoring-only — no Program or output verb exists anywhere in this
surface, so the Editor/Playout boundary is untouched:

- `Shared/adobe-common-schema` (`@grapix/adobe-common-schema`) — the `grapix-adobe/1` wire
  protocol, the shared `AdobeImportDocument`, and the Adobe object models.
- `Shared/grapix-adobe-client` (`@grapix/adobe-client`) — isomorphic client; the Editor
  panel runs it in the WebView and the gateway's integration tests run it in Node, so one
  implementation is what both prove.
- `Editor/services/adobe-mcp-gateway` (`@grapix/adobe-mcp-gateway`) — the gateway on
  **port 4784**. `npm run dev:adobe`.

Plus `File › Integrations · Adobe…` in the Editor (`AdobeIntegrationsDialog`, `adobeStore`).

**Two transports, and the precedence rule.** `local` is a plugin inside the application;
`cloud` is Adobe's Photoshop API driven in-process by the gateway. A call with no explicit
transport prefers `local` and falls back to `cloud` — the same precedence the Figma
importer uses for REST versus Desktop MCP. `local` wins because only a plugin sees the
document the operator has open; `cloud` exists because a playout machine has no Photoshop
on it. After Effects has no cloud API, so `transport: "cloud"` on an `aftereffects.*` tool
is refused with `transport_unavailable` rather than quietly served by the local bridge.

**Both Adobe SDKs are used, not guessed at.**

- Photoshop: `@adobe/aio-lib-photoshop-api` (the library behind
  `adobe/adobe-photoshop-api-sdk`) is a real dependency of the gateway. `photoshop.ts`
  mirrors its `LayerType`, `BlendMode`, `ParagraphAlignment`, `Storage`, `MimeType` and
  `JobOutputStatus`, and *both* transports speak that vocabulary — a PSD imported over the
  cloud and through the plugin must produce the same scene.
- After Effects: SDK **25.6.61** headers. `afterEffects.ts` transcribes `AEGP_ObjectType`
  (`AE_GeneralPlug.h:982`), `AEGP_LayerStream` (`:1266`), `AEGP_KeyInterp` (`:1390`),
  `AEGP_StreamType` (`:1438`), `AEGP_TrackMatte` (`:920`), `AEGP_LayerFlags` (`:952`) and
  `PF_MaskMode` (`AE_Effect.h:1917`), citing header and line for each. Transcribed rather
  than imported: the SDK is a C++ header set under Adobe's licence. `vendor/adobe/` is
  gitignored and no build step reads it.

Two AE decisions worth not relearning: `AEGP_LayerStream_ROTATION` and `_ROTATE_Z` are
**one** index (`:1271`) — treating them as two would double-key Z rotation on every 3D
layer; and `PF_MaskMode_ACCUM` is deliberately **unmapped**, because it is a real add
rather than a screen, is unreachable from AE's UI, and aliasing it to `add` would render a
different composite than AE and never say so.

**No silent substitution.** Photoshop has 26 blend modes; GrapiX implements six in both
renderers. Only exact equivalences map (including Photoshop `linearDodge` → GrapiX `add`).
Everything else renders `normal` **and** emits a warning, because aliasing `colorBurn` to
`multiply` puts a different picture on air than the designer approved.
`adjustmentLayer` is `Rasterised`, not `Converted` — GrapiX has no adjustment pipeline.

**Security.** Loopback + `Origin` check on the HTTP surface and the WS upgrade; token per
connection compared with `timingSafeEqual`; 10 s hello deadline; 64 MiB frame cap; 500-entry
log ring. Every mutating tool is refused with `approval_required` until the operator ticks
the box in the panel — approval is per gateway session, clears on reconnect, and applies to
the cloud transport too, so an unapproved edit never reaches Adobe. Photoshop API
credentials are all-four-or-none (a partially configured API would advertise a transport
that fails on first call) and never appear in status, logs or the panel.

**Gates:** `@grapix/adobe-common-schema` **16**, `@grapix/adobe-mcp-gateway` **23**,
`@grapix/editor-web` **91** (up from 83). Boundaries pass at Editor 8 / Playout 4 /
Shared 16. Smoke-tested live: gateway process on 4784, the panel driven in a browser
through connect → discover → bridge attach → view logs → restart bridge → approval toggle,
and the real `@adobe/aio-lib-ims` path reaching Adobe, which rejected deliberately invalid
credentials with `invalid_client` — proof the SDK path is wired rather than stubbed.

**Not built:** Phase 2 (Photoshop UXP plugin), Phase 3 (After Effects ExtendScript bridge),
Phase 4 (import-UI compatibility reports, asset dedupe, missing-font detection,
cancellation, connection recovery). Until a plugin exists the local transport has nothing
to route to, and the panel says "Unavailable" rather than implying the application is idle.

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
`program`. `publish_scene` builds a `.gpxpkg` and says in its own description
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

After the autosave retry and snapshot-revision fixes (2026-08-04):

- editor-web tests: **120/120 passed** (3 new: retry backoff policy, a failed
  write re-arming and recovering with no edit, no retry while autosave is off)
- API tests: **42/42 passed** (3 new: the ring stamps the stored revision, fills
  before recycling, and never writes into `scenes/`)
- full workspace `npm run typecheck`: passed
- `npm run check:boundaries`: passed
- `npm run build:editor`: passed. `stage:runtime` and `tauri build` were **not**
  run — the desktop app was live and rule 97 makes that fail
- live verification, editor-web on 5173 with `POST /api/scenes` failed in the
  page: the status bar read `Autosave: Project service unreachable on
  127.0.0.1:4100` rather than `Failed to fetch`, retries continued with no
  operator edit, and the editor returned to `Autosave: Saved` on its own 23 s
  after the stub started answering — the pre-fix behaviour was a permanent
  `Not saved`

After removing the Editor's Sequencer (2026-08-04):

- editor-web tests **120/120**, full `npm run typecheck`, `npm run
  check:boundaries` and `npm run build -w @grapix/editor-web`: all passed
- live verification ran on **port 5199**, which is not in the project service's
  origin allow-list, so the page could not write to the live project at all —
  proven in the page before driving it, and confirmed afterwards by an audit log
  with no entries for the session. Use this whenever a dev editor must be driven
  beside a running desktop app (rule 118)
- a dock layout seeded with `bottom: ["timeline","sequencer"]` and
  `activePanelId: "sequencer"` migrated on read to `["timeline"]` with Timeline
  active; Display menu ends at Timeline, Animation menu is Timeline and Play /
  Pause, the template context menu no longer offers "To Sequencer", and no
  console errors

Figma motion import, first two tranches (2026-08-06):

- api-server tests **105/105** (18 new: 9 conversion, 9 prototype/Smart Animate including one
  end-to-end through `DesignImportManager` with an injected fetch), shared-types **108/108**,
  full `npm run typecheck` and `npm run check:boundaries`: passed
- built: the manifest contract (`Shared/shared-types/src/figmaMotion.ts`), the conversion engine
  with compatibility classification, REST prototype capture, Smart Animate diffing, and the
  import wiring (`motionMode`/`motionManifest` on `FigmaDesignImportSource`, `motion` on
  `DesignImportResult`). The HTTP route needed no change — both fields ride on the source object
- **not built yet**: the export bridge plugin, and the import dialog's motion UI (mode choice,
  frame picker, compatibility report, missing-node warnings, progress)

Figma motion import, completed (2026-08-06, later the same day):

Both remaining tranches landed, against the real published API rather than the guess the contract
was first written to — `https://developers.figma.com/docs/plugins/api/figma-motion/` and the
`Motion` page beside it. Three findings changed the contract:

- **Figma Motion's spring is a normalized `bounce` (0–1), not physical parameters.** The prototype
  `Transition` carries mass/stiffness/damping; a Motion keyframe carries `NormalizedSpring`, and
  the API publishes only `physicalSpringToNormalized`, never the inverse. So the physical triple
  cannot be recovered. Added a `normalized-spring` easing kind that keeps the bounce verbatim, plus
  `normalizedSpringToPhysical`, whose single undocumented assumption (**damping ratio = 1 - bounce**,
  segment length as the period, Apple's `Spring(duration:bounce:)` relation) is stated in the
  function and pinned by a test. Everything built from it classifies `sampled`, never
  `native-editable`.
- **`TRANSLATION_*` and `ROTATION` are offsets from the layer's layout position, not coordinates.**
  Added `FigmaMotionTrack.valueSpace` (`absolute` default, so an older manifest keeps its meaning).
  The engine reads every object's resting value *before* writing anything — reading per timeline
  would make a second timeline offset from the first one's keyframes. Importing a 0 key as `x = 0`
  flings every animated layer to the canvas origin, which reads as a broken importer.
- **`TRANSLATION_XY`/`SCALE_XY` carry two channels on one track**, as a `VECTOR` value, and are
  what Figma writes when a layer is simply dragged. One Figma track becomes two manifest tracks;
  `sourceField` keeps the original name so the report can say which track it means.

Built: `Shared/shared-types/src/figmaMotionBridge.ts` (the whole conversion, structurally typed
against the beta API so a rename is a compile error rather than a silent `any`);
`tools/figma-motion-bridge/` (plugin manifest, `code.ts`, `ui.html` frame picker, esbuild bundle,
`npm run build:figma-bridge`); the dialog's motion UI with the compatibility report grouped
worst-first; and `applyMotion` extracted in `designImportManager` so `importFile` carries motion too.

- **the plugin holds nothing testable on purpose.** The conversion lives in `Shared` because nothing
  in a Figma plugin can be unit-tested outside Figma; the bundle inlines it, so what ships cannot
  drift from what the suite covers. `networkAccess: none` — a motion export must not be a way for an
  unreleased design to leave the machine.
- **a manifest can only travel with a Figma link.** The design-file route's body is the design's raw
  bytes, so there is nowhere for a second file. The file tab falls back to
  `design-and-prototype-motion` (an exported Figma document carries its own transitions) and says so
  beside the control rather than leaving a warning in the report. `importFile` itself takes a
  manifest, so in-process callers are not limited.
- verification: shared-types **124/124** (+16), api-server **110/114** (+9), editor-web **155/155**
  (+8), full `npm run typecheck`, `npm run check:boundaries`, and `npm run build -w @grapix/editor-web`
  all passed
- the four api-server failures are **pre-existing and unrelated** — the uncommitted auth work.
  `corsOrigins` needs `GRAPIX_AUTH_SECRET` set for `createAuthContext` to boot at all; the other
  three (`automationRoutes`, `diagnostics`, `figmaImageAssets`) get 401 from the new `requireUser`
  hook because they call non-public routes unauthenticated. Nothing in the motion diff touches auth.
  Fixed one blocker in passing because it stopped `npm run typecheck` repo-wide:
  `Playout/apps/playout-web/src/api.ts` called `currentAccessToken()` without importing it from
  `./auth`, where it is exported.

After the Object Manager column redesign (2026-08-06):

- editor-web tests **145/145** (7 new for the column catalogue, ordering, per-type support and
  the Animated shortcut), full `npm run typecheck` and the production build: passed
- live on port 5199 (rule 118 isolation): the header went from ten fixed columns to
  Object · Visibility · Status · Alpha · X · Y; the picker listed all ten with the default three
  checked; **All** widened the grid to ten, **None** applied the `no-columns` template and let
  the name column take the width, **Animated** resolved to exactly the one property the scene
  keys; with every column shown, Rot X, Rot Y and Scale Z rendered inert on a light, a text and
  a quad while Rot Z stayed editable — `isPropertySupported`, not the old private list;
  editing (Alpha 100 → 40, X 220 → 255) and the stopwatch still worked; the choice survived
  unmounting and remounting the panel. No console errors
- the **All properties / Keyframed** ribbon toggle was added the same day, tests **147/147**:
  live, All showed ten columns and Keyframed showed the two the scene animated; enabling a
  Scale X stopwatch while in All made Scale X appear in Keyframed and disabling it made the
  column leave again — the live-mode behaviour a preset cannot give; unticking Rot Y from
  "All properties" produced a nine-column custom set rather than collapsing to the stored three;
  pressing an active mode returned to that custom set intact after a trip through both modes;
  with every stopwatch off, Keyframed rendered the no-columns layout and the note "Nothing in
  this scene is keyframed yet"

After the timeline selection/scrub rework (2026-08-06):

- editor-web tests **138/138** (5 new, covering the keyframed filter, key collection, marquee
  hit-testing and group-delta clamping), full `npm run typecheck` and the production build: passed
- live on port 5199 (rule 118 isolation, proven in the page before driving it), with two animated
  objects and keys at 0/30/90: a marquee over frames 15–45 selected the two keys at 30 and the
  ribbon read "2 selected"; dragging the group moved both 30 → 60 with the neighbours untouched;
  **one** undo restored both; the "Keyframed only" toggle dropped an un-animated Text object and
  `aria-pressed` tracked it; scrubbing followed the pointer forward (25→50→75→92) **and back**
  (70→40→12→0), released cleanly, and the playhead head dragged on its own; wheel, arrows, Home
  and End all stepped. No console errors
- dispatched `PointerEvent`s are how this was driven — note two harness traps: React batches, so
  the DOM must be read a tick later, and a synthetic pointer id makes `setPointerCapture` fail,
  which is what exposed rule 121

### Desktop package build — 2026-08-08

Both shells rebuilt so the Object Manager's `treegrid`, its keyboard model, the focus resolver and the
memoised row reach an installed app. **A debug render engine was staged in both shells and would have
shipped** — see the sidecar note below; it is the reason this pass touched Playout, which had no code
changes of its own.

- `npm run build` (clean dist → Shared → Editor → Playout → stage runtime): exit 0
- `cargo build --release` (render engine): **rebuilt**, `e413774a…`, 19,108,352 bytes. The previous
  release binary was three days old and every Rust source was newer than it
- `cargo clean -p app --release` / `-p playout-app --release` **before** each `tauri build`, per rule 87
- `npm run build -w @grapix/desktop-tauri` and `-w @grapix/playout-desktop`: both exit 0, run
  **unpiped** into a log (rule 97: a pipeline reports its own exit code)
- rule 87 hash check after both packages: built engine `e413774a…` equals **both**
  `*/src-tauri/binaries/grapix-render-engine-x86_64-pc-windows-msvc.exe`
- **the staged sidecar was the *debug* engine before this build** — 45,011,456 bytes, byte-identical to
  `services/render-engine/target/debug/`, put there by `npm run dev -w @grapix/desktop-tauri`, whose
  script runs `cargo build` with no `--release`. It had survived in `binaries/` since the last dev run,
  and a package built without forcing a restage would have shipped an unoptimised renderer while every
  command exited 0. Rule 87's hash check catches it only if the *release* engine is the comparison
- artifacts: `GrapiX_0.1.0_x64-setup.exe` (39.4 MiB) + `GrapiX_0.1.0_x64_en-US.msi` (58.7 MiB);
  `GrapiX Playout_0.2.0_x64-setup.exe` (28.9 MiB) + `.msi` (42.0 MiB)
- bundle-level proof: `dist/assets/index-D59fTgx0.js` carries `treegrid`, `cellCount`, `rowheader`,
  `columnheader`, `aria-posinset`, `scene-grid-caption` and the keymap's intent literals, and **no
  longer carries** `scene-grid-layer` or `scene-grid-scene-row` — the band wrapper and the scene row
  that P4 removed. The CSS bundle carries `.scene-grid-caption`
- build order is the chain that holds, not a string scan of `app.exe` (Tauri compresses embedded
  assets): `frontendDist` is `../../editor-web/dist`, vite emitted `index-D59fTgx0.js` at 23:15:47 and
  the shell compiled at 23:18:31; Playout's web bundle at 23:19:56 and its shell at 23:22:09
- no collision with a live session: nothing was running, checked before building (rule 97)

### Desktop package build — 2026-08-05

Both shells rebuilt so the autosave retry, the unreachable-service message, the
autosave revision stamping and the Sequencer removal reach an installed app.

- `npm run build` (clean dist → Shared → Editor → Playout → stage runtime): passed
- `cargo build --release` (render engine): unchanged this pass, no Rust was touched
- `cargo clean -p app --release` / `-p playout-app --release` **before** each
  `tauri build`, per rule 87 — without it the build script may not re-stage
- `npm run build -w @grapix/desktop-tauri` and `-w @grapix/playout-desktop`: both
  exit 0, run **unpiped** into a log (rule 97: a pipeline reports its own exit code)
- rule 87 hash check, run after *each* package and again at the end — built engine
  `62CD7811…` equals both `*/src-tauri/binaries/grapix-render-engine-x86_64-pc-windows-msvc.exe`
- artifacts: `GrapiX_0.1.0_x64-setup.exe` (39.2 MiB) + `GrapiX_0.1.0_x64_en-US.msi`
  (58.4 MiB); `GrapiX Playout_0.2.0_x64-setup.exe` (28.9 MiB) + `.msi` (42.0 MiB)
- bundle-level proof: `dist/assets/index-*.js` has no `Sequencer` and does carry
  `Project service unreachable`; the staged `grapix-api-server.mjs` carries
  `storedRevision` and `sceneRevision`
- **A string scan of `app.exe` proves nothing** — Tauri compresses embedded assets,
  so no frontend string is searchable there, present or absent. The chain that does
  hold is build order: vite emitted the verified `index-*.js` at 15:34:57 and the
  shell compiled from it at 15:37:11
- the build did **not** collide with the live session: the running engine and
  services were the *installed* copies under `C:\Program Files\GrapiX`, so the
  repo sidecar rule 97 deletes was never locked. Check this before assuming a
  build must wait for the apps to close

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

### 2026-08-12 - AE-CD1 declared controls and stable native targets

- Added protocol-v1 authenticated named-pipe client/supervision in Playout, including owned versus
  attached process identity, bounded health/restart behavior, persisted crash evidence, and explicit
  degraded/failed status without claiming Program readiness.
- The resident AEGP adapter now returns typed project, composition, layer, and constrained property
  descriptors. Control identity is composition item id + layer id + canonical match-name path and
  ordinal; display names and structural fingerprints are diagnostic only.
- Declared `AeDynamicControl` records live in the runtime-container sidecar with persistent UUIDs,
  update policy, value constraints, and `valid | stale | rebind-required | disabled` lifecycle.
  Playout validates declaration, writability, canonical target, kind, value, and policy before the
  only `SET_PROPERTY` dispatch. Undeclared/read-only/stale/out-of-range calls do not reach the setter.
- Editor now has a dedicated dockable **AE Controls** panel. This remains separate from
  `PropertiesSidebar.tsx`, which is scene-object binding UI.
- Live AE 26.3 evidence on `lower-third.aep`: composition item `1`, layer id `21`, and canonical
  `ADBE Opacity[0]` were discovered; an out-of-range write was refused, `100 -> 83 -> 100` readback
  passed, a rename preserved id `21`, duplication created id `22` without hijacking id `21`, and a
  clean AE restart rediscovered/wrote id `21`. The fixture changes were discarded on shutdown.
- Scope remains AE-CD1 only. Atomic multi-control revisions/audit reservation (AE-CD2), media preload
  handles (AE-CD3), expression-control authoring/dependency preflight (AE-CD4), and Program frame
  ingress remain later gates.

### 2026-08-13 - AE-CD2 revisioned atomic application and audit

- `APPLY_DATA_REVISION` joins the closed runtime protocol. The adapter applies a batch in three
  phases: parse and range-check every member, resolve every target and prove every stream writable
  while capturing its prior value, then write all of them inside one `AEGP_StartUndoGroup`. The first
  write failure restores every already-written member in reverse and answers
  `REVISION_ROLLED_BACK`; a failed *restore* deliberately downgrades to `AE_ERROR` so a mixed state is
  never reported as a clean rollback.
- `AeControlBinding` (`controlId` + `dataPath`) lives on the container sidecar. Values resolve through
  `resolveDataPath` from `@grapix/shared-types` - not a second path resolver. A binding naming an
  undeclared control, or bound twice, is refused when the sidecar is validated.
- `AeDataRevisionTracker` persists the accepted revision, its idempotency key and the control ids it
  wrote, one file per container, through a temp-file rename. It commits **only after** the adapter
  reports the whole batch applied: a crash in that window re-offers the same revision, which the
  idempotency key then recognises as a retry. The other write order would skip a revision nothing had
  applied.
- Verdicts are `apply | duplicate | not-monotonic | gap | conflict`, and every one is reachable.
  Because a revision must be exactly `baseRevision + 1`, the base alone decides the rest: below the
  accepted revision is `conflict`, above it `gap`, equal `apply`. There is no separate `stale` verdict
  - a resend of an accepted number under a different key cannot be told apart from divergence, so it
  refuses as a conflict rather than guessing.
- `AuditLog.reserve(action, count)` claims queue capacity and returns null when the sink cannot
  promise it. A reserved record is written even once unreserved traffic has filled the queue, so the
  bounded queue drops the least interesting line rather than the one a caller was told it could write.
  The revision route reserves `members + 1` before dispatch and refuses
  `REVISION_AUDIT_UNAVAILABLE` rather than applying unrecorded. New closed actions:
  `ae-runtime.revision-applied` (events) and `ae-runtime.revision-refused` (audit).
- Update policy is recorded per member, not enforced. `on-take`/`on-cue` gating needs PL3's verb state
  machine; gating here would be a claim this phase cannot back.
- Live AE 26.3 evidence on `lower-third.aep`: layers `21` and `20` moved `100 -> 71` and `100 -> 62`
  in **one** call, both read back. A batch whose second member was out of range refused
  `INVALID_PAYLOAD`; a batch naming a non-existent layer refused `TARGET_NOT_FOUND`; both left the two
  layers at `71/62`, so a bad member costs no AE mutation even for the members that were valid.
  Restored to `100/100` and discarded on shutdown. Evidence:
  `ae-plugin/runtime-adapter/certification/AE-CD2-revision.json`.
- **Named gap.** The rollback path is implemented and its refusal handled end to end, but it has not
  been triggered live: phase 2 rejects keyframed and expression-driven streams up front, so a
  validated numeric stream has no way to fail `AEGP_SetStreamValue` mid-batch on this fixture. Until
  AE-A3's wider matrix supplies a kind that validates and then refuses, "rollback works" is a code
  claim, not a measured one.
- Scope remains AE-CD2. Media preload handles (AE-CD3), expression-control authoring and dependency
  preflight (AE-CD4), cue/take verbs (PL1-PL3) and Program frame ingress (AE-F1/AE-F2) are later
  gates.

### 2026-08-13 - BO0a breadth, PL1 exact cues, AE-F1 frame ring, and the AE-A3 gap under all three

Three phases were taken in parallel. Two landed; one is blocked on prerequisites that are named rather
than worked around. The shared discovery was that **one upstream gap sat under all of them**: six of the
thirteen declared runtime operations were admitted by the pipe but had no dispatch handler, so they
answered `OPERATION_UNSUPPORTED`.

**PL1 - declared cues and exact time. Implemented.**
- `Shared/shared-types/src/aeTime.ts` is the single reference for AE-time-to-Program-frame mapping:
  `AeExactTime` is `{value, scale}` decimal strings, and `aeExactTimeToProgramFrame` refuses anything
  that does not divide exactly onto a frame (`NOT_ON_FRAME`) instead of rounding to a neighbour.
- **`clock.ts::deadlineNanos` and `stage.rs::deadline_nanos` disagreed on a third of all frames.** The
  TypeScript side did `Math.round` on a double product that passes `Number.MAX_SAFE_INTEGER` after about
  six minutes at `60000/1001`; Rust truncated in `u128`. Measured: 33,333 of the first 100,000 frames.
  Both now truncate, TypeScript delegates to the bigint reference, and the value is `33366666` for frame
  2 at `60000/1001`, not `33366667`.
- `aeCueMap.ts` resolves the `GRAPIX:` marker grammar with a closed refusal set, and one JSON vector
  fixture is read by **both** the Node and Rust tests so the two cannot drift apart silently.

**AE-F1 - bounded shared-memory ring. Implemented.** `AeFrameDescriptor` plus the explicit
`bgra8`/`rgba8`/`argb8` colour format landed in TypeScript and Rust together; old documents default to
`bgra8` and NDI validation refuses anything else. The adapter owns a Windows mapping with a fixed header
and four fixed slots, `FREE -> WRITING -> READY -> READING -> FREE` on acquire/release atomics, with
generation and owner ids against stale mappings and ABA reuse. A two-process harness ran **100,000
cycles**: zero checksum faults, zero in-use overwrites, zero allocations after configure, bounded
rejected requests, and a resume without reconnect after every slot was `READY`. No pixels reach
`ipc.rs`, `transport.rs`, protocol v3, audit or browser payloads. Program ingress is AE-F2 and untouched.

**AE-A3 breadth - partial, and it was the blocker under the other two.** `SET_TIME`, `LIST_EFFECTS`, and
a declared canonical property table for text (`ADBE Text Properties/ADBE Text Document`) and effect
colour (`ADBE Effect Parade/ADBE Fill/ADBE Fill-0002`) now exist, all routed through one table so
nothing is writable that discovery did not declare. Live: one revision moved two text members and a
colour member together (`042 -> 137`, `MAYA RIVERA -> GRAPIX LIVE`, `#0557FF -> #1E90FF`), and a batch
with a malformed colour member refused and left all three untouched. `OPEN_PROJECT`, `CLOSE_PROJECT`,
`RENDER_READY` and `RENDER_FAILED` are still admitted without handlers.

**BO0a - three of four controls proven; the full gate stays open.** `PLAYER_NAME`, `SCORE` and
`TEAM_COLOR` now pass through the production `AeControlService` path in `certify:ae-runtime-fixtures`,
and live dependency equality passes now that `LIST_EFFECTS` answers. The alpha subset still compares
7/7 at zero differing pixels. Two manifest claims were **wrong and are corrected**: the source ids (18
and 16, not 4 and 2) and `PLAYER_IMAGE`, which is an internal solid and not replaceable footage. Still
open, each an explicit `not-run` row: the approved licensed third-party plugin (criterion 15,
unobtainable here), AE-CD3 footage replacement, authored composition markers (so the cue map is
declared-not-authored), AE-F2 ingress, and the AE-F3 soak.

**The finding that cost a session.** `SET_TIME` asked `LOWER_THIRD` for `1001/30000` and AE answered
`800/23976`: AE holds time in the *item's own* scale, and this composition's scale is `23976`, exactly
`29.97` rather than `30000/1001`. The two are different instants under cross-multiplication
(`1001x23976 = 23999976` against `800x30000 = 24000000`), so the adapter now refuses with
`TIME_NOT_REPRESENTABLE`. The cue map's declared rate and the composition's own scale are two clocks,
and reconciling them was open work — closed on 2026-08-17, below.

### 2026-08-17 - the declared rate and the composition's scale become one proven clock

**PL1's open gap is closed.** Of the two routes named on 2026-08-13, cue resolution learned to state
cues in the composition's scale; the fixture was *not* re-authored to fit the declared rate. Re-authoring
would have made one fixture pass and left every real `29.97` composition to fail at air time, and the
project file is authoritative, so GrapiX has to read the composition's clock rather than assert it.

**The composition clock is now a contract, and it is exact.** `AeCompositionClock {frameDuration,
timeScale}` in `Shared/shared-types/src/aeTime.ts` comes from `AEGP_GetCompFrameDuration` as a rational
and **never** from `AEGP_GetCompFramerate`, which is an `A_FpLong`: a float rate cannot be trusted to
separate `2997/100` from `30000/1001`. `AeRuntimeComposition` now *requires* it, so a container can no
longer carry a composition whose clock nobody read.

**The proof collapses the problem.** A composition's exact rate is `timeScale/frameDuration`;
`reconcileAeCompositionClock` demands it equal the declared Program rate. Once they are the same
rational, `timeScale = k·numerator` and `frameDuration = k·denominator`, so Program frame `F` is at
exactly `F·frameDuration` in the composition's scale — an integer for every `F`. Consequences worth
keeping:
- A rate the scale cannot carry condemns **every** cue, not one, so it is refused once at load rather
  than per cue at air time. `AeCueService` raises `RATE_NOT_IN_COMPOSITION_SCALE` **before** any adapter
  call, so the refusal now precedes AE mutation instead of being inferred from AE's read-back.
- A per-cue "not on a composition frame" refusal was written, then **deleted as dead code**: with the
  clocks reconciled it cannot fire, because composition-frame and Program-frame membership are the same
  divisibility test. Verified by brute force over 86,760 clock/rate/time triples before removing it.
  `CUE_OFF_FRAME` already covers the reachable case.
- The cue-map digest now covers the clock, so a composition re-authored at another scale invalidates
  every recorded pin instead of resolving identically against a different clock. Resolutions that pass
  no clock keep their previous canonical form and digest, so existing pins are untouched
  (`066ac392…` still holds).

**The fixture stopped asserting a rate nobody measured.** `lower-third.json` recorded `30000/1001` while
the composition was `29.97`; it now records the measured clock `800/23976` and rate `2997/100`, with
markers restated at composition-frame instants (`0, 800, …, 4800` in scale `23976`) and digest
`f69ad7e1abf6e1f9b67c445a89a32a832df4c43f635ed61d5998742883412824`. Deadlines moved accordingly — frame
1 is `33366700`, not `33366666` — which is the honest consequence of 29.97 not being 29.97003.

**Cross-language, in one commit (rule 7).** `render-engine/src/stage.rs` mirrors the arithmetic and both
sides consume the same `Shared/animation-engine/fixtures/ae-cue-vectors.json` vectors
(`compositionClocks`, `compositionRefusals`, `compositionScaleRestatements`), which reproduce the
measured round trip: `1001/30000` refuses, `800/23976` is composition frame 1, `0/30000` restates to
`0/23976`. Verified: shared 15 packages green (shared-types 218, animation-engine 47), Playout 98,
Editor 121/40/8/24/485, `cargo test` stage suites green, root `typecheck` and `check:boundaries` clean.

**The adapter now reports the clock — compiled, not executed.** `runtime_list_compositions` emitted only
`AEGP_GetCompFramerate` (an `A_FpLong`), so the composition's own scale never reached TypeScript at all
and the manifest's measured value was the only source. It now also emits
`clock: {frameDuration, timeScale}` from `AEGP_GetCompFrameDuration`, and omits the field rather than
fabricating one when a composition has no usable duration. `AeRuntimeCompositionDescriptor.clock`
carries it on the wire, and `frameRate` is now marked diagnostic-only on the descriptor.
**The AE SDK *is* vendored here** at `vendor/adobe/sdk/ae25.6_61.64bit.AfterEffectsSDK` (gitignored, so
a `glob` scoped to `ae-plugin/` misses it) and MSVC 14.44 is installed at the path `build.sh` expects —
`adapter.cpp` compiles clean, with two pre-existing `getenv` warnings. Note `build.sh` is bash-only and
uses `//flag` for MSYS path translation; the harness shell is not git-bash, so compile steps need
single-slash flags.

**Still gated, and not faked.** Compilation is not execution: reading a live composition's clock needs
the licensed AE 26.3 host with the installed `.aex`, so no claim is made that a live
`LIST_COMPOSITIONS` returned the rational. That stays an external gate on the fixture, and
`compare-lower-third.mjs` records an explicit unverified line rather than passing silently when the
field is absent. Also unchanged: the adapter still leaves the composition parked at the quantised
instant when it refuses `TIME_NOT_REPRESENTABLE` in isolation, which the GrapiX path no longer reaches.

**What is actually in `SDK docs/`, and the exposure it created.** Four files were dropped in the repo
root; only one is relevant to this work.

| File | What it really is | Relevance |
| --- | --- | --- |
| `AfterEffectsSDK_25.6_61_win (1).zip` (7.5 MB) | The AEGP SDK delivery. Not a plain zip: it holds `ae25.6_61.64bit.AfterEffectsSDK.zstd.zip` plus bundled 7-Zip-Zstandard and `extractzstd.bat`, which is why it ships an archiver. | **This is the one.** Its payload name matches the already-extracted `vendor/adobe/sdk/ae25.6_61.64bit.AfterEffectsSDK`, so the vendored SDK is this delivery. |
| `documentation.pdf` (57,309 B) | The **CC 2015 HTML5/CEP Panel SDK Guide**, renamed — MD5 `5f94c06d…` is byte-identical to the guide inside the Panel SDK zip. Zac Lam, Aug 2015. | **Wrong SDK.** CEP panels are a different extensibility surface from AEGP; nothing in the adapter uses it. |
| `Adobe_After_Effects_CC_2015_Panel_SDK (1).zip` (77 KB) | The CEP panel samples the PDF documents (Barebones, iframe, Simple Script). | None. |
| `SensorManager-PluginSDK-CC201804.zip` (738 KB) | Adobe **Sensor Manager Plug-in SDK** for Motion Graphics JSON (MGJSON), April 2018 — writes `.mgx` converters that turn a vendor file format into MGJSON, which AE imports as footage whose data streams drive properties. Targets AE 15.1, VC++ 2015 / Xcode 8. | Adjacent to data bindings, **not** to the runtime container: MGJSON is an offline ingest format, while GrapiX drives declared properties live over the adapter. |

**The real AEGP documentation is not a PDF any more.** `After_Effects_SDK_Guide.pdf` inside SDK 25.6 is
a three-line stub pointing at <https://ae-plugins.docsforadobe.dev/>. That online reference confirms
`AEGP_GetCompFrameDuration(AEGP_CompH, A_Time*)` returns "the precise duration of a frame based on the
composition's frame rate" as an `A_Time` value/timescale pair — the semantics the reconciliation above
rests on. `AE_GeneralPlug.h` agrees: `AEGP_GetCompFramerate` is `A_FpLong` (line 702),
`AEGP_GetCompFrameDuration` is `A_Time` (line 834). Adobe's own header even distinguishes the two
clocks in a comment: *"when timebaseC == 30 && item framerate == 29.97, use drop frame or non-drop?"*
and `AEGP_CreateComp` takes the framerate as an `A_Ratio`, not a float.

**Licence exposure, fixed.** `SDK docs/` was untracked but **not** gitignored, so 8.4 MB of Adobe SDK
material — both PDFs carry "no part of this publication may be reproduced or transmitted ... without
the prior written consent of Adobe" — would have been committed by any `git add -A`. `.gitignore`
already excluded `vendor/adobe/` for exactly this reason; `SDK docs/` now sits beside it. Verified with
`git check-ignore`.

**Toolchain pin, decided 2026-08-17.** Host **After Effects 2026 (26.3)** + SDK **25.6_61** + **MSVC
14.44**. The owner confirmed **no 26.x SDK is published on the Adobe developer portal yet**, so the
one-minor gap is deliberate rather than accidental and satisfies L0's "pinned SDK toolchain"
requirement. This is the exact triple `AE-A0` built and ran and that `adapter.cpp` compiles clean
against. Treat it as a **re-validation trigger, not a permanent answer**: when a 26.x SDK ships, re-run
`AE-A0` and `AE-F0` before adopting it, and treat any struct layout or suite-version difference as a
contract change rather than a drop-in upgrade. Recorded on the plan's §3 ground-truth list so it is
reviewable instead of implied.

### 2026-08-17 - council round 2: finish AE-A3 next, run CB0 beside it

Seven seats reconvened after `PL1` closed. **Verdict: `AE-A3` completion next (5 of 7 seats), with `CB0`
run beside it rather than after it (6 of 7).** Adapter and Cutover seats put `CB0` first; nobody put
`PL2` first even though it is fully unblocked, because its 7-10 days would design a control plane before
`AE-F2` exposes the completion, revision and deadline facts it has to carry. Full round recorded in the
plan's §2 "Council round 2".

**Only four of thirteen AE-A3 operations remain**, admitted by the pipe and falling through to
`OPERATION_UNSUPPORTED`: `OPEN_PROJECT`, `CLOSE_PROJECT`, `RENDER_READY`, `RENDER_FAILED`
(`adapter.cpp` dispatch chain ~3041-3073, `runtime_pipe.cpp` ~449-458). Nine dispatch today.

**Do not add the lifecycle pair as ordinary idle-hook cases.** `AE-A0` finding F2 already recorded that
`AEGP_OpenProjectFromPath` from the idle hook returns `A_Err_NONE`, opens the project, and then no idle
callback ever fires again; pipe requests are still dispatched synchronously from that same hook. Naive
completion wedges the runtime. Lifecycle needs its own execution route and the supervisor must treat
channel silence as a state.

**`AE-CD2`'s named gap is load-bearing.** Its rollback path has never been triggered live, and `AE-CD2`
gates `AE-F2` and `PL3`. Its stated remedy is "a second writable kind from AE-A3's wider matrix", so
`AE-A3` is the enabler — sequence the two together rather than treating the gap as a missing test.

**`AE-F2` should be split before starting.** `program.rs` sleeps to a target's deadline and only then
renders, so there is no earlier request point: `AE-F2a` proves one live checkout → ring → Program frame,
`AE-F2b` adds lead-time scheduling, late/missed/backpressure policy and counters.
`RENDER_READY`/`RENDER_FAILED` carry correlation (request, session, composition item, exact
composition-scale time, revision, frame id, deadline) and stay **events**, never replies sharing a
`messageId` (rule 24).

**CB0 is not cosmetic — the falsehood is still shipping and was already known.** `preferEditability` is
accepted by the dialog, the API client and the route, threaded into `sceneConverter`'s signature, and
**read by nothing** — which `memory.md` itself already recorded as a finding. The UI still offers
"Prefer editable objects over pixel-exact rendering" and promises that turning it off "favours visual
accuracy, baking more layers to rendered fallbacks", while `docs/adobe-integration.md` says that baking
is not implemented. A known-false user-facing claim that survives in the product is the strongest
argument the Cutover seat has, and it is a fair one.

**Fixed in passing:** `compare-edge-corpus.mjs` iterated `manifest.cases` with `failed = false` and no
floor, so an emptied or truncated manifest printed PASS and exited 0 — a straight breach of rule 247,
which `compare-lower-third.mjs` had guarded and this runner had not. It now refuses fewer than seven
cases and refuses duplicate compositions, so seven copies of one vector cannot stand in for seven.
Verified against emptied, missing, six-case and seven-duplicate manifests.

**Two defects in the plan document itself.** `AE-CD0` declares "Blocked by CB0" but is recorded landed
while the `CB` track never started — bypassed, not satisfied, so `CB0`'s inventory owes `AE-CD0` a
retrospective pass. And `AE-A1`, `AE-A2`, `AE-CD0`, `AE-CD1` are counted landed with **no status card**,
contradicting the plan's own "a phase without one is not started"; their evidence lives only here.

### 2026-08-17 - AE-A3's declared surface closes as 11 operations plus 2 events, and CB0 stops the false claim

Council round 2's verdict executed: `AE-A3`'s four remaining operations and `CB0`, run together.

**The four operations exposed a contract defect.** `RENDER_READY`/`RENDER_FAILED` were declared **twice**
- in `AeRuntimeOperation` (client->adapter, has a `requestId`) and in `AeRuntimeEvent` (adapter->client,
has none). One name meant two incompatible things: a client asking AE whether a render is ready, and the
adapter reporting that it is. Only the second is meaningful. They are **events only** now, removed from
the operation union and from the pipe's inbound admission. **The declared surface is eleven operations
plus two events, not thirteen operations.**

**A latent bug sat under it.** `AeRuntimeClient.acceptBytes` handed every frame to the next reply waiter,
while `call()` demands the next frame match its outstanding `requestId`/`sequence`/`operation`. One pushed
event would have failed an unrelated call with `MALFORMED_FRAME` and desynchronised the pipe - events
could not be delivered at all. The client now demultiplexes on `kind`; an event never satisfies a reply
waiter. It also drops and counts foreign-session events, isolates throwing listeners, bounds
pre-subscription buffering with a dropped count, and tracks event-sequence gaps. Events carry an
independent sequence and no `requestId` (rule 24), through the same serialised writer as results.

**Project lifecycle is a supervisor-owned process replacement, not an adapter command. Do not put it
back.** Finding F2 measured `AEGP_OpenProjectFromPath` on the idle hook returning `A_Err_NONE` then
silencing every later callback. The first answer was an asynchronous lifecycle - accept, act on a
later idle callback, emit `PROJECT_LOADED`/`PROJECT_CLOSED` only once another callback proved
survival, and raise `LIFECYCLE_SILENT` when completion never came. It was executed on licensed AE
26.3 on 2026-08-18 and worked exactly as designed: `OPEN_PROJECT` accepted as `lifecycle-1`, host
unresponsive, supervisor `ready -> degraded` with the documented remedy
(`certification/AE-A3-lifecycle-silence.json`). It detected the wedge; it never avoided it, and a
detected wedge still costs a kill and the next start's dialog tax.

So the whole surface is **removed** at runtime protocol major **2**: no
`OPEN_PROJECT`/`CLOSE_PROJECT` operations, no `project.lifecycle` capability, no
`PROJECT_LOADED`/`PROJECT_CLOSED` events, no `AeLifecycleAcceptedResult`,
`AeProjectLifecycleDetail` or `AeRuntimeLifecycleSilentError`, and no pending-lifecycle queue in
`adapter.cpp`. The pipe refuses both names as `OPERATION_UNSUPPORTED` like any other non-protocol
name. `AeRuntimeSupervisor.restartWithProject` verifies the target `.aep` against its declared
digest, terminates the owned host, and launches a fresh one with that project.

**Identity comes from After Effects, never from the caller's digest.** `HEALTH` now carries
`projectPath` from `AEGP_GetProjectPath`, and a launch is not `ready` until that path matches the
requested one; a different path is treated as still-loading until the deadline, then refused. The
declared digest proves which bytes were asked for, not which project is open - only AE's own answer
does that.

**Executed on the licensed host, 2026-08-18.** Adapter
`7155d7ef1f5be5cb902241a3629777e27372c5ab09d70c17b8d6160f3f3929bb`, self-reported and matching the
installed file. `lower-third.aep` owned/ready as pid 45752 with AE reporting that path; both removed
operations refused `OPERATION_UNSUPPORTED` **and the host stayed commandable after refusing them** -
that is the measured difference from the wedge; the change to `bo0a-alpha-edges.aep` came up as pid
49392 with AE reporting the replacement path and all seven BO0a compositions enumerated; shutdown
`stopped`, `crashCount 0`, no error. Evidence:
`ae-plugin/runtime-adapter/certification/AE-A3-restart-lifecycle.json`. The runner is
`Playout/services/playout-control/tests/ae-restart-live.mjs`; it re-records this evidence on demand.

**Three things this does not fix, and one of them will bite an unattended run.** The SDK call is
unreachable, not safe. The supervisor does **not** clear AE's startup modals - the live run needed
the `ae-window.ps1` clearing loop running beside it, and without that a host queuing a crash dialog
times out at the pipe with `ENOENT` for the whole window. Stop is `SIGTERM`/`TerminateProcess`,
which arms crash repair and taxes the next start; there is no AEGP quit call, so a graceful
in-protocol shutdown does not exist. Render-event **serialisers** still have no caller - emission
belongs to `AE-F2`, and nothing fabricates a render event.

**CB0: the false claim is gone from every surface a user can read.** The Import-After-Effects command,
the dialog's import flow, the path-based `/api/import/after-effects/project` route,
`importAeProjectOnApi` and its `source: "native" | "bridge"` switch are removed;
`POST /api/import/after-effects` survives as the AEP Static Inspector and says of an `.aep` that it
"performs static inspection only; it makes no renderability, fidelity, or scene-conversion
determination". `preferEditability` - accepted by dialog, API client, route and converter signature and
**read by nothing**, which this file already recorded while the UI still promised it traded editability
for pixel accuracy - is removed at every layer rather than relabelled.

**CB0's gate is honestly partial.** Zero hits across editor-web, project-api, `Shared/*/src`, the READMEs
and the AE docs. `AEPX direct`/`aepx-direct` still appear in `aepxParser.ts` and the `AeManifest.producer`
union: internal code, not a user-readable claim, and exactly what **CB1**'s exit gate deletes. Recorded as
CB1's inheritance, not reported as a clean zero. The CB0 card's gate was also amended to exclude
`memory.md`'s preserved evidence lessons - rule 155 contains `AEPX direct` while recording why that path
was deleted, and deleting a lesson to satisfy a grep would destroy the evidence that stopped the path
being rebuilt.

**Two test faults the removal exposed.** `ae-native-route.test.mjs` was green against a **stale `dist/`**
and only failed once `project-api` was rebuilt - a subagent's "tests pass" meant nothing because it had
rebuilt a different package. It now targets the retained inspector and asserts an `.aep` is refused for
conversion, reports inspection-only, and **creates no scene or asset directory**. `importers.test.mjs`
pinned the old `/cannot execute|forbidden/` wording and now pins the truthful message plus empty
`convertedItems`/`importedItems`. Verified after: typecheck clean, `check:boundaries` clean, shared 15
packages `fail 0`, Playout `fail 0`, Editor 5 packages `fail 0`.

### 2026-08-17 - topology: both hosts supported, but they are two different seams

The owner answered the chair's question with "both options - same host or separate render host". That
phrase conflates two questions, and separating them is the whole answer.

**Where GrapiX rasterizes and outputs: already host-agnostic, already implemented.** `config.rs` takes
`--bind`, `--headless`, `--engine-id`, forces a token on any non-loopback bind (rule 21), warns without
TLS, supports a client allowlist, and says in its own header that "mode is configuration rather than a
code path". `remote-production-v2.md` lists headless remote engine mode as implemented substrate. A
separate GrapiX Render Engine host needs **no new work** - it is deployment configuration today.

**Where After Effects runs relative to the engine: same host only, through AE-F3.** Two independent
reasons, either sufficient on its own:
- **Licence.** L0 §9 approves **V1 only**. A dedicated on-prem AE machine is **V2: conditional** - own
  licensed seat, *named interactive user*, no service account, because Business PST §4 bans generic-user
  deployment. The render-engine install is **V3: research variant only**; whether an AEGP can host the
  frame path there is unproven. §9.4 scope discipline puts "a second render machine at scale" behind L1
  and kill gate K0.
- **Arithmetic.** AE-F1's ring is a Windows shared-memory mapping: same-host by construction, moving zero
  bytes over a link because it hands over a mapping offset. Crossing hosts needs a real transport -
  1920x1080 BGRA8 at 60000/1001 is 8,294,400 B/frame = **497 MB/s = 3.98 Gbit/s**; 16-bit 7.95;
  2160p59.94 **15.91 Gbit/s**. 10GbE with no headroom, 25GbE+ for UHD. Compressing to fit would violate
  invariant 7. The control channel is same-host by construction too: a local same-user named pipe.

So a remote-AE variant is **a phase with a licence gate in front of it, not a configuration flag**. What
AE-F2 owes it is a seam: the ingress already consumes only descriptor plus slot lease and knows no Adobe
SDK call, and that boundary stays transport-shaped. **AE-F2a must refuse a non-local AE session with a
named code** so the unapproved topology is never reachable by accident or left silently undefined.

**AE-F2 is split** (chair's demand): **AE-F2a** 3-4 d - one live frame end to end, ProgramClock request ->
checkout -> ring descriptor/lease -> engine ingress validation -> RecordingSink byte comparison, same-host
with the non-local refusal; **AE-F2b** 5-8 d - lead-time scheduling, the in-flight set that stops a timer
wakeup issuing a second request, late/missed/backpressure/stale-revision policy, counters. Note
`program.rs` currently sleeps to a target's deadline and only then renders, so there is **no earlier
request point at all**; creating one is AE-F2a's first real change and it must preserve skip-late rather
than queue historical frames.

**Next, in order:** AE-CD2's live rollback trigger (AE-A3's wider matrix supplies the second writable
kind its gap asked for), then AE-F2a. Both need the licensed AE 26.3 host, which is the standing gate on
everything native now.

### 2026-08-17 - AE-CD2's rollback becomes measurable, and a mixed state gets a name

The gap said "rollback works is a code claim, not a measured one" and offered two remedies: find a stream
class that validates then refuses, or use a second writable kind from AE-A3's wider matrix. Investigating
produced a **third answer, and it is the right one: nothing validated on this fixture can fail its write,
because phase 2 is deliberately thorough** - every kind is gated on a cheap total query
(`AEGP_GetLayerObjectType` for text, an effect walk for colour) before a stream is acquired. That is a
property to keep, not a hole to open, so hunting for a validate-then-fail stream was the wrong shape.

**What was done instead.** The write/rollback sequencing is factored out of AE into
`ae-plugin/runtime-adapter/src/revision_apply.{h,cpp}` (`apply_revision_with_rollback`);
`runtime_apply_data_revision` calls it with two AE-aware lambdas, so the harness measures **the same code
production runs**. `revision_rollback_harness.cpp` + `run-revision-rollback-harness.sh` link only
`revision_apply.cpp` and **no SDK header**, following the AE-F1 ring-harness pattern. Ten cases pass,
including a 1,000-batch sweep moving the failure index across the batch (4,500 write / 3,500 restore calls
observed): forward writes; reverse restores, exactly once; the failing member and unreached members never
restored; **a failing restore does not abandon the remaining restores** (stopping would widen the mixed
state, not limit it); the write's original failure code survives the rollback's report; any restore failure
degrades away from a clean rollback.

**The harness is falsifying.** Reversing the restore order on purpose fails six of its ten cases and exits
1; the good run exits 0. A harness that cannot fail measures nothing, so this was verified by mutation
rather than assumed.

**`REVISION_ROLLBACK_FAILED`.** Rule 238 already refused to call a failed restore a clean rollback, but it
left the worst outcome wearing `AE_ERROR` - the same code as any routine refusal - and captured the
restore's own error code into a local it then discarded. The new code travels adapter -> `AeRuntimeErrorCode`
-> `AeDataRevisionRefusalCode` -> an operator message stating the project holds a mixed state and that no
retry is safe until a human inspects it. The accepted revision still does not advance. **This refines rule
238, it does not reverse it.**

**The live trigger has a procedure now, not a search.**
`GRAPIX_AE_RUNTIME_FAULT_INJECT_REVISION_WRITE=<index>` forces the Nth write of the next revision to fail,
**once**, then disarms - so the restores run against real AE values with a real read-back and only the
*cause* is synthetic. Because an adapter that can be told to fail is a liability: an armed adapter reports
`faultInjection` in its HELLO fingerprint, and `compare-lower-third.mjs` refuses to record evidence when
that field is non-null **or absent** (an adapter predating the field is unknown, and equally not evidence).

**Still owed:** no injected revision has run on the licensed AE 26.3 host, so "AE restores real values"
remains a design claim. That one experiment closes the gap.

Verified: adapter and `revision_apply` compile clean (3 `getenv` C4996s now, up from 2 - the new one
follows the file's existing idiom); harness 10/10 exit 0; typecheck and `check:boundaries` clean; shared 15
packages `fail 0`, Playout `fail 0` (revision service 9 tests), Editor 5 packages `fail 0`. Also learned:
**git-bash exists at `C:/Program Files/Git/bin/bash.exe`**, so `build.sh` and the harness scripts can be
run directly instead of reconstructing `cl` invocations by hand.

### 2026-08-17 - AE-F2a: the clock gets a request point, and ingress gets twelve named refusals

**`src/ae_ingress.rs`** (new) consumes **descriptor plus slot lease only** and makes no Adobe SDK call.
Refusal codes: `AE_SESSION_NOT_LOCAL`, `AE_STALE_RING_GENERATION`, `AE_COMPOSITION_MISMATCH`,
`AE_FRAME_UNREQUESTED`, `AE_FRAME_DUPLICATE`, `AE_FRAME_OUT_OF_ORDER`, `AE_FRAME_HISTORICAL`,
`AE_FRAME_NOT_READY`, `AE_TIME_MISMATCH`, `AE_STALE_REVISION`, `AE_REJECTED_FORMAT`,
`AE_IMPOSSIBLE_GEOMETRY`. **Locality is checked first**, so an unapproved topology is refused before any
other field is trusted. `AeProgramSource::new` also refuses a composition clock that cannot carry the
Program rate - structurally at install, because that condemns every frame, which is the same argument PL1
used to move the rate check out of the per-cue path. Exact times are cross-multiplied, so `800/23976` and
`100/2997` are one instant.

**The clock is two-stage now.** It reads `has_ae_program_source()` in its *existing* status lock, so the
non-AE path keeps exactly its old single-sleep shape and pays nothing. With an AE source: sleep to
`deadline - request_lead_nanos(rate)`, issue at most one request for `next` **only while still before the
deadline**, then sleep to the **unchanged** absolute deadline. The lead is taken *out of* the existing
wait, never added to the schedule, so a late request cannot push presentation later. Lead = one frame
period capped at 50 ms; one period is the largest lead that cannot overlap the previous frame's request,
and pipelining two is AE-F2b's question rather than an accident.

**Two findings from the tests, both real, both my spec's fault:**

1. **A truncated deadline lags exactly one frame; `target = next.max(due)` is load-bearing arithmetic.**
   I specified `frame_at(deadline_nanos(f)) == f`; it fails for **1,333 of the first 2,000 frames** at
   `60000/1001`. Frame 1's exact deadline is 16,683,333.33 ns, truncated to 16,683,333; `frame_at` of that
   is 0.99999998 -> 0. Both functions round down, so `due` may lag one and can never lead, and
   `frame_at(deadline+1)` is always the frame itself. The test now pins those invariants and says why the
   `max` is not defensive coding.
2. **`AE_FRAME_HISTORICAL` must be decided before the in-flight lookup.** An abandoned frame has no
   request, so the original order answered `AE_FRAME_UNREQUESTED` - "nobody asked for this" - about a
   frame that *was* asked for and merely came late. Also corrected the counter: **`abandon_before` owns
   the `missed` count**, so a late arrival for an abandoned frame must not count a second miss, or the
   totals would claim more dropped frames than the clock dropped and CB4/PL4 would inherit the inflation.
   There is now an explicit double-count guard test.

**Both subagents refused to weaken an assertion and reported the conflict instead.** That is the correct
behaviour and it is why both faults were found rather than papered over.

**Verified, all scripted:** 96 lib tests (27 ingress cases, whole-struct counter assertions, the
double-count guard) and 9 integration tests in `tests/ae_program_ingress.rs` - a 100-frame sweep with
`requested == ready_before_deadline == 100`; out-of-order / duplicate / stale-revision / wrong-format
refusals; an injected late completion counted without blocking the next deadline; an unreturned request
counted missed and its late arrival refused historical; a non-local session unable to present at all; and
a known premultiplied BGRA8 pattern round-tripped **byte-for-byte** through `RecordingSink`.

**Owed:** no AE frame has been evaluated through this path. The engine output seam
(`render_program_frame`'s AE branch) and the fail-closed egress agreement against `validate_ndi_format`
are deliberately unwritten - they need a real descriptor and a licensed host to be worth more than a mock.

**Pre-existing failure, characterised (not mine, and not a flake).**
`protocol_server::a_patch_is_applied_and_reports_what_it_invalidated`: `applyPatch` replies
`sceneRevision: 3`, then `getStatus` reports 2. Measured behaviour, which is the important part:
**isolated with `--exact` it fails deterministically; run inside the full binary it fails intermittently
(2 of 3 runs).** So it is a real defect that concurrency occasionally *masks*, not a timing flake — do not
dismiss it on a green suite run.

`getStatus` reads `LoadedScene::revision` (`engine.rs:3792`); the patch path assigns it at
`engine.rs:1430` behind a lookup. The uncommitted in-flight work in `engine.rs` changes how scenes are
addressed by revision (a `SceneLoad` vs `SceneFullSync` split, with a rationale comment), so
**[INFERENCE]** the patch's update may land on a different map key than status reads — unverified, and
worth ten minutes with a breakpoint rather than another guess. My own `engine.rs` changes are a new
`Option` field defaulting to `None` plus new methods, which cannot affect scene-patch revision reporting.

### 2026-08-17 - the AE output seam and ring wiring land; the live frame is blocked on elevation

**Engine output seam.** `render_program_frame` now takes a single early branch to
`render_ae_program_frame` when an AE source is installed, leaving the scene/GPU path below it exactly as
it was. Staging is **one preallocated slab**, reused across frames and replaced (and counted) only when
the negotiated geometry changes - a per-frame `Vec` at 59.94 would be sixty ~8 MB allocations a second.
Egress **fails closed**: every running output is checked against `validate_ndi_format`, `Bgra8`,
premultiplied, sRGB, matching dimensions and tight stride before a byte moves; disagreement refuses
`AE_REJECTED_FORMAT` and delivers nothing. **The lease is returned on accept, refuse and error** - the
ring is bounded and a leaked lease starves it.

**Adapter ring wiring - the gap nobody had noticed.** AE-F1 proved the ring with a 100,000-cycle harness,
but `adapter.cpp` contained **zero references to `SharedFrameRing`**: the evaluated frame had no route in,
so AE-F2a's ingress had nothing to validate. `checkout` now takes an opt-in
`ring <renderRequestId> <dataRevision> <frameId> <presentationDeadlineNanos>`, lazily creates a four-slot
session-derived producer mapping, swizzles the **observed** ARGB8 premultiplied world into BGRA8 in the
lease, preserves AE's row stride, publishes the descriptor and emits a correlated
`RENDER_READY`/`RENDER_FAILED`. Back-pressure is reportable, never an overwrite; failed leases are
cancelled; `AEGP_CheckinFrame` runs on every path; 16/32-bit worlds and non-premultiplied alpha are
**refused, not relabelled** (finding C4 is why the descriptor reports the layout observed, never
requested).

**`build.sh` was broken and nobody had run it.** After AE-CD2 factored the rollback sequencing into
`revision_apply.cpp`, the build script's hand-listed link line was never updated, so the *documented*
build failed with `LNK2019` on `apply_revision_with_rollback` - while hand-rolled `cl` invocations kept
working and hid it. Fixed; it now compiles and links all four translation units and produces
`GrapiXRuntimeAdapter.aex` (254,464 bytes, SHA-256
`d9a3e2fceea2c0bbb397cc8346a12613a1746a77a0cb056268ea0ba4e440b942`). **Lesson: after adding a
translation unit, run the project's own build script, not the compile command you already have open.**

**Verified:** 348 engine tests pass, 14 of them in `tests/ae_program_ingress.rs` - accepted frame reaches
`RecordingSink` byte-identically, format disagreement writes nothing, lease returned on
accept/refuse/error, staging slab stable across identical geometry. Ring harness still 100,000 cycles,
zero checksum faults, zero overwrites, zero allocations after configure.

**The live frame is blocked, and the blocker is environmental.** Installing the `.aex` into
`C:/Program Files/Adobe/Adobe After Effects 2026/Support Files/Plug-ins/GrapiX` fails
`Permission denied`; `net session` confirms no elevation. That is finding **F5**, already on this
plugin's own record. AE 2026 *is* installed (`Support Files/AfterFX.exe`, note the capitalisation) and a
prior session's live evidence is still in `$LOCALAPPDATA/GrapiX/ae-adapter/result.json`, but the adapter
is **not currently installed** - `Plug-ins/GrapiX/` does not exist, so AE would not load it. The runbook
for the frame is in `ae-plugin/runtime-adapter/README.md` under "Evaluating one real AE frame into the
ring"; it needs one elevated `copy`. **No AE frame has been evaluated through the ring path. Do not let
any document imply it has.**

**A flake I introduced in the CB0 retarget, found and fixed.** `ae-native-route.test.mjs` failed roughly
one editor run in two, on two or three of its four tests. Cause: `GRAPIX_DATA_ROOT` is read when
`dist/index.js` is first imported and an **ESM import is cached**, so a fresh temp root per test never
took effect - every server resolved the first test's root - and `authenticatedInject` refuses to bootstrap
an admin once `users.json` exists there. It was *intermittent* rather than constant because it only
passed when test 1's cleanup actually deleted `users.json`, which on Windows depends on whether the
closing server had released its handles yet. Now one root, one server and one admin bootstrap for the
file, torn down in `after()`. Verified deterministic over five file runs and three full editor suites.

### 2026-08-18 - AE-F2b: the AE lead is a bounded depth, and its policy is asymmetric

**One frame period of lead cannot work, and AE-F2a said so before it was built.** A period at
`60000/1001` is 16.68 ms; `AE-F0` measured a checkout in the **tens of milliseconds**. A frame requested
one period ahead is late by construction. `services/render-engine/src/ae_schedule.rs` turns the lead
into a *depth*: 50 ms of target lead over a 16.68 ms period is **three frames**. The clock's wakeup did
not change - it still wakes one period early - but each wakeup now asks for every frame in the window,
so a frame is requested three periods before its own deadline. Do not "simplify" this back into a longer
sleep: a longer sleep moves the request point toward the previous frame's presentation, which is what
the one-period rule was protecting.

**Depth is bounded by the ring, not by taste.** `MAX_PIPELINE_DEPTH` is 8, and
`MappedAeProgramFrameSource::ring_slot_count()` reports the mapping's real slot count so frames in
flight are capped at `slots - 1` - one slot belongs to the publish in progress. A two-slot ring gives a
one-frame pipeline immediately, not after the first back-pressure event.

**Pressure and lateness are opposite signals and must never share a response.** Back-pressure or a
genuinely full in-flight set means too *deep* for the ring: drop one step. Late or missed frames mean
too *shallow*: stop the recovery streak and **never shrink**, because a shallower pipeline arrives later
still. Recovery is one step per clean second against one step per pressure event, so it settles a step
shallow instead of oscillating. This asymmetry is mutation-checked - making lateness shrink the depth
fails `late_frames_never_shrink_the_lead_depth`.

**A revision supersedes work in flight; it does not discard it.** A data change lands while several
frames are outstanding, all rendered against data that no longer applies. Their requests are *rewritten*
to the new revision and kept, so the render already under way arrives against the new request and
refuses `AE_STALE_REVISION`. Dropping them would answer `AE_FRAME_UNREQUESTED` about a frame that was
requested - the same misdiagnosis this file already records for the historical path.

**The defect the smoke test found, and the reason to run the real loop.** Every unit test called the
scheduling surface directly and passed. Driving the actual `ProgramClock` against a producer that never
delivers exposed that the clock abandoned requests **only when it skipped frames**: a stalled After
Effects with a punctual clock never skipped, so nothing was ever abandoned, the in-flight set stayed
full of unpresentable requests, and Program stopped asking for frames *permanently* - it stayed stopped
after the producer recovered. `issue_window` now drains requests below the frame being presented before
it asks for anything. Consequence worth knowing: with the drain, the capacity guard is unreachable
through the window alone (depth <= capacity, and each tick drains), so it is reached only by the
pre-AE-F2b single-request API, and its test says so rather than pretending otherwise.

**Counters and status.** `in_flight_saturated`, `revision_superseded`, `lead_depth_reduced`,
`lead_depth_restored` joined the AE-F2 set, and `status_payload` grows an `aeProgram` block carrying the
counters **plus the depth in force, the configured depth and the ring capacity** - counters alone cannot
say a pipeline has settled a step shallow, which is the state `PL4` has to see. The block is absent with
no AE source, so non-AE status keeps its shape.

**Verified:** 108 lib tests and 25 in `tests/ae_program_ingress.rs`, including a 100-tick sweep proving
each frame is asked for once and exactly `depth - 1` ticks early with zero spurious saturation, and one
test that runs the real clock for 200 ms. Full engine suite green. **Not proven:** no live After Effects
run has exercised the deep lead - that is `AE-F3`'s soak - and nothing calls
`note_ae_program_backpressure` from the ring consumer yet, so the back-pressure branch is engine-side
only until `AE-F3` joins the adapter's refused-publish report to it.

### 2026-08-18 - AE-F3's soak was attempted and refused: the frame path is ~21 fps, not 29.97

**The gate cannot pass, and the reason is arithmetic rather than tuning.** Measured on licensed AE 26.3
with `tools/certification/ae-runtime-fixtures/ae-frame-path-probe.mjs`
(`certification/AE-F3-frame-path-probe.json`, `AE-F3-ring-backpressure-probe.json`): a 1920x1080
`LOWER_THIRD` checkout round-trips at **p50 46.5 ms** (p95 50.2, p99 64.3, max 79.3 over 300 frames),
which is **~21 fps steady state, 0.70x of 29.97**. Ring mode is worse - **p50 81.7 ms, ~12 fps, 0.41x** -
because the publish swizzles and checksums 8.29 MB. Two of 300 frames exceeded a 5 s deadline.

**The 46 ms is dispatch cadence, not rendering, and that is the whole finding.** An *unknown verb* - no
render, no pixels, no file - measured p50 46.7 ms, indistinguishable from a full checkout. The adapter
services **one command per idle callback** and AE's callback sets that period, so the ceiling is ~21 Hz
whatever the command does. AE's own render is fast: `renderMs` reported 0 every time because it is a
`GetTickCount` delta and the render fits inside one 15.6 ms tick. **Do not try to fix this with a deeper
`AE-F2b` lead** - pipelining hides latency, and this is throughput.

**Nothing forwards a frame request to After Effects.** `request_ae_program_frames` is called by the clock
and by tests, and the result is discarded. The only trigger is the **legacy file command channel**
(`send.sh checkout ... ring ...`); the runtime protocol has no render operation, so `RENDER_READY` and
`RENDER_FAILED` are events no request can cause. Rule 268 again: the producer trigger is a test harness.

**The checkout verb writes every frame to disk before publishing, unconditionally.** 8,294,400 bytes per
frame - 2.5 GB accumulated in 24 seconds of probing, and **447 GB** for 30 minutes at 29.97. The payload
file and the alpha statistics exist for `AE-F0`/`BO0a` one-shot comparison and must be opt-in before any
soak.

**One thing the probe proved rather than assumed.** With a real producer and no consumer, the four-slot
ring **published exactly 4 frames and then refused every later publish as back-pressure** - no overwrite,
no corruption, no mapping growth. That is `AE-F1`'s bounded-ring claim, observed live for the first time.

**Blocked beyond this, and not by this track.** `PL3`, `PL4`, `AE-CD3`, `AE-CD4` are unstarted, and
criterion 15 needs a licensed third-party plugin that is still unprovisioned - so four of the six §38
criteria in AE-F3's Work cannot be exercised regardless of throughput. Two probe bugs worth remembering:
the driver initially omitted the `checkout` verb, and **the adapter answers `ok:true` with a `reason` for
an unknown verb**, so a harness that trusts `ok` measures the cost of being misunderstood - it looked
like a plausible 46 ms frame path.

### 2026-08-18 - the adapter's dispatch ceiling was two bugs; lifting it 8x exposed a host freeze

**Two independent limits, and the second was invisible.** The pipe reader enqueued a request and then
**waited for that request's completion before reading the next frame**, so only one operation could ever
be in flight; and the idle hook serviced exactly one queued request per callback. Either alone caps the
protocol at one operation per AE callback, which is the ~21 Hz AE-F3 measured.

**The callback period is now a measured fact.** `HEALTH` carries `idleTicks`, `idleElapsedMicros`,
`idleMaxGapMicros` and the batch bounds, from `QueryPerformanceCounter` - `GetTickCount`'s 15.6 ms tick
is coarser than a frame budget, which is exactly why `renderMs` always reported 0. Mean period: **46.9
ms**, stable across every run and unmoved by asking AE for a shorter `max_sleep`, so the sleep hint is
not the lever - batching is.

**Measured, licensed host** (`certification/AE-F3-dispatch-serial.json`, `-batched.json`): depth 1 =
**21.3 ops/s** (reproducing the frame path's 21 fps exactly, which is the cross-check that its ceiling
was dispatch), depth 4 = 85.3, depth 8 = **170.6**, depth 16 = 170.7 with p50 doubled to 93 ms. Flat
throughput with doubled latency is the proof that the per-callback bound is now the binding constraint.

**The freeze this caused, and the rule it produces: one thread owns pipe I/O.** Writing a reply from the
idle hook while the reader sat in a blocking `ReadFile` froze After Effects for **900 seconds** - the
handle is *synchronous*, and Windows serialises I/O on a synchronous file object, so the write queued
behind a read that could only finish once the client got that reply. `idleMaxGapMicros` recorded
899,992,220. What attributed it was the new `pipeAccepted`/`pipeServiced`/`pipePending` counters: they
showed the request accepted **and serviced**, so the loss was the write, not the work - a guess would
have gone hunting in the batch loop. `write_serialized` now queues, the connection thread flushes, and it
polls with `PeekNamedPipe` instead of parking in a read. **This also removed a latent freeze older than
this phase:** `emit_event` (`RENDER_READY`/`RENDER_FAILED`) already wrote from the idle hook and would
deadlock the same way whenever the reader was idle in a read.

**Regression-checked live**, because rewriting pipe I/O touches every operation: the lifecycle refusals,
discovery (`LIST_COMPOSITIONS`/`LIST_LAYERS`/`LIST_PROPERTIES`, `100 -> 83` write with an out-of-range
refusal) and the AE-CD2 revision harness (`71/62` applied together, bad member refused, both restored)
all behave exactly as their recorded evidence says.

**What 8x does not buy.** It lifts *dispatch*, proven with `HEALTH`, not frames. A 1080p render is ~15 ms
against a 24 ms budget, so one or two renders fit per 46.9 ms callback (~21-42 fps); 59.94 needs about
three, i.e. a ~45 ms budget against a 46.9 ms callback - near a full duty cycle on AE's own thread, and
whether that is acceptable is still unmeasured. Measuring it needs the protocol render request, because
the legacy file channel carries one command at a time and cannot pipeline. Still owed with it: payload
write and alpha statistics opt-in, and a ring consumer that drains slots.

### 2026-08-18 - RENDER_FRAME lands: the frame path is 63.6 fps at 1080p, 3x what it was

**The missing request now exists.** `RENDER_FRAME` is on the runtime protocol at major 2, so
`RENDER_READY`/`RENDER_FAILED` answer a request instead of being events nothing could cause. It takes a
**stable composition item id** (an index moves on reorder, names repeat across the corpus), an **exact
rational instant** validated against that composition's own frame duration - off-frame refuses
`TIME_NOT_REPRESENTABLE`, cross-multiplied so `800/23976` and `100/2997` are one instant - and it writes
**no payload file and no alpha statistics**. It shares `do_checkout`'s proven body through one
`write_payload` parameter and an `id:` selector rather than duplicating 140 lines of render setup.

**Measured, licensed host, 1920x1080** (`certification/AE-F3-render-frame-depth{1,4,8}.json`):
depth 1 = **21.3 fps (0.71x of 29.97)**, depth 4 = **63.6 fps (2.12x of 29.97, 1.06x of 59.94)**,
depth 8 = same throughput with p50 doubled to 130 ms. **300 of 300 frames published at every depth, zero
back-pressure.** Depth 4 is the knee, one more than AE-F2b's ring-capacity bound of three, so that is the
pipeline depth to use.

**The per-frame render cost is finally visible: ~8 ms.** 2.94 frames per 46.9 ms callback. The adapter
could never report it - `renderMs` is a `GetTickCount` delta and 8 ms rounds to 0 on a 15.6 ms tick. So
the **24 ms callback budget is now the limiter**, not After Effects: three renders fill it.
`GRAPIX_AE_IDLE_BUDGET_MS` is the lever; ~45 ms would buy ~110 fps at the cost of a near-full duty cycle
on AE's own thread, and that trade has not been measured.

**Payload opt-out, verified by side effect rather than by reading the code:** 900 `RENDER_FRAME` renders
left the state directory at **864 KB**; 24 seconds of the legacy `checkout` path wrote **2.5 GB**.

**Measure a consumer in release or you measure the compiler.** A debug build of `ae-ring-drain` published
only 33 of 300 frames because verifying an 8.29 MB FNV checksum per frame unoptimised costs more than the
render itself. The release build drained 300 of 300. Also: the drain must **wait** for the mapping, which
the adapter creates lazily on its first publish - a consumer that exits instead makes the producer look
like it back-pressures for no reason. And a consumer *killed* rather than stopped strands its owner claim
on the mapping until the session ends: the single-consumer guard working, but confusing if unexpected.

**What this does not unblock.** `AE-F3`'s gate is still blocked by `PL3`, `PL4`, `AE-CD3`, `AE-CD4` and
the unprovisioned licensed plugin, and **nothing yet joins the engine's `request_ae_program_frames` to
`RENDER_FRAME`** - the probe is a harness, not the production requester. A 29.97 soak is now
arithmetically possible (2.12x); 59.94 has no headroom (1.06x) at this default budget - the next entry
sweeps the budget, lifts 59.94 to 1.41x, and corrects the ~8 ms per-frame figure above to ~11.3 ms.

### 2026-08-18 - the idle-budget sweep: 59.94 gains headroom, then the render itself is the wall

Swept `GRAPIX_AE_IDLE_BUDGET_MS` / `GRAPIX_AE_IDLE_MAX_OPS` on licensed AE 26.3, 1920x1080, every frame
published and drained. Env rather than compile-time on purpose: the adapter hash stayed `b5e6c79c...`
across the whole series, so the points are comparable.

| Budget / max ops | Frames per callback | Callback period | fps | x29.97 | x59.94 | p50 |
| --- | --- | --- | --- | --- | --- | --- |
| 24 ms / 8 (default) | 2.94 | 46.9 ms | 63.6 | 2.12x | 1.06x | 57.5 ms |
| **45 ms / 16** | **5.02** | **59.6 ms** | **84.6** | **2.82x** | **1.41x** | 81 ms |
| 200 ms / 32 | 20.0 | 226.6 ms | 88.6 | 2.96x | 1.48x | 184-357 ms |

**The mechanism, which corrects an earlier number of mine.** Callback period behaves as
`max(AE's own ~47 ms idle cadence, batch x per-frame cost)`. Under the floor, batching is free - it
recovers sleep. Over it, the batch *becomes* the clock and throughput converges on `1 / per-frame cost`.
So the per-frame cost is **~11.3 ms**, from the marginal slope `(226.6 - 59.6) / (20.0 - 5.02)` - **not
the ~8 ms I inferred last entry**, which divided by a period that still contained AE's idle floor. Hard
ceiling on this host: **~88 fps**.

**Operating point: 45 ms / 16, client depth 8** - 84.6 fps, 95% of the asymptote, 59.6 ms period. The
200 ms point buys the last 5% for a 3.8x worse period. AE reports `Responding=True` under sustained load
there, but that flag only proves no hang: a 226 ms callback occupancy stutters any UI interaction to
~4 Hz. **Not adopted as the default** (still 24 ms / 8) because editing the adapter bumps its hash and
invalidates the `adapterSha256` in every `AE-F` evidence file; that is a deliberate change for whichever
phase re-certifies next, with this measurement as the justification.

**Two consequences.** 59.94 with real headroom is **not reachable by tuning** - 11.3 ms against a 16.68 ms
period is 1.48x and that is arithmetic, so it needs a cheaper frame or parallel AE instances. And at
84.6 fps the **four-slot ring became the next constraint**: 31 of 1200 frames back-pressured (2.6%), since
four slots is 47 ms of buffer at that rate and the drain polls at 500 us. Evidence:
`certification/AE-F3-budget-45ms.json`.

### 2026-08-18 - 45 ms / 16 adopted as the adapter default, re-certified, and a damaged fixture found

`kDefaultIdleServiceBudgetMicros` = 45'000, `kDefaultMaxRequestsPerIdleCallback` = 16, with the sweep
table written into the source as the justification. New adapter hash **`a24f2b1b...`** (was `b5e6c79c`).
Both stay env-overridable.

**The default landed, proven from `HEALTH` rather than assumed:** `idleBudgetMicros: 45000`,
`idleMaxOpsPerCallback: 16`, with no environment override present.

**Behaviour-neutral except for throughput.** Re-run live on the certified binary: declared surface
(`setTime` quantised -> `TIME_NOT_REPRESENTABLE`, `800/23976` exact, negative -> `INVALID_PAYLOAD`,
footage -> `OPERATION_UNSUPPORTED`), revision (rev 1, 71/62 applied together, bad member refused, both
restored), discovery (write accepted, bad payload refused, restored), **edge corpus 7/7 with
`premul diff=0`**, and throughput **83.98 fps / 1.40x of 59.94** - within 0.7% of the env-override point,
so adoption cost nothing. `AE-A3-declared-surface.json` and `AE-CD2-revision.json` regenerated from the
certified binary; `AE-F3-recert-default.json` added.

**The `LOWER_THIRD` fixture is damaged, and that is now the blocker.** `compare-lower-third.mjs` refused on
`fixture digest mismatch`: the pinned `.aep` drifted `903406290b...` -> `5415da2500...` during this
session, and **no pristine copy exists on disk or in git - the fixtures directory is untracked**. Re-pinning
the current bytes was tried and **reverted**, because frame 0 then differs from its recorded reference by
**221,745 pixels at max channel delta 255** against a zero tolerance. The cause is in our own evidence: the
live `SCORE` control reads **100** where the authored baseline recorded **042**, so control values were
persisted away from the authored state. The only writer is the adapter's `fixture` verb through
`AEGP_SaveProjectToPath` - `supervise.sh quit` never saves, and `ae-window.ps1` sends only `WM_CLOSE`,
which on a save prompt means Cancel. Repair = re-author the fixture **and** re-record its baseline
reference frame; that is a separate decision. Drifted file kept at `.tmp-fixture-backup/`. Still passing
meanwhile: composition clock `800/23976`, `PLAYER_NAME`, `SCORE`, `TEAM_COLOR`, dependency live-report -
three of four controls, the standing `BO0a` status.

**A harness bug fixed on the way.** The cue-map check compared `JSON.stringify(resolvedCues)` to the pinned
array, making key *order* a contract: the resolver emits `compositionTime` last, the pin carries it third,
every value identical, `cueMap.digest` matching exactly. It now compares a recursively key-sorted canonical
form.

### 2026-08-18 - acceptance pass on the shipped build, and the fixture-mutation suspect narrowed

Ran the harness sequence against the installed `a24f2b1b` adapter after the full application build
(both desktop installers, engine release, sidecars hashing `c06bc9f0` in both bundles; the packaged
Editor launches, supervises the engine and opens 4400).

| Harness | Result |
| --- | --- |
| `runtime-lifecycle-smoke` | `idleBudgetMicros` 45000, `idleMaxOpsPerCallback` 16, resident on driver 126.3, `CLOSE_PROJECT` -> `OPERATION_UNSUPPORTED` |
| `ae-render-frame-probe`, depth 1 | 21.32 fps (0.71x of 29.97) - the serial ceiling, reproduced a fourth time |
| `ae-render-frame-probe`, depth 8 | **88.70 fps, 2.96x of 29.97, 1.48x of 59.94**, 300/300 published, zero back-pressure, 300 `RENDER_READY`, `payloadWritten: false` |
| `runtime-declared-surface-smoke` | quantised -> `TIME_NOT_REPRESENTABLE`, `800/23976` exact, zero accepted, negative -> `INVALID_PAYLOAD`, footage -> `OPERATION_UNSUPPORTED`, batch -> `INVALID_PAYLOAD`, 4 effects |
| `runtime-revision-smoke` | revision 1, two targets `[71, 62]`, `rolledBack: false`, bad member -> `INVALID_PAYLOAD`, bad target -> `TARGET_NOT_FOUND`, restored `[100, 100]` |
| `runtime-discovery-smoke` | `LOWER_THIRD` itemId 1, 1920x1080, 100 -> 83 -> 100, bad payload -> `INVALID_PAYLOAD` |
| `run-edge-corpus.sh compare` | 7/7 `premul diff=0` |
| `run-lower-third.sh` | still blocked on the drifted fixture - unchanged |

Throughput envelope across three sessions is **84-89 fps**, converging on the ~88 fps asymptote; 88.70 is
the fastest observed and sits exactly at it.

**The fixture-mutation suspect is narrowed by measurement, not by reading.** After this entire pass - 600
`RENDER_FRAME`s, property writes, `SET_TIME`, two data revisions and two clean quits - `lower-third.aep` is
**byte-identical to the drifted backup with an unchanged mtime**. So no runtime path persists to disk, and
the only remaining writer is the `fixture` authoring verb through `AEGP_SaveProjectToPath`, as the code
says. Do not re-suspect the property or render paths.

### 2026-08-18 - the engine asks: request_ae_program_frames reaches RENDER_FRAME

`services/render-engine/src/ae_runtime_client.rs` is the request half the frame path never had. `AE-F2b`
computed which frames Program needed, `program.rs` logged the answer, and the only thing that ever asked
After Effects to render was a harness on the legacy file channel.

**Shape.** Named-pipe client for `\\.\pipe\grapix-ae-runtime-<session>` with the `hello` handshake, and
one I/O thread that **pipelines** - written as they arrive, replies matched by `requestId` after.
Serialising would have returned the entire dispatch fix (21.3 vs 88.7 fps). `submit` is a channel send
(a request that waits for AE has already missed its deadline), and the thread never touches the engine
mutex - back-pressure returns as `feedback` the clock drains on a tick it already holds the lock for, so
`AE-F2b`'s lead-depth policy still decides.

**Wired at the source.** `Engine::send_ae_program_requests` is the single point where a scheduled frame
becomes wire traffic, so the lead window, single frames **and** revision re-requests are all carried.

**Proven live.** The `AE-F2a` gate no longer has its frame pushed in from outside: it connects the
engine's own requester, asks for frame 1, and one real AE render reaches `RecordingSink` byte-identically
at 1920x1080x4 with `ready_before_deadline: 1`.

**Two faults only the live run could find.**
1. **`DUPLICATE_REQUEST`** - an idempotency key of `frame-<n>-rev-<r>` looks right and is wrong: the
   adapter remembers accepted keys for the whole AE session, so a *restarted engine* asking for frame 1
   is deduplicated and never rendered. Keys are now scoped by a per-run id; at-most-once within a run is
   still the schedule's job.
2. **`INVALID_PAYLOAD`** - the adapter's parsers are asymmetric: `frameId` via
   `runtime_payload_integer` (bare), `presentationDeadlineNanos` via `runtime_payload_string` (quoted).
   Quoting both, which looks more consistent, is refused.

**One assertion the wiring corrected.** The gate asserted punctuality with *one* frame period of lead,
which is impossible once the engine really waits for AE: the idle callback's period is ~46.9 ms against
33.4 ms at 29.97. It now asks four periods ahead - `AE-F3`'s measured knee - and is punctual.

**Verification.** 10 unit tests plus 7 integration tests against a real named-pipe server standing where
the adapter would, and the live gate. Engine lib 108 -> 118 tests.

**Not done: who installs it in production.** The live gate and the drain bin construct the requester;
nothing in a running engine does, because attaching a container is `PL3`'s `LOAD` verb and `PL3` is
unstarted. The mechanism exists and is proven; the container lifecycle around it was not invented here.

### 2026-08-18 - PL3's LOAD verb: a running engine attaches the AE frame path itself

`ae.container.load` / `ae.container.unload` are on the engine protocol. The requester existed and nothing
in a running engine installed it - only the live gate and the drain bin did, which is a mechanism with no
owner.

**The verb performs the only sequence the adapter permits:** install ingress with the negotiated geometry
and the composition's own clock; connect the requester; ask for **one warm-up frame** (the ring mapping is
created lazily on first publish, so there is nothing to open until a frame is requested); then open that
mapping as the frame source under a deadline. **Success means attached *and proven*, not configured**, and
any failure detaches everything first - a Program that thinks it has an AE source and never asks is the
fault the whole track exists to remove.

**Authority.** Playout-only on the role matrix (attaching a container is operations, never authoring; the
Editor link holds no token). Classified `OutputManage` in `permission_for_request` - it decides where
Program's pixels may come from, not what goes on air. The engine's unclassified-verb guard refused the
verb until it was classified, which is that guard doing its job. The session token arrives in the payload
because Playout launched the host, and is never echoed into the ack, audit or logs (asserted).

**Proven live.** One request: `ringSlots: 4` (exists only because the warm-up frame really published),
`stride: 7680`, then `render_program_frame` delivered a real 1920x1080x4 AE frame to `RecordingSink`, and
unload released the pipe and ring consumer. Nothing in that test wires anything by hand.

**Verification.** 5 new tests (parse/group - including that the addition did not displace
`output.configure` in the parse table, which it did once; Playout-only authority; payload contract
including a clock that cannot carry the Program rate; a failed load leaving nothing attached; an honest
unload) plus the live gate. `ae_program_ingress` 26 -> 30, 2 ignored live.

**Live gates must run serially** (`--test-threads=1`): each claims the ring's single consumer slot.

**What PL3 still owes.** The `LOAD` half only. The verb state machine - `CUE`, `TAKE`, `CONTINUE`,
`CLEAR`, Preview/Program isolation, the rundown, and the discriminated AE-container record in Playout's
target model with digests, revisions and audit identity - is not started, and Playout does not yet *call*
this verb: its controller has no AE-container target, so today's caller is a test.

### 2026-08-19 - the AE Controls panel was dead in a packaged Editor: no allowlisted project root

The panel showed `GRAPIX_AE_PROJECT_ROOTS must name at least one allowlisted project root` and no
containers. **The allowlist was right; the packaged app never configured it.** An AE container may only
reference a project under an allowlisted root - `resolveAeProjectUri` refuses an absolute path, a `..`
segment, a backslash and anything outside the list, which is what stops a client naming
`C:\Windows\...` as a "project". The list has no default, so `listAeRuntimeContainers` threw
`AE_PROJECT_ROOT_NOT_CONFIGURED` and the panel could not even list.

**Fix.** `apply_shared_env` in the Editor's desktop supervisor now provisions one root - `<data_root>/
ae-projects`, inside the per-user AppData tree that is already writable - and only when the operator has
not set the variable themselves. Deliberately not the user profile or a drive: widening an allowlist to
make a panel populate would trade the control away for a cosmetic fix. The refusal message now names the
remedy (what to set, and that a restart is needed) rather than only the variable, because the panel
renders that string verbatim.

**Verified.** 123 api-server tests including two new ones: an allowlisted root with no containers lists
`[]` with 200 rather than refusing (the state a packaged Editor now starts in), and an unset root still
refuses `AE_PROJECT_ROOT_NOT_CONFIGURED` with an actionable message. Rebuilt the Editor with installers,
relaunched, and `C:\Users\CG\AppData\Roaming\com.grapix.editor\ae-projects` was created by the supervisor.

**Still open, and it is a real gap:** there is **no UI to add a project root**. A user whose `.aep` lives
elsewhere must set `GRAPIX_AE_PROJECT_ROOTS` or copy the project under the provisioned root, so the panel
is alive but the feature is not reachable for an arbitrary project. That is a preference surface nobody
has built.

**Two operational notes.** Force-killing `app.exe` orphans its sidecars - the supervisor's own shutdown
takes them down, a `Stop-Process` on the parent does not. And a running sidecar blocks
`tauri build`: `tauri-build` does `fs::remove_file` on each staged binary, which fails with
`PermissionDenied` on a running exe even though a *rename* of the same file succeeds.

### 2026-08-18 - AE-F2a's live gate passes: one real frame reaches Program

**Install, finally.** The `.aex` was installed into AE 2026 through an administrator prompt and its
SHA-256 now matches the built artifact exactly. One host quirk cost time: git-bash `if exist` on the AE
path lied (`AfterFX=missing`, `adapter=missing`) while PowerShell `Test-Path` and `Get-FileHash` told the
truth. On this machine, verify Adobe file paths with PowerShell, not bash.

**The README was wrong twice.** The live gate exposed two runbook defects by execution: `checkout … ring`
requires all three optional render arguments, and the composition selector is an index, not a name. The
working command is `checkout 0 1 8 premul-black argb ring <requestId> <revision> <frameId> <deadline>`.
A runbook that has never been run is a draft, not a procedure.

**The real missing piece was the live ring consumer.** `AE-F1` proved the ring and `AE-F2a` proved the
Program seam, but `AeProgramFrameSource` had only a scripted test implementation. The first live attempt
refused `FRAME_RING_INVALID_CONFIGURATION` because the adapter requires the managed runtime session
environment, and even after that was fixed the engine had no production implementation to open
`Local\GrapiX-AeFrameRing-v1-<session>`. `services/render-engine/src/ae_ring_source.rs` is that
implementation: it mirrors the C++ wire layout, claims the consumer owner id, checks generation,
revision, checksum and geometry, returns the lease on every path, and never calls an Adobe SDK.

**C4 is still true, and now measured on the live fixture.** Odd and even consecutive `BGRA` checkouts of
one unchanged frame returned different SHA-256 hashes (`FBEAF731...`, `8121A2AD...`) and the bad parity
sample showed the colour-above-alpha profile that premultiplied black forbids. The stable `ARGB` request
reproduced `8121A2AD...` exactly. Request `argb`; swizzle locally; never trust a requested non-native
order.

**The live descriptor used `sRGB`, not `srgb`.** The engine's egress originally demanded exact `srgb`,
which made the first true descriptor fail at the last boundary. Egress now accepts `sRGB`/`srgb`
case-insensitively; the adapter still publishes `sRGB`, and the live session negotiates that exact text.

**Verified live.** Managed fingerprint `faultInjection: null`; `LOWER_THIRD` frame 1 evaluated at
`800/23976`; ring publish `published`; the opt-in integration test
`live_ae_ring_frame_reaches_recording_sink_byte_identically` passed against the managed host and a
running `RecordingSink`. Evidence: `ae-plugin/runtime-adapter/certification/AE-F2a-live-frame.json`.
Full engine suite is 350 passed, 1 ignored (the opt-in live test).

**What this does not prove.** It does not prove NDI or hardware output, and it does not make the live
test part of the normal suite — it stays ignored because it needs a managed AE runtime. AE-F2b still
owns lead-time pipelining, backpressure policy and the operational counter surface.


### 2026-08-18 - AE-A3 control safety executes on keyed, expression and footage cases

**The declared-control refusal slice is now live evidence, not an inferred policy.** A fixture-only
command added one opacity keyframe and enabled a no-op `value` expression on rotation. Production
`READ_PROPERTY_METADATA` then reported `keyframed` and `expression-enabled` respectively, with
`writable:false`, `timeVarying:true`, `surface:"aegp-sdk"` and canonical structural fingerprints.
Attempted `SET_PROPERTY` calls on both streams refused `PROPERTY_READ_ONLY`; exact before/after reads
were unchanged. An inbound `REPLACE_FOOTAGE` request refused `OPERATION_UNSUPPORTED`, and
`LIST_EFFECTS` inventoried the fixture's native Fill effect. Evidence:
`ae-plugin/runtime-adapter/certification/AE-A3-declared-surface.json`.

The checked-in `lower-third.aep` already contained unrelated uncommitted content and was not touched.
The run authored a clean equivalent into ignored `.tmp-ae-a3/lower-third-clean.aep`, exercised
`042 -> 137`, `MAYA RIVERA -> GRAPIX LIVE`, `#0557FF -> #1E90FF`, restored those values, then discarded
the unsafe keyframe/expression session on clean quit. The adapter's documented build script compiled
and linked the fixture probes against the pinned SDK; the live harness itself failed closed unless both
unsafe writes and the footage request returned their exact refusal codes.

**Scope stays honest.** This closes AE-A3's declared property safety/refusal gap, not the whole card:
the licensed host still disproves safe `OPEN_PROJECT` lifecycle with `LIFECYCLE_SILENT`; actual footage
replacement remains AE-CD3, expression-control authoring remains AE-CD4, and the fingerprint-keyed
capability matrix remains AE-A4.

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
93. **The MCP server's Streamable HTTP transport is session-based, one `McpServer` per client,
    keyed by `mcp-session-id`.** It shipped "stateless": one shared server, a fresh transport per
    request, and `server.connect()` called every time — so a client's *second* call died with
    "Already connected to a transport". stdio hid it completely, because there one process is one
    server, which is why 34 passing tests and a live stdio run said nothing was wrong; every
    HTTP client (Cursor, a remote Codex, anything attaching to a running server) broke right
    after the handshake. Do not "simplify" it back to a shared server, and do not test it with a
    single call — `tests/http-transport.test.mjs` makes several calls per session and opens two
    concurrent sessions because only that shape fails against the bug. The ingested corpus and
    the project client are shared across sessions on purpose, so a new session does not re-read
    the repository.
94. **`@grapix/editor-mcp` is the one publishable package, and two things about it must not be
    "tidied".** (a) `@grapix/shared-types` is a **devDependency**, inlined into
    `bundle/grapix-editor-mcp.mjs` by `scripts/bundle.mjs`. Moving it back to `dependencies`
    makes `npm install` fail for every external user, because that version exists on no
    registry. The MCP SDK and zod stay external on purpose: a protocol fix should arrive by
    `npm install`, not by republishing GrapiX. (b) The entry guard compares `realpathSync` of
    `process.argv[1]` and `import.meta.url`, because npm installs a `bin` as a **symlink** on
    macOS and Linux — a string comparison makes `npx`/global runs start nothing at all, with no
    output and exit 0, which is the worst way for a CLI to fail. The published tarball is four
    files and deliberately contains no `docs/`, no `memory.md` and no `dist/`; the knowledge
    corpus is read from a checkout (rule 92), so the server exits 2 with instructions when it
    cannot find one rather than serving an empty one.
95. **The Editor was write-only against its own project service until 2026-08-01.** It had
    `saveSceneToApi` and `listScenesFromApi` but no function that read a scene document back:
    `GET /api/scenes/:id` existed in `project-api` for as long as the route existed and the UI
    never called it, there was no File > Open, and the editor booted from `createEmptyScene()`
    into a localStorage template catalogue. So any scene authored outside a running window — by
    the MCP server, another agent, or a previous session — was invisible, and the reported
    symptom ("I can't see the new scene in the exe") had no cache to clear because no code path
    existed. `readSceneFromApi` + `File > Open Scene…` is that path. Do not reintroduce a
    save-only client: a design that can write state it cannot read back is how two sources of
    truth start.
96. **A scene opened from the service keeps its server id.** `sceneToTemplateScene` assigns a
    fresh numeric catalogue id (`004`) and is for a *design import*, whose scene has no server
    identity yet. Using it for an opened scene renames `scene_4e51e528` to `004`, so the next
    Save posts a **different** id — creating a second scene and silently leaving the original
    untouched while the author believes they are editing it. `serverSceneToTemplateScene` keeps
    the id, and `openServerScene` replaces an existing catalogue entry for the same `sceneId`
    rather than adding a second card pointing at one scene. `tests/open-server-scene.test.ts`
    pins both halves, including that the import wrapper still renumbers.
97. **`tauri build` deletes `target/<profile>/<sidecar>.exe` before staging it**
    (`tauri-build/src/lib.rs`, `copy_binaries` -> `fs::remove_file(&dest).unwrap()`), so a
    **running render engine fails the desktop build** with `Os { code: 5, PermissionDenied }`
    and an unwrap panic that names the tauri source, not the file. Stop the engine before
    building the shell. Two traps found on 2026-08-01: deleting a running image reports **Access
    Denied (5)**, not a sharing violation, so probing with "can I open it for write" answers the
    wrong question and clears a file that is in fact blocked; and piping the build through
    `| tail` makes the harness report the **pipeline's** exit code, so a failed build looks like
    a success. Run it unpiped.
98. **A content-addressed store must serialize writes per target path.** One design import
    extracts the same bytes once per referencing layer (a PSD reusing a texture), and every
    copy resolves to one `asset_<checksum>` path. `persistExtractedAssets` writes them with
    `Promise.all`, so the second `rename` onto that path failed on Windows with **EPERM**
    (`MoveFileEx` -> `ERROR_ACCESS_DENIED` while the first replacement still holds the
    destination). It surfaced as "Asset X could not be embedded" and left the layer on an
    inline data URL. `atomicWriteFile` now queues per resolved path, which also lets the
    checksum short-circuit in `importAssetBuffer` see the first write. Nine of forty warnings
    on a real 93 MB PSD were this one bug.
99. **An import report describes the scene, not the source file.** Format adapters walk the
    whole document, so they reported unrenderable masks and effects for layers the
    hidden-layer filter then dropped, and for effects Photoshop had switched **off**. Twelve
    mask warnings named layers that were not in the scene. `pruneDesignImportIssues` drops
    issues whose `sourceNodeId` did not survive normalization, effect warnings are gated on
    `enabled`, and the normalizer keeps only fonts an imported text node still references.
100. **A mask whose shape is a bitmap may not be authored as a path.** The PSD bitmap-mask
    fallback used the layer's bounding box as an `add` mask with `inverted` from the mask's
    default colour - a full-bounds hide, so the layer disappeared while the report claimed the
    mask was "preserved" and `grapixObjectConverter` dropped `alphaAssetId` entirely. It now
    carries the alpha asset with `mode: "none"` (the renderer's skip condition), so the layer
    renders unmasked and the report says so. Invariant 7 is about this: a fallback may not
    silently produce different pixels.
101. **Nothing may re-fetch an asset that is already in the store.** `persistExtractedAssets`
    re-downloaded the source document from `PUBLIC_ASSET_BASE` because `assetMode: "embed"`
    plus a `sourceUrl` looked like a remote asset - a 93 MB loopback copy of a file written
    moments earlier, and a hard failure when the service does not run on 4100. That base is
    now derived from `GRAPIX_API_PORT`, and an asset served under its own id is skipped.
102. **`layerId` is a compositing layer and the FIRST render-order key; it is not a parent
    pointer.** `grapixObjectConverter` wrote the parent object's id into it while nesting was
    already expressed by `childIds` (the only thing `resolveSceneObjectHierarchy` reads), so
    every group's children landed in their own pseudo-layer sorted alphabetically against
    `"main"`. A PSD's opaque bottom layer therefore painted over every nested object in
    Preview and Program, and the Object Manager grew a fake layer per group. Imported
    objects stay on one layer; `zIndex` follows the document walk.
103. **`anchor` is an object-local pivot, applied as `T(x,y) · R · S · T(-anchor)`.** The PSD
    importer set it from `layer.referencePoint`, which is Photoshop's free-transform
    reference in **document** space. A full-frame layer with `referencePoint.y = 1080` was
    drawn one canvas height above the frame and vanished; three of the four background
    layers of a real deliverable disappeared this way. Import the pivot as `{0,0}` and keep
    the source value in `sourceData`.
104. **A Photoshop clipping mask is a mask, not metadata.** `clipping: true` means the layer
    is clipped to the alpha of the nearest unclipped layer below it in the same group. Kept
    as metadata only, a 1918x927 gradient clipped to a 727x205 text layer covered the whole
    canvas. It now becomes a mask over the base layer's **bounds** - exact for a rectangle
    or shape base, approximate for a text base, and reported either way.
105. **An importer may not author a blend mode the renderers dropped.** `mapBlendMode`
    returned `overlay` and `subtract`, which are declared in `MaterialBlendMode` and rendered
    by nothing, and let Photoshop's `vivid light` / `luminosity` fall through to `normal`
    silently. `Editor/services/project-api/src/importers/design/blendModes.ts` is now the one
    table for Photoshop, SVG/CSS and Figma names; it returns only
    `IMPLEMENTED_BLEND_MODES` values and marks approximations so the caller can report them.
106. **Never do bookkeeping writes on a read path, and always retry a Windows rename.**
    `readStoredAssetContent` rewrote the asset sidecar on every GET to stamp
    `lastAccessedAt`: opening an imported scene rewrote one JSON per asset (86) against the
    reference-index rebuild `saveScene` runs, and a single `EPERM` from `MoveFileEx` turned
    an image request into a **500** - which the editor draws as an empty white quad, and made
    every autosave fail. The stamp is throttled to a minute and best-effort, the index
    rebuild writes only changed sidecars and never fails a save, and `atomicWriteFile`
    retries `EPERM`/`EACCES`/`EBUSY` renames with backoff.
107. **Figma Desktop MCP cannot produce editable layers; only the REST API can.** The MCP
    server exposes `get_metadata` (sparse XML), `get_design_context` (generated
    React/Tailwind) and `get_screenshot` — never the native document JSON, so that route is a
    screenshot by construction. `figmaRestImporter.ts` is the editable route: it parses the
    file key and node ids out of any link flavour (`/design`, `/file`, `/proto`, `/board`,
    `/branch/<key>`, bare key, `?node-id=1-2` incl. `I1-2;3-4`), calls
    `/v1/files/{key}/nodes?ids=…&geometry=paths` plus `/v1/files/{key}/images` for `imageRef`
    fills, and reuses the `figma-json` adapter. The token (personal `figd_…` via
    `X-Figma-Token`, or OAuth bearer) is per request or `FIGMA_ACCESS_TOKEN`, and is never
    written to the project, the scene or the report. `transport: "rest"` with no token fails
    loudly instead of silently rasterizing.
108. **The web client must surface the service's own error text.** `request()` in
    `apiClient.ts` threw `API request failed with 422` and discarded the `error` body, so a
    Figma import that failed for a missing `file_content:read` scope told the operator only a
    status code. It now reads the payload first and throws `payload.error` when present.
109. **A Figma coordinate is page space; a scene dimension is not.** `boundsOfNodes`
    computed the canvas as `maxY - Math.min(0, minY)`, so a 1920x1080 frame sitting at
    y = 4875 on its Figma page imported as a **5955-high** scene with the artwork pushed off
    the origin. The selected root frame is the scene: origin `0,0`, canvas = its own
    `width`/`height`, every node `localX = node.absoluteX - root.absoluteX` at each nesting
    level. Several roots (whole-page import) use their common top-left and extent. The frame's
    page position survives as metadata only (`sourceData.pagePosition`). `rootMetadata` in the
    MCP importer also now prefers the first element that declares width **and** height,
    because a `<page>` wrapper carries neither and the fallback silently adopted the
    screenshot's scale as the canvas size.
110. **The render engine registers assets by checksum, so an importer that omits it produces
    scenes that cannot go on air.** `convertAssets` never emitted `checksum`, so *every*
    design-imported scene failed at `asset.register` with "asset … has no checksum and cannot
    be sent to the render engine". `persistExtractedAssets` now carries `checksum`/`sizeBytes`
    from the store, `convertAssets` emits them, an asset with neither checksum nor inline
    bytes is `MISSING` instead of a `READY` lie, `readSceneUnlocked` backfills checksums for
    scenes written before this (and downgrades the ones that are not in the store), and
    `ensureSceneAssets` skips acknowledged `MISSING` assets rather than refusing the whole
    scene. A `READY` asset with no checksum is still a hard failure - that is a broken
    producer, not an authoring gap.
111. **The authoring source document is provenance, not scene content.** The import pushed the
    source PSD into `scene.assets`, and Playout ships every scene asset to the engine: a
    93 MB upload per take that renders nothing, and `asset.register` timing out at 15 s
    behind it. The source now lives only in `dataContext.__designImport.sourceAssetIds`.
112. **A `RATE_LIMITED` frame was never consumed, so retry the SAME frame.** The engine's
    limiter runs before its sequence tracker (`transport.rs`), so re-sending a rate-limited
    request as a *new* message leaves a hole in the inbound sequence: the engine answered
    with `inbound sequence gap; requiring a resync` and, after a few, dropped the socket
    (1006) mid asset-sync. `EngineConnection.request` now retransmits the identical frame -
    same message id, same sequence - after the delay the engine states, up to five times.
    Sequence contiguity is the contract; backpressure is not an outage.
113. **Inserting a path anchor must not move the curve.** Only de Casteljau subdivision
    (`insertAnchorOnSegment` in `tools/bezierEditing.ts`) does that. Inserting the midpoint of two
    *vertices* — what `insertPathPoint` did for as long as "Add point" existed — puts the anchor
    off the curve and flattens the segment, so refining a shape silently redrew it. Verify a
    change here by sampling the path densely and comparing **anchor-relative**: `fitShapeToPath`
    re-origins the path and compensates through `anchor`, so a naive local-space or object-x/y
    comparison reports a large fake deviation.
114. **Handle linkage is derived from the anchor's geometry, never stored.** `BezierPath` has no
    linkage field and does not need one: `anchorKind` reads corner/smooth/broken from the handles
    themselves and `moveAnchorHandle` mirrors only when the anchor is already smooth. The previous
    "Link handles" and "Break handles" buttons were the alternative — one was a byte-identical
    duplicate of "Smooth", the other rewrote a handle from the neighbours — so do not reintroduce
    a linked flag, an argument, or a button for it.
115. **Align by bounds, never by `x`.** `x`/`y` is the *anchor's* position, so aligning it lines up
    pivots — two objects with different anchors, rotations or scales end up visibly unaligned with
    matching numbers, which is what the original "Align left" did. `objectBounds`
    (`Shared/shared-types/src/bounds.ts`) is the one definition of an object's visible edges, and it
    is in Shared because Editor/Playout agreement about an aligned graphic *is* agreement about its
    bounds — alignment only writes `x`/`y`, which both renderers already read. Bounds translate
    rigidly with position, so alignment works in deltas and never needs an inverse transform.
116. **A container's `width`/`height` is decoration.** `createGroupObject` fixes a group at 260×170
    and never tracks its children, so anything that needs a group's real extent must use
    `objectBoundsInScene`, which unions the children. Using `objectBounds` on a group aligns an
    invisible rectangle.
117. **A failed write must re-arm itself, and a transport error must name what is unreachable.**
    Every trigger in `lib/autosave.ts` is an edit — scene change, gesture boundary, window
    hidden — so before the retry, one failed `POST /api/scenes` parked the Editor on
    `Not saved` until the operator happened to change something, with the document living only
    in the window. That is the state a running Editor was found in on 2026-08-04: the last
    write the service saw was 11:02:53, the service was healthy and reachable from the webview
    for every one of the following minutes, and nothing was ever going to try again. The retry
    is a doubling 2 s→30 s backoff, deliberately not conditional on which error occurred (a
    client cannot tell a restart from a refusal), it is cleared on success, and a window
    regaining visibility retries immediately. `request()` in `apiClient.ts` also translates a
    transport rejection into `ApiUnreachableError`, because the browser's own "Failed to fetch"
    is what the save indicator ends up displaying and it names neither what nor where.
118. **The editor-web dev server writes to the *live* project service, and its first local
    template is `001`.** `apiBaseUrl` is hardcoded to `http://127.0.0.1:4100`, so
    `npm run dev:web` against a running desktop app shares one data root — and a fresh browser
    origin has an empty template catalogue, which numbers its first template `001`. Autosave
    then posts it about a second after the page loads, with no operator action at all. On
    2026-08-04 that replaced a real 323-object `Domination Team` (599,814 bytes) with an 8,909
    byte empty template, and filed an `Untitled Template 1 autosave 1.json` in that scene's
    recovery ring. `POST /api/scenes/001/recover` restored it from the pre-write backup with
    only `revision` and `updatedAt` moved — which is the second lesson: the backup ring is the
    thing that saved it, so do not make `backupScene` conditional. Before pointing a dev
    editor at a live service, intercept `POST /api/scenes` in the page, or accept that it will
    overwrite whatever scene shares an id with its first template. The underlying defect —
    a local catalogue id silently claiming a server scene id, now that autosave posts it
    unprompted — is the same class as rule 96 and is **not fixed**.
119. **The Editor has no Sequencer.** `SequencerPanel.tsx` was deleted on 2026-08-04 with its
    dock panel, its Display and Animation menu entries, the template context menu's
    "To Sequencer", and `saveRundownOnApi`/`readRundownFromApi`/`fireRundownEvent`. It authored
    a running order of scene cues on a track named **Program**, with conditional **Take**
    actions and a dry run — operator vocabulary in a tool that has no Program authority, and
    the visible contradiction of the split the command surfaces enforce by omission (rule 19).
    The operator surface is Playout's Scene Manager and Take List (rule 52). What deliberately
    stayed: **scene automation**, which is authoring — a scene's own triggers, evaluated and
    returned as a plan, never executed (rule 47). `RundownDocument` and `GrapixSequenceEngine`
    also stay, and not out of sentiment: `POST /api/scenes/:id/events` builds a *synthetic*
    rundown to run scene triggers through the SDK engine, so deleting the contract would mean
    rewriting scene automation. Still present and **not** removed: `/api/rundowns`,
    `/api/rundowns/:id/events`, rundown storage, and the four editor-mcp rundown tools.
    Stopping at the panel is deliberate, not an oversight — the MCP package is published
    (rule 94) and its tools are someone else's contract. `dockStore`'s `allDockPanels` is what
    migrates a saved layout: `sanitizeStacks` keeps only panels listed there, so a stored
    `"sequencer"` is dropped on read and its stack survives on the panels that remain.
120. **Timeline keys are one list, moved by a delta.** Before 2026-08-06 the panel rendered
    property, legacy, mask and shape-path keys in four separate `flatMap` passes, each with its
    own drag handler, and three of them wrote `frameForClientX(event.clientX)` — the *absolute*
    frame under the pointer. Grabbing a diamond anywhere but its centre teleported it, and
    nothing could select two keys at once. `components/timelineModel.ts` is now the single
    definition: `createTimelineRows` and `collectTimelineKeys` build row ids through the same
    `rowIdFor*` helpers, so a marker cannot be positioned against a row id nothing generates.
    A drag records the start frames at pointer-down and applies `clampFrameDelta` — the group
    moves by one shared delta or not at all, because clamping each key on its own collapses the
    spacing the author built. One `beginHistory`/`commitHistory` pair wraps the gesture, which
    also suspends autosave for its duration (rule 117's mid-gesture rule).
121. **Do not gate a pointer drag on `hasPointerCapture`.** `setPointerCapture` throws
    `NotFoundError` when the pointer is already released — a real race between the browser
    queueing the event and React running the handler — and an escaping throw abandons the rest
    of the handler, so the gesture never records its start state and does nothing at all.
    `capturePointer` swallows it, and every gesture tracks through its own ref instead.
    Scrubbing originally checked `hasPointerCapture` in its move handler, which made a refused
    capture the difference between a playhead that follows the pointer and one that jumps once
    and sticks. The ruler's tick row is the scrub surface and the track area below it is the
    marquee surface: one element cannot be both, or every rubber-band that starts near the
    playhead yanks Program time instead of selecting.
122. **Object Manager property columns are chosen, not fixed.** Until 2026-08-06 the panel drew
    ten transform columns (Alpha, X-Pos … Z-Scale) for every object — a table nobody picked,
    wide enough to push the viewport aside, and a second editor for values the Object Inspector's
    Transform tab already owns in full. `components/objectManagerColumns.ts` is the catalogue,
    the canonical order and the support rule; `uiStore.objectManagerColumns` is the author's set
    and survives a re-dock. Columns are re-sorted into catalogue order rather than kept in click
    order, and an unknown persisted id is dropped rather than rendered as a blank stripe. The
    grid template is a CSS variable the component computes: header, object rows, mask rows and
    layer bands must agree on one template or the header stops lining up with its body.
    **Support routes through `isPropertySupported`** — the panel's private copy had already
    drifted, offering Rotate X and Rotate Y on layers and groups, which
    `resolveSceneObjectHierarchy` never reads (rule 84 again, rule 82's defect class).
    Two presentation fixes went with it: the M/K/P triplet needed a legend to decode and is now
    three labelled status dots, and mask rows no longer borrow the transform columns to print
    "F 12"/"E 3" under headings that say X and Y — a mask has opacity, feather and expansion,
    which are named in its own row.
    A ribbon on top carries the **All properties / Keyframed** toggle, mirroring the Timeline's.
    `keyframed` is a *mode*, not a preset that fills the custom set in: `resolveColumns`
    re-derives from the scene, so a column appears the moment a stopwatch is enabled and leaves
    when its last key goes — a snapshot would be right until the next edit and wrong after.
    Neither mode writes `objectManagerColumns`, so the author's own set comes back intact;
    pressing the active mode releases it, because a toggle you can enter but not leave is not a
    toggle. Ticking a column in the picker adopts what is **on screen** rather than the stored
    set — editing from the stored set would make the first tick in "All properties" appear to
    delete nine visible columns. An empty keyframed table says why rather than looking broken.
123. **Figma motion may only become a keyframe on a channel that plays.** GrapiX animates the
    numeric channels in `ANIMATABLE_PROPERTIES`; `animation.rs` samples those and nothing else.
    So of the properties a Figma timeline can carry, **only x, y, rotation, scaleX, scaleY and
    opacity can be authored**. Width, height, corner radius, fill, stroke and effects have no
    channel at all — writing them anywhere plausible is rule 82's defect at import scale, so
    they classify `unsupported`, keep their source data on the report entry, and author nothing.
    `FIGMA_MOTION_CHANNELS` in `Shared/shared-types/src/figmaMotion.ts` is that table, and its
    *absences* are the specification. Note also that shape/path morphing cannot help here:
    `pathAnimation` is preview-only (TS samples it, `animation.rs` excludes path geometry
    deliberately), so vector motion from Figma cannot reach Program either.
    Easing follows the same rule: a Figma curve is reproduced exactly — cubic beziers through
    the tangent handles `bezierEase` already solves — or it is **sampled and said to be
    sampled**. Springs are baked, bounded to 48 keys so the result stays editable rather than
    one key per frame. Substituting the nearest preset for a spring is the "fallback that
    renders different pixels" invariant 7 forbids.
    `applyFigmaMotion` returns a new scene and never mutates its input; that is what makes
    "rollback on failure" real rather than a promise to undo writes already made.
    Three things about the **Motion plugin API** specifically, learned from the published docs and
    now pinned by `Shared/shared-types/tests/figma-motion-bridge.test.mjs`: its keyframe times are
    **seconds** (`timelinePosition`, `Timeline.duration`), so the bridge converts to the manifest's
    milliseconds; `TRANSLATION_X`/`_Y`/`_XY` and `ROTATION` are **offsets from the layer's layout
    position**, carried as `valueSpace: "offset"` and resolved against every object's resting value
    read *before* any write, or a second timeline offsets from the first one's keyframes; and
    `TRANSLATION_XY`/`SCALE_XY` put **two channels on one track** as a `VECTOR`, which is what Figma
    writes when a layer is dragged — a converter that only knew the single-axis fields would drop
    the common case silently. A Motion spring is a normalized `bounce` with no published inverse of
    `physicalSpringToNormalized`, so it is kept verbatim as `normalized-spring` and sampled under one
    stated assumption; see `normalizedSpringToPhysical`.
124. **Figma states transition durations in seconds; the legacy fields state them in
    milliseconds.** `interactions[].actions[].transition.duration` is seconds (0.3 = 300 ms);
    the older per-node `transitionDuration` beside `transitionNodeID` is already milliseconds.
    Reading both the same way makes every legacy prototype import a thousand times too slow or
    too fast, which looks like a broken importer rather than a unit bug. `figmaPrototype.ts`
    handles them separately and a test pins each.
    Smart Animate is where real per-property motion comes from on the REST route: the difference
    between the two frames *is* the animation, so the layers are matched **by name path** (a bare
    name is ambiguous — two branches can each hold a "Title") and every changed property becomes
    a two-key track on the **destination** node, which is the object the scene will hold.
125. **Rebuild before running a `node --test` suite that imports from `dist/`.** The TypeScript
    packages test built output, so `npm run typecheck` passing proves nothing about what the
    tests will load — a `--noEmit` check leaves `dist/` stale and the suite exercises the
    previous build. On 2026-08-06 that reported the Figma motion wiring as broken when only the
    build was missing. `npm test -w <pkg>` runs the build first for exactly this reason; a bare
    `node --test` does not.
119. **An operator-facing failure must name the thing, the request and the remedy — or it is
    not a report.** `asset <id> returned HTTP 404` cost a session: no asset name, no scene, no
    URL, no status text, nothing to do. Throw `PlayoutOperationError` (`code`, `summary`,
    `cause`, `remedy`, `context`) from the frame that still holds the context; a route two
    frames up cannot reconstruct any of it. New failure paths in Playout go through it and
    through `refuse(...)`, which both answers the request and appends to the console log —
    an error the operator dismissed must still be readable afterwards.
120. **The console log is in memory, bounded, and never on a frame path.** 300 records, cleared
    on request, notified by sequence over the existing SSE bus. Do not persist it: the engine
    owns the audit trail, and a log file is one more thing that fills a volume on an
    unattended station. Do not record retries of one condition — the first engine-connect
    failure of a run is recorded and the backoff attempts are not, or the console fills with
    the reconnect loop and hides the error that needs reading.
121. **`EngineRegistry` records never carry `authToken` or `secure`, so never rebuild a profile
    from one.** They are reported to operator UIs, where a bearer token has no business.
    `PlayoutEngineController` retains the registered profile; rebuilding from the record is
    what made Playout unable to reach any engine requiring auth, reported only as "could not
    connect".
122. **Declare CORS `methods`.** The default preflight answer was `GET,HEAD,POST`, which blocked
    every DELETE route in the browser and surfaced as a bare "Failed to fetch". A UI-visible
    verb that is not in that list does not exist.
123. **An unauthenticated loopback engine connection is an *Editor* principal, and the `playout`
    role may not `scene.load`, `scene.prepare` or `asset.register`.** A development GrapiX
    works only because Playout connects without a credential — add a token and cue stops
    working with `UNAUTHORIZED_ROLE`. This is a live conflict in the authority model. Do not
    "fix" it by widening the capability matrix in passing; it is an architecture decision.
124. **Playout's asset upload fetches from the Editor's project service at take time.** A
    published scene is therefore only as portable as the service holding its bytes: 404 means
    the content is gone, a rejected `fetch` means the host is down, and a relative source means
    the scene was published with neither embedded bytes nor an absolute address. Keep those
    three distinct — they have three different remedies — and keep "publish with assets
    embedded" as the one that removes the dependency.
125. **Discovery is a fallback and must never overrule configuration.** `EndpointResolver` order is
    configured → remembered → loopback → discovered, and every candidate is proven by a `verify`
    that checks the peer's `/health` names itself. An explicit address is an instruction; adopting
    something that merely answered a multicast query is how a rehearsal drives the wrong machine.
    A port check is not proof — 4300 could be any vendor's control surface.
126. **A failure to open the mDNS socket is never a startup failure.** 5353 is routinely held by
    Bonjour or Avahi, a firewall profile may block multicast, and a machine may have no multicast
    interface. `MdnsSocket.open` resolves false, the service runs unchanged, and the console says
    the fallback is unavailable. Nothing in `Shared/service-discovery` throws into a service's
    boot path.
127. **Multicast loopback stays on, and loopback interfaces are joined.** The case this exists for
    is two GrapiX applications on *one machine*. Turning either off would make the most common
    deployment the one discovery cannot serve.
128. **A goodbye must be flushed before the socket closes.** `send` returns a promise for exactly
    this reason: closing in the same turn discards the datagram, and a peer then offers an
    operator a service that has already stopped for the full 120-second TTL. On Windows a
    `TerminateProcess` bypasses the handler anyway — the short TTL is the backstop, which is why
    it is 120 seconds and not RFC 6763's suggested 4500 for PTR.
129. **Fastify refuses `addHook` after `listen`.** Register `onClose` inside the server factory. An
    `addHook` after `listen` in `startApiServer` crashed the Editor service on boot.
130. **A browser cannot speak mDNS.** There is no multicast API in a page, so a web UI asks its own
    local service where a peer is (`GET /api/discovery/playout`). Never add a second, weaker
    discovery path written against what a page can reach, and never import
    `@grapix/service-discovery` into UI code — its tsconfig drops `DOM` from `lib` so that attempt
    is a compile error rather than a run-time one.
131. **Nothing advertises the render engine.** `_grapix-engine._tcp` does not exist, so do not add a
    browse for it: a discovery path that never resolves is worse than none. The engine is reached
    through its configured address or the loopback port scan in `@grapix/render-protocol`.
132. **No design node may disappear silently.** Every Figma node becomes a native object, a generic
    container whose children are still imported, or pixels the source tool rendered. Recursion is
    driven by `children` with no depth limit and no type filter; a type table must never end in a
    bare `return "group"`. The report's counts are the proof: `nodes = native + genericContainers`
    and `nodes = surviving layers + masks`.
133. **Never invent geometry to fill a gap.** A vector whose outline Figma withheld used to get a
    rectangle of its bounds, which is indistinguishable from a real rectangle — the layer looked
    imported and was wrong. Leave the path undefined; that is what marks it for rendering through
    `/v1/images`.
134. **A clip is one composition, not a mask per descendant.** `clipResolution.ts` builds
    `Clip Composition → [<name> clip shape, <name> contents]` and puts the clip on `contents`; the
    frame's paint moves to the clip shape so it is not painted twice. It runs inside
    `normalizeDesignDocument`: after scaling, because a clip must be in the same space as what it
    cuts, and before `flattenNodes`, which drops containers — a clip that lived only as a container
    property vanishes with its container. The clip reaches drawn objects through
    `resolveSceneObjectHierarchy`, which inherits masks and re-expresses each in the receiving
    object's own space, so a rotated container's clip arrives rotated. A mask group's outline is the
    union of its subtree, never its bounding box.
135. **Figma has no `rotation` field.** Rotation is `atan2(m10, m00)` of `relativeTransform` with no
    negation (both spaces are y-down), `size` is the untransformed extent, and
    `absoluteBoundingBox` is the *axis-aligned* box around the rotated shape — using its width and
    height stretches the layer to the bounding box of its own rotation. Pivot about the centre.
136. **Report issues carry the *source* node id, node records carry ours.** `importedNodeIds` must
    collect `node.id`, `node.sourceId` and the ids of mask layers consumed into masks, or the
    pruning pass deletes the entire per-layer report and leaves only document-level lines.
137. **Every asset id that can be remapped must be remapped.** `persistExtractedAssets` rewrites ids
    when it stores bytes; `remapNodeAssets` has to cover `assetId`, `renderedAssetId`,
    `additionalImageAssetIds`, `strokeImageAssetIds` and each mask's `alphaAssetId`. A missed one
    downloads the pixels and then cannot find them. Ids belong on the node, not inside `sourceData`,
    for exactly this reason.
138. **A hidden layer is imported hidden.** The Figma route defaults `importHiddenLayers` on. A
    designer's hidden layer is an alternate take or a data-driven state; one that vanishes cannot be
    switched back on by an operator.
139. **An imported image lives in the project, at `images/<scene>/<layer>.png`.** A Figma image URL is
    signed and expires within the hour, so a scene that remembers one goes blank on its own. Every
    `imageRef` in fills *and* strokes is collected, deduplicated per document and downloaded once;
    the scene stores the project-relative path, and `scaleMode` becomes `objectFit`
    (`FILL`/`CROP` → cover, `FIT` → contain) with the full paint kept in
    `importedDesign.imagePaint`. A Figma rectangle with an image fill is an image object — importing
    it as a rect painted the fill's average colour is why photos arrived as flat blocks.
140. **A project-relative asset path is resolved in one place.** `resolveProjectAssetUrl` in
    `lib/projectAssets.ts`; a relative path otherwise resolves against the *page* origin (the dev
    server, or `tauri.localhost`) and 404s. Every consumer uses it — GPU renderer, SVG template
    preview, material panels, font registry — and `apiBaseUrl` reads `VITE_GRAPIX_API_URL` with
    `import.meta.env?.` so Node-run tests can import the module.
141. **A published scene carries its own bytes.** `inlinePublishedAssets` inlines fonts, images and
    SVGs and rewrites each image object's `src`. Playout keeps rendering after the Editor closes, so
    anything it must resolve through the Editor is a missing texture on air.
142. **Localise a source outline by its own bounds, never by the node's position.** Figma's
    `geometry=paths` outlines are in the node's unrotated local space with a foreign origin — one
    real file returned every outline near x=14590 whatever the layer's position. Subtracting the
    node's absolute position put a clip ten thousand pixels off the canvas and masked away every
    layer under it. The outline's extent equals the node's own size, so re-originating it to its
    union bounding box is exact; move all of a node's subpaths together.
143. **A mask that is wrong is worse than a mask that is missing.** One inherited clip decides
    whether a whole subtree draws, so a clip's geometry must be checked against the objects it
    clips — `figmaClipComposition.test.mjs` asserts the clip covers what it clips, which is the
    assertion a transparent canvas would have failed.
144. **A scene document is a control message; bytes go through `asset.upload`.** The engine enforces
    `security.max_message_bytes` (8 MiB) before it parses, declares a scene's assets from
    `assets[].assetId`, and never reads `source`. `withoutInlineAssetBytes` strips an inlined source
    to `asset:<id>` for the wire, and `asset.register` sends that reference as its `uri`. A published
    scene with eight inlined images was 13.06 MiB and could not be taken at all.
145. **A refusal the caller cannot correlate is not an answer.** A frame rejected before parsing was
    replied to with no `requestId`, so the caller waited out its own timeout: an operator saw
    "connection closed: reconnecting" a minute after Take instead of the limit it exceeded.
    `request_id_from_frame_head` recovers the id with a bounded scan; the client also refuses
    oversized frames up front, naming the size and the limit.
146. **Never consume a sequence number for a frame you do not send.** The receiver parks a message
    that arrives with a gap ahead of it, waiting for one that never comes, so the next real frame is
    never answered. `SequenceGenerator.release` returns the number when a send is refused.
147. **`cargo test` is not part of `npm test`.** The engine's `protocol_server` suite has been red
    since `f0dadfd` — 28 tests whose client omits the `sceneRef` the engine now requires — and
    nothing surfaced it. Run `cargo test --manifest-path services/render-engine/Cargo.toml` when
    touching the engine, and do not read a green `npm test` as covering it.
148. **A compound path is one shape, and every subpath has to be drawn.** `drawShape` read only
    `object.path` while the contract carried `compoundPaths`, so holes and extra pieces vanished — 47
    of 48 subpaths of one logo. Build a `GraphicsPath` with `checkForHoles` and hand it to
    `graphics.path()`: Pixi detects a hole only for a path added whole, never for instructions drawn
    straight into the context.
149. **Merge a closing anchor that repeats the first one.** Sources write the closing segment and then
    close, so a naive parse gains an anchor at the seam and — when that segment is a curve — attaches
    its incoming handle to the duplicate, which draws the seam of a rounded shape straight.
150. **Text case is applied when text is drawn, never baked into the characters.** Figma's `textCase`
    means a layer holding "mvp" reads MVP; importing only `characters` loses it with nothing left to
    recover from. Keep the characters as typed so a binding can replace them and the case still holds.
    `small-caps` draws as upper case and is reported per layer.
151. **Pixi's geometry runs headless.** `GraphicsPath`/`ShapePath` need no GPU, so hole detection and
    curve control points are assertable in a plain Node test —
    `shape-and-text-presentation.test.ts`. Prefer that to a screenshot for anything geometric.152. **`afterfx -r` silently ignores a script path containing a space.** Given one, After Effects
    starts, runs nothing and exits 0 — indistinguishable from a script that did nothing, and it
    cost two 7-minute debugging cycles before the cause was found. The AE bridge therefore stages
    its bootstrap *and a copy of the exporter* in a space-free directory
    (`scriptStagingRoot()` in `Editor/services/adobe-mcp-gateway/src/aeBridge.ts`) and hands only
    that path to AE. Paths inside the script are quoted string literals and may contain spaces.
    The scripting *warn* preference is not involved; file/network scripting permission is, because
    the exporter writes the manifest.
153. **Never pin an Adobe version list.** The first AE detector listed 2022–2025 and failed on the
    2026 install on this machine. Enumerate `%ProgramFiles%\Adobe\Adobe After Effects *` newest
    first, with `GRAPIX_AE_EXECUTABLE` as the override.
154. **The AE scripting DOM enums are not the SDK's PF constants, and the binary's are neither.**
    `MaskMode.SUBTRACT` is 6814 in ExtendScript and `PF_MaskMode` subtract is 2;
    `ParagraphJustification` runs LEFT 7413, RIGHT 7414, **CENTER 7415**, full-justify 7416 up.
    Both were wrong in the first exporter and produced a scene that imported cleanly and looked
    wrong (right-aligned titles, an add mask where subtract was authored) — and this rule itself
    carried CENTER as 7416 until the binary reader was written against the real values, which is
    how the exporter's `justificationName` was still reading centred text as left-aligned. Inside
    the `.aep` a third vocabulary applies: transfer modes are `PF_Xfer` (Normal **2**, 0 on layers
    that cannot blend), COS justification is 0-based from LEFT. Every producer resolves enums to
    the manifest's own vocabulary — the converter never sees a raw number.
155. **After Effects project import is four producers, one manifest.** AEP native (the binary
    `.aep`, parsed here, the default), AE bridge (`.aep` through an installed After Effects,
    opt-in), AEPX direct (`.aepx` XML) and collected-footage all emit `AeManifest`
    (`Shared/shared-types`); `convertAeManifestToScenes` (`Shared/adobe-common-schema/src/ae/`) is
    the single converter. One composition becomes one scene at *that composition's* frame rate —
    never a hardcoded 50. Footage is copied into `assets/after-effects/<Project>/` (sha256-deduped,
    traversal-checked); originals are never modified. Every item carries an `AECompatibility`, and
    an unsupported effect is preserved with its match name and reported as `baked` rather than
    dropped. Rendered-fallback baking is the declared, unimplemented extension point — do not
    claim it works. Never fall back between producers: they differ in coverage, so which one ran
    is the author's to know (`producer` on the manifest and in the report).
156. **Easing is one specification with two implementations and a checked-in conformance table.**
    `Shared/shared-types/src/easing.ts` and `services/render-engine/src/easing.rs` implement 36
    named easings; `Shared/animation-engine/fixtures/easing-vectors.json` (36 × 33 samples) is
    generated once by `tools/animation/generate-easing-vectors.mjs` and both suites assert
    against it to 1e-9. **Never regenerate the fixture to make a test pass** — a changed number
    is a changed curve, and every scene already authored against it then animates differently.
    Closed forms with no early exits on both sides, so the two languages do identical arithmetic.
    The implementation lives in `shared-types`, not `animation-engine` as the phase plan said,
    because `animation-engine` depends on `shared-types` and the evaluator lives there: the
    plan's path would have forked the TypeScript evaluator, which is the drift P0 removes.
157. **`ease-in` / `ease-out` / `ease-in-out` are quadratic and frozen.** They are aliases of the
    `-quad` forms. Adding an easing is additive; changing one of those three silently re-times
    every scene on disk.
158. **An unimplemented easing holds the previous value; it is never silently linear.** Both
    evaluators return "no curve" rather than substituting linear, and the sampler holds the
    outgoing key. The Editor learns through the `onAnimationDiagnostic` sink
    (`animation.unknown-easing`, with object, property, frame and the offending name); Playout
    learns because `collect_unknown_easings` merges into the prepared-scene warnings a client
    already receives — no new protocol message.
159. **A per-frame sampler must deduplicate its diagnostics.** The first version reported on every
    sample and put six copies of one fault in the console within a second; at 50 fps it would
    have flushed the 300-record buffer. Faults are reported once per object+property+value, with
    `resetAnimationDiagnostics()` for a host to clear on scene change. Any diagnostic raised from
    an evaluation path needs this.
160. **All four certification harnesses run and pass; fixing them exposed three shipped
    authority defects.** 84 checks green, twice in a row, against one engine started with both
    `GRAPIX_ENGINE_IPC` and `GRAPIX_ENGINE_TOKEN`
    (`certify:engine` 54, `certify:animation` 11, `certify:ipc` 11, `certify:parity` 8+1 skip).
    The harnesses were not merely stale - they were the first thing to actually drive the two
    authorities against one engine, and all three defects were in committed product code:
    1. **A token-secured engine refused the Editor entirely.** `auth.required` made *every*
       socket connection `authenticated_playout`, and the pre-frame gate refused any
       unauthenticated principal - so on the deployment every Playout install creates, the
       Editor could not load a stage or a scene. Fixed in `transport.rs`: the handshake now
       returns a `HandshakeGrant`, a **loopback** peer with no bearer is the Editor, a remote
       one is still refused, and a *wrong* bearer is always refused. Five tests.
    2. **Playout could not deliver a scene.** Its capability list had no `SceneLoad`,
       `SceneFullSync`, `ScenePrepare`, `SceneUnload`, `AssetRegister` or `AssetUpload` - yet
       `engineController.load` and `ensureSceneAssets` call exactly those. Playout could cue a
       scene it had no way to deliver. Granted in `capabilities.rs`; `SceneApplyPatch`,
       `StageLoad` and `EditorViewRequest` deliberately stay Editor-only. Three tests.
    3. **IPC is not a substitute for the socket.** `ipc.rs` drops binary frames on purpose, and
       the Editor's own render path (`editor.view.request`) *is* a binary frame - so "author
       over the pipe" was never an alternative to fixing (1).
    Two smaller honesty fixes came with them: `engine.getStatus` described an authoring session
    with a fabricated implicit 1920x1080 stage instead of the one loaded scene's real stage, and
    a wrong-revision address answered `SCENE_NOT_FOUND` instead of naming the revision the
    engine holds.
161. **A stopped `hub` job does not always kill the engine.** An orphaned
    `grapix-render-engine.exe` kept port 4400, the next `dev:engine` failed to bind, and a probe
    then talked to a *stale binary* and "proved" the opposite of the truth. Check
    `netstat -ano | grep 4400` before trusting an engine result.
162. **A harness must release the scenes it loads, addressed by `sceneRef`.** `scene.unload`
    with a bare `{ sceneId }` as the envelope options releases nothing - the engine addresses
    scenes by runtime `SceneRef` key. Four harnesses leaked every scene of every run until the
    engine hit its eight-scene ceiling, and the *next* harness then failed on its first
    `scene.load` with `ENGINE_BUSY`, blaming a limit rather than the leak.
163. **The engine reports scenes under the runtime key, never the plain id.**
    `13:certification|9:authoring|9:scene_e2e|1` - length-prefixed segments, ending in the
    *load* revision, which is not the content revision the same status row reports. Three
    separate checks compared `entry.sceneId === scene.id`, which is never true, so they
    asserted `undefined === 2` and passed for as long as they existed. Match on
    `:${id}|` rather than reconstructing the key.
164. **Authentication is one account system, one signing key, three roles - and the engine
    is the point of it.** A login in Editor or Playout mints the same `gx1` token the engine
    verifies, so who is allowed to take a scene to air has one answer, not one per product.
    - **Token format is not JWT.** `gx1.<b64url(payload)>.<b64url(HMAC-SHA256)>` with no
      algorithm field, so `alg:none` and RS/HS confusion are structurally absent rather than
      defended against. Specified in `Shared/auth-contract`, reimplemented in
      `services/render-engine/src/auth.rs`, proven byte-identical by a conformance fixture.
    - **The engine requires a token on every transport in production, including loopback.**
      With `auth.required`, a credential-less connection - socket *or* IPC, from any address
      including this machine - is refused; an audit trail that cannot name who cued a scene
      is not an audit trail. The tokenless loopback exemption exists only on a dev engine.
    - **Permissions are checked per command, not only at connect.** The role matrix says which
      *link* a request may arrive on; `permission_for_request` says whether *this token* may
      send it, on every frame. An unclassified verb is refused, never waved through. Admin is
      the union of both products' permissions by construction.
    - **The static bearer token is gone.** `GRAPIX_ENGINE_TOKEN` is now a minted `gx1` token
      for Playout's service account, verified against the shared `GRAPIX_ENGINE_AUTH_SECRET`;
      a wrong or expired one is refused even from loopback. Regression-tested in transport.rs.
165. **Audit is two JSON Lines sinks, fire-and-forget, and never blocks a take.**
    `Shared/auth-contract/src/auditLog.ts` queues synchronously and drains on a timer, so
    `record()` returns void and Program never waits on the disk; a full queue drops the oldest
    entries *and reports the count* rather than stalling. `audit.jsonl` is security (logins,
    refusals, permission failures, settings), `events.jsonl` is operations (loads, edits,
    patches, cues, takes, uploads). Every row carries timestamp, monotonic sequence (survives
    restart), user id, username, role, session id, device name, IP, connection id, action,
    scene id, revision, result and error. `sanitiseDetail` strips passwords, tokens and binary
    bodies by key and by type. Rotation is daily or by size, gzips the archive, deletes by
    retention, and never removes the plain copy before the compressed one is durably written.
166. **The bootstrap admin password is generated, shown once, and never stored.** An empty
    user store creates `admin` with a random password surfaced on the console at startup and
    on `app.bootstrapAdminPassword` for tests - only its scrypt hash is persisted. A shipped
    default password would be worse than no auth, because it would look secure. Tests sign in
    through the real login route via `tests/authHelpers.mjs` (`authenticatedInject`), which
    reads that one-time value from the instance.
167. **A binary `.aep` is read natively, and every offset names its evidence.**
    `Shared/adobe-common-schema/src/ae/` reads the RIFX `Egg!` container in three layers:
    `rifx.ts` (container), `aepParser.ts` (chunk semantics), `cos.ts` (the `btdk` text document,
    which is PDF-style COS). Adobe publishes nothing, so a field offset is only allowed here if it
    is verified against an After-Effects-authored fixture or agreed by two independent open
    implementations (`forticheprod/py-aep`, the Lottie Docs AEP spec) — and the comment says
    which. `tests/fixtures/aep/*.aep` come from `boltframe/aftereffects-aep-parser` (MIT) and the
    expected values are the ones its own suite asserts, so a wrong offset fails against a number
    After Effects wrote. **Never "fix" a parser test by relaxing an expected value**; it is
    ground truth from the application. Keyframes and masks appear in no fixture and are pinned by
    synthetic chunk trees — weaker evidence, and the test says so.
168. **Three traps in the `.aep` that each shipped a wrong import once.**
    (a) After Effects **omits a property still at its default** — a default layer has no
    `ADBE Position` and keeps `ADBE Position_0/1` present holding zero, so believing those zeros
    puts every untouched layer in the top-left corner instead of the frame centre; the defaults
    (position = comp centre, anchor = centre of what the layer draws) are part of reading the file.
    (b) `tdsb`'s "dimensions separated" bit is **not** the split-position signal: every property in
    an AE-authored transform group carries `0x03` there.
    (c) An **adjustment layer sets the null bit too** — test adjustment first or it imports as an
    empty group.
169. **Do not report a tool failure as the tool being missing.** `/api/import/after-effects/project`
    once mapped every `AeBridgeError` to `503 AE_NOT_AVAILABLE`, so an author with After Effects
    installed *and running* was told it was unavailable while the real fault (an export that failed
    inside it) went unnamed. `describeAeImportFailure` now separates not-installed (503
    `AE_NOT_AVAILABLE`), export-failed (422 `AE_EXPORT_FAILED`), not-a-project (422
    `AE_NOT_A_PROJECT`) and missing-path (404 `AE_PROJECT_NOT_FOUND`), and each diagnostic names
    the way out. `Editor/services/project-api/tests/ae-native-route.test.mjs` pins it.
170. **`aepxParser.ts` reads an XML shape After Effects does not write.** Its fixture and its
    reader use an invented `<Project><ItemList><Item><name>` PropertyList tree; a real `.aepx` is
    the same RIFX chunk tree serialised as 4CC elements with hex `bdata` payloads. So the `.aepx`
    path has never been exercised against a file After Effects produced, and it will find no
    compositions in one. The native `.aep` reader is the working no-After-Effects path. Fixing
    AEPX means feeding the real chunk tree into `aepParser.ts`'s semantics — not extending the
    invented shape.
171. **Editable and animatable are two questions, and `isPropertyAnimatable` answers the second.**
    `Shared/shared-types` owns it, because `preflightScenePackage` lives there and cannot import from
    `Editor/` — putting the rule in the Editor is why preflight could not see the fault for months.
    `isPropertySupported` still answers editable/bindable. Today one property is gated: `zDepth`
    is animatable **only on the mesh path**, and the mesh path is `mesh` *and* `shape`, because a
    bezier shape is tessellated into a `PreparedMesh` (`mesh_prepare.rs:740`) and is patched by
    `mesh_transforms` like a mesh. For a rect or a text, depth is paint order resolved during
    preparation, so `animation.rs` discards `AnimatedProperty::Z` (`:498-504`, `:527-530`) and never
    re-sorts — while the Editor sorted by `layerId → zDepth → zIndex` on the evaluated scene every
    frame, so the author watched an animation that did nothing on air. Every consumer routes through
    the rule: the evaluator skips the patch, `isColumnAnimatable` and `animatedColumns` gate the
    grid, and the Inspector's `AnimatedNumberField` gates itself. `fixtures/animatable-properties.json`
    is emitted from the rule and `animation.rs` asserts against it *and* proves both sides
    behaviourally in the same test, so the table can never become a second copy of the list.
    A legacy channel is a **warning** (`ANIMATION_CHANNEL_NOT_RENDERED`), never stripped and never a
    package blocker: post-fix the scene renders identically with or without those keys.
    Mesh `width`/`height`/`opacity` are the same defect and are deliberately **not** gated — the
    engine bakes object opacity into the prepared surface once, `shape` shares that path, and fading
    a vector logo is ordinary authoring, so the repair belongs in the engine. Do not "finish" this
    rule by deleting those controls.
172. **There is ONE object selection, it lives in `editorStore`, and `selectedObjectId` is its
    *active member*.** The fields are `selectedObjectIds` (document order),
    `selectedObjectId` (active; non-null exactly when the set is non-empty and **always** a member)
    and `objectSelectionAnchorId`. `selectObjects` is the only writer and normalises; `selectObject`
    is a shim. `uiStore.selectedPathObjectIds` is gone — it accumulated rather than reconciled,
    because nothing ever cleared it, so a marquee of five stayed live in the alignment toolbar after
    a single click and the "key object" was `next.at(-1)`, i.e. whichever id sorted last.
    - **Never put the selection in `uiStore`, and never prune it in an effect.** Only the store can
      prune inside the same `set` as the delete/undo that invalidated it; an effect paints one frame
      in which the toolbar counts ids that no longer exist. `selectionAfterRemoval` is that path.
    - **Every writer goes through it.** Add, duplicate, delete, pen-shape create and all four
      scene-lifecycle entry points used to assign `selectedObjectId` directly. Missing one breaks the
      invariant with no type error and no symptom until something counts a ghost;
      `tests/object-selection-store.test.ts` drives every one of those paths.
    - The gesture table is `store/objectSelection.ts` and is pure. A Shift range spans the **visible**
      rows; Ctrl+A spans the **selectable** ones (search matches, collapsed descendants included) so
      Ctrl+A then Delete cannot orphan a collapsed child. A range keeps its anchor so the next
      Shift-click re-measures from the same end.
    - Member styling and active styling are **two classes**. A single selection is a member that is
      also active, which is what keeps one selected row rendering exactly as it did before the set
      existed.
173. **A mutation that writes `set({ scene: touchScene(...) })` is not undoable — use `commitScene`.**
    `updateObject`, `moveObjectInStack`, add, duplicate, **delete**, `setPropertyAnimationEnabled`
    and `setAnimatedPropertyValue` all did, so deleting an object left nothing to undo. `commitScene`
    deposits nothing while a history transaction is open, so a continuous gesture that wraps itself
    in `beginHistory`/`commitHistory` is still exactly one step — which is why converting them was
    safe, and why any *new* continuous gesture MUST wrap itself or it deposits an entry per pointer
    move. The Object Manager's scrub opens on pointer-down; typing opens on focus and closes on blur,
    the same pattern `MaterialInspector` uses for its text fields.
174. **Do not subscribe a list to `currentFrame`.** The Object Manager did, and one playhead tick
    re-rendered every row and every cell for a scene where one property might be animated.
    `TransformCell` is memoised and split in two: a cell with no channel never subscribes, and only
    `AnimatedTransformCell` follows the frame. Where the frame is needed to *act* — a stopwatch adds
    a key at the playhead — read it at click time with `useUiStore.getState()` instead of
    subscribing. Same rule for any future row list.
175. **Vite HMR can serve a module compiled from a mid-edit state.** After a series of edits the page
    went blank with `does not provide an export named 'ObjectManager'` while the export was plainly
    there. Restarting the dev server cleared it. Restart before debugging a phantom export error.
176. **One history per document, labelled and attributed — never a stack per module.** Panels all
    edit one `SceneDocument`, so independent per-module stacks would revert each other: popping
    module A's older snapshot while module B's newer edit stands produces a document that never
    existed and silently discards B's work. `SceneHistoryEntry` is `{ scene, label?, scope? }` where
    the label describes the change the entry **reverts** and `scope` names the module that made it.
    "Module-level undo" is therefore each panel having its own control that drives the one history
    and **names the owner** — the Object Manager's button reads "Undo Timeline · Hide object" when
    that was the newest step. If a per-module stack is ever proposed again, this is the reason not to.
177. **`Ctrl+Z` is on `window`; `Delete` is not.** Undo is not destructive-in-place — it moves the
    document back one step and every surface names the step first — so it must work wherever the
    author's hands are. Delete acts on whatever the focused panel points at, so it stays panel-scoped
    (rule 4). The refusals live in `lib/historyShortcut.ts`: a **text-entry target keeps the
    browser's own text undo** (INPUT/TEXTAREA/SELECT/`contentEditable`), and an **Alt chord is not
    ours** because Ctrl+Alt+A and Ctrl+Alt+C are the assistant and the console. `Ctrl+Shift+Z` and
    `Ctrl+Y` both redo; `Meta` counts as `Ctrl` for macOS.
178. **Undo during a gesture abandons the gesture.** An open `historyTransaction` means a drag, scrub
    or pen path is in flight and uncommitted; popping the stack would take back the *previous* change
    and leave the half-finished one standing. `undo()` tests for an open transaction before touching
    the stack, and the UI keeps the button enabled while one is open because there is always
    something to cancel.
179. **Undo covers the open scene, not the project.** `templateStore` scene create/duplicate/rename/
    delete and asset/font imports are outside it: they are server-backed or content-addressed on
    disk, and a scene delete cannot be reversed without a soft-delete/trash that does not exist. Do
    not describe undo as project-wide, and do not add project operations to the scene history —
    reverting a document snapshot cannot un-delete a file.
180. **The Object Manager draws each band reversed, so screen order is the inverse of render order.**
    Visually *above* a row means **later** in the flat render order and a **greater** `zIndex`. The
    flip happens in exactly one place — `inRenderOrder` in `ObjectManager.tsx`, on the way into the
    store — and the drop resolver returns *screen* terms because the indicator renders them. Flipping
    before choosing the indicator drew the insertion line on the opposite edge: hovering the top of a
    row promised a landing at its bottom. Two flips cancel out and none is a silent inversion, so if a
    reorder ever lands backwards, count the flips first.
181. **Drag state that `dragover` reads must be a ref, not React state.** `dragover` resolves inside
    its own handler; a `dragstart` state update has not been applied yet, so the first hover reads the
    old value. That made the very first indicator fail to appear until the pointer moved again. The
    `drop` handler additionally re-reads the ids from the `DataTransfer`, which is the only source that
    survives a re-render.
182. **Hierarchy legality has one definition: `store/objectHierarchy.ts`.** `isContainerObject`,
    `isAllowedContainerChild`, `containerContains`, `collectContainerSubtreeIds`, `parentOfObject`.
    The drop resolver must refuse *while the pointer is over the target*, and the store refuses again
    at the mutation; both read these. A copy in the panel is how an indicator promises a drop the store
    rejects — and the Inspector's parent checkbox already ships the silent version of that defect: it
    offers every object as a parent and discards `setContainerChild`'s `false`.
183. **A lock check must cover the whole dragged subtree.** `setContainerChild` and
    `moveObjectToLayer` rewrite every descendant's `layerId` with no lock check of their own, so
    refusing only a locked *dragged id* would let an unlocked group carry a locked child. `resolveDrop`
    tests every member of `draggedSubtree`.
184. **A container that moves takes its subtree.** All three renderers sort `layerId` before depth, so
    a descendant left in the old band draws detached from the group that positions it.
    `moveObjectToLayer` moves `collectContainerSubtreeIds` and detaches from any parent. It had **no
    callers** while it moved one object, which is why the defect never surfaced — check for callers
    before trusting that an untested path is correct.
185. **The Object Manager has two state lifetimes, and they are not interchangeable.**
    `modules/object-manager/stores/objectManagerStore.ts` **persists** columns, column mode and
    name-column width under `grapix-object-manager-v1`; **collapse is session-scoped** — it survives a
    re-dock and not a reload. Persisting collapse means a scene-id→node-id map plus stale-entry pruning
    on every projection, for state an author rebuilds with two clicks. Reading is defensive **per
    field**: an unknown column id is dropped (it would leave a permanent blank stripe), an unknown mode
    falls back, and the width is clamped on read. One bad value must not discard the others. The column
    state was removed from `uiStore`, not mirrored — do not put it back.
186. **`normalizeLayerId` lives in `store/layerIds.ts` and is never copied.** The panel must predict
    the store's collision answer *while the author types*, and the two rules have to be the same one.
    The old `window.alert` is what a second copy looks like from the outside: the input was seeded with
    the raw slug while the band displayed Title Case, and the alert quoted the draft while the store
    compared the slug — so "Lower Third" collided with "lower third" and the message named neither
    culprit. Predict inline, name the slug, never raise a modal for a predictable condition.
187. **A band header aggregates the whole band, never the rows on screen.**
    `setLayerVisibility`/`setLayerLocked` write every object in the layer, so reducing over a
    search-filtered list made the eye and the lock describe one set and act on another
    (`services/objectManagerBands.ts`). An **empty** band is not "all locked": `every` on an empty list
    is true, which would show a lock on a band holding nothing.
188. **`nth-child` cannot stripe a class, and `nth-of-type` counts tags.** Mask rows are `div`
    siblings of object rows, so both selectors counted them and the zebra inverted below every object
    owning a mask. There is no CSS selector for "nth of this class" — compute the parity from the row's
    index in the visible order and apply it as a class. Same trap for any interleaved row type.
189. **Solo is refused; "Hide others" / "Show all" are the answer.** Solo is either a `SceneDocument`
    field the renderers must honour or a canvas compositing filter. The tempting third option — writing
    `visible: false` across the scene and calling it view state — corrupts the document and loses the
    author's real visibility on undo. The commands are honest visibility writes, one undo step each,
    and a selected container's descendants stay visible with it.
190. **The panel has exactly one tree walker: `services/objectManagerTree.ts`.** `buildTreeRows`
    flattens bands, objects and masks into the rows the panel draws, and the render iterates that list.
    A second walk — for `aria-posinset`, for a keyboard order, for a visible-id list — is a second
    opinion about draw order that will drift from the first. The render recursed and `flatMap`ped before
    this, which is precisely why nothing outside it could say what row 9 of 40 was.
191. **A row's cell count belongs to the row.** A band draws four cells, a mask five, an object four
    plus the property columns. Clamping a column against one grid-wide width let the active column point
    at a cell the row does not draw, and Left/Right then spent several presses moving an invisible index
    while the screen sat still. `TreeRow.cellCount` is authoritative, every landing re-clamps to it, and
    the renderers keep `data-cell` **contiguous** — a spacer that skips an index makes the count a lie.
192. **`consumed` is not the same question as the intent.** A key can be the panel's *and* mean "do
    nothing": End on the last cell, Up on the first row. Returning "not handled" there scrolls the panel
    out from under the author. A key can also be the panel's to **refuse** — Ctrl+Alt+A and Ctrl+Alt+C
    belong to the Assistant and the console, and while a draft is open every key belongs to the input.
193. **Left and Right must resolve by position, never by both meanings at once.** Hierarchy on the
    first cell, movement everywhere else. A tree that tries to collapse *and* move either eats the
    author's navigation or never opens a group.
194. **A plain arrow carries the selection; the accelerator does not.** Moving the tab stop without the
    selection leaves the anchor behind, and the next Shift+Down claims every row between them — measured
    live as a three-row gesture selecting 197. Ctrl+Arrow is the escape hatch for navigating without
    disturbing the set.
195. **The DOM is the authority on where the caret is.** Any click inside the grid can focus a cell, so
    the active cell is *adopted* from `focusin` rather than tracked in parallel. Deciding it a second
    time on the pointer path is how the keyboard ends up moving from a cell the author left minutes ago.
196. **"Did this panel have focus" must be answered before the DOM changes.** Deleting the focused row
    moves the caret to `body`, so `grid.contains(document.activeElement)` in an effect answers "no" for
    exactly the case that needs "yes". Track it on `focusin`/`focusout`, and treat a `focusout` with no
    `relatedTarget` as a node disappearing rather than the author leaving.
197. **Never steal focus; resolve the target and move only if you already had it.** The focus resolver
    returns a *target plus a flag*. A panel that pulls the caret because another panel edited the scene
    eats typing from across the workspace. A keyboard commit returns to the owning cell; a pointer
    commit never pulls focus off the pointer's target.
198. **The roving tab stop does not belong in React state, and this is measured.** Driving it through
    state re-rendered every row and cell to change one attribute: **85 ms per arrow key at 199 rows**.
    It lives in a ref plus two DOM writes, re-asserted by an effect after every commit because the cells
    render `tabIndex={-1}` unconditionally. Pure navigation costs **0.2 ms**. Focus genuinely lives in
    the DOM; selection does not, so do **not** reach for this trick for `aria-selected`.
199. **A row that re-renders with the panel costs the panel's whole render.** `ObjectRow` is a
    module-level `memo` whose props are primitives plus a **stable handlers ref** — not an object of
    callbacks, which would change identity every render and defeat the memo. That took a selecting arrow
    from 80 ms to 15 ms and the marginal cost to ~14 µs per row. Anything a row needs that reads live
    scene or selection state goes through the ref and is read at event time.
200. **Virtualisation is still deferred, now on evidence rather than assumption.** At 199 rows the cost
    is a fixed floor, not a function of row count, so windowing at ~250 rows would buy under a
    millisecond while making range selection and auto-scroll-during-drag materially harder. Re-measure
    before reconsidering; the trigger is a measured per-row cost, not a row count.
201. **The scene name is a heading, not a row.** It was the grid's first `role="row"` with one cell in
    it, which made every `aria-rowindex` off by one and offered a reader a row containing no object. A
    caption names a collection and sits above it.
202. **`npm run dev` on a desktop shell leaves a *debug* render engine staged in `binaries/`.** Its
    script runs `cargo build` with no `--release`, and `build.rs` stages from
    `services/render-engine/target/<PROFILE>/`, so the debug binary sits in `binaries/` until something
    restages it. Found on 2026-08-08 in **both** shells: 45,011,456 bytes against the release engine's
    19,108,352, and a package built without `cargo clean -p app --release` would have shipped an
    unoptimised renderer with every command exiting 0. Rule 87's hash check catches this **only** when
    the comparison is the *release* engine — comparing against "whatever cargo last built" agrees with
    the defect. Before packaging: build the engine release, force the restage, then compare.
203. **The release engine can be older than the Rust sources, and nothing says so.** On 2026-08-08 the
    binary predated every `.rs` file by three days while `tauri build` happily packaged it. `build.rs`
    only reruns when the *binary* changes, so a stale binary is a stable input. Compare the binary's
    mtime against the sources before packaging, not just the staged copy against the binary.
204. **A parity claim has one home: `PROPERTY_RENDERER_SUPPORT` in `Shared/shared-types`.** It carries
    the verdict *and the wording*, because the defect that created it was a note that confidently said
    the opposite of what the renderers do — the Object Inspector claimed both renderers fill non-zero
    while Rust branches on even-odd (`mesh_prepare.rs:1366`) and Preview never reads `fillRule` at all.
    A wrong note is worse than no note. Never restate a support fact in a panel, a test literal, or a
    second module; read it, and add an entry only when you have verified it against renderer source.
205. **`neither` and `editor` are different verdicts and the distinction is load-bearing.** `neither` is
    a value that was meant to reach the screen and does not, so it must not be authorable. `editor` is
    authoring state — a name, a lock, a colour label — that no renderer is expected to consume. Collapse
    the two and the audit starts demanding that `locked` be disabled.
206. **A type the native renderer never prepares cannot honour any of its properties.** `document.rs`
    prepares `rect`, `ellipse`, `text`, `shape`, `mesh` and `light`; everything else is counted
    unsupported. So every property of an `image`, `line`, `paint`, `camera` or `marker` is Preview-only
    by derivation, which is why the contract computes that rather than repeating `preview` thirty times.
    Deriving it also keeps the claim tied to the single fact it follows from.
207. **A control the panel offers must be declared where a test can see it.** There is no DOM in the
    test runner, so `CONTROL_MANIFEST` in `modules/object-inspector/services/inspectorControls.ts` is the
    panel's own account of what it offers, and the audit holds it against the contract. This is the
    forcing function: a new field cannot reach an author without someone stating which renderers honour
    it. Eleven dishonest controls accumulated while that check did not exist.
208. **A disabled control that does not explain itself is the same defect, quieter.** `paintBlendMode`
    was already disabled and still misled, because the only nearby note said something more general. The
    audit therefore fails on a disabled control with no note, not merely on an enabled one.
209. **Removing a control must preserve its data, and "byte-identical" is the wrong promise.**
    `normalizeScene` writes defaults on load (`editorStore.ts:3259-3301`), so a legacy import can never
    round-trip byte-for-byte. The contract is **deep preservation** of the specific retained values —
    `paintBlendMode`, `eventName`, typed `effects`, `compoundPaths`, material slots including an
    `instanceId`, and an imported `textCase`. Deleting an editor is not licence to drop the field.
210. **Cross-language contracts should be asserted behaviourally, not mirrored.**
    `services/render-daemon/tests/program_object_types.rs` pushes one object of every declared type
    through `prepare_scene` and compares what avoids the "are NOT rendered" warning against the shared
    JSON. A second hand-maintained list in Rust would have drifted; a behavioural probe cannot.
211. **Pin a geometry difference by measured area, never by vertex or index counts.** The even-odd
    fill-rule test tessellates a square inside a same-winding square and asserts the filled area:
    40,000 units² under non-zero, 30,000 under even-odd. Counts can match by coincidence between two
    tessellations and would have let a regression through; area is the thing the operator sees.
212. **A behaviour that lives in JSX cannot be proven, because there is no DOM in the test runner.** The
    exit gate asked that an imported `textCase` be "shown read-only and not settable"; that was
    unprovable until the condition moved into a pure `importedDisclosures`. If a gate clause is about
    what the panel *does*, the decision has to live in a service before it can be asserted — which is
    the same reason `CONTROL_MANIFEST` exists.
213. **Some object types cannot be created from the UI, and a live gate has to route around it.** The
    Insert menu makes no `line`, `paint` or `marker`. A paint layer comes from driving the real Brush
    tool across the canvas; a `line` and an object with imported effects come through the real Import
    Design dialog from a hand-written Figma fixture, because `LINE` maps to a `line` object
    (`grapixObjectConverter.ts:340`) and node effects land in `importedDesign.effects` (`:208`). A
    `marker` still has no route, so anything about a marker's UI is headless-only — say so rather than
    implying otherwise.
214. **A mixed value must be a type that cannot carry a value.** `BatchValue`'s mixed arm is
    `{ kind: "mixed"; count }` with **no value field**, so a caller cannot render the first target's
    number and pass it off as the selection's. A convention ("remember not to show it") would have been
    broken the first time someone added a field; the type cannot be. `count` is *distinct values*, not
    objects — twelve rects with two opacities read "Mixed — 2 values".
215. **Batch eligibility means the write means the same thing on every target, not that they all have
    the property.** A mesh's `rotation` is its legacy Z fallback while a rect's is its only angle, so a
    mixed set gets position, size and opacity only. Anything type-specific needs a homogeneous set, and
    everything is still filtered through `inspectorControl` so the renderer contract governs a batch
    exactly as it governs one object.
216. **A batch is one store commit, never a loop over the single-object action.** `updateObjects`
    exists because looping `updateObject` rebuilds and normalises the scene once per target and deposits
    one history entry each unless every caller remembers to wrap it in a transaction. Twelve objects, one
    entry, one Ctrl+Z.
217. **A gate must refuse the whole batch and be openable from where it refuses.** A locked member
    refuses every field rather than letting ten of twelve through — a partial write is a mutation the
    author cannot see the shape of, and their undo then takes back something other than what they think.
    "Unlock all" therefore acts *on* the locked objects; a gate with no escape hatch is a dead end.
218. **With a mixed selection there is no state to toggle.** Visibility and lock are explicit
    "Show all / Hide all / Lock all / Unlock all" commands, because inferring a current state from a
    mixed set is how an author hides the half they meant to show.
219. **Do not index a discriminated union to read a property by name.** The per-type members live on
    variants, so `object[property]` needs a cast that fabricates a shape nothing checked. Explicit typed
    accessors also put each **default** in one place: a missing `scaleX` is 1, not 0, and a mesh's
    `rotationZ` falls back to its legacy `rotation` exactly as `resolveSceneObjectHierarchy` reads it.
220. **A step belongs to the property, not to the control.** Both panels chose their own and the same
    27-pixel drag on `x` moved an object 2.7px in the Object Manager and 27px in the Inspector. Read
    `propertyStep`; a call site that passes its own `step`, `min` or `max` for a table-constrained
    property is a second opinion waiting to drift, and `ConstrainedNumberField` exists so it cannot.
221. **Escape must not revert by writing a value.** A mixed field displays none, so restoring "the
    value" writes the active object's number onto the whole selection. Abandon a gesture through the
    store's `cancelHistory`, which restores the scene the transaction opened on and deposits nothing.
222. **A clamp over two properties needs the object, not its type.** `clampPatch` took the type, so it
    could not see the other half of a pair: its comment claimed the camera planes were enforced by a
    branch that returned its input, and the slab bevels were never clamped at all. Both relationships
    now live in `propertyConstraints.ts` and are re-evaluated whenever either side of the pair is
    patched — shrinking a slab's extrusion re-clamps bevels the patch never mentioned.
223. **Transcribe a renderer clamp including the parts that look wrong.** `slabGeometry.ts` caps each
    bevel depth at the extrusion **before** scaling the pair, so two bevels deeper than the whole slab
    lose their proportion. The store matches that rather than preserving the ratio, because the nicer
    answer is one the picture contradicts.
224. **`el.value = x` then dispatching `input` does not reach React.** React tracks the value setter, so
    a direct assignment is skipped and the DOM shows a number the store never received — a live check
    driven that way passes while proving nothing. Use real keystrokes, or the native value setter.
225. **A second OS-level drag in one page may not register.** Synthetic pointer capture leaves the first
    gesture holding the pointer, so `page.mouse` drags after it silently do nothing and read as delta 0.
    Dispatch the pointer sequence on the element for repeated gesture measurements.
226. **Program resolves no data bindings.** `SceneDocumentDto` has no `dataContext` field and nothing
    under `services/render-engine/src` resolves a path, while channels *are* sampled on air. So a bound
    property is rehearsal-only, and any surface that shows a bound value must say which renderer agrees.
    `services/render-daemon/tests/data_bindings_are_not_resolved.rs` fails if this ever changes.
227. **A binding overwrites a keyframe.** Preview's order is channels, then hierarchy, then bindings
    (`sceneMaterial.ts:35-38`). Anything reporting a property's value must resolve in that order, not in
    the order it happens to read the fields.
228. **A resolved, correctly-typed binding can still be dropped.** `assignBoundValue` guards
    `rotationX`/`rotationY`/`rotationZ`/`scaleZ` behind `object.type === "mesh"` with no else branch, and
    the numeric arms drop a wrong type the same way. "The path resolved" is not "the value was written":
    ask `isBindingAssignable` first, or report `bound` for something inert.
229. **Two questions that look like one: does a renderer consume this property, and can the applier write
    it.** A layer's `scaleZ` edited by hand reaches its mesh child through hierarchy inheritance; the same
    property bound reaches nothing. One predicate answering both is how the panel advertised an option
    nothing honoured. Keep the column, drop the binding row.
230. **Test both branches of a fix before choosing one.** F13's declared repair was to apply bindings
    before hierarchy, and measuring showed that changes nothing — the container's own value is never
    written in either order. A plan's preferred direction is a hypothesis.
231. **A hidden control can be the correct one and still be wrong about its neighbour.** The camera/light
    transform group was hidden by one flag; six of the seven were right, and a light's `opacity` is a
    dimmer both renderers honour. Gate per property from the contract, never per group by object type.
232. **A channel is worth offering only if some renderer reads the property.** `isPropertyAnimatable`
    derives from `PROPERTY_RENDERER_SUPPORT`; `neither` means no curve. It deliberately does not encode
    "the engine animates no lights at all" — that is an engine gap, and deleting controls to describe it
    would hide the gap instead of fixing it.
233. **A top-level `Set` built from a re-exported barrel constant throws.** `index.ts` re-exports
    `propertySource.ts`, so `new Set(ANIMATABLE_PROPERTIES)` at module scope hit the TDZ and took the
    whole package's suite down, not just that file. Read shared constants at call time, or import only
    types from the barrel as the sibling contract modules do.
234. **An exclusion list needs a test that fails when the exclusion becomes unnecessary.**
    `KNOWN_CONTROL_WITHOUT_CHANNEL` names the light/camera `zDepth` gap and asserts it still exists, so a
    fix shrinks the list instead of leaving a stale carve-out that hides the next real disagreement.
235. **A protocol operation is not reachable until its capability is advertised on both sides.** Adding
    `APPLY_DATA_REVISION` to the verb list and the dispatcher left it unusable: the adapter's HELLO
    checked the client's requested capabilities against its own set, so a client negotiating
    `data.revision` was refused `CAPABILITY_MISSING` before it could send a single request — failing for
    exactly the clients the operation was added for. Extend the operation enum, the admission list, the
    dispatcher **and** the advertised capability set together.
236. **A mutating operation must join the pinned-digest list, not just the admission list.** The pipe
    gates `OPEN_PROJECT` and `SET_PROPERTY` on a non-empty `expectedProjectDigest`; a new writer that is
    only added to the admission list mutates a project nobody pinned.
237. **Atomicity across an API with no transaction has to be built in three phases.** Validate and
    range-check every member, then resolve and prove every target writable while capturing its prior
    value, then write. Rolling back needs the prior values, and the prior values have to be read before
    the first write — a two-phase version can only apologise.
238. **A rollback that cannot itself be trusted must not report success.** If restoring a member fails,
    After Effects holds a mixed state; `rolledBack` stays false and the code degrades to `AE_ERROR`, so
    "we put it back" is never claimed on evidence that says otherwise.
239. **Persist the accepted revision after the mutation, never before.** Both orders can lose to a crash,
    but only one loses safely: committing after means a crash re-offers the same revision and the
    idempotency key recognises the retry, while committing first would skip a revision nothing applied.
240. **A verdict that cannot be produced is dead code, and the reachability test is arithmetic.** With
    `revision === baseRevision + 1` enforced, `conflict` required an accepted revision strictly between
    two consecutive integers — impossible. Either the strict rule or the verdict had to go: ordering the
    checks so the base alone decides (`below → conflict`, `above → gap`, `equal → apply`) made all five
    reachable and deleted the redundant `stale`.
241. **A bounded audit queue that drops the oldest line cannot also promise a record.** Reserving
    capacity before dispatch, and writing reserved records past the ceiling, is what lets a caller be
    told "you may proceed" honestly; without it the record a take depends on is exactly the one a flood
    evicts. `reserve` returning null is a refusal to act, not a warning to ignore.
242. **Two descriptions of the same layer must not disagree about it.** `LIST_LAYERS` rendered "no
    footage source" as `null` while `runtime_property_target_json` wrote `0` for the same layer, so a
    declared control and a revision echo described one target two ways. The contract types the field
    `number | null`; both now say `null`.
243. **Asking After Effects for a stream a layer cannot have wedges the idle hook.** Source text on a
    solid, or a Fill colour on a layer with no effects: AE stays alive and `Responding` with a flat CPU
    counter while no callback ever completes again — finding F2's signature. The graceful quit then
    refuses because ownership cannot be proven, so only a kill clears it, and the kill taxes the next
    start (measured: 12 s and four dialog batches after a kill against 6 s and one after a graceful
    quit). Gate every property kind on a cheap total query — `AEGP_GetLayerObjectType` for text, an
    effect walk for colour — **before** acquiring any stream. Probing by "try it and see" is not free
    here; it is how a session is lost.
244. **A multi-segment canonical path must be echoed as real segments.** Collapsing
    `ADBE Text Properties/ADBE Text Document` into one `/`-joined `matchName` made every two-segment
    declared control unmatchable and reported it as `CONTROL_TARGET_STALE`, because `selectMetadata`
    compares segment by segment. The joined form is fine as a diagnostic fingerprint and wrong as an
    identity.
245. **After Effects quantises a requested time into the item's own scale, and the scale may not be able
    to represent what you asked for.** `LOWER_THIRD`'s scale is `23976` — exactly `29.97`, not
    `30000/1001` — so a cue declared at `30000/1001` came back as a different instant. Always read the
    time back and cross-multiply; refuse with `TIME_NOT_REPRESENTABLE` rather than parking a cue on a
    neighbouring frame. A declared rate and a composition's time scale are two clocks until proven equal.
246. **`Math.round` and integer truncation are not the same rounding, and a cross-language pair must pick
    one.** `clock.ts` rounded while `stage.rs` truncated, so a third of all frames at `60000/1001` had
    different deadlines in the two languages — and the TypeScript intermediate product overflowed
    `Number.MAX_SAFE_INTEGER` after six minutes anyway. Compute in bigint, truncate on both sides, and
    have one JSON vector fixture read by both test suites so drift fails a test instead of a show.
247. **A certification runner that can report zero comparisons must not be able to exit green.** A
    `not-run` row is a legitimate outcome and has to be visually distinct from a pass; the exit code
    keys off failed *declared* comparisons only. Otherwise "all gates open" and "all gates passed" look
    identical from CI.
248. **When one upstream gap blocks several phases, fix the gap rather than working around it in each.**
    Six admitted-but-unhandled operations were the single reason BO0a's control proof and PL1's live
    proof were both stuck; three of four declared controls went from `not-run` to passing once the
    declared surface carried text and colour. Check whether the blocker is shared before routing around
    it three times.
249. **A refusal branch that cannot fire is a claim the code does not honour — delete it.** Cue
    resolution grew a per-cue "not on a composition frame" refusal beside the structural rate check.
    Once the declared rate is *proven* equal to `timeScale/frameDuration`, composition-frame and
    Program-frame membership are the same divisibility test, so the branch was unreachable: dead code
    advertising a safety check that never runs. Brute-force the reachability claim (86,760 triples here)
    and then remove the branch, rather than writing a test for a path no input can take.
250. **Read a clock as a rational or do not read it at all.** `AEGP_GetCompFramerate` hands back an
    `A_FpLong`, and a float rate is not allowed to decide whether a composition is `2997/100` or
    `30000/1001` — the whole `TIME_NOT_REPRESENTABLE` incident is what that distinction costs.
    `AEGP_GetCompFrameDuration` gives `{value, scale}` exactly; make the exact reading the required
    field on the contract, so a container cannot carry a composition whose clock nobody read. Add the
    *producer* first and the wire field with it: a field with no producer is speculative surface, but a
    gate named where a producer could have existed is an excuse.
251. **`vendor/` is gitignored, so a default `glob` cannot see it — check before declaring a toolchain
    absent.** This session concluded "no AE SDK is vendored" and deferred a native change on that basis;
    the SDK was at `vendor/adobe/sdk/ae25.6_61.64bit.AfterEffectsSDK` all along, with MSVC 14.44 exactly
    where `build.sh` expects it, and `adapter.cpp` compiled clean in under two seconds. Pass
    `gitignore: false` when asking whether a dependency exists. Also: `build.sh` is bash-only and writes
    `//flag` for MSYS path translation — the harness shell is not git-bash, so invoke `cl` with
    single-slash flags instead of running the script.
252. **One name in two directions is two contracts, and one of them is wrong.** `RENDER_READY` and
    `RENDER_FAILED` sat in both `AeRuntimeOperation` (client→adapter, carries a `requestId`) and
    `AeRuntimeEvent` (adapter→client, carries none), so the same word meant both "is the render ready?"
    and "the render is ready". Pick the meaningful direction and delete the other from the union. A
    duplicated name also hides a transport bug: the client's frame loop handed *every* frame to the next
    reply waiter, so the pushed direction could never have been delivered at all. When a protocol
    declares a push channel, prove one push reaches a listener while a call is in flight — otherwise the
    channel exists only in the type.
253. **When a call can wedge the only callback that answers calls, make the answer asynchronous.**
    `AEGP_OpenProjectFromPath` returns success and then silences the idle hook the pipe is serviced
    from, so a synchronous "opened" reply is precisely the reply a wedged runtime cannot send. Accept the
    request, act on a *later* callback than the one that accepted it, and emit the completion only after
    *another* callback proves the host survived. That does not fix the wedge — it converts an
    undetectable hang into a missing event a supervisor reports as degraded. Say which of the two you
    did, and never let it be re-simplified back to a synchronous call.
254. **A subagent's "tests pass" is worthless until you know which package it rebuilt.** CB0 removed a
    route and reported green tests; the tests imported `../dist/index.js` and only failed once
    `project-api` was actually rebuilt, because the agent had built `editor-web`. Any suite that imports
    from `dist/` is testing the last build, not the current source — rebuild the package the change is
    in, then believe the result.
255. **Deleting a route means retargeting its tests, not deleting its coverage.** The retired
    `/api/import/after-effects/project` tests carried assertions still worth keeping — a non-project is
    refused with a reason, a bad request is refused before anything is read. They were re-pointed at the
    surviving inspector and gained the assertion that actually guards the retirement: inspection creates
    **no scene and no asset directory**. A removal test should assert the absence of the side effect, not
    merely the absence of the route.
256. **"Same host or a separate host" is two questions when two different things render.** GrapiX's own
    engine is already host-agnostic by configuration (`--bind`, `--headless`, token forced on non-loopback),
    so "separate render host" is free for GrapiX and expensive for After Effects. The AE frame path is
    same-host *by construction* — a Windows shared-memory mapping and a local same-user named pipe — and
    crossing hosts is 3.98 Gbit/s at 1080p59.94, 15.91 at 2160p59.94, with compression forbidden by
    invariant 7. Before agreeing to "both", say which renderer moves, then check the transport arithmetic
    and the licence variant separately: L0 approves V1 only, V2 needs a named interactive user on its own
    seat, V3 is research. An unapproved topology must be **refused with a named code**, not left
    unreachable-by-accident.
257. **When a recovery path cannot be reached, factor it out and measure it — do not weaken the guard that
    blocks it.** AE-CD2's rollback had never run because phase 2 validates thoroughly enough that no
    member can fail its write. The temptation is to find or create a validate-then-fail stream; the answer
    is to extract the sequencing (`revision_apply.cpp`) so a harness drives *the same code production
    runs* with injected faults and no SDK, exactly as the ring harness does. Keep the guard, move the
    testability.
258. **A harness that cannot fail is not evidence — mutate it once and watch it break.** Reversing the
    restore order on purpose failed six of ten cases and exited 1. Do that before quoting a harness's PASS
    count as proof of anything.
259. **Fault injection in a shippable component must announce itself.** One-shot arming by explicit
    environment variable, disarmed on use, reported in the HELLO fingerprint, and certification refuses to
    record evidence when the field is non-null **or absent** — absent means an older build that cannot say,
    which is not the same as clean. An injected run measures a recovery path; it never certifies a product.
260. **`git-bash` is installed at `C:/Program Files/Git/bin/bash.exe`.** Use it for `build.sh`,
    `run-frame-ring-harness.sh` and `run-revision-rollback-harness.sh` instead of hand-reconstructing `cl`
    invocations. The default `bash` on PATH is WSL and cannot see the Windows toolchain (rule 251).
261. **Two truncating conversions do not round-trip, and the `max` that hides it is load-bearing.**
    `deadline_nanos` and `frame_at` both round down, so `frame_at(deadline_nanos(f))` is `f-1` for two
    thirds of frames at `60000/1001`. `due` can lag one and can never lead; `target = next.max(due)` is
    what makes the clock correct. Assert the *direction* of a rounding error and the compensation, never
    a round-trip — and when a test of an invariant fails, check whether the invariant was ever true
    before touching the code.
262. **Order refusal checks by what is true, not by what is convenient to look up.** An abandoned frame
    has no outstanding request, so a lookup-first ordering reported "nobody asked for this" about a frame
    that was asked for and merely arrived late. Decide `historical` before `unrequested`. The corollary is
    a counter rule: **exactly one owner per counter** — `abandon_before` owns `missed`, so the late
    arrival must not count it again, or every figure built on the totals inherits the inflation.
263. **A subagent that refuses to weaken an assertion is doing its job.** Both AE-F2a agents stopped and
    reported a conflict between the spec and the implementation rather than adjusting the test, and both
    conflicts turned out to be errors in the instructions they were given. Write tasks that say "do not
    weaken an assertion; report the conflict" and then actually treat the report as a finding.
264. **After adding a translation unit, run the project's own build script — not the compile command you
    already have open.** `revision_apply.cpp` was added for AE-CD2 and compiled fine by hand for hours,
    while `build.sh`'s hand-listed link line had never heard of it: the *documented* build was broken with
    `LNK2019` and only a subagent running the real script found it. A build script that enumerates its
    inputs by hand will drift from the source tree every time, and the hand-rolled command is exactly what
    hides the drift.
265. **Wiring is not the same as proving a mechanism.** AE-F1 proved the shared-memory ring over 100,000
    cycles and `adapter.cpp` contained **zero** references to it — a fully certified transport with no
    producer attached. When a phase says "implemented and verified", grep for the call sites before
    believing the next phase can consume it.
266. **A per-test temp directory is useless when the module cached the path at import.** `GRAPIX_DATA_ROOT`
    is read once when `dist/index.js` is imported, and ESM caches the module — so every server in a file
    uses the *first* root no matter what later tests set. Combined with a bootstrap that refuses when
    `users.json` already exists, that produced a failure which passed or failed depending on whether the
    previous server had released its file handles yet. If a test suite reads configuration from the
    environment at import time, share one root and one bootstrap per file; do not fake isolation you do
    not have. And when a test fails intermittently, run it five times before calling it a flake — a
    deterministic failure hiding behind a race is the more common case.
267. **On this Windows host, verify Adobe file paths with PowerShell, not git-bash.** `cmd if exist` and
    bash path checks can report `AfterFX.exe` or an installed plug-in as missing when PowerShell
    `Test-Path` and `Get-FileHash` show the real state. A false negative there looks like an install or
    environment failure and sends the work in the wrong direction.
268. **A live gate needs a live consumer, not just a proven producer.** `AE-F1` proved the shared-memory
    ring and `AE-F2a` proved the Program seam, but no real `AeProgramFrameSource` existed, so the frame
    still could not reach Program. When a phase ends with a seam on one side and a harness on the other,
    grep for the production implementation that joins them before calling the gate live.
269. **A runbook that has never been executed is a draft.** The AE live-frame README had two wrong
    command shapes in one sentence; both were found only by running the gate. Prefer evidence gathered
    by execution over a polished procedure that has never been tried.
270. **NDI discovery is not BO2 certification.** This workstation has NDI 6 Tools/Studio Monitor and an
    app-local runtime at 6.0.1.0, but no default-path SDK and no runtime DLL on `PATH`; the vendor-current
    Tools release is 6.3.2. BO2 needs one pinned SDK/runtime pair on both machines plus a second physical
    wired-LAN receiver host running the GrapiX verifier. Studio Monitor can prove discovery and pixels
    are visible; it cannot prove exact alpha, cadence or accounting.
271. **Inventory old broadcast hardware before buying its replacement.** Windows retains non-present
    records for a DeckLink 8K Pro and DeckLink Mini Recorder 4K and has Desktop Video 12.5 installed, but
    no Blackmagic device is currently present. Locate the 8K Pro first: it can supply the four SDI
    channels BO3 needs in `PCIEX16_2` at x8, at the cost of reducing the RTX 3070 Ti to x8. If it is gone,
    a Duo 2 fits `PCIEX16_3` only when BIOS selects x4, which disables SATA ports 5/6. Never order before
    checking those ports and physical clearance.
272. **When a detection contract is all a route can offer, replace the route.** The asynchronous AE
    lifecycle was correct and it still lost: it turned an undetectable `AEGP_OpenProjectFromPath`
    wedge into a detected `LIFECYCLE_SILENT`, which is a degraded host and a kill either way. The
    supervisor-owned restart deletes the failure instead of reporting it. Prefer removing an unsafe
    capability over instrumenting it, and delete the instrumentation with it so nothing re-grows
    around the old shape.
273. **Prove identity from the host, not from the request.** A project digest proves which bytes were
    asked for; only `AEGP_GetProjectPath` through `HEALTH` proves which project After Effects has
    open. During a load AE answers before the target document exists, so treat a non-matching path as
    still-loading until the deadline and then refuse — never accept the first successful reply as
    proof, and never let the declared digest stand in for the host's answer.
274. **The supervisor does not clear After Effects' startup modals; a live run must.** An unattended
    launch on a host queuing a crash dialog sits at `ENOENT` on the pipe for the entire window and
    looks exactly like a broken adapter. Run the `ae-window.ps1 -Action clear-dialogs` loop beside any
    live supervisor gate, and remember the modals are armed by the previous `TerminateProcess` stop.
275. **An install that prints instructions is not an install.** `install.sh` refused on Program Files
    and printed a manual copy command, which stalled a licensed-host gate behind a stale `.aex` that
    still answered on the pipe at the old protocol major. It now self-elevates through an
    `-EncodedCommand` UAC child and **verifies the installed hash**, because a dismissed prompt and a
    successful copy are indistinguishable from the launching shell's exit code. PowerShell has no
    `\"` escape: use a backtick before the quote inside an sh-single-quoted block.
276. **Run the real loop, not just the surface it calls.** Every AE-F2b unit test passed against a
    scheduler that permanently wedged Program: the clock abandoned outstanding requests only when it
    *skipped* frames, so a stalled After Effects with a punctual clock never abandoned anything, filled
    the in-flight set with unpresentable requests, and stopped asking for frames for good — including
    after the producer recovered. Two hundred milliseconds of the actual `ProgramClock` found it. When a
    component is driven by a loop, one test must drive the loop.
277. **A lead that is shorter than the work it waits for is a schedule that cannot work.** One frame
    period at 59.94 is 16.68 ms and an AE checkout takes tens of milliseconds, so a one-frame lead makes
    every frame late by construction — correct measurement, useless schedule. Fix it by deepening the
    *window*, never by sleeping longer: a longer sleep drags the request point into the previous frame's
    presentation, which is what the one-period rule existed to protect.
278. **Back-pressure and lateness are opposite signals; never give them one response.** Pressure means
    too deep for the ring (shrink); late means too shallow (never shrink — it only arrives later still,
    so merely stop restoring depth). Asymmetry like this is worth a mutation check: collapse the two
    branches on purpose and confirm a test fails, or the asymmetry is only a comment.
279. **When a guard becomes unreachable, say where it is still reachable from.** Draining dead requests
    made AE-F2b's capacity guard unreachable through the window (depth never exceeds capacity), but the
    older single-request API still bypasses the window, so the guard stays and its test documents that
    path. An untestable guard is either dead code to delete or a reachable path to name — not something
    to leave ambiguous.
280. **Measure the gate's own number before building toward it.** AE-F3 asks for 30 minutes at a pinned
    rate; the frame path sustains ~21 fps against 29.97, so no amount of harness work makes that gate
    pass. A 300-frame probe answered it in 24 seconds. When a phase's exit gate names a rate, a size or
    a duration, measure that quantity first — it is the cheapest possible way to find out the phase is
    really a throughput problem wearing a soak's clothing.
281. **A per-command channel is a throughput ceiling, and it hides behind plausible latency.** The
    adapter services one command per AE idle callback, so a trivial command and a full 1920×1080
    checkout both take ~46 ms. That symmetry is the tell: if work of wildly different cost takes the
    same time, the number being measured is the channel, not the work. Prove it by timing a command that
    does nothing.
282. **Never trust `ok` from the AE file channel.** The adapter answers `ok:true` **with a `reason`** for
    an unknown verb, so a harness that checks `ok` alone will happily measure and report the cost of
    being misunderstood. Require a field only the intended verb produces — a checkout reports its own
    geometry.
283. **Evidence side effects belong behind a flag.** `checkout` writes its full payload to disk and
    computes per-pixel alpha statistics before publishing to the ring — right for `AE-F0`/`BO0a` one-shot
    comparison, 447 GB for a 30-minute soak at 29.97. Any per-frame diagnostic on a path that will one
    day run continuously must be opt-in from the start.
284. **One thread owns a synchronous pipe handle. No exceptions.** Writing a reply from AE's idle hook
    while the connection thread sat in a blocking `ReadFile` froze After Effects for 900 seconds:
    Windows serialises I/O on a synchronous file object, so the write queued behind a read that could
    only finish once the client received that write. Queue envelopes and let the owning thread flush
    them; poll input with `PeekNamedPipe` rather than parking in a read. `emit_event` had this hazard
    before this phase and nobody had hit it yet.
285. **Counters that separate "accepted" from "serviced" pay for themselves the first time.**
    `pipeAccepted`/`pipeServiced`/`pipePending` in HEALTH turned "the client sees nothing" into "the
    request was accepted and serviced, so the loss is the write" in one command. Without them the next
    hour goes into the wrong half of the system. When work crosses a queue, count both sides.
286. **A request/response protocol that waits for each reply before reading the next frame has a
    throughput ceiling of one operation per servicing tick,** whatever the client does. Depth 1 measured
    21.3 ops/s, depth 8 measured 170.6, and depth 16 added only latency — flat throughput with doubled
    latency is how you prove the *server's* bound is now binding rather than the client's.
287. **Measure a host callback's period before designing around it.** AE's idle hook fires every ~46.9 ms
    here, and asking for a shorter `max_sleep` did not change it. Anything built on "the hook will run
    more often if we ask nicely" is built on nothing; batching per callback is the only lever that moved.
288. **An events-only signal is a design smell.** `RENDER_READY`/`RENDER_FAILED` existed on the protocol
    for a whole phase with no request that could cause them, and no amount of harness work around the
    legacy file channel could measure the frame path because of it. When a reply shape has no request,
    that is the missing work, not a detail.
289. **Address a composition by item id, never by index or name.** An index moves the moment a project is
    reordered and names repeat across a fixture corpus. Both forms stay supported for the original spike
    commands; every new operation takes `id:`.
290. **Per-frame diagnostics must be opt-in on any path that runs continuously.** The payload file and its
    per-pixel alpha statistics are `AE-F0`/`BO0a` one-shot comparison evidence. Left unconditional they
    cost 8.29 MB per frame - 2.5 GB in 24 seconds of probing, against 864 KB for 900 renders with them
    off.
291. **Measure a Rust consumer in release or you are measuring the compiler.** An 8.29 MB FNV checksum per
    frame unoptimised costs more than a 1080p After Effects render, and it made the producer look like it
    back-pressured.
292. **A consumer must wait for a lazily created mapping, not exit.** The adapter creates the ring on its
    first publish. A consumer that exits when it finds nothing turns a start-ordering detail into a
    phantom producer fault.
293. **A host callback's period is not a constant — it is `max(host cadence, your batch)`.** Batching
    under the host's own idle floor is free; past it you become the clock and throughput converges on
    `1 / per-item cost`. Deriving a per-item cost by dividing work by a period that still contains the
    host's idle floor understates it - that is how ~11.3 ms per frame got recorded as ~8 ms.
294. **`Responding=True` on a Windows process proves the absence of a hang, not the absence of jank.** A
    226 ms callback occupancy still answers the message queue while stuttering every UI interaction to
    ~4 Hz. Never quote it as evidence a host stayed usable.
295. **Take the knee, not the maximum.** The 45 ms budget captured 95% of the throughput asymptote at a
    59.6 ms callback period; 200 ms bought the last 5% for a 3.8x worse period and 4x worse latency.
296. **Keep performance tunables in the environment, not in the binary.** A compile-time sweep changes the
    adapter hash mid-series, so points in one series stop being comparable. It does *not* invalidate
    recorded evidence - the corpus already spans four hashes, and `adapterSha256` records *which build
    produced this evidence*, which makes an older file historical rather than wrong. Adopting a swept
    value as the default is still a re-certification pass, not a tuning commit.
297. **Certification fixtures MUST be in version control.** `tools/certification/ae-runtime-fixtures/v1/`
    `fixtures/` is untracked, so when `lower-third.aep` drifted from its pinned digest there was nothing
    to restore from. A digest that pins an untracked file records damage without enabling recovery.
298. **Never re-pin a digest to match drift; make the artifact match the pin.** Re-pinning was tried here
    and reverted - the fixture then failed its pixel baseline by 221,745 pixels at full channel delta.
    The pin is not the problem it reports.
299. **A live control read is fixture-integrity evidence.** `SCORE` reading `100` where the authored
    baseline recorded `042` identified persisted fixture mutation faster than any byte diff could.
300. **Never make key order a contract.** `JSON.stringify(a) !== JSON.stringify(b)` on structured data
    fails certification when a field is merely added in a different *position* - which is what
    `compositionTime` did while the authoritative digest matched exactly. Compare a recursively
    key-sorted canonical form.
301. **Prove an adopted default from the host's own report.** `HEALTH` showing `idleBudgetMicros: 45000`
    with no override present is what makes "the default changed" a fact; then re-run every live path the
    change could touch and require behaviour-neutrality before calling the adoption free.
302. **An idempotency key must be scoped to a run, not to the work.** `frame-<n>-rev-<r>` reads as the
    correct identity and silently bricks a restart: the adapter remembers accepted keys for the whole
    After Effects session, so the second engine to ask for frame 1 is answered `DUPLICATE_REQUEST` and
    the frame is never rendered. Prefix with a per-run id.
303. **Read the receiver's parser, not the receiver's docs, for field types.** `RENDER_FRAME` takes
    `frameId` bare (`runtime_payload_integer`) and `presentationDeadlineNanos` quoted
    (`runtime_payload_string`). Making them consistent is `INVALID_PAYLOAD`.
304. **Wire a schedule at its source, never at one caller.** Posting requests inside
    `Engine::send_ae_program_requests` carries the lead window, single frames and revision re-requests
    alike; doing it in the clock would have wired one of the three and looked finished.
305. **A client that pipelines must never block a write behind a read.** One thread owns the pipe, writes
    everything queued, then polls; a blocking read starves the write queue, which is the same fault that
    froze After Effects for 900 seconds from the other side.
306. **A lead of one frame period cannot be punctual against a host callback that is slower than a
    frame.** AE's idle period measured ~46.9 ms against 33.4 ms at 29.97, so asserting punctuality inside
    one period asserts the host runs faster than it does. Four periods is the measured knee.
307. **A new protocol verb must be classified in `permission_for_request`, not just in the role matrix.**
    The engine refuses an unclassified verb with `UnauthorizedRole` - "not a classified request type" -
    because treating an unrecognised message as unprivileged is how a protocol addition becomes an
    authority hole. Both gates, every time.
308. **When adding an arm to a parse table, assert a neighbour still parses.** The `ae.container.load`
    edit silently displaced `output.configure`; a test that only checked the new verb would have passed.
309. **A lifecycle verb should mean "proven", not "configured".** `ae.container.load` asks for a warm-up
    frame and opens the ring it creates, so a success means pixels have actually moved. Any failure
    detaches what was already installed - a half-attached container is the silent-no-frames fault.
310. **A secret that arrives in a payload must not come back out.** Playout owns the AE session token and
    the engine needs it to connect; it is never echoed into an ack, an audit record or a log line, and a
    test asserts the ack does not contain it.
311. **Live gates that claim a single-consumer resource must run with `--test-threads=1`.** Two ignored AE
    tests in one binary both claim the ring's one consumer slot, and cargo runs them concurrently.
312. **`.gpxpkg` is the only native extension, and it carries two formats.** A project manifest at a
    project root and a published scene package are both `.gpxpkg`; `kind` (`"project"` /
    `"scene-package"`) is what tells them apart. Never infer the format from which fields happen to be
    present — absence is also what a truncated file and an older writer look like, and guessing between
    "project" and "goes on air" is not a guess worth making. Anything that opens a `.gpxpkg` reads
    `kind` first, and a reader that scans a directory must keep looking rather than take the first match.
313. **A project is a folder, not an archive.** The `.gpxpkg` at its root is the manifest and the thing
    an operator double-clicks; the content stays in readable folders beside it so a show can be
    inspected, synced and archived without GrapiX. Do not "improve" this into a single sealed zip:
    every save would rewrite the container, video could not stream out of it, and the native engine
    could not memory-map an asset. A sealed single file is a *pack* operation, not the working format.
314. **Writes refuse without a project; reads return nothing.** `projectFolder()` throws
    `NO_PROJECT_OPEN` and that is deliberate — the operator can author freely, and nothing reaches disk
    until they choose where. But listing is a question, not a write: `listScenes` answers `[]`, because
    a scene picker showing an error before the first save is wrong. Keep that asymmetry when adding
    paths, and keep `ensureStorage` creating only the service's own directories.
315. **Cache-busting one module does not isolate the modules it imports.** `dist/storage.js?root=…`
    gives each test its own storage, and the `projectWorkspace.js` inside it is still shared — so the
    first test in a file decides which project is open for all of them, and later writes land in the
    first test's project while every assertion still passes. Share one project path per file and empty
    it between tests. This is the same trap as rule 266, one layer deeper.
316. **The asset folder is the library; the scene records what it uses.** Material Manager lists the
    project's asset folders by reading them, so a file dropped in with Explorer appears and a deleted
    one stops being offered. Do not reintroduce a catalogue that entries must be imported into — the
    whole point is that the library and the file manager cannot disagree. The scene still carries
    `scene.assets` for what it actually references, because that is what the packager packages and
    what the renderers resolve; assignment is the moment a browsed reference joins the document.
317. **A library reference is addressed by path, a transfer cache by hash.** Both exist and they are
    not interchangeable. Replacing `lower-third-bg.png` in place must keep every material bound to
    it — path identity makes that a new version of the same reference, hash identity would make it a
    different asset and orphan every binding. `projectAssetId()` is a function of the path, and its
    alphabet is constrained because the packager builds a file name out of it.
318. **Adopt inside the caller's own commit.** `assignAssetToFaces` pulls an unknown library asset
    into the scene within the same `commitScene` that binds it. Calling `adoptProjectAsset` first
    would be two history entries for one gesture, and Ctrl+Z would then leave the asset in the scene
    bound to nothing. One gesture, one undo.
319. **Re-check containment after `realpath`, not before.** A client-supplied asset path is checked
    syntactically, resolved inside the project root, and checked again once symlinks are resolved. A
    syntax check alone cannot see a link, and a junction in `Assets/Images` pointing at a shared
    drive is a normal thing for an operator to create. Every refusal answers one 404 — distinguishing
    "outside the project" from "does not exist" maps the filesystem a request at a time.
320. **Do not put a filesystem watcher on a folder the operator edits.** The asset library refreshes
    on panel mount and window focus, which is when an author who alt-tabbed to Explorer comes back.
    A watcher holds handles on those directories, and on Windows that is how a folder becomes
    undeletable while the Editor is running.
321. **A fixed `.tmp` name is not an atomic write.** `write-then-rename` is only safe when the
    temporary name is unique per write and writes are serialised. A shared name means two concurrent
    savers race: the loser's rename fails `ENOENT`, and the file that survives can be the older body
    while both callers believe they saved. `storage.ts` has the keyed-lock pattern to follow.
