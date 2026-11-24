// Path geometry for the Pen family (plan rows 11.104, 11.107; the Advanced Pen Tool spec, sections 4 to 6 and 8).
//
// Pure maths over the scene contract's own `BezierPath`: vertices, and in and out handles that are OFFSETS from their
// vertex. Nothing here is a second path model: every function takes a `BezierPath` and gives one back (or a number), so
// the engine draws exactly the path the editor edited. Positions are plain numbers (f64 in JavaScript too), a path is
// never changed in place, and the result of an edit that cannot be done is `undefined` with the reason from `whyNot`.
//
//   segment i      runs from vertex i to vertex i+1 (the last one, of a closed path, back to vertex 0)
//   cubic          P0 = vertex i, P1 = P0 + out[i], P2 = P3 + in[i+1], P3 = vertex i+1
//   split          De Casteljau: the curve before and after is the same curve, to rounding
//   nearest point  the roots of (B(t) - Q) . B'(t), a degree 5 polynomial, found by bisecting its Bernstein form until each
//                  piece has at most one sign change (Descartes), then refined: no fixed sampling, so a tight loop is not missed

import type { BezierPath, VertexKind } from "@grapix/contracts";

export interface Pt {
  readonly x: number;
  readonly y: number;
}

/** The four control points of one cubic segment. */
export interface Cubic {
  readonly p0: Pt;
  readonly p1: Pt;
  readonly p2: Pt;
  readonly p3: Pt;
}

const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const scale = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y;
const length = (a: Pt): number => Math.hypot(a.x, a.y);
export const ORIGIN: Pt = { x: 0, y: 0 };

/** A handle shorter than this is no handle: the vertex is a corner on that side. In path units. */
export const NO_HANDLE = 1e-6;
/** A split this close to a vertex is that vertex: no new vertex is made. */
export const SPLIT_MARGIN = 1e-6;

// ---------------------------------------------------------------------------------------------------------------------
// The segments of a path

/** How many segments a path has: one fewer than its vertices, or as many when it is closed. */
export function segmentCount(path: BezierPath): number {
  const n = path.vertices.length;
  if (n < 2) return 0;
  return path.closed ? n : n - 1;
}

/** The cubic of segment `index` (0 to `segmentCount - 1`). */
export function cubicOf(path: BezierPath, index: number): Cubic {
  const n = path.vertices.length;
  const a = index % n;
  const b = (index + 1) % n;
  const p0 = path.vertices[a]!;
  const p3 = path.vertices[b]!;
  return { p0, p1: add(p0, path.outTangents[a]!), p2: add(p3, path.inTangents[b]!), p3 };
}

/** Every segment of a path as a cubic. */
export function cubicsOf(path: BezierPath): Cubic[] {
  const drawn = effective(path);
  return Array.from({ length: segmentCount(drawn) }, (_, i) => cubicOf(drawn, i));
}

// ---------------------------------------------------------------------------------------------------------------------
// Vertex ids and kinds (11.112, 11.113): the twin of the Rust section of the same name

/** The tension of `auto` vertices when the path names none. */
export const AUTO_TENSION = 0.5;

/** The id of every vertex: the stored ids, or the vertex index of a path that has none (an old scene). */
export function idsOf(path: BezierPath): number[] {
  return path.vertexIds !== undefined && path.vertexIds.length === path.vertices.length ? [...path.vertexIds] : path.vertices.map((_, i) => i);
}

/** The kind of every vertex: the stored kinds, or each vertex's kind inferred from its handles. */
export function kindsOf(path: BezierPath): VertexKind[] {
  return path.vertexKinds !== undefined && path.vertexKinds.length === path.vertices.length
    ? [...path.vertexKinds]
    : path.vertices.map((_, i) => (isSmooth(path, i) ? "smooth" : "corner"));
}

/** The path with an id on every vertex (the vertex index where it had none). */
export function withIds(path: BezierPath): BezierPath {
  return { ...path, vertexIds: idsOf(path) };
}

/** An id no vertex of `path` has. */
export function freshId(path: BezierPath): number {
  const ids = idsOf(path);
  return ids.length === 0 ? 0 : Math.max(...ids) + 1;
}

/** Whether two paths have the same topology: open or closed alike, the same vertex ids in the same order. Only such paths blend. */
export function sameTopology(a: BezierPath, b: BezierPath): boolean {
  if (a.closed !== b.closed || a.vertices.length !== b.vertices.length) return false;
  const x = idsOf(a);
  const y = idsOf(b);
  return x.every((id, i) => id === y[i]);
}

/** Whether any vertex of the path is `auto`. */
export function hasAuto(path: BezierPath): boolean {
  return path.vertexKinds !== undefined && path.vertexKinds.includes("auto");
}

/** The handles an `auto` vertex gets from its neighbours: a centripetal Catmull-Rom tangent (twice the tension scales them, so 0.5 is the
 *  plain spline); the ends of an open path point a third of the way, scaled the same, to their one neighbour. The twin of
 *  `derive_auto_handles` in Rust: every consumer reads a path through `effective`. */
export function deriveAutoHandles(path: BezierPath, index: number): { readonly in: Pt; readonly out: Pt } {
  const n = path.vertices.length;
  const tension = Math.min(1, Math.max(0, path.autoTension ?? AUTO_TENSION));
  const s = tension * 2;
  const here = path.vertices[index]!;
  const prev = index > 0 ? path.vertices[index - 1] : path.closed && n > 2 ? path.vertices[n - 1] : undefined;
  const next = index + 1 < n ? path.vertices[index + 1] : path.closed && n > 2 ? path.vertices[0] : undefined;
  const toward = (p: Pt): Pt => scale(sub(p, here), s / 3);
  if (prev !== undefined && next !== undefined) {
    const d0 = Math.sqrt(length(sub(here, prev)));
    const d1 = Math.sqrt(length(sub(next, here)));
    if (d0 < 1e-9 || d1 < 1e-9) {
      return { in: d0 >= 1e-9 ? toward(prev) : ORIGIN, out: d1 >= 1e-9 ? toward(next) : ORIGIN };
    }
    const span = d0 + d1;
    const a = scale(sub(here, prev), 1 / d0);
    const b = scale(sub(next, prev), 1 / span);
    const c = scale(sub(next, here), 1 / d1);
    const m = add(sub(a, b), c);
    return { in: scale(scale(m, d0), -s / 3), out: scale(scale(m, d1), s / 3) };
  }
  if (next !== undefined) return { in: ORIGIN, out: toward(next) };
  if (prev !== undefined) return { in: toward(prev), out: ORIGIN };
  return { in: ORIGIN, out: ORIGIN };
}

/** The path as drawn: the handles of every `auto` vertex derived from its neighbours, everything else as stored. A path with no `auto`
 *  vertex is returned as it is. */
export function effective(path: BezierPath): BezierPath {
  if (!hasAuto(path) || path.vertexKinds!.length !== path.vertices.length) return path;
  const inTangents = [...path.inTangents];
  const outTangents = [...path.outTangents];
  path.vertexKinds!.forEach((kind, i) => {
    if (kind !== "auto") return;
    const handles = deriveAutoHandles(path, i);
    inTangents[i] = handles.in;
    outTangents[i] = handles.out;
  });
  return { ...path, inTangents, outTangents };
}

/** The `auto` vertices among `indices` written out as smooth ones with the handles they have now (11.113), so an edit that reads or moves
 *  those handles starts from the curve the author sees. The other `auto` vertices stay `auto`. */
export function materialiseAt(path: BezierPath, indices: readonly number[]): BezierPath {
  if (path.vertexKinds === undefined || path.vertexKinds.length !== path.vertices.length) return path;
  const kinds = [...path.vertexKinds];
  const inTangents = [...path.inTangents];
  const outTangents = [...path.outTangents];
  for (const i of indices) {
    if (i >= 0 && i < kinds.length && kinds[i] === "auto") {
      const handles = deriveAutoHandles(path, i);
      inTangents[i] = handles.in;
      outTangents[i] = handles.out;
      kinds[i] = "smooth";
    }
  }
  return { ...path, inTangents, outTangents, vertexKinds: kinds };
}

/** The box of the control polygon (vertices and the ends of their handles) of the drawn path: a curve lies inside it, and so does every
 *  blend of two paths of one topology. */
export function controlBounds(path: BezierPath): Box | undefined {
  const drawn = effective(path);
  let box: Box | undefined;
  drawn.vertices.forEach((p, i) => {
    for (const q of [p, add(p, drawn.inTangents[i]!), add(p, drawn.outTangents[i]!)]) {
      box = box === undefined ? { minX: q.x, minY: q.y, maxX: q.x, maxY: q.y } : { minX: Math.min(box.minX, q.x), minY: Math.min(box.minY, q.y), maxX: Math.max(box.maxX, q.x), maxY: Math.max(box.maxY, q.y) };
    }
  });
  return box;
}

/** A path built from `from`'s closed flag and tension, with the given arrays and (when stored) ids and kinds. */
function assemble(from: BezierPath, parts: { vertices: Pt[]; inTangents: Pt[]; outTangents: Pt[]; ids?: number[] | undefined; kinds?: VertexKind[] | undefined; closed?: boolean }): BezierPath {
  return {
    closed: parts.closed ?? from.closed,
    vertices: parts.vertices,
    inTangents: parts.inTangents,
    outTangents: parts.outTangents,
    ...(parts.ids !== undefined ? { vertexIds: parts.ids } : {}),
    ...(parts.kinds !== undefined ? { vertexKinds: parts.kinds } : {}),
    ...(from.autoTension !== undefined ? { autoTension: from.autoTension } : {}),
  };
}

/** A cubic mapped through `map` (control points only, which is exact for an affine map). */
export function mapCubic(cubic: Cubic, map: (p: Pt) => Pt): Cubic {
  return { p0: map(cubic.p0), p1: map(cubic.p1), p2: map(cubic.p2), p3: map(cubic.p3) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Evaluation: point, tangent, normal, curvature

/** The point of the curve at `t` (0 to 1), in the stable form `(1-t)^3 P0 + 3 (1-t)^2 t P1 + 3 (1-t) t^2 P2 + t^3 P3`. */
export function pointAt(c: Cubic, t: number): Pt {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * c.p0.x + w1 * c.p1.x + w2 * c.p2.x + w3 * c.p3.x,
    y: w0 * c.p0.y + w1 * c.p1.y + w2 * c.p2.y + w3 * c.p3.y,
  };
}

/** The first derivative `B'(t)`. */
export function derivativeAt(c: Cubic, t: number): Pt {
  const u = 1 - t;
  const a = scale(sub(c.p1, c.p0), 3 * u * u);
  const b = scale(sub(c.p2, c.p1), 6 * u * t);
  const d = scale(sub(c.p3, c.p2), 3 * t * t);
  return add(add(a, b), d);
}

/** The second derivative `B''(t)`. */
export function secondDerivativeAt(c: Cubic, t: number): Pt {
  const u = 1 - t;
  const a = scale(add(sub(c.p2, scale(c.p1, 2)), c.p0), 6 * u);
  const b = scale(add(sub(c.p3, scale(c.p2, 2)), c.p1), 6 * t);
  return add(a, b);
}

/** The unit tangent at `t`. When the speed is nil (a repeated control point) it looks a little way along the curve, then to
 *  the chord, and gives `undefined` only for a curve that is a single point. */
export function tangentAt(c: Cubic, t: number): Pt | undefined {
  const unit = (v: Pt): Pt | undefined => {
    const l = length(v);
    return l > 1e-12 ? scale(v, 1 / l) : undefined;
  };
  const here = unit(derivativeAt(c, t));
  if (here) return here;
  for (const nudge of [1e-4, 1e-3, 1e-2]) {
    for (const s of [t + nudge, t - nudge]) {
      if (s < 0 || s > 1) continue;
      const found = unit(derivativeAt(c, s));
      if (found) return found;
    }
  }
  return unit(sub(c.p3, c.p0));
}

/** The unit normal at `t` (the tangent turned a quarter), or `undefined` with no tangent. */
export function normalAt(c: Cubic, t: number): Pt | undefined {
  const tangent = tangentAt(c, t);
  return tangent ? { x: -tangent.y, y: tangent.x } : undefined;
}

/** The signed curvature at `t`; 0 where the speed is nil, so it never divides by zero. */
export function curvatureAt(c: Cubic, t: number): number {
  const d1 = derivativeAt(c, t);
  const d2 = secondDerivativeAt(c, t);
  const speed = length(d1);
  if (speed < 1e-12) return 0;
  return (d1.x * d2.y - d1.y * d2.x) / (speed * speed * speed);
}

// ---------------------------------------------------------------------------------------------------------------------
// Splitting (De Casteljau)

export interface Split {
  readonly left: Cubic;
  readonly right: Cubic;
}

/** The curve cut at `t`: both halves, which together are the same curve. */
export function splitCubic(c: Cubic, t: number): Split {
  const a = lerp(c.p0, c.p1, t);
  const b = lerp(c.p1, c.p2, t);
  const cc = lerp(c.p2, c.p3, t);
  const d = lerp(a, b, t);
  const e = lerp(b, cc, t);
  const m = lerp(d, e, t);
  return { left: { p0: c.p0, p1: a, p2: d, p3: m }, right: { p0: m, p1: e, p2: cc, p3: c.p3 } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Bounds

/** The roots in (0, 1) of one component of the derivative, which is a quadratic in `t`. */
function derivativeRoots(p0: number, p1: number, p2: number, p3: number): number[] {
  // B'(t) / 3 = a t^2 + b t + c with the differences of the control points.
  const d0 = p1 - p0;
  const d1 = p2 - p1;
  const d2 = p3 - p2;
  const a = d0 - 2 * d1 + d2;
  const b = 2 * (d1 - d0);
  const k = d0;
  const roots: number[] = [];
  const keep = (t: number) => {
    if (t > 0 && t < 1) roots.push(t);
  };
  if (Math.abs(a) < 1e-14) {
    if (Math.abs(b) > 1e-14) keep(-k / b);
    return roots;
  }
  const disc = b * b - 4 * a * k;
  if (disc < 0) return roots;
  const root = Math.sqrt(disc);
  keep((-b + root) / (2 * a));
  keep((-b - root) / (2 * a));
  return roots;
}

export interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** The exact bounds of one cubic: its end points and the points where either coordinate turns. */
export function cubicBounds(c: Cubic): Box {
  const ts = [0, 1, ...derivativeRoots(c.p0.x, c.p1.x, c.p2.x, c.p3.x), ...derivativeRoots(c.p0.y, c.p1.y, c.p2.y, c.p3.y)];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const t of ts) {
    const p = pointAt(c, t);
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/** The exact bounds of the drawn path, or `undefined` for a path with no segment. */
export function pathBounds(path: BezierPath): Box | undefined {
  const boxes = cubicsOf(path).map(cubicBounds);
  if (boxes.length === 0) return undefined;
  return boxes.reduce((a, b) => ({
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }));
}

// ---------------------------------------------------------------------------------------------------------------------
// Arc length

// 8-point Gauss-Legendre nodes and weights on [-1, 1].
const GL_X = [0.1834346424956498, 0.5255324099163290, 0.7966664774136267, 0.9602898564975363];
const GL_W = [0.3626837833783620, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763];

function gaussLength(c: Cubic, a: number, b: number): number {
  const half = (b - a) / 2;
  const mid = (b + a) / 2;
  let sum = 0;
  for (let i = 0; i < GL_X.length; i++) {
    sum += GL_W[i]! * (length(derivativeAt(c, mid + half * GL_X[i]!)) + length(derivativeAt(c, mid - half * GL_X[i]!)));
  }
  return sum * half;
}

/** The length of the curve from `t0` to `t1`, by adaptive Gauss-Legendre: halves an interval until its two halves agree
 *  with the whole to `tolerance` (path units). */
export function arcLength(c: Cubic, t0 = 0, t1 = 1, tolerance = 1e-6): number {
  const walk = (a: number, b: number, whole: number, depth: number): number => {
    const mid = (a + b) / 2;
    const left = gaussLength(c, a, mid);
    const right = gaussLength(c, mid, b);
    if (depth >= 24 || Math.abs(left + right - whole) <= tolerance) return left + right;
    return walk(a, mid, left, depth + 1) + walk(mid, b, right, depth + 1);
  };
  if (t1 <= t0) return 0;
  return walk(t0, t1, gaussLength(c, t0, t1), 0);
}

/** The length of every segment of a path, and their sum. */
export function pathLengths(path: BezierPath, tolerance = 1e-6): { segments: number[]; total: number } {
  const segments = cubicsOf(path).map((c) => arcLength(c, 0, 1, tolerance));
  return { segments, total: segments.reduce((a, b) => a + b, 0) };
}

/** The parameter at which the curve has gone `distance` along itself (clamped to 0 and the whole length). */
export function tAtLength(c: Cubic, distance: number, tolerance = 1e-6): number {
  const whole = arcLength(c, 0, 1, tolerance);
  if (distance <= 0) return 0;
  if (distance >= whole) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (arcLength(c, 0, mid, tolerance) < distance) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------------------------------------------------
// Nearest point

export interface Nearest {
  /** The parameter on the cubic. */
  readonly t: number;
  readonly point: Pt;
  readonly distance: number;
}

/** Bernstein coefficients of f(t) = (B(t) - q) . B'(t), the degree 5 polynomial whose roots are the stationary points. */
function stationaryCoefficients(c: Cubic, q: Pt): number[] {
  const a = [sub(c.p0, q), sub(c.p1, q), sub(c.p2, q), sub(c.p3, q)];
  const d = [scale(sub(c.p1, c.p0), 3), scale(sub(c.p2, c.p1), 3), scale(sub(c.p3, c.p2), 3)];
  const choose3 = [1, 3, 3, 1];
  const choose2 = [1, 2, 1];
  const choose5 = [1, 5, 10, 10, 5, 1];
  const out = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i <= 3; i++) {
    for (let j = 0; j <= 2; j++) {
      out[i + j]! += (choose3[i]! * choose2[j]! * dot(a[i]!, d[j]!)) / choose5[i + j]!;
    }
  }
  return out;
}

/** The sign changes in a coefficient list, skipping zeros (Descartes' rule for the Bernstein form: this many roots at most). */
function signChanges(values: readonly number[]): number {
  let count = 0;
  let last = 0;
  for (const v of values) {
    const s = v > 0 ? 1 : v < 0 ? -1 : 0;
    if (s === 0) continue;
    if (last !== 0 && s !== last) count++;
    last = s;
  }
  return count;
}

/** One de Casteljau step of a Bernstein list at one half: the halves' coefficients. */
function halve(values: readonly number[]): [number[], number[]] {
  const left: number[] = [];
  const right: number[] = [];
  let row = [...values];
  while (row.length > 0) {
    left.push(row[0]!);
    right.unshift(row[row.length - 1]!);
    row = row.slice(1).map((v, i) => (row[i]! + v) / 2);
  }
  return [left, right];
}

/** The parameters inside [0, 1] where the distance to `q` is stationary, found without sampling. Each piece of the
 *  polynomial's Bernstein form with exactly one sign change holds one root, found by bisection; the signs just inside the
 *  ends come from the end coefficients, so an end that is itself a root (a cusp, or a symmetric curve, at a halving point)
 *  does not hide the root beside it. The ends of every piece are candidates too. */
function stationaryParameters(c: Cubic, q: Pt): number[] {
  const roots: number[] = [];
  const f = (t: number) => dot(sub(pointAt(c, t), q), derivativeAt(c, t));
  const refine = (coeffs: readonly number[], lo: number, hi: number) => {
    const first = coeffs.find((v) => v !== 0);
    if (first === undefined) return;
    const start = Math.sign(first);
    let a = lo;
    let b = hi;
    for (let i = 0; i < 60; i++) {
      const mid = (a + b) / 2;
      const fm = f(mid);
      if (fm === 0) {
        roots.push(mid);
        return;
      }
      if (Math.sign(fm) === start) a = mid;
      else b = mid;
    }
    roots.push((a + b) / 2);
  };
  const walk = (coeffs: number[], lo: number, hi: number, depth: number) => {
    roots.push(lo, hi);
    const changes = signChanges(coeffs);
    if (changes === 0) return;
    if (changes === 1) {
      refine(coeffs, lo, hi);
      return;
    }
    if (depth >= 40 || hi - lo < 1e-12) {
      roots.push((lo + hi) / 2);
      return;
    }
    const [left, right] = halve(coeffs);
    const mid = (lo + hi) / 2;
    walk(left, lo, mid, depth + 1);
    walk(right, mid, hi, depth + 1);
  };
  walk(stationaryCoefficients(c, q), 0, 1, 0);
  return roots;
}

/** The point of the curve nearest `q`: every stationary point and both ends are compared, so the answer is the global
 *  minimum, also for a loop or a cusp. */
export function nearestOnCubic(c: Cubic, q: Pt): Nearest {
  let best: Nearest | undefined;
  for (const t of [0, 1, ...stationaryParameters(c, q)]) {
    const point = pointAt(c, t);
    const distance = length(sub(point, q));
    if (best === undefined || distance < best.distance) best = { t, point, distance };
  }
  return best!;
}

export interface PathHit extends Nearest {
  readonly segment: number;
}

/** The point of a path nearest `q` over all its segments (in the path's own space), or `undefined` for a path without one. */
export function nearestOnPath(path: BezierPath, q: Pt): PathHit | undefined {
  let best: PathHit | undefined;
  cubicsOf(path).forEach((c, segment) => {
    const found = nearestOnCubic(c, q);
    if (best === undefined || found.distance < best.distance) best = { ...found, segment };
  });
  return best;
}

// ---------------------------------------------------------------------------------------------------------------------
// Edits: each returns a new path, or `undefined` (with `whyNot` saying why)

/** Why the last edit that gave `undefined` could not be done, as a sentence to show the author. */
export let whyNot = "";
const refuse = (reason: string): undefined => {
  whyNot = reason;
  return undefined;
};

const replaceAt = <T>(list: readonly T[], index: number, value: T): T[] => list.map((v, i) => (i === index ? value : v));
const clonePath = (path: BezierPath): BezierPath =>
  assemble(path, {
    vertices: path.vertices.map((p) => ({ ...p })),
    inTangents: path.inTangents.map((p) => ({ ...p })),
    outTangents: path.outTangents.map((p) => ({ ...p })),
    ids: path.vertexIds !== undefined ? [...path.vertexIds] : undefined,
    kinds: path.vertexKinds !== undefined ? [...path.vertexKinds] : undefined,
  });

/** A vertex put at segment `segment`, parameter `t`, without changing the drawn curve (exact De Casteljau split).
 *  `t` at an end of the segment is refused: that is a vertex already. */
export function insertVertex(path: BezierPath, segment: number, t: number, id?: number): BezierPath | undefined {
  if (!(segment >= 0 && segment < segmentCount(path))) return refuse("there is no such segment");
  if (!Number.isFinite(t) || t <= SPLIT_MARGIN || t >= 1 - SPLIT_MARGIN) return refuse("that is a vertex already");
  const n = path.vertices.length;
  const a = segment;
  const b = (segment + 1) % n;
  // The ends of the segment, if auto, are written out first: the curve is split as drawn and the shape stays exactly.
  path = materialiseAt(path, [a, b]);
  if (id !== undefined && path.vertexIds !== undefined && path.vertexIds.includes(id)) return refuse("that vertex id is taken");
  const cubic = cubicOf(path, segment);
  const { left, right } = splitCubic(cubic, t);
  const middle = left.p3;
  const vertices = [...path.vertices];
  const inTangents = [...path.inTangents];
  const outTangents = [...path.outTangents];
  outTangents[a] = sub(left.p1, left.p0);
  inTangents[b] = sub(right.p2, right.p3);
  // The new vertex goes after vertex `a`; for the closing segment of a closed path that is the end of the list.
  const at = a + 1;
  const into = sub(left.p2, middle);
  const outof = sub(right.p1, middle);
  vertices.splice(at, 0, middle);
  inTangents.splice(at, 0, into);
  outTangents.splice(at, 0, outof);
  let ids: number[] | undefined;
  if (path.vertexIds !== undefined) {
    ids = [...path.vertexIds];
    ids.splice(at, 0, id ?? (ids.length === 0 ? 0 : Math.max(...ids) + 1));
  }
  let kinds: VertexKind[] | undefined;
  if (path.vertexKinds !== undefined) {
    kinds = [...path.vertexKinds];
    kinds.splice(at, 0, length(into) > NO_HANDLE || length(outof) > NO_HANDLE ? "smooth" : "corner");
  }
  return assemble(path, { vertices, inTangents, outTangents, ids, kinds });
}

/** What fitting one cubic over the two curves beside a vertex gives (11.113): the path without the vertex and how far the new curve is
 *  from the old two (the larger of the two directed distances, in path units). The twin of `fit_delete_vertex` in Rust. */
export interface KeepShapeFit {
  readonly path: BezierPath;
  readonly deviation: number;
}

const direction = (v: Pt, fallback: Pt): Pt => {
  const l = length(v);
  if (l > NO_HANDLE) return scale(v, 1 / l);
  const f = length(fallback);
  return f > NO_HANDLE ? scale(fallback, 1 / f) : ORIGIN;
};

/** The vertex `index` taken out and one cubic fitted over the two curves beside it: same end points, the directions the outer handles
 *  pointed in, handle lengths by least squares over points of the old curves with the parameter moved to the nearest point of the
 *  curve just fitted (Schneider). `deviation` is measured. The ends of an open path have one curve: the ordinary delete, exactly. */
export function fitDeleteVertex(path: BezierPath, index: number): KeepShapeFit | undefined {
  const n = path.vertices.length;
  if (!(index >= 0 && index < n)) return refuse("there is no such vertex");
  const prev = (index + n - 1) % n;
  const next = (index + 1) % n;
  path = materialiseAt(path, [index, prev, next]);
  const without = deleteVertices(path, [index]);
  if (without === undefined) return undefined;
  if (!path.closed && (index === 0 || index === n - 1)) return { path: without, deviation: 0 };
  const first = cubicOf(path, prev);
  const second = cubicOf(path, index);
  const PER_CURVE = 24;
  const samples: Pt[] = [];
  for (const [c, last] of [[first, false], [second, true]] as const) {
    const upto = last ? PER_CURVE : PER_CURVE - 1;
    for (let k = 0; k <= upto; k += 1) samples.push(pointAt(c, k / PER_CURVE));
  }
  const t: number[] = new Array(samples.length).fill(0);
  for (let i = 1; i < samples.length; i += 1) t[i] = t[i - 1]! + length(sub(samples[i]!, samples[i - 1]!));
  const whole = t[t.length - 1]!;
  if (whole <= NO_HANDLE) return { path: without, deviation: 0 };
  for (let i = 0; i < t.length; i += 1) t[i] = t[i]! / whole;
  const p0 = first.p0;
  const p3 = second.p3;
  const d1 = direction(sub(first.p1, first.p0), sub(first.p3, first.p0));
  const d2 = direction(sub(second.p2, second.p3), sub(second.p0, second.p3));
  const chord = length(sub(p3, p0));
  const solve = (params: readonly number[]): Cubic => {
    let c11 = 0, c12 = 0, c22 = 0, x1 = 0, x2 = 0;
    samples.forEach((point, k) => {
      const tk = params[k]!;
      const u = 1 - tk;
      const b0 = u * u * u, b1 = 3 * u * u * tk, b2 = 3 * u * tk * tk, b3 = tk * tk * tk;
      const r = sub(point, add(scale(p0, b0 + b1), scale(p3, b2 + b3)));
      c11 += b1 * b1 * dot(d1, d1);
      c12 += b1 * b2 * dot(d1, d2);
      c22 += b2 * b2 * dot(d2, d2);
      x1 += b1 * dot(d1, r);
      x2 += b2 * dot(d2, r);
    });
    const det = c11 * c22 - c12 * c12;
    let a1 = Math.abs(det) > 1e-12 ? (x1 * c22 - x2 * c12) / det : chord / 3;
    let a2 = Math.abs(det) > 1e-12 ? (c11 * x2 - c12 * x1) / det : chord / 3;
    if (!(a1 > 1e-9) || !Number.isFinite(a1)) a1 = chord / 3;
    if (!(a2 > 1e-9) || !Number.isFinite(a2)) a2 = chord / 3;
    return { p0, p1: add(p0, scale(d1, a1)), p2: add(p3, scale(d2, a2)), p3 };
  };
  const worst = (c: Cubic): number => samples.reduce((m, p) => Math.max(m, nearestOnCubic(c, p).distance), 0);
  let fitted = solve(t);
  let best = { w: worst(fitted), c: fitted };
  for (let iteration = 0; iteration < 60; iteration += 1) {
    fitted = solve(samples.map((p) => nearestOnCubic(fitted, p).t));
    const w = worst(fitted);
    const improved = best.w - w;
    if (w < best.w) best = { w, c: fitted };
    if (Math.abs(improved) < 1e-12) break;
  }
  const chosen = best.c;
  let deviation = 0;
  for (const point of samples) deviation = Math.max(deviation, nearestOnCubic(chosen, point).distance);
  for (let k = 0; k <= 2 * PER_CURVE; k += 1) {
    const point = pointAt(chosen, k / (2 * PER_CURVE));
    deviation = Math.max(deviation, Math.min(nearestOnCubic(first, point).distance, nearestOnCubic(second, point).distance));
  }
  const out = { ...without, outTangents: [...without.outTangents], inTangents: [...without.inTangents] };
  const newPrev = prev > index ? prev - 1 : prev;
  const newNext = next > index ? next - 1 : next;
  out.outTangents[newPrev] = sub(chosen.p1, chosen.p0);
  out.inTangents[newNext] = sub(chosen.p2, chosen.p3);
  // The fitted ends keep their directions but not necessarily equal lengths.
  if (out.vertexKinds !== undefined) {
    out.vertexKinds = [...out.vertexKinds];
    for (const i of [newPrev, newNext]) if (out.vertexKinds[i] === "symmetric") out.vertexKinds[i] = "smooth";
  }
  return { path: out, deviation };
}

/** `fitDeleteVertex`, accepted only when the new curve stays within `tolerance` of the old ones. */
export function deleteKeepShape(path: BezierPath, index: number, tolerance: number): BezierPath | undefined {
  if (!Number.isFinite(tolerance) || tolerance < 0) return refuse("the tolerance must be a distance of zero or more");
  const fit = fitDeleteVertex(path, index);
  if (fit === undefined) return undefined;
  if (fit.deviation > tolerance) return refuse("taking that vertex out would change the shape by more than the tolerance");
  return fit.path;
}

/** Vertices taken out. The curves beside each join with the handles their vertices already had, which is the plain delete of
 *  the Pen tool: the shape changes. A path keeps at least two vertices (three when closed). */
export function deleteVertices(path: BezierPath, indices: readonly number[]): BezierPath | undefined {
  const n = path.vertices.length;
  if (indices.length === 0 || indices.some((i) => !(i >= 0 && i < n))) return refuse("there is no such vertex");
  const drop = new Set(indices);
  const left = n - drop.size;
  if (path.closed && left < 3) return refuse("a closed path keeps three vertices");
  if (left < 2) return refuse("a path keeps two vertices");
  const keep = <T>(list: readonly T[]) => list.filter((_, i) => !drop.has(i));
  return assemble(path, {
    vertices: keep(path.vertices),
    inTangents: keep(path.inTangents),
    outTangents: keep(path.outTangents),
    ids: path.vertexIds !== undefined ? keep(path.vertexIds) : undefined,
    kinds: path.vertexKinds !== undefined ? keep(path.vertexKinds) : undefined,
  });
}

/** One vertex taken out (see `deleteVertices`). */
export const deleteVertex = (path: BezierPath, index: number): BezierPath | undefined => deleteVertices(path, [index]);

/** Whether a vertex has a handle on either side. */
export function hasHandles(path: BezierPath, index: number): boolean {
  return length(path.inTangents[index]!) > NO_HANDLE || length(path.outTangents[index]!) > NO_HANDLE;
}

/** Whether a vertex is smooth: both handles there and in line, opposite each other (their lengths may differ). */
export function isSmooth(path: BezierPath, index: number): boolean {
  const a = path.inTangents[index]!;
  const b = path.outTangents[index]!;
  const la = length(a);
  const lb = length(b);
  if (la <= NO_HANDLE || lb <= NO_HANDLE) return false;
  const cross = (a.x * b.y - a.y * b.x) / (la * lb);
  return Math.abs(cross) < 1e-6 && dot(a, b) < 0;
}

/** A vertex's neighbours' positions, or `undefined` at the end of an open path. */
function neighbours(path: BezierPath, index: number): { prev?: Pt; next?: Pt } {
  const n = path.vertices.length;
  const prev = index > 0 ? path.vertices[index - 1] : path.closed ? path.vertices[n - 1] : undefined;
  const next = index < n - 1 ? path.vertices[index + 1] : path.closed ? path.vertices[0] : undefined;
  return { ...(prev ? { prev } : {}), ...(next ? { next } : {}) };
}

/** A vertex turned from a corner into a smooth point, or from a point with handles into a corner (the Convert tool).
 *  A new smooth point is given a third of the way to each neighbour, in line with the way through it. */
export function convertVertex(path: BezierPath, index: number): BezierPath | undefined {
  if (!(index >= 0 && index < path.vertices.length)) return refuse("there is no such vertex");
  path = materialiseAt(path, [index]);
  const withKind = (made: BezierPath, kind: VertexKind): BezierPath =>
    made.vertexKinds === undefined ? made : { ...made, vertexKinds: replaceAt(made.vertexKinds, index, kind) };
  if (hasHandles(path, index)) {
    return withKind({ ...clonePath(path), inTangents: replaceAt(path.inTangents, index, ORIGIN), outTangents: replaceAt(path.outTangents, index, ORIGIN) }, "corner");
  }
  const here = path.vertices[index]!;
  const { prev, next } = neighbours(path, index);
  if (!prev && !next) return refuse("a vertex with no neighbour has no direction");
  const through = prev && next ? sub(next, prev) : prev ? sub(here, prev) : sub(next!, here);
  const l = length(through);
  if (l < 1e-9) return refuse("its neighbours are on top of it");
  const dir = scale(through, 1 / l);
  const out = next ? scale(dir, length(sub(next, here)) / 3) : ORIGIN;
  const into = prev ? scale(dir, -length(sub(here, prev)) / 3) : ORIGIN;
  return withKind({ ...clonePath(path), inTangents: replaceAt(path.inTangents, index, into), outTangents: replaceAt(path.outTangents, index, out) }, "smooth");
}

/** A vertex given the kind `kind` (11.113). `corner` keeps the handles it has; `smooth` and `symmetric` bring them in line (smooth keeps their
 *  lengths, symmetric makes them equal); `auto` clears the stored handles, which are derived from now on, and a vertex that stops being
 *  `auto` is first written out with the handles it was drawn with, so the shape never moves. */
export function setVertexKind(path: BezierPath, index: number, kind: VertexKind): BezierPath | undefined {
  if (!(index >= 0 && index < path.vertices.length)) return refuse("there is no such vertex");
  const kinds = kindsOf(path);
  if (kinds[index] === kind) return refuse("it is that kind already");
  let next = materialiseAt(path, [index]);
  // An auto vertex's handles are derived and never stored beside manual ones (11.113): its stored handles are cleared.
  if (kind === "auto") next = { ...next, inTangents: replaceAt(next.inTangents, index, ORIGIN), outTangents: replaceAt(next.outTangents, index, ORIGIN) };
  if (kind === "smooth" || kind === "symmetric") {
    const inn = next.inTangents[index]!;
    const out = next.outTangents[index]!;
    const li = length(inn);
    const lo = length(out);
    if (li <= NO_HANDLE && lo <= NO_HANDLE) {
      // No handles to bring in line: derive them as a corner made smooth would get them.
      const { vertexKinds: _dropped, ...probe } = next;
      const made = convertVertex(probe, index);
      if (made === undefined) return undefined;
      next = { ...next, inTangents: replaceAt(next.inTangents, index, made.inTangents[index]!), outTangents: replaceAt(next.outTangents, index, made.outTangents[index]!) };
    } else {
      // Keep the longer handle's direction, the author's main gesture.
      let dir: Pt;
      let lenOut: number;
      let lenIn: number;
      if (lo >= li) {
        dir = direction(out, ORIGIN);
        lenOut = lo;
        lenIn = li > NO_HANDLE ? li : lo;
      } else {
        dir = scale(direction(inn, ORIGIN), -1);
        lenOut = lo > NO_HANDLE ? lo : li;
        lenIn = li;
      }
      if (kind === "symmetric") {
        const m = (lenOut + lenIn) / 2;
        lenOut = m;
        lenIn = m;
      }
      next = { ...next, outTangents: replaceAt(next.outTangents, index, scale(dir, lenOut)), inTangents: replaceAt(next.inTangents, index, scale(dir, -lenIn)) };
    }
  }
  return { ...next, vertexKinds: replaceAt(kinds, index, kind) };
}

/** The tension of the `auto` vertices, 0 to 1. */
export function setAutoTension(path: BezierPath, tension: number): BezierPath | undefined {
  if (!Number.isFinite(tension) || tension < 0 || tension > 1) return refuse("the tension is a number from 0 to 1");
  return { ...clonePath(path), autoTension: tension };
}

/** How the far handle follows the one being dragged: `none` leaves it, `smooth` keeps it opposite with its own length,
 *  `mirror` makes it the same length opposite. */
export type Coupling = "none" | "smooth" | "mirror";

/** One handle set to `vector` (an offset from its vertex). The other follows by `coupling`. A zero handle stays zero. */
export function setHandle(path: BezierPath, index: number, side: "in" | "out", vector: Pt, coupling: Coupling = "none"): BezierPath | undefined {
  if (!(index >= 0 && index < path.vertices.length)) return refuse("there is no such vertex");
  if (!Number.isFinite(vector.x) || !Number.isFinite(vector.y)) return refuse("a handle must be a finite point");
  path = materialiseAt(path, [index]);
  const near = side === "in" ? path.inTangents : path.outTangents;
  const far = side === "in" ? path.outTangents : path.inTangents;
  let farVector = far[index]!;
  const l = length(vector);
  if (coupling === "mirror") farVector = scale(vector, -1);
  else if (coupling === "smooth" && l > NO_HANDLE) farVector = scale(vector, -length(far[index]!) / l);
  const nextNear = replaceAt(near, index, vector);
  const nextFar = replaceAt(far, index, farVector);
  const kind: VertexKind = coupling === "none" ? "corner" : coupling === "smooth" ? "smooth" : "symmetric";
  return assemble(path, {
    vertices: path.vertices.map((p) => ({ ...p })),
    inTangents: side === "in" ? nextNear : nextFar,
    outTangents: side === "in" ? nextFar : nextNear,
    ids: path.vertexIds !== undefined ? [...path.vertexIds] : undefined,
    kinds: path.vertexKinds !== undefined ? replaceAt(path.vertexKinds, index, kind) : undefined,
  });
}

/** Some vertices moved by the same offset; their handles (offsets) go with them. */
export function moveVertices(path: BezierPath, indices: readonly number[], delta: Pt): BezierPath | undefined {
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return refuse("a move must be a finite distance");
  const set = new Set(indices);
  return assemble(path, {
    vertices: path.vertices.map((p, i) => (set.has(i) ? add(p, delta) : { ...p })),
    inTangents: path.inTangents.map((p) => ({ ...p })),
    outTangents: path.outTangents.map((p) => ({ ...p })),
    ids: path.vertexIds !== undefined ? [...path.vertexIds] : undefined,
    kinds: path.vertexKinds !== undefined ? [...path.vertexKinds] : undefined,
  });
}

/** The curve dragged at parameter `t` of `segment` by `delta`, its two end vertices staying put: the handles beside it
 *  move to follow, each by the share its weight in the curve gives it (spec 8.1, exact grab point). A smooth vertex at an
 *  end keeps its other handle in line. */
export function reshapeSegment(path: BezierPath, segment: number, t: number, delta: Pt): BezierPath | undefined {
  if (!(segment >= 0 && segment < segmentCount(path))) return refuse("there is no such segment");
  const u = 1 - t;
  const a = 3 * u * u * t;
  const b = 3 * u * t * t;
  const weight = a * a + b * b;
  if (weight < 1e-12) return refuse("grab the curve between its vertices");
  const n = path.vertices.length;
  const from = segment % n;
  const to = (segment + 1) % n;
  path = materialiseAt(path, [from, to]);
  const couple = (p: BezierPath, i: number): Coupling => {
    const kind = kindsOf(p)[i];
    return kind === "symmetric" ? "mirror" : kind === "smooth" || kind === "auto" ? "smooth" : "none";
  };
  const first = setHandle(path, from, "out", add(path.outTangents[from]!, scale(delta, a / weight)), couple(path, from));
  if (first === undefined) return undefined;
  return setHandle(first, to, "in", add(first.inTangents[to]!, scale(delta, b / weight)), couple(first, to));
}

/** The path in the other direction: the same outline, drawn from the other end. */
export function reversePath(path: BezierPath): BezierPath {
  const n = path.vertices.length;
  const order = Array.from({ length: n }, (_, i) => n - 1 - i);
  // A closed path keeps its first vertex first, so it reads the same from there.
  const ordered = path.closed ? [0, ...order.filter((i) => i !== 0)] : order;
  return assemble(path, {
    vertices: ordered.map((i) => ({ ...path.vertices[i]! })),
    inTangents: ordered.map((i) => ({ ...path.outTangents[i]! })),
    outTangents: ordered.map((i) => ({ ...path.inTangents[i]! })),
    ids: path.vertexIds !== undefined ? ordered.map((i) => path.vertexIds![i]!) : undefined,
    kinds: path.vertexKinds !== undefined ? ordered.map((i) => path.vertexKinds![i]!) : undefined,
  });
}

/** A closed path started from another vertex: the same outline, a different first vertex. */
export function setFirstVertex(path: BezierPath, index: number): BezierPath | undefined {
  if (!path.closed) return refuse("only a closed path has a first vertex to change");
  const n = path.vertices.length;
  if (!(index >= 0 && index < n)) return refuse("there is no such vertex");
  const turn = <T>(list: readonly T[]) => [...list.slice(index), ...list.slice(0, index)];
  return assemble(path, {
    closed: true,
    vertices: turn(path.vertices),
    inTangents: turn(path.inTangents),
    outTangents: turn(path.outTangents),
    ids: path.vertexIds !== undefined ? turn(path.vertexIds) : undefined,
    kinds: path.vertexKinds !== undefined ? turn(path.vertexKinds) : undefined,
  });
}

/** A path closed (the end joins the start) or opened again. Closing needs three vertices. */
export function setClosed(path: BezierPath, closed: boolean): BezierPath | undefined {
  if (closed && path.vertices.length < 3) return refuse("a closed path needs three vertices");
  return { ...clonePath(path), closed };
}

/** Two open paths joined end to start: `first`'s last vertex meets `second`'s first. `second` is reversed when told, so either end of
 *  it can be the one joined. Neither path is moved: when the two ends are within `merge` of each other they become one vertex (the
 *  first's end, with the first's incoming handle and the second's outgoing one); when they are further apart the paths keep every
 *  vertex and a segment runs between the two ends with the handles those ends already have, as Illustrator's Join does. */
export function joinPaths(first: BezierPath, second: BezierPath, reverseSecond = false, merge = 0.5): BezierPath | undefined {
  if (first.closed || second.closed) return refuse("only open paths can be joined");
  const turned = reverseSecond ? reversePath(second) : second;
  const n = first.vertices.length;
  const copy = (list: readonly Pt[]): Pt[] => list.map((p) => ({ ...p }));
  // Ids and kinds are kept when either path has them; the second path's ids are moved clear of the first's so each stays unique.
  const keepsIds = first.vertexIds !== undefined || turned.vertexIds !== undefined;
  const keepsKinds = first.vertexKinds !== undefined || turned.vertexKinds !== undefined;
  const offset = freshId(first);
  const otherIds = idsOf(turned).map((id) => id + offset);
  const merged = length(sub(first.vertices[n - 1]!, turned.vertices[0]!)) <= merge;
  const skip = merged ? 1 : 0;
  const tension = first.autoTension ?? turned.autoTension;
  const ids = keepsIds ? [...idsOf(first), ...otherIds.slice(skip)] : undefined;
  const kinds = keepsKinds ? [...kindsOf(first), ...kindsOf(turned).slice(skip)] : undefined;
  const tail = {
    ...(ids !== undefined ? { vertexIds: ids } : {}),
    ...(kinds !== undefined ? { vertexKinds: kinds } : {}),
    ...(tension !== undefined ? { autoTension: tension } : {}),
  };
  if (merged) {
    return {
      closed: false,
      vertices: [...copy(first.vertices), ...copy(turned.vertices.slice(1))],
      inTangents: [...copy(first.inTangents), ...copy(turned.inTangents.slice(1))],
      outTangents: [...copy(first.outTangents.slice(0, n - 1)), { ...turned.outTangents[0]! }, ...copy(turned.outTangents.slice(1))],
      ...tail,
    };
  }
  return {
    closed: false,
    vertices: [...copy(first.vertices), ...copy(turned.vertices)],
    inTangents: [...copy(first.inTangents), ...copy(turned.inTangents)],
    outTangents: [...copy(first.outTangents), ...copy(turned.outTangents)],
    ...tail,
  };
}

/** The point `to` brought to the nearest multiple of `degrees` from `from` (Shift). */
export function snapAngle(from: Pt, to: Pt, degrees: number): Pt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const l = Math.hypot(dx, dy);
  if (l === 0 || !(degrees > 0)) return to;
  const step = (degrees * Math.PI) / 180;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: from.x + l * Math.cos(angle), y: from.y + l * Math.sin(angle) };
}

/** Whether a segment is straight to within `tolerance` (path units): both inner control points lie within it of the chord. */
export function isStraight(c: Cubic, tolerance = 1e-6): boolean {
  const chord = sub(c.p3, c.p0);
  const l = length(chord);
  const off = (p: Pt) => (l < 1e-12 ? length(sub(p, c.p0)) : Math.abs((chord.x * (p.y - c.p0.y) - chord.y * (p.x - c.p0.x)) / l));
  return off(c.p1) <= tolerance && off(c.p2) <= tolerance;
}

/** Whether every number of a path is finite and its three arrays agree: the invariants the contract checks too. */
export function pathIsValid(path: BezierPath): boolean {
  const n = path.vertices.length;
  if (path.inTangents.length !== n || path.outTangents.length !== n) return false;
  if (path.vertexIds !== undefined && (path.vertexIds.length !== n || new Set(path.vertexIds).size !== n)) return false;
  if (path.vertexKinds !== undefined && path.vertexKinds.length !== n) return false;
  if (path.autoTension !== undefined && !(path.autoTension >= 0 && path.autoTension <= 1)) return false;
  return [...path.vertices, ...path.inTangents, ...path.outTangents].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}
