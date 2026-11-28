// Hide when empty (row 11.153, slice A and the Editor's half; Jev A, docs/evidence/11.153/jev-laya-data-block.json): the Properties row, the
// Data block's buttons on the card, and the preview's resolver agreeing with Rust (the shared fixture covers the resolver itself).

import { describe, expect, it } from "vitest";

import type { SceneDocument } from "@grapix/contracts";

import { dataActions, elementCard } from "../src/element-card";
import { hasEmptinessBinding, inspectorEdits, inspectorPanel, inspectorSections } from "../src/inspector";
import { resolveSceneBindings } from "../src/bindings";

const text = (id: string, extra: Record<string, unknown> = {}) => ({ type: "text", id, name: id, text: "Authored", fontId: "f", size: 40, autoFit: "none", layout: "point", align: "left", verticalAlign: "top", textCase: "original", x: 0, y: 0, width: 100, height: 40, opacity: 1, rotation: 0, scaleX: 1, scaleY: 1, visible: true, locked: false, strokeWidth: 0, ...extra });
const rect = (id: string, extra: Record<string, unknown> = {}) => ({ type: "rect", id, name: id, radius: 0, x: 0, y: 0, width: 10, height: 10, opacity: 1, rotation: 0, scaleX: 1, scaleY: 1, visible: true, locked: false, strokeWidth: 0, ...extra });
const doc = (objects: unknown[], dataContext: Record<string, unknown> = {}): SceneDocument =>
  ({ canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } }, objects, assets: [], fonts: [], materials: [], dataContext, timeline: { durationFrames: 100n, channels: [], phases: [], pathChannels: [] } }) as unknown as SceneDocument;

describe("which elements Hide when empty means anything for", () => {
  it("are the ones bound to a text or an image, and no other", () => {
    expect(hasEmptinessBinding({ bindings: { text: "p.name" } })).toBe(true);
    expect(hasEmptinessBinding({ bindings: { assetId: "team.logo" } })).toBe(true);
    expect(hasEmptinessBinding({ bindings: { x: "p.x" } })).toBe(false);
    expect(hasEmptinessBinding({ bindings: { text: 5 } as never })).toBe(false);
    expect(hasEmptinessBinding({})).toBe(false);
  });
});

describe("the Properties row", () => {
  it("is a Data section with one checkbox, only where a selected element is bound to a text or image", () => {
    const bound = doc([text("a", { bindings: { text: "p.name" } }), rect("r")]);
    const dataSection = (selected: string[]) => inspectorSections(inspectorPanel(bound, selected)).find((section) => section.id === "data");
    expect(dataSection(["a"])!.fields.map((field) => [field.label, field.input!.type, field.input!.value])).toEqual([["Hide when empty", "checkbox", "false"]]);
    expect(dataSection(["r"])).toBeUndefined();
    expect(dataSection(["a", "r"])).toBeDefined();
    expect(inspectorSections(inspectorPanel(doc([text("a", { bindings: { text: "p.name" }, hideWhenEmpty: true })]), ["a"])).find((section) => section.id === "data")!.fields[0]!.input!.value).toBe("true");
  });

  it("sends one setObjectField for every selected element, in the contract's words", () => {
    const bound = doc([text("a", { bindings: { text: "p.name" } }), text("b", { bindings: { text: "p.role" } })]);
    expect(inspectorEdits(bound, ["a", "b"], "hideWhenEmpty", true)).toEqual([{ edit: "setObjectField", objectIds: ["a", "b"], field: { name: "hideWhenEmpty", value: true } }]);
    expect(inspectorEdits(bound, ["a"], "hideWhenEmpty", "yes")).toEqual({ refused: "Hide when empty cannot be set to yes" });
  });
});

describe("the card's Data block", () => {
  it("offers Hide when empty for a bound text or image, and Auto-fit too for a bound text, pressed when on", () => {
    expect(dataActions(text("a", { bindings: { text: "p.name" } }) as never)).toEqual([
      { id: "auto-fit", label: "Auto-fit", pressed: false },
      { id: "hide-when-empty", label: "Hide when empty", pressed: false },
    ]);
    expect(dataActions(text("a", { bindings: { text: "p.name" }, autoFit: "shrink", hideWhenEmpty: true }) as never).map((action) => action.pressed)).toEqual([true, true]);
    expect(dataActions(rect("r", { bindings: { assetId: "team.logo" } }) as never).map((action) => action.id)).toEqual(["hide-when-empty"]);
  });

  it("offers nothing for an element that reads no text or image from data", () => {
    expect(dataActions(text("a") as never)).toEqual([]);
    expect(dataActions(rect("r", { bindings: { x: "p.x" } }) as never)).toEqual([]);
  });

  it("dims Auto-fit with the engine's reason, and says nothing more about Hide when empty", () => {
    const actions = dataActions(text("a", { bindings: { text: "p.name" } }) as never, "Shrinks to fit is not drawn by the engine yet: row 11.51 draws it");
    expect(actions[0]).toMatchObject({ id: "auto-fit", unavailable: "Shrinks to fit is not drawn by the engine yet: row 11.51 draws it" });
    expect(actions[1]!.unavailable).toBeUndefined();
  });

  it("puts the buttons in the card's Data section, not in Style or Motion", () => {
    const card = elementCard(doc([text("a", { bindings: { text: "p.name" } })]), text("a", { bindings: { text: "p.name" } }) as never);
    expect(card.sections.map((section) => [section.id, section.actions?.length ?? 0])).toEqual([["style", 0], ["motion", 0], ["data", 2]]);
  });
});

describe("the preview resolves it as Rust does", () => {
  it("hides on blank, null and missing, keeps the authored text, and does not hide a value", () => {
    const resolve = (data: Record<string, unknown>) => {
      const result = resolveSceneBindings(doc([text("a", { bindings: { text: "p.name" }, hideWhenEmpty: true })], data));
      expect(result.ok).toBe(true);
      return result.ok ? (result.document.objects[0] as unknown as { visible: boolean; text: string }) : undefined;
    };
    for (const empty of [{ p: { name: "" } }, { p: { name: "  " } }, { p: { name: null } }, { p: {} }]) {
      expect(resolve(empty), JSON.stringify(empty)).toMatchObject({ visible: false, text: "Authored" });
    }
    expect(resolve({ p: { name: "Soul" } })).toMatchObject({ visible: true, text: "Soul" });
  });

  it("refuses a missing path when the element does not hide", () => {
    expect(resolveSceneBindings(doc([text("a", { bindings: { text: "p.name" } })], { p: {} })).ok).toBe(false);
    expect(resolveSceneBindings(doc([text("a", { bindings: { text: "p.name" }, hideWhenEmpty: false })], { p: {} })).ok).toBe(false);
  });
});
