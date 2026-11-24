// Masks and track mattes in the Editor (11.117): what can carry them, what each control becomes as a scene edit, and the rules of
// the matte (the source's eye goes off, a matte chain has no end to read).
import { describe, expect, it } from "vitest";
import type { Mask, SceneDocument, SceneObject } from "@grapix/contracts";
import {
  MASK_MODES,
  MOST_MASKS,
  addMask,
  clearMatte,
  clips,
  copyMaskToShape,
  copyShapeToMask,
  copyableShapes,
  defaultMask,
  isRefused,
  maskSketches,
  maskStatus,
  maskTarget,
  matteSources,
  moveMask,
  patchMask,
  removeMask,
  setEffectMask,
  setMatte,
  matteWarning,
  setMatteMode,
  setPreserve,
  type MaskTarget,
} from "../src/mask-edit";
import { EMPTY_PEN, addPoint, closePath, penMaskEdit, penPlan, penPlanWords, type PenState } from "../src/pen-tool";
import { buildViewportOverlay, renderViewportOverlay } from "../src/overlay";
import { editPathEdit, editTarget, gestureOp } from "../src/path-edit";
import html from "../web/index.html?raw";
import main from "../web/main.ts?raw";

function object(id: string, extra: Record<string, unknown> = {}): SceneObject {
  return { id, name: id, type: "rect", x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, width: 200, height: 100, locked: false, visible: true, ...extra } as unknown as SceneObject;
}
const docOf = (...objects: SceneObject[]): SceneDocument => ({ canvas: { width: 1920, height: 1080 }, objects }) as unknown as SceneDocument;
const mask = (extra: Partial<Mask> = {}): Mask => ({ ...defaultMask(object("m")), ...extra });
function targetOf(masks: Mask[], extra: Record<string, unknown> = {}): MaskTarget {
  const outcome = maskTarget(docOf(object("a", { masks, ...extra })), ["a"]);
  if (isRefused(outcome)) throw new Error(outcome.refused);
  return outcome;
}
const editsOf = (outcome: unknown): { edit: string; objectId: string; masks: Mask[] } => {
  if (typeof outcome === "object" && outcome !== null && "refused" in outcome) throw new Error(String((outcome as { refused: string }).refused));
  return outcome as { edit: string; objectId: string; masks: Mask[] };
};

describe("what can carry a mask", () => {
  it("is one unlocked layer that draws pixels, and says why when it is not", () => {
    expect(isRefused(maskTarget(docOf(object("a")), []))).toBe(true);
    expect(isRefused(maskTarget(docOf(object("a"), object("b")), ["a", "b"]))).toBe(true);
    expect(maskTarget(docOf(object("a")), ["gone"])).toMatchObject({ refused: "That object is not in the scene." });
    expect(maskTarget(docOf(object("a", { type: "group", name: "G" })), ["a"])).toMatchObject({ refused: expect.stringContaining("draws no pixels") });
    expect(maskTarget(docOf(object("a", { locked: true })), ["a"])).toMatchObject({ refused: expect.stringContaining("locked") });
    for (const type of ["rect", "ellipse", "line", "shape", "text", "image"]) {
      expect(isRefused(maskTarget(docOf(object("a", { type })), ["a"]))).toBe(false);
    }
  });
});

describe("the mask list", () => {
  it("adds a rectangle over the layer's box, as one edit, and refuses past the most a layer takes", () => {
    const edit = editsOf(addMask(targetOf([])));
    expect(edit).toMatchObject({ edit: "setObjectMasks", objectId: "a" });
    expect(edit.masks).toHaveLength(1);
    expect(edit.masks[0]).toMatchObject({ mode: "add", feather: 0, expansion: 0, opacity: 1, inverted: false });
    expect(edit.masks[0]!.path.closed).toBe(true);
    expect(edit.masks[0]!.path.vertices).toEqual([{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }]);
    // A layer with no box gets a 100 x 100 one.
    expect(defaultMask(object("b", { width: 0, height: 0 })).path.vertices[2]).toEqual({ x: 100, y: 100 });
    const full = targetOf(Array.from({ length: MOST_MASKS }, () => mask()));
    expect(addMask(full)).toMatchObject({ refused: expect.stringContaining(String(MOST_MASKS)) });
  });

  it("reorders in one edit and removes by place", () => {
    const [a, b, c] = [mask({ mode: "add" }), mask({ mode: "subtract" }), mask({ mode: "intersect" })];
    const target = targetOf([a, b, c]);
    expect(editsOf(moveMask(target, 0, 1)).masks.map((m) => m.mode)).toEqual(["subtract", "add", "intersect"]);
    expect(editsOf(moveMask(target, 2, -1)).masks.map((m) => m.mode)).toEqual(["add", "intersect", "subtract"]);
    expect(moveMask(target, 0, -1)).toMatchObject({ refused: "That mask is already first." });
    expect(moveMask(target, 2, 1)).toMatchObject({ refused: "That mask is already last." });
    expect(moveMask(target, 7, 1)).toMatchObject({ refused: "There is no mask 8." });
    expect(editsOf(removeMask(target, 1)).masks.map((m) => m.mode)).toEqual(["add", "intersect"]);
    expect(removeMask(target, 3)).toMatchObject({ refused: "There is no mask 4." });
  });
});

describe("changing one mask", () => {
  it("changes only what was asked, with every mode available, and keeps the order", () => {
    const target = targetOf([mask({ mode: "add" }), mask({ mode: "subtract", opacity: 0.4 })]);
    for (const mode of MASK_MODES) {
      expect(editsOf(patchMask(target, 1, { mode })).masks[1]!.mode).toBe(mode);
    }
    const next = editsOf(patchMask(target, 1, { feather: 12, expansion: -3, inverted: true, opacity: 0.5 })).masks;
    expect(next[0]).toEqual(target.masks[0]);
    expect(next[1]).toMatchObject({ mode: "subtract", feather: 12, expansion: -3, inverted: true, opacity: 0.5 });
  });

  it("keeps feather y and a falloff only when they say something", () => {
    const target = targetOf([mask()]);
    const set = editsOf(patchMask(target, 0, { featherY: 0, falloff: "linear" })).masks[0]!;
    expect(set).toMatchObject({ featherY: 0, falloff: "linear" });
    // A feather y of null is "the same as feather": the key goes. A smooth falloff is the default: the key goes.
    const after = targetOf([set]);
    const cleared = editsOf(patchMask(after, 0, { featherY: null, falloff: "smooth" })).masks[0]!;
    expect("featherY" in cleared).toBe(false);
    expect("falloff" in cleared).toBe(false);
    // Changing something else leaves them as they were.
    expect(editsOf(patchMask(after, 0, { feather: 5 })).masks[0]).toMatchObject({ featherY: 0, falloff: "linear", feather: 5 });
  });

  it("refuses a value the engine would refuse, in the author's words, and an unknown mask", () => {
    const target = targetOf([mask()]);
    expect(patchMask(target, 0, { opacity: 1.2 })).toMatchObject({ refused: "Opacity is from 0 to 100%." });
    expect(patchMask(target, 0, { feather: 251 })).toMatchObject({ refused: expect.stringContaining("250") });
    expect(patchMask(target, 0, { featherY: -1 })).toMatchObject({ refused: expect.stringContaining("250") });
    expect(patchMask(target, 0, { expansion: 1001 })).toMatchObject({ refused: expect.stringContaining("1000") });
    expect(patchMask(target, 0, { feather: Number.NaN })).toMatchObject({ refused: expect.any(String) });
    expect(patchMask(target, 4, { feather: 1 })).toMatchObject({ refused: "There is no mask 5." });
  });

  it("says what a mask does, including why it does nothing", () => {
    const open = mask({ path: { ...mask().path, closed: false } });
    expect(clips(open)).toBe(false);
    expect(maskStatus(open)).toContain("does not clip until it is closed");
    expect(clips(mask({ mode: "none" }))).toBe(false);
    expect(maskStatus(mask({ mode: "none" }))).toContain("shapes nothing");
    expect(clips(mask())).toBe(true);
    expect(maskStatus(mask({ mode: "darken", inverted: true }))).toBe("Darken, inverted.");
  });
});

describe("the track matte", () => {
  const plate = (extra: Record<string, unknown> = {}): SceneObject => object("plate", { name: "Plate", ...extra });
  const spot = (extra: Record<string, unknown> = {}): SceneObject => object("spot", { name: "Spot", type: "ellipse", ...extra });

  it("lists the layers that can be a matte: not itself, not drawing nothing, not one that has a matte", () => {
    const group = object("g", { type: "group" });
    const matted = object("m", { trackMatte: { sourceId: "spot", mode: "alpha" } });
    const names = matteSources(docOf(plate(), spot(), group, matted), "plate").map((o) => o.id);
    expect(names).toEqual(["spot"]);
  });

  it("sets the source and turns its eye off in the same batch, so one undo returns both", () => {
    const edits = setMatte(docOf(plate(), spot()), "plate", "spot", "luma");
    expect(edits).toEqual([
      { edit: "setTrackMatte", objectId: "plate", trackMatte: { sourceId: "spot", mode: "luma" } },
      { edit: "setObjectVisible", objectId: "spot", visible: false },
    ]);
    // A source already hidden is not touched again.
    expect(setMatte(docOf(plate(), spot({ visible: false })), "plate", "spot", "alpha")).toEqual([
      { edit: "setTrackMatte", objectId: "plate", trackMatte: { sourceId: "spot", mode: "alpha" } },
    ]);
  });

  it("refuses what the engine would, by name", () => {
    const docA = docOf(plate(), spot());
    expect(setMatte(docA, "plate", "plate", "alpha")).toMatchObject({ refused: expect.stringContaining("own matte") });
    expect(setMatte(docA, "plate", "gone", "alpha")).toMatchObject({ refused: "That matte source is not in the scene." });
    expect(setMatte(docA, "gone", "spot", "alpha")).toMatchObject({ refused: "That object is not in the scene." });
    expect(setMatte(docOf(plate(), spot({ locked: true })), "plate", "spot", "alpha")).toMatchObject({ refused: expect.stringContaining("locked") });
    expect(setMatte(docOf(plate(), object("g", { type: "group", name: "G" })), "plate", "g", "alpha")).toMatchObject({ refused: expect.stringContaining("draws no pixels") });
    // 3.30: a source with a matte of its own, and a layer that is already someone's matte, may take one: a matte reads its source first.
    const chained = docOf(plate(), spot({ trackMatte: { sourceId: "x", mode: "alpha" } }), object("x"));
    expect(Array.isArray(setMatte(chained, "plate", "spot", "alpha"))).toBe(true);
    const used = docOf(plate(), spot(), object("other", { trackMatte: { sourceId: "plate", mode: "alpha" } }));
    expect(Array.isArray(setMatte(used, "plate", "spot", "alpha"))).toBe(true);
    // A matte whose source is gone passes through, and says so by name.
    const orphan = docOf(plate({ trackMatte: { sourceId: "gone", mode: "alpha" } }));
    expect(matteWarning(orphan, orphan.objects[0]!)).toContain("gone");
    expect(matteWarning(chained, chained.objects[1]!)).toBeUndefined();
  });

  it("changes the mode alone, and clears without bringing the source back", () => {
    const matted = plate({ trackMatte: { sourceId: "spot", mode: "alpha" } });
    expect(setMatteMode(matted, "lumaInverted")).toEqual({ edit: "setTrackMatte", objectId: "plate", trackMatte: { sourceId: "spot", mode: "lumaInverted" } });
    expect(clearMatte(matted)).toEqual({ edit: "setTrackMatte", objectId: "plate" });
    expect(setMatteMode(plate(), "luma")).toMatchObject({ refused: "Plate has no track matte." });
    expect(clearMatte(plate())).toMatchObject({ refused: "Plate has no track matte." });
  });
});

describe("editing a mask's path with the path tools", () => {
  it("targets the mask, by its place, and keeps the shape's own rules (lock, group)", () => {
    const withMask = object("a", { masks: [mask(), mask({ path: { ...mask().path, closed: false } })] });
    const target = editTarget(docOf(withMask), ["a"], 1);
    expect(target).toMatchObject({ mask: 1, paths: [{ subpath: 0 }] });
    expect("refused" in target).toBe(false);
    expect(editTarget(docOf(withMask), ["a"], 5)).toMatchObject({ refused: "a has no mask 6." });
    expect(editTarget(docOf({ ...withMask, locked: true } as SceneObject), ["a"], 0)).toMatchObject({ refused: expect.stringContaining("locked") });
    // Without a mask index a rect is still not a shape.
    expect(editTarget(docOf(withMask), ["a"])).toMatchObject({ refused: expect.stringContaining("not a shape") });
    const edit = editPathEdit("a", 0, { op: "reverse" } as never, 1) as unknown as { target: unknown };
    expect(edit.target).toEqual({ kind: "mask", index: 1 });
    expect((editPathEdit("a", 2, { op: "reverse" } as never) as unknown as { target: unknown }).target).toEqual({ kind: "shape", subpath: 2 });
  });
});

describe("the page", () => {
  it("has a place for the masks under Properties and draws them with the selection", () => {
    expect(html).toContain('id="masks-mount"');
    expect(main).toContain('masks: need<HTMLDivElement>("masks-mount")');
    // renderInspector draws the masks, so they follow the selection and every scene change.
    expect(main).toMatch(/renderMasks\(document_\);\s*refreshInspectorFrame\(model\);/);
  });

  it("sends each change as one edit and turns the source's eye off with a new matte", () => {
    expect(main).toContain("sendMaskEdit(setMatte(document_, object.id, source.value");
    expect(main).toContain('void runEdits(Array.isArray(edit) ? edit : [edit as SceneEdit], label, "scene")');
    // A refused change is told to the author and sends nothing.
    expect(main).toMatch(/"refused" in edit\) \{\s*log\(edit\.refused, "bad"\);\s*return;/);
  });

  it("lets the path tools edit a mask's path, and forgets the mask with the selection and the tool", () => {
    expect(main).toContain("editTarget(scene, selection, pathMask, currentFrame)");
    expect(main).toContain("editTarget(active, selection, pathMask, currentFrame)");
    expect(main).toContain("editPathEdit(id, subpath, op, target.mask, frame, pathEditRevision(target, subpath))");
    expect(main).toMatch(/pathSelected = \[\];\s*pathMask = undefined;/);
    expect(main).toMatch(/dropPathState\(\);\s*pathMask = undefined;/);
    expect(main).toMatch(/pathMask = index;[\s\S]*setActiveTool\("path"\)/);
  });
});

describe("what the Pen makes (11.111)", () => {
  const square = (): PenState => {
    let state = EMPTY_PEN;
    for (const [x, y] of [[100, 100], [300, 100], [300, 200], [100, 200]] as const) state = addPoint(state, { x, y });
    return closePath(state);
  };
  const selected = (objects: SceneObject[], ids: string[], creates: "auto" | "shape" | "mask") => penPlan(docOf(...objects), ids, creates);

  it("is a mask in Auto when one layer that is not a shape is selected, and a shape otherwise", () => {
    const rect = object("r", { name: "Card" });
    expect(selected([rect], ["r"], "auto")).toMatchObject({ kind: "mask" });
    expect(selected([rect], [], "auto")).toEqual({ kind: "shape" });
    expect(selected([rect, object("s", { type: "shape" })], ["s"], "auto")).toEqual({ kind: "shape" });
    expect(selected([rect, object("t")], ["r", "t"], "auto")).toEqual({ kind: "shape" });
    // A locked layer is left alone in Auto: a new shape, not a change to it.
    expect(selected([object("r", { locked: true })], ["r"], "auto")).toEqual({ kind: "shape" });
    // Said before the first click.
    expect(penPlanWords(selected([rect], ["r"], "auto"))).toBe("The Pen will draw a mask on Card.");
    expect(penPlanWords({ kind: "shape" })).toBe("The Pen will draw a new shape.");
  });

  it("obeys Shape and Mask, and says why a mask cannot be made", () => {
    const rect = object("r", { name: "Card" });
    expect(selected([rect], ["r"], "shape")).toEqual({ kind: "shape" });
    expect(selected([rect, object("s", { type: "shape" })], ["s"], "mask")).toMatchObject({ kind: "mask" });
    expect(selected([rect], [], "mask")).toMatchObject({ refused: expect.stringContaining("Select a layer") });
    expect(selected([object("r", { locked: true, name: "Card" })], ["r"], "mask")).toMatchObject({ refused: expect.stringContaining("locked") });
  });

  it("puts the drawn path on the layer, in the layer's own space, as one setObjectMasks", () => {
    const card = object("r", { name: "Card", x: 50, y: 20 });
    const made = penMaskEdit(docOf(card), square(), card);
    if ("refused" in made) throw new Error(made.refused);
    expect(made.edits).toHaveLength(1);
    const edit = made.edits[0] as unknown as { edit: string; objectId: string; masks: Mask[] };
    expect(edit).toMatchObject({ edit: "setObjectMasks", objectId: "r" });
    expect(edit.masks).toHaveLength(1);
    expect(edit.masks[0]).toMatchObject({ mode: "add", feather: 0, expansion: 0, opacity: 1, inverted: false });
    expect(edit.masks[0]!.path).toMatchObject({ closed: true, vertices: [{ x: 50, y: 80 }, { x: 250, y: 80 }, { x: 250, y: 180 }, { x: 50, y: 180 }] });
    // It goes after the masks the layer has, and a turned and scaled layer reads the points through its turn and scale.
    const turned = object("t", { x: 0, y: 0, rotation: 90, scaleX: 2, scaleY: 2 });
    const second = penMaskEdit(docOf(turned), square(), turned) as unknown as { edits: { masks: Mask[] }[] };
    const [v0] = second.edits[0]!.masks[0]!.path.vertices;
    // canvas (100,100) = R(90) S(2) q  =>  q = (50, -50)
    expect(v0!.x).toBeCloseTo(50, 6);
    expect(v0!.y).toBeCloseTo(-50, 6);
    const has = object("h", { masks: [mask()] });
    expect((penMaskEdit(docOf(has), square(), has) as unknown as { edits: { masks: Mask[] }[] }).edits[0]!.masks).toHaveLength(2);
  });

  it("refuses an open path and a layer scaled to nothing, by name, and takes a layer in a group through the group", () => {
    const card = object("r", { name: "Card" });
    let open = EMPTY_PEN;
    for (const [x, y] of [[0, 0], [10, 0], [10, 10]] as const) open = addPoint(open, { x, y });
    expect(penMaskEdit(docOf(card), open, card)).toMatchObject({ refused: expect.stringContaining("closed path") });
    // The card is in a group at (300, 200): the square's corner (100,100) is (-200,-100) in the card.
    const group = object("g", { type: "group", childIds: ["r"], x: 300, y: 200 });
    const through = penMaskEdit(docOf(group, card), square(), card) as unknown as { edits: { masks: Mask[] }[] };
    expect(through.edits[0]!.masks[0]!.path.vertices[0]).toEqual({ x: -200, y: -100 });
    const flat = object("f", { name: "Flat", scaleX: 0 });
    expect(penMaskEdit(docOf(flat), square(), flat)).toMatchObject({ refused: expect.stringContaining("scaled to nothing") });
  });

  it("is wired in the page: a choice, a note before the first click, no resume while it makes a mask", () => {
    expect(html).toContain('id="pen-creates"');
    expect(html).toContain('id="pen-creates-note"');
    expect(main).toContain('penCreates = ui.penCreates.value as PenCreates;');
    expect(main).toMatch(/showPenCreates\(\);\s*const context = commandContext\(\);/);
    expect(main).toMatch(/const plan = currentPenPlan\(\);\s*if \("refused" in plan \|\| plan\.kind !== "shape"\) return false;/);
    expect(main).toContain("? penMaskEdit(scene, pen, plan.object)");
  });
});

describe("a path copied between a shape and a mask (11.118)", () => {
  const closed = { closed: true, vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }], inTangents: Array(4).fill({ x: 0, y: 0 }), outTangents: Array(4).fill({ x: 0, y: 0 }) };
  const star = (extra: Record<string, unknown> = {}): SceneObject => object("s", { name: "Star", type: "shape", path: closed, x: 100, y: 40, ...extra });
  const card = (extra: Record<string, unknown> = {}): SceneObject => object("c", { name: "Card", x: 10, y: 5, ...extra });

  it("copies the shape's path into the layer's own space, as a new mask on the end of the stack, in one edit", () => {
    const doc = docOf(star(), card());
    const target = maskTarget(doc, ["c"]);
    if (isRefused(target)) throw new Error(target.refused);
    const edit = copyShapeToMask(doc, target, "s") as unknown as { edit: string; masks: Mask[] };
    expect(edit.edit).toBe("setObjectMasks");
    // Shape point (0,0) is canvas (100,40); the card is at (10,5): so (90,35) in the card.
    expect(edit.masks[0]!.path.vertices[0]).toEqual({ x: 90, y: 35 });
    expect(edit.masks[0]!.path.vertices[2]).toEqual({ x: 190, y: 85 });
    expect(edit.masks[0]).toMatchObject({ mode: "add", inverted: false });
    // An independent copy: the shape's own path is untouched and shares nothing with the mask.
    expect(edit.masks[0]!.path.vertices).not.toBe(closed.vertices);
    expect(closed.vertices[0]).toEqual({ x: 0, y: 0 });
  });

  it("offers closed shapes, in groups too, and refuses the rest by name", () => {
    const open = star({ id: "o", name: "Line", path: { ...closed, closed: false } });
    const group = object("g", { type: "group", childIds: ["in"] });
    const inside = star({ id: "in", name: "Inside" });
    const doc = docOf(star(), open, group, inside, card());
    expect(copyableShapes(doc, "c").map((o) => o.id)).toEqual(["s", "in"]);
    const target = maskTarget(doc, ["c"]);
    if (isRefused(target)) throw new Error(target.refused);
    expect(copyShapeToMask(doc, target, "o")).toMatchObject({ refused: expect.stringContaining("open path") });
    expect("refused" in (copyShapeToMask(doc, target, "in") as object)).toBe(false);
    expect(copyShapeToMask(doc, target, "gone")).toMatchObject({ refused: "That shape is not in the scene." });
    expect(copyShapeToMask(doc, target, "c")).toMatchObject({ refused: "That shape is not in the scene." });
  });

  it("copies a mask to a new shape where the mask is on the canvas, and back gives the same path", () => {
    const withMask = card({ masks: [{ ...mask(), path: closed }] });
    const doc = docOf(withMask);
    const made = copyMaskToShape(doc, withMask, 0) as unknown as { edit: string; name: string; path: typeof closed };
    expect(made).toMatchObject({ edit: "createShape", name: "Card mask 1" });
    expect(made.path.vertices[0]).toEqual({ x: 10, y: 5 });
    // The new shape sits at the canvas origin with canvas points; copying it back onto the card returns the mask's own path.
    const shape = { ...star({ x: 0, y: 0 }), path: made.path } as SceneObject;
    const target = maskTarget(docOf(shape, card()), ["c"]);
    if (isRefused(target)) throw new Error(target.refused);
    const back = copyShapeToMask(docOf(shape, card()), target, "s") as unknown as { masks: Mask[] };
    expect(back.masks[0]!.path.vertices).toEqual(closed.vertices);
    expect(copyMaskToShape(doc, withMask, 3)).toMatchObject({ refused: "There is no mask 4." });
  });

  it("is wired in the page", () => {
    expect(main).toContain("copyMaskToShape(document_, object, index)");
    expect(main).toContain("copyShapeToMask(document_, target, shapePick.value)");
  });
});

describe("effect mask references and Preserve Underlying Transparency (3.28)", () => {
  const fx = (effectId: string, extra: Record<string, unknown> = {}) => ({ effectId, enabled: true, effect: "invert", ...extra });
  const withEffects = (masks: Mask[], effects: unknown[]) => object("a", { name: "Card", masks, effects });

  it("gives every new mask an id that no mask of the layer has, and keeps it through a reorder", () => {
    expect(defaultMask(object("a"), []).id).toBe("mask-1");
    expect(defaultMask(object("a"), [mask({ id: "mask-1" }), mask({ id: "mask-3" })]).id).toBe("mask-2");
    const target = targetOf([mask({ id: "mask-1" }), mask({ id: "mask-2", mode: "subtract" })]);
    expect(editsOf(addMask(target)).masks.map((m) => m.id)).toEqual(["mask-1", "mask-2", "mask-3"]);
    expect(editsOf(moveMask(target, 1, -1)).masks.map((m) => m.id)).toEqual(["mask-2", "mask-1"]);
    expect(editsOf(patchMask(target, 0, { feather: 4 })).masks[0]!.id).toBe("mask-1");
  });

  it("limits one effect to one mask of the layer, or back to the whole layer, as one setEffects", () => {
    const card = withEffects([mask({ id: "mask-1" })], [fx("blur"), fx("glow", { maskIds: ["mask-1"] })]);
    const limited = setEffectMask(card, 0, "mask-1") as unknown as { edit: string; effects: { effectId: string; maskIds?: string[] }[] };
    expect(limited.edit).toBe("setEffects");
    expect(limited.effects.map((e) => e.maskIds)).toEqual([["mask-1"], ["mask-1"]]);
    const whole = setEffectMask(card, 1, null) as unknown as { effects: { maskIds?: string[] }[] };
    expect("maskIds" in whole.effects[1]!).toBe(false);
    expect(setEffectMask(card, 5, "mask-1")).toMatchObject({ refused: "Card has no effect 6." });
    expect(setEffectMask(card, 0, "gone")).toMatchObject({ refused: "Card has no mask with the id gone." });
  });

  it("clears an effect's reference first when its mask is removed, so the engine never sees a dangling one", () => {
    const card = withEffects([mask({ id: "mask-1" }), mask({ id: "mask-2" })], [fx("glow", { maskIds: ["mask-1"] }), fx("blur", { maskIds: ["mask-1", "mask-2"] })]);
    const target = maskTarget(docOf(card), ["a"]);
    if (isRefused(target)) throw new Error(target.refused);
    const edits = removeMask(target, 0) as unknown as { edit: string; effects?: { effectId: string; maskIds?: string[] }[]; masks?: Mask[] }[];
    expect(edits.map((e) => e.edit)).toEqual(["setEffects", "setObjectMasks"]);
    expect(edits[0]!.effects!.map((e) => e.maskIds)).toEqual([undefined, ["mask-2"]]);
    expect(edits[1]!.masks!.map((m) => m.id)).toEqual(["mask-2"]);
    // A mask nothing refers to is just removed.
    const plain = maskTarget(docOf(withEffects([mask({ id: "mask-1" })], [fx("blur")])), ["a"]);
    if (isRefused(plain)) throw new Error(plain.refused);
    expect((removeMask(plain, 0) as unknown as { edit: string }).edit).toBe("setObjectMasks");
  });

  it("turns Preserve Underlying Transparency on and off, and says when it already is so", () => {
    expect(setPreserve(object("a"), true)).toEqual({ edit: "setPreserveTransparency", objectId: "a", preserve: true });
    expect(setPreserve(object("a", { preserveUnderlyingTransparency: true }), false)).toEqual({ edit: "setPreserveTransparency", objectId: "a", preserve: false });
    expect(setPreserve(object("a"), false)).toMatchObject({ refused: expect.stringContaining("already") });
    expect(setPreserve(object("a", { preserveUnderlyingTransparency: true }), true)).toMatchObject({ refused: expect.stringContaining("already") });
  });

  it("is wired in the page", () => {
    expect(main).toContain("setEffectMask(object, effectIndex, pick.value");
    expect(main).toContain('sendMaskEdit(setPreserve(object, preserveBox.checked)');
  });
});

describe("the masks on the canvas (11.117)", () => {
  it("draws each mask's boundary through the layer's place, with the band its feather softens", () => {
    const card = object("c", { x: 50, y: 20, scaleX: 2, scaleY: 2, masks: [mask({ feather: 6, featherY: 10 }), mask({ mode: "none" }), mask({ path: { ...mask().path, closed: false } })] });
    const sketches = maskSketches(docOf(card), card, 1);
    expect(sketches).toHaveLength(3);
    // The rectangle (0,0)-(200,100) of the layer, doubled, from (50,20): corner (450,220).
    expect(sketches[0]!.d.startsWith("M 50 20 C")).toBe(true);
    expect(sketches[0]!.d.endsWith("Z")).toBe(true);
    expect(sketches[0]!.d).toContain("450 20");
    // Feather 6 along x, 10 along y: their mean, doubled by the scale.
    expect(sketches[0]!.feather).toBe(16);
    expect(sketches.map((s) => s.mode)).toEqual(["add", "none", "add"]);
    expect(sketches.map((s) => s.active)).toEqual([false, true, false]);
    expect(sketches.map((s) => s.open)).toEqual([false, false, true]);
    expect(sketches[2]!.d.endsWith("Z")).toBe(false);
    expect(maskSketches(docOf(object("n")), object("n"))).toEqual([]);
  });

  it("is a primitive of the overlay, drawn as a boundary and a feather band, dashed when open", () => {
    const card = object("c", { masks: [mask({ feather: 8 }), mask({ path: { ...mask().path, closed: false }, feather: 8 })] });
    const model = buildViewportOverlay(docOf(card), { selectedIds: ["c"], masks: maskSketches(docOf(card), card) });
    expect(model.primitives.some((p) => p.kind === "masks")).toBe(true);
    expect(buildViewportOverlay(docOf(card), { selectedIds: ["c"] }).primitives.some((p) => p.kind === "masks")).toBe(false);
    // A bare fake of the SVG elements the renderer makes, as the overlay tests use.
    class Fake {
      readonly attributes = new Map<string, string>();
      readonly children: Fake[] = [];
      constructor(readonly tag: string) {}
      setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
      append(...kids: Fake[]): void { this.children.push(...kids); }
      replaceChildren(...kids: Fake[]): void { this.children.length = 0; this.children.push(...kids); }
    }
    const root = new Fake("svg");
    renderViewportOverlay({ createElementNS: (_ns: string, tag: string) => new Fake(tag) } as unknown as Document, root as unknown as SVGSVGElement, model);
    const group = root.children.find((child) => child.attributes.get("class") === "overlay-masks")!;
    const classes = group.children.map((child) => child.attributes.get("class"));
    expect(classes.filter((c) => c === "overlay-mask-feather")).toHaveLength(1);
    expect(classes.filter((c) => c?.startsWith("overlay-mask "))).toHaveLength(2);
    expect(classes.filter((c) => c?.includes("is-open"))).toHaveLength(1);
  });

  it("is wired in the page for the selected layer, with the mask the path tools edit marked", () => {
    expect(main).toContain("...maskSketchesFor(active),");
    expect(main).toContain("maskSketches(active, object, activeTool === \"path\"");
  });
});

describe("the Pen settings (11.116)", () => {
  it("are read into the Pen and path tools: the angle step, the pick distance and the double click", () => {
    expect(main).toContain("const editorPen = { angle: 15, pick: PICK_RADIUS, doubleClickEnds: true, snap: true, fit: 1 };");
    expect(main).toContain("applyPenSettings(settingsSnapshot.user);");
    expect(main).toContain("pen = addPoint(pen, at, event.shiftKey, editorPen.angle);");
    expect(main).toContain("constrain(last, at, editorPen.angle)");
    expect(main).toContain("degrees: editorPen.angle");
    expect(main).toContain("step: editorPen.angle");
    expect(main).toContain("PICK_RADIUS * overlayUnit()".replace("PICK_RADIUS", "editorPen.pick"));
    expect(main).toContain("editorPen.doubleClickEnds && event.timeStamp - penFinishedAt >= 500");
  });

  it("hold a dragged handle to the step asked for, 15 degrees when none is", () => {
    const path = { closed: false, vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }], inTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }], outTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }] };
    const doc = docOf(object("s", { type: "shape", path, width: 100, height: 100 }));
    const target = editTarget(doc, ["s"]);
    if ("refused" in target) throw new Error(target.refused);
    const gesture = { hit: { kind: "handle" as const, subpath: 0, index: 0, side: "out" as const }, start: { x: 0, y: 0 }, moving: [] };
    // Drag the handle to 20 degrees off the x axis, 100 long.
    const at = { x: 100 * Math.cos((20 * Math.PI) / 180), y: 100 * Math.sin((20 * Math.PI) / 180) };
    const angle = (step?: number): number => {
      const made = gestureOp(target, gesture, at, { shift: true, alt: false, ...(step === undefined ? {} : { step }) });
      const op = made!.op as unknown as { vector: { x: number; y: number } };
      return Math.round((Math.atan2(op.vector.y, op.vector.x) * 180) / Math.PI);
    };
    expect(angle()).toBe(15);
    expect(angle(45)).toBe(0);
    expect(angle(10)).toBe(20);
  });
});

describe("keys and clicks of the pen family (11.116)", () => {
  it("goes on through Pen, Add, Delete and Convert when G is pressed again, and Alt-click converts a vertex", () => {
    expect(main).toContain('const PEN_FAMILY: readonly PageTool[] = ["pen", "vertex-add", "vertex-delete", "vertex-convert"];');
    expect(main).toContain('decision.command === "edit.pen" && event.key.toLowerCase() === "g" && PEN_FAMILY.includes(activeTool)');
    expect(main).toContain("(PEN_FAMILY.indexOf(activeTool) + 1) % PEN_FAMILY.length");
    expect(main).toContain('event.altKey && hit?.kind === "vertex"');
    expect(main).toContain('clickOp("convert", hit, target)');
  });
});

describe("snapping in the page (11.110)", () => {
  it("snaps a placed Pen point and the vertex or handle being dragged, and ends the snap with the gesture", () => {
    expect(main).toContain("const at = snapAt(eventScenePoint(event), event, new Set(), pen.points.map((p) => ({ x: p.x, y: p.y })));");
    expect(main).toContain("const at = penPull === event.pointerId ? raw : snapAt(raw, event,");
    expect(main).toContain("const at = snapGrab(target, pathGesture.gesture, rawAt, event);");
    expect(main).toContain("snapGrab(target, drag.gesture, at, event)");
    expect(main).toMatch(/event\.ctrlKey \|\| event\.metaKey \|\| event\.shiftKey \|\| !editorPen\.snap/);
    expect(main).toMatch(/function cancelPen\(\): void \{\s*penRefused = false;\s*endSnap\(\);/);
    expect(main).toMatch(/function dropPathState\(\): void \{\s*endSnap\(\);/);
    expect(main).toContain("editorPen.snap = user.penSnap;");
  });
});

describe("a refused Pen path (11.111)", () => {
  it("is given back, and a second Escape lets it go, so the Pen is never stuck with it", () => {
    expect(main).toContain("penRefused = true;");
    expect(main).toMatch(/\} else if \(penRefused\) \{\s*\/\/[^\n]*\n\s*penRefused = false;\s*cancelPen\(\);/);
    expect(main).toMatch(/function cancelPen\(\): void \{\s*penRefused = false;/);
    expect(main).toMatch(/penRefused = false;\s*pen = addPoint\(pen, at, event\.shiftKey, editorPen\.angle\);/);
  });
});

describe("Remove Point, Keep Shape in the page (11.113)", () => {
  it("is Alt-click with the Delete Vertex tool, within the tolerance setting", () => {
    expect(main).toContain('clickOp(tool, hit, target, tool === "delete" && event.altKey ? editorPen.fit : undefined)');
    expect(main).toContain("editorPen.fit = user.penFitTolerance;");
  });
});
