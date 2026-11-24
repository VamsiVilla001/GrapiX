# Charts and widgets plan (design proposal, 24 Nov 2026)

Status: proposal. Not in `GrapiX-Build-Plan.md` yet. The owner decides whether it becomes plan rows.
Evidence: `docs/design/research/charts-widgets-research.md` (Viz Artist, Singular.live, Chyron PRIME, Chart.js, GrapiX sandbox rules).
Names are working titles (Element, Style, Effects, Phase, Cue, Stack, Airview); they change in one place.

## 1. What is wanted

Charts (bar, pie, donut, line, area, ranking list, gauge) and widgets (clock, countdown, counter, round timer) that a designer drops into a graphic, binds to data, and animates, in the way Viz Artist offers chart plugins in a searchable panel and edits them in a parameter panel.

## 2. Decision

1. **Chart.js is not used.** It needs a canvas and a browser. GrapiX scripts run in the `rquickjs` sandbox with no DOM, no canvas, no wall clock and no network (plan 16.4, 11.55, 11.56; invariants 8, 62, 66). Time comes only from the engine frame number.
2. **Charts are native Elements.** A chart is drawn by the GPU engine as vector shapes. Its layout is a pure function of (data, parameters, frame). The same data and frame give identical pixels on every run.
3. **JavaScript is optional.** A scene script may feed or reshape data through the shared events and actions. It never draws.
4. **Maths is ported, not downloaded.** Scale and shape maths in the style of d3-scale and d3-shape is written in Rust in the project. d3-scale is ISC; d3-shape's licence is unconfirmed. Nothing is downloaded without the user's approval (plan rule), and the licence check is recorded before any port.

## 3. Where it lives in the UI

| Place | What goes there |
|---|---|
| **Elements, Widgets shelf** | Primary home: Bar, Ranking list, Pie, Donut, Line, Area, Gauge, plus Clock, Countdown, Counter, Round timer (row 11.56). Added from the Elements "+" menu and from Ctrl K. |
| **Library** | Styled presets (for example a ranking list in the event style, a scoreboard bar). Presets are hashed like other assets. |
| **Style card** | A "Chart" group for the selected chart: scale, axes, geometry, colour, labels, value format, sorting, limits. |
| **Effects panel** | A shortcut category "Charts and widgets" that opens the same picker, so it can be found where Viz users look for plugins. Charts are not effects (effects change a layer's pixels; a chart creates content), so the shortcut is a finder only. The owner decides whether to add it. |
| **Inputs (Playout)** | Operators see the chart's data field and a few switches. Design parameters stay in the Editor. |

## 4. What a chart can do (summary of the research)

- **Kinds:** bar (vertical, horizontal, stacked, grouped), pie, donut, line, area, scoreboard bar, ranking list with rank change, gauge. Sparkline later.
- **Data:** a single value, an array field of {label, value, colour, icon}, rows from a data source, named series, and a column mapping for different providers. One data field per chart.
- **Style card:** fixed or auto scale, axes, bar thickness and gaps, corner radius, donut inner radius, per-datum and team-colour binding, label rules for long names, value format and locale decimal, sorting, max items with an "others" bucket.
- **Phases:** Appears (grow, concurrent or left to right, stagger in frames), Changes (tween old to new in frames, rows reorder with motion, snap option), Leaves. A rapid update restarts the tween from the drawn value; updates never stack. The tween can also be bound to a timeline value, so the designer keyframes the chart.
- **Edge cases tested:** empty data, one item, all zero, negative values, null versus 0, ties, over max items, long labels, Arabic and Devanagari names, right-to-left, duplicate labels, 10 updates a second, rank swap mid-tween, bad values from a feed (the row is refused by name and the previous value kept), identical pixels on two runs.

## 5. Suggested plan rows (for the owner)

| # | Row | Depends on | Done when |
|---|---|---|---|
| 1 | Chart layout core in Shared: a pure function of data, parameters and frame that returns a shape list, with one fixture per kind | 11.56, 16.4 | Two runs give identical shape lists; a banned input is refused by name |
| 2 | Chart Elements: bar and ranking list first, then pie and donut, line and area, gauge | 1 | Each kind renders on the GPU path in the Editor and the engine |
| 3 | Repeater element for rows, shared with ranking lists | 1 | 40 rows over the max follow the "others" rule |
| 4 | Chart group in the Style card, the operator data field, and the test records | 2, 3 | The 17 edge cases in the research pass in test records |
| 5 | Optional port of scale and shape maths, with the licence check recorded | owner approval | Licence noted; no download without approval |

## 6. Screens to build in Figma and wireframes (not built yet)

- Elements "+" menu with the Widgets shelf open.
- A chart selected on the stage, with the Chart group in the Style card (scale, geometry, colour, labels, value format, sorting, limits).
- Chart data binding: column mapping and the test records table (empty, long names, 40 rows).
- Phases for a chart: Appears, Changes (rank swap), Leaves, with the tween bound to a timeline value.
- Playout Inputs showing a chart's data field.

## 7. Decisions (user, 24 Nov 2026) and open questions

Decided:
1. The Effects panel gets a "Charts and widgets" shortcut category, and the Widgets shelf also lives in Elements (Figma C1 and C4).
2. Bar chart and Ranking list ship first. Pie, donut, line, area and gauge come later.

Still open:
1. Must the first version reorder rows with motion, or is a snap acceptable?
2. Confirm d3-shape's licence and Chart.js's use of the browser clock before any decision that depends on them (unverified in the research).
3. Viz Datacenter, Viz Chart, the Viz Script API, Ross XPression charts and Chyron Lyric charts were not verified.

Figma screens built: C1 Add element (74:5381), C2 Chart selected (74:5700), C3 Chart data (75:5708), C4 Effects shortcut (75:6095).

## 8. Update, 24 Nov 2026: Chart.js option model and plugins
The chart parameters follow the Chart.js option names and every chart or widget is a plugin (manifest, parameter schema, pure layout function). See `plugin-architecture-plan.md`. Figma screens C1 to C5 replace the earlier chart screens.
