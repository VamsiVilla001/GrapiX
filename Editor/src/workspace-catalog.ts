// The workspaces that ship with GrapiX (plan row 11.94), and nothing else. A shipped workspace is a definition in code:
// no file holds it, nothing writes it, and "Reset to shipped" returns to exactly this.
//
// The Editor ships Design now: the arrangement authors have used, migrated from the four-region layout so what they see
// does not change. Animation, Data and automation, 3D and render, and Diagnostics follow with row 11.98, and Playout's
// Operator, Monitoring and Template control with row 12.12.

import type { AppKind, SavedWorkspace } from "./dock-model";
import { CARD_SORT_LAYOUT } from "./workspace-layout";
import { workspaceFromLayout } from "./workspace-io";
import type { WorkspaceSet } from "./workspace-presets";

export const EDITOR_DESIGN_ID = "factory.editor.design";

/** Panel kinds that were renamed since layouts were saved, old name to new. None yet: the first layout schema ships now. */
export const PANEL_ALIASES: Readonly<Record<string, string>> = {};

export function factoryWorkspaces(app: AppKind): Readonly<Record<string, SavedWorkspace>> {
  if (app === "editor") {
    return {
      [EDITOR_DESIGN_ID]: workspaceFromLayout(CARD_SORT_LAYOUT, {
        workspaceId: EDITOR_DESIGN_ID,
        name: "Design",
        origin: "factory",
        app: "editor",
      }),
    };
  }
  return {};
}

/** A set with only what ships and nothing saved. */
export function shippedSet(app: AppKind): WorkspaceSet {
  const factory = factoryWorkspaces(app);
  return { app, factory, saved: {}, session: {}, lastGood: {}, order: [], activeId: Object.keys(factory)[0] ?? "", leftAlone: [] };
}
