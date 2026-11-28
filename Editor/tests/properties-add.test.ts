// The Add row at the foot of Properties (Figma B3d v2; Jev, 26 Nov 2026): what it offers and when it can be used.

import { describe, expect, it } from "vitest";

import { ADD_ROW, addRowBlocker } from "../src/properties-add";

describe("the Add row of Properties", () => {
  it("offers an effect, a mask and the pivot, in that order", () => {
    expect(ADD_ROW.map((button) => [button.kind, button.label])).toEqual([
      ["effect", "+ Effect"],
      ["mask", "+ Mask"],
      ["pivot", "Pivot"],
    ]);
    for (const button of ADD_ROW) expect(button.hint.length, button.kind).toBeGreaterThan(10);
  });

  it("is dimmed with its reason until an element is selected", () => {
    expect(addRowBlocker(0)).toBe("Select an element first");
    expect(addRowBlocker(1)).toBeUndefined();
    expect(addRowBlocker(3)).toBeUndefined();
  });
});
