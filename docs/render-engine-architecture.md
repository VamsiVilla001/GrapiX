# GrapiX Standalone Render Engine — Target Architecture

Companion to [`render-engine-assessment.md`](render-engine-assessment.md) (what
exists) and [`render-engine-migration.md`](render-engine-migration.md) (how we
get there).

This document defines the target architecture: process separation, contracts,
the virtual canvas, the tile renderer, the stage/surface model, and the engine
protocol.

---

## 1. Product separation

GrapiX splits into three product-level applications, in the same relationship as
Viz Artist / Viz Trio / Viz Engine and Ross XPression Designer / Sequencer /
Engine.

```text
GrapiX Master Project
├── Editor            authoring. Produces SceneDocument + StageDocument.
├── Playout           operations. Sends commands. Owns rundown and on-air state.
└── Render Engine     rendering. Owns all GPU state and Program output.
```

Hard rules:

1. The Editor and Playout **never** touch renderer internals. All contact is via
   `@grapix/render-protocol` messages.
2. The Editor's only authority is scene *content*. It does not decide what is
   on air.
3. Playout's only authority is *operations*: Load, Prepare, Cue, Take, Continue,
   Update, Stop, Clear, Replace, Transition, Unload.
4. The engine is authoritative for Program. Closing the Editor or Playout must
   not disturb a rendering Program scene.
5. The engine depends on no React, Electron, PixiJS, or DOM API.

## 2. Deployment modes

One binary, `grapix-render-engine`, covers every mode. Mode is configuration,
not a code path.

| Mode | Transport | Notes |
| --- | --- | --- |
| Local embedded | IPC (named pipe / UDS) | Started and supervised by the desktop shell. |
| Local external process | IPC or `ws://127.0.0.1` | Survives editor restarts. |
| Remote network engine | `ws://` or `wss://` | Requires auth token; TLS-ready. |
| Dedicated GPU engine | `wss://` | `preferred_gpu` pins the adapter. |
| Headless server engine | `wss://` | `headless = true`, no window, no surface. |
| Multiple render nodes | `wss://` per node | Distinct `engine_id`; region/surface/tile assignment. |

```bash
grapix-render-engine --config engine.toml
grapix-render-engine --config engine.toml --bind 0.0.0.0 --port 4300 --headless
GRAPIX_ENGINE_PORT=4300 grapix-render-engine --config engine.toml
```

Precedence: **CLI argument > environment variable > TOML file > built-in default.**

## 3. Package and service layout

```text
packages/
  shared-types/         existing — SceneDocument, objects, materials, animation
  scene-model/          NEW — scene separation, revisions, incremental patches
  renderer-contracts/   NEW — RendererBackend, RenderGraph, SceneRuntime, …
  render-protocol/      NEW — engine protocol v3 + EngineConnection client
  shader-library/       NEW — metadata/validation over packages/render-shaders
  animation-engine/     NEW — rational broadcast frame clock + frame evaluation
  asset-manager/        NEW — asset state machine, content addressing, upload
  stage-model/          NEW — virtual canvas, regions, viewports, cameras
  surface-model/        NEW — physical display surfaces and output mapping
  tile-system/          NEW — tile grid, culling, dirty tracking, overscan
  output-contracts/     NEW — output adapter descriptors, formats
  renderer-protocol/    existing — protocol v2, retained for compatibility
  render-shaders/       existing — WGSL sources and byte layouts
  grapix-sdk/           existing

apps/
  editor-web/           existing React editor (Pixi + Three + SVG overlay)
  desktop-electron/     existing fallback shell
  desktop-tauri/        existing primary shell

services/
  api-server/           existing project/asset/package service
  render-daemon/        existing native renderer — becomes the engine's core lib
  render-engine/        NEW standalone engine binary
```

`services/render-engine` depends on the existing daemon crate under the alias
`grapix-render-core`. That reuses 10,541 lines of tested scene parsing, mesh
preparation, text shaping, pipeline caching, asset caching, and output adapters
without moving a file or invalidating a lockfile. The engine adds only what is
genuinely new: virtual canvas, tiles, render graph, protocol v3, configuration,
capabilities, preview, diagnostics, security.

## 4. Virtual canvas design

### 4.1 The core idea

A stage is a **logical coordinate space**, not a framebuffer. Nothing in the
architecture ever allocates a texture the size of the stage.

```text
Stage (logical, f64, up to 50,000 × 50,000)
  └── Regions            named logical rectangles
  └── Viewports          what a camera looks at
  └── Surfaces           physical display geometry placed on the stage
        └── Output mappings   surface → output device rectangle
  └── Tile grid          how the stage is decomposed for rendering
        └── Tiles        the only things that become GPU render targets
```

### 4.2 Precision

Scene and stage coordinates are **f64** (`number` in TypeScript is already IEEE-754
double; Rust uses `f64` explicitly). At 50,000 units the double spacing is about
7.3 × 10⁻¹² — twelve orders of magnitude finer than a pixel, so absolute
positions are exact for all practical purposes.

The precision risk is not storage, it is **accumulated transform error in f32**.
GPUs consume f32, where spacing at 50,000 is about 0.0039 px — already visible
jitter, and much worse after a chain of multiplications.

The rule, enforced by `stage-model`:

> Never hand absolute stage coordinates to the GPU. Subtract the tile (or
> viewport) origin in f64 **first**, then narrow to f32.

```text
world_f64  ──subtract tile origin (f64)──►  local_f64  ──narrow──►  local_f32  ──► GPU
```

For a 2048-wide tile, local coordinates stay under 2048, where f32 spacing is
1.2 × 10⁻⁴ px. `stage-model` exposes `toTileLocal` / `toViewportLocal` and both
TypeScript and Rust have tests asserting that a 49,999.5 coordinate survives the
round trip to sub-thousandth-pixel accuracy, and that the naive f32 path does
not.

### 4.3 Stage document

```ts
interface StageDocument {
  stageId: string;
  name: string;
  version: 1;
  canvas: VirtualCanvas;        // logical size, origin, render scale, PAR
  safeAreas: StageSafeArea[];
  regions: StageRegion[];
  viewports: StageViewport[];
  cameras: StageCameraMapping[];
  surfaces: DisplaySurface[];   // from surface-model
  outputs: OutputTarget[];
  outputMappings: OutputMapping[];
  tiling: TileGridConfig;
  physical?: PhysicalStageMeasurements;  // millimetres, real-world size
}
```

`StageDocument` is separate from `SceneDocument`. A scene is content; a stage is
where content lives. Many scenes share one stage. `SceneDocument` gains one
optional field, `stageId`, preserving v1 compatibility.

## 5. Stage resolution vs output resolution

These are unrelated numbers and the architecture keeps them unrelated.

```text
Logical stage: 50,000 × 10,000

  Output A  ── region  left:    (0,      0) 3840 × 2160  → 3840 × 2160 device
  Output B  ── region  centre:  (23080,  0) 3840 × 2160  → 3840 × 2160 device
  Output C  ── region  right:   (46160,  0) 3840 × 2160  → 3840 × 2160 device
  Operator preview ── whole stage, render scale 0.0384 → 1920 × 384
  Recording ── whole stage, tiled, assembled off-GPU
```

Seven distinct concepts, never conflated:

| Concept | Meaning |
| --- | --- |
| **Stage** | The installation. Logical coordinate space + physical measurements. |
| **Canvas** | The logical pixel extent of the stage, with origin, render scale, PAR. |
| **Surface** | A physical display placed on the stage (LED wall, projector, ribbon). |
| **Region** | A named logical rectangle. Authoring and routing convenience. |
| **Viewport** | What is looked at: a logical rect plus a render scale. |
| **Camera** | How it is looked at: projection, transform, and target viewport. |
| **Output** | A device that wants pixels at its own resolution and frame rate. |
| **Output mapping** | Source (region/surface/viewport/full stage) → one output, with fit, rotation, crop. |

## 6. Tile-based rendering

### 6.1 Grid

```ts
interface TileGridConfig {
  tileWidth: number;   // 512 | 1024 | 2048 | user-defined
  tileHeight: number;
  overscan: number;    // padding in logical px for filters
  maxResidentTiles: number;
  cacheBudgetBytes: number;
}
```

Tile identity is derived, never stored: `tileId = "t:<col>:<row>"` for a given
grid. A 50,000 × 50,000 stage at 2048² is 25 × 25 = 625 tiles — a tractable
number. At 512² it is 98 × 98 = 9,604 tiles, which is why tile selection must be
index-driven rather than a full scan.

### 6.2 Tile state

Every tile tracks: `tileId`, logical bounds (f64), active object ids, dirty
state, render state, GPU resource state, cache state, last-rendered frame, and
output references — exactly as required.

```text
render state:  Idle → Queued → Rendering → Rendered → Failed
gpu state:     None → Allocating → Allocated → Released
cache state:   Cold → Warm → Hot → Evicted
```

### 6.3 Selection

A tile renders only if it is in the union of:

- visible in an active viewport,
- dirty since its last render,
- required by an active output mapping,
- required by a pending preview request,
- required by an in-progress export.

Everything else is culled. Selection is driven by an **object → tile index**
maintained incrementally: when an object's bounds change, only the tiles it left
and the tiles it entered are touched.

### 6.4 Seams and overscan

An object crossing a tile boundary renders in *every* tile it overlaps, each time
clipped to that tile's bounds plus overscan. Because each tile uses the same f64
world transform and only differs by its origin subtraction, the geometry lands on
exactly the same world position in each tile — no seam.

Filters need pixels from outside the tile. Overscan is computed per tile from the
filters of the objects present:

```text
required_overscan = max over objects in tile of filter_extent(object)

filter_extent:
  gaussian blur σ      → ceil(3σ)
  box blur radius r    → r
  drop shadow          → ceil(3σ) + |offset|
  glow                 → ceil(3σ) + spread
```

Tiles are rendered at `bounds` expanded by their required overscan, and composited
using only the inner `bounds` rectangle. The overscan ring is sampled, never
written to the output. That is what makes the composite seam-free.

## 7. Multi-surface stage mapping

```ts
interface DisplaySurface {
  surfaceId: string;
  name: string;
  kind: "led-wall" | "curved-led" | "projection" | "ribbon" | "scoreboard"
      | "multi-monitor" | "stadium" | "virtual-production" | "irregular";
  position: StagePoint;          // logical, f64
  size: StageSize;               // logical, f64
  rotationDegrees: number;
  crop?: StageRect;
  uvMapping: SurfaceUvMapping;   // how stage pixels map onto the surface
  outputId?: string;
  pixelDensity: number;          // logical px per physical mm
  pixelAspectRatio: number;
  bezel?: BezelCompensation;     // multi-monitor gaps
  warp?: SurfaceWarp;            // grid / mesh / curvature — data model only
  edgeBlend?: EdgeBlend;         // projector overlap — data model only
  colorProfileRef?: string;
}
```

Warp and edge-blend **maths** are deliberately not implemented yet. The data
model and the renderer interfaces carry them now so that adding calibration
later is not an architecture change.

## 8. Engine protocol v3

### 8.1 Envelope

Every message, in both directions:

```ts
interface EngineEnvelope {
  protocolVersion: 3;
  messageId: string;         // unique per message; enables duplicate suppression
  requestId: string | null;  // correlates a reply to its request
  engineId: string | null;
  projectId: string | null;
  sceneId: string | null;
  sceneRevision: number | null;
  timestampMs: number;
  type: EngineMessageType;
  requiresAck: boolean;
  sequence: number;          // strictly increasing per connection, per direction
}
```

Retained from v2: monotonic sequence, revision gating, explicit nullability.
Added: `messageId` (dedupe), `engineId` (multi-engine routing), `projectId`
(permission scope), `requiresAck` (explicit rather than inferred).

### 8.2 Message groups

| Group | Messages |
| --- | --- |
| Connection | `Hello`, `Authenticate`, `Heartbeat`, `Capabilities`, `Disconnect` |
| Scene | `LoadScene`, `UnloadScene`, `FullSceneSync`, `ApplyScenePatch`, `ValidateScene`, `PrepareScene` |
| Assets | `RegisterAsset`, `UploadAsset`, `ValidateAsset`, `PreloadAsset`, `ReleaseAsset` |
| Playout | `Cue`, `TakeOnline`, `TakeOffline`, `Continue`, `Update`, `Stop`, `Clear`, `Replace`, `Transition` |
| Preview | `RequestPreview`, `StartPreviewStream`, `StopPreviewStream`, `SetPreviewViewport` |
| Engine | `GetStatus`, `GetDiagnostics`, `GetCapabilities`, `SetConfiguration`, `RestartRenderer` |

### 8.3 Engine connection state machine

```text
Offline ─► Discovering ─► Connecting ─► Authenticating ─► Synchronising
                                                              │
                                              ┌───────────────┘
                                              ▼
                                          Preparing ─► Ready ─► OnAir
                                              │          │        │
                                              └──────────┴────────┴─► Warning
                                                                 └─► Error ─► Recovering ─► Connecting
```

Reconnection uses exponential backoff with jitter. On reconnect the client
compares its scene revisions against the engine's; any gap triggers
`FullSceneSync` rather than a patch stream.

### 8.4 Reliability rules

- Duplicate `messageId` within the dedupe window is acknowledged and ignored.
- A patch whose `baseRevision` does not match the engine's current revision is
  rejected with `REVISION_MISMATCH`, and the client must full-sync.
- Commands are applied in `sequence` order; a gap parks later messages briefly
  and then forces resync rather than applying them out of order.
- Every `requiresAck` message is retried with backoff until acknowledged or the
  attempt budget is exhausted.

## 9. Capability negotiation

At `Hello`/`Capabilities` the engine reports OS, CPU, GPU adapter, backend, VRAM
estimate, max texture dimensions, max buffer size, supported texture formats,
supported video formats, shader features, output adapters, max active scenes,
**max logical canvas**, tile-rendering support, headless support, and hardware
encoding support.

The Editor and Playout use this to warn *before* publishing. Concretely: a stage
whose logical canvas exceeds `maxLogicalCanvas`, or whose configured tile size
exceeds `maxTextureDimension2d`, is a publish warning, not a runtime surprise.

## 10. Renderer contracts

Named interfaces, implemented natively in Rust and mirrored as TypeScript types
so the browser preview and the engine are held to the same shape:

`RendererBackend`, `RenderGraph`, `SceneRuntime`, `SceneAdapter`, `RenderNode`,
`RenderPass`, `OutputAdapter`, `FrameClock`, `AssetProvider`, `TextRenderer`,
`VideoProvider`, `TransitionController`, `TileManager`, `ViewportManager`,
`SurfaceMapper`, `PreviewProvider`.

`SceneDocument` stores none of these. It stores no PixiJS objects, no React
components, no DOM elements, no wgpu resources. Adapters convert SceneDocument
into PixiJS display objects (browser), wgpu render nodes (engine), preview
representations, and output render passes.

## 11. Broadcast frame clock

Frame rates are **rational**, never floats:

| Rate | Numerator / Denominator |
| --- | --- |
| 23.976 | 24000 / 1001 |
| 24 | 24 / 1 |
| 25 | 25 / 1 |
| 29.97 | 30000 / 1001 |
| 30 | 30 / 1 |
| 50 | 50 / 1 |
| 59.94 | 60000 / 1001 |
| 60 | 60 / 1 |
| custom | any positive pair |

Frame deadlines use integer arithmetic: `deadline_ns(n) = n · 1e9 · den / num`,
which cannot drift. `requestAnimationFrame` is used only to pace the editor's
interactive preview; it is never the authority for a rendered frame.

Animation state is a pure function of `(sceneRevision, frame)`. That is the
determinism contract that makes browser preview and native rendering agree, and
makes the same frame reproducible across engines.

## 12. Preview and Program

| Channel | Authority | Quality |
| --- | --- | --- |
| Editor | local browser renderer | interactive |
| Engine Preview | engine | independent from Program |
| Program | engine, changed only by Playout commands | authoritative |
| Auxiliary | engine | per-output |

Preview never sends the full stage. `RequestPreview` must name one of: a scaled
whole-stage view, a viewport, a region, a surface, or a tile set. The engine
rejects a preview request whose decoded size exceeds a configured budget.

## 13. Security

Remote deployment requires: bearer auth tokens, TLS-ready transport, project-scoped
permissions, an engine allowlist, file-path restriction to configured roots,
asset sandboxing, shader validation, message-size limits, upload-size limits,
rate limiting, and an audit log.

Absolute rule: a remote client can never supply an unrestricted filesystem path,
and can never cause arbitrary shader or OS code to execute. Asset paths are
resolved only inside configured roots, and every resolved path is re-checked
after canonicalisation to defeat `..` traversal and symlink escape.

## 14. Distributed readiness

Not shipped in phase 1, but not designed out:

- Every engine has a unique `engineId`.
- Rendering is deterministic in `(sceneRevision, frame)`, so two engines given
  the same inputs produce the same output.
- Tiles, regions, and surfaces are addressable units of work, so a node can be
  assigned a subset.
- Scene and asset state is content-addressed, so replication is a cache fill.

Primary/backup, mirroring, failover, and load balancing are therefore
configuration and orchestration problems layered on this model, not rewrites.
