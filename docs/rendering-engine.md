# GrapiX Rendering Engine

Material architecture, shared WGSL rules, alpha/blend behavior, and current
renderer support are documented in [material-system.md](./material-system.md).

## Current Direction

GrapiX uses a web-based desktop architecture:

```text
Electron desktop shell
  -> React editor UI
  -> GPU render viewport
  -> Shared scene model
  -> Local API / package services
```

The editor viewport now separates rendering from editing:

- PixiJS/WebGL renders scene pixels, images, SVG textures, video textures, text, and shapes.
- A lightweight SVG overlay handles editor interactions such as hit testing, selection, and dragging.
- The shared `SceneDocument` model remains the source of truth for both editor and renderer.

## Why This Architecture

- WebGL is the best immediate backend for a web-based Electron app because it is stable, GPU accelerated, widely supported, and compatible with heavy 2D broadcast graphics workloads.
- PixiJS provides texture caching, batched drawing, accelerated sprites, SVG rasterization via browser image decode, text rendering, and video texture support.
- Keeping interactions in an overlay prevents the renderer from being polluted with editor-only handles, hit zones, and selection UX.
- The rendering boundary can later move to OffscreenCanvas, a Web Worker, WebGPU, or a native renderer process without replacing the editor UI.

## Current Capabilities

- GPU canvas renders the scene background.
- Rectangles and ellipses render as GPU graphics.
- Text renders through the GPU renderer.
- Image objects render from images, SVG data URLs, and video sources.
- Object Library primitives render immediately: quads, spheres, lines, cube/cylinder/torus/slab/model placeholders, light symbols, camera symbols, layer frames, event markers, and groups.
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
- Add staged asset preloading before opening/taking scenes.
- Add texture eviction and media lifecycle policies.
- Add shader/filter support for broadcast effects.
- Replace mesh placeholders with a real Three.js/WebGPU scene layer for true 3D models, cameras, lights, and materials.
- Move rendering to OffscreenCanvas where supported.
- Add WebGPU backend exploration behind the same renderer interface.
- Add native renderer/output bridge later for NDI/SDI/program output.
