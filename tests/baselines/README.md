# Pixel references

Run `cargo run -p gx-pixel-gate -- check` from the shared worktree. The
renderable JSON fixtures are in `tests/reference-scenes`; authored mappings
that the renderer cannot draw live in `tests/refusal-scenes` and must refuse.
A passing baseline comparison does not certify those unsupported mappings.

## 16 October 2026: colour-ramp-50 correction

The previous colour-ramp baseline ignored vector opacity and drew placeholder
text/mesh pixels. The corrected scene retains real packaged Inter text and
vector geometry; unsupported image/material/mesh mappings remain in the
refusal fixture. The historical PNGs under `history/2026-10-13-before-3.13`
preserve the previous references byte for byte.

The replacement is justified by authored values, not a relaxed threshold:

| Sample | Expected RGBA8 | Authored meaning |
| --- | --- | --- |
| (5, 5) | 255, 0, 0, 255 | Opaque red ramp |
| (28, 40) | 255, 0, 0, 26 | Red veil at opacity 0.1 |
| (40, 40) | 255, 210, 210, 71 | White at 0.2, then red at 0.1 in legacy linear working space |
| (250, 120) | 255, 210, 210, 71 | Same veils without a removed mesh placeholder |
| (300, 170) | 0, 0, 0, 0 | No authored geometry |

`services/render-engine/worker/tests/colour_reference.rs` checks those values
through the real prepared-scene renderer. The blue vector sample also checks
the authored colour within one quantization code value. Existing worker tests
cover packaged glyph outlines, opacity, working-space composition and named
refusals. Before regeneration, exactly 39,065 pixels differed, maximum channel
delta 255; the five rate references were unchanged. No comparison threshold
is changed. This is a Windows software-reference correction, not a Windows /
macOS comparison or certification of the future GPU renderer (step 4.5 remains
active).
