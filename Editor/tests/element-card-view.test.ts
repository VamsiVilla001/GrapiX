import { describe, expect, it } from "vitest";

import { cardPlaceholder } from "../src/element-card-view";

describe("what the card area says when there is no single element", () => {
  it("asks for a selection, or for one element", () => {
    expect(cardPlaceholder(0)).toBe("Select an element to see its style, motion and data.");
    expect(cardPlaceholder(3)).toBe("3 elements are selected. Select one to see its card.");
  });
});

describe("the card's Data block", () => {
  it("has an Open Data button that opens the Data screen", async () => {
    const nodeFs = "node:fs";
    const fs = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync(path: URL, encoding: string): string };
    const view = fs.readFileSync(new URL("../src/element-card-view.ts", import.meta.url), "utf8");
    const main = fs.readFileSync(new URL("../web/main.ts", import.meta.url), "utf8");
    expect(view).toContain('"Open Data"');
    expect(view).toMatch(/section\.id === "data"[\s\S]{0,300}handlers\.openData/);
    expect(main).toContain("openData: () => openDataScreen()");
  });
});
