// The Text animator section of Properties (row 11.61; Jev A on all three, docs/evidence/11.61/jev-laya-text-animator-ui.json): Add makes
// a neutral animator, the rows are the contract's scalars with diamonds, Shape, Basis and Randomize are held values in one setTextAnimator,
// Remove takes it away, and the Draft view and the card read the same numbers.

import { describe, expect, it } from "vitest";

import type { SceneDocument } from "@grapix/contracts";

import { findNode } from "../src/agent-surface";
import { inspectorPanel, inspectorSections, parseFieldInput } from "../src/inspector";
import { baseValueOf, propertyLabel } from "../src/keyframe-editor";
import { previewSceneAt } from "../src/preview-playback";
import { isChoiceGroup } from "../src/text-choices";
import { ANIMATOR_ROWS, animatorEdit, animatorNodes, neutralAnimator, parseAnimatorId, parseHeld } from "../src/text-animator";

const animator = (extra: Record<string, unknown> = {}, selector: Record<string, unknown> = {}) => ({ ...neutralAnimator(), ...extra, selector: { ...neutralAnimator().selector, ...selector } });
const text = (id: string, textAnimator?: unknown) => ({ type: "text", id, name: id, text: "Hello", fontId: "f", size: 40, x: 0, y: 0, width: 100, height: 40, opacity: 1, rotation: 0, scaleX: 1, scaleY: 1, visible: true, locked: false, strokeWidth: 0, ...(textAnimator === undefined ? {} : { textAnimator }) });
const rect = { type: "rect", id: "r", name: "r", radius: 0, x: 0, y: 0, width: 10, height: 10, opacity: 1, rotation: 0, scaleX: 1, scaleY: 1, visible: true, locked: false, strokeWidth: 0 };
const doc = (objects: unknown[], channels: unknown[] = []): SceneDocument =>
  ({ canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } }, objects, assets: [], fonts: [], materials: [], timeline: { durationFrames: 100n, channels, phases: [], pathChannels: [] } }) as unknown as SceneDocument;

describe("adding and removing", () => {
  it("makes a neutral animator on every selected text that has none: the whole text, nothing moved", () => {
    const outcome = animatorEdit(doc([text("a"), text("b", animator()), rect]), ["a", "b"], "add");
    expect(outcome).toEqual({ edits: [{ edit: "setTextAnimator", objectIds: ["a"], animator: neutralAnimator() }], label: "Add text animator" });
    expect(neutralAnimator()).toMatchObject({ x: 0, y: 0, scale: 1, rotation: 0, selector: { start: 0, end: 1, offset: 0, amount: 1, shape: "square", randomizeOrder: false } });
    expect(neutralAnimator().opacity).toBeUndefined();
  });

  it("removes it from the ones that have one, with null (which takes its keys with it)", () => {
    expect(animatorEdit(doc([text("a", animator()), text("b", animator())]), ["a", "b"], "remove")).toEqual({
      edits: [{ edit: "setTextAnimator", objectIds: ["a", "b"], animator: null }],
      label: "Remove text animator from 2 texts",
    });
  });

  it("removes only from the texts that have one", () => {
    const outcome = animatorEdit(doc([text("a", animator()), text("b")]), ["a", "b"], "remove");
    expect(outcome).toMatchObject({ edits: [{ objectIds: ["a"], animator: null }], label: "Remove text animator" });
  });

  it("refuses by name: no text, every text already has one, none has one", () => {
    expect(animatorEdit(doc([rect]), ["r"], "add")).toEqual({ refused: "Select a text element first" });
    expect(animatorEdit(doc([text("a", animator())]), ["a"], "add")).toEqual({ refused: "Every selected text already has a text animator" });
    expect(animatorEdit(doc([text("a")]), ["a"], "remove")).toEqual({ refused: "No selected text has a text animator" });
    expect(animatorEdit(doc([text("a")]), ["a"], "shape", "triangle")).toEqual({ refused: "Add a text animator first" });
  });
});

describe("the held values", () => {
  it("set Shape, Basis and Randomize order each in a setTextAnimator that keeps the rest, one per text so each keeps its own", () => {
    const document = doc([text("a", animator({ x: 5 })), text("b", animator({ x: 9 }, { basis: "words" }))]);
    const shape = animatorEdit(document, ["a", "b"], "shape", "triangle");
    expect("edits" in shape && shape.edits.map((edit) => (edit as { animator: { x: number; selector: { shape: string } } }).animator).map((a) => [a.x, a.selector.shape])).toEqual([[5, "triangle"], [9, "triangle"]]);
    const basis = animatorEdit(document, ["b"], "basis", "lines");
    expect("edits" in basis && (basis.edits[0] as { animator: { selector: { basis: string } } }).animator.selector.basis).toBe("lines");
    const back = animatorEdit(document, ["b"], "basis", "default");
    expect("edits" in back && "basis" in (back.edits[0] as { animator: { selector: object } }).animator.selector).toBe(false);
    const random = animatorEdit(document, ["a"], "randomize", true);
    expect("edits" in random && (random.edits[0] as { animator: { selector: { randomizeOrder: boolean } } }).animator.selector.randomizeOrder).toBe(true);
    const off = animatorEdit(doc([text("a", animator({}, { randomizeOrder: true }))]), ["a"], "randomize", false);
    expect("edits" in off && (off.edits[0] as { animator: { selector: { randomizeOrder: boolean } } }).animator.selector.randomizeOrder).toBe(false);
  });

  it("are read as what the animators hold, Mixed when they differ", () => {
    const nodes = animatorNodes(doc([text("a", animator({}, { shape: "round" })), text("b", animator({}, { shape: "smooth", randomizeOrder: true }))]), ["a", "b"]);
    const byId = (id: string) => nodes.find((node) => node.id === id)!;
    expect(byId("inspector/textAnimator/shape").value).toBe("Mixed");
    expect(byId("inspector/textAnimator/basis").value).toBe("As authored");
    expect(byId("inspector/textAnimator/randomize").value).toBe("Mixed");
    expect(byId("inspector/textAnimator/randomize").input).toEqual({ type: "checkbox", value: "false", mixed: true });
    expect(byId("inspector/textAnimator/add").value).toBe("On");
  });
});

describe("Amount, Smoothness and the two eases", () => {
  it("are held percents: shown as the animator holds them, Mixed when they differ", () => {
    const one = animatorNodes(doc([text("a", animator({}, { amount: -0.5, smoothness: 0.25, easeHigh: 0.1, easeLow: -1 }))]), ["a"]);
    const read = (key: string) => one.find((node) => node.id === `inspector/textAnimator/${key}`)!.input;
    expect(read("amount")).toEqual({ type: "text", value: "-50%" });
    expect(read("smoothness")).toEqual({ type: "text", value: "25%" });
    expect(read("easeHigh")).toEqual({ type: "text", value: "10%" });
    expect(read("easeLow")).toEqual({ type: "text", value: "-100%" });
    // A value typed with decimals is shown to three, not rounded to a whole percent.
    const fine = animatorNodes(doc([text("a", animator({}, { amount: 0.12345 }))]), ["a"]);
    expect(fine.find((node) => node.id === "inspector/textAnimator/amount")!.input!.value).toBe("12.345%");
    const two = animatorNodes(doc([text("a", animator({}, { amount: 1 })), text("b", animator({}, { amount: 0.5 }))]), ["a", "b"]);
    expect(two.find((node) => node.id === "inspector/textAnimator/amount")!.input).toEqual({ type: "text", value: "", mixed: true });
    expect(two.find((node) => node.id === "inspector/textAnimator/smoothness")!.input).toEqual({ type: "text", value: "100%" });
  });

  it("are set in one setTextAnimator per text that keeps the rest, as a fraction of the percent typed", () => {
    const document = doc([text("a", animator({ x: 5 })), text("b", animator({ x: 9 }, { shape: "round" }))]);
    const outcome = animatorEdit(document, ["a", "b"], "easeHigh", 30);
    expect(outcome).toMatchObject({ label: "Set Ease high" });
    const animators = "edits" in outcome ? outcome.edits.map((edit) => (edit as { animator: { x: number; selector: { easeHigh: number; shape: string } } }).animator) : [];
    expect(animators.map((a) => [a.x, a.selector.easeHigh, a.selector.shape])).toEqual([[5, 0.3, "square"], [9, 0.3, "round"]]);
    const smooth = animatorEdit(document, ["a"], "smoothness", 0);
    expect("edits" in smooth && (smooth.edits[0] as { animator: { selector: { smoothness: number } } }).animator.selector.smoothness).toBe(0);
  });

  it("are refused by name outside what the contract accepts, and without an animator", () => {
    const document = doc([text("a", animator())]);
    expect(animatorEdit(document, ["a"], "amount", 101)).toEqual({ refused: "Amount must be between -100% and 100%" });
    expect(animatorEdit(document, ["a"], "smoothness", -1)).toEqual({ refused: "Smoothness must be between 0% and 100%" });
    expect(animatorEdit(document, ["a"], "easeLow", Number.NaN)).toEqual({ refused: "Ease low must be between -100% and 100%" });
    expect(animatorEdit(doc([text("a")]), ["a"], "amount", 50)).toEqual({ refused: "Add a text animator first" });
  });

  it("read a person's text: a number, with or without the percent sign", () => {
    expect(parseHeld("amount", "50")).toEqual({ percent: 50 });
    expect(parseHeld("amount", " -25 % ")).toEqual({ percent: -25 });
    expect(parseHeld("smoothness", "0")).toEqual({ percent: 0 });
    expect(parseHeld("smoothness", "-5")).toEqual({ refused: "Smoothness must be between 0% and 100%, not -5%" });
    expect(parseHeld("easeHigh", "")).toEqual({ refused: 'Ease high needs a number, not ""' });
    expect(parseHeld("easeLow", "abc")).toEqual({ refused: 'Ease low needs a number, not "abc"' });
    expect(parseHeld("amount", "100")).toEqual({ percent: 100 });
    expect(parseHeld("amount", "-100%")).toEqual({ percent: -100 });
    expect(parseHeld("smoothness", "100")).toEqual({ percent: 100 });
    expect(parseHeld("amount", "101%")).toEqual({ refused: "Amount must be between -100% and 100%, not 101%" });
  });

  it("have ids that read back to their part, and no value", () => {
    expect(parseAnimatorId("inspector/textAnimator/amount")).toEqual({ part: "amount" });
    expect(parseAnimatorId("inspector/textAnimator/easeLow")).toEqual({ part: "easeLow" });
    expect(parseAnimatorId("inspector/textAnimator/amount/high")).toBeUndefined();
  });
});

describe("the section in Properties", () => {
  it("is Add alone until an animator exists, then the range rows, the held choices and the change rows, in that order", () => {
    const none = inspectorSections(inspectorPanel(doc([text("a")]), ["a"])).find((section) => section.id === "text-animator")!;
    expect(none.fields.map((field) => field.id)).toEqual(["inspector/textAnimator/add"]);
    expect(none.fields[0]!.actions!.map((action) => [action.name, action.unavailable])).toEqual([["add", undefined]]);
    const some = inspectorSections(inspectorPanel(doc([text("a", animator({ opacity: 0.5 }))]), ["a"])).find((section) => section.id === "text-animator")!;
    expect(some.fields.map((field) => field.label)).toEqual([
      "Text animator", "Range start", "Range end", "Range offset", "Shape", "Basis", "Amount", "Smoothness", "Ease high", "Ease low", "Randomize order", "Move X", "Move Y", "Scale", "Rotation", "Opacity", "Tracking",
    ]);
    expect(some.fields[0]!.actions!.map((action) => [action.name, action.unavailable])).toEqual([["add", "Every selected text already has one"], ["remove", undefined]]);
  });

  it("shows the values as the animator holds them, the opacity defaulting to 100%", () => {
    const panel = inspectorPanel(doc([text("a", animator({ x: 12, opacity: 0.25 }, { start: 0.2, offset: -0.5 }))]), ["a"]);
    const input = (key: string) => findNode(panel, `inspector/${key}`)!.input!.value;
    expect(input("textAnimator.x")).toBe("12");
    expect(input("textAnimator.selector.offset")).toBe("-0.5");
    // The range and the opacity are a percent of the text and of full, as the opacity row in Transform is.
    expect(input("textAnimator.opacity")).toBe("25%");
    expect(input("textAnimator.selector.start")).toBe("20%");
    expect(findNode(inspectorPanel(doc([text("a", animator())]), ["a"]), "inspector/textAnimator.opacity")!.input!.value).toBe("100%");
  });

  it("has a Tracking row in signed pixels that reads 0 when the animator holds none", () => {
    const panel = (extra: Record<string, unknown>) => inspectorPanel(doc([text("a", animator(extra))]), ["a"]);
    expect(findNode(panel({}), "inspector/textAnimator.tracking")!.input!.value).toBe("0");
    expect(findNode(panel({ tracking: -4.5 }), "inspector/textAnimator.tracking")!.input!.value).toBe("-4.5");
    expect(parseFieldInput("textAnimator.tracking", "-12")).toEqual({ value: -12 });
    expect(parseFieldInput("textAnimator.tracking", "wide")).toEqual({ refused: 'Tracking needs a finite number, not "wide"' });
  });

  it("refuses the whole section for a selection with something that is not text", () => {
    const nodes = animatorNodes(doc([text("a"), rect]), ["a", "r"]);
    expect(nodes[0]!.actions![0]!.unavailable).toBe("A text animator is a text choice: rect has none. Select only text");
    expect(animatorNodes(doc([rect]), ["r"])).toEqual([]);
  });

  it("takes a number from a person: a percent of the text for the range, never a range past the text", () => {
    expect(parseFieldInput("textAnimator.x", "12")).toEqual({ value: 12 });
    expect(parseFieldInput("textAnimator.selector.start", "20%")).toEqual({ value: 0.2 });
    expect(parseFieldInput("textAnimator.selector.end", "120%")).toEqual({ refused: "Range end must be between 0 and 1 (0% to 100%), not 120%" });
    expect(parseFieldInput("textAnimator.opacity", "abc")).toEqual({ refused: 'Opacity needs a finite number, not "abc"' });
  });
});

describe("the dropdowns", () => {
  it("are drawn for Shape and Basis, like the other text choices, and for nothing else of the section", () => {
    expect(isChoiceGroup("inspector/textAnimator/shape")).toBe(true);
    expect(isChoiceGroup("inspector/textAnimator/basis")).toBe(true);
    expect(isChoiceGroup("inspector/textAnimator/add")).toBe(false);
    expect(isChoiceGroup("inspector/textAnimator/randomize")).toBe(false);
  });
});

describe("ids", () => {
  it("are read back to the part and value they name, and nothing else", () => {
    expect(parseAnimatorId("inspector/textAnimator/add")).toEqual({ part: "add" });
    expect(parseAnimatorId("inspector/textAnimator/shape/rampUp")).toEqual({ part: "shape", value: "rampUp" });
    expect(parseAnimatorId("inspector/textAnimator/basis/charactersExcludingSpaces")).toEqual({ part: "basis", value: "charactersExcludingSpaces" });
    for (const bad of ["inspector/textAnimator/shape", "inspector/textAnimator/x", "inspector/textAnimator/add/extra1", "textAnimator/add", "inspector/textAnimator/shape/a-b"]) {
      expect(parseAnimatorId(bad), bad).toBeUndefined();
    }
  });
});

describe("the rows elsewhere in the Editor", () => {
  const keyed = doc([text("a", animator({ x: 10 }))], [{ objectId: "a", property: "textAnimator.x", keys: [{ frame: 0n, value: 0, easing: "linear" }, { frame: 10n, value: 100, easing: "linear" }] }]);

  it("have names a person reads, and a base value to key from", () => {
    expect(ANIMATOR_ROWS.map((row) => propertyLabel(row.property))).toEqual([
      "Animator · Range start", "Animator · Range end", "Animator · Range offset", "Animator · Move X", "Animator · Move Y", "Animator · Scale", "Animator · Rotation", "Animator · Opacity", "Animator · Tracking",
    ]);
    expect(baseValueOf(keyed, "a", "textAnimator.x")).toBe(10);
    expect(baseValueOf(keyed, "a", "textAnimator.opacity")).toBe(1);
    expect(baseValueOf(doc([text("a")]), "a", "textAnimator.x")).toBeUndefined();
  });

  it("are what the Draft view holds at a frame, inside the animator and not as a stray field", () => {
    const surface = { properties: ["textAnimator.x"], objectKinds: ["text"], propertyKinds: { "textAnimator.x": ["text"] }, easings: ["linear"] } as never;
    const drawn = previewSceneAt(keyed, 5, surface).document.objects[0] as unknown as Record<string, unknown> & { textAnimator: { x: number; selector: { end: number } } };
    expect(drawn.textAnimator.x).toBe(50);
    expect(drawn.textAnimator.selector.end).toBe(1);
    expect("textAnimator.x" in drawn).toBe(false);
    // A range scalar goes into the animator's selector, beside the rest of it.
    const range = doc([text("a", animator())], [{ objectId: "a", property: "textAnimator.selector.offset", keys: [{ frame: 0n, value: 0, easing: "linear" }, { frame: 10n, value: 1, easing: "linear" }] }]);
    const rangeSurface = { properties: ["textAnimator.selector.offset"], objectKinds: ["text"], propertyKinds: { "textAnimator.selector.offset": ["text"] }, easings: ["linear"] } as never;
    const held = previewSceneAt(range, 5, rangeSurface).document.objects[0] as unknown as { textAnimator: { selector: { offset: number; end: number; shape: string } } };
    expect(held.textAnimator.selector).toMatchObject({ offset: 0.5, end: 1, shape: "square" });
  });
});
