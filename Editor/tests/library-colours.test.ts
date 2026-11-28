// The Library's Colours tab (Figma B13; row 11.122): reading and writing a colour, what a swatch says, what Apply and New can do with the selection, and the tab
// inside the Library panel. A library colour is applied by copy, so use is counted by exact match in the open graphic.

import { describe, expect, it } from "vitest";

import type { LibraryColour, Rgba, SceneDocument, SceneObject } from "@grapix/contracts";
import { agentView, findNode, renderNode } from "../src/agent-surface";
import { libraryPanel } from "../src/library";
import {
  COLOURS_NEED_PROJECT,
  COLOURS_NOTE,
  applyBlocker,
  colourUse,
  colourWords,
  coloursNodes,
  fillBlocker,
  parseHex,
  swatchCss,
} from "../src/library-colours";

const rgba = (r: number, g: number, b: number, a = 1, space: Rgba["space"] = "srgb"): Rgba => ({ r, g, b, a, space });
const red = rgba(224 / 255, 32 / 255, 32 / 255);
const colour = (id: string, name: string, value: Rgba): LibraryColour => ({ id, name, color: value });

const base = (id: string): Record<string, unknown> => ({
  id,
  name: id,
  visible: true,
  locked: false,
  opacity: 1,
  x: 0,
  y: 0,
  zDepth: 0,
  zIndex: 0,
  layerId: "",
  width: 10,
  height: 10,
  rotation: 0,
  rotationX: 0,
  rotationY: 0,
  scaleX: 1,
  scaleY: 1,
  scaleZ: 1,
  strokeWidth: 0,
});
const rect = (id: string, extra: Record<string, unknown> = {}): SceneObject => ({ type: "rect", ...base(id), radius: 0, ...extra }) as unknown as SceneObject;
const solid = (value: Rgba) => ({ type: "solid", color: value });
const scene = (objects: SceneObject[]): SceneDocument =>
  ({ id: "s", name: "S", version: 1, objects, assets: [], fonts: [], materials: [], timeline: { durationFrames: 1 } }) as unknown as SceneDocument;

describe("a hex colour", () => {
  it("reads #RRGGBB as sRGB, with or without the #, in either case", () => {
    expect(parseHex("#E02020")).toEqual({ colour: red });
    expect(parseHex("e02020")).toEqual({ colour: red });
    expect(parseHex("  #e02020  ")).toEqual({ colour: red });
  });

  it("reads #RGB by doubling each digit, and #RRGGBBAA with an alpha", () => {
    expect(parseHex("#fa0")).toEqual({ colour: rgba(1, 170 / 255, 0) });
    expect(parseHex("#000000")).toEqual({ colour: rgba(0, 0, 0) });
    expect(parseHex("#FFFFFF80")).toEqual({ colour: rgba(1, 1, 1, 128 / 255) });
  });

  it("refuses what is not a hex colour, saying how to write one", () => {
    for (const bad of ["", "#", "#12", "#1234", "#12345", "#1234567", "#12345678F", "#GGGGGG", "red", "# E02020"]) {
      const result = parseHex(bad);
      expect("refused" in result, bad).toBe(true);
      expect((result as { refused: string }).refused).toContain("write #RGB, #RRGGBB or #RRGGBBAA");
    }
  });
});

describe("what a colour says for itself", () => {
  it("is hex for an sRGB colour in range, with the alpha only when it is below 1", () => {
    expect(colourWords(red)).toBe("#E02020");
    expect(colourWords(rgba(0, 0, 0))).toBe("#000000");
    expect(colourWords(rgba(1, 1, 1, 128 / 255))).toBe("#FFFFFF80");
  });

  it("is the numbers and the space for anything else: another space, or a value outside 0 to 1", () => {
    expect(colourWords(rgba(1, 0, 0, 1, "display-p3"))).toBe("1 0 0 · display-p3");
    expect(colourWords(rgba(0.12345, 0.5, 0.25, 0.5, "linear"))).toBe("0.123 0.5 0.25 · alpha 0.5 · linear");
    expect(colourWords(rgba(4, 0, 0))).toBe("4 0 0 · srgb");
    expect(colourWords(rgba(-0.1, 0, 0))).toBe("-0.1 0 0 · srgb");
  });

  it("is drawn as itself only in sRGB, and never guessed at in another space", () => {
    expect(swatchCss(red)).toBe("rgba(224, 32, 32, 1)");
    expect(swatchCss(rgba(1, 1, 1, 0.5))).toBe("rgba(255, 255, 255, 0.5)");
    expect(swatchCss(rgba(4, -1, 0))).toBe("rgba(255, 0, 0, 1)");
    expect(swatchCss(rgba(1, 0, 0, 1, "display-p3"))).toBeUndefined();
  });
});

describe("where a colour is used in the open graphic", () => {
  it("counts the fills and strokes that have exactly this colour", () => {
    const document = scene([
      rect("a", { fill: solid(red) }),
      rect("b", { fill: solid(red), stroke: solid(red) }),
      rect("c", { stroke: solid(red) }),
      rect("d", { fill: solid(rgba(224 / 255, 32 / 255, 33 / 255)) }),
    ]);
    expect(colourUse(document, red)).toEqual({ fills: 2, strokes: 2 });
  });

  it("does not count the same numbers in another colour space, a gradient, or no paint", () => {
    const document = scene([
      rect("a", { fill: solid({ ...red, space: "display-p3" }) }),
      rect("b", { fill: { type: "linear-gradient", angle: 0, startX: 0, startY: 0, endX: 1, endY: 0, stops: [] } }),
      rect("c", { fill: { type: "none" } }),
      rect("d"),
      // A paint of a kind this build does not know is not a solid colour, even if it carries one.
      rect("e", { fill: { type: "pattern", color: red } }),
    ]);
    expect(colourUse(document, red)).toEqual({ fills: 0, strokes: 0 });
  });
});

describe("what Apply can do to the selection", () => {
  const document = scene([rect("a"), { type: "line", ...base("l") } as unknown as SceneObject, { type: "group", ...base("g"), childIds: [] } as unknown as SceneObject, rect("b")]);

  it("needs an object selected", () => {
    expect(applyBlocker(document, [], "fill")).toBe("select an object first");
    expect(applyBlocker(document, ["gone"], "stroke")).toBe("select an object first");
  });

  it("is possible for kinds that draw the paint, and says which kind does not", () => {
    expect(applyBlocker(document, ["a", "b"], "fill")).toBeUndefined();
    expect(applyBlocker(document, ["a", "l"], "stroke")).toBeUndefined();
    expect(applyBlocker(document, ["l"], "fill")).toBe("a fill is not drawn by line");
    expect(applyBlocker(document, ["a", "g"], "stroke")).toBe("a stroke is not drawn by group");
  });
});

describe("what a colour can be made from", () => {
  it("is one object with a solid fill", () => {
    const document = scene([rect("a", { fill: solid(red) }), rect("b", { fill: solid(red) }), rect("n"), rect("none", { fill: { type: "none" } }), rect("grad", { fill: { type: "linear-gradient", angle: 0, startX: 0, startY: 0, endX: 1, endY: 0, stops: [] } })]);
    expect(fillBlocker(document, ["a"])).toBeUndefined();
    expect(fillBlocker(document, [])).toBe("select an object whose fill to keep");
    expect(fillBlocker(document, ["a", "b"])).toBe("select one object: a colour is made from one fill");
    expect(fillBlocker(document, ["n"])).toBe("n has no fill");
    expect(fillBlocker(document, ["none"])).toBe("none has no fill");
    expect(fillBlocker(document, ["grad"])).toBe("grad has a gradient fill: only a solid colour can be kept");
  });
});

describe("the Colours tab", () => {
  const document = scene([rect("a", { fill: solid(red) }), rect("b")]);
  const colours = [colour("colour-1", "Team red", red), colour("colour-2", "P3 red", rgba(1, 0, 0, 1, "display-p3"))];
  const nodes = (extra: Record<string, unknown> = {}) => coloursNodes(document, { project: true, colours, ...extra });
  const wrap = (children: ReturnType<typeof nodes>) => ({ id: "root", role: "region" as const, label: "root", children });

  it("says why there are no colours when the graphic is not in a project, and offers nothing that would not work", () => {
    const [list] = coloursNodes(document, { project: false });
    expect(list!.description).toBe(COLOURS_NEED_PROJECT);
    expect(list!.actions!.map((a) => [a.name, a.unavailable])).toEqual([["newColourFromFill", COLOURS_NEED_PROJECT], ["newColourHex", COLOURS_NEED_PROJECT]]);
  });

  it("says they are being read, or why they could not be", () => {
    expect(coloursNodes(document, { project: true })[0]!.description).toBe("reading the project's colours…");
    expect(coloursNodes(document, { project: true, coloursProblem: "the project's colours could not be read: disk error" })[0]!.description).toContain("disk error");
    expect(coloursNodes(document, { project: true })[0]!.actions!.every((a) => a.unavailable === "the project's colours have not been read")).toBe(true);
  });

  it("says when there are none yet, and how to make one", () => {
    const [list] = coloursNodes(document, { project: true, colours: [] });
    expect(list!.description).toBe("no colours yet: make one from a fill, or type a hex value");
  });

  it("lists each colour with its words, a swatch where one can be drawn, and which is selected", () => {
    const [list] = nodes({ selectedColourId: "colour-2" });
    expect(list!.description).toBe("2 colours");
    expect(list!.children!.map((c) => [c.label, c.value, c.swatch, c.selected])).toEqual([
      ["Team red", "#E02020", "rgba(224, 32, 32, 1)", false],
      ["P3 red", "1 0 0 · display-p3", undefined, true],
    ]);
    expect(list!.children![0]!.actions).toEqual([{ name: "colour", label: "Team red · #E02020" }]);
  });

  it("makes a colour from the selected fill or from hex, the first dimmed with the reason when nothing selected has a fill", () => {
    const withFill = nodes({ selectedObjectIds: ["a"] })[0]!.actions!;
    expect(withFill.map((a) => [a.name, a.label, a.unavailable])).toEqual([["newColourFromFill", "+ From selected fill", undefined], ["newColourHex", "+ New colour…", undefined]]);
    const without = nodes({ selectedObjectIds: ["b"] })[0]!.actions!;
    expect(without[0]!.unavailable).toBe("b has no fill");
    expect(without[1]!.unavailable).toBeUndefined();
    expect(nodes()[0]!.actions![0]!.unavailable).toBe("select an object whose fill to keep");
  });

  it("shows no card until a colour is selected, then its words, its space and how many objects have it", () => {
    expect(nodes()[1]!.description).toBe("Select a colour to apply it, rename it or change it.");
    const card = nodes({ selectedColourId: "colour-1" })[1]!;
    expect(card.label).toBe("Team red");
    expect(card.description).toBe("#E02020");
    expect(findNode(wrap(nodes({ selectedColourId: "colour-1" })), "colour/colour-1/space")!.value).toBe("srgb");
    const use = findNode(wrap(nodes({ selectedColourId: "colour-1" })), "colour/colour-1/use")!;
    expect(use.value).toBe("1 fill and 0 strokes have exactly this colour");
    expect(use.description).toBe("Counts exact matches in the open graphic only: an applied colour is a copy, not a link.");
    expect(findNode(wrap(nodes({ selectedColourId: "colour-2" })), "colour/colour-2/use")!.value).toBe("no object has exactly this colour");
    // Used only as a stroke is still use.
    const strokeOnly = coloursNodes(scene([rect("s", { stroke: solid(red) })]), { project: true, colours, selectedColourId: "colour-1" })[1]!;
    expect(strokeOnly.children!.find((c) => c.id.endsWith("/use"))!.value).toBe("0 fills and 1 stroke have exactly this colour");
  });

  it("offers Apply as fill and stroke to the selection, dimmed with the reason when it cannot, and Rename, Change and Delete always", () => {
    const card = (ids: string[]) => nodes({ selectedColourId: "colour-1", selectedObjectIds: ids })[1]!;
    expect(card(["a"]).actions!.map((a) => [a.name, a.unavailable])).toEqual([
      ["applyFill", undefined],
      ["applyStroke", undefined],
      ["renameColour", undefined],
      ["editColour", undefined],
      ["deleteColour", undefined],
    ]);
    expect(card([]).actions![0]!.unavailable).toBe("select an object first");
    expect(card([]).actions![4]!.unavailable).toBeUndefined();
  });

  it("gives an agent the same reasons a person sees", () => {
    const view = agentView(wrap(nodes({ selectedColourId: "colour-1" })));
    const find = (node: typeof view, id: string): typeof view | undefined => (node.id === id ? node : node.children.map((c) => find(c, id)).find(Boolean));
    expect(find(view, "library/colour-detail")!.actions[0]).toMatchObject({ name: "applyFill", available: false, unavailableReason: "select an object first" });
  });
});

describe("the Library panel on the Colours tab", () => {
  const document = scene([rect("a", { fill: solid(red) })]);
  const colours = [colour("colour-1", "Team red", red)];
  const panel = (extra: Record<string, unknown> = {}) => libraryPanel(document, { project: "show", tab: "colours", colours, ...extra } as never);

  it("shows the tab strip with Colours selected, the swatches and a note, and none of the asset grid", () => {
    const node = panel();
    expect(findNode(node, "library/tab/colours")!.selected).toBe(true);
    expect(findNode(node, "library/tab/assets")!.selected).toBe(false);
    expect(findNode(node, "library/colours")!.children).toHaveLength(1);
    expect(findNode(node, "library/note")!.value).toBe(COLOURS_NOTE);
    for (const gone of ["library/folders", "library/filters", "asset-manager/list", "library/detail"]) expect(findNode(node, gone), gone).toBeUndefined();
    expect(node.actions).toBeUndefined();
  });

  it("keeps the Assets tab as it was when no tab is chosen, and the tab strip leaves Colours unselected", () => {
    const assets = libraryPanel(document, { project: "show", colours } as never);
    expect(findNode(assets, "library/tab/assets")!.selected).toBe(true);
    expect(findNode(assets, "library/tab/colours")!.selected).toBe(false);
    expect(findNode(assets, "library/colours")).toBeUndefined();
    expect(findNode(assets, "asset-manager/list")).toBeDefined();
  });

  it("still shows a notice from an action on the Colours tab", () => {
    expect(findNode(panel({ notice: "The colour was not made: a Library colour named \"x\" already exists" }), "asset-manager/notice")!.value).toContain("already exists");
  });
});

describe("a swatch in the DOM", () => {
  class Fake {
    readonly attributes = new Map<string, string>();
    readonly children: Fake[] = [];
    textContent = "";
    className = "";
    constructor(readonly tag: string) {}
    setAttribute(name: string, value: string): void {
      this.attributes.set(name, value);
    }
    append(...kids: Fake[]): void {
      this.children.push(...kids);
    }
  }
  const draw = (swatch: string | undefined) =>
    renderNode({ createElement: (tag: string) => new Fake(tag) } as unknown as Document, { id: "x", role: "listitem", label: "x", ...(swatch === undefined ? {} : { swatch }) }) as unknown as Fake;

  it("sets its colour as a variable for the stylesheet", () => {
    const element = draw("rgba(224, 32, 32, 1)");
    expect(element.attributes.get("style")).toBe("--swatch: rgba(224, 32, 32, 1)");
    expect(element.attributes.get("data-swatch")).toBe("true");
  });

  it("takes only a plain colour value, so nothing else can be put in a style attribute", () => {
    for (const bad of ["red; background: url(http://x)", "rgba(1,2,3,1);}", "a\"b", "</style>"]) {
      const element = draw(bad);
      expect(element.attributes.has("style"), bad).toBe(false);
    }
    expect(draw(undefined).attributes.has("style")).toBe(false);
  });
});
