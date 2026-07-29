# GrapiX Render Engine — Architecture Assessment and Required Change Report

Date: **2026-07-28**
Branch: `Basic-v0.2`
Baseline commit: `a387f5c` (Basic v0.1 checkpoint)

This document is the Phase 0 deliverable required before any engine separation
work. It records what the repository actually contains today, which parts are
reused unchanged, and which architectural properties are missing for a
Viz-Engine-class standalone renderer.

Companion documents:

- [`render-engine-architecture.md`](render-engine-architecture.md) — target
  architecture, contracts, protocol, stage/surface/virtual-canvas/tile design.
- [`render-engine-migration.md`](render-engine-migration.md) — phased migration
  plan and gates.

---

## 1. Current repository structure

Verified by inspection, not assumed.

```text
GrapiX/
├── apps/
│   ├── desktop-electron/      retained fallback shell
│   ├── desktop-tauri/         primary desktop supervisor (Rust, src-tauri)
│   └── editor-web/            React 18 + Vite editor (17.5k LOC TS/TSX)
├── packages/
│   ├── shared-types/          3,484 LOC — SceneDocument + all durable contracts
│   ├── renderer-protocol/     455 LOC — renderer control protocol v2
│   ├── render-shaders/        WGSL + layouts.json + shader manifest
│   └── grapix-sdk/            scene scripting SDK
├── services/
│   ├── api-server/            Fastify project/asset/package service (port 4100)
│   └── render-daemon/         Rust 1.87 + wgpu 26 native renderer (10,541 LOC)
├── Editor/                    workspace scaffold only (README + package.json)
├── Playout/
│   ├── apps/playout-web/      operator UI
│   └── services/playout-control/  playout control service
├── Shared/                    workspace scaffold only
└── tools/architecture/check-workspace-boundaries.mjs
```

Rust layout: there is **no root Cargo workspace**. `services/render-daemon` and
`apps/desktop-tauri/src-tauri` are independent crates with independent
`Cargo.lock` files. This is important — it means a new engine crate can be added
without restructuring or invalidating existing lockfiles.

## 2. Existing renderer files

### Browser renderers (`apps/editor-web/src/rendering/`)

| File | LOC | Role |
| --- | --- | --- |
| `GpuSceneRenderer.ts` | 1052 | PixiJS 8 2D renderer. Already initialises with `preference: "webgl"`. |
| `ThreeSceneLayer.ts` | 823 | Three.js depth-tested 3D layer (meshes, cameras, lights, glTF). |
| `PixiPreviewRendererAdapter.ts` | — | Adapts Pixi to the preview contract. |
| `ScenePreviewRenderer.ts` | 24 | The editor-preview seam interface. Explicitly documented as "never the authoritative Program output". |
| `RendererClient.ts` | — | Control boundary to the native renderer. Already separate from the preview seam. |
| `sceneMaterial.ts` | — | Resolves material slots/instances/assets to renderable descriptors. |
| `slabGeometry.ts` | 271 | Generated XPression-style Slab mesh. |

**Assessment: the browser-side separation is already correct.** `ScenePreviewRenderer`
(preview) and `RendererClient` (control) are distinct interfaces, and Pixi
construction is behind an adapter. Requirement 10 (PixiJS + WebGL preference) and
requirement 12 (no renderer objects in SceneDocument) already hold. No rewrite
is warranted here.

### Native renderer (`services/render-daemon/src/`)

| Module | LOC | Reuse verdict |
| --- | --- | --- |
| `scene/document.rs` | 1679 | **Reuse as-is.** Rust-side SceneDocument consumption. |
| `scene/mesh_prepare.rs` | 2174 | **Reuse as-is.** Off-thread mesh/material/texture preparation. |
| `protocol.rs` | 1180 | Keep for protocol v2 compatibility; engine adds v3 alongside. |
| `controller.rs` | 756 | Keep; engine has its own command surface. |
| `renderer/mesh.rs` | 695 | **Reuse as-is.** Mesh buffers and draw submission. |
| `config.rs` | 595 | Env-only. Engine needs TOML + CLI + env; new implementation. |
| `renderer/pipeline.rs` | 536 | **Reuse as-is.** Cached pipelines, blend/cull state. |
| `scene/lifecycle.rs` | 483 | **Reuse.** UNLOADED→…→FAILED residency vocabulary. |
| `transport/websocket.rs` | 454 | Pattern reused; engine transport is separate. |
| `resource.rs` | 296 | **Reuse.** Quality profiles and budget enforcement. |
| `asset_cache.rs` | 277 | **Reuse.** Content-addressed CPU/GPU cache accounting. |
| `media.rs` | 239 | **Reuse.** Media lifecycle, bounded frame queues. |
| `renderer/frame.rs` | 200 | **Reuse.** Frame representation and rational timing. |
| `renderer/text.rs` | 196 | **Reuse.** cosmic-text shaping and glyph compositing. |
| `output/*.rs` | 343 | **Reuse.** `VideoOutput` trait + null/recording/NDI adapters. |
| `renderer/gpu.rs` | 50 | Reuse for device creation; engine needs adapter selection and limit reporting on top. |

**Assessment: 10,541 lines of proven, tested native rendering code exists.** The
engine must build on it, not replace it. Rebuilding scene parsing, mesh
preparation, text shaping, or pipeline caching would discard 84 passing unit
tests plus GPU smoke, layout-contract, and scene-contract tests for no benefit.

## 3. SceneDocument schema

`SceneDocument` (`packages/shared-types/src/index.ts:1924`) is version `1` and
holds: `id`, `name`, `revision?`, `activeCameraId?`, `canvas`, `dataContext`,
`assets`, `materials`, `materialInstances?`, `shaders?`, `materialFolders?`,
`gradientPresets?`, `objects`, `timeline`, `fonts?`, `automation?`,
`createdAt`, `updatedAt`.

Object families: text, rect, ellipse, image, line, shape, paint, mesh, light,
camera, layer, marker, group.

**The critical gap is `SceneCanvas` (line 1111):**

```ts
export interface SceneCanvas {
  width: number;
  height: number;
  background: string;
  backgroundStyle?: ColorValue;
  editorViewport?: SceneViewportSettings;   // editor chrome only
}
```

This is a single flat pixel rectangle. There is **no** stage, surface, region,
viewport, camera-mapping, output-mapping, tile, render-scale, pixel-aspect, or
physical-measurement concept anywhere in the durable contract. Coordinates are
plain JavaScript `number` (IEEE-754 double, so precision is available, but there
are no precision-preserving operations and no documented large-coordinate rules).

`RendererPatch` (line 1950) supports exactly three incremental operations:
`PATCH_DATA_CONTEXT`, `PATCH_SCENE_PROPERTY`, `SET_VISIBILITY`. There is no
object create/delete patch, no layer-reorder patch, no material/asset/surface
patch, and no revision-gap or conflict handling.

## 4. Current PixiJS usage

`GpuSceneRenderer.ts:153` calls `app.init({ preference: "webgl", … })`. Pixi
renders text, rects, ellipses, images, lines, paths, gradients, masks, and the
six implemented blend modes. Three.js handles real 3D in a stacked canvas.
Editor authoring controls live in `CanvasStage.tsx` (1913 LOC) as a DOM/SVG
overlay above the canvases.

**Assessment: requirements 10, 11 and 23 are substantially satisfied already.**
Pixi is WebGL-first, overlays are separate from the graphics canvas, and Three.js
is a separate layer rather than being mixed into the Pixi scene graph. What is
missing is an explicit, testable renderer-preference policy (WebGL → opt-in
WebGPU → emergency Canvas) and tile/surface/camera-frame diagnostic overlays.

## 5. Existing WebSocket and API code

- `services/render-daemon/src/transport/websocket.rs` — the daemon is the
  WebSocket **server** on `ws://127.0.0.1:4200`, authenticated by a token file
  under `data/render-daemon.token`, with Origin checks.
- `packages/renderer-protocol` — protocol v2 envelope with `protocolVersion`,
  `requestId`, strictly increasing `sequence`, `timestampMs`,
  `expectedRendererState`, `sceneId`, `sceneRevision`, `channel`.
- `services/api-server` — Fastify REST on `:4100` for projects, scenes, assets,
  fonts, packages, design import, plus a renderer bridge.
- `Playout/services/playout-control` — owns its own renderer-protocol client.

**Assessment: the envelope discipline is good and the ordering/precondition
ideas carry directly into v3.** What v2 lacks: `messageId` (so duplicate
suppression is impossible), `engineId` and `projectId` (so multi-engine routing
is impossible), an explicit `requiresAck` flag, connection-lifecycle messages
(Hello/Authenticate/Capabilities/Disconnect as first-class messages rather than
implicit), asset messages, preview-stream messages, and a full playout verb set
(it has `channel.take` with `transition: "cut"` only — no Cue/Continue/Clear/
Replace/Unload).

## 6. Existing animation system

`packages/shared-types` owns the animation contract: `SceneTimeline` (fps +
duration), `PropertyChannel`/`PropertyKeyframe` with Bezier tangents,
`ANIMATABLE_PROPERTIES`, `sampleChannel`, `evaluatePropertyChannelsAtFrame`,
`evaluateObjectPropertiesAtFrame`, `evaluateSceneAtFrame`, plus
`interpolatePath` with a matched-vertex-count guard.

Evaluation is already **frame-based and pure** — `evaluateSceneAtFrame(scene, frame)`
returns a new SceneDocument. That is exactly the property needed for
browser/native determinism.

**Gap:** there is no rational frame clock. `SceneTimeline.fps` is a single
`number`, so 29.97 and 59.94 cannot be represented exactly at the contract level
(the daemon's `renderer/frame.rs` does use rational rates internally, so the
contract is weaker than the runtime). There are also no named markers, continue
points, or pause points in the timeline contract, and no transition-state model.

## 7. Existing asset management

- `AssetLibraryItem` with `AssetKind`, `AssetAvailability`
  (`READY`/`MISSING`/`IMPORTING`/`UNSUPPORTED`/`ERROR`), alpha mode, colour
  space.
- `services/api-server` performs content hashing, storage, validation,
  relinking, and `.gfxpkg` packaging with SHA-256 per file.
- `services/render-daemon/src/asset_cache.rs` does content-addressed CPU/GPU
  cache accounting with budgets.

**Assessment: strong foundation.** Gaps: no per-asset decode/GPU-upload state
machine exposed over the wire, no reference counting or last-used time in the
shared contract, no chunked/resumable upload protocol, and no scene-preparation
state (`Not loaded`/`Loading`/`Ready`/`Ready with warnings`/`Failed`) as a
first-class gate on taking a scene online.

## 8. Existing shader support

`packages/render-shaders` holds `wgsl/common/colour.wgsl`, `wgsl/common/uv.wgsl`,
`wgsl/composite_quad.wgsl`, `wgsl/materials/textured.wgsl`, `wgsl/mesh_pbr.wgsl`,
plus `layouts.json`, `manifests/shader-manifest.json` and a documented byte/blend/
colour contract with TypeScript↔Rust layout tests.

**Assessment: this already is the shared shader library the requirement asks
for.** The right move is to extend it — metadata, uniform/texture/sampler
declarations, capability requirements, validation, and safe fallback shaders —
and expose it under the requested `shader-library` name, not to create a second
parallel WGSL tree that would immediately drift.

## 9. Existing Playout work

`Playout/services/playout-control` has atomic file-backed persistence, immutable
monotonic published scene versions, rundown revision/autosave, connection health,
and its own renderer-protocol client. `Playout/apps/playout-web` has a scene
library, segmented rundown, Preview/Program monitors, connection state, timecode
display, and protected Cue/Take.

**Assessment: Playout already owns operational state and speaks only protocol to
the renderer.** It needs the wider command verb set and engine health/diagnostic
surfaces, not a redesign.

## 10. Current project resolution assumptions

Every resolution path in the repository assumes a single modest rectangle:

- `SceneCanvas.width`/`height` — one canvas, used directly as render size.
- `VideoProfile { width, height, frameRate, scanMode }` — output presets.
- `RendererOutputConfig { width, height, … }` — protocol v2 output size.
- `RendererResourceLimits.maxOutputWidth`/`maxOutputHeight` — profile caps.
- `RendererValidatedOutputConfig` — one validated output rectangle.

There is exactly **one** rectangle in the whole system, and stage size, render
size, and output size are the same number. Nothing distinguishes "how big the
logical stage is" from "how many pixels this output wants".

## 11. GPU texture-size assumptions

`RendererGpuStatus` reports `maxTextureDimension2d` and `maxBufferSize`, and
`RendererResourceLimits.maxTextureDimension` exists — so limits are *observed*,
but nothing *acts* on them for canvas sizing. The daemon renders the scene into
one off-screen texture sized to the output config (`renderer/gpu.rs` is
explicitly "renders into off-screen textures only").

**This is the hard blocker for the 50,000 × 50,000 requirement.** Typical desktop
`maxTextureDimension2d` is 16,384 (some hardware 32,768). A 50,000 × 50,000
BGRA8 surface is 50,000 × 50,000 × 4 = **10 GB** — larger than any consumer GPU's
VRAM and 3× over the maximum texture dimension. The current single-target design
cannot represent the requested stage, and must not be scaled up naively.

## 12. Code that should be reused

Reuse without modification:

1. `SceneDocument` and every contract in `packages/shared-types` — extended with
   optional fields only, per the frozen v1 compatibility rules.
2. The frame-based animation evaluator (`evaluateSceneAtFrame` and friends).
3. `packages/render-shaders` WGSL, layouts, and the byte-layout drift tests.
4. The PixiJS 8 WebGL editor renderer and the Three.js 3D layer.
5. The `ScenePreviewRenderer` / `RendererClient` seam separation.
6. The DOM/SVG authoring overlay in `CanvasStage.tsx`.
7. Native `scene/document.rs`, `scene/mesh_prepare.rs`, `scene/lifecycle.rs`,
   `renderer/mesh.rs`, `renderer/pipeline.rs`, `renderer/text.rs`,
   `renderer/frame.rs`, `asset_cache.rs`, `media.rs`, `resource.rs`,
   `output/*`.
8. Protocol v2 envelope discipline (version, request id, monotonic sequence,
   state precondition, revision gating).
9. `services/api-server` asset hashing, validation, and `.gfxpkg` v2 packaging.
10. `Playout/services/playout-control` persistence and operational ownership.
11. `tools/architecture/check-workspace-boundaries.mjs` as the boundary gate.

## 13. Architecture changes required

| # | Change | Reason |
| --- | --- | --- |
| C1 | Add a **virtual canvas / stage model** with f64 logical coordinates, origin, safe areas, regions, viewports, cameras, render scale, pixel aspect, and physical measurements. | `SceneCanvas` is one flat pixel rect; 50,000² cannot be expressed or reasoned about. |
| C2 | Add a **display-surface model** (LED wall, curved LED, projection, ribbon, scoreboard, multi-monitor, stadium, virtual production, irregular) with crop, UV, density, PAR, bezel, warp, edge blend, colour profile. | No physical-installation concept exists at all. |
| C3 | Add a **tile system**: grid, tile state, object→tile index, culling, dirty tracking, overscan for filters, seam-free compositing, LRU eviction. | A single render target cannot exceed GPU limits; tiling is the only way to render huge stages. |
| C4 | Separate **stage / canvas / surface / region / viewport / camera / output / output mapping** into distinct concepts. | Today all seven collapse into one width×height pair. |
| C5 | Introduce **protocol v3** with `messageId`, `engineId`, `projectId`, `requiresAck`, connection lifecycle, asset messages, preview-stream messages, and the full playout verb set. | v2 cannot deduplicate, cannot route to multiple engines, and has only `cut`. |
| C6 | Add an **engine connection state machine** (Offline → Discovering → Connecting → Authenticating → Synchronising → Preparing → Ready → On Air → Warning → Error → Recovering) with reconnect, heartbeat, timeout, retry, and full resync. | v2 has heartbeat only; there is no lifecycle model for a remote engine. |
| C7 | Add **capability negotiation** covering OS, CPU, GPU adapter, backend, VRAM estimate, max texture dims, max buffer size, texture/video formats, shader features, output adapters, max scenes, max logical canvas, tile support, headless support, hardware encode. | v2 `RendererCapabilities` is feature flags only, with no hardware limits usable for pre-publish validation. |
| C8 | Extend **incremental updates** to object create/delete, transform, text, material, animation, layer order, asset, surface, output mapping, publish, recall — with revision, timestamp, gap detection, duplicate suppression, and conflict detection. | Three patch types cannot express normal editing. |
| C9 | Add a **rational broadcast frame clock** to the shared contract (23.976/24/25/29.97/30/50/59.94/60/custom) plus markers, continue points, and pause points. | `SceneTimeline.fps: number` cannot represent 30000/1001 exactly. |
| C10 | Add **scene preparation states** and make taking an unprepared scene online require an explicit operator override. | No prepare gate exists today. |
| C11 | Create `services/render-engine` as an independently buildable, configurable, deployable binary driven by `engine.toml` + env + CLI, reusing the daemon's rendering core. | Requirement 1. The daemon is env-configured only and is supervised by the desktop shell rather than deployable standalone. |
| C12 | Add a **preview provider** that never sends full-stage pixels — scaled stage, requested viewport, or reduced-resolution tiles only. | A 50,000² preview frame is 10 GB. |
| C13 | Keep **output adapters behind a stable registry** with no hard-coded NDI/SDI resolutions. | Requirement 5. |
| C14 | Add **engine security**: auth tokens, TLS-ready transport, engine allowlist, file-path restriction, asset sandboxing, shader validation, message/upload size limits, rate limiting, audit log. | The daemon assumes loopback; a network engine cannot. |
| C15 | Make **engine identity** (`engineId`) first class and design for primary/backup, mirroring, failover, and region/surface/tile-based distribution without requiring it in phase 1. | Requirement 21. |

## 14. Explicit non-goals for this work

- Not rewriting the PixiJS or Three.js editor renderers.
- Not moving `apps/editor-web` into `Editor/` — that is the separately gated
  Phase 2 of the existing workspace migration
  ([`editor-playout-workspace.md`](editor-playout-workspace.md)).
- Not implementing NDI/SDI/DeckLink/AJA transmission — explicitly deprioritised
  behind scene loading, tile rendering, and remote communication.
- Not implementing warp/edge-blend *maths*; only the data model and renderer
  interfaces that will carry them.
- Not claiming distributed rendering. The architecture must permit it; phase 1
  does not ship it.
