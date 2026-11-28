// The bridge between the page's four-region layout and the named workspaces (plan row 11.96, decided 24 Nov 2026).
//
// The workspace model keeps each arrangement as a tree of docks. The page does not draw a tree: it draws four regions (left, centre,
// right, bottom), and a tree cannot be turned back into regions reliably (stacked columns merge). So a workspace the page makes carries
// the page's own layout in its view state, next to the tree made from it, and the page trusts the carried layout only while the tree
// still says the same thing. A workspace made elsewhere, or changed since, is refused by name instead of being guessed at.
//
// When the docking engine replaces the regions, the tree becomes the truth and this key goes away.

import type { SavedWorkspace } from "./dock-model";
import { workspaceFromLayout, type LayoutMeta } from "./workspace-io";
import { LAYOUT_STORAGE_KEY, restoreLayout, type Layout, type LayoutStorage } from "./workspace-layout";

/** The view-state key the page's layout travels under. */
export const PAGE_LAYOUT_KEY = "page.layout";

/** The workspace for `layout`: the tree made from it, with the layout itself carried beside it. */
export function workspaceWithPageLayout(layout: Layout, meta: LayoutMeta): SavedWorkspace {
  const base = workspaceFromLayout(layout, meta);
  return { ...base, viewState: { ...base.viewState, [PAGE_LAYOUT_KEY]: layout } };
}

export type PageLayout = { readonly layout: Layout; readonly notes: readonly string[] } | { readonly unavailable: string };

export function isUnavailable(read: PageLayout): read is { readonly unavailable: string } {
  return "unavailable" in read;
}

function holding(raw: string): LayoutStorage {
  return { getItem: (key) => (key === LAYOUT_STORAGE_KEY ? raw : null), setItem: () => undefined };
}

/** The layout the page can show for `workspace`, reconciled against the panels this build has, or why it cannot be shown. */
export function pageLayoutOf(workspace: SavedWorkspace, knownPanels: readonly string[]): PageLayout {
  const carried = workspace.viewState[PAGE_LAYOUT_KEY];
  if (carried === undefined || carried === null || typeof carried !== "object") {
    return { unavailable: `${workspace.name} was not arranged on this page, so this page cannot show it yet` };
  }
  // The tree must say what the carried layout says, judged before the layout is reconciled with today's panels (a panel added or removed
  // since is a change of build, not of the file).
  let agrees = false;
  try {
    const made = workspaceFromLayout(carried as Layout, { workspaceId: workspace.workspaceId, name: workspace.name, origin: workspace.origin, app: workspace.app });
    agrees = JSON.stringify(made.root) === JSON.stringify(workspace.root) && JSON.stringify(made.instances) === JSON.stringify(workspace.instances);
  } catch {
    agrees = false;
  }
  if (!agrees) {
    return { unavailable: `${workspace.name}: the arrangement this page saved and the arrangement stored do not agree (it was changed outside the page), so it is not shown` };
  }
  const restored = restoreLayout(holding(JSON.stringify(carried)), knownPanels);
  return { layout: restored.layout, notes: restored.notes };
}
