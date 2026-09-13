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

import type { CubicBezier, KeyframeChannel, SceneKeyframe } from "@grapix/contracts";

import { channelValueRange, easeAt, easingControlPoints, type ChannelKeys } from "./easing";
import { visibleRange, buildKeyIndex } from "./key-index";
import type { DrawingContext } from "./drawing";
import { frameToX, visibleFrames, xToFrame, type TimelineViewport } from "./viewport";

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
}

export interface SpeedGraphModel {
  readonly polyline: readonly GraphPoint[];
  readonly keys: readonly GraphKey[];
  readonly min: number;
  readonly max: number;
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
): SpeedGraphModel {
  const { min, max } = channelValueRange(channel);
  const frames = visibleFrames(viewport, durationFrames);
  const polyline: GraphPoint[] = [];

  if (channel.keys.length > 0 && viewport.pixelsPerFrame > 0) {
    // One sample per visible pixel column: the cost of drawing is the width of
    // the viewport, never the number of keys.
    const columns = Math.max(1, Math.ceil(viewport.width));
    for (let column = 0; column <= columns; column += 1) {
      const frame = xToFrame(viewport, column);
      const value = evaluateForGraph(channel, frame);
      if (value === undefined) continue;
      polyline.push({ x: column, y: valueToY(value, min, max, height) });
    }
  }

  // Handles only for keys actually on screen, located by binary search.
  const index = buildKeyIndex(channel.keys);
  const span = visibleRange(index, frames.first, frames.last);
  const byFrame = new Map(channel.keys.map((key) => [Number(key.frame), key]));
  const keys: GraphKey[] = [];
  for (let position = span.from; position < span.to; position += 1) {
    const frame = index.frames[position]!;
    const key = byFrame.get(frame);
    if (!key) continue;
    const at = { x: frameToX(viewport, frame), y: valueToY(key.value, min, max, height) };
    const next = nextKeyAfter(channel.keys, frame);
    keys.push({
      frame,
      value: key.value,
      at,
      ...(next && key.easing !== "hold"
        ? { outHandle: outHandlePoint(key, next, viewport, min, max, height) }
        : {}),
    });
  }

  return { polyline, keys, min, max };
}

function nextKeyAfter(
  keys: readonly SceneKeyframe[],
  frame: number,
): SceneKeyframe | undefined {
  let best: SceneKeyframe | undefined;
  for (const key of keys) {
    const at = Number(key.frame);
    if (at > frame && (best === undefined || at < Number(best.frame))) best = key;
  }
  return best;
}

/// Where the outgoing control handle is drawn.
///
/// The stored curve is `(x1, y1)` in the segment's own normalised space, so
/// the handle position is that point mapped onto the segment's pixel box. Drag
/// it and the inverse gives the new control point back.
function outHandlePoint(
  key: SceneKeyframe,
  next: SceneKeyframe,
  viewport: TimelineViewport,
  min: number,
  max: number,
  height: number,
): GraphPoint {
  const points =
    key.easing === "custom-bezier"
      ? (key.bezier ?? easingControlPoints("linear"))
      : easingControlPoints(key.easing);
  const fromFrame = Number(key.frame);
  const toFrame = Number(next.frame);
  const frameSpan = toFrame - fromFrame;
  const valueSpan = next.value - key.value;
  const frame = fromFrame + points.x1 * frameSpan * HANDLE_REACH;
  const value = key.value + points.y1 * valueSpan * HANDLE_REACH;
  return { x: frameToX(viewport, frame), y: valueToY(value, min, max, height) };
}

/// The control point a dragged handle implies.
///
/// The inverse of `outHandlePoint`. `x1` is clamped to 0–1 because it is a
/// time control and the contract refuses anything else (`validate_key`);
/// `y1` is left free, because overshoot is a legitimate effect.
export function bezierFromHandleDrag(
  key: SceneKeyframe,
  next: SceneKeyframe,
  handle: GraphPoint,
  viewport: TimelineViewport,
  min: number,
  max: number,
  height: number,
): CubicBezier {
  const existing =
    key.easing === "custom-bezier"
      ? (key.bezier ?? easingControlPoints("linear"))
      : easingControlPoints(key.easing);
  const fromFrame = Number(key.frame);
  const frameSpan = Number(next.frame) - fromFrame;
  const valueSpan = next.value - key.value;

  const frame = xToFrame(viewport, handle.x);
  const value = yToValue(handle.y, min, max, height);
  const x1 = frameSpan === 0 ? existing.x1 : (frame - fromFrame) / frameSpan / HANDLE_REACH;
  const y1 = valueSpan === 0 ? existing.y1 : (value - key.value) / valueSpan / HANDLE_REACH;

  return {
    x1: Math.min(1, Math.max(0, x1)),
    y1: Number.isFinite(y1) ? y1 : existing.y1,
    x2: existing.x2,
    y2: existing.y2,
  };
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

export interface SpeedGraphTheme {
  readonly curve: string;
  readonly key: string;
  readonly handle: string;
}

export const DEFAULT_GRAPH_THEME: SpeedGraphTheme = {
  curve: "#58b8ef",
  key: "#f5fbff",
  handle: "#d89a34",
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
