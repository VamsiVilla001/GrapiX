# 3.17 evidence: GPU 2D drawing (paths, strokes, gradients and images)

Build-plan row `3.17`. **Active.** This file records the increments as they
land; the row is done only when every clause of its done-when has executed
evidence here.

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
