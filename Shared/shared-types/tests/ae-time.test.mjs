import assert from "node:assert/strict";
import test from "node:test";

import {
  aeCompositionClock,
  aeCompositionClockRate,
  aeExactRatesEqual,
  aeExactTime,
  aeExactTimeToProgramFrame,
  aeExactTimesEqual,
  aeTimeInCompositionScale,
  compareAeExactTimes,
  exactDeadlineNanos,
  exactFrameDurationNanos,
  isAeCompositionClock,
  isAeExactRate,
  isAeExactTime,
  parseAeExactTime,
  programFrameToAeCompositionTime,
  programFrameToAeExactTime,
  reconcileAeCompositionClock
} from "../dist/aeTime.js";

const NTSC60 = { numerator: 60000, denominator: 1001 };
const NTSC30 = { numerator: 30000, denominator: 1001 };
const PAL = { numerator: 25, denominator: 1 };

/** What `clock.ts` used to do, kept here as the thing the exact path has to disagree with. */
const legacyRoundedDeadline = (rate, frame) =>
  Math.round((frame * 1_000_000_000 * rate.denominator) / rate.numerator);

test("a time is only exact when both parts are decimal integer strings", () => {
  assert.equal(isAeExactTime({ value: "1001", scale: "30000" }), true);
  assert.equal(isAeExactTime({ value: "0", scale: "1" }), true);

  // A float anywhere is the whole failure mode this type exists to prevent.
  assert.equal(isAeExactTime({ value: 1001, scale: 30000 }), false);
  assert.equal(isAeExactTime({ value: "33.366", scale: "1" }), false);
  assert.equal(isAeExactTime({ value: "1e3", scale: "1" }), false);
  assert.equal(isAeExactTime({ value: "-1", scale: "1" }), false, "time is non-negative");
  assert.equal(isAeExactTime({ value: "01", scale: "1" }), false, "no leading zeros to parse two ways");
  assert.equal(isAeExactTime({ value: "1", scale: "0" }), false, "scale zero is not a rational");
  assert.equal(isAeExactTime(null), false);
  assert.equal(parseAeExactTime({ value: "1", scale: "0" }), null);
});

test("equality and ordering hold across unequal scales", () => {
  assert.equal(aeExactTimesEqual({ value: "1", scale: "2" }, { value: "2", scale: "4" }), true);
  assert.equal(aeExactTimesEqual({ value: "1", scale: "2" }, { value: "3", scale: "4" }), false);
  assert.equal(compareAeExactTimes({ value: "1", scale: "2" }, { value: "3", scale: "4" }), -1);
  assert.equal(compareAeExactTimes({ value: "3", scale: "4" }, { value: "1", scale: "2" }), 1);
  assert.equal(compareAeExactTimes({ value: "2", scale: "4" }, { value: "1", scale: "2" }), 0);
  assert.ok(Number.isNaN(compareAeExactTimes({ value: "x", scale: "1" }, { value: "1", scale: "1" })));

  // Well past 2^53, where a float comparison would call these equal.
  const big = { value: "90071992547409910", scale: "1" };
  const bigPlusOne = { value: "90071992547409911", scale: "1" };
  assert.equal(aeExactTimesEqual(big, bigPlusOne), false);
  assert.equal(compareAeExactTimes(big, bigPlusOne), -1);
});

test("an off-frame instant is refused rather than rounded to a neighbour", () => {
  assert.deepEqual(aeExactTimeToProgramFrame({ value: "1001", scale: "30000" }, NTSC30), {
    frame: 1,
    deadlineNanos: 33_366_666
  });
  // Half a frame at 30000/1001. Rounding it would put a cue on a frame nobody declared.
  assert.equal(aeExactTimeToProgramFrame({ value: "1", scale: "2" }, NTSC30), "NOT_ON_FRAME");
  assert.equal(aeExactTimeToProgramFrame({ value: "1001", scale: "60000" }, NTSC30), "NOT_ON_FRAME");
  assert.equal(aeExactTimeToProgramFrame({ value: "1.5", scale: "1" }, NTSC30), "INVALID_TIME");
  assert.equal(aeExactTimeToProgramFrame({ value: "0", scale: "1" }, { numerator: 0, denominator: 1 }), "INVALID_RATE");
  assert.deepEqual(aeExactTimeToProgramFrame({ value: "0", scale: "1" }, NTSC60), { frame: 0, deadlineNanos: 0 });
});

test("deadlines truncate, which is what makes them agree with the Rust twin", () => {
  // stage.rs::FrameRate::deadline_nanos truncates in u128; the old TypeScript rounded.
  assert.equal(exactDeadlineNanos(NTSC60, 2), 33_366_666);
  assert.equal(legacyRoundedDeadline(NTSC60, 2), 33_366_667, "the value Rust never agreed with");

  let diverged = 0;
  for (let frame = 0; frame < 100_000; frame += 1) {
    if (legacyRoundedDeadline(NTSC60, frame) !== exactDeadlineNanos(NTSC60, frame)) diverged += 1;
  }
  assert.equal(diverged, 33_333, "a third of all frames disagreed before this module existed");
});

test("the intermediate product outgrows a double, so it is a bigint", () => {
  // frame * 1e9 * 1001 at one hour is ~2.16e17, well past Number.MAX_SAFE_INTEGER (9.0e15).
  const oneHour = 215_784;
  assert.ok(oneHour * 1_000_000_000 * NTSC60.denominator > Number.MAX_SAFE_INTEGER);
  assert.equal(exactDeadlineNanos(NTSC60, oneHour), 3_599_996_400_000);
  assert.equal(exactDeadlineNanos(NTSC30, 107_892), 3_599_996_400_000);
  assert.equal(exactDeadlineNanos(PAL, 90_000), 3_600_000_000_000);

  // Ten hours: the float path is off by a nanosecond, which is the drift arriving.
  const tenHours = 2_157_842;
  assert.equal(exactDeadlineNanos(NTSC60, tenHours), 35_999_997_366_666);
  assert.equal(legacyRoundedDeadline(NTSC60, tenHours), 35_999_997_366_667);
});

test("frame durations and rate validation", () => {
  assert.equal(exactFrameDurationNanos(NTSC60), 16_683_333);
  assert.equal(exactFrameDurationNanos(NTSC30), 33_366_666);
  assert.equal(exactFrameDurationNanos(PAL), 40_000_000);
  assert.equal(exactFrameDurationNanos({ numerator: 0, denominator: 1 }), 0);
  assert.equal(isAeExactRate(undefined), false);
  assert.equal(isAeExactRate({ numerator: 25, denominator: 0 }), false);
  assert.equal(isAeExactRate({ numerator: -25, denominator: 1 }), false);
  assert.equal(isAeExactRate({ numerator: 1.5, denominator: 1 }), false);
});

test("a frame survives a round trip through exact time", () => {
  for (const rate of [NTSC60, NTSC30, PAL]) {
    for (const frame of [0, 1, 2, 7, 215_784, 2_157_842]) {
      const time = programFrameToAeExactTime(frame, rate);
      assert.equal(isAeExactTime(time), true);
      const mapped = aeExactTimeToProgramFrame(time, rate);
      assert.deepEqual(
        mapped,
        { frame, deadlineNanos: exactDeadlineNanos(rate, frame) },
        `frame ${frame} at ${rate.numerator}/${rate.denominator} must survive the round trip`
      );
    }
  }
});

test("a frame from one rate does not silently become a frame at another", () => {
  // Frame 1 at 60000/1001 is half a frame at 30000/1001, so it must refuse rather than land on 0 or 1.
  const atSixty = programFrameToAeExactTime(1, NTSC60);
  assert.equal(aeExactTimeToProgramFrame(atSixty, NTSC30), "NOT_ON_FRAME");
  // Frame 2 at 60000/1001 is exactly frame 1 at 30000/1001, and that is allowed to map.
  assert.deepEqual(aeExactTimeToProgramFrame(programFrameToAeExactTime(2, NTSC60), NTSC30), {
    frame: 1,
    deadlineNanos: 33_366_666
  });
});

test("the constructor accepts bigints and numbers alike", () => {
  assert.deepEqual(aeExactTime(1001n, 30000n), { value: "1001", scale: "30000" });
  assert.deepEqual(aeExactTime(1001, 30000), { value: "1001", scale: "30000" });
});

test("a composition clock only admits positive canonical decimal units", () => {
  assert.equal(isAeCompositionClock({ frameDuration: "800", timeScale: "23976" }), true);

  // A float or number would reintroduce the non-exact time representation this boundary prevents.
  assert.equal(isAeCompositionClock({ frameDuration: 800, timeScale: 23976 }), false);
  assert.equal(isAeCompositionClock({ frameDuration: "800.0", timeScale: "23976" }), false);
  assert.equal(isAeCompositionClock({ frameDuration: "800", timeScale: "23976.0" }), false);
  assert.equal(isAeCompositionClock({ frameDuration: "1e3", timeScale: "23976" }), false);
  assert.equal(isAeCompositionClock({ frameDuration: "800", timeScale: "1e3" }), false);
  assert.equal(isAeCompositionClock({ frameDuration: "-800", timeScale: "23976" }), false);
  assert.equal(isAeCompositionClock({ frameDuration: "800", timeScale: "-23976" }), false);
  assert.equal(isAeCompositionClock({ frameDuration: "0800", timeScale: "23976" }), false);
  assert.equal(isAeCompositionClock({ frameDuration: "800", timeScale: "023976" }), false);
  assert.equal(isAeCompositionClock({ frameDuration: "0", timeScale: "23976" }), false);
  assert.equal(isAeCompositionClock({ frameDuration: "800", timeScale: "0" }), false);
  assert.equal(isAeCompositionClock({ frameDuration: "800" }), false);
  assert.equal(isAeCompositionClock({ timeScale: "23976" }), false);
  assert.equal(isAeCompositionClock(null), false);
});

test("a composition clock exposes its reduced exact rate", () => {
  assert.deepEqual(aeCompositionClockRate({ frameDuration: "800", timeScale: "23976" }), {
    numerator: 2997,
    denominator: 100
  });
  assert.deepEqual(aeCompositionClockRate({ frameDuration: "1001", timeScale: "30000" }), {
    numerator: 30000,
    denominator: 1001
  });
  assert.deepEqual(aeCompositionClockRate({ frameDuration: "1", timeScale: "25" }), {
    numerator: 25,
    denominator: 1
  });
  assert.deepEqual(aeCompositionClock(800, 23976), { frameDuration: "800", timeScale: "23976" });
});

test("rate equality cross-multiplies instead of conflating adjacent NTSC rates", () => {
  assert.equal(aeExactRatesEqual({ numerator: 2997, denominator: 100 }, { numerator: 29970, denominator: 1000 }), true);
  // 29.97 and 29.97003 are different clocks; treating them as equal caused the live SET_TIME failure.
  assert.equal(aeExactRatesEqual({ numerator: 2997, denominator: 100 }, NTSC30), false);
});

test("the BO0a composition refuses its falsely declared rate before any cue can air", () => {
  const lowerThird = { frameDuration: "800", timeScale: "23976" };
  // These are the live-measured AE round trip values in AE-A3-declared-surface.json.
  assert.equal(reconcileAeCompositionClock(lowerThird, NTSC30), "RATE_NOT_IN_COMPOSITION_SCALE");
  assert.deepEqual(reconcileAeCompositionClock(lowerThird, { numerator: 2997, denominator: 100 }), {
    compositionRate: { numerator: 2997, denominator: 100 }
  });
});

test("program frames are stated in the composition's own integer scale", () => {
  const lowerThird = { frameDuration: "800", timeScale: "23976" };
  for (let frame = 0; frame <= 6; frame += 1) {
    // These are the live-measured AE round trip values in AE-A3-declared-surface.json.
    assert.deepEqual(programFrameToAeCompositionTime(frame, lowerThird), {
      value: String(frame * 800),
      scale: "23976"
    });
  }
  assert.equal(programFrameToAeCompositionTime(-1, lowerThird), "INVALID_CLOCK");
});

test("composition-scale restatement refuses instants between its frames", () => {
  const lowerThird = { frameDuration: "800", timeScale: "23976" };
  // These are the live-measured AE round trip values in AE-A3-declared-surface.json.
  assert.equal(aeTimeInCompositionScale({ value: "1001", scale: "30000" }, lowerThird), "NOT_ON_FRAME");
  assert.deepEqual(aeTimeInCompositionScale({ value: "800", scale: "23976" }, lowerThird), {
    time: { value: "800", scale: "23976" },
    compositionFrame: 1
  });
  assert.deepEqual(aeTimeInCompositionScale({ value: "0", scale: "30000" }, lowerThird), {
    time: { value: "0", scale: "23976" },
    compositionFrame: 0
  });
  assert.deepEqual(aeTimeInCompositionScale({ value: "100", scale: "2997" }, lowerThird), {
    time: { value: "800", scale: "23976" },
    compositionFrame: 1
  });
  assert.deepEqual(aeTimeInCompositionScale({ value: "100", scale: "1" }, lowerThird), {
    time: { value: "2397600", scale: "23976" },
    compositionFrame: 2997
  });
  assert.equal(aeTimeInCompositionScale({ value: "1", scale: "1" }, lowerThird), "NOT_ON_FRAME");
});

test("composition mappings emit only canonical integer strings", () => {
  const lowerThird = { frameDuration: "800", timeScale: "23976" };
  const emitted = [
    ...Array.from({ length: 7 }, (_, frame) => programFrameToAeCompositionTime(frame, lowerThird)),
    aeTimeInCompositionScale({ value: "800", scale: "23976" }, lowerThird),
    aeTimeInCompositionScale({ value: "0", scale: "30000" }, lowerThird),
    aeTimeInCompositionScale({ value: "100", scale: "2997" }, lowerThird),
    aeTimeInCompositionScale({ value: "100", scale: "1" }, lowerThird)
  ];
  for (const value of emitted) {
    assert.notEqual(typeof value, "number");
    const time = "time" in value ? value.time : value;
    if ("compositionFrame" in value) assert.equal(Number.isInteger(value.compositionFrame), true);
    assert.equal(isAeExactTime(time), true);
    assert.match(time.value, /^(?:0|[1-9][0-9]*)$/);
    assert.match(time.scale, /^(?:0|[1-9][0-9]*)$/);
  }
});
