// Phase bands over the timeline (11.25).
//
// Rust owns whether a phase is legal; these guard the pixel side — that a band
// spanning the visible range is drawn across it rather than dropped, that a
// click below the strip is not treated as a phase click, and that the address
// format matches the one Rust computes.

import { describe, expect, it } from "vitest";

import type { TimelinePhase } from "@grapix/contracts";
import {
  phaseAddress,
  phaseAtPoint,
  phaseBands,
  phaseSummary,
  PHASE_BAND_HEIGHT,
} from "../src/timeline/phases";
import { DEFAULT_ROW_HEIGHT, type TimelineViewport } from "../src/timeline/viewport";

const viewport: TimelineViewport = {
  startFrame: 0,
  pixelsPerFrame: 4,
  width: 400,
  height: 200,
  scrollTop: 0,
  rowHeight: DEFAULT_ROW_HEIGHT,
};

function phase(
  kind: TimelinePhase["kind"],
  startFrame: number,
  endFrame: number,
  name?: string,
): TimelinePhase {
  return {
    kind,
    ...(name === undefined ? {} : { name }),
    startFrame: startFrame as unknown as bigint,
    endFrame: endFrame as unknown as bigint,
  };
}

describe("phase addressing", () => {
  it("matches the address Rust computes", () => {
    // `TimelinePhase::address` in Rust is the one place the format is decided.
    // If these disagree, a click here edits a different phase than the author
    // pointed at.
    expect(phaseAddress(phase("in", 0, 10))).toBe("in");
    expect(phaseAddress(phase("continue", 0, 10, "score"))).toBe("continue:score");
  });
});

describe("phase bands", () => {
  it("positions a band across the frames it covers", () => {
    const [band] = phaseBands([phase("in", 10, 30)], viewport);
    expect(band).toMatchObject({ x: 40, width: 80, address: "in" });
  });

  it("clips a band that begins before the visible range rather than dropping it", () => {
    // A take-out starting off-screen still occupies the frames on screen.
    // Showing nothing there would misreport what the scene does.
    const scrolled: TimelineViewport = { ...viewport, startFrame: 20 };
    const [band] = phaseBands([phase("out", 0, 40)], scrolled);
    expect(band?.x).toBe(0);
    expect(band?.width).toBe(80);
  });

  it("omits a band entirely outside the visible range", () => {
    const scrolled: TimelineViewport = { ...viewport, startFrame: 500 };
    expect(phaseBands([phase("in", 0, 40)], scrolled)).toEqual([]);
  });

  it("keeps every phase addressable, including several continues", () => {
    const bands = phaseBands(
      [phase("continue", 0, 10, "stat"), phase("continue", 10, 20, "score")],
      viewport,
    );
    expect(bands.map((band) => band.address)).toEqual(["continue:stat", "continue:score"]);
  });
});

describe("hit testing the strip", () => {
  const bands = phaseBands([phase("in", 0, 20), phase("out", 40, 60)], viewport);

  it("finds the band under a point inside the strip", () => {
    expect(phaseAtPoint(bands, 10, 4)?.address).toBe("in");
    expect(phaseAtPoint(bands, 170, 4)?.address).toBe("out");
  });

  it("reports nothing in the gap between two phases", () => {
    // Phases need not tile the timeline; an unnamed frame is genuinely unnamed.
    expect(phaseAtPoint(bands, 120, 4)).toBeUndefined();
  });

  it("does not treat a click on a key row as a click on a phase", () => {
    // Otherwise selecting a key would silently retarget a phase edit.
    expect(phaseAtPoint(bands, 10, PHASE_BAND_HEIGHT + 20)).toBeUndefined();
  });
});

describe("the sentence an author reads", () => {
  it("reports frames first and derives milliseconds from the exact rate", () => {
    // 20 frames at 50/1 is 400 ms. Derived from the rational rate, never a
    // rounded fps (invariant 12).
    expect(phaseSummary(phase("in", 10, 30), { num: 50, den: 1 })).toBe(
      "in: frames 10–30 (20 frames, 400 ms)",
    );
  });

  it("stays exact at a non-integer rate", () => {
    // 30000/1001 is 29.97 and cannot be written as a float. 30 frames is
    // 1001 ms exactly.
    expect(phaseSummary(phase("out", 0, 30), { num: 30000, den: 1001 })).toContain("1001 ms");
  });
});
