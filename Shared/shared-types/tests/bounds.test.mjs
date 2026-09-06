import assert from "node:assert/strict";
import test from "node:test";
import {
  boundsContain,
  boundsEdges,
  boundsIntersect,
  objectBounds,
  selectionBounds,
  unionBounds
} from "../dist/index.js";

/**
 * The bounds contract is what makes an aligned graphic land in the same place in the Editor
 * preview and in Playout: alignment writes x/y into the scene and both renderers read it, so the
 * only thing that can disagree is where each side thinks the object's edges are.
 */
function object(patch = {}) {
  return {
    id: "object-1",
    name: "Quad 1",
    type: "rect",
    x: 100,
    y: 100,
    zDepth: 0,
    zIndex: 0,
    layerId: "main",
    width: 200,
    height: 100,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    fill: "#ffffff",
    stroke: "#000000",
    strokeWidth: 0,
    radius: 0,
    bindings: {},
    materialSlots: {},
    ...patch
  };
}

test("an untransformed object's bounds are its own box at its own position", () => {
  assert.deepEqual(objectBounds(object()), { x: 100, y: 100, width: 200, height: 100 });
});

test("scale grows the box about the anchor, not about the origin", () => {
  const scaled = objectBounds(object({ scaleX: 2, scaleY: 3 }));
  assert.deepEqual(scaled, { x: 100, y: 100, width: 400, height: 300 });

  // With the anchor at the centre the box grows both ways instead of down-right.
  const centred = objectBounds(object({ scaleX: 2, scaleY: 2, anchor: { x: 100, y: 50 } }));
  assert.deepEqual(centred, { x: -100, y: 0, width: 400, height: 200 });
});

test("rotation is measured on the transformed box, which is what the operator sees", () => {
  // A 200x100 quad turned 90 degrees occupies 100x200.
  const turned = objectBounds(object({ rotation: 90 }));
  assert.ok(Math.abs(turned.width - 100) < 1e-9, `width ${turned.width}`);
  assert.ok(Math.abs(turned.height - 200) < 1e-9, `height ${turned.height}`);

  // 45 degrees makes it wider than either side: (200+100)/sqrt(2).
  const diagonal = objectBounds(object({ rotation: 45 }));
  const expected = (200 + 100) / Math.SQRT2;
  assert.ok(Math.abs(diagonal.width - expected) < 1e-6, `width ${diagonal.width}`);
  assert.ok(Math.abs(diagonal.height - expected) < 1e-6, `height ${diagonal.height}`);
});

test("a stroke is centred on the outline, so half of it counts as visible", () => {
  const stroked = objectBounds(object({ strokeWidth: 10 }));
  assert.deepEqual(stroked, { x: 95, y: 95, width: 210, height: 110 });

  const layoutBox = objectBounds(object({ strokeWidth: 10 }), { includeStroke: false });
  assert.deepEqual(layoutBox, { x: 100, y: 100, width: 200, height: 100 });
});

test("text is not grown by its stroke, which outlines glyphs rather than the layout box", () => {
  const text = objectBounds(object({
    type: "text", text: "Hi", fontSize: 48, fontFamily: "Inter", fontWeight: "400",
    align: "left", strokeWidth: 12
  }));
  assert.deepEqual(text, { x: 100, y: 100, width: 200, height: 100 });
});

test("a shape is measured by its path, not by its declared width and height", () => {
  const shape = objectBounds(object({
    type: "shape",
    width: 10,
    height: 10,
    fillEnabled: true,
    strokeEnabled: false,
    fillRule: "nonzero",
    path: {
      closed: true,
      vertices: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 0, y: 40 }],
      inTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
      outTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]
    }
  }));
  assert.deepEqual(shape, { x: 100, y: 100, width: 60, height: 40 });
});

test("a line is measured by its points", () => {
  const line = objectBounds(object({
    type: "line",
    width: 999,
    height: 999,
    strokeWidth: 0,
    points: [{ x: 10, y: 5 }, { x: 40, y: 25 }]
  }));
  assert.deepEqual(line, { x: 110, y: 105, width: 30, height: 20 });
});

test("edges and centres come off the box", () => {
  const edges = boundsEdges({ x: 10, y: 20, width: 100, height: 50 });
  assert.equal(edges.left, 10);
  assert.equal(edges.right, 110);
  assert.equal(edges.top, 20);
  assert.equal(edges.bottom, 70);
  assert.equal(edges.centerX, 60);
  assert.equal(edges.centerY, 45);
});

test("a selection's box covers every member", () => {
  const combined = selectionBounds([
    object({ x: 0, y: 0, width: 50, height: 50 }),
    object({ x: 200, y: 100, width: 50, height: 50 })
  ]);
  assert.deepEqual(combined, { x: 0, y: 0, width: 250, height: 150 });
  assert.deepEqual(unionBounds([]), { x: 0, y: 0, width: 0, height: 0 });
});

test("intersection is for touch selection and containment for enclosed selection", () => {
  const marquee = { x: 0, y: 0, width: 100, height: 100 };
  const straddling = { x: 90, y: 90, width: 50, height: 50 };
  const inside = { x: 10, y: 10, width: 20, height: 20 };

  assert.equal(boundsIntersect(marquee, straddling), true);
  assert.equal(boundsContain(marquee, straddling), false, "a straddling object is not enclosed");
  assert.equal(boundsContain(marquee, inside), true);
  assert.equal(boundsIntersect(marquee, { x: 500, y: 500, width: 1, height: 1 }), false);
});

test("a group is measured by what it contains, not by its own decorative box", async () => {
  const { objectBoundsInScene } = await import("../dist/index.js");
  const child = object({ id: "child", x: 500, y: 400, width: 100, height: 100 });
  const group = object({
    id: "group", type: "group", x: 0, y: 0, width: 260, height: 170,
    strokeWidth: 0, childIds: ["child"]
  });
  const byId = new Map([[child.id, child], [group.id, group]]);

  assert.deepEqual(
    objectBoundsInScene(group, byId),
    { x: 500, y: 400, width: 100, height: 100 },
    "the group's own 260x170 box is decoration and must not be what aligns"
  );
});

test("an empty group still reports something, and a cycle cannot hang the caller", async () => {
  const { objectBoundsInScene } = await import("../dist/index.js");
  const empty = object({ id: "g", type: "group", x: 10, y: 20, width: 30, height: 40, strokeWidth: 0, childIds: [] });
  assert.deepEqual(objectBoundsInScene(empty, new Map([[empty.id, empty]])),
    { x: 10, y: 20, width: 30, height: 40 });

  const loop = object({ id: "a", type: "group", x: 0, y: 0, width: 5, height: 5, strokeWidth: 0, childIds: ["a"] });
  assert.ok(objectBoundsInScene(loop, new Map([[loop.id, loop]])));
});

/**
 * The selection box has to sit on the geometry, not on the layout box.
 *
 * `localBounds` is what the Editor's transform gizmo draws and what alignment measures, so these
 * pin the two ways it used to be wrong: a path whose geometry is nowhere near `width`/`height`,
 * and a curve whose control handles reach far outside the curve itself.
 */

/** A circle of radius 100 centred at (100,100), drawn the way a pen tool emits one. */
function circlePath() {
  const k = 0.5522847498307936 * 100; // the standard cubic circle constant × radius
  return {
    closed: true,
    vertices: [{ x: 100, y: 0 }, { x: 200, y: 100 }, { x: 100, y: 200 }, { x: 0, y: 100 }],
    outTangents: [{ x: k, y: 0 }, { x: 0, y: k }, { x: -k, y: 0 }, { x: 0, y: -k }],
    inTangents: [{ x: -k, y: 0 }, { x: 0, y: -k }, { x: k, y: 0 }, { x: 0, y: k }]
  };
}

test("a shape's local box is its path, not its width/height", async () => {
  const { localBounds } = await import("../dist/index.js");
  const shape = object({
    type: "shape",
    // Deliberately nothing like the geometry: this is the layout box the gizmo used to draw.
    width: 600,
    height: 400,
    strokeWidth: 0,
    strokeEnabled: false,
    fillEnabled: true,
    fillRule: "nonzero",
    path: {
      closed: false,
      vertices: [{ x: 40, y: 60 }, { x: 140, y: 260 }],
      inTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }],
      outTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }]
    }
  });

  assert.deepEqual(localBounds(shape), { x: 40, y: 60, width: 100, height: 200 });
});

test("a curve's box is the curve, not its control handles", async () => {
  const { localBounds } = await import("../dist/index.js");
  const shape = object({
    type: "shape",
    width: 200,
    height: 200,
    strokeWidth: 0,
    strokeEnabled: false,
    fillEnabled: true,
    fillRule: "nonzero",
    path: circlePath()
  });

  const box = localBounds(shape);
  // The true circle is exactly 200×200 at the origin. Taking the control polygon instead
  // reports ~110 to each side — the visible gap this test exists to prevent.
  assert.ok(Math.abs(box.x) < 0.01, `left edge ${box.x} must be 0`);
  assert.ok(Math.abs(box.y) < 0.01, `top edge ${box.y} must be 0`);
  assert.ok(Math.abs(box.width - 200) < 0.01, `width ${box.width} must be 200`);
  assert.ok(Math.abs(box.height - 200) < 0.01, `height ${box.height} must be 200`);
});

test("a stroked shape's box includes the half-stroke that is actually painted", async () => {
  const { localBounds } = await import("../dist/index.js");
  const shape = object({
    type: "shape",
    width: 10,
    height: 10,
    strokeWidth: 20,
    strokeEnabled: true,
    fillEnabled: false,
    fillRule: "nonzero",
    path: {
      closed: true,
      vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
      inTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
      outTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]
    }
  });

  assert.deepEqual(localBounds(shape), { x: -10, y: -10, width: 120, height: 120 });
  // Opting out gives the geometry alone, which is what a layout reference wants.
  assert.deepEqual(localBounds(shape, { includeStroke: false }), { x: 0, y: 0, width: 100, height: 100 });
});

test("a line's local box is its points", async () => {
  const { localBounds } = await import("../dist/index.js");
  const line = object({
    type: "line",
    width: 500,
    height: 500,
    strokeWidth: 0,
    points: [{ x: 20, y: 30 }, { x: 120, y: 30 }, { x: 70, y: 130 }]
  });
  assert.deepEqual(localBounds(line), { x: 20, y: 30, width: 100, height: 100 });
});
