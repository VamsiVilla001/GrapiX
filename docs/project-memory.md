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
- Tauri, Fastify project services, strict package compiler, and the native
  Rust/wgpu renderer now exist; native text/general 2D image/video/effect
  coverage and certified output hardware remain future phases.

## Build Log

### 2026-08-02 — AE-style keyframing made usable in the Scene Inspector

**Root cause of "I cannot add keyframe":** the per-property stopwatch already existed and was correctly wired to `setPropertyAnimationEnabled`, but its CSS was `opacity: 0`, revealed only on `.scene-transform-cell:hover`. The control was invisible, so keyframing was undiscoverable — not missing.

- **Stopwatch is now always visible** (`opacity: 1`), tokenised (`--text-faint` idle → `--accent` when animating, replacing hardcoded `#536173` / `#d86aff`), with a hover state.
- **Added an AE-style key toggle (diamond)** that appears once a property is animated: click adds a key at the playhead, click again removes the key at that frame — the "add or remove keyframe by toggle" behaviour. Hollow = no key on this frame, filled `--gold` = key here. Wired to `addPropertyKeyframe` / `deletePropertyKeyframe`.
- Cell inputs get left padding so the stopwatch (and diamond when animating) never overlap the number.
- State classes live **on the buttons themselves** (`.property-stopwatch.active`, `.property-key-toggle.on`) rather than depending on an ancestor combinator.
- **Verified live, end to end:** stopwatch on → channel created with a key at the playhead (`x: [0]`); playhead to 24 + diamond → `[0, 24]`, diamond filled; diamond again → back to `[0]`, diamond hollow; stopwatch off → channel removed entirely (`animation: null`) and the diamond disappears. Editor 12/12, shared-types 35/35, build clean.
- **Unresolved (cosmetic only):** computed-style reads for the active stopwatch tint kept returning the idle colour even though the rule, class and element all check out — and an inline `!important` on the same verified-attached node also failed to register, so the measurement itself is unreliable in that webview. Functionality is unaffected; confirm the active tint visually before chasing it further.

### 2026-08-02 — Unified XPression-style material (finished) + physical lighting

Completed the collapse of Unlit / Basic Lit / PBR into **one** material whose response to light is physical.

- **Canonical type.** `CANONICAL_MATERIAL_TYPE = "pbr"`; `solid-color`, `image`, `unlit-texture`, `basic-lit` are load-only wire aliases that `normalizeMaterial()` rewrites to `pbr`, forcing `shaderId: "grapix.material.pbr"` (index.ts:2092). The creator UI now calls `createMaterial()` with no type argument — there is no lit/unlit choice to make.
- **Fixed the failing migration test.** Alias migration dropped an authored `parameters.tint` when the legacy top-level `color` was also present (only image/unlit aliases honoured tint). Precedence is now uniform for every alias: `parameters.baseColor → parameters.tint → legacy color → #ffffff` — an explicitly authored parameter always outranks the legacy convenience field.
- **Stale built-in shaders (root cause of the split surviving).** `normalizeScene` only *added* missing built-in shaders, never refreshed them, so saved scenes kept old definitions — `data/scenes/001.json` still carried `Basic Lit Mesh` / `Physically Based Mesh` with no `userFacing` flags. Built-ins are app-owned, not user data: they are now always taken from the current manifest, while scene-authored (imported WGSL) shaders are preserved untouched.
- **UI honours the alias flags.** `userFacing` / `compatibilityAliasFor` were declared on `ShaderDefinition` but never read, so alias shaders still listed in the Material Manager. The library now filters them out. Verified live: the shader list shows exactly one entry — **"Standard Material"**.
- **Lighting is genuinely physical, not a label.** `mesh_pbr.wgsl` implements Cook-Torrance: GGX distribution, Smith geometry, Schlick Fresnel, view-dependent halfway vector. Verified live by GL pixel sampling on one material: intensity 3 → `[255,255,255]`, intensity 0.02 → `[26,26,26]`; and metal at roughness 0.05 → `[255,255,255]` vs roughness 0.95 → `[45,45,45]`. The roughness response is the microfacet signature (energy spreads out of the mirror direction) — a diffuse-only or label-only material cannot produce it.
- Tests: shared-types 35/35, editor 12/12, render-daemon 92/92. Full monorepo typecheck + editor build clean.
- **Note:** the manifest keeps `solid-colour` / `textured` / `basic-lit` entries as hidden compatibility aliases so scenes written by older builds still resolve; they are invisible in authoring. Removing them entirely is only safe once no saved scene references them.

### 2026-07-26 — XPression object/property grid + property clocks + Speed Graph

- Rebuilt Scene Inspector as an XPression-style hierarchy/property table:
  Object, visibility, M/K/P state, Alpha, XYZ position, XYZ rotation, and XYZ
  scale are aligned columns. Group `childIds` render as a collapsible hierarchy.
- Removed the duplicated per-object up/down/front/back, duplicate, delete, layer,
  and material controls. Stack ordering and selected-object actions now live in
  one inspector toolbar; visibility remains a row column, while layer
  visibility/locking/rename/delete remain whole-layer controls.
- Merged Properties, Materials, Text, and Data Binding into Scene Inspector
  tabs. The separate Properties dock and Animation tab were removed.
- Activated the existing per-property animation-channel schema. Clicking a
  property clock creates a key at the playhead; editing an active property
  updates or inserts only that property's key. Typed channels now evaluate in
  `evaluateSceneAtFrame`, taking precedence over legacy whole-object snapshots.
- Rebuilt Timeline as a dope sheet with object/property rows. Property diamonds
  move horizontally by pointer drag or keyboard (arrow = one frame,
  Shift+arrow = ten); Delete removes the selected property key. Legacy snapshot
  keys remain visible and movable for old scenes.
- Added a Speed Graph view: sampled units/second curve, per-key frame/value/ease
  controls, selected-key deletion, and draggable incoming/outgoing temporal
  influence handles persisted as Bézier tangents.
- Live verification: X clock created a frame-0 key, editing X at frame 30
  created a second key, frame 15 sampled the exact midpoint, a selected key
  moved from frame 30 to 31, and the graph showed two keys/two editable handles.
  Shared-types 27 tests pass; editor production build and API/editor typechecks
  are clean (existing Vite large-chunk warning only).

### 2026-07-26 — Design-system pass over Templates + Scene Inspector (and global colour unification)

- The Templates panel and Scene Inspector had bypassed the design system entirely. Fixed both against the `:root` tokens.
- **Templates panel:** search field 42px/20px-font → 28px/12px with accent focus ring; section title 15px/900 → 11px uppercase label with a teal "Editing …" tag; card index 20px → 12px tabular; card radius 8px → `--r-md`, tighter padding, `--bg-panel-2` surface with `--bg-elevated` hover; **selection changed from blue `#1d75ff` to the teal accent** with an inset accent bar; the **view dropdown was a white `#f2f2f2` light-theme menu** — now `--bg-elevated` dark with accent hover; New/Delete actions became consistent chips (accent primary / `--danger-dim`).
- **Scene Inspector:** rows 44px → 28-30px; **rainbow type badges replaced with neutral chips using type-coloured *text*** (rect/shape/image/light/camera/layer) instead of saturated orange/yellow/red/mint fills; row controls now fade in on hover/selection (`opacity .45 → 1`) so the tree stays scannable; selection uses `--bg-active` + inset accent bar (was old-cyan tint); the material "M" indicator is a subtle teal-tinted chip (was solid cyan fill); meta inputs 22px → 20px tokenised with accent focus; layer stack on `--bg-panel-2`.
- **Global colour unification:** the rest of the app still used legacy hardcoded accents. Mapped them to tokens across `styles.css` — `#23c7d9`→`var(--accent)` (11), `#f5b942`→`var(--gold)` (8), `#071016`→`var(--accent-ink)` (6), plus the rgba tint forms `rgba(35,199,217,…)`→`rgba(23,185,168,…)` (23) and `rgba(245,185,66,…)`→`rgba(242,165,58,…)`. This pulled Material Manager, Timeline, Sequencer, Font Manager etc. into the system in one pass.
- Verified live by sweeping every rendered element's computed styles: **0 legacy cyan / amber / blue usages** remain; active dock tab = `--bg-panel` + accent bar, app bg = `--bg-app`, badges neutral, no console errors. Typecheck + build clean. (Note: a stale-HMR read initially showed the active tab as transparent — a reload confirmed it was correct; reload before trusting computed-style checks after CSS edits.)

### 2026-07-25 — Real 3D editor + native Program mesh rendering

- Replaced editor mesh illustrations with a Three.js depth-buffered layer.
  Cube/slab, sphere, cylinder, and torus now use actual geometry with
  perspective, Z translation/occlusion, XYZ rotation/scale, and 3D anchors.
- Added independent face/surface assignment: six cube/slab faces, cylinder
  body and caps, continuous sphere/torus surfaces, and imported glTF material
  elements. Solid, image, unlit, and PBR-compatible materials preserve
  opacity, culling, sampler, colour-space, and UV controls.
- Added GLB/glTF asset import to Object Library/Material Manager. Embedded
  models preserve authored PBR base materials and expose ordered material names
  for whole-model or `element:N` overrides.
- Removed the dormant Pixi 2D mesh fallback; meshes are rendered only by the
  real 3D layer.
- Added a native Rust/wgpu mesh pipeline for Program output. Scene warm now
  prepares tessellated primitives or embedded glTF triangles, decodes texture
  assets outside the frame loop, and the renderer uses perspective, a depth
  attachment, per-surface GPU textures/samplers, culling, lighting, alpha, UV
  transforms, and the six shared blend modes.
- Native GPU smoke tests assert pixels for a textured rotated cube and a
  two-material imported glTF, in addition to the 2D quad smoke test. This
  supersedes the older Phase 2 notes below that describe flat mesh symbols.

### 2026-07-25 — Interactive canvas transform tools + real-time pen preview

- Continued the interrupted Claude task with a complete **2D transform-tool suite**: Select (`V`), Move (`W`), Rotate (`E`), Scale (`R`), Pivot (`Y`), and Pen (`P`). The stage toolbar and Edit menu expose every tool; single-key shortcuts are ignored while typing in form controls.
- Added object-space SVG gizmos over the GPU canvas: local red/green move axes plus free-move handle, rotation ring/handle, independent X/Y scale handles plus uniform scale, movable pivot crosshair, selection bounds/corners, and locked-object handling. Each pointer gesture is one undoable history transaction.
- Added a backward-compatible transform model to `BaseSceneObject`: optional `scaleX`/`scaleY` (default 1) and local-pixel `anchor` (default 0,0). Transform contract is now `T(x,y) · R · S · T(-anchor)`: `x/y` is the anchor's world position. Old scenes remain pixel-identical.
- Kept renderer parity: PixiJS applies `scale` + `pivot`; the Rust/wgpu daemon deserializes the same fields and builds the same matrix. The shared WGSL comments and shader contract document the formula. A Rust matrix test proves the anchor remains fixed through scale/rotation.
- Pivot-tool movement compensates `x/y` while changing the local anchor, so the object stays visually stationary as its pivot is repositioned. Scale then occurs around that pivot. Inspector exposes Scale X/Y and Anchor X/Y; transform snapshots/keyframes interpolate scale and anchor.
- Pen authoring is now visibly **real-time between clicks**: a live cubic preview follows the cursor from the last point (including its outgoing tangent). Pen/mask overlays and material hit-testing now respect object rotation, scale, and anchor instead of assuming axis-aligned, untransformed objects.
- Verified live in the browser: move updated position continuously; rotate snapped at 15°; axis scaling updated continuously; pivot movement preserved the exact pre/post screen bounds; `V/W/E/R/Y/P` changed tools; the pen preview path changed with cursor movement; renderer stayed healthy. Test scene edits were undone afterward. Full typecheck/build clean; shared-types 21 tests and render-daemon 46 tests/smokes pass. Existing Vite large-chunk warning remains.
- **3D boundary:** these fields and object-space tool primitives are the transform foundation for the planned Three.js viewport, but the current canvas is still the PixiJS 2D renderer. True perspective camera/orbit, `rotationX/Y`, Z-axis gizmos, depth-tested meshes, and Three.js/wgpu 3D parity remain Track 3E in `docs/3d-engine-architecture.md`.

### 2026-07-25 — Tauri 2 shell, Vizrt-style reskin, XPression menu bar

- **Decision (user delegated):** keep React (no Svelte rewrite — too costly vs. verified UI); adopt **Tauri 2** as the shell (Windows-first, cross-platform later); grow the broadcast design system on the current stack. See the assessment in this session.
- **Tauri 2 desktop shell shipped (working spike/migration):** new `apps/desktop-tauri` (`@grapix/desktop-tauri`) with `src-tauri` (Cargo + `tauri.conf.json` + `lib.rs`). Config: `devUrl` http://localhost:5173, `frontendDist` ../../editor-web/dist, `beforeDevCommand` starts editor-web. `lib.rs` spawns the **Fastify API as a Node sidecar** (mirroring what Electron did in-process), with an `api_already_online()` TCP check on :4100 so it reuses a running API instead of double-binding, and kills the child on window close. Root `dev` now = Tauri (`dev:tauri`); Electron kept as `dev:electron`.
- **Verified live:** `cargo build` compiles clean; `tauri dev` launches a native **WebView2** window titled "GrapiX" (process `app`, 25 msedgewebview2 procs) rendering the editor; API sidecar starts (`Server listening at :4100`) and the window **saves scenes** (`OPTIONS /api/scenes → 204`, `POST → 200`).
- **API CORS fix (required for Tauri):** the API's Origin allowlist rejected the webview origin with 403; added the Tauri webview origins — `tauri://localhost` (macOS/Linux) and `http(s)://tauri.localhost` (Windows WebView2) — to `readAllowedApiOrigins` (`services/api-server/src/index.ts`) alongside the existing `grapix://editor` + 5173 dev origins.
- **Vizrt Artist–style reskin:** retinted the design tokens (`:root`) from the blue-tinted palette to a **neutral near-black + teal** Vizrt look — `--bg-app #161616`, panels `#242424/#1e1e1e`, high-contrast text `#ededed`, teal accent `#17b9a8`, amber `#f2a53a`, flatter radii. Since the chrome is tokenised, this reskins the whole UI. Tokenised the app-shell background (was hardcoded `#0b0f14`).
- **One-time UI cache reset** in `main.tsx`: clears all persisted `grapix-*` localStorage (dock layout, panel splits, prefs — scenes live in the API, not here) when `UI_CACHE_VERSION` changes, so a reskin/layout change starts fresh instead of restoring a stale cached layout.
- **Viz Artist / XPression–style application menu bar** (`components/MenuBar.tsx`) above the top bar (new 26px grid row), reworked from a basic set to mirror Viz Artist's structure per the user's reference screenshots: **File · Edit · Insert · Windows · Project · Display · Animation · Help**. Every item is wired to a real action — File (New Scene, Save Ctrl+S, Export Package, Reload, Exit), Edit (Undo/Redo, Select/Pen tool, Duplicate, Delete), Insert (Text/Quad/Shape/Sphere/Cube/Cylinder/Camera/Light), Windows (Reset Docking Layout, Snapping ✓-toggle), Project (New Scene, Refresh Assets, Export Package), **Display** (opens dock panels — Object Library, Scene Manager, Material Manager, Object Inspector, Templates, Timeline), Animation (Timeline, Add Keyframe, Play/Pause), Help (About). New `dockStore.activatePanel(panelId)` brings a panel to the front of whichever stack holds it. **Global shortcuts (Viz signatures):** Ctrl+M → Material Manager, Ctrl+Alt+O → Object Library, Ctrl+S → Save (guarded against typing in fields). Dropdowns show shortcut hints + a check column; click-outside/Escape closes. Verified live: all 8 menus render, Ctrl+M and the Display→Object Library click both re-focus the correct dock stack, Insert adds objects.
- Verified via computed styles + render test: teal accent + neutral bg applied, 6 menus render, cache reset ran, 4-row grid intact (menu/topbar/main/status), renderer healthy no error banner. Typecheck (editor + api) clean.
- **Tauri next steps (noted):** ship the API as a real bundled **sidecar binary** (currently spawns `node` at a dev path) for `tauri build`; produce the packaged installer; validate mac/Linux WebView GPU (WebGPU) when cross-platform milestone arrives; then retire Electron.

### 2026-07-24 — UI reskin & dead-code cleanup

- **Removed 9 dead components** (leftovers from the retired "xpression-shell" layout, none imported by the live `reference-editor-shell`): `MenuBar`, `TopToolbar`, `TopBar`, `LeftRail`, `LayoutTabs`, `ProjectManager`, `BottomWorkbench`, and `DataPanel` + `AssetMaterialPanel` (only `BottomWorkbench` referenced those). 13 active components remain.
- **Removed visible dead UI:** the placeholder **Output Previews** tiles (16:9/9:16/1:1) and the no-op "Reset view" button in the Properties sidebar, plus their CSS.
- **Design-token system** in `:root` (`--bg-app/dock/panel/panel-2/elevated/input`, `--bg-hover/active`, `--border/border-strong`, `--text/text-dim/text-faint`, `--accent`+`--accent-ink`, `--gold`, `--danger`, radii `--r-sm/md/lg`, `--ctl-h`) — replaces scattered hardcoded greys.
- **Cohesive chrome restyle** (layout unchanged — tokens/colours/spacing only, zero structural risk): topbar (Publish now the accent, not clashing blue; cleaner product mark), dock area + panels + resize handles + panel headers, dock tabs (active = top accent bar), Properties tab strip (**fixed the broken 5-tab grid** — it reserved a 32px column for the removed button and clipped "Data Binding"; now 5 equal columns with an accent underline), form fields/inputs (36px→30px, tokenised, accent focus ring), buttons (panel-icon/wide-action/snapping/tool toggles), status bar, and the viewport stage/toolbar.
- Verified live via computed styles + a render test: shell + 4 dock panels + 5 tabs render, Output Previews gone, Publish button = accent `rgb(53,201,220)`, inputs tokenised, a shape renders (`#00e0ff`) with no error banner. Note: a transient `IMPLEMENTED_MASK_MODES` module error was a **stale Vite dep cache** (cleared `.vite`, restarted — resolved; dist was always correct). Typecheck + build clean.
- `main.tsx` `__grapixStore`/`__grapixUi` dev handles made permanent (already `import.meta.env.DEV`-gated).
- **Not done (deliberately, without being able to screenshot):** deep restyle of individual panel internals (Material Manager grid, Timeline, Scene tree) — they share the dark palette so they don't clash, but could be polished further after visual review. Bulk dead-CSS removal skipped (heavily interleaved with active base styles — high risk, invisible payoff).

### 2026-07-24 — Shape controls fix + AE-style masking

- **Diagnosed the two reported issues (both were UX, not engine bugs), verified live:** colors DO change on a **closed** shape (store `#ff0000` → rendered `[255,0,0]`) and keyframes DO animate (a shape keyframed x 220→820 + fill red→blue renders at the interpolated midpoint x=520 with `[128,0,128]` at frame 30; Play advanced 0→120 on its own). The confusion: the **pen draws open paths**, and a fill only shows on a **closed** path, so editing "Fill" on an open path looks dead; and animating a shape's *path* (morph) is S-3, not built.
- **Fix — shape controls in the Inspector:** for `type==="shape"`, added **Fill on / Stroke on / Closed** toggles (plus the existing Fill/Stroke colour + width), so a drawn path can be closed and filled and its colours are clearly editable. New `ToggleField`.
- **AE-style MASKING (user top priority) — shipped and verified:**
  - Data model (`@grapix/shared-types`): `MaskMode` (`none|add|subtract|intersect|lighten|darken|difference`), `IMPLEMENTED_MASK_MODES` (`none/add/subtract` — the drift guard), `ObjectMask { id, name, path: BezierPath, mode, inverted, opacity, expansion, feather }`, and `BaseSceneObject.masks?`.
  - Renderer (`GpuSceneRenderer`): `applyObjectMasks` wraps content in a masked `Container`; `buildMaskGraphics` resolves reveal-inside vs hide-inside from mode×inverted — reveal paths fill (union), hide paths `cut()` holes; a hide-only mask reveals the full frame then cuts. Masks with ≥3 vertices apply (so a mask mid-draw doesn't collapse the layer). `traceBezierPath` closes the region.
  - Store actions (all history-committed): `addRectMask` (instant inset-20% rect mask), `addMask`/`appendMaskVertex`/`closeMaskPath` (pen), `updateMask`, `deleteMask` — via `addMaskToObject`/`mutateMask` helpers.
  - Authoring: uiStore `penTarget: "shape" | "mask"`; the pen tool draws a mask on the selected object when `penTarget==="mask"` (own overlay: dashed polyline + vertex dots). Inspector **Masks** section: list + "+ Rect" + "+ Pen" buttons, per-mask mode dropdown, invert toggle, delete. Toolbar Pen button shows "· mask" and resets to shape-draw.
  - Verified live via GPU pixel extraction: **add** mask clips content to the path (inside visible, outside cut); **subtract** cuts a hole (inside empty, outside visible); `addRectMask` clips a rect to its inset; a **pen-drawn triangle mask** clips a rect (inside blue `[34,170,255]`, outside cut); `updateMask` mode/inverted and `deleteMask` (undoable) all work. Typecheck + build clean; shared-types 19 tests pass.
- **Colour fix (real root cause of "colours not changing"):** a shape fill only rendered when the path was **closed**, but in After Effects a fill always closes the region. `drawShape` now fills whenever `fillEnabled` (≥2 verts), auto-closing like AE; only the stroke respects open/closed. `createPenShape` now defaults `fillEnabled:true` (fill `#7c5cff`, white stroke) so a pen-drawn path is immediately a filled, colour-editable shape. Verified live: an **open** pen path fills and its Fill colour changes on the fly (green→orange `[255,136,0]`); closed shapes unchanged.
- **S-3 shipped — animatable bezier paths (shape morphing):** added `"path"` to `SceneProperty`, `interpolatePath(a,b,t)` (matched-vertex-count lerp of vertices+in/out tangents; **holds** the nearer keyframe on a count mismatch — AE's rule; `closed` switches at t=0.5), and wired it into `interpolateKeyframeProperty`. `createObjectSnapshot` now deep-captures `path` for shapes, so `addObjectKeyframe` records the whole path and `evaluateSceneAtFrame` morphs it. Verified live via GPU pixels: a triangle whose apex vertex is keyframed x 50→400 over frames 0→60 renders empty at x=200 on frame 0 but filled at frame 30 (vertex interpolated to ~225) with x=300 still empty — i.e. the path genuinely morphs. shared-types 20 tests pass (new `interpolatePath` test); typecheck + build clean.
- Also: `main.tsx` now exposes `window.__grapixStore`/`__grapixUi` **dev-only** (`import.meta.env.DEV`) as debug handles, matching the existing `__grapixRenderers` pattern (stripped from production).
- **Next:** mask-path animation (mask paths are nested in `object.masks[]`, not a top-level `SceneProperty` — needs its own keyframe channel), Trim Paths (animated draw-on), mask feather/expansion/opacity + intersect/lighten/darken/difference modes, edit existing vertices' curve handles by drag + convert corner↔smooth, even-odd fill.

### 2026-07-23 — Animation engine (AN-1), and Motion/3D plan

- Direction set with the user for an After Effects / XPression–class **Motion & 3D engine**, with an **AE-style pen tool + animatable bézier paths as the headline feature**. Full plan in [`docs/3d-engine-architecture.md`](3d-engine-architecture.md): shared **animation-evaluation engine (§A)** → **Track S** (shapes/pen-tool/path-animation, prioritized, 2D) ‖ **Track 3E** (three.js 3D, animated glTF, wgpu daemon). Locked: editor renderer = three.js (best-effort parity, daemon authoritative); canvas = PixiJS 2D + three.js 3D stacked; shape/path model = Lottie/Bodymovin-shaped bézier (`v`/`i`/`o`/`c`); glTF v1 = animated. (A web-research workflow for citations was cut off by a session usage limit; grounded in code + domain knowledge instead.)
- Key grounding: GrapiX had a keyframe *data* model + timeline UI but **no evaluation engine** — `SceneKeyframe` snapshots a fixed scalar `SceneProperty` enum, and `currentFrame` was never sampled into the renderer, so the viewport showed static state. No path type (`line` is a bare polyline).
- **AN-1 shipped (increment 1):** added `evaluateSceneAtFrame(scene, frame)` + `evaluateObjectPropertiesAtFrame` to `@grapix/shared-types` — per-property scalar interpolation (number lerp, hex-colour lerp, step for text/src/visible) with easing (linear/ease-in/out/in-out), holding before first / after last defining keyframe. Wired `CanvasStage` to `resolveRenderableObjects(evaluateSceneAtFrame(scene, currentFrame))` (was frame-agnostic). This makes keyframed properties actually animate the viewport for the first time.
- Verified live via GPU pixel extraction: a quad keyframed x 220→620 over frames 0→30 renders at the **interpolated** midpoint (magenta center at x≈600 ⇒ evaluated x=420) at frame 15, **not** its base x=620 (base-center at x=800 empty). shared-types 19 tests pass (3 new animation tests: numeric/colour interpolation + hold, ease-in curve, scene sampling patches only keyframed objects). Full monorepo typecheck + build clean.
- Note (design): the current global-snapshot keyframe model animates whole-object snapshots; the doc's typed per-property `Animatable<T>` refactor (needed for independent per-property keys and animatable bézier paths) is the next evolution before/with Track S path animation. A base-vs-evaluated position subtlety exists while dragging during playback — to resolve with the per-property model.
- **S-1 shipped (shapes + bézier rendering):** added `Vec2`, `BezierPath` (Lottie-shaped `closed`/`vertices`/`inTangents`/`outTangents`), `ShapeSceneObject` (`path` + `fillEnabled`/`strokeEnabled`/`fillRule`, reusing base fill/stroke), and `bezierPathBounds` to `@grapix/shared-types`; `"shape"` added to `SceneObjectType`/`SceneObject`. `createShapeObject` factory (default = smooth closed rounded-diamond bézier) + `"shape"` library kind + Object-Library "Shape" entry (pen icon). Renderer `drawShape` builds a Pixi path via `moveTo`/`bezierCurveTo`/`closePath` and fills/strokes it. SceneInspector labels shape as "path".
- Verified live via GPU pixel extraction: a new shape renders as a **filled bézier curve** — center = fill `#7c5cff` `[124,92,255]`, but the bounding-box corner is empty `[7,11,18]` (proves a curve, not a rect); a thick cyan stroke scans as 28 stroke pixels + 166 fill pixels across the center row. No error banner. Typecheck + build clean; shared-types 19 tests pass.
- **S-2 shipped (pen tool):** editor tool mode in uiStore (`activeTool: "select" | "pen"` + `setActiveTool`); a Select/Pen toggle in the stage toolbar (crosshair cursor in pen mode). Pen-authoring store actions (all history-committed, so a gesture wrapped in `beginHistory`/`commitHistory` = one undo): `createPenShape(origin)`, `appendShapeVertex`, `updateShapeVertex`, `closeShapePath`. `CanvasStage` pen interaction: click to create a shape + first vertex, click to append vertices to the same path, drag to set symmetric smooth handles (`create-tangent`), click within ~10px of the first vertex to close (enables fill), Escape / leaving the tool finishes. Overlay renders vertex squares (first highlighted) + tangent handle lines/dots; dragging a vertex square moves it (`kind:"vertex"`). `beginDrag` early-returns in pen mode so clicks reach the stage. Pointer-capture wrapped in try/catch.
- Verified live via the dev server + GPU pixel extraction: activating pen + clicking created a shape exactly at the click point (300,300); a second click appended a vertex to the SAME path at the exact clicked point; a third click made a triangle; clicking the first vertex closed it (`closed`+`fillEnabled`, no new vertex/shape). The closed triangle renders filled (centroid `[124,92,255]`, outside corner empty) and the overlay shows 3 vertex dots. Undo granularity confirmed: a 5-gesture path = 5 undo steps. Typecheck + build clean; shared-types 19 tests pass.
- **Next:** Track S — S-3 (animatable path: typed `Animatable<BezierPath>` + `interpolatePath` with matched-vertex-count guard + Trim Paths) → S-4 (operators/masks, even-odd fill). Not yet: handle/tangent editing of existing vertices via drag (only whole-vertex move + create-time handle drag are wired), convert corner↔smooth, insert/delete vertex on an existing path; `fillRule` even-odd; open-path fill.

### 2026-07-23 — 3D per-face rendering (Phase 2)

- **XPression face-based material binding — Phase 2: per-face rendering on mesh symbols** (continues the Phase 0+1 work; branch `feat/material-manager-and-render-daemon`).
- The editor GPU renderer (`GpuSceneRenderer`) now paints each **visible** region of the flat mesh symbols from its own bound material slot, colour or texture. `drawMesh`/`drawCubeLike`/`drawCylinder`/`drawTorus` became async renderer methods (textures load via `getTexture`); a shared `paintMeshFace` helper fills the region with the face's resolved colour and, when the face carries a texture, overlays a `Sprite` masked to the region shape. Unbound faces fall back to the original shaded `object.fill`, so unbound meshes look exactly as before. Region→slot mapping: **cube/slab** front→`main`, right wall→`face:right`, top→`face:top`; **cylinder** body→`main`, top ellipse→`face:cap-top`, bottom→`face:cap-bottom`; **torus/model**→`main`.
- Per-face resolution added in `sceneMaterial.ts`: new `ResolvedFaceMaterial` + `RenderableSceneObject.faceMaterials` (slot-keyed colour/assetSource/assetMime). `applyMaterialSlots` resolves every bound face for meshes (via `getBindableFaces`), and carries face resolutions even when the primary `main` slot is empty (a cube bound only on non-main faces still renders them).
- Materials tab (`MaterialsTab.tsx`) now tags faces the flat 2D symbol can't show yet (cube back/left/bottom) with a **preview-hidden** badge + hint, so binding to them isn't confusing. `symbolVisibleSlots` mirrors the renderer's visible regions.
- **Verified live via GPU stage-pixel extraction** (`app.renderer.extract.canvas`): cube front/right/top rendered exact bound colours `[255,0,0]`/`[0,0,255]`/`[0,255,0]`; a bound blob-PNG textured the cube front (`[255,51,102]`); unbound cube top/side fell back to the exact shaded fills (`[160,195,255]`/`[108,143,231]`); cylinder body/top-cap/bottom-cap rendered `[255,170,0]`/`[0,255,204]`/`[204,0,255]`. Materials tab confirmed 6 cube faces with preview-hidden badges on Back/Left/Bottom. No error banners, clean console. Full monorepo typecheck + editor build clean; shared-types 16 tests pass.
- **Note on verification:** the editor renders on the tick after a store mutation, so pixel extraction must run in a separate step from the store change (a same-call extract catches the previous frame). New library objects spawn at (220,220) and stack, so isolate/move an object before sampling.
- **Still open (Phases 3–4):** Material Manager folders / refresh-thumbnail / Ctrl+M focus; OS→Material Manager and OS→viewport(create quads) drag-drop; shader-specific drag; optional MM-thumbnail→object drag enhancement. True 3D per-face texturing (all 6 cube faces, curved cylinder body) still awaits the real 3D mesh renderer; Rust daemon still reads only `main`.

### 2026-07-22

- **XPression-style face-based material binding — Phase 0 + Phase 1** (branch `feat/material-manager-and-render-daemon`, on top of the earlier double-click/drag asset-assignment work).
- **Phase 0 — renderer crash fix.** Imported assets get extension-less API content URLs (`/api/assets/<id>/content`); PixiJS `Assets.load` matched no parser for them and *resolved to null* (not a rejection), bypassing `getTexture`'s `.catch(()=>Texture.EMPTY)`, so the null hit `applyTextureSampler` → `texture.source` → "Cannot read properties of null (reading 'source')". Fix in `GpuSceneRenderer.getTexture`/new `loadImageTexture`: coalesce a null resolution to `Texture.EMPTY`, and force the correct parser for extension-less sources via `loadDescriptorForSource` (image/* → `loadTextures`, image/svg → `loadSVG`; data: URLs left to Pixi's MIME auto-detect). Asset MIME threaded through `RenderableSceneObject.materialAssetMime` (set in `sceneMaterial.applyMaterialSlots`). Defensive `!texture?.source` guard added. Verified live with an extension-less `blob:` PNG URL: binds + renders, no banner, no console error.
- **Phase 1 — central face-binding model.** New single source of truth in `@grapix/shared-types`: `MaterialFace`/`MaterialFaceKind`, `getBindableFaces(object)` (cube→6, cylinder→side+2 caps, quad/background/sphere/torus/slab→1 primary, text→1 "All Text" element, model→1 placeholder; faces[0] is always the primary surface at slot `PRIMARY_MATERIAL_SLOT` = "main" for back-compat), `faceSlotKey`, `isMaterialCompatibleWithFace` (relaxes the object-type gate so textures/solids bind to mesh faces). Per-face bindings are stored as extra `materialSlots` keys (`face:back` etc.) alongside "main" — **no schema change**, so old scenes / packages / the Rust daemon (`.get("main")`) are unaffected.
- Central API in `editorStore` (each bind/unbind = one `commitScene` = one undo entry; multi-face = single transaction): `assignMaterial`, `assignMaterialToFaces`, `assignAssetToFaces`, `unbindMaterial`, `unbindMaterialFromFaces`, `getMaterial`, `getBindableFaces`, `getObjectsUsingMaterial`. Plus face-selection state `selectedFaceIndices`/`faceSelectionAnchor` with `selectFace(i, 'single'|'toggle'|'range')` and `clearFaceSelection`, reset on `selectObject`/`loadScene`/`resetScene`/delete.
- UI: new Object Inspector **Materials tab** (`components/MaterialsTab.tsx`) showing the object's faces from `getBindableFaces` (label, bound material name + thumbnail, bound/unbound state, single/Shift-range/Ctrl-toggle selection, right-click → **Unbind** which clears the slot only, never deletes the shared material). Material Manager double-click now binds to the selected faces via the central API; **Shift+double-click** and context-menu **Edit** open the material in the Material Inspector (the editor form); double-click never opens the editor. Non-blocking "Select a compatible object or material face first." message when nothing valid is selected.
- **Honest scope boundary:** the GPU renderer still draws cube/cylinder/torus/slab as flat 2D symbols with one fill, so per-face *visual* texturing on 3D primitives is **Phase 2** (a real 3D mesh renderer). Flat primitives (Quad/Background/Sphere/Torus/Slab) and Text render their bound material now; cube/cylinder face bindings are data/Inspector/API/undo/persist-complete but not yet visible on the symbol. Text is one "All Text" element (per-character runs are future — no text-run model yet). Model exposes one placeholder element (no glTF/obj importer yet). A standalone node-graph Material Editor is Phase 5; today "open editor" = the Material Inspector form.
- **Not yet built (Phases 2–4, per approved scope):** cube/cylinder multi-face visual rendering, Material Manager folders/refresh-thumbnail/Ctrl+M focus, and all drag-and-drop (OS→Material Manager, OS→viewport-creates-quads, shader-specific drag, optional MM-thumbnail→object enhancement).
- Verified live end-to-end via the editor store: 6-face cube, range selection [0,1,2], multi-face assign as one undo entry, undo/redo atomic, unbind keeps shared material, text override + font-style restore, no-selection message, and cube face bindings surviving a JSON save/reload round-trip. Tests: shared-types 16 pass (3 new face-model tests). Full monorepo typecheck + editor production build clean.

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

## 2026-07-25 renderer architecture boundary

- Froze and documented `SceneDocument` v1 compatibility/migration rules.
- Added `@grapix/renderer-protocol` as the TypeScript source of truth for the
  existing daemon v1 wire format plus shared Preview/Program channel and scene
  lifecycle vocabulary.
- Refactored the Fastify render-daemon bridge to build and validate messages
  through the shared protocol package instead of duplicating constants/types.
- Added the authoritative `RendererClient` control interface separately from
  the editor-only `ScenePreviewRenderer`.
- Moved construction of the Pixi engine behind `PixiPreviewRendererAdapter`;
  React feature components now depend on the preview interface.
- The existing Rust daemon already covers the review's process-prototype
  milestone. Its next slice is capability/sequence safety plus
  Preview/Program lifecycle and bounded warm-scene LRU management.

## 2026-07-25 renderer protocol v2

- Upgraded the TypeScript/Rust renderer protocol together to v2.
- Every command now requires `requestId`, strictly increasing `sequence`,
  `timestampMs`, explicit expected renderer state, and explicit nullable
  scene/revision/channel context.
- Scene commands prove that envelope scene id/revision match the full
  `SceneDocument`; the daemon rejects stale sequences, revision mismatches and
  output-state precondition failures with dedicated error codes.
- Added `capabilities.get` and `heartbeat`; capability flags describe only
  behavior that is actually implemented.
- Added a typed server-event envelope; the daemon now publishes
  lifecycle/channel/output/resource changes on every connected controller.

## 2026-07-25 renderer scene lifecycle

- Replaced the daemon's single loaded-scene ownership with `SceneRegistry`.
- Added revision-checked `scene.warm`, `scene.release`,
  `channel.preview.set`, and cut-only `channel.take` protocol commands plus
  Fastify bridge routes.
- The registry protects one Program scene and one Preview selection from
  eviction, retains three warm scenes, and evicts the least-recently-used warm
  scene when over budget.
- Status now reports every resident scene's lifecycle, revision, object/rect
  counts, warnings, estimated prepared bytes and last-use order, along with
  Preview/Program ids and aggregate cache pressure.

## 2026-07-25 resource governor

- Added `EDITOR_PREVIEW`, `PROGRAM_HD`, `PROGRAM_UHD`, `LOW_LATENCY`, and
  `SAFE_MODE` profiles.
- The daemon enforces profile output dimensions/frame rate, per-scene prepared
  size, warm-scene count and total prepared-cache budget.
- Profile changes can evict warm scenes but never Program or Preview; status
  exposes the active profile, all declared limits, cache pressure and
  over-budget state.

## 2026-07-25 desktop renderer supervision

- Tauri now starts/reuses both the Fastify project service and native render
  daemon and stages the daemon as a packaged external binary.
- A two-second watchdog monitors API health, renderer status, Program frame
  progress and output errors. Three consecutive failures trigger a bounded
  renderer restart (maximum three per minute).
- The watchdog remembers Program scene/output configuration, attempts to
  restore them after restart, supports `GRAPIX_SAFE_FALLBACK_SCENE_ID`, and
  reports explicit fallback state when recovery fails.
- Supervisor state is exposed by a Tauri command and event; the editor status
  bar displays native Program health, frame progress and fallback reason.

## 2026-07-25 architecture review implementation pass

- Added an explicit 35-row compliance ledger. Hardware, vendor SDK, decoder,
  3D and long-soak gates remain labeled rather than being claimed complete.
- Project storage now uses temp+fsync+rename, monotonic revisions, per-scene
  backups, safe IDs/paths and SHA-256 asset reference accounting.
- `.gfxpkg` v2 embeds local assets and declares renderer/features/fonts/
  shaders/codecs/memory/fallbacks. Every file is SHA-256 listed; the builder
  reopens the final ZIP and tamper tests verify rejection.
- Added typed `scene.patch` with current/next revision proof, atomic project
  persistence, 120-patch/s rate limit, safe data paths and latest-value
  frame-boundary delivery.
- Added native content-addressed asset-cache accounting, Program/Preview/Warm
  priorities, decoded CPU/GPU tier budgets and non-eviction of referenced
  Program resources.
- Added native media lifecycle, decoder budgeting, bounded decoded-frame
  queues and renderer-clock frame selection. Native codec decode is still
  disabled and video package preflight blocks production use.
- Added strict asset magic/path/size validation, glTF/GLB import reports and
  complexity limits, `.aep` rejection plus Lottie/alpha-media compatibility
  reports, authenticated remote API binding, operator audit logs and
  read-only show mode.
- Native Program now renders solid rects and analytic ellipses and blocks Take
  when unsupported visible content/materials would be omitted.
- Added raw BGRA recording output, explicit unavailable DeckLink/AJA plugin
  gates, detected GPU/driver/limit status and last/average/p99 frame-budget
  telemetry.
- Fixed Tauri watchdog status parsing: Fastify wraps daemon status in `reply`,
  which the old pointer path missed. Recovery now also preserves recording
  configuration; UI reports the detected GPU and an explicit uncertified
  hardware warning.
- Added the exact reviewed 80-scene control-plane suite and a live soak runner
  configurable for 8/24-hour execution, plus a hardware certification record
  template. These do not substitute for real NDI/decoder/device testing.

## 2026-07-25 font, sequencer, and automation extension

- Added scene font-family/face definitions for packaged OTF/TTF/WOFF/WOFF2,
  HTTPS CSS links, and normalized Adobe Fonts project links. Remote references
  stay explicit and receive an offline-reliability preflight warning.
- Added multi-sequence `RundownDocument` storage, cue tracks, transition
  definitions, bounded conditional trigger rules, priority/cooldown/once
  semantics, and dry-run or explicit-execute event endpoints.
- Added checksummed per-scene JavaScript module references and `@grapix/sdk`.
  The SDK evaluates declarative conditions and exposes a permission-scoped
  typed-action API; arbitrary script source remains outside the API, editor,
  and native renderer pending the isolated-worker certification gate.

## 2026-07-26 active editor cameras, lights, and hierarchy layers

- Scene camera objects now drive the Three.js viewport when selected through
  `SceneDocument.activeCameraId`. Perspective/orthographic projection,
  position/target/up, FOV/zoom, and near/far controls are live in Properties;
  the first added camera becomes active and deletion repairs the reference.
- Directional, point, and spot objects now create real Three.js lights. Colour,
  intensity, attenuation, cone/penumbra, target, opacity, and shadow state
  affect PBR meshes; the synthetic fill rig remains fallback-only.
- Added an immutable shared layer/group hierarchy resolver with one-parent,
  cycle-safe child references; recursive position/rotation/depth/scale plus
  visibility/opacity/lock inheritance; diagnostics; and non-pixel containers.
- Properties now assigns layer contents and exposes camera/light controls.
  Scene Inspector nests both layer and group children. Container guides remain
  editor-only while their effective children feed both PixiJS and Three.js.
- Live browser verification covered active-camera FOV projection, light
  intensity reaching full black at zero, and layer translation moving its mesh
  child. Native Program parity for active cameras and hierarchy-evaluated
  camera/light transforms remains an explicit renderer follow-up.

## 2026-07-27 material visibility and authored-light correction

- Confirmed material bindings were persisted correctly; the primary failure
  was render classification. Three had routed solid/textured-unlit faces
  through `MeshStandardMaterial`, allowing an ineffective authored light to
  black them out.
- Editor mesh surfaces now classify Solid/Image/Unlit Texture as unlit and
  Basic Lit/PBR as lit. Material opacity is no longer multiplied twice.
- Added explicit Unlit, Basic Lit, and PBR creation controls; PBR exposes base
  colour, opacity, metalness, and roughness.
- Whole-object canvas/Scene Inspector drops bind every real mesh face, while
  the Materials inspector retains explicit per-face control. Mesh drop hit
  testing now uses active-camera projected bounds at the evaluated frame.
- Texture decode failure is retryable and shows a visible fallback. Transparent
  Three surfaces do not write depth.
- The Rust Program path now carries the same lit/unlit flag, consumes up to 16
  directional/point/spot authored lights through the shared WGSL contract,
  preserves primitive `main`/front semantics, and prioritizes image tint.
- Live editor smoke verified that unlit remains white under zero/tinted lights,
  while PBR goes dark at zero intensity and renders at authored intensity 2.2.
- Automated evidence: 4 editor renderer tests, 32 shared tests, and 91 native
  tests including a real-GPU zero-light regression.
- Remaining explicit parity gates: native active camera, transparent mesh depth
  ordering/depthMode, shadows, hierarchy/timeline-resolved native lights,
  sampled-texture `opaque` alpha behavior, and unified 2D/3D interleaving.
