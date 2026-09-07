/**
 * The timeline's time model and its frame/pixel viewport.
 *
 * Everything else in the timeline is built on this, so it is deliberately small, pure and
 * exhaustively tested. Three rules, and the rest follows:
 *
 * 1. **The integer frame index is the canonical unit.** Positions, hit-tests, selections, drags and
 *    the visible range are all integer frames. Nothing downstream stores a time in seconds.
 *
 * 2. **The rate belongs to the scene, never to the timeline.** `timelineFrameRate` derives it per
 *    call from the open document — the exact `SceneTimeline.frameRate` when the document carries
 *    one, or `rationalFromDecimal(fps)` for a legacy document that does not. Caching it here would
 *    let a rate change leave a stale copy behind, and hardcoding one would be worse.
 *
 * 3. **Seconds are a display conversion and nothing else.** They are computed from a frame index on
 *    demand, never accumulated. Treating 59.94 as its decimal rather than 60000/1001 drifts about
 *    0.216 frames per hour — 0.1 frames over 100,000 frames, and past a frame and a half across an
 *    eight-hour day. So the conversion goes through the same truncating bigint arithmetic the
 *    render engine uses (`exactDeadlineNanos`, mirroring `FrameRate::deadline_nanos` in
 *    `services/render-engine/src/stage.rs`).
 *
 * ## Why the hit tolerance is in frames
 *
 * A pixel tolerance converted to frames changes meaning with zoom: the same gesture selects one key
 * zoomed in and four zoomed out, so a drag that felt precise becomes destructive at a different
 * magnification. A tolerance stated in frames is the same tolerance everywhere. The cost is
 * accepted deliberately: zoomed far out, keys closer together than the tolerance cannot be picked
 * apart, which is a legible limit rather than a surprise.
 */

import { rationalFromDecimal } from "@grapix/animation-engine";
import {
  exactDeadlineNanos,
  type RationalFrameRate,
  type SceneTimeline
} from "@grapix/shared-types";

/**
 * How close, in frames, a pointer must be to a key to hit it.
 *
 * Invariant under zoom by construction — it is a count of frames, not a distance converted into
 * one. See the module comment for the trade this makes.
 */
export const HIT_TOLERANCE_FRAMES = 3;

const NANOS_PER_SECOND_EXACT = 1_000_000_000n;

/**
 * The scene's exact rate, derived rather than stored.
 *
 * `SceneTimeline.frameRate` is authoritative when present. A legacy document carries only the
 * decimal `fps`, where 29.97 is really 29.97002997…, so `rationalFromDecimal` recognises the
 * drop-frame family by proximity instead of equality.
 */
export function timelineFrameRate(timeline: Pick<SceneTimeline, "fps" | "frameRate">): RationalFrameRate {
  const declared = timeline.frameRate;
  if (
    declared
    && Number.isSafeInteger(declared.numerator)
    && Number.isSafeInteger(declared.denominator)
    && declared.numerator > 0
    && declared.denominator > 0
  ) {
    return declared;
  }
  return rationalFromDecimal(timeline.fps);
}

/**
 * A frame's absolute time in nanoseconds.
 *
 * Truncating bigint division, computed from the frame number every time rather than accumulated.
 * Shared with the engine so a frame means the same instant on both sides.
 */
export function frameToNanos(rate: RationalFrameRate, frame: number): number {
  return exactDeadlineNanos(rate, Math.max(0, Math.trunc(frame)));
}

/**
 * The exact inverse of `frameToNanos`.
 *
 * Rounds to the nearest frame, and must. `frameToNanos` truncates, so its result sits up to one
 * nanosecond *below* the frame's exact instant; scaling that back lands a hair under an integer,
 * and flooring it would return `frame - 1` for every frame. That is not a rounding preference, it
 * is what makes the round trip close — the first version of this floored and reported frame 1 at
 * 23.976 as frame 0.
 *
 * Note the consequence: this answers "which frame is this instant nearest", not "which frame
 * contains it". Nothing in the timeline needs the latter, because positions are carried as frame
 * indices and only converted for display.
 */
export function nanosToFrame(rate: RationalFrameRate, nanos: number): number {
  if (!(nanos > 0)) return 0;
  const scaled = BigInt(Math.trunc(nanos)) * BigInt(rate.numerator);
  const divisor = NANOS_PER_SECOND_EXACT * BigInt(rate.denominator);
  // Round-half-up in integers: floor((scaled + divisor/2) / divisor), without a division that
  // could lose the half.
  return Number((scaled * 2n + divisor) / (divisor * 2n));
}

/** A frame's time in seconds. **Display only** — never feed this back into a position. */
export function frameToSeconds(rate: RationalFrameRate, frame: number): number {
  return frameToNanos(rate, frame) / 1_000_000_000;
}

/** The frame containing a time in seconds. The inverse of `frameToSeconds` for whole frames. */
export function secondsToFrame(rate: RationalFrameRate, seconds: number): number {
  return nanosToFrame(rate, Math.round(seconds * 1_000_000_000));
}

/**
 * The window of the timeline currently drawn.
 *
 * `startFrame` is an integer because the canonical unit is an integer frame; sub-frame panning
 * would put every key on a fractional pixel and make the ruler disagree with the keys it labels.
 * Horizontal position is `(frame - startFrame) * pixelsPerFrame`, which is what makes both
 * conversions below pure arithmetic with no dependence on the rate.
 */
export interface TimelineViewport {
  /** Leftmost visible frame. Integer. */
  startFrame: number;
  /** CSS pixels per frame. Positive; zoom is expressed entirely through this. */
  pixelsPerFrame: number;
  /** Width of the track area in CSS pixels. */
  width: number;
}

export function createViewport(
  startFrame: number,
  pixelsPerFrame: number,
  width: number
): TimelineViewport {
  return {
    startFrame: Math.max(0, Math.trunc(startFrame)),
    // A non-positive scale would divide by zero on the way back and collapse every key onto one
    // pixel on the way out. Clamped rather than refused: a zero-width panel is a normal transient
    // during layout, not an error worth throwing from a pure function.
    pixelsPerFrame: pixelsPerFrame > 0 ? pixelsPerFrame : 1,
    width: Math.max(0, width)
  };
}

/** X of a frame, in CSS pixels relative to the track area's left edge. */
export function frameToX(viewport: TimelineViewport, frame: number): number {
  return (frame - viewport.startFrame) * viewport.pixelsPerFrame;
}

/**
 * The frame at an X, rounded to the nearest whole frame.
 *
 * Rounding rather than flooring: the author is pointing at the nearest key, and flooring biases
 * every pick and every drag half a frame to the left.
 */
export function xToFrame(viewport: TimelineViewport, x: number): number {
  return Math.round(x / viewport.pixelsPerFrame) + viewport.startFrame;
}

/**
 * The inclusive frame range the viewport covers, clamped to the timeline.
 *
 * One frame of margin either side so a key whose marker straddles an edge is still drawn; a marker
 * has width, and a range computed from its centre alone clips it as it leaves.
 */
export function visibleFrameRange(
  viewport: TimelineViewport,
  durationFrames: number
): { first: number; last: number } {
  const span = Math.ceil(viewport.width / viewport.pixelsPerFrame);
  return {
    first: Math.max(0, viewport.startFrame - 1),
    last: Math.min(Math.max(0, durationFrames), viewport.startFrame + span + 1)
  };
}

/**
 * Whether a pointer at `pointerFrame` hits a key at `keyFrame`.
 *
 * The whole hit-test, in frame space. No element lookup, no bounding boxes, no dependence on the
 * current zoom.
 */
export function hitsFrame(pointerFrame: number, keyFrame: number): boolean {
  return Math.abs(pointerFrame - keyFrame) <= HIT_TOLERANCE_FRAMES;
}
