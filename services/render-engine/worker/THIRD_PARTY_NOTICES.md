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

## Blend modes (3.20)

`src/blend.rs` (the CPU reference) and `src/compositor/blend.wgsl` (its GPU
twin) port the After Effects and Photoshop blend-mode formulas and the
Dissolve `hash_noise` from EffectCraft's `crates/color/src/blend.rs`,
`crates/raster/src/lib.rs` and `crates/gpu/src/shaders/common.wgsl`, pinned at
`9a7d3e76991d5372448033b473dc12c2480a6a04`.

Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors.
Used under the MIT licence retained in `EFFECTCRAFT-LICENSE`.
GrapiX's own: the mode numbering generated from the contract enum, the
bit-pattern coverage, flush and bound guards that keep NaN and infinity out
of every layer (EffectCraft's DX12 32-bit runs emitted NaN), the
overflow-safe order in colour clipping, the per-object Dissolve seed, the
zero-opacity skip, and the stencil clamp of luminance to [0, 1].

## Effects (3.22)

`src/effects.rs` (the CPU reference) and `src/compositor/effects.wgsl` (its
GPU twin) port the Fill, Tint, Levels, Curves (Fritsch–Carlson), Hue/
Saturation, Brightness & Contrast and Exposure formulas and the HSL
conversions from EffectCraft's `crates/effects/src/color_fx.rs` and
`crates/color/src/lib.rs`, pinned at `9a7d3e76991d5372448033b473dc12c2480a6a04`.

Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors.
Used under the MIT licence retained in `EFFECTCRAFT-LICENSE`.
EffectCraft's string-keyed registry and per-frame allocation were not ported.
GrapiX's own: the typed contract, the packed parameter block both renderers
read, the prepared per-layer effect chain, coverage tests on bit patterns,
transparent pixels never gaining coverage, exact identity settings, Exposure
in linear light in either working space, and effects before opacity.

## Spatial effects (3.22)

`src/effect_chain.rs` (the CPU reference) and the spatial passes of
`src/compositor/effects.wgsl` port the box radii and box passes, the
directional blur, glow (bright pass, blur, combine) and drop shadow (make,
blur, combine) kernels, and the linear and radial wipe masks from
EffectCraft's `crates/raster/src/blur.rs`, `crates/gpu/src/shaders/
kernels.wgsl` and `crates/effects/src/misc.rs`, pinned at
`9a7d3e76991d5372448033b473dc12c2480a6a04`.

Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors.
Used under the MIT licence retained in `EFFECTCRAFT-LICENSE`.
GrapiX's own: the fixed pass plan sized at prepare from every animated
frame, one running sum per line in both directions, layer-space coordinates,
the gradient ramp, the iris star, the radial wipe's feather in pixels, and
the shared polynomial trigonometry both renderers evaluate.
