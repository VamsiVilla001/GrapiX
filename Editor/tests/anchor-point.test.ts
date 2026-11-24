// The pivot (11.103): the arithmetic that moves it without moving what is drawn, and the plan of edits for the panel.
import { describe, expect, it } from "vitest";
import type { SceneDocument, SceneEdit, SceneObject } from "@grapix/contracts";
import { isRefused } from "../src/inspector";
import {
  effectivePlacement,
  GRID,
  pivotEdits,
  pivotLabel,
  pivotPlan,
  placementOf,
  toLocalDelta,
  toSceneDelta,
  type Placement,
  type PivotRequest,
} from "../src/anchor-point";
import { localBox, objectOverlayBounds } from "../src/overlay";

function rect(id: string, x: number, y: number, width: number, height: number, extra: Record<string, unknown> = {}): SceneObject {
  return {
    type: "rect", id, name: id, visible: true, locked: false, opacity: 1, x, y, zDepth: 0, zIndex: 0, layerId: "",
    width, height, rotation: 0, rotationX: 0, rotationY: 0, scaleX: 1, scaleY: 1, scaleZ: 1, strokeWidth: 0, radius: 0,
    ...extra,
  } as unknown as SceneObject;
}

function group(id: string, childIds: string[], extra: Record<string, unknown> = {}): SceneObject {
  return { ...rect(id, 0, 0, 0, 0, extra), type: "group", childIds } as unknown as SceneObject;
}

function shape(id: string, points: [number, number][], extra: Record<string, unknown> = {}): SceneObject {
  const zero = points.map(() => ({ x: 0, y: 0 }));
  return {
    ...rect(id, 0, 0, 0, 0, extra), type: "shape",
    path: { closed: true, vertices: points.map(([x, y]) => ({ x, y })), inTangents: zero, outTangents: zero },
  } as unknown as SceneObject;
}

function scene(objects: SceneObject[], channels: { objectId: string; property: string; keys: unknown[] }[] = []): SceneDocument {
  return {
    id: "s", name: "S", version: 4,
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    objects,
    timeline: { channels, phases: [], pathChannels: [] },
  } as unknown as SceneDocument;
}

/** Where a point of the object's own space lands on the canvas: (x, y) + R·S·(q - anchor). */
function landing(p: Placement, q: { x: number; y: number }): { x: number; y: number } {
  const moved = toSceneDelta(p, q.x - p.anchorX, q.y - p.anchorY);
  return { x: p.x + moved.x, y: p.y + moved.y };
}

/** The placement after the edits, as the engine would apply them. */
function apply(p: Placement, edits: readonly SceneEdit[]): Placement {
  let next = { ...p };
  for (const edit of edits) {
    const e = edit as unknown as { edit: string; anchor?: { x: number; y: number } | null; field?: { name: string; value: number } };
    if (e.edit === "setAnchor") next = { ...next, anchorX: e.anchor?.x ?? 0, anchorY: e.anchor?.y ?? 0 };
    if (e.edit === "setObjectField" && e.field !== undefined) next = { ...next, [e.field.name]: e.field.value };
  }
  return next;
}

const plan = (document: SceneDocument, ids: string[], request: PivotRequest, keepInPlace = true) => {
  const outcome = pivotPlan(document, ids, request, { keepInPlace });
  if (isRefused(outcome)) throw new Error(`refused: ${outcome.refused}`);
  return outcome;
};
const refusal = (document: SceneDocument, ids: string[], request: PivotRequest, keepInPlace = true): string => {
  const outcome = pivotPlan(document, ids, request, { keepInPlace });
  if (!isRefused(outcome)) throw new Error("expected a refusal");
  return outcome.refused;
};

describe("the arithmetic", () => {
  it("turns a distance on the canvas into the object's own space and back", () => {
    for (const rotation of [0, 30, 90, 137, -45, 180]) {
      for (const [scaleX, scaleY] of [[1, 1], [2, 0.5], [0.25, 4], [-1, 1]] as const) {
        const p = { rotation, scaleX, scaleY };
        const local = toLocalDelta(p, 37, -12)!;
        const back = toSceneDelta(p, local.x, local.y);
        expect(back.x).toBeCloseTo(37, 9);
        expect(back.y).toBeCloseTo(-12, 9);
      }
    }
  });

  it("has no answer for an object scaled to nothing", () => {
    expect(toLocalDelta({ rotation: 0, scaleX: 0, scaleY: 1 }, 1, 1)).toBeUndefined();
    expect(toLocalDelta({ rotation: 0, scaleX: 1, scaleY: 0 }, 1, 1)).toBeUndefined();
  });

  it("turns clockwise on screen: a quarter turn takes the object's right to the canvas's down", () => {
    const down = toSceneDelta({ rotation: 90, scaleX: 1, scaleY: 1 }, 10, 0);
    expect(down.x).toBeCloseTo(0, 9);
    expect(down.y).toBeCloseTo(10, 9);
  });

  it("keeps every point of the object where it was when the pivot moves with the position", () => {
    for (const rotation of [0, 33, 90, -120]) {
      for (const [scaleX, scaleY] of [[1, 1], [2, 3], [0.5, 0.5]] as const) {
        for (const [anchorX, anchorY] of [[0, 0], [20, 10], [-5, 40]] as const) {
          const from: Placement = { x: 300, y: 200, rotation, scaleX, scaleY, anchorX, anchorY };
          const after = apply(from, pivotEdits("a", from, { x: 70, y: 35 }, true));
          expect(after.anchorX).toBe(70);
          expect(after.anchorY).toBe(35);
          for (const q of [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 40, y: 90 }, { x: 70, y: 35 }]) {
            const was = landing(from, q);
            const is = landing(after, q);
            expect(is.x, `x of ${q.x},${q.y} at ${rotation}`).toBeCloseTo(was.x, 2);
            expect(is.y, `y of ${q.x},${q.y} at ${rotation}`).toBeCloseTo(was.y, 2);
          }
        }
      }
    }
  });

  it("moves the picture with the pivot when asked not to keep it in place", () => {
    const from: Placement = { x: 300, y: 200, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 0, anchorY: 0 };
    const edits = pivotEdits("a", from, { x: 70, y: 35 }, false);
    expect(edits).toEqual([{ edit: "setAnchor", objectIds: ["a"], anchor: { x: 70, y: 35 } }]);
  });

  it("sends nothing when the pivot is already there, and only the fields that change", () => {
    const from: Placement = { x: 300, y: 200, rotation: 0, scaleX: 1, scaleY: 1, anchorX: 10, anchorY: 10 };
    expect(pivotEdits("a", from, { x: 10, y: 10 }, true)).toEqual([]);
    expect(pivotEdits("a", from, { x: 10.00001, y: 10 }, true)).toEqual([]);
    const across = pivotEdits("a", from, { x: 60, y: 10 }, true);
    expect(across).toEqual([
      { edit: "setAnchor", objectIds: ["a"], anchor: { x: 60, y: 10 } },
      { edit: "setObjectField", objectIds: ["a"], field: { name: "x", value: 350 } },
    ]);
  });
});

describe("the box a pivot is placed on", () => {
  it("is the width and height from the top left for a rectangle, ellipse, image or text", () => {
    expect(localBox(rect("a", 5, 5, 100, 40))).toEqual({ left: 0, top: 0, width: 100, height: 40 });
    expect(localBox({ ...rect("t", 0, 0, 80, 20), type: "text" } as unknown as SceneObject)).toEqual({ left: 0, top: 0, width: 80, height: 20 });
  });

  it("is the path's own bounds for a shape, wherever the path sits", () => {
    expect(localBox(shape("s", [[200, 100], [300, 100], [300, 160], [200, 160]]))).toEqual({ left: 200, top: 100, width: 100, height: 60 });
    // And the selection box is drawn there too, not at the corner of the canvas.
    expect(objectOverlayBounds(shape("s", [[200, 100], [300, 100], [300, 160], [200, 160]]))).toEqual({ x: 200, y: 100, width: 100, height: 60 });
  });

  it("is nothing for an object with no box, or a box of no size", () => {
    expect(localBox(group("g", []))).toBeUndefined();
    expect(localBox(rect("a", 0, 0, 0, 40))).toBeUndefined();
  });
});

describe("the nine places", () => {
  it("are the corners, edges and middle of the box", () => {
    expect(GRID.map((cell) => [cell.fx, cell.fy])).toEqual([[0, 0], [0.5, 0], [1, 0], [0, 0.5], [0.5, 0.5], [1, 0.5], [0, 1], [0.5, 1], [1, 1]]);
    expect(new Set(GRID.map((cell) => cell.id)).size).toBe(9);
  });

  it("puts the pivot on the middle of the box and moves the position so nothing moves", () => {
    const document = scene([rect("a", 200, 100, 100, 40)]);
    const edits = plan(document, ["a"], { kind: "grid", place: "centre" });
    expect(edits).toEqual([
      { edit: "setAnchor", objectIds: ["a"], anchor: { x: 50, y: 20 } },
      { edit: "setObjectField", objectIds: ["a"], field: { name: "x", value: 250 } },
      { edit: "setObjectField", objectIds: ["a"], field: { name: "y", value: 120 } },
    ]);
  });

  it("puts each of the nine where the box says, for each object", () => {
    const document = scene([rect("a", 0, 0, 100, 40, { rotation: 20, scaleX: 2 }), rect("b", 500, 500, 60, 80)]);
    for (const cell of GRID) {
      const outcome = pivotPlan(document, ["a", "b"], { kind: "grid", place: cell.id });
      if (isRefused(outcome)) continue; // the top left is where it already is
      for (const id of ["a", "b"]) {
        const object = document.objects.find((o) => o.id === id)!;
        const after = apply(placementOf(object), outcome.filter((e) => (e as unknown as { objectIds: string[] }).objectIds[0] === id));
        expect(after.anchorX, `${id} ${cell.id}`).toBeCloseTo(cell.fx * object.width, 3);
        expect(after.anchorY, `${id} ${cell.id}`).toBeCloseTo(cell.fy * object.height, 3);
        // The picture has not moved: the box's own top left lands where it did.
        const was = landing(placementOf(object), { x: 0, y: 0 });
        const is = landing(after, { x: 0, y: 0 });
        expect(is.x).toBeCloseTo(was.x, 2);
        expect(is.y).toBeCloseTo(was.y, 2);
      }
    }
  });

  it("adds the offset in the object's own pixels", () => {
    const document = scene([rect("a", 0, 0, 100, 40)]);
    const edits = plan(document, ["a"], { kind: "grid", place: "bottom-right", offset: { x: -10, y: 5 } }, false);
    expect(edits).toEqual([{ edit: "setAnchor", objectIds: ["a"], anchor: { x: 90, y: 45 } }]);
  });

  it("uses a shape's path bounds, so the middle is the middle of what is drawn", () => {
    const document = scene([shape("s", [[200, 100], [300, 100], [300, 160], [200, 160]])]);
    const edits = plan(document, ["s"], { kind: "grid", place: "centre" }, false);
    expect(edits).toEqual([{ edit: "setAnchor", objectIds: ["s"], anchor: { x: 250, y: 130 } }]);
  });

  it("puts the pivots of a selection on one point of the canvas with the selection scope", () => {
    const document = scene([rect("a", 0, 0, 100, 100), rect("b", 300, 200, 100, 100, { rotation: 45, scaleX: 2 })]);
    const edits = plan(document, ["a", "b"], { kind: "selection", place: "centre" }, false);
    const bounds = [objectOverlayBounds(document.objects[0]!), objectOverlayBounds(document.objects[1]!)];
    const left = Math.min(...bounds.map((b) => b.x));
    const right = Math.max(...bounds.map((b) => b.x + b.width));
    const top = Math.min(...bounds.map((b) => b.y));
    const bottom = Math.max(...bounds.map((b) => b.y + b.height));
    const centre = { x: (left + right) / 2, y: (top + bottom) / 2 };
    expect(centre.x).toBeGreaterThan(0);
    for (const object of document.objects) {
      const after = apply(placementOf(object), edits.filter((e) => (e as unknown as { objectIds: string[] }).objectIds[0] === object.id));
      // The pivot's place on the canvas, with the position left where it is, is the pivot's own point: the position.
      // With keep in place off the position stays, so the pivot's canvas place is (x, y) for both, but the point of the
      // object that sits there is the one the grid chose: it lands on the selection's centre before the edit.
      const q = { x: after.anchorX, y: after.anchorY };
      const was = landing(placementOf(object), q);
      expect(was.x).toBeCloseTo(centre.x, 2);
      expect(was.y).toBeCloseTo(centre.y, 2);
    }
  });
});

describe("reset, typed point and nudge", () => {
  const document = scene([rect("a", 300, 200, 100, 40, { anchor: { x: 50, y: 20 }, rotation: 90 })]);

  it("puts the pivot back at the origin without moving the picture", () => {
    const from = placementOf(document.objects[0]!);
    const after = apply(from, plan(document, ["a"], { kind: "reset" }));
    expect([after.anchorX, after.anchorY]).toEqual([0, 0]);
    const was = landing(from, { x: 100, y: 40 });
    const is = landing(after, { x: 100, y: 40 });
    expect(is.x).toBeCloseTo(was.x, 2);
    expect(is.y).toBeCloseTo(was.y, 2);
  });

  it("sets a typed point, and leaves a coordinate that was not typed", () => {
    expect(plan(document, ["a"], { kind: "point", x: 10 }, false)).toEqual([{ edit: "setAnchor", objectIds: ["a"], anchor: { x: 10, y: 20 } }]);
    expect(plan(document, ["a"], { kind: "point", y: 5 }, false)).toEqual([{ edit: "setAnchor", objectIds: ["a"], anchor: { x: 50, y: 5 } }]);
  });

  it("nudges by a distance in the object's own pixels", () => {
    expect(plan(document, ["a"], { kind: "nudge", dx: 1, dy: -10 }, false)).toEqual([{ edit: "setAnchor", objectIds: ["a"], anchor: { x: 51, y: 10 } }]);
  });

  it("says when nothing would change", () => {
    expect(refusal(document, ["a"], { kind: "point", x: 50, y: 20 })).toBe("The pivot is already there; nothing was changed.");
    expect(refusal(document, ["a"], { kind: "nudge", dx: 0, dy: 0 })).toBe("The pivot is already there; nothing was changed.");
  });

  it("refuses a pivot that is not a number", () => {
    expect(refusal(document, ["a"], { kind: "point", x: Number.NaN })).toBe("The pivot must be a number.");
    expect(refusal(document, ["a"], { kind: "nudge", dx: Number.POSITIVE_INFINITY, dy: 0 })).toBe("The pivot must be a number.");
  });
});

describe("what is refused, by name", () => {
  const plain = scene([rect("a", 0, 0, 100, 40), rect("b", 200, 0, 100, 40)]);

  it("needs something selected", () => {
    expect(refusal(plain, [], { kind: "grid", place: "centre" })).toBe("Select an object first.");
    expect(refusal(plain, ["gone"], { kind: "reset" })).toBe("Select an object first.");
  });

  it("refuses a locked object, and an item in a locked group", () => {
    expect(refusal(scene([rect("a", 0, 0, 1, 1, { locked: true })]), ["a"], { kind: "reset" })).toBe("a is locked. Unlock it first; nothing was changed.");
    const inLocked = scene([group("g", ["a"], { locked: true, name: "Lower third" }), rect("a", 0, 0, 10, 10, { anchor: { x: 1, y: 1 } })]);
    expect(refusal(inLocked, ["a"], { kind: "reset" })).toBe("a is in Lower third, which is locked. Unlock it first; nothing was changed.");
  });

  it("refuses a group, which draws nothing of its own, and a mesh", () => {
    expect(refusal(scene([group("g", [])]), ["g"], { kind: "point", x: 1 })).toBe("g draws nothing of its own, so it has no pivot to place. Select the items inside it.");
    const mesh = { ...rect("m", 0, 0, 10, 10), type: "mesh" } as unknown as SceneObject;
    expect(refusal(scene([mesh]), ["m"], { kind: "point", x: 1 })).toBe("m keeps its pivot in 3D, which the pivot tools do not place yet.");
  });

  it("refuses an object with no box for a place on the box, but takes a typed point", () => {
    const flat = scene([rect("a", 0, 0, 0, 0)]);
    expect(refusal(flat, ["a"], { kind: "grid", place: "centre" })).toBe("a has no box of its own to place a pivot on. Type a point, or use the Pivot tool.");
    expect(isRefused(pivotPlan(flat, ["a"], { kind: "point", x: 5, y: 5 }))).toBe(false);
  });

  it("refuses a place that is not one of the nine", () => {
    expect(refusal(plain, ["a"], { kind: "grid", place: "middle-ish" })).toBe("middle-ish is not a place on the box.");
    expect(refusal(plain, ["a", "b"], { kind: "selection", place: "nowhere" })).toBe("nowhere is not a place on the box.");
  });

  it("refuses a scale of 0 only when the picture is to stay, since then it cannot be done", () => {
    const flat = scene([rect("a", 0, 0, 100, 40, { scaleX: 0 })]);
    expect(refusal(flat, ["a"], { kind: "grid", place: "centre" })).toBe("a has a scale of 0, so the pivot cannot be placed without moving what is drawn.");
    expect(isRefused(pivotPlan(flat, ["a"], { kind: "grid", place: "centre" }, { keepInPlace: false }))).toBe(false);
  });

  it("refuses the selection scope inside a group, whose own space is not read yet, but not a place on each box", () => {
    const grouped = scene([group("g", ["a"]), rect("a", 10, 10, 100, 40), rect("b", 300, 0, 100, 40)]);
    expect(refusal(grouped, ["a", "b"], { kind: "selection", place: "centre" })).toContain("is inside a group");
    // A place on each object's own box is in its own space, so a group above does not matter.
    expect(isRefused(pivotPlan(grouped, ["a"], { kind: "grid", place: "centre" }))).toBe(false);
  });

  it("acts on the group's own pivot, not on a child selected with it", () => {
    const grouped = scene([group("g", ["a"]), rect("a", 10, 10, 100, 40)]);
    expect(refusal(grouped, ["g", "a"], { kind: "point", x: 1 })).toContain("g draws nothing of its own");
  });
});

describe("when the position has keys", () => {
  const key = (frame: number, value: number) => ({ frame, value, easing: "linear" });
  const keyedX = (extra: Record<string, unknown> = {}, more: { objectId: string; property: string; keys: unknown[] }[] = []) =>
    scene([rect("a", 100, 100, 100, 40, extra)], [{ objectId: "a", property: "x", keys: [key(0, 100), key(50, 300)] }, ...more]);
  const kinds = (edits: readonly SceneEdit[]) => edits.map((e) => (e as { edit: string }).edit);

  it("adds a key at the playhead, holding the picture there, by default", () => {
    const document = keyedX();
    // At frame 25 the animation has the object at x 200.
    const view = scene([rect("a", 200, 100, 100, 40)]);
    const edits = plan(document, ["a"], { kind: "grid", place: "centre" }, true);
    expect(isRefused(pivotPlan(document, ["a"], { kind: "grid", place: "centre" }, { keepInPlace: true, frame: 25, view }))).toBe(false);
    const withView = pivotPlan(document, ["a"], { kind: "grid", place: "centre" }, { keepInPlace: true, frame: 25, view });
    if (isRefused(withView)) throw new Error(withView.refused);
    expect(withView).toEqual([
      { edit: "setAnchor", objectIds: ["a"], anchor: { x: 50, y: 20 } },
      { edit: "editProperty", objectId: "a", property: "x", value: 250, frame: 25, autoKey: true },
      { edit: "setObjectField", objectIds: ["a"], field: { name: "y", value: 120 } },
    ]);
    expect(kinds(edits)[1]).toBe("editProperty");
  });

  it("uses the turn and scale the object has at the playhead", () => {
    const view = scene([rect("a", 200, 100, 100, 40, { rotation: 90 })]);
    const outcome = pivotPlan(keyedX({ rotation: 0 }), ["a"], { kind: "grid", place: "centre" }, { frame: 25, view });
    if (isRefused(outcome)) throw new Error(outcome.refused);
    // A quarter turn takes the own-space distance (50, 20) to (-20, 50) on the canvas.
    expect(outcome[1]).toMatchObject({ edit: "editProperty", property: "x", value: 180, frame: 25 });
    expect(outcome[2]).toMatchObject({ field: { name: "y", value: 150 } });
  });

  it("moves every key by the same distance, and the unkeyed position with it, in Modify mode", () => {
    const outcome = pivotPlan(keyedX(), ["a"], { kind: "grid", place: "centre" }, { keyed: "modify" });
    if (isRefused(outcome)) throw new Error(outcome.refused);
    expect(outcome).toEqual([
      { edit: "setAnchor", objectIds: ["a"], anchor: { x: 50, y: 20 } },
      { edit: "updateKeyframe", objectId: "a", property: "x", keyframe: { frame: 0, value: 150, easing: "linear" } },
      { edit: "updateKeyframe", objectId: "a", property: "x", keyframe: { frame: 50, value: 350, easing: "linear" } },
      { edit: "setObjectField", objectIds: ["a"], field: { name: "y", value: 120 } },
    ]);
  });

  it("keeps the picture at every frame in Modify mode, even turned", () => {
    const document = keyedX({ rotation: 90, scaleX: 2 });
    const outcome = plan(document, ["a"], { kind: "grid", place: "centre" }, true);
    void outcome;
    const modify = pivotPlan(document, ["a"], { kind: "grid", place: "centre" }, { keyed: "modify" });
    if (isRefused(modify)) throw new Error(modify.refused);
    const object = document.objects[0]!;
    const before = placementOf(object);
    for (const frame of [0, 50]) {
      const x = frame === 0 ? 100 : 300;
      const oldAt = { ...before, x };
      const key = modify.find((e) => (e as { property?: string; keyframe?: { frame: number } }).property === "x" && (e as unknown as { keyframe: { frame: number } }).keyframe.frame === frame) as unknown as { keyframe: { value: number } };
      const yEdit = modify.find((e) => (e as { field?: { name: string } }).field?.name === "y") as unknown as { field: { value: number } };
      const newAt = { ...before, x: key.keyframe.value, y: yEdit.field.value, anchorX: 50, anchorY: 20 };
      for (const q of [{ x: 0, y: 0 }, { x: 100, y: 40 }]) {
        const was = landing(oldAt, q);
        const is = landing(newAt, q);
        expect(is.x, `frame ${frame}`).toBeCloseTo(was.x, 2);
        expect(is.y, `frame ${frame}`).toBeCloseTo(was.y, 2);
      }
    }
  });

  it("refuses Modify when the turn or scale has keys too, and says to insert a key instead", () => {
    for (const property of ["rotation", "scaleX", "scaleY"]) {
      const document = keyedX({}, [{ objectId: "a", property, keys: [key(0, 0), key(10, 1)] }]);
      const outcome = pivotPlan(document, ["a"], { kind: "grid", place: "centre" }, { keyed: "modify" });
      expect(isRefused(outcome) && outcome.refused, property).toBe(`a has keys on ${property}, so one distance cannot keep its picture at every frame. Insert a keyframe at the playhead instead.`);
      // Inserting a key at the playhead is fine: it holds the picture at that frame.
      expect(isRefused(pivotPlan(document, ["a"], { kind: "grid", place: "centre" }, { keyed: "insert", frame: 5 })), property).toBe(false);
    }
  });

  it("leaves the keys alone when the picture is to move with the pivot, or the keys are on something else", () => {
    const edits = plan(keyedX(), ["a"], { kind: "grid", place: "centre" }, false);
    expect(edits).toEqual([{ edit: "setAnchor", objectIds: ["a"], anchor: { x: 50, y: 20 } }]);
    const opacity = scene([rect("a", 100, 100, 100, 40)], [{ objectId: "a", property: "opacity", keys: [key(0, 1)] }]);
    expect(kinds(plan(opacity, ["a"], { kind: "grid", place: "centre" }))).toEqual(["setAnchor", "setObjectField", "setObjectField"]);
    const empty = scene([rect("a", 100, 100, 100, 40)], [{ objectId: "a", property: "x", keys: [] }]);
    expect(kinds(plan(empty, ["a"], { kind: "grid", place: "centre" }))).toEqual(["setAnchor", "setObjectField", "setObjectField"]);
  });

  it("refuses a playhead that is not a whole frame", () => {
    for (const frame of [-1, 2.5, Number.NaN]) {
      const outcome = pivotPlan(keyedX(), ["a"], { kind: "grid", place: "centre" }, { frame });
      expect(isRefused(outcome) && outcome.refused, String(frame)).toBe("The playhead is not on a whole frame.");
    }
  });

  it("sends nothing when the pivot is already there, keys or not", () => {
    const document = scene([rect("a", 100, 100, 100, 40, { anchor: { x: 50, y: 20 } })], [{ objectId: "a", property: "x", keys: [key(0, 100)] }]);
    expect(isRefused(pivotPlan(document, ["a"], { kind: "grid", place: "centre" }))).toBe(true);
  });
});

describe("a turn or scale with keys", () => {
  const key = (frame: number, value: number) => ({ frame, value, easing: "linear" });
  const turnKeyed = (extra: Record<string, unknown> = {}) =>
    scene([rect("a", 100, 100, 100, 40, extra)], [{ objectId: "a", property: "rotation", keys: [key(0, 0), key(100, 90)] }]);

  it("holds the picture as it is drawn at the playhead, even when the position has no keys", () => {
    // At this frame the animation has turned the rectangle a quarter turn.
    const view = scene([rect("a", 100, 100, 100, 40, { rotation: 90 })]);
    const outcome = pivotPlan(turnKeyed(), ["a"], { kind: "grid", place: "centre" }, { frame: 50, view });
    if (isRefused(outcome)) throw new Error(outcome.refused);
    // The own-space distance (50, 20) is (-20, 50) on the canvas at a quarter turn, not (50, 20) as stored (not turned).
    expect(outcome).toEqual([
      { edit: "setAnchor", objectIds: ["a"], anchor: { x: 50, y: 20 } },
      { edit: "setObjectField", objectIds: ["a"], field: { name: "x", value: 80 } },
      { edit: "setObjectField", objectIds: ["a"], field: { name: "y", value: 150 } },
    ]);
  });

  it("is the same as before when nothing is animated, so the stored turn is used", () => {
    const stored = scene([rect("a", 100, 100, 100, 40, { rotation: 90 })]);
    const outcome = plan(stored, ["a"], { kind: "grid", place: "centre" });
    expect(outcome[1]).toMatchObject({ field: { name: "x", value: 80 } });
  });

  it("puts the pivots of a selection on one point of the canvas as drawn at the playhead", () => {
    const stored = scene([rect("a", 0, 0, 100, 100), rect("b", 300, 200, 100, 100)], [{ objectId: "a", property: "x", keys: [key(0, 0), key(100, 500)] }]);
    // At the playhead a has gone to x 200.
    const view = scene([rect("a", 200, 0, 100, 100), rect("b", 300, 200, 100, 100)]);
    const outcome = pivotPlan(stored, ["a", "b"], { kind: "selection", place: "top-left" }, { keepInPlace: false, view });
    if (isRefused(outcome)) throw new Error(outcome.refused);
    // The selection's top left as drawn is (200, 0): b's own top left is at (300, 200), so its pivot goes to (-100, -200).
    expect(outcome).toContainEqual({ edit: "setAnchor", objectIds: ["b"], anchor: { x: -100, y: -200 } });
    // a's own top left is already there as drawn, so a has nothing to change.
    expect(outcome.some((e) => (e as unknown as { objectIds: string[] }).objectIds[0] === "a")).toBe(false);
  });

  it("keeps the offset when the pivots of a selection meet", () => {
    const document = scene([rect("a", 0, 0, 100, 100), rect("b", 200, 0, 100, 100)]);
    const edits = plan(document, ["a", "b"], { kind: "selection", place: "top-left", offset: { x: 10, y: 20 } }, false);
    expect(edits).toContainEqual({ edit: "setAnchor", objectIds: ["a"], anchor: { x: 10, y: 20 } });
    expect(edits).toContainEqual({ edit: "setAnchor", objectIds: ["b"], anchor: { x: -190, y: 20 } });
  });
});

describe("the words", () => {
  it("says what was done to whom", () => {
    expect(pivotLabel([{ name: "Title" }], { kind: "grid", place: "bottom-left" }, true)).toBe("Put the pivot of Title at its bottom left");
    expect(pivotLabel([{ name: "a" }, { name: "b" }], { kind: "selection", place: "centre" }, true)).toBe("Put the pivot of 2 items at its centre of the selection");
    expect(pivotLabel([{ name: "Title" }], { kind: "reset" }, false)).toBe("Put the pivot of Title back at its origin, the picture moving with it");
    expect(pivotLabel([{ name: "Title" }], { kind: "nudge", dx: 1, dy: -2 }, true)).toBe("Nudged the pivot of Title by 1, -2");
    expect(pivotLabel([{ name: "Title" }], { kind: "point", x: 3 }, true)).toBe("Put the pivot of Title at 3, its y");
  });
});

describe("where an object stands through its groups (effectivePlacement)", () => {
  const obj = (id: string, extra: Record<string, unknown> = {}): SceneObject =>
    ({ id, name: id, type: "rect", x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, width: 10, height: 10, locked: false, visible: true, opacity: 1, ...extra }) as unknown as SceneObject;
  const doc = (...objects: SceneObject[]): SceneDocument => ({ canvas: { width: 1920, height: 1080 }, objects }) as unknown as SceneDocument;

  it("is the object's own place when it is in no group", () => {
    expect(effectivePlacement(doc(obj("a", { x: 5, y: 6, rotation: 20, scaleX: 2 })), obj("a", { x: 5, y: 6, rotation: 20, scaleX: 2 }))).toEqual({
      x: 5, y: 6, rotation: 20, scaleX: 2, scaleY: 1, anchorX: 0, anchorY: 0,
    });
  });

  it("carries the origin through each ancestor, adds the rotations and multiplies the scales, as resolve_hierarchy does", () => {
    // Outer at (100,50), turned 90 and doubled; inner at (10,0) in it; the shape at (5,0) in the inner.
    const outer = obj("outer", { type: "group", childIds: ["inner"], x: 100, y: 50, rotation: 90, scaleX: 2, scaleY: 2 });
    const inner = obj("inner", { type: "group", childIds: ["s"], x: 10, y: 0 });
    const s = obj("s", { x: 5, y: 0, rotation: 15, anchor: { x: 1, y: 2 } });
    const placed = effectivePlacement(doc(outer, inner, s), s);
    // inner's origin: outer(10,0) = (100,50) + R90 * 2 * (10,0) = (100, 70); then the shape (5,0) under both:
    // R90 * 2 * (10 + 5, 0) = (0, 30) from (100,50) => (100, 80).
    expect(placed.x).toBeCloseTo(100, 9);
    expect(placed.y).toBeCloseTo(80, 9);
    expect(placed.rotation).toBe(105);
    expect(placed.scaleX).toBe(2);
    expect(placed.anchorX).toBe(1);
    expect(placed.anchorY).toBe(2);
  });
});

import fixture from "../../Shared/contracts/fixtures/effective-placement.json";

describe("effectivePlacement against the engine's resolve_hierarchy", () => {
  it("gives the position, rotation and scale the engine resolves, for every object of a scene of nested groups", () => {
    const document = { canvas: { width: 1920, height: 1080 }, objects: fixture.objects } as unknown as SceneDocument;
    expect(fixture.effective.length).toBeGreaterThanOrEqual(7);
    for (const expected of fixture.effective) {
      const object = document.objects.find((candidate) => candidate.id === expected.id)!;
      const got = effectivePlacement(document, object);
      expect(got.x, `${expected.id} x`).toBeCloseTo(expected.x, 9);
      expect(got.y, `${expected.id} y`).toBeCloseTo(expected.y, 9);
      expect(got.rotation, `${expected.id} rotation`).toBeCloseTo(expected.rotation, 9);
      expect(got.scaleX, `${expected.id} scaleX`).toBeCloseTo(expected.scaleX, 9);
      expect(got.scaleY, `${expected.id} scaleY`).toBeCloseTo(expected.scaleY, 9);
      expect(got.anchorX).toBe(expected.anchorX);
      expect(got.anchorY).toBe(expected.anchorY);
    }
  });
});
