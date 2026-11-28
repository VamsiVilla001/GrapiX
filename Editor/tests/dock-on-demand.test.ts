// The dock panels that are on demand (visibility decision of 26 Nov 2026): which are hidden for which tool, selection and opened set,
// which tab a group shows when its active one is hidden, and going back to Properties.

import { describe, expect, it } from "vitest";

import { CONTEXT_PANELS, OPENED_ONLY_PANELS, afterTab, hiddenPanels, sectionsUnder, shownTab, type OnDemandInput } from "../src/dock-on-demand";

const base: OnDemandInput = { tool: "select", selectionHasMasks: false, selectionHasEffects: false, penMakesMask: false, opened: new Set() };
const hidden = (extra: Partial<OnDemandInput> = {}) => hiddenPanels({ ...base, ...extra });

describe("what is hidden", () => {
  it("hides every on-demand panel when nothing calls for one, and never Properties, Animation, Elements or the Timeline", () => {
    expect([...hidden()].sort()).toEqual([...CONTEXT_PANELS, ...OPENED_ONLY_PANELS].sort());
    for (const always of ["inspector", "object-manager", "timeline", "viewport", "assets"]) expect(hidden().has(always), always).toBe(false);
  });

  it("shows Pivot while the Pivot tool is in use", () => {
    expect(hidden({ tool: "pivot" }).has("pivot")).toBe(false);
    expect(hidden({ tool: "move" }).has("pivot")).toBe(true);
  });

  it("shows Masks when a selected element has masks, or while the Pen or a path tool is about to make a mask", () => {
    expect(hidden({ selectionHasMasks: true }).has("masks")).toBe(false);
    expect(hidden({ tool: "pen", penMakesMask: true }).has("masks")).toBe(false);
    expect(hidden({ tool: "path", penMakesMask: true }).has("masks")).toBe(false);
    expect(hidden({ tool: "pen", penMakesMask: false }).has("masks")).toBe(true);
    expect(hidden({ tool: "select", penMakesMask: true }).has("masks")).toBe(true);
  });

  it("shows Effect Controls when a selected element has effects", () => {
    expect(hidden({ selectionHasEffects: true }).has("effect-controls")).toBe(false);
    expect(hidden({ selectionHasMasks: true }).has("effect-controls")).toBe(true);
  });

  it("shows any of them when the person opens it", () => {
    for (const panel of [...CONTEXT_PANELS, ...OPENED_ONLY_PANELS]) expect(hidden({ opened: new Set([panel]) }).has(panel), panel).toBe(false);
  });
});

describe("the tab a group shows", () => {
  const members = ["inspector", "pivot", "masks", "animation"];
  it("is the active one when it is shown, else the first member that is not hidden, else none", () => {
    expect(shownTab(members, "masks", new Set())).toBe("masks");
    expect(shownTab(members, "masks", new Set(["masks"]))).toBe("inspector");
    expect(shownTab(members, "inspector", new Set(["inspector", "pivot"]))).toBe("masks");
    expect(shownTab(members, "pivot", new Set(members))).toBeUndefined();
  });
});

describe("going back to Properties", () => {
  it("puts away the opened panels of its group, and keeps the rest", () => {
    const opened = new Set(["fonts", "pivot", "effects"]);
    expect([...afterTab(opened, "inspector", ["inspector", "pivot", "fonts"])].sort()).toEqual(["effects"]);
    expect([...afterTab(opened, "fonts", ["inspector", "pivot", "fonts"])].sort()).toEqual(["effects", "fonts", "pivot"]);
  });
});

describe("Properties as one list (Figma B3d v2)", () => {
  const members = ["inspector", "pivot", "masks", "animation", "effect-controls", "text-styles", "fonts"];

  it("waits on the Animation panel: its diamonds are on the Properties rows and Auto-key is in the bar", () => {
    expect(hidden().has("animation")).toBe(true);
    expect(hidden({ opened: new Set(["animation"]) }).has("animation")).toBe(false);
  });

  it("stands the called-for context panels under Properties, in the group's order", () => {
    expect(sectionsUnder(members, "inspector", new Set(["pivot", "animation", "text-styles", "fonts"]))).toEqual(["masks", "effect-controls"]);
    expect(sectionsUnder(members, "inspector", new Set(["masks", "effect-controls", "animation", "text-styles", "fonts"]))).toEqual(["pivot"]);
  });

  it("never stands an opened library panel or the Animation panel there, and draws none while another tab is shown", () => {
    expect(sectionsUnder(members, "inspector", new Set())).toEqual(["pivot", "masks", "effect-controls"]);
    expect(sectionsUnder(members, "fonts", new Set())).toEqual([]);
    expect(sectionsUnder(members, undefined, new Set())).toEqual([]);
  });
});
