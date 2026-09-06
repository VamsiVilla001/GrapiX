import { orderColumns, type ObjectColumnId, type ObjectColumnMode } from "../../../components/objectManagerColumns";

/**
 * The Object Manager's remembered working set.
 *
 * These are author *preferences*, so they survive a reload — which nothing in this panel did before,
 * despite a comment claiming the chosen columns were "remembered": `uiStore` is a plain `create` with
 * no persistence, so the set survived a re-dock and died on refresh.
 *
 * Reading is defensive on purpose. A stored payload comes from a previous build, so it may name a
 * column this one has dropped, carry a width from a since-changed clamp, or be corrupt entirely. Each
 * field is validated independently: one bad value must not throw the others away.
 */

export interface ObjectManagerPreferences {
  /** The author's own chosen columns, in catalogue order. */
  columns: ObjectColumnId[];
  /** Which rule decides the visible columns. */
  columnMode: ObjectColumnMode;
  /** Width of the name column, in pixels. */
  nameWidth: number;
}

/** Enough to be useful on first open, far short of a spreadsheet. */
export const DEFAULT_PREFERENCES: ObjectManagerPreferences = {
  columns: ["opacity", "x", "y"],
  columnMode: "custom",
  nameWidth: 180
};

/**
 * The name column's limits.
 *
 * The lower bound keeps the badge and the disclosure control from squeezing the name to nothing; the
 * upper bound keeps the property columns on screen at a usable dock width.
 */
export const NAME_WIDTH_MIN = 120;
export const NAME_WIDTH_MAX = 480;

export function clampNameWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PREFERENCES.nameWidth;
  return Math.round(Math.max(NAME_WIDTH_MIN, Math.min(NAME_WIDTH_MAX, value)));
}

const COLUMN_MODES: readonly ObjectColumnMode[] = ["all", "keyframed", "custom"];

/**
 * Read a stored payload into preferences, keeping whatever is still valid.
 *
 * Unknown column ids are dropped rather than rendered, because a column the build no longer has would
 * otherwise leave a permanent blank stripe down the grid — `orderColumns` is the same filter the panel
 * already applies, so there is one definition of "a column this build knows".
 */
export function parsePreferences(raw: unknown): ObjectManagerPreferences {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_PREFERENCES };
  const value = raw as Partial<Record<keyof ObjectManagerPreferences, unknown>>;

  return {
    columns: Array.isArray(value.columns)
      ? orderColumns(value.columns.filter((id): id is string => typeof id === "string"))
      : [...DEFAULT_PREFERENCES.columns],
    columnMode: COLUMN_MODES.includes(value.columnMode as ObjectColumnMode)
      ? (value.columnMode as ObjectColumnMode)
      : DEFAULT_PREFERENCES.columnMode,
    nameWidth: typeof value.nameWidth === "number"
      ? clampNameWidth(value.nameWidth)
      : DEFAULT_PREFERENCES.nameWidth
  };
}

/** The payload to store. Only the three fields; nothing session-scoped leaks into it. */
export function serialisePreferences(preferences: ObjectManagerPreferences): string {
  return JSON.stringify({
    columns: preferences.columns,
    columnMode: preferences.columnMode,
    nameWidth: preferences.nameWidth
  });
}
