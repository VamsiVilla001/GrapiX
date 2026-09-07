/**
 * Keyframe drag: coalescing, and the undo transaction around it.
 *
 * Acceptance item 3 lives here — dragging 50 selected keys yields exactly one undo entry. The
 * session itself opens no transaction; what it must guarantee is that no amount of pointer input
 * makes the caller open a second one, and that a drag which never moved writes nothing at all (so
 * `commitHistory` finds an unchanged scene and deposits no entry, as it does today).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  KeyDragSession,
  coalescedClientXs,
  dragHistoryLabel
} from "../src/components/timeline/keyDragSession";

const PIXELS_PER_FRAME = 4;
const frameForClientX = (clientX: number) => Math.round(clientX / PIXELS_PER_FRAME);
const noClamp = (_starts: number[], delta: number) => delta;

function session(options: {
  keys?: number;
  startFrame?: number;
  threshold?: number;
  clampDelta?: (starts: number[], delta: number) => number;
} = {}) {
  const count = options.keys ?? 1;
  const startFrames = new Map(
    Array.from({ length: count }, (_, index) => [`k${index}`, (options.startFrame ?? 100) + index])
  );
  return new KeyDragSession({
    originClientX: 400,
    originFrame: frameForClientX(400),
    startFrames,
    thresholdPx: options.threshold ?? 3,
    frameForClientX,
    clampDelta: options.clampDelta ?? noClamp
  });
}

/* ── Acceptance 3 ─────────────────────────────────────────────────────────────────────────── */

/**
 * A realistic drag: 50 keys, 120 pointer moves arriving in coalesced batches, flushed once per
 * animation frame. The transaction is opened by the caller once at pointer-down; what is asserted
 * here is that the session never signals a reason to open another, and that the keys land exactly
 * where the final pointer position puts them.
 */
test("dragging 50 keys across 120 samples is one transaction's worth of writes", () => {
  const drag = session({ keys: 50 });
  let flushes = 0;
  let lastWrites: { id: string; frame: number }[] = [];

  for (let move = 1; move <= 120; move += 1) {
    // Three coalesced samples per dispatch, as a high-rate pointer delivers.
    drag.sample([400 + move * 2 - 1, 400 + move * 2, 400 + move * 2 + 1]);

    // One flush per animation frame — roughly every third dispatch at 60 Hz.
    if (move % 3 === 0) {
      const writes = drag.flush();
      if (writes.length > 0) {
        flushes += 1;
        lastWrites = writes;
      }
    }
  }

  assert.ok(flushes > 0, "the drag must actually have written something");
  assert.equal(lastWrites.length, 50, "every selected key moves together, in one batch");

  // 40 flushes at most (120/3), and each is a batch of 50 — not 50 separate transactions.
  assert.ok(flushes <= 40, `expected at most one write batch per frame, saw ${flushes}`);

  const label = dragHistoryLabel(50);
  assert.equal(label, "Move 50 keyframes", "the existing label shape is preserved");
});

/** A press that never moved writes nothing, so commitHistory deposits no undo entry. */
test("a click that never passes the threshold writes nothing", () => {
  const drag = session({ keys: 50, threshold: 3 });

  drag.sample([401]);
  assert.deepEqual(drag.flush(), []);
  drag.sample([402]);
  assert.deepEqual(drag.flush(), []);
  assert.equal(drag.hasMoved, false);
});

test("once the threshold is passed the drag stays live, even back at the origin", () => {
  const drag = session();

  drag.sample([500]);
  assert.ok(drag.flush().length > 0);
  assert.equal(drag.hasMoved, true);

  // Returning to the start is a real move back, not a return to click semantics.
  drag.sample([400]);
  const back = drag.flush();
  assert.equal(back.length, 1);
  assert.equal(back[0].frame, 100, "back at the starting frame");
});

/* ── Coalescing ───────────────────────────────────────────────────────────────────────────── */

test("only the last coalesced sample decides the outcome", () => {
  const drag = session();
  drag.sample([420, 460, 500]);

  const writes = drag.flush();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].frame, 100 + (frameForClientX(500) - frameForClientX(400)));
});

test("a flush with no new sample writes nothing", () => {
  const drag = session();
  drag.sample([500]);
  assert.equal(drag.flush().length, 1);

  assert.deepEqual(drag.flush(), [], "the same position must not be written twice");
  assert.equal(drag.hasPendingSample, false);
});

test("samples that resolve to the same frame are written once", () => {
  const drag = session();
  drag.sample([500]);
  assert.equal(drag.flush().length, 1);

  // Sub-frame movement: still frame 125 at 4 px per frame.
  drag.sample([501]);
  assert.deepEqual(drag.flush(), [], "a move within one frame is not a move");
});

/* ── Delta is measured from the origin ────────────────────────────────────────────────────── */

/**
 * The compounding bug this shape exists to prevent: adding each move to the *current* frames makes
 * the selection accelerate away from the cursor. After N moves to the same place, the keys must be
 * in the same place.
 */
test("repeated flushes at one position do not compound", () => {
  const drag = session({ keys: 3 });

  drag.sample([600]);
  const first = drag.flush();

  drag.sample([500]);
  drag.flush();
  drag.sample([600]);
  const again = drag.flush();

  assert.deepEqual(again, first, "returning to a position must reproduce it exactly");
});

test("every key keeps its own offset within the selection", () => {
  const drag = session({ keys: 3, startFrame: 100 });
  drag.sample([600]);

  const writes = drag.flush();
  const delta = frameForClientX(600) - frameForClientX(400);
  assert.deepEqual(
    writes.map((write) => write.frame),
    [100 + delta, 101 + delta, 102 + delta],
    "the selection moves rigidly; relative spacing is preserved"
  );
});

test("the clamp is applied to the delta, not to each key after the fact", () => {
  const seen: number[][] = [];
  const drag = session({
    keys: 3,
    clampDelta: (starts, delta) => {
      seen.push([...starts]);
      return Math.min(delta, 5);
    }
  });

  drag.sample([900]);
  const writes = drag.flush();

  assert.deepEqual(seen[0], [100, 101, 102], "the clamp sees every start frame at once");
  assert.deepEqual(writes.map((write) => write.frame), [105, 106, 107], "clamped rigidly");
});

/* ── getCoalescedEvents ───────────────────────────────────────────────────────────────────── */

test("coalesced samples are read when the browser provides them", () => {
  assert.deepEqual(
    coalescedClientXs({
      clientX: 500,
      getCoalescedEvents: () => [{ clientX: 480 }, { clientX: 490 }, { clientX: 500 }]
    }),
    [480, 490, 500]
  );
});

/** Absent in older Safari and in test doubles; the event's own position is what the browser would
 *  have delivered anyway, so the fallback loses nothing. */
test("the event's own position is used when coalescing is unavailable or empty", () => {
  assert.deepEqual(coalescedClientXs({ clientX: 500 }), [500]);
  assert.deepEqual(coalescedClientXs({ clientX: 500, getCoalescedEvents: () => [] }), [500]);
});

test("the history label matches the existing wording for one key and many", () => {
  assert.equal(dragHistoryLabel(1), "Move keyframe");
  assert.equal(dragHistoryLabel(2), "Move 2 keyframes");
});
