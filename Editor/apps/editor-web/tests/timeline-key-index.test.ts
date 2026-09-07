/**
 * The key index: sorted integer frames, binary-search slicing, frame-space hit testing.
 *
 * The property that matters is that the cost of drawing a row follows how many keys are *visible*,
 * not how many the row holds — so the searches are tested at 100,000 keys, and the visible slice is
 * checked to be a small run rather than a filtered copy of everything.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildKeyIndex,
  emptyKeyIndex,
  indicesInRange,
  lowerBound,
  nearestWithin,
  selectedPositions,
  upperBound,
  visibleSlice
} from "../src/components/timeline/keyIndex";
import { HIT_TOLERANCE_FRAMES } from "../src/components/timeline/timelineViewport";

const keysAt = (frames: number[]) => frames.map((frame, index) => ({ frame, id: `k${index}` }));

test("frames are stored as a sorted Int32Array with ids kept parallel", () => {
  const index = buildKeyIndex([
    { frame: 30, id: "c" },
    { frame: 10, id: "a" },
    { frame: 20, id: "b" }
  ]);

  assert.ok(index.frames instanceof Int32Array);
  assert.deepEqual([...index.frames], [10, 20, 30]);
  assert.deepEqual(index.ids, ["a", "b", "c"]);
});

/**
 * A binary search over an unsorted array does not fail loudly; it returns the wrong key. The store
 * already sorts, so this is belt and braces — but it is the kind of belt whose absence is silent.
 */
test("an unsorted input is sorted rather than trusted", () => {
  const index = buildKeyIndex([
    { frame: 5, id: "z" },
    { frame: 5, id: "a" },
    { frame: 1, id: "m" }
  ]);
  assert.deepEqual([...index.frames], [1, 5, 5]);
  assert.deepEqual(index.ids, ["m", "a", "z"], "ties break on id so the order is total");
});

test("an empty index answers every query without special-casing at the call site", () => {
  const index = emptyKeyIndex();
  assert.deepEqual(visibleSlice(index, 0, 100), { start: 0, end: 0 });
  assert.equal(nearestWithin(index, 10, 3), -1);
  assert.deepEqual(indicesInRange(index, 0, 100), []);
});

/* ── Binary search ────────────────────────────────────────────────────────────────────────── */

test("lowerBound and upperBound bracket a run of equal frames", () => {
  const index = buildKeyIndex(keysAt([10, 20, 20, 20, 30]));
  assert.equal(lowerBound(index.frames, 20), 1);
  assert.equal(upperBound(index.frames, 20), 4);
  assert.equal(lowerBound(index.frames, 25), 4, "a frame between keys lands after the run");
  assert.equal(lowerBound(index.frames, 0), 0);
  assert.equal(lowerBound(index.frames, 999), 5, "past the end is the length");
});

test("the visible slice is the run inside the range, inclusive at both ends", () => {
  const index = buildKeyIndex(keysAt([0, 10, 20, 30, 40, 50]));

  assert.deepEqual(visibleSlice(index, 10, 30), { start: 1, end: 4 });
  assert.deepEqual(visibleSlice(index, 11, 29), { start: 2, end: 3 });
  assert.deepEqual(visibleSlice(index, 60, 70), { start: 6, end: 6 }, "no keys is an empty run");
  assert.deepEqual(visibleSlice(index, 30, 10), { start: 0, end: 0 }, "an inverted range is empty");
});

/**
 * The point of the whole module: a row with 100,000 keys costs the same to slice as one with ten,
 * and yields only what is on screen.
 */
test("slicing 100,000 keys yields only the visible run", () => {
  const index = buildKeyIndex(keysAt(Array.from({ length: 100_000 }, (_, i) => i)));

  const { start, end } = visibleSlice(index, 50_000, 50_099);
  assert.equal(start, 50_000);
  assert.equal(end, 50_100);
  assert.equal(end - start, 100, "100 visible keys out of 100,000");

  // And the boundaries behave at the ends of a large array.
  assert.deepEqual(visibleSlice(index, -10, 2), { start: 0, end: 3 });
  assert.equal(visibleSlice(index, 99_998, 200_000).end, 100_000);
});

/* ── Hit testing, in frames ───────────────────────────────────────────────────────────────── */

test("the nearest key within tolerance is found from either side", () => {
  const index = buildKeyIndex(keysAt([100, 200, 300]));

  assert.equal(nearestWithin(index, 100, HIT_TOLERANCE_FRAMES), 0, "exactly on a key");
  assert.equal(nearestWithin(index, 102, HIT_TOLERANCE_FRAMES), 0, "just after");
  assert.equal(nearestWithin(index, 198, HIT_TOLERANCE_FRAMES), 1, "just before");
  assert.equal(nearestWithin(index, 150, HIT_TOLERANCE_FRAMES), -1, "between keys hits nothing");
});

test("the tolerance is inclusive at its edge and excludes one frame beyond", () => {
  const index = buildKeyIndex(keysAt([100]));
  assert.equal(nearestWithin(index, 100 + HIT_TOLERANCE_FRAMES, HIT_TOLERANCE_FRAMES), 0);
  assert.equal(nearestWithin(index, 100 - HIT_TOLERANCE_FRAMES, HIT_TOLERANCE_FRAMES), 0);
  assert.equal(nearestWithin(index, 100 + HIT_TOLERANCE_FRAMES + 1, HIT_TOLERANCE_FRAMES), -1);
});

/** A repeated click on coincident keys must not alternate between them. */
test("a tie goes to the earlier key, stably", () => {
  const index = buildKeyIndex([
    { frame: 100, id: "first" },
    { frame: 100, id: "second" }
  ]);
  assert.equal(nearestWithin(index, 100, 3), 0);
  assert.equal(nearestWithin(index, 100, 3), 0);
});

test("hit testing 100,000 keys finds the right one", () => {
  const index = buildKeyIndex(keysAt(Array.from({ length: 100_000 }, (_, i) => i * 4)));
  assert.equal(nearestWithin(index, 240_000, 3), 60_000, "frame 240000 is key 60000 at stride 4");
  assert.equal(nearestWithin(index, 240_002, 3), 60_000, "two frames off still hits");
  assert.equal(
    nearestWithin(index, 240_002, 1),
    -1,
    "a tighter tolerance refuses, which is what makes tolerance meaningful"
  );
});

/* ── Marquee and selection ────────────────────────────────────────────────────────────────── */

test("a marquee range returns the indices it covers, either way round", () => {
  const index = buildKeyIndex(keysAt([0, 10, 20, 30, 40]));
  assert.deepEqual(indicesInRange(index, 10, 30), [1, 2, 3]);
  assert.deepEqual(indicesInRange(index, 30, 10), [1, 2, 3], "dragging right-to-left is the same range");
});

/**
 * Selection is held as ids and projected to positions for the draw. Ids survive a re-sort; indices
 * do not, and an index-keyed selection would transfer itself to whichever key landed in the slot.
 */
test("selected ids project to positions, and survive a reorder", () => {
  const before = buildKeyIndex([
    { frame: 10, id: "a" },
    { frame: 20, id: "b" }
  ]);
  const selected = new Set(["b"]);
  assert.deepEqual([...selectedPositions(before, selected)], [1]);

  // "b" moves before "a" — same identity, different index.
  const after = buildKeyIndex([
    { frame: 5, id: "b" },
    { frame: 10, id: "a" }
  ]);
  assert.deepEqual([...selectedPositions(after, selected)], [0], "the selection followed the key, not the slot");
});

test("an empty selection projects to nothing without scanning", () => {
  const index = buildKeyIndex(keysAt(Array.from({ length: 100_000 }, (_, i) => i)));
  assert.equal(selectedPositions(index, new Set()).size, 0);
});
