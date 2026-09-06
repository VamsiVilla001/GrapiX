/**
 * Which rows a fixed-height list actually needs to draw.
 *
 * The Timeline draws one line per animated channel and one marker per keyframe. A show-sized scene
 * reaches into the thousands of both, and every one of them was being rendered whether or not it was
 * on screen — so scrubbing a 2,000-row timeline paid for 2,000 rows on every frame while the author
 * could see forty of them.
 *
 * This is the whole of the windowing decision, kept as a pure function because it is the part that
 * can be silently wrong: an off-by-one here does not throw, it just clips the row under the cursor
 * or leaves a gap at the bottom of a scroll. It is therefore tested directly rather than inferred
 * from how the panel looks.
 *
 * ## The coordinate system
 *
 * Row `i` occupies `[headerHeight + i·rowHeight, headerHeight + (i+1)·rowHeight)` in the scroller's
 * content space, because the ruler's own tick band sits above the first row. `scrollTop` is in that
 * same space, so no conversion is needed beyond subtracting the header.
 */
export interface RowWindow {
  /** First row index to render, inclusive. */
  first: number;
  /** Last row index to render, inclusive. `first > last` means "render nothing". */
  last: number;
}

export interface RowWindowParams {
  scrollTop: number;
  /** Visible height of the scroll container. Zero means "not measured yet". */
  viewportHeight: number;
  rowHeight: number;
  rowCount: number;
  /** Height of the band above row 0 — the Timeline's ruler ticks. */
  headerHeight: number;
  /**
   * Extra rows kept above and below the viewport.
   *
   * Not a smoothness tweak: a row that only exists once it is on screen cannot be the target of a
   * drag that started off screen, and a keyframe marker that mounts mid-drag loses the pointer
   * capture. A few rows of margin keeps the row under a fast pointer already mounted.
   */
  overscan: number;
}

export function computeRowWindow(params: RowWindowParams): RowWindow {
  const { scrollTop, viewportHeight, rowHeight, rowCount, headerHeight, overscan } = params;

  if (rowCount <= 0) return { first: 0, last: -1 };

  // Unmeasured or nonsensical geometry degrades to "draw everything", never to "draw nothing":
  // a blank timeline is a bug the author sees, an unwindowed one is merely the old cost.
  if (viewportHeight <= 0 || rowHeight <= 0) return { first: 0, last: rowCount - 1 };

  const top = scrollTop - headerHeight;
  const bottom = top + viewportHeight;

  // `floor` for the first row and `ceil` for the one past the last: a row straddling either edge is
  // partly visible and must be drawn, which truncation would drop.
  const firstVisible = Math.floor(top / rowHeight);
  const lastVisible = Math.ceil(bottom / rowHeight) - 1;

  return {
    first: Math.max(0, firstVisible - overscan),
    last: Math.min(rowCount - 1, Math.max(-1, lastVisible + overscan))
  };
}

/** Pixels of spacer standing in for the rows above and below the window, for a flow-laid list. */
export function rowWindowSpacers(
  window: RowWindow,
  rowCount: number,
  rowHeight: number
): { before: number; after: number } {
  if (window.first > window.last) return { before: 0, after: rowCount * rowHeight };
  return {
    before: window.first * rowHeight,
    after: Math.max(0, rowCount - 1 - window.last) * rowHeight
  };
}


/**
 * The same decision for a list whose rows are not all the same height.
 *
 * The Object Manager draws three kinds of row — a layer band, an object, a mask — and they are 27,
 * 29 and 27 pixels. Close enough to be tempting to average, and averaging is wrong: two pixels of
 * error per band row is a row and a half of drift by the fortieth layer, which lands the tab stop on
 * a different row than the one under the cursor.
 *
 * So the caller supplies each row's height and this walks the running total. `offsets[i]` is the top
 * of row `i`; `offsets[rowCount]` is the total height, which is what the spacers have to add up to.
 */
export function rowOffsets(heights: readonly number[]): number[] {
  const offsets = new Array<number>(heights.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < heights.length; index += 1) {
    offsets[index + 1] = offsets[index] + heights[index];
  }
  return offsets;
}

export function computeRowWindowFromOffsets(params: {
  scrollTop: number;
  viewportHeight: number;
  /** Prefix sums from `rowOffsets`; length is rowCount + 1. */
  offsets: readonly number[];
  overscan: number;
}): RowWindow {
  const { scrollTop, viewportHeight, offsets, overscan } = params;
  const rowCount = offsets.length - 1;

  if (rowCount <= 0) return { first: 0, last: -1 };
  // Unmeasured geometry draws everything, exactly as the fixed-height version does: the old cost,
  // never a blank panel.
  if (viewportHeight <= 0) return { first: 0, last: rowCount - 1 };

  const firstVisible = rowAtOffset(offsets, scrollTop);
  const lastVisible = rowAtOffset(offsets, scrollTop + viewportHeight);

  return {
    first: Math.max(0, firstVisible - overscan),
    last: Math.min(rowCount - 1, lastVisible + overscan)
  };
}

/**
 * The row containing a pixel offset, by binary search.
 *
 * Linear scanning is fine at forty rows and quietly quadratic at four thousand, because this runs on
 * every scroll event.
 */
export function rowAtOffset(offsets: readonly number[], offset: number): number {
  const rowCount = offsets.length - 1;
  if (offset <= 0) return 0;
  if (offset >= offsets[rowCount]) return rowCount - 1;

  let low = 0;
  let high = rowCount - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid] <= offset) low = mid;
    else high = mid - 1;
  }
  return low;
}