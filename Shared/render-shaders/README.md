# @grapix/render-shaders

Shared WGSL shaders and byte-layout contract for GrapiX renderers.

Consumed by:

- `services/render-daemon` — the Rust/wgpu broadcast render daemon (today).
- The browser WebGPU preview described in `docs/rendering-engine.md` (future).

Contents:

- `wgsl/` — shader source, used verbatim by both renderers.
- `layouts.json` — machine-readable uniform sizes/offsets, vertex input mode,
  and blend-mode ids. Both renderers assert against this file in tests.
- `docs/shader-contract.md` — the full contract: coordinate system, transform
  composition, colour/alpha pipeline, and the rules for changing any of it.

This package intentionally contains no build step and no runtime code.
