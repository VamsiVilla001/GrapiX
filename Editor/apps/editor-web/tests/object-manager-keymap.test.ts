import assert from "node:assert/strict";
import test from "node:test";
import {
  isSelectable,
  reduceObjectManagerKey,
  type KeymapEvent,
  type KeymapState
} from "../src/modules/object-manager/services/objectManagerKeymap";
import { FIXED_COLUMNS, type TreeRow } from "../src/modules/object-manager/services/objectManagerTree";

/**
 * The whole keyboard, as a table.
 *
 * Two properties this defends, and neither is visible in a handler. **What a key means must not
 * depend on anything but the state given** — so the same keystroke on the same cell always resolves
 * the same way, and Left cannot both move a cell and close a row. And **`consumed` must be separate
 * from the intent** — a key can be ours and mean "do nothing" (End on the last cell), while a key
 * that is not ours must pass through untouched or the Assistant and the console lose their chords.
 */

function row(id: string, patch: Partial<TreeRow> = {}): TreeRow {
  return {
    id,
    kind: "object",
    level: 2,
    posInSet: 1,
    setSize: 1,
    expandable: false,
    expanded: false,
    depth: 0,
    layerId: "main",
    cellCount: FIXED_COLUMNS + 3,
    objectId: id,
    ...patch
  };
}

const BAND = row("band:main", { kind: "band", level: 1, expandable: true, expanded: true, cellCount: 4, objectId: undefined });
const GROUP = row("g", { expandable: true, expanded: true });
const CLOSED = row("h", { expandable: true, expanded: false });
const MASK = row("a:m1", { kind: "mask", level: 3, cellCount: 5, objectId: "a", maskId: "m1" });

function state(patch: Partial<KeymapState> = {}): KeymapState {
  return {
    rows: [BAND, GROUP, row("a"), MASK, row("b")],
    activeRowId: "a",
    activeColumn: 0,
    editing: false,
    ...patch
  };
}

function press(key: string, modifiers: Partial<KeymapEvent> = {}, patch: Partial<KeymapState> = {}) {
  return reduceObjectManagerKey(state(patch), { key, ...modifiers });
}

test("Down moves to the next drawn row, whatever kind it is", () => {
  const { intent, consumed } = press("ArrowDown");
  assert.equal(consumed, true);
  // A mask cannot be selected, so moving onto one only moves.
  assert.deepEqual(intent, { kind: "move", rowId: "a:m1", column: 0 });
});

test("a plain arrow onto an object row takes the selection with it", () => {
  // Otherwise the tab stop drifts away from the anchor, and the next Shift+Down claims every row
  // between them: a three-row gesture that selects two hundred.
  const { intent } = press("ArrowDown", {}, { activeRowId: "a:m1" });
  assert.deepEqual(intent, { kind: "select", rowId: "b", column: 0 });
});

test("the accelerator navigates without disturbing the selection", () => {
  const { intent } = press("ArrowDown", { ctrlKey: true }, { activeRowId: "a:m1" });
  assert.deepEqual(intent, { kind: "move", rowId: "b", column: 0 });
});

test("Up at the first row is consumed and does nothing", () => {
  const { intent, consumed } = press("ArrowUp", {}, { activeRowId: "band:main" });
  // Consumed on purpose: letting it through scrolls the panel out from under the author.
  assert.equal(consumed, true);
  assert.deepEqual(intent, { kind: "none" });
});

test("Down at the last row is consumed and does nothing", () => {
  const { intent, consumed } = press("ArrowDown", {}, { activeRowId: "b" });
  assert.equal(consumed, true);
  assert.deepEqual(intent, { kind: "none" });
});

test("the column is kept while moving between rows of the same width", () => {
  const { intent } = press("ArrowUp", {}, { activeRowId: "b", activeColumn: 5 });
  assert.deepEqual(intent, { kind: "move", rowId: "a:m1", column: 4 });
  // Two object rows are the same width, so the column survives untouched.
  const wide = press("ArrowDown", {}, { activeRowId: "g", activeColumn: 5, rows: [row("g"), row("a")] });
  assert.deepEqual(wide.intent, { kind: "select", rowId: "a", column: 5 });
});

test("Right moves one cell, and stops at the last one", () => {
  assert.deepEqual(press("ArrowRight", {}, { activeColumn: 1 }).intent, { kind: "move", rowId: "a", column: 2 });
  const last = press("ArrowRight", {}, { activeColumn: FIXED_COLUMNS + 3 - 1 });
  assert.deepEqual(last.intent, { kind: "none" });
  assert.equal(last.consumed, true);
});

test("Left moves one cell while there is a cell to its left", () => {
  assert.deepEqual(press("ArrowLeft", {}, { activeColumn: 2 }).intent, { kind: "move", rowId: "a", column: 1 });
});

test("Left on the first cell of an expanded row collapses it instead of moving", () => {
  // The collision. On the first cell Left is hierarchy; anywhere else it is movement. If it were both
  // the author would either never close a group or never reach the name column.
  const { intent } = press("ArrowLeft", {}, { activeRowId: "g", activeColumn: 0 });
  assert.deepEqual(intent, { kind: "collapse", rowId: "g" });
});

test("Right on the first cell of a collapsed row expands it instead of moving", () => {
  const { intent } = press("ArrowRight", {}, { activeRowId: "h", activeColumn: 0, rows: [CLOSED] });
  assert.deepEqual(intent, { kind: "expand", rowId: "h" });
});

test("Right on the first cell of an already expanded row moves on to the next cell", () => {
  // Not a no-op: an expanded row has nothing left to open, so the key falls through to movement.
  const { intent } = press("ArrowRight", {}, { activeRowId: "g", activeColumn: 0 });
  assert.deepEqual(intent, { kind: "move", rowId: "g", column: 1 });
});

test("Left on the first cell of a leaf is consumed and does nothing", () => {
  const { intent, consumed } = press("ArrowLeft", {}, { activeRowId: "a", activeColumn: 0 });
  assert.deepEqual(intent, { kind: "none" });
  assert.equal(consumed, true);
});

test("Home and End are row-scoped, Ctrl+Home and Ctrl+End column-scoped", () => {
  assert.deepEqual(press("Home", {}, { activeColumn: 4 }).intent, { kind: "move", rowId: "a", column: 0 });
  assert.deepEqual(press("End", {}, { activeColumn: 0 }).intent, { kind: "move", rowId: "a", column: FIXED_COLUMNS + 2 });
  assert.deepEqual(press("Home", { ctrlKey: true }, { activeColumn: 2 }).intent, { kind: "move", rowId: "band:main", column: 2 });
  assert.deepEqual(press("End", { ctrlKey: true }, { activeColumn: 2 }).intent, { kind: "move", rowId: "b", column: 2 });
});

test("Shift+Down extends over object rows only, skipping bands and masks", () => {
  // `a` is followed by a mask row, then `b`. A range that silently included the mask would report a
  // selection with something unselectable in it.
  const { intent } = press("ArrowDown", { shiftKey: true }, { activeRowId: "a" });
  assert.deepEqual(intent, { kind: "extend", rowId: "b", column: 0 });
});

test("Shift+Down with no selectable row ahead is consumed and does nothing", () => {
  const { intent, consumed } = press("ArrowDown", { shiftKey: true }, { activeRowId: "b" });
  assert.deepEqual(intent, { kind: "none" });
  assert.equal(consumed, true);
});

test("Ctrl+Space toggles one row's membership, Shift+Space takes the range", () => {
  assert.deepEqual(press(" ", { ctrlKey: true }).intent, { kind: "toggleMember", rowId: "a", column: 0 });
  assert.deepEqual(press(" ", { shiftKey: true }).intent, { kind: "extend", rowId: "a", column: 0 });
});

test("Ctrl+Space on a band or a mask is refused, because neither can join a selection", () => {
  assert.deepEqual(press(" ", { ctrlKey: true }, { activeRowId: "band:main" }).intent, { kind: "none" });
  assert.deepEqual(press(" ", { ctrlKey: true }, { activeRowId: "a:m1" }).intent, { kind: "none" });
});

test("bare Space is visibility, on every kind of row", () => {
  assert.deepEqual(press(" ").intent, { kind: "toggleVisibility", rowId: "a" });
  assert.deepEqual(press(" ", {}, { activeRowId: "band:main" }).intent, { kind: "toggleVisibility", rowId: "band:main" });
  assert.deepEqual(press(" ", {}, { activeRowId: "a:m1" }).intent, { kind: "toggleVisibility", rowId: "a:m1" });
});

test("Enter and F2 both begin an edit on the cell under the tab stop", () => {
  assert.deepEqual(press("Enter", {}, { activeColumn: 0 }).intent, { kind: "beginEdit", rowId: "a", column: 0 });
  assert.deepEqual(press("F2", {}, { activeColumn: 4 }).intent, { kind: "beginEdit", rowId: "a", column: 4 });
});

test("Ctrl+A selects all and Escape clears, at any column and with nothing active", () => {
  assert.deepEqual(press("a", { ctrlKey: true }).intent, { kind: "selectAll" });
  assert.deepEqual(press("A", { metaKey: true }).intent, { kind: "selectAll" });
  assert.deepEqual(press("Escape").intent, { kind: "clearSelection" });
  assert.deepEqual(press("Escape", {}, { activeRowId: null }).intent, { kind: "clearSelection" });
});

test("Delete acts on the selection from an object row and is refused elsewhere", () => {
  assert.deepEqual(press("Delete").intent, { kind: "delete" });
  assert.deepEqual(press("Backspace").intent, { kind: "delete" });
  assert.deepEqual(press("Delete", {}, { activeRowId: "band:main" }).intent, { kind: "none" });
  assert.deepEqual(press("Delete", {}, { activeRowId: "a:m1" }).intent, { kind: "none" });
});

test("Ctrl+Alt+A and Ctrl+Alt+C are never intercepted", () => {
  // The Assistant and the console own these. A grid that took Ctrl+A first would take them with it.
  for (const key of ["a", "c", "A", "C"]) {
    const result = press(key, { ctrlKey: true, altKey: true });
    assert.equal(result.consumed, false, `Ctrl+Alt+${key} must pass through`);
    assert.deepEqual(result.intent, { kind: "none" });
  }
});

test("nothing is consumed while a field is being edited", () => {
  // Arrows, Home, End and Delete belong to the text. So do Enter and Escape: the draft's own handlers
  // answer them next to the input, and a second opinion here would race the commit.
  for (const key of ["ArrowDown", "ArrowLeft", "Home", "End", "Delete", "Enter", "Escape", " ", "a"]) {
    const result = press(key, { ctrlKey: key === "a" }, { editing: true });
    assert.equal(result.consumed, false, `${key} must reach the input`);
  }
});

test("an unknown key is never consumed", () => {
  for (const key of ["b", "Tab", "PageDown", "F5"]) {
    assert.equal(press(key).consumed, false, `${key} must pass through`);
  }
});

test("the first navigation key adopts the first row when nothing is active", () => {
  const { intent, consumed } = press("ArrowDown", {}, { activeRowId: null });
  assert.equal(consumed, true);
  assert.deepEqual(intent, { kind: "move", rowId: "band:main", column: 0 });
});

test("a navigation key on an empty grid is consumed and does nothing", () => {
  const { intent, consumed } = press("ArrowDown", {}, { activeRowId: null, rows: [] });
  assert.equal(consumed, true);
  assert.deepEqual(intent, { kind: "none" });
});

test("an active row that no longer exists is treated as nothing active", () => {
  const { intent } = press("ArrowDown", {}, { activeRowId: "deleted" });
  assert.deepEqual(intent, { kind: "move", rowId: "band:main", column: 0 });
});

test("a column past the last one is clamped rather than moved into", () => {
  // Untick the column holding the tab stop and the stored index outlives the cell it named.
  const { intent } = press("ArrowDown", {}, { activeColumn: 99 });
  // The landing row is a mask, five cells wide, so the clamp is that row's — not the grid's.
  assert.deepEqual(intent, { kind: "move", rowId: "a:m1", column: 4 });
});

test("moving onto a narrower row clamps to that row's last cell, with no dead presses", () => {
  // The wart this closes: arrowing from column 6 of an object row onto a four-cell band used to leave
  // the index at 6, so the next two Lefts moved an invisible cursor and nothing on screen changed.
  const onBand = press("ArrowUp", {}, { activeRowId: "g", activeColumn: 6 });
  assert.deepEqual(onBand.intent, { kind: "move", rowId: "band:main", column: 3 });
  // And Left from there responds immediately.
  const left = press("ArrowLeft", {}, { activeRowId: "band:main", activeColumn: 6 });
  assert.deepEqual(left.intent, { kind: "move", rowId: "band:main", column: 2 });
});

test("only object rows are selectable", () => {
  assert.equal(isSelectable(row("a")), true);
  assert.equal(isSelectable(BAND), false);
  assert.equal(isSelectable(MASK), false);
  assert.equal(isSelectable(undefined), false);
});
