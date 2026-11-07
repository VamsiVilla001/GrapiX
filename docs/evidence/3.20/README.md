# 3.20 evidence: the full blend-mode set on the GPU

Build-plan row `3.20`. Recorded 8 Nov 2026 (Claude). Reference GPU: NVIDIA
GeForce RTX 3070 Ti. Backends: DX12 (FXC, the product's explicit choice) and
Vulkan. Rust 1.89, wgpu 30.0.1. Release builds.

## What changed

| Piece | Where | What it does |
|---|---|---|
| Vocabulary | `Shared/contracts/src/material.rs` `BlendMode` | Grows from 1.x's 10 modes to 38: the 27 Photoshop modes (`BlendMode::PHOTOSHOP`) and the After Effects ones (`BlendMode::AFTER_EFFECTS`), each exactly once. The first ten keep their wire names and places; the rest are appended. `add` and `linear-dodge` share a formula and stay separate because the menus name them separately; `alpha-mask` / `inverse-alpha-mask` are After Effects' Stencil / Silhouette Alpha under their 1.x names. |
| Layer property | `Shared/contracts/src/scene.rs` `ObjectBase::blend_mode` | Every 2D object's layer blend mode, from the same enum materials use (1.3). Omitted from the wire when `normal`, so existing scenes serialise unchanged. Generated TS: `blendMode?: BlendMode`. |
| CPU reference | `services/render-engine/worker/src/blend.rs` | The formulas, ported from EffectCraft (`crates/color/src/blend.rs`, `hash_noise`) at `9a7d3e7` with attribution, in GrapiX's own structure. |
| GPU twin | `services/render-engine/worker/src/compositor/blend.wgsl` | The same formulas in the same order of operations. Every layer pass in `composite.wgsl` calls `blend_pixel`; mode numbers are `M_*` constants generated from `BlendMode::ALL`, so they cannot drift from the contract. |
| CPU renderer | `prepared.rs` `compose`, `rasterise/mod.rs` `RasterSurface::blend_layer` | An object in a non-normal mode is drawn alone onto a canvas-sized layer and blended pixel by pixel through `crate::blend`. |
| GPU uniforms | `compositor/mod.rs` | 64-byte layer uniform: geometry and opacity as before, plus a u32 key (mode, Dissolve seed, the tile's first stage pixel as an integer hash key, never a float coordinate; invariant 38). The 3.16 refusal of non-normal modes is removed. |
| Editor viewport | `Editor/src/viewport.ts` | WebGL's fixed-function blending would draw any mode as normal (invariant 18), so a non-normal layer is named as unsupported and not drawn until the engine-rendered viewport (13.5). |

### Numerical guards (GrapiX's, not EffectCraft's)

EffectCraft's own DX12 32-bit runs emitted NaN, and not on every run: Darken on
11 October 2026, Classic Difference on 12 October 2026 (ADR-0003, memory.md
3.14). Both twins therefore apply the same rules, each tested on the bit
pattern (`bitcast`), which no compiler folds and no subnormal flush changes:

- an alpha covers nothing unless it is positive, normal and finite;
- an un-premultiplied colour and the shared coverage `sa·da` are flushed to 0
  when subnormal, as a flushing GPU would;
- after every blend, NaN becomes 0, ±infinity the largest finite value of its
  sign, a subnormal 0, and alpha is clamped to [0, 1];
- colour clipping (Hue, Saturation, Color, Luminosity) computes its ratio
  before multiplying, so over-range inputs cannot overflow in one twin and not
  the other;
- a layer at zero opacity (hidden, zero-scale) does nothing in any mode, so a
  hidden stencil cannot clear the frame; Stencil and Silhouette Luma clamp the
  luminance they scale by to [0, 1].

Dissolve's threshold is `hash_noise(stage x, stage y, seed)` with a seed from
an FNV-1a hash of the object id; Dancing Dissolve mixes in the scene frame, and
a scene that uses it counts as animated on the CPU path too.

## Gates run

| Test | Claim | DX12 | Vulkan |
|---|---|---|---|
| `blend::tests` (7, no GPU) | Published formulas; transparent source and backdrop identities; After Effects 32-bit classic and over-range formulas; Dissolve; no input among subnormal/tiny alphas and colours up to 3e38 yields a non-finite or out-of-range result (over 100,000 combinations); mode numbers follow the contract order | pass | pass |
| `compositor::blend_tests::gpu_blend_kernel_equals_the_cpu_reference_for_every_mode` | 4,096 pixel pairs per mode through the WGSL kernel. All GPU results finite with alpha in [0, 1]. The 3,511 pairs with colours up to 4x over range equal the CPU reference within 1e-4 relative | **0 mismatches in all 38 modes** | pass |
| `engine::blend_tests::every_blend_mode_composites_on_the_gpu_and_matches_its_cpu_reference` | Per mode and working space (76 cases), through the real Engine: the frame trace says `gpu-compositor` with 0 CPU rasterisations and one dispatch per layer; working-space floats equal the CPU renderer's within 1e-4 relative; Program and Preview are exactly the CPU encode of the GPU's own working pixels; no channel more than one code from the CPU frame | pass | pass |
| `engine::blend_tests::dancing_dissolve_changes_each_frame_and_matches_the_cpu_reference` | The pattern moves between frames on the GPU and matches the CPU renderer at each frame | pass | pass |
| `engine::blend_tests::regression_dx12_32_bit_darken_nan_of_11_october` | EffectCraft's failing scene shape (background, Add layer at 50%, rotated 17°, scaled 115/90%, 70% layer at a fractional position, 32-bit float targets) in Darken, rendered 200 times: every working-space value finite on every run, every run bit-identical to the first | pass | pass |
| `engine::blend_tests::regression_dx12_32_bit_classic_difference_nan_of_12_october` | The same for Classic Difference | pass | pass |

`modes.json` per backend has the per-mode figures; `nan-regression-*.json` the
regression runs.

### Results

| | DX12 | Vulkan |
|---|---|---|
| Cases (38 modes × 2 working spaces) | 76 | 76 |
| Program and Preview byte-identical to the CPU frame | 66 | 67 |
| Worst channel difference | 1 code value | 1 code value |
| Worst working-space difference (relative, absolute below 1e-3) | 3.7e-5 | 2.7e-5 |
| Most pixels with a 1-code difference in one case | 576 of 15,360 (Hue and Saturation, linear-srgb, Preview) | 348 |

Every differing code is a rounding-boundary flip: the GPU's bytes are exactly
the CPU encode of its own working pixels, and those pixels differ from the CPU
renderer's only by float rounding (the GPU fuses multiply-adds and divides to
2.5 ULP). Program (Rec.709) differs in no case; only Preview does, in modes
whose formula mixes by partial coverage. A flat 24×24 test cell whose exact
colour lands on a code boundary flips as a whole, which is why some cases
exceed 4.4's "at most 0.1% of pixels". 3.20's done-when asks for agreement with
the CPU reference, not the 4.4 pixel fraction; this is recorded rather than
hidden by moving the palette off boundaries.

## Unchanged gates (no assertion edited)

`engine::gpu_tests` (3.16: the six golden frames and the lower third still
byte-identical to the CPU renderer), `compositor::tests` (the Overlay-refusal
case now asserts that every mode is accepted; the struct literals gained
`seed: 0`) and `engine::output_tests` (3.21): DX12 18/18 across all ignored
worker tests, Vulkan 14/14 for the 3.16, compositor and 3.20 tests. `npm run
check`: exit 0; boundaries OK, codegen 353 current, 40 Node and 404 Editor
tests, 754 Rust passed / 0 failed / 21 ignored, conformance 499 passed / 0
failed / 8 skipped (387 before: 28 new material blend-refusal checks on each of
four peers).

## Frame cost

`dx12/frame-budget-after-3.20.json` re-measures 3.21's workloads with the
blend shader: medians within 1–3% of 3.21's on every workload. The 1080p lower
third's settled p99 was 11.1–11.7 ms in four runs against 6.6 ms in 3.21's
evidence. An A/B with the composite pass temporarily reverted to normal-only
source-over (`dx12/frame-budget-ab-normal-only-shader.json`) gave the same
11.0 ms, so the blend shader is not the cause; the 6.6 ms figure did not
reproduce on this machine on 8 Nov with either shader. 3.21 stays active.
