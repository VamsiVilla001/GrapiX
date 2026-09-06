import type { BezierPath, SceneObject, Vec2 } from "./index.js";

/**
 * The visible, axis-aligned box an object occupies in scene space.
 *
 * This is the single definition of "where an object is" for anything that has to agree with what
 * gets drawn — alignment, distribution, snapping, marquee selection, selection handles — and it
 * lives in `Shared` for exactly that reason. The Editor aligns by writing `x`/`y` into the scene
 * document and both renderers read that document, so Editor and Playout agree about an aligned
 * graphic **iff** they agree about its bounds. A bounds function private to the Editor would make
 * that agreement a coincidence rather than a property.
 *
 * It implements the documented 2D transform, `T(x, y) · R(rotation) · S(scaleX, scaleY) ·
 * T(-anchor)`, and takes the *transformed* extent: rotating a wide, short quad by 45° makes its
 * axis-aligned box taller and narrower, and that box — not the object's own width and height — is
 * what an operator sees and expects to align.
 */

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Right and bottom edges plus the centre, which every alignment edge is expressed against. */
export interface BoundsEdges extends Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
  centerX: number;
  centerY: number;
}

export function boundsEdges(bounds: Bounds): BoundsEdges {
  return {
    ...bounds,
    left: bounds.x,
    right: bounds.x + bounds.width,
    top: bounds.y,
    bottom: bounds.y + bounds.height,
    centerX: bounds.x + bounds.width / 2,
    centerY: bounds.y + bounds.height / 2
  };
}

/**
 * The object's untransformed extent in its own local space, before rotation and scale.
 *
 * Most types are a `width` × `height` box anchored at their origin. The exceptions are the ones
 * whose geometry is not the box: a path can bulge outside it, and a line's points are the only
 * thing it draws. Using `width`/`height` for those would align a box the operator cannot see.
 */
export function localExtent(object: SceneObject): Bounds {
  if (object.type === "shape") {
    const paths = [object.path, ...(object.compoundPaths ?? [])];
    const merged = paths
      .map(pathExtent)
      .filter((extent): extent is Bounds => extent !== null)
      .reduce<Bounds | null>((total, extent) => (total ? unionBounds([total, extent]) : extent), null);
    if (merged) return merged;
  }

  if (object.type === "line" && object.points.length > 0) {
    return pointsExtent(object.points);
  }

  if (object.type === "paint") {
    const points = object.strokes.flatMap((stroke) => stroke.points);
    if (points.length > 0) {
      // Grow by the widest stroke's radius: a brush stroke is drawn around its centre line.
      const widest = Math.max(...object.strokes.map((stroke) => stroke.size), 0) / 2;
      return growBounds(pointsExtent(points), widest);
    }
  }

  return { x: 0, y: 0, width: object.width, height: object.height };
}

/**
 * The object's local box, optionally grown by the stroke it paints.
 *
 * This is the box drawn *inside* the object's own transform — the selection gizmo needs exactly
 * this, and so does `objectBounds` before it transforms the corners. Exported so the two cannot
 * drift: the gizmo previously drew `0,0,width,height`, which is not where a path, a line or a
 * paint layer actually is, and put the selection box off the geometry it belonged to.
 */
export function localBounds(
  object: SceneObject,
  options: { includeStroke?: boolean } = {}
): Bounds {
  return options.includeStroke === false
    ? localExtent(object)
    : growBounds(localExtent(object), strokeOutset(object));
}

/**
 * The bounds of one object in scene space.
 *
 * `includeStroke` grows the box by half the stroke width, because a stroke is centred on the
 * outline and so half of it sits outside the fill — which is what "align to the visible edge"
 * means for a stroked shape. It is optional because the *layout* box (what a designer typed into
 * width/height) is sometimes the intended reference instead.
 */
export function objectBounds(
  object: SceneObject,
  options: { includeStroke?: boolean } = {}
): Bounds {
  const local = localBounds(object, options);

  const anchor = object.anchor ?? { x: 0, y: 0 };
  const scaleX = object.scaleX ?? 1;
  const scaleY = object.scaleY ?? 1;
  const radians = ((object.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  // The four local corners, taken through S then R then translated to the anchor's world
  // position. Transforming all four and taking their extent is what makes the result correct for
  // a rotation: transforming only the origin and the size would keep the box axis-aligned in the
  // wrong space.
  const corners: Vec2[] = [
    { x: local.x, y: local.y },
    { x: local.x + local.width, y: local.y },
    { x: local.x + local.width, y: local.y + local.height },
    { x: local.x, y: local.y + local.height }
  ].map((corner) => {
    const sx = (corner.x - anchor.x) * scaleX;
    const sy = (corner.y - anchor.y) * scaleY;
    return {
      x: object.x + sx * cos - sy * sin,
      y: object.y + sx * sin + sy * cos
    };
  });

  return pointsExtent(corners);
}

/**
 * Bounds of an object, resolving a container to the extent of what it contains.
 *
 * A layer or group carries its own `width`/`height`, but that box is decoration — it is created
 * at a fixed size and never tracks the children. Aligning a group by it lines up a rectangle the
 * operator cannot see instead of the graphics inside, which is precisely the bug that "groups
 * align as one object" is meant to describe the absence of.
 *
 * Falls back to the container's own box when it is empty, because an empty group still has to
 * report something, and recurses through nested containers with a visited set so a malformed
 * scene cannot hang the caller.
 */
export function objectBoundsInScene(
  object: SceneObject,
  objectsById: ReadonlyMap<string, SceneObject>,
  options: { includeStroke?: boolean } = {},
  visited: Set<string> = new Set()
): Bounds {
  if (object.type !== "layer" && object.type !== "group") {
    return objectBounds(object, options);
  }
  if (visited.has(object.id)) return objectBounds(object, options);
  visited.add(object.id);

  const children = object.childIds
    .map((childId) => objectsById.get(childId))
    .filter((child): child is SceneObject => Boolean(child) && child!.visible)
    .map((child) => objectBoundsInScene(child, objectsById, options, visited));

  return children.length > 0 ? unionBounds(children) : objectBounds(object, options);
}

/** The smallest box containing every one of these boxes. */
export function unionBounds(all: readonly Bounds[]): Bounds {
  if (all.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const bounds of all) {
    left = Math.min(left, bounds.x);
    top = Math.min(top, bounds.y);
    right = Math.max(right, bounds.x + bounds.width);
    bottom = Math.max(bottom, bounds.y + bounds.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * The combined box of a selection.
 *
 * A group or layer is one object here — its own box already covers its children, and treating a
 * container and its descendants as separate members of a selection would weight the group twice.
 */
export function selectionBounds(
  objects: readonly SceneObject[],
  options: { includeStroke?: boolean } = {}
): Bounds {
  return unionBounds(objects.map((object) => objectBounds(object, options)));
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return (
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  );
}

/** True when `inner` lies wholly inside `outer` — the "fully enclosed" marquee mode. */
export function boundsContain(outer: Bounds, inner: Bounds): boolean {
  return (
    inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height
  );
}

export function growBounds(bounds: Bounds, amount: number): Bounds {
  if (amount === 0) return bounds;
  return {
    x: bounds.x - amount,
    y: bounds.y - amount,
    width: bounds.width + amount * 2,
    height: bounds.height + amount * 2
  };
}

/**
 * How far a stroke reaches beyond the geometry.
 *
 * Half the stroke width, and only where the type actually paints one. A text object's
 * `strokeWidth` is an outline on the glyphs rather than a border around the layout box, so
 * growing the box by it would align text to an edge nothing draws.
 */
function strokeOutset(object: SceneObject): number {
  if (object.type === "text" || object.type === "camera" || object.type === "light") return 0;
  if (object.type === "shape" && !object.strokeEnabled) return 0;
  return Math.max(0, object.strokeWidth ?? 0) / 2;
}

function pointsExtent(points: readonly Vec2[]): Bounds {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const point of points) {
    left = Math.min(left, point.x);
    top = Math.min(top, point.y);
    right = Math.max(right, point.x);
    bottom = Math.max(bottom, point.y);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * A path's exact extent.
 *
 * A cubic bezier is contained by its control polygon but almost never touches it, so taking the
 * extent of the vertices *and their tangent handles* reports a box visibly larger than the curve
 * — on a circle drawn with four handles it over-reports by more than 10% of the radius, which is
 * what made a selection box float off the shape it belongs to.
 *
 * The tight box is analytic: a cubic's extremes on each axis are its endpoints plus the points
 * where the derivative is zero. The derivative is a quadratic, so that is at most two roots per
 * axis per segment — cheaper than flattening and exact rather than approximate.
 */
function pathExtent(path: BezierPath): Bounds | null {
  const { vertices, inTangents, outTangents, closed } = path;
  const count = vertices.length;
  if (count === 0) return null;
  if (count === 1) return pointsExtent(vertices);

  const points: Vec2[] = [];
  const segments = closed ? count : count - 1;
  for (let index = 0; index < segments; index += 1) {
    const from = vertices[index];
    const to = vertices[(index + 1) % count];
    const out = outTangents[index] ?? { x: 0, y: 0 };
    const inn = inTangents[(index + 1) % count] ?? { x: 0, y: 0 };
    const p1 = { x: from.x + out.x, y: from.y + out.y };
    const p2 = { x: to.x + inn.x, y: to.y + inn.y };
    points.push(from, to);
    for (const t of cubicExtremaTimes(from.x, p1.x, p2.x, to.x)) {
      points.push(cubicPointAt(from, p1, p2, to, t));
    }
    for (const t of cubicExtremaTimes(from.y, p1.y, p2.y, to.y)) {
      points.push(cubicPointAt(from, p1, p2, to, t));
    }
  }
  return pointsExtent(points);
}

/**
 * The `t` values in (0, 1) where a cubic's derivative is zero on one axis.
 *
 * B'(t) = 3(1-t)²(p1-p0) + 6(1-t)t(p2-p1) + 3t²(p3-p2), which is the quadratic
 * `at² + bt + c` below. A degenerate (near-zero `a`) curve falls back to the linear root, so a
 * straight segment expressed with handles does not divide by zero.
 */
function cubicExtremaTimes(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = 3 * (-p0 + 3 * p1 - 3 * p2 + p3);
  const b = 6 * (p0 - 2 * p1 + p2);
  const c = 3 * (p1 - p0);
  const inRange = (t: number) => (t > 0 && t < 1 ? [t] : []);

  if (Math.abs(a) < 1e-12) {
    return Math.abs(b) < 1e-12 ? [] : inRange(-c / b);
  }
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return [];
  const root = Math.sqrt(discriminant);
  return [...inRange((-b + root) / (2 * a)), ...inRange((-b - root) / (2 * a))];
}

function cubicPointAt(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
    y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y
  };
}
