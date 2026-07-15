import { create } from "zustand";

export type MaterialManagerSelectionKind = "material" | "asset" | "shader" | "instance";
export type MaterialManagerFilter = "all" | "materials" | "images" | "shaders" | "missing" | "in-use";
export type MaterialManagerView = "grid" | "list";

export interface MaterialManagerSelection {
  kind: MaterialManagerSelectionKind;
  id: string;
}

interface MaterialManagerState {
  search: string;
  filter: MaterialManagerFilter;
  view: MaterialManagerView;
  thumbnailSize: number;
  selection: MaterialManagerSelection | null;
  multiSelection: MaterialManagerSelection[];
  importing: boolean;
  contextMenu: { x: number; y: number; selection: MaterialManagerSelection } | null;
  setSearch: (search: string) => void;
  setFilter: (filter: MaterialManagerFilter) => void;
  setView: (view: MaterialManagerView) => void;
  setThumbnailSize: (thumbnailSize: number) => void;
  select: (selection: MaterialManagerSelection | null) => void;
  toggleSelection: (selection: MaterialManagerSelection) => void;
  setImporting: (importing: boolean) => void;
  openContextMenu: (x: number, y: number, selection: MaterialManagerSelection) => void;
  closeContextMenu: () => void;
}

const storageKey = "grapix-material-manager-v1";
const persisted = readPersistedState();

export const useMaterialManagerStore = create<MaterialManagerState>((set) => ({
  search: "",
  filter: persisted.filter,
  view: persisted.view,
  thumbnailSize: persisted.thumbnailSize,
  selection: null,
  multiSelection: [],
  importing: false,
  contextMenu: null,
  setSearch: (search) => set({ search }),
  setFilter: (filter) => set((state) => persist({ ...state, filter })),
  setView: (view) => set((state) => persist({ ...state, view })),
  setThumbnailSize: (thumbnailSize) => set((state) => persist({
    ...state,
    thumbnailSize: Math.max(72, Math.min(220, thumbnailSize))
  })),
  select: (selection) => set({ selection, multiSelection: selection ? [selection] : [], contextMenu: null }),
  toggleSelection: (selection) => set((state) => {
    const exists = state.multiSelection.some((item) => item.kind === selection.kind && item.id === selection.id);
    const multiSelection = exists
      ? state.multiSelection.filter((item) => item.kind !== selection.kind || item.id !== selection.id)
      : [...state.multiSelection, selection];
    return { multiSelection, selection: exists ? multiSelection.at(-1) ?? null : selection, contextMenu: null };
  }),
  setImporting: (importing) => set({ importing }),
  openContextMenu: (x, y, selection) => set({ contextMenu: { x, y, selection }, selection }),
  closeContextMenu: () => set({ contextMenu: null })
}));

function readPersistedState(): Pick<MaterialManagerState, "filter" | "view" | "thumbnailSize"> {
  const fallback: Pick<MaterialManagerState, "filter" | "view" | "thumbnailSize"> = { filter: "all", view: "grid", thumbnailSize: 112 };
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "") as Partial<typeof fallback>;
    return {
      filter: isFilter(value.filter) ? value.filter : fallback.filter,
      view: value.view === "list" ? "list" : "grid",
      thumbnailSize: typeof value.thumbnailSize === "number" ? value.thumbnailSize : fallback.thumbnailSize
    };
  } catch {
    return fallback;
  }
}

function persist(state: MaterialManagerState): Partial<MaterialManagerState> {
  localStorage.setItem(storageKey, JSON.stringify({
    filter: state.filter,
    view: state.view,
    thumbnailSize: state.thumbnailSize
  }));
  return state;
}

function isFilter(value: unknown): value is MaterialManagerFilter {
  return ["all", "materials", "images", "shaders", "missing", "in-use"].includes(String(value));
}
