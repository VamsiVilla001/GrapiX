// Speed graph: value over time, with curve editing (11.11).
//
// The dope sheet answers "when"; this answers "how". It plots each key's value
// against the frame axis and draws the eased path between them, so an author
// can see an ease-in actually easing rather than inferring it from a label.
//
// **Cost is bounded by the viewport, not the document.** The curve is sampled
// once per visible pixel column, and handles are built only for keys inside
// the visible frame span (found by the same binary search the dope sheet
// uses). A channel with 100,000 keys costs the same to draw as one with ten —
// which is the property 11.10 established and this must not break.
//
// **The curve drawn is the curve rendered.** Sampling goes through `easeAt`,
// the TypeScript mirror pinned against the Rust evaluator's generated
// reference (invariant 27). A preview that eased differently from the engine
// would be worse than no preview.
//
// **The After Effects model (11.68).** A segment's curve is one cubic bezier on
// normalised time and value: `(x1, y1)` is the **outgoing** handle of the key
// the segment starts at, `(x2, y2)` the **incoming** handle of the key it ends
// at. That is After Effects' in and out influence, stored with the segment so a
// saved scene means the same curve when reopened. The graph draws both handles
// and edits either. Two views: the **value graph** (value over time) and the
// **speed graph** (rate of change over time, view only).

import type { CubicBezier, KeyframeChannel, SceneKeyframe } from "@grapix/contracts";

import {
  channelValueRange,
  easeAt,
  segmentControlPoints,
  type ChannelKeys,
} from "./easing";
import { visibleRange, buildKeyIndex } from "./key-index";
import type { DrawingContext } from "./drawing";
import { frameToX, visibleFrames, type TimelineViewport } from "./viewport";

export interface GraphPoint {
  readonly x: number;
  readonly y: number;
}

/// One key as the graph shows it: its position, and the outgoing bezier
/// control handle an author can drag.
export interface GraphKey {
  readonly frame: number;
  readonly value: number;
  readonly at: GraphPoint;
  /// Outgoing control handle position, absent when the key is the last one or
  /// holds (a hold has no curve to shape).
  readonly outHandle?: GraphPoint;
  /// Incoming control handle position (`(x2, y2)` of the segment that ends at
  /// this key), absent for the first key and after a hold.
  readonly inHandle?: GraphPoint;
  /// The frame of the key the incoming segment starts at: the key whose stored
  /// bezier an incoming-handle drag edits.
  readonly inSegment?: number;
}

/// A segment has bezier handles to draw and drag unless it is a hold or one of the easings that are not cubic beziers (Bounce, Elastic):
/// a handle on those would suggest a curve that is not there, and dragging it would silently replace the easing.
function hasBezierHandles(easing: string): boolean {
  return easing !== "hold" && easing !== "bounce" && easing !== "elastic";
}

/// Which handle of a segment is being edited.
export type HandleSide = "out" | "in";

/// What a point on the graph is over. A handle names the frame of the key its
/// segment starts at.
export type GraphHit =
  | { readonly kind: "handle"; readonly segment: number; readonly side: HandleSide }
  | { readonly kind: "key"; readonly frame: number };

/// Which of the two views the graph shows.
export type GraphMode = "value" | "speed";

export interface SpeedGraphModel {
  readonly polyline: readonly GraphPoint[];
  readonly keys: readonly GraphKey[];
  readonly min: number;
  readonly max: number;
  readonly mode: GraphMode;
}

export interface GraphOptions {
  readonly mode?: GraphMode;
  /// Frames per second, for the speed view's unit (value units per second).
  readonly framesPerSecond?: number;
}

/// How far the outgoing handle is drawn from its key, as a fraction of the
/// segment. Purely a display length: the stored curve is the control point,
/// not the pixel distance.
const HANDLE_REACH = 1;

function valueToY(value: number, min: number, max: number, height: number): number {
  if (max === min) return height / 2;
  // Screen Y grows downward; a larger value must sit higher.
  return height - ((value - min) / (max - min)) * height;
}

export function yToValue(y: number, min: number, max: number, height: number): number {
  if (height === 0) return min;
  return min + ((height - y) / height) * (max - min);
}

/// Build the graph for one channel over the visible span.
///
/// Takes the channel's parts rather than a `KeyframeChannel` so a caller can
/// pass the model's borrowed `readonly` key array without copying it.
export function buildSpeedGraph(
  channel: ChannelKeys,
  viewport: TimelineViewport,
  height: number,
  durationFrames: number,
  options: GraphOptions = {},
): SpeedGraphModel {
  const mode = options.mode ?? "value";
  const framesPerSecond = options.framesPerSecond ?? 1;
  const frames = visibleFrames(viewport, durationFrames);
  const polyline: GraphPoint[] = [];
  let { min, max } = channelValueRange(channel);

  // One sample per visible pixel column: the cost of drawing is the width of
  // the viewport, never the number of keys.
  const samples: Array<{ x: number; v: number }> = [];
  if (channel.keys.length > 0 && viewport.pixelsPerFrame > 0) {
    const columns = Math.max(1, Math.ceil(viewport.width));
    for (let column = 0; column <= columns; column += 1) {
      // The exact (fractional) frame under the column, not the nearest whole
      // one: the curve is continuous, and rounding here drew it as a staircase
      // one flat step per frame.
      const frame = viewport.startFrame + column / viewport.pixelsPerFrame;
      const value =
        mode === "value"
          ? evaluateForGraph(channel, frame)
          : speedForGraph(channel, frame, framesPerSecond);
      if (value === undefined) continue;
      samples.push({ x: column, v: value });
    }
  }
  if (mode === "speed") {
    // The speed axis always includes zero (a stop is the thing to see).
    min = Math.min(0, ...samples.map((s) => s.v));
    max = Math.max(0, ...samples.map((s) => s.v));
    if (min === max) max = min + 1;
  }
  for (const sample of samples) {
    polyline.push({ x: sample.x, y: valueToY(sample.v, min, max, height) });
  }

  // Handles only for keys actually on screen, located by binary search. A key's
  // neighbours are read by position in the sorted key array, never by a scan.
  const index = buildKeyIndex(channel.keys);
  const span = visibleRange(index, frames.first, frames.last);
  const keys: GraphKey[] = [];
  for (let position = span.from; position < span.to; position += 1) {
    const key = channel.keys[position];
    if (!key) continue;
    const frame = Number(key.frame);
    const previous = position > 0 ? channel.keys[position - 1] : undefined;
    const next = channel.keys[position + 1];
    if (mode === "speed") {
      const speed = speedForGraph(channel, frame, framesPerSecond) ?? 0;
      keys.push({
        frame,
        value: key.value,
        at: { x: frameToX(viewport, frame), y: valueToY(speed, min, max, height) },
      });
      continue;
    }
    const at = { x: frameToX(viewport, frame), y: valueToY(key.value, min, max, height) };
    keys.push({
      frame,
      value: key.value,
      at,
      ...(next && hasBezierHandles(key.easing)
        ? { outHandle: handlePoint(key, next, "out", viewport, min, max, height) }
        : {}),
      ...(previous && hasBezierHandles(previous.easing)
        ? {
            inHandle: handlePoint(previous, key, "in", viewport, min, max, height),
            inSegment: Number(previous.frame),
          }
        : {}),
    });
  }

  return { polyline, keys, min, max, mode };
}

/// Where a segment's handle is drawn.
///
/// The stored curve is `(x1, y1)` / `(x2, y2)` in the segment's own normalised
/// space, so a handle's position is that point mapped onto the segment's pixel
/// box. Drag it and the inverse gives the new control point back.
function handlePoint(
  from: SceneKeyframe,
  to: SceneKeyframe,
  side: HandleSide,
  viewport: TimelineViewport,
  min: number,
  max: number,
  height: number,
): GraphPoint {
  const points = segmentControlPoints(from);
  const [cx, cy] = side === "out" ? [points.x1, points.y1] : [points.x2, points.y2];
  const fromFrame = Number(from.frame);
  const frameSpan = Number(to.frame) - fromFrame;
  const valueSpan = to.value - from.value;
  const frame = fromFrame + cx * frameSpan * HANDLE_REACH;
  const value = from.value + cy * valueSpan * HANDLE_REACH;
  return { x: frameToX(viewport, frame), y: valueToY(value, min, max, height) };
}

/// The control point a dragged handle implies.
///
/// The inverse of `handlePoint`. The time control (`x1` or `x2`) is clamped to
/// 0-1 because the contract refuses anything else (`validate_key`); the value
/// control is left free, because overshoot is a legitimate effect. The other
/// handle of the segment is kept as it was, so editing one side never moves the
/// other.
export function bezierFromHandleDrag(
  key: SceneKeyframe,
  next: SceneKeyframe,
  handle: GraphPoint,
  viewport: TimelineViewport,
  min: number,
  max: number,
  height: number,
  side: HandleSide = "out",
): CubicBezier {
  const existing = segmentControlPoints(key);
  const fromFrame = Number(key.frame);
  const frameSpan = Number(next.frame) - fromFrame;
  const valueSpan = next.value - key.value;
  const [currentX, currentY] =
    side === "out" ? [existing.x1, existing.y1] : [existing.x2, existing.y2];

  // The exact position, not `xToFrame`'s nearest whole frame: a handle is a
  // control point on a continuous curve, and rounding it to a frame would make
  // a 100-frame segment's influence move in 1% steps.
  const frame = viewport.pixelsPerFrame > 0 ? viewport.startFrame + handle.x / viewport.pixelsPerFrame : viewport.startFrame;
  const value = yToValue(handle.y, min, max, height);
  const rawX = frameSpan === 0 ? currentX : (frame - fromFrame) / frameSpan / HANDLE_REACH;
  const rawY = valueSpan === 0 ? currentY : (value - key.value) / valueSpan / HANDLE_REACH;
  const cx = Math.min(1, Math.max(0, rawX));
  const cy = Number.isFinite(rawY) ? rawY : currentY;

  return side === "out"
    ? { x1: cx, y1: cy, x2: existing.x2, y2: existing.y2 }
    : { x1: existing.x1, y1: existing.y1, x2: cx, y2: cy };
}

/// Pixels a handle must be from its own key to be grabbed as a handle. A linear
/// segment's handles sit on their keys; they are not offered until the segment
/// has a curve (After Effects does the same: Easy Ease first, then drag).
export const HANDLE_GRAB_MIN_PX = 4;

/// What is under a point: a handle first, then a key. `radius` is the pointer
/// tolerance in pixels. Pure over the built model.
export function hitGraph(
  model: SpeedGraphModel,
  x: number,
  y: number,
  radius = 7,
): GraphHit | undefined {
  let best: { hit: GraphHit; distance: number } | undefined;
  const consider = (hit: GraphHit, point: GraphPoint): void => {
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance <= radius && (best === undefined || distance < best.distance)) {
      best = { hit, distance };
    }
  };
  const apart = (a: GraphPoint, b: GraphPoint): boolean =>
    Math.hypot(a.x - b.x, a.y - b.y) > HANDLE_GRAB_MIN_PX;
  for (const key of model.keys) {
    if (key.outHandle && apart(key.outHandle, key.at)) {
      consider({ kind: "handle", segment: key.frame, side: "out" }, key.outHandle);
    }
    if (key.inHandle && key.inSegment !== undefined && apart(key.inHandle, key.at)) {
      consider({ kind: "handle", segment: key.inSegment, side: "in" }, key.inHandle);
    }
  }
  if (best) return (best as { hit: GraphHit }).hit;
  for (const key of model.keys) consider({ kind: "key", frame: key.frame }, key.at);
  return (best as { hit: GraphHit } | undefined)?.hit;
}

/// The keys with one segment's curve replaced by a draft (a drag in progress),
/// so the graph can show the curve under the pointer before anything is saved.
export function withDraftBezier(
  keys: readonly SceneKeyframe[],
  segment: number,
  bezier: CubicBezier,
): readonly SceneKeyframe[] {
  return keys.map((key) =>
    Number(key.frame) === segment ? { ...key, easing: "custom-bezier" as const, bezier } : key,
  );
}

/// Evaluate for drawing. Separate from `evaluateChannel` only so the graph can
/// be sampled at a frame outside the keyed range without special-casing.
function evaluateForGraph(channel: ChannelKeys, frame: number): number | undefined {
  const keys = channel.keys;
  if (keys.length === 0) return undefined;
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  if (frame <= Number(first.frame)) return first.value;
  if (frame >= Number(last.frame)) return last.value;

  let low = 0;
  let high = keys.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (Number(keys[mid]!.frame) <= frame) low = mid + 1;
    else high = mid;
  }
  const from = keys[low - 1]!;
  const to = keys[low]!;
  const span = Number(to.frame) - Number(from.frame);
  if (span === 0) return from.value;
  const t = (frame - Number(from.frame)) / span;
  return from.value + (to.value - from.value) * easeAt(from.easing, from.bezier, t);
}

/// Rate of change at `frame`, in value units per second: a central difference
/// over half a frame either side, through the same evaluator the value graph
/// uses. Constant (zero) outside the keyed range.
function speedForGraph(
  channel: ChannelKeys,
  frame: number,
  framesPerSecond: number,
): number | undefined {
  if (channel.keys.length === 0) return undefined;
  const half = 0.5;
  const before = evaluateForGraph(channel, frame - half);
  const after = evaluateForGraph(channel, frame + half);
  if (before === undefined || after === undefined) return undefined;
  return (after - before) * framesPerSecond;
}

export interface SpeedGraphTheme {
  readonly curve: string;
  readonly key: string;
  readonly handle: string;
}

/// A canvas cannot read CSS variables, so these are the SKWAD live values
/// (`Editor/web/skwad.css`): the curve is the interface ember, keys are ink, and
/// handles are the warning amber, so a handle never reads as the curve.
export const DEFAULT_GRAPH_THEME: SpeedGraphTheme = {
  curve: "#F58138",
  key: "#F2F0EB",
  handle: "#DDA543",
};

export const GRAPH_KEY_RADIUS_PX = 3.5;

/// Draw the graph on a layer. Content only: the playhead stays on the
/// interaction layer, which is what keeps a scrub off this path entirely.
export function paintSpeedGraph(
  context: DrawingContext,
  model: SpeedGraphModel,
  theme: SpeedGraphTheme = DEFAULT_GRAPH_THEME,
): void {
  if (model.polyline.length > 1) {
    context.strokeStyle = theme.curve;
    context.lineWidth = 1.5;
    context.beginPath();
    const [head, ...rest] = model.polyline;
    context.moveTo(head!.x, head!.y);
    for (const point of rest) context.lineTo(point.x, point.y);
    context.stroke();
  }

  for (const key of model.keys) {
    if (key.outHandle) {
      context.strokeStyle = theme.handle;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(key.at.x, key.at.y);
      context.lineTo(key.outHandle.x, key.outHandle.y);
      context.stroke();
      context.fillStyle = theme.handle;
      context.fillRect(key.outHandle.x - 2.5, key.outHandle.y - 2.5, 5, 5);
    }
    if (key.inHandle) {
      context.strokeStyle = theme.handle;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(key.at.x, key.at.y);
      context.lineTo(key.inHandle.x, key.inHandle.y);
      context.stroke();
      context.fillStyle = theme.handle;
      context.fillRect(key.inHandle.x - 2.5, key.inHandle.y - 2.5, 5, 5);
    }
    context.fillStyle = theme.key;
    context.beginPath();
    context.moveTo(key.at.x, key.at.y - GRAPH_KEY_RADIUS_PX);
    context.lineTo(key.at.x + GRAPH_KEY_RADIUS_PX, key.at.y);
    context.lineTo(key.at.x, key.at.y + GRAPH_KEY_RADIUS_PX);
    context.lineTo(key.at.x - GRAPH_KEY_RADIUS_PX, key.at.y);
    context.closePath();
    context.fill();
  }
}
