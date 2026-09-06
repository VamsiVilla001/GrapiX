import assert from "node:assert/strict";
import test from "node:test";
import { GraphicsPath } from "pixi.js";
import type { BezierPath, SceneObject } from "@grapix/shared-types";

import { compoundGraphicsPath, shapeSubpaths, shapeVertexCount } from "../src/rendering/shapeGeometry";
import { applyTextCase, hasTextDecoration } from "../src/rendering/textPresentation";

/**
 * What the renderer will actually draw, asserted without a GPU.
 *
 * Pixi's path and shape classes are plain geometry, so the two things reported wrong — a compound
 * path losing every subpath but the first, and text ignoring the case a designer applied — are both
 * checkable here, deterministically, instead of by looking at a screenshot.
 */

/** A closed rectangle as an authored bezier path: four corners, no handles. */
function rectangle(x: number, y: number, width: number, height: number): BezierPath {
  const vertices = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height }
  ];
  return {
    closed: true,
    vertices,
    inTangents: vertices.map(() => ({ x: 0, y: 0 })),
    outTangents: vertices.map(() => ({ x: 0, y: 0 }))
  };
}

function shape(path: BezierPath, compoundPaths?: BezierPath[]) {
  return { path, compoundPaths } as Pick<Extract<SceneObject, { type: "shape" }>, "path" | "compoundPaths">;
}

/** The shape primitives Pixi will fill, once the path is added the way the renderer adds it. */
function primitivesFor(target: Pick<Extract<SceneObject, { type: "shape" }>, "path" | "compoundPaths">) {
  const context = new GraphicsPath(undefined, true);
  context.addPath(compoundGraphicsPath(target));
  return context.shapePath.shapePrimitives;
}

test("a ring is one filled shape with a hole, not two stacked shapes", () => {
  const ring = shape(rectangle(0, 0, 200, 200), [rectangle(50, 50, 100, 100)]);

  const primitives = primitivesFor(ring);
  assert.equal(primitives.length, 1, "the inner subpath is not a shape of its own");
  assert.equal(primitives[0].holes?.length, 1, "it is a hole in the outer one");
});

test("every subpath of a compound path is drawn", () => {
  // Five separate squares side by side: none contains another, so none is a hole.
  const pieces = [1, 2, 3, 4].map((index) => rectangle(index * 300, 0, 100, 100));
  const logo = shape(rectangle(0, 0, 100, 100), pieces);

  assert.equal(shapeSubpaths(logo).length, 5);
  assert.equal(shapeVertexCount(logo), 20, "four corners each");
  assert.equal(primitivesFor(logo).length, 5, "all five pieces reach the renderer");
});

test("a shape with no compound paths is unchanged", () => {
  const plain = shape(rectangle(0, 0, 10, 10));
  assert.equal(shapeSubpaths(plain).length, 1);
  assert.equal(primitivesFor(plain).length, 1);
});

test("an empty subpath is skipped rather than breaking the path", () => {
  const empty: BezierPath = { closed: true, vertices: [], inTangents: [], outTangents: [] };
  const withEmpty = shape(rectangle(0, 0, 10, 10), [empty]);
  assert.equal(shapeSubpaths(withEmpty).length, 1);
  assert.equal(primitivesFor(withEmpty).length, 1);
});

test("curve handles reach the path as cubic control points", () => {
  // Two anchors with handles pulling right and left: a lens shape, not a straight line.
  const curved: BezierPath = {
    closed: true,
    vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    inTangents: [{ x: -20, y: 40 }, { x: 20, y: 40 }],
    outTangents: [{ x: 20, y: -40 }, { x: -20, y: -40 }]
  };

  const path = compoundGraphicsPath(shape(curved));
  const curves = path.instructions.filter((instruction) => instruction.action === "bezierCurveTo");
  assert.equal(curves.length, 2, "closed, so both segments are curves");

  // The first control point is the anchor plus its outgoing handle, in absolute coordinates.
  assert.deepEqual(curves[0].data.slice(0, 2), [20, -40]);
});

test("the case a designer applied is what gets drawn, from the characters as typed", () => {
  assert.equal(applyTextCase("mvp of the match", "upper"), "MVP OF THE MATCH");
  assert.equal(applyTextCase("MVP OF THE MATCH", "lower"), "mvp of the match");
  assert.equal(applyTextCase("day 2 - match 3", "title"), "Day 2 - Match 3");
  assert.equal(applyTextCase("mvp", "original"), "mvp");
  assert.equal(applyTextCase("mvp", undefined), "mvp", "no case set changes nothing");
});

test("title case leaves the rest of a word alone, so a team name survives", () => {
  // Upper-casing every word would give "Gg Vs T1"; upper-casing the whole string is worse.
  assert.equal(applyTextCase("GG vs T1", "title"), "GG Vs T1");
  assert.equal(applyTextCase('"quoted" (bracketed)', "title"), '"Quoted" (Bracketed)');
});

test("small caps is approximated as upper case rather than silently ignored", () => {
  // No browser text engine applies the feature without a font that carries it. Upper case is the
  // honest approximation; the alternative is text that reads lower case where a designer set caps.
  assert.equal(applyTextCase("mvp", "small-caps"), "MVP");
});

test("case applies to non-ASCII scripts through the locale rules", () => {
  assert.equal(applyTextCase("straße", "upper"), "STRASSE");
  assert.equal(applyTextCase("ÉQUIPE", "lower"), "équipe");
});

test("decoration is only drawn when the text carries some", () => {
  assert.equal(hasTextDecoration(undefined), false);
  assert.equal(hasTextDecoration({}), false);
  assert.equal(hasTextDecoration({ underline: false, strikethrough: false }), false);
  assert.equal(hasTextDecoration({ underline: true }), true);
  assert.equal(hasTextDecoration({ strikethrough: true }), true);
});
