/**
 * The Editor's dock: which panels exist, and where the workspace layout is kept.
 *
 * ## Why this is thin
 *
 * The layout itself lives in dockview, which owns the grid, the floating groups and the popout
 * windows. Mirroring that tree into Zustand would create two truths about where a panel is, and the
 * one the user sees would be dockview's. So this store holds the *api handle* and the panel
 * catalogue, and every layout question is asked of dockview directly.
 *
 * What replaced what: the previous store modelled the workspace as three fixed areas
 * (`"left" | "right" | "bottom"`) each holding stacks. That was the rigidity — a panel could only
 * ever be in one of three places, and the viewport could not participate at all. There is no area
 * concept here on purpose: a panel goes wherever the user drops it, including beside the viewport,
 * floating over it, or in its own OS window.
 */
import { create } from "zustand";
import type { DockviewApi } from "dockview-react";

export type DockPanelId =
  | "templates"
  | "object-library"
  | "scene-manager"
  | "object-inspector"
  | "material-manager"
  | "font-manager"
  | "ae-controls"
  | "automation"
  | "render-engine"
  | "timeline";

/**
 * The viewport is a dock panel like any other, so it can be split against, floated over, or moved.
 * It is kept out of `DockPanelId` because it is not one of the author's tool panels: it cannot be
 * closed, and `renderDockPanel` does not produce it.
 */
export const VIEWPORT_PANEL_ID = "viewport";

/** Every tool panel the Editor has, in the order the View menu lists them. */
export const allDockPanels: DockPanelId[] = [
  "templates",
  "object-library",
  "scene-manager",
  "object-inspector",
  "material-manager",
  "font-manager",
  "automation",
  "ae-controls",
  "render-engine",
  "timeline"
];

/**
 * Bumped because the shape changed completely: a v4 value is three areas of stacks, which cannot be
 * read as a dockview grid. An old key is ignored rather than migrated — there is no honest mapping
 * from "left area, second stack" onto a free-form grid, and guessing one would put panels somewhere
 * the user never chose. They get the default layout once, then their own arrangement persists.
 */
const dockLayoutStorageKey = "grapix-dock-layout-v5";

interface DockState {
  /** Set once dockview is ready; null before the workspace has mounted. */
  api: DockviewApi | null;
  setApi: (api: DockviewApi | null) => void;
  /** Bring a panel to the front of whichever group holds it, adding it back if it was closed. */
  activatePanel: (panelId: DockPanelId) => void;
  /** Float a panel free of the grid, over the workspace. */
  floatPanel: (panelId: DockPanelId) => void;
  /** Move a panel into its own OS window. */
  popOutPanel: (panelId: DockPanelId) => void;
  /** Discard the saved arrangement and rebuild the default one. */
  resetDockLayout: () => void;
}

export const useDockStore = create<DockState>((set, get) => ({
  api: null,
  setApi: (api) => set({ api }),
  activatePanel: (panelId) => {
    const api = get().api;
    if (!api) return;
    const panel = api.getPanel(panelId);
    // A panel the user closed is gone from the layout, so "show it" has to add it back rather than
    // fail silently — which is what a View-menu entry means.
    if (panel) panel.api.setActive();
    else addToolPanel(api, panelId);
  },
  floatPanel: (panelId) => {
    const api = get().api;
    const panel = api?.getPanel(panelId);
    if (api && panel) api.addFloatingGroup(panel);
  },
  popOutPanel: (panelId) => {
    const api = get().api;
    const panel = api?.getPanel(panelId);
    if (api && panel) void api.addPopoutGroup(panel);
  },
  resetDockLayout: () => {
    const api = get().api;
    if (!api) return;
    clearSavedDockLayout();
    api.clear();
    buildDefaultLayout(api);
  }
}));

/** Add one tool panel with no position, letting dockview place it in the active group. */
export function addToolPanel(api: DockviewApi, panelId: DockPanelId): void {
  api.addPanel({ id: panelId, component: panelId, title: titleForPanel(panelId) });
}

export function readSavedDockLayout(): unknown | null {
  try {
    const raw = localStorage.getItem(dockLayoutStorageKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // A corrupt value is not worth failing the whole workspace over; the default layout is a
    // perfectly good answer to "we could not read your arrangement".
    return null;
  }
}

export function saveDockLayout(layout: unknown): void {
  try {
    localStorage.setItem(dockLayoutStorageKey, JSON.stringify(layout));
  } catch {
    // Storage can be full or blocked; losing the arrangement is not worth an error to the author.
  }
}

export function clearSavedDockLayout(): void {
  localStorage.removeItem(dockLayoutStorageKey);
}

/**
 * The layout a first run gets: the shape the Editor had before, expressed as a grid.
 *
 * The viewport is added first so every other panel is positioned relative to it — that is what makes
 * this a viewport-centred workspace rather than three boxes around a hole. Everything after is a
 * direction from something already placed, so the result is readable as a sentence: library left of
 * the viewport, inspector right of it, timeline below it.
 */
export function buildDefaultLayout(api: DockviewApi): void {
  api.addPanel({ id: VIEWPORT_PANEL_ID, component: VIEWPORT_PANEL_ID, title: "Viewport" });

  const panel = (id: DockPanelId, referencePanel: string, direction: "left" | "right" | "below" | "above") =>
    api.addPanel({
      id,
      component: id,
      title: titleForPanel(id),
      position: { referencePanel, direction }
    });

  panel("object-library", VIEWPORT_PANEL_ID, "left");
  panel("templates", "object-library", "below");
  panel("object-inspector", VIEWPORT_PANEL_ID, "right");
  panel("scene-manager", "object-inspector", "above");
  panel("timeline", VIEWPORT_PANEL_ID, "below");

  // Stacked as tabs onto panels already placed: these share space with a sibling rather than
  // claiming their own region, which is how the old layout read too.
  for (const [id, host] of [
    ["material-manager", "object-inspector"],
    ["font-manager", "object-inspector"],
    ["ae-controls", "scene-manager"],
    ["automation", "timeline"],
    ["render-engine", "timeline"]
  ] as [DockPanelId, string][]) {
    api.addPanel({
      id,
      component: id,
      title: titleForPanel(id),
      position: { referencePanel: host, direction: "within" },
      // Added without stealing focus, so the default workspace opens on the panels above rather
      // than on whichever of these was added last.
      inactive: true
    });
  }

  api.getPanel(VIEWPORT_PANEL_ID)?.api.setActive();
}

export function titleForPanel(panelId: DockPanelId): string {
  switch (panelId) {
    case "templates":
      return "Templates";
    case "object-library":
      return "Object Library";
    case "scene-manager":
      return "Object Manager";
    case "object-inspector":
      return "Object Inspector";
    case "material-manager":
      return "Material Manager";
    case "font-manager":
      return "Font Manager";
    case "ae-controls":
      return "After Effects";
    case "automation":
      return "Automation";
    case "render-engine":
      return "Render Engine";
    case "timeline":
      return "Timeline";
  }
}
