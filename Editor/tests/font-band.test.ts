import { describe, expect, it } from "vitest";

import { fontBand, type BandFont } from "../src/font-band";
import { blockingFonts, fontBlockedReason } from "../src/font-manager";

const font = (name: string, status: BandFont["status"] = "missing"): BandFont => ({ fontId: name.toLowerCase().replace(/ /g, "-"), displayName: name, status });

describe("what the band says", () => {
  it("is nothing when no font blocks", () => {
    expect(fontBand([])).toBeUndefined();
  });

  it("names the one font that is missing and says Publish is blocked", () => {
    expect(fontBand([font("Anybody Bold")])).toEqual({
      message: 'Font "Anybody Bold" is missing on this computer. Publish is blocked.',
      firstFontId: "anybody-bold",
    });
  });

  it("says a font that cannot be used for another reason in those words, with the reason", () => {
    expect(fontBand([font("Odd Sans", "invalid")])?.message).toBe('Font "Odd Sans" cannot be used on this computer (invalid). Publish is blocked.');
  });

  it("counts several, names the first three, and says how many more", () => {
    const many = ["A", "B", "C", "D", "E"].map((n) => font(n));
    expect(fontBand(many)?.message).toBe("5 fonts are missing on this computer: A, B, C and 2 more. Publish is blocked.");
    expect(fontBand([font("A"), font("B", "error")])?.message).toBe("2 fonts cannot be used on this computer: A, B. Publish is blocked.");
  });

  it("never says a replacement is on screen: a missing font is not silently replaced", () => {
    for (const blocking of [[font("A")], [font("A"), font("B")], [font("A", "invalid")]]) {
      expect(fontBand(blocking)?.message).not.toMatch(/instead|shown|substitut|widths may differ/i);
    }
  });
});

describe("the fonts that block, one rule for the panel and the band", () => {
  const document = { fonts: [{ fontId: "a", displayName: "A" }, { fontId: "b", displayName: "B" }, { fontId: "c", displayName: "C" }] } as never;

  it("are the fonts the registry could not resolve", () => {
    expect(blockingFonts(document, { unresolvedFontIds: ["b", "zzz"] }).map((f) => f.fontId)).toEqual(["b"]);
    expect(blockingFonts(document, {})).toEqual([]);
  });

  it("are named in the reason a publish gives", () => {
    expect(fontBlockedReason(blockingFonts(document, { unresolvedFontIds: ["a", "c"] }))).toBe("unresolved font(s): A, C");
    expect(fontBlockedReason([])).toBeUndefined();
  });
});
