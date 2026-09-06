import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_OBJECT_SELECTION,
  gestureForPointer,
  normaliseObjectSelection,
  reconcileObjectSelection,
  reduceObjectSelection,
  type ObjectSelection
} from "../src/store/objectSelection";

/**
 * The selection gesture table, asserted directly.
 *
 * The Editor had two selections before this: `selectedObjectId` and the marquee's
 * `selectedPathObjectIds`. Nothing cleared the second, so a marquee of five stayed live in the
 * alignment toolbar after a single click, and the "key object" was whichever id happened to sort
 * last. These tests pin the parts that are easy to get subtly wrong — which end an anchor measures
 * from, who becomes active when the active member is removed, and what Ctrl+A means when part of
 * the tree is collapsed.
 */

/** Six visible rows; `d1` and `d2` are collapsed descendants that are selectable but not visible. */
const rows = ["a", "b", "c", "d", "e", "f"];
const all = ["a", "b", "c", "d", "d1", "d2", "e", "f"];
const context = { rows, all };

const selection = (ids: string[], active: string | null, anchor: string | null): ObjectSelection => ({
  selectedObjectIds: ids,
  activeObjectId: active,
  anchorId: anchor
});

test("a plain click replaces the selection and sets the anchor", () => {
  const next = reduceObjectSelection(selection(["a", "b"], "a", "a"), { kind: "replace", id: "e" }, context);
  assert.deepEqual(next, selection(["e"], "e", "e"));
});

test("ctrl-click on a non-member adds it and makes it active", () => {
  const next = reduceObjectSelection(selection(["a"], "a", "a"), { kind: "toggle", id: "c" }, context);
  assert.deepEqual(next.selectedObjectIds, ["a", "c"]);
  assert.equal(next.activeObjectId, "c");
  assert.equal(next.anchorId, "c");
});

test("ctrl-click on the active member hands the active role to the nearest survivor above", () => {
  const next = reduceObjectSelection(selection(["b", "c", "e"], "e", "b"), { kind: "toggle", id: "e" }, context);
  assert.deepEqual(next.selectedObjectIds, ["b", "c"]);
  assert.equal(next.activeObjectId, "c", "c is the nearest remaining member above e");
});

test("ctrl-click on a non-active member leaves the active object alone", () => {
  const next = reduceObjectSelection(selection(["b", "c", "e"], "e", "b"), { kind: "toggle", id: "c" }, context);
  assert.deepEqual(next.selectedObjectIds, ["b", "e"]);
  assert.equal(next.activeObjectId, "e");
});

test("ctrl-click on the last member empties the selection", () => {
  const next = reduceObjectSelection(selection(["d"], "d", "d"), { kind: "toggle", id: "d" }, context);
  assert.deepEqual(next, EMPTY_OBJECT_SELECTION);
});

test("shift-click takes the inclusive run and keeps the anchor where it was", () => {
  const next = reduceObjectSelection(selection(["b"], "b", "b"), { kind: "range", id: "e" }, context);
  assert.deepEqual(next.selectedObjectIds, ["b", "c", "d", "e"]);
  assert.equal(next.activeObjectId, "e");
  assert.equal(next.anchorId, "b", "a second shift-click must re-measure from the same end");
});

test("shift-click backwards takes the same run", () => {
  const next = reduceObjectSelection(selection(["e"], "e", "e"), { kind: "range", id: "b" }, context);
  assert.deepEqual(next.selectedObjectIds, ["b", "c", "d", "e"]);
  assert.equal(next.activeObjectId, "b");
});

test("shift-click replaces rather than adds", () => {
  const next = reduceObjectSelection(selection(["a", "f"], "f", "b"), { kind: "range", id: "c" }, context);
  assert.deepEqual(next.selectedObjectIds, ["b", "c"], "a and f are dropped");
});

test("ctrl-shift-click unions the run with what was already selected", () => {
  const next = reduceObjectSelection(selection(["a", "f"], "f", "b"), { kind: "rangeAdd", id: "c" }, context);
  assert.deepEqual(next.selectedObjectIds, ["a", "b", "c", "f"]);
  assert.equal(next.activeObjectId, "c");
});

test("a range with no anchor degrades to the single-object gesture", () => {
  const replaced = reduceObjectSelection(selection([], null, null), { kind: "range", id: "c" }, context);
  assert.deepEqual(replaced, selection(["c"], "c", "c"));

  const added = reduceObjectSelection(selection(["a"], "a", null), { kind: "rangeAdd", id: "c" }, context);
  assert.deepEqual(added.selectedObjectIds, ["a", "c"]);
});

test("select all spans every search match, including collapsed descendants", () => {
  const next = reduceObjectSelection(selection(["a"], "a", "a"), { kind: "selectAll" }, context);
  assert.deepEqual(next.selectedObjectIds, all, "d1 and d2 are collapsed but still selectable");
  assert.equal(next.activeObjectId, "a");
});

test("select all with nothing selectable is empty rather than an invalid active id", () => {
  const next = reduceObjectSelection(selection(["a"], "a", "a"), { kind: "selectAll" }, { rows: [], all: [] });
  assert.deepEqual(next, EMPTY_OBJECT_SELECTION);
});

test("clear empties every field together", () => {
  const next = reduceObjectSelection(selection(["a", "b"], "b", "a"), { kind: "clear" }, context);
  assert.deepEqual(next, EMPTY_OBJECT_SELECTION);
});

test("the selection is ordered by the scene, not by click order", () => {
  const next = reduceObjectSelection(selection(["f"], "f", "f"), { kind: "toggle", id: "b" }, context);
  assert.deepEqual(next.selectedObjectIds, ["b", "f"]);
});

test("normalising forces the active member to be a member", () => {
  const next = normaliseObjectSelection(selection(["b", "c"], "z", "z"), context);
  assert.equal(next.activeObjectId, "b");
  assert.equal(next.anchorId, "b", "an anchor the context does not know falls back to the active id");
});

test("normalising deduplicates without losing the active choice", () => {
  const next = normaliseObjectSelection(selection(["c", "b", "c"], "c", "b"), context);
  assert.deepEqual(next.selectedObjectIds, ["b", "c"]);
  assert.equal(next.activeObjectId, "c");
});

test("an empty set can never carry an active id", () => {
  assert.deepEqual(normaliseObjectSelection(selection([], "a", "a"), context), EMPTY_OBJECT_SELECTION);
});

test("reconciling drops removed members and re-picks the active one", () => {
  const next = reconcileObjectSelection(
    selection(["b", "c", "e"], "c", "b"),
    new Set(["b", "e"]),
    ["b", "c", "e"]
  );
  assert.deepEqual(next.selectedObjectIds, ["b", "e"]);
  assert.equal(next.activeObjectId, "b", "the member above the removed active one");
});

test("reconciling keeps the active object when it survives", () => {
  const next = reconcileObjectSelection(
    selection(["b", "c", "e"], "e", "b"),
    new Set(["b", "e"]),
    ["b", "c", "e"]
  );
  assert.equal(next.activeObjectId, "e");
  assert.deepEqual(next.selectedObjectIds, ["b", "e"]);
});

test("reconciling away every member yields the empty selection", () => {
  assert.deepEqual(
    reconcileObjectSelection(selection(["b"], "b", "b"), new Set(["z"]), ["b"]),
    EMPTY_OBJECT_SELECTION
  );
});

test("modifier keys map to the gestures the table describes", () => {
  assert.deepEqual(gestureForPointer("a", {}), { kind: "replace", id: "a" });
  assert.deepEqual(gestureForPointer("a", { ctrlKey: true }), { kind: "toggle", id: "a" });
  assert.deepEqual(gestureForPointer("a", { metaKey: true }), { kind: "toggle", id: "a" }, "macOS");
  assert.deepEqual(gestureForPointer("a", { shiftKey: true }), { kind: "range", id: "a" });
  assert.deepEqual(
    gestureForPointer("a", { ctrlKey: true, shiftKey: true }),
    { kind: "rangeAdd", id: "a" }
  );
});
