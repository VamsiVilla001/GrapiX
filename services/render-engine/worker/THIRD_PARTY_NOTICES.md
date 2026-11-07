# Render worker component ports

`src/compositor/composite.wgsl` ports transparent bilinear sampling,
normal source-over blending and the affine warp dispatch from EffectCraft's
`crates/gpu/src/shaders/common.wgsl` and `kernels.wgsl`, pinned at
`9a7d3e76991d5372448033b473dc12c2480a6a04`.

Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors.
Used under the MIT licence retained in `EFFECTCRAFT-LICENSE`.
No EffectCraft crate is a product dependency. GrapiX supplies its own
prepare lifecycle, working-space contract, tile-local transforms, resource
ownership and named mapping refusals (ADR-0003).
