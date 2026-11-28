// The Library as its own screen (visibility decision of 26 Nov 2026, Figma B13): its tabs, and which panel each shows.

import { describe, expect, it } from "vitest";

import { SCREEN_TABS, screenTab, tabForPanel } from "../src/library-screen";

describe("the Library screen's tabs", () => {
  it("are the library's seven tabs in the design's order", () => {
    expect(SCREEN_TABS.map((tab) => tab.label)).toEqual(["Assets", "Colours", "Layer styles", "Text styles", "Fonts", "Effects & Presets", "Materials"]);
  });

  it("show the Assets panel for its three tabs and each other panel for its own", () => {
    expect(SCREEN_TABS.map((tab) => [tab.id, tab.panel, tab.libraryTab])).toEqual([
      ["assets", "assets", "assets"],
      ["colours", "assets", "colours"],
      ["layer-styles", "assets", "layer-styles"],
      ["text-styles", "text-styles", undefined],
      ["fonts", "fonts", undefined],
      ["effects", "effects", undefined],
      ["materials", "materials", undefined],
    ]);
  });

  it("fall back to Assets for an unknown tab", () => {
    expect(screenTab("fonts").id).toBe("fonts");
    expect(screenTab("nope").id).toBe("assets");
    expect(screenTab(undefined).id).toBe("assets");
  });

  it("open where the person already was: the panel's tab, or the Assets panel's own", () => {
    expect(tabForPanel("fonts", "assets")).toBe("fonts");
    expect(tabForPanel("effects", "assets")).toBe("effects");
    expect(tabForPanel("assets", "colours")).toBe("colours");
    expect(tabForPanel("assets", "layer-styles")).toBe("layer-styles");
    expect(tabForPanel("assets", "weird")).toBe("assets");
    expect(tabForPanel("timeline", "assets")).toBeUndefined();
  });
});

import { DATA_TABS, dataTab } from "../src/library-screen";

describe("the Data screen's tabs", () => {
  it("are Data, Template controls, Take page and Publish, each showing its own panel", () => {
    expect(DATA_TABS.map((tab) => [tab.label, tab.panel])).toEqual([
      ["Data", "bindings"],
      ["Template controls", "control-contract"],
      ["Take page", "take-page"],
      ["Publish", "publish"],
    ]);
    for (const tab of DATA_TABS) expect(tab.id).toBe(tab.panel);
  });

  it("fall back to Data for an unknown tab", () => {
    expect(dataTab("publish").id).toBe("publish");
    expect(dataTab("nope").id).toBe("bindings");
    expect(dataTab(undefined).id).toBe("bindings");
  });
});
