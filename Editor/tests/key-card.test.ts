import { describe, expect, it } from "vitest";

import { frameText, keyCard, overTimeLabel, planSetInfluence, planSetKeyFrame, planSetPreset, planSetKeyValue, shownValue, storedValue } from "../src/timeline/key-card";
import { keyId, timelineModel } from "../src/timeline/model";

type Doc = Parameters<typeof keyCard>[0];
const rate = { num: 50, den: 1 };
const EASE = { x1: 1 / 3, y1: 0, x2: 2 / 3, y2: 1 };
const key = (frame: number, value: number, easing = "linear", bezier?: object) => ({ frame, value, easing, ...(bezier === undefined ? {} : { bezier }) });
const obj = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, type: "rect", visible: true, locked: false, ...extra });
const doc = (channels: { objectId: string; property: string; keys: ReturnType<typeof key>[] }[]): Doc =>
  ({ objects: [obj("plate", "Name plate"), obj("other", "Other")], canvas: { width: 1920, height: 1080, frameRate: rate }, timeline: { durationFrames: 250, channels, phases: [], pathChannels: [] } }) as unknown as Doc;

const d = doc([
  { objectId: "plate", property: "x", keys: [key(0, 100), key(20, 160, "custom-bezier", EASE), key(60, 300, "hold")] },
  { objectId: "plate", property: "y", keys: [key(0, 780), key(20, 800, "linear"), key(60, 900)] },
  { objectId: "plate", property: "opacity", keys: [key(0, 0), key(20, 0.5)] },
  { objectId: "other", property: "x", keys: [key(20, 5)] },
]);

describe("time", () => {
  it("says the frame and its milliseconds at the scene's rate", () => {
    expect(frameText(20, rate)).toBe("20 · 400 ms");
    expect(frameText(12, rate)).toBe("12 · 240 ms");
    expect(frameText(1, { num: 30000, den: 1001 })).toBe("1 · 33 ms");
    expect(frameText(5, { num: 0, den: 1 })).toBe("5 · 0 ms");
  });
});

describe("a value as the field shows it", () => {
  it("converts opacity and scale to percent and back, and leaves pixels alone", () => {
    expect(shownValue("opacity", 0.5)).toBe(50);
    expect(shownValue("scaleX", 1.25)).toBe(125);
    expect(shownValue("x", 160)).toBe(160);
    expect(storedValue("opacity", 50)).toBe(0.5);
    expect(storedValue("rotation", 90)).toBe(90);
    expect(storedValue("unknownThing", 7)).toBe(7);
  });
});

describe("one key", () => {
  it("is titled by the element, the property and the frame, and shows its own value", () => {
    const card = keyCard(d, [keyId("plate", "x", 20)], rate)!;
    expect(card.title).toBe("Keyframe · Name plate · Position · frame 20");
    expect(card.moment!.frameText).toBe("20 · 400 ms");
    expect(card.moment!.values).toEqual([{ property: "x", label: "X", shown: 160, suffix: "px" }]);
  });

  it("names a property that is not part of a pair by itself", () => {
    expect(keyCard(d, [keyId("plate", "opacity", 20)], rate)!.title).toBe("Keyframe · Name plate · Opacity · frame 20");
    expect(keyCard(d, [keyId("plate", "opacity", 20)], rate)!.moment!.values[0]).toMatchObject({ shown: 50, suffix: "%" });
  });

  it("says Ease for the F9 curve, and how strongly it eases on each side", () => {
    const card = keyCard(d, [keyId("plate", "x", 20)], rate)!;
    expect(card.moment!.overTime).toBe("Ease");
    expect(card.active).toBe("ease");
    // leaves with 33.3 %, and arrives through the previous key's linear segment, which has no ease
    expect(card.moment!.easeOut).toBe("33.3 %");
    expect(card.moment!.easeIn).toBe("—");
  });

  it("reads the arriving side from the key before it", () => {
    const bent = doc([{ objectId: "plate", property: "x", keys: [key(0, 0, "custom-bezier", { x1: 0.2, y1: 0, x2: 0.7, y2: 1 }), key(20, 10, "linear"), key(40, 20)] }]);
    const card = keyCard(bent, [keyId("plate", "x", 20)], rate)!;
    expect(card.moment!.easeIn).toBe("30 %");
    expect(card.moment!.easeOut).toBe("—");
  });

  it("says a hold or a linear key has no ease, and marks the matching button", () => {
    expect(keyCard(d, [keyId("plate", "x", 60)], rate)!.active).toBe("hold");
    const lin = keyCard(d, [keyId("plate", "y", 20)], rate)!;
    expect(lin.active).toBe("linear");
    expect(lin.moment!.easeOut).toBe("—");
  });

  it("says the last key has no leaving curve", () => {
    expect(keyCard(d, [keyId("plate", "opacity", 20)], rate)!.moment!.easeOut).toBe("—");
  });

  it("carries the element's Parent, Blend and Matte", () => {
    expect(keyCard(d, [keyId("plate", "x", 20)], rate)!.moment!.element).toMatchObject({ parent: { label: "—" }, blend: { label: "Normal" }, matte: { label: "—" } });
  });
});

describe("x and y together are one moment", () => {
  it("lists both values under Position", () => {
    const card = keyCard(d, [keyId("plate", "x", 20), keyId("plate", "y", 20)], rate)!;
    expect(card.title).toBe("Keyframe · Name plate · Position · frame 20");
    expect(card.moment!.values.map((v) => [v.label, v.shown])).toEqual([["X", 160], ["Y", 800]]);
    expect(card.moment!.overTime).toBe("Mixed");
    expect(card.moment!.easing).toBe("mixed");
  });

  it("says how many properties when they are not a pair", () => {
    const card = keyCard(d, [keyId("plate", "x", 20), keyId("plate", "opacity", 20)], rate)!;
    expect(card.title).toBe("Keyframe · Name plate · 2 properties · frame 20");
  });
});

describe("a spread of keys", () => {
  it("summarises frames and elements and shows no single value", () => {
    const card = keyCard(d, [keyId("plate", "x", 0), keyId("plate", "x", 60)], rate)!;
    expect(card.moment).toBeUndefined();
    expect(card.title).toBe("2 keyframes selected");
    expect(card.summary).toContain("frames 0 to 60 on Name plate");
    const across = keyCard(d, [keyId("plate", "x", 20), keyId("other", "x", 20)], rate)!;
    expect(across.moment).toBeUndefined();
    expect(across.summary).toContain("frame 20 on 2 elements");
  });

  it("still marks an ease every selected key has", () => {
    expect(keyCard(d, [keyId("plate", "x", 60), keyId("plate", "y", 60)], rate)).toBeDefined();
    expect(keyCard(d, [keyId("plate", "x", 20), keyId("plate", "x", 60)], rate)!.active).toBeUndefined();
  });
});

describe("a selection that is gone", () => {
  it("has no card once none of its keys or elements exists", () => {
    expect(keyCard(d, [], rate)).toBeUndefined();
    expect(keyCard(d, [keyId("ghost", "x", 3)], rate)).toBeUndefined();
    expect(keyCard(d, ["not a key id"], rate)).toBeUndefined();
  });

  it("drops a key that was deleted from a moment and shows the rest", () => {
    const card = keyCard(d, [keyId("plate", "x", 20), keyId("plate", "x", 999)], rate)!;
    expect(card.moment).toBeUndefined();
    expect(card.title).toBe("2 keyframes selected");
  });
});

describe("the label for an easing", () => {
  it("is the contract's word, Ease for the F9 curve and Custom curve for any other", () => {
    expect(overTimeLabel(key(0, 0, "ease-in") as never)).toBe("Ease in");
    expect(overTimeLabel(key(0, 0, "custom-bezier", EASE) as never)).toBe("Ease");
    expect(overTimeLabel(key(0, 0, "custom-bezier", { x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.9 }) as never)).toBe("Custom curve");
    expect(overTimeLabel(key(0, 0, "something-new") as never)).toBe("something-new");
  });
});

describe("a field change", () => {
  it("writes a value in the stored unit and keeps the key's frame, easing and curve", () => {
    const plan = planSetKeyValue(d, keyId("plate", "x", 20), 175) as unknown as { edits: unknown[]; label: string };
    expect(plan.edits).toEqual([{ edit: "updateKeyframe", objectId: "plate", property: "x", keyframe: { frame: 20, value: 175, easing: "custom-bezier", bezier: EASE } }]);
    expect(plan.label).toBe("Set X at frame 20");
    const pct = planSetKeyValue(d, keyId("plate", "opacity", 20), 25) as unknown as { edits: { keyframe: { value: number } }[] };
    expect(pct.edits[0]!.keyframe.value).toBe(0.25);
  });

  it("refuses a value that is not a number or a key that is gone", () => {
    expect(planSetKeyValue(d, keyId("plate", "x", 20), Number.NaN)).toEqual({ refused: "A value must be a number." });
    expect(planSetKeyValue(d, keyId("plate", "x", 21), 1)).toEqual({ refused: "That key is not in the scene." });
  });

  it("moves the whole selected moment by the same distance", () => {
    const model = timelineModel(d, { allObjects: true, selectedIds: ["plate"] });
    const plan = planSetKeyFrame(model, [keyId("plate", "x", 20), keyId("plate", "y", 20)], 30) as unknown as { edits: { property: string; fromFrame: number; toFrame: number }[] };
    expect(plan.edits.map((e) => [e.property, e.fromFrame, e.toFrame])).toEqual([["x", 20, 30], ["y", 20, 30]]);
  });

  it("refuses a frame that is not whole, is on another key, or is the same frame", () => {
    const model = timelineModel(d, { allObjects: true, selectedIds: ["plate"] });
    expect(planSetKeyFrame(model, [keyId("plate", "x", 20)], 2.5)).toEqual({ refused: "A frame must be a whole number." });
    expect(planSetKeyFrame(model, [keyId("plate", "x", 20)], 60)).toMatchObject({ refused: expect.stringContaining("already has a key") });
    expect(planSetKeyFrame(model, [keyId("plate", "x", 20)], 20)).toEqual({ refused: "the keys did not move" });
  });
});

describe("a typed Ease in or Ease out", () => {
  type Plan = { edits: { property: string; keyframe: { frame: number; value: number; easing: string; bezier: { x1: number; y1: number; x2: number; y2: number } } }[]; label: string };
  const bent = doc([
    { objectId: "plate", property: "x", keys: [key(0, 0, "custom-bezier", { x1: 0.2, y1: 0.1, x2: 0.7, y2: 0.9 }), key(20, 10, "custom-bezier", { x1: 0.4, y1: 0, x2: 0.6, y2: 1 }), key(40, 20)] },
    { objectId: "plate", property: "y", keys: [key(0, 0, "linear"), key(20, 10, "linear"), key(40, 20)] },
    { objectId: "plate", property: "opacity", keys: [key(0, 0, "hold"), key(20, 1, "hold"), key(40, 0)] },
  ]);

  it("holds the numbers it shows, and nothing on a side that has no curve", () => {
    const mid = keyCard(bent, [keyId("plate", "x", 20)], rate)!.moment!;
    expect(mid.influence).toEqual({ out: 40, in: 30 });
    expect(keyCard(bent, [keyId("plate", "x", 0)], rate)!.moment!.influence).toEqual({ out: 20 });
    expect(keyCard(bent, [keyId("plate", "x", 40)], rate)!.moment!.influence).toEqual({ in: 40 });
    // Hold segments have no curve: leaving a held key, and arriving through a held one.
    expect(keyCard(bent, [keyId("plate", "opacity", 20)], rate)!.moment!.influence).toEqual({});
  });

  it("Ease out writes x1 of the leaving curve and keeps the handle's height and the other handle", () => {
    const plan = planSetInfluence(bent, [keyId("plate", "x", 20)], "out", 60) as unknown as Plan;
    expect(plan.label).toBe("Set Ease out");
    expect(plan.edits).toEqual([{ edit: "updateKeyframe", objectId: "plate", property: "x", keyframe: { frame: 20, value: 10, easing: "custom-bezier", bezier: { x1: 0.6, y1: 0, x2: 0.6, y2: 1 } } }]);
  });

  it("Ease in writes x2 of the PREVIOUS key's curve, as one minus the percentage, on that key", () => {
    const plan = planSetInfluence(bent, [keyId("plate", "x", 20)], "in", 25) as unknown as Plan;
    expect(plan.label).toBe("Set Ease in");
    expect(plan.edits).toEqual([{ edit: "updateKeyframe", objectId: "plate", property: "x", keyframe: { frame: 0, value: 0, easing: "custom-bezier", bezier: { x1: 0.2, y1: 0.1, x2: 0.75, y2: 0.9 } } }]);
  });

  it("keeps a Linear segment straight: the handle slides along the line, on whichever side is typed", () => {
    const out = planSetInfluence(bent, [keyId("plate", "y", 20)], "out", 40) as unknown as Plan;
    expect(out.edits[0]!.keyframe.bezier).toEqual({ x1: 0.4, y1: 0.4, x2: 1, y2: 1 });
    const into = planSetInfluence(bent, [keyId("plate", "y", 20)], "in", 40) as unknown as Plan;
    expect(into.edits[0]!.keyframe).toMatchObject({ frame: 0, easing: "custom-bezier" });
    expect(into.edits[0]!.keyframe.bezier).toEqual({ x1: 0, y1: 0, x2: 0.6, y2: 0.6 });
  });

  it("clamps to 0.1 to 100 percent and refuses what is not a number", () => {
    const low = planSetInfluence(bent, [keyId("plate", "x", 20)], "out", -5) as unknown as Plan;
    expect(low.edits[0]!.keyframe.bezier.x1).toBeCloseTo(0.001, 9);
    const high = planSetInfluence(bent, [keyId("plate", "x", 20)], "out", 250) as unknown as Plan;
    expect(high.edits[0]!.keyframe.bezier.x1).toBe(1);
    expect(planSetInfluence(bent, [keyId("plate", "x", 20)], "out", Number.NaN)).toEqual({ refused: "An influence must be a number." });
  });

  it("leaves a Hold alone and refuses when no selected key has the segment", () => {
    expect(planSetInfluence(bent, [keyId("plate", "opacity", 20)], "out", 50)).toEqual({ refused: "There is no curve leaving this key to change." });
    expect(planSetInfluence(bent, [keyId("plate", "opacity", 40)], "in", 50)).toEqual({ refused: "There is no curve arriving at this key to change." });
    expect(planSetInfluence(bent, [keyId("plate", "x", 0)], "in", 50)).toEqual({ refused: "There is no curve arriving at this key to change." });
    expect(planSetInfluence(bent, [keyId("plate", "x", 40)], "out", 50)).toEqual({ refused: "There is no curve leaving this key to change." });
  });

  it("edits every selected channel of the moment together, skipping the ones that have no segment there", () => {
    const plan = planSetInfluence(bent, [keyId("plate", "x", 20), keyId("plate", "y", 20), keyId("plate", "opacity", 20)], "out", 50) as unknown as Plan;
    expect(plan.edits.map((e) => e.property)).toEqual(["x", "y"]);
  });
});

describe("the Back presets", () => {
  const room = doc([
    { objectId: "plate", property: "x", keys: [key(0, 100), key(20, 300), key(40, 500)] },
    { objectId: "plate", property: "opacity", keys: [key(0, 0.2), key(20, 0.5), key(40, 0.6)] },
    { objectId: "plate", property: "width", keys: [key(0, 100), key(20, 400)] },
    { objectId: "plate", property: "y", keys: [key(0, 0, "custom-bezier", { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 }), key(20, 10)] },
  ]);
  type Plan = { edits: { property: string; keyframe: { frame: number; value: number; easing: string; bezier: { x1: number; y1: number; x2: number; y2: number } } }[]; label: string };

  it("write the single cubic bezier of Back out and Back in on every selected key that has a segment", () => {
    const out = planSetPreset(room, [keyId("plate", "x", 0), keyId("plate", "x", 20), keyId("plate", "x", 40)], "back-out") as unknown as Plan;
    expect(out.label).toBe("Set Back out");
    expect(out.edits.map((e) => e.keyframe.frame)).toEqual([0, 20]);
    expect(out.edits[0]!.keyframe).toMatchObject({ value: 100, easing: "custom-bezier", bezier: { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 } });
    const into = planSetPreset(room, [keyId("plate", "x", 0)], "back-in") as unknown as Plan;
    expect(into.edits[0]!.keyframe.bezier).toEqual({ x1: 0.36, y1: 0, x2: 0.66, y2: -0.56 });
  });

  it("are named by the card once written, and any other curve stays Custom curve", () => {
    expect(overTimeLabel({ frame: 0, value: 0, easing: "custom-bezier", bezier: { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 } } as never)).toBe("Back out");
    expect(overTimeLabel({ frame: 0, value: 0, easing: "custom-bezier", bezier: { x1: 0.36, y1: 0, x2: 0.66, y2: -0.56 } } as never)).toBe("Back in");
    expect(overTimeLabel({ frame: 0, value: 0, easing: "custom-bezier", bezier: { x1: 0.34, y1: 1.5, x2: 0.64, y2: 1 } } as never)).toBe("Custom curve");
  });

  it("refuse where the overshoot would leave a property's range, naming the property and the frames", () => {
    // Opacity 0.2 to 0.5 overshoots above its own end (about 0.67): inside 0..1, fine. 0.5 to 0.6 is fine too.
    expect(planSetPreset(room, [keyId("plate", "opacity", 0)], "back-out")).toHaveProperty("edits");
    // Opacity from 0.6 up to 1 would pass 1.
    const tight = doc([{ objectId: "plate", property: "opacity", keys: [key(0, 0.6), key(20, 1)] }]);
    expect(planSetPreset(tight, [keyId("plate", "opacity", 0)], "back-out")).toEqual({ refused: expect.stringMatching(/Back out overshoots Opacity past its limits between frames 0 and 20/) });
    // Back in dips under the start value: a width of 0 to 100 would go negative; 100 to 400 stays positive.
    const narrow = doc([{ objectId: "plate", property: "width", keys: [key(0, 0), key(20, 100)] }]);
    expect(planSetPreset(narrow, [keyId("plate", "width", 0)], "back-in")).toHaveProperty("refused");
    expect(planSetPreset(room, [keyId("plate", "width", 0)], "back-in")).toHaveProperty("edits");
    // A property with no range (x) may overshoot freely, below or above.
    const free = doc([{ objectId: "plate", property: "x", keys: [key(0, 0), key(20, 10)] }]);
    expect(planSetPreset(free, [keyId("plate", "x", 0)], "back-in")).toHaveProperty("edits");
  });

  it("refuse an unknown preset and keys with no segment leaving them", () => {
    expect(planSetPreset(room, [keyId("plate", "x", 0)], "bounce")).toEqual({ refused: "That ease is not one this card can write." });
    expect(planSetPreset(room, [keyId("plate", "x", 40)], "back-out")).toEqual({ refused: "There is no curve leaving these keys to change." });
  });
});
