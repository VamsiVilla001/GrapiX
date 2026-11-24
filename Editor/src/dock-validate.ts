// The rules a saved workspace must keep (plan row 11.92). The numbers are those of the hand-off's list.
//
//   1  every panel in a tree is a known instance, once, and every instance is in a tree
//   3  a tab group has a panel and shows one of its own (and the interface state points at a group that exists)
//   4  a split has two or more children and one positive weight each, adding up to one
//   5  no node id is used twice, and no node is its own descendant
//   7  a floating group's bounds are finite and have a size
//   9  no password, token or secret is kept in a panel's view state
//
// Rules 2 (a singleton at most once), 6 (unavailable panels are placeholders), 8 (migration) and 10 (what to
// do with a rejected layout) are in the registry, the manager and the store; they need more than the tree.

import { allNodes, instanceOf, trees, type DockNode, type DockProblem, type SavedWorkspace, walk } from "./dock-model";

const WEIGHT_SUM_TOLERANCE = 1e-6;

/** The words of a key: `accessToken`, `access_token` and `access-token` are all `access`, `token`. */
function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase());
}

/** A key names a secret when it *ends* in one of these words. Ending, not containing: `bypass`, `compass`,
 *  `designTokens` and `tokenFilter` are ordinary preferences, and refusing a layout over them would cost an
 *  author their arrangement for nothing. */
const SECRET_LAST_WORD = new Set(["password", "passphrase", "passwd", "secret", "token", "credential", "credentials", "authorization", "authorisation", "bearer", "apikey"]);
/** ...or in one of these pairs: `apiKey`, `private_key`, `access-key`, `secretKey`. */
const SECRET_BEFORE_KEY = new Set(["api", "private", "access", "secret"]);

export function isSecretKey(key: string): boolean {
  const words = keyWords(key);
  const last = words[words.length - 1];
  if (last === undefined) return false;
  if (SECRET_LAST_WORD.has(last)) return true;
  return last === "key" && SECRET_BEFORE_KEY.has(words[words.length - 2] ?? "");
}

/** A value that is a credential whatever its key is called: a GrapiX credential (`gx1.` and no spaces), or an
 *  HTTP authorisation value (`Bearer` or `Basic` followed by one token of eight characters or more). A search
 *  for "Basic 3D" is not one. A bare hex or base64 string is not treated as one either: content hashes are that. */
const SECRET_VALUE = /^(gx1\.\S+|(bearer|basic)\s+[A-Za-z0-9+/_.=~-]{8,})$/i;

export function isSecretValue(value: string): boolean {
  return SECRET_VALUE.test(value.trim());
}

/** How deep view state may nest. Deeper than this it is not checked, so it is refused rather than passed. */
export const VIEW_STATE_MAX_DEPTH = 12;

export interface SecretFinding {
  readonly path: string;
  readonly kind: "secret" | "too-deep";
}

/** Every place in a value that looks like a password, token or secret, and every place nested too deep to check. */
export function secretsIn(value: unknown, path: string, depth: number = 0, found: SecretFinding[] = []): SecretFinding[] {
  if (typeof value === "string") {
    if (isSecretValue(value)) found.push({ path, kind: "secret" });
    return found;
  }
  if (typeof value !== "object" || value === null) return found;
  if (depth >= VIEW_STATE_MAX_DEPTH) {
    found.push({ path, kind: "too-deep" });
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => secretsIn(item, `${path}[${index}]`, depth + 1, found));
    return found;
  }
  for (const [key, inner] of Object.entries(value)) {
    if (isSecretKey(key)) found.push({ path: `${path}.${key}`, kind: "secret" });
    else secretsIn(inner, `${path}.${key}`, depth + 1, found);
  }
  return found;
}

/** The rule 9 problem for one finding. */
export function secretProblem(finding: SecretFinding): DockProblem {
  return finding.kind === "secret"
    ? { rule: 9, reason: `${finding.path} looks like a password, token or secret, which a layout never keeps` }
    : { rule: 9, reason: `${finding.path} is nested deeper than ${VIEW_STATE_MAX_DEPTH} levels, which is too deep to check for secrets` };
}

function checkTree(tree: DockNode, root: boolean, problems: DockProblem[], seenObjects: Set<object>): void {
  const seen = new Set<object>();
  const check = (node: DockNode, isRoot: boolean): void => {
    if (seen.has(node) || seenObjects.has(node)) {
      problems.push({ rule: 5, reason: `node ${node.id} is reached twice: a node cannot be inside itself or in two places` });
      return;
    }
    seen.add(node);
    seenObjects.add(node);
    if (node.kind === "tabs") {
      if (node.panelInstanceIds.length === 0) {
        if (!(isRoot && root)) problems.push({ rule: 3, reason: `tab group ${node.id} holds no panel` });
      } else if (node.activePanelInstanceId === null || !node.panelInstanceIds.includes(node.activePanelInstanceId)) {
        problems.push({ rule: 3, reason: `tab group ${node.id} shows ${String(node.activePanelInstanceId)}, which is not one of its panels` });
      }
      return;
    }
    if (node.children.length < 2) problems.push({ rule: 4, reason: `split ${node.id} has ${node.children.length} children; a split has two or more` });
    if (node.weights.length !== node.children.length) {
      problems.push({ rule: 4, reason: `split ${node.id} has ${node.children.length} children but ${node.weights.length} weights` });
    } else if (!node.weights.every((weight) => Number.isFinite(weight) && weight > 0)) {
      problems.push({ rule: 4, reason: `split ${node.id} has a weight that is not a positive number` });
    } else if (Math.abs(node.weights.reduce((sum, weight) => sum + weight, 0) - 1) > WEIGHT_SUM_TOLERANCE) {
      problems.push({ rule: 4, reason: `the weights of split ${node.id} do not add up to one` });
    }
    for (const child of node.children) check(child, false);
  };
  check(tree, true);
}

/** Every rule the saved workspace breaks, named. An empty list is a valid workspace. */
export function validateWorkspace(workspace: SavedWorkspace): DockProblem[] {
  const problems: DockProblem[] = [];
  const seenObjects = new Set<object>();
  checkTree(workspace.root, true, problems, seenObjects);
  for (const float of workspace.floats) checkTree(float.root, false, problems, seenObjects);

  // 5: ids. Counted over the trees as walked, so a repeated node is not counted twice by the tree check.
  const ids = new Map<string, number>();
  const count = (id: string): void => void ids.set(id, (ids.get(id) ?? 0) + 1);
  for (const tree of trees(workspace)) {
    const visited = new Set<object>();
    const visit = (node: DockNode): void => {
      if (visited.has(node)) return;
      visited.add(node);
      count(node.id);
      if (node.kind === "split") node.children.forEach(visit);
    };
    visit(tree);
  }
  for (const float of workspace.floats) count(float.id);
  for (const [id, times] of ids) if (times > 1) problems.push({ rule: 5, reason: `the id ${id} is used ${times} times` });

  // 1: instances.
  const referenced = new Map<string, number>();
  const visitedGroups = new Set<object>();
  for (const tree of trees(workspace)) {
    const stack: DockNode[] = [tree];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (visitedGroups.has(node)) continue;
      visitedGroups.add(node);
      if (node.kind === "tabs") for (const id of node.panelInstanceIds) referenced.set(id, (referenced.get(id) ?? 0) + 1);
      else stack.push(...node.children);
    }
  }
  for (const [id, times] of referenced) {
    if (instanceOf(workspace, id) === undefined) problems.push({ rule: 1, reason: `panel ${id} is in the layout but has no instance record` });
    if (times > 1) problems.push({ rule: 1, reason: `panel ${id} is in ${times} places; a panel is in one` });
  }
  for (const [key, instance] of Object.entries(workspace.instances)) {
    if (instance.instanceId !== key) problems.push({ rule: 1, reason: `the instance record ${key} calls itself ${instance.instanceId}` });
    if (!referenced.has(key)) problems.push({ rule: 1, reason: `panel ${key} has an instance record but is in no tab group` });
  }

  // 3: interface state points at groups that exist.
  const groupIds = new Set(allNodes(workspace).filter((node) => node.kind === "tabs").map((node) => node.id));
  if (workspace.maximizedGroupId !== undefined && !groupIds.has(workspace.maximizedGroupId)) {
    problems.push({ rule: 3, reason: `the maximised group ${workspace.maximizedGroupId} does not exist` });
  }
  if (workspace.activeGroupId !== undefined && !groupIds.has(workspace.activeGroupId)) {
    problems.push({ rule: 3, reason: `the active group ${workspace.activeGroupId} does not exist` });
  }

  // 7: floating bounds.
  for (const float of workspace.floats) {
    const { x, y, width, height } = float.bounds;
    if (![x, y, width, height].every(Number.isFinite)) problems.push({ rule: 7, reason: `floating group ${float.id} has bounds that are not finite numbers` });
    else if (!(width > 0 && height > 0)) problems.push({ rule: 7, reason: `floating group ${float.id} has no size` });
  }

  // 9: secrets.
  const secrets: SecretFinding[] = [];
  secretsIn(workspace.viewState, "viewState", 0, secrets);
  for (const instance of Object.values(workspace.instances)) secretsIn(instance.context, `instances.${instance.instanceId}.context`, 0, secrets);
  for (const finding of secrets) problems.push(secretProblem(finding));

  return problems;
}

/** Walk helper kept here so tests can count a tree's nodes without importing the generator. */
export function nodeCount(tree: DockNode): number {
  return [...walk(tree)].length;
}
