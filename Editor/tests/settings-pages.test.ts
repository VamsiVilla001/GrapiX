// Plan row 11.81 (Figma E4): which pages the Settings nav lists, and that a page that is not built says so.
import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS_PAGE, SETTINGS_PAGES, resolvePage, settingsPage, waitingLine } from "../src/settings-pages";

describe("the nav", () => {
  it("lists General and Shortcuts as built and AI and MCP access as waiting", () => {
    expect(SETTINGS_PAGES.map((page) => [page.id, page.label, page.live])).toEqual([
      ["general", "General", true],
      ["shortcuts", "Shortcuts", true],
      ["ai", "AI and MCP access", false],
    ]);
  });

  it("has unique ids, and General is the page shown first", () => {
    expect(new Set(SETTINGS_PAGES.map((page) => page.id)).size).toBe(SETTINGS_PAGES.length);
    expect(DEFAULT_SETTINGS_PAGE).toBe("general");
    expect(SETTINGS_PAGES[0]?.id).toBe(DEFAULT_SETTINGS_PAGE);
  });

  it("draws no page that has no content: the Figma nav's Colour and Help pages and the spec's other sections wait for rows", () => {
    const labels = SETTINGS_PAGES.map((page) => page.label.toLowerCase()).join(" ");
    for (const word of ["colour", "diagnostics", "viewport", "timeline", "import", "fonts", "cache", "language"]) expect(labels).not.toContain(word);
  });
});

describe("a page that is not built", () => {
  const ai = settingsPage("ai");

  it("names the row that builds it and says what it waits for, in words, without a role the contracts do not have", () => {
    expect(ai?.rows).toEqual(["8.14"]);
    expect(waitingLine(ai!)).toBe("Not built yet (row 8.14).");
    expect(ai?.waitsFor).toContain("no role can cue, take out, clear or change what is on air");
    expect(ai?.waitsFor).toContain("not decided yet");
  });

  it("gives a built page no waiting line", () => {
    expect(waitingLine(settingsPage("general")!)).toBe("");
    expect(waitingLine(settingsPage("shortcuts")!)).toBe("");
  });
});

describe("resolving a page", () => {
  it("is the page asked for, and General for anything that is not one", () => {
    expect(resolvePage("shortcuts").id).toBe("shortcuts");
    expect(resolvePage("ai").id).toBe("ai");
    expect(resolvePage("nonsense").id).toBe("general");
    expect(resolvePage("").id).toBe("general");
    expect(resolvePage(undefined).id).toBe("general");
    expect(settingsPage("nonsense")).toBeUndefined();
  });
});
