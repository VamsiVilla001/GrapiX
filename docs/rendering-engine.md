# GrapiX Editor viewport (browser preview)

> **V1 authority note (2026-07-29):** this document describes the **Editor's
> browser viewport as it exists today**, not the target. [`architecture.md`](architecture.md)
> is authoritative: the native Render Engine is the only implementation that
> rasterizes production scene pixels, and milestone M2 replaces this browser
> path with a native Editor Render View. Until then the viewport below is what
> an author actually sees, and its divergence from Program is a known risk
> rather than an accepted design.

Material architecture, shared WGSL rules, alpha/blend behavior, and current
renderer support are documented in [material-system.md](./material-system.md).

## What the viewport is today

```text
React editor UI
  -> ScenePreviewRenderer -> PixiJS 2D preview  (rects, ellipses, text, images)
  -> ThreeSceneLayer      -> depth-tested 3D meshes, cameras, lights
  -> SVG overlay          -> hit testing, selection, dragging
  -> engineClient         -> protocol v3 -> render engine (panel, diagnostics)
  -> SceneDocument v1     -> durable content source of truth
```

- PixiJS/WebGL is contained behind `PixiPreviewRendererAdapter` and renders
  preview pixels, images, SVG textures, video textures, text and shapes.
- A lightweight SVG overlay handles interactions, so the renderer is never
  polluted with editor-only handles, hit zones and selection UX.
- `SceneDocument` v1 remains the durable content source of truth.
- The engine, never the browser preview, is authoritative for Program state and
  output. The Editor holds no Program or output authority at all.

## Why it is built this way, and why it is temporary

WebGL is a practical *preview* backend: stable, GPU accelerated and compatible
with the existing 2D authoring workload. Pixi supplies texture caching, batched
drawing, SVG rasterization via browser image decode, text rendering and video
textures.

What it cannot do is guarantee that authored pixels match Program. Two renderers
reading the same JSON drift — different blending, colour math and transform
rounding — which is why the shared WGSL contract exists and why M2 moves
authoring onto the native renderer through a Render View. The preview boundary is
kept behind one interface precisely so that swap is not a feature rewrite.

See [scene-document-v1.md](./scene-document-v1.md) for the durable content
contract and [render-engine-architecture.md](./render-engine-architecture.md)
for the native renderer this path is converging on.

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

## What is deliberately not planned here

Items that once sat on this document's roadmap now belong to the engine, because
the Editor is not getting a second production renderer: render-quality profiles,
scene warming, texture eviction and media lifecycle, broadcast effect shaders,
Preview/Program channels and the warm-scene LRU are all engine concerns and are
specified in [render-engine-architecture.md](./render-engine-architecture.md).

What remains genuinely viewport work, until the native Render View lands:

- viewport diagnostics an author can act on — FPS, draw calls, texture count;
- OffscreenCanvas where supported, to keep interaction responsive;
- keeping the Pixi and Three layers behind one `SceneRenderer` interface so the
  Render View replaces them without touching feature components.

## Native Program 3D path

The render core renders actual triangle geometry with a depth attachment and
perspective camera. It natively tessellates cube/slab, sphere, cylinder and
torus primitives, imports embedded glTF/GLB triangle primitives, preserves
authored glTF PBR base materials, and applies GrapiX whole-model or
per-material-element overrides. Image textures are decoded during scene warm and
uploaded into sRGB/linear GPU textures before the frame clock begins.

Editor-versus-Program parity for that path is measured, not assumed — see
[pixel-parity.md](./pixel-parity.md).
