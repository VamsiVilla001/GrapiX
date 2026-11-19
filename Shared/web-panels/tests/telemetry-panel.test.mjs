// The shared telemetry panel (build plan 2.27): what it shows for a reading, and
// that it never invents a verdict. A small DOM double stands in for the page, so
// the real code runs without a browser.

import assert from "node:assert/strict";
import test from "node:test";

import { createTelemetryPanel, headline, renderSummary, sparklinePoints, worstSeverity } from "../telemetry-panel.js";

class FakeNode {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.className = "";
    this.open = false;
    this.textValue = "";
  }
  set textContent(value) {
    this.textValue = value;
    this.children = [];
  }
  get textContent() {
    return this.textValue + this.children.map((c) => c.textContent).join("");
  }
  append(...items) {
    this.children.push(...items);
  }
  replaceChildren(...items) {
    this.children = items;
    this.textValue = "";
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  addEventListener(name, handler) {
    (this.listeners[name] ??= []).push(handler);
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    for (const handler of this.listeners.close ?? []) handler();
  }
  all(predicate, found = []) {
    if (predicate(this)) found.push(this);
    for (const child of this.children) child.all(predicate, found);
    return found;
  }
}

function fakeDocument() {
  const head = new FakeNode("head");
  const body = new FakeNode("body");
  return {
    head,
    body,
    createElement: (tag) => new FakeNode(tag),
    createElementNS: (_ns, tag) => new FakeNode(tag),
    querySelector: (selector) => (selector === "style[data-gxt]" ? head.all((n) => n.tag === "style")[0] ?? null : null),
  };
}

const RATE = { num: 50, den: 1 };

function reading(overrides = {}) {
  return {
    rate: RATE,
    deviceTier: "T0",
    frames: [],
    totalRendered: 1200,
    totalLate: 0,
    totalDropped: 0,
    totalMissed: 0,
    meanBudgetRatio: 0.21,
    components: [
      { id: "frame-loop", kind: "frameLoop", label: "Program render", state: "ok", detail: "4.0 ms mean", series: [{ name: "Render time", unit: "ms", values: [4, 5, 4], limit: 20 }] },
      { id: "gpu-adapter", kind: "gpuAdapter", label: "GPU adapter", state: "ok", detail: "RTX. GPU time per frame is not measured", series: [] },
      { id: "readback", kind: "readback", label: "GPU readback", state: "notMeasured", detail: "no ring", series: [] },
    ],
    findings: [],
    ...overrides,
  };
}

const text = (nodes) => nodes.map((n) => n.textContent).join("\n");

test("the worst severity is the highest one, and none is Nominal", () => {
  assert.equal(worstSeverity([]), "Nominal");
  assert.equal(worstSeverity(undefined), "Nominal");
  assert.equal(worstSeverity([{ severity: "Warning" }, { severity: "Critical" }, { severity: "Warning" }]), "Critical");
});

test("the headline is the engine's worst finding, and an engine with no components is NO DATA, not OK", () => {
  assert.deepEqual(
    headline(reading({ findings: [{ severity: "Warning" }, { severity: "Warning" }] })),
    { word: "WARNING", tone: "warning", note: "2 findings, worst first." },
  );
  assert.equal(headline(reading()).word, "OK");
  assert.equal(headline(reading({ components: [] })).word, "NO DATA");
  assert.equal(headline(undefined).tone, "idle");
});

test("a sparkline scales to its limit, so a value under the limit never looks over it", () => {
  const { points, limitY } = sparklinePoints([4, 5, 4], 20, 200, 36);
  assert.equal(points.length, 3);
  assert.ok(points.every(([, y]) => y > limitY), "every point is below the limit line (larger y)");
  assert.equal(points[0][0], 0);
  assert.equal(points[2][0], 200);
  assert.equal(sparklinePoints([], undefined).limitY, null);
  assert.deepEqual(sparklinePoints([], 20).points, []);
});

test("a finding shows its wording, its next step and its log record, worst first as sent", () => {
  const nodes = renderSummary(
    fakeDocument(),
    reading({
      findings: [
        { id: "readback.stalled", component: "readback", severity: "Critical", what: "GPU readback stalled: up to 3 clock frames", check: "Look for other GPU work.", record: "frame.late" },
        { id: "frame.late", component: "frame-loop", severity: "Warning", what: "1 of 100 frames late", check: "Simplify the scene." },
      ],
    }),
  );
  const shown = text(nodes);
  assert.match(shown, /CRITICAL: GPU readback stalled: up to 3 clock frames/);
  assert.match(shown, /Check: Look for other GPU work\./);
  assert.match(shown, /Log record: frame\.late/);
  assert.ok(shown.indexOf("readback stalled") < shown.indexOf("1 of 100 frames late"));
  assert.doesNotMatch(shown, /Nothing wrong/);
});

test("with no findings it says so, and a component that is not measured says NOT MEASURED, not OK", () => {
  const shown = text(renderSummary(fakeDocument(), reading()));
  assert.match(shown, /Nothing wrong/);
  assert.match(shown, /GPU readback[\s\S]*NOT MEASURED/);
  assert.match(shown, /GPU time per frame is not measured/);
});

test("every component is drawn with its state word and its series with the last value and the limit", () => {
  const nodes = renderSummary(fakeDocument(), reading());
  const cards = nodes.flatMap((n) => n.all((x) => x.dataset.component !== undefined));
  assert.deepEqual(cards.map((c) => c.dataset.component), ["frame-loop", "gpu-adapter", "readback"]);
  const shown = text(nodes);
  assert.match(shown, /4\.0 ms \/ limit 20\.0 ms/);
  const svgs = nodes.flatMap((n) => n.all((x) => x.attributes.role === "img"));
  assert.equal(svgs.length, 1, "a component with no series draws no empty graph");
  assert.match(svgs[0].attributes["aria-label"], /Render time: last 4\.0 ms, limit 20\.0 ms/);
});

test("totals show the engine's counts and a missing budget ratio as a dash, not 0%", () => {
  const shown = text(renderSummary(fakeDocument(), reading({ meanBudgetRatio: undefined, totalMissed: 3 })));
  assert.match(shown, /Missed3/);
  assert.match(shown, /Budget used—/);
  assert.match(shown, /Rate50\/1/);
});

test("opening loads a reading and shows it; a failed read is named, with the age of the last good one", async () => {
  const doc = fakeDocument();
  let clock = 10_000;
  let fail = false;
  const panel = createTelemetryPanel({
    load: async () => {
      if (fail) throw new Error("Engine not connected");
      return reading({ findings: [{ id: "frame.late", component: "frame-loop", severity: "Warning", what: "1 of 100 frames late", check: "Simplify." }] });
    },
    doc,
    now: () => clock,
    intervalMs: 3_600_000,
  });
  panel.open();
  await panel.refresh();
  const dialog = doc.body.children[0];
  assert.equal(dialog.open, true);
  const chip = dialog.all((n) => n.className.startsWith("gxt__chip"))[0];
  assert.equal(chip.textContent, "WARNING");

  fail = true;
  clock += 7_000;
  await panel.refresh();
  assert.equal(chip.textContent, "STALE");
  const alert = dialog.all((n) => n.attributes.role === "alert")[0];
  assert.match(alert.textContent, /Engine telemetry is unavailable: Engine not connected\. Showing last good reading 7 s ago\./);
  assert.match(dialog.textContent, /1 of 100 frames late/, "the last good reading stays visible beside the failure");
  panel.close();
  assert.equal(dialog.open, false);
});

test("a read that fails before any reading says there is none, not that things are fine", async () => {
  const doc = fakeDocument();
  const panel = createTelemetryPanel({ load: async () => { throw new Error("Engine not connected"); }, doc, intervalMs: 3_600_000 });
  panel.open();
  await panel.refresh();
  const dialog = doc.body.children[0];
  assert.match(dialog.textContent, /unavailable: Engine not connected\. Showing no reading yet\./);
  assert.doesNotMatch(dialog.textContent, /Nothing wrong/);
  panel.close();
});

test("the panel installs its style once however often it is created", () => {
  const doc = fakeDocument();
  const first = createTelemetryPanel({ load: async () => reading(), doc, intervalMs: 3_600_000 });
  const second = createTelemetryPanel({ load: async () => reading(), doc, intervalMs: 3_600_000 });
  first.open();
  second.open();
  assert.equal(doc.head.all((n) => n.tag === "style").length, 1);
  first.close();
  second.close();
});
