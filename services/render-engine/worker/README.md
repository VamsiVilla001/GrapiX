# gx-render-worker

Native Rust/wgpu render worker. Owns the GPU device, the scene runtime, tiling
and Program frame production.

Two rules here are load-bearing and were paid for once already: nothing that
can be built once may be built per Program frame (invariant 35), and a large
stage is never one GPU texture — only tiles become render targets
(invariant 37).

**Partial — 3.16:** `src/compositor` prepares an independent GPU layer
compositor on the negotiated hardware device. Drawing backends supply
premultiplied working-space float layers in effective order. Affine transforms,
opacity, transparent bilinear sampling and normal source-over composition run
on the GPU into bounded tile targets. Pipelines, textures, bind groups,
uniforms and diagnostic readback buffers are prepared once; frame submission
only validates state, writes uniforms and dispatches. DX12 explicitly uses FXC
for this baseline shader, rather than changing compiler with DLL availability.

This core is not yet connected to `PreparedScene` or the engine's
Preview/Program paths. Those still use the CPU renderer. `output_tiles()`
borrows the working-space GPU results for a future output pass;
`readback_reference()` is exclusive, blocking diagnostic readback with CPU
reference output encoding, and must not drive the Program clock. The bounded
asynchronous output ring belongs to 3.21. Oversized source layers currently
refuse by object and path; source backends must supply bounded layers.

Explicit hardware proof (fails if a hardware GPU is unavailable):

```text
cargo test -p gx-render-worker compositor::tests -- --include-ignored --test-threads=1
```

The ordinary suite runs mapping/precision checks and explicitly ignores four
hardware tests. The hardware tests cover both working spaces and output
reference codes, order, affine motion, opacity, fractional sampling,
repeat-frame resource identity, distant origins, and seam-free GPU tiles,
including a stage wider than the actual negotiated texture limit. They prove
the layer core; they do not close 3.16's scene/engine/trace criteria.

EffectCraft component provenance and its retained licence are in
`THIRD_PARTY_NOTICES.md` and `EFFECTCRAFT-LICENSE`.
