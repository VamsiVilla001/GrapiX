// The workspace manager's commands (plan rows 11.92 and 11.93): the dock model's operations that need to know
// what a panel type is allowed to do. Opening a panel, closing one, and telling which panels cannot be shown
// here. Every function is pure: a workspace in, a workspace or a named refusal out.
//
// Nothing here touches a scene, a revision, the undo history or any output. A panel's own actions (a Take in
// the rundown, a save in the inspector) are the panel's; moving, hiding and showing the panel is not one.

import {
  closePanel,
  findGroup,
  focusPanel,
  freshId,
  groups,
  instanceOf,
  isDockRefused,
  normalizeWorkspace,
  withFocus,
  type DockRefusal,
  type PanelInstance,
  type SavedWorkspace,
  type TabsNode,
} from "./dock-model";
import { secretProblem, secretsIn } from "./dock-validate";
import { unavailableReason, type PanelRegistry } from "./panel-registry";

export interface OpenResult {
  readonly workspace: SavedWorkspace;
  readonly instanceId: string;
  /** False when the panel was already open and was only shown. */
  readonly created: boolean;
}

export interface OpenOptions {
  /** Open another instance of a panel that allows it, such as a second viewport. */
  readonly newInstance?: boolean;
  /** The features this build has. A panel that needs one that is absent is unavailable. */
  readonly capabilities?: ReadonlySet<string>;
}

function instancesOfType(workspace: SavedWorkspace, panelType: string): PanelInstance[] {
  return Object.values(workspace.instances).filter((instance) => instance.panelType === panelType);
}

function nextInstanceId(workspace: SavedWorkspace, panelType: string): string {
  for (let n = 1; ; n += 1) {
    const id = `${panelType}-${n}`;
    if (instanceOf(workspace, id) === undefined && freshId(workspace, id) === id) return id;
  }
}

/** Where a new panel goes: its registered group if there is one, else the group that last had focus, else the
 *  first group of the main layout. */
function placementFor(workspace: SavedWorkspace, hint: string | undefined): TabsNode {
  const hinted = hint === undefined ? undefined : findGroup(workspace, hint);
  if (hinted !== undefined) return hinted;
  const active = workspace.activeGroupId === undefined ? undefined : findGroup(workspace, workspace.activeGroupId);
  if (active !== undefined) return active;
  return groups(workspace)[0] ?? (workspace.root as TabsNode);
}

/** Open a panel, or show it if it is already open. A panel that is a singleton (or that allows only one) is
 *  never opened twice: it is brought forward, and asking explicitly for another is refused by name. A panel that
 *  this application or build cannot show is refused as unavailable. */
export function openPanel(
  workspace: SavedWorkspace,
  registry: PanelRegistry,
  panelType: string,
  options: OpenOptions = {},
): OpenResult | DockRefusal {
  const why = unavailableReason(registry, panelType, workspace.app, options.capabilities ?? new Set());
  if (why !== undefined) return { code: "PANEL_NOT_AVAILABLE", refused: why };
  const definition = registry.get(panelType)!;
  const open = instancesOfType(workspace, panelType);
  const single = definition.singleton || !definition.allowMultiple;

  if (open.length > 0 && (!options.newInstance || single)) {
    if (options.newInstance) {
      return { code: "DUPLICATE_SINGLETON", refused: `${definition.title} can only be open once, and it is already open` };
    }
    const shown = focusPanel(workspace, open[0]!.instanceId);
    return isDockRefused(shown) ? shown : { workspace: shown, instanceId: open[0]!.instanceId, created: false };
  }

  const instanceId = nextInstanceId(workspace, panelType);
  const target = placementFor(workspace, definition.defaultPlacement?.groupHint);
  const place = (node: TabsNode): TabsNode => {
    const at = Math.max(0, Math.min(definition.defaultPlacement?.tabIndex ?? node.panelInstanceIds.length, node.panelInstanceIds.length));
    const ids = [...node.panelInstanceIds];
    ids.splice(at, 0, instanceId);
    return { ...node, panelInstanceIds: ids, activePanelInstanceId: instanceId };
  };
  const insert = (node: SavedWorkspace["root"]): SavedWorkspace["root"] =>
    node.kind === "tabs" ? (node.id === target.id ? place(node) : node) : { ...node, children: node.children.map(insert) };
  // A panel opened while another group fills the window would be out of sight: `withFocus` restores that group.
  const next: SavedWorkspace = withFocus(
    normalizeWorkspace({
      ...workspace,
      root: insert(workspace.root),
      floats: workspace.floats.map((float) => ({ ...float, root: insert(float.root) })),
      instances: { ...workspace.instances, [instanceId]: { instanceId, panelType } },
    }),
    target.id,
  );
  return { workspace: next, instanceId, created: true };
}

/** Close a panel's tab, unless its kind cannot be closed. Only the tab goes: the panel's own work is untouched. */
export function closePanelChecked(workspace: SavedWorkspace, registry: PanelRegistry, instanceId: string): SavedWorkspace | DockRefusal {
  const instance = instanceOf(workspace, instanceId);
  const definition = instance === undefined ? undefined : registry.get(instance.panelType);
  if (definition !== undefined && !definition.allowClose) {
    return { code: "PANEL_NOT_CLOSABLE", refused: `${definition.title} cannot be closed. It can be moved to another place, or its group shown at full size.` };
  }
  return closePanel(workspace, instanceId);
}

export interface UnavailableInstance {
  readonly instanceId: string;
  readonly panelType: string;
  readonly reason: string;
}

/** The open panels this build cannot show, with the reason each is unavailable. They stay in the layout, so a
 *  layout from a build that had more panels is not damaged by opening it in one that has fewer: the page draws
 *  a labelled placeholder in their place. */
export function unavailableInstances(
  workspace: SavedWorkspace,
  registry: PanelRegistry,
  capabilities: ReadonlySet<string> = new Set(),
): UnavailableInstance[] {
  return Object.values(workspace.instances).flatMap((instance) => {
    const reason = unavailableReason(registry, instance.panelType, workspace.app, capabilities);
    return reason === undefined ? [] : [{ instanceId: instance.instanceId, panelType: instance.panelType, reason }];
  });
}

/** Keep a panel's interface preferences (its columns, its filter, what is expanded) under a key of the
 *  workspace. This is where a secret is caught: at the moment a panel tries to keep one, with the panel named,
 *  and not at the next start, when the whole layout would be refused for it. */
export function setPanelViewState(workspace: SavedWorkspace, key: string, value: unknown): SavedWorkspace | DockRefusal {
  if (key === "__proto__" || key === "") {
    return { code: "LAYOUT_VALIDATION_FAILED", refused: `view state cannot be kept under the key "${key}"`, problems: [{ rule: 9, reason: `viewState.${key} is not a key a panel may use` }] };
  }
  const found = secretsIn({ [key]: value }, "viewState");
  if (found.length > 0) {
    const problems = found.map(secretProblem);
    return { code: "LAYOUT_VALIDATION_FAILED", refused: `this view state was not kept: ${problems[0]!.reason}`, problems };
  }
  return { ...workspace, viewState: { ...workspace.viewState, [key]: value } };
}

/** Whether a panel type is open, and where: for the Panels menu's check marks. */
export function openTypes(workspace: SavedWorkspace): Set<string> {
  return new Set(Object.values(workspace.instances).map((instance) => instance.panelType));
}
