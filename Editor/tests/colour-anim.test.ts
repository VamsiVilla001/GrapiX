// Solid colour animation in the Editor (row 11.132, frontend; Jev A on all three, docs/evidence/11.132/jev-laya-colour-ui.json):
// the values match the contract's evaluation, a change keys or sets the static paint by the number rows' rule, the diamond toggles,
// and the timeline moves, deletes and eases colour keys with the colour edits.

import { describe, expect, it } from "vitest";

import type { AnimationSurface, Rgba, SceneDocument } from "@grapix/contracts";

import { findNode } from "../src/agent-surface";
import {
  arrowFrame,
  colourAt,
  colourField,
  colourOfField,
  colourRowNodes,
  evaluateColour,
  fromHex,
  hexOf,
  planColourChange,
  planColourKeyToggle,
  toLinear,
  toSpace,
} from "../src/colour-anim";
import { elementCard } from "../src/element-card";
import { applyColourChannels, previewSceneAt } from "../src/preview-playback";
import { planDelete, planMove, planSetEasing } from "../src/timeline/key-edit";
import { keyId, timelineModel } from "../src/timeline/model";

const srgb = (r: number, g: number, b: number, a = 1): Rgba => ({ r, g, b, a, space: "srgb" });
const solid = (color: Rgba) => ({ type: "solid", color });

const doc = (colourKeys: { frame: number; value: Rgba; easing?: string }[] = [], extra: Record<string, unknown> = {}): SceneDocument =>
  ({
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    objects: [
      { id: "a", name: "A", type: "rect", fill: solid(srgb(1, 0, 0)), stroke: solid(srgb(0, 0, 1)), ...extra },
      { id: "b", name: "B", type: "rect", fill: solid(srgb(1, 0, 0)) },
      { id: "g", name: "G", type: "group" },
    ],
    timeline: {
      durationFrames: 100n,
      channels: [],
      phases: [],
      pathChannels: [],
      colourChannels:
        colourKeys.length === 0
          ? undefined
          : [{ objectId: "a", property: "fill", keys: colourKeys.map((k) => ({ frame: BigInt(k.frame), value: k.value, easing: k.easing ?? "linear" })) }],
    },
  }) as unknown as SceneDocument;

const surface = { colourPropertyKinds: { fill: ["rect", "ellipse", "text", "shape"], stroke: ["rect", "ellipse", "text", "shape", "line"] }, easings: ["linear"] } as unknown as AnimationSurface;

describe("colour values, as the contract works them out", () => {
  it("converts between sRGB and linear light both ways", () => {
    const grey = srgb(0.5, 0.5, 0.5);
    expect(toLinear(grey)[0]).toBeCloseTo(0.21404, 4);
    const back = toSpace(toSpace(grey, "linear"), "srgb");
    expect(back.r).toBeCloseTo(0.5, 10);
    expect(toSpace(grey, "srgb")).toBe(grey);
  });

  it("reads and writes hex as sRGB, keeping the space and alpha asked for", () => {
    expect(hexOf(srgb(1, 0.5, 0))).toBe("#ff8000");
    expect(hexOf(toSpace(srgb(1, 0.5, 0), "linear"))).toBe("#ff8000");
    const linear = fromHex("#808080", "linear", 0.5)!;
    expect(linear.space).toBe("linear");
    expect(linear.a).toBe(0.5);
    expect(linear.r).toBeCloseTo(toLinear(srgb(128 / 255, 0, 0))[0], 10);
    expect(fromHex("#80808", "srgb", 1)).toBeUndefined();
    expect(fromHex("red", "srgb", 1)).toBeUndefined();
  });

  it("mixes in linear light between keys, holds the ends, and keeps the first key's space", () => {
    const channel = { objectId: "a", property: "fill" as const, keys: [
      { frame: 10n, value: srgb(0, 0, 0), easing: "linear" as const },
      { frame: 20n, value: srgb(1, 1, 1, 0), easing: "linear" as const },
    ] };
    expect(evaluateColour(channel, 0)).toEqual(srgb(0, 0, 0));
    expect(evaluateColour(channel, 10)).toEqual(srgb(0, 0, 0));
    expect(evaluateColour(channel, 25)).toEqual(srgb(1, 1, 1, 0));
    const middle = evaluateColour(channel, 15)!;
    expect(middle.space).toBe("srgb");
    expect(middle.a).toBeCloseTo(0.5, 10);
    // Half of linear white, encoded: brighter than 0.5, as light mixes.
    expect(middle.r).toBeCloseTo(0.7353569830524495, 10);
    const held = { ...channel, keys: [{ ...channel.keys[0]!, easing: "hold" as const }, channel.keys[1]!] };
    expect(evaluateColour(held, 19)).toEqual(srgb(0, 0, 0));
    expect(evaluateColour({ ...channel, keys: [] }, 5)).toBeUndefined();
  });

  it("shows the static paint when nothing is keyed, and says why a gradient or no paint cannot be animated", () => {
    const document = doc();
    expect(colourAt(document, document.objects[0]!, "fill", 0)).toEqual(srgb(1, 0, 0));
    const gradient = doc([], { fill: { type: "linear-gradient" } });
    expect(colourAt(gradient, gradient.objects[0]!, "fill", 0)).toEqual({ not: "A's fill is a gradient: only a solid colour is animated" });
    const none = doc([], { stroke: undefined });
    expect(colourAt(none, none.objects[0]!, "stroke", 0)).toEqual({ not: "A has no stroke" });
  });
});

describe("changing a colour, by the number rows' rule", () => {
  it("sets the static paint when nothing is keyed and Auto-key is off", () => {
    const plan = planColourChange(doc(), ["a"], "fill", "#00ff00", 5, false, "linear");
    expect(plan).toEqual({ edits: [{ edit: "setPaint", objectIds: ["a"], slot: "fill", paint: { type: "solid", color: srgb(0, 1, 0) } }], label: "Change fill colour" });
  });

  it("keys it at the playhead with Auto-key on, or when it is already keyed; updates a key that is there", () => {
    const auto = planColourChange(doc(), ["a"], "fill", "#00ff00", 5, true, "linear");
    expect(auto).toEqual({ edits: [{ edit: "createColourKey", objectId: "a", property: "fill", keyframe: { frame: 5, value: srgb(0, 1, 0), easing: "linear" } }], label: "Key fill colour at frame 5" });
    const keyed = doc([{ frame: 0, value: srgb(1, 0, 0) }, { frame: 10, value: srgb(0, 0, 1), easing: "ease-in-out" }]);
    const update = planColourChange(keyed, ["a"], "fill", "#00ff00", 10, false, "linear");
    expect(update).toEqual({ edits: [{ edit: "updateColourKey", objectId: "a", property: "fill", keyframe: { frame: 10n, value: srgb(0, 1, 0), easing: "ease-in-out" } }], label: "Key fill colour at frame 10" });
  });

  it("keeps each object's colour space and alpha, and refuses a gradient, a bad hex and an empty selection", () => {
    const linear = doc([], { fill: solid({ r: 0, g: 0, b: 0, a: 0.25, space: "linear" }) });
    const plan = planColourChange(linear, ["a"], "fill", "#ffffff", 0, false, "linear");
    expect("edits" in plan && (plan.edits[0] as { paint: { color: Rgba } }).paint.color).toEqual({ r: 1, g: 1, b: 1, a: 0.25, space: "linear" });
    expect(planColourChange(doc([], { fill: { type: "linear-gradient" } }), ["a"], "fill", "#ffffff", 0, false, "linear")).toEqual({ refused: "A's fill is a gradient: only a solid colour is animated" });
    expect(planColourChange(doc(), ["a"], "fill", "#fff", 0, false, "linear")).toEqual({ refused: "#fff is not a colour: use #rrggbb" });
    expect(planColourChange(doc(), [], "fill", "#ffffff", 0, false, "linear")).toEqual({ refused: "Select an element first" });
  });
});

describe("the diamond and the arrows", () => {
  it("adds a key at the current colour on every selected element, or removes them when all are keyed there", () => {
    const add = planColourKeyToggle(doc(), ["a", "b"], "fill", 7, "linear");
    expect(add).toEqual({
      edits: [
        { edit: "createColourKey", objectId: "a", property: "fill", keyframe: { frame: 7, value: srgb(1, 0, 0), easing: "linear" } },
        { edit: "createColourKey", objectId: "b", property: "fill", keyframe: { frame: 7, value: srgb(1, 0, 0), easing: "linear" } },
      ],
      label: "Add fill colour key at frame 7",
    });
    const keyed = doc([{ frame: 7, value: srgb(0, 0, 0) }]);
    expect(planColourKeyToggle(keyed, ["a"], "fill", 7, "linear")).toEqual({ edits: [{ edit: "removeColourKey", objectId: "a", property: "fill", frame: 7 }], label: "Remove fill colour key at frame 7" });
    // Only one of two keyed there: the other gets its key, the keyed one is left alone.
    const some = planColourKeyToggle(keyed, ["a", "b"], "fill", 7, "linear");
    expect("edits" in some && some.edits.map((edit) => (edit as { objectId: string }).objectId)).toEqual(["b"]);
  });

  it("goes to the nearest key before or after the playhead", () => {
    const keyed = doc([{ frame: 0, value: srgb(0, 0, 0) }, { frame: 20, value: srgb(1, 1, 1) }, { frame: 40, value: srgb(0, 0, 0) }]);
    expect(arrowFrame(keyed, ["a"], "fill", 25, "prev")).toBe(20);
    expect(arrowFrame(keyed, ["a"], "fill", 25, "next")).toBe(40);
    expect(arrowFrame(keyed, ["a"], "fill", 0, "prev")).toBeUndefined();
    expect(arrowFrame(keyed, ["a"], "fill", 40, "next")).toBeUndefined();
  });
});

describe("the Fill and Stroke rows", () => {
  it("are offered for the kinds the surface lists, with the colour in words and a picker", () => {
    const rows = colourRowNodes(doc(), ["a"], surface, 0);
    expect(rows.map((row) => [row.id, row.value, row.input?.type, row.input?.value])).toEqual([
      ["colour/fill", "#ff0000 · 100%", "color", "#ff0000"],
      ["colour/stroke", "#0000ff · 100%", "color", "#0000ff"],
    ]);
    expect(colourRowNodes(doc(), ["g"], surface, 0)).toEqual([]);
    expect(colourRowNodes(doc(), ["a", "g"], surface, 0)).toEqual([]);
    expect(colourRowNodes(doc(), ["a"], undefined, 0)).toEqual([]);
  });

  it("say Mixed when the selection differs, and dim everything but the arrows with the reason for a gradient", () => {
    const differ = doc([], { fill: solid(srgb(0, 1, 0)) });
    expect(colourRowNodes(differ, ["a", "b"], surface, 0)[0]!.value).toBe("Mixed");
    const gradient = colourRowNodes(doc([], { fill: { type: "linear-gradient" } }), ["a"], surface, 0)[0]!;
    expect(gradient.input).toBeUndefined();
    expect(gradient.actions!.find((action) => action.name === "key")!.unavailable).toBe("A's fill is a gradient: only a solid colour is animated");
  });

  it("show a filled diamond on a key, and dim an arrow with nothing to go to", () => {
    const keyed = doc([{ frame: 10, value: srgb(0, 0, 0) }]);
    const on = colourRowNodes(keyed, ["a"], surface, 10)[0]!;
    expect(on.actions!.find((action) => action.name === "key")!.label).toBe("◆");
    expect(on.actions!.find((action) => action.name === "prev")!.unavailable).toBe("No key before the playhead");
    const off = colourRowNodes(doc(), ["a"], surface, 10)[0]!;
    expect(off.actions!.find((action) => action.name === "key")!.label).toBe("◇");
    expect(off.actions!.find((action) => action.name === "next")!.unavailable).toBe("Not animated yet");
    expect(findNode(on, "colour/fill")).toBe(on);
  });
});

describe("colour keys in the timeline", () => {
  const keyed = doc([{ frame: 0, value: srgb(0, 0, 0) }, { frame: 10, value: srgb(1, 1, 1) }]);
  const model = timelineModel(keyed);

  it("are a track named Fill colour, kept apart from number properties", () => {
    const track = model.tracks.find((candidate) => candidate.property === colourField("fill"))!;
    expect(track.label).toBe("Fill colour");
    expect(track.colourProperty).toBe("fill");
    expect(colourOfField("colour.stroke")).toBe("stroke");
    expect(colourOfField("fill")).toBeUndefined();
    expect(colourOfField("opacity")).toBeUndefined();
    expect(colourOfField("colour.other")).toBeUndefined();
    expect(colourOfField("colour.fills")).toBeUndefined();
  });

  it("move, delete and ease with the colour edits", () => {
    const id = keyId("a", "colour.fill", 10);
    expect(planMove(model, [id], 5)).toMatchObject({ edits: [{ edit: "moveColourKey", objectId: "a", property: "fill", fromFrame: 10, toFrame: 15 }] });
    expect(planDelete([id])).toMatchObject({ edits: [{ edit: "removeColourKey", objectId: "a", property: "fill", frame: 10 }] });
    expect(planSetEasing(model, [keyId("a", "colour.fill", 0)], "ease-in-out")).toMatchObject({
      edits: [{ edit: "updateColourKey", objectId: "a", property: "fill", keyframe: { frame: 0n, value: srgb(0, 0, 0), easing: "ease-in-out" } }],
    });
  });
});

describe("colour keys elsewhere in the Editor", () => {
  const keyed = doc([{ frame: 0, value: srgb(0, 0, 1) }, { frame: 50, value: srgb(1, 0, 0) }]);

  it("are drawn by the Draft view: the paint at a frame is the track's value", () => {
    const at25 = applyColourChannels(keyed, 25);
    const fill = (at25.objects[0] as unknown as { fill: { type: string; color: Rgba } }).fill;
    expect(fill.type).toBe("solid");
    expect(hexOf(fill.color)).toBe("#bc00bc");
    // The other object and the stroke keep what was authored; a scene with no colour keys is the same scene.
    expect(at25.objects[1]).toBe(keyed.objects[1]);
    expect((at25.objects[0] as unknown as { stroke: unknown }).stroke).toEqual(solid(srgb(0, 0, 1)));
    const plain = doc();
    expect(applyColourChannels(plain, 25)).toBe(plain);
  });

  it("show on the element card as motion, and the card's colour says it is animated", () => {
    const card = elementCard(keyed, keyed.objects[0]!);
    const rows = card.sections.flatMap((section) => section.rows);
    expect(rows.find((row) => row.label === "Animated")!.value).toContain("Fill colour");
    expect(rows.find((row) => row.label === "Keyframes")!.value).toBe("2");
    expect(rows.find((row) => row.label === "Colour")!.value).toBe("Animated: see Fill in Properties");
  });
});

describe("colour values between keys, the finer points", () => {
  const from = { frame: 0n, value: srgb(0.5, 0.2, 0.8, 1), easing: "linear" as const };
  const to = { frame: 10n, value: srgb(1, 0.6, 0.1, 0.5), easing: "linear" as const };
  const channel = { objectId: "a", property: "fill" as const, keys: [from, to] };

  it("mixes mid-tones in linear light, not in the encoded numbers", () => {
    const middle = evaluateColour(channel, 5)!;
    const expected = toSpace(
      { r: (toLinear(from.value)[0] + toLinear(to.value)[0]) / 2, g: (toLinear(from.value)[1] + toLinear(to.value)[1]) / 2, b: (toLinear(from.value)[2] + toLinear(to.value)[2]) / 2, a: 0.75, space: "linear" },
      "srgb",
    );
    expect(middle.r).toBeCloseTo(expected.r, 10);
    expect(middle.g).toBeCloseTo(expected.g, 10);
    expect(middle.b).toBeCloseTo(expected.b, 10);
    expect(middle.r).not.toBeCloseTo(0.75, 3);
  });

  it("holds the key's own colour until the next key", () => {
    const held = { ...channel, keys: [{ ...from, easing: "hold" as const }, to] };
    expect(evaluateColour(held, 9)).toBe(held.keys[0]!.value);
  });

  it("never eases past the next key's colour, even with Elastic", () => {
    const elastic = { ...channel, keys: [{ ...from, value: srgb(0, 0, 0), easing: "elastic" as const }, { ...to, value: srgb(1, 1, 1, 1) }] };
    for (let frame = 0; frame <= 10; frame += 1) {
      const value = evaluateColour(elastic, frame)!;
      expect(value.r, `frame ${frame}`).toBeLessThanOrEqual(1);
      expect(value.r, `frame ${frame}`).toBeGreaterThanOrEqual(0);
    }
  });

  it("are what the Draft view draws at a frame", () => {
    const keyed = doc([{ frame: 0, value: srgb(0, 0, 1) }, { frame: 50, value: srgb(1, 0, 0) }]);
    const drawn = previewSceneAt(keyed, 25, null).document;
    expect(hexOf((drawn.objects[0] as unknown as { fill: { color: Rgba } }).fill.color)).toBe("#bc00bc");
  });
});
