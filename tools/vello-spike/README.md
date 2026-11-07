# Vello / Vello Hybrid spike

Build-plan `3.17` (GPU 2D drawing) and `16.9` (rasteriser benchmark). This is
an isolated probe, not a drawing backend: it is its own Cargo workspace with
its own lockfile, it is not a member of the product workspace, and nothing in
the product depends on it. It reads `gx-render-worker` and `gx-contracts` by
path only to time the existing CPU rasteriser through its public API, which it
does not change. Neither `3.17` nor `16.9` is done; see "What is still owed".

```powershell
& ./tools/vello-spike/run.ps1 -Backend dx12 -DxcPath 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\dxcompiler.dll'
& ./tools/vello-spike/run.ps1 -Backend dx12      # wgpu's Auto compiler: FXC here
& ./tools/vello-spike/run.ps1 -Backend vulkan
```

`gx-vello-spike negotiate` (from `agent/tmp/vello-spike/target/release`)
prints what the product's own unchanged `gpu::negotiate()` decides on this
machine (tier, hardware, texture limit).

The build goes to `agent/tmp/vello-spike/target`, PNGs and logs to
`agent/tmp/vello-spike/` (git-ignored scratch). The probe fails if the
requested hardware adapter is missing; a software adapter is never accepted.

## Versions (7 November 2026)

| Crate | Version | wgpu | MSRV |
|---|---|---|---|
| `vello` (classic, GPU compute) | 0.11.0 | 30.0.1 | 1.89 |
| `vello_hybrid` (sparse strips, CPU + GPU) | 0.2.0 | **29.0.4** | 1.88 |
| `vello_cpu` (sparse strips, CPU) | 0.3.0 | none | 1.89 |
| `tiny-skia` | 0.12.0 | none | unknown |
| Product worker (after `0.2`'s bump) | | 30.0.1 | 1.89 |

`vello_hybrid` 0.2.0 is the newest release and is built on wgpu 29, while
`vello` 0.11 and the product are on wgpu 30. The two wgpu versions cannot share
a device, so the probe opens one device per crate on the same adapter.

## Method

Three broadcast-shaped workloads, 1920x1080 RGBA8, transparent background
(key + fill), expressed once as a backend-neutral display list:

- **lower-third**: a rounded rect (r 18) filled with a 2-stop linear gradient,
  the same outline stroked at 2 px, and two text-sized rectangles at
  fractional positions.
- **scorebug**: a rounded panel with a 1.5 px semi-transparent stroke and 20
  small rounded rects, every other one stroked at 1 px.
- **full-panel**: a full-frame 3-stop radial gradient and 50 stroked paths
  (polyline plus a cubic), widths 2 to 6 px, miter/round/bevel joins,
  butt/round/square caps, every other path dashed 16/8.

Backends: `vello` classic (area AA), `vello_hybrid`, `vello_cpu`
(single-threaded), `tiny-skia`, and the **GrapiX worker's CPU rasteriser**
(`PreparedScene::frame_at`, prepared once, not timed). The worker refuses
gradients and has no dashes, joins or caps, so it is given the same geometry
with each gradient replaced by its first stop and plain strokes; it is
point-sampled, not anti-aliased. Its numbers are for scale, not like for like.

Timing: 5 warmups then 30 samples per backend per workload. A sample is the
whole frame: building the scene from the display list, rendering, and a
synchronous readback of all 8 MB into CPU memory. For the two GPU backends a
second series waits for the GPU instead of reading back ("no readback"), to
separate rendering from transfer. CPU backends reuse their pixmap.

Comparison: premultiplied RGBA8 (the colour of a zero-alpha pixel is
meaningless and is not counted), over the full frame and named regions (a
rounded AA corner, a gradient-only area, one row of strokes). The verdict uses
the engine's own `headless::CROSS_MACHINE_TOLERANCE`, the threshold the golden
gate applies today: no channel off by more than 1 code value, and at most 0.1%
of pixels different.

## Results (7 November 2026)

NVIDIA GeForce RTX 3070 Ti, driver 591.59 (32.0.15.9159), Windows 10 19045.
Three runs of 5 warmups + 30 samples per configuration; the table gives the
median of the three p50s and the worst of the three p99s, in ms. The
workstation was shared with another agent's builds and a live Editor during
the runs, so the p99 column is noisy and only the p50 column should be read
as a cost. Raw logs: `agent/tmp/vello-spike/runs/`.

| workload | backend | DX12 (DXC) p50 / p99 | DX12 (Auto = FXC) p50 / p99 | Vulkan p50 / p99 |
|---|---|---:|---:|---:|
| lower-third | vello-classic, no readback | 0.83 / 1.62 | 0.77 / 1.52 | 0.71 / 1.48 |
| lower-third | vello-hybrid, no readback | 0.43 / 0.80 | 0.47 / 6.42 | 0.28 / 0.53 |
| lower-third | vello-classic | 4.82 / 8.81 | 5.12 / 20.26 | 5.51 / 55.39 |
| lower-third | vello-hybrid | 5.14 / 10.49 | 4.47 / 18.72 | 4.56 / 28.00 |
| lower-third | vello-cpu | 2.91 / 5.51 | 2.37 / 8.73 | 3.43 / 8.43 |
| lower-third | tiny-skia | 3.46 / 4.53 | 3.98 / 7.07 | 4.04 / 8.51 |
| lower-third | grapix-worker-cpu* | 106.30 / 161.99 | 100.98 / 201.28 | 105.77 / 284.55 |
| scorebug | vello-classic, no readback | 3.24 / 14.00 | 2.29 / 11.07 | 4.06 / 34.22 |
| scorebug | vello-hybrid, no readback | 0.96 / 3.33 | 1.00 / 5.10 | 0.73 / 1.43 |
| scorebug | vello-classic | 8.58 / 13.29 | 7.00 / 18.05 | 9.22 / 46.93 |
| scorebug | vello-hybrid | 4.96 / 8.34 | 5.80 / 11.39 | 5.29 / 39.81 |
| scorebug | vello-cpu | 2.91 / 26.08 | 2.35 / 3.93 | 3.53 / 36.20 |
| scorebug | tiny-skia | 3.20 / 9.48 | 2.84 / 4.47 | 3.58 / 7.19 |
| scorebug | grapix-worker-cpu* | 72.05 / 99.52 | 71.63 / 126.32 | 86.13 / 164.24 |
| full-panel | vello-classic, no readback | 5.21 / 15.97 | 3.18 / 18.08 | 3.08 / 70.31 |
| full-panel | vello-hybrid, no readback | 2.56 / 10.03 | 2.91 / 10.64 | 2.23 / 5.09 |
| full-panel | vello-classic | 7.16 / 17.59 | 7.54 / 17.39 | 5.75 / 52.03 |
| full-panel | vello-hybrid | 6.37 / 15.53 | 7.51 / 15.08 | 6.21 / 120.52 |
| full-panel | vello-cpu | 6.72 / 16.69 | 7.76 / 33.41 | 7.75 / 27.89 |
| full-panel | tiny-skia | 34.29 / 58.49 | 32.35 / 65.69 | 32.02 / 61.53 |
| full-panel | grapix-worker-cpu* | 577.26 / 728.12 | 574.27 / 1231.99 | 573.54 / 952.42 |

\* Same geometry, gradients flattened to their first stop, plain strokes, no
anti-aliasing (see Method). Not like for like; shown for scale.

Renderer initialisation (pipeline creation), three runs each: classic
DX12/FXC 4349 to 4590 ms, DX12/DXC 287 to 709 ms, Vulkan 40 to 56 ms; Hybrid
DX12/FXC 554 to 612 ms, DX12/DXC 208 to 349 ms, Vulkan 37 to 48 ms.

### Pixels (DX12, premultiplied, against `CROSS_MACHINE_TOLERANCE`)

Each cell is the share of differing pixels / the worst channel difference.

| workload | pair | full frame | AA corner or strokes | gradient only | gate |
|---|---|---|---|---|---|
| lower-third | Hybrid vs vello_cpu | 0.058% / 1 | 0.91% / 1 | 0% / 0 | full frame PASS |
| lower-third | classic vs tiny-skia | 0.97% / 78 | 10.2% / 78 | 12.5% / 1 | FAIL |
| lower-third | Hybrid vs tiny-skia | 2.84% / 58 | 35.6% / 58 | 39.8% / 1 | FAIL |
| lower-third | classic vs vello_cpu | 2.38% / 49 | 29.4% / 49 | 31.6% / 1 | FAIL |
| scorebug | Hybrid vs vello_cpu | 0.16% / 1 | 5.5% / 1 | | FAIL (share only) |
| scorebug | classic vs tiny-skia | 0.19% / 60 | 8.5% / 56 | | FAIL |
| full-panel | Hybrid vs vello_cpu | 1.74% / 1 | 2.66% / 1 | 0.001% / 1 | FAIL (share only) |
| full-panel | classic vs tiny-skia | 13.9% / 197 | 14.6% / 197 | 11.9% / 1 | FAIL |
| full-panel | classic vs vello_cpu | 19.6% / 197 | 25.3% / 197 | 11.7% / 1 | FAIL |

Repeatability: every backend gave identical pixels run to run. Hybrid gave
identical pixels on DX12/FXC, DX12/DXC and Vulkan (4 pixels off by 1 on the
Vulkan full-panel). Classic shifted with the shader compiler: DX12 FXC and DXC
differed on 1,146 scorebug pixels by up to 4 code values, outside the gate.

What the differences are:
- **Gradients** differ by exactly one code value between independent
  rasterisers (12 to 40% of the gradient area): rounding of the ramp, not a
  visible error. Hybrid and `vello_cpu` match each other exactly there.
- **AA edges** differ by up to 49 to 78 code values between algorithm
  families (analytic area coverage in tiny-skia, sparse-strip coverage in
  Hybrid and vello_cpu, compute-shader area AA in classic). Within one family
  (Hybrid vs vello_cpu) they differ by at most 1.
- **Classic draws a notch where a dash crosses a miter join** (full-panel,
  pixel (1738, 158): worst 197). tiny-skia, vello_cpu and Hybrid agree with
  each other there; classic is the outlier. Diff heatmaps: `*-diff-*.png`.

The 4.4 cross-machine tolerance (0.1% of pixels) was set for arithmetic noise
between machines. Even same-family GPU and CPU renders exceed its pixel share
on stroke-heavy frames while never exceeding 1 code value, so a GPU-vs-CPU
threshold for 3.17 is a decision still to be made, not something this spike
settles.

## Verdict

**Recommendation for 3.17: Vello Hybrid, with `vello_cpu` as its CPU
reference, once a Hybrid release on the product's wgpu exists.** Not Vello
classic. lyon-on-GPU still has to be measured before 3.17 can record a final
choice.

Why Hybrid over classic:
- Lower GPU cost on all three workloads at p50 (0.3 to 2.9 ms against 0.7 to
  5.2 ms) and a much steadier tail on many small paths (scorebug 0.7 to 1.0 ms
  against 2.3 to 4.1 ms).
- Deterministic across DX12, Vulkan and both DX12 shader compilers. Classic's
  output depends on the compiler, which a golden-pixel gate cannot tolerate.
- It has a same-algorithm CPU reference (`vello_cpu`) that matches it to one
  code value, which is what "match their CPU reference within the 4.4
  threshold" needs. Classic matches no CPU renderer to better than 33 to 197.
- Classic mis-draws dashed miter joins; Hybrid does not.
- Classic needs DXC on DX12 (4.5 s pipeline creation with FXC); Hybrid starts
  in under 0.7 s either way.

With readback, every backend lands at 4 to 9 ms per 1080p frame: the
synchronous 8 MB copy costs about 4 to 5 ms and dominates. The Program output
path needs pipelined (double-buffered, asynchronous) readback or a GPU-side
output adapter, whatever backend is chosen.

The existing worker CPU rasteriser takes 70 to 580 ms per 1080p frame, without
anti-aliasing, gradients or dashes. It is a reference path, not a live one
(memory.md rule 28).

## Role of `vello_cpu` in a GPU-first renderer

`vello_cpu` never draws Program: Program stays on the GPU (memory.md rule 28).
It earns its place only alongside Hybrid, as the CPU half of the same
algorithm:

- **The 3.17 reference.** 3.17 requires GPU drawing to match its CPU reference
  within the 4.4 threshold. Hybrid and `vello_cpu` differed by at most one
  code value here; an independent rasteriser (tiny-skia) differs by up to 58
  to 78 on every anti-aliased edge, so a gate against it would fail on every
  curve.
- **No-GPU paths with GPU pixels.** CI, software-adapter tiers (T2/T3, never
  live) and headless renders (thumbnails, approval previews, 11.41) could
  produce the same pixels as Program instead of a look-alike.
- **Replacing today's CPU reference.** 2 to 8 ms per 1080p frame against 70 to
  580 ms for the worker's rasteriser, with anti-aliasing, gradients, dashes,
  joins and caps, none of which the worker's path has.
- **Diagnosis.** Render one scene on both; a disagreement points at the GPU
  path, agreement at the scene.

Limits: it is only worth having if 3.17 chooses Hybrid (classic differs from
it by 33 to 197; a lyon-on-GPU path would need its own reference). The pair
must be pinned together: today `vello_hybrid` 0.2 uses `vello_common` 0.2 and
`vello_cpu` 0.3 uses `vello_common` 0.3, and they still agreed, but nothing
guarantees the next pair will. It was measured single-threaded only; its
multithreaded mode was not timed.

## Blockers

- **wgpu version coupling.** `vello_hybrid` 0.2.0 needs wgpu 29; the product
  and `vello` 0.11 are on wgpu 30. A Hybrid backend cannot share the
  product's device until Hybrid ships on wgpu 30, or the product pins
  Hybrid's wgpu, which would undo `0.2`'s bump. Each Vello release moves
  wgpu, so the product's wgpu pin becomes Vello's pin.
- **MSRV.** None today: `vello` and `vello_cpu` need 1.89, `vello_hybrid` 1.88,
  and the workspace is on 1.89. The next Vello release may raise it.
- **DXC.** wgpu 30's default DX12 compiler is `Auto`, which silently falls
  back to FXC when `dxcompiler.dll` is not on the search path (wgpu 26
  defaulted to FXC). The product must choose the compiler explicitly and
  ship `dxcompiler.dll` if it uses DXC; a silent fallback is what the
  architecture forbids.
- **Maturity.** Hybrid's own documentation says mask layers, complex filter
  graphs and some non-isolated blend modes panic, some failures panic instead
  of returning an error, and glyph caching is experimental. 3.19 (masks,
  mattes) must pre-validate every combination and refuse by name before a
  scene can reach Hybrid.
- **Text (3.18).** Vello draws glyph runs from font bytes it is handed, using
  `skrifa` outlines and its own glyph cache. cosmic-text stays the single
  shaper; its shaped glyph ids and positions would feed Vello glyph runs over
  package-owned font bytes only. Today's 3.13 outlines come from `swash`; two
  outline sources must not both reach the screen, so 3.18 picks one. Text was
  not measured here.

## What is still owed

`3.17` (not done): lyon-on-GPU benchmarked on the same workloads; the GPU vs
CPU-reference threshold decided; the chosen backend drawing GrapiX scenes
(`SceneDocument` through the worker, not a hand-written display list) with
images and the tagged colour pipeline; gradients no longer refused.

`16.9` (not done): measurement on real broadcast content (the reference
scenes and the Figma corpus, with text and images), not these three
synthetic workloads; long runs (thousands of frames, p99.9) on a quiet
machine; pipelined readback and output timing; 4K; a second GPU vendor; and
the evaluation "against the gate", which needs the threshold decision above.
