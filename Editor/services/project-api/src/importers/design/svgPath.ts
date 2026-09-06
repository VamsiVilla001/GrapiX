import type { BezierPath, Vec2 } from "@grapix/shared-types";

const TOKEN = /[a-zA-Z]|[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi;

export function parseSvgPathData(data: string): BezierPath[] {
  const tokens = data.match(TOKEN) ?? [];
  const paths: BezierPath[] = [];
  let index = 0;
  let command = "";
  let current = { x: 0, y: 0 };
  let start = { x: 0, y: 0 };
  let lastControl: Vec2 | null = null;
  let path = emptyPath();

  const number = () => Number(tokens[index++]);
  const point = (relative: boolean): Vec2 => {
    const x = number();
    const y = number();
    return relative ? { x: current.x + x, y: current.y + y } : { x, y };
  };
  /**
   * Close off the subpath being built.
   *
   * A source almost always writes the closing segment explicitly and *then* closes — Figma emits
   * `M a … L a Z`, so the last anchor sits exactly on the first. Kept as written, every closed shape
   * gains a redundant anchor at the seam (116 of 117 paths in a real file), and when that last
   * segment is a curve its incoming handle lands on the duplicate instead of on the anchor the curve
   * actually arrives at — so the seam of a rounded shape is drawn straight.
   *
   * Merging the two is exact: the duplicate's incoming handle belongs to the first anchor, which is
   * the same point, and the segment between them has zero length.
   */
  const finish = (closed = false) => {
    if (!path.vertices.length) return;

    if (closed && path.vertices.length > 1) {
      const first = path.vertices[0];
      const last = path.vertices[path.vertices.length - 1];
      // A hair of tolerance: a source that has rounded its coordinates still means the same point.
      if (Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6) {
        path.inTangents[0] = path.inTangents[path.vertices.length - 1];
        path.vertices.pop();
        path.inTangents.pop();
        path.outTangents.pop();
      }
    }

    path.closed = closed;
    paths.push(path);
    path = emptyPath();
    lastControl = null;
  };
  const addAnchor = (anchor: Vec2, incoming: Vec2 = anchor, outgoing: Vec2 = anchor) => {
    path.vertices.push(anchor);
    path.inTangents.push({ x: incoming.x - anchor.x, y: incoming.y - anchor.y });
    path.outTangents.push({ x: outgoing.x - anchor.x, y: outgoing.y - anchor.y });
    current = anchor;
  };

  while (index < tokens.length) {
    if (/^[a-z]$/i.test(tokens[index])) command = tokens[index++];
    if (!command) break;
    const relative = command === command.toLowerCase();
    const upper = command.toUpperCase();

    if (upper === "M") {
      const next = point(relative);
      if (path.vertices.length) finish(false);
      addAnchor(next);
      start = next;
      command = relative ? "l" : "L";
    } else if (upper === "L") {
      addAnchor(point(relative));
      lastControl = null;
    } else if (upper === "H") {
      const value = number();
      addAnchor({ x: relative ? current.x + value : value, y: current.y });
      lastControl = null;
    } else if (upper === "V") {
      const value = number();
      addAnchor({ x: current.x, y: relative ? current.y + value : value });
      lastControl = null;
    } else if (upper === "C") {
      const control1 = point(relative);
      const control2 = point(relative);
      const anchor = point(relative);
      if (path.vertices.length) {
        const lastIndex = path.vertices.length - 1;
        path.outTangents[lastIndex] = {
          x: control1.x - path.vertices[lastIndex].x,
          y: control1.y - path.vertices[lastIndex].y
        };
      }
      addAnchor(anchor, control2);
      lastControl = control2;
    } else if (upper === "S") {
      const control1 = lastControl
        ? { x: current.x * 2 - lastControl.x, y: current.y * 2 - lastControl.y }
        : current;
      const control2 = point(relative);
      const anchor = point(relative);
      if (path.vertices.length) {
        const lastIndex = path.vertices.length - 1;
        path.outTangents[lastIndex] = {
          x: control1.x - path.vertices[lastIndex].x,
          y: control1.y - path.vertices[lastIndex].y
        };
      }
      addAnchor(anchor, control2);
      lastControl = control2;
    } else if (upper === "Q") {
      const quadratic = point(relative);
      const anchor = point(relative);
      const control1 = {
        x: current.x + (quadratic.x - current.x) * 2 / 3,
        y: current.y + (quadratic.y - current.y) * 2 / 3
      };
      const control2 = {
        x: anchor.x + (quadratic.x - anchor.x) * 2 / 3,
        y: anchor.y + (quadratic.y - anchor.y) * 2 / 3
      };
      const lastIndex = path.vertices.length - 1;
      if (lastIndex >= 0) {
        path.outTangents[lastIndex] = {
          x: control1.x - path.vertices[lastIndex].x,
          y: control1.y - path.vertices[lastIndex].y
        };
      }
      addAnchor(anchor, control2);
      lastControl = quadratic;
    } else if (upper === "T") {
      const quadratic: Vec2 = lastControl
        ? { x: current.x * 2 - lastControl.x, y: current.y * 2 - lastControl.y }
        : current;
      const anchor = point(relative);
      const control1 = {
        x: current.x + (quadratic.x - current.x) * 2 / 3,
        y: current.y + (quadratic.y - current.y) * 2 / 3
      };
      const control2 = {
        x: anchor.x + (quadratic.x - anchor.x) * 2 / 3,
        y: anchor.y + (quadratic.y - anchor.y) * 2 / 3
      };
      const lastIndex = path.vertices.length - 1;
      if (lastIndex >= 0) {
        path.outTangents[lastIndex] = {
          x: control1.x - path.vertices[lastIndex].x,
          y: control1.y - path.vertices[lastIndex].y
        };
      }
      addAnchor(anchor, control2);
      lastControl = quadratic;
    } else if (upper === "A") {
      // GrapiX stores cubic paths. Preserve the endpoint and let the compatibility
      // report identify that this SVG arc needs a future exact cubic conversion.
      number(); number(); number(); number(); number();
      addAnchor(point(relative));
      lastControl = null;
    } else if (upper === "Z") {
      current = start;
      finish(true);
      command = "";
    } else {
      break;
    }
  }
  finish(false);
  return paths;
}

export function rectanglePath(width: number, height: number): BezierPath {
  return {
    closed: true,
    vertices: [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }],
    inTangents: Array.from({ length: 4 }, () => ({ x: 0, y: 0 })),
    outTangents: Array.from({ length: 4 }, () => ({ x: 0, y: 0 }))
  };
}

/**
 * A rectangle with per-corner radii, as four cubic corners.
 *
 * The circular-arc constant: a quarter circle of radius r is approximated by a cubic whose
 * control points sit `r * (4/3)(sqrt(2) - 1)` along the tangents. Maximum radial error is about
 * 0.02% of r — far below a pixel at any radius a design uses, and the same approximation every
 * vector renderer makes.
 *
 * Used for clip rectangles: a rounded frame that clips its children must clip with its own
 * corners, or the artwork shows square shoulders exactly where a designer rounded them.
 */
export function roundedRectanglePath(
  width: number,
  height: number,
  radii: [number, number, number, number]
): BezierPath {
  // A radius wider than half the shorter side has no meaning; every design tool clamps it, and
  // an unclamped one produces a self-crossing outline.
  const limit = Math.min(width, height) / 2;
  const clamped = radii.map((radius) => Math.max(0, Math.min(Number.isFinite(radius) ? radius : 0, limit)));
  if (clamped.every((radius) => radius === 0)) return rectanglePath(width, height);

  const kappa = (4 / 3) * (Math.SQRT2 - 1);
  const vertices: Vec2[] = [];
  const inTangents: Vec2[] = [];
  const outTangents: Vec2[] = [];

  /**
   * One corner, clockwise from the top-left.
   *
   * A square corner is one anchor with no tangents. A rounded one is two: where the arc starts
   * and where it ends, so the straight edges between corners stay straight. `arrive`/`leave` are
   * unit directions of travel into and out of the corner.
   */
  const corner = (
    point: Vec2,
    radius: number,
    arrive: Vec2,
    leave: Vec2
  ) => {
    if (radius === 0) {
      vertices.push(point);
      inTangents.push({ x: 0, y: 0 });
      outTangents.push({ x: 0, y: 0 });
      return;
    }
    // Arc start: back along the direction of travel, leaving into the curve.
    vertices.push({ x: point.x - arrive.x * radius, y: point.y - arrive.y * radius });
    inTangents.push({ x: 0, y: 0 });
    outTangents.push({ x: arrive.x * radius * kappa, y: arrive.y * radius * kappa });
    // Arc end: forward along the outgoing direction, arriving from the curve.
    vertices.push({ x: point.x + leave.x * radius, y: point.y + leave.y * radius });
    inTangents.push({ x: -leave.x * radius * kappa, y: -leave.y * radius * kappa });
    outTangents.push({ x: 0, y: 0 });
  };

  const right = { x: 1, y: 0 };
  const down = { x: 0, y: 1 };
  const left = { x: -1, y: 0 };
  const up = { x: 0, y: -1 };

  // Clockwise from the top-left. Each corner is entered travelling in the direction of the edge
  // that arrives at it: the left edge runs upward into the top-left, the top edge runs right into
  // the top-right, and so on.
  corner({ x: 0, y: 0 }, clamped[0], up, right);
  corner({ x: width, y: 0 }, clamped[1], right, down);
  corner({ x: width, y: height }, clamped[2], down, left);
  corner({ x: 0, y: height }, clamped[3], left, up);

  return { closed: true, vertices, inTangents, outTangents };
}

function emptyPath(): BezierPath {
  return { closed: false, vertices: [], inTangents: [], outTangents: [] };
}
