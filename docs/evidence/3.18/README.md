# 3.18 evidence: GPU text, real glyph outlines from packaged fonts

Build-plan row `3.18`. **Done, 15 Nov 2026.** Taken on the user's instruction
("start with the unblocked pointers"), after 3.17.

## What changed

Text was already shaped by cosmic-text from package-owned font bytes only
(3.6, 3.13: the system font database is never loaded) and already drawn as
glyph outlines, not advance rectangles. But the outlines were tessellated into
triangles and filled without anti-aliasing on the CPU, the GPU route
included. Now:

- **Outlines are paths.** Each text object's glyph outlines are one
  `kurbo::BezPath` in the text's own coordinates (`PreparedTextObject.outline`),
  built once at publish. `PreparedPaths::prepare` places it through the
  object's transform like any vector shape and fills it non-zero.
- **One drawing path for everything.** Text is drawn by the 3.17 backends:
  Vello GPU coverage at prepare on the GPU route
  (`gpu-vello-coverage-at-prepare`), Vello CPU on the CPU path. The text-only
  triangle rasteriser (`text::rasterise_texts`, `rasterise::fill_union`,
  `PathVertex`) is removed.
- **Fill gradients and strokes.** Because text is a path, a text fill takes a
  linear or radial gradient by the 3.17 rule (`GradientNotDrawable` for what
  cannot be drawn as authored), and a text stroke is drawn, joins, caps and
  dashes included. Both were refused before (owner 3.18); the refusals are
  lifted. `UnsupportedPathGradient` has no reachable producer left (brush paint
  objects are refused as a kind first) and is a named limitation in the
  conformance audit.
- **Re-owned.** Text vertical alignment, decoration, overflow, point-text
  alignment and an outline-less glyph still refuse by name; they are layout
  features outside this row's done-when, now owned by `11.51` (text engine
  depth) instead of 3.18.
- **Fixtures (user approval, 15 Nov 2026).** Noto Sans Telugu, Noto Sans
  Devanagari, Noto Nastaliq Urdu and Noto Sans Arabic, SIL OFL 1.1, downloaded
  from github.com/notofonts and committed as test fixtures with
  `tests/fixtures/OFL-Noto.txt`; with the existing Inter and Noto Sans Hebrew.
- **Golden.** `colour-ramp-50` holds Inter text, now anti-aliased: regenerated
  (942 pixels differed, worst delta 183, all at glyph edges), the previous one
  in `tests/baselines/history/2026-11-15-before-3.18`. The other five goldens
  hold no text and are unchanged. The authored-value samples of
  `colour_reference` still hold.

## Executed

| Check | Result |
| --- | --- |
| `engine::gpu_tests::gpu_engine_draws_text_in_five_scripts_within_one_code_of_the_cpu_reference` (hardware, `GX_GPU_316_BACKEND=dx12` and `=vulkan`) | Nine text objects through the real engine, both working spaces: Latin (Inter, with a ligature), Telugu, Hindi, mixed bidi (Latin, numerals and Hebrew), a gradient fill, a stroke, **Urdu in Nastaliq, the same Urdu in Naskh, and Urdu mixed with English and numerals**. Every source on the GPU route, 0 CPU source rasterisations; each line draws. Against the Vello CPU reference: **0 differing pixels** in Program and Preview on both backends, so strict 4.4 (at most one code value on at most 0.1% of pixels) holds, not only the 3.17 one-code rule |
| `text::tests::telugu_and_hindi_shape_into_clusters_from_their_packaged_faces` | Telugu and Devanagari conjuncts and vowel signs shape into fewer glyphs than characters, with clusters spanning several characters, from the declared fallback face |
| `text::tests::urdu_shapes_right_to_left_with_joined_letters_in_nastaliq_and_naskh` | In both styles: every Urdu glyph in a right-to-left run, the first letter drawn furthest right, and a joined beh takes a different glyph from beh alone |
| `text::tests::a_script_no_declared_font_covers_refuses_instead_of_reaching_for_a_system_font` | Telugu with only Inter declared refuses `FontMissing` (invariant 66); nothing is filled from a system font |
| `text::tests::text_draws_its_stroke_and_its_gradient_fill` | A stroke-only text draws; a red-to-blue gradient fill is red on the left glyphs and blue on the right |
| `text::tests` (all 12) and `advanced_shaping_uses_opentype_bidi_and_declared_fallback_only` | Pass, the ligature, bidi and declared fallback included |
| `engine::gpu_tests` (10, hardware, both backends) | Pass; the lower third's headline now takes the GPU route (0 CPU source rasterisations) |
| `drawability::tests` | A boxed text gradient draws; an unboxed one refuses `GradientNotDrawable` for "text fill"; a text stroke no longer refuses |
| `cargo run -p gx-pixel-gate -- check` | Exit 0 after the `colour-ramp-50` regeneration |

| `cargo test -p gx-render-worker -- --include-ignored` | 177 passed, 0 failed, 0 ignored on the hardware GPU |
| Repository gate | cargo fmt --check and clippy -D warnings exit 0; npm run check exit 0 (853 Rust passed, 0 failed, 32 ignored; conformance 583/0/9; hardware worker suite 177/0/0). Conformance has one check fewer than at 3.17: the check that a gradient text fill is refused is gone, since it now draws |

## Mutations

One exact replacement each, run alone, files restored byte-identical.

| # | Mutation | Failing |
| --- | --- | --- |
| T1 | text paths are not built | the five-script engine test, the lower third, the goldens, the draw-order and glyph-outline tests |
| T2 | glyph outlines are not flipped to y-down | the golden-frame test (GPU and CPU share the flip, so only the stored reference sees it) |
| T3 | the declared fallback families are ignored | the five-script engine test, the bidi, Telugu-and-Hindi and Urdu tests |
| T4 | the text stroke is dropped | `text_draws_its_stroke_and_its_gradient_fill` |
| T5 | a text fill gradient is not checked | the validator gradient test |
| T6 | a missing glyph is drawn as notdef | the no-system-font refusal test |

## Not in this row

- Text layout features that still refuse by name, now owned by 11.51:
  vertical alignment, underline and strikethrough, overflow, point-text
  alignment.
- Text, like every layer, is drawn into its object-local source at prepare and
  resampled by the compositor when rotated, scaled or fractionally placed
  (3.16); the comparisons above are at whole-pixel placements.
- Mixed-script bidi in one line with three or more scripts, and Nastaliq's
  full kashida justification, are not separately tested.

## Jev and Laya on acceptance (15 Nov 2026)

`jev-laya-acceptance.json`; Laya 1859 state tokens, not truncated. Jev
`jev-1.14.0`, confidences: `done_when_met` 0.87, `evidence_names_execution`
0.99, `silent_substitution_risk` 0.32, `weakest` none, `unrun_is_named` 0.33,
`mutations_can_fail` 0.97, scripts covered 0.94, missing glyph and no system
font 0.97, both backends 0.98. Laya answered 0.94 or more to every yes/no
question and named a vague record; it carries no signal here. Read by hand:
Jev's low `unrun_is_named` fits the record it was given, which did not yet name
the full hardware suite and the repository gate (asked before they ran); both
are recorded above. The untested items are named under "Not in this row".
