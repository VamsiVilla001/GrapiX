// The playhead handle sits in the ruler's track, and the track must start where the ruler's tick area starts. The label columns have two widths
// (240 px with the layer columns off, 570 px with them on) and the track was left at 240 for both, so with the columns on the handle was drawn
// 330 px left of its line, over the Parent column. The widths are in the stylesheet, so the stylesheet is what is held to agree.

import { describe, expect, it } from "vitest";

// Vitest hands a stylesheet import back empty, so the file is read from disk. The specifier is a variable so the tests' own TypeScript project, which has no Node types, still compiles.
const nodeFs = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync: (path: URL, encoding: "utf8") => string };
const css = readFileSync(new URL("../web/style.css", import.meta.url), "utf8");

/** The text between the braces of the first rule whose selector is exactly `selector` (the rule starts a line). */
function body(selector: string): string {
  const start = css.split("\n").findIndex((line: string) => line.startsWith(`${selector} {`));
  expect(start, `a rule for ${selector}`).toBeGreaterThanOrEqual(0);
  const line = css.split("\n")[start]!;
  return line.slice(line.indexOf("{") + 1, line.lastIndexOf("}"));
}

/** The pixels a property is given in a rule body: `left: 240px` gives 240. */
function px(rule: string, property: string): number {
  const at = rule.indexOf(`${property}:`);
  expect(at, `${property} in ${rule}`).toBeGreaterThanOrEqual(0);
  const found = /(\d+)px/.exec(rule.slice(at));
  expect(found).not.toBeNull();
  return Number(found![1]);
}

describe("the playhead's track starts where the ruler's ticks do", () => {
  it("at the label column's width with the layer columns off", () => {
    expect(px(body(".timeline-ruler-track"), "left")).toBe(px(body(".timeline-ruler"), "grid-template-columns"));
  });

  it("at the label column's width with the layer columns on", () => {
    const on = body('.timeline-bar[data-columns="on"] .timeline, .timeline-bar[data-columns="on"] .timeline-ruler');
    expect(px(body('.timeline-bar[data-columns="on"] .timeline-ruler-track'), "left")).toBe(px(on, "grid-template-columns"));
  });

  it("with the Parent, Blend and Matte columns adding up to the wider label width", () => {
    const sum = ["parent", "blend", "matte"].map((name) => px(body(`.timeline-ruler .layer-column-heading .tl-col-${name}`), "width")).reduce((a, b) => a + b, 0);
    expect(240 + sum).toBe(570);
  });
});
