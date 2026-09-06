import { create } from "zustand";
import { toggleColumn, type ObjectColumnId, type ObjectColumnMode } from "../../../components/objectManagerColumns";
import {
  clampNameWidth,
  parsePreferences,
  serialisePreferences,
  type ObjectManagerPreferences
} from "../services/objectManagerPreferences";

/**
 * The Object Manager's own state: what it remembers and what it forgets.
 *
 * Two lifetimes, deliberately different.
 *
 * **Preferences persist** — the chosen columns, the column mode and the name-column width are the
 * author's working set, and an author expects those back after a refresh. They were previously in
 * `uiStore`, which has no persistence at all, so they survived a re-dock and died on reload.
 *
 * **Collapse is session-scoped** — it survives a re-dock, because losing it when a panel moves is
 * the complaint that started this, but not a reload. Persisting it would mean keeping a map of scene
 * ids to node ids and pruning stale entries on every projection, which is a new failure surface for
 * something an author reconstructs with two clicks.
 *
 * Nothing here reaches `SceneDocument`. Collapse, columns and widths are views of a scene, not part
 * of one.
 */

interface ObjectManagerState extends ObjectManagerPreferences {
  /** Collapsed rows: object ids for groups, `layerId`s for bands. Session-scoped. */
  collapsedIds: string[];
  setColumns: (columns: readonly ObjectColumnId[]) => void;
  toggleColumn: (column: ObjectColumnId) => void;
  setColumnMode: (mode: ObjectColumnMode) => void;
  setNameWidth: (width: number) => void;
  toggleCollapsed: (id: string) => void;
  expand: (id: string) => void;
}

const storageKey = "grapix-object-manager-v1";

export const useObjectManagerStore = create<ObjectManagerState>((set) => ({
  ...readPreferences(),
  collapsedIds: [],
  setColumns: (columns) => set((state) => persist({ ...state, columns: [...columns], columnMode: "custom" })),
  /**
   * Ticking a column adopts what is on screen and switches to `custom`.
   *
   * The caller passes the *visible* set, not the stored one: editing from the stored set would make
   * the first tick in "All properties" appear to delete nine columns the author can see.
   */
  toggleColumn: (column) => set((state) => persist({
    ...state,
    columns: toggleColumn(state.columns, column),
    columnMode: "custom"
  })),
  setColumnMode: (columnMode) => set((state) => persist({ ...state, columnMode })),
  setNameWidth: (width) => set((state) => persist({ ...state, nameWidth: clampNameWidth(width) })),
  toggleCollapsed: (id) => set((state) => ({
    collapsedIds: state.collapsedIds.includes(id)
      ? state.collapsedIds.filter((entry) => entry !== id)
      : [...state.collapsedIds, id]
  })),
  expand: (id) => set((state) => state.collapsedIds.includes(id)
    ? { collapsedIds: state.collapsedIds.filter((entry) => entry !== id) }
    : state)
}));

function readPreferences(): ObjectManagerPreferences {
  try {
    return parsePreferences(JSON.parse(localStorage.getItem(storageKey) ?? ""));
  } catch {
    // No stored payload, or one that is not JSON at all. Defaults, silently: a corrupt preference is
    // not something to tell an author about.
    return parsePreferences(null);
  }
}

function persist(state: ObjectManagerState): ObjectManagerState {
  try {
    localStorage.setItem(storageKey, serialisePreferences(state));
  } catch {
    // A full or blocked storage quota must not stop the panel from working; the preference simply
    // lasts as long as the session does.
  }
  return state;
}
