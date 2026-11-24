# Plugins and Chart.js-style parameters (design proposal, 24 Nov 2026)

Status: proposal; the owner decides what enters the build plan. Names are working titles.
Related: `charts-and-widgets-plan.md`, `docs/design/research/charts-widgets-research.md`, plan rows 16.4 (script sandbox), 16.16 (effect plug-ins as sandboxed WebAssembly), 11.56 (widgets).

## What was asked
1. Charts should be built "based on Chart.js, so their UI can be controlled".
2. They should be plugins, the way Vizrt has them, with a workaround that can actually be implemented in GrapiX.

## The constraint that shapes the workaround
Chart.js needs a browser canvas. GrapiX scripts run in the `rquickjs` sandbox with no DOM, no canvas, no wall clock and no network, and time comes only from the engine frame number (invariants 8, 62, 66). So the Chart.js code cannot run inside GrapiX. What can be reused is its **option model**: the names and structure of its configuration.

## The workaround: a plugin is a manifest, a parameter schema and a pure layout function

| Part | What it is | Why |
|---|---|---|
| **Manifest** | JSON: id, version, kind (element), runtime, data inputs, parameters file, time budget, permissions (none), content hash | One shape for every plugin, built in or installed |
| **Parameter schema** | A tree of typed options named after Chart.js (`type`, `options.indexAxis`, `scales.x.max`, `datasets[0].barThickness`, `elements.bar.borderRadius`, `options.animation.duration`), each with type, default, range, and whether it can be keyframed | The Style card, the Add element menu, MCP and the Library are all generated from it, so the UI is controlled by the plugin |
| **Layout function** | A pure function (data, parameters, frame) returning a list of shapes; the engine draws them on the GPU path | Deterministic, no clock, no DOM; same data and frame give identical pixels |

### Three implementation tiers (the ladder)
1. **Tier 0, release 1: built-in plugins in Rust.** Bar chart and Ranking list (and the existing clock, countdown, counter and round timer) are registered through the same manifest and schema. This proves the interface and gives a fast, trusted implementation.
2. **Tier 1: JavaScript plugins in the `rquickjs` sandbox.** A designer or third party writes `layout(data, params, frame)` in JavaScript under the rules of 16.4 (CPU and memory bounded, banned APIs refused by name). No Rust needed. Layout helpers in the style of d3-scale and d3-shape live in the sandbox prelude (ported, licence checked, nothing downloaded without approval).
3. **Tier 2, later: WebAssembly plugins** from the Plug-ins folder, as plan row 16.16 already describes, with the same manifest and no capabilities.

### Rules that make it safe on air
- A published package pins each plugin by id, version and hash. Playout renders only a plugin it has, with the same hash; a missing or changed plugin is refused by name, never replaced.
- A plugin cannot read the clock, the network or files, and has a time budget per frame. A plugin that fails keeps its last good output and one line goes to Playout diagnostics.
- All time values in the schema are frames.
- Options that make no sense on air are not in the schema: tooltips, hover, click events, responsive resizing.

### Chart.js compatibility, kept honest
- The schema uses the option names of Chart.js version 4 so its documentation applies. It is not a runtime dependency, and not every Chart.js option exists.
- **Config import (later):** paste a Chart.js config JSON; GrapiX maps the supported keys to plugin parameters and shows a coverage report of what was kept, changed or dropped, in the same way as the Figma import.
- Chart.js names for types are used where they exist: bar, line, pie, doughnut, radar, polarArea. Ranking list and gauge are GrapiX plugins (Chart.js has no gauge).

## How this compares with Viz Artist
| Viz Artist | GrapiX |
|---|---|
| Geometry plugins (Bar Chart, Pie Chart, Graph2D) found in a plugin panel | Plugins in the Add element menu and the Effects panel shortcut, grouped as built in or installed |
| Plugin parameters edited in the container's parameter panel | The Style card, generated from the plugin's schema |
| Data from shared memory or a data field, labels cloned per datum | A data field with a column mapping; rows drawn by the plugin or a repeater |
| Plugins are native binaries | Built in Rust first; sandboxed JavaScript and WebAssembly later, so plugins cannot break Program |

## Figma screens
C1 Add element (plugins grouped), C2 Bar chart selected with Chart.js-named options and keyframe diamonds, C3 Chart data and test records, C4 Effects shortcut, C5 Plugin manager (list, manifest, parameter table, actions). Renders are in `docs/design/wireframes/figma/`.

## Plan rows (added to the plan as pending)
11.149 plugin manifest and registry; 11.150 parameter schema and the generated Style card (Chart.js names); 11.151 Plugin manager panel; 11.152 Chart.js config import with a coverage report; 16.25 JavaScript plugin runtime on the sandbox.

## Open questions
1. Should installed plugins be allowed in release 1, or only built-in ones (tier 0)? The design assumes built-in only for release 1.
2. Who may install a plugin (Admin only), and does an unsigned plugin need an explicit approval each time?
3. Is the Chart.js 4 option set the right target, and which options beyond the first set (radar, polar area) are wanted?
