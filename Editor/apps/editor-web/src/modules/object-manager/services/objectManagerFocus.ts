import type { TreeRow } from "./objectManagerTree";

/**
 * Where the panel's one tab stop goes when the rows underneath it change.
 *
 * Two failures this exists to prevent. A row that disappears — deleted, collapsed into its parent,
 * filtered out by a search — takes the tab stop with it, and a grid with no tab stop drops the author
 * back to the top of the document on the next Tab. And the opposite: a panel that *takes* focus
 * because its contents changed steals the caret out of whatever the author was typing somewhere else.
 *
 * So every answer here is a *target*, not an act. The caller moves focus only when it already had it.
 */

export type FocusReason =
  /** Rows changed under us: a delete, a collapse, a search, a scene edit from another panel. */
  | "rows-changed"
  /** The scene closed; there are no rows to hold anything. */
  | "scene-closed"
  /** The panel was re-docked and is mounting again. */
  | "remounted";

export interface FocusTarget {
  rowId: string | null;
  column: number;
  /** False when the caller must leave the caret where it is and only remember the cell. */
  moveFocus: boolean;
  /** True when nothing in the grid can hold focus and the empty state or heading must. */
  fallback: boolean;
}

export interface FocusRequest {
  rows: readonly TreeRow[];
  /** The cell the panel held before the change. */
  previousRowId: string | null;
  previousColumn: number;
  /** The draw order before the change, used to find the nearest surviving neighbour. */
  previousRows: readonly TreeRow[];
  reason: FocusReason;
  /** True when the focus was inside this panel at the moment of the change. */
  hadFocus: boolean;
}

export function resolveFocusTarget(request: FocusRequest): FocusTarget {
  // A column can vanish too — untick the one the tab stop was sitting in and the cell index is past
  // the end of every row. Clamping is not cosmetic: an index nothing renders is a lost tab stop.
  const widest = request.rows.reduce((most, row) => Math.max(most, row.cellCount), 1);
  const column = clampColumn(request.previousColumn, widest);

  if (request.reason === "scene-closed" || request.rows.length === 0) {
    return { rowId: null, column, moveFocus: request.hadFocus, fallback: true };
  }

  // A re-dock remounts the panel with the same rows. Restoring the cell is right; pulling the caret
  // into it is not, unless the author was already in here when the drag began.
  if (request.reason === "remounted") {
    const survivor = request.previousRowId
      ? request.rows.find((row) => row.id === request.previousRowId)
      : undefined;
    const landing = survivor ?? request.rows[0];
    return { rowId: landing.id, column: clampColumn(column, landing.cellCount), moveFocus: request.hadFocus, fallback: false };
  }

  if (request.previousRowId) {
    const survivor = request.rows.find((row) => row.id === request.previousRowId);
    if (survivor) {
      // The row is still here. Nothing to resolve, and nothing to steal.
      return { rowId: survivor.id, column: clampColumn(column, survivor.cellCount), moveFocus: false, fallback: false };
    }
  }

  const nearest = nearestSurvivor(request.previousRows, request.rows, request.previousRowId);
  if (nearest) {
    const landing = request.rows.find((row) => row.id === nearest);
    return { rowId: nearest, column: clampColumn(column, landing?.cellCount ?? widest), moveFocus: request.hadFocus, fallback: false };
  }

  // Nothing near it survived, so the top of the panel is the honest answer.
  return { rowId: request.rows[0].id, column: clampColumn(column, request.rows[0].cellCount), moveFocus: request.hadFocus, fallback: false };
}

/**
 * The nearest row that is still drawn: forwards first, then backwards.
 *
 * Forwards first because a delete reads as "that one is gone, the list closed up" — landing on the
 * row that took its place is the same cell the author was already looking at. Only at the end of a
 * band does going back make sense.
 *
 * Object rows are preferred over bands and masks in both directions before either is accepted: after
 * deleting the last object in a band, the row that physically follows is the *next band's* header,
 * and landing a delete-and-repeat rhythm on a header means the next Delete does nothing.
 */
function nearestSurvivor(
  previousRows: readonly TreeRow[],
  rows: readonly TreeRow[],
  previousRowId: string | null
): string | null {
  if (!previousRowId) return null;
  const from = previousRows.findIndex((row) => row.id === previousRowId);
  if (from === -1) return null;
  const alive = new Set(rows.map((row) => row.id));

  return scan(previousRows, from, alive, true) ?? scan(previousRows, from, alive, false);
}

function scan(
  previousRows: readonly TreeRow[],
  from: number,
  alive: ReadonlySet<string>,
  objectsOnly: boolean
): string | null {
  const accepts = (row: TreeRow): boolean =>
    alive.has(row.id) && (!objectsOnly || row.kind === "object");

  for (let at = from + 1; at < previousRows.length; at += 1) {
    if (accepts(previousRows[at])) return previousRows[at].id;
  }
  for (let at = from - 1; at >= 0; at -= 1) {
    if (accepts(previousRows[at])) return previousRows[at].id;
  }
  return null;
}

function clampColumn(column: number, total: number): number {
  if (!Number.isFinite(column) || column < 0) return 0;
  return Math.min(Math.trunc(column), Math.max(0, total - 1));
}
