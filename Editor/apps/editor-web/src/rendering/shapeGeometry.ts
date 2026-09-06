/**
 * Turning an authored shape into geometry a renderer can fill.
 *
 * Separate from `GpuSceneRenderer` because it is pure geometry: no application, no canvas, no DOM.
 * That makes the part most easily got wrong — a compound path's holes — assertable without a GPU.
 */

import { GraphicsPath } from "pixi.js";
import {
  flattenBezierPath,
  trimFlattenedPath,
  trimPathsActive,
  type BezierPath,
  type SceneObject
} from "@grapix/shared-types";

type ShapeObject = Extract<SceneObject, { type: "shape" }>;

/** Every subpath a shape draws with, primary path first. */
export function shapeSubpaths(shape: Pick<ShapeObject, "path" | "compoundPaths">): BezierPath[] {
  return [shape.path, ...(shape.compoundPaths ?? [])].filter(
    (path): path is BezierPath => (path?.vertices.length ?? 0) > 0
  );
}

/**
 * One path object holding every subpath, with hole detection enabled.
 *
 * A compound path is a single shape: the letter O is an outer ring and an inner one, and an imported
 * logo can be fifty pieces. Drawing only the primary path — which is what happened before — silently
 * dropped every counter and every extra piece, so a vector arrived recognisably wrong.
 *
 * `checkForHoles` is what makes Pixi treat a subpath enclosed by another as a hole instead of
 * painting over it, and it is only consulted for a path added whole. Hence a `GraphicsPath` built
 * here and handed to `graphics.path()`, rather than instructions drawn straight into the context.
 *
 * The remaining imprecision is declared fill rules: Pixi decides holes geometrically, so an
 * even-odd path whose subpaths overlap without enclosing each other is not reproduced exactly. Every
 * shape a design tool exports for a letter, a ring or an icon does enclose, which is the case that
 * matters here.
 */
export function compoundGraphicsPath(shape: Pick<ShapeObject, "path" | "compoundPaths">): GraphicsPath {
  const compound = new GraphicsPath(undefined, true);

  for (const subpath of shapeSubpaths(shape)) {
    const { vertices, inTangents, outTangents, closed } = subpath;
    const count = vertices.length;
    if (count === 0) continue;

    compound.moveTo(vertices[0].x, vertices[0].y);
    const segments = closed ? count : count - 1;
    for (let index = 0; index < segments; index += 1) {
      const from = vertices[index];
      const to = vertices[(index + 1) % count];
      const out = outTangents[index] ?? { x: 0, y: 0 };
      const inn = inTangents[(index + 1) % count] ?? { x: 0, y: 0 };
      // Cubic bezier from `from` to `to`, with the tangents stored relative to their anchors.
      compound.bezierCurveTo(from.x + out.x, from.y + out.y, to.x + inn.x, to.y + inn.y, to.x, to.y);
    }
    if (closed) compound.closePath();
  }

  return compound;
}

/** How many anchors the shape will actually draw, across every subpath. */
export function shapeVertexCount(shape: Pick<ShapeObject, "path" | "compoundPaths">): number {
  return shapeSubpaths(shape).reduce((total, subpath) => total + subpath.vertices.length, 0);
}

/**
 * Whether a shape draws its stroke through a Trim Paths window.
 *
 * Exported so the renderer can split the fill (always the full region) from the stroke (the
 * trimmed window) without re-deriving the condition.
 */
export function shapeTrimActive(
  shape: Pick<ShapeObject, "trimStart" | "trimEnd" | "trimOffset">
): boolean {
  return trimPathsActive(shape.trimStart, shape.trimEnd, shape.trimOffset);
}

/**
 * The stroke geometry of a shape with Trim Paths applied: one open polyline per drawable
 * piece, per subpath. The trim is stroke-only by design (AE behaviour), so the fill never
 * consults this. Arc lengths come from the same flattening the native engine uses, so the
 * viewport and Program cut a curve at the same point.
 */
export function trimmedStrokePolylines(
  shape: Pick<ShapeObject, "path" | "compoundPaths" | "trimStart" | "trimEnd" | "trimOffset">
): { x: number; y: number }[][] {
  const start = shape.trimStart ?? 0;
  const end = shape.trimEnd ?? 100;
  const offset = shape.trimOffset ?? 0;
  const pieces: { x: number; y: number }[][] = [];
  for (const subpath of shapeSubpaths(shape)) {
    const flattened = flattenBezierPath(subpath);
    pieces.push(...trimFlattenedPath(flattened, subpath.closed, start, end, offset));
  }
  return pieces;
}
