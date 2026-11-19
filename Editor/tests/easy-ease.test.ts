// Easy Ease and curve editing the After Effects way (11.68).
//
// The Rust test `easy_ease_is_smoothstep_on_the_engine_evaluator` pins the same
// numbers on the engine's evaluator, so the Editor and the engine are shown to
// draw one curve: an Easy Ease that the Editor showed differently from what
// went to air would be a lie about air.

import { describe, expect, it } from "vitest";

import type { CubicBezier, KeyframeChannel, SceneKeyframe } from "@grapix/contracts";
import { EASY_EASE_INFLUENCE, easeAt } from "../src/timeline/easing";
import { planEasyEase, planSetSegmentBezier, isRefused } from "../src/timeline/key-edit";
import { keyId, type TimelineModel } from "../src/timeline/model";
import {
  bezierFromHandleDrag,
  buildSpeedGraph,
  hitGraph,
  withDraftBezier,
} from "../src/timeline/speed-graph";
import type { TimelineViewport } from "../src/timeline/viewport";

const EASY: CubicBezier = { x1: EASY_EASE_INFLUENCE, y1: 0, x2: 1 - EASY_EASE_INFLUENCE, y2: 1 };

function key(frame: number, value: number, easing: SceneKeyframe["easing"] = "linear", bezier?: CubicBezier): SceneKeyframe {
  return { frame: frame as unknown as bigint, value, easing, ...(bezier ? { bezier } : {}) };
}

const viewport: TimelineViewport = { startFrame: 0, pixelsPerFrame: 6, width: 600, height: 160, scrollTop: 0, rowHeight: 22 };

/** A one-track model, enough for the plans, which read `tracks[].sourceKeys` only. */
function model(keys: SceneKeyframe[]): TimelineModel {
  return {
    tracks: [{ objectId: "card", property: "x", label: "card x", keys: { frames: [] }, sourceKeys: keys }],
  } as unknown as TimelineModel;
}

const id = (frame: number) => keyId("card", "x", frame);
const edited = (plan: ReturnType<typeof planEasyEase>) => {
  if (isRefused(plan)) throw new Error(plan.refused);
  return plan.edits.map((e) => (e as { keyframe: { frame: unknown; easing: string; bezier: CubicBezier } }).keyframe);
};

describe("Easy Ease is smoothstep: the numbers the Rust test pins", () => {
  it("matches 3t^2 - 2t^3 at the pinned points, flat at both ends", () => {
    for (const [t, expected] of [[0.1, 0.028], [0.25, 0.15625], [0.5, 0.5], [0.75, 0.84375], [0.9, 0.972]] as const) {
      expect(easeAt("custom-bezier", EASY, t)).toBeCloseTo(expected, 9);
    }
    expect(easeAt("custom-bezier", EASY, 0.001)).toBeLessThan(1e-5);
    expect(1 - easeAt("custom-bezier", EASY, 0.999)).toBeLessThan(1e-5);
  });
});

describe("planEasyEase", () => {
  const three = () => model([key(0, 0), key(50, 50), key(100, 100)]);

  it("both: easing the middle key rewrites the arriving and the leaving segment, each on its own handle", () => {
    const keys = edited(planEasyEase(three(), [id(50)], "both"));
    expect(keys.map((k) => Number(k.frame))).toEqual([50, 0]);
    const [leaving, arriving] = keys;
    // Leaving segment (50 -> 100): out handle (1/3, 0), in handle left as it was (linear: 1, 1).
    expect(leaving!.bezier).toEqual({ x1: EASY_EASE_INFLUENCE, y1: 0, x2: 1, y2: 1 });
    // Arriving segment (0 -> 50): in handle (2/3, 1), out handle left as it was (linear: 0, 0).
    expect(arriving!.bezier).toEqual({ x1: 0, y1: 0, x2: 1 - EASY_EASE_INFLUENCE, y2: 1 });
    expect(keys.every((k) => k.easing === "custom-bezier")).toBe(true);
  });

  it("in only touches the arriving segment, out only the leaving one", () => {
    const into = edited(planEasyEase(three(), [id(50)], "in"));
    expect(into.map((k) => Number(k.frame))).toEqual([0]);
    expect(into[0]!.bezier.x2).toBeCloseTo(2 / 3, 12);
    const out = edited(planEasyEase(three(), [id(50)], "out"));
    expect(out.map((k) => Number(k.frame))).toEqual([50]);
    expect(out[0]!.bezier.x1).toBeCloseTo(1 / 3, 12);
  });

  it("two neighbours sharing a segment keep both of its handles", () => {
    const keys = edited(planEasyEase(three(), [id(0), id(50)], "both"));
    const first = keys.find((k) => Number(k.frame) === 0)!;
    // 0 -> 50: leaving handle from key 0, arriving handle from key 50: the full Easy Ease.
    expect(first.bezier).toEqual(EASY);
    expect(keys.filter((k) => Number(k.frame) === 0)).toHaveLength(1);
  });

  it("keeps the other handle of a custom segment it only half rewrites", () => {
    const custom = model([key(0, 0, "custom-bezier", { x1: 0.2, y1: 0.9, x2: 0.4, y2: 0.1 }), key(100, 100)]);
    const keys = edited(planEasyEase(custom, [id(0)], "out"));
    expect(keys[0]!.bezier).toEqual({ x1: EASY_EASE_INFLUENCE, y1: 0, x2: 0.4, y2: 0.1 });
  });

  it("skips holds and ends, and refuses by name when nothing is left", () => {
    const refused = planEasyEase(model([key(0, 0, "hold"), key(100, 100)]), [id(0)], "out");
    expect(isRefused(refused) && refused.refused).toMatch(/nothing to ease/);
    expect(isRefused(planEasyEase(three(), [id(100)], "out"))).toBe(true);
    expect(isRefused(planEasyEase(three(), [id(0)], "in"))).toBe(true);
    expect(isRefused(planEasyEase(three(), [], "both"))).toBe(true);
    expect(isRefused(planEasyEase(three(), [id(7)], "both"))).toBe(true);
  });

  it("one gesture: a single label, one edit per segment", () => {
    const plan = planEasyEase(three(), [id(0), id(50), id(100)], "both");
    if (isRefused(plan)) throw new Error(plan.refused);
    expect(plan.label).toBe("Easy ease on 3 keys");
    expect(plan.edits).toHaveLength(2);
  });
});

describe("the incoming handle and handle editing", () => {
  const eased = [key(0, 0, "custom-bezier", EASY), key(100, 100)];
  const graph = (keys: SceneKeyframe[]) => buildSpeedGraph({ keys } as unknown as KeyframeChannel, viewport, 160, 100);

  it("draws an incoming handle on every key that has an arriving curve, naming the segment it edits", () => {
    const g = graph(eased);
    expect(g.keys[0]!.inHandle).toBeUndefined();
    expect(g.keys[1]!.inHandle).toBeDefined();
    expect(g.keys[1]!.inSegment).toBe(0);
    // The arriving handle sits left of its key (x2 < 1) and the leaving one right of its own.
    expect(g.keys[1]!.inHandle!.x).toBeLessThan(g.keys[1]!.at.x);
    expect(g.keys[0]!.outHandle!.x).toBeGreaterThan(g.keys[0]!.at.x);
  });

  it("a hold gives its next key no incoming handle", () => {
    const g = graph([key(0, 0, "hold"), key(100, 100)]);
    expect(g.keys[1]!.inHandle).toBeUndefined();
  });

  it("an incoming-handle drag edits (x2, y2) and leaves (x1, y1) alone, and round-trips", () => {
    const g = graph(eased);
    const same = bezierFromHandleDrag(eased[0]!, eased[1]!, g.keys[1]!.inHandle!, viewport, g.min, g.max, 160, "in");
    expect(same.x2).toBeCloseTo(EASY.x2, 6);
    expect(same.y2).toBeCloseTo(EASY.y2, 6);
    expect(same.x1).toBe(EASY.x1);
    expect(same.y1).toBe(EASY.y1);
    const dragged = bezierFromHandleDrag(eased[0]!, eased[1]!, { x: -9999, y: -9999 }, viewport, g.min, g.max, 160, "in");
    expect(dragged.x2).toBe(0); // the time control is clamped into 0-1
    expect(dragged.y2).toBeGreaterThan(1); // the value control may overshoot
    expect(dragged.x1).toBe(EASY.x1);
  });

  it("hit-testing prefers a handle to a key, ignores a handle sitting on its key, and finds keys", () => {
    const g = graph(eased);
    const out = g.keys[0]!.outHandle!;
    expect(hitGraph(g, out.x, out.y)).toEqual({ kind: "handle", segment: 0, side: "out" });
    const incoming = g.keys[1]!.inHandle!;
    expect(hitGraph(g, incoming.x, incoming.y)).toEqual({ kind: "handle", segment: 0, side: "in" });
    expect(hitGraph(g, g.keys[1]!.at.x, g.keys[1]!.at.y)).toEqual({ kind: "key", frame: 100 });
    expect(hitGraph(g, 5000, 5000)).toBeUndefined();
    // A linear segment's handles lie on their keys: grabbing there selects the key.
    const linear = graph([key(0, 0), key(100, 100)]);
    expect(hitGraph(linear, linear.keys[0]!.at.x, linear.keys[0]!.at.y)).toEqual({ kind: "key", frame: 0 });
  });

  it("a draft replaces one segment's curve without touching the others or the source", () => {
    const source = [key(0, 0), key(50, 50), key(100, 100)];
    const drafted = withDraftBezier(source, 50, EASY);
    expect(drafted[1]).toMatchObject({ easing: "custom-bezier", bezier: EASY });
    expect(drafted[0]).toBe(source[0]);
    expect(source[1]!.easing).toBe("linear");
  });

  it("planSetSegmentBezier is one named edit that keeps the key's frame and value", () => {
    const plan = planSetSegmentBezier(model([key(0, 5), key(100, 9)]), "card", "x", 0, EASY);
    if (isRefused(plan)) throw new Error(plan.refused);
    expect(plan.edits).toHaveLength(1);
    expect(plan.edits[0]).toMatchObject({ edit: "updateKeyframe", keyframe: { value: 5, easing: "custom-bezier", bezier: EASY } });
    expect(isRefused(planSetSegmentBezier(model([key(0, 5)]), "card", "x", 40, EASY))).toBe(true);
  });
});

describe("the value graph is a continuous curve, not a staircase", () => {
  it("changes between adjacent pixel columns across a segment instead of holding one value per frame", () => {
    const g = buildSpeedGraph({ keys: [key(0, 0, "custom-bezier", EASY), key(100, 100)] } as unknown as KeyframeChannel, viewport, 160, 100);
    // 6 px per frame: a staircase would repeat one y for 6 columns in a row.
    const inside = g.polyline.filter((p) => p.x > 60 && p.x < 540);
    let longestRun = 1;
    let run = 1;
    for (let i = 1; i < inside.length; i += 1) {
      run = inside[i]!.y === inside[i - 1]!.y ? run + 1 : 1;
      longestRun = Math.max(longestRun, run);
    }
    expect(longestRun).toBeLessThan(3);
  });
});

describe("the speed view", () => {
  const speed = (keys: SceneKeyframe[], fps = 50) =>
    buildSpeedGraph({ keys } as unknown as KeyframeChannel, viewport, 160, 100, { mode: "speed", framesPerSecond: fps });

  it("is constant for linear motion and always includes zero", () => {
    const g = speed([key(0, 0), key(100, 100)]);
    expect(g.mode).toBe("speed");
    expect(g.min).toBe(0);
    // 100 units over 100 frames at 50 fps is 50 units per second.
    expect(g.max).toBeCloseTo(50, 6);
    const middle = g.polyline[Math.round(g.polyline.length * 0.3)]!;
    const ys = new Set(g.polyline.filter((p) => p.x > 30 && p.x < 570).map((p) => p.y.toFixed(3)));
    expect(ys.size).toBe(1);
    expect(middle.y).toBeLessThan(160);
  });

  it("Easy Ease peaks in the middle and is flat at the ends", () => {
    const g = speed([key(0, 0, "custom-bezier", EASY), key(100, 100)]);
    expect(g.max).toBeGreaterThan(50 * 1.4); // smoothstep peaks at 1.5x the average speed
    const atStart = g.polyline.find((p) => p.x >= 0)!;
    const atMiddle = g.polyline[300]!;
    expect(atMiddle.y).toBeLessThan(atStart.y);
  });

  it("has no handles: the speed view is for reading", () => {
    const g = speed([key(0, 0, "custom-bezier", EASY), key(100, 100)]);
    expect(g.keys.every((k) => k.outHandle === undefined && k.inHandle === undefined)).toBe(true);
  });
});
