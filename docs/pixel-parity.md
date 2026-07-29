# Pixel parity

How GrapiX checks that what a designer sees in the Editor is what goes to air, and — just
as importantly — what that check does and does not currently prove.

Run it with:

```bash
npm run dev:engine        # in one terminal
npm run certify:parity    # in another
```

## What is automated

| Check | What it would catch |
| --- | --- |
| Native determinism | A renderer whose output varies between identical calls. Nothing else in this document means anything if this fails, so it runs first. |
| Tile composite against single pass | A seam, an overscan mistake, or a rebase error. The same region is rendered once as a single pass and once as a composite of 512 px tiles, and the two must be **pixel-identical**. |
| Far edge against near edge | The f32 precision failure the whole virtual-canvas design exists to avoid. Identical content is placed at x=0 and at x=49,000 and must render the same. |
| Program capture determinism | Non-determinism on the path that actually reaches an output, captured byte-exact through the recording adapter rather than through a lossy preview. |

All four pass on an NVIDIA RTX 3070 Ti (Vulkan) with **zero differing pixels**.

The tile-versus-single-pass result is the one worth dwelling on. `packages/tile-system`
proves seam-freedom *algorithmically* — that the tiles cover the region exactly once and the
overscan ring is discarded. This proves it *photographically*: the composited image and the
single-pass image are the same bytes. Those are different claims, and a design that rests on
a 50,000² virtual canvas needs both.

## What is not automated: the browser side

Capturing the Editor's PixiJS output needs a real browser, and this repository has no browser
automation (no Playwright, no Puppeteer). The harness therefore **does not claim parity with
the browser renderer**. It looks for captures on disk, compares any it finds using exactly
the same comparison code, and reports a `SKIP` — never a pass — when there are none.

To produce a capture:

1. Open the Editor and load the scene you want to compare.
2. Run `Help ▸ Capture Parity Frame` (or press `Ctrl+Alt+P`). The browser downloads
   `parity-browser-<width>x<height>.png`, read back from the live WebGL canvas with the
   interaction overlay excluded.
3. Move that file into `artifacts/pixel-parity/browser/`.
4. Re-run `npm run certify:parity`.

The comparison then runs with a tolerance of ±4 per channel and allows 0.2% of pixels to
exceed it. That is deliberately not zero: PixiJS on WebGL and wgpu on Vulkan are different
rasterisers, and they legitimately disagree in the last bit or two on antialiased edges.
Demanding exactness across two rasterisers would make the harness fail on correct output,
and a check that fails on correct output gets switched off. What the tolerance does not admit
is anything a viewer could see.

Before comparing, the native frame is unpremultiplied and both images are flattened onto the
same background. The native renderer produces premultiplied alpha and a canvas read-back is
straight; comparing them raw reports a difference in every semi-transparent pixel that
nobody could see, while comparing composited colour alone would hide a real alpha fault.

## Reading a failure

Every comparison reports four numbers, because each answers a different question:

- **Max channel delta**, and where. The single worst pixel. A large max with a tiny mean is a
  localised fault: one glyph, one edge, one seam.
- **Mean absolute error.** A small max with a large mean is systematic: a gamma or
  colour-space mismatch rather than a rendering bug.
- **Pixels beyond tolerance**, as a count and a percentage. How much of the frame is affected.
- **Worst 16×16 block.** Broadcast faults cluster — a seam is a line, a wrong glyph is a box —
  so the location of the worst *region* is more useful than the worst pixel.

A failing comparison writes a diff PNG into `artifacts/pixel-parity/`, along with both inputs.
Differences are drawn in red over a darkened copy of the reference, so a seam is visible at a
glance without a colour key.

## The comparison core

`tools/certification/pixel-parity.mjs` is the comparison, separate from any capture route,
because the two fail differently: a capture problem is plumbing, a comparison result is
evidence. It has its own unit tests
(`packages/render-protocol/tests/pixel-parity.test.mjs`, 20 tests) covering the metrics, the
alpha handling, the BGRA conversion, and a PNG codec that reads what both the Rust `image`
crate and browsers actually write — real deflate and all five row filters. A reader that only
understood its own output would pass its own tests and fail on every real capture.

## Why previews can be PNG

`preview.request` accepts `encoding: "png"`, which is lossless and keeps alpha. JPEG is right
for a preview a human looks at and wrong for anything measured: its own error is larger than
the differences this harness is trying to detect. Streams stay JPEG — a stream of PNGs at
30 fps is bandwidth spent on precision nobody is measuring.

`forceTiled: true` renders a region by the tile-composite route even when it would fit one
texture. It is distinct from `showTileDebug`, which *draws* the grid and therefore produces an
image that cannot be compared. The reply reports `renderPath` so a harness can confirm the two
captures genuinely came from different routes rather than accidentally comparing one path with
itself.
