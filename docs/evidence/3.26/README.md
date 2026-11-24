# 3.26 mask modes, 3.27 feather x/y and falloff, 3.30 matte source visibility (24 Nov 2026)

Masking spec v2, sections 1.2, 4.5, 5, 6.2. User decisions 24 Nov 2026: "go as per spec" (difference is `abs(a - c)`),
and the matte source is hidden by its eye, as After Effects does (classic matte and pick-whip alike; the pick-whip's only
difference is that the source can be anywhere in the stack).

## What changed
- `MaskMode` gains `lighten`, `darken`; `Mask` gains `featherY` and `falloff` (`smooth` Gaussian, `linear` box), both optional,
  so saved scenes read unchanged. Generated TypeScript and schemas regenerated (`codegen:check` OK, 517 files).
- CPU twin `rasterise/mask.rs` and the GPU pass `compositor/mask.wgsl` fold the same way: start from nothing unless the first
  mask that shapes anything subtracts; a first intersect or darken acts as an add; no active mask leaves the layer whole.
  The feather has its own weights per axis (an axis with none takes the identity tap).
- A track matte source is drawn when its own visibility says so, and always mattes: the GPU adds a second, drawn layer beside
  its matte layer; the CPU reference skips only clip children. The Editor hides the source when it sets a matte.

## Checks
- `cargo test -p gx-render-worker --lib -- rasterise::mask`: 8 passed (worked values .875/.375/.375/.75/.5/.25, first-mask rules,
  no-active-mask, per-axis feather, linear ramp, weights).
- GPU (`GX_GPU_316_BACKEND=dx12` and `vulkan`, `-- --ignored`): masked layers, track mattes and clip groups within one code of
  the CPU reference in sRGB and linear working spaces, with new golden objects (add + lighten 50% + darken 80%; a first darken;
  a feather along x only with a linear falloff; a visible matte source drawn and mattering). All passed on both backends.
- `cargo test --workspace --exclude gx-engine-host` (separate target folder, `gx-editor-mcp.exe` was running): 1394 passed, 0 failed.
- Mutation, `tools/mutate_mask.py`, result in `mutants.txt`: 11 of 13 first, two gaps closed, 13 of 13.

## Not done
3.27: a large feather tiled at 8K; a feather reaching outside the layer's box is not checked. 3.30: the rest of the audit
(source outside its time, deleted source passing through with a warning, cycle trace, one draw for several targets, M-18 to M-32).
3.28 and 3.29 are not started.
