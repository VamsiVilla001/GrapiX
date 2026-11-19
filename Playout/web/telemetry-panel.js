// GENERATED from Shared/web-panels/telemetry-panel.js by tools/sync-shared-web.mjs. Do not edit: edit the source and run `npm run sync:web`.
// Live telemetry panel (build plan 2.27), shared by GrapiX Editor and GrapiX Playout.
//
// One source, copied into each app's `web/` by `tools/sync-shared-web.mjs` (and
// checked by it), so the two apps show the same telemetry the same way. The panel
// owns nothing about the engine: the app hands it `load()`, which returns the
// engine's `performance` reply, and the panel draws what the engine decided.
//
// Rules this file lives under:
//
// - It never derives a verdict. Severity, wording and the next step come from the
//   engine's findings (`Shared/control-plane/src/telemetry.rs`); the panel only
//   orders and draws them. A number is never turned into "fine" here.
// - A component the engine does not measure is shown as NOT MEASURED, never as OK
//   and never as a flat line.
// - A failed read is on screen, named, with the age of the last good reading. The
//   panel does not keep drawing old data as if it were live.
// - No wall-clock time (Playout invariants 8 and 9): ages are seconds since the
//   last reading, not a time of day.
// - Words always carry the state; colour is never the only signal.

const STATE_WORD = { ok: "OK", degraded: "DEGRADED", failed: "FAILED", notMeasured: "NOT MEASURED" };
const SEVERITY_WORD = { Critical: "CRITICAL", Warning: "WARNING", Nominal: "OK" };
const SEVERITY_RANK = { Nominal: 0, Warning: 1, Critical: 2 };
const SVG_NS = "http://www.w3.org/2000/svg";
const SPARK_W = 200;
const SPARK_H = 36;

/** The worst severity among the findings: `Nominal` when there are none. */
export function worstSeverity(findings) {
  let worst = "Nominal";
  for (const finding of findings ?? []) {
    if ((SEVERITY_RANK[finding.severity] ?? 0) > SEVERITY_RANK[worst]) worst = finding.severity;
  }
  return worst;
}

/** What the header says: the worst finding, or that the engine sent no components. */
export function headline(summary) {
  const components = summary?.components ?? [];
  if (components.length === 0) {
    return { word: "NO DATA", tone: "idle", note: "This engine sends no component telemetry." };
  }
  const worst = worstSeverity(summary.findings);
  const count = (summary.findings ?? []).length;
  return {
    word: SEVERITY_WORD[worst] ?? "OK",
    tone: worst === "Critical" ? "critical" : worst === "Warning" ? "warning" : "ok",
    note: count === 0 ? "No findings." : `${count} finding${count === 1 ? "" : "s"}, worst first.`,
  };
}

/**
 * Points of a series for a `width` by `height` box, newest at the right. The
 * scale reaches the limit, so a value under the limit never looks like it is
 * over it. Pure: the same series gives the same points.
 */
export function sparklinePoints(values, limit, width = SPARK_W, height = SPARK_H) {
  const top = Math.max(limit ?? 0, ...values, Number.MIN_VALUE) * 1.15;
  const y = (v) => height - (Math.max(v, 0) / top) * (height - 2) - 1;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return {
    points: values.map((v, i) => [Number((i * step).toFixed(2)), Number(y(v).toFixed(2))]),
    limitY: limit === undefined || limit === null ? null : Number(y(limit).toFixed(2)),
  };
}

function format(value, unit) {
  const digits = unit === "frames" ? 0 : value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${unit}`;
}

const CSS = `
.gxt { width: min(760px, calc(100vw - 32px)); max-height: calc(100vh - 32px); padding: 0; border: 1px solid var(--sk-border-strong, #46423a);
  border-radius: 4px; background: var(--sk-canvas, #131210); color: var(--sk-ink-2, #d3cec6);
  font: 500 12px/1.45 var(--sk-font-ui, system-ui); box-shadow: var(--sk-shadow-2, 0 4px 16px rgba(0,0,0,.45)); overflow: hidden; }
.gxt::backdrop { background: rgba(0,0,0,.55); }
.gxt[open] { display: flex; flex-direction: column; }
.gxt__head { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: var(--sk-surface, #1b1916); border-bottom: 1px solid var(--sk-border, #34312a); }
.gxt__title { margin: 0; font: 800 13px/1 var(--sk-font-ui, system-ui); color: var(--sk-ink, #f2f0eb); letter-spacing: .01em; }
.gxt__note { flex: 1; color: var(--sk-ink-3, #95908a); }
.gxt__chip { font: 700 10px/1 var(--sk-font-mono, monospace); letter-spacing: .08em; padding: 4px 7px; border-radius: 1px; border: 1px solid currentColor; }
.gxt__chip--ok { color: var(--sk-ok-ink, #7cc6a2); } .gxt__chip--warning { color: var(--sk-warn-ink, #e8b862); }
.gxt__chip--critical { color: var(--sk-danger-ink, #ee8f84); } .gxt__chip--idle { color: var(--sk-ink-3, #95908a); }
.gxt__btn { font: 700 11px/1 var(--sk-font-ui, system-ui); color: var(--sk-ink-2, #d3cec6); background: var(--sk-surface-2, #24221e);
  border: 1px solid var(--sk-border-strong, #46423a); border-radius: 2px; padding: 6px 10px; cursor: pointer; }
.gxt__btn:hover { border-color: var(--sk-ember, #f58138); }
.gxt__body { overflow: auto; padding: 12px 14px 14px; display: grid; gap: 12px; }
.gxt__stale { margin: 0; padding: 8px 10px; border: 1px solid var(--sk-danger, #e06a5e); background: var(--sk-danger-tint, #2e1714); color: var(--sk-danger-ink, #ee8f84); }
.gxt__totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; margin: 0; }
.gxt__total { padding: 7px 9px; background: var(--sk-surface, #1b1916); border: 1px solid var(--sk-border, #34312a); border-radius: 3px; }
.gxt__total dt { color: var(--sk-ink-3, #95908a); font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
.gxt__total dd { margin: 2px 0 0; font: 600 15px/1.1 var(--sk-font-mono, monospace); color: var(--sk-ink, #f2f0eb); font-variant-numeric: tabular-nums; }
.gxt__h { margin: 0 0 6px; font: 800 10px/1 var(--sk-font-ui, system-ui); letter-spacing: .08em; text-transform: uppercase; color: var(--sk-ink-3, #95908a); }
.gxt__findings { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
.gxt__finding { padding: 8px 10px; background: var(--sk-surface, #1b1916); border: 1px solid var(--sk-border, #34312a); border-left-width: 3px; border-radius: 3px; }
.gxt__finding--critical { border-left-color: var(--sk-danger, #e06a5e); } .gxt__finding--warning { border-left-color: var(--sk-warn, #dda543); }
.gxt__what { margin: 0; color: var(--sk-ink, #f2f0eb); font-weight: 700; }
.gxt__check { margin: 3px 0 0; } .gxt__rec { margin: 3px 0 0; color: var(--sk-ink-3, #95908a); font: 500 11px/1.3 var(--sk-font-mono, monospace); }
.gxt__clear { margin: 0; color: var(--sk-ok-ink, #7cc6a2); }
.gxt__grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 8px; }
.gxt__comp { padding: 8px 10px; background: var(--sk-surface, #1b1916); border: 1px solid var(--sk-border, #34312a); border-radius: 3px; }
.gxt__comphead { display: flex; align-items: baseline; gap: 8px; }
.gxt__compname { flex: 1; font-weight: 800; color: var(--sk-ink, #f2f0eb); }
.gxt__state { font: 700 10px/1 var(--sk-font-mono, monospace); letter-spacing: .08em; }
.gxt__state--ok { color: var(--sk-ok-ink, #7cc6a2); } .gxt__state--degraded { color: var(--sk-warn-ink, #e8b862); }
.gxt__state--failed { color: var(--sk-danger-ink, #ee8f84); } .gxt__state--notMeasured { color: var(--sk-ink-3, #95908a); }
.gxt__detail { margin: 3px 0 0; color: var(--sk-ink-3, #95908a); }
.gxt__series { margin-top: 6px; }
.gxt__seriesname { display: flex; justify-content: space-between; font-size: 10px; color: var(--sk-ink-3, #95908a); }
.gxt__spark { display: block; width: 100%; height: 36px; background: var(--sk-canvas, #131210); border: 1px solid var(--sk-border, #34312a); }
.gxt__spark polyline { fill: none; stroke: var(--sk-ink-2, #d3cec6); stroke-width: 1.2; vector-effect: non-scaling-stroke; }
.gxt__spark line { stroke: var(--sk-warn, #dda543); stroke-width: 1; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
`;

/** An element with a class and text. */
function node(doc, tag, className, text) {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function sparkline(doc, series) {
  const { points, limitY } = sparklinePoints(series.values, series.limit);
  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "gxt__spark");
  svg.setAttribute("viewBox", `0 0 ${SPARK_W} ${SPARK_H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("role", "img");
  const last = series.values[series.values.length - 1];
  svg.setAttribute(
    "aria-label",
    `${series.name}: ${last === undefined ? "no samples" : `last ${format(last, series.unit)}`}${
      series.limit == null ? "" : `, limit ${format(series.limit, series.unit)}`
    }`,
  );
  if (limitY !== null) {
    const line = doc.createElementNS(SVG_NS, "line");
    for (const [name, value] of [["x1", 0], ["x2", SPARK_W], ["y1", limitY], ["y2", limitY]]) line.setAttribute(name, String(value));
    svg.append(line);
  }
  if (points.length > 0) {
    const poly = doc.createElementNS(SVG_NS, "polyline");
    poly.setAttribute("points", points.map(([x, y]) => `${x},${y}`).join(" "));
    svg.append(poly);
  }
  return svg;
}

function componentCard(doc, component) {
  const card = node(doc, "li", "gxt__comp");
  card.dataset.component = component.id;
  const head = node(doc, "div", "gxt__comphead");
  head.append(
    node(doc, "span", "gxt__compname", component.label),
    node(doc, "span", `gxt__state gxt__state--${component.state}`, STATE_WORD[component.state] ?? String(component.state).toUpperCase()),
  );
  card.append(head);
  if (component.detail) card.append(node(doc, "p", "gxt__detail", component.detail));
  for (const series of component.series ?? []) {
    const block = node(doc, "div", "gxt__series");
    const last = series.values[series.values.length - 1];
    const name = node(doc, "div", "gxt__seriesname");
    name.append(
      node(doc, "span", "", series.name),
      node(doc, "span", "", last === undefined ? "no samples" : `${format(last, series.unit)}${series.limit == null ? "" : ` / limit ${format(series.limit, series.unit)}`}`),
    );
    block.append(name, sparkline(doc, series));
    card.append(block);
  }
  return card;
}

function totals(doc, summary) {
  const list = node(doc, "dl", "gxt__totals");
  const ratio = summary.meanBudgetRatio;
  for (const [key, value] of [
    ["Rendered", String(summary.totalRendered)],
    ["Late", String(summary.totalLate)],
    ["Missed", String(summary.totalMissed)],
    ["Dropped", String(summary.totalDropped)],
    ["Budget used", ratio == null ? "—" : `${Math.round(ratio * 100)}%`],
    ["Rate", `${summary.rate.num}/${summary.rate.den}`],
  ]) {
    const cell = node(doc, "div", "gxt__total");
    cell.append(node(doc, "dt", "", key), node(doc, "dd", "", value));
    list.append(cell);
  }
  return list;
}

/** The body for one reading: totals, findings (worst first), then every component. */
export function renderSummary(doc, summary) {
  const body = [];
  body.push(totals(doc, summary));
  const findings = summary.findings ?? [];
  const section = node(doc, "section");
  section.append(node(doc, "h3", "gxt__h", "Findings"));
  if (findings.length === 0) {
    section.append(node(doc, "p", "gxt__clear", "Nothing wrong, and nothing close to it, in what the engine measures."));
  } else {
    const list = node(doc, "ul", "gxt__findings");
    for (const finding of findings) {
      const item = node(doc, "li", `gxt__finding gxt__finding--${String(finding.severity).toLowerCase()}`);
      item.dataset.finding = finding.id;
      item.append(
        node(doc, "p", "gxt__what", `${SEVERITY_WORD[finding.severity] ?? finding.severity}: ${finding.what}`),
        node(doc, "p", "gxt__check", `Check: ${finding.check}`),
      );
      if (finding.record) item.append(node(doc, "p", "gxt__rec", `Log record: ${finding.record} (in the diagnostic bundle)`));
      list.append(item);
    }
    section.append(list);
  }
  body.push(section);
  const parts = node(doc, "section");
  parts.append(node(doc, "h3", "gxt__h", "Components"));
  const grid = node(doc, "ul", "gxt__grid");
  grid.style.listStyle = "none";
  grid.style.margin = "0";
  grid.style.padding = "0";
  for (const component of summary.components ?? []) grid.append(componentCard(doc, component));
  if ((summary.components ?? []).length === 0) parts.append(node(doc, "p", "gxt__detail", "This engine reports no per-component telemetry."));
  parts.append(grid);
  body.push(parts);
  return body;
}

/**
 * The panel. `load()` resolves to the engine's `performance` reply and rejects
 * with an `Error` (or anything with a message) when it cannot be had.
 */
export function createTelemetryPanel({ load, intervalMs = 1000, doc = globalThis.document, now = () => performance.now() }) {
  let dialog;
  let timer;
  let paused = false;
  let lastGood = null;
  let lastGoodAt = 0;
  let parts = {};

  function ensure() {
    if (dialog) return;
    if (!doc.querySelector("style[data-gxt]")) {
      const style = node(doc, "style", "", CSS);
      style.dataset.gxt = "";
      doc.head.append(style);
    }
    dialog = node(doc, "dialog", "gxt");
    dialog.setAttribute("aria-labelledby", "gxt-title");
    const head = node(doc, "header", "gxt__head");
    const title = node(doc, "h2", "gxt__title", "Live telemetry");
    title.id = "gxt-title";
    parts = {
      chip: node(doc, "span", "gxt__chip gxt__chip--idle", "NO DATA"),
      note: node(doc, "span", "gxt__note", "Waiting for the engine."),
      pause: node(doc, "button", "gxt__btn", "Pause"),
      close: node(doc, "button", "gxt__btn", "Close"),
      body: node(doc, "div", "gxt__body"),
    };
    parts.pause.type = "button";
    parts.close.type = "button";
    parts.pause.addEventListener("click", () => {
      paused = !paused;
      parts.pause.textContent = paused ? "Resume" : "Pause";
      if (!paused) void refresh();
    });
    parts.close.addEventListener("click", close);
    dialog.addEventListener("close", stop);
    head.append(title, parts.chip, parts.note, parts.pause, parts.close);
    dialog.append(head, parts.body);
    doc.body.append(dialog);
  }

  function draw(error) {
    const children = [];
    if (error) {
      const age = lastGood ? `last good reading ${Math.round((now() - lastGoodAt) / 1000)} s ago` : "no reading yet";
      const stale = node(doc, "p", "gxt__stale", `Engine telemetry is unavailable: ${error}. Showing ${age}.`);
      stale.setAttribute("role", "alert");
      children.push(stale);
    }
    if (lastGood) children.push(...renderSummary(doc, lastGood));
    parts.body.replaceChildren(...children);
    const head = lastGood ? headline(lastGood) : { word: "NO DATA", tone: "idle", note: error ? "No engine reading." : "Waiting for the engine." };
    parts.chip.className = `gxt__chip gxt__chip--${error ? "critical" : head.tone}`;
    parts.chip.textContent = error ? "STALE" : head.word;
    parts.note.textContent = error ? "The engine did not answer." : head.note;
  }

  async function refresh() {
    try {
      lastGood = await load();
      lastGoodAt = now();
      draw(null);
    } catch (failure) {
      draw(failure?.message ?? String(failure));
    }
  }

  function stop() {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  }

  function open() {
    ensure();
    if (!dialog.open) dialog.showModal();
    void refresh();
    stop();
    timer = setInterval(() => {
      if (!paused) void refresh();
    }, intervalMs);
  }

  function close() {
    stop();
    if (dialog?.open) dialog.close();
  }

  return { open, close, refresh, isOpen: () => Boolean(dialog?.open) };
}
