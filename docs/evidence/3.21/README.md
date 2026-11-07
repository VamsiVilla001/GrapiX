# 3.21 evidence: GPU Program/Preview output, one quantisation, bounded asynchronous readback

Build-plan row `3.21`. Recorded 7 Nov 2026 (Claude). Reference GPU: NVIDIA
GeForce RTX 3070 Ti. Backends: DX12 (FXC, the product's explicit choice) and
Vulkan. Rust 1.89, wgpu 30.0.1.

## What changed

| Piece | Where | What it does |
|---|---|---|
| Output pass | `services/render-engine/worker/src/compositor/output.wgsl` | One compute pass per tile reads the composited working-space tile (rgba32float) and writes Program (Rec.709) and Preview (sRGB) RGBA8 words. The 3.15 output transforms are applied here, once, on the GPU. |
| Threshold tables | `compositor/output.rs` `OutputTables` | Per output and working space, the smallest f32 straight value that reaches each code value, computed from the CPU colour authority (`WorkingRgba::encode`) by bisection over f32 bit patterns. The shader never evaluates a transfer curve. |
| Exact rounding | `output.wgsl` `quotient_reaches`, mirrored in `output.rs` | A float binary search finds a candidate code; the code is then settled by an exact integer comparison of the correctly rounded quotient `r / a` against the neighbouring thresholds. GPU float division (2.5 ULP in WGSL) therefore cannot move a code value. |
| Readback ring | `compositor/output.rs` `OutputRing` | Three staging slots, each one buffer holding Program then Preview bytes. `submit` encodes commands, copies into an idle slot and maps it asynchronously; it never waits. `collect` returns the newest completed frame; older completed frames are superseded and counted. With no idle slot the frame is refused before it is composited, so GPU work is bounded by the ring depth. |
| Engine wiring | `engine.rs` `emit_frame` / `emit_frame_settled`, `ReadbackReport` | The live loop queues the current frame and emits the newest delivered one (one frame behind at the paced rate). Tests and synchronous renders use the settled variant, which waits (bounded, 5 s) for exactly the frame asked for. The ring's counters and latencies are in the engine's readback report. |
| Work counters | `render_work.rs` `gpu_output_dispatches` | Output dispatches are counted apart from layer dispatches, so the 3.16 trace assertions (3 layer dispatches, 0 CPU rasterisations, 0 resource builds per frame) still hold. |

Prepare builds the output pipeline, tables, output buffers, per-tile bind
groups and every ring slot (invariant 35). Nothing on the frame path creates
a resource or calls a CPU pixel loop.

## Gates run (`services/render-engine/worker/src/engine/output_tests.rs`)

| Test | Claim |
|---|---|
| `compositor::output::tests::every_threshold_is_the_first_value_that_reaches_its_code` | The tables are exact at both ends of every code, in both working spaces. |
| `compositor::output::tests::the_exact_rule_matches_the_cpu_encode` | The integer rule equals `WorkingRgba::encode` on 200,000 random premultiplied pixels per space plus every threshold and its neighbours at eight alphas. |
| `gpu_output_encode_equals_the_cpu_encode_of_the_same_pixels` | For 20 frames of the lower third, including fractional translations, in both spaces, the GPU-encoded Program and Preview bytes equal the CPU encode of the working-space pixels the GPU composited. |
| `the_ring_delivers_the_frame_it_was_given` | Paced at 50 fps, every delivered frame is byte-identical to a settled render of the scene frame it was submitted for; it is exactly one frame behind; per frame 0 CPU rasterisations, 0 resource builds, 3 layer dispatches, 1 output dispatch. |
| `the_readback_ring_refuses_instead_of_stalling` | Two seconds of unpaced emits at 2160p saturate the ring; emits keep returning, refusals are counted, and deliveries continue. |
| `program_holds_the_frame_budget_on_the_reference_workloads` | The numbers below. |

Agreement with the CPU rasteriser at integer translations (the six golden
frames and the lower third at frames 0, 25, 50 and 100) is 3.16's gate and is
unchanged: `engine::gpu_tests` runs through the ring now and still matches
byte for byte.

## Measurement method

The engine clock is a shared counter the test advances one frame per
`emit_frame` call. The loop sleeps to a 20 ms deadline between calls, as the
worker's clock pump does. `emit_frame` is the live path. Two figures are
reported per workload after 50 warm-up frames and 300 measured frames:

- **emit wall time**: what the Program loop pays per frame on the CPU
  (uniform evaluation, command encoding, submission, and copying the
  delivered frame out of the mapped slot).
- **readback latency**: submit to delivery of each delivered frame. Because
  completions are only observed at the next emit, a paced loop reports about
  one frame interval here; the pipeline depth (`framesBehindMax`, 1 at 50
  fps) is the honest statement of the picture's age.

Evidence JSON per backend and profile: `debug/` (Vulkan, unoptimised) and
`release/dx12`, `release/vulkan`. `GX_GPU_321_ASSERT_BUDGET=1` makes the
budget test fail above 10 ms.

## Results (release build, RTX 3070 Ti, DX12 with FXC, 50 fps, 7 Nov 2026)

Times in ms. "Emit" is the live loop's CPU cost per frame; "settled" is one
frame end to end: submit, GPU composite and encode, readback and copy,
waited for. The row's budget is p99 ≤ 10 ms.

| Workload | Size | Emit p50 / p99 | Settled p50 / p99 | Ring full | Frames behind (max) | Within 10 ms |
|---|---|---|---|---|---|---|
| lower-third | 1920x1080 | 3.2 / 9.2 | 5.5 / 6.6 | 0 | 1 | yes |
| scorebug | 1920x1080 | 3.1 / 4.1 | 6.7 / 8.2 | 0 | 1 | yes |
| stats-page | 1920x1080 | 4.0 / 5.3 | 12.7 / 13.5 | 12 | 13 | no |
| lower-third | 3840x2160 | 8.2 / 10.5 | 18.3 / 19.7 | 0 | 2 | no |
| scorebug | 3840x2160 | 8.1 / 10.6 | 20.9 / 22.4 | 7 | 7 | no |
| stats-page | 3840x2160 | 6.1 / 9.4 | 41.7 / 44.1 | 149 | 18 | no |

Vulkan, same build and method (`release/vulkan/frame-budget.json`):

| Workload | Size | Emit p50 / p99 | Settled p50 / p99 | Ring full | Frames behind (max) | Within 10 ms |
|---|---|---|---|---|---|---|
| lower-third | 1920x1080 | 2.5 / 18.2 | 6.2 / 12.3 | 3 | 3 | no |
| scorebug | 1920x1080 | 2.5 / 3.3 | 6.9 / 8.9 | 0 | 1 | yes |
| stats-page | 1920x1080 | 3.0 / 4.0 | 11.6 / 12.7 | 0 | 1 | no |
| lower-third | 3840x2160 | 7.5 / 24.0 | 20.6 / 24.9 | 0 | 2 | no |
| scorebug | 3840x2160 | 7.4 / 9.2 | 21.3 / 26.5 | 0 | 2 | no |
| stats-page | 3840x2160 | 5.8 / 8.5 | 42.0 / 45.8 | 149 | 5 | no |

Vulkan's medians match DX12 but its tails are longer on this machine: the
1080p lower third's settled p99 is 12.3 ms against 6.6 ms on DX12, and one
2160p run had a live emit p99 of 24 ms. DX12 is the product's backend; the
Vulkan numbers are recorded, not relied on.

### Where the time goes, and what is still owed

- **Lower third and scorebug at 1080p meet the budget** (p99 6.6 ms and
  8.2 ms). The live loop pays about 3 ms per frame, almost all of it the copy
  of the two 8 MB surfaces out of the mapped slot.
- **The stats page at 1080p and every 2160p workload do not.** Two costs
  remain, and neither is in the output pass or the ring:
  1. **One full-tile pass per layer in the 3.16 compositor.** `composite()`
     dispatches every layer over the whole tile and each pass reads the
     4-tap rgba32float source, the whole destination and writes the whole
     output: about 96 bytes per pixel per layer. The 71-layer stats page at
     2160p moves roughly 56 GB per frame, about 40 ms of GPU time; the
     3-layer lower third at 2160p about 10 ms. The fix is to dispatch each
     layer over its warped bounding box on the tile (and optionally
     rgba16float targets). That is the compositor's code (row 3.16, codex)
     and was reported on Panchayati topic 10, message 340, 7 Nov 2026.
  2. **The copy out of the mapped slot at 2160p**: two 33 MB surfaces per
     frame, about 8 ms on four threads. Beyond this, the output adapter
     would have to consume the mapped buffer directly, or Preview would have
     to be read back at a lower rate than Program.

Before this commit the ring allocated a fresh frame per delivery and the OS
paged it in on first touch, which alone cost 5 ms at 1080p and 22 ms at
2160p; the ring now recycles the engine's released frames
(`OutputRing::recycle`) and copies on four threads.

The 3.16 trace counters hold on every workload above: 0 CPU full-frame and
0 CPU source rasterisations, 0 GPU resource builds per frame.

**Headless renders while Program runs** (invariant 14): the conformance
timed run in `npm run check`, which reads the engine's own frame-timing
report against the worker process, was skipped before this row because
Program could not hold cadence. It now runs and passes: Program alone 150
frames (0 late, 0 missed); with 7 headless 1080p renders issued back to back,
171 frames (0 late, 0 missed). Gate: `npm run check` exit 0, conformance 387
passed / 0 failed / 8 skipped.
