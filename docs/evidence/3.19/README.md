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

### Still open in 3.19

Clip groups (`GroupObject.clipChildId`), track mattes (alpha, inverted alpha,
luma, inverted luma, by explicit source id, a matte source not drawn on its
own), trim start/end/offset honoured on the GPU and the CPU, mutations, and
the Jev and Laya acceptance run.
