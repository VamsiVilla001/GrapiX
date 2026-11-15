# 3.17 evidence: GPU 2D drawing (paths, strokes, gradients and images)

Build-plan row `3.17`. **Done, 15 Nov 2026** (closing sections at the end).
The increments are recorded in order.

## Decisions (user, 15 Nov 2026)

Asked of Jev (`jev-1.14.0`) and Laya (`laya-multilingual` 0.4.28,
`max_len=8192`, no truncation) first; answers in
`agent/tmp/gpu-317/design-jev-laya.json` (untracked scratch), summarised here.

| Question | Jev | Laya | Decided |
| --- | --- | --- | --- |
| Drawing backend | Vello GPU 0.3 (0.96) | Vello GPU 0.3 | **Vello GPU 0.3** |
| Reference | Vello CPU 0.3 (0.96) | Vello CPU 0.3 | **Vello CPU 0.3** |
| Gate | float tie-aware (0.38) | strict 4.4 | **At most one code value per channel on any share of pixels, for drawing only** |
| Colour precision | float target (0.50) | convert 8-bit | **Vello for coverage only; colour and gradients in float in the working space** |
| User decision needed | yes (0.85) | yes (0.86) | asked |

Then, when the old CPU rasteriser turned out to have no anti-aliasing at all
(a pixel was in or out), the user decided: **the CPU path switches to Vello
CPU** (headless renders, the CPU reference and the pixel gate), the six
goldens are regenerated once, and **stroke join, cap and dash are added to
the contract** now.

The Vello GPU 0.3, Vello classic 0.11 and lyon-on-GPU measurements behind the
choice are codex's 7 Nov spike (`tools/vello-spike`, raw DX12 report in
`agent/tmp/gpu-317/dx12/report.json`): 1080p p50 / p99 per frame, dynamic,
no readback, Vello GPU 0.52 / 0.67 (lower third), 0.92 / 4.63 (scorebug),
2.86 / 8.23 ms (full panel); lyon 1.15 / 1.66, 6.26 / 19.65, 5.73 / 6.74 ms;
Vello classic 1.70 / 2.46, 2.29 / 11.29, 3.64 / 15.37 ms. Against Vello CPU,
Vello GPU's worst channel delta was 1 code value on every workload; lyon's 71
to 248, Vello classic's 33 to 197. These are recorded again with the product
integration when the row closes.

## Increment 1 (15 Nov 2026): Vello on both paths, strokes with joins, caps and dashes

- **Contract.** `ObjectBase.strokeStyle` (`StrokeStyle`: `join` miter, round
  or bevel; `cap` butt, round or square; `miterLimit`, default 4; `dash`;
  `dashOffset`). Absent means miter, butt, solid: every existing scene draws as
  before and serialises unchanged. TS and JSON Schema generated.
- **Paths.** A prepared path is now an outline (`kurbo::BezPath`, scene
  coordinates) filled under its fill rule. A stroke is expanded once at prepare
  by `kurbo::stroke`, joins, caps and dashes included, and filled non-zero, so
  the GPU and the CPU draw the same geometry. lyon still builds the authored
  outline and measures trim (3.19); its tessellator no longer draws.
- **Refused by name** (`VectorTessellationFailed` naming the object): a miter
  limit below 1 or not finite; a dash entry negative or not finite; a dash
  pattern with no length; more than 64 dash entries; a dash pattern that would
  repeat more than 100,000 times along the stroke, checked before any dash is
  generated (invariant 51).
- **CPU backend** (`rasterise::VelloCpuRasteriser`): Vello CPU fills each path
  in white over its coverage window; the 8-bit alpha left is the coverage; the
  path's paint, already in the working space, is composited in float scaled by
  it. Colour never passes through Vello's 8-bit pipeline (3.15).
- **GPU backend** (`compositor::draw::GpuDrawer`, built once per device and
  kept in `Gpu`): Vello GPU draws the same coverage over the same window into
  an 8-bit target; `draw.wgsl` composites the paint in float into the layer
  source, which the compositor samples directly (`LayerInput.drawn`). One
  queue submission per path: Vello uploads each scene's strips with queue
  writes, and two paths recorded into one encoder both read the last path's
  strips (found by the drawer test below). Vector objects take the route
  `gpu-vello-coverage-at-prepare`; text keeps its CPU glyph route until 3.18.
  Nothing draws on the frame path (invariant 35).
- **Goldens regenerated once** from the Vello CPU path; the previous six are
  in `tests/baselines/history/2026-11-15-before-3.17` byte for byte.

### Executed

| Check | Result |
| --- | --- |
| `compositor::draw::tests::gpu_drawer_matches_the_cpu_backend_within_one_coverage_step` (hardware) | Two paths (a rounded rect non-zero, a circle even-odd), at 40x30, 300x200 at origin (-17, 230), 700x90 at (5, -3): every float channel of the GPU drawer within 1/255 of the CPU backend |
| `engine::gpu_tests::gpu_engine_draws_vector_content_within_one_code_of_the_vello_cpu_reference` (hardware) | Every join and cap, a dash pattern with an offset, both fill rules, rounded rect, ellipse, polyline, through the real engine in both working spaces: 0 CPU source rasterisations, all nine sources on the GPU route, Program and Preview within one code value of the Vello CPU reference, more than 200 anti-aliased pixels, even-odd leaves a star's centre open and non-zero fills it |
| `engine::gpu_tests` (7, hardware) | The lower third (plate and accent on the GPU, headline on the CPU, one CPU source rasterisation) and all six goldens within one code value of the CPU reference |
| `rasterise::tests` | A dashed stroke leaves its gap empty and draws its dashes; the six refusals above, each naming the object |
| `prepared::tests::a_semi_transparent_stroke_composites_each_pixel_once` | Rewritten for anti-aliasing: no pixel exceeds the paint's own alpha where the zigzag overlaps itself, and most lit pixels carry exactly that alpha |
| `cargo run -p gx-pixel-gate -- check` | Before regeneration: colour-ramp-50 90 differing pixels (worst delta 124), rate-30 552 (99), rate-59-94 396 (134), rate-60 340 (137), rate-25 and rate-29-97 unchanged; after, exit 0 |
| `colour_reference` | The authored-value samples of the colour ramp still hold |

### Not in this increment

- Image quads, the benchmark of the chosen backend in the product,
  mutations. Next increments.
- **Transformed layers.** A rotated, scaled or fractionally placed object is
  drawn into its object-local source and resampled by the compositor (3.16),
  so it is compared with the CPU reference only at whole-pixel placements, as
  3.16's gate was. This row does not change that.

## Increment 2 (15 Nov 2026): linear and radial gradients on paths

Gradients on path fills and strokes are drawn, no longer refused. The contract
never fixed what a gradient's fields mean (the Editor does not draw them and
1.x never did), so this increment defines it, following the contract's own
tests, and refuses by name wherever the meaning would be ambiguous:

- **Object space**: coordinates are fractions of the object's box, (0, 0)
  top-left to (1, 1) bottom-right. **Scene space** is refused by name: a
  scene-space gradient stays put while its object moves, and the engine draws
  each object's source once at prepare.
- **Linear**: the axis runs from the start point to the end point. A non-zero
  `angle` beside explicit points is refused by name rather than ignored.
- **Radial**: elliptical, `t = |(p - centre) / radii|`; a focal point off the
  centre is refused by name.
- **Spread**: pad, repeat or reflect. **Stops**: at most 16, positions in 0 to
  1 and non-decreasing; colours converted to premultiplied working-space
  colour and interpolated there (`WorkingRgba::mix`, 3.15). A hard stop is two
  stops at one position.
- One rule for the validator and the engine (invariant 27):
  `ColorValue::gradient_problem`, refusing `GradientNotDrawable { object,
  paint, detail }`, a new refusal driven by the conformance audit. Text fills
  still refuse `UnsupportedPathGradient` until 3.18; brush paint strokes stay
  solid.
- Both backends evaluate the gradient from the same two f32 rows per coverage
  window, with the same spread, stop search and interpolation, in Rust
  (`rasterise::paint`) and in WGSL (`compositor/draw.wgsl`).

### Executed

| Check | Result |
| --- | --- |
| `compositor::draw::tests::gpu_drawer_matches_the_cpu_backend_within_one_coverage_step` (hardware) | Now also linear pad and repeat, radial reflect and pad, with a hard stop and a stop fading to transparent, over the shapes and across the window at three sizes and origins: within 1/255 of the CPU backend on every float channel |
| `engine::gpu_tests::gpu_engine_draws_vector_content_within_one_code_of_the_vello_cpu_reference` (hardware, `GX_GPU_316_BACKEND=dx12` and `=vulkan`) | Adds a repeating linear fill with a hard stop on a rounded rect, a reflected radial fill on an ellipse and a linear stroke: within one code value of the Vello CPU reference in both working spaces, on both backends |
| `engine::gpu_tests` (8, hardware, DX12 and Vulkan) | All pass |
| `rasterise::tests::a_linear_gradient_fill_runs_from_its_first_stop_to_its_last_across_the_box` | Pixel centres 0.5 and 9.5 of a 10-pixel box carry 0.95/0.05 and 0.05/0.95 of the two stops in linear light; outside the box is empty |
| `drawability::tests` | A drawable gradient refuses nothing; an angled one refuses `GradientNotDrawable` for fill and stroke, hidden too; unboxed, coincident points, decreasing or out-of-range stops, 17 stops, a zero radius, an off-centre focus and scene space each refuse with their detail; text still refuses `UnsupportedPathGradient` |
| Conformance refusal audit | `GradientNotDrawable` is driven, and refused identically by the validator and the publication wire for a fill, a hidden fill and a stroke |

**The comparison rule, refined.** The one-code rule does not compare the
colour of a pixel whose alpha is code 0 on both sides: such a pixel is
invisible, and its straight colour is a quotient by an alpha too small to
show. On Vulkan, one pixel at the transparent end of a gradient had alpha 0 on
both sides and colour 226 on the CPU against 0 on the GPU.

## Increment 3 (15 Nov 2026): tagged image quads, every fit mode

User decisions, 15 Nov 2026, after Jev and Laya
(`agent/tmp/gpu-317/design-images-jev-laya.json`): the source colour tag
lives on the **asset record**, filled at import from the PNG's own `sRGB`
chunk; **PNG only**; **all eight fit modes**; an untagged asset is **refused
by name**. Jev: file metadata (0.19, weak), PNG only (0.88), all eight
(0.62), refuse (0.86). Laya: on each image object, PNG and JPEG, stretch
only, refuse.

- **Contract.** `AssetLibraryItem.colorSpace` (absent: untagged);
  `ImageObject.slice` (`ImageSlice`, nine-slice insets in texels); the edit
  `setAssetColorSpace { assetId, colorSpace }` (an unknown asset refuses
  `SceneAssetUnknown`), in the witness trace of every edit; the refusal
  `ImageNotDrawable { object, asset, detail }`, driven by the audit. The
  validator (`drawability::image_problem`) refuses an unknown, non-image,
  unstored or untagged asset and missing or negative nine-slice insets; the
  engine adds what only the bytes say: not a PNG, more than 4096 x 4096
  texels (checked from the header before decoding, invariant 51), undecodable,
  insets wider than the image, a raster beyond the device limit.
- **Import.** `gx_asset_plane::import::png_colour_tag`: a PNG's `sRGB` chunk
  before its image data tags it sRGB; nothing else is read as a tag (a gamma
  or ICC chunk alone names no standard space), so such a PNG stays untagged
  until the user tags it.
- **Engine.** `image::decode` (8- and 16-bit, grey, grey-alpha, RGB, RGBA,
  palette expanded) into premultiplied working-space float through the colour
  pipeline from the tagged space; `image::fit_plan`: per axis a piecewise-linear
  map from box coordinates to texels (one segment for the scaled modes, three
  for nine-slice). Stretch fills the box; contain and cover scale uniformly,
  centred (cover clipped); crop, original and pixel-perfect are native size,
  centred (original unclipped; pixel-perfect at a whole-pixel offset, rounded
  half away from zero, sampled nearest); tile repeats from the box's
  top-left; nine-slice keeps corners at native size (scaled together when the
  box is shorter than both insets) and stretches edges and centre. Sampling is
  bilinear with clamped edges, scaled by how much of the pixel the image covers
  (the pixel's extent mapped into texels), and by the box's coverage when the
  mode clips. The GPU pass (`compositor/image.wgsl`, in `GpuDrawer`) and the CPU
  twin (`FitPlan::sample`) do the same f32 operations; the compositor then warps
  the raster like any layer, and the CPU reference warps it with the same
  sampler. Route `gpu-image-fit-at-prepare`.
- **Not drawn yet, named**: brush paint objects still refuse
  `ObjectKindNotDrawable` (owner 3.17); they are not in this row's done-when.

### Executed

| Check | Result |
| --- | --- |
| `image::tests` (4) | Decoding into the tagged space (sRGB 128 is 0.216 linear, linear 128 is 0.502); refusals for a JPEG, a broken PNG and a 4097 x 4097 one; every fit mode's sample values; nine-slice corners, middle mapping, wide insets refused, a short box scaling the corners |
| `compositor::draw::tests::gpu_image_fit_matches_the_cpu_raster_in_every_fit_mode` (hardware) | A 13 x 7 partly transparent image, every fit mode, boxes 40.5 x 23.25, 9 x 5.5 and 5 x 30: GPU within one 8-bit step of the CPU raster on every float channel |
| `engine::gpu_tests::gpu_engine_draws_image_quads_in_every_fit_mode_within_one_code_of_the_cpu_reference` (hardware, DX12 and Vulkan) | One sRGB-tagged PNG drawn by eight image objects, one per fit mode, at opacity 0.9, through the real engine in both working spaces: every source on `gpu-image-fit-at-prepare`, Program and Preview within one code value of the CPU reference, each object visible |
| `drawability::tests::an_image_draws_only_when_its_asset_is_a_stored_tagged_image` | Draws when stored and tagged; refuses each problem with its detail |
| `import::tests::a_png_is_tagged_srgb_only_by_its_own_srgb_chunk_before_its_image_data` | The sRGB chunk tags; gAMA alone does not; after IDAT is not read; a truncated file is untagged |
| Conformance (asset plane, real engine) | An image object over the delivered `rate-25.png`, untagged, is refused `ImageNotDrawable` ("no colour space"); the same image with its asset tagged sRGB publishes. `ImageNotDrawable` is driven. (A validator-and-wire parity case is not possible for it: the parity harness holds no asset bytes, so the validator names every referenced image asset `AssetMissing` first.) |

## Backend measurements recorded with the product (15 Nov 2026)

The spike (`tools/vello-spike`) rerun today on the same three reference
workloads, 1080p, RTX 3070 Ti, 30 samples after 5 warm-ups, dynamic display
list, no readback. Its executable is the one built on 7 Nov 2026: a fresh
`--locked` build refused, because the worker's new dependencies would change
the spike's own lockfile, which was left as it is. That binary pins the same
Vello GPU 0.3, Vello CPU 0.3 and lyon versions the product uses; only its
"worker CPU" column is the old rasteriser. Raw reports:
`agent/tmp/gpu-317/2026-11-15/{dx12,vulkan}/report.json` (untracked scratch).

| Backend | DX12 p50 / p99 ms (lower third, scorebug, full panel) | Vulkan p50 / p99 ms | Worst delta against Vello CPU |
| --- | --- | --- | --- |
| **Vello GPU 0.3 (chosen)** | 0.36 / 0.40, 0.74 / 3.95, 2.90 / 6.21 | 0.22 / 0.26, 0.28 / 0.33, 2.08 / 2.38 | 1 code value on every workload (0.06%, 0.16%, 1.74% of pixels) |
| lyon on GPU, 4x MSAA | 23.91 / 28.56, 80.13 / 85.67, 127.27 / 161.24 | 0.32 / 0.34, 1.55 / 2.24, 3.30 / 3.59 | 102, 71, 248 code values |
| Vello classic 0.11 | 0.99 / 1.61, 2.11 / 6.47, 2.94 / 6.87 | 0.75 / 0.97, 0.73 / 0.96, 5.17 / 9.28 | not measured against Vello CPU here |

Vello GPU is the fastest backend on both APIs and the only one within one code
value of its CPU reference. lyon on DX12 was far slower today than on 7 Nov
(1.15 to 5.73 ms p50); that is recorded as measured, not explained. In the
product the drawing runs once per object at prepare, never per frame.

## Mutations (15 Nov 2026)

One exact replacement each, run alone against the hardware drawing tests (or
the contracts or asset-plane tests named), files restored byte-identical.

| # | Mutation | Failing |
| --- | --- | --- |
| D1 | the GPU compose ignores coverage | the drawer test, the vector, lower-third and golden engine tests |
| D2 | the CPU coverage is divided by 256 | the lower-third engine test, two rasteriser tests |
| D3 | the CPU reflect spread repeats instead | the drawer test, the vector engine test |
| D4 | the GPU stop interpolation drops its weight | the drawer test, the vector engine test |
| D5 | the CPU pixel-perfect fit filters bilinearly | **none: equivalent.** Pixel-perfect places the image at a whole-pixel offset at scale 1, so every raster pixel centre is a texel centre and bilinear sampling returns that texel. |
| D6 | the GPU tile clamps instead of wrapping | the GPU image test, the image engine test |
| D7 | a round join is drawn as a miter | `joins_and_caps_cover_the_areas_their_names_say` |
| D8 | the dash-count bound is skipped | the stroke refusal test |
| D9 | a gradient angle is ignored | the validator gradient test |
| D10 | an untagged image is drawn | the validator image test |
| D11 | the import ignores the sRGB chunk | the import tag test |
| D12 | the GPU image pass ignores image coverage | the GPU image test, the image engine test |

`rasterise::tests::joins_and_caps_cover_the_areas_their_names_say` was added
for D7, which changes both backends alike and so cannot be caught by a
GPU-against-CPU comparison: a sharp V covers bevel < round < miter, and a
24-pixel segment 4 wide covers 96 (butt) < round < 112 (square).

## Done (15 Nov 2026)

Every clause of the done-when has executed evidence above: fills, strokes with
joins, caps and dashes, linear and radial gradients and tagged image quads draw
on the GPU with anti-aliasing and match their CPU reference within the drawing
threshold the user set for this row (at most one code value per channel, the
colour of a pixel transparent on both sides excepted), on DX12 and Vulkan;
gradients on paths are no longer refused; lyon-on-GPU and Vello are
benchmarked on the reference workloads and Vello GPU is recorded as the
backend with its measurements. Gate: npm run check exit 0 (849 Rust passed, 0 failed, 31 ignored; conformance 584/0/9; hardware worker suite 171/0/0).

**Found at the final gate and fixed.** The conformance timed run "headless
renders while Program runs add no late or missed Program frame" (invariant 14)
had one late Program frame in two of three runs after this row's last change:
Program alone 150 frames 0 late, with 5 or 6 headless renders 159 or 177
frames, 1 late. It runs against a debug worker, and headless renders now draw
full frames with Vello CPU, which is heavier than the old rasteriser and was
unoptimised there. Headless renders run after the engine releases its lock, so
this was CPU contention, not blocking. The workspace now builds `vello_cpu`,
`vello_common`, `fearless_simd` and `kurbo` at `opt-level = 3` in debug
(`Cargo.toml`); the product's own code stays debug. After it: three runs out of
three pass, 584 passed, 0 failed, 9 skipped.

**Not part of this row, named:** text fills still refuse gradients
(`UnsupportedPathGradient`, owner 3.18, GPU text); brush paint objects still
refuse `ObjectKindNotDrawable` (owner 3.17 in the validator, outside this
done-when); scene-space gradients and off-centre radial foci refuse
`GradientNotDrawable` by name; JPEG and other formats refuse
`ImageNotDrawable`. A rotated, scaled or fractionally placed object is drawn
into its object-local source and resampled by the compositor (3.16).

## Jev and Laya on acceptance (15 Nov 2026)

Same typed questions as 5.12 and 5.10, plus three for this row, with the plan's
done-when, the user's threshold decision, this README in full and the gate
(`jev-laya-acceptance.json`; Laya 6043 state tokens, not truncated). Jev
`jev-1.14.0`, confidences: `done_when_met` 0.97, `evidence_names_execution`
0.99, `silent_substitution_risk` 0.29, `weakest` none, `unrun_is_named` 0.54,
`mutations_can_fail` 0.38, threshold applied as decided 0.93, both backends
0.98, benchmark clause 0.95. Laya answered 0.91 or more to every yes/no
question and named an unexecuted clause; as on 5.12 and 5.10 it carries no
signal here. Read by hand: Jev's low `mutations_can_fail` is right under that
question's wording (every mutation must fail a check), because D5 does not; it
is recorded above as equivalent, with the reason.

