# 3.25 batch 1: Invert, Posterize, Threshold, Vibrance

Ported from EffectCraft (pinned reference, MIT OR Apache-2.0, ADR-0003): `crates/effects/src/misc.rs` and `color_fx.rs`.

- Contract: `Invert` (+`InvertChannel`), `Posterize`, `Threshold`, `Vibrance` in `Shared/contracts/src/effect.rs`; one parameter table (`Effect::visit`) drives keyframe validation, the Editor panel and the surface.
- Engine: kernels 19 to 22 in `services/render-engine/worker/src/effects.rs` (CPU) and `compositor/effects.wgsl` (GPU), one packed block.
- Panel: 20 available, 286 not yet ported.

## Evidence
- `cargo test -p gx-contracts --lib`: 283 passed. `cargo test -p gx-render-worker --lib`: 199 passed.
- Hardware GPU parity (`--ignored effect`): 4 passed, including `gpu_effect_kernels_equal_the_cpu_reference` with 7 new cases and `every_effect_matches_its_cpu_reference_on_the_gpu`.
- Mutations (one at a time, restored byte-identical, each fails a named test): B1-B9 (CPU), G1-G4 (WGSL, GPU parity), C1-C3 (contract and catalogue). B7 (vibrance weight) first survived because the test pixel sat at s = 0.5; a pixel at s = 0.8 now catches it.
- Gate: fmt 0, clippy 0, `npm run check` 0.

## Not done
Vulkan backend parity (`GX_GPU_316_BACKEND=vulkan`); batches 2 onward.
