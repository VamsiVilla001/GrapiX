/**
 * Keyframes for one row, laid out for drawing rather than for editing.
 *
 * The panel used to derive its visible keys by building one object per key across the whole scene
 * and filtering the result twice — three full passes over every key in the document on every change.
 * At 64,000 keys that is 64,000 allocations and 192,000 predicate calls to draw the few hundred an
 * author can actually see.
 *
 * This is the other shape. Frames live in a sorted `Int32Array`, ids in a parallel array, and the
 * visible run is found by two binary searches. Cost becomes O(log n + visible) instead of O(n), and
 * the frames occupy 4 bytes each instead of an object header.
 *
 * ## Why frames are integers and the array is typed
 *
 * The canonical unit is the integer frame (see `./timelineViewport.ts`), so `Int32Array` is the
 * exact representation rather than a narrowing. It also makes the search branch-predictable and
 * keeps a 100,000-key row inside 400 KB.
 *
 * ## Why ids stay beside the frames
 *
 * Every mutation and every selection in the editor is addressed by keyframe id, and ids must
 * survive a re-sort: moving a key past its neighbour changes its index but not its identity. The
 * index is the drawing coordinate; the id is the thing an author selected.
 */

/** One row's keys, sorted ascending by frame. */
export interface KeyIndex {
  /** Frame of each key, ascending. Parallel to `ids`. */
  readonly frames: Int32Array;
  /** Keyframe id of each key. Parallel to `frames`. */
  readonly ids: readonly string[];
}

const EMPTY: KeyIndex = { frames: new Int32Array(0), ids: [] };

export function emptyKeyIndex(): KeyIndex {
  return EMPTY;
}

/**
 * Build an index from a row's keys.
 *
 * Sorts defensively even though the store keeps channels ordered (`sortPropertyKeys` in
 * `../../store/editorStore.ts`): every search below is a binary search, and a binary search over an
 * unsorted array does not fail loudly — it silently returns the wrong key. Ties break on id so the
 * order is total and a rebuild cannot reshuffle two keys that share a frame.
 */
export function buildKeyIndex(keys: readonly { frame: number; id: string }[]): KeyIndex {
  if (keys.length === 0) return EMPTY;

  const sorted = [...keys].sort((left, right) =>
    left.frame === right.frame ? left.id.localeCompare(right.id) : left.frame - right.frame
  );

  const frames = new Int32Array(sorted.length);
  const ids: string[] = new Array(sorted.length);
  for (let index = 0; index < sorted.length; index += 1) {
    frames[index] = Math.trunc(sorted[index].frame);
    ids[index] = sorted[index].id;
  }
  return { frames, ids };
}

/**
 * First position whose frame is >= `frame`, or `length` when none is.
 *
 * The primitive everything else here is built from. Written out rather than pulled from a helper so
 * the half-open convention is visible at the one place it matters.
 */
export function lowerBound(frames: Int32Array, frame: number): number {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    // `(low + high) >>> 1` rather than `/2`: an int32 midpoint, and no overflow at any length an
    // Int32Array can hold.
    const mid = (low + high) >>> 1;
    if (frames[mid] < frame) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** First position whose frame is > `frame`. */
export function upperBound(frames: Int32Array, frame: number): number {
  let low = 0;
  let high = frames.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (frames[mid] <= frame) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * The half-open run `[start, end)` of keys inside an inclusive frame range.
 *
 * Two binary searches, so the cost of drawing a row depends on how many keys are on screen and not
 * on how many the row holds.
 */
export function visibleSlice(
  index: KeyIndex,
  firstFrame: number,
  lastFrame: number
): { start: number; end: number } {
  if (index.frames.length === 0 || lastFrame < firstFrame) return { start: 0, end: 0 };
  return {
    start: lowerBound(index.frames, firstFrame),
    end: upperBound(index.frames, lastFrame)
  };
}

/**
 * The key nearest `frame` within `toleranceFrames`, or `-1`.
 *
 * The tolerance is a count of frames, so this is the same test at every zoom — see
 * `./timelineViewport.ts`. Both neighbours of the insertion point are considered because the
 * nearest key can be on either side of it, and ties go to the earlier key so a repeated click on
 * a stack of coincident keys is stable rather than alternating.
 */
export function nearestWithin(index: KeyIndex, frame: number, toleranceFrames: number): number {
  const { frames } = index;
  if (frames.length === 0) return -1;

  const at = lowerBound(frames, frame);
  const before = at - 1;
  const after = at;

  const beforeDistance = before >= 0 ? Math.abs(frame - frames[before]) : Number.POSITIVE_INFINITY;
  const afterDistance = after < frames.length ? Math.abs(frames[after] - frame) : Number.POSITIVE_INFINITY;

  const best = beforeDistance <= afterDistance ? before : after;
  const distance = Math.min(beforeDistance, afterDistance);
  return distance <= toleranceFrames ? best : -1;
}

/**
 * Every key index inside an inclusive frame range — the marquee's query.
 *
 * Returns indices rather than ids because the caller is about to draw them; the caller maps to ids
 * only for the keys it actually commits.
 */
export function indicesInRange(index: KeyIndex, fromFrame: number, toFrame: number): number[] {
  const first = Math.min(fromFrame, toFrame);
  const last = Math.max(fromFrame, toFrame);
  const { start, end } = visibleSlice(index, first, last);

  const result: number[] = [];
  for (let position = start; position < end; position += 1) result.push(position);
  return result;
}

/**
 * The positions of the selected ids within this index, for the draw pass.
 *
 * Selection is durably held as a set of keyframe **ids** (`selectedKeyIds` in the panel), not
 * indices, and deliberately: a drag moves keys past one another, which changes every index it
 * crosses while changing no identity. An index-keyed selection would silently transfer itself to
 * whichever key happened to land in that slot.
 *
 * What the requirement is about — selection changing a fill colour rather than the set of things
 * that exist — is satisfied by this: the draw pass takes a `Set<number>` of positions, so a
 * selection change repaints and creates nothing.
 */
export function selectedPositions(index: KeyIndex, selectedIds: ReadonlySet<string>): Set<number> {
  const positions = new Set<number>();
  if (selectedIds.size === 0) return positions;

  for (let position = 0; position < index.ids.length; position += 1) {
    if (selectedIds.has(index.ids[position])) positions.add(position);
  }
  return positions;
}
