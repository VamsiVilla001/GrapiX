import { create } from "zustand";

export type DockAreaId = "left" | "right" | "bottom";
export type DockPanelId = "templates" | "object-library" | "scene-manager" | "properties" | "timeline";

interface DockState {
  areas: Record<DockAreaId, DockPanelId[]>;
  movePanel: (panelId: DockPanelId, areaId: DockAreaId, insertIndex?: number) => void;
  resetDockLayout: () => void;
}

const defaultAreas: Record<DockAreaId, DockPanelId[]> = {
  left: ["templates", "object-library", "scene-manager"],
  right: ["properties"],
  bottom: ["timeline"]
};
const allDockPanels: DockPanelId[] = ["templates", "object-library", "scene-manager", "properties", "timeline"];

export const useDockStore = create<DockState>((set) => ({
  areas: readDockLayout(),
  movePanel: (panelId, areaId, insertIndex) =>
    set((state) => {
      const withoutPanel = Object.fromEntries(
        Object.entries(state.areas).map(([key, panels]) => [key, panels.filter((item) => item !== panelId)])
      ) as Record<DockAreaId, DockPanelId[]>;
      const targetPanels = [...withoutPanel[areaId]];
      const targetIndex = insertIndex ?? targetPanels.length;

      targetPanels.splice(targetIndex, 0, panelId);

      const nextAreas = {
        ...withoutPanel,
        [areaId]: targetPanels
      };

      saveDockLayout(nextAreas);

      return {
        areas: nextAreas
      };
    }),
  resetDockLayout: () => {
    saveDockLayout(defaultAreas);
    set({ areas: defaultAreas });
  }
}));

function readDockLayout(): Record<DockAreaId, DockPanelId[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem("grapix-dock-layout-v1") ?? "") as Record<DockAreaId, DockPanelId[]>;

    if (parsed.left && parsed.right && parsed.bottom) {
      const mergedLayout = mergeMissingDockPanels(parsed);
      saveDockLayout(mergedLayout);

      return mergedLayout;
    }
  } catch {
    return defaultAreas;
  }

  return defaultAreas;
}

function saveDockLayout(layout: Record<DockAreaId, DockPanelId[]>): void {
  localStorage.setItem("grapix-dock-layout-v1", JSON.stringify(layout));
}

function mergeMissingDockPanels(layout: Record<DockAreaId, DockPanelId[]>): Record<DockAreaId, DockPanelId[]> {
  const knownPanels = new Set(allDockPanels);
  const nextLayout: Record<DockAreaId, DockPanelId[]> = {
    left: layout.left.filter((panelId) => knownPanels.has(panelId)),
    right: layout.right.filter((panelId) => knownPanels.has(panelId)),
    bottom: layout.bottom.filter((panelId) => knownPanels.has(panelId))
  };
  const visiblePanels = new Set([...nextLayout.left, ...nextLayout.right, ...nextLayout.bottom]);

  for (const panelId of allDockPanels) {
    if (!visiblePanels.has(panelId)) {
      nextLayout.left.push(panelId);
    }
  }

  return nextLayout;
}
