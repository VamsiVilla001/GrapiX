import assert from "node:assert/strict";
import test from "node:test";
import type { BezierPath } from "@grapix/shared-types";
import {
  anchorAt,
  anchorKind,
  cubicAt,
  insertAnchorOnSegment,
  moveAnchorHandle,
  nearestPointOnPath,
  segmentControlPoints,
  segmentCount,
  setAnchorKind,
  toggleAnchorKind
} from "../src/tools/bezierEditing";

/** A single curved segment that bulges well away from the chord between its ends. */
function curve(): BezierPath {
  return {
    closed: false,
    vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    inTangents: [{ x: 0, y: 0 }, { x: -30, y: -60 }],
    outTangents: [{ x: 30, y: -60 }, { x: 0, y: 0 }]
  };
}

function square(): BezierPath {
  const zero = { x: 0, y: 0 };
  return {
    closed: true,
    vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
    inTangents: [zero, zero, zero, zero],
    outTangents: [zero, zero, zero, zero]
  };
}

/** Sample a whole path densely so two paths can be compared as drawn curves. */
function samplePath(path: BezierPath, perSegment = 40): { x: number; y: number }[] {
  const points = [];
  for (let segment = 0; segment < segmentCount(path); segment += 1) {
    const [p0, p1, p2, p3] = segmentControlPoints(path, segment);
    for (let step = 0; step <= perSegment; step += 1) {
      points.push(cubicAt(p0, p1, p2, p3, step / perSegment));
    }
  }
  return points;
}

test("a closed path has one segment per vertex and an open path one fewer", () => {
  assert.equal(segmentCount(square()), 4);
  assert.equal(segmentCount(curve()), 1);
  assert.equal(segmentCount({ ...curve(), vertices: [{ x: 0, y: 0 }], inTangents: [], outTangents: [] }), 0);
});

test("inserting an anchor on a curve does not move the curve", () => {
  const before = samplePath(curve());
  const { path } = insertAnchorOnSegment(curve(), 0, 0.5);

  assert.equal(path.vertices.length, 3, "one anchor was added");
  assert.equal(path.inTangents.length, 3, "every array stays the same length");
  assert.equal(path.outTangents.length, 3);

  const after = samplePath(path, 20);
  // Every sample of the new path must lie on the old curve.
  for (const point of after) {
    const nearest = before.reduce(
      (best, candidate) => {
        const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
        return distance < best ? distance : best;
      },
      Number.POSITIVE_INFINITY
    );
    assert.ok(nearest < 0.5, `sample (${point.x}, ${point.y}) drifted ${nearest.toFixed(3)} off the original curve`);
  }
});

test("inserting at t splits where the curve actually is, not at the vertex midpoint", () => {
  const source = curve();
  const [p0, p1, p2, p3] = segmentControlPoints(source, 0);
  const expected = cubicAt(p0, p1, p2, p3, 0.5);
  const { path, index } = insertAnchorOnSegment(source, 0, 0.5);

  assert.equal(index, 1);
  assert.ok(Math.abs(path.vertices[1].x - expected.x) < 1e-9);
  assert.ok(Math.abs(path.vertices[1].y - expected.y) < 1e-9);
  // The old behaviour put it at the midpoint of the two vertices, which is nowhere near a curve
  // that bulges 45 units away.
  assert.ok(Math.abs(path.vertices[1].y - 0) > 30, "the anchor lands on the curve, not the chord");
});

test("inserting on a closed path's last segment wraps to the first vertex", () => {
  const { path, index } = insertAnchorOnSegment(square(), 3, 0.5);
  assert.equal(index, 4);
  assert.equal(path.vertices.length, 5);
  assert.deepEqual(path.vertices[4], { x: 0, y: 50 });
});

test("nearest point finds the segment and parameter a click landed on", () => {
  const hit = nearestPointOnPath(square(), { x: 50, y: 3 });
  assert.ok(hit);
  assert.equal(hit!.segmentIndex, 0);
  assert.ok(Math.abs(hit!.t - 0.5) < 0.05);
  assert.ok(hit!.distance < 3.01);
});

test("anchor hit testing respects the tolerance and picks the nearest", () => {
  assert.equal(anchorAt(square(), { x: 2, y: 2 }, 10), 0);
  assert.equal(anchorAt(square(), { x: 98, y: 4 }, 10), 1);
  assert.equal(anchorAt(square(), { x: 50, y: 50 }, 10), null, "the centre is not on any anchor");
});

test("an anchor reports corner, smooth or broken", () => {
  assert.equal(anchorKind(square(), 0), "corner");

  const smooth = setAnchorKind(square(), 1, "smooth");
  assert.equal(anchorKind(smooth, 1), "smooth");

  const broken: BezierPath = {
    ...square(),
    inTangents: [{ x: -10, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
    outTangents: [{ x: 0, y: 20 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]
  };
  assert.equal(anchorKind(broken, 0), "broken", "handles at a right angle are not one tangent");
});

test("converting a corner to a tangent point gives it handles, and back removes them", () => {
  const smooth = toggleAnchorKind(square(), 1);
  assert.equal(anchorKind(smooth, 1), "smooth");
  assert.ok(Math.hypot(smooth.outTangents[1].x, smooth.outTangents[1].y) > 0);

  const corner = toggleAnchorKind(smooth, 1);
  assert.equal(anchorKind(corner, 1), "corner");
  assert.deepEqual(corner.inTangents[1], { x: 0, y: 0 });
  assert.deepEqual(corner.outTangents[1], { x: 0, y: 0 });
});

test("straightening a broken anchor keeps each handle's own length", () => {
  const broken: BezierPath = {
    ...square(),
    inTangents: [{ x: -30, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
    outTangents: [{ x: 0, y: 10 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]
  };
  const smooth = setAnchorKind(broken, 0, "smooth");

  assert.equal(anchorKind(smooth, 0), "smooth");
  assert.ok(Math.abs(Math.hypot(smooth.inTangents[0].x, smooth.inTangents[0].y) - 30) < 1e-6);
  assert.ok(Math.abs(Math.hypot(smooth.outTangents[0].x, smooth.outTangents[0].y) - 10) < 1e-6);
});

test("dragging one handle of a tangent point mirrors the other, and a corner's does not", () => {
  const smooth = setAnchorKind(square(), 1, "smooth");
  const dragged = moveAnchorHandle(smooth, 1, "out", { x: 0, y: 40 });

  const inn = dragged.inTangents[1];
  assert.ok(inn.x < 1e-6 && inn.y < 0, "the opposite handle followed to stay antiparallel");
  assert.equal(anchorKind(dragged, 1), "smooth");

  const broken: BezierPath = {
    ...square(),
    inTangents: [{ x: -30, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
    outTangents: [{ x: 0, y: 10 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]
  };
  const independent = moveAnchorHandle(broken, 0, "out", { x: 5, y: 5 });
  assert.deepEqual(independent.inTangents[0], { x: -30, y: 0 }, "a broken anchor stays broken");
});
