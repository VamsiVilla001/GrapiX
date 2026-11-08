# 3.22 evidence: the typed effect registry and the broadcast effect set on the GPU

Build-plan row `3.22`. Recorded 8 Nov 2026 (Claude). Reference GPU: NVIDIA
GeForce RTX 3070 Ti. Backends: DX12 (FXC) and Vulkan. Release builds.
Row status: **done**. Two increments: the contract and the seven pointwise
effects (commit 975f693), then the nine spatial and coordinate effects.

## Decisions (Jev, TypeSafe `jev-1.14.0`, on the user's instruction)

`jev-design-decision.json` and `jev-tie-decision.json` hold the answers.

| Question | Choice | Confidence |
|---|---|---|
| Where effects live | Ordered stack on `ObjectBase`, applied to the layer's pixels before transform and blend; adjustment layers later | 0.97 |
| Typing | One serde-tagged enum, a typed struct per effect, a stable `effectId` per entry | 0.92 |
| Keyframe addressing | `effects.<effectId>.<path>` resolved through each effect's typed table | 0.56 (0.71 vs 0.29 for a typed channel target) |
| GPU memory for spatial effects | Size padding at prepare from exact channel extrema; refuse by name over the limit | 1.00 |
| First increment | Contract, registry, refusals, keyframing, per-layer GPU pass, pointwise effects | 0.96 |
| EffectCraft | Port kernels and formulas only; write GrapiX's own contract, chain and resource lifecycle | yes, 0.96 |
| Rounding ties in the GPU-vs-CPU gate | Tie-aware 4.4 (below); approved by the user on 8 Nov 2026 and recorded in the build plan | 0.81 |

`jg` classified EffectCraft's effect code first: its registry keys effects by
string (`"ec.blur.gaussian"`) and reads parameters by string
(`params.f("blurriness")`), allocates images per frame and falls back to the
CPU. That is exactly what 3.22 forbids, so only the kernels and formulas are
ported.

## What changed

| Piece | Where |
|---|---|
| Contract | `Shared/contracts/src/effect.rs`: `EffectInstance { effectId, enabled, effect }`, `Effect` with 16 typed variants (the row's first set), `Effect::visit` as the one parameter table with domains, `validate_effects`. `ObjectBase.effects`. `Refusal::EffectInvalid`. Generated TS `EffectInstance` is a tagged union; `Shared/generated-ts/schemas/EffectInstance.schema.json` is the JSON Schema (16 variants, 24 definitions). |
| Keyframing | `animation.rs`: `is_animatable_on`, `effect_parameter_domain`; key values, bezier extrema and base values checked against the parameter's domain; switches and choices take hold keys only; `set_base_property` writes through the typed table. `every_parameter_of_every_effect_takes_a_keyframe` walks the whole registry. |
| Refusals | An unknown tag fails to parse, naming it. A malformed stack refuses as `EffectInvalid` (conformance check added). |
| Layer source | `services/render-engine/worker/src/layer_source.rs`: the object drawn once in its own layer space, padded by the stack's largest reach over every frame (`effect_chain::layer_extent`). The GPU scene and the CPU reference share it (moved from 3.16's `compositor/scene.rs`; unchanged with no padding). |
| Pass plan | `effect_chain.rs`: each effect expands at prepare into a fixed list of passes (per-pixel colour, ramp and wipe; box passes along rows or columns, three per axis for a Gaussian; a gather for the directional blur; save, bright or make, blur and combine for glow and drop shadow). Per frame only the packed parameters change; a Box Blur's iteration count is sized to its largest over the animation, unused passes pack as identity. The same module is the CPU reference: `EffectPlan::run`. |
| GPU | `compositor/effects.wgsl`: `effect_step` (one invocation per pixel) and `effect_line` (one per row or column, one running sum) over one bind layout with a fifth binding for the saved input; three layer-sized targets per chain, built at prepare; one dispatch per pass per frame (`gpu_effect_dispatches`). |
| Order | Effects act on layer-space pixels before the layer's transform and opacity, as in After Effects. The CPU reference warps the effected layer with the compositor's own inverse-affine rows and sampler (`RasterSurface::warp_blend`, `compositor::layer_rows`). |
| Editor | The viewport names a layer with effects as unsupported (13.5) instead of drawing it without them. |
| Fix to 3.20 | An explicit `"blendMode": "normal"` was refused as an unknown field; `blendMode` is now `Option`, test added. |

Exact identities: a power of 1 (Levels gamma 1, modern Brightness &
Contrast at zero) and Hue/Saturation with no change return the pixel
unchanged on both paths. The wipes evaluate the same polynomial `atan2`,
`sin` and `cos` on both paths, because a GPU's built-ins are approximations
of its own and a feathered edge magnifies the difference (the radial wipe's
worst working-space difference fell from 1.8e-3 to 7e-6).

## Gates run

| Test | DX12 | Vulkan |
|---|---|---|
| `effect::tests` (4), `animation::tests::every_effect_parameter_is_keyframable_through_its_typed_table`, `every_parameter_of_every_effect_takes_a_keyframe` (over 100 parameters) | pass | — |
| `effects::tests` (4) and `effect_chain::tests` (6: blurs keep coverage and spread, shadow offset, wipes hide by completion, ramp, glow, reach sized from every frame) | pass | — |
| `compositor::effect_tests::gpu_effect_kernels_equal_the_cpu_reference`: 14 pointwise settings × 2 spaces × 4,096 pixels incl. subnormal and over-range | **0 mismatches** (within 2e-4) | pass |
| `engine::effect_tests::every_effect_matches_its_cpu_reference_on_the_gpu`: 30 cases (every effect, several settings, a 3-effect chain) × 2 spaces through the Engine, on 10 layers incl. one rotated, scaled and at a fractional position; trace `gpu-compositor`, 0 CPU rasterisations, one dispatch per planned pass | pass | pass |
| `engine::effect_tests::animated_effect_parameters_and_a_hold_keyed_enable_match_frame_by_frame`: gamma, eased hue, exposure, blurriness, Box Blur iterations 1→4, shadow distance, and a hold-keyed `enabled`, at frames 0, 10, 19, 20, 35, 50 | pass | pass |
| `engine::effect_tests::unknown_and_invalid_effects_refuse_by_name` | pass | pass |
| All worker hardware tests (3.16, 3.20, 3.21 unchanged in their assertions) | 22/22 | 18/18 |

`npm run check`: see the commit message for the final figures.

## Results and the 4.4 threshold

| | DX12 | Vulkan |
|---|---|---|
| Static cases (30 × 2 spaces) | 60 | 60 |
| Byte-identical to the CPU frame | 32 | 34 |
| Strict 4.4 (≤1 code, ≤0.1% pixels differing) | 38 | 39 |
| Tie-aware 4.4 | 60 | 60 |
| Worst channel difference | 1 code | 1 code |
| Worst working-space difference (relative) | 8.3e-5 | 9.3e-5 |
| Differing pixels that are not proven tie flips | 0 | 0 |
| Animated frames, strict / tie-aware | 5 / 12 of 12 | 4 / 12 of 12 |

Every remaining difference is a rounding tie. In an sRGB project the
Preview encode is v·255, so decimal values sit exactly on code ties (0.5 →
127.5, 0.7 → 178.5). The GPU fuses multiply-adds and divides to about 2.5
ULP, so a flat cell on a tie can come out one code either side, across the
whole cell; the same 418 one-code flips appear in this scene with no effects
at all through the existing compositor. Blurs and wipes have fewer flat
regions but more arithmetic, so their working-space differences are larger
(to 9e-5, still 2% of a code step) and their flips are scattered.

**Tie-aware 4.4** (Jev; approved by the user, 8 Nov 2026; build plan, Phase
3 notes): no channel more than one code apart, and at most 0.1% of pixels
differing other than proven tie flips. A differing pixel is a proven tie
flip when the GPU's bytes are exactly the CPU encode of its own working
floats and those floats are within 1e-4 (relative above 1e-3) of the
reference's. The strict count is recorded in every row of `effects.json`
and `animated.json` (`strict4_4`, `differing`, `notTieFlips`).

## Frame cost

`dx12/frame-budget-3.21-rerun.json`: 3.21's workloads carry no effects, so
the effect pass is not on their frame path; medians are within 1–2% of
3.21's figures (lower third 1080p p99 11.0 ms, as measured since 3.20; see
`docs/evidence/3.20`). An effect chain costs one full-layer pass per planned
pass on the layer's padded texture, not on the stage.

## Not in this row

Hue/Saturation's per-colour ranges, Levels' and Exposure's individual-channel
groups beyond the contract's fields, Glow's A & B colours and operations other
than Add, and Fill's mask options are not in the contract; they are named
findings for an importer, never dropped. Adjustment layers (effects on
everything below) are a later row.
