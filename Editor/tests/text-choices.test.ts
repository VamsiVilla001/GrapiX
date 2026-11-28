// The text choices of the Properties dock (plan row 11.132): which options a selection may take, the reasons for those it may not, Mixed,
// and the one edit a choice sends. The surface is `Shared/contracts/fixtures/text-choices.json`, the same file the Rust surface is pinned
// to, so the dock's rules run on what the engine really draws.

import { describe, expect, it } from "vitest";

import type { SceneDocument, SceneObject, TextChoices } from "@grapix/contracts";

import fixture from "../../Shared/contracts/fixtures/text-choices.json";
import { agentView, findNode, type UiNode } from "../src/agent-surface";
import { inspectorPanel, inspectorSections } from "../src/inspector";
import { CHOICES_NOT_READ, choiceBlocker, choiceEdit, choiceFieldWords, choiceValue, isChoiceGroup, optionReason, parseChoiceId, textChoiceNodes } from "../src/text-choices";

const surface = fixture as unknown as TextChoices;

/** The surface as it was while small caps were not drawn: the dock reads only the surface, so a value the engine does not draw dims. */
const withSmallCapsUndrawn = (): TextChoices => {
  const earlier = structuredClone(surface) as TextChoices;
  const smallCaps = earlier.fields[0]!.values.find((value) => value.value === "small-caps")! as { drawnForLayouts: string[]; owner?: string };
  smallCaps.drawnForLayouts = [];
  smallCaps.owner = "11.51";
  return earlier;
};

type Text = Extract<SceneObject, { type: "text" }>;
const text = (id: string, extra: Partial<Record<string, unknown>> = {}): Text =>
  ({
    type: "text",
    id,
    name: id,
    text: "Hello",
    fontId: "font",
    size: 40,
    layout: "point",
    autoFit: "none",
    writingMode: "horizontal-tb",
    verticalAlign: "top",
    direction: "auto",
    textCase: "original",
    decoration: { underline: false, strikethrough: false },
    overflow: "visible",
    align: "left",
    letterSpacing: 0,
    wordSpacing: 0,
    paragraphSpacing: 0,
    textIndent: 0,
    x: 0,
    y: 0,
    width: 300,
    height: 80,
    opacity: 1,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    visible: true,
    locked: false,
    strokeWidth: 0,
    ...extra,
  }) as unknown as Text;
const rect = (id: string): SceneObject => ({ type: "rect", id, name: id, radius: 0, x: 0, y: 0, width: 10, height: 10, opacity: 1, rotation: 0, scaleX: 1, scaleY: 1, visible: true, locked: false, strokeWidth: 0 }) as unknown as SceneObject;
const scene = (objects: SceneObject[]): SceneDocument =>
  ({ id: "s", name: "S", version: 1, objects, assets: [], fonts: [], materials: [], timeline: { durationFrames: 10, channels: [] } }) as unknown as SceneDocument;

const node = (nodes: readonly UiNode[], field: string): UiNode => nodes.find((candidate) => candidate.id === `inspector/${field}`)!;
const option = (nodes: readonly UiNode[], field: string, value: string): UiNode => node(nodes, field).children!.find((candidate) => candidate.id === `inspector/${field}/${value}`)!;
const why = (nodes: readonly UiNode[], field: string, value: string): string | undefined => option(nodes, field, value).actions![0]!.unavailable;

describe("the choices a text selection shows", () => {
  it("lists Case, Align, Vertical align, Box, Writing mode, Fit and Overflow with every value, in the surface's words", () => {
    const nodes = textChoiceNodes(scene([text("t")]), ["t"], surface);
    expect(nodes.map((n) => [n.id, n.label])).toEqual([
      ["inspector/textCase", "Case"],
      ["inspector/align", "Align"],
      ["inspector/verticalAlign", "Vertical align"],
      ["inspector/layout", "Box"],
      ["inspector/writingMode", "Writing mode"],
      ["inspector/autoFit", "Fit"],
      ["inspector/overflow", "Overflow"],
    ]);
    expect(node(nodes, "textCase").children!.map((c) => c.label)).toEqual(["As typed", "Uppercase", "Lowercase", "Title case", "Small caps"]);
  });

  it("shows the object's own value as the group's value and marks that option", () => {
    const nodes = textChoiceNodes(scene([text("t", { textCase: "upper" })]), ["t"], surface);
    expect(node(nodes, "textCase").value).toBe("Uppercase");
    expect(option(nodes, "textCase", "upper").selected).toBe(true);
    expect(option(nodes, "textCase", "lower").selected).toBe(false);
    expect(why(nodes, "textCase", "upper")).toBe("already Uppercase");
  });

  it("shows nothing for a selection with no text, and one status line when the surface has not been read", () => {
    expect(textChoiceNodes(scene([rect("r")]), ["r"], surface)).toEqual([]);
    expect(textChoiceNodes(scene([text("t")]), [], surface)).toEqual([]);
    expect(textChoiceNodes(scene([text("t")]), ["t"], undefined)).toEqual([{ id: "inspector/text-choices", role: "status", label: "Text choices", value: CHOICES_NOT_READ }]);
  });

  it("says Mixed when the selected text objects differ, and then offers every drawn value, the shared ones included", () => {
    const nodes = textChoiceNodes(scene([text("a", { textCase: "upper" }), text("b")]), ["a", "b"], surface);
    expect(node(nodes, "textCase").value).toBe("Mixed");
    expect(node(nodes, "textCase").children!.some((c) => c.selected)).toBe(false);
    expect(why(nodes, "textCase", "upper")).toBeUndefined();
    expect(why(nodes, "textCase", "original")).toBeUndefined();
  });

  it("dims every option, naming the other kinds, when the selection also holds something that is not text", () => {
    const nodes = textChoiceNodes(scene([text("t"), rect("r")]), ["t", "r"], surface);
    expect(node(nodes, "align").description).toBe("not on rect");
    expect(why(nodes, "align", "left")).toBe("Align is a text choice: rect has none. Select only text");
    expect(why(nodes, "textCase", "upper")).toBe("Case is a text choice: rect has none. Select only text");
  });
});

describe("what the engine draws decides what can be chosen", () => {
  const point = textChoiceNodes(scene([text("t")]), ["t"], surface);

  it("offers the values the engine draws", () => {
    for (const value of ["upper", "lower", "title", "small-caps"]) expect(why(point, "textCase", value), value).toBeUndefined();
    for (const value of ["shrink", "fit"]) expect(why(point, "autoFit", value), value).toBeUndefined();
    expect(why(point, "layout", "paragraph")).toBeUndefined();
  });

  it("dims a value the engine does not draw yet with the row that will", () => {
    const earlier = textChoiceNodes(scene([text("t")]), ["t"], withSmallCapsUndrawn());
    expect(why(earlier, "textCase", "small-caps")).toBe("Small caps is not drawn by the engine yet: row 11.51 draws it");
  });

  it("offers centre, right, middle and bottom now that the engine draws them under both layouts", () => {
    for (const value of ["center", "right"]) expect(why(point, "align", value), value).toBeUndefined();
    for (const value of ["middle", "bottom"]) expect(why(point, "verticalAlign", value), value).toBeUndefined();
  });

  // The rules about a value drawn for one layout only are kept under test with a surface that says so (the engine drew centre and right
  // for paragraph text only until row 11.51's second slice), because another value may be drawn for one layout later.
  const paragraphOnly = structuredClone(surface) as TextChoices;
  for (const value of ["center", "right"]) {
    const entry = paragraphOnly.fields.find((field) => field.field === "align")!.values.find((candidate) => candidate.value === value)! as {
      drawnForLayouts: string[];
      owner?: string;
    };
    entry.drawnForLayouts = ["paragraph"];
    entry.owner = "11.51";
  }
  const narrowPoint = textChoiceNodes(scene([text("t")]), ["t"], paragraphOnly);

  it("dims a value drawn for paragraph text only on point text, and offers it on paragraph text", () => {
    expect(why(narrowPoint, "align", "center")).toBe("Centre is drawn for paragraph text only, and t would be point text: row 11.51 draws it");
    const paragraph = textChoiceNodes(scene([text("t", { layout: "paragraph" })]), ["t"], paragraphOnly);
    expect(why(paragraph, "align", "center")).toBeUndefined();
    expect(why(paragraph, "align", "right")).toBeUndefined();
  });

  it("will not turn centred paragraph text back into point text when point text cannot draw it, naming what it would break", () => {
    const centred = textChoiceNodes(scene([text("Title", { layout: "paragraph", align: "center" })]), ["Title"], paragraphOnly);
    expect(why(centred, "layout", "point")).toBe("Title has Align Centre, which is not drawn for point text: row 11.51 draws it");
  });

  it("checks every selected text object: one point-text object is enough to dim a paragraph-only value", () => {
    const nodes = textChoiceNodes(scene([text("a", { layout: "paragraph" }), text("b")]), ["a", "b"], paragraphOnly);
    expect(why(nodes, "align", "center")).toContain("b would be point text");
  });

  it("reads only the surface: a surface that draws small caps offers it and one that does not dims it", () => {
    expect(why(textChoiceNodes(scene([text("t")]), ["t"], surface), "textCase", "small-caps")).toBeUndefined();
    expect(why(textChoiceNodes(scene([text("t")]), ["t"], withSmallCapsUndrawn()), "textCase", "small-caps")).toContain("not drawn");
  });

  it("names no row when the surface gives none", () => {
    const anonymous = withSmallCapsUndrawn();
    delete (anonymous.fields[0]!.values[4]! as { owner?: string }).owner;
    expect(choiceBlocker(anonymous, [text("t")], "textCase", "small-caps")).toBe("Small caps is not drawn by the engine yet");
  });
});

describe("the edit a choice sends", () => {
  it("is one setObjectField over the selected text objects, in the scene's words", () => {
    const document = scene([text("a"), text("b"), rect("r")]);
    expect(choiceEdit(document, ["a", "b"], "textCase", "upper")).toEqual({ edit: "setObjectField", objectIds: ["a", "b"], field: { name: "textCase", value: "upper" } });
    // Only text objects are named, whatever else is selected.
    expect(choiceEdit(document, ["a", "r"], "align", "left")).toEqual({ edit: "setObjectField", objectIds: ["a"], field: { name: "align", value: "left" } });
  });

  it("reads an option's id back into its choice and value, and nothing else", () => {
    expect(parseChoiceId("inspector/textCase/small-caps")).toEqual({ field: "textCase", value: "small-caps" });
    expect(parseChoiceId("inspector/layout/paragraph")).toEqual({ field: "layout", value: "paragraph" });
    expect(parseChoiceId("inspector/opacity")).toBeUndefined();
    expect(parseChoiceId("inspector/size/12")).toBeUndefined();
    expect(parseChoiceId("inspector/align/center/more")).toBeUndefined();
  });

  it("reads each choice from the object the way the scene stores it", () => {
    const object = text("t", { textCase: "title", align: "right", verticalAlign: "bottom", layout: "paragraph", writingMode: "vertical-rl", autoFit: "shrink", overflow: "clip" });
    expect(["textCase", "align", "verticalAlign", "layout", "writingMode", "autoFit", "overflow", "size"].map((field) => choiceValue(object, field))).toEqual(["title", "right", "bottom", "paragraph", "vertical-rl", "shrink", "clip", undefined]);
  });
});

describe("in the Properties dock", () => {
  it("sits in the Text section after the text fields", () => {
    const sections = inspectorSections(inspectorPanel(scene([text("t")]), ["t"], surface));
    const textSection = sections.find((section) => section.title === "Text")!;
    expect(textSection.fields.map((field) => field.id).slice(-7)).toEqual(["inspector/textCase", "inspector/align", "inspector/verticalAlign", "inspector/layout", "inspector/writingMode", "inspector/autoFit", "inspector/overflow"]);
    expect(sections.some((section) => section.title === "Other")).toBe(false);
  });

  it("gives an agent the same options and the same reasons", () => {
    const view = agentView(inspectorPanel(scene([text("t")]), ["t"], surface));
    const find = (n: typeof view, id: string): typeof view | undefined => (n.id === id ? n : n.children.map((c) => find(c, id)).find(Boolean));
    const earlier = agentView(inspectorPanel(scene([text("t")]), ["t"], withSmallCapsUndrawn()));
    expect(find(earlier, "inspector/textCase/small-caps")!.actions[0]).toMatchObject({ name: "choose", available: false, unavailableReason: "Small caps is not drawn by the engine yet: row 11.51 draws it" });
    expect(find(view, "inspector/textCase/small-caps")!.actions[0]).toMatchObject({ name: "choose", available: true });
    expect(find(view, "inspector/textCase/upper")!.actions[0]).toMatchObject({ name: "choose", available: true });
    expect(findNode(inspectorPanel(scene([text("t")]), ["t"], surface), "inspector/textCase")!.value).toBe("As typed");
  });
});

describe("the text choices as dropdown fields (Figma B3d v2)", () => {
  it("are the six choice groups and nothing else in Properties", () => {
    for (const field of ["textCase", "align", "verticalAlign", "layout", "writingMode", "autoFit", "overflow"]) expect(isChoiceGroup(`inspector/${field}`), field).toBe(true);
    for (const id of ["inspector/opacity", "inspector/align/center", "inspector/textCaseX", "textCase", "inspector/text-choices"]) expect(isChoiceGroup(id), id).toBe(false);
  });

  it("show the value, Mixed, or a dash when nothing is set", () => {
    expect(choiceFieldWords("Uppercase")).toBe("Uppercase");
    expect(choiceFieldWords("Mixed")).toBe("Mixed");
    expect(choiceFieldWords("")).toBe("—");
    expect(choiceFieldWords("  ")).toBe("—");
  });

  it("write the reason under an option that cannot be chosen, but not under the chosen one", () => {
    expect(optionReason("Small caps is not drawn by the engine yet: row 11.40 draws it", false)).toBe("Small caps is not drawn by the engine yet: row 11.40 draws it");
    expect(optionReason("already Uppercase", true)).toBeUndefined();
    expect(optionReason(undefined, false)).toBeUndefined();
  });
});

import { fontChoiceNode } from "../src/text-choices";

describe("the Font row as a choice (Figma B3d v2: a name, not an id)", () => {
  const fontScene = (objects: SceneObject[]): SceneDocument =>
    ({ ...scene(objects), fonts: [
      { fontId: "font_a", displayName: "Anybody", enabled: true },
      { fontId: "font_b", displayName: "Manrope", enabled: true },
      { fontId: "font_c", displayName: "Old Face", enabled: false },
    ] }) as unknown as SceneDocument;

  it("shows the font in use by its name, one option per font the scene holds, the one in use chosen", () => {
    const group = fontChoiceNode(fontScene([text("t", { fontId: "font_b" })]), ["t"])[0]!;
    expect(group.id).toBe("inspector/fontId");
    expect(group.value).toBe("Manrope");
    expect(group.children!.map((child) => [child.label, child.selected])).toEqual([["Anybody", false], ["Manrope", true], ["Old Face", false]]);
  });

  it("dims the chosen font with why, and a switched-off font with that reason", () => {
    const group = fontChoiceNode(fontScene([text("t", { fontId: "font_b" })]), ["t"])[0]!;
    const reasons = group.children!.map((child) => child.actions![0]!.unavailable);
    expect(reasons).toEqual([undefined, "already Manrope", "Old Face is switched off in this scene"]);
  });

  it("says Mixed when the text elements differ, and refuses the whole choice when the selection holds something that is not text", () => {
    const mixed = fontChoiceNode(fontScene([text("a", { fontId: "font_a" }), text("b", { fontId: "font_b" })]), ["a", "b"])[0]!;
    expect(mixed.value).toBe("Mixed");
    expect(mixed.children!.every((child) => child.selected === false)).toBe(true);
    const withRect = fontChoiceNode(fontScene([text("a"), rect("r")]), ["a", "r"])[0]!;
    expect(withRect.description).toBe("not on rect");
    expect(withRect.children![0]!.actions![0]!.unavailable).toBe("Font is a text choice: rect has none. Select only text");
  });

  it("falls back to the id for a font the scene does not hold, and offers nothing for a selection with no text", () => {
    expect(fontChoiceNode(fontScene([text("t", { fontId: "gone" })]), ["t"])[0]!.value).toBe("gone");
    expect(fontChoiceNode(fontScene([rect("r")]), ["r"])).toEqual([]);
  });

  it("is a choice in the Properties text section, edited as a setObjectField on every selected text", () => {
    const panel = inspectorPanel(fontScene([text("t", { fontId: "font_a" })]), ["t"], surface);
    expect(findNode(panel, "inspector/fontId")!.role).toBe("group");
    expect(inspectorSections(panel).find((section) => section.id === "text")!.fields.map((field) => field.label).slice(0, 2)).toEqual(["Text", "Font"]);
    expect(isChoiceGroup("inspector/fontId")).toBe(true);
    expect(parseChoiceId("inspector/fontId/font_a")).toEqual({ field: "fontId", value: "font_a" });
    expect(parseChoiceId("inspector/fontId/a/b")).toBeUndefined();
    expect(choiceEdit(fontScene([text("t")]), ["t"], "fontId", "font_b")).toEqual({ edit: "setObjectField", objectIds: ["t"], field: { name: "fontId", value: "font_b" } });
  });
});
