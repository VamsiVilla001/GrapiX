# gx-render-worker

Native Rust/wgpu render worker. Owns the GPU device, the scene runtime, tiling
and Program frame production.

Two rules here are load-bearing and were paid for once already: nothing that
can be built once may be built per Program frame (invariant 35), and a large
stage is never one GPU texture — only tiles become render targets
(invariant 37).

**3.16 GPU composition:** `src/compositor/scene.rs` maps bound SceneDocuments
in stable z-index order across object types. The engine prepares one GPU cache
per pinned revision at publish and recovery. Preview and Program use its GPU
affine transforms, effective opacity and premultiplied source-over composition
in the declared working space, with bounded tile targets and tile-local f64
subtraction before narrowing. DX12 selects FXC explicitly. T2/T3 authored
Program and hardware loss refuse by name; no CPU backend is selected instead.

The bridge to 3.17/3.18 is explicit: existing vector and packaged-glyph
rasterisers produce **object source textures at prepare only**, labelled
`cpu-prepared-source-at-prepare` in the source trace. No CPU full-frame surface
is built at GPU publication. Source sampling windows preserve the reference
coverage grid without a full-stage CPU allocation. Supported animation updates
transform/opacity uniforms through the shared semantic evaluator. Source-size
animation (width/height) and oversized source textures refuse by object and
document path; GPU source backends remain later work. Containers inherit
transforms, visibility and opacity through the shared hierarchy resolver.

Pipelines, textures, views, bind groups, uniforms, clear frames and readback
buffers are prepared once. `output_tiles()` borrows GPU working tiles;
`readback_working()` uses reusable buffers with bounded synchronous polling
and cancellation cleanup. One working readback feeds the existing CPU output
encoders, quantising once per output. The asynchronous ring and output timing
target belong to **3.21**, which is not claimed here. `PreparedScene::frame_at`
remains the explicit CPU headless/pixel reference; identifier-only control
fixtures remain labelled diagnostic frames with no authored scene content.

Explicit hardware proof (fails if a hardware GPU is unavailable):

```text
cargo test -p gx-render-worker compositor::tests -- --include-ignored --test-threads=1
cargo test -p gx-render-worker engine::gpu_tests -- --include-ignored --test-threads=1
```

The ordinary suite runs mapping/precision/tier-refusal checks and explicitly
ignores hardware proofs. The hardware tests cover both working spaces and output
reference codes, order, affine motion, opacity, fractional sampling,
repeat-frame resource identity, distant origins, and seam-free GPU tiles,
including a stage wider than the actual negotiated texture limit. Engine tests
publish/take the packaged-font lower third, inspect actual frame-work counters,
compare both output frames to the CPU reference and all six unchanged golden
frames, and verify recovery, clear and named refusal behaviour.

For a Windows backend matrix, set `GX_GPU_316_BACKEND` to `dx12` or `vulkan`
before running the Engine proof. `GX_GPU_316_EVIDENCE_DIR` can name an absolute
directory under `agent/tmp/` to retain the executed JSON traces and PNGs.
Committed evidence is under `docs/evidence/3.16/` at the repository root.
No-adapter execution fails these explicit proofs, and never counts as PASS.

**3.21 GPU output and readback:** `src/compositor/output.rs` and `output.wgsl`
encode Program (Rec.709) and Preview (sRGB) RGBA8 on the GPU with exactly one
quantisation, byte-identical to the CPU colour authority, and read them back
through a three-slot asynchronous ring that never stalls the frame loop.
`engine::output_tests` holds the gates and the frame-budget benchmark
(`GX_GPU_321_EVIDENCE_DIR`, `GX_GPU_321_ASSERT_BUDGET`). Committed evidence
and the measured budget are under `docs/evidence/3.21/`.

**3.20 blend modes:** every layer composites through `blend_pixel` in
`src/compositor/blend.wgsl`, the GPU twin of the CPU reference `src/blend.rs`
(all 38 contract modes: the 27 Photoshop modes and the After Effects ones).
The mode numbers are generated from `BlendMode::ALL` and prepended to the
shader. The CPU renderer blends an object in a non-normal mode through a
canvas-sized layer surface (`RasterSurface::blend_layer`), visiting the whole
canvas because the stencil and silhouette modes change the backdrop outside
the object. A layer at zero opacity does nothing in any mode. Gates and
evidence: `compositor::blend_tests`, `engine::blend_tests`, `docs/evidence/3.20/`.

**3.22 effects:** an object's effect stack (`gx_contracts::effect`) runs on
the object's own layer-space pixels (`src/layer_source.rs`, padded by the
stack's largest reach over every frame) before its transform and opacity.
`src/effect_chain.rs` expands the stack into a fixed list of passes at
prepare (per-pixel colour, ramp and wipe passes; box passes along rows or
columns for the blurs; save, make or bright, blur and combine for drop
shadow and glow), packs each pass per frame into a fixed f32 block, and is
the CPU reference; `src/compositor/effects.wgsl` runs the same passes on the
GPU over three layer-sized targets built at prepare, one dispatch per pass.
All 16 effects of the row's first set are drawn. Evidence:
`docs/evidence/3.22/`.

EffectCraft component provenance and its retained licence are in
`THIRD_PARTY_NOTICES.md` and `EFFECTCRAFT-LICENSE`.
