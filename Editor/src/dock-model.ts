// The dock model (plan row 11.92): the arrangement of panels as a tree, and every change to it.
//
// A workspace is a tree of splits and tab groups. A *split* lays its children side by side
// (`horizontal`) or one above another (`vertical`) with weights that add up to one; a *tab group* holds
// panels as tabs, one showing. Every operation here is a pure function from a workspace to a workspace
// (or to a refusal that names why), so the rules are held by tests and the page only draws the result.
//
// This model is independent of how the page draws it and of any docking library. It is interface state
// only: it never touches a scene, a revision, the undo history or any output. The dock tree is not the
// scene's object tree.
//
// The older four-region layout (`workspace-layout.ts`, layout version 3) is read by `workspace-io.ts`,
// which migrates it into this form.

export type Direction = "horizontal" | "vertical";
export type DockPosition = "left" | "right" | "top" | "bottom" | "center";
export type Side = Exclude<DockPosition, "center">;
export type AppKind = "editor" | "playout";

export interface TabsNode {
  readonly kind: "tabs";
  readonly id: string;
  readonly panelInstanceIds: readonly string[];
  readonly activePanelInstanceId: string | null;
}

export interface SplitNode {
  readonly kind: "split";
  readonly id: string;
  readonly direction: Direction;
  /** One weight per child: positive, finite, adding up to one. */
  readonly weights: readonly number[];
  readonly children: readonly DockNode[];
}

export type DockNode = SplitNode | TabsNode;

export interface PanelContext {
  readonly mode: "follow" | "pinned";
  readonly entityId?: string;
}

export interface PanelInstance {
  readonly instanceId: string;
  readonly panelType: string;
  readonly context?: PanelContext;
  readonly viewStateRef?: string;
}

export interface Bounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FloatingGroup {
  readonly id: string;
  readonly root: DockNode;
  readonly displayIdHint?: string;
  readonly bounds: Bounds;
}

/** The version of the saved shape. A saved workspace of a newer version is refused, not half read. */
export const WORKSPACE_SCHEMA_VERSION = 1;

export interface SavedWorkspace {
  readonly schemaVersion: number;
  readonly workspaceId: string;
  readonly app: AppKind;
  readonly name: string;
  readonly origin: "factory" | "user";
  readonly root: DockNode;
  readonly floats: readonly FloatingGroup[];
  readonly instances: Readonly<Record<string, PanelInstance>>;
  /** Panel-local interface preferences only. No secret, token or password may be kept here. */
  readonly viewState: Readonly<Record<string, unknown>>;
  /** Interface state: the group shown alone at full size, if any. The tree itself is not changed by it. */
  readonly maximizedGroupId?: string;
  /** Interface state: the group that last had focus. */
  readonly activeGroupId?: string;
  readonly metadata?: { readonly updatedAt?: string; readonly description?: string };
}

// ---------------------------------------------------------------------------
// Refusals and problems
// ---------------------------------------------------------------------------

export type DockRefusalCode =
  | "PANEL_NOT_AVAILABLE"
  | "DUPLICATE_SINGLETON"
  | "INVALID_DOCK_TARGET"
  | "PANEL_NOT_CLOSABLE"
  | "LAYOUT_VALIDATION_FAILED"
  | "LAYOUT_SCHEMA_NEWER";

/** One broken rule of a saved workspace, named. `rule` is the number of the invariant in the hand-off. */
export interface DockProblem {
  readonly rule: number;
  readonly reason: string;
}

export interface DockRefusal {
  readonly refused: string;
  readonly code: DockRefusalCode;
  readonly problems?: readonly DockProblem[];
}

export function isDockRefused<T>(result: T | DockRefusal): result is DockRefusal {
  return typeof result === "object" && result !== null && "refused" in result && "code" in result;
}

function refuse(code: DockRefusalCode, refused: string, problems?: readonly DockProblem[]): DockRefusal {
  return { code, refused, ...(problems === undefined ? {} : { problems }) };
}

// ---------------------------------------------------------------------------
// Reading the tree
// ---------------------------------------------------------------------------

/** Every node of a tree, the node first, then its children in order. A node that comes up twice (a tree that
 *  loops back on itself, which a saved layout must not) is visited once, so reading a broken tree ends. */
export function* walk(node: DockNode, seen: Set<DockNode> = new Set()): Generator<DockNode> {
  if (seen.has(node)) return;
  seen.add(node);
  yield node;
  if (node.kind === "split") for (const child of node.children) yield* walk(child, seen);
}

/** The main tree and every floating group's tree. */
export function trees(workspace: SavedWorkspace): DockNode[] {
  return [workspace.root, ...workspace.floats.map((float) => float.root)];
}

export function allNodes(workspace: SavedWorkspace): DockNode[] {
  return trees(workspace).flatMap((tree) => [...walk(tree)]);
}

export function groups(workspace: SavedWorkspace): TabsNode[] {
  return allNodes(workspace).filter((node): node is TabsNode => node.kind === "tabs");
}

export function findGroup(workspace: SavedWorkspace, groupId: string): TabsNode | undefined {
  return groups(workspace).find((group) => group.id === groupId);
}

export function findSplit(workspace: SavedWorkspace, splitId: string): SplitNode | undefined {
  return allNodes(workspace).find((node): node is SplitNode => node.kind === "split" && node.id === splitId);
}

/** The record of an open panel, or `undefined`. Looked up as the object's own entry only: a panel id such as
 *  `constructor` or `toString` must not be answered by what every object inherits. */
export function instanceOf(workspace: SavedWorkspace, instanceId: string): PanelInstance | undefined {
  return Object.prototype.hasOwnProperty.call(workspace.instances, instanceId) ? workspace.instances[instanceId] : undefined;
}

export function groupOfInstance(workspace: SavedWorkspace, instanceId: string): TabsNode | undefined {
  return groups(workspace).find((group) => group.panelInstanceIds.includes(instanceId));
}

/** The instances in the order they appear: main tree first, then floats. */
export function instanceIdsInOrder(workspace: SavedWorkspace): string[] {
  return groups(workspace).flatMap((group) => [...group.panelInstanceIds]);
}

function usedIds(workspace: SavedWorkspace): Set<string> {
  return new Set([
    ...allNodes(workspace).map((node) => node.id),
    ...workspace.floats.map((float) => float.id),
    ...Object.keys(workspace.instances),
  ]);
}

/** A name not used by any node, float or panel instance: `base-2`, `base-3`, and so on. */
export function freshId(workspace: SavedWorkspace, base: string, taken: ReadonlySet<string> = new Set()): string {
  const used = usedIds(workspace);
  if (!used.has(base) && !taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate) && !taken.has(candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

const WEIGHT_TOLERANCE = 1e-6;

/** Weights scaled to add up to one. Anything that cannot be (not finite, not positive) becomes equal shares. */
export function normalizeWeights(weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const usable = weights.every((weight) => Number.isFinite(weight) && weight > 0);
  const total = usable ? weights.reduce((sum, weight) => sum + weight, 0) : 0;
  if (!usable || !(total > 0) || !Number.isFinite(total)) return weights.map(() => 1 / weights.length);
  return weights.map((weight) => weight / total);
}

// ---------------------------------------------------------------------------
// Normalising a tree
// ---------------------------------------------------------------------------

/** Make a tree valid again after a panel left it: an empty tab group goes, a split left with one child is
 *  that child, a split inside a split of the same direction is joined to it, the weights add up to one, and a
 *  tab group shows one of its tabs. `null` when nothing is left. */
function normalizeNode(node: DockNode): DockNode | null {
  if (node.kind === "tabs") {
    if (node.panelInstanceIds.length === 0) return null;
    const active =
      node.activePanelInstanceId !== null && node.panelInstanceIds.includes(node.activePanelInstanceId)
        ? node.activePanelInstanceId
        : node.panelInstanceIds[0]!;
    return active === node.activePanelInstanceId ? node : { ...node, activePanelInstanceId: active };
  }
  const children: DockNode[] = [];
  const weights: number[] = [];
  node.children.forEach((child, index) => {
    const kept = normalizeNode(child);
    if (kept === null) return;
    const weight = node.weights[index] ?? 0;
    if (kept.kind === "split" && kept.direction === node.direction) {
      kept.children.forEach((grandchild, at) => {
        children.push(grandchild);
        weights.push(weight * (kept.weights[at] ?? 0));
      });
    } else {
      children.push(kept);
      weights.push(weight);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { ...node, children, weights: normalizeWeights(weights) };
}

const EMPTY_ROOT: TabsNode = { kind: "tabs", id: "root", panelInstanceIds: [], activePanelInstanceId: null };

/** The workspace with every tree normalised, empty floats dropped, and interface state that points at a
 *  group that is gone cleared. The root may be an empty tab group: a workspace with nothing open. */
export function normalizeWorkspace(workspace: SavedWorkspace): SavedWorkspace {
  const root = normalizeNode(workspace.root) ?? { ...EMPTY_ROOT, id: workspace.root.id };
  const floats = workspace.floats.flatMap((float) => {
    const kept = normalizeNode(float.root);
    return kept === null ? [] : [{ ...float, root: kept }];
  });
  const next: SavedWorkspace = { ...workspace, root, floats };
  const ids = new Set(groups(next).map((group) => group.id));
  const { maximizedGroupId, activeGroupId, ...rest } = next;
  return {
    ...rest,
    ...(maximizedGroupId !== undefined && ids.has(maximizedGroupId) ? { maximizedGroupId } : {}),
    ...(activeGroupId !== undefined && ids.has(activeGroupId) ? { activeGroupId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Editing the tree
// ---------------------------------------------------------------------------

function mapTrees(workspace: SavedWorkspace, edit: (tree: DockNode) => DockNode): SavedWorkspace {
  return {
    ...workspace,
    root: edit(workspace.root),
    floats: workspace.floats.map((float) => ({ ...float, root: edit(float.root) })),
  };
}

/** A node with `edit` applied to the tab group called `groupId`. */
function editGroup(node: DockNode, groupId: string, edit: (group: TabsNode) => TabsNode): DockNode {
  if (node.kind === "tabs") return node.id === groupId ? edit(node) : node;
  return { ...node, children: node.children.map((child) => editGroup(child, groupId, edit)) };
}

/** A tab group without one panel. The tab to its right, or else the one to its left, takes over if it was showing. */
function withoutInstance(group: TabsNode, instanceId: string): TabsNode {
  const at = group.panelInstanceIds.indexOf(instanceId);
  if (at < 0) return group;
  const panelInstanceIds = group.panelInstanceIds.filter((id) => id !== instanceId);
  const active =
    group.activePanelInstanceId === instanceId
      ? (panelInstanceIds[Math.min(at, panelInstanceIds.length - 1)] ?? null)
      : group.activePanelInstanceId;
  return { ...group, panelInstanceIds, activePanelInstanceId: active };
}

/** Put a tab group beside another, taking half of its share. A split of the same direction gets one more
 *  child; otherwise the target is wrapped in a new split. */
function insertBeside(tree: DockNode, targetId: string, node: TabsNode, position: Side, splitId: string): DockNode {
  const direction: Direction = position === "left" || position === "right" ? "horizontal" : "vertical";
  const before = position === "left" || position === "top";
  const place = (current: DockNode): DockNode => {
    if (current.kind === "split") {
      const index = current.children.findIndex((child) => child.id === targetId);
      if (index >= 0 && current.direction === direction) {
        const share = (current.weights[index] ?? 0) / 2;
        const weights = [...current.weights];
        weights.splice(index, 1, share, share);
        const children = [...current.children];
        children.splice(before ? index : index + 1, 0, node);
        return { ...current, weights, children };
      }
      return { ...current, children: current.children.map(place) };
    }
    if (current.id !== targetId) return current;
    return { kind: "split", id: splitId, direction, weights: [0.5, 0.5], children: before ? [node, current] : [current, node] };
  };
  return place(tree);
}

/** The tree without the tab group `groupId`, normalised. */
function withoutGroup(tree: DockNode, groupId: string): DockNode | null {
  const drop = (node: DockNode): DockNode =>
    node.kind === "tabs" ? (node.id === groupId ? { ...node, panelInstanceIds: [], activePanelInstanceId: null } : node) : { ...node, children: node.children.map(drop) };
  return normalizeNode(drop(tree));
}

const SIDES: readonly Side[] = ["left", "right", "top", "bottom"];

function isSide(position: DockPosition): position is Side {
  return SIDES.includes(position as Side);
}

/** Replace the main tree and floats with what a edit produced, then normalise. */
function finish(workspace: SavedWorkspace): SavedWorkspace {
  return normalizeWorkspace(workspace);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** Give a group focus. Another group that was maximised is restored, or the group with focus would be out of
 *  sight behind it. Every step that ends with a panel the author just acted on goes through here. */
export function withFocus(workspace: SavedWorkspace, groupId: string): SavedWorkspace {
  const { maximizedGroupId, ...rest } = workspace;
  return {
    ...rest,
    activeGroupId: groupId,
    ...(maximizedGroupId === groupId ? { maximizedGroupId } : {}),
  };
}

/** Show a panel's tab, and make its group the one with focus. A group maximised elsewhere is restored first,
 *  so the panel asked for is seen. */
export function focusPanel(workspace: SavedWorkspace, instanceId: string): SavedWorkspace | DockRefusal {
  const group = groupOfInstance(workspace, instanceId);
  if (group === undefined) return refuse("PANEL_NOT_AVAILABLE", `no open panel is called ${instanceId}`);
  const shown = mapTrees(workspace, (tree) => editGroup(tree, group.id, (g) => ({ ...g, activePanelInstanceId: instanceId })));
  return withFocus(shown, group.id);
}

/** Move one panel into a tab group (`center`, as a tab at `index`, or the end) or beside it (a side, as a new
 *  group taking half of the target's room). Moving a panel beside the group it is alone in is refused. */
export function movePanel(
  workspace: SavedWorkspace,
  instanceId: string,
  destinationGroupId: string,
  position: DockPosition,
  index?: number,
): SavedWorkspace | DockRefusal {
  const source = groupOfInstance(workspace, instanceId);
  if (source === undefined) return refuse("PANEL_NOT_AVAILABLE", `no open panel is called ${instanceId}`);
  const destination = findGroup(workspace, destinationGroupId);
  if (destination === undefined) return refuse("INVALID_DOCK_TARGET", `there is no tab group called ${destinationGroupId}`);
  if (position !== "center" && !isSide(position)) return refuse("INVALID_DOCK_TARGET", `${String(position)} is not a place to dock`);
  if (destination.id === source.id && position !== "center" && source.panelInstanceIds.length === 1) {
    return refuse("INVALID_DOCK_TARGET", "a panel that is alone in its group cannot be docked beside its own group");
  }
  if (index !== undefined && !Number.isFinite(index)) return refuse("INVALID_DOCK_TARGET", "a tab cannot be put at a place that is not a number");

  let next = mapTrees(workspace, (tree) => editGroup(tree, source.id, (group) => withoutInstance(group, instanceId)));
  if (position === "center") {
    next = mapTrees(next, (tree) =>
      editGroup(tree, destination.id, (group) => {
        const rest = group.panelInstanceIds.filter((id) => id !== instanceId);
        const at = Math.max(0, Math.min(index === undefined ? rest.length : Math.trunc(index), rest.length));
        rest.splice(at, 0, instanceId);
        return { ...group, panelInstanceIds: rest, activePanelInstanceId: instanceId };
      }),
    );
  } else {
    const groupId = freshId(next, `${instanceOf(workspace, instanceId)?.panelType ?? "panel"}-group`);
    const splitId = freshId(next, "split", new Set([groupId]));
    const node: TabsNode = { kind: "tabs", id: groupId, panelInstanceIds: [instanceId], activePanelInstanceId: instanceId };
    next = mapTrees(next, (tree) => insertBeside(tree, destination.id, node, position, splitId));
  }
  const placed = finish(next);
  const now = groupOfInstance(placed, instanceId);
  return now === undefined ? placed : withFocus(placed, now.id);
}

/** Move a whole tab group, with its tabs in order and its showing tab, beside another group or into it. Into
 *  it (`center`) the tabs are added after the target's. A group cannot be moved onto itself. */
export function moveGroup(
  workspace: SavedWorkspace,
  groupId: string,
  destinationGroupId: string,
  position: DockPosition,
): SavedWorkspace | DockRefusal {
  const source = findGroup(workspace, groupId);
  if (source === undefined) return refuse("INVALID_DOCK_TARGET", `there is no tab group called ${groupId}`);
  const destination = findGroup(workspace, destinationGroupId);
  if (destination === undefined) return refuse("INVALID_DOCK_TARGET", `there is no tab group called ${destinationGroupId}`);
  if (source.id === destination.id) return refuse("INVALID_DOCK_TARGET", "a group cannot be moved onto itself");
  if (position !== "center" && !isSide(position)) return refuse("INVALID_DOCK_TARGET", `${String(position)} is not a place to dock`);
  if (source.panelInstanceIds.length === 0) return refuse("INVALID_DOCK_TARGET", `group ${groupId} holds no panel, so there is nothing to move`);

  // A float whose only group moves away is empty, and normalising drops it.
  const detached = mapTrees(workspace, (tree) => editGroup(tree, source.id, (group) => ({ ...group, panelInstanceIds: [], activePanelInstanceId: null })));
  let next: SavedWorkspace;
  if (position === "center") {
    next = mapTrees(detached, (tree) =>
      editGroup(tree, destination.id, (group) => ({
        ...group,
        panelInstanceIds: [...group.panelInstanceIds, ...source.panelInstanceIds],
        activePanelInstanceId: source.activePanelInstanceId,
      })),
    );
  } else {
    // The normalised tree has lost the emptied group, which is what makes room for the moved one.
    let cleaned = finish(detached);
    // When the moved group was the whole main layout, what is left is an empty root that still carries the
    // group's id. The group keeps its id (focus and saved view state name it), so the empty root takes another.
    if (cleaned.root.kind === "tabs" && cleaned.root.id === source.id) {
      cleaned = { ...cleaned, root: { ...cleaned.root, id: freshId(cleaned, "root") } };
    }
    const splitId = freshId(cleaned, "split", new Set([source.id]));
    next = mapTrees(cleaned, (tree) => insertBeside(tree, destination.id, source, position, splitId));
  }
  const placed = finish(next);
  const target = position === "center" ? destination.id : source.id;
  return findGroup(placed, target) === undefined ? placed : withFocus(placed, target);
}

/** Put a tab at another place in its own group. An index past the end puts it last. */
export function reorderTab(workspace: SavedWorkspace, instanceId: string, index: number): SavedWorkspace | DockRefusal {
  const group = groupOfInstance(workspace, instanceId);
  if (group === undefined) return refuse("PANEL_NOT_AVAILABLE", `no open panel is called ${instanceId}`);
  if (!Number.isFinite(index)) return refuse("INVALID_DOCK_TARGET", "a tab cannot be put at a place that is not a number");
  const rest = group.panelInstanceIds.filter((id) => id !== instanceId);
  rest.splice(Math.max(0, Math.min(Math.trunc(index), rest.length)), 0, instanceId);
  return mapTrees(workspace, (tree) => editGroup(tree, group.id, (g) => ({ ...g, panelInstanceIds: rest })));
}

/** Show a group alone at full size. The tree is not changed, so restoring brings back every proportion. */
export function maximizeGroup(workspace: SavedWorkspace, groupId: string): SavedWorkspace | DockRefusal {
  if (findGroup(workspace, groupId) === undefined) return refuse("INVALID_DOCK_TARGET", `there is no tab group called ${groupId}`);
  return { ...workspace, maximizedGroupId: groupId, activeGroupId: groupId };
}

export function restoreGroup(workspace: SavedWorkspace, groupId: string): SavedWorkspace | DockRefusal {
  if (findGroup(workspace, groupId) === undefined) return refuse("INVALID_DOCK_TARGET", `there is no tab group called ${groupId}`);
  const { maximizedGroupId, ...rest } = workspace;
  return maximizedGroupId === groupId ? rest : workspace;
}

/** Close a panel's tab. Only the interface goes: the panel's own work (a scene, an asset, a take) is not
 *  touched, and its saved view state is kept so reopening it finds its columns and filters. */
export function closePanel(workspace: SavedWorkspace, instanceId: string): SavedWorkspace | DockRefusal {
  const group = groupOfInstance(workspace, instanceId);
  if (group === undefined) return refuse("PANEL_NOT_AVAILABLE", `no open panel is called ${instanceId}`);
  const next = mapTrees(workspace, (tree) => editGroup(tree, group.id, (g) => withoutInstance(g, instanceId)));
  const instances: Record<string, PanelInstance> = {};
  for (const key of Object.keys(next.instances)) if (key !== instanceId) instances[key] = next.instances[key]!;
  return finish({ ...next, instances });
}

/** Set a split's weights. They must be as many as its children, positive and finite; they are scaled to add up to one. */
export function setSplitWeights(workspace: SavedWorkspace, splitId: string, weights: readonly number[]): SavedWorkspace | DockRefusal {
  const split = findSplit(workspace, splitId);
  if (split === undefined) return refuse("INVALID_DOCK_TARGET", `there is no split called ${splitId}`);
  if (weights.length !== split.children.length) return refuse("INVALID_DOCK_TARGET", `split ${splitId} has ${split.children.length} children, not ${weights.length} weights`);
  if (!weights.every((weight) => Number.isFinite(weight) && weight > 0)) return refuse("INVALID_DOCK_TARGET", "every weight must be a positive number");
  const scaled = normalizeWeights(weights);
  const replace = (node: DockNode): DockNode =>
    node.kind === "tabs" ? node : node.id === splitId ? { ...node, weights: scaled } : { ...node, children: node.children.map(replace) };
  return mapTrees(workspace, replace);
}

/** The smallest share of a split one child may be given: enough for its tab strip or heading. */
export const MIN_FRACTION = 0.04;

/** Move the divider between child `dividerIndex` and the next one by `delta` (a fraction of the whole split;
 *  positive grows the first child). Neither child may go below its minimum: the move stops there. */
export function dragDivider(
  workspace: SavedWorkspace,
  splitId: string,
  dividerIndex: number,
  delta: number,
  minimums?: readonly number[],
): SavedWorkspace | DockRefusal {
  const split = findSplit(workspace, splitId);
  if (split === undefined) return refuse("INVALID_DOCK_TARGET", `there is no split called ${splitId}`);
  if (!Number.isInteger(dividerIndex) || dividerIndex < 0 || dividerIndex >= split.children.length - 1) {
    return refuse("INVALID_DOCK_TARGET", `split ${splitId} has no divider number ${dividerIndex}`);
  }
  if (!Number.isFinite(delta)) return refuse("INVALID_DOCK_TARGET", "the divider was not moved: the pointer position it was given is not a number");
  const minimum = (child: number): number => Math.max(MIN_FRACTION, minimums?.[child] ?? 0);
  const before = split.weights[dividerIndex] ?? 0;
  const after = split.weights[dividerIndex + 1] ?? 0;
  const pair = before + after;
  const low = minimum(dividerIndex);
  const high = pair - minimum(dividerIndex + 1);
  // Not enough room for both minimums: the pair is left as it is.
  if (low > high) return workspace;
  const moved = Math.min(high, Math.max(low, before + delta));
  const weights = [...split.weights];
  weights[dividerIndex] = moved;
  weights[dividerIndex + 1] = pair - moved;
  return setSplitWeights(workspace, splitId, weights);
}
