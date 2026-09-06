import type { BezierPath, Vec2 } from "@grapix/shared-types";

/**
 * Path editing geometry: hit-testing a path, splitting a segment, and converting an anchor
 * between a corner and a tangent point.
 *
 * All of it is object-local and pure, so the pen tool, the Direct Selection tool and the
 * Inspector share one definition of what "add a point here" means instead of three.
 *
 * The important property is that **inserting an anchor must not move the curve**. The previous
 * "Add point" button inserted the midpoint of two *vertices* with zero handles, which on a curved
 * segment pulled the path towards a straight line — the operator asked for an extra handle and
 * got a different shape. Subdividing with de Casteljau gives the same curve with one more anchor,
 * which is what every design tool does and what makes the button safe to press.
 */

/** Segments in a path. A closed path has one per vertex; an open path has one fewer. */
export function segmentCount(path: BezierPath): number {
  const count = path.vertices.length;
  if (count < 2) return 0;
  return path.closed ? count : count - 1;
}

/** The vertex indices a segment runs between. */
export function segmentEnds(path: BezierPath, segmentIndex: number): { from: number; to: number } {
  const count = path.vertices.length;
  return { from: segmentIndex, to: (segmentIndex + 1) % count };
}

/** A segment's four cubic control points, in absolute object-local coordinates. */
export function segmentControlPoints(
  path: BezierPath,
  segmentIndex: number
): [Vec2, Vec2, Vec2, Vec2] {
  const { from, to } = segmentEnds(path, segmentIndex);
  const start = path.vertices[from];
  const end = path.vertices[to];
  const out = path.outTangents[from] ?? ZERO;
  const inn = path.inTangents[to] ?? ZERO;
  return [
    start,
    { x: start.x + out.x, y: start.y + out.y },
    { x: end.x + inn.x, y: end.y + inn.y },
    end
  ];
}

export function cubicAt(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y
  };
}

export interface PathHit {
  segmentIndex: number;
  /** Parameter along the segment, 0 at its start vertex and 1 at its end. */
  t: number;
  point: Vec2;
  distance: number;
}

/**
 * The closest point on the path to `point`.
 *
 * Sampled rather than solved: the exact answer needs the roots of a quintic, and the caller is
 * deciding whether a click landed on a line a few pixels wide. Sampling then refining around the
 * best sample is accurate well past that and cannot fail to converge.
 */
export function nearestPointOnPath(
  path: BezierPath,
  point: Vec2,
  samplesPerSegment = 24
): PathHit | null {
  let best: PathHit | null = null;

  for (let segment = 0; segment < segmentCount(path); segment += 1) {
    const [p0, p1, p2, p3] = segmentControlPoints(path, segment);
    for (let step = 0; step <= samplesPerSegment; step += 1) {
      const t = step / samplesPerSegment;
      const candidate = cubicAt(p0, p1, p2, p3, t);
      const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
      if (!best || distance < best.distance) {
        best = { segmentIndex: segment, t, point: candidate, distance };
      }
    }
  }

  if (!best) return null;

  // Refine around the best sample by repeated bisection of a shrinking window.
  let refined: PathHit = best;
  const [p0, p1, p2, p3] = segmentControlPoints(path, refined.segmentIndex);
  let window = 1 / samplesPerSegment;
  for (let pass = 0; pass < 12; pass += 1) {
    const candidates: number[] = [refined.t - window, refined.t + window];
    for (const t of candidates) {
      if (t < 0 || t > 1) continue;
      const candidate = cubicAt(p0, p1, p2, p3, t);
      const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
      if (distance < refined.distance) {
        refined = { segmentIndex: refined.segmentIndex, t, point: candidate, distance };
      }
    }
    window /= 2;
  }

  return refined;
}

/** The index of an anchor within `tolerance` of `point`, nearest first, or null. */
export function anchorAt(path: BezierPath, point: Vec2, tolerance: number): number | null {
  let bestIndex: number | null = null;
  let bestDistance = tolerance;

  path.vertices.forEach((vertex, index) => {
    const distance = Math.hypot(vertex.x - point.x, vertex.y - point.y);
    if (distance <= bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });

  return bestIndex;
}

/**
 * Insert an anchor partway along a segment, leaving the drawn curve identical.
 *
 * de Casteljau: subdividing at `t` yields two cubics whose union is the original curve, so the
 * three handles it touches — the start vertex's outgoing, the end vertex's incoming, and both of
 * the new anchor's — are all determined by the split rather than chosen.
 */
export function insertAnchorOnSegment(
  path: BezierPath,
  segmentIndex: number,
  t: number
): { path: BezierPath; index: number } {
  const clamped = Math.min(1, Math.max(0, t));
  const { from, to } = segmentEnds(path, segmentIndex);
  const [p0, p1, p2, p3] = segmentControlPoints(path, segmentIndex);

  const a = lerp(p0, p1, clamped);
  const b = lerp(p1, p2, clamped);
  const c = lerp(p2, p3, clamped);
  const d = lerp(a, b, clamped);
  const e = lerp(b, c, clamped);
  const anchor = lerp(d, e, clamped);

  const index = from + 1;
  const vertices = [...path.vertices];
  const inTangents = [...path.inTangents];
  const outTangents = [...path.outTangents];

  // The two neighbours keep their far handles and give up their near ones to the split.
  outTangents[from] = subtract(a, p0);
  inTangents[to] = subtract(c, p3);

  vertices.splice(index, 0, anchor);
  inTangents.splice(index, 0, subtract(d, anchor));
  outTangents.splice(index, 0, subtract(e, anchor));

  return { path: { ...path, vertices, inTangents, outTangents }, index };
}

/**
 * What kind of anchor this is.
 *
 * `corner` has no handles at all. `smooth` has handles that leave in exactly opposite directions,
 * which is what makes the curve continuous through the anchor. `broken` has handles that do not
 * line up — legal, frequently wanted, and the reason this is a three-way answer rather than a
 * boolean: converting a broken anchor to a corner throws away work, so a caller that only knew
 * "not smooth" would do it silently.
 */
export type AnchorKind = "corner" | "smooth" | "broken";

export function anchorKind(path: BezierPath, index: number): AnchorKind {
  const inn = path.inTangents[index] ?? ZERO;
  const out = path.outTangents[index] ?? ZERO;
  const inLength = Math.hypot(inn.x, inn.y);
  const outLength = Math.hypot(out.x, out.y);

  if (inLength < EPSILON && outLength < EPSILON) return "corner";
  // One handle present is still a tangent point in every design tool: an end anchor of an open
  // path has only one side to be continuous with.
  if (inLength < EPSILON || outLength < EPSILON) return "smooth";

  const cross = inn.x * out.y - inn.y * out.x;
  const dot = inn.x * out.x + inn.y * out.y;
  const collinear = Math.abs(cross) <= COLLINEAR_TOLERANCE * inLength * outLength;
  return collinear && dot < 0 ? "smooth" : "broken";
}

/**
 * Handles that make the anchor continuous, derived from its neighbours.
 *
 * The direction is the chord between the two neighbouring anchors and each handle is a third of
 * the distance to its own neighbour — the standard Catmull-Rom-ish construction, and the same one
 * the store already used, kept here so the pen and the buttons cannot drift apart.
 */
export function smoothHandlesFor(
  path: BezierPath,
  index: number
): { inTangent: Vec2; outTangent: Vec2 } {
  const count = path.vertices.length;
  const point = path.vertices[index];
  const previous = path.vertices[index === 0 ? (path.closed ? count - 1 : 0) : index - 1];
  const next = path.vertices[index === count - 1 ? (path.closed ? 0 : count - 1) : index + 1];
  const dx = next.x - previous.x;
  const dy = next.y - previous.y;
  const length = Math.max(0.0001, Math.hypot(dx, dy));
  const inLength = Math.hypot(point.x - previous.x, point.y - previous.y) / 3;
  const outLength = Math.hypot(next.x - point.x, next.y - point.y) / 3;
  return {
    inTangent: { x: (-dx / length) * inLength, y: (-dy / length) * inLength },
    outTangent: { x: (dx / length) * outLength, y: (dy / length) * outLength }
  };
}

/**
 * Convert one anchor to a corner or a tangent point.
 *
 * Converting to `smooth` keeps the handles the anchor already has when they only need
 * straightening — the longer side sets the direction and the shorter one is mirrored onto it — so
 * a broken anchor becomes smooth without the curve jumping to a shape derived from its
 * neighbours. Only an anchor with no handles at all is given new ones.
 */
export function setAnchorKind(path: BezierPath, index: number, kind: "corner" | "smooth"): BezierPath {
  if (index < 0 || index >= path.vertices.length) return path;

  const inTangents = [...path.inTangents];
  const outTangents = [...path.outTangents];

  if (kind === "corner") {
    inTangents[index] = { x: 0, y: 0 };
    outTangents[index] = { x: 0, y: 0 };
    return { ...path, inTangents, outTangents };
  }

  const inn = inTangents[index] ?? ZERO;
  const out = outTangents[index] ?? ZERO;
  const inLength = Math.hypot(inn.x, inn.y);
  const outLength = Math.hypot(out.x, out.y);

  if (inLength < EPSILON && outLength < EPSILON) {
    const derived = smoothHandlesFor(path, index);
    inTangents[index] = derived.inTangent;
    outTangents[index] = derived.outTangent;
    return { ...path, inTangents, outTangents };
  }

  // Straighten: the longer handle keeps its direction, the other is mirrored onto it at its own
  // length. Preserving each length is what stops the curve changing weight as well as direction.
  const leader = outLength >= inLength ? out : { x: -inn.x, y: -inn.y };
  const leaderLength = Math.max(EPSILON, Math.hypot(leader.x, leader.y));
  const unit = { x: leader.x / leaderLength, y: leader.y / leaderLength };

  outTangents[index] = { x: unit.x * outLength, y: unit.y * outLength };
  inTangents[index] = { x: -unit.x * inLength, y: -unit.y * inLength };
  return { ...path, inTangents, outTangents };
}

/** Corner becomes a tangent point and anything with handles becomes a corner. */
export function toggleAnchorKind(path: BezierPath, index: number): BezierPath {
  return setAnchorKind(path, index, anchorKind(path, index) === "corner" ? "smooth" : "corner");
}

/**
 * Move one handle, mirroring the opposite one when the anchor is a tangent point.
 *
 * This is the behaviour the "Link handles" button claimed to provide and never did: linkage was
 * never stored anywhere, and Direct Selection dragged every handle independently, so a smooth
 * anchor silently broke the moment it was touched. Deriving linkage from the anchor's *current*
 * geometry needs no new contract field and cannot go stale — a smooth anchor stays smooth, a
 * broken one stays broken.
 */
export function moveAnchorHandle(
  path: BezierPath,
  index: number,
  side: "in" | "out",
  handle: Vec2
): BezierPath {
  const inTangents = [...path.inTangents];
  const outTangents = [...path.outTangents];
  const wasSmooth = anchorKind(path, index) === "smooth";

  if (side === "in") inTangents[index] = handle;
  else outTangents[index] = handle;

  if (wasSmooth) {
    const opposite = side === "in" ? outTangents[index] ?? ZERO : inTangents[index] ?? ZERO;
    const oppositeLength = Math.hypot(opposite.x, opposite.y);
    const length = Math.hypot(handle.x, handle.y);
    if (oppositeLength >= EPSILON && length >= EPSILON) {
      // Mirror the direction, keep the opposite handle's own length.
      const unit = { x: -handle.x / length, y: -handle.y / length };
      const mirrored = { x: unit.x * oppositeLength, y: unit.y * oppositeLength };
      if (side === "in") outTangents[index] = mirrored;
      else inTangents[index] = mirrored;
    }
  }

  return { ...path, inTangents, outTangents };
}

const ZERO: Vec2 = { x: 0, y: 0 };
const EPSILON = 1e-6;
/** Sine of the angle two handles may differ by and still count as one straight tangent. */
const COLLINEAR_TOLERANCE = 1e-3;

function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function subtract(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}
