import assert from "node:assert/strict";
import test from "node:test";
import { computeRowWindow, rowWindowSpacers } from "../src/components/rowWindow";

/**
 * The windowing arithmetic, tested directly.
 *
 * An off-by-one here does not throw — it clips the row under the cursor, or leaves a gap at the end
 * of a scroll that looks like a rendering glitch. So each edge is pinned: the partly-visible row at
 * either boundary, the unmeasured first paint, the empty list, and the spacers that stand in for the
 * rows that were not drawn.
 */

const base = { rowHeight: 28, headerHeight: 28, overscan: 0 };

test("a window covers exactly the rows on screen", () => {
  // Scrolled to the top, 280px of viewport below a 28px header: rows 0..9 are visible.
  const window = computeRowWindow({ ...base, scrollTop: 28, viewportHeight: 280, rowCount: 1000 });
  assert.deepEqual(window, { first: 0, last: 9 });
});

test("a row straddling either edge is drawn, not truncated away", () => {
  // Scrolled half a row down: row 0 is half off the top and must still be drawn, and the row
  // straddling the bottom edge must be too. Truncating either leaves a visible gap.
  const window = computeRowWindow({ ...base, scrollTop: 28 + 14, viewportHeight: 280, rowCount: 1000 });
  assert.equal(window.first, 0, "the half-scrolled row 0 is still partly visible");
  assert.equal(window.last, 10, "the row straddling the bottom edge is drawn");
});

test("overscan widens the window without running past the ends", () => {
  const middle = computeRowWindow({ ...base, overscan: 3, scrollTop: 28 + 28 * 50, viewportHeight: 280, rowCount: 1000 });
  assert.deepEqual(middle, { first: 47, last: 62 });

  // At the very top there is nothing above to overscan into, and the window must not go negative.
  const atTop = computeRowWindow({ ...base, overscan: 3, scrollTop: 28, viewportHeight: 280, rowCount: 1000 });
  assert.equal(atTop.first, 0);

  // At the very bottom it must not name a row that does not exist.
  const atBottom = computeRowWindow({
    ...base,
    overscan: 3,
    scrollTop: 28 + 28 * 990,
    viewportHeight: 280,
    rowCount: 1000
  });
  assert.equal(atBottom.last, 999);
});

test("scrolling to the end still reaches the final row", () => {
  // The last row must be reachable: a window that stops one short is a row an author cannot key.
  const rowCount = 1000;
  const contentHeight = 28 + rowCount * 28;
  const viewportHeight = 280;
  const window = computeRowWindow({
    ...base,
    scrollTop: contentHeight - viewportHeight,
    viewportHeight,
    rowCount
  });
  assert.equal(window.last, rowCount - 1);
});

test("an unmeasured viewport draws everything rather than nothing", () => {
  // First paint, before the scroller has been measured. Drawing nothing would flash an empty
  // timeline; drawing everything is merely the cost this change removes.
  const window = computeRowWindow({ ...base, scrollTop: 0, viewportHeight: 0, rowCount: 40 });
  assert.deepEqual(window, { first: 0, last: 39 });
});

test("an empty list yields an empty window, not row zero", () => {
  const window = computeRowWindow({ ...base, scrollTop: 0, viewportHeight: 280, rowCount: 0 });
  assert.ok(window.first > window.last, "an empty window is expressed as first > last");
});

test("spacers account for every row the window did not draw", () => {
  const rowCount = 1000;
  const window = { first: 47, last: 62 };
  const spacers = rowWindowSpacers(window, rowCount, 28);
  assert.equal(spacers.before, 47 * 28);
  assert.equal(spacers.after, (1000 - 1 - 62) * 28);
  // The scroll height an author feels must not change just because fewer rows are mounted.
  const drawn = (window.last - window.first + 1) * 28;
  assert.equal(spacers.before + drawn + spacers.after, rowCount * 28);
});

test("an empty window still reserves the whole scroll height", () => {
  const spacers = rowWindowSpacers({ first: 0, last: -1 }, 250, 28);
  assert.equal(spacers.before + spacers.after, 250 * 28);
});

/**
 * The variable-height half, used by the Object Manager: a layer band is 27px, an object row 29px, a
 * mask row 27px. These pin the arithmetic that averaging them would get wrong.
 */

import { computeRowWindowFromOffsets, rowAtOffset, rowOffsets } from "../src/components/rowWindow";

const HEIGHTS = { band: 27, object: 29, mask: 27 };

/** One band followed by `n` object rows — the shape the panel actually draws. */
function bandOf(objectCount: number): number[] {
  return [HEIGHTS.band, ...Array.from({ length: objectCount }, () => HEIGHTS.object)];
}

test("offsets are running totals, ending at the full height", () => {
  const offsets = rowOffsets([27, 29, 29, 27]);
  assert.deepEqual(offsets, [0, 27, 56, 85, 112]);
  assert.equal(offsets.at(-1), 27 + 29 + 29 + 27);
});

test("a pixel offset resolves to the row that contains it", () => {
  const offsets = rowOffsets([27, 29, 29]);
  assert.equal(rowAtOffset(offsets, 0), 0);
  assert.equal(rowAtOffset(offsets, 26), 0, "last pixel of row 0 is still row 0");
  assert.equal(rowAtOffset(offsets, 27), 1, "first pixel of row 1");
  assert.equal(rowAtOffset(offsets, 55), 1);
  assert.equal(rowAtOffset(offsets, 56), 2);
  // Past the end clamps to the last row rather than returning an index nobody can render.
  assert.equal(rowAtOffset(offsets, 100000), 2);
  assert.equal(rowAtOffset(offsets, -50), 0);
});

test("mixed row heights do not drift the window", () => {
  // 40 bands of 10 objects each: averaging 27 and 29 would be ~1.5 rows out by the end.
  const heights: number[] = [];
  for (let band = 0; band < 40; band += 1) heights.push(...bandOf(10));
  const offsets = rowOffsets(heights);

  // Scroll exactly to the top of the last band and confirm the window starts there.
  const lastBandIndex = 39 * 11;
  const window = computeRowWindowFromOffsets({
    scrollTop: offsets[lastBandIndex],
    viewportHeight: 290,
    offsets,
    overscan: 0
  });
  assert.equal(window.first, lastBandIndex, "the window must start on the row at that exact offset");
});

test("the offset window keeps the partly-visible rows at both edges", () => {
  const offsets = rowOffsets(bandOf(40));
  // Start half way down row 3, and give the viewport a height that ends mid-row.
  const scrollTop = offsets[3] + 14;
  const window = computeRowWindowFromOffsets({ scrollTop, viewportHeight: 100, offsets, overscan: 0 });
  assert.equal(window.first, 3, "row 3 is still half visible");
  assert.equal(window.last, rowAtOffset(offsets, scrollTop + 100));
});

test("an unmeasured or empty offset list degrades safely", () => {
  const offsets = rowOffsets(bandOf(20));
  assert.deepEqual(
    computeRowWindowFromOffsets({ scrollTop: 0, viewportHeight: 0, offsets, overscan: 4 }),
    { first: 0, last: 20 },
    "unmeasured draws every row rather than none"
  );
  const empty = rowOffsets([]);
  const window = computeRowWindowFromOffsets({ scrollTop: 0, viewportHeight: 300, offsets: empty, overscan: 4 });
  assert.ok(window.first > window.last, "no rows is an empty window");
});

test("overscan never names a row outside the list", () => {
  const offsets = rowOffsets(bandOf(30));
  const atTop = computeRowWindowFromOffsets({ scrollTop: 0, viewportHeight: 200, offsets, overscan: 8 });
  assert.equal(atTop.first, 0);
  const atEnd = computeRowWindowFromOffsets({
    scrollTop: offsets.at(-1)! - 200,
    viewportHeight: 200,
    offsets,
    overscan: 8
  });
  assert.equal(atEnd.last, 30, "31 rows -> last index 30");
});
