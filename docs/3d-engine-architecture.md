# GrapiX Motion & 3D Engine — Architecture & Phased Plan

Status: **in progress; 2D animation/shape foundation landed, 3D rendering gated**.
Target: After Effects / XPression–class motion
graphics — an **animatable pen-tool bézier shape system (headline feature)**,
real 3D meshes, scene lighting and cameras, and **animated glTF** import — all
driven by one timeline, replacing today's 2D-static preview.

This document covers two interleaved tracks: **Track S** (Shapes / Pen tool /
Path animation — highest priority) and **Track 3E** (3D engine), sharing one new
**animation-evaluation engine** (§A). It follows the material-binding work
(Phases 0–2, see [`project-memory.md`](project-memory.md)).

> Research note (2026-07-23): a planned web-research pass (AE/Lottie/three.js/glTF
> citations) was cut short by a session usage limit; this revision is grounded in
> the codebase (read directly) + domain knowledge, with the Lottie/Bodymovin JSON
> format as the reference for the shape/path model. External citations to be added
> when the limit resets.

---

## 1. Current state (grounded)

GrapiX today is a **2D compositor**. What exists:

- **Editor renderer** — PixiJS 8, 2D only (`Editor/apps/editor-web/src/rendering/GpuSceneRenderer.ts`). Objects get `x`, `y`, and a single 2D `rotation`; `zDepth`/`zIndex` are paint-sort order, not depth. No view/projection matrix, no perspective.
- **"3D" primitives** (cube/cylinder/torus/slab) — flat 2D symbols; Phase 2 paints their visible faces per bound material but the geometry is fake isometric.
- **Lights** (point/directional/spot) — gizmo icons (`drawLight`); `LightSceneObject.intensity` exists but nothing consumes it. Lights illuminate nothing.
- **Cameras** (perspective/ortho) — gizmo icons (`drawCamera`); `CameraSceneObject.fov`/`zoom` exist but no view transform is applied. Viewport "zoom" is CSS scale of the stage.
- **Rust daemon** — wgpu, but `scene_projection` is a 2D **orthographic** map with quads at `z=0`; it draws **only `rect`** and warns on everything else (`services/render-daemon/src/scene/document.rs`).
- **Shared shader contract** — `Shared/render-shaders` (`layouts.json` byte contract + WGSL + `shader-contract.md`) is the drift guard between the two renderers. Currently 2D quad + textured + blend modes only.
- **Animation** — the shared evaluator samples numeric, colour, anchor and
  matched-vertex bézier-path keys, and `CanvasStage` renders
  `evaluateSceneAtFrame(scene, currentFrame)`. The current scalar snapshot
  model remains a migration step short of the fully typed per-property
  `Animatable<T>` target below.
- **Vectors** — `ShapeSceneObject`, Lottie-shaped cubic bézier paths, fill,
  stroke, masks and editor path interaction exist. Advanced shape operators,
  trim paths and complete Program-daemon tessellation remain.
- **3D import gate** — the project service validates glTF 2/GLB headers,
  embedded dependencies, required extensions and per-profile mesh/material/
  light/bone limits, and reports a VRAM estimate. It does not yet make the
  editor or native daemon a true 3D renderer, so 3D package preflight blocks
  production publication.

The existing docs already anticipate 3D: `rendering-engine.md` ("real Three.js/WebGPU scene layer") and `render-daemon-architecture.md` ("browser WebGPU preview later" consuming the shared WGSL).

Data-model skeleton already present (`Shared/shared-types/src/index.ts`): `MeshSceneObject{ meshKind, depth, src }`, `LightSceneObject{ lightKind, intensity, color }`, `CameraSceneObject{ cameraKind, fov, zoom }`. None of it is rendered in 3D.

---

## 2. Target capability (parity checklist)

To be XPression/AE class:

- True 3D transforms: position (x/y/**z**), rotation (**x/y/z**), scale (x/y/**z**), anchor/pivot.
- Real meshes: cube/cylinder/torus/sphere/slab as geometry + **glTF/OBJ model import** with sub-materials (feeds the Phase 1 "model faces" placeholder and test case #7).
- Scene **cameras**: perspective + orthographic, near/far, look-at/target, an **active** camera that renders the scene, viewport navigation.
- Scene **lighting**: directional, point, spot; intensity, colour, range/falloff, cone angle, optional **shadows**; ambient/environment.
- **PBR / lit materials**: base colour, metalness, roughness, normal, emissive; plus the existing unlit/2D materials still work.
- **2D + 3D composited in one scene** under the active camera (AE-style: 2D layers are planes in 3D space).
- **Preview = program**: editor preview matches the daemon output within a documented tolerance.
- Broadcast-grade: 50/59.94/60 fps, correct colour space, alpha, motion.

---

## 3. Core architectural decisions

### Decision A — Editor 3D renderer: **LOCKED → three.js (A1)**

Chosen: **three.js**, behind a swappable `SceneRenderer` interface. Parity bar
is **documented best-effort** (see §5) — the wgpu daemon stays the authoritative
program output; three.js is the editor preview matched to a documented 3D
contract. Rationale: fastest path to real meshes/lights/cameras/glTF/shadows; the
repo already frames the renderer as replaceable, so a future bit-exact
requirement can swap to browser-WebGPU-on-shared-WGSL (the rejected A2) behind the
same interface without a UI rewrite.

### Decision B — how the 2D (PixiJS) and 3D (three.js) renderers coexist — **OPEN, needs sign-off**

three.js and PixiJS each own a WebGL/WebGPU context; they cannot share one
cheaply. Three concrete options (B1 is split into the two ways it's actually
implemented):

| Option | Mechanism | Interleaving | Cost / risk |
|---|---|---|---|
| **B1a. Stacked canvases** (recommended to start) | Two `<canvas>` layered by CSS in the stage: 3D behind, 2D in front (order configurable per scene) | Whole-layer only (all 2D in front of / behind all 3D) — no per-object depth interleave | Lowest; no cross-context sharing; each engine untouched. Blend between layers limited to CSS/`globalAlpha` |
| **B1b. 3D → texture → Pixi sprite** | three.js renders offscreen; its canvas is uploaded as a Pixi texture each frame and drawn as a sprite at a z-band | 3D composites at chosen 2D z-bands; still one 3D "slab" per band | Per-frame texture re-upload cost; one 3D pass per band |
| **B2. Unify on one 3D scene graph** (2D = planes) | Retire PixiJS; everything is a three.js node; 2D objects are planes under the active camera | True AE/XPression per-object 2D/3D interleave under one camera | Large migration; must re-prove every 2D behaviour (blend modes, text, UV, masks, TilingSprite) |

**Recommendation:** Start **B1a (stacked canvases)** — it ships real 3D with
zero risk to the proven 2D pipeline and no cross-context problem. Most broadcast
lower-thirds/scorebugs put 3D as a background or foreground band, which B1a
covers. Move to **B1b** only if a scene needs 3D sandwiched between 2D bands.
Evaluate **B2** at `3E-6` — it's the correct long-term architecture (true
interleave, one camera) but must not block first 3D. The `SceneRenderer`
interface is designed so B1a→B1b→B2 are swaps, not rewrites.

---

## 4. Data-model changes (`Shared/shared-types`)

All additions are **optional with back-compat defaults** so existing 2D scenes (z=0, `rotation`=rotationZ) load unchanged; migration in `normalizeMaterialSceneDocument`/`normalizeScene`.

> **Implementation status (2026-07-25):** the 2D transform foundation has
> landed: `scaleX`/`scaleY` and a local-pixel `anchor` are shared by the editor
> and wgpu daemon, with matching `T · R · S · T(-anchor)` semantics and live
> move/rotate/scale/pivot gizmos. The 3D-only fields and Three.js renderer below
> remain planned Track 3E work.

- **Transform3D on `BaseSceneObject`:** `z?: number` (default 0), `rotationX?`/`rotationY?` (default 0; existing `rotation` = rotationZ), `scaleX?`/`scaleY?`/`scaleZ?` (default 1), `anchor?: {x,y,z}`. Keep `x,y,width,height,rotation` as the 2D projection of this.
- **`LightSceneObject`:** add `range?`, `decay?`, `coneAngleDeg?`/`penumbra?` (spot), `direction?`/`target?`, `castShadow?: boolean`. Define **intensity units** in the contract.
- **`CameraSceneObject`:** add `near?`, `far?`, `target?: {x,y,z}`, `up?`, and a scene-level **active camera** id (`SceneDocument.activeCameraId?`).
- **Materials:** extend `basic-lit`/`pbr` params — `metalness`, `roughness`, `emissive`, `normalScale`; normal/emissive/roughness texture slots (the texture-slot model already exists).
- **Mesh/model:** `MeshSceneObject.modelAssetId?` (glTF/glb asset); imported sub-materials become **bindable faces** via the existing `getBindableFaces` seam (fulfils the Phase 1 model placeholder).
- **Contract + fixtures:** extend `Shared/render-shaders` with a **3D contract** (camera model, light equations, BRDF, tone-map, colour space) and re-emit `fixtures/scene-document.v1.json`; bump `SUPPORTED_VERSION` if the shape changes materially.

---

## 5. Rendering architecture

```
SceneDocument (shared-types, now with 3D transforms/lights/cameras/models)
   │
   ├── Editor preview:  SceneRenderer interface
   │      ├─ Renderer2D (PixiJS)      — today's 2D path
   │      └─ Renderer3D (three.js)    — 3D scene mirrored from SceneDocument, active camera,
   │                                     lights, meshes, glTF; rendered to texture, composited (B1)
   │
   └── Program output:  Rust daemon (wgpu)
          ├─ 2D pipeline (today)      — ortho quads
          └─ 3D pipeline (new)        — depth buffer, camera UBO, model matrices, mesh buffers,
                                        light UBO, lit WGSL per the render-shaders 3D contract, glTF (gltf crate)
```

**Parity strategy:** the daemon is authoritative. `Shared/render-shaders/docs/shader-contract.md` gains a 3D section (camera projection, light falloff, BRDF, tone-map, sRGB). three.js is configured to match it as closely as its pipeline allows (linear workflow, ACES/none tone-map to match, matched light units). Parity is validated by rendering the same scene in both and comparing within tolerance — same philosophy as the current `blend_states_match_pixi_equations` test, but tolerance-based for lighting.

### 5.1 `SceneRenderer` interface (the swap seam)

Both the current Pixi path and the new three.js path implement one interface, so
`GpuSceneStage` doesn't care which is active and B1a→B1b→B2 are swaps:

```ts
interface SceneRenderer {
  mount(host: HTMLElement, scene: SceneDocument): Promise<void>;
  renderScene(scene: SceneDocument, objects: RenderableSceneObject[]): Promise<void>;
  resize(scene: SceneDocument): void;
  getCapabilities(): GpuRendererCapabilities;      // extended: has3D, maxLights, shadows
  destroy(): void;
}
```

The stage decides 2D-only vs 2D+3D from scene content (any object with a non-zero
3D transform, or any `light`/`camera`/3D `mesh`/model → 3D active). `GpuSceneRenderer`
is renamed to `Renderer2DPixi`; the three.js implementation is `Renderer3DThree`.
For B1a the stage mounts both and stacks their canvases.

### 5.2 Coordinate system & 2D/3D interop

- **2D authoring stays y-down** (canvas/PixiJS: origin top-left, +y down, px units) — unchanged for every existing scene.
- **The 3D renderer converts** at the boundary: scene (x, y, z) → three.js (x, −y, z) with a matched projection so a z=0 object lands exactly where the 2D renderer would draw it. One documented conversion, applied in `Renderer3DThree` and mirrored in the daemon.
  - **Negate the position; never reflect a parent.** `(x, −y, z)` per object is not
    interchangeable with `scale.y = −1` on a shared parent, even though both put objects in the
    same place. Reflecting a parent mirrors its children's *geometry*: UVs flip, so every texture
    renders upside down, and triangle winding inverts, so under back-face culling the surface
    either shows its back face or disappears. The editor's `ThreeSceneLayer` shipped
    `content.scale.y = −1` and a material-assigned quad showed its texture rotated 180 degrees;
    restoring the documented per-position negation fixed it. The camera-rotation trick that
    reflection replaced had the same defect for the same reason. Lighting *may* be reflected at its
    root, because a light has no geometry - only a position and a direction.
  - Negating Y reverses rotations about the other two axes, so `rotationX` and `rotationZ` are
    negated with it and `rotationY` is not. A parent reflection got that for free; doing the
    conversion honestly means doing it explicitly, and it is invisible until something is rotated.
    `projectMeshBounds` composes the identical transform, because selection handles are drawn from
    it and must land on the object.
- **A 2D object in a 3D scene** is a plane at its z (default 0), facing the camera's near plane — so mixed scenes are coherent and B2 (2D-as-planes) is a natural extension.
- **`rotation` is rotationZ**; `rotationX`/`rotationY` default 0. Existing 2D scenes are unchanged (pure z-rotation at z=0).

### 5.3 Camera model (editor view vs active render camera)

Mirrors AE/XPression: the scene has an **active render camera** (`SceneDocument.activeCameraId`;
default = a synthetic 2D ortho camera matching today's flat view, so existing
scenes render identically). The **editor viewport** additionally has its own
*navigation* camera (orbit/pan/zoom) that is view-only and never serialized —
like AE's "Custom View". A toggle renders the viewport through the active camera
(what goes to program) vs the nav camera (authoring). The daemon always renders
through the active camera.

---

## A. Animation-evaluation engine (shared foundation for everything)

Today's keyframes are a scalar snapshot list that never reaches the renderer.
Both tracks (shapes and 3D) need a real **typed, per-property** animation model
and a runtime evaluator. This is the AE/Lottie model.

**A.1 Typed animatable properties.** Replace the global scalar-keyframe list with
per-property animation living on the object (like Lottie's `transform.position.k`):

```ts
type Interp = { easing: SceneKeyframeEasing; bezier?: { i:{x,y}, o:{x,y} } }; // temporal, AE-style
interface Keyframe<T> { frame: number; value: T; interp?: Interp }
type Animatable<T> = { static: T } | { keyframes: Keyframe<T>[] };  // T = number | Vec2 | Vec3 | Color | BezierPath
```

Each animatable property (position, scale, rotation, opacity, colour, **path**,
trim start/end, glTF clip time, …) is an `Animatable<T>`. This gives per-property
keyframing (AE keys each property independently), typed interpolation, and
per-keyframe temporal easing — and it's what lets a **bézier path** be animated
like any other value.

**A.2 Interpolator registry** — one pure function per value type:
`lerpNumber`, `lerpVec2/3`, `lerpColor` (in linear/OKLab, matched to the shader
contract), and the critical **`interpolatePath(a, b, t)`** (§B.3).

**A.3 Evaluator** — `evaluateSceneAtFrame(scene, frame): SceneDocument` samples
every `Animatable` to a concrete value, then the existing
`resolveRenderableObjects` runs on the sampled scene. Wire `CanvasStage` to
`evaluateSceneAtFrame(scene, currentFrame)` (currently `resolveRenderableObjects(scene)`
with no frame) — this closes the "playback doesn't render" gap and is the single
change that makes *all* animation (2D, 3D, paths, glTF) visible. The daemon gets
the same evaluator (shared-types is cross-consumed) for preview=program.

**A.4 Migration** — convert the current global `timeline.keyframes` (scalar
snapshots) into per-property `Animatable` values in `normalizeScene`; keep
`SceneTimeline{fps,durationFrames}` as playback config. Back-compat: an object
with no keyframes → `{static: value}`.

---

## B. Shape layers + Pen tool + Path animation — **HEADLINE**

The most important feature. Modeled on AE shape layers, serialized like
**Lottie/Bodymovin** (the proven web format for exactly this).

**B.1 Bézier path value** (Lottie's `sh` shape, verbatim structure):

```ts
interface BezierPath {
  closed: boolean;               // "c"
  vertices:    Vec2[];           // "v" — anchor points (absolute, object space)
  inTangents:  Vec2[];           // "i" — control handles INTO each vertex, relative to it
  outTangents: Vec2[];           // "o" — control handles OUT of each vertex, relative to it
}
// Segment k→k+1 is a cubic bézier: P0=v[k], P1=v[k]+o[k], P2=v[k+1]+i[k+1], P3=v[k+1].
```

**B.2 Shape layer = a small render tree** (Lottie shape items), all properties
`Animatable`:
- `path` (BezierPath) · `fill` (colour/opacity, even-odd|nonzero) · `stroke`
  (colour, width, cap, join, miter, dashes) · `gradientFill` ·
  `trimPath` (start/end/offset — animates a "draw-on" reveal) · `group`
  (nested items + a transform) · `repeater` · `roundCorners` · `mergePaths`.
- **Masks**: a `BezierPath` used as a clip (add/subtract/intersect, feather) on
  any layer — same path model, reused.

New object family `type: "shape"` (`ShapeSceneObject { contents: ShapeItem[] }`).
The existing `line` object is subsumed (a shape with an open path + stroke).

**B.3 Animating a path — the crux.** `interpolatePath(a, b, t)` requires
**matched vertex counts** (AE/Lottie's hard rule): with `a.vertices.length ===
b.vertices.length`, lerp `vertices[k]`, `inTangents[k]`, `outTangents[k]`
component-wise; `closed` switches at t≥0.5. If counts differ → this is the #1
risk (§7): the pen tool and keyframe UX must **preserve vertex count** when
keying a path (add a vertex on all keyframes at once, or auto-pad by inserting
coincident vertices along segments). Surface a clear warning rather than
morphing wrongly. Temporal easing per keyframe (later: per-property bézier
timing). Trim Paths animate by keyframing `start`/`end`.

**B.4 Pen tool** (interaction mode on the canvas overlay, reusing the SVG
interaction layer in `CanvasStage`):
- Click = add **corner** vertex (zero tangents); click-drag = add **smooth**
  vertex (sets symmetric in/out handles); Alt/Opt-drag a handle = break it;
  click the first vertex = **close** path.
- Edit: select/drag vertices and handles; add vertex on a segment; delete vertex;
  convert corner↔smooth (Alt-click). All operations are undoable (one
  `commitScene` each, like the material work) and, when the path is animated,
  edit the **active keyframe's** path (with the count-matching guard).

**B.5 Rendering** — PixiJS v8 `GraphicsPath` / `graphics.bezierCurveTo(...)`
rebuilt from the interpolated `BezierPath` each frame (Pixi tessellates + AA's
cubic béziers); fills via `graphics.fill({fillRule})`, strokes via
`graphics.stroke({width,cap,join})`. Trim Paths → partial stroking. Per-frame
rebuild is fine for typical shape counts (note in perf budget). Shapes live in
the 2D renderer, so this ships **without** the 3D track.

---

## C. Animated glTF / GLB import (Track 3E-4)

- **Load** via three.js `GLTFLoader` (+ `DRACOLoader` optional). Store `.glb`
  content-hashed through the existing asset pipeline; `MeshSceneObject.modelAssetId`.
- **Animation** — glTF's three kinds all supported by three.js: node TRS
  keyframes, **skeletal** (`SkinnedMesh` + bones), **morph targets**. Clips →
  `AnimationMixer`; **drive from the GrapiX timeline** by `mixer.setTime(frame /
  fps)` each evaluated frame (scrub-accurate, not free-running). Object fields:
  `clipName`/`clipIndex`, `timeScale`, `loop`, `frameOffset`.
- **Materials** — glTF PBR (`MeshStandardMaterial`/`MeshPhysicalMaterial`:
  baseColor/metalness/roughness/normal/emissive/occlusion). Imported named
  sub-meshes/materials become **bindable faces** via the existing
  `getBindableFaces` seam — completing the Phase 1 "model" placeholder and
  material test case #7 (per-model-element binding) *visually*.

## Canvas / renderer decision — **LOCKED**

**PixiJS v8 for all 2D (shapes, pen-tool bézier paths, text, images, masks) +
three.js for 3D**, composited via **B1a stacked canvases** (§3). Pixi's
`GraphicsPath` covers AE-style vector authoring; rebuilding an animating path per
frame is acceptable. *Alternative noted for the future:* Skia/**CanvasKit-wasm**
(the vector engine behind Flutter/Rive) if vector fidelity or per-frame
tessellation cost ever becomes a bottleneck — it would replace the Pixi 2D path
behind the same `SceneRenderer` interface, a swap not a rewrite.

---

## 6. Phased plan

Two tracks sharing the **animation engine (§A)**. **Track S (Shapes / Pen tool /
Path animation) is the priority** and ships entirely on the existing 2D renderer —
it does **not** depend on the 3D track. Track 3E proceeds in parallel. Each phase
is independently shippable, typechecks, has tests, and is verified live (editor
pixel-extraction + daemon headless render), matching the Phase 0–2 workflow.

### Shared foundation (do first — both tracks need it)
- **AN-1 — Animation engine.** Typed `Animatable<T>` per property, interpolator registry (number/vec/colour), `evaluateSceneAtFrame`, and wire `CanvasStage` playback→render (§A). Migrate the current scalar keyframes. Deliverable: existing transform/opacity keyframes actually animate in the viewport (they don't today). Files: `Shared/shared-types` (animation model + evaluator + tests), `editorStore` (per-property keyframe actions), `CanvasStage`, `TimelinePanel`.

### Track S — Shapes / Pen tool / Path animation (HEADLINE, 2D-only)
- **S-1 — Shape object + bézier path rendering.** `ShapeSceneObject` + `BezierPath` (§B.1–B.2); render fill/stroke via Pixi `GraphicsPath`; subsume `line`. Static shapes first. Tests: path→geometry, pixel-extraction of a filled/stroked bézier.
- **S-2 — Pen tool.** Create/edit path interaction on the canvas overlay (add corner/smooth vertices, drag handles, break handles, close, insert/delete vertex, convert corner↔smooth), all undoable (§B.4). Inspector shows path/fill/stroke.
- **S-3 — Path animation.** `path` becomes `Animatable<BezierPath>`; `interpolatePath` with the **matched-vertex-count** guard (§B.3); keyframe a path from the pen tool (edits target the active keyframe, count preserved/padded); **Trim Paths** (animated draw-on). This is the headline deliverable.
- **S-4 — Shape operators + masks.** Gradients, repeater, merge/boolean, round corners; mask paths (add/subtract/intersect, feather) reusing the same path model.

### Track 3E — 3D engine
- **3E-0 — Spike & de-risk.** three.js layer behind the `SceneRenderer` interface; one **lit 3D cube** under a **perspective camera** with **one directional + one point light** actually shading it; composited into the Pixi stage (B1a). No data-model change yet (hard-coded demo scene). Deliverable: go/no-go on A1 + B1a, measured. Files: new `Editor/apps/editor-web/src/rendering/three/*`, compositing hook in `GpuSceneStage`.
- **3E-1 — 3D data model.** Transform3D, light/camera/material/model fields, `activeCameraId`, migration + fixtures + tests (`Shared/shared-types`). No renderer change beyond reading defaults.
- **3E-2 — Editor 3D scene + active camera.** Renderer3D mirrors the SceneDocument: real meshes for cube/cylinder/torus/sphere/slab, active-camera view/projection, depth composite with 2D. 3D transform gizmos (move/rotate/scale) and viewport camera nav. Inspector: 3D transform panel. Files: `rendering/three/*`, `editorStore` (3D transform actions, `setActiveCamera`), `Inspector`, `PropertiesSidebar`.
- **3E-3 — Real lighting.** Point/directional/spot illuminate meshes; light gizmos reflect real params; `basic-lit`/`pbr` materials shaded per the contract; optional shadow maps (sub-slice). Inspector: light property panel.
- **3E-4 — Animated glTF/GLB import.** `GLTFLoader` (+ optional Draco); clips driven from the timeline via `mixer.setTime(frame/fps)` (§C); node/skeletal/morph animation; PBR materials; imported sub-materials exposed as **bindable faces** (completes test case #7 visually and the Phase 1 model placeholder). glb stored content-hashed; Material Manager shows model assets.
- **3E-5 — Daemon 3D pipeline (wgpu).** Depth buffer, camera UBO, 3D model matrices (extend the existing model-matrix path), mesh vertex/index buffers, light UBO array, lit WGSL shader per the 3D contract, glTF via the `gltf` crate. Headless parity validation vs the editor.
- **3E-6 — Compositing decision (B2 evaluation).** Prototype the unified 2D-as-planes scene graph; decide migrate-vs-keep based on interleaving needs and 2D-fidelity risk. Only then consider retiring the PixiJS 2D path.

**Cross-cutting (every phase):** honour the "no silent fallback" rule — unimplemented 3D features (a light type, a material param) are reported as warnings, never faked; keep the `SceneRenderer` interface swappable; keep 2D scenes rendering unchanged.

---

## 7. Risks & mitigations

- **Renderer divergence (biggest).** three.js vs wgpu 3D lighting won't be bit-exact. → Daemon authoritative; documented 3D contract; tolerance-based parity tests; A2 swap path preserved.
- **2D regression.** Compositing/migration could break existing 2D. → B1 keeps the 2D pipeline intact first; full 2D re-validation gates any B2 migration.
- **Scope / velocity.** This is multi-week. → Strict phasing; 3E-0 spike before commitment; each phase shippable.
- **Performance.** Broadcast 60fps with lights/shadows. → Budget per phase; measure in 3E-0; shadows are an opt-in sub-slice.
- **Colour/alpha correctness.** Linear workflow, premultiplied alpha, sRGB output must match the daemon and the existing blend contract. → Extend `shader-contract.md`; reuse the premultiplied-alpha discipline already in the 2D path.
- **Data migration.** Old scenes and published `.gfxpkg`. → All 3D fields optional with defaults; idempotent normalization; fixtures re-emitted; version bump only if unavoidable.
- **Path-animation vertex mismatch (headline-feature #1 risk).** AE/Lottie can only interpolate paths with equal vertex counts. → Pen tool + keyframe UX preserve/pad vertex count when keying a path; `interpolatePath` guards mismatched counts and warns (never morphs wrongly); consider auto-insert of coincident vertices.
- **Per-frame path tessellation cost.** Rebuilding Pixi geometry from an interpolated bézier every frame. → Fine for typical shape counts; budget/measure; cache when a shape isn't animating; CanvasKit is the escape hatch.
- **Animation-model refactor blast radius.** Moving from scalar-snapshot keyframes to typed per-property `Animatable`. → Do it as AN-1 with migration + tests before either track builds on it; keep `SceneTimeline{fps,durationFrames}`.

---

## 8. Decisions

**Locked:**
- **Decision A — editor renderer: three.js (A1)** behind a swappable `SceneRenderer` interface.
- **Parity bar: documented best-effort** — daemon authoritative, three.js matched to a documented 3D contract, tolerance-based parity tests (not bit-exact).

**Locked (this revision):**
- **Canvas:** PixiJS v8 (all 2D incl. shapes/pen-tool paths) + three.js (3D), stacked-canvas composite; CanvasKit reserved as a future swap.
- **glTF v1 = animated** (node/skeletal/morph), not static-only — the user requires animated glTF import.
- **Shape/path model = Lottie/Bodymovin-shaped** bézier (`v`/`i`/`o`/`c`).
- **Priority = Track S (pen tool + path animation) first**, on the 2D renderer, after the shared AN-1 animation engine.

**Still open (need sign-off):**
1. **Build order:** AN-1 → Track S (S-1…S-4) first, with Track 3E (3E-0 spike…) in parallel/after? (recommended) — or run the 3E-0 spike first to de-risk 3D while AN-1 lands?
2. **Decision B — 2D/3D coexistence:** **B1a stacked canvases** to start (recommended) vs B1b render-to-texture.
3. **Shadows** — in v1 3D lighting (3E-3) or deferred?
4. **Primitive geometry source** — parametric three.js geometries vs authored-to-match-daemon.
5. **Colour management** — linear-light workflow + output transform (none vs ACES) to match the daemon + premultiplied-alpha 2D blend contract.

## 9. Refinement log

- 2026-07-23a: Decision A locked to three.js; parity bar documented best-effort. Split Decision B (B1a/B1b/B2), recommended B1a. Added `SceneRenderer` interface (§5.1), coordinate/2D-plane interop (§5.2), active vs nav camera (§5.3).
- 2026-07-23b: **Reframed to a Motion & 3D engine with the AE-style pen tool + animatable bézier paths as the headline.** Grounded the animation gap (scalar-snapshot keyframes, no evaluator, no path type, `line` is a bare polyline). Added the shared **animation-evaluation engine** (§A, typed `Animatable<T>` + `evaluateSceneAtFrame`), the **Shape/Pen-tool/Path-animation** architecture (§B, Lottie-shaped bézier + pen tool + `interpolatePath`), **animated glTF** (§C), and locked the canvas (Pixi 2D + three.js 3D). Restructured the plan into **AN-1 (shared) → Track S (pen tool, prioritized) ‖ Track 3E**. (Planned web-research citations deferred — session usage limit; to be added on reset.)
