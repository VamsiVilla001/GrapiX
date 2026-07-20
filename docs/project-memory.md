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

### 2026-07-18

- Added the XPression-style **Texture Coordinates** feature to the Material Manager: UV offset, UV scale, and UV rotation transform the texture; address mode (clamp/repeat/mirror-repeat) and filtering (linear/nearest) are real GPU sampler settings. The editor renders non-identity UV transforms through a Pixi `TilingSprite` (purpose-built for UV transforms + wrap); the default identity path keeps the plain sprite + fit-mode sizing so existing image rendering is untouched.
- Enabled the previously-disabled Wrap (repeat/mirror) and Filtering (nearest) inspector options; added a dedicated "Texture coordinates" panel (Offset X/Y, Scale X/Y, Rotation) editing `material.parameters` (where the renderer reads UV), and removed the duplicate uvScale/uvOffset entries from the generic parameter list. Relaxed the editor render guard and the shared-types resolver warnings so wrap/filtering no longer warn (only tile/nine-slice fit remain unimplemented).
- Verified in the packaged Electron app by extracting the preview renderer to PNG: UV scale 3 + repeat wrap renders an exact 3×3 tile grid; UV rotation 30° rotates the tiled pattern; no error banner. (Note: the imported `frame.png` couldn't override the Home Team Logo material's texture because that material is dynamic/data-bound — correct behaviour — so tiling was verified on the bound SOUL logo instead.)
- Committed the two provided sample assets (`materials/frame.png`, `materials/Mask.png`) with a README as import test fixtures (user-approved).
- Sampler settings are per-asset in the editor today (texture source shared by URL); true per-material samplers need a WebGPU bind group and are tracked with the daemon texture work. Tests: shared-types 13 pass (added a repeat/nearest-no-warning + tile-fit-still-warns test); editor typecheck+build clean.

### 2026-07-17

- Implemented six blend modes natively in **both** renderers as fixed-function GPU blending, using Adobe's standard blend-mode math where fixed-function-expressible: normal, add, multiply, screen, darken, lighten. `IMPLEMENTED_BLEND_MODES` in `@grapix/shared-types` is the single source of truth (inspector dropdown, editor render guard, and resolver warning all read it). The editor maps ids to PixiJS blend modes (darken→min, lighten→max); the daemon builds one cached wgpu pipeline per blend id via `blend_state_for_id`, mirroring PixiJS's premultiplied blend equations so preview and program output match. Per-mode colour/alpha equations recorded in `packages/render-shaders/layouts.json` (ids 0–5) and `shader-contract.md`.
- Clarified with the user that "Adobe's API" for blending is a misconception: Adobe blend modes are published math formulas (PDF/ISO-32000), not a service; a per-frame network call could never meet broadcast timing. Firefly Services stays deferred for asset generation per the render-daemon architecture doc. Overlay/subtract/alpha-mask remain unimplemented (need a shader compositing pass) and are refused with a warning — overlay is NOT aliased to screen.
- Verified all six modes in the live packaged Electron app by driving the Material Manager over CDP and extracting stage pixels: normal `[255,204,0]`, multiply `[7,9,0]`, screen `[255,206,18]`, darken `[7,11,0]` (exact per-channel min), lighten `[255,204,18]` (exact per-channel max), add `[255,215,18]` — all mathematically correct, no error banner.
- Imported the two real provided PNGs (`materials/frame.png`, `materials/Mask.png`) through the real import pipeline: content-hashed and stored under `data/assets/images/` with metadata records, shown in the Material Manager library with correct size/dimension metadata and **alpha auto-detected** (frame.png → alpha detected, straight). This is the XPression-style per-asset inspector the user wants to adapt.
- Tests: added a daemon `blend_states_match_pixi_equations` unit test (40 Rust tests pass) and a shared-types contract test asserting `IMPLEMENTED_BLEND_MODES` matches the `layouts.json` implemented set exactly (12 shared-types tests pass). Editor typecheck + build clean; nothing in the existing app regressed.
- Note: `data/` is gitignored so the imported asset files are local runtime artifacts. The source `materials/` folder is left untracked (user's working art; not committed without being asked).

### 2026-07-16

- Fixed three GPU viewport faults, diagnosed live against the packaged Electron app over the DevTools protocol:
  - Blank viewport (pre-existing on main): Pixi v8's `removeChildren()` returns children in reverse order, so the per-frame reparent re-added the full-canvas background quad last and painted it over every scene object. Reparent now preserves draw order.
  - Canvas overflow (pre-existing on main): Pixi's `autoDensity` writes inline `style.width/height` equal to the logical canvas size, beating the fitted stylesheet rule; only the scene's empty top-left corner was visible while the SVG interaction overlay scaled correctly. The renderer now re-asserts 100% sizing after mount/resize.
  - Undo crash (introduced with material previews): destroying a per-panel renderer with `app.destroy(true, ...)` released Pixi's global resource registry, clearing the shared `TexturePool` under the main viewport; its next Text destroy crashed in `returnTexture`. Per-panel renderers now destroy with `{ removeView: true }` only.
  - Also: the renderer error banner clears on the next successful render instead of poisoning the viewport until reload, and live renderers register on `window.__grapixRenderers` for debugging packaged builds.
- Verified after the fixes: the Lower Third Starter scene renders on screen with dynamic material bindings resolving (accent bar shows the bound team colour `#ffcc00`, name text the bound `#23c7d9`, bound SOUL logo and score) and stage-extract pixel samples matching expected values exactly; the create-material→undo repro leaves no error and identical pixels.
- Slimmed the top bar (34px, was 56px): removed the seven disabled placeholder buttons (menu, project/scene switchers, search, comments, help, settings), kept brand, working undo/redo, zoom, reset docks, Save, and Publish. The Ctrl+Z/Ctrl+Shift+Z handler stays in the top bar component.
- Renamed Scene Manager to **Scene Inspector** (dock panel id stays `scene-manager` so persisted layouts keep working). The panel header now shows the opened template (`Template 001: <name>`) and falls back to the scene name.
- Added layer management to the Scene Inspector, all history-integrated (undoable): move object to layer (per-row dropdown with `+ New layer`), move selected object to a new auto-named layer, inline layer rename (Electron has no `window.prompt`), delete layer (objects return to Main), and layer-level show/hide + lock/unlock for all objects in a layer. Layers remain implicit kebab-case slugs on objects; no schema change.
- Branch `feat/material-manager-and-render-daemon` carries this work; PR body prepared, opened manually (no `gh` CLI on this machine).

### 2026-07-15

- Scaffolded the native render daemon at `services/render-daemon`: Rust + wgpu headless renderer with a versioned WebSocket protocol (`scene.load`/`scene.update` as full `SceneDocument` replacement, `output.configure`/`start`/`stop`, `status`), rational frame rates (59.94 = 60000/1001), and explicit validation errors for unsupported broadcast modes (interlaced, straight alpha).
- v1 renders solid-color rects over the canvas background in editor render order; every unsupported object type is reported as a warning, never silently dropped.
- Created `packages/render-shaders`: shared WGSL shaders, machine-readable uniform layouts (`layouts.json`), blend-mode ids, and the colour/alpha/transform contract, to be consumed by both the daemon and the future browser WebGPU preview so preview and program output cannot drift.
- Added a TypeScript↔Rust scene contract: fixture typed against `SceneDocument` in `packages/shared-types/src/fixtures.ts`, emitted to JSON via `npm run fixtures:emit`, parsed by daemon tests; plus a byte-layout contract test against `layouts.json`.
- NDI output implemented behind a Cargo `ndi` feature via grafton-ndi (needs local NDI SDK; untested here); null output backend runs everywhere. Output abstraction is a `VideoOutput` trait so the renderer is not coupled to one NDI crate.
- `services/api-server` gained optional `/api/render-daemon/*` bridge routes (503 when the daemon is down) using Node 22's built-in WebSocket client; daemon remains fully optional.
- Hardened the bridge with a generated per-install authentication token, WebSocket Origin checks, server-side API Origin enforcement, bounded 1–240 fps validation, and interruptible frame waits for prompt stop/shutdown.
- MCP/Figma/Adobe integration explicitly deferred and ordered in `docs/render-daemon-architecture.md` (GrapiX's own MCP server first, then Figma Dev Mode MCP, then Adobe Firefly Services MCP; imported assets must flow through the normal asset/render pipeline).
- Landed the Material Manager v1 (`apps/editor-web/src/modules/material-manager`): dockable panel with search/filter/grid+list library, image and WGSL import with content-hashed external storage under `data/assets` (no binaries in scene JSON), solid/textured materials with opacity, tint, UV scale/offset and Normal/Add blending, shared materials plus one-level instances with parameter overrides, compatibility-checked assignment (canvas drop, scene tree, inspector), Find Usage with deletion protection, missing-asset badges with undo-safe relinking, and scene-history undo/redo. Unsupported source types (video, sequences, live inputs, fonts, render textures) are visibly marked planned/disabled. Docs in `docs/material-system.md`; sample at `samples/material-manager-v1.scene.json`.
- Dependency security refresh in its own commit (npm audit: 8 advisories, all requiring majors): Electron 31→43, Vite 5→8 (+plugin-react 6), Fastify 4→5 (+cors 11), Node engine ≥22.12. Zero vulnerabilities after; build, Electron launch, and API serving verified.

### 2026-07-14

- Began the next editor-workspace architecture step with real dock tab stacks.
- Dock layout persistence moved from a flat panel list to stack-aware layout storage with automatic migration from the previous `grapix-dock-layout-v1` format.
- Default docking now groups Templates and Object Library into a left browser stack, keeps Scene Manager as its own left stack, and preserves Properties and Timeline in their primary work zones.
- Dock panels now expose active tabs, tab switching, drag-to-stack behavior, and active-panel movement between left, right, and bottom dock areas.

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
