// The Properties dock's scalar rows that arrived with task 118 (Figma B3d): tracking, leading, baseline shift, trim, stroke width and dash offset.
// What the rows read, which kinds have them, where they sit, and that they are set the way the Animation panel sets them (`editProperty`, from main.ts),
// not through `setObjectField`, which has no such fields.

import { describe, expect, it } from "vitest";

import type { SceneDocument, SceneObject } from "@grapix/contracts";
import { findNode } from "../src/agent-surface";
import { inspectorEdits, inspectorPanel, inspectorSections, isRefused, parseFieldInput } from "../src/inspector";

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
  width: 100,
  height: 50,
  rotation: 0,
  rotationX: 0,
  rotationY: 0,
  scaleX: 1,
  scaleY: 1,
  scaleZ: 1,
  strokeWidth: 2,
});
const text = (id: string, extra: Record<string, unknown> = {}): SceneObject =>
  ({ type: "text", ...base(id), text: "Hi", fontId: "inter", size: 48, letterSpacing: 20, ...extra }) as unknown as SceneObject;
const rect = (id: string, extra: Record<string, unknown> = {}): SceneObject => ({ type: "rect", ...base(id), radius: 4, ...extra }) as unknown as SceneObject;
const shape = (id: string, extra: Record<string, unknown> = {}): SceneObject => ({ type: "shape", ...base(id), ...extra }) as unknown as SceneObject;
const image = (id: string): SceneObject => ({ type: "image", ...base(id), assetId: "a", fit: "contain" }) as unknown as SceneObject;
const scene = (objects: SceneObject[]): SceneDocument =>
  ({ id: "s", name: "S", version: 1, canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } }, timeline: { durationFrames: 1 }, dataContext: {}, assets: [], fonts: [], materials: [], objects }) as unknown as SceneDocument;

const value = (panel: ReturnType<typeof inspectorPanel>, key: string): string | undefined => findNode(panel, `inspector/${key}`)?.value;
const input = (panel: ReturnType<typeof inspectorPanel>, key: string) => findNode(panel, `inspector/${key}`)?.input;

describe("the text rows", () => {
  const panel = inspectorPanel(scene([text("t", { lineHeight: 1.2, baselineShift: -3 })]), ["t"]);

  it("read tracking, leading and baseline shift from the text", () => {
    expect(value(panel, "letterSpacing")).toBe("20");
    expect(value(panel, "lineHeight")).toBe("1.2");
    expect(value(panel, "baselineShift")).toBe("-3");
  });

  it("are labelled in designers' words", () => {
    expect(findNode(panel, "inspector/letterSpacing")!.label).toBe("Tracking");
    expect(findNode(panel, "inspector/lineHeight")!.label).toBe("Leading");
    expect(findNode(panel, "inspector/baselineShift")!.label).toBe("Baseline shift");
  });

  it("read leading as auto, with an empty field, until one is set, and baseline shift as 0", () => {
    const fresh = inspectorPanel(scene([text("t")]), ["t"]);
    expect(value(fresh, "lineHeight")).toBe("auto");
    expect(input(fresh, "lineHeight")).toEqual({ type: "number", value: "" });
    expect(value(fresh, "baselineShift")).toBe("0");
  });

  it("are not on a rect, which has no text", () => {
    const onRect = inspectorPanel(scene([rect("r")]), ["r"]);
    for (const key of ["letterSpacing", "lineHeight", "baselineShift"]) expect(findNode(onRect, `inspector/${key}`)).toBeUndefined();
  });
});

describe("Paragraph spacing and Max lines (row 11.51)", () => {
  it("read 0 and none until set, then the stored values, and are not on a rect", () => {
    const fresh = inspectorPanel(scene([text("t")]), ["t"]);
    expect(value(fresh, "paragraphSpacing")).toBe("0");
    expect(value(fresh, "maxLines")).toBe("none");
    expect(findNode(fresh, "inspector/maxLines")!.label).toBe("Max lines");
    expect(findNode(fresh, "inspector/paragraphSpacing")!.label).toBe("Paragraph spacing");
    const set = inspectorPanel(scene([text("t", { paragraphSpacing: 12, maxLines: 2 })]), ["t"]);
    expect(value(set, "paragraphSpacing")).toBe("12");
    expect(value(set, "maxLines")).toBe("2");
    expect(input(set, "maxLines")).toEqual({ type: "text", value: "2" });
    const onRect = inspectorPanel(scene([rect("r")]), ["r"]);
    for (const key of ["paragraphSpacing", "maxLines"]) expect(findNode(onRect, `inspector/${key}`)).toBeUndefined();
  });

  it("Word spacing reads 0 and Kerning reads on until switched off, and both are held setObjectField values", () => {
    const fresh = inspectorPanel(scene([text("t")]), ["t"]);
    expect(value(fresh, "wordSpacing")).toBe("0");
    expect(value(fresh, "kerning")).toBe("true");
    expect(value(inspectorPanel(scene([text("t", { kerning: false, wordSpacing: -4 })]), ["t"]), "kerning")).toBe("false");
    expect(value(inspectorPanel(scene([text("t", { wordSpacing: -4 })]), ["t"]), "wordSpacing")).toBe("-4");
    expect(parseFieldInput("wordSpacing", "-6.5")).toEqual({ value: -6.5 });
    const doc = scene([text("a")]);
    expect(inspectorEdits(doc, ["a"], "kerning", false)).toEqual([{ edit: "setObjectField", objectIds: ["a"], field: { name: "kerning", value: false } }]);
    expect(inspectorEdits(doc, ["a"], "wordSpacing", 3)).toEqual([{ edit: "setObjectField", objectIds: ["a"], field: { name: "wordSpacing", value: 3 } }]);
  });

  it("Underline and Strike-through read the text's decoration and set it as one field, keeping the flag not touched on each text", () => {
    const panel = inspectorPanel(scene([text("t", { decoration: { underline: true, strikethrough: false } })]), ["t"]);
    expect(value(panel, "underline")).toBe("true");
    expect(value(panel, "strikethrough")).toBe("false");
    expect(value(inspectorPanel(scene([text("t")]), ["t"]), "underline")).toBe("false");
    const doc = scene([text("a", { decoration: { underline: false, strikethrough: true } }), text("b"), text("c", { decoration: { underline: false, strikethrough: true } })]);
    expect(inspectorEdits(doc, ["a", "b", "c"], "underline", true)).toEqual([
      { edit: "setObjectField", objectIds: ["a", "c"], field: { name: "decoration", value: { underline: true, strikethrough: true } } },
      { edit: "setObjectField", objectIds: ["b"], field: { name: "decoration", value: { underline: true, strikethrough: false } } },
    ]);
    expect(isRefused(inspectorEdits(doc, ["a"], "underline", "yes"))).toBe(true);
  });

  it("say Mixed when texts differ", () => {
    const panel = inspectorPanel(scene([text("a", { maxLines: 1 }), text("b")]), ["a", "b"]);
    expect(value(panel, "maxLines")).toBe("Mixed");
  });

  it("take a whole number from 1 for Max lines and none or 0 to clear it, and refuse anything else by name", () => {
    expect(parseFieldInput("maxLines", "3")).toEqual({ value: 3 });
    for (const clear of ["none", "None", "", "0", "off"]) expect(parseFieldInput("maxLines", clear), clear).toEqual({ value: null });
    for (const bad of ["1.5", "-2", "two"]) {
      const refused = parseFieldInput("maxLines", bad);
      expect("refused" in refused && refused.refused, bad).toBe(`Max lines needs a whole number from 1, or "none", not "${bad}"`);
    }
  });

  it("take a number that is not negative for Paragraph spacing", () => {
    expect(parseFieldInput("textIndent", "18")).toEqual({ value: 18 });
    expect("refused" in parseFieldInput("textIndent", "-2")).toBe(true);
    expect(parseFieldInput("paragraphSpacing", "24.5")).toEqual({ value: 24.5 });
    expect(parseFieldInput("paragraphSpacing", "0")).toEqual({ value: 0 });
    for (const bad of ["-1", "", "wide"]) expect("refused" in parseFieldInput("paragraphSpacing", bad), bad).toBe(true);
  });

  it("are held values: one setObjectField over the selection, and null clears Max lines", () => {
    const doc = scene([text("a"), text("b")]);
    expect(inspectorEdits(doc, ["a", "b"], "maxLines", 2)).toEqual([{ edit: "setObjectField", objectIds: ["a", "b"], field: { name: "maxLines", value: 2 } }]);
    expect(inspectorEdits(doc, ["a"], "maxLines", null)).toEqual([{ edit: "setObjectField", objectIds: ["a"], field: { name: "maxLines", value: null } }]);
    expect(inspectorEdits(doc, ["a"], "textIndent", 18)).toEqual([{ edit: "setObjectField", objectIds: ["a"], field: { name: "textIndent", value: 18 } }]);
    expect(inspectorEdits(doc, ["a"], "paragraphSpacing", 8)).toEqual([{ edit: "setObjectField", objectIds: ["a"], field: { name: "paragraphSpacing", value: 8 } }]);
    expect(isRefused(inspectorEdits(doc, ["a"], "paragraphSpacing", "8"))).toBe(true);
  });
});

describe("the shape rows", () => {
  it("read trim as a percentage of the path, 0 and 100 when omitted, and only on a shape", () => {
    const plain = inspectorPanel(scene([shape("s")]), ["s"]);
    expect(value(plain, "trimStart")).toBe("0");
    expect(value(plain, "trimEnd")).toBe("100");
    const trimmed = inspectorPanel(scene([shape("s", { trimStart: 10, trimEnd: 60 })]), ["s"]);
    expect(value(trimmed, "trimStart")).toBe("10");
    expect(value(trimmed, "trimEnd")).toBe("60");
    expect(findNode(inspectorPanel(scene([rect("r")]), ["r"]), "inspector/trimStart")).toBeUndefined();
  });
});

describe("the stroke rows", () => {
  it("read the stroke width and the dash offset inside the stroke style, 0 when there is no style", () => {
    const styled = inspectorPanel(scene([rect("r", { strokeStyle: { join: "round", cap: "butt", miterLimit: 4, dash: [6, 3], dashOffset: 7.5 } })]), ["r"]);
    expect(value(styled, "strokeWidth")).toBe("2");
    expect(value(styled, "strokeStyle.dashOffset")).toBe("7.5");
    expect(value(inspectorPanel(scene([rect("r")]), ["r"]), "strokeStyle.dashOffset")).toBe("0");
  });

  it("are on text, rect, ellipse, line and shape, and explained, not hidden, beside an image", () => {
    const mixed = inspectorPanel(scene([rect("r"), image("i")]), ["r", "i"]);
    const width = findNode(mixed, "inspector/strokeWidth")!;
    expect(width.description).toBe("not on image");
    expect(width.actions![0]!.unavailable).toBe("Stroke width is not a property of image");
    expect(findNode(inspectorPanel(scene([image("i")]), ["i"]), "inspector/strokeWidth")).toBeUndefined();
  });

  it("say Mixed when the selection differs", () => {
    const panel = inspectorPanel(scene([rect("a", { strokeWidth: 1 }), rect("b", { strokeWidth: 4 })]), ["a", "b"]);
    expect(value(panel, "strokeWidth")).toBe("Mixed");
  });
});

describe("where the rows sit", () => {
  const titles = (panel: ReturnType<typeof inspectorPanel>) => inspectorSections(panel).map((section) => [section.title, section.fields.map((f) => f.id.slice("inspector/".length))]);

  it("puts tracking, leading and baseline shift under Text, trim under Shape, and the stroke in its own section", () => {
    expect(titles(inspectorPanel(scene([text("t")]), ["t"]))).toEqual([
      ["Layer", ["name", "visible", "locked"]],
      ["Transform", ["x", "y", "scaleX", "scaleY", "rotation", "opacity"]],
      // Without the text choices read from Rust (11.132), the Text section says so in one status line.
      ["Text", ["text", "fontId", "size", "letterSpacing", "lineHeight", "wordSpacing", "paragraphSpacing", "textIndent", "kerning", "underline", "strikethrough", "maxLines", "baselineShift", "text-choices"]],
      ["Stroke", ["strokeWidth", "strokeStyle.dashOffset"]],
      // A text element can always be given an animator (11.61): the section is its Add button until it has one.
      ["Text animator", ["textAnimator/add"]],
    ]);
    expect(titles(inspectorPanel(scene([shape("s")]), ["s"])).slice(2)).toEqual([
      ["Shape", ["trimStart", "trimEnd", "trimOffset"]],
      ["Stroke", ["strokeWidth", "strokeStyle.dashOffset"]],
    ]);
  });
});

describe("typing into them", () => {
  it("takes a number, refuses text, and does not clamp a trim past 100 (the contract refuses it by name)", () => {
    expect(parseFieldInput("letterSpacing", "40")).toEqual({ value: 40 });
    expect(parseFieldInput("baselineShift", "-2.5")).toEqual({ value: -2.5 });
    expect(parseFieldInput("strokeStyle.dashOffset", "12")).toEqual({ value: 12 });
    expect(parseFieldInput("trimEnd", "140")).toEqual({ value: 140 });
    const refused = parseFieldInput("lineHeight", "auto");
    expect("refused" in refused && refused.refused).toBe('Leading needs a finite number, not "auto"');
  });

  it("is not a setObjectField: the scalar rows are set with editProperty, so inspectorEdits refuses them rather than inventing a field", () => {
    const outcome = inspectorEdits(scene([text("t")]), ["t"], "letterSpacing", 40);
    expect(isRefused(outcome)).toBe(true);
    expect(isRefused(outcome) && outcome.refused).toBe("Tracking cannot be set to 40");
  });
});
