import assert from "node:assert/strict";
import test from "node:test";
import {
  SCRUB_DEAD_ZONE_PX,
  SCRUB_FINE_FACTOR,
  reduceScrub,
  scrubNumericValue
} from "../src/lib/numericGesture";

/**
 * The numeric gesture both panels now share.
 *
 * The three rules that are easy to get wrong and invisible when they are: the dead zone that keeps a
 * click a click, the Shift factor, and measuring every delta from where the press began rather than
 * accumulating per move. The last one is why a scrub is reversible — drag out and back and the value
 * returns exactly, instead of drifting by the rounding of a hundred small steps.
 */

const origin = (startValue: number, startX = 100, active = false) => ({ startValue, startX, active });

test("a press that has not travelled far enough means nothing yet", () => {
  const outcome = reduceScrub(origin(10), { clientX: 101, shiftKey: false, step: 1 });
  assert.equal(outcome.active, false);
  assert.equal(outcome.value, null);
});

test("travel past the dead zone makes it a drag", () => {
  const outcome = reduceScrub(origin(10), { clientX: 100 + SCRUB_DEAD_ZONE_PX, shiftKey: false, step: 1 });
  assert.equal(outcome.active, true);
  assert.equal(outcome.value, 12);
});

test("Shift yields one tenth of the delta", () => {
  const coarse = reduceScrub(origin(0), { clientX: 200, shiftKey: false, step: 1 });
  const fine = reduceScrub(origin(0), { clientX: 200, shiftKey: true, step: 1 });
  assert.equal(coarse.value, 100);
  assert.equal(fine.value, 10);
  assert.equal(SCRUB_FINE_FACTOR, 0.1);
  assert.equal((fine.value ?? 0) * 10, coarse.value);
});

test("an already-active drag keeps responding inside the dead zone", () => {
  // Latching matters: drag out, then return to within a pixel of the start. Without the latch the
  // gesture would stop reporting and the value would freeze wherever it was.
  const outcome = reduceScrub(origin(10, 100, true), { clientX: 101, shiftKey: false, step: 1 });
  assert.equal(outcome.active, true);
  assert.equal(outcome.value, 11);
});

test("a delta is measured from the press, so a scrub is reversible", () => {
  const start = origin(50, 100, true);
  const out = reduceScrub(start, { clientX: 180, shiftKey: false, step: 1 });
  const back = reduceScrub(start, { clientX: 100, shiftKey: false, step: 1 });
  assert.equal(out.value, 130);
  assert.equal(back.value, 50, "returning to the start restores the exact original value");
});

test("the step scales the delta, so a scale scrubs finer than a position", () => {
  assert.equal(reduceScrub(origin(1, 100, true), { clientX: 200, shiftKey: false, step: 0.01 }).value, 2);
  assert.equal(reduceScrub(origin(0, 100, true), { clientX: 200, shiftKey: false, step: 0.1 }).value, 10);
});

test("a scrub respects the bounds it is given", () => {
  const clamped = reduceScrub(origin(0.5, 100, true), {
    clientX: 400, shiftKey: false, step: 0.01, min: 0, max: 1
  });
  assert.equal(clamped.value, 1);
});

test("the rounding follows the step rather than leaving float dust", () => {
  assert.equal(scrubNumericValue(0, 3, 0.1), 0.3);
  assert.equal(scrubNumericValue(0, 1, 0.01), 0.01);
  // A step of 1 still allows the two decimals a fine scrub needs.
  assert.equal(scrubNumericValue(0, 1, 1, SCRUB_FINE_FACTOR), 0.1);
});

test("a nonsense step or sensitivity falls back rather than producing NaN", () => {
  assert.equal(scrubNumericValue(5, 10, Number.NaN), 15);
  assert.equal(scrubNumericValue(5, 10, 0), 15);
  assert.equal(scrubNumericValue(5, 10, 1, Number.NaN), 15);
  assert.ok(Number.isFinite(scrubNumericValue(5, 10, -1, -1)));
});
