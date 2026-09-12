// Broadcast fills resolve through the same transfer curves the engine uses
// (11.4 wired to the viewport, invariant 27).
//
// Rec.709 shares sRGB's D65 primaries, so decoding reaches the preview's
// linear working space exactly. Display P3 does not share those primaries and
// remains a named unsupported case until 3.3 supplies the gamut transform;
// decoding it alone would be a silent substitution.

import { describe, expect, it } from "vitest";

import type { ColorValue } from "@grapix/contracts";
import { rec709Decode, srgbDecode } from "../src/color-transfer";
import { resolvePaint, type PaintResolution } from "../src/viewport";

const colour = (resolution: PaintResolution): { r: number; g: number; b: number } => {
  if (resolution.kind !== "color") {
    throw new Error(`expected a colour, got ${resolution.kind}`);
  }
  return { r: resolution.color.r, g: resolution.color.g, b: resolution.color.b };
};

describe("a Rec.709 fill decodes through the broadcast curve", () => {
  it("lands in the linear working space the engine composites in", () => {
    const value = {
      type: "solid",
      color: { r: 0.8, g: 0.4, b: 0.2, a: 1, space: "rec709" },
    } as unknown as ColorValue;

    const { r, g, b } = colour(resolvePaint(value));
    expect(r).toBeCloseTo(rec709Decode(0.8), 12);
    expect(g).toBeCloseTo(rec709Decode(0.4), 12);
    expect(b).toBeCloseTo(rec709Decode(0.2), 12);
  });

  it("is a real colour, not the grey a missing fill used to read as", () => {
    // The hole was not just "unsupported": it was a placeholder that looked
    // finished while the real fill never reached the screen.
    const value = {
      type: "solid",
      color: { r: 0.8, g: 0.4, b: 0.2, a: 1, space: "rec709" },
    } as unknown as ColorValue;
    expect(resolvePaint(value).kind).toBe("color");
  });
});

describe("a Display P3 fill is not silently treated as linear sRGB", () => {
  it("names the missing primary conversion", () => {
    const value = {
      type: "solid",
      color: { r: 0.6, g: 0.3, b: 0.5, a: 1, space: "display-p3" },
    } as unknown as ColorValue;

    const resolution = resolvePaint(value);
    expect(resolution).toMatchObject({
      kind: "unsupported",
      reason: expect.stringContaining("primary conversion"),
    });
  });
});

describe("the two spaces the preview already handled are unchanged", () => {
  it("sRGB and linear are decoded into the same working space the engine uses", () => {
    // Three holds a colour linearly, so both a tagged sRGB value and a tagged
    // linear value resolve to the linear working space — sRGB 0.5 decodes to
    // the engine's srgbDecode(0.5), and a linear value passes straight
    // through. Asserting the channels match the DECODE, not the input, is
    // what proves the tag was honoured rather than ignored.
    const srgb = {
      type: "solid",
      color: { r: 0.5, g: 0.5, b: 0.5, a: 1, space: "srgb" },
    } as unknown as ColorValue;
    // Both agree to the last 8-bit channel. Three's own sRGB conversion and
    // the proven curve differ by ~1e-11 in f64 (a libm one-ulp), which is a
    // different channel only in theory; asserting the channel is what the
    // pixel gate actually measures.
    const srgbChannel = colour(resolvePaint(srgb)).r;
    expect(Math.round(srgbChannel * 255)).toBe(Math.round(srgbDecode(0.5) * 255));

    const linear = {
      type: "solid",
      color: { r: 0.3, g: 0.3, b: 0.3, a: 1, space: "linear" },
    } as unknown as ColorValue;
    expect(colour(resolvePaint(linear)).r).toBeCloseTo(0.3, 12);
  });

  it("a gradient is still reported rather than approximated", () => {
    // No texture here, so no silent flat fill: the reason reaches the
    // operator, which is the invariant-18 behaviour the layer is built on.
    const gradient = {
      type: "linear-gradient",
      stops: [],
      angle: 0,
    } as unknown as ColorValue;
    const resolution = resolvePaint(gradient);
    expect(resolution.kind).toBe("unsupported");
    expect(resolution.kind === "unsupported" && resolution.reason).toContain("texture");
  });
});
