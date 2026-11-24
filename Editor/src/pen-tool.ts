// The Pen tool (plan row 11.104): draw a path point by point and make it a shape.
//
//   click               a corner point (no handles)
//   click and drag      a smooth point: the drag pulls the point's outgoing handle, and the incoming one opposite it
//   click on the first  closes the path (three or more points), so it is a filled shape
//   Enter / double click / choosing another tool   finishes an open path (two or more points): a line with a stroke
//   Backspace           takes back the last point (or opens a closed path again)
//   Shift               keeps the next point (and a pulled handle) to a multiple of SHIFT_ANGLE degrees (15, as After Effects does)
//   Alt                 while pulling: breaks the handles apart, so only the outgoing one follows the pointer
//   Space               while placing: moves the new point, with its handles, instead of pulling
//   Escape              while pulling: takes that point back; with no pull in progress: ends the path and keeps what is placed
//   click on an end     of a selected open shape: carries that path on (see `resumeState`)
//
// Pure: the page feeds it pointer positions and draws `penSketch`; the result is ONE `createShape` edit (plus the paints
// that make an open path a stroke), so the whole path is one undo step. A shape lands at the origin with its path's own
// coordinates, which is what the contract says (render_edit::create_shape), so points are stored as canvas coordinates.

import type { BezierPath, SceneDocument, SceneEdit, SceneObject } from "@grapix/contracts";
import { effectivePlacement, toLocalDelta } from "./anchor-point";
import type { EditRefused } from "./inspector";
import { addMask, isRefused as isMaskRefused, maskTarget } from "./mask-edit";
import { toObjectSpace } from "./path-edit";
import { isSmooth, snapAngle } from "./path-geometry";

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A point of the path with its two handles, each relative to the point (as the contract's `BezierPath` keeps them). */
export interface PenPoint {
  readonly x: number;
  readonly y: number;
  readonly inX: number;
  readonly inY: number;
  readonly outX: number;
  readonly outY: number;
}

export interface PenState {
  readonly points: readonly PenPoint[];
  readonly closed: boolean;
}

export const EMPTY_PEN: PenState = { points: [], closed: false };

/** A drag shorter than this is a click, and makes a corner point. In canvas pixels. */
export const MIN_PULL = 3;
/** The most points one pen path holds, so a runaway gesture cannot build an enormous shape. */
export const MAX_POINTS = 500;

const tidy = (value: number): number => Math.round(value * 100) / 100;

const corner = (at: Point): PenPoint => ({ x: at.x, y: at.y, inX: 0, inY: 0, outX: 0, outY: 0 });

/** The step Shift holds an angle to, in degrees. After Effects' manual Bezier paths use 15; the spec makes it a policy, so
 *  every function that takes Shift takes the step too and this is only the default. */
export const SHIFT_ANGLE = 15;

/** The point `to` brought to the nearest multiple of `degrees` from `from` (Shift). */
export function constrain(from: Point, to: Point, degrees: number = SHIFT_ANGLE): Point {
  return snapAngle(from, to, degrees);
}

/** Whether `at` is close enough to the first point to close the path on it. `tolerance` is in canvas pixels. */
export function nearFirst(state: PenState, at: Point, tolerance: number): boolean {
  if (state.closed || state.points.length < 3) return false;
  const first = state.points[0]!;
  return Math.hypot(at.x - first.x, at.y - first.y) <= tolerance;
}

/** A new corner point at `at`; with `shift`, held to a multiple of `degrees` from the last point. */
export function addPoint(state: PenState, at: Point, shift = false, degrees: number = SHIFT_ANGLE): PenState {
  if (state.closed || state.points.length >= MAX_POINTS) return state;
  const last = state.points[state.points.length - 1];
  const place = shift && last !== undefined ? constrain(last, at, degrees) : at;
  return { points: [...state.points, corner({ x: tidy(place.x), y: tidy(place.y) })], closed: false };
}

/** The last point's handles pulled to `to`: its outgoing handle follows the pointer and the incoming one is opposite it.
 *  A pull shorter than `MIN_PULL` leaves a corner. */
export interface PullOptions {
  /** Alt: the incoming handle stays where it is and only the outgoing one follows the pointer. */
  readonly alt?: boolean;
  /** Shift: the pulled handle is held to a multiple of `degrees` from its point. */
  readonly shift?: boolean;
  readonly degrees?: number;
}

export function pullHandles(state: PenState, to: Point, options: PullOptions = {}): PenState {
  const index = state.points.length - 1;
  const point = state.points[index];
  if (point === undefined || state.closed) return state;
  const aim = options.shift === true ? constrain(point, to, options.degrees ?? SHIFT_ANGLE) : to;
  const dx = aim.x - point.x;
  const dy = aim.y - point.y;
  if (Math.hypot(dx, dy) < MIN_PULL) return { ...state, points: [...state.points.slice(0, index), corner(point)] };
  const out = { outX: tidy(dx), outY: tidy(dy) };
  const pulled = options.alt === true ? { ...point, ...out } : { ...point, ...out, inX: tidy(-dx), inY: tidy(-dy) };
  return { ...state, points: [...state.points.slice(0, index), pulled] };
}

/** The last point moved by `delta`, its handles with it (Space while placing). */
export function moveLast(state: PenState, delta: Point): PenState {
  const index = state.points.length - 1;
  const point = state.points[index];
  if (point === undefined || state.closed) return state;
  return { ...state, points: [...state.points.slice(0, index), { ...point, x: tidy(point.x + delta.x), y: tidy(point.y + delta.y) }] };
}

/** The first point's handles pulled to `to` as the path closes on it: the way the path leaves the first point, and the way it
 *  arrives (opposite, or only the arriving one with Alt). Closing by a plain click leaves the first point as it was. */
export function closeWithPull(state: PenState, to: Point, options: PullOptions = {}): PenState {
  if (state.points.length < 3) return state;
  const first = state.points[0]!;
  const aim = options.shift === true ? constrain(first, to, options.degrees ?? SHIFT_ANGLE) : to;
  const dx = aim.x - first.x;
  const dy = aim.y - first.y;
  if (Math.hypot(dx, dy) < MIN_PULL) return { ...state, closed: true };
  const arriving = { inX: tidy(-dx), inY: tidy(-dy) };
  const leaving = options.alt === true ? {} : { outX: tidy(dx), outY: tidy(dy) };
  return { points: [{ ...first, ...arriving, ...leaving }, ...state.points.slice(1)], closed: true };
}

/** An open path carried on: the points of `path`, ordered so the new points are added where the author clicked. `fromFirst`
 *  turns the path round first, so clicking its first end extends from there. A closed path cannot be carried on. */
export function resumeState(path: BezierPath, fromFirst: boolean): PenState | undefined {
  if (path.closed || path.vertices.length < 2) return undefined;
  const points: PenPoint[] = path.vertices.map((v, i) => ({
    x: v.x,
    y: v.y,
    inX: path.inTangents[i]!.x,
    inY: path.inTangents[i]!.y,
    outX: path.outTangents[i]!.x,
    outY: path.outTangents[i]!.y,
  }));
  if (!fromFirst) return { points, closed: false };
  return { points: points.reverse().map((p) => ({ ...p, inX: p.outX, inY: p.outY, outX: p.inX, outY: p.inY })), closed: false };
}

/** The edit that puts a carried-on path back into its shape: one `setShapePath`, so one undo step. */
export function resumeEdits(shapeId: string, state: PenState): { readonly edits: readonly SceneEdit[] } | EditRefused {
  const why = cannotFinish(state);
  if (why !== undefined) return { refused: why };
  return { edits: [{ edit: "setShapePath", shapeId, path: toBezier(state), compoundPaths: [] } as SceneEdit] };
}

/** Close the path on its first point. Nothing happens for fewer than three points. */
export function closePath(state: PenState): PenState {
  return state.points.length >= 3 ? { ...state, closed: true } : state;
}

/** Take back the last point; a closed path is opened again first. */
export function removeLast(state: PenState): PenState {
  if (state.closed) return { ...state, closed: false };
  return { points: state.points.slice(0, -1), closed: false };
}

/** Why the path cannot be finished yet, or nothing when it can. */
export function cannotFinish(state: PenState): string | undefined {
  if (state.closed) return state.points.length >= 3 ? undefined : "A closed shape needs at least three points.";
  return state.points.length >= 2 ? undefined : "A path needs at least two points. Click again to add one, or press Escape to drop it.";
}

/** The path as the contract keeps it: every vertex has a stable id from its birth (so the path can be animated later without a
 *  migration) and a kind (smooth when its handles are in line and opposite, a corner otherwise). */
export function toBezier(state: PenState): BezierPath {
  return withIdsAndKinds({
    closed: state.closed,
    vertices: state.points.map((p) => ({ x: p.x, y: p.y })),
    inTangents: state.points.map((p) => ({ x: p.inX, y: p.inY })),
    outTangents: state.points.map((p) => ({ x: p.outX, y: p.outY })),
  });
}

/** `path` with ids 0 to n-1 and the kinds its handles show. */
export function withIdsAndKinds(path: BezierPath): BezierPath {
  return {
    ...path,
    vertexIds: path.vertices.map((_, i) => i),
    vertexKinds: path.vertices.map((_, i) => (isSmooth(path, i) ? ("smooth" as const) : ("corner" as const))),
  };
}

/** The id the engine will give the next shape: the lowest free `shape-N`, as `next_object_id` does. */
export function nextShapeId(document: SceneDocument): string {
  const taken = new Set(document.objects.map((object) => object.id));
  for (let n = 1; ; n += 1) {
    const candidate = `shape-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** The edits that make the path a shape. A closed path keeps the default fill. An open path is a line: its fill is cleared
 *  and it gets a stroke, or it would draw as a filled sliver. All in one batch, so it is one undo step. */
export function penEdits(document: SceneDocument, state: PenState, name: string): { readonly edits: readonly SceneEdit[]; readonly id: string } | EditRefused {
  const why = cannotFinish(state);
  if (why !== undefined) return { refused: why };
  const id = nextShapeId(document);
  const edits: SceneEdit[] = [{ edit: "createShape", name, path: toBezier(state) } as SceneEdit];
  if (!state.closed) {
    edits.push(
      { edit: "setPaint", objectIds: [id], slot: "fill" } as SceneEdit,
      { edit: "setPaint", objectIds: [id], slot: "stroke", paint: { type: "solid", color: { r: 1, g: 1, b: 1, a: 1, space: "srgb" } } } as SceneEdit,
      { edit: "setStroke", objectIds: [id], width: 6, style: { join: "round", cap: "round", miterLimit: 4 } } as unknown as SceneEdit,
    );
  }
  return { edits, id };
}

/** The words for the Activity line and the undo entry. */
export function penLabel(state: PenState, resumed = false): string {
  return `${resumed ? "Carried on" : "Drew"} a ${state.closed ? "closed shape" : "line"} of ${state.points.length} points`;
}

// ---------------------------------------------------------------------------
// What the viewport shows while the path is being drawn
// ---------------------------------------------------------------------------

export interface PenSketch {
  /** The SVG path data of the path so far, and of the segment the pointer would add (`rubber`). */
  readonly d: string;
  readonly rubber?: string;
  /** Each point, and whether it is the first (where the path closes). */
  readonly vertices: readonly { readonly x: number; readonly y: number; readonly first: boolean }[];
  /** Each handle as a line from its point to its end. */
  readonly handles: readonly { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }[];
  /** The pointer is over the first point and a click there closes the path. */
  readonly closing: boolean;
}

const num = (value: number): string => String(tidy(value));

function segment(a: PenPoint, b: PenPoint): string {
  return `C ${num(a.x + a.outX)} ${num(a.y + a.outY)} ${num(b.x + b.inX)} ${num(b.y + b.inY)} ${num(b.x)} ${num(b.y)}`;
}

/** The path so far as the viewport draws it. `cursor` is where the pointer is, for the segment it would add; `closing`
 *  says a click there would close the path. */
export function penSketch(state: PenState, cursor?: Point, closing = false): PenSketch {
  const points = state.points;
  let d = "";
  if (points.length > 0) {
    d = `M ${num(points[0]!.x)} ${num(points[0]!.y)}`;
    for (let i = 1; i < points.length; i += 1) d += ` ${segment(points[i - 1]!, points[i]!)}`;
    if (state.closed && points.length > 1) d += ` ${segment(points[points.length - 1]!, points[0]!)} Z`;
  }
  const last = points[points.length - 1];
  const rubber =
    cursor === undefined || last === undefined || state.closed
      ? undefined
      : `M ${num(last.x)} ${num(last.y)} ${segment(last, corner(cursor))}`;
  return {
    d,
    ...(rubber === undefined ? {} : { rubber }),
    vertices: points.map((p, i) => ({ x: p.x, y: p.y, first: i === 0 })),
    handles: points.flatMap((p) => [
      ...(p.outX !== 0 || p.outY !== 0 ? [{ x1: p.x, y1: p.y, x2: p.x + p.outX, y2: p.y + p.outY }] : []),
      ...(p.inX !== 0 || p.inY !== 0 ? [{ x1: p.x, y1: p.y, x2: p.x + p.inX, y2: p.y + p.inY }] : []),
    ]),
    closing,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// What the Pen makes (11.111, Masking and Pen specs v2, 3.2 and 12): a new shape or a mask on the selected layer.

/** `Tool Creates`: Auto picks from the selection, Shape and Mask are the author's word. */
export type PenCreates = "auto" | "shape" | "mask";

export type PenPlan = { readonly kind: "shape" } | { readonly kind: "mask"; readonly object: SceneObject } | EditRefused;

/** What the next path will be, from the selection, so the page can say it before the first click. Auto makes a mask when one
 *  layer that can take a mask and is not itself a shape is selected, and a shape otherwise. */
export function penPlan(document: SceneDocument, selectedIds: readonly string[], creates: PenCreates): PenPlan {
  if (creates === "shape") return { kind: "shape" };
  const only = selectedIds.length === 1 ? document.objects.find((candidate) => candidate.id === selectedIds[0]) : undefined;
  if (creates === "auto") {
    if (only === undefined || only.type === "shape") return { kind: "shape" };
    const target = maskTarget(document, selectedIds);
    return isMaskRefused(target) ? { kind: "shape" } : { kind: "mask", object: target.object };
  }
  const target = maskTarget(document, selectedIds);
  return isMaskRefused(target) ? { refused: target.refused } : { kind: "mask", object: target.object };
}

/** The words for the line that says what the Pen will make. */
export function penPlanWords(plan: PenPlan): string {
  if ("refused" in plan) return plan.refused;
  return plan.kind === "mask" ? `The Pen will draw a mask on ${plan.object.name}.` : "The Pen will draw a new shape.";
}

/** The path as a mask of `object`: its points taken from the canvas into the object's own space, through its place, turn,
 *  scale and pivot. A mask is a closed path (an open one clips nothing and the engine refuses it), so an open path is told so. */
export function penMaskEdit(document: SceneDocument, state: PenState, object: SceneObject): { readonly edits: readonly SceneEdit[] } | EditRefused {
  if (!state.closed) return { refused: "A mask is a closed path: click the first point to close it, or draw a shape with Pen creates set to Shape." };
  const why = cannotFinish(state);
  if (why !== undefined) return { refused: why };
  const target = maskTarget(document, [object.id]);
  if (isMaskRefused(target)) return { refused: target.refused };
  const placement = effectivePlacement(document, object);
  const vertices = [];
  const inTangents = [];
  const outTangents = [];
  for (const p of state.points) {
    const at = toObjectSpace(placement, { x: p.x, y: p.y });
    const into = toLocalDelta(placement, p.inX, p.inY);
    const out = toLocalDelta(placement, p.outX, p.outY);
    if (at === undefined || into === undefined || out === undefined) return { refused: `${object.name} is scaled to nothing, so a path cannot be put on it.` };
    vertices.push({ x: at.x, y: at.y });
    inTangents.push({ x: into.x, y: into.y });
    outTangents.push({ x: out.x, y: out.y });
  }
  const edit = addMask(target, withIdsAndKinds({ closed: true, vertices, inTangents, outTangents }));
  return isMaskRefused(edit) ? { refused: edit.refused } : { edits: [edit] };
}

/** The words for the Activity line and the undo entry of a mask drawn with the Pen. */
export function penMaskLabel(state: PenState, object: SceneObject): string {
  return `Drew a mask of ${state.points.length} points on ${object.name}`;
}

