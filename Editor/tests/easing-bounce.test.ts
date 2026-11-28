import { describe, expect, it } from "vitest";

import { EASING_REFERENCE } from "../src/easing-reference";
import { keyCard, overTimeLabel, planSetInfluence } from "../src/timeline/key-card";
import { channelValueRange, easeAt, evaluateChannel } from "../src/timeline/easing";
import { planSetEasing } from "../src/timeline/key-edit";
import { keyId, timelineModel } from "../src/timeline/model";

const rate = { num: 50, den: 1 };
const key = (frame: number, value: number, easing = "linear") => ({ frame, value, easing });
const obj = (id: string) => ({ id, name: id, type: "rect", visible: true, locked: false });
const doc = (channels: { objectId: string; property: string; keys: ReturnType<typeof key>[] }[]) =>
  ({ objects: [obj("plate")], canvas: { width: 1920, height: 1080, frameRate: rate }, timeline: { durationFrames: 250, channels, phases: [], pathChannels: [] } }) as never;

describe("the mirror of Bounce and Elastic", () => {
  it("is pinned by the generated reference, which now carries both", () => {
    for (const name of ["bounce", "elastic"] as const) {
      const rows = EASING_REFERENCE.filter((row) => row.easing === name);
      expect(rows.length).toBeGreaterThanOrEqual(10);
      for (const row of rows) expect(easeAt(name, undefined, row.t)).toBeCloseTo(row.y, 9);
    }
  });

  it("gives Penner's values, ends exactly on 1, and Elastic swings past it", () => {
    expect(easeAt("bounce", undefined, 0.5)).toBeCloseTo(0.765625, 12);
    expect(easeAt("bounce", undefined, 0.25)).toBeCloseTo(0.47265625, 12);
    expect(easeAt("bounce", undefined, 0.95)).toBeCloseTo(0.98453125, 12);
    expect(easeAt("elastic", undefined, 0.5)).toBeCloseTo(1.015625, 12);
    for (const name of ["bounce", "elastic"] as const) {
      expect(easeAt(name, undefined, 0)).toBe(0);
      expect(easeAt(name, undefined, 1)).toBe(1);
    }
    const bounce = Array.from({ length: 1001 }, (_, i) => easeAt("bounce", undefined, i / 1000));
    expect(Math.max(...bounce)).toBeLessThanOrEqual(1 + 1e-12);
    const elastic = Array.from({ length: 1001 }, (_, i) => easeAt("elastic", undefined, i / 1000));
    expect(Math.max(...elastic)).toBeGreaterThan(1.36);
  });

  it("is what a channel is evaluated by, and the graph's value range includes the overshoot", () => {
    const channel = { keys: [key(0, 100, "elastic"), key(100, 300)] } as never;
    expect(evaluateChannel(channel, 50)).toBeCloseTo(100 + 200 * 1.015625, 9);
    expect(evaluateChannel(channel, 100)).toBe(300);
    const range = channelValueRange(channel);
    // The first peak is 1.3731 of the distance; eight samples only reach 1.3641, so the graph must sample finer for Elastic.
    expect(range.max).toBeGreaterThan(100 + 200 * 1.368);
  });
});

describe("choosing Elastic or Bounce on keys", () => {
  const d = doc([
    { objectId: "plate", property: "opacity", keys: [key(0, 0), key(20, 1), key(40, 0.5)] },
    { objectId: "plate", property: "x", keys: [key(0, 0), key(20, 500)] },
    { objectId: "plate", property: "width", keys: [key(0, 100), key(20, 0)] },
  ]);
  const model = timelineModel(d, { allObjects: true, selectedIds: ["plate"] });

  it("writes the easing by name on a property that may overshoot", () => {
    const plan = planSetEasing(model, [keyId("plate", "x", 0)], "elastic") as unknown as { edits: { keyframe: { easing: string; bezier?: unknown } }[] };
    expect(plan.edits[0]!.keyframe.easing).toBe("elastic");
    expect(plan.edits[0]!.keyframe.bezier).toBeUndefined();
  });

  it("refuses Elastic where it would leave opacity or a size, naming the property and the frames, and allows Bounce", () => {
    const refused = planSetEasing(model, [keyId("plate", "opacity", 0)], "elastic");
    expect(refused).toEqual({ refused: expect.stringMatching(/Elastic overshoots Opacity past its limits between frames 0 and 20/) });
    expect(planSetEasing(model, [keyId("plate", "width", 0)], "elastic")).toHaveProperty("refused");
    expect(planSetEasing(model, [keyId("plate", "opacity", 0)], "bounce")).toHaveProperty("edits");
    // Opacity 1 down to 0.5 swings between about 0.32 and 1, inside its range, so Elastic is fine there.
    expect(planSetEasing(model, [keyId("plate", "opacity", 20)], "elastic")).toHaveProperty("edits");
  });
});

describe("the card with Bounce and Elastic keys", () => {
  const d = doc([{ objectId: "plate", property: "x", keys: [key(0, 0, "bounce"), key(20, 100, "elastic"), key(40, 200)] }]);

  it("names them, and has no Ease in or Ease out number for a curve that has no handles", () => {
    const first = keyCard(d, [keyId("plate", "x", 0)], rate)!.moment!;
    expect(first.overTime).toBe("Bounce");
    expect(first.influence).toEqual({});
    const second = keyCard(d, [keyId("plate", "x", 20)], rate)!.moment!;
    expect(second.overTime).toBe("Elastic");
    // Arriving through a Bounce segment and leaving through an Elastic one: neither has a handle to type into.
    expect(second.influence).toEqual({});
    expect(overTimeLabel({ frame: 0, value: 0, easing: "elastic" } as never)).toBe("Elastic");
  });

  it("will not turn a Bounce or Elastic segment into a bezier by a typed influence", () => {
    expect(planSetInfluence(d, [keyId("plate", "x", 0)], "out", 50)).toEqual({ refused: "There is no curve leaving this key to change." });
    expect(planSetInfluence(d, [keyId("plate", "x", 20)], "in", 50)).toEqual({ refused: "There is no curve arriving at this key to change." });
  });
});
