// Tests for the operator clock display (ADR-002 action 3).
//
// Runs against the compiled output, so it verifies what actually ships rather
// than what the source appears to say. `npm run typecheck` must run first.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clockIndicator,
  formatRate,
  liveControlEnabled,
  takeFeedback,
} from "../dist/clock-display.js";

const P29_97 = { num: 30000, den: 1001 };
const P50 = { num: 50, den: 1 };

test("an exact rational is displayed the way an engineer says it", () => {
  assert.equal(formatRate(P29_97), "29.97");
  assert.equal(formatRate({ num: 60000, den: 1001 }), "59.94");
  // Integer rates do not gain a decimal point they never had.
  assert.equal(formatRate(P50), "50");
  assert.equal(formatRate({ num: 25, den: 1 }), "25");
});

test("a locked clock is allowed to be quiet", () => {
  const indicator = clockIndicator({
    severity: "Nominal",
    label: "Genlocked",
    timebase: P29_97,
    freeRunning: false,
  });
  assert.equal(indicator.prominence, "quiet");
  assert.equal(indicator.freeRunning, false);
  assert.equal(indicator.requiresAcknowledgement, false);
});

test("free-run is persistent and never quiet", () => {
  // Invariant 11: this is the whole point of the module. A free-running clock
  // cannot be presented as an unobtrusive state.
  const indicator = clockIndicator({
    severity: "Warning",
    label: "FREE RUN - no external reference",
    timebase: P50,
    freeRunning: true,
  });
  assert.equal(indicator.prominence, "persistent");
  assert.notEqual(indicator.prominence, "quiet");
  assert.equal(indicator.requiresAcknowledgement, true);
  assert.match(indicator.label, /FREE RUN/);
});

test("a lost reference blocks", () => {
  const indicator = clockIndicator({
    severity: "Critical",
    label: "REFERENCE LOST - holding last cadence",
    timebase: P29_97,
    freeRunning: true,
  });
  assert.equal(indicator.prominence, "blocking");
  // The held cadence is what is shown, because that is what Program is running
  // at (ADR-002).
  assert.equal(indicator.rate, "29.97");
});

test("the committed frame is always shown, never optional", () => {
  const feedback = takeFeedback({
    frame: 90210n,
    timebase: P29_97,
    clock: "Genlocked",
  });
  assert.equal(feedback.committedFrame, "90210");
  assert.equal(feedback.rate, "29.97");
  assert.equal(feedback.onFreeRunningClock, false);
});

test("a commitment on a free-running clock says so", () => {
  const feedback = takeFeedback({
    frame: 12n,
    timebase: P50,
    clock: "FreeRun",
  });
  assert.equal(feedback.onFreeRunningClock, true);
});

test("the live control is disabled when the engine would refuse", () => {
  const base = {
    epoch: 1n,
    currentFrame: 100n,
    timebase: P50,
    clock: "Genlocked",
    reference: "Locked",
    deviceTier: "T0",
    liveAllowed: true,
    program: null,
    degradations: [],
  };

  assert.equal(liveControlEnabled(base), true);

  assert.equal(
    liveControlEnabled({ ...base, liveAllowed: false }),
    false,
    "the engine's own gate is respected",
  );

  assert.equal(
    liveControlEnabled({
      ...base,
      degradations: [{ degradation: "referenceLost", was: P50 }],
    }),
    false,
    "ADR-002: no new live configuration while the reference is lost",
  );

  assert.equal(
    liveControlEnabled({
      ...base,
      degradations: [{ degradation: "deviceBelowT0", actual: "T2" }],
    }),
    false,
    "invariant 19: below T0 cannot go live",
  );

  assert.equal(
    liveControlEnabled({
      ...base,
      degradations: [{ degradation: "freeRunning" }],
    }),
    true,
    "a knowing free-run is permitted; the acknowledgement gate is separate",
  );
});
