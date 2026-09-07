/**
 * The timeline's time model.
 *
 * Acceptance items 4 and 5 live here: conversions must round-trip exactly at the broadcast rates
 * with no drift across a long timeline, and the hit tolerance must not change meaning with zoom.
 *
 * The rates that matter are the drop-frame ones. 29.97 is 30000/1001 and 59.94 is 60000/1001; a
 * timeline that treats either as its decimal approximation drifts about 0.6 frames an hour at
 * 59.94, which is invisible in a test that checks one frame and obvious by the end of a show.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  HIT_TOLERANCE_FRAMES,
  createViewport,
  frameToNanos,
  frameToSeconds,
  frameToX,
  hitsFrame,
  nanosToFrame,
  secondsToFrame,
  timelineFrameRate,
  visibleFrameRange,
  xToFrame
} from "../src/components/timeline/timelineViewport";

const RATES = {
  "23.976": { numerator: 24_000, denominator: 1_001 },
  "29.97": { numerator: 30_000, denominator: 1_001 },
  "50": { numerator: 50, denominator: 1 },
  "59.94": { numerator: 60_000, denominator: 1_001 }
};

/* ── Acceptance 4: exact round-trips, no drift ────────────────────────────────────────────── */

test("frame -> nanos -> frame is exact at every broadcast rate, across 100,000 frames", () => {
  for (const [name, rate] of Object.entries(RATES)) {
    // Every frame for the first thousand, then a stride that lands on non-multiples of the rate so
    // a bug that only shows on second boundaries cannot hide.
    for (let frame = 0; frame <= 1_000; frame += 1) {
      assert.equal(nanosToFrame(rate, frameToNanos(rate, frame)), frame, `${name} @ ${frame}`);
    }
    for (let frame = 1_000; frame <= 100_000; frame += 997) {
      assert.equal(nanosToFrame(rate, frameToNanos(rate, frame)), frame, `${name} @ ${frame}`);
    }
    assert.equal(nanosToFrame(rate, frameToNanos(rate, 100_000)), 100_000, `${name} @ 100000`);
  }
});

test("frame -> seconds -> frame is exact at every broadcast rate", () => {
  for (const [name, rate] of Object.entries(RATES)) {
    for (let frame = 0; frame <= 100_000; frame += 991) {
      assert.equal(secondsToFrame(rate, frameToSeconds(rate, frame)), frame, `${name} @ ${frame}`);
    }
  }
});

/**
 * The drift test proper. A timeline that accumulated `previous + 1/fps` would be wrong here by
 * roughly a frame; computing from the frame index every time cannot drift at all.
 */
test("the 100,000th frame sits where exact rational arithmetic puts it", () => {
  for (const [name, rate] of Object.entries(RATES)) {
    const expectedNanos = Number(
      (BigInt(100_000) * 1_000_000_000n * BigInt(rate.denominator)) / BigInt(rate.numerator)
    );
    assert.equal(frameToNanos(rate, 100_000), expectedNanos, name);
  }

  /*
   * 59.94 specifically, with the real magnitude rather than a rounder-sounding one. Treating the
   * rate as its decimal drifts 0.216 frames per hour: 0.1 frames by 100,000 frames (~28 minutes),
   * and past a frame and a half across an eight-hour day. Small enough to survive a test that
   * checks one frame, large enough to matter by the end of a show.
   */
  const exact = frameToSeconds(RATES["59.94"], 100_000);
  const naive = 100_000 / 59.94;
  const driftFrames = Math.abs(exact - naive) * (60_000 / 1_001);

  assert.ok(driftFrames > 0.09, `the decimal must be measurably wrong; drift was ${driftFrames} frames`);
  assert.ok(driftFrames < 0.11, `and this much: drift was ${driftFrames} frames`);
  assert.equal(
    exact,
    Number((100_000n * 1_000_000_000n * 1_001n) / 60_000n) / 1_000_000_000,
    "the exact path must equal the rational, not merely be close to it"
  );
});

test("frame -> x -> frame is exact for integer frames at any zoom", () => {
  for (const pixelsPerFrame of [0.05, 0.25, 1, 3, 12.5, 40]) {
    const viewport = createViewport(0, pixelsPerFrame, 1_200);
    for (let frame = 0; frame <= 5_000; frame += 37) {
      assert.equal(xToFrame(viewport, frameToX(viewport, frame)), frame, `zoom ${pixelsPerFrame}`);
    }
  }
});

test("a scrolled viewport round-trips too", () => {
  const viewport = createViewport(4_321, 2.5, 900);
  for (let frame = 4_321; frame <= 4_800; frame += 13) {
    assert.equal(xToFrame(viewport, frameToX(viewport, frame)), frame);
  }
  assert.equal(frameToX(viewport, 4_321), 0, "the start frame sits at the left edge");
});

/* ── Acceptance 5: hit tolerance invariant under zoom ─────────────────────────────────────── */

test("hit tolerance is the same number of frames at every zoom", () => {
  for (const pixelsPerFrame of [0.05, 1, 40]) {
    const viewport = createViewport(0, pixelsPerFrame, 1_000);
    const key = 500;

    // Expressed through the viewport: convert a pointer X back to a frame and test in frame space.
    const insideX = frameToX(viewport, key + HIT_TOLERANCE_FRAMES);
    const outsideX = frameToX(viewport, key + HIT_TOLERANCE_FRAMES + 1);

    assert.equal(hitsFrame(xToFrame(viewport, insideX), key), true, `zoom ${pixelsPerFrame} inside`);
    assert.equal(hitsFrame(xToFrame(viewport, outsideX), key), false, `zoom ${pixelsPerFrame} outside`);
  }
});

test("the tolerance is symmetric and inclusive at its edge", () => {
  assert.equal(hitsFrame(100 - HIT_TOLERANCE_FRAMES, 100), true);
  assert.equal(hitsFrame(100 + HIT_TOLERANCE_FRAMES, 100), true);
  assert.equal(hitsFrame(100 - HIT_TOLERANCE_FRAMES - 1, 100), false);
  assert.equal(hitsFrame(100 + HIT_TOLERANCE_FRAMES + 1, 100), false);
});

/* ── The rate comes from the scene, never from the timeline ───────────────────────────────── */

test("an exact rate on the document wins", () => {
  assert.deepEqual(
    timelineFrameRate({ fps: 30, frameRate: { numerator: 30_000, denominator: 1_001 } }),
    { numerator: 30_000, denominator: 1_001 },
    "the declared rational must not be overridden by the decimal beside it"
  );
});

/** A legacy document carries only `fps`, where 29.97 is really 29.97002997… */
test("a legacy document's decimal fps resolves to the drop-frame rational", () => {
  assert.deepEqual(timelineFrameRate({ fps: 29.97 }), { numerator: 30_000, denominator: 1_001 });
  assert.deepEqual(timelineFrameRate({ fps: 59.94 }), { numerator: 60_000, denominator: 1_001 });
  assert.deepEqual(timelineFrameRate({ fps: 50 }), { numerator: 50, denominator: 1 });
});

test("a malformed rate falls back to the decimal rather than dividing by zero", () => {
  assert.deepEqual(
    timelineFrameRate({ fps: 25, frameRate: { numerator: 0, denominator: 0 } }),
    { numerator: 25, denominator: 1 }
  );
});

/* ── Viewport ranges ──────────────────────────────────────────────────────────────────────── */

test("the visible range covers the width and is clamped to the timeline", () => {
  const viewport = createViewport(100, 2, 400);
  const range = visibleFrameRange(viewport, 1_000);
  assert.equal(range.first, 99, "one frame of margin so a straddling marker still draws");
  assert.equal(range.last, 301);

  assert.equal(visibleFrameRange(createViewport(0, 2, 400), 50).last, 50, "clamped to duration");
  assert.equal(visibleFrameRange(createViewport(0, 2, 400), 1_000).first, 0, "never negative");
});

test("a degenerate zoom or width cannot divide by zero", () => {
  const viewport = createViewport(0, 0, 0);
  assert.equal(viewport.pixelsPerFrame, 1);
  assert.equal(Number.isFinite(xToFrame(viewport, 10)), true);
  assert.equal(Number.isFinite(visibleFrameRange(viewport, 100).last), true);
});
