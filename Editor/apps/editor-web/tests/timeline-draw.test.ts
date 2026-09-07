/**
 * The draw calls, against a recording context.
 *
 * This is where "repaint cost is independent of timeline length" becomes measurable without a
 * browser: the double counts calls, so a row of 100,000 keys can be asserted to issue draw calls
 * only for the ones on screen.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildKeyIndex } from "../src/components/timeline/keyIndex";
import { createViewport } from "../src/components/timeline/timelineViewport";
import {
  chooseTickInterval,
  drawInteractionLayer,
  drawKeyRows,
  drawStaticLayer,
  type Canvas2DLike,
  type TimelineMetrics,
  type TimelineTheme
} from "../src/components/timeline/drawTimeline";

const THEME: TimelineTheme = {
  rulerText: "#aaa", rulerTick: "#888", gridLine: "#333",
  rowBandEven: "#111", rowBandOdd: "#151515",
  key: "#17b9a8", keySelected: "#ffcc44", keyStroke: "#000",
  playhead: "#ff4444", marqueeFill: "rgba(23,185,168,0.15)", marqueeStroke: "#17b9a8",
  font: "11px system-ui"
};

const METRICS: TimelineMetrics = { rowHeight: 28, rulerHeight: 28, markerRadius: 5 };

/** Records every call so a test can count shapes without a canvas. */
function recorder() {
  const calls: string[] = [];
  const fills: string[] = [];
  const record = (name: string) => (..._args: unknown[]) => { calls.push(name); };

  const ctx = {
    lineWidth: 1,
    font: "",
    textBaseline: "middle" as CanvasTextBaseline,
    globalAlpha: 1,
    set fillStyle(value: string) { fills.push(value); },
    get fillStyle() { return fills[fills.length - 1] ?? ""; },
    strokeStyle: "",
    save: record("save"), restore: record("restore"),
    beginPath: record("beginPath"), closePath: record("closePath"),
    moveTo: record("moveTo"), lineTo: record("lineTo"), rect: record("rect"),
    fill: record("fill"), stroke: record("stroke"),
    fillRect: record("fillRect"), clearRect: record("clearRect"),
    fillText: record("fillText"), translate: record("translate"), rotate: record("rotate")
  } as unknown as Canvas2DLike;

  return {
    ctx,
    count: (name: string) => calls.filter((call) => call === name).length,
    fills
  };
}

const keysEvery = (count: number, stride = 1) =>
  buildKeyIndex(Array.from({ length: count }, (_, i) => ({ frame: i * stride, id: `k${i}` })));

/* ── Cost follows what is visible, not what exists ────────────────────────────────────────── */

test("a row of 100,000 keys draws only the ones on screen", () => {
  const index = keysEvery(100_000);
  const viewport = createViewport(50_000, 4, 400); // 400px / 4px per frame = 100 frames visible
  const rec = recorder();

  const drawn = drawKeyRows(rec.ctx, {
    rows: [{ index, windowRow: 0, selected: new Set() }],
    viewport,
    firstFrame: 50_000,
    lastFrame: 50_099,
    theme: THEME,
    metrics: METRICS
  });

  assert.equal(drawn, 100, "100 visible keys out of 100,000");
  assert.equal(rec.count("fill"), 100, "one fill per visible diamond, not per key");
});

/**
 * The headline property: 100 keys and 100,000 keys cost the same to draw when the same number are
 * on screen.
 */
test("draw cost is flat as a row grows from 100 to 100,000 keys", () => {
  const counts = [100, 1_000, 10_000, 100_000];
  const drawnPerSize = counts.map((count) => {
    const rec = recorder();
    const drawn = drawKeyRows(rec.ctx, {
      rows: [{ index: keysEvery(count), windowRow: 0, selected: new Set() }],
      viewport: createViewport(50, 4, 400),
      firstFrame: 50,
      lastFrame: 99,
      theme: THEME,
      metrics: METRICS
    });
    return { drawn, fills: rec.count("fill") };
  });

  const first = drawnPerSize[0];
  for (const entry of drawnPerSize) {
    assert.equal(entry.drawn, first.drawn, "the same window must draw the same number of keys");
    assert.equal(entry.fills, first.fills);
  }
  assert.equal(first.drawn, 50, "frames 50..99 inclusive");
});

test("a row with no keys in view issues no draw calls at all", () => {
  const rec = recorder();
  const drawn = drawKeyRows(rec.ctx, {
    rows: [{ index: keysEvery(1_000), windowRow: 0, selected: new Set() }],
    viewport: createViewport(50_000, 4, 400),
    firstFrame: 50_000,
    lastFrame: 50_099,
    theme: THEME,
    metrics: METRICS
  });

  assert.equal(drawn, 0);
  assert.equal(rec.count("fill"), 0, "an off-screen row must not cost a path");
});

/* ── Selection is a fill colour ───────────────────────────────────────────────────────────── */

test("selecting a key changes its fill and nothing else", () => {
  const index = keysEvery(10);
  const base = recorder();
  const withSelection = recorder();

  const shared = {
    viewport: createViewport(0, 10, 200),
    firstFrame: 0,
    lastFrame: 9,
    theme: THEME,
    metrics: METRICS
  };

  const drawnPlain = drawKeyRows(base.ctx, {
    rows: [{ index, windowRow: 0, selected: new Set() }],
    ...shared
  });
  const drawnSelected = drawKeyRows(withSelection.ctx, {
    rows: [{ index, windowRow: 0, selected: new Set([2, 3]) }],
    ...shared
  });

  assert.equal(drawnPlain, drawnSelected, "the same keys are drawn either way");
  assert.equal(base.count("fill"), withSelection.count("fill"), "and the same number of shapes");
  assert.equal(base.fills.filter((fill) => fill === THEME.keySelected).length, 0);
  assert.equal(
    withSelection.fills.filter((fill) => fill === THEME.keySelected).length,
    2,
    "exactly the two selected keys take the selected colour"
  );
});

/* ── Ruler ────────────────────────────────────────────────────────────────────────────────── */

/** Labels must name round frame numbers and stay legible from far out to far in. */
test("the tick interval follows the 1-2-5 ladder and keeps labels apart", () => {
  for (const pixelsPerFrame of [0.02, 0.1, 1, 4, 20, 100]) {
    const interval = chooseTickInterval(pixelsPerFrame, 90);
    const gapPx = interval * pixelsPerFrame;

    assert.ok(gapPx >= 90, `at ${pixelsPerFrame}px/frame the gap was ${gapPx}px — labels would crowd`);
    assert.ok(gapPx < 90 * 5, `at ${pixelsPerFrame}px/frame the gap was ${gapPx}px — labels would strand`);

    const mantissa = interval / 10 ** Math.floor(Math.log10(interval));
    assert.ok([1, 2, 5, 10].includes(Math.round(mantissa)), `interval ${interval} is not on the ladder`);
  }
});

test("the static layer draws a band per row and ticks across the width", () => {
  const rec = recorder();
  drawStaticLayer(rec.ctx, {
    viewport: createViewport(0, 4, 400),
    height: 28 + 5 * 28,
    rowCount: 5,
    firstRowIndex: 0,
    durationFrames: 1_000,
    theme: THEME,
    metrics: METRICS
  });

  assert.equal(rec.count("clearRect"), 1, "cleared once");
  assert.equal(rec.count("fillRect"), 5, "one band per mounted row");
  assert.ok(rec.count("fillText") > 0, "and labelled ticks");
});

/** Row banding follows the absolute row index, so scrolling does not make the stripes jump. */
test("banding alternates on the absolute row index, not the window position", () => {
  const even = recorder();
  const odd = recorder();
  const shared = {
    viewport: createViewport(0, 4, 400),
    height: 28 + 2 * 28,
    rowCount: 2,
    durationFrames: 1_000,
    theme: THEME,
    metrics: METRICS
  };

  drawStaticLayer(even.ctx, { ...shared, firstRowIndex: 0 });
  drawStaticLayer(odd.ctx, { ...shared, firstRowIndex: 1 });

  assert.notEqual(
    even.fills[0],
    odd.fills[0],
    "a window starting on an odd row must start with the odd band"
  );
});

/* ── Interaction layer ────────────────────────────────────────────────────────────────────── */

test("the interaction layer clears itself and draws the playhead", () => {
  const rec = recorder();
  drawInteractionLayer(rec.ctx, {
    viewport: createViewport(0, 4, 400),
    height: 200,
    currentFrame: 25,
    marquee: null,
    theme: THEME,
    metrics: METRICS
  });

  assert.equal(rec.count("clearRect"), 1, "a full clear is cheaper than tracking what moved");
  assert.equal(rec.count("stroke"), 1, "just the playhead");
  assert.equal(rec.count("fillRect"), 0, "and nothing from the other layers");
});

test("a marquee adds a filled rectangle and its outline", () => {
  const rec = recorder();
  drawInteractionLayer(rec.ctx, {
    viewport: createViewport(0, 4, 400),
    height: 200,
    currentFrame: 25,
    marquee: { frameFrom: 10, frameTo: 40, rowFrom: 0, rowTo: 2 },
    theme: THEME,
    metrics: METRICS
  });

  assert.equal(rec.count("fillRect"), 1);
  assert.equal(rec.count("stroke"), 2, "marquee outline plus playhead");
});

/** Dragged right-to-left or bottom-to-top, a marquee is the same rectangle. */
test("a reversed marquee draws the same rectangle", () => {
  const forward = recorder();
  const reversed = recorder();
  const shared = {
    viewport: createViewport(0, 4, 400),
    height: 200,
    currentFrame: 0,
    theme: THEME,
    metrics: METRICS
  };

  drawInteractionLayer(forward.ctx, { ...shared, marquee: { frameFrom: 10, frameTo: 40, rowFrom: 0, rowTo: 2 } });
  drawInteractionLayer(reversed.ctx, { ...shared, marquee: { frameFrom: 40, frameTo: 10, rowFrom: 2, rowTo: 0 } });

  assert.equal(forward.count("fillRect"), reversed.count("fillRect"));
  assert.equal(forward.count("stroke"), reversed.count("stroke"));
});
