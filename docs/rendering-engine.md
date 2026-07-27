# GrapiX Rendering Engine

Material architecture, shared WGSL rules, alpha/blend behavior, and current
renderer support are documented in [material-system.md](./material-system.md).

## Current Direction

GrapiX uses a web-authored, native-output desktop architecture:

```text
Tauri desktop supervisor
  -> React editor UI
     -> ScenePreviewRenderer -> PixiJS editor preview
     -> RendererClient -> Fastify bridge
  -> Shared SceneDocument v1
  -> Rust/wgpu render daemon -> Program output
```

The editor viewport now separates rendering from editing:

- PixiJS/WebGL is contained behind `PixiPreviewRendererAdapter` and renders
  editor preview pixels, images, SVG textures, video textures, text, and shapes.
- A lightweight SVG overlay handles editor interactions such as hit testing, selection, and dragging.
- `SceneDocument` v1 remains the durable content source of truth.
- The native daemon, not the browser preview, is authoritative for Program
  state and output.

See [renderer-control-architecture.md](./renderer-control-architecture.md) and
[scene-document-v1.md](./scene-document-v1.md) for the process and contract
boundaries.

## Why This Architecture

- WebGL is a practical editor-preview backend because it is stable, GPU
  accelerated, and compatible with the existing 2D authoring workload.
- PixiJS provides texture caching, batched drawing, accelerated sprites, SVG rasterization via browser image decode, text rendering, and video texture support.
- Keeping interactions in an overlay prevents the renderer from being polluted with editor-only handles, hit zones, and selection UX.
- The preview boundary can move to OffscreenCanvas, a Web Worker, WebGPU, or a
  3D adapter without replacing editor feature components.

## Current Capabilities

- GPU canvas renders the scene background.
- Rectangles and ellipses render as GPU graphics.
- Text renders through the GPU renderer.
- Image objects render from images, SVG data URLs, and video sources.
- Object Library mesh primitives render as depth-buffered Three.js geometry in
  the editor; cube/slab faces, cylinder caps/sides, sphere/torus surfaces, and
  imported glTF material elements accept independent materials and textures.
- A scene's active perspective or orthographic camera now drives the Three.js
  mesh projection. Camera position, target, up vector, FOV/zoom, and clipping
  planes are live-editable; the synthetic editor camera is fallback-only.
- Directional, point, and spot scene lights now illuminate editor meshes with
  live colour/intensity/attenuation/cone/target controls and optional shadows.
  The fixed editor light rig is used only when no authored visible light exists.
- Solid and textured-unlit mesh materials intentionally ignore those lights;
  explicit Basic Lit and PBR materials opt into them. Native Program consumes
  the same three authored light kinds with the same zero-light/fallback policy
  and a deterministic 16-light Take gate.
- Layer/group objects are non-pixel transform containers. Their child
  transforms, depth, visibility, opacity, and lock state resolve recursively
  before PixiJS/Three.js submission, with invalid references diagnosed safely.
- Render order is explicit: objects sort by layer, z-depth, and z-index rather than accidental array order.
- Image fit modes support stretch, contain, and cover-style sizing.
- The renderer can play an explicitly configured video URL, but the central
  Material Manager video importer/metadata/shared-playback path is disabled
  until a shared decoder lifecycle is implemented.
- Solid and textured rectangle/image materials resolve shared definitions,
  instances, opacity, tint, UV scale/offset, and Normal/Add blending.
- The viewport reports GPU backend and max texture size in the stage toolbar.

## Next Rendering Steps

- Add renderer diagnostics panel: FPS, draw calls, texture count, VRAM estimate, dropped frames.
- Add render-quality profile controls: preview, program, UHD, and low-latency.
- Add lifecycle-managed scene warming before Preview and Take.
- Add texture eviction and media lifecycle policies.
- Add shader/filter support for broadcast effects.
- Port the editor's active-camera, shadow, and hierarchy-resolved camera/light
  transforms to the authoritative native mesh path.
- Move rendering to OffscreenCanvas where supported.
- Add WebGPU backend exploration behind the same renderer interface.
- Add Preview/Program channels and warm-scene LRU to the existing native
  renderer/output bridge.

## Native Program 3D path

The Rust daemon now renders actual triangle geometry with a depth attachment
and perspective camera. It natively tessellates cube/slab, sphere, cylinder,
and torus primitives, imports embedded glTF/GLB triangle primitives, preserves
authored glTF PBR base materials, and applies GrapiX whole-model or
per-material-element overrides. Image textures are decoded during scene warm
and uploaded into sRGB/linear GPU textures before the frame clock begins.
