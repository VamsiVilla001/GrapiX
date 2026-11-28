import { describe, expect, it } from "vitest";

import { contextLine, frameRateText } from "../src/context-line";

const scene = (over: Record<string, unknown> = {}) =>
  ({
    name: "Final Four L3",
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    colorDepth: "32",
    workingColorSpace: "srgb",
    ...over,
  }) as unknown as Parameters<typeof contextLine>[0];

describe("the context line", () => {
  it("says what is open: name, Scene ID, size, rate, depth and colour space", () => {
    expect(contextLine(scene({ sceneLabel: "1" }))).toBe("Final Four L3 · Scene ID 1 · 1920×1080 · 50 fps · 32 bit · sRGB");
  });

  it("leaves out a Scene ID nobody has set, and says when nothing is open", () => {
    expect(contextLine(scene())).toBe("Final Four L3 · 1920×1080 · 50 fps · 32 bit · sRGB");
    expect(contextLine(scene({ sceneLabel: "" }))).not.toContain("Scene ID");
    expect(contextLine(undefined)).toBe("No scene open");
  });

  it("names a scene with no name and writes the linear space in words", () => {
    expect(contextLine(scene({ name: "   " }))).toMatch(/^Untitled · /);
    expect(contextLine(scene({ workingColorSpace: "linear-srgb", colorDepth: "16" }))).toMatch(/16 bit · Linear sRGB$/);
  });

  it("does not claim a scan: no p, no i", () => {
    expect(contextLine(scene())).not.toMatch(/\d(p|i)\d/);
  });
});

describe("a frame rate as a person writes it", () => {
  it("is whole when it is whole and two places when it is not", () => {
    expect(frameRateText({ num: 50, den: 1 })).toBe("50");
    expect(frameRateText({ num: 30000, den: 1001 })).toBe("29.97");
    expect(frameRateText({ num: 60000, den: 1001 })).toBe("59.94");
    expect(frameRateText({ num: 25, den: 1 })).toBe("25");
  });

  it("is a question mark, not a number, for a rate that is not one", () => {
    expect(frameRateText({ num: 25, den: 0 })).toBe("?");
    expect(frameRateText({ num: Number.NaN, den: 1 })).toBe("?");
  });
});
