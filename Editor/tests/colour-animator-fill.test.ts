// The text animator's glyph colour in the Editor (row 11.61, on codex's release 795/796): `textAnimatorFill`, the colour fully selected
// glyphs take, is a third colour property. A row "Animator fill" in the Colour section for a text with an animator, set as a held field of
// the animator (`setTextAnimator`) or keyed (`createColourKey`), a timeline track, motion on the card, and what the Draft view draws.

import { describe, expect, it } from "vitest";

import type { AnimationSurface, Rgba, SceneDocument } from "@grapix/contracts";

import { arrowFrame, colourAt, colourField, colourLabel, colourOfField, colourRowNodes, planColourChange, planColourKeyToggle, staticColour, hexOf } from "../src/colour-anim";
import { elementCard } from "../src/element-card";
import { applyColourChannels } from "../src/preview-playback";
import { timelineModel } from "../src/timeline/model";

const srgb = (r: number, g: number, b: number, a = 1): Rgba => ({ r, g, b, a, space: "srgb" });
const animator = (fill?: Rgba) => ({ selector: { start: 0, end: 1, offset: 0, amount: 1, shape: "square", smoothness: 1, easeHigh: 0, easeLow: 0, randomizeOrder: false }, x: 0, y: 0, scale: 1, rotation: 0, ...(fill === undefined ? {} : { fill }) });
const text = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, type: "text", fontId: "f", size: 40, align: "left", verticalAlign: "top", layout: "point", autoFit: "none", strokeWidth: 0, fill: { type: "solid", color: srgb(0, 0, 1) }, ...extra });

const doc = (objects: unknown[], keys: { frame: number; value: Rgba }[] = [], objectId = "a"): SceneDocument =>
  ({
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    objects,
    fonts: [],
    timeline: {
      durationFrames: 100n,
      channels: [],
      phases: [],
      pathChannels: [],
      colourChannels: keys.length === 0 ? undefined : [{ objectId, property: "textAnimatorFill", keys: keys.map((k) => ({ frame: BigInt(k.frame), value: k.value, easing: "linear" })) }],
    },
  }) as unknown as SceneDocument;

const surface = { colourPropertyKinds: { fill: ["text", "rect"], stroke: ["text", "rect"], textAnimatorFill: ["text"] }, easings: ["linear"] } as unknown as AnimationSurface;
const easing = "linear" as never;

describe("the Animator fill row", () => {
  it("is offered only when every selected element is a text with an animator", () => {
    const ids = (document: SceneDocument, selected: string[]) => colourRowNodes(document, selected, surface, 0).map((row) => row.id);
    const withIt = doc([text("a", { textAnimator: animator() }), text("b", { textAnimator: animator() })]);
    expect(ids(withIt, ["a"])).toEqual(["colour/fill", "colour/stroke", "colour/textAnimatorFill"]);
    expect(ids(withIt, ["a", "b"])).toContain("colour/textAnimatorFill");
    const mixed = doc([text("a", { textAnimator: animator() }), text("b")]);
    expect(ids(mixed, ["a", "b"])).not.toContain("colour/textAnimatorFill");
    expect(ids(mixed, ["b"])).not.toContain("colour/textAnimatorFill");
    const rect = doc([{ id: "r", name: "r", type: "rect", fill: { type: "solid", color: srgb(1, 0, 0) } }]);
    expect(ids(rect, ["r"])).not.toContain("colour/textAnimatorFill");
    expect(colourRowNodes(withIt, ["a"], { colourPropertyKinds: { fill: ["text"], stroke: ["text"] } } as unknown as AnimationSurface, 0).map((row) => row.id)).not.toContain("colour/textAnimatorFill");
  });

  it("says Not set until a colour exists, offering the text's own colour to start from, then says the colour", () => {
    const row = (document: SceneDocument) => colourRowNodes(document, ["a"], surface, 0).find((node) => node.id === "colour/textAnimatorFill")!;
    const unset = row(doc([text("a", { textAnimator: animator() })]));
    expect(unset.label).toBe("Animator fill");
    expect(unset.value).toBe("Not set · glyphs keep their colour");
    expect(unset.input).toEqual({ type: "color", value: "#0000ff" });
    expect(unset.actions!.find((action) => action.name === "edit")!.unavailable).toBeUndefined();
    const set = row(doc([text("a", { textAnimator: animator(srgb(1, 0, 0, 0.5)) })]));
    expect(set.value).toBe("#ff0000 · 50%");
    expect(set.input).toEqual({ type: "color", value: "#ff0000" });
    // With no solid fill of its own, an animator's colour starts from white.
    const bare = row(doc([text("a", { fill: { type: "none" }, textAnimator: animator() })]));
    expect(bare.input!.value).toBe("#ffffff");
  });

  it("says Not set only when no selected text has a colour, and Mixed when some do", () => {
    const both = doc([text("a", { textAnimator: animator(srgb(1, 0, 0)) }), text("b", { textAnimator: animator() })]);
    const row = colourRowNodes(both, ["a", "b"], surface, 0).find((node) => node.id === "colour/textAnimatorFill")!;
    expect(row.value).toBe("Mixed");
  });

  it("reads the keyed value at the playhead, and the diamond and arrows follow the keys", () => {
    const keyed = doc([text("a", { textAnimator: animator() })], [{ frame: 0, value: srgb(0, 0, 0) }, { frame: 10, value: srgb(1, 1, 1) }]);
    const row = (frame: number) => colourRowNodes(keyed, ["a"], surface, frame).find((node) => node.id === "colour/textAnimatorFill")!;
    expect(row(0).value).toBe("#000000 · 100%");
    expect(row(10).value).toBe("#ffffff · 100%");
    expect(row(0).actions!.find((action) => action.name === "key")!.label).toBe("◆");
    expect(row(5).actions!.find((action) => action.name === "key")!.label).toBe("◇");
    expect(arrowFrame(keyed, ["a"], "textAnimatorFill", 5, "next")).toBe(10);
    expect(arrowFrame(keyed, ["a"], "textAnimatorFill", 5, "prev")).toBe(0);
  });
});

describe("static and keyed values", () => {
  it("are the animator's field, or a reason in words", () => {
    const withIt = doc([text("a", { textAnimator: animator(srgb(1, 0, 0)) }), text("b", { textAnimator: animator() }), text("c")]);
    expect(staticColour(withIt.objects[0]!, "textAnimatorFill")).toEqual(srgb(1, 0, 0));
    expect(staticColour(withIt.objects[1]!, "textAnimatorFill")).toEqual({ not: "b's text animator has no colour yet" });
    expect(staticColour(withIt.objects[2]!, "textAnimatorFill")).toEqual({ not: "c has no text animator" });
    const keyed = doc([text("a", { textAnimator: animator(srgb(1, 0, 0)) })], [{ frame: 0, value: srgb(0, 1, 0) }]);
    expect(colourAt(keyed, keyed.objects[0]!, "textAnimatorFill", 3)).toEqual(srgb(0, 1, 0));
  });
});

describe("changing the animator's colour", () => {
  const unset = doc([text("a", { textAnimator: animator() })]);
  const set = doc([text("a", { textAnimator: animator(srgb(1, 0, 0, 0.5)) })]);

  it("sets the animator's field, keeping the rest of the animator, when nothing is keyed and Auto-key is off", () => {
    const plan = planColourChange(set, ["a"], "textAnimatorFill", "#00ff00", 0, false, easing);
    expect(plan).toEqual({ edits: [{ edit: "setTextAnimator", objectIds: ["a"], animator: { ...animator(), fill: srgb(0, 1, 0, 0.5) } }], label: "Change animator fill colour" });
    // The first pick starts from the text's own colour: its space, and full alpha.
    const first = planColourChange(unset, ["a"], "textAnimatorFill", "#00ff00", 0, false, easing);
    expect(first).toMatchObject({ edits: [{ edit: "setTextAnimator", animator: { fill: srgb(0, 1, 0, 1) } }] });
  });

  it("keys it at the playhead with Auto-key on, and updates a key that is there", () => {
    const plan = planColourChange(unset, ["a"], "textAnimatorFill", "#00ff00", 12, true, easing);
    expect(plan).toMatchObject({ label: "Key animator fill colour at frame 12", edits: [{ edit: "createColourKey", objectId: "a", property: "textAnimatorFill", keyframe: { frame: 12, value: srgb(0, 1, 0, 1), easing: "linear" } }] });
    const keyed = doc([text("a", { textAnimator: animator() })], [{ frame: 12, value: srgb(0, 0, 0) }]);
    const update = planColourChange(keyed, ["a"], "textAnimatorFill", "#ff0000", 12, false, easing);
    expect(update).toMatchObject({ edits: [{ edit: "updateColourKey", objectId: "a", property: "textAnimatorFill", keyframe: { value: srgb(1, 0, 0, 1) } }] });
  });

  it("refuses a text with no animator by name", () => {
    expect(planColourChange(doc([text("a")]), ["a"], "textAnimatorFill", "#00ff00", 0, false, easing)).toEqual({ refused: "a has no text animator" });
    expect(planColourKeyToggle(doc([text("a")]), ["a"], "textAnimatorFill", 0, easing)).toEqual({ refused: "a has no text animator" });
  });

  it("keys the current colour with the diamond, starting from the text's own colour when none is set, and takes it away again", () => {
    const add = planColourKeyToggle(unset, ["a"], "textAnimatorFill", 4, easing);
    expect(add).toMatchObject({ label: "Add textAnimatorFill colour key at frame 4", edits: [{ edit: "createColourKey", property: "textAnimatorFill", keyframe: { frame: 4, value: srgb(0, 0, 1) } }] });
    const keyed = doc([text("a", { textAnimator: animator() })], [{ frame: 4, value: srgb(0, 0, 1) }]);
    expect(planColourKeyToggle(keyed, ["a"], "textAnimatorFill", 4, easing)).toMatchObject({ edits: [{ edit: "removeColourKey", objectId: "a", property: "textAnimatorFill", frame: 4 }] });
  });
});

describe("the track, the card and the Draft view", () => {
  const keyed = doc([text("a", { textAnimator: animator(srgb(1, 0, 0)) })], [{ frame: 0, value: srgb(0, 0, 1) }, { frame: 50, value: srgb(1, 0, 0) }]);

  it("is a track named Animator fill colour, kept apart from Fill colour", () => {
    expect(colourField("textAnimatorFill")).toBe("colour.textAnimatorFill");
    expect(colourOfField("colour.textAnimatorFill")).toBe("textAnimatorFill");
    expect(colourLabel("textAnimatorFill")).toBe("Animator fill colour");
    const track = timelineModel(keyed).tracks.find((candidate) => candidate.property === "colour.textAnimatorFill")!;
    expect([track.label, track.colourProperty]).toEqual(["Animator fill colour", "textAnimatorFill"]);
  });

  it("shows on the element card as motion", () => {
    const rows = elementCard(keyed, keyed.objects[0]!).sections.flatMap((section) => section.rows);
    expect(rows.find((row) => row.label === "Animated")!.value).toContain("Animator fill colour");
  });

  it("is drawn by the Draft view as the animator's colour at the frame, the animator otherwise whole", () => {
    const at25 = applyColourChannels(keyed, 25);
    const object = at25.objects[0] as unknown as { textAnimator: { fill: Rgba; scale: number }; fill: unknown };
    expect(hexOf(object.textAnimator.fill)).toBe("#bc00bc");
    expect(object.textAnimator.scale).toBe(1);
    // The text's own fill is not the keyed colour's business.
    expect(object.fill).toEqual({ type: "solid", color: srgb(0, 0, 1) });
    // A key for an object that has no animator draws nothing.
    const orphan = doc([text("a")], [{ frame: 0, value: srgb(0, 0, 1) }]);
    expect((applyColourChannels(orphan, 0).objects[0] as unknown as { textAnimator?: unknown }).textAnimator).toBeUndefined();
  });
});
