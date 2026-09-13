// One channel's keys, laid out for drawing rather than for editing (11.10).
//
// The panel in `keyframe-editor.ts` derives its rows by mapping over channels
// and filtering — fine for the inspector's twelve properties, ruinous for a
// timeline. Deriving visible keys by building one object per key and filtering
// is a full pass over every key in the document on every repaint: at 100,000
// keys that is 100,000 allocations to draw the few hundred an author can see.
//
// This is the other shape. Frames live in a sorted `Int32Array` and the visible
// run is found by two binary searches, so cost is O(log n + visible) rather
// than O(n), and a 100,000-key channel occupies 400 KB rather than 100,000
// object headers.
//
// **A key is identified by its frame.** `SceneKeyframe` carries no id, and it
// does not need one: `move_keyframe` in `gx_contracts::animation` refuses a
// move onto an occupied frame, so a frame is unique within a channel by
// contract. The index therefore stores frames alone, and identity is
// (objectId, property, frame).

import type { SceneKeyframe } from "@grapix/contracts";

/// One channel's key frames, sorted ascending.
export interface KeyIndex {
  readonly frames: Int32Array;
}

const EMPTY: KeyIndex = { frames: new Int32Array(0) };

export function emptyKeyIndex(): KeyIndex {
  return EMPTY;
}

/// Build an index from a channel's keys.
///
/// Sorts defensively even though the contract's `set_keyframe` keeps channels
/// ordered: every lookup below is a binary search, and a binary search over an
/// unsorted array does not fail loudly — it silently returns the wrong key.
export function buildKeyIndex(keys: readonly SceneKeyframe[]): KeyIndex {
  if (keys.length === 0) return EMPTY;
  const frames = new Int32Array(keys.length);
  for (let index = 0; index < keys.length; index += 1) {
    frames[index] = Math.trunc(Number(keys[index]!.frame));
  }
  frames.sort();
  return { frames };
}

/// First position whose frame is >= `frame`, or `length` when none is.
///
/// The primitive the rest is built from, written out rather than borrowed so
/// the half-open convention is visible where it matters.
export function lowerBound(frames: Int32Array, frame: number): number {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    // `>>> 1` rather than `/ 2`: an int32 midpoint that cannot overflow at any
    // length an Int32Array can hold.
    const mid = (low + high) >>> 1;
    if (frames[mid]! < frame) low = mid + 1;
    else high = mid;
  }
  return low;
}

/// First position whose frame is > `frame`.
export function upperBound(frames: Int32Array, frame: number): number {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (frames[mid]! <= frame) low = mid + 1;
    else high = mid;
  }
  return low;
}

/// The half-open index range `[from, to)` of keys within an inclusive frame
/// span. This is what makes drawing proportional to what is visible.
export function visibleRange(
  index: KeyIndex,
  firstFrame: number,
  lastFrame: number,
): { readonly from: number; readonly to: number } {
  if (lastFrame < firstFrame) return { from: 0, to: 0 };
  return {
    from: lowerBound(index.frames, firstFrame),
    to: upperBound(index.frames, lastFrame),
  };
}

/// How many keys fall inside an inclusive frame span.
export function countInSpan(index: KeyIndex, firstFrame: number, lastFrame: number): number {
  const { from, to } = visibleRange(index, firstFrame, lastFrame);
  return to - from;
}

/// The key nearest `frame` within `tolerance` frames, or `undefined`.
///
/// The tolerance is in **frames, not pixels**, and deliberately: a pixel
/// tolerance converted to frames changes meaning with zoom, so the same
/// gesture picks one key zoomed in and four zoomed out. A gesture that felt
/// precise would become destructive at a different magnification.
export function keyNear(
  index: KeyIndex,
  frame: number,
  tolerance: number,
): number | undefined {
  const { frames } = index;
  if (frames.length === 0) return undefined;

  const at = lowerBound(frames, frame);
  let best: number | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  // Only the two neighbours can be nearest in a sorted array.
  for (const candidate of [at - 1, at]) {
    if (candidate < 0 || candidate >= frames.length) continue;
    const distance = Math.abs(frames[candidate]! - frame);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = frames[candidate]!;
    }
  }
  return bestDistance <= tolerance ? best : undefined;
}

/// How close, in frames, a pointer must be to a key to hit it.
export const HIT_TOLERANCE_FRAMES = 3;
