# Look section: property inventory and tiering (text, shape, image)

Date: 2026-11-24. Method: web research only (WebSearch/WebFetch). No product layout copied; this is a property inventory plus reasons.

## 0. Evidence quality (read first)

Several vendor pages blocked automated fetch (HTTP 403) or did not list properties. Where a claim has no fetched citation it is marked UNVERIFIED and rests on general knowledge. Do not treat UNVERIFIED rows as research findings.

| Source | Result |
|---|---|
| Ross XPression text object | UNVERIFIED. The only Ross page found (https://www.rossvideo.com/resources/ross-university/change-fonts-and-text-objects/) says text can be created and formatted and fonts created, but lists no properties. Property list must come from the XPression manual or a hands-on pass in the app. |
| Vizrt Viz Engine Text Editor | Fetched: https://docs.vizrt.com/viz-artist-guide/5.4/Viz_Engine_Text_Editor.html |
| Vizrt classic Text Parameters (kerning, tracking, leading) | Search snippet only: https://docs.vizrt.com/viz-artist-guide/3.13/Text_Parameters.html |
| Singular.live Text widget | Search snippet only (page returned 403): https://support.singular.live/hc/en-us/articles/360025486472-Text-Widget . Snippet: Minimum/Maximum of Lines; overflow options Clip, Ellipsis, Word Wrap, Letter Size, Letter Width (garbled; UNVERIFIED in detail). Any property may be bound to a Control or Data node. |
| CasparCG HTML templates | No property list exists (templates are free HTML/CSS). Only issue threads found: https://www.github.com/CasparCG/help/issues/44 (animated text shaking on playout) and https://www.github.com/CasparCG/help/issues/51 (viewport-unit font sizing). |
| After Effects Character/Paragraph panels | Adobe pages returned 403. Search only confirmed tracking vs kerning distinction: https://helpx.adobe.com/en/after-effects/using/formatting-characters-character-panel.html . Remaining AE items below are UNVERIFIED (general knowledge). |
| Figma text properties | Fetched: https://help.figma.com/hc/en-us/articles/360039956634-Explore-text-properties |
| CSS | Fetched MDN pages cited inline. |

## 1. TEXT parts

Tier key: P1 always visible, P2 under More, P3 search-only. Reason column ties to live broadcast use.

### 1.1 Font

| Property | What it does / range | Exposed by tools | Tier | Reason |
|---|---|---|---|---|
| Font family | Typeface. Viz: chosen from fonts in the connected Graphic Hub, searchable, with favourites (Viz 5.4 page). Figma, CSS: yes. | Viz, Figma, CSS, AE (UNVERIFIED), XPression (UNVERIFIED) | P1 | Brand identity; the first thing an operator checks. |
| Style / weight | Regular, Bold, etc. CSS `font-weight` 1-1000 (variable range, e.g. 300-900 per https://developer.mozilla.org/en-US/docs/Web/CSS/font-variation-settings). | Viz (Font Style), Figma, CSS | P1 (merged with family as one picker) | Scoreboard bold vs name regular. |
| Size | Units: px/pt/em. Viz: relative to font 1 EM. | All | P1 | Core. |
| Variable axes (wght, wdth, slnt, ital, opsz, custom) | Continuous axes; Viz shows font-specific extra settings for variable fonts; Figma lists weight, width, optical size, slant plus author axes. CSS: https://developer.mozilla.org/en-US/docs/Web/CSS/font-variation-settings | Viz, Figma, CSS | P2 (weight and width), P3 (custom axes) | A width axis is a cheap fix for long names; but only if the font ships it. |
| Fallback font stack | Ordered list used for glyphs the primary font lacks (CSS font-family list). | CSS yes; Viz exposes a "Characters" glyph browser to find unmapped symbols (Viz 5.4). Others UNVERIFIED. | P2 (project-level default plus per-part override) | Non-Latin names in a Latin display font. See section 4. |
| Missing-glyph behaviour | What shows when no font has the glyph: box (tofu) vs visible warning. One tool doc states a missing character is drawn as a box with no Latin fallback: https://creatomate.com/llms/text.md | Rare | P3 setting, but a P1 preflight warning in the editor | Must never reach air silently. |
| Faux bold / italic (font synthesis) | Browser fakes missing bold/italic. MDN warns synthesis for CJK and similar can hurt legibility or meaning: https://developer.mozilla.org/en-US/docs/Web/CSS/font-synthesis . Viz has "Font Effects" for fonts lacking bold/italic. | CSS, Viz | P3 | Off by default for Indic and CJK. |
| Font size adjust (match x-height across fallback) | `font-size-adjust` counters fallback fonts looking larger or smaller: https://www.w3.org/TR/css-fonts-5 (via search result) | CSS | P3 | Mixed-script lines look balanced. |

### 1.2 Colour and effects

| Property | What it does / range | Exposed | Tier | Reason |
|---|---|---|---|---|
| Fill colour (with alpha) | Solid colour, 0-100% alpha. Viz: colour and alpha; multiplies with material base colour (Viz 5.4). | All | P1 | Core. |
| Opacity (whole part) | 0-100% | All | P2 (usually animated rather than set) | Animation owns it on air. |
| Gradient fill | Linear/radial stops | Figma, AE (UNVERIFIED); broadcast tools vary (UNVERIFIED) | P2 | Esports styling. |
| Stroke / outline | Width px, position (inside/centre/outside), colour, join | Figma, AE (UNVERIFIED) | P2 | Readability over busy video. |
| Drop shadow | Offset x/y, blur, spread, colour | Common (UNVERIFIED per tool) | P2 | Legibility over video. |
| Glow | Blur + colour, no offset | Common (UNVERIFIED per tool) | P3 | Style only. |
| Underline / strikethrough | Figma: style solid/dotted/wavy, thickness, offset, skip ink, colour (Figma page). Viz: skip mode, continuation, base position, offset, thickness (Viz 5.4). | Figma, Viz | P3 | Rare on air. |
| Sub/superscript | Viz Effects: subscript, superscript, underline (Viz 5.4). | Viz, Figma (UNVERIFIED) | P3 | Ordinals, units. |
| Extrusion (3D text) | Depth, size, shading angle (Viz geometry method). | Viz | P3 (out of scope until 3D) | Viz-only feature. |

### 1.3 Spacing

| Property | What it does / range | Exposed | Tier | Reason |
|---|---|---|---|---|
| Letter spacing (tracking) | Uniform extra space, % of em or units. Viz: "Letter Spacing" as percent/units/absolute. Figma: yes. AE: tracking is applied evenly over a range (Adobe snippet). | Viz, Figma, AE | P2 | Tight tracking is a manual fit lever. |
| Kerning (pair) | Per-pair adjustment; Viz has per-cursor kerning and a "Use Kerning" toggle (3.13 Text Parameters snippet). CSS `font-kerning`. | Viz, AE, CSS | P3 (on by default) | Rarely hand-set. |
| Line height | Percent, em or absolute; Viz adds the values; Figma pixel or % of size, default Auto. | Viz, Figma, CSS | P2 | Multi-line plates; Indic scripts need more (section 1.7). |
| Paragraph spacing | px between paragraphs (Figma). | Figma | P3 | Broadcast text is mostly single paragraph. |
| Word spacing | Extra space per space char. CSS `word-spacing`. Viz mentions word spacing in newer guides (search snippet). | CSS, Viz | P3 | Justified text only. |
| Baseline shift | Raise/lower selection (AE: UNVERIFIED). | AE | P3 | Rare. |
| Vertical trim (cap height to baseline) | Removes extra space above and below text; Figma "vertical trim" (Figma page). | Figma | P2 | Makes plate padding even for Latin-only designs. Careful with Indic (clips marks). |

### 1.4 Alignment and box

| Property | What it does | Exposed | Tier | Reason |
|---|---|---|---|---|
| Horizontal align | Left, centre, right (Viz), justify (Viz classic needs "Justify to fill text box"). | All | P1 | Core. |
| Vertical align | Top, middle, bottom, baseline (Viz). Figma: only applies to fixed-size boxes. | Viz, Figma | P2 | Plates with fixed height. |
| Text box vs point text | Viz: the text box size sets the wrap width and alignment boundary; at zero size with wrapping off, alignment follows the container position. Figma: auto width, auto height, fixed. | Viz, Figma | P1 as a single "Box: Auto width / Auto height / Fixed" choice | Decides whether a long name grows or is constrained. |
| Anchor / pivot | Which point stays fixed when text grows (left edge vs centre). Viz: container position is the anchor when box is zero. | Viz; others UNVERIFIED | P2 (follows align by default) | Right-aligned scores must grow leftwards. |
| Direction (LTR/RTL) | Viz Script Direction: LTR or RTL primary direction, horizontal only, "doesn't reverse mismatched text". CSS `direction` and `unicode-bidi` (isolate, plaintext): https://developer.mozilla.org/en-US/docs/Web/CSS/unicode-bidi | Viz, CSS | P2: Auto (detect) with manual override | Arabic or Urdu names inside Latin lines. Prefer isolate per data field so punctuation does not reorder. |
| Orientation (vertical text) | Viz horizontal or vertical, plus column order and width. | Viz | P3 | CJK vertical; rare for Indian esports. |
| Tab handling | Viz: tab stop, space, glyph. | Viz | P3 | Rare. |

### 1.5 Fitting and overflow

This is the group that most prevents on-air failures.

| Property | What it does / range | Exposed | Tier | Reason |
|---|---|---|---|---|
| Fit mode: Fixed / Shrink to fit / Wrap | Viz "Automatic Font Size" scales text to fit the box with optional min and max sizes (Viz 5.4); CSS `text-fit` shrink/grow with percentage limits, but experimental and limited support: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/text-fit ; Viz classic "Scaled to fill text box". | Viz, CSS (experimental) | P1 | Variable-length names must fit the plate. |
| Min and max font size (shrink limits) | Floor so text never becomes unreadable. A design-tool doc advises a minimum so long text does not shrink to unreadable sizes (https://creatomate.com/llms/text.md). | Viz | P1 (appears when Shrink is chosen) | Prevents 8 px names. |
| Wrap mode | Viz: no wrap, wrap by space, wrap by word (languages without spaces), wrap any (Viz 5.4). CSS `text-wrap` balance/pretty/nowrap: https://developer.mozilla.org/en-US/docs/Web/CSS/text-wrap . Figma wrap styles Auto, Balance, Pretty. | Viz, Figma, CSS | P2 | Two-line names balanced, not 1 word on second line. |
| Max lines | Singular Minimum/Maximum of Lines (snippet); Figma max lines requires truncate on and auto height. | Singular, Figma | P2 | Caps plate height. |
| Truncate / ellipsis | Figma truncate adds an ellipsis; Singular overflow Clip and Ellipsis (snippet). | Figma, Singular | P2 | Fallback when min size reached. A name ending "..." on air is bad, so make it a last resort. |
| Scale-to-width (condense horizontally) | Singular "Letter Width" overflow (UNVERIFIED reading of garbled snippet); font width axis; AE horizontal scale (UNVERIFIED). | Singular (UNVERIFIED), AE | P2 as an option of Shrink: "condense before reducing size" | Keeps height consistent across names. |
| Auto-grow plate | Background grows with text (Figma auto layout hug; Viz bounding box options Typographic, Geometric, Text Box, Viz 5.4). | Viz, Figma | P1 as part of plate (see 1.9) | Plate fits the name. |
| Overflow-wrap / word-break / hyphenation | CSS: `overflow-wrap`, `word-break`, `hyphens`. Per MDN-derived notes (general knowledge, not on page): avoid `word-break: break-all` for Indic as it can split clusters; hyphenation is unreliable for Indic. | CSS | P3 | Defaults must be safe, not exposed. |

### 1.6 Case and transform

| Property | What it does | Exposed | Tier | Reason |
|---|---|---|---|---|
| Case: as typed / UPPER / lower / Title / small caps | Figma letter case: uppercase, lowercase, capitalize, small caps; non-destructive (Figma page). CSS `text-transform`, `font-variant-caps`. | Figma, CSS | P2 | Style rule per template; data stays untouched. Note: Indic and Arabic have no case, so it must be a no-op there, not an error. |
| Locale-aware casing | Turkish i, Greek. | CSS `lang` | P3 | Only matters if feeds include those. |

### 1.7 OpenType features

| Feature | Tag | Why | Tier |
|---|---|---|---|
| Tabular figures | `tnum` / `font-variant-numeric: tabular-nums`: all figures same width so they align in columns (https://developer.mozilla.org/en-US/docs/Web/CSS/font-variant-numeric) | Digit jitter on scores and clocks | P1 for number fields (see 1.8); P2 for generic text |
| Proportional / lining / oldstyle figures | `pnum`, `lnum`, `onum` | Style | P3 |
| Slashed zero | `zero` | Disambiguation for IDs | P3 |
| Ligatures | `liga`; page says on by default, disable with `"liga" 0` (https://developer.mozilla.org/en-US/docs/Web/CSS/font-feature-settings) | "fi" ligature in names is fine; disable for tracked-out caps | P3 toggle |
| Small caps | `smcp`, `c2sc`; MDN prefers `font-variant-caps` | Style | P3 (under Case) |
| Stylistic sets / swashes | `ssNN`, `swsh` | Brand fonts | P3 free-text feature list |
| Fractions, ordinals | `frac`, `ordn` | Rare | P3 |
| Kerning, locale forms | `kern`, `locl` | Needed for correct Indic and CJK shaping; on by default | Not exposed; keep always on |
| Generic feature string | `font-feature-settings` raw tags | Escape hatch | P3 |

MDN advises using the `font-variant-*` longhands where they exist because they are more predictable; `font-feature-settings` is the low-level path.

### 1.8 Number, date and time formatting (data-bound fields)

Not found as a standard property list in any fetched source; the following is a design inventory, UNVERIFIED against tools.

| Property | Range | Tier | Reason |
|---|---|---|---|
| Number format: decimals, thousands separator, sign, prefix/suffix | 0-3 decimals; locale grouping | P1 for numeric fields | Scores, points, damage. |
| Indian digit grouping (1,00,000) and numerals (Devanagari digits) | Locale option | P2 | Indian audience; must be a choice, not hard-coded. |
| Tabular figures forced on | see 1.7 | P1 (default on for numeric fields) | Prevents jitter. |
| Zero padding / fixed width | e.g. 05 | P2 | Clocks. |
| Date and time pattern | e.g. HH:mm:ss, dd MMM; timezone | P2 | Match start times. |
| Countdown or count-up display | mm:ss | P2 | Timers. |
| Fallback when value missing | Text shown for empty/null: "-" or blank | P1 for data-bound fields | Empty feed field must not show "undefined". |

### 1.9 Plate / background

Treated as part of the text part's Look in many broadcast tools (UNVERIFIED); in GrapiX it may be a separate shape part. Properties either way:

| Property | Range | Tier | Reason |
|---|---|---|---|
| Plate fill | Colour/gradient/image | P1 | Name plate is the visible object. |
| Padding (top/right/bottom/left) | px | P1 (one linked value) | Plate hugs text with consistent margin. |
| Corner radius | px or per corner | P2 | Style. |
| Plate stroke | width, colour | P2 | Style. |
| Plate min width / max width | px | P2 | Name plates with a minimum size, capped by layout. |
| Grow direction | left/right/centre | P2 | Pairs with anchor. |

### 1.10 Language and script handling (Indian esports)

Requirements derived from fetched sources plus general knowledge; no Indian-broadcaster source was found.

| Concern | What is needed | Evidence | Tier |
|---|---|---|---|
| Shaping (Devanagari, Tamil, Telugu conjuncts, Arabic joining) | Use a shaping engine (HarfBuzz class); `kern`, `locl` always on. Plain glyph-by-glyph text drawing breaks conjuncts. | General knowledge, UNVERIFIED by fetched page | Engine requirement, not a property |
| Vertical metrics and clipping | Tall Indic and Arabic marks exceed typo ascender/descender; apps that clip to those metrics cut glyphs. Fix: use Win metrics or add extra ascent/descent. | https://www.libreoffice.org/bugzilla/show_bug.cgi?id=119608 , https://typedrawers.com/discussion/comment/59559 , https://bugzilla.mozilla.org/show_bug.cgi?id=1150394 (all via search snippets) | P2 "Line padding / ascent extra" plus never clip to line box by default |
| Script-specific font | A Devanagari run needs a Devanagari font; mixed-script names need fallback stack | CSS font-family fallback (section 1.1) | P2 |
| Language tag | `lang` informs locale forms and line breaking; CSS notes dictionary breaking for Thai, Lao, Khmer, Myanmar needs correct lang (MDN-derived, general knowledge) | https://developer.mozilla.org/en-US/docs/Web/CSS/line-break | P3 (auto from data, override available) |
| Line breaking | Indic uses spaces; keep `word-break: normal`; avoid break-all. CJK: `line-break` auto/loose/normal/strict/anywhere (page) and `word-break: keep-all` for Korean. | https://developer.mozilla.org/en-US/docs/Web/CSS/line-break | P3 (safe defaults) |
| Faux styles off for non-Latin | Synthesis can alter legibility or meaning | https://developer.mozilla.org/en-US/docs/Web/CSS/font-synthesis | Default off for non-Latin |
| Bidi | Isolate unknown-direction data in a field; `plaintext` for user content | https://developer.mozilla.org/en-US/docs/Web/CSS/unicode-bidi | P2 direction control (1.4) |
| Case, letter-spacing | Tracking on connected scripts (Arabic) breaks joins; uppercase no-op | General knowledge, UNVERIFIED | Disable tracking for connected scripts or warn |
| Numerals | Latin vs Devanagari vs Arabic-Indic digits | General knowledge, UNVERIFIED | P2 (1.8) |

## 2. What goes wrong on air (text)

Cases are drawn from fetched sources where cited; others are standard failure modes (UNVERIFIED as incident reports).

| Failure | Cause | Property that prevents it |
|---|---|---|
| Name overflows plate or hits neighbouring element | Fixed size with long data | Fit mode Shrink with min/max, scale-to-width, max lines, auto-grow plate |
| Text shrinks to unreadable size | Shrink without floor (creatomate doc advises a min size) | Min font size, then truncate as last resort |
| Ellipsis cuts a player name | Truncate used as primary overflow | Prefer shrink/condense first; show a preflight warning when truncation is active |
| Missing glyph shows as box (tofu) | Font lacks character; one doc states no Latin fallback is applied (https://creatomate.com/llms/text.md) | Fallback font stack, glyph coverage preflight, Characters-style glyph check (Viz has one) |
| Wrong fallback font looks bigger or smaller | Fallback has different proportions (https://www.w3.org/TR/css-fonts-5 via search) | Font size adjust, explicit per-script font |
| Faux bold smears non-Latin glyphs | Synthesis | Font synthesis off for non-Latin |
| Digits jitter on live score or clock | Proportional figures change width each tick | Tabular figures on all numeric fields, fixed-width zero padding |
| Tall marks clipped (Devanagari, Tamil, Telugu, Arabic) | Clipping to typo metrics (LibreOffice bug links above) | Extra ascent/descent padding, do not clip to line box |
| RTL name scrambles punctuation or neighbours | Bidi algorithm mixing directions | Direction auto plus isolate per field |
| Conjuncts broken | No shaping | Shaping engine (engine requirement) |
| Uppercase transform garbles non-Latin or Turkish | Case applied blindly | Case is no-op for caseless scripts; locale-aware casing |
| Text shakes during animation | Subpixel positioning and non-integer transforms; seen in a CasparCG HTML template report (https://www.github.com/CasparCG/help/issues/44, cause not stated) | Pixel snapping option for text position (P3), tested at playout rate |
| Text size changes between machines | Viewport-unit sizing (CasparCG issue 51 uses vh units) | Use canvas-relative absolute sizes, not viewport units |
| Empty feed field shows "undefined" or blank plate | Missing data | Fallback text for empty field, plate hides when empty (option) |
| Wrong font on playout PC | Font not installed on engine | Embedded or packaged fonts; preflight font check |

## 3. SHAPE parts

Sources: general knowledge unless cited; blend modes from https://developer.mozilla.org/en-US/docs/Web/CSS/mix-blend-mode . No broadcast-tool shape property pages were fetched, so "exposed by tools" is UNVERIFIED for this section.

| Property | Range | Tier | Reason |
|---|---|---|---|
| Fill (solid) with alpha | colour, 0-100% | P1 | Core. |
| Gradient fill | linear/radial/angular, stops, angle | P1 (as a fill type) | Esports plates. |
| Stroke (width, colour, position) | 0-100 px; inside/centre/outside | P1 | Outlines. |
| Corner radius | px; per corner; or full pill | P1 | Plates and chips. |
| Opacity | 0-100% | P2 | Usually animated. |
| Drop shadow | x, y, blur, spread, colour | P2 | Depth. |
| Inner shadow | same | P3 | Style. |
| Layer blur | px | P2 | Soft glow plates. |
| Background blur (blur what is behind) | px | P3 | Needs live backdrop; costly on air. |
| Blend mode | normal, multiply, screen, overlay, darken, lighten, color-dodge, color-burn, hard-light, soft-light, difference, exclusion, hue, saturation, color, luminosity; plus-lighter useful for cross-fades (MDN) | P2 (a short list), P3 (full list) | Light-leak and overlay looks. |
| Masks (alpha, luminance, vector) | shape or image as mask, invert | P2 | Wipes and reveals depend on masks. |
| Stroke dash, cap, join | dash length, gap | P3 | Style. |
| Size, position, rotation | not Look; belongs to Layout | n/a | Kept separate. |
| Shape-specific: star points, polygon sides, arrow | integer | P2 under shape type | Per shape. |

## 4. IMAGE parts

Fit modes from https://developer.mozilla.org/en-US/docs/Web/CSS/object-fit : fill (stretches), contain (letterbox), cover (crops to fill), none (no resize), scale-down. `object-position` aligns content in the box (page content truncated, so default 50% 50% is general knowledge). Other rows UNVERIFIED against broadcast tools.

| Property | Range | Tier | Reason |
|---|---|---|---|
| Fit mode: cover / contain / fill / none | 4 to 5 options | P1 | Player photos and logos have varying aspect ratios; wrong choice distorts a face (fill) or leaves gaps. |
| Anchor / focal point | x,y 0-100% (object-position) | P1 | Cover crop must keep the face, not the shoulders. |
| Crop (per edge) | px or % | P2 | Trim built-in borders of supplied art. |
| Placeholder when missing | Image, colour, or hide part | P1 | Missing portrait must not show a broken-image icon. |
| Alpha handling | Straight vs premultiplied; matte colour | P2 | Haloed edges on logos. |
| Tint / colour overlay | colour + amount | P2 | Recolour white logos per team. |
| Opacity | 0-100% | P2 | Animated usually. |
| Corner radius / mask shape (circle avatar) | px or % | P2 | Round player photos. |
| Filters: brightness, contrast, saturation, hue, grayscale, blur | numeric | P3 | Style. |
| Flip horizontal/vertical | boolean | P3 | Mirrored portraits. |
| Stroke and shadow | as shapes | P2 | Frame around photo. |
| Colour space / resampling quality | sRGB vs working space; bilinear vs lanczos | P3 | Project-level rather than per part. |
| Source reference (asset link, or data-bound URL) | binding | P1 as the part's content field, not Look | Feed-driven photos. |
| Load-failure and slow-load behaviour | fallback timing | P3 (engine setting) | Avoid pop-in on air. |

## 5. Proposed tiering

### 5.1 TEXT

P1 (always visible), 6 rows:

| # | Row | Contains | Reason |
|---|---|---|---|
| 1 | Font | Family and style/weight in one picker, with size | Identity and core size. |
| 2 | Colour | Fill colour with alpha | Core. |
| 3 | Align | Horizontal align (left/centre/right) | Core; also sets grow direction by default. |
| 4 | Box and fit | Auto width / Auto height / Fixed, then Shrink to fit with min and max size when Fixed | Variable-length names, the main on-air risk. |
| 5 | Plate | Fill and one linked padding value (if the plate is part of the text part) | The visible name plate must fit its text. |
| 6 | Numbers | Tabular figures, shown only for numeric/data-bound fields | Score digit jitter. |

P2 (under More):

| Row | Reason |
|---|---|
| Stroke, shadow, gradient fill, opacity | Legibility over video and styling. |
| Letter spacing, line height, vertical trim, extra ascent/descent | Fit tuning, Indic and Arabic clipping protection. |
| Vertical align, anchor/pivot, grow direction | Fixed-height plates, right-aligned scores. |
| Wrap mode (balance), max lines, truncate/ellipsis, condense-before-shrink | Overflow control. |
| Case (as typed, upper, lower, title, small caps) | Template style rule. |
| Fallback font stack and per-script font | Non-Latin names. |
| Direction (auto, LTR, RTL) | Arabic or Urdu data. |
| Variable axes (weight, width) | Width axis for long names. |
| Number format, digit set, padding, date and time pattern, empty-value fallback | Data-bound fields (empty fallback arguably P1 for data fields). |
| Plate: corner radius, stroke, min/max width | Style. |

P3 (search-only):

| Row | Reason |
|---|---|
| Kerning toggle, word spacing, baseline shift, paragraph spacing | Rarely changed. |
| Ligatures, stylistic sets, swashes, fractions, slashed zero, raw feature string | Brand-font specifics. |
| Custom variable axes, font size adjust, font synthesis | Expert control; safe defaults. |
| Glow, underline/strikethrough, sub/superscript, vertical orientation, tab handling, extrusion | Rare on air. |
| Language tag, line-break and word-break rules, hyphenation | Auto from data; safe defaults. |
| Pixel snapping of text, missing-glyph behaviour | Engine behaviour; preflight surfaces issues instead. |

Always-on safety (not properties): shaping engine, kern and locl on, missing-glyph preflight warning, no clipping to the line box.

### 5.2 SHAPE

| Tier | Rows |
|---|---|
| P1 | Fill (solid or gradient), stroke, corner radius |
| P2 | Opacity, drop shadow, layer blur, blend mode (short list), mask, type-specific parameters |
| P3 | Inner shadow, background blur, dash/cap/join, full blend list |

### 5.3 IMAGE

| Tier | Rows |
|---|---|
| P1 | Fit mode, anchor/focal point, placeholder when missing |
| P2 | Crop, alpha handling, tint, opacity, corner radius or mask shape, stroke and shadow |
| P3 | Filters (brightness, contrast, saturation, hue, grayscale, blur), flip, resampling and colour-space, load-failure behaviour |

## 6. Open items needing hands-on or manual checks

1. XPression text object property list (UNVERIFIED): open a text object in XPression Designer and record the property sheet; compare with sections 1.1-1.9.
2. Singular.live Text widget full list: the page blocked automated fetch; open it in a browser.
3. After Effects Character/Paragraph panel list: open https://helpx.adobe.com/en/after-effects/using/formatting-characters-character-panel.html in a browser.
4. Viz classic Text Parameters (kerning, tracking, leading): https://docs.vizrt.com/viz-artist-guide/3.13/Text_Parameters.html was seen only as a snippet.
5. Test Devanagari, Tamil and Telugu conjunct shaping and clipping on the actual render path with the esports fonts chosen; the clipping evidence is from LibreOffice, Mozilla and font-forum threads, not from broadcast engines.
6. Confirm `text-fit` is not relied on: MDN marks it experimental with limited availability, so GrapiX should implement its own fit.
