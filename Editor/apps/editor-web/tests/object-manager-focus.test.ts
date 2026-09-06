import assert from "node:assert/strict";
import test from "node:test";
import { resolveFocusTarget } from "../src/modules/object-manager/services/objectManagerFocus";
import { FIXED_COLUMNS, type TreeRow } from "../src/modules/object-manager/services/objectManagerTree";

/**
 * Where the tab stop goes when the rows move underneath it.
 *
 * The rule that matters most is the one about *not* acting: `moveFocus` is false unless the focus was
 * already inside the panel. A panel that grabs the caret because another panel deleted an object is a
 * panel that eats what the author was typing somewhere else entirely.
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

const BAND = row("band:main", { kind: "band", level: 1, cellCount: 4, objectId: undefined });

function resolve(patch: Partial<Parameters<typeof resolveFocusTarget>[0]> = {}) {
  const rows = [BAND, row("a"), row("b"), row("c")];
  return resolveFocusTarget({
    rows,
    previousRows: rows,
    previousRowId: "b",
    previousColumn: 2,
    reason: "rows-changed",
    hadFocus: true,
    ...patch
  });
}

test("a surviving row keeps the tab stop and nothing moves", () => {
  const target = resolve();
  assert.equal(target.rowId, "b");
  assert.equal(target.column, 2);
  // Nothing to move: the cell is where it was.
  assert.equal(target.moveFocus, false);
});

test("a deleted row hands the tab stop to the row that took its place", () => {
  const previousRows = [BAND, row("a"), row("b"), row("c")];
  const target = resolve({ rows: [BAND, row("a"), row("c")], previousRows });
  assert.equal(target.rowId, "c");
  assert.equal(target.column, 2);
  assert.equal(target.moveFocus, true);
});

test("deleting the last row falls back to the one before it", () => {
  const previousRows = [BAND, row("a"), row("b"), row("c")];
  const target = resolve({ rows: [BAND, row("a"), row("b")], previousRowId: "c", previousRows });
  assert.equal(target.rowId, "b");
});

test("an object row is preferred over the band header that follows it", () => {
  // Deleting the last object of a band leaves the *next band's* header physically next. Landing there
  // would break a delete-and-repeat rhythm: the next Delete would do nothing.
  const previousRows = [BAND, row("a"), row("lower", { kind: "band", level: 1, objectId: undefined }), row("z")];
  const target = resolve({
    rows: [BAND, row("lower", { kind: "band", level: 1, objectId: undefined }), row("z")],
    previousRowId: "a",
    previousRows
  });
  assert.equal(target.rowId, "z");
});

test("a band header is accepted when no object row survives anywhere", () => {
  const previousRows = [BAND, row("a")];
  const target = resolve({ rows: [BAND], previousRowId: "a", previousRows });
  assert.equal(target.rowId, "band:main");
});

test("the column is clamped to the row it lands on", () => {
  // A band is four cells wide however many property columns the object rows show.
  const target = resolve({ previousColumn: 6, previousRowId: "band:main" });
  assert.equal(target.rowId, "band:main");
  assert.equal(target.column, 3);
});

test("a closed scene gives up the row and asks for the fallback", () => {
  const target = resolve({ reason: "scene-closed" });
  assert.equal(target.rowId, null);
  assert.equal(target.fallback, true);
  assert.equal(target.moveFocus, true);
});

test("an empty grid asks for the fallback even while a scene is open", () => {
  const target = resolve({ rows: [], previousRows: [] });
  assert.equal(target.rowId, null);
  assert.equal(target.fallback, true);
});

test("focus is never taken when it was not already in the panel", () => {
  // Every reason, one rule: no steal.
  for (const reason of ["rows-changed", "scene-closed", "remounted"] as const) {
    const target = resolve({ hadFocus: false, reason, rows: [BAND, row("a")], previousRowId: "b" });
    assert.equal(target.moveFocus, false, `${reason} must not steal focus`);
  }
});

test("a re-dock restores the cell, and only pulls the caret if the panel had it", () => {
  const held = resolve({ reason: "remounted", hadFocus: true });
  assert.equal(held.rowId, "b");
  assert.equal(held.column, 2);
  assert.equal(held.moveFocus, true);

  const notHeld = resolve({ reason: "remounted", hadFocus: false });
  assert.equal(notHeld.rowId, "b");
  assert.equal(notHeld.moveFocus, false);
});

test("a re-dock into changed rows falls back to the first row", () => {
  const target = resolve({ reason: "remounted", previousRowId: "gone" });
  assert.equal(target.rowId, "band:main");
});

test("no previous cell at all lands on the first row", () => {
  const target = resolve({ previousRowId: null, previousColumn: 0 });
  assert.equal(target.rowId, "band:main");
  assert.equal(target.column, 0);
});

test("a previous row missing from the previous list still resolves somewhere real", () => {
  // The panel can be handed a cell it never drew — a stale session, a scene swapped underneath it.
  const target = resolve({ previousRowId: "never-drawn" });
  assert.equal(target.rowId, "band:main");
});
