// Snapping for the Pen and the path tools (11.110; Pen spec v2, section 9).
//
// A point being placed or dragged snaps to the canvas edges and centre, to the edges and centres of the other layers, and to
// the vertices of other shapes (and of its own path), on each axis alone. The threshold is in SCREEN pixels, so it is the same
// at every zoom: a snap is taken at 7 pixels and held until the pointer is 11 away, so it does not flicker at the edge of its
// reach. The source of a snap is named, and an explicit guide outranks a generic line.
//
// Pure: the page feeds it the document, the point and what it held last time, and draws the guides it returns.

import type { SceneDocument, SceneObject } from "@grapix/contracts";

import { effectivePlacement } from "./anchor-point";
import type { OverlayGuide } from "./overlay";
import { objectOverlayBounds } from "./overlay";
import { toCanvas } from "./path-edit";
import { cubicsOf, mapCubic, nearestOnCubic, type Cubic } from "./path-geometry";

/** The screen distance at which a snap is taken, and at which a held snap is let go. */
export const SNAP_IN = 7;
export const SNAP_OUT = 11;

export interface Pt {
  readonly x: number;
  readonly y: number;
}

/** A value on one axis a point can take, and what it is. Lower `priority` wins a tie. */
export interface AxisTarget {
  readonly value: number;
  readonly label: string;
  readonly priority: number;
}

/** A curve of another shape, on the canvas, a point can snap onto (the spec's "other vector anchors/segments"). */
export interface CurveTarget {
  readonly id: string;
  readonly label: string;
  readonly cubics: readonly Cubic[];
}

export interface SnapTargets {
  readonly x: readonly AxisTarget[];
  readonly y: readonly AxisTarget[];
  /** The curves of the other shapes. A point that snaps to no line or vertex may snap onto the nearest of these. */
  readonly curves?: readonly CurveTarget[];
}

/** What the last snap held, per axis, so it can be kept until the pointer is 11 away. */
export interface SnapHold {
  readonly x?: AxisTarget;
  readonly y?: AxisTarget;
  /** The curve a point was snapped onto, so it is kept until the pointer is 11 screen pixels from it. */
  readonly curve?: string;
}

export interface SnapResult {
  readonly point: Pt;
  readonly hold: SnapHold;
  /** The guides to draw: one line per axis that snapped, with the source named. */
  readonly guides: readonly OverlayGuide[];
}

const CANVAS_X = (width: number): AxisTarget[] => [
  { value: 0, label: "Canvas edge", priority: 3 },
  { value: width / 2, label: "Canvas centre", priority: 3 },
  { value: width, label: "Canvas edge", priority: 3 },
];
const CANVAS_Y = (height: number): AxisTarget[] => [
  { value: 0, label: "Canvas edge", priority: 3 },
  { value: height / 2, label: "Canvas centre", priority: 3 },
  { value: height, label: "Canvas edge", priority: 3 },
];

/** Everything a point may snap to: the canvas, the other layers' bounds, and the vertices of other shapes. `own` are points of
 *  the path being edited that are not moving (its other vertices). */
export function snapTargets(document: SceneDocument, except: ReadonlySet<string>, own: readonly Pt[] = []): SnapTargets {
  const x: AxisTarget[] = CANVAS_X(document.canvas.width);
  const y: AxisTarget[] = CANVAS_Y(document.canvas.height);
  const curves: CurveTarget[] = [];
  // An explicit guide outranks every generic line (the Pen spec's snapping order): a lower priority number wins a tie.
  for (const guide of document.guides ?? []) {
    (guide.axis === "x" ? x : y).push({ value: guide.position, label: `Guide ${guide.id}`, priority: -1 });
  }
  for (const object of document.objects) {
    if (except.has(object.id) || object.type === "group" || object.type === "layer" || object.type === "camera" || object.type === "marker") continue;
    const bounds = objectOverlayBounds(object);
    if (bounds.width > 0 || bounds.height > 0) {
      x.push(
        { value: bounds.x, label: `${object.name} edge`, priority: 2 },
        { value: bounds.x + bounds.width / 2, label: `${object.name} centre`, priority: 2 },
        { value: bounds.x + bounds.width, label: `${object.name} edge`, priority: 2 },
      );
      y.push(
        { value: bounds.y, label: `${object.name} edge`, priority: 2 },
        { value: bounds.y + bounds.height / 2, label: `${object.name} centre`, priority: 2 },
        { value: bounds.y + bounds.height, label: `${object.name} edge`, priority: 2 },
      );
    }
    if (object.type === "shape") {
      const placement = effectivePlacement(document, object);
      for (const v of object.path.vertices) {
        const p = toCanvas(placement, v);
        x.push({ value: p.x, label: `${object.name} vertex`, priority: 1 });
        y.push({ value: p.y, label: `${object.name} vertex`, priority: 1 });
      }
      const onCanvas = (q: Pt) => toCanvas(placement, q);
      for (const [index, path] of [object.path, ...(object.compoundPaths ?? [])].entries()) {
        curves.push({ id: `${object.id}/${index}`, label: `${object.name} curve`, cubics: cubicsOf(path).map((c) => mapCubic(c, onCanvas)) });
      }
    }
  }
  for (const p of own) {
    x.push({ value: p.x, label: "Vertex", priority: 0 });
    y.push({ value: p.y, label: "Vertex", priority: 0 });
  }
  return { x, y, curves };
}

/** The nearest point of `curve` to `point` no further than `reach` (canvas pixels), with its distance. */
function nearestOn(curve: CurveTarget, point: Pt, reach: number): { readonly point: Pt; readonly distance: number } | undefined {
  let best: { point: Pt; distance: number } | undefined;
  for (const c of curve.cubics) {
    // A curve lies inside the box of its control points: one whose box is further than the reach (or than the best so far) is skipped.
    const limit = Math.min(reach, best?.distance ?? reach);
    const minX = Math.min(c.p0.x, c.p1.x, c.p2.x, c.p3.x), maxX = Math.max(c.p0.x, c.p1.x, c.p2.x, c.p3.x);
    const minY = Math.min(c.p0.y, c.p1.y, c.p2.y, c.p3.y), maxY = Math.max(c.p0.y, c.p1.y, c.p2.y, c.p3.y);
    if (point.x < minX - limit || point.x > maxX + limit || point.y < minY - limit || point.y > maxY + limit) continue;
    const found = nearestOnCubic(c, point);
    if (found.distance <= reach && (best === undefined || found.distance < best.distance)) best = { point: found.point, distance: found.distance };
  }
  return best;
}

/** The point on the nearest curve within the snap reach of `point`, keeping the held curve until it is let go (11 pixels). */
function curveSnap(point: Pt, curves: readonly CurveTarget[], held: string | undefined, unit: number): { readonly id: string; readonly label: string; readonly point: Pt } | undefined {
  if (held !== undefined) {
    const curve = curves.find((c) => c.id === held);
    const kept = curve === undefined ? undefined : nearestOn(curve, point, SNAP_OUT * unit);
    if (curve !== undefined && kept !== undefined) return { id: curve.id, label: curve.label, point: kept.point };
  }
  let best: { id: string; label: string; point: Pt; distance: number } | undefined;
  for (const curve of curves) {
    const found = nearestOn(curve, point, SNAP_IN * unit);
    if (found !== undefined && (best === undefined || found.distance < best.distance)) best = { id: curve.id, label: curve.label, point: found.point, distance: found.distance };
  }
  return best === undefined ? undefined : { id: best.id, label: best.label, point: best.point };
}

/** The target to snap one coordinate to: the held one while it is within `out`, else the nearest within `in` (ties go to the
 *  lower priority number). Distances are in canvas pixels; `unit` is canvas pixels per screen pixel. */
function pick(value: number, targets: readonly AxisTarget[], held: AxisTarget | undefined, unit: number): AxisTarget | undefined {
  if (held !== undefined && Math.abs(held.value - value) <= SNAP_OUT * unit) return held;
  let best: AxisTarget | undefined;
  let bestDistance = SNAP_IN * unit;
  for (const target of targets) {
    const distance = Math.abs(target.value - value);
    if (distance > SNAP_IN * unit) continue;
    if (best === undefined || distance < bestDistance - 1e-9 || (Math.abs(distance - bestDistance) <= 1e-9 && target.priority < best.priority)) {
      best = target;
      bestDistance = distance;
    }
  }
  return best;
}

/** `point` snapped, each axis on its own. `disabled` (a held modifier, or the setting off) returns it as it is and lets go. */
export function snapPoint(point: Pt, targets: SnapTargets, hold: SnapHold, unit: number, disabled = false): SnapResult {
  if (disabled || !(unit > 0)) return { point, hold: {}, guides: [] };
  const tx = pick(point.x, targets.x, hold.x, unit);
  const ty = pick(point.y, targets.y, hold.y, unit);
  // A point that snapped to no line or vertex may snap onto a curve of another shape (the Pen spec's "other segments"): the line
  // and vertex snaps win, because they are what an author lines up with.
  if (tx === undefined && ty === undefined && targets.curves !== undefined && targets.curves.length > 0) {
    const onCurve = curveSnap(point, targets.curves, hold.curve, unit);
    if (onCurve !== undefined) {
      return {
        point: onCurve.point,
        hold: { curve: onCurve.id },
        guides: [
          { axis: "x", position: onCurve.point.x, label: onCurve.label },
          { axis: "y", position: onCurve.point.y, label: onCurve.label },
        ],
      };
    }
  }
  const guides: OverlayGuide[] = [];
  if (tx !== undefined) guides.push({ axis: "x", position: tx.value, label: tx.label });
  if (ty !== undefined) guides.push({ axis: "y", position: ty.value, label: ty.label });
  return {
    point: { x: tx?.value ?? point.x, y: ty?.value ?? point.y },
    hold: { ...(tx === undefined ? {} : { x: tx }), ...(ty === undefined ? {} : { y: ty }) },
    guides,
  };
}

/** The ids a snap ignores while `object` is edited: the object itself. */
export const exceptObject = (object: SceneObject): ReadonlySet<string> => new Set([object.id]);
