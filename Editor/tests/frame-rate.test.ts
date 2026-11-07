// Frame-rate choices carry exact rationals (invariant 12); a decimal is
// refused with the rational it should be, never rounded into a drifting rate.

import { describe, expect, it } from "vitest";

import { BROADCAST_RATES, parseRateChoice, rateKey } from "../src/frame-rate";
import { formatRate, formatTimecode, framesPerTimecodeSecond } from "../src/timeline/clock";

describe("broadcast frame rates", () => {
  it("offers the NTSC rates as exact rationals", () => {
    const by = Object.fromEntries(BROADCAST_RATES.map((entry) => [entry.label, entry.rate]));
    expect(by["29.97 fps (NTSC)"]).toEqual({ num: 30000, den: 1001 });
    expect(by["59.94 fps (NTSC progressive)"]).toEqual({ num: 60000, den: 1001 });
    expect(by["60 fps"]).toEqual({ num: 60, den: 1 });
  });

  it("maps a document's rate back to its choice, and anything else to custom", () => {
    expect(rateKey({ num: 30000, den: 1001 })).toBe("30000/1001");
    expect(rateKey({ num: 60, den: 1 })).toBe("60/1");
    expect(rateKey({ num: 48, den: 1 })).toBe("custom");
  });

  it("reads a named choice or a custom whole-number ratio", () => {
    expect(parseRateChoice("60000/1001", "", "")).toEqual({ ok: true, rate: { num: 60000, den: 1001 } });
    expect(parseRateChoice("custom", "48", "1")).toEqual({ ok: true, rate: { num: 48, den: 1 } });
    expect(parseRateChoice("custom", " 24000 ", "1001")).toEqual({ ok: true, rate: { num: 24000, den: 1001 } });
  });

  it("refuses a decimal, naming the rational it should be, and refuses zero", () => {
    expect(parseRateChoice("custom", "29.97", "1")).toEqual({
      ok: false,
      refused: "a frame rate is a whole-number ratio, not 29.97 (29.97 is 30000/1001)",
    });
    expect(parseRateChoice("custom", "59.94", "1")).toEqual({
      ok: false,
      refused: "a frame rate is a whole-number ratio, not 59.94 (59.94 is 60000/1001)",
    });
    expect(parseRateChoice("custom", "0", "1")).toEqual({ ok: false, refused: "invalid rate: 0/1" });
    expect(parseRateChoice("custom", "30", "0")).toEqual({ ok: false, refused: "invalid rate: 30/0" });
    expect(parseRateChoice("custom", "thirty", "1").ok).toBe(false);
  });
});

describe("the clock at NTSC rates", () => {
  it("counts 30 labelled frames per timecode second at 29.97 and 60 at 59.94", () => {
    const p2997 = { num: 30000, den: 1001 };
    const p5994 = { num: 60000, den: 1001 };
    expect(framesPerTimecodeSecond(p2997)).toBe(30);
    expect(framesPerTimecodeSecond(p5994)).toBe(60);
    expect(formatTimecode(30, p2997)).toBe("0:00:01:00");
    expect(formatTimecode(29, p2997)).toBe("0:00:00:29");
    expect(formatTimecode(119, p5994)).toBe("0:00:01:59");
    expect(formatRate(p2997)).toBe("29.97 fps NDF");
    expect(formatRate(p5994)).toBe("59.94 fps NDF");
    expect(formatRate({ num: 60, den: 1 })).toBe("60 fps");
  });
});
