# GrapiX Project Memory

This file records the working memory for GrapiX so product and engineering decisions survive across sessions.

## Source Architecture

Primary architecture note supplied by the user, updated:

`D:\Player Images\broadcast_graphics_architecture_flow(1).md`

Current UI-first build plan supplied by the user:

`D:\Player Images\xpression_style_ui_first_build_plan.md`

## Product Direction

GrapiX is a flagship broadcast graphics product with three major surfaces:

- Graphics Editor
- Sequencer / Playout Controller
- Real-Time Renderer

Recommended architecture:

```text
React / TypeScript UI
        -> Tauri Desktop Shell
        -> Native C++ / Rust Renderer
        -> NDI / SDI / Preview Output
```

The product should feel web-like for designers and operators, while the renderer behaves like broadcast hardware software.

## Differentiators To Protect

- Strong scene package format
- First-class data binding model
- Frame-safe live patch runtime
- Native-grade output adapters
- Reliable sequencer workflow

## Build Phases

0. Asset ingestion and Material Manager: import Photoshop/Figma/media/font sources, convert them into Asset Library entries, create render-ready Materials, assign Material Slots to scene objects, and preload dynamic materials before Take.

1. Web Editor MVP: canvas, property panel, save/load scene JSON, text/image/shape objects, basic animation foundation.
2. Binding System: schema panel, manual JSON data source, property bindings, preview bound data, validation.
3. Sequencer MVP: rundown, template browser, preview/program, take in/out, layer selection, data overrides.
4. Native Renderer MVP: scene loader, text/image rendering, timeline playback, patch updates, preview window.
5. NDI Output.
6. SDI Output.
7. Distributed render nodes.

## Current Implementation

- Monorepo scaffolded with npm workspaces.
- Phase 1 starts with `apps/editor-web`.
- Shared scene model starts in `packages/shared-types`.
- Current UI direction is XPression-inspired professional broadcast software: fixed editor viewport/canvas, dockable surrounding modules, scene/template browser, scene manager, properties, timeline, package publishing, and status bar.
- First UI priority is a strong editor shell and scene/object/material workflow, not native rendering, NDI, SDI, real playout, auth, cloud sync, or distributed render nodes.
- The updated roadmap moves asset ingestion before the full editor.
- First canvas implementation uses SVG for quick editable object manipulation and JSON scene persistence.
- Scene documents now include an Asset Library, Material Manager entries, and per-object Material Slots.
- Dynamic materials are part of the MVP direction: data can resolve a material to an asset or color before the renderer swaps at a safe frame boundary.
- Editor can publish a first `.gfxpkg` zip containing `manifest.json`, `scene.json`, `materials.json`, `bindings.json`, `timeline.json`, and bundled data-URI assets.
- Package preflight checks material readiness, missing material slots, and fallback-ready material warnings before publish.
- Backend work must now move in parallel with UI work whenever the feature touches product state, package publishing, asset ingestion, validation, or renderer-facing data.
- `services/api-server` is a real Fastify backend with scene save/list/load, package preflight, and backend `.gfxpkg` publishing into local `data/` storage.
- Editor top bar calls the backend for save, preflight, and package publish, with browser-side package download retained as fallback.
- Native renderer, Tauri shell, backend services, and package compiler are future phases.

## Build Log

### 2026-07-05

- Shifted the app into the XPression/After Effects style editor direction: the viewport is the fixed center anchor, while surrounding modules can be resized and docked.
- Added dockable workspace infrastructure for Templates, Scene Manager, Properties, and Timeline.
- Dock layout can move panels between left, right, and bottom dock areas by drag/drop or dock buttons.
- Multiple panels inside the same dock area are resizable against each other.
- Dock layout persists in `localStorage`.
- Removed earlier cluttered top navigation/layout tabs and the left icon rail so the whole screen behaves as the design/editor workspace.
- Reworked the Templates module into a plain scene/template browser without categories.
- Templates panel starts empty; clicking `+ New` appends a new empty template below existing scenes and opens it in the editor.
- Each scene/template now has two editable fields: Name and numeric ID.
- Scene IDs are normalized as padded numeric IDs such as `001`, `002`, `003`; generated hash-style IDs were removed from the UI.
- Template cards show real SVG previews generated from the scene canvas and objects, preserving aspect ratio and video profile information.
- Added selected-template deletion from the Templates header and Delete key.
- Added favorite/star toggling on template cards.
- Kept the Ross XPression-style right-click context menu for scene/template operations: New, To Sequencer, Edit Script Events, Edit Visual Logic, Duplicate, Rename, Change ID, Convert Dimensions, Detach from Parent, Export Scene, Regenerate All Thumbnails, Delete.
- Added an XPression-style `View` menu in Templates with `Thumbnails` and `List` modes.
- Template view mode persists in `localStorage`; Thumbnail mode shows preview cards and List mode shows compact rows.
- Scene Manager controls now perform real actions for visibility, lock/unlock, duplicate, delete, and object selection.
- Locked objects remain visible/selectable but are not draggable on the canvas.
- Inspector exposes object visibility and lock controls alongside editable properties.
- Timeline has a real frame-aware store with play/pause, current frame, object tracks, keyframe creation, and click-to-seek basics.
- Backend and UI are being developed in parallel: Fastify API supports scene save/list/load, preflight, and backend `.gfxpkg` publishing into local `data/` storage.
- Started native desktop direction with `apps/desktop-electron`: Electron wraps the existing web editor, loads the built Vite app, and starts/uses the local Fastify API service.
- Desktop direction remains web-based: React UI plus future WebGL/WebGPU renderer viewport inside Electron, with native access used for files, project IO, multi-window previews, and later output bridges.
- Electron is now the primary workspace surface: root `npm run dev` launches the desktop app, while `npm run dev:web` remains for browser-only debugging.
- The Fastify API can now start in-process from Electron through exported API server functions, instead of relying on a separate spawned Node process.
- Added the first GPU rendering engine pass using PixiJS/WebGL: the viewport now renders scene pixels through a GPU canvas while preserving an SVG editor overlay for selection and drag interactions.
- Rendering support now includes GPU shapes, text, images, SVG-backed image textures, imported video assets/materials, video textures, texture caching, cover/contain/stretch image fitting, and basic renderer capability reporting.
- Added the first functional XPression-style Object Library module as a dockable panel: Base Objects, Mesh Objects, Primitives, Lights, Cameras, Layers, Markers, and Misc.
- Object Library entries now create real selected scene objects instead of disabled placeholders, including text, background, quads, sphere/ellipse, line strips, mesh primitive placeholders, light controls, camera controls, layer frames, event markers, and groups.
- Shared scene types now include line, mesh, light, camera, layer, marker, and group object families.
- GPU renderer now draws the new object families as renderable editor/runtime symbols, giving every Object Library item immediate viewport feedback.
- Scene Manager now owns an XPression-style layer stack: objects have `layerId`, `zIndex`, and `zDepth`; the GPU renderer/template previews sort by layer/depth/index; the panel exposes stack movement, material assignment, visibility, lock, duplicate, delete, and z-depth editing.
- Latest verification passed with `npm run typecheck` and `npm run build`.

## Naming

- Product: GrapiX
- Scene package extension: `.gfxpkg`
- Shared package namespace: `@grapix/*`

## Near-Term Next Steps

- Add true tabbed docking stacks, floating panels, drop-position indicators, and ordered panel insertion.
- Add Electron packaging, app icons, installer config, native file dialogs, and project open/save IPC.
- Add renderer diagnostics: FPS, draw calls, texture count, VRAM estimate, dropped frames, and media preload readiness.
- Expand every visible button/icon into real module behavior instead of placeholder alerts.
- Expand Asset Library import support for PNG/JPG/SVG/fonts and persist imported assets.
- Add Material Manager editing, dynamic binding controls, and readiness states.
- Build first Photoshop/Figma import package converter interfaces.
- Make editor canvas comfortable for lower-thirds and scorebug design.
- Add schema-aware binding validation.
- Add timeline/keyframe model and animation preview.
- Add scene package publisher.
- Add sequencer MVP using the same shared scene and binding model.
