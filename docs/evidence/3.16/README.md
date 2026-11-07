# 3.16 GPU compositor execution evidence — 7 November 2026

The real Engine publishes a pinned SceneDocument, Takes it, and emits GPU
Program and Preview frames. This is execution evidence for 3.16, continuing
the standalone compositor core from `c163720`.

## Executed proofs

| Proof | Result |
|---|---|
| Entire render-worker library, including normally ignored hardware proofs, Vulkan | 109 passed, 0 failed, 0 ignored |
| Engine GPU suite, explicitly selected DX12/FXC | 7 passed, 0 failed, 0 ignored |
| Adapter | NVIDIA GeForce RTX 3070 Ti; DX12 and Vulkan selected separately |
| Scene/output spaces | sRGB and linear sRGB; sRGB Preview and Rec.709 Program |
| Animated packaged-font lower third | Frames 0, 25, 50 and 100: both outputs byte-identical to CPU references in both working spaces, on both backends |
| Existing golden frames | Six per backend, all zero differing pixels and zero worst-channel delta; no re-baselining |
| Large stage | Engine output 8,199 × 3 above negotiated texture limit 8,192; every pixel white, including the seam |
| CPU/software tiers | Authored Take refuses `tierTooLow(T2)` / `tierTooLow(T3)` before committing; explicit CPU headless render remains available |
| Recovery and simulated tier loss | GPU resources rebuilt during recovery preparation only; output inhibited until re-armed; a simulated T2 transition refuses with no CPU fallback |
| Unsupported mappings | Animated source size and an oversized source refuse by object id and document path; a refused publish preserves existing pinned Program |
| CPU pixel gate | Exit 0, unchanged baselines |
| Repository gate | Exit 0; 353 generated files current; 40 Node / 403 Editor / 744 Rust passed; 12 Rust ignored; conformance 386 passed / 0 failed / 9 skipped |
| Shipped worker build | `cargo build -p gx-render-worker`, exit 0 |

The lower-third source fixture is
`services/render-engine/worker/tests/fixtures/gpu-lower-third-50.json`.
Its declared font hash is verified against the existing packaged
`Inter-Regular.ttf` fixture. The authored object array places text before its
plate; stable z-index ordering must place the plate below text and an accent
above it. The group animates translation and opacity.

## Frame-path trace

Each backend's `lower-third-trace.json` records actual counter differences
around preparation and each Engine frame. The CPU compose/source rasterisers
and persistent GPU constructors record at their execution sites.

- Preparation: 3 CPU source rasterisations, 24 persistent GPU resource builds,
  and **0 CPU full-frame rasterisations**.
- Each Program/Preview pair: 3 GPU layer dispatches, **0 CPU full-frame or
  source rasterisations**, and **0 persistent GPU resource builds**.
- `sources` names every object, its document path and dimensions, and its
  `cpu-prepared-source-at-prepare` route. Source images are premultiplied
  float pixels in the scene's working space, without source quantisation.

The initial source-cache attempt moved 37 text/vector edge pixels in the
existing colour-ramp golden (worst channel delta 230). Cropped source windows
now retain the CPU reference's sampling grid and geometry rounding. The final
executed comparisons committed here are exact; the golden images were never
changed. Fractional source resampling and full GPU drawing remain subject to
3.17/3.18's own drawing/reference criteria.

## Scope and method

Pipelines, source textures, tile targets/views, bind groups, uniforms, clear
frames and readback buffers are built at publish/recovery preparation. The
frame path uses cached sources, the shared semantic keyframe/hierarchy
evaluator, GPU warping/opacity/source-over, and one float readback. Existing
CPU colour encoders produce each output with one quantisation.

Readback is synchronous and uses reusable bounded buffers, five-second
poll/map failure deadlines and cancellation cleanup. This evidence makes
**no 3.21 asynchronous-readback or p99 frame-budget claim**. The CPU source
bridge does not implement GPU vector or glyph drawing (3.17/3.18), masks,
the full blend-mode set or effects (3.19/3.20/3.22). Unsupported source-size
animation and oversized source textures refuse explicitly. Identifier-only
control fixtures remain labelled diagnostics with no SceneDocument content.

Commands from the canonical shared worktree, with serialized gate ownership:

```powershell
$env:GX_GPU_316_BACKEND = 'vulkan'
$env:GX_GPU_316_EVIDENCE_DIR = Join-Path (Get-Location) 'agent/tmp/gpu-316-wiring/evidence/vulkan'
cargo test -p gx-render-worker --lib -- --include-ignored --test-threads=1

$env:GX_GPU_316_BACKEND = 'dx12'
$env:GX_GPU_316_EVIDENCE_DIR = Join-Path (Get-Location) 'agent/tmp/gpu-316-wiring/evidence/dx12'
cargo test -p gx-render-worker engine::gpu_tests -- --include-ignored --test-threads=1

cargo run -p gx-pixel-gate -- check
npm run check
```

The pixel gate passed with unchanged CPU baselines. Full-gate results are
recorded in the corresponding `memory.md` entry. Local logs are retained in
`agent/tmp/gpu-316-wiring/`. Explicit hardware proofs fail if no hardware
adapter exists; their normal-suite ignores do not count as GPU execution.

## Retained artifacts

`dx12/` and `vulkan/` each contain:

- `lower-third-trace.json`: source preparation, frame work and output differences.
- `golden-differences.json`: all six unchanged golden comparisons.
- `engine-large-stage.json`: actual texture limit, larger stage and its frame trace.
- `recovery.json`: prepare work, resumed GPU frame and simulated tier-loss refusal.

`lower-third-srgb-preview.png` is the actual DX12 Engine Preview at scene
frame 100. The accent deliberately covers part of the text to exercise order
across object types.
