// Snapping for the Pen and the path tools (11.110): what a point snaps to, the 7 and 11 pixel reach, the source named.
import { describe, expect, it } from "vitest";
import type { SceneDocument, SceneObject } from "@grapix/contracts";
import { SNAP_IN, SNAP_OUT, snapPoint, snapTargets, type SnapHold } from "../src/path-snap";
import { buildViewportOverlay } from "../src/overlay";

const z = { x: 0, y: 0 };
function rect(id: string, x: number, y: number, w: number, h: number): SceneObject {
  return { id, name: id, type: "rect", x, y, width: w, height: h, rotation: 0, scaleX: 1, scaleY: 1, locked: false, visible: true, opacity: 1 } as unknown as SceneObject;
}
function shape(id: string, x: number, y: number): SceneObject {
  const path = { closed: true, vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }], inTangents: [z, z, z], outTangents: [z, z, z] };
  return { id, name: id, type: "shape", x, y, width: 100, height: 50, rotation: 0, scaleX: 1, scaleY: 1, locked: false, visible: true, opacity: 1, path } as unknown as SceneObject;
}
const doc = (...objects: SceneObject[]): SceneDocument => ({ canvas: { width: 1920, height: 1080 }, objects }) as unknown as SceneDocument;
const none: SnapHold = {};

describe("what a point can snap to", () => {
  it("is the canvas edges and centre, the other layers' edges and centres, and the vertices of other shapes", () => {
    const targets = snapTargets(doc(rect("card", 200, 100, 300, 80), shape("star", 600, 400), rect("self", 10, 10, 10, 10)), new Set(["self"]));
    const xs = targets.x.map((t) => `${t.label}@${t.value}`);
    expect(xs).toContain("Canvas centre@960");
    expect(xs).toContain("Canvas edge@1920");
    expect(xs).toContain("card edge@200");
    expect(xs).toContain("card centre@350");
    expect(xs).toContain("star vertex@700");
    // The object being edited is not a target of itself.
    expect(xs.some((x) => x.startsWith("self"))).toBe(false);
    expect(targets.y.map((t) => `${t.label}@${t.value}`)).toContain("star vertex@450");
  });

  it("includes the points of the path being edited that are not moving", () => {
    const targets = snapTargets(doc(), new Set(), [{ x: 12, y: 34 }]);
    expect(targets.x.some((t) => t.label === "Vertex" && t.value === 12)).toBe(true);
    expect(targets.y.some((t) => t.label === "Vertex" && t.value === 34)).toBe(true);
  });
});

describe("snapping a point", () => {
  const targets = snapTargets(doc(rect("card", 200, 100, 300, 80)), new Set());

  it("is taken within 7 screen pixels on each axis alone, whatever the zoom", () => {
    // 1 canvas pixel per screen pixel: x 5 off the card edge snaps, y 50 away does not.
    const near = snapPoint({ x: 205, y: 400 }, targets, none, 1);
    expect(near.point).toEqual({ x: 200, y: 400 });
    expect(near.guides).toEqual([{ axis: "x", position: 200, label: "card edge" }]);
    // 8 pixels off does not.
    expect(snapPoint({ x: 208, y: 400 }, targets, none, 1).point).toEqual({ x: 208, y: 400 });
    // Zoomed in four times (0.25 canvas px per screen px): 8 canvas pixels is 32 screen pixels, so nothing; 1.5 snaps.
    expect(snapPoint({ x: 208, y: 400 }, targets, none, 0.25).point.x).toBe(208);
    expect(snapPoint({ x: 201.5, y: 400 }, targets, none, 0.25).point.x).toBe(200);
    // Zoomed out (4 canvas px per screen px): 20 canvas pixels is 5 screen pixels, so it snaps.
    expect(snapPoint({ x: 220, y: 400 }, targets, none, 4).point.x).toBe(200);
  });

  it("is held until the pointer is 11 screen pixels away, so it does not flicker", () => {
    const first = snapPoint({ x: 205, y: 90 }, targets, none, 1);
    expect(first.point.x).toBe(200);
    // 10 away: still held. 12 away: let go.
    expect(snapPoint({ x: 210, y: 90 }, targets, first.hold, 1).point.x).toBe(200);
    expect(snapPoint({ x: 212, y: 90 }, targets, first.hold, 1).point.x).toBe(212);
    expect(SNAP_IN).toBe(7);
    expect(SNAP_OUT).toBe(11);
  });

  it("takes the nearest target, a vertex before an edge on a tie, and names its source", () => {
    const t = snapTargets(doc(rect("card", 200, 100, 300, 80), shape("star", 200, 400)), new Set());
    const result = snapPoint({ x: 203, y: 403 }, t, none, 1);
    expect(result.point).toEqual({ x: 200, y: 400 });
    // x 200 is both the card's edge and the star's vertex: the vertex (lower priority number) is named.
    expect(result.guides.find((g) => g.axis === "x")!.label).toBe("star vertex");
  });

  it("does nothing when it is turned off, and lets go of what it held", () => {
    const held = snapPoint({ x: 205, y: 90 }, targets, none, 1);
    const off = snapPoint({ x: 205, y: 90 }, targets, held.hold, 1, true);
    expect(off).toEqual({ point: { x: 205, y: 90 }, hold: {}, guides: [] });
    expect(snapPoint({ x: 205, y: 90 }, targets, none, 0).point).toEqual({ x: 205, y: 90 });
  });
});

describe("snapping onto a curve of another shape (11.110, the spec's other segments)", () => {
  // `star` at (600, 400): its edges run (600,400)-(700,400), (700,400)-(700,450) and the closing diagonal (700,450)-(600,400).
  const world = doc(shape("star", 600, 400), shape("self", 0, 0));
  const targets = snapTargets(world, new Set(["self"]));

  it("lists the curves of the other shapes, not the one being edited", () => {
    expect(targets.curves?.map((c) => c.id)).toEqual(["star/0"]);
    expect(targets.curves?.[0]?.label).toBe("star curve");
    expect(targets.curves?.[0]?.cubics).toHaveLength(3);
  });

  it("snaps a point that is near a curve and on no line or vertex onto the nearest point of it, and names it", () => {
    // Near the diagonal, away from every vertex, edge and centre line.
    const result = snapPoint({ x: 620, y: 415 }, targets, none, 1);
    expect(result.hold.curve).toBe("star/0");
    expect(result.guides.map((g) => g.label)).toEqual(["star curve", "star curve"]);
    expect(Math.abs(result.point.y - 400 - (result.point.x - 600) / 2)).toBeLessThan(1e-6);
    // Its own distance to the diagonal is within the reach.
    expect(Math.hypot(result.point.x - 620, result.point.y - 415)).toBeLessThanOrEqual(SNAP_IN);
  });

  it("lets a line or a vertex win, holds the curve to 11 pixels and lets go past it, at any zoom", () => {
    // On the vertex x = 700: the axis snap wins and no curve is held.
    const onLine = snapPoint({ x: 702, y: 425 }, targets, none, 1);
    expect(onLine.hold.curve).toBeUndefined();
    expect(onLine.point.x).toBe(700);
    // Held (the lines taken away, so only the curve is in play): about 9 pixels from the diagonal is kept, 13 is let go.
    const curveOnly = { x: [], y: [], curves: targets.curves ?? [] };
    const first = snapPoint({ x: 630, y: 415 }, curveOnly, none, 1);
    expect(first.hold.curve).toBe("star/0");
    const kept = snapPoint({ x: 630 - 4.25, y: 415 + 8.5 }, curveOnly, first.hold, 1);
    expect(kept.hold.curve).toBe("star/0");
    expect(snapPoint({ x: 630 - 4.25, y: 415 + 8.5 }, curveOnly, none, 1).hold.curve).toBeUndefined();
    expect(snapPoint({ x: 630 - 6, y: 415 + 12 }, curveOnly, first.hold, 1).hold.curve).toBeUndefined();
    // At 2 canvas pixels per screen pixel the reach doubles in canvas pixels, so it is the same on screen.
    expect(snapPoint({ x: 630 - 4.25, y: 415 + 8.5 }, curveOnly, none, 2).hold.curve).toBe("star/0");
    expect(snapPoint({ x: 630 - 4.25, y: 415 + 8.5 }, curveOnly, none, 0.5).hold.curve).toBeUndefined();
    // Switched off, it does nothing.
    expect(snapPoint({ x: 620, y: 415 }, targets, none, 1, true).hold).toEqual({});
  });
});

describe("explicit guides (11.44)", () => {
  const withGuides = (...guides: { id: number; axis: "x" | "y"; position: number }[]): SceneDocument => ({ ...doc(rect("card", 200, 100, 300, 80)), guides }) as unknown as SceneDocument;

  it("are targets that outrank a generic line at the same distance, and are named", () => {
    // The card's left edge is at x = 200; a guide 3 pixels away on the other side is as near as a line two pixels off.
    const targets = snapTargets(withGuides({ id: 4, axis: "x", position: 203 }, { id: 5, axis: "y", position: 300 }), new Set());
    expect(targets.x.filter((t) => t.label === "Guide 4")).toEqual([{ value: 203, label: "Guide 4", priority: -1 }]);
    const tie = snapPoint({ x: 201.5, y: 300 }, targets, none, 1);
    expect(tie.point).toEqual({ x: 203, y: 300 });
    expect(tie.guides.map((g) => g.label)).toEqual(["Guide 4", "Guide 5"]);
    // Out of reach of everything, nothing snaps.
    expect(snapPoint({ x: 1300, y: 900 }, targets, none, 1).guides).toEqual([]);
  });

  it("are drawn by the overlay, dashed apart from a snap line, and hidden with the Show switch", () => {
    const model = buildViewportOverlay(withGuides({ id: 1, axis: "x", position: 960 }), { selectedIds: [] });
    const fixed = model.primitives.filter((p) => p.kind === "guide");
    expect(fixed).toHaveLength(1);
    expect(fixed[0]).toMatchObject({ guide: { axis: "x", position: 960, label: "Guide 1", fixed: true } });
    expect(buildViewportOverlay(withGuides({ id: 1, axis: "x", position: 960 }), { selectedIds: [], showGuides: false }).primitives.some((p) => p.kind === "guide")).toBe(false);
  });
});
