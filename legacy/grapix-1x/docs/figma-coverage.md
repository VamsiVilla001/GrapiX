# Figma Import Coverage

What the Figma importers read, what they ignore, and what that costs. Audited against the
Figma REST node schema and the plugin API.

Two front-ends, one mapper (`packages/importers/src/figma-mapper.ts`). "REST" is the
fallback path; "Plugin" is the higher-fidelity path. A gap in the mapper affects both.

Legend: **yes** mapped · **partial** mapped with a known loss · **no** not read.

## Node basics

| Field | REST | Plugin | Notes |
| --- | --- | --- | --- |
| `id` | yes | yes | Identity anchor. Stable across edits — the reason Figma is the reference source. |
| `name` | yes | yes | Also parsed for design tokens. |
| `type` | yes | yes | Unmapped types warn and render as empty containers. |
| `visible`, `locked`, `opacity` | yes | yes | |
| `blendMode` | yes | yes | Full 16-mode map. |
| `relativeTransform` | yes | yes | Full affine. Falls back to `absoluteBoundingBox` translation, which loses rotation — warned. |
| `size` / `width`+`height` | yes | yes | |
| `clipsContent` | yes | yes | |
| `absoluteRenderBounds` | yes | yes | Bounds *including* effect and stroke bleed. |
| `isMask` | yes | yes | |
| `maskType` | yes | yes | Luminance masks raise `FIGMA_LUMINANCE_MASK`: they must composite by luminance, not alpha, or a gradient fade looks wrong. |
| `children` | yes | yes | |

## Fills, strokes, effects

| Field | REST | Plugin | Notes |
| --- | --- | --- | --- |
| `fills[]` — solid | yes | yes | |
| `fills[]` — 4 gradient types | yes | yes | REST from `gradientHandlePositions`; the plugin supplies `gradientTransform` directly, which is used in preference. |
| `fills[]` — image | yes | yes | |
| Paint `visible`, `opacity`, `blendMode` | yes | yes | |
| Paint `scaleMode` | yes | yes | |
| Paint `imageTransform` | yes | yes | Crop/placement. Without it a cropped headshot renders at the wrong offset. |
| Paint `scalingFactor` | yes | yes | Tile scale. |
| Paint `rotation` | yes | yes | |
| Paint `filters` | yes | yes | Exposure/contrast/saturation/temperature/tint/highlights/shadows. All-zero sets are dropped as equivalent to absent. |
| `strokes[]` | yes | yes | Same paint vocabulary as fills. |
| `strokeWeight`, `strokeAlign`, `strokeCap`, `strokeJoin`, `strokeDashes` | yes | yes | |
| `individualStrokeWeights` | yes | yes | Per-side weights, recorded only when the sides actually differ. |
| `strokeMiterAngle` | yes | no | Plugin exposes `strokeMiterLimit` instead; not yet mapped. |
| `strokeGeometry` | **no** | **no** | Outlined stroke path. Only `fillGeometry` is read, so a stroke on a complex vector is reconstructed from weight/align rather than its true outline. |
| `effects[]` — drop/inner shadow, layer/background blur | yes | yes | |
| Effect `showShadowBehindNode` | yes | yes | |
| Effect — noise, texture | **no** | **no** | Newer Figma effects. Unmapped and currently unwarned. |
| `cornerRadius`, `rectangleCornerRadii`, `cornerSmoothing` | yes | yes | |

## Text

| Field | REST | Plugin | Notes |
| --- | --- | --- | --- |
| `characters` | yes | yes | |
| Run splitting | partial | yes | Plugin uses `getStyledTextSegments` — real runs. REST reconstructs from `characterStyleOverrides` + `styleOverrideTable` and raises `FIGMA_TEXT_RUNS_RECONSTRUCTED`. |
| `fontFamily`, `fontWeight`, `fontSize` | yes | yes | |
| `fontPostScriptName` | yes | **no** | The exact face. Plugin gives family+style only, which cannot always resolve a face unambiguously. |
| `letterSpacing` | yes | yes | Plugin normalises percent tracking to px. |
| `lineHeightPx` | yes | yes | |
| `lineHeightPercent`, `lineHeightUnit` | **no** | n/a | REST normally supplies px too, so this is a low-risk gap. |
| `textAlignHorizontal`, `textAlignVertical` | yes | yes | |
| `textAutoResize` | yes | yes | Feeds the auto-fit broadcast object later. |
| `textCase`, `textDecoration` | yes | yes | |
| `paragraphSpacing` | yes | yes | |
| `textTruncation`, `maxLines` | yes | yes | |
| `leadingTrim` | **no** | **no** | Affects vertical metrics of tight text boxes. |
| `hyperlink` | **no** | **no** | No broadcast meaning. |
| Per-run `baselineShift` | **no** | **no** | Always 0. Superscripts will sit on the baseline. |

## Layout intent

| Field | REST | Plugin | Notes |
| --- | --- | --- | --- |
| `layoutMode` and the auto-layout block | yes | yes | Axis, alignment, spacing, padding, sizing modes. |
| `constraints` | yes | yes | Pinning intent. |
| `layoutAlign`, `layoutGrow` | **no** | **no** | Per-child grow/stretch inside auto-layout. Declared in the payload but not mapped. |
| `layoutGrids` | **no** | **no** | Design-time guides; no broadcast meaning. |

## Styles, components, variables

| Field | REST | Plugin | Notes |
| --- | --- | --- | --- |
| `styles` (shared styles) | yes | yes | Figma's own "layer styles". Node keeps the style *id*, and the DesignIR carries a `sharedStyles` table — so two layers on one style can later change together. A referenced style that is missing from the payload raises `FIGMA_STYLE_NOT_RESOLVED`; the node keeps its resolved values but is no longer linked. |
| `componentId` / main component | yes | yes | Plugin resolves the name via `getMainComponentAsync`. |
| `componentPropertyDefinitions`, instance overrides | **no** | **no** | Instance-level property overrides are not distinguished from plain values. |
| `boundVariables` | yes | yes | Recorded as property → variable id. |
| Variable *values* | **no** | **no** | Needs `/v1/files/:key/variables/local`, which is Enterprise-only. Only the reference is stored. |

## The honest summary

Layer styling is now largely covered on both paths. The gaps that can still visibly change
a design, worst first:

1. **`strokeGeometry` is ignored.** A stroke on a complex vector is reconstructed from
   weight and alignment rather than its real outline.
2. **`baselineShift` is always 0.** Superscript and subscript runs drop to the baseline.
3. **Noise and texture effects are unmapped and unwarned** — the only silent gap left.
4. **`leadingTrim`** shifts tight text boxes vertically.
5. **Instance property overrides** are flattened into plain values.

Everything else above either has no broadcast meaning or is reported as a warning at import.

## What is not covered by any of this

Coverage of the *schema* is not the same as coverage of the *pipeline*. As of this audit
nothing consumes a DesignIR: `readDesignFromApi` exists but has no caller, and there is no
DesignIR → scene conversion. An imported design — geometry, text and images alike — does not
appear on the canvas yet. That is the rig layer (phase 3 in
[middle-layer-arch.md](middle-layer-arch.md)), not an importer gap.

Also unverified: no Figma front-end has run against a real Figma file. Everything above is
audited against the schema and tested against fixture payloads, which is not the same as
having imported a designer's actual artwork.
