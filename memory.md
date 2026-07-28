# GrapiX Project Memory

Last consolidated: **2026-07-28**  
Repository: `D:\Project KK\Personal projects\GrapiX`  
Current branch: `Basic-v0.1`  
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
  library, rundown, sequencer, Preview and Program control application.
- Editor must provide a durable **Publish to Playout** workflow that validates,
  packages and versions every scene dependency and receives structured publish
  progress and acknowledgement.
- Playout must continue from previously published scenes when Editor is closed
  or disconnected and must own rundown/timecode/operator state independently.

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

**Approved target; not yet physically migrated:**

```text
GrapiX/
├── Editor/
├── Playout/
├── Shared/
└── package.json
```

- Editor owns authoring, project/source assets, validation and publishing.
- Playout owns published scene versions, the scene library, rundowns, segments,
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

1. Stabilize, verify and checkpoint current uncommitted work.
2. Add root Editor/Playout/Shared workspace scaffolding and compatibility
   scripts.
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

### `apps/desktop-tauri`

Primary desktop shell and process supervisor.

- Tauri 2 + Rust + Windows WebView2.
- Loads the React/Vite editor.
- Starts or reuses the Fastify API service.
- Builds, stages, starts, or reuses the Rust render daemon.
- Watches API health, renderer status, Program frame progress, and output
  errors.
- Uses bounded renderer restart attempts.
- Remembers Program/output state and attempts restoration after restart.
- Supports an explicit safe fallback scene state.
- Exposes supervisor health to the editor status bar.
- Root `npm run dev` targets this app.

### `apps/desktop-electron`

Retained fallback shell from the earlier desktop phase.

- Wraps the same web editor.
- Can start/use the Fastify service.
- Not the primary architecture after the Tauri 2 decision.
- Preserve it until Tauri packaging and workflows fully replace it.

### `apps/editor-web`

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
- `RendererClient.ts` — renderer-control client boundary, separate from editor
  preview.

### Future `Editor/`, `Playout/`, and `Shared/`

The existing modules above describe the current layout. Their approved future
ownership is:

- `Editor/` — current desktop shells, `editor-web`, project API, authoring tests
  and Publish to Playout.
- `Playout/` — new operator desktop/web UI, playout control service, published
  scene store, rundown/segment runtime, native daemon and output plugins.
- `Shared/` — current shared-types, renderer-protocol, render-shaders,
  grapix-sdk and future rundown/transition/package/common packages.

This is Planned architecture until the safe migration phases pass.

### `packages/shared-types`

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

### `packages/renderer-protocol`

TypeScript source of truth for renderer protocol v2.

Envelope safety includes:

- protocol version
- non-empty request ID
- strictly increasing per-connection sequence
- timestamp
- expected renderer state
- explicit nullable scene ID/revision/channel context
- acknowledgement/error/capability/status/event envelopes
- stale-sequence, revision, and state-precondition rejection

Command families include capability, heartbeat, scene load/update/warm/patch/
release, Preview selection, cut Take, output configure/start/stop, resource
profile, and status.

Rust protocol parsing must change in the same commit when this package changes.

### `packages/render-shaders`

Shared WGSL and machine-readable renderer contracts.

- Uniform byte layouts.
- Transform matrix conventions.
- Premultiplied-alpha rules.
- sRGB/linear colour rules.
- Blend-mode IDs and equations.
- Canonical physical mesh shader.
- TypeScript/Rust byte-layout tests protect drift.

### `packages/grapix-sdk` (`@grapix/sdk`)

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

### `services/api-server`

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
- Renderer-daemon bridge.
- Operator audit logging and read-only show mode.

Storage safety:

- temp + fsync + rename writes
- safe IDs and paths
- SHA-256 references and package checksums
- backups and explicit recovery
- input magic/type/size validation
- remote binding authentication and Origin checks

### `services/render-daemon`

Standalone native Rust 1.87+ service using Tokio, wgpu 26, glam, glTF, image,
serde, and an optional NDI adapter.

Main module ownership:

- `config.rs` — environment and runtime configuration.
- `protocol.rs` — Rust protocol v2 envelopes and validation.
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
- `transport/websocket.rs` — authenticated local WebSocket transport.

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

Editor publication to Playout is distinct from saving an authoring project:

- Editor builds and preflights a complete versioned `.gfxpkg`.
- Playout revalidates checksums/capabilities, stores it in staging and atomically
  promotes the published version into its scene library.
- Scene identity and revision are preserved across updates.
- Playout reports progress, warnings, failures and final acknowledgement.
- Playout retains previously published versions needed by rundowns or Program.
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

Useful gates:

```bash
npm run typecheck
npm test -w @grapix/editor-web
npm test -w @grapix/shared-types
npm test -w @grapix/api-server
npm run test:daemon
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
npm run dev
```

Individual development processes:

```bash
npm run dev:web
npm run dev:api
npm run dev:daemon
```

Default local endpoints:

- editor: `http://127.0.0.1:5173`
- API: `http://127.0.0.1:4100`
- native daemon WebSocket: `ws://127.0.0.1:4200`

The Tauri shell reuses already-running services when possible.

## Known gaps and next priorities

### Editor / Playout workspace migration

- Finish and checkpoint the current dirty Editor/native-renderer/font work.
- Scaffold the master `Editor/`, `Playout/`, `Shared/` workspaces without moving
  source yet.
- Move existing source mechanically into Editor and restore every build/test/dev
  command before feature work.
- Extract shared contracts with compatibility exports.
- Build Playout scene library, rundown/segment persistence and autosave.
- Implement Publish to Playout and its reconnect/idempotency/version tests.
- Add independent native Preview and Program operator control.
- Add page recall, timecode, automation, layer conflict and transition runtime.
- Add Playout restart/offline/on-air-state reconciliation tests.

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
- [`docs/project-memory.md`](docs/project-memory.md) — older detailed build log.
- [`docs/architecture.md`](docs/architecture.md) — product architecture.
- [`docs/editor-playout-workspace.md`](docs/editor-playout-workspace.md) —
  approved Editor/Playout master workspace, publishing, rundown and migration
  architecture.
- [`docs/architecture-review-compliance.md`](docs/architecture-review-compliance.md)
  — 35-point acceptance ledger.
- [`docs/renderer-control-architecture.md`](docs/renderer-control-architecture.md)
  — control/process boundaries.
- [`docs/render-daemon-architecture.md`](docs/render-daemon-architecture.md)
  — daemon/output/native planning.
- [`docs/rendering-engine.md`](docs/rendering-engine.md) — preview/native renderer
  state.
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
- [`docs/hardware-certification-template.md`](docs/hardware-certification-template.md)
  — external certification record.
- [`services/render-daemon/README.md`](services/render-daemon/README.md) — native
  service operation and protocol.
- [`packages/render-shaders/docs/shader-contract.md`](packages/render-shaders/docs/shader-contract.md)
  — GPU byte/layout/blend/colour contract.

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
14. Before moving repository paths or starting Playout, read
    `docs/editor-playout-workspace.md`; perform its Phase 0 checkpoint first.
15. Keep Playout independent from Editor lifecycle and never let Editor become
    authoritative for on-air Program state.
