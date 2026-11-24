// Named workspaces (plan row 11.94): the shipped ones, the author's saved ones, the session copy that follows each
// change, and the last good copy. Every step is a pure function from a state to a state, or to a refusal that
// names why; the page and the store (`workspace-persistence.ts`) only carry the result to the screen and to disk.
//
// Four copies of a workspace may exist, and they are never mixed up:
//
//   shipped    a definition that comes with GrapiX and never changes (`factory`)
//   saved      the author's baseline. For a workspace the author made it is the workspace; for a shipped one it is an
//              override that Reset to shipped removes
//   session    the arrangement as the author last left it, kept a moment after each change. Selecting a workspace
//              loads it if there is one, else the baseline
//   last good  the last arrangement that read and passed every rule, kept to fall back to
//
// A workspace that is changed is `modified` until it is saved or reset. Changing the arrangement, switching, saving,
// resetting, renaming and deleting a workspace are interface steps only: none touches a scene, the selection, the
// undo history or any output.

import {
  WORKSPACE_SCHEMA_VERSION,
  isDockRefused,
  type AppKind,
  type DockRefusal,
  type SavedWorkspace,
} from "./dock-model";
import { validateWorkspace } from "./dock-validate";
import { migrateWorkspace } from "./workspace-io";

export type PresetRefusalCode =
  | "WORKSPACE_UNKNOWN"
  | "WORKSPACE_NAME_INVALID"
  | "WORKSPACE_NAME_TAKEN"
  | "WORKSPACE_FACTORY_IMMUTABLE"
  | "WORKSPACE_NOT_FACTORY"
  | "WORKSPACE_IN_USE"
  | "WORKSPACE_ORDER_INVALID"
  | "WORKSPACE_WRONG_APP";

export interface PresetRefusal {
  readonly refused: string;
  readonly code: PresetRefusalCode | DockRefusal["code"];
  readonly problems?: DockRefusal["problems"];
}

export function isPresetRefused<T>(result: T | PresetRefusal): result is PresetRefusal {
  return typeof result === "object" && result !== null && "refused" in result && "code" in result;
}

function refuse(code: PresetRefusalCode, refused: string): PresetRefusal {
  return { code, refused };
}

type ById = Readonly<Record<string, SavedWorkspace>>;

export interface WorkspaceSet {
  readonly app: AppKind;
  /** Shipped definitions, in the order they ship. Never changed by any step here. */
  readonly factory: ById;
  readonly saved: ById;
  readonly session: ById;
  readonly lastGood: ById;
  /** The order the author put the workspaces in. Ids it does not name follow, shipped ones first. */
  readonly order: readonly string[];
  readonly activeId: string;
  /** Ids whose files were written by a newer GrapiX. They are not loaded, and the store refuses to write over them. */
  readonly leftAlone: readonly string[];
  /** Ids whose saved copy is on disk but could not be used and had no good copy to fall back to. They are not
   *  listed, and their id is not given to a new workspace, so the file is never written over. */
  readonly unloaded?: readonly string[];
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading a set
// ---------------------------------------------------------------------------------------------------------------------

/** Every workspace id, in the order shown: the author's order first, then shipped ones in the order they ship, then
 *  the rest sorted. */
export function workspaceIds(set: WorkspaceSet): string[] {
  const known = new Set([...Object.keys(set.factory), ...Object.keys(set.saved)]);
  const out: string[] = [];
  for (const id of set.order) if (known.has(id) && !out.includes(id)) out.push(id);
  for (const id of Object.keys(set.factory)) if (!out.includes(id)) out.push(id);
  for (const id of Object.keys(set.saved).sort()) if (!out.includes(id)) out.push(id);
  return out;
}

export function isFactory(set: WorkspaceSet, id: string): boolean {
  return own(set.factory, id) !== undefined;
}

function own(map: ById, id: string): SavedWorkspace | undefined {
  return Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined;
}

/** What a workspace is when it is not being edited: the author's saved copy, else the shipped one. */
export function baselineOf(set: WorkspaceSet, id: string): SavedWorkspace | undefined {
  return own(set.saved, id) ?? own(set.factory, id);
}

/** What selecting the workspace loads: the session copy if there is one, else the baseline. */
export function currentOf(set: WorkspaceSet, id: string): SavedWorkspace | undefined {
  return own(set.session, id) ?? baselineOf(set, id);
}

/** The display name of a workspace. */
export function nameOf(set: WorkspaceSet, id: string): string | undefined {
  return currentOf(set, id)?.name;
}

/** The part of an arrangement that Save keeps: the tree, the floats, the panels and their preferences. Which group is
 *  maximised or has focus, and when it was saved, are about now. */
function arrangement(ws: SavedWorkspace): string {
  return JSON.stringify({ root: ws.root, floats: ws.floats, instances: ws.instances, viewState: ws.viewState });
}

/** Whether the workspace has been changed since it was saved. */
export function isModified(set: WorkspaceSet, id: string): boolean {
  const session = own(set.session, id);
  const baseline = baselineOf(set, id);
  return session !== undefined && baseline !== undefined && arrangement(session) !== arrangement(baseline);
}

/** A workspace the author made, as opposed to one that ships. */
export function isUser(set: WorkspaceSet, id: string): boolean {
  return own(set.saved, id) !== undefined && own(set.factory, id) === undefined;
}

/** Whether the author's saved copy of a shipped workspace exists, so Reset to shipped has something to remove. */
export function hasOverride(set: WorkspaceSet, id: string): boolean {
  return isFactory(set, id) && own(set.saved, id) !== undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Names and ids
// ---------------------------------------------------------------------------------------------------------------------

export const MAX_NAME_LENGTH = 60;

/** A name is one to sixty characters with no control characters, and is not just spaces. */
export function checkName(raw: string): string | PresetRefusal {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name === "") return refuse("WORKSPACE_NAME_INVALID", "a workspace needs a name");
  if (name.length > MAX_NAME_LENGTH) return refuse("WORKSPACE_NAME_INVALID", `a workspace name is at most ${MAX_NAME_LENGTH} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return refuse("WORKSPACE_NAME_INVALID", "a workspace name cannot hold a control character");
  return name;
}

function nameTaken(set: WorkspaceSet, name: string, except?: string): boolean {
  const wanted = name.toLowerCase();
  return workspaceIds(set).some((id) => id !== except && (nameOf(set, id) ?? "").toLowerCase() === wanted);
}

/** The id for a new workspace made from a name: `user.` and the name in lower case, joined by hyphens, and a number
 *  when that id is taken. Always a safe file name, whatever the name holds. */
export function newIdFor(set: WorkspaceSet, name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[^\x00-\x7f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const base = `user.${slug === "" ? "workspace" : slug}`;
  const taken = new Set([...workspaceIds(set), ...Object.keys(set.lastGood), ...Object.keys(set.session), ...set.leftAlone, ...(set.unloaded ?? [])]);
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

/** A name that is free, for a copy or an import: `Name`, then `Name (2)`, `Name (3)`, and so on. */
export function freeName(set: WorkspaceSet, wanted: string): string {
  const name = typeof checkName(wanted) === "string" ? (checkName(wanted) as string) : "Workspace";
  if (!nameTaken(set, name)) return name;
  for (let n = 2; ; n += 1) {
    const suffix = ` (${n})`;
    const candidate = `${name.slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`;
    if (!nameTaken(set, candidate)) return candidate;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------------------------------

function unknown(id: string): PresetRefusal {
  return refuse("WORKSPACE_UNKNOWN", `there is no workspace called ${id}`);
}

/** Switch to a workspace. Only the choice changes: the workspace loads as its session copy or its baseline, and what
 *  was open stays as it was left. */
export function activate(set: WorkspaceSet, id: string): WorkspaceSet | PresetRefusal {
  if (baselineOf(set, id) === undefined) return unknown(id);
  return { ...set, activeId: id };
}

/** Keep the arrangement as the session copy of a workspace. It is checked first: an arrangement that breaks a rule is
 *  refused with the rule named, and the session copy is as it was. The saved copy is not touched. */
export function changeSession(set: WorkspaceSet, id: string, next: SavedWorkspace): WorkspaceSet | PresetRefusal {
  if (baselineOf(set, id) === undefined) return unknown(id);
  if (next.app !== set.app) return refuse("WORKSPACE_WRONG_APP", `this is a ${next.app} workspace, and this is the ${set.app} application`);
  if (next.workspaceId !== id) return refuse("WORKSPACE_UNKNOWN", `the arrangement is for ${next.workspaceId}, not ${id}`);
  const problems = validateWorkspace(next);
  if (problems.length > 0) {
    return { code: "LAYOUT_VALIDATION_FAILED", refused: `the arrangement was not kept: rule ${problems[0]!.rule}: ${problems[0]!.reason}`, problems };
  }
  return { ...set, session: { ...set.session, [id]: next } };
}

/** Record that the workspace as it is now read and passed every rule, so it can be fallen back to. */
export function markGood(set: WorkspaceSet, id: string): WorkspaceSet | PresetRefusal {
  const current = currentOf(set, id);
  if (current === undefined) return unknown(id);
  if (validateWorkspace(current).length > 0) return refuse("WORKSPACE_UNKNOWN", `${id} does not pass the layout rules, so it is not recorded as good`);
  return { ...set, lastGood: { ...set.lastGood, [id]: current } };
}

/** What a saved copy keeps of an arrangement: not which group is maximised or has focus. */
function forSaving(ws: SavedWorkspace, patch: { workspaceId?: string; name?: string; origin?: "factory" | "user"; now?: string }): SavedWorkspace {
  const { maximizedGroupId: _maximized, activeGroupId: _active, metadata, ...rest } = ws;
  const updatedAt = patch.now ?? metadata?.updatedAt;
  const description = metadata?.description;
  return {
    ...rest,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    workspaceId: patch.workspaceId ?? ws.workspaceId,
    name: patch.name ?? ws.name,
    origin: patch.origin ?? ws.origin,
    ...(updatedAt === undefined && description === undefined ? {} : { metadata: { ...(updatedAt === undefined ? {} : { updatedAt }), ...(description === undefined ? {} : { description }) } }),
  };
}

/** Make what the author sees the saved copy. For a shipped workspace this is the author's own copy beside it; the
 *  shipped one is not touched. Saving a workspace that has not been changed saves it as it is. */
export function save(set: WorkspaceSet, id: string, now?: string): WorkspaceSet | PresetRefusal {
  const current = currentOf(set, id);
  if (current === undefined) return unknown(id);
  const kept = forSaving(current, { origin: isFactory(set, id) ? "user" : current.origin, ...(now === undefined ? {} : { now }) });
  return { ...set, saved: { ...set.saved, [id]: kept }, session: { ...set.session, [id]: kept } };
}

/** Make what the author sees a new workspace of their own, with a name. The workspace it came from keeps its session
 *  copy as it was, so nothing is lost by saving a copy. The new one is saved and has its own session copy. */
export function saveAs(set: WorkspaceSet, fromId: string, rawName: string, now?: string): { readonly set: WorkspaceSet; readonly id: string } | PresetRefusal {
  const current = currentOf(set, fromId);
  if (current === undefined) return unknown(fromId);
  const name = checkName(rawName);
  if (typeof name !== "string") return name;
  if (nameTaken(set, name)) return refuse("WORKSPACE_NAME_TAKEN", `a workspace is already called ${name}`);
  const id = newIdFor(set, name);
  const kept = forSaving(current, { workspaceId: id, name, origin: "user", ...(now === undefined ? {} : { now }) });
  return {
    id,
    set: { ...set, saved: { ...set.saved, [id]: kept }, session: { ...set.session, [id]: kept }, order: [...workspaceIds(set), id] },
  };
}

/** A copy of a workspace under a new name. The copy is not switched to. */
export function duplicate(set: WorkspaceSet, id: string, rawName: string, now?: string): { readonly set: WorkspaceSet; readonly id: string } | PresetRefusal {
  const made = saveAs(set, id, rawName, now);
  if (isPresetRefused(made)) return made;
  return { id: made.id, set: { ...made.set, activeId: set.activeId } };
}

/** Throw away the changes: the workspace goes back to its saved copy. */
export function resetToSaved(set: WorkspaceSet, id: string): WorkspaceSet | PresetRefusal {
  if (baselineOf(set, id) === undefined) return unknown(id);
  const { [id]: _dropped, ...session } = set.session;
  return { ...set, session };
}

/** Put a shipped workspace back to the arrangement it ships with, and remove the author's own copy of it. A workspace
 *  the author made has no shipped arrangement to return to. */
export function resetToFactory(set: WorkspaceSet, id: string): WorkspaceSet | PresetRefusal {
  if (!isFactory(set, id)) {
    return baselineOf(set, id) === undefined ? unknown(id) : refuse("WORKSPACE_NOT_FACTORY", `${nameOf(set, id) ?? id} is your own workspace, so there is no shipped arrangement to go back to. Use Reset to saved.`);
  }
  const { [id]: _saved, ...saved } = set.saved;
  const { [id]: _session, ...session } = set.session;
  return { ...set, saved, session };
}

/** Change the name of a workspace the author made. Shipped workspaces keep their names. */
export function rename(set: WorkspaceSet, id: string, rawName: string): WorkspaceSet | PresetRefusal {
  if (baselineOf(set, id) === undefined) return unknown(id);
  if (!isUser(set, id)) return refuse("WORKSPACE_FACTORY_IMMUTABLE", `${nameOf(set, id) ?? id} ships with GrapiX and keeps its name. Save a copy under another name instead.`);
  const name = checkName(rawName);
  if (typeof name !== "string") return name;
  if (nameTaken(set, name, id)) return refuse("WORKSPACE_NAME_TAKEN", `a workspace is already called ${name}`);
  const renamed = (ws: SavedWorkspace | undefined): SavedWorkspace | undefined => (ws === undefined ? undefined : { ...ws, name });
  const session = renamed(own(set.session, id));
  const lastGood = renamed(own(set.lastGood, id));
  return {
    ...set,
    saved: { ...set.saved, [id]: renamed(own(set.saved, id))! },
    session: session === undefined ? set.session : { ...set.session, [id]: session },
    lastGood: lastGood === undefined ? set.lastGood : { ...set.lastGood, [id]: lastGood },
  };
}

/** Delete a workspace the author made. A shipped one cannot be deleted, and neither can the one in use: switch first. */
export function remove(set: WorkspaceSet, id: string): WorkspaceSet | PresetRefusal {
  if (baselineOf(set, id) === undefined) return unknown(id);
  if (!isUser(set, id)) return refuse("WORKSPACE_FACTORY_IMMUTABLE", `${nameOf(set, id) ?? id} ships with GrapiX and cannot be deleted. Reset to shipped puts it back as it was.`);
  if (set.activeId === id) return refuse("WORKSPACE_IN_USE", `${nameOf(set, id) ?? id} is the workspace in use. Switch to another workspace first, then delete it.`);
  const without = (map: ById): ById => Object.fromEntries(Object.entries(map).filter(([key]) => key !== id));
  return { ...set, saved: without(set.saved), session: without(set.session), lastGood: without(set.lastGood), order: set.order.filter((key) => key !== id) };
}

/** Put the workspaces in a new order. It must name every workspace once and no other. */
export function reorder(set: WorkspaceSet, ids: readonly string[]): WorkspaceSet | PresetRefusal {
  const now = workspaceIds(set);
  if (ids.length !== now.length || new Set(ids).size !== ids.length || !ids.every((id) => now.includes(id))) {
    return refuse("WORKSPACE_ORDER_INVALID", "the new order must list every workspace once, and no other");
  }
  return { ...set, order: [...ids] };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading what was stored
// ---------------------------------------------------------------------------------------------------------------------

/** What the store gave back for one file, as the page receives it. */
export type StoredRead =
  | { readonly read: "missing" }
  | { readonly read: "found"; readonly value: unknown }
  | { readonly read: "setAside"; readonly aside: string; readonly backup?: unknown }
  | { readonly read: "newer"; readonly found: number; readonly supported: number };

export interface RestoreInput {
  readonly app: AppKind;
  readonly factory: ById;
  readonly saved: Readonly<Record<string, StoredRead>>;
  readonly session: Readonly<Record<string, StoredRead>>;
  readonly lastGood: Readonly<Record<string, StoredRead>>;
  readonly order: readonly string[];
  readonly activeId: string | undefined;
  /** Panel kinds renamed since layouts were saved. */
  readonly aliases?: Readonly<Record<string, string>>;
}

export type RestoreWarningKind =
  | "session-set-aside"
  | "session-invalid"
  | "saved-set-aside"
  | "saved-invalid"
  | "dropped"
  | "newer-left-alone"
  | "active-reset"
  | "migrated";

export interface RestoreWarning {
  readonly id: string;
  readonly kind: RestoreWarningKind;
  /** In plain words, for the person, with the file's new name when one was set aside. */
  readonly detail: string;
}

/** A copy that is in use from a fallback and so is not what the store holds: it must be written back, or the next
 *  start would find the broken file again (or nothing, for a workspace the author made). */
export interface Repair {
  readonly kind: "saved" | "session";
  readonly id: string;
}

export interface Restored {
  readonly set: WorkspaceSet;
  readonly warnings: readonly RestoreWarning[];
  readonly repairs: readonly Repair[];
}

type Usable =
  | { readonly ws: SavedWorkspace; readonly migrated: boolean }
  | {
      readonly problem: string;
      readonly newer?: boolean;
      /** The file read but is not a usable layout (it breaks a rule, or is for another app or id). It is still on disk. */
      readonly invalid?: boolean;
      readonly aside?: string;
      readonly backup?: SavedWorkspace;
    };

function usable(stored: StoredRead | undefined, id: string, app: AppKind, aliases: Readonly<Record<string, string>>): Usable | undefined {
  if (stored === undefined || stored.read === "missing") return undefined;
  if (stored.read === "newer") return { problem: `it was saved by a newer GrapiX (layout version ${stored.found}; this one reads up to ${stored.supported})`, newer: true };
  const tryValue = (value: unknown): Usable => {
    const result = migrateWorkspace(value, aliases);
    if (isDockRefused(result)) return result.code === "LAYOUT_SCHEMA_NEWER" ? { problem: "it was saved by a newer GrapiX", newer: true } : { problem: result.refused, invalid: true };
    if (result.workspace.app !== app) return { problem: `it is a ${result.workspace.app} workspace, not an ${app} one`, invalid: true };
    if (result.workspace.workspaceId !== id) return { problem: `it is for ${result.workspace.workspaceId}, not ${id}`, invalid: true };
    return { ws: result.workspace, migrated: result.migrated || result.renamed.length > 0 };
  };
  if (stored.read === "found") return tryValue(stored.value);
  // The store offers the copy the last write replaced; it is used only if it passes every rule too.
  const fromBackup = stored.backup === undefined ? undefined : tryValue(stored.backup);
  const backup = fromBackup !== undefined && "ws" in fromBackup && validateWorkspace(fromBackup.ws).length === 0 ? fromBackup.ws : undefined;
  return { problem: "the file could not be read", aside: stored.aside, ...(backup === undefined ? {} : { backup }) };
}

function asideNote(aside: string | undefined): string {
  return aside === undefined ? "" : ` The file was kept as ${aside}.`;
}

/** Build the set from what the store holds. Each copy that cannot be used is named, set aside by the store and never
 *  replaced silently: a session copy falls back to the last good copy, then to the saved copy; a saved copy of a
 *  workspace the author made falls back to the last good copy, and failing that the workspace is left out; a copy
 *  from a newer GrapiX is left alone and not loaded. The workspace in use falls back to the first shipped one. */
export function restoreSet(input: RestoreInput): Restored {
  const aliases = input.aliases ?? {};
  const warnings: RestoreWarning[] = [];
  const repairs: Repair[] = [];
  const unloaded: string[] = [];
  const leftAlone: string[] = [];
  const saved: Record<string, SavedWorkspace> = {};
  const session: Record<string, SavedWorkspace> = {};
  const lastGood: Record<string, SavedWorkspace> = {};
  const note = (id: string, kind: RestoreWarningKind, detail: string): void => void warnings.push({ id, kind, detail });

  const ids = new Set([...Object.keys(input.saved), ...Object.keys(input.session), ...Object.keys(input.lastGood)]);
  for (const id of [...ids].sort()) {
    const good = usable(input.lastGood[id], id, input.app, aliases);
    if (good !== undefined && "ws" in good && validateWorkspace(good.ws).length === 0) lastGood[id] = good.ws;
    const factory = Object.prototype.hasOwnProperty.call(input.factory, id);

    const base = usable(input.saved[id], id, input.app, aliases);
    if (base !== undefined && "ws" in base) {
      saved[id] = base.ws;
      if (base.migrated) note(id, "migrated", `${base.ws.name} was brought up to date for this version.`);
    } else if (base !== undefined) {
      if (base.newer === true) {
        leftAlone.push(id);
        note(id, "newer-left-alone", `${id} ${base.problem}, so it was left alone and not loaded.`);
      } else if ((base.backup ?? lastGood[id]) !== undefined) {
        saved[id] = (base.backup ?? lastGood[id])!;
        repairs.push({ kind: "saved", id });
        note(id, "saved-invalid", `The saved copy of ${id} could not be used (${base.problem}); ${base.backup !== undefined ? "the copy kept from the save before it" : "the last good copy"} is in use.${asideNote(base.aside)}`);
      } else if (!factory) {
        // A file that is still on disk keeps its id out of use, so nothing is ever saved over it.
        if (base.invalid === true) unloaded.push(id);
        note(id, "dropped", `${id} could not be used (${base.problem}) and has no good copy, so it was left out.${asideNote(base.aside)}`);
      } else {
        note(id, "saved-invalid", `Your saved copy of ${id} could not be used (${base.problem}); the shipped one is in use.${asideNote(base.aside)}`);
      }
    }

    const live = usable(input.session[id], id, input.app, aliases);
    if (live !== undefined && "ws" in live) {
      if (saved[id] !== undefined || factory) session[id] = live.ws;
    } else if (live !== undefined) {
      if (live.invalid === true) {
        note(id, "session-invalid", `The arrangement last left for ${id} cannot be used (${live.problem}), so the saved one is used. The file is left as it is.`);
      } else if (live.newer === true) {
        if (!leftAlone.includes(id)) leftAlone.push(id);
        note(id, "newer-left-alone", `The arrangement last left for ${id} ${live.problem}, so it was left alone and the saved one is used.`);
      } else {
        const fallback = live.backup ?? lastGood[id];
        if (fallback !== undefined && (saved[id] !== undefined || factory)) {
          session[id] = fallback;
          repairs.push({ kind: "session", id });
        }
        note(id, "session-set-aside", `The arrangement last left for ${id} could not be read (${live.problem}); ${fallback === undefined ? "the saved one" : live.backup !== undefined ? "the one kept before it" : "the last good one"} is in use.${asideNote(live.aside)}`);
      }
    }
  }

  const factoryIds = Object.keys(input.factory);
  const base: WorkspaceSet = { app: input.app, factory: input.factory, saved, session, lastGood, order: [...input.order], activeId: factoryIds[0] ?? "", leftAlone, unloaded };
  const known = workspaceIds(base);
  let activeId = input.activeId;
  if (activeId === undefined || !known.includes(activeId)) {
    activeId = known[0] ?? "";
    if (input.activeId !== undefined) note(input.activeId, "active-reset", `The workspace in use (${input.activeId}) is not there any more, so ${activeId} is in use.`);
  }
  return { set: { ...base, activeId }, warnings, repairs };
}

// ---------------------------------------------------------------------------------------------------------------------
// Export and import
// ---------------------------------------------------------------------------------------------------------------------

/** A string that is a path on this computer: a drive letter, a share, or a home folder. */
const MACHINE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home)\/|~[\\/])/;

function withoutMachinePaths(value: unknown, path: string, removed: string[]): unknown {
  if (typeof value === "string") {
    if (MACHINE_PATH.test(value.trim())) {
      removed.push(path);
      return undefined;
    }
    return value;
  }
  if (Array.isArray(value)) return value.flatMap((item, index) => {
    const kept = withoutMachinePaths(item, `${path}[${index}]`, removed);
    return kept === undefined ? [] : [kept];
  });
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      const kept = withoutMachinePaths(inner, `${path}.${key}`, removed);
      if (kept !== undefined) out[key] = kept;
    }
    return out;
  }
  return value;
}

export interface Exported {
  readonly text: string;
  /** View-state entries left out because they were paths on this computer. */
  readonly removed: readonly string[];
}

/** A workspace as a file to share: what the author sees, as a layout of the author's own, with nothing that only means
 *  something on this computer (the display a floating group was on, which group had focus, a path in a panel's
 *  preferences). A secret is never in a workspace, so none can be exported. */
export function exportWorkspace(set: WorkspaceSet, id: string): Exported | PresetRefusal {
  const current = currentOf(set, id);
  if (current === undefined) return unknown(id);
  const removed: string[] = [];
  const viewState = withoutMachinePaths(current.viewState, "viewState", removed) as Record<string, unknown>;
  const kept = forSaving({ ...current, floats: current.floats.map(({ displayIdHint: _hint, ...float }) => float), viewState }, { origin: "user" });
  const { metadata, ...portable } = kept;
  return { text: JSON.stringify({ ...portable, ...(metadata?.description === undefined ? {} : { metadata: { description: metadata.description } }) }, null, 2), removed };
}

export interface ImportReport {
  readonly name: string;
  /** The name it came with, when it had to be changed because another workspace has it. */
  readonly renamedFrom?: string;
  /** Panels in it that this build or application cannot show: they stay in it, as placeholders. */
  readonly unavailable: readonly { readonly instanceId: string; readonly panelType: string }[];
  /** Panel kinds that were renamed since it was made. */
  readonly renamed: readonly string[];
  /** Floating groups in it. They are kept and brought back into view when the window opens. */
  readonly floats: number;
}

/** Add a workspace from a file as a new workspace of the author's own. It is not switched to: the person sees what it
 *  holds first. A file that is not a layout, is a newer one, is for the other application or breaks a rule is refused
 *  with the reason, and nothing is added. */
export function importWorkspace(
  set: WorkspaceSet,
  text: string,
  options: { readonly aliases?: Readonly<Record<string, string>>; readonly isAvailable?: (panelType: string) => boolean; readonly now?: string } = {},
): { readonly set: WorkspaceSet; readonly id: string; readonly report: ImportReport } | PresetRefusal {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { code: "LAYOUT_VALIDATION_FAILED", refused: "this file is not a GrapiX layout: its contents could not be read. Choose a layout that GrapiX exported. Nothing was changed." };
  }
  const read = migrateWorkspace(value, options.aliases ?? {});
  if (isDockRefused(read)) return read;
  if (read.workspace.app !== set.app) {
    return refuse("WORKSPACE_WRONG_APP", `this is a ${read.workspace.app} workspace, and this is the ${set.app} application. Nothing was changed.`);
  }
  const wanted = checkName(read.workspace.name);
  const name = freeName(set, typeof wanted === "string" ? wanted : "Imported workspace");
  const id = newIdFor(set, name);
  const kept = forSaving(read.workspace, { workspaceId: id, name, origin: "user", ...(options.now === undefined ? {} : { now: options.now }) });
  const unavailable = Object.values(kept.instances)
    .filter((instance) => options.isAvailable !== undefined && !options.isAvailable(instance.panelType))
    .map((instance) => ({ instanceId: instance.instanceId, panelType: instance.panelType }));
  return {
    id,
    set: { ...set, saved: { ...set.saved, [id]: kept }, session: { ...set.session, [id]: kept }, order: [...workspaceIds(set), id] },
    report: {
      name,
      ...(name === read.workspace.name.trim() ? {} : { renamedFrom: read.workspace.name }),
      unavailable,
      renamed: read.renamed,
      floats: kept.floats.length,
    },
  };
}
