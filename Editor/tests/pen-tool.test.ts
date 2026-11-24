// The Pen tool (11.104): points, handles, closing, what is sent, what is shown while drawing.
import { describe, expect, it } from "vitest";
import type { SceneDocument } from "@grapix/contracts";
import { isRefused } from "../src/inspector";
import {
  EMPTY_PEN,
  MAX_POINTS,
  MIN_PULL,
  addPoint,
  cannotFinish,
  closePath,
  SHIFT_ANGLE,
  closeWithPull,
  constrain,
  moveLast,
  resumeEdits,
  resumeState,
  nearFirst,
  nextShapeId,
  penEdits,
  penLabel,
  penSketch,
  pullHandles,
  removeLast,
  toBezier,
  type PenState,
} from "../src/pen-tool";

const scene = (ids: string[] = []): SceneDocument =>
  ({ objects: ids.map((id) => ({ id })), timeline: { channels: [], phases: [], pathChannels: [] }, canvas: { width: 1920, height: 1080 } }) as unknown as SceneDocument;

function drawn(...points: [number, number][]): PenState {
  return points.reduce<PenState>((state, [x, y]) => addPoint(state, { x, y }), EMPTY_PEN);
}

describe("adding points", () => {
  it("adds a corner point where the pointer went down", () => {
    const state = addPoint(EMPTY_PEN, { x: 10.123, y: 20.987 });
    expect(state.points).toEqual([{ x: 10.12, y: 20.99, inX: 0, inY: 0, outX: 0, outY: 0 }]);
    expect(state.closed).toBe(false);
  });

  it("keeps the points in the order they were made", () => {
    expect(drawn([0, 0], [10, 0], [10, 10]).points.map((p) => [p.x, p.y])).toEqual([[0, 0], [10, 0], [10, 10]]);
  });

  it("holds a point to a multiple of 15 degrees from the one before with Shift", () => {
    const start = drawn([100, 100]);
    const flat = addPoint(start, { x: 200, y: 110 }, true);
    expect(flat.points[1]).toMatchObject({ y: 100 });
    expect(flat.points[1]!.x).toBeCloseTo(100 + Math.hypot(100, 10), 1);
    const diagonal = addPoint(start, { x: 160, y: 150 }, true);
    expect(diagonal.points[1]!.x - 100).toBeCloseTo(diagonal.points[1]!.y - 100, 1);
    // A step is a policy: 45 degrees on request.
    const coarse = addPoint(start, { x: 200, y: 130 }, true, 45);
    expect(coarse.points[1]).toMatchObject({ y: 100 });
    // With nothing before it there is nothing to hold it to.
    expect(addPoint(EMPTY_PEN, { x: 5, y: 7 }, true).points[0]).toMatchObject({ x: 5, y: 7 });
  });

  it("goes to the nearest multiple of 15 degrees by default and of any step asked for", () => {
    const from = { x: 0, y: 0 };
    expect(SHIFT_ANGLE).toBe(15);
    const near15 = constrain(from, { x: 100, y: 20 });
    expect(Math.atan2(near15.y, near15.x)).toBeCloseTo((15 * Math.PI) / 180, 9);
    expect(constrain(from, { x: 100, y: 20 }, 45)).toEqual({ x: expect.closeTo(Math.hypot(100, 20), 6), y: expect.closeTo(0, 6) });
    expect(constrain(from, { x: 20, y: 100 }, 45).x).toBeCloseTo(0, 6);
    expect(constrain(from, { x: -50, y: -45 }, 45).x).toBeCloseTo(-Math.hypot(50, 45) * Math.SQRT1_2, 6);
    expect(constrain(from, from)).toEqual(from);
  });

  it("holds no more than the most points", () => {
    let state = EMPTY_PEN;
    for (let i = 0; i < MAX_POINTS + 5; i += 1) state = addPoint(state, { x: i, y: 0 });
    expect(state.points).toHaveLength(MAX_POINTS);
  });

  it("adds nothing to a closed path", () => {
    const closed = closePath(drawn([0, 0], [10, 0], [10, 10]));
    expect(addPoint(closed, { x: 50, y: 50 })).toBe(closed);
  });
});

describe("handles", () => {
  it("pulls the outgoing handle to the pointer and the incoming one opposite it", () => {
    const state = pullHandles(drawn([100, 100]), { x: 130, y: 90 });
    expect(state.points[0]).toMatchObject({ outX: 30, outY: -10, inX: -30, inY: 10 });
  });

  it("changes only the last point", () => {
    const state = pullHandles(drawn([0, 0], [50, 50]), { x: 80, y: 50 });
    expect(state.points[0]).toMatchObject({ outX: 0, inX: 0 });
    expect(state.points[1]).toMatchObject({ outX: 30, inX: -30 });
  });

  it("makes a corner when the pull is shorter than a click's wobble, and takes handles back when pulled in again", () => {
    const small = pullHandles(drawn([100, 100]), { x: 100 + MIN_PULL - 1, y: 100 });
    expect(small.points[0]).toMatchObject({ outX: 0, outY: 0, inX: 0, inY: 0 });
    const out = pullHandles(drawn([100, 100]), { x: 140, y: 100 });
    expect(out.points[0]!.outX).toBe(40);
    expect(pullHandles(out, { x: 101, y: 100 }).points[0]).toMatchObject({ outX: 0, inX: 0 });
  });

  it("does nothing with no point or a closed path", () => {
    expect(pullHandles(EMPTY_PEN, { x: 1, y: 1 })).toBe(EMPTY_PEN);
    const closed = closePath(drawn([0, 0], [10, 0], [10, 10]));
    expect(pullHandles(closed, { x: 50, y: 50 })).toBe(closed);
  });
});

describe("closing, and taking a point back", () => {
  it("closes only with three points", () => {
    expect(closePath(drawn([0, 0], [10, 0])).closed).toBe(false);
    expect(closePath(drawn([0, 0], [10, 0], [10, 10])).closed).toBe(true);
  });

  it("counts the pointer as on the first point right up to the tolerance", () => {
    const three = drawn([100, 100], [200, 100], [200, 200]);
    expect(nearFirst(three, { x: 109.5, y: 100 }, 10)).toBe(true);
    expect(nearFirst(three, { x: 110, y: 100 }, 10)).toBe(true);
    expect(nearFirst(three, { x: 110.5, y: 100 }, 10)).toBe(false);
  });

  it("knows when the pointer is on the first point, never with fewer than three points or once closed", () => {
    const three = drawn([100, 100], [200, 100], [200, 200]);
    expect(nearFirst(three, { x: 104, y: 97 }, 10)).toBe(true);
    expect(nearFirst(three, { x: 111, y: 100 }, 10)).toBe(false);
    expect(nearFirst(drawn([100, 100], [200, 100]), { x: 100, y: 100 }, 10)).toBe(false);
    expect(nearFirst(closePath(three), { x: 100, y: 100 }, 10)).toBe(false);
  });

  it("takes back the last point, and opens a closed path before it takes points", () => {
    const three = drawn([0, 0], [10, 0], [10, 10]);
    expect(removeLast(three).points).toHaveLength(2);
    const closed = closePath(three);
    const reopened = removeLast(closed);
    expect(reopened.closed).toBe(false);
    expect(reopened.points).toHaveLength(3);
    expect(removeLast(EMPTY_PEN).points).toEqual([]);
  });
});

describe("finishing", () => {
  it("needs two points for a line and three for a shape, and says so", () => {
    expect(cannotFinish(EMPTY_PEN)).toContain("at least two points");
    expect(cannotFinish(drawn([0, 0]))).toContain("at least two points");
    expect(cannotFinish(drawn([0, 0], [10, 0]))).toBeUndefined();
    expect(cannotFinish({ points: drawn([0, 0], [10, 0]).points, closed: true })).toBe("A closed shape needs at least three points.");
    expect(cannotFinish(closePath(drawn([0, 0], [10, 0], [10, 10])))).toBeUndefined();
  });

  it("is the contract's path: relative handles, all three arrays one length, an id and a kind on every vertex (11.112, 11.113)", () => {
    const state = pullHandles(drawn([100, 100], [200, 100]), { x: 230, y: 80 });
    expect(toBezier(state)).toEqual({
      closed: false,
      vertices: [{ x: 100, y: 100 }, { x: 200, y: 100 }],
      inTangents: [{ x: 0, y: 0 }, { x: -30, y: 20 }],
      outTangents: [{ x: 0, y: 0 }, { x: 30, y: -20 }],
      vertexIds: [0, 1],
      vertexKinds: ["corner", "smooth"],
    });
  });

  it("gives a vertex whose handles do not line up (Alt) the kind corner, and a mask the same ids and kinds", () => {
    const broken = pullHandles(drawn([100, 100], [200, 100]), { x: 230, y: 80 }, { alt: true });
    expect(toBezier(broken).vertexKinds).toEqual(["corner", "corner"]);
  });

  it("makes a closed path one createShape and keeps the default fill", () => {
    const outcome = penEdits(scene(), closePath(drawn([0, 0], [100, 0], [100, 100])), "Pen path");
    if (isRefused(outcome)) throw new Error(outcome.refused);
    expect(outcome.id).toBe("shape-1");
    expect(outcome.edits).toHaveLength(1);
    expect(outcome.edits[0]).toMatchObject({ edit: "createShape", name: "Pen path", path: { closed: true } });
  });

  it("makes an open path a line: no fill, a white stroke of 6 with round ends, on the shape that is made", () => {
    const outcome = penEdits(scene(["shape-1", "rect-1"]), drawn([0, 0], [100, 50]), "Pen path");
    if (isRefused(outcome)) throw new Error(outcome.refused);
    expect(outcome.id).toBe("shape-2");
    expect(outcome.edits.map((e) => (e as { edit: string }).edit)).toEqual(["createShape", "setPaint", "setPaint", "setStroke"]);
    expect(outcome.edits[1]).toEqual({ edit: "setPaint", objectIds: ["shape-2"], slot: "fill" });
    expect(outcome.edits[2]).toEqual({ edit: "setPaint", objectIds: ["shape-2"], slot: "stroke", paint: { type: "solid", color: { r: 1, g: 1, b: 1, a: 1, space: "srgb" } } });
    expect(outcome.edits[3]).toEqual({ edit: "setStroke", objectIds: ["shape-2"], width: 6, style: { join: "round", cap: "round", miterLimit: 4 } });
    // The dash fields are left out: the engine's own defaults are a solid line, and sending them was refused by name.
    expect(JSON.stringify(outcome.edits[3])).not.toContain("dash");
  });

  it("refuses by name, and sends nothing, when it cannot be finished", () => {
    const outcome = penEdits(scene(), drawn([0, 0]), "Pen path");
    expect(isRefused(outcome) && outcome.refused).toContain("at least two points");
  });

  it("names the id the engine will give: the lowest free shape number", () => {
    expect(nextShapeId(scene())).toBe("shape-1");
    expect(nextShapeId(scene(["shape-1", "shape-3"]))).toBe("shape-2");
    expect(nextShapeId(scene(["rect-1"]))).toBe("shape-1");
  });

  it("says what was drawn", () => {
    expect(penLabel(drawn([0, 0], [1, 1]))).toBe("Drew a line of 2 points");
    expect(penLabel(closePath(drawn([0, 0], [1, 1], [2, 0])))).toBe("Drew a closed shape of 3 points");
  });
});

describe("what is shown while drawing", () => {
  it("draws the path so far, with each point and each handle", () => {
    const state = pullHandles(drawn([0, 0], [100, 0]), { x: 130, y: 20 });
    const sketch = penSketch(state);
    expect(sketch.d).toBe("M 0 0 C 0 0 70 -20 100 0");
    expect(sketch.vertices).toEqual([{ x: 0, y: 0, first: true }, { x: 100, y: 0, first: false }]);
    expect(sketch.handles).toEqual([
      { x1: 100, y1: 0, x2: 130, y2: 20 },
      { x1: 100, y1: 0, x2: 70, y2: -20 },
    ]);
  });

  it("is nothing before the first point", () => {
    expect(penSketch(EMPTY_PEN)).toEqual({ d: "", vertices: [], handles: [], closing: false });
  });

  it("draws the segment the pointer would add, until the path is closed", () => {
    const open = penSketch(drawn([0, 0], [100, 0]), { x: 150, y: 50 });
    expect(open.rubber).toBe("M 100 0 C 100 0 150 50 150 50");
    expect(penSketch(drawn([0, 0], [100, 0]), undefined).rubber).toBeUndefined();
    expect(penSketch(EMPTY_PEN, { x: 1, y: 1 }).rubber).toBeUndefined();
    expect(penSketch(closePath(drawn([0, 0], [100, 0], [100, 100])), { x: 5, y: 5 }).rubber).toBeUndefined();
  });

  it("closes the drawing back to the first point when the path is closed", () => {
    const closed = penSketch(closePath(drawn([0, 0], [100, 0], [100, 100])));
    expect(closed.d).toBe("M 0 0 C 0 0 100 0 100 0 C 100 0 100 100 100 100 C 100 100 0 0 0 0 Z");
  });

  it("passes on that a click on the first point would close the path", () => {
    expect(penSketch(drawn([0, 0], [100, 0], [100, 100]), { x: 2, y: 2 }, true).closing).toBe(true);
    expect(penSketch(drawn([0, 0], [100, 0], [100, 100]), { x: 2, y: 2 }).closing).toBe(false);
  });
});

describe("the spec's modifiers", () => {
  const down = (...at: [number, number][]) => at.reduce((state, [x, y]) => addPoint(state, { x, y }), EMPTY_PEN);

  it("breaks the handles with Alt: only the outgoing one follows, the incoming one stays", () => {
    const placed = pullHandles(down([100, 100]), { x: 140, y: 100 });
    expect(placed.points[0]).toMatchObject({ outX: 40, inX: -40 });
    const broken = pullHandles(placed, { x: 100, y: 160 }, { alt: true });
    expect(broken.points[0]).toMatchObject({ outY: 60, inX: -40 });
  });

  it("holds a pulled handle to the angle step with Shift, and still makes a corner for a short pull", () => {
    const pulled = pullHandles(down([0, 0]), { x: 100, y: 20 }, { shift: true });
    expect(Math.atan2(pulled.points[0]!.outY, pulled.points[0]!.outX)).toBeCloseTo((15 * Math.PI) / 180, 2);
    const coarse = pullHandles(down([0, 0]), { x: 100, y: 20 }, { shift: true, degrees: 45 });
    expect(coarse.points[0]!.outY).toBeCloseTo(0, 2);
    expect(pullHandles(down([0, 0]), { x: 1, y: 1 }, { shift: true }).points[0]).toMatchObject({ outX: 0, inX: 0 });
  });

  it("moves the new point with its handles on Space, and nothing for an empty or closed path", () => {
    const placed = pullHandles(down([10, 10]), { x: 30, y: 10 });
    const moved = moveLast(placed, { x: 5, y: -4 });
    expect(moved.points[0]).toMatchObject({ x: 15, y: 6, outX: 20, inX: -20 });
    expect(moveLast(EMPTY_PEN, { x: 1, y: 1 })).toBe(EMPTY_PEN);
    expect(moveLast({ ...placed, closed: true }, { x: 1, y: 1 }).points).toEqual({ ...placed, closed: true }.points);
  });

  it("closes with the first point's tangents when the closing click is dragged", () => {
    const three = down([0, 0], [100, 0], [100, 100]);
    expect(closeWithPull(three, { x: 1, y: 1 }).points[0]).toMatchObject({ outX: 0, inX: 0 });
    expect(closeWithPull(three, { x: 1, y: 1 }).closed).toBe(true);
    const pulled = closeWithPull(three, { x: 0, y: 40 });
    expect(pulled.closed).toBe(true);
    expect(pulled.points[0]).toMatchObject({ outY: 40, inY: -40 });
    const alt = closeWithPull(three, { x: 0, y: 40 }, { alt: true });
    expect(alt.points[0]).toMatchObject({ outY: 0, inY: -40 });
    expect(closeWithPull(down([0, 0], [5, 5]), { x: 9, y: 9 }).closed).toBe(false);
  });

  it("carries on an open path from either end, and sends it back as one setShapePath", () => {
    const path = { closed: false, vertices: [{ x: 0, y: 0 }, { x: 50, y: 0 }], inTangents: [{ x: 0, y: 0 }, { x: -10, y: 5 }], outTangents: [{ x: 10, y: 5 }, { x: 0, y: 0 }] };
    const last = resumeState(path, false)!;
    expect(last.points.map((p) => p.x)).toEqual([0, 50]);
    const first = resumeState(path, true)!;
    expect(first.points.map((p) => p.x)).toEqual([50, 0]);
    expect(first.points[0]).toMatchObject({ inX: 0, outX: -10, outY: 5 });
    expect(first.points[1]).toMatchObject({ inX: 10, inY: 5, outX: 0 });
    expect(resumeState({ ...path, closed: true }, false)).toBeUndefined();
    expect(resumeState({ ...path, vertices: [{ x: 0, y: 0 }], inTangents: [{ x: 0, y: 0 }], outTangents: [{ x: 0, y: 0 }] }, false)).toBeUndefined();
    const grown = addPoint(last, { x: 90, y: 40 });
    const outcome = resumeEdits("shape-3", grown);
    expect(outcome).toMatchObject({ edits: [{ edit: "setShapePath", shapeId: "shape-3", compoundPaths: [] }] });
    expect(resumeEdits("shape-3", { points: [], closed: false })).toHaveProperty("refused");
  });
});
