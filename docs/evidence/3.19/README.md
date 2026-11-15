# 3.19 evidence: GPU masks, clip groups, track mattes and trim paths

Build-plan row `3.19`. **Active, 15 Nov 2026.** Taken on the user's
instruction ("start with the unblocked pointers"), after 3.18.

## User decisions (15 Nov 2026)

Put to the user before any code, as each one changes the contract:

- **Masks live on each object** (`ObjectBase.masks`), as After Effects layer
  masks.
- **A track matte names its source by explicit id**, not by "the layer
  above".
- **The agreed set:** clip groups as `GroupObject.clipChildId`; static masks
  and clip shapes drawn at prepare; track mattes as per-frame matte targets.
- **Scope:** 3.19 adds the contract and the rendering. 11.47 keeps the Editor
  tools, pen paths, animated trim and its goldens.

Jev and Laya were run on the design first (`design-jev-laya.json`). They
agreed on the clip child, when masks are drawn and the matte target, and split
on where masks live (Jev: on each object; Laya: mask objects) and on how a
matte names its source (Jev: explicit id; Laya: the layer above). Both said the
user decides; the user chose as above.

### Second round, before clip groups (`clip-design-jev-laya.json`)

- **Clips are per-frame mattes** (user, replacing "static clip shapes"):
  the clip child is still drawn once at prepare, into its own layer, and is
  warped each frame into a matte target, so a clip child or clip group that
  moves or fades renders instead of refusing. Jev and Laya both chose this,
  and both leaned towards asking the user (Jev 0.57, Laya 0.78).
- **The clip carries the clip child's own opacity** (user). Jev chose this,
  with low confidence. Laya chose effective opacity, which applies a group's
  opacity twice when checked by hand: at 50% the clipped children would show
  at 25%.
- Jev and Laya agreed, and it was checked by hand: a hidden clip child still
  clips (it is never drawn anyway); every other descendant of the group is
  clipped, whatever its draw order; the clip child is a drawing object.

## Increment 1: layer masks

### What changed

- **Contract.** `ObjectBase.masks: Option<Vec<Mask>>` (absent and empty both
  mean none). A `Mask` is a closed `BezierPath` in the object's own
  coordinates plus `mode` (`none`, `add`, `subtract`, `intersect`,
  `difference`; default `add`), `feather` (0 to 250 px), `expansion`
  (-1000 to 1000 px), `opacity` (0 to 1, default 1) and `inverted`. At most 16
  per object. Static: masks are not animatable yet.
- **Refusal.** `Refusal::MaskInvalid { object, index, detail }`
  (`maskInvalid`), from one rule (`drawability::mask_problem`) shared by the
  validator and the engine: a mask on an object that draws no pixels (group,
  layer, camera, light, marker, mesh, paint), too many masks, an open path or
  one under three vertices, tangents that do not match the vertices, a
  non-finite point, or a value out of range. The validator reports it at
  `objects[i].masks[j]` with the mask as the given value.
- **The After Effects model, once, on both paths.** For each mask: its
  coverage, grown (a union with a band of width 2|e| around the path) or shrunk
  (multiplied by one minus that band), feathered by a normalised Gaussian
  (sigma = feather / 2, radius ceil(3 sigma), zero outside the layer),
  inverted, then scaled by its opacity. Masks fold in order: add
  `a + c - ac`, subtract `a(1 - c)`, intersect `ac`, difference
  `a + c - 2ac`; `none` is skipped. The fold starts at 0 when the first mask
  that is not `none` adds, else at 1. The layer's pixels are multiplied by the
  result before its effects.
- **CPU twin:** `services/render-engine/worker/src/rasterise/mask.rs` (coverage
  by Vello CPU over the layer's coverage window).
- **GPU:** `compositor/mask.wgsl` and `GpuDrawer::apply_masks`. Fill and band
  coverage come from Vello GPU; `init`, `shape`, `blur_h`, `blur_v`, `fold`
  and `apply` passes run over the layer's float buffer at prepare, before the
  copy into the layer texture. Nothing waits for the GPU.
- **Wiring.** Paths, text and images all take masks. Vector and text masks are
  placed by the same transform as the object's own paths; an image's raster is
  in box coordinates, as its masks are. A masked object is drawn in its own
  layer space on the CPU reference as well, like an object with effects.

### Executed checks

- `cargo test -p gx-render-worker --lib rasterise::mask`: 5 passed (each
  mode's fold and the starting alpha, inversion and opacity, expansion grow
  and shrink, the feather weights and the softened edge, the multiply).
- `cargo test -p gx-render-worker --lib gpu_masks_match -- --include-ignored`
  (RTX 3070 Ti): the GPU passes equal the CPU twin to within 1.5/255 under five
  masks (every mode, both feathers, both expansions, inversion, opacity) at
  three sizes and origins.
- `GX_GPU_316_BACKEND=dx12|vulkan cargo test -p gx-render-worker --lib
  gpu_engine_draws_masked -- --include-ignored`: a masked image, rect, shape
  and text line, in both working spaces, Program and Preview within one code
  of the CPU reference on DX12 and Vulkan; strict 4.4 reading (LinearSrgb):
  Program 4.8e-7 of pixels differ, Preview 2.1e-4, worst one code. The masks
  land where their object coordinates put them (inside, subtracted, the hole,
  the 70% ellipse differenced back, the image corner, the caption's first
  200 px).
- `cargo test -p gx-contracts --lib mask`: the validator refuses each bad mask
  by index, hidden objects too, and accepts every range's extremes; the
  structured refusal carries `objects[0].masks[0]` and the mask.
- Conformance refusal audit: `MaskInvalid` is driven; two parity cases (a
  feather past the limit, a mask on a group) refuse identically in the
  validator and over the publication wire.

- Gate: `cargo fmt --all`, `cargo clippy --workspace --all-targets -- -D
  warnings` and `npm run check` exit 0 (46 Node, 412 Editor, 860 Rust passed,
  0 failed, 34 ignored; conformance 587/0/9). Hardware worker suite
  (`cargo test -p gx-render-worker --lib -- --include-ignored`): 184/0/0.

## Increment 2: clip groups

### What changed

- **Contract.** `GroupObject.clipChildId: Option<String>` names one of the
  group's `childIds`. `Refusal::ClipGroupInvalid { group, detail }`
  (`clipGroupInvalid`) comes from `drawability::clip_group_problem`, shared by
  the validator and the engine, at `objects[i].clipChildId`. It refuses a clip
  child that is not one of the group's children, is not in the scene, or draws
  no pixels (the drawing kinds are rect, ellipse, line, shape, text and image:
  `drawability::draws_pixels`, which masks now use too).
- **One plan for both paths** (`worker/src/clip.rs`, `ClipPlan`). It names
  each object's clip as the clip child of its nearest enclosing clip group
  that does not name the object itself, and it marks the clip children. A
  nested clip child is clipped by the outer clip, so each matte already holds
  every clip around it.
- **GPU.** A clip child is a matte layer. In the frame it passes the backdrop
  through (opacity 0), so the ping-pong chain and the final target are
  unchanged. Each tile has one matte target per clip child. Before the frame's
  layers, each matte is composited over the whole tile from a zero backdrop
  that is never written, outer mattes before inner ones. It is placed by
  `matte_state`: its effective transform at its own opacity, whether visible or
  not, and with no area at zero scale. `composite.wgsl` gains binding 4 (the
  clip's matte target); a clipped layer's sample is multiplied by the matte's
  alpha before its blend.
- **CPU reference.** A clip child is drawn in its own layer space and never
  drawn itself. A clipped object is drawn alone on a transparent canvas,
  multiplied by its clip's matte (built once per frame, outermost first) and
  blended in its mode. Effects, masks, opacity and every blend mode keep their
  order.

### Executed checks

- `cargo test -p gx-render-worker --lib clip`:
  - `ClipPlan` names the nearest clip, and an inner clip child is clipped by
    the outer one.
  - The CPU reference clips at the clip child's own opacity (group 50% times
    clip 80% = alpha 102, not 51), with nested clips multiplying (163). A
    hidden clip still clips, and a visible clip child is not drawn.
- `GX_GPU_316_BACKEND=dx12|vulkan cargo test -p gx-render-worker --lib
  gpu_engine_clips -- --include-ignored` (RTX 3070 Ti). The fixture is a
  group at 50% clipped by a hidden ellipse at 80% that moves 60 px over ten
  frames, holding a fill, a Multiply rect and a nested clip group with a masked
  fill; a second group with a visible clip child; and an unclipped rect.
  - Program and Preview at frames 0, 5 and 10, in both working spaces, are
    within one code of the CPU reference; the strict 4.4 reading is 0
    differing pixels at frames 0 and 10.
  - Alpha lands where expected: 0.4 and 0.64 inside the clips, 0 outside, and
    the clip follows its animation.
- `cargo test -p gx-contracts --lib clip`: each `ClipGroupInvalid` detail.
- Conformance refusal audit: `ClipGroupInvalid` is driven; a stray clip child
  refuses identically in the validator and over the publication wire.
- Gate: fmt, clippy -D warnings and npm run check exit 0 (46 Node, 412 Editor, 863 Rust passed, 0 failed, 35 ignored; conformance 589/0/9); hardware worker suite 187/0/0. The timed conformance check "headless renders while Program runs add no late or missed Program frame" failed in two earlier full gates on this tree (22 late/38 missed, then 2/2) and in 1 of 4 standalone runs; an A/B of standalone conformance alternating HEAD a17a545 (exported, own target dir) and this tree passed 3/3 each, and neither timing scene touches the clip code (plain rects); the clip-free per-tile zero texture was removed anyway. Treat that check as load-sensitive in debug builds.

### Still open in 3.19

Track mattes (alpha, inverted alpha, luma and inverted luma, by explicit
source id, a matte source not drawn on its own), trim start/end/offset
honoured on the GPU and the CPU, mutations, and the Jev and Laya acceptance
run.
