import assert from "node:assert/strict";
import test from "node:test";
import {
  flattenBezierPath,
  flattenedPathLength,
  trimFlattenedPath,
  trimPathsActive
} from "../dist/index.js";

/**
 * The one trim definition both renderers cut with.
 *
 * `trimFlattenedPath` here and `trim_flattened_path` in `services/render-daemon` are two
 * implementations of one specification, like `resolveTextureFit`/`resolve_texture_fit`: the
 * Editor viewport and Program must cut a curve at the same arc length, or a trim that
 * previews a 50% wipe airs as a 60% one. These tests pin the semantics that are easy to get
 * subtly different: percent-of-length windows, seam wrapping on closed paths, the inverted
 * (start > end) complement, and the zero-width window that must draw nothing rather than a dot.
 */

// A 100-unit square, closed: perimeter 400, so 25% of length is exactly one side.
const SQUARE = {
  closed: true,
  vertices: [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 100 },
    { x: 0, y: 100 }
  ],
  inTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
  outTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]
};

// A 100-unit straight run, open: length 100.
const LINE = {
  closed: false,
  vertices: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }],
  inTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
  outTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]
};

test("an untrimmed path reports inactive, so renderers take the cheap path", () => {
  assert.equal(trimPathsActive(undefined, undefined, undefined), false);
  assert.equal(trimPathsActive(0, 100, 0), false);
  assert.equal(trimPathsActive(0, 100, 200), false); // offset is periodic
  assert.equal(trimPathsActive(10, 100, 0), true);
  assert.equal(trimPathsActive(0, 90, 0), true);
  assert.equal(trimPathsActive(0, 100, 25), true);
});

test("a straight open path cuts at exact percentages of its length", () => {
  const flat = flattenBezierPath(LINE);
  assert.ok(Math.abs(flattenedPathLength(flat, false) - 100) < 1e-9);

  const [firstHalf] = trimFlattenedPath(flat, false, 0, 50, 0);
  assert.ok(Math.abs(firstHalf[0].x - 0) < 1e-9);
  assert.ok(Math.abs(firstHalf.at(-1).x - 50) < 1e-9);

  const [secondHalf] = trimFlattenedPath(flat, false, 50, 100, 0);
  assert.ok(Math.abs(secondHalf[0].x - 50) < 1e-9);
  assert.ok(Math.abs(secondHalf.at(-1).x - 100) < 1e-9);
});

test("a zero-width window returns no pieces — an authored blank, not a dot", () => {
  const flat = flattenBezierPath(LINE);
  assert.deepEqual(trimFlattenedPath(flat, false, 50, 50, 0), []);
  assert.deepEqual(trimFlattenedPath(flat, false, 100, 100, 0), []);
});

test("a closed path's window wraps the seam as one piece after rotation", () => {
  const flat = flattenBezierPath(SQUARE);
  // 12.5% either side of the seam: starts halfway up the left side, ends halfway
  // along the top. Without rotation this is two fragments; with offset it is one window.
  const pieces = trimFlattenedPath(flat, true, 87.5, 12.5, 0);
  assert.equal(pieces.length, 2, "the inverted-by-wrap case splits at the seam");

  const rotated = trimFlattenedPath(flat, true, 0, 25, 87.5);
  assert.equal(rotated.length, 1, "offset rotates the window into one piece");
});

test("start > end inverts: the result is the complement, as two pieces", () => {
  const flat = flattenBezierPath(LINE);
  const pieces = trimFlattenedPath(flat, false, 75, 25, 0);
  assert.equal(pieces.length, 2);
  assert.ok(Math.abs(pieces[0].at(-1).x - 25) < 1e-9, "head ends at the window start");
  assert.ok(Math.abs(pieces[1][0].x - 75) < 1e-9, "tail starts at the window end");
});

test("a curve flattens within tolerance, so both renderers measure the same length", () => {
  // A quarter-circle-ish bulge: control points pushed out. The flattened length must be
  // between the chord (straight-line distance) and the control polygon (the longest a
  // bezier can be), or the trim cut lands somewhere neither renderer intended.
  const curve = {
    closed: false,
    vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    inTangents: [{ x: 0, y: 0 }, { x: 0, y: -100 }],
    outTangents: [{ x: 0, y: -100 }, { x: 0, y: 0 }]
  };
  const flat = flattenBezierPath(curve);
  const length = flattenedPathLength(flat, false);
  const chord = 100;
  const controlPolygon = 100 * Math.SQRT2 + 100;
  assert.ok(length > chord, `flattened length ${length} must exceed the chord ${chord}`);
  assert.ok(length < controlPolygon, `flattened length ${length} must stay under the control polygon ${controlPolygon}`);
});
