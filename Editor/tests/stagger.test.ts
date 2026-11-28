// Stagger animations (plan row 11.77): which elements move, by how many steps, in what order the writes go, what refuses the whole gesture, and that the
// result is the same batch of key moves a drag sends (so one undo takes it all back).

import { describe, expect, it } from "vitest";

import type { SceneDocument, SceneEdit, SceneObject } from "@grapix/contracts";
import { isRefused, planMove } from "../src/timeline/key-edit";
import { keyId, timelineModel } from "../src/timeline/model";
import { planAddKeys, BAR_BUTTONS, barState } from "../src/timeline/keyframe-bar";
import {
  DEFAULT_STAGGER,
  STAGGER_NEEDS_KEYS,
  STAGGER_NEEDS_TWO,
  planStagger,
  staggerBlocker,
  staggerDeltas,
  staggerElements,
  staggerLabel,
  staggerSteps,
  staggeredSelection,
  type StaggerOptions,
} from "../src/timeline/stagger";

const rect = (id: string): SceneObject => ({ type: "rect", id, name: id, radius: 0, x: 0, y: 0 }) as unknown as SceneObject;

/** A scene whose layers are `layers` in that order, each animating `x` at the frames given. */
const scene = (animated: Record<string, number[]>, layers: string[] = Object.keys(animated), durationFrames = 200): SceneDocument =>
  ({
    id: "s",
    name: "S",
    version: 1,
    workingColorSpace: "srgb",
    colorDepth: "32",
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    timeline: {
      durationFrames,
      channels: Object.entries(animated).map(([objectId, frames]) => ({
        objectId,
        property: "x",
        keys: frames.map((frame) => ({ frame, value: frame, easing: "linear" })),
      })),
      phases: [],
      pathChannels: [],
    },
    dataContext: {},
    assets: [],
    fonts: [],
    materials: [],
    controls: [],
    textStyles: [],
    pathLinks: [],
    guides: [],
    objects: layers.map(rect),
  }) as unknown as SceneDocument;

const opts = (extra: Partial<StaggerOptions> = {}): StaggerOptions => ({ ...DEFAULT_STAGGER, ...extra });
const editsOf = (plan: unknown): SceneEdit[] => (plan as { edits: SceneEdit[] }).edits;
const k = (objectId: string, frame: number, property = "x"): string => keyId(objectId, property, frame);
const moves = (plan: ReturnType<typeof planStagger>) =>
  isRefused(plan) ? plan : (plan.edits as unknown as { objectId: string; fromFrame: number; toFrame: number }[]).map((e) => `${e.objectId}:${e.fromFrame}>${e.toFrame}`);

describe("how many steps each position moves", () => {
  it("is 0, 1, 2… down the list", () => {
    expect(staggerSteps(4, { reverse: false, fromCentre: false })).toEqual([0, 1, 2, 3]);
  });

  it("is the other way round with Reverse, so the first element is the last to move", () => {
    expect(staggerSteps(4, { reverse: true, fromCentre: false })).toEqual([3, 2, 1, 0]);
  });

  it("is the distance from the middle with From centre: the middle stays, and each one further out is a step later on both sides", () => {
    expect(staggerSteps(3, { reverse: false, fromCentre: true })).toEqual([1, 0, 1]);
    expect(staggerSteps(5, { reverse: false, fromCentre: true })).toEqual([2, 1, 0, 1, 2]);
  });

  it("keeps the middle PAIR together when the count is even", () => {
    expect(staggerSteps(4, { reverse: false, fromCentre: true })).toEqual([1, 0, 0, 1]);
    expect(staggerSteps(6, { reverse: false, fromCentre: true })).toEqual([2, 1, 0, 0, 1, 2]);
  });

  it("puts the ends first and the middle last with From centre and Reverse", () => {
    expect(staggerSteps(5, { reverse: true, fromCentre: true })).toEqual([0, 1, 2, 1, 0]);
  });
});

describe("which elements are staggered, in what order", () => {
  const doc = scene({ a: [0], b: [0], c: [0] }, ["a", "b", "c"]);

  it("takes layer order from the scene's layers, whatever order the keys were selected in", () => {
    expect(staggerElements(doc, [k("c", 0), k("a", 0), k("b", 0)], "layer")).toEqual(["a", "b", "c"]);
  });

  it("takes selection order from the order the first key of each element was selected", () => {
    expect(staggerElements(doc, [k("c", 0), k("a", 0), k("c", 5), k("b", 0)], "selection")).toEqual(["c", "a", "b"]);
  });

  it("lists an element once however many of its keys are selected", () => {
    expect(staggerElements(doc, [k("a", 0), k("a", 5, "y"), k("b", 0)], "layer")).toEqual(["a", "b"]);
  });

  it("puts an element the scene does not have after the layers", () => {
    expect(staggerElements(doc, [k("ghost", 0), k("a", 0)], "layer")).toEqual(["a", "ghost"]);
  });
});

describe("what Stagger needs", () => {
  const doc = scene({ a: [0], b: [0] });

  it("needs keys, then keys on two elements", () => {
    expect(staggerBlocker(doc, [])).toBe(STAGGER_NEEDS_KEYS);
    expect(staggerBlocker(doc, [k("a", 0), k("a", 5)])).toBe(STAGGER_NEEDS_TWO);
    expect(staggerBlocker(doc, [k("a", 0), k("b", 0)])).toBeUndefined();
    expect(staggerBlocker(null, [k("a", 0), k("b", 0)])).toBe("Open a scene first");
  });

  it("is dimmed on the KEYFRAME bar with the same reasons, and drawn before Zoom to fit", () => {
    expect(BAR_BUTTONS.map((b) => b.action).slice(-3)).toEqual(["stagger", "fit", "auto-key"]);
    expect(barState(doc, [], []).stagger.disabled).toBe(STAGGER_NEEDS_KEYS);
    expect(barState(doc, [k("a", 0)], []).stagger.disabled).toBe(STAGGER_NEEDS_TWO);
    expect(barState(doc, [k("a", 0), k("b", 0)], []).stagger).toEqual({});
  });

  it("refuses a step of 0 by name, and a step that is not a whole number", () => {
    const keys = [k("a", 0), k("b", 0)];
    expect(staggerDeltas(doc, keys, opts({ step: 0 }))).toMatchObject({ refused: expect.stringContaining("a step of 0 frames moves nothing") });
    expect(staggerDeltas(doc, keys, opts({ step: 2.5 }))).toEqual({ refused: "the step is a whole number of frames, not 2.5" });
    expect(staggerDeltas(doc, keys, opts({ step: Number.NaN }))).toEqual({ refused: "the step is a whole number of frames, not NaN" });
  });

  it("refuses From centre with fewer than three elements, saying why", () => {
    expect(staggerDeltas(doc, [k("a", 0), k("b", 0)], opts({ fromCentre: true }))).toEqual({
      refused: "From centre needs keys on at least three elements: with two there is no middle one",
    });
  });

  it("refuses keys of an element the scene does not have", () => {
    expect(staggerDeltas(doc, [k("a", 0), k("ghost", 0)], opts())).toEqual({ refused: "a selected key belongs to ghost, which this scene does not have" });
  });

  it("refuses an unreadable key id and an empty selection", () => {
    expect(staggerDeltas(doc, ["nonsense"], opts())).toEqual({ refused: "a selected key is unreadable" });
    expect(staggerDeltas(doc, [], opts())).toEqual({ refused: STAGGER_NEEDS_KEYS });
  });
});

describe("the stagger as one gesture", () => {
  const doc = scene({ a: [0, 10], b: [0, 10], c: [0, 10] });
  const plan = (selected: string[], extra: Partial<StaggerOptions> = {}, document = doc) => planStagger(document, timelineModel(document), selected, opts(extra));
  const all = [k("a", 0), k("a", 10), k("b", 0), k("b", 10), k("c", 0), k("c", 10)];
  // One key each, far from any other, so a stagger lands on free frames.
  const lone = scene({ a: [0, 100], b: [0, 100], c: [0, 100] });
  const three = [k("a", 0), k("b", 0), k("c", 0)];

  it("leaves the first element where it is and moves each next one by one more step, keeping each element's spacing", () => {
    const made = moves(plan(all));
    expect(made).not.toHaveProperty("refused");
    expect(made).toEqual(expect.arrayContaining(["b:10>15", "b:0>5", "c:10>20", "c:0>10"]));
    expect(made).toHaveLength(4);
    expect((made as string[]).some((m) => m.startsWith("a:"))).toBe(false);
  });

  it("writes rightward moves from the rightmost key first, so a run never collides with itself", () => {
    // b's keys move 5 right onto 5 and 15: with c's keys on 0 and 10 moving 10, the writes for each channel go rightmost first.
    const made = moves(plan(all)) as string[];
    expect(made.indexOf("b:10>15")).toBeLessThan(made.indexOf("b:0>5"));
    expect(made.indexOf("c:10>20")).toBeLessThan(made.indexOf("c:0>10"));
  });

  it("can stagger earlier with a negative step, writing leftward moves leftmost first", () => {
    const late = scene({ a: [40, 50], b: [40, 50], c: [40, 50] });
    const made = moves(plan([k("a", 40), k("a", 50), k("b", 40), k("b", 50), k("c", 40), k("c", 50)], { step: -5 }, late)) as string[];
    expect(made).toEqual(expect.arrayContaining(["b:40>35", "b:50>45", "c:40>30", "c:50>40"]));
    expect(made.indexOf("b:40>35")).toBeLessThan(made.indexOf("b:50>45"));
  });

  it("follows the layer order, so a different order of selection gives the same stagger", () => {
    expect(moves(plan([k("c", 0), k("b", 0), k("a", 0)]))).toEqual(moves(plan([k("a", 0), k("b", 0), k("c", 0)])));
  });

  it("follows the selection order when asked, so the element selected first stays", () => {
    const made = moves(plan([k("c", 0), k("b", 0), k("a", 0)], { order: "selection" }, lone)) as string[];
    expect(made).toEqual(expect.arrayContaining(["b:0>5", "a:0>10"]));
    expect(made.some((m) => m.startsWith("c:"))).toBe(false);
  });

  it("moves the first element last with Reverse", () => {
    const made = moves(plan(three, { reverse: true }, lone)) as string[];
    expect(made).toEqual(expect.arrayContaining(["a:0>10", "b:0>5"]));
    expect(made.some((m) => m.startsWith("c:"))).toBe(false);
  });

  it("moves the ends and not the middle with From centre", () => {
    const made = moves(plan(three, { fromCentre: true }, lone)) as string[];
    expect(made).toEqual(expect.arrayContaining(["a:0>5", "c:0>5"]));
    expect(made.some((m) => m.startsWith("b:"))).toBe(false);
  });

  it("moves only the selected keys, not the rest of an element's keys", () => {
    const made = moves(plan(three, {}, lone)) as string[];
    expect([...made].sort()).toEqual(["b:0>5", "c:0>10"]);
  });

  it("sends the SAME moves a drag of those keys sends, so it is one history entry like any move", () => {
    const keys = [k("b", 0), k("b", 10)];
    const dragged = planMove(timelineModel(doc), keys, 5);
    const staggered = planStagger(doc, timelineModel(doc), [k("a", 0), ...keys], opts());
    expect(isRefused(dragged) || isRefused(staggered)).toBe(false);
    expect(editsOf(staggered)).toEqual(editsOf(dragged));
    expect(editsOf(staggered).every((e) => e.edit === "moveKeyframe")).toBe(true);
  });

  it("refuses the WHOLE gesture when one key would land on a frame another key holds, naming it", () => {
    const crowded = scene({ a: [0, 10], b: [0, 5, 10], c: [0, 10] });
    const refused = plan([k("a", 0), k("b", 0), k("c", 0)], {}, crowded);
    expect(refused).toEqual({ refused: "frame 5 on b.x already has a key" });
  });

  it("lets a run of selected keys slide onto frames the run itself vacates", () => {
    const run = scene({ a: [0, 5, 10], b: [0, 5, 10] });
    const made = plan([k("a", 0), k("b", 0), k("b", 5), k("b", 10)], { step: 5 }, run);
    expect(moves(made)).toEqual(["b:10>15", "b:5>10", "b:0>5"]);
  });

  it("refuses the whole gesture when a key would leave the timeline, at either edge", () => {
    expect(plan(all, { step: 50 }, scene({ a: [0, 10], b: [0, 10], c: [0, 10] }, undefined, 60))).toEqual({
      refused: "frame 100 is outside the 60-frame timeline",
    });
    const early = scene({ a: [2, 10], b: [2, 10], c: [2, 10] });
    expect(plan([k("a", 2), k("b", 2), k("c", 2)], { step: -2 }, early)).toEqual({ refused: "frame -2 is before the start of the timeline" });
  });

  it("does not write the keys that stay where they are", () => {
    const planned = planStagger(doc, timelineModel(doc), [k("a", 0), k("b", 0, "x")], opts());
    expect(editsOf(planned)).toHaveLength(1);
  });

  it("moves a path key with its own edit, like a drag does, beside a plain key", () => {
    const square = { closed: true, vertices: [], inTangents: [], outTangents: [], vertexIds: [], vertexKinds: [] };
    const withPath = {
      ...scene({ q: [0, 100] }, ["q", "p"]),
      timeline: {
        durationFrames: 200,
        channels: [{ objectId: "q", property: "x", keys: [0, 100].map((frame) => ({ frame, value: frame, easing: "linear" })) }],
        phases: [],
        pathChannels: [{ objectId: "p", target: { kind: "shape", subpath: 0 }, keys: [0, 100].map((frame) => ({ frame, path: square, easing: "linear" })) }],
      },
    } as unknown as SceneDocument;
    const planned = planStagger(withPath, timelineModel(withPath), [k("q", 0), keyId("p", "path", 0)], opts({ order: "layer" }));
    if (isRefused(planned)) throw new Error(planned.refused);
    expect(planned.edits).toEqual([{ edit: "movePathKey", objectId: "p", target: { kind: "shape", subpath: 0 }, fromFrame: 0, toFrame: 5 }]);
  });

  it("is labelled with how many elements, the step and the options", () => {
    expect((plan(all) as { label: string }).label).toBe("Stagger 3 elements by +5 frames");
    const late = scene({ a: [40, 50], b: [40, 50], c: [40, 50] });
    const lateKeys = [k("a", 40), k("b", 40), k("c", 40)];
    expect((plan(lateKeys, { step: -1, fromCentre: true, reverse: true }, late) as { label: string }).label).toBe("Stagger 3 elements by -1 frame (from the centre, reversed)");
    expect(staggerLabel(2, opts({ step: 1 }))).toBe("Stagger 2 elements by +1 frame");
  });
});

describe("the selection after a stagger", () => {
  it("follows the keys that moved: each key id with its frame moved by its element's step", () => {
    const doc = scene({ a: [0], b: [0, 10] });
    const keys = [k("a", 0), k("b", 0), k("b", 10)];
    const made = staggerDeltas(doc, keys, opts());
    if ("refused" in made) throw new Error(made.refused);
    expect(staggeredSelection(keys, made.deltas)).toEqual([k("a", 0), k("b", 5), k("b", 15)]);
  });

  it("is unchanged where nothing moves", () => {
    expect(staggeredSelection([k("a", 7)], new Map())).toEqual([k("a", 7)]);
  });
});

describe("nothing else in the timeline changed", () => {
  it("still adds keys at the playhead as before", () => {
    const doc = scene({ a: [0, 10] });
    expect(isRefused(planAddKeys(doc, ["a"], 5, "linear"))).toBe(false);
  });
});
