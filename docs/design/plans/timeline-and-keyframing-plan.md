# Timeline and keyframing plan (design proposal, 24 Nov 2026)

Status: proposal; the owner decides what enters the build plan. Names are working titles.

## Decisions (user)
- The Timeline is the main and only motion screen. There are no template animations (no "Slide in", "Wipe reveal" style gallery) and no default phase bands.
- Motion is keyframes. Every animatable property has a keyframe diamond (hollow = not animated, filled = has keyframes; component KeyframeToggle, 76:6058). Phases such as appear, stay and leave are things a designer builds with keyframes and markers, not presets.
- Text character styles, fonts and shape properties are keyframable, as in After Effects (capability, not layout).
- Parent and child, track matte and per-element blending are on each element. Blending keeps every mode EffectCraft already has (38).

## What the screens show (Figma)
| Screen | Node | Content |
|---|---|---|
| B3 Timeline | 67:4965 | Elements with Parent, Blend and Matte columns; property rows with keyframe diamonds and keyframe shapes (diamond linear, circle ease, square hold); toolbar with Add keyframe (K), Linear, Ease (F9), Ease in, Ease out, Hold, Snap, Markers, Auto-key; playhead; blend list open |
| B3c Graph | 71:5135 | Value and speed graph, curves with handles, ease presets (Linear, Ease, Ease in, Ease out, Back, Bounce, Elastic, Hold), influence and speed numbers, apply, copy and paste ease |
| B3d Properties | 73:5216 | Character (font, style, size, tracking, leading, kerning, baseline shift, case, language), fill and stroke, paragraph and fit, text animator by character, shape (fill, stroke, corner radius, trim paths, dash), element switches; a keyframe diamond on each |
| B2 | 34:218 | Bottom strip is a collapsed Timeline with Open Timeline; the Motion card shows Animated and Keyframes, no styles |

## Ease of keyframing (why the earlier version was hard to use)
- A keyframe is one click away: keyframe diamond on a property, or K at the playhead, or Auto-key.
- Ease is a button and a key (F9), not a curve you must draw first. The Graph is for fine-tuning.
- Rows are grouped per element, with the animated properties visible by default; everything else is collapsed.
- The Style card and the Timeline show the same keyframe diamonds, so you can start animating from either.

## Blend modes (kept from EffectCraft, 38)
Normal, Dissolve, Dancing Dissolve; Darken, Multiply, Color Burn, Classic Color Burn, Linear Burn, Darker Color; Add, Lighten, Screen, Color Dodge, Classic Color Dodge, Linear Dodge, Lighter Color; Overlay, Soft Light, Hard Light, Linear Light, Vivid Light, Pin Light, Hard Mix; Difference, Classic Difference, Exclusion, Subtract, Divide; Hue, Saturation, Color, Luminosity; Stencil Alpha, Stencil Luma, Silhouette Alpha, Silhouette Luma, Alpha Add, Luminescent Premul. Source: `agent/tmp/effectcraft-src/crates/color/src/blend.rs`.

## Open items
1. Track matte types: the screens show None and Alpha. Inverted alpha and luma mattes are expected; confirm what EffectCraft exposes before listing them.
2. Spatial path editing (position path handles on the stage) is not drawn yet.
3. How phase-like behaviour (a hold until Continue, a loop, an event-driven change) is expressed with markers and scripts is not decided here. B12 Logic still talks about phases and needs a pass.
4. Speed graph is a tab only; not drawn.
