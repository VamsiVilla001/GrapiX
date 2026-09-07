/**
 * Which layers a change repaints.
 *
 * Acceptance item 2 lives here: scrubbing must produce no static repaint. Expressed as a pure
 * function of two snapshots precisely so it can be asserted — as three `useEffect` dependency
 * arrays the same rule would only be checkable by rendering and counting rasterises.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  TIMELINE_LAYERS,
  planRepaint,
  rowSpanDirtyRect,
  unionDirty,
  type TimelineSnapshot
} from "../src/components/timeline/repaintPlan";

const BASE: TimelineSnapshot = {
  startFrame: 0,
  pixelsPerFrame: 4,
  width: 1_200,
  height: 400,
  devicePixelRatio: 2,
  rowWindowFirst: 0,
  rowWindowLast: 20,
  contentRevision: 1,
  selectionRevision: 1,
  currentFrame: 0,
  marqueeRevision: 0,
  dragRevision: 0
};

const after = (patch: Partial<TimelineSnapshot>): TimelineSnapshot => ({ ...BASE, ...patch });

/* ── Acceptance 2 ─────────────────────────────────────────────────────────────────────────── */

test("scrubbing repaints only the interaction layer", () => {
  const plan = planRepaint(BASE, after({ currentFrame: 1 }));

  assert.deepEqual([...plan], ["interaction"]);
  assert.equal(plan.has("static"), false, "a scrub must never re-rasterise the ruler");
  assert.equal(plan.has("content"), false, "nor the keys");
});

/** A whole scrub, not just its first frame: 600 frames of playhead movement, still no static. */
test("no amount of scrubbing dirties the static layer", () => {
  let previous = BASE;
  for (let frame = 1; frame <= 600; frame += 1) {
    const next = after({ currentFrame: frame });
    const plan = planRepaint(previous, next);
    assert.equal(plan.has("static"), false, `frame ${frame} dirtied the static layer`);
    assert.equal(plan.has("content"), false, `frame ${frame} dirtied the content layer`);
    previous = next;
  }
});

test("a marquee or a drag also stays on the interaction layer", () => {
  assert.deepEqual([...planRepaint(BASE, after({ marqueeRevision: 1 }))], ["interaction"]);
  assert.deepEqual([...planRepaint(BASE, after({ dragRevision: 1 }))], ["interaction"]);
});

/* ── Content ──────────────────────────────────────────────────────────────────────────────── */

test("moving a key repaints content but not the ruler", () => {
  const plan = planRepaint(BASE, after({ contentRevision: 2 }));
  assert.deepEqual([...plan], ["content"]);
});

test("changing the selection repaints content only — it is a fill colour, not a structure", () => {
  const plan = planRepaint(BASE, after({ selectionRevision: 2 }));
  assert.deepEqual([...plan], ["content"]);
});

/* ── Geometry cascades ────────────────────────────────────────────────────────────────────── */

test("zoom, scroll, resize and DPR each dirty all three layers", () => {
  for (const patch of [
    { pixelsPerFrame: 8 },
    { startFrame: 100 },
    { width: 900 },
    { height: 500 },
    { devicePixelRatio: 1 },
    { rowWindowFirst: 4 },
    { rowWindowLast: 30 }
  ]) {
    const plan = planRepaint(BASE, after(patch));
    assert.deepEqual(
      [...plan].sort(),
      [...TIMELINE_LAYERS].sort(),
      `${JSON.stringify(patch)} must stale every layer — they share one coordinate space`
    );
  }
});

test("the first paint draws everything", () => {
  assert.deepEqual([...planRepaint(null, BASE)].sort(), [...TIMELINE_LAYERS].sort());
});

test("an unchanged snapshot repaints nothing", () => {
  assert.equal(planRepaint(BASE, { ...BASE }).size, 0);
});

/* ── Dirty rectangles ─────────────────────────────────────────────────────────────────────── */

test("a row span reaches half a marker beyond the frames that changed", () => {
  const rect = rowSpanDirtyRect(100, 200, 28, 56, 5);
  assert.ok(rect.x <= 100 - 5, "or a drag leaves a sliver of the old marker behind");
  assert.ok(rect.x + rect.width >= 200 + 5);
  assert.equal(rect.y, 28);
  assert.equal(rect.height, 28);
});

test("a reversed span is still a positive rectangle", () => {
  const rect = rowSpanDirtyRect(200, 100, 28, 56, 5);
  assert.ok(rect.width > 0);
  assert.ok(rect.x <= 100 - 5);
});

test("union grows to cover both rectangles, and passes through a null", () => {
  const a = { x: 10, y: 10, width: 10, height: 10 };
  const b = { x: 50, y: 0, width: 10, height: 5 };

  assert.deepEqual(unionDirty(a, b), { x: 10, y: 0, width: 50, height: 20 });
  assert.deepEqual(unionDirty(null, b), b);
  assert.deepEqual(unionDirty(a, null), a);
  assert.equal(unionDirty(null, null), null, "nothing dirty stays nothing");
});
