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

## 15 Nov 2026: each layer dispatched over its footprint (Claude)

The first of the two costs above. `composite()` no longer dispatches every
layer over the whole tile. `layer_region` gives the tile pixels a layer can
change (the hull of its warped source rectangle, widened by the bilinear reach
and a 2 px margin in source and tile space; nothing for a layer at zero
opacity; the whole tile for the four `acts_on_whole_backdrop` modes). Layer i
is dispatched over the hull of its own footprint and layer i - 1's, because
the target it writes still holds the state before layer i - 1. Both targets
are cleared at frame start. The shader keeps the backdrop bit for bit where the
source is exactly zero. `RenderWork.gpuLayerPixels` counts the pixels
dispatched. The row stays **active**.

**Executed.**

- `compositor::tests::gpu_footprint_dispatch_is_bit_identical_to_the_whole_tile`
  (hardware): every blend mode, and the non-whole-backdrop modes twice over, in
  both working spaces, on one tile and on a two-tile stage past the texture
  limit, six random frames each (rotation, shear, scale up to 60x, zero
  opacity): every working-space float is bit-identical to the whole-tile
  dispatch, with fewer pixels dispatched and no resource built.
- `a_layer_region_holds_every_pixel_its_source_can_reach` (400 random cases on
  a multi-tile stage at a distant origin, brute force over every pixel) and
  `a_layer_region_is_tight_empty_or_whole_as_the_layer_requires`.
- `cargo test -p gx-render-worker -- --include-ignored`: 161 passed, 0 failed,
  0 ignored, on the hardware GPU. That includes the byte-exact CPU-reference
  gates of 3.16, 3.20 and 3.22.
- Mutations, one exact replacement each, run alone, files restored
  byte-identical: no bilinear widening or margin; the previous layer's
  footprint left out of the region; only one target cleared; whole-backdrop
  modes given a footprint; the shader ignoring the region origin. Each fails a
  named test. A sixth, removing the shader's zero-source early-out, fails
  nothing: the whole-tile reference runs the same shader, so the test cannot
  see it. It is recorded as not killed.

**Measured** (release, RTX 3070 Ti, DX12/FXC, same method as above, both builds
on 15 Nov 2026, the committed tree `b89448b` first; settled p50 / p99 in ms;
`footprint-2026-11-15/`):

| Workload | Before | After | Layer pixels per frame |
|---|---|---|---|
| lower-third 1080p | (row not captured) | 5.3 / 6.9 | 0.44 M (whole tile: 6.2 M) |
| scorebug 1080p | 7.2 / 10.6 | 5.7 / 8.8 | 0.51 M (47.7 M) |
| stats-page 1080p | 14.4 / 15.6, ring full 12 | 11.2 / 13.1, ring full 0 | 6.95 M (147 M) |

The stats page at 1080p is still over 10 ms although it now dispatches about
5% of the pixels, so its remaining cost is not layer area: about 6 ms over the
lower third for 68 more layers, roughly 85 us per layer dispatch. That is the
next thing to remove (fewer passes: several layers per dispatch).

**2160p was not measurable on 15 Nov.** The committed tree itself took 453 /
629 ms on the 2160p lower third and then failed the scorebug with a 5 s
readback timeout; the new code took 298 to 863 ms. On 7 Nov the same
workloads took 20 to 44 ms. Other applications held about 5.2 GB of the 8 GB
of GPU memory during these runs (nvidia-smi), which is the likely cause and
was not proved. The 2160p budget needs a rerun on a quiet machine.

## 16 Nov 2026: 2160p to V2, and a DX12 regression from 3.17 found and removed (Claude)

**User decision, 16 Nov 2026.** "Check why 3.21 is blocked on hardware. If
it's because of 4K, then 4K is a V2 option. First let's work on 1080p." It was
4K: the 2160p runs time out or take 300 to 900 ms while other applications hold
about 5 GB of the 8 GB of GPU memory and keep the GPU about 40% busy (Parsec,
Chrome, Discord, WebView2, the Codex desktop app; nvidia-smi), and 2160p was
over budget even on 7 Nov (19.7 to 44 ms). The done-when now reads 1080p50;
2160p50 is row **3.23 (V2)**, measured by the new
`program_holds_the_frame_budget_at_2160p`.
`program_holds_the_frame_budget_on_the_reference_workloads` is 1080p only.

**What 1080p showed today.** At HEAD (2d20672), release, DX12, settled
p50 / p99: lower third 5.8 / 10.9 ms, scorebug 6.7 / 30.0 ms, **stats page
94.3 / 211.9 ms** (15 Nov: 11.2 / 13.1). The same benchmark on the 15 Nov tree
(f27de37, exported with `git archive`) gave the stats page 10.3 / 11.9 ms on
the same machine the same hour. Bisected over the commits that built (the two
intermediate 3.17 commits do not compile their tests): 028720a (3.17 done) is
slow at 89.8 ms p50, so the cause entered with 3.17, when vector sources began
to be drawn on the GPU at prepare.

**Isolating it** (temporary profiling, never committed: per-stage times, each
GPU submission waited for; 1080p stats page alone; composite GPU / output GPU,
ms):

| Variant | Composite | Output |
| --- | --- | --- |
| HEAD, DX12 | 66.9 | 18.6 |
| HEAD, DX12, no layer dispatched at all | 27.7 | 16.7 |
| HEAD, **Vulkan** | 1.07 | 4.6 |
| HEAD, DX12, sources prepared on the CPU (no GPU drawing) | 1.38 | 5.2 |
| ... CPU sources plus 1.5 GB of extra buffers allocated after prepare | 1.46 | 5.3 |
| ... CPU sources plus large storage buffers allocated and freed before | 1.49 | 5.3 |
| HEAD, DX12, GPU drawer created but nothing drawn on it | 1.44 | 5.3 |
| HEAD, DX12, drawer dropped and the device drained after prepare | 67.6 | 19.0 |
| HEAD, DX12, no path drawn and no copy (only each layer's storage buffer) | 67.6 | 16.7 |
| ... the same with each layer's storage buffer 16 bytes | 1.40 | 4.4 |
| HEAD, DX12, one reused scratch buffer instead of one per layer | 67.1 | 18.8 |
| HEAD, DX12, **`MemoryHints::MemoryUsage`** | **1.49** | **5.1** |

Two clears of 2 x 33 MB taking 27.7 ms, and the output pass slowed sixfold
with no change to its work, is the rate of memory reached over PCIe. The
allocator reported only 213 MB allocated (640 MB reserved), so the process is
not short of memory; what changed is where it sits. wgpu suballocates DX12
memory in 128 to 256 MB heaps; D3D12 makes whole heaps resident; with other
applications holding most of the card, this process's residency budget is
small. The per-layer storage buffers that GPU drawing allocates at prepare
opened more heaps, the frame's targets, sources and output buffers were spread
across them, and the heaps were paged on every submission. That reading fits
every row above (Vulkan manages memory differently; 16-byte buffers open no
heap; buffers that are never touched again are simply evicted) and was not
proved directly: the per-process GPU memory counters could not be read in this
session (process and counter queries hang on this machine).

**The fix.** `gpu.rs` requests the device with `MemoryHints::MemoryUsage`
(8 to 64 MB blocks). One line, no change to any pass.

**Measured after the fix** (release, DX12/FXC, three runs, settled p50 / p99 in
ms; `memory-2026-11-16/frame-budget-dx12-run*.json`):

| Workload | Run 1 | Run 2 | Run 3 | Budget |
| --- | --- | --- | --- | --- |
| lower third 1080p | 5.6 / 7.5 | 5.5 / 6.9 | 5.4 / 6.7 | met |
| scorebug 1080p | 5.7 / 7.1 | 5.7 / 7.0 | 5.9 / 7.9 | met |
| stats page 1080p | 9.9 / 11.5 | 10.1 / 12.1 | 10.2 / 13.1 | **not met** |

The regression is gone (stats page 94 to 10 ms at p50, scorebug p99 30 to 7 ms)
and the two lighter workloads meet the budget. **3.21 stays active:** the stats
page is 1.5 to 3 ms over at p99. Its frame, from the profile with the fix:
evaluate 0.4 ms, composite CPU about 1 ms, composite GPU 1.5 ms, output pass and
readback about 5 ms (3 ms on the lower third), the copy out of the mapped slot
1.9 ms.

**Regression guard.** The 1080p benchmark now asserts, on every run, that each
workload's settled p50 is under 20 ms (twice the budget): with the hint
reverted to `Performance` it fails ("stats-page 1920x1080: settled p50
89339 us is over the 20000 us regression ceiling"); restored, it passes
(10.0 ms). The 10 ms budget itself stays an opt-in assertion
(`GX_GPU_321_ASSERT_BUDGET`), as before. `cargo test -p gx-render-worker --lib
-- --include-ignored --test-threads=1` with the fix: 192 passed, 0 failed.

**Jev and Laya on the fix** (`memory-2026-11-16/review-jev-laya.json`; Laya read
4153 tokens, not truncated):

| Question | Jev | Laya |
| --- | --- | --- |
| the evidence supports memory placement as the cause | 0.91 | 0.95 |
| which fix to keep | `MemoryUsage` hint (1.0) | `MemoryUsage` hint |
| the fix makes a workload slower | 0.21 | 0.94 |
| the ceiling is a real, non-flaky guard | 0.92 | 0.88 |
| 2160p to 3.23 follows the user's decision | 0.97 | 0.98 |
| 3.21's status | stays active (0.92) | done |
| weakest point | cause not proved directly (0.59) | none |
| must the user approve first | 0.23 | 0.81 |

By hand: every workload is faster with the fix (lower third p99 10.9 to about
7, scorebug 30.0 to about 7.3, stats page 212 to about 12), so Laya's "slower"
is contradicted by the measurements; the stats page is still over budget, so
the row stays active; the cause was not read from a memory counter, which is
stated above. The plan change is the user's decision. The splits are reported
to the user.

### 16 Nov 2026, continued: the stats page's remaining frame (Claude)

Three changes, each measured on its own (release, DX12, three runs each,
settled p50 / p99 of the 1080p stats page, ms):

| Change | Stats page | Why |
| --- | --- | --- |
| after the memory fix (above) | 9.9-10.2 / 11.5-13.1 | |
| **the output encode**: the exact refinement loops stop when a step does not move the code, and an opaque pixel (alpha exactly 1) takes its code from the threshold search alone | 8.0-8.1 / 9.8-10.5 | an opaque pixel ran 48 of the 64-bit exact checks per pixel; `r / 1` is exact, and a further refinement step re-tests the same threshold, so both are exact and byte-identical |
| **the readback copy**: both surfaces copied in one parallel pass of eight chunks | 7.9-8.4 / 9.2-10.2 | the two surfaces were copied one after the other |
| **one uniform buffer per tile**, every layer's uniform at a 256-byte-aligned offset, written once per frame | 6.3-6.7 / 8.1-33.6 | 71 buffers and 71 queue writes per frame |

The profile after the encode change: the stats page's output stage fell from
5.1 to 3.0 ms, the same as the lower third's, so the encode no longer depends on
how much of the frame is opaque.

**Six runs after all three** (`memory-2026-11-16/frame-budget-dx12-final-run*.json`):

| Run | Lower third | Scorebug | Stats page |
| --- | --- | --- | --- |
| 1 | 5.1 / 7.5 | 5.2 / 14.5 | 6.3 / 15.9 |
| 2 | 5.1 / 6.3 | 5.3 / 7.0 | 6.5 / 33.6 |
| 3 | 5.5 / 8.1 | 5.5 / 7.3 | 6.7 / 11.5 |
| 4 | 5.2 / 7.8 | 5.5 / 7.5 | 6.3 / 8.1 |
| 5 | 4.9 / 6.5 | 5.4 / 6.6 | 6.3 / 10.8 |
| 6 | 5.2 / 7.0 | 5.1 / 6.2 | 6.6 / 8.7 |

The medians are steady and well inside 10 ms; the p99 of 100 settled frames
is the second-worst frame, and on this machine it follows what the other
applications are doing on the GPU (nvidia-smi between runs read 5%, 40% and 60%
utilisation; one stats-page frame took 47 ms). The scorebug, which is lighter,
was hit the same way in run 1. **3.21 stays active**: at 1080p the stats page
meets p99 ≤ 10 ms in three of six runs on this shared GPU, and no claim is made
that it holds. What would settle it is a run on the reference GPU with nothing
else on it, which is the same condition 3.23 needs.

**Executed.** `cargo test -p gx-render-worker --lib -- --include-ignored
--test-threads=1 --skip program_holds_the_frame_budget`: 190 passed, 0 failed
(hardware). `gpu_output_encode_equals_the_cpu_encode_of_the_same_pixels` now
compares the opaque stats page as well as the lower third, byte for byte, in
both working spaces. Mutations, one at a time, files restored byte-identical
(`mutate_321b.py`): the opaque path reading the other output table, the opaque
path truncating instead of searching, the Rust twin off by one, every layer
binding the first uniform, only the first uniform uploaded, Program and Preview
swapped in the copy. Each fails named tests. The loop exit is an exact
equivalence (a step that does not move the code re-tests the same threshold),
so no mutation of it that keeps the code correct can fail a test; one that
breaks it is caught by the same GPU comparisons.

**Jev and Laya on these changes** (`memory-2026-11-16/review2-jev-laya.json`;
Laya read 8012 tokens, not truncated):

| Question | Jev | Laya |
| --- | --- | --- |
| byte-identical to the CPU encode, shown by tests | 0.92 | 0.93 |
| the opaque path is right for every value | 0.65 | 0.93 |
| one uniform buffer is safe with frames in flight | 0.47 | 0.95 |
| 3.21's status | stays active (0.98) | done |
| weakest point | shared-GPU tails (0.91) | shared-GPU tails |
| a defect to fix first | 0.53 | 0.93 |

By hand. The opaque path: `r / 1` is `r` exactly in IEEE arithmetic, NaN,
signed zero and infinities included, so the float comparisons of the search
give the CPU's code; the Rust twin's test now also covers -0.1, -0, 0, plus and
minus infinity, 2, the smallest normal and the smallest subnormal at alpha 1,
and passes. The uniform buffer: a queue write takes effect at the next
submission, after every frame already submitted, which is the ordering the 71
separate buffers had. No defect found; the row stays active for the reason both
name. The splits are reported to the user.
