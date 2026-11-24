# Charts and widgets research (24 Nov 2026)

Scope: capability model and reasons, not layouts. Every claim carries a URL. UNVERIFIED = not confirmed from a fetched page. Nothing downloaded or installed.

## 1. Viz Artist (Vizrt)

### 1.1 Plugin model

| Item | Finding | Source |
|---|---|---|
| Categories | Plugins panel lists Geometry, Container, Classic Shader, Viz Engine Shader, Scene, Media Asset | https://documentation.vizrt.com/viz-artist-guide/5.0/Plug-ins.html |
| Geometry | A container holds only one Geometry plugin (adding another replaces it) | same |
| Function plugins | Older guides call them "function plug-ins": enhance a container and can affect sibling containers; several per container. Later guides say "Container plug-ins" | https://documentation.vizrt.com/viz-artist-guide/5.1/Working_with_Containers.html |
| Scene plugins | Not draggable; added with "Add to Scene" (3.14: via Scene Settings plugin tab) | https://documentation.vizrt.com/viz-artist-guide/5.0/Plug-ins.html |
| "Plugin pool" | Exact phrase NOT found. The Plug-ins panel lists installed valid plugins; each can be switched on or off, inactive ones are not loaded at startup | https://documentation.vizrt.com/viz-engine-guide/5.0/Plug-ins.html |
| Containers | Scene tree nodes; plugins attach to them; geometry is what draws | https://docs.vizrt.com/viz-artist-guide/5.4/Containers.html |

### 1.2 Built-in chart plugins (Geometry plugins, Built Ins > Geom plug-ins > VisualDataTools)

| Plugin | Capability | Source |
|---|---|---|
| Bar Chart | Data from a Data field or shared memory (Scene, Global, Distributed); Transfer Mode string or array; delimiter; number format (locale or custom decimal) | https://docs.vizrt.com/viz-artist-guide/3.14/Bar_Chart.html |
| Bar Chart scaling | Data Scale, Offset, Auto Scale, Fit Size (Total or Current), detect limits, threshold, start/stop, Draw Zero, Compare (link to a second chart) | same |
| Bar Chart look | Chart Width, Bar Width, Max Width, Bar Gap Ratio, Depth, Corners, Bevel, colour by ID, separate positive and negative colours, Color Override | same |
| Bar Chart animation | Value Animation Disable / Timer (duration) / Director (stage timeline progress 0 to 100%); mode Concurrent, Left to Right, Right to Left; Balance Speed; Const. Speed (equal time per bar); Relative Length (each bar its own 100%); Progress Mode Bars / Chart X / Chart Y; Data Nodes Animation | same |
| Bar Chart labels | Pos. Container places a child container per bar; Data Label plugin with Copy Container clones a label prototype per value | https://docs.vizrt.com/viz-artist-guide/3.14/Advanced_Bar_Chart_Creation.html |
| Pie Chart | Same data sources; Diameter, Total Segment deg, Inner Cutoff (donut), Height, Const. Offset gap, Piece Scaling, Move Piece (explode one slice by index), Pos. Container per slice, colour by texture coordinate or vertex colour | https://docs.vizrt.com/viz-artist-guide/3.14/Pie_Chart.html |
| Pie animation | Timer (old to new over N s) or Director; Concurrent / Left to Right / Right to Left; Balance Speed | same |
| Graph2D | Line, Graph, Bars from a plain text "CHANNEL<n>" file (point count then X/Y pairs); Douglas-Peucker point reduction, Minimum Points, positive/negative colours, Show Frame, Max% to reveal part of the width, Bar Animation (one by one or all) | https://docs.vizrt.com/viz-artist-guide/3.14/Graph2D.html |
| DataGraph (DataPool) | Container plugin that drives a Graph geometry from a DataPool DataField of space separated numbers; Format X, Y or XY; Normalize between Position Min and Max. Animation on update not described | https://docs.vizrt.com/datapool-guide/2.13/DataGraph.html |

No area, gauge or ranking-list plugin was found beyond Graph2D; how Vizrt users build those is UNVERIFIED (likely containers plus script).

### 1.3 Data binding

| Route | What it is | Source |
|---|---|---|
| Shared memory | Named keys in Scene.Map (this scene) or System.Map (all loaded scenes); written by script or over TCP port 6100 as key|value pairs; scripts can register a changed callback | https://docs.vizrt.com/viz-artist-guide/5.3/Data_Sharing.html ; https://documentation.vizrt.com/viz-artist-guide/3.12/Data_Sharing.html |
| Control Parameter | Exposes a script parameter as a named field so Pilot or Trio can edit it | https://docs.vizrt.com/viz-artist-guide/3.14/Advanced_Bar_Chart_Creation.html |
| Viz Pilot data element | A template filled with data; the data element, not the template, plays on air; served by Pilot Data Server over HTTP as VDF | https://documentation.vizrt.com/viz-pilot-guide/8.9/Viz_Pilot_News.html ; https://documentation.vizrt.com/pilot-data-server-guide/8.8/Web_Interface.html |
| DataPool | Named DataFields, structures defined in .dp files loaded at engine start | https://docs.vizrt.com/datapool-guide-2.13.pdf (search snippet only; PDF not read) |
| Viz Datacenter, Viz Chart | Not found in docs. UNVERIFIED | none |
| Viz Script | Only Scene.Map callbacks confirmed. Full API UNVERIFIED | https://docs.vizrt.com/viz-artist-guide/5.3/Data_Sharing.html |

Lessons: (a) one chart element with one data field, not N hand-wired objects; (b) the Viz guide says Pilot and Trio cannot set bar colours directly, so a script was needed. GrapiX should expose colour as data; (c) labels are cloned per datum, so row count changes object count: GrapiX needs a repeater.

### 1.4 What editors see
The plugin's parameter panel for designers; only the exposed control fields for operators (https://docs.vizrt.com/viz-artist-guide/3.14/Advanced_Bar_Chart_Creation.html). Reason to copy: designer parameters and operator fields are two surfaces.

## 2. Other broadcast tools (brief)

| Tool | Finding | Source |
|---|---|---|
| Singular.live | Area, Bar, Candlestick, Column, Line, Pie as Google Chart widgets; data from Google Sheets (ID plus A1 range) with a request frequency; also API and Data Streams. Pie is an "advanced widget" needing sub-compositions | https://support.singular.live/hc/en-us/articles/360049270592-Google-Chart-Widgets |
| Singular update animation | In/Out animation fires every time a control or data node changes; chart behaviour not documented | https://developer.singular.live/singular-basics/building-overlays-in-composer/animating-overlays/how-to-create-update-animations |
| Singular progress and circle | Progress Bar and Circle widgets exist | https://support.singular.live/hc/en-us/articles/360025783951-Progress-Bar-Widget |
| Chyron PRIME | Native data table with CSV import (4.7), message ranges: one parent template recalled per row (4.8), Duplicate Effect for leaderboards (4.9). No built-in chart found | https://www.sportsvideo.org/2023/04/13/chyrons-prime-4-7-simplifies-and-accelerates-graphics-design-data-binding-and-playout-for-live-sports-production/ ; https://www.sportsvideo.org/2024/02/07/chyron-prime-4-9-enhances-the-operator-experience-streamlines-real-time-data-management-for-sports-users/ |
| Chyron Lyric | LyricX runs on PRIME. Chart features UNVERIFIED | https://chyron.com/products/cg-graphics-platforms/lyricx |
| CasparCG | HTML producer calls global play/next/stop/update; stop only calls your function and does not remove the template; the chart (for example Chart.js) is the author's job | https://casparcg.com/docs/wiki/media/html-templates ; https://chrisryanouellette.gitbook.io/casparcg-html-template-guide/javascript/handling-updates |
| Ross XPression | Search returned nothing on charts or data-linked charts. UNVERIFIED. Use docs/evidence/xpression-benchmark/ | none |

Common kinds across tools: bar, column, line, area, pie (donut), progress/gauge, table or ranking rows. Common properties: scale min/max, labels, colours, value format, animate in, animate on update.

## 3. Chart.js and GrapiX

### 3.1 Chart.js facts
| Fact | Source |
|---|---|
| MIT licence (older docs page; confirm latest LICENSE.md before use) | https://chartjs.org/docs/2.8.0/notes/license.html |
| Needs a `<canvas>` node plus the script | https://www.chartjs.org/docs/latest/getting-started/usage |
| Animation: duration 1000 ms default, easing easeOutQuart, delay, loop, onProgress, onComplete; transition modes active/hide/reset/resize/show; `animation:false` disables | https://www.chartjs.org/docs/latest/configuration/animations.html |
| Types: area, bar, bubble, doughnut and pie, line, mixed, polar area, radar, scatter | https://www.chartjs.org/docs/latest/charts/bar.html |
| Bar options: indexAxis x/y (horizontal), stacked scales, borderRadius, barPercentage, categoryPercentage, maxBarThickness, minBarLength, skipNull | same |
| requestAnimationFrame and wall clock use | Not stated in fetched docs. UNVERIFIED. Expect browser timing; confirm in source |

### 3.2 GrapiX constraints (read from the repo)
| Constraint | Where |
|---|---|
| Per-scene JS on rquickjs: no Date.now, performance.now, timers, fetch, sockets; time from engine frame number and rational rate only; data only through bindings; banned API refused by name | Build Plan rows 16.4 and 11.55 |
| Scene scripts have no wall-clock or network access (invariant 62; same frame must not render two ways, invariant 8) | docs/invariants.md line 205 |
| Counters and timers derive from frame count, zero drift | Build Plan row 11.56 |
| rquickjs adopted; lyon and Vello measured for GPU 2D drawing in 3.17 | docs/adr/0001-distributed-architecture.md lines 472 to 481; docs/adr/0003-effectcraft-render-core.md lines 131, 245 |
| GPU-first compositor; vectors, text, images, meshes composite in SceneDocument order | docs/adr/0003-effectcraft-render-core.md lines 47, 73 |
| Missing glyph is a refusal, not a font swap (invariant 66) | docs/invariants.md line 221 |

### 3.3 Verdict
| Question | Answer | Reason |
|---|---|---|
| Use Chart.js as is? | No | It needs a DOM canvas and (UNVERIFIED) browser timing; the sandbox has no DOM, canvas or clock. Its pixels would also bypass SceneDocument order and glyph rules |
| Embed a browser to run it? | No | Breaks invariants 8 and 62 and ADR-0001 "no V8 in Program" |
| Right approach | Native chart elements. The engine draws GPU vector shapes (rects, arcs, paths, text) from data fields. Layout (bar lengths, arc angles, ticks, label slots) is a pure function of (data, parameters, frame) | Deterministic and fixture-testable |
| Where JS fits | Optional: a script may sort data or compute custom layout, using only frame number and bindings. Core kinds need no script | Scripts are a bounded extension |
| Reuse maths | Port small d3-scale and d3-shape ideas into Rust (linear and band scales, nice ticks, arc, line, area, curves). d3-scale is ISC (https://github.com/d3/d3-scale). d3-shape licence UNVERIFIED (expected ISC). Chart.js is a feature checklist only | Small pure code; no download is proposed. Any package download needs user approval |
| Drawing back end | Reuse what 3.17 selects (lyon or Vello); charts only emit shape lists | No second renderer |

## 4. Proposed capability list for GrapiX chart elements

### 4.1 Kinds
| Kind | Reason (live esports and sports) |
|---|---|
| Bar vertical and horizontal | Team stats, damage dealt |
| Stacked and grouped bar | Kills by weapon; team A vs team B per metric |
| Pie and donut (inner cutoff, as Viz Pie) | Map pick share, possession; donut centre can hold a total |
| Line and area | Gold lead or match score over time |
| Scoreboard bars | Short score bars beside a team name |
| Ranking list (sortable rows, rank change) | Standings, kill leaderboard; mirrors PRIME ranges and Viz Copy Container |
| Gauge or radial progress | Ultimate charge, win probability |
| Sparkline (later) | Trend inside a ranking row |

### 4.2 Data binding
| Item | Spec | Reason |
|---|---|---|
| Single value | number plus label | Scoreboard bar |
| Array field | list of {label, value, colour, icon} | One field per chart (Viz lesson) |
| Rows from a data source | table or feed rows through bindings, esports feed 19.10 | Data reaches the engine only as control-plane intent |
| Series | named series sharing x labels | Line over time |
| Column mapping | field path to label, value, colour, image | Providers differ |
| Operator surface | the data field and few switches; design params stay in the Style card | Viz and Singular split surfaces |

### 4.3 Style card parameters
| Group | Parameters | Reason |
|---|---|---|
| Scale | min, max, auto or fixed, zero baseline, relative length per bar | Fixed max stops bars jumping on update; auto for unknown feeds |
| Axes | show, tick count, gridlines, axis label, reverse | Many broadcast bars have no axes |
| Geometry | bar thickness, gap ratio, corner radius, max bar width, donut inner radius, start angle, slice gap | Brand shapes |
| Colour | per datum, positive and negative, team colour binding, ramp, gradient | Team colours from data |
| Labels | position, font, size, truncation rule, show rank, value, icon | Long team names |
| Value format | decimals, thousands separator, percent, unit suffix, locale decimal symbol | Viz exposes locale or custom decimal; 1.5 vs 1,5 |
| Sorting | none, value ascending or descending, label, data order | Leaderboards |
| Limits | max items, "others" bucket, min slice size | Keeps the screen readable |
| Fit | clip to frame, auto scale to box | Safe area |

### 4.4 Animation (frame-number driven, never wall clock)
| Phase | Options | Reason |
|---|---|---|
| Appears | grow from zero; concurrent, left to right, right to left; stagger frames; easing; duration in frames; arc sweep | Viz offers the same three modes |
| Changes on update | tween old to new over N frames; rows reorder with motion; new rows enter, removed leave; snap option | Singular fires an update animation per data change |
| Rapid updates | latest data wins; tween restarts from the drawn value; no stacking | Feeds can beat the tween length |
| Leaves | reverse of appear, or fade | Clean take out |
| Timeline link | tween progress bindable to a timeline value (Viz Director mode) | Designer keyframes the whole chart |
| Constant speed | equal time per bar, or equal speed per unit | Viz Const. Speed |

Every parameter above is animatable, per the product direction.

### 4.5 Limits and edge cases (test records)
| Case | Expected behaviour |
|---|---|
| Empty data | Draw nothing or placeholder per switch; no NaN |
| One item | Full bar or full circle; no divide by zero |
| All zero | Empty ring, zero-length bars; auto scale falls back to 1 |
| Negative values | Bars below baseline in negative colour; pie refuses negatives by name |
| Mixed sign stacks | Positive stacks up, negative down |
| Null vs 0 | Null skipped, 0 drawn |
| Huge values, ties | Separators; stable order for ties |
| Over max items | "Others" bucket or refusal per switch |
| Long labels | Shrink to a minimum, then ellipsis, no overlap |
| Non-Latin text (Arabic, Devanagari, CJK) | Shaped text path; missing glyph is a refusal (invariant 66) |
| Right to left | Option to mirror bar direction and label side |
| Duplicate labels | Keyed by row id, not label |
| 10 updates per second | Tween restarts; identical frames on two runs |
| Rank swap mid tween | Rows cross smoothly |
| NaN or wrong type from feed | Row refused by name; previous value kept |
| Determinism | Same data and frame gives identical pixels (invariant 8) |
| Colour depth | Follows project working space and 8/16/32 bit |

Test records: 6 team kill table; 12 row standings with ties; 60 point score line with negative lead; 1 row chart; empty chart; long Arabic and Hindi team names; 40 rows over the max.

### 4.6 Where it sits
| Option | Verdict | Reason |
|---|---|---|
| Effects area | Not for the chart itself | Effects transform a layer's pixels; a chart creates content from data. Viz also files charts as geometry, not as effects (https://docs.vizrt.com/viz-artist-guide/3.14/Bar_Chart.html) |
| Elements | Primary home | Drawn in SceneDocument order, bindable, animatable |
| Library | Yes, as presets (styled ranking list, scoreboard bar) over the same elements | Fast for operators; hashed like other assets |
| Widgets shelf | Group with clock, countdown, counter (row 11.56) | Same rules: frame-derived, data-bound |
| "Like Viz Artist" | Viz lists charts in a searchable plugin panel and edits them in the container's parameters. Closest GrapiX fit: a Widgets/Elements picker plus a Style card. Whether to add an Effects menu shortcut is the owner's UI choice | Owner decision |

### 4.7 Suggested plan rows (not added to the plan)
1. Chart layout core in Shared/: pure function of (data, params, frame) returning a shape list; fixtures per kind.
2. Elements: bar and ranking list first, then pie and donut, line and area, gauge.
3. Repeater element for rows, shared with ranking lists.
4. Chart Style card, operator field list, the test records above.
5. Optional d3-style maths port with the licence check recorded.

## 5. Open items
- UNVERIFIED: Viz Datacenter, Viz Chart, full Viz Script API, Ross XPression chart widgets, Chyron Lyric charts.
- Chart.js rAF and wall-clock use: confirm from source. d3-shape licence: confirm.
- This file is in the `.claude/worktrees/vibrant-bassi-6cce4b` worktree because the hook and the task required it; the usual rule is agent/worktree, so move or merge as the owner prefers.
