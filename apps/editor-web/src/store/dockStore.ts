import { create } from "zustand";

export type DockAreaId = "left" | "right" | "bottom";
export type DockPanelId = "templates" | "object-library" | "scene-manager" | "properties" | "material-manager" | "timeline";

export interface DockStack {
  id: string;
  panels: DockPanelId[];
  activePanelId: DockPanelId;
}

export type DockLayout = Record<DockAreaId, DockStack[]>;

interface DockState {
  areas: DockLayout;
  movePanelToArea: (panelId: DockPanelId, areaId: DockAreaId, stackIndex?: number) => void;
  movePanelToStack: (panelId: DockPanelId, areaId: DockAreaId, stackId: string, insertIndex?: number) => void;
  setActivePanel: (areaId: DockAreaId, stackId: string, panelId: DockPanelId) => void;
  resetDockLayout: () => void;
}

const allDockPanels: DockPanelId[] = ["templates", "object-library", "scene-manager", "properties", "material-manager", "timeline"];
const dockLayoutStorageKey = "grapix-dock-layout-v2";
const legacyDockLayoutStorageKey = "grapix-dock-layout-v1";

export const useDockStore = create<DockState>((set) => ({
  areas: readDockLayout(),
  movePanelToArea: (panelId, areaId, stackIndex) =>
    set((state) => {
      const layoutWithoutPanel = removePanelFromLayout(state.areas, panelId);
      const nextAreas = cloneLayout(layoutWithoutPanel);
      const targetStacks = [...nextAreas[areaId]];
      const targetIndex = Math.max(0, Math.min(stackIndex ?? targetStacks.length, targetStacks.length));

      targetStacks.splice(targetIndex, 0, {
        id: createStackId(areaId, panelId, targetStacks),
        panels: [panelId],
        activePanelId: panelId
      });

      nextAreas[areaId] = targetStacks;

      saveDockLayout(nextAreas);

      return {
        areas: nextAreas
      };
    }),
  movePanelToStack: (panelId, areaId, stackId, insertIndex) =>
    set((state) => {
      const layoutWithoutPanel = removePanelFromLayout(state.areas, panelId);
      const nextAreas = cloneLayout(layoutWithoutPanel);
      const targetStack = nextAreas[areaId].find((stack) => stack.id === stackId);

      if (!targetStack) {
        return { areas: state.areas };
      }

      const targetIndex = Math.max(0, Math.min(insertIndex ?? targetStack.panels.length, targetStack.panels.length));
      targetStack.panels.splice(targetIndex, 0, panelId);
      targetStack.activePanelId = panelId;

      saveDockLayout(nextAreas);

      return { areas: nextAreas };
    }),
  setActivePanel: (areaId, stackId, panelId) =>
    set((state) => {
      const nextAreas = cloneLayout(state.areas);
      const targetStack = nextAreas[areaId].find((stack) => stack.id === stackId);

      if (!targetStack || !targetStack.panels.includes(panelId)) {
        return { areas: state.areas };
      }

      targetStack.activePanelId = panelId;
      saveDockLayout(nextAreas);

      return { areas: nextAreas };
    }),
  resetDockLayout: () => {
    const defaultAreas = createDefaultDockLayout();
    saveDockLayout(defaultAreas);
    set({ areas: defaultAreas });
  }
}));

function createDefaultDockLayout(): DockLayout {
  return {
    left: [
      {
        id: "left-browser-stack",
        panels: ["templates", "object-library"],
        activePanelId: "templates"
      },
      {
        id: "left-scene-stack",
        panels: ["scene-manager"],
        activePanelId: "scene-manager"
      }
    ],
    right: [
      {
        id: "right-inspector-stack",
        panels: ["properties", "material-manager"],
        activePanelId: "properties"
      }
    ],
    bottom: [
      {
        id: "bottom-timeline-stack",
        panels: ["timeline"],
        activePanelId: "timeline"
      }
    ]
  };
}

function readDockLayout(): DockLayout {
  try {
    const parsed = JSON.parse(localStorage.getItem(dockLayoutStorageKey) ?? "") as DockLayout;

    if (hasDockAreas(parsed)) {
      const mergedLayout = mergeMissingDockPanels(parsed);
      saveDockLayout(mergedLayout);

      return mergedLayout;
    }
  } catch {
    const migratedLayout = readLegacyDockLayout();

    if (migratedLayout) {
      return migratedLayout;
    }

    return createDefaultDockLayout();
  }

  return createDefaultDockLayout();
}

function saveDockLayout(layout: DockLayout): void {
  localStorage.setItem(dockLayoutStorageKey, JSON.stringify(layout));
}

function readLegacyDockLayout(): DockLayout | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(legacyDockLayoutStorageKey) ?? "") as Record<DockAreaId, DockPanelId[]>;

    if (!parsed.left || !parsed.right || !parsed.bottom) {
      return null;
    }

    const migratedLayout: DockLayout = {
      left: panelsToStacks("left", parsed.left),
      right: panelsToStacks("right", parsed.right),
      bottom: panelsToStacks("bottom", parsed.bottom)
    };
    const mergedLayout = mergeMissingDockPanels(migratedLayout);

    saveDockLayout(mergedLayout);

    return mergedLayout;
  } catch {
    return null;
  }
}

function panelsToStacks(areaId: DockAreaId, panels: DockPanelId[]): DockStack[] {
  return panels.filter(isDockPanelId).map((panelId) => ({
    id: `${areaId}-${panelId}-stack`,
    panels: [panelId],
    activePanelId: panelId
  }));
}

function mergeMissingDockPanels(layout: DockLayout): DockLayout {
  const knownPanels = new Set(allDockPanels);
  const visiblePanels = new Set<DockPanelId>();
  const nextLayout: DockLayout = {
    left: sanitizeStacks("left", layout.left, knownPanels, visiblePanels),
    right: sanitizeStacks("right", layout.right, knownPanels, visiblePanels),
    bottom: sanitizeStacks("bottom", layout.bottom, knownPanels, visiblePanels)
  };

  for (const panelId of allDockPanels) {
    if (!visiblePanels.has(panelId)) {
      const targetArea = panelId === "material-manager" ? "right" : "left";
      nextLayout[targetArea].push({
        id: createStackId(targetArea, panelId, nextLayout[targetArea]),
        panels: [panelId],
        activePanelId: panelId
      });
    }
  }

  return nextLayout;
}

function sanitizeStacks(
  areaId: DockAreaId,
  stacks: DockStack[],
  knownPanels: Set<DockPanelId>,
  visiblePanels: Set<DockPanelId>
): DockStack[] {
  if (!Array.isArray(stacks)) {
    return [];
  }

  return stacks
    .map((stack, stackIndex) => {
      const panels = Array.isArray(stack.panels)
        ? stack.panels.filter((panelId) => knownPanels.has(panelId) && !visiblePanels.has(panelId))
        : [];

      for (const panelId of panels) {
        visiblePanels.add(panelId);
      }

      return {
        id: typeof stack.id === "string" && stack.id.length > 0 ? stack.id : `${areaId}-stack-${stackIndex + 1}`,
        panels,
        activePanelId: panels.includes(stack.activePanelId) ? stack.activePanelId : panels[0]
      };
    })
    .filter((stack): stack is DockStack => Boolean(stack.activePanelId) && stack.panels.length > 0);
}

function removePanelFromLayout(layout: DockLayout, panelId: DockPanelId): DockLayout {
  return {
    left: removePanelFromStacks(layout.left, panelId),
    right: removePanelFromStacks(layout.right, panelId),
    bottom: removePanelFromStacks(layout.bottom, panelId)
  };
}

function removePanelFromStacks(stacks: DockStack[], panelId: DockPanelId): DockStack[] {
  return stacks
    .map((stack) => {
      const panels = stack.panels.filter((item) => item !== panelId);

      return {
        ...stack,
        panels,
        activePanelId: panels.includes(stack.activePanelId) ? stack.activePanelId : panels[0]
      };
    })
    .filter((stack): stack is DockStack => Boolean(stack.activePanelId) && stack.panels.length > 0);
}

function cloneLayout(layout: DockLayout): DockLayout {
  return {
    left: layout.left.map(cloneStack),
    right: layout.right.map(cloneStack),
    bottom: layout.bottom.map(cloneStack)
  };
}

function cloneStack(stack: DockStack): DockStack {
  return {
    id: stack.id,
    panels: [...stack.panels],
    activePanelId: stack.activePanelId
  };
}

function createStackId(areaId: DockAreaId, panelId: DockPanelId, stacks: DockStack[]): string {
  const baseId = `${areaId}-${panelId}-stack`;
  let candidateId = baseId;
  let suffix = 2;

  while (stacks.some((stack) => stack.id === candidateId)) {
    candidateId = `${baseId}-${suffix}`;
    suffix += 1;
  }

  return candidateId;
}

function hasDockAreas(layout: DockLayout): boolean {
  return Boolean(layout?.left && layout?.right && layout?.bottom);
}

function isDockPanelId(panelId: string): panelId is DockPanelId {
  return allDockPanels.includes(panelId as DockPanelId);
}
