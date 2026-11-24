// What the Pivot panel shows (11.103): the pivot of the selection, and the place on the box it is on.
import { describe, expect, it } from "vitest";
import type { SceneDocument, SceneObject } from "@grapix/contracts";
import { pivotView } from "../src/pivot-panel";

function rect(id: string, extra: Record<string, unknown> = {}): SceneObject {
  return {
    type: "rect", id, name: id, visible: true, locked: false, opacity: 1, x: 0, y: 0, zDepth: 0, zIndex: 0, layerId: "",
    width: 100, height: 40, rotation: 0, rotationX: 0, rotationY: 0, scaleX: 1, scaleY: 1, scaleZ: 1, strokeWidth: 0, radius: 0,
    ...extra,
  } as unknown as SceneObject;
}
const scene = (objects: SceneObject[]): SceneDocument => ({ objects, timeline: { channels: [], phases: [], pathChannels: [] }, canvas: { width: 1920, height: 1080 } }) as unknown as SceneDocument;

describe("the pivot panel's view", () => {
  it("has nothing to show with nothing selected", () => {
    expect(pivotView(scene([rect("a")]), [])).toEqual({ kind: "none", summary: "" });
    expect(pivotView(scene([rect("a")]), ["gone"]).kind).toBe("none");
  });

  it("says where one object's pivot is, and which place on the box that is", () => {
    const origin = pivotView(scene([rect("a")]), ["a"]);
    expect(origin).toEqual({ kind: "one", summary: "a: pivot x 0, y 0 (top left)", x: 0, y: 0, place: "top-left" });
    const middle = pivotView(scene([rect("a", { anchor: { x: 50, y: 20 } })]), ["a"]);
    expect(middle).toMatchObject({ x: 50, y: 20, place: "centre", summary: "a: pivot x 50, y 20 (centre)" });
    const corner = pivotView(scene([rect("a", { anchor: { x: 100, y: 40 } })]), ["a"]);
    expect(corner.place).toBe("bottom-right");
  });

  it("names no place when the pivot is between them", () => {
    const view = pivotView(scene([rect("a", { anchor: { x: 30, y: 7 } })]), ["a"]);
    expect(view.place).toBeUndefined();
    expect(view.summary).toBe("a: pivot x 30, y 7");
  });

  it("counts a pivot on a place within a hundredth of a pixel, and no further", () => {
    expect(pivotView(scene([rect("a", { anchor: { x: 50.005, y: 20 } })]), ["a"]).place).toBe("centre");
    expect(pivotView(scene([rect("a", { anchor: { x: 50.5, y: 20 } })]), ["a"]).place).toBeUndefined();
  });

  it("gives no place for an object with no box", () => {
    expect(pivotView(scene([rect("a", { width: 0, anchor: { x: 0, y: 0 } })]), ["a"]).place).toBeUndefined();
  });

  it("shows what several objects agree on, and says where they differ", () => {
    const same = pivotView(scene([rect("a", { anchor: { x: 5, y: 5 } }), rect("b", { anchor: { x: 5, y: 5 } })]), ["a", "b"]);
    expect(same).toEqual({ kind: "many", summary: "2 items: pivot x 5, y 5", x: 5, y: 5 });
    const apart = pivotView(scene([rect("a", { anchor: { x: 5, y: 5 } }), rect("b", { anchor: { x: 9, y: 5 } })]), ["a", "b"]);
    expect(apart).toEqual({ kind: "many", summary: "2 items: pivot x differs, y 5", y: 5 });
    expect(apart.x).toBeUndefined();
  });

  it("shows y when the objects agree on it and differ on x, and the other way round", () => {
    const a = pivotView(scene([rect("a", { anchor: { x: 1, y: 5 } }), rect("b", { anchor: { x: 2, y: 5 } })]), ["a", "b"]);
    expect(a).toMatchObject({ y: 5, summary: "2 items: pivot x differs, y 5" });
    const b = pivotView(scene([rect("a", { anchor: { x: 1, y: 5 } }), rect("b", { anchor: { x: 1, y: 9 } })]), ["a", "b"]);
    expect(b).toMatchObject({ x: 1, summary: "2 items: pivot x 1, y differs" });
    expect(b.y).toBeUndefined();
  });

  it("reads the objects a selection acts on, not a child that is selected with its group", () => {
    const group = { ...rect("g"), type: "group", childIds: ["a"] } as unknown as SceneObject;
    const view = pivotView(scene([group, rect("a", { anchor: { x: 9, y: 9 } })]), ["g", "a"]);
    expect(view.kind).toBe("one");
    expect(view.summary).toBe("g: pivot x 0, y 0");
  });
});
