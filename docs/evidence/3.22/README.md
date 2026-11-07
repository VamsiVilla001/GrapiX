# 3.22 evidence, increment 1: the typed effect registry and the pointwise effects

Build-plan row `3.22`. Recorded 8 Nov 2026 (Claude). Reference GPU: NVIDIA
GeForce RTX 3070 Ti. Backends: DX12 (FXC) and Vulkan. Release builds. Row
status: **active**. The nine spatial effects are not drawn yet, and the
tie-aware reading of the 4.4 threshold below awaits the user's approval.

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
| Rounding ties in the GPU-vs-CPU gate | Tie-aware 4.4 (below) | 0.81; 0.61 that the user must approve it |

`jg` classified EffectCraft's effect code first: its registry keys effects by
string (`"ec.blur.gaussian"`) and reads parameters by string
(`params.f("blurriness")`), allocates images per frame and falls back to the
CPU. That is exactly what 3.22 forbids, so only the kernels and formulas are
ported.

## What changed

| Piece | Where |
|---|---|
| Contract | `Shared/contracts/src/effect.rs`: `EffectInstance { effectId, enabled, effect }`, `Effect` with 16 typed variants (the row's first set), `Effect::visit` as the one parameter table with domains, `validate_effects`. `ObjectBase.effects`. `Refusal::EffectInvalid`. Generated TS `EffectInstance` is a tagged union. |
| Keyframing | `animation.rs`: `is_animatable_on`, `effect_parameter_domain`; key values, bezier extrema and base values checked against the parameter's domain; switches and choices take hold keys only; `set_base_property` writes through the typed table. |
| Refusals | Spatial effects refuse at publish as `ScenePropertyNotDrawable` (owner 3.22). An unknown tag fails to parse, naming it. A malformed stack refuses as `EffectInvalid`. |
| CPU reference | `services/render-engine/worker/src/effects.rs`: each effect packed once per frame into a fixed f32 block in the working space; `apply_pixel` / `apply_chain`. |
| GPU | `compositor/effects.wgsl` (the twin, reading the same block); `compositor/mod.rs`: per-layer `EffectChain` (steps, two ping-pong targets, uniforms and curve buffers built at prepare); one dispatch per effect per frame; `composite_with_effects`; `render_work.gpu_effect_dispatches`. |
| Order | Effects act before the layer's opacity, as in After Effects: an object with effects is drawn at full opacity on both paths and its opacity applies after them. |
| Editor | The viewport names a layer with effects as unsupported (13.5) instead of drawing it without them. |
| Fix to 3.20 | An explicit `"blendMode": "normal"` was refused as an unknown field; `blendMode` is now `Option`, test added. |

Exact identities: a power of 1 (Levels gamma 1, modern Brightness &
Contrast at zero) and Hue/Saturation with no change return the pixel
unchanged on both paths. Before this they moved values by a GPU `pow`'s or
an HSL round trip's rounding.

## Gates run

| Test | DX12 | Vulkan |
|---|---|---|
| `effect::tests` (4) and `animation::tests::every_effect_parameter_is_keyframable_through_its_typed_table` | pass | — |
| `effects::tests` (4, CPU formulas, identities, transparency) | pass | — |
| `compositor::effect_tests::gpu_effect_kernels_equal_the_cpu_reference`: 14 settings × 2 spaces × 4,096 pixels incl. subnormal and over-range | **0 mismatches** (within 2e-4) | pass |
| `engine::effect_tests::every_pointwise_effect_matches_its_cpu_reference_on_the_gpu`: 15 cases incl. a 3-effect chain × 2 spaces through the Engine; trace `gpu-compositor`, 0 CPU rasterisations, one effect dispatch per effect | pass | pass |
| `engine::effect_tests::animated_effect_parameters_and_a_hold_keyed_enable_match_frame_by_frame`: gamma, hue (ease-in-out), exposure and a hold-keyed `enabled` at frames 0, 10, 19, 20, 35, 50 | pass | pass |
| `engine::effect_tests::spatial_and_unknown_effects_refuse_by_name` | pass | pass |
| All worker hardware tests (3.16, 3.20, 3.21 unchanged) | 22/22 | 18/18 |

`npm run check` exit 0: boundaries OK, codegen 376 current, 40 Node and 405
Editor tests, 764 Rust passed / 0 failed / 25 ignored, conformance 500 passed /
0 failed / 8 skipped.

## Results and the 4.4 threshold

| | DX12 | Vulkan |
|---|---|---|
| Static cases (15 × 2 spaces) | 30 | 30 |
| Byte-identical to the CPU frame | 28 | 29 |
| Strict 4.4 (≤1 code, ≤0.1% pixels differing) | 28 | 29 |
| Tie-aware 4.4 | 30 | 30 |
| Worst channel difference | 1 code | 1 code |
| Worst working-space difference (relative) | 1.9e-5 | 9.2e-6 |
| Differing pixels that are not proven tie flips | 0 | 0 |
| Animated frames, strict / tie-aware | 9 / 12 of 12 | 9 / 12 of 12 |

Every remaining difference is a rounding tie. In an sRGB project the
Preview encode is v·255, so decimal values sit exactly on code ties (0.5 →
127.5, 0.7 → 178.5, 0.1 → 25.5). The GPU fuses multiply-adds and divides to
about 2.5 ULP, so a flat cell on a tie can come out one code either side,
across the whole cell. The same 418 one-code flips appear in this scene with
**no effects at all**, through the existing compositor, so this predates
3.22. Effect parameters create ties too: Colorize at saturation 0.6 and
lightness 0.25 turns black into exactly 0.1 (306 pixels).

**Tie-aware 4.4** (Jev, pending the user): no channel more than one code
apart, and at most 0.1% of pixels differing other than proven tie flips. A
differing pixel is a proven tie flip when the GPU's bytes are exactly the
CPU encode of its own working floats and those floats are within 1e-4
(relative above 1e-3) of the reference's, far below a code step of 3.9e-3.
The strict count is recorded in every row of `effects.json` and
`animated.json` (`strict4_4`, `differing`, `notTieFlips`).

## Still owed in 3.22

- The spatial effects: Gaussian, box and directional blur, glow, drop
  shadow, gradient ramp and the three wipes (padding sized from channel
  extrema at prepare).
- The user's decision on the tie-aware threshold.
- Hue/Saturation's per-colour ranges and Levels/Exposure individual-channel
  modes beyond what the contract carries now are not in the contract.
