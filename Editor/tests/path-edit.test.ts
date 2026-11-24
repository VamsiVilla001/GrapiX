// Editing a path in the viewport (11.107): what can be edited, what the pointer is on, what a drag becomes, and the one-click tools.
import { describe, expect, it } from "vitest";
import type { BezierPath, SceneDocument, SceneObject } from "@grapix/contracts";
import {
  applyOp,
  beginGesture,
  clickOp,
  deleteSelected,
  editPathEdit,
  editTarget,
  gestureOp,
  isClick,
  joinEdits,
  pathEditSketch,
  pickPath,
  toCanvas,
  toObjectSpace,
  verticesInBox,
  type EditTarget,
  type Selected,
} from "../src/path-edit";
import { placementOf } from "../src/anchor-point";
import { isRefused } from "../src/inspector";
import { cubicOf, pointAt } from "../src/path-geometry";

const z = { x: 0, y: 0 };
const curve: BezierPath = {
  closed: false,
  vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 50 }],
  inTangents: [z, { x: -30, y: -40 }, { x: -20, y: 30 }],
  outTangents: [{ x: 30, y: 40 }, { x: 30, y: 40 }, z],
};
const square: BezierPath = {
  closed: true,
  vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
  inTangents: [z, z, z, z],
  outTangents: [z, z, z, z],
};

function shape(id: string, extra: Record<string, unknown> = {}): SceneObject {
  return { id, name: id, type: "shape", x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, width: 200, height: 100, locked: false, visible: true, path: curve, ...extra } as unknown as SceneObject;
}
function docOf(...objects: SceneObject[]): SceneDocument {
  return { canvas: { width: 1920, height: 1080 }, objects } as unknown as SceneDocument;
}
function target(object: SceneObject = shape("a")): EditTarget {
  const outcome = editTarget(docOf(object), [object.id]);
  if (isRefused(outcome)) throw new Error(outcome.refused);
  return outcome;
}
const none: readonly Selected[] = [];

describe("what can be edited", () => {
  it("is one unlocked shape in no locked group, and says why when it is not", () => {
    expect(isRefused(editTarget(docOf(shape("a")), []))).toBe(true);
    expect(isRefused(editTarget(docOf(shape("a"), shape("b")), ["a", "b"]))).toBe(true);
    expect(editTarget(docOf(shape("a")), ["gone"])).toMatchObject({ refused: "That object is not in the scene." });
    const text = { ...shape("t"), type: "text", name: "Title" } as unknown as SceneObject;
    expect(editTarget(docOf(text), ["t"])).toMatchObject({ refused: expect.stringContaining("not a shape") });
    expect(editTarget(docOf(shape("a", { locked: true })), ["a"])).toMatchObject({ refused: expect.stringContaining("locked") });
    const group = { id: "g", name: "Group", type: "group", locked: true, childIds: ["a"], x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 } as unknown as SceneObject;
    expect(editTarget(docOf(group, shape("a")), ["a"])).toMatchObject({ refused: expect.stringContaining("Group, which is locked") });
    const open = { ...group, locked: false } as SceneObject;
    // An unlocked group is not in the way: the shape's place is taken through it.
    const moved = { ...open, x: 30, y: 40 } as SceneObject;
    const inside = editTarget(docOf(moved, shape("a")), ["a"]);
    if ("refused" in inside) throw new Error(inside.refused);
    expect(inside.placement).toMatchObject({ x: 30, y: 40, rotation: 0, scaleX: 1, scaleY: 1 });
    expect(isRefused(editTarget(docOf(shape("a")), ["a"]))).toBe(false);
  });

  it("lists the main path and each compound subpath in order", () => {
    const two = shape("a", { compoundPaths: [square] });
    expect(target(two).paths.map((p) => p.subpath)).toEqual([0, 1]);
  });
});

describe("the object's space and the canvas", () => {
  it("agree with each other through position, turn, scale and pivot", () => {
    const placed = shape("a", { x: 500, y: 300, rotation: 30, scaleX: 2, scaleY: 0.5, anchor: { x: 10, y: 20 } });
    const placement = placementOf(placed);
    for (const q of [{ x: 0, y: 0 }, { x: 100, y: -40 }, { x: 3.5, y: 8 }]) {
      const back = toObjectSpace(placement, toCanvas(placement, q))!;
      expect(back.x).toBeCloseTo(q.x, 9);
      expect(back.y).toBeCloseTo(q.y, 9);
    }
    // The pivot sits at the position.
    expect(toCanvas(placement, { x: 10, y: 20 })).toEqual({ x: 500, y: 300 });
    expect(toObjectSpace({ ...placement, scaleX: 0 }, { x: 1, y: 1 })).toBeUndefined();
  });
});

describe("picking", () => {
  const t = target();

  it("takes a handle of a selected vertex before the vertex under it, then a vertex, then a curve, then nothing", () => {
    const selected: Selected[] = [{ subpath: 0, index: 1 }];
    // The out handle of vertex 1 ends at (130, 40); the in handle at (70, -40).
    expect(pickPath(t, selected, { x: 131, y: 41 }, 8)).toEqual({ kind: "handle", subpath: 0, index: 1, side: "out" });
    expect(pickPath(t, selected, { x: 70, y: -40 }, 8)).toEqual({ kind: "handle", subpath: 0, index: 1, side: "in" });
    // An unselected vertex's handles are not there to be taken.
    expect(pickPath(t, none, { x: 130, y: 40 }, 3)).toBeUndefined();
    expect(pickPath(t, none, { x: 101, y: 1 }, 8)).toEqual({ kind: "vertex", subpath: 0, index: 1 });
    const onCurve = pointAt(cubicOf(curve, 0), 0.5);
    const hit = pickPath(t, none, { x: onCurve.x + 2, y: onCurve.y }, 8);
    expect(hit).toMatchObject({ kind: "segment", subpath: 0, segment: 0 });
    expect((hit as { t: number }).t).toBeCloseTo(0.5, 1);
    expect(pickPath(t, none, { x: 500, y: 500 }, 8)).toBeUndefined();
  });

  it("measures the radius on the canvas, so a scaled shape is picked where it is drawn", () => {
    const big = target(shape("a", { scaleX: 3, scaleY: 3, x: 10, y: 10 }));
    expect(pickPath(big, none, { x: 10 + 300, y: 10 }, 5)).toEqual({ kind: "vertex", subpath: 0, index: 1 });
    expect(pickPath(big, none, { x: 100, y: 0 }, 5)).toBeUndefined();
  });

  it("finds the nearest vertex when two are in reach, and reaches a compound subpath", () => {
    const two = target(shape("a", { path: square, compoundPaths: [{ ...square, vertices: square.vertices.map((v) => ({ x: v.x + 300, y: v.y })) }] }));
    expect(pickPath(two, none, { x: 301, y: 1 }, 8)).toEqual({ kind: "vertex", subpath: 1, index: 0 });
    const close = target(shape("a", { path: { ...square, vertices: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }] } }));
    expect(pickPath(close, none, { x: 3, y: 0 }, 8)).toEqual({ kind: "vertex", subpath: 0, index: 1 });
  });

  it("selects the vertices inside a marquee", () => {
    expect(verticesInBox(t, { x: -10, y: -10, width: 120, height: 20 })).toEqual([{ subpath: 0, index: 0 }, { subpath: 0, index: 1 }]);
    expect(verticesInBox(t, { x: 1000, y: 1000, width: 5, height: 5 })).toEqual([]);
  });
});

describe("a drag", () => {
  const t = target();
  const sel = (...indices: number[]): Selected[] => indices.map((index) => ({ subpath: 0, index }));

  it("moves the grabbed vertex, or every selected one when it is among them", () => {
    const hit = { kind: "vertex", subpath: 0, index: 1 } as const;
    const alone = beginGesture(hit, { x: 100, y: 0 }, none, false);
    expect(alone.selected).toEqual(sel(1));
    expect(gestureOp(t, alone.gesture, { x: 110, y: 5 }, { shift: false, alt: false })).toEqual({ subpath: 0, op: { op: "moveVertices", indices: [1], delta: { x: 10, y: 5 } } });
    const among = beginGesture(hit, { x: 100, y: 0 }, sel(0, 1), false);
    expect(among.selected).toEqual(sel(0, 1));
    expect(gestureOp(t, among.gesture, { x: 100, y: 10 }, { shift: false, alt: false })!.op).toMatchObject({ indices: [0, 1] });
    expect(beginGesture(hit, { x: 100, y: 0 }, sel(0), true).selected).toEqual(sel(0, 1));
    expect(beginGesture(hit, { x: 100, y: 0 }, sel(0), false).selected).toEqual(sel(1));
    const held = gestureOp(t, alone.gesture, { x: 160, y: 10 }, { shift: true, alt: false })!.op as { delta: { x: number; y: number } };
    expect(held.delta.y).toBeCloseTo(0, 6);
  });

  it("moves a handle, keeps a smooth vertex's other handle in line, and breaks them with Alt", () => {
    const smooth: BezierPath = { ...curve, inTangents: [z, { x: -30, y: -40 }, z], outTangents: [{ x: 30, y: 40 }, { x: 30, y: 40 }, z] };
    const ts = target(shape("a", { path: smooth }));
    const hit = { kind: "handle", subpath: 0, index: 1, side: "out" } as const;
    const { gesture } = beginGesture(hit, { x: 130, y: 40 }, sel(1), false);
    expect(gestureOp(ts, gesture, { x: 140, y: 50 }, { shift: false, alt: false })).toEqual({
      subpath: 0,
      op: { op: "setHandle", index: 1, side: "out", vector: { x: 40, y: 50 }, coupling: "smooth" },
    });
    expect(gestureOp(ts, gesture, { x: 140, y: 50 }, { shift: false, alt: true })!.op).toMatchObject({ coupling: "none" });
    // A corner's handle goes alone.
    const corner = target(shape("a", { path: { ...curve, inTangents: [z, z, z] } }));
    expect(gestureOp(corner, gesture, { x: 140, y: 50 }, { shift: false, alt: false })!.op).toMatchObject({ coupling: "none" });
    // Shift holds it to 15 degrees from its vertex.
    const held = gestureOp(ts, gesture, { x: 200, y: 20 }, { shift: true, alt: false })!.op as { vector: { x: number; y: number } };
    expect(Math.atan2(held.vector.y, held.vector.x)).toBeCloseTo((15 * Math.PI) / 180, 3);
  });

  it("reshapes a curve at the point grabbed, and the grabbed point follows the pointer", () => {
    const hit = { kind: "segment", subpath: 0, segment: 0, t: 0.5, point: pointAt(cubicOf(curve, 0), 0.5) } as const;
    const { gesture } = beginGesture(hit, hit.point, none, false);
    const made = gestureOp(t, gesture, { x: hit.point.x + 12, y: hit.point.y - 7 }, { shift: false, alt: false })!;
    expect(made.op).toMatchObject({ op: "reshapeSegment", segment: 0, t: 0.5, delta: { x: 12, y: -7 } });
    const next = applyOp(curve, made.op)!;
    const after = pointAt(cubicOf(next, 0), 0.5);
    expect(after.x).toBeCloseTo(hit.point.x + 12, 3);
    expect(after.y).toBeCloseTo(hit.point.y - 7, 3);
  });

  it("works through the object's own turn and scale: a drag of 30 canvas pixels is 15 in an object scaled by two", () => {
    const scaled = target(shape("a", { scaleX: 2, scaleY: 2 }));
    const { gesture } = beginGesture({ kind: "vertex", subpath: 0, index: 0 }, { x: 0, y: 0 }, none, false);
    expect(gestureOp(scaled, gesture, { x: 30, y: 0 }, { shift: false, alt: false })!.op).toMatchObject({ delta: { x: 15, y: 0 } });
    expect(gestureOp(target(shape("a", { scaleX: 0 })), gesture, { x: 30, y: 0 }, { shift: false, alt: false })).toBeUndefined();
  });

  it("is a click under three screen pixels", () => {
    expect(isClick({ clientX: 10, clientY: 10 }, { clientX: 11, clientY: 11 })).toBe(true);
    expect(isClick({ clientX: 10, clientY: 10 }, { clientX: 13, clientY: 10 })).toBe(false);
  });

  it("sends one editPath edit", () => {
    expect(editPathEdit("shape-1", 2, { op: "reverse" })).toEqual({ edit: "editPath", objectId: "shape-1", target: { kind: "shape", subpath: 2 }, op: { op: "reverse" } });
  });
});

describe("the one-click tools and Delete", () => {
  const t = target();
  const vertex = { kind: "vertex", subpath: 0, index: 1 } as const;
  const segment = { kind: "segment", subpath: 0, segment: 1, t: 0.4, point: z } as const;

  it("adds on a curve, deletes and converts on a vertex, and says what to click otherwise", () => {
    expect(clickOp("add", segment, t)).toMatchObject({ op: { op: "insertVertex", segment: 1, t: 0.4 }, label: "Added a vertex" });
    expect(clickOp("add", vertex, t)).toEqual({ refused: "Click on the curve where the vertex should go." });
    expect(clickOp("delete", vertex, t)).toMatchObject({ op: { op: "deleteVertices", indices: [1] }, label: "Deleted a vertex" });
    expect(clickOp("delete", segment, t)).toEqual({ refused: "Click on a vertex to take it out." });
    expect(clickOp("delete", undefined, t)).toEqual({ refused: "Click on a vertex to take it out." });
    expect(clickOp("convert", segment, t)).toEqual({ refused: "Click on a vertex to change it." });
    expect(clickOp("convert", vertex, t)).toMatchObject({ label: "Made a vertex a corner" });
    expect(clickOp("convert", { kind: "vertex", subpath: 0, index: 0 }, target(shape("a", { path: square })))).toMatchObject({ label: "Made a vertex smooth" });
  });

  it("refuses by the geometry's reason, in a sentence", () => {
    const two = target(shape("a", { path: { closed: false, vertices: [{ x: 0, y: 0 }, { x: 5, y: 5 }], inTangents: [z, z], outTangents: [z, z] } }));
    expect(clickOp("delete", { kind: "vertex", subpath: 0, index: 0 }, two)).toEqual({ refused: "A path keeps two vertices." });
    const stacked = target(shape("a", { path: { closed: false, vertices: [{ x: 0, y: 0 }, { x: 0, y: 0 }], inTangents: [z, z], outTangents: [z, z] } }));
    expect(clickOp("convert", { kind: "vertex", subpath: 0, index: 0 }, stacked)).toEqual({ refused: "Its neighbours are on top of it." });
  });

  it("deletes every selected vertex of one subpath at once", () => {
    expect(deleteSelected(t, [])).toEqual({ refused: "Select the vertices to delete first." });
    expect(deleteSelected(target(shape("a", { path: square })), [{ subpath: 0, index: 1 }, { subpath: 0, index: 2 }])).toEqual({ refused: "A closed path keeps three vertices." });
    expect(deleteSelected(target(shape("a", { path: { ...square, closed: false } })), [{ subpath: 0, index: 1 }, { subpath: 0, index: 2 }])).toMatchObject({
      op: { op: "deleteVertices", indices: [1, 2] },
      label: "Deleted 2 vertices",
    });
  });
});

describe("what the viewport draws", () => {
  it("is the path in canvas coordinates, every vertex, and the handles of the selected ones only", () => {
    const t = target(shape("a", { x: 10, y: 20 }));
    const sketch = pathEditSketch(t, [{ subpath: 0, index: 1 }]);
    expect(sketch.d.startsWith("M 10 20 C 40 60")).toBe(true);
    expect(sketch.vertices).toEqual([
      { x: 10, y: 20, selected: false },
      { x: 110, y: 20, selected: true },
      { x: 210, y: 70, selected: false },
    ]);
    expect(sketch.handles).toEqual([
      { x1: 110, y1: 20, x2: 140, y2: 60 },
      { x1: 110, y1: 20, x2: 80, y2: -20 },
    ]);
    expect(pathEditSketch(t, []).handles).toEqual([]);
  });

  it("draws a dragged subpath as it would be, and closes a closed one", () => {
    const t = target(shape("a", { path: square }));
    const moved = applyOp(square, { op: "moveVertices", indices: [0], delta: { x: 5, y: 5 } })!;
    const sketch = pathEditSketch(t, [], { subpath: 0, path: moved });
    expect(sketch.vertices[0]).toMatchObject({ x: 5, y: 5 });
    expect(sketch.d.endsWith("Z")).toBe(true);
  });
});

describe("the gaps the mutants found", () => {
  const sel1: Selected[] = [{ subpath: 0, index: 1 }];

  it("takes a handle only within the radius", () => {
    const t = target();
    // The out handle of vertex 1 ends at (130, 40): 20 away is out of an 8 pixel reach.
    expect(pickPath(t, sel1, { x: 150, y: 40 }, 8)?.kind).not.toBe("handle");
    expect(pickPath(t, sel1, { x: 137, y: 40 }, 8)).toEqual({ kind: "handle", subpath: 0, index: 1, side: "out" });
  });

  it("deletes the selected vertices of the first subpath only", () => {
    const two = target(shape("a", { path: { ...square, closed: false }, compoundPaths: [{ ...square, closed: false }] }));
    const made = deleteSelected(two, [{ subpath: 0, index: 1 }, { subpath: 1, index: 0 }, { subpath: 0, index: 3 }]);
    expect(made).toMatchObject({ subpath: 0, op: { op: "deleteVertices", indices: [1, 3] } });
  });

  it("keeps a marquee to its height as well as its width", () => {
    const t = target();
    expect(verticesInBox(t, { x: -10, y: 500, width: 400, height: 20 })).toEqual([]);
    expect(verticesInBox(t, { x: -10, y: -10, width: 400, height: 20 }).length).toBeGreaterThan(0);
  });
});

describe("joining two open shapes (11.110)", () => {
  const line = (points: [number, number][]): BezierPath => ({ closed: false, vertices: points.map(([x, y]) => ({ x, y })), inTangents: points.map(() => z), outTangents: points.map(() => z) });
  const open = (id: string, points: [number, number][], extra: Record<string, unknown> = {}) => shape(id, { path: line(points), compoundPaths: [], ...extra });

  it("makes one path of the two at the nearest ends, in the first shape's space, moving neither, and removes the second, as one batch", () => {
    const a = open("a", [[0, 0], [50, 0], [100, 0]]);
    const b = open("b", [[104, 2], [150, 0], [200, 0]]);
    const edits = joinEdits(docOf(a, b), ["a", "b"]);
    if ("refused" in edits) throw new Error(edits.refused);
    expect(edits.map((e) => e.edit)).toEqual(["setShapePath", "deleteObject"]);
    const set = edits[0] as unknown as { shapeId: string; path: BezierPath };
    expect(set.shapeId).toBe("a");
    // A's last vertex and B's first are 4 apart: both paths keep all their vertices, and a segment runs between the two ends.
    expect(set.path.vertices).toEqual([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }, { x: 104, y: 2 }, { x: 150, y: 0 }, { x: 200, y: 0 }]);
    expect((edits[1] as unknown as { objectId: string }).objectId).toBe("b");
  });

  it("turns the second round when its far end is the one that meets, and starts from the second when the first's start meets it", () => {
    const a = open("a", [[0, 0], [100, 0]]);
    const reversedB = open("b", [[300, 0], [102, 0]]);
    const far = joinEdits(docOf(a, reversedB), ["a", "b"]) as unknown as { path: BezierPath }[];
    expect(far[0]!.path.vertices.map((v) => v.x)).toEqual([0, 100, 102, 300]);
    const before = open("c", [[-100, 0], [-2, 0]]);
    const front = joinEdits(docOf(a, before), ["a", "c"]) as unknown as { path: BezierPath }[];
    // C's end meets A's start: C then A.
    expect(front[0]!.path.vertices.map((v) => Math.round(v.x))).toEqual([-100, -2, 0, 100]);
  });

  it("takes the second's points through its own place, turn and scale into the first's", () => {
    const a = open("a", [[0, 0], [100, 0]]);
    // B is drawn 50 long and doubled by its scale, standing at x 100: canvas (100,0) to (200,0).
    const scaled = open("b", [[0, 0], [50, 0]], { x: 100, y: 0, scaleX: 2, scaleY: 2 });
    const edits = joinEdits(docOf(a, scaled), ["a", "b"]) as unknown as { path: BezierPath }[];
    expect(edits[0]!.path.vertices.map((v) => [v.x, v.y])).toEqual([[0, 0], [100, 0], [200, 0]]);
    // Turned a quarter, it runs down the canvas from (100,0) to (100,50) and the join follows it.
    const turned = open("t", [[0, 0], [50, 0]], { x: 100, y: 0, rotation: 90 });
    const down = joinEdits(docOf(a, turned), ["a", "t"]) as unknown as { path: BezierPath }[];
    const [, , end] = down[0]!.path.vertices;
    expect(end!.x).toBeCloseTo(100, 6);
    expect(end!.y).toBeCloseTo(50, 6);
  });

  it("refuses by name what it cannot join", () => {
    const a = open("a", [[0, 0], [100, 0]]);
    const b = open("b", [[100, 0], [200, 0]]);
    expect(joinEdits(docOf(a, b), ["a"])).toMatchObject({ refused: "Select two open shapes to join them." });
    expect(joinEdits(docOf(a, shape("c", { path: square })), ["a", "c"])).toMatchObject({ refused: expect.stringContaining("closed") });
    expect(joinEdits(docOf(a, open("l", [[0, 0], [1, 1]], { locked: true })), ["a", "l"])).toMatchObject({ refused: expect.stringContaining("locked") });
    const text = { ...shape("t"), type: "text", name: "Title" } as unknown as SceneObject;
    expect(joinEdits(docOf(a, text), ["a", "t"])).toMatchObject({ refused: expect.stringContaining("not a shape") });
    expect(joinEdits(docOf(a, open("m", [[0, 0], [5, 5]], { compoundPaths: [curve] })), ["a", "m"])).toMatchObject({ refused: expect.stringContaining("more than one path") });
    // Two shapes in one group at an offset still join: both are taken through the group.
    const group = { id: "g", name: "G", type: "group", childIds: ["a", "b"], x: 500, y: 0, rotation: 0, scaleX: 1, scaleY: 1, locked: false } as unknown as SceneObject;
    const joined = joinEdits(docOf(group, a, b), ["a", "b"]);
    expect("refused" in joined).toBe(false);
  });
});

describe("Remove Point, Keep Shape with the Delete Vertex tool (11.113)", () => {
  const ring = (): BezierPath => {
    const n = 8, r = 100, k = (4 / 3) * Math.tan(Math.PI / 16);
    const out: BezierPath = { closed: true, vertices: [], inTangents: [], outTangents: [] };
    for (let i = 0; i < n; i += 1) {
      const a = (2 * Math.PI * i) / n;
      out.vertices.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
      out.outTangents.push({ x: -r * Math.sin(a) * k, y: r * Math.cos(a) * k });
      out.inTangents.push({ x: r * Math.sin(a) * k, y: -r * Math.cos(a) * k });
    }
    return out;
  };

  it("sends a keep-shape delete with its tolerance when the shape stays within it, and says by how much", () => {
    const t = target(shape("a", { path: ring() }));
    const hit = { kind: "vertex" as const, subpath: 0, index: 3 };
    const done = clickOp("delete", hit, t, 1);
    if ("refused" in done) throw new Error(done.refused);
    expect(done.op).toEqual({ op: "deleteKeepShape", index: 3, tolerance: 1 });
    expect(done.label).toMatch(/^Removed a vertex, keeping the shape \(0\.\d\d px\)$/);
    expect(applyOp(ring(), done.op)!.vertices).toHaveLength(7);
    // Without Alt the ordinary delete is sent, and changes the shape.
    expect(clickOp("delete", hit, t)).toMatchObject({ op: { op: "deleteVertices", indices: [3] } });
  });

  it("keeps the vertex and says how far the shape would move when it would move too far", () => {
    const corner: BezierPath = { closed: false, vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], inTangents: [z, z, z], outTangents: [z, z, z] };
    const t = target(shape("a", { path: corner }));
    const refused = clickOp("delete", { kind: "vertex", subpath: 0, index: 1 }, t, 1);
    expect(refused).toMatchObject({ refused: expect.stringMatching(/would move the shape by \d+\.\d\d pixels, more than the 1 allowed/) });
    expect(clickOp("delete", { kind: "vertex", subpath: 0, index: 1 }, t, 50)).toMatchObject({ op: { op: "deleteKeepShape" } });
  });

  it("is read from the setting and used with Alt in the page", () => {
    // (the page patterns are pinned in mask-edit.test.ts)
    expect(applyOp(ring(), { op: "deleteKeepShape", index: 0, tolerance: -1 })).toBeUndefined();
  });
});
