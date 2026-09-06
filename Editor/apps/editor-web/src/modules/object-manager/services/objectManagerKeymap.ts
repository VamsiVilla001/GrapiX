import type { TreeRow } from "./objectManagerTree";

/**
 * The Object Manager's keyboard, as a pure function.
 *
 * Every key the panel answers is decided here and nowhere else, because the two things that go wrong
 * with a grid keyboard are both invisible in a handler: a key that means two things at once, and a
 * key the panel consumes without acting on. Left and Right are the collision to watch — they move
 * between cells *and* open and close a row, and a tree that does both on the same cell either eats
 * the author's navigation or refuses to expand. The rule here is positional: hierarchy on the first
 * cell, movement everywhere else, and never both.
 *
 * `consumed` is separate from the intent on purpose. A key can be ours and do nothing (End on the
 * last cell) — that is still consumed, because passing it up would scroll the panel out from under
 * the author. A key can be ours to *refuse*: Ctrl+Alt+A and Ctrl+Alt+C belong to the Assistant and
 * the console, and Delete belongs to whatever is being typed into.
 */

export type KeymapIntent =
  | { kind: "none" }
  | { kind: "move"; rowId: string; column: number }
  | { kind: "collapse"; rowId: string }
  | { kind: "expand"; rowId: string }
  /** Replace the selection with this row alone, and move to it. */
  | { kind: "select"; rowId: string; column: number }
  /** Extend the selection from the anchor to this row. */
  | { kind: "extend"; rowId: string; column: number }
  /** Add or remove one row without disturbing the rest. */
  | { kind: "toggleMember"; rowId: string; column: number }
  | { kind: "selectAll" }
  | { kind: "clearSelection" }
  | { kind: "toggleVisibility"; rowId: string }
  | { kind: "beginEdit"; rowId: string; column: number }
  | { kind: "delete" };

export interface KeymapResult {
  intent: KeymapIntent;
  /** True when the panel handled the key — including handling it by deliberately doing nothing. */
  consumed: boolean;
}

export interface KeymapState {
  /** The rows as drawn, in order. */
  rows: readonly TreeRow[];
  /** The cell that holds the panel's single tab stop. */
  activeRowId: string | null;
  activeColumn: number;
  /** True while a text field or a numeric cell owns the keystrokes. */
  editing: boolean;
}

export interface KeymapEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

const REFUSED: KeymapResult = { intent: { kind: "none" }, consumed: false };
const SWALLOWED: KeymapResult = { intent: { kind: "none" }, consumed: true };

export function reduceObjectManagerKey(state: KeymapState, event: KeymapEvent): KeymapResult {
  const accel = Boolean(event.ctrlKey || event.metaKey);

  // Not ours, at any time. Two chords reach the Assistant and the console through this panel, and a
  // grid that grabbed Ctrl+A first would take them with it.
  if (accel && event.altKey) return REFUSED;

  // A live edit owns every key. The draft's own handlers already answer Enter and Escape next to the
  // input that holds the text, so the panel taking a second position on them is how a commit and a
  // revert end up racing.
  if (state.editing) return REFUSED;

  const index = state.activeRowId ? state.rows.findIndex((row) => row.id === state.activeRowId) : -1;

  // P1 already decided what these two mean over a search: Ctrl+A takes the match set, Escape clears.
  // They are repeated here only as a route to those definitions, never as a second opinion.
  if (accel && !event.shiftKey && event.key.toLowerCase() === "a") {
    return { intent: { kind: "selectAll" }, consumed: true };
  }
  if (event.key === "Escape") {
    return { intent: { kind: "clearSelection" }, consumed: true };
  }

  // Nothing is active yet: the first navigation key adopts the first row rather than doing nothing,
  // which is what makes the panel reachable by keyboard alone after a Tab into it.
  if (index === -1) {
    if (!isNavigationKey(event.key)) return REFUSED;
    const first = state.rows[0];
    if (!first) return SWALLOWED;
    return { intent: { kind: "move", rowId: first.id, column: clampColumn(state.activeColumn, first.cellCount) }, consumed: true };
  }

  const row = state.rows[index];
  // Clamped against *this* row, not the widest one: a band has four cells whatever the object rows
  // beside it show, and an index past its last cell is a column the author cannot see or reach.
  const column = clampColumn(state.activeColumn, row.cellCount);

  switch (event.key) {
    case "ArrowDown":
    case "ArrowUp": {
      const step = event.key === "ArrowDown" ? 1 : -1;
      // Shift extends over objects only. Bands and masks are not selectable, and a range that
      // silently skipped them would report a selection the author cannot see.
      if (event.shiftKey && !accel) {
        const next = seekSelectable(state.rows, index, step);
        if (!next) return SWALLOWED;
        return { intent: { kind: "extend", rowId: next.id, column: clampColumn(column, next.cellCount) }, consumed: true };
      }
      const next = state.rows[index + step];
      if (!next) return SWALLOWED;
      const landing = clampColumn(column, next.cellCount);
      // A plain arrow takes the selection with it, so the anchor stays where the author is looking.
      // Without this the tab stop drifts away from the anchor and the next Shift+Down claims every row
      // between them — a three-row gesture that selects two hundred. Hold the accelerator to navigate
      // without disturbing the set, which is the one case where the drift is the point.
      if (accel || !isSelectable(next)) {
        return { intent: { kind: "move", rowId: next.id, column: landing }, consumed: true };
      }
      return { intent: { kind: "select", rowId: next.id, column: landing }, consumed: true };
    }

    case "ArrowLeft": {
      // Hierarchy lives on the first cell; movement lives everywhere else. One key, one meaning,
      // decided by where it is pressed.
      if (column > 0) return { intent: { kind: "move", rowId: row.id, column: column - 1 }, consumed: true };
      if (row.expandable && row.expanded) return { intent: { kind: "collapse", rowId: row.id }, consumed: true };
      return SWALLOWED;
    }

    case "ArrowRight": {
      if (column === 0 && row.expandable && !row.expanded) {
        return { intent: { kind: "expand", rowId: row.id }, consumed: true };
      }
      if (column + 1 < row.cellCount) {
        return { intent: { kind: "move", rowId: row.id, column: column + 1 }, consumed: true };
      }
      return SWALLOWED;
    }

    case "Home": {
      // Row-scoped bare, column-scoped with the accelerator — the spreadsheet convention, so the
      // author does not lose their column to reach the top.
      if (accel) {
        const first = state.rows[0];
        if (!first) return SWALLOWED;
        return { intent: { kind: "move", rowId: first.id, column: clampColumn(column, first.cellCount) }, consumed: true };
      }
      return { intent: { kind: "move", rowId: row.id, column: 0 }, consumed: true };
    }

    case "End": {
      if (accel) {
        const last = state.rows[state.rows.length - 1];
        if (!last) return SWALLOWED;
        return { intent: { kind: "move", rowId: last.id, column: clampColumn(column, last.cellCount) }, consumed: true };
      }
      return { intent: { kind: "move", rowId: row.id, column: row.cellCount - 1 }, consumed: true };
    }

    case " ":
    case "Spacebar": {
      if (accel && !event.shiftKey) {
        if (!isSelectable(row)) return SWALLOWED;
        return { intent: { kind: "toggleMember", rowId: row.id, column }, consumed: true };
      }
      if (event.shiftKey && !accel) {
        if (!isSelectable(row)) return SWALLOWED;
        return { intent: { kind: "extend", rowId: row.id, column }, consumed: true };
      }
      // Bare Space is visibility, which bands and masks have as well as objects.
      return { intent: { kind: "toggleVisibility", rowId: row.id }, consumed: true };
    }

    case "Enter":
    case "F2": {
      return { intent: { kind: "beginEdit", rowId: row.id, column }, consumed: true };
    }

    case "Delete":
    case "Backspace": {
      if (!isSelectable(row)) return SWALLOWED;
      return { intent: { kind: "delete" }, consumed: true };
    }

    default:
      return REFUSED;
  }
}

/** Only object rows join a selection: a band is a container and a mask belongs to its object. */
export function isSelectable(row: TreeRow | undefined): boolean {
  return Boolean(row && row.kind === "object");
}

function seekSelectable(rows: readonly TreeRow[], from: number, step: number): TreeRow | undefined {
  for (let at = from + step; at >= 0 && at < rows.length; at += step) {
    if (isSelectable(rows[at])) return rows[at];
  }
  return undefined;
}

function isNavigationKey(key: string): boolean {
  return key === "ArrowDown" || key === "ArrowUp" || key === "ArrowLeft"
    || key === "ArrowRight" || key === "Home" || key === "End";
}

function clampColumn(column: number, total: number): number {
  if (!Number.isFinite(column) || column < 0) return 0;
  return Math.min(Math.trunc(column), Math.max(0, total - 1));
}
