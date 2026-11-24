// Reading, writing and migrating a saved workspace (plan rows 11.92 and 11.94).
//
// Everything that comes from outside the running page is untrusted until it has passed through here: a
// layout from storage, from an imported file, from an older build, or from a newer one. Reading is strict
// about the shape, then checks every rule of `dock-validate.ts`, and refuses with the reasons named. A
// layout that cannot be read is never half applied.
//
// The older four-region layout (`workspace-layout.ts`, version 3) is migrated into a workspace here, so an
// author keeps the arrangement they made.

import {
  WORKSPACE_SCHEMA_VERSION,
  normalizeWeights,
  normalizeWorkspace,
  type AppKind,
  type Bounds,
  type DockNode,
  type DockProblem,
  type DockRefusal,
  type FloatingGroup,
  type PanelInstance,
  type SavedWorkspace,
} from "./dock-model";
import { validateWorkspace } from "./dock-validate";
import { entryId, regionEntries, REGIONS, type Layout, type RegionId } from "./workspace-layout";

class ShapeError extends Error {}

function fail(path: string, wanted: string): never {
  throw new ShapeError(`${path} must be ${wanted}`);
}

const MAX_DEPTH = 64;

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "an object");
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "") fail(path, "a word or more");
  return value as string;
}

function number(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "a number");
  return value as number;
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "a list");
  return value as unknown[];
}

function readNode(value: unknown, path: string, depth: number): DockNode {
  if (depth > MAX_DEPTH) fail(path, `no deeper than ${MAX_DEPTH} levels`);
  const node = record(value, path);
  const id = text(node["id"], `${path}.id`);
  if (node["kind"] === "tabs") {
    const ids = list(node["panelInstanceIds"], `${path}.panelInstanceIds`).map((item, index) => text(item, `${path}.panelInstanceIds[${index}]`));
    const active = node["activePanelInstanceId"];
    if (active !== null && typeof active !== "string") fail(`${path}.activePanelInstanceId`, "a panel id or null");
    return { kind: "tabs", id, panelInstanceIds: ids, activePanelInstanceId: active as string | null };
  }
  if (node["kind"] === "split") {
    const direction = node["direction"];
    if (direction !== "horizontal" && direction !== "vertical") fail(`${path}.direction`, "horizontal or vertical");
    const weights = list(node["weights"], `${path}.weights`).map((item, index) => number(item, `${path}.weights[${index}]`));
    const children = list(node["children"], `${path}.children`).map((item, index) => readNode(item, `${path}.children[${index}]`, depth + 1));
    return { kind: "split", id, direction: direction as "horizontal" | "vertical", weights, children };
  }
  return fail(`${path}.kind`, "a group of tabs or a split");
}

function readBounds(value: unknown, path: string): Bounds {
  const bounds = record(value, path);
  return {
    x: number(bounds["x"], `${path}.x`),
    y: number(bounds["y"], `${path}.y`),
    width: number(bounds["width"], `${path}.width`),
    height: number(bounds["height"], `${path}.height`),
  };
}

function readInstance(value: unknown, path: string): PanelInstance {
  const instance = record(value, path);
  const context = instance["context"];
  const ref = instance["viewStateRef"];
  let readContext: PanelInstance["context"];
  if (context !== undefined) {
    const found = record(context, `${path}.context`);
    if (found["mode"] !== "follow" && found["mode"] !== "pinned") fail(`${path}.context.mode`, "follow or pinned");
    const entity = found["entityId"];
    if (entity !== undefined && typeof entity !== "string") fail(`${path}.context.entityId`, "a word");
    readContext = { mode: found["mode"] as "follow" | "pinned", ...(entity === undefined ? {} : { entityId: entity as string }) };
  }
  if (ref !== undefined && typeof ref !== "string") fail(`${path}.viewStateRef`, "a word");
  return {
    instanceId: text(instance["instanceId"], `${path}.instanceId`),
    panelType: text(instance["panelType"], `${path}.panelType`),
    ...(readContext === undefined ? {} : { context: readContext }),
    ...(ref === undefined ? {} : { viewStateRef: ref as string }),
  };
}

function readFloat(value: unknown, path: string): FloatingGroup {
  const float = record(value, path);
  const hint = float["displayIdHint"];
  if (hint !== undefined && typeof hint !== "string") fail(`${path}.displayIdHint`, "a word");
  return {
    id: text(float["id"], `${path}.id`),
    root: readNode(float["root"], `${path}.root`, 0),
    bounds: readBounds(float["bounds"], `${path}.bounds`),
    ...(hint === undefined ? {} : { displayIdHint: hint as string }),
  };
}

/** The workspace a value is, with its shape checked and every rule of the saved layout kept; or a refusal that
 *  names what is wrong. The value must already be the current schema: `migrateWorkspace` first. */
export function readWorkspace(value: unknown): SavedWorkspace | DockRefusal {
  let workspace: SavedWorkspace;
  try {
    const raw = record(value, "the layout");
    const version = number(raw["schemaVersion"], "schemaVersion");
    if (version !== WORKSPACE_SCHEMA_VERSION) fail("schemaVersion", `${WORKSPACE_SCHEMA_VERSION} (use migrateWorkspace for another)`);
    const app = raw["app"];
    if (app !== "editor" && app !== "playout") fail("app", "editor or playout");
    const origin = raw["origin"];
    if (origin !== "factory" && origin !== "user") fail("origin", "factory or user");
    const instancesRaw = record(raw["instances"], "instances");
    const instances: Record<string, PanelInstance> = {};
    for (const key of Object.keys(instancesRaw)) {
      // Assigning under this key would replace the object's prototype instead of adding a record.
      if (key === "__proto__") fail("instances.__proto__", "a panel id (this one is not allowed)");
      instances[key] = readInstance(instancesRaw[key], `instances.${key}`);
    }
    const viewState = record(raw["viewState"], "viewState");
    const metadata = raw["metadata"] === undefined ? undefined : record(raw["metadata"], "metadata");
    const updatedAt = metadata?.["updatedAt"];
    const description = metadata?.["description"];
    if (updatedAt !== undefined && typeof updatedAt !== "string") fail("metadata.updatedAt", "a word");
    if (description !== undefined && typeof description !== "string") fail("metadata.description", "a word");
    const maximized = raw["maximizedGroupId"];
    const active = raw["activeGroupId"];
    if (maximized !== undefined && typeof maximized !== "string") fail("maximizedGroupId", "a word");
    if (active !== undefined && typeof active !== "string") fail("activeGroupId", "a word");
    workspace = {
      schemaVersion: version,
      workspaceId: text(raw["workspaceId"], "workspaceId"),
      app: app as AppKind,
      name: text(raw["name"], "name"),
      origin: origin as "factory" | "user",
      root: readNode(raw["root"], "root", 0),
      floats: list(raw["floats"], "floats").map((item, index) => readFloat(item, `floats[${index}]`)),
      instances,
      viewState,
      ...(maximized === undefined ? {} : { maximizedGroupId: maximized as string }),
      ...(active === undefined ? {} : { activeGroupId: active as string }),
      ...(metadata === undefined
        ? {}
        : { metadata: { ...(updatedAt === undefined ? {} : { updatedAt: updatedAt as string }), ...(description === undefined ? {} : { description: description as string }) } }),
    };
  } catch (error) {
    if (error instanceof ShapeError) {
      return {
        code: "LAYOUT_VALIDATION_FAILED",
        refused: `this is not a layout GrapiX can read: ${error.message}. The file may be damaged or made by something else. Nothing was changed.`,
        problems: [{ rule: 0, reason: error.message }],
      };
    }
    throw error;
  }
  const problems = validateWorkspace(workspace);
  if (problems.length > 0) return rejected(problems);
  return workspace;
}

function rejected(problems: readonly DockProblem[]): DockRefusal {
  const first = problems[0]!;
  const more = problems.length > 1 ? ` (and ${problems.length - 1} more)` : "";
  return { code: "LAYOUT_VALIDATION_FAILED", refused: `the layout breaks rule ${first.rule}: ${first.reason}${more}`, problems };
}

/** The layout as text, for storage or export. */
export function serializeWorkspace(workspace: SavedWorkspace): string {
  return JSON.stringify(workspace, null, 2);
}

/** Read a layout from text. A refusal names what is wrong, including text that is not a layout at all. */
export function parseWorkspaceText(textValue: string, aliases: Readonly<Record<string, string>> = {}): MigrationResult | DockRefusal {
  let value: unknown;
  try {
    value = JSON.parse(textValue);
  } catch {
    return { code: "LAYOUT_VALIDATION_FAILED", refused: "this file is not a GrapiX layout: its contents could not be read. Choose a layout that GrapiX exported. Nothing was changed.", problems: [{ rule: 0, reason: "not valid JSON" }] };
  }
  return migrateWorkspace(value, aliases);
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/** One step per old schema version: `MIGRATIONS[n]` turns a version `n` layout into version `n + 1`. There is
 *  none yet, because version 1 is the first; the table is what a later version fills. */
export const MIGRATIONS: Readonly<Record<number, (raw: Record<string, unknown>) => Record<string, unknown>>> = {};

export interface MigrationResult {
  readonly workspace: SavedWorkspace;
  /** The layout was from an older schema and was brought up to date. */
  readonly migrated: boolean;
  /** Panel kinds that were renamed since the layout was saved, as `old -> new`. */
  readonly renamed: readonly string[];
}

/** Bring a layout up to the current schema and the current panel names, then read it. The original value is
 *  never changed (the caller keeps a copy before replacing what it came from), a newer schema is refused
 *  rather than half read, and a renamed panel kind keeps its place under its new name. */
export function migrateWorkspace(value: unknown, aliases: Readonly<Record<string, string>> = {}): MigrationResult | DockRefusal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { code: "LAYOUT_VALIDATION_FAILED", refused: "this is not a layout file: it does not hold a layout. Choose a layout that GrapiX exported. Nothing was changed.", problems: [{ rule: 0, reason: "it is not an object" }] };
  }
  let raw = structuredClone(value) as Record<string, unknown>;
  const version = raw["schemaVersion"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { code: "LAYOUT_VALIDATION_FAILED", refused: "this is not a layout GrapiX can read: schemaVersion must be a whole number, 1 or more. Nothing was changed.", problems: [{ rule: 0, reason: "schemaVersion must be a whole number, 1 or more" }] };
  }
  if (version > WORKSPACE_SCHEMA_VERSION) {
    return {
      code: "LAYOUT_SCHEMA_NEWER",
      refused: `this layout was saved by a newer GrapiX (layout version ${version}; this one reads up to ${WORKSPACE_SCHEMA_VERSION}). Nothing was changed. Open it with that version, or use a layout saved by this one.`,
    };
  }
  let from = version;
  while (from < WORKSPACE_SCHEMA_VERSION) {
    const step = MIGRATIONS[from];
    if (step === undefined) {
      return { code: "LAYOUT_VALIDATION_FAILED", refused: `no migration exists from layout version ${from}`, problems: [{ rule: 0, reason: `no migration from version ${from}` }] };
    }
    raw = { ...step(raw), schemaVersion: from + 1 };
    from += 1;
  }
  const renamed: string[] = [];
  const instances = raw["instances"];
  if (typeof instances === "object" && instances !== null && !Array.isArray(instances)) {
    for (const instance of Object.values(instances as Record<string, unknown>)) {
      if (typeof instance !== "object" || instance === null) continue;
      const entry = instance as Record<string, unknown>;
      let type = entry["panelType"];
      const own = (name: string): string | undefined => (Object.prototype.hasOwnProperty.call(aliases, name) ? aliases[name] : undefined);
      for (let hops = 0; typeof type === "string" && own(type) !== undefined && hops < 8; hops += 1) {
        const next = own(type)!;
        const label = `${type} -> ${next}`;
        if (!renamed.includes(label)) renamed.push(label);
        type = next;
      }
      entry["panelType"] = type;
    }
  }
  const workspace = readWorkspace(raw);
  if ("refused" in workspace) return workspace;
  return { workspace, migrated: version < WORKSPACE_SCHEMA_VERSION, renamed };
}

// ---------------------------------------------------------------------------
// From the four-region layout (layout version 3)
// ---------------------------------------------------------------------------

export interface LayoutMeta {
  readonly workspaceId: string;
  readonly name: string;
  readonly origin: "factory" | "user";
  readonly app?: AppKind;
}

/** The share a dock that was collapsed keeps, so its panels stay in the layout as a narrow strip. */
const COLLAPSED_SHARE = 0.03;
/** The least the middle column is given, however wide the side docks were dragged. */
const MIN_CENTRE_SHARE = 0.1;

/** A saved four-region layout as a workspace, arranged as the four-region page showed it: the left dock, the
 *  centre and the right dock side by side, and the bottom dock (the timeline) under all three, across the
 *  whole width. A side dock keeps the share of the width it had and the centre takes the rest, which is what
 *  the page did (it never used the centre's own stored size). Each dock is a column of its panels and tab
 *  groups in the order and with the heights it had. Nothing is lost: every panel keeps its place, and every
 *  tab group its id, its tabs and its showing tab. */
export function workspaceFromLayout(layout: Layout, meta: LayoutMeta): SavedWorkspace {
  const instances: Record<string, PanelInstance> = {};
  const instanceOf = (panel: string): string => {
    const id = `${panel}-1`;
    instances[id] = { instanceId: id, panelType: panel };
    return id;
  };

  // Node ids are handed out through one set. A lone panel's group is named after the panel (`inspector-group`),
  // which is also what a tab group the author made may be called; and the names invented here (`root`,
  // `top-row`, `left-column`) could be an author's too. A tab group keeps its own id; everything else steps aside.
  const taken = new Set<string>();
  for (const region of REGIONS) for (const group of layout.regions[region].groups) taken.add(group.id);
  const handed = new Set<string>();
  const unique = (base: string): string => {
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
    taken.add(id);
    return id;
  };
  const groupId = (id: string): string => {
    if (handed.has(id)) return unique(id);
    handed.add(id);
    return id;
  };

  const column = (region: RegionId): DockNode | undefined => {
    const state = layout.regions[region];
    const entries = regionEntries(state);
    if (entries.length === 0) return undefined;
    const nodes: DockNode[] = entries.map((entry) => {
      if (entry.kind === "panel") {
        const id = instanceOf(entry.panel);
        return { kind: "tabs", id: unique(`${entry.panel}-group`), panelInstanceIds: [id], activePanelInstanceId: id };
      }
      const ids = entry.group.panels.map(instanceOf);
      return { kind: "tabs", id: groupId(entry.group.id), panelInstanceIds: ids, activePanelInstanceId: `${entry.group.active}-1` };
    });
    if (nodes.length === 1) return nodes[0]!;
    // The stored fractions apply only to the entries they were measured for.
    const keys = entries.map(entryId);
    const stored = state.split;
    const fits = stored !== undefined && stored.entries.length === keys.length && stored.entries.every((key, index) => key === keys[index]);
    return { kind: "split", id: unique(`${region}-column`), direction: "vertical", weights: normalizeWeights(fits ? stored.fractions : keys.map(() => 1)), children: nodes };
  };

  const share = (region: RegionId): number =>
    layout.regions[region].collapsed ? COLLAPSED_SHARE : Math.min(0.9, Math.max(layout.regions[region].size, COLLAPSED_SHARE));
  const left = column("left");
  const centre = column("centre");
  const right = column("right");
  const bottom = column("bottom");

  const leftShare = left === undefined ? 0 : share("left");
  const rightShare = right === undefined ? 0 : share("right");
  const row: { readonly node: DockNode; readonly weight: number }[] = [];
  if (left !== undefined) row.push({ node: left, weight: leftShare });
  if (centre !== undefined) row.push({ node: centre, weight: Math.max(MIN_CENTRE_SHARE, 1 - leftShare - rightShare) });
  if (right !== undefined) row.push({ node: right, weight: rightShare });
  const top: DockNode | undefined =
    row.length === 0
      ? undefined
      : row.length === 1
        ? row[0]!.node
        : { kind: "split", id: unique("top-row"), direction: "horizontal", weights: normalizeWeights(row.map((entry) => entry.weight)), children: row.map((entry) => entry.node) };

  const root: DockNode =
    top !== undefined && bottom !== undefined
      ? { kind: "split", id: unique("root"), direction: "vertical", weights: normalizeWeights([1 - share("bottom"), share("bottom")]), children: [top, bottom] }
      : (top ?? bottom ?? { kind: "tabs", id: unique("root"), panelInstanceIds: [], activePanelInstanceId: null });

  // Normalising joins a column that is itself stacked into the stacked root, so the result is in the one
  // form every other step of the dock model produces.
  return normalizeWorkspace({
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    workspaceId: meta.workspaceId,
    app: meta.app ?? "editor",
    name: meta.name,
    origin: meta.origin,
    root,
    floats: [],
    instances,
    viewState: {},
  });
}

/** Every region the four-region layout has, for tests that check nothing is lost. */
export const LAYOUT_REGIONS: readonly RegionId[] = REGIONS;
