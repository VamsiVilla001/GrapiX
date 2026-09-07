import { create } from "zustand";
import { useProfileStore } from "./profileStore";

export type DockAreaId = "left" | "right" | "bottom";
export type DockPanelId = "templates" | "design-import" | "scene-manager" | "properties" | "timeline";

/**
 * Dock layout.
 *
 * The active profile owns the layout, so every change is written back to it. localStorage
 * stays as the fallback for browser-only debugging, where no profile service is running.
 */

const DOCK_STORAGE_KEY = "grapix-dock-layout-v2";

interface DockState {
  areas: Record<DockAreaId, DockPanelId[]>;
  movePanel: (panelId: DockPanelId, areaId: DockAreaId, insertIndex?: number) => void;
  resetDockLayout: () => void;
  /** Seeds the layout from a launched profile. */
  applyProfileLayout: (dock: Record<string, string[]> | undefined) => void;
}

const defaultAreas: Record<DockAreaId, DockPanelId[]> = {
  left: ["templates", "design-import", "scene-manager"],
  right: ["properties"],
  bottom: ["timeline"]
};

const allDockPanels: DockPanelId[] = [
  "templates",
  "design-import",
  "scene-manager",
  "properties",
  "timeline"
];

export const useDockStore = create<DockState>((set) => ({
  areas: readDockLayout(),

  movePanel: (panelId, areaId, insertIndex) =>
    set((state) => {
      const withoutPanel = Object.fromEntries(
        Object.entries(state.areas).map(([key, panels]) => [
          key,
          panels.filter((item) => item !== panelId)
        ])
      ) as Record<DockAreaId, DockPanelId[]>;
      const targetPanels = [...withoutPanel[areaId]];
      const targetIndex = insertIndex ?? targetPanels.length;

      targetPanels.splice(targetIndex, 0, panelId);

      const nextAreas = {
        ...withoutPanel,
        [areaId]: targetPanels
      };

      persistDockLayout(nextAreas);

      return { areas: nextAreas };
    }),

  resetDockLayout: () => {
    persistDockLayout(defaultAreas);
    set({ areas: defaultAreas });
  },

  applyProfileLayout: (dock) => {
    if (!dock || !Object.keys(dock).length) {
      return;
    }

    set({ areas: normalizeDockLayout(dock) });
  }
}));

/** Writes to the active profile, and to localStorage as the browser-only fallback. */
function persistDockLayout(layout: Record<DockAreaId, DockPanelId[]>): void {
  try {
    localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Non-fatal.
  }

  const { activeProfile, saveWorkspaceLayout } = useProfileStore.getState();

  if (activeProfile) {
    saveWorkspaceLayout({
      dock: layout,
      panelSizes: activeProfile.workspaceLayout?.panelSizes ?? {}
    });
  }
}

function readDockLayout(): Record<DockAreaId, DockPanelId[]> {
  try {
    const raw = localStorage.getItem(DOCK_STORAGE_KEY);

    if (!raw) {
      return defaultAreas;
    }

    return normalizeDockLayout(JSON.parse(raw) as Record<string, string[]>);
  } catch {
    return defaultAreas;
  }
}

/**
 * Drops panel ids this build no longer has and re-adds any that are missing, so a layout
 * saved by an older build (which had the Object Library) still opens cleanly.
 */
function normalizeDockLayout(layout: Record<string, string[]>): Record<DockAreaId, DockPanelId[]> {
  const known = new Set<string>(allDockPanels);
  const keep = (panels: string[] | undefined): DockPanelId[] =>
    (panels ?? []).filter((panelId): panelId is DockPanelId => known.has(panelId));

  const next: Record<DockAreaId, DockPanelId[]> = {
    left: keep(layout.left),
    right: keep(layout.right),
    bottom: keep(layout.bottom)
  };

  const visible = new Set([...next.left, ...next.right, ...next.bottom]);

  for (const panelId of allDockPanels) {
    if (!visible.has(panelId)) {
      next.left.push(panelId);
    }
  }

  return next;
}
