// Carrying the workspace set to and from disk (plan rows 11.94 and 2.29).
//
// `WorkspacePersistence` is what the page needs from the store: read a file, write one, remove one, list, and keep
// the workspace in use and the order. The real one speaks to the shell's `cmd_workspace_*` commands (the Rust store);
// the in-memory one is for tests and for a page opened without a shell. The set itself is in `workspace-presets.ts`.

import type { AppKind, SavedWorkspace } from "./dock-model";
import {
  baselineOf,
  currentOf,
  restoreSet,
  workspaceIds,
  type Repair,
  type Restored,
  type StoredRead,
  type WorkspaceSet,
} from "./workspace-presets";

export type StoredKind = "saved" | "session" | "lastGood";

export interface WorkspacePersistence {
  get(app: AppKind, kind: StoredKind, id: string): Promise<StoredRead>;
  /** Rejects with the store's refusal, which names the reason, when the id or the document is not acceptable. */
  put(app: AppKind, kind: StoredKind, id: string, value: unknown): Promise<void>;
  remove(app: AppKind, kind: StoredKind, id: string): Promise<boolean>;
  list(app: AppKind, kind: StoredKind): Promise<string[]>;
  active(app: AppKind): Promise<string | null>;
  setActive(app: AppKind, id: string | null): Promise<void>;
  order(app: AppKind): Promise<string[]>;
  setOrder(app: AppKind, ids: readonly string[]): Promise<void>;
}

/** The shell's `invoke`. */
export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export function tauriPersistence(invoke: Invoke): WorkspacePersistence {
  return {
    get: (app, kind, id) => invoke<StoredRead>("cmd_workspace_get", { app, kind, id }),
    put: (app, kind, id, value) => invoke<void>("cmd_workspace_put", { app, kind, id, value }),
    remove: (app, kind, id) => invoke<boolean>("cmd_workspace_delete", { app, kind, id }),
    list: (app, kind) => invoke<string[]>("cmd_workspace_list", { app, kind }),
    active: (app) => invoke<string | null>("cmd_workspace_active", { app }),
    setActive: (app, id) => invoke<void>("cmd_workspace_set_active", { app, id }),
    order: (app) => invoke<string[]>("cmd_workspace_order", { app }),
    setOrder: (app, ids) => invoke<void>("cmd_workspace_set_order", { app, ids: [...ids] }),
  };
}

/** A store in memory, with the same behaviour a page depends on. `fail` makes the next writes reject, to test what the
 *  page does when a write does not happen. */
export function memoryPersistence(): WorkspacePersistence & {
  readonly files: Map<string, unknown>;
  readonly writes: string[];
  fail: ((what: string) => boolean) | undefined;
} {
  const files = new Map<string, unknown>();
  const writes: string[] = [];
  const key = (app: AppKind, kind: StoredKind, id: string): string => `${app}/${kind}/${id}`;
  const store = {
    files,
    writes,
    fail: undefined as ((what: string) => boolean) | undefined,
    async get(app: AppKind, kind: StoredKind, id: string): Promise<StoredRead> {
      const value = files.get(key(app, kind, id));
      return value === undefined ? { read: "missing" } : { read: "found", value };
    },
    async put(app: AppKind, kind: StoredKind, id: string, value: unknown): Promise<void> {
      const what = key(app, kind, id);
      if (store.fail?.(what) === true) throw new Error(`the store could not write ${what}`);
      writes.push(what);
      files.set(what, structuredClone(value));
    },
    async remove(app: AppKind, kind: StoredKind, id: string): Promise<boolean> {
      const what = key(app, kind, id);
      if (store.fail?.(what) === true) throw new Error(`the store could not remove ${what}`);
      return files.delete(what);
    },
    async list(app: AppKind, kind: StoredKind): Promise<string[]> {
      const prefix = `${app}/${kind}/`;
      return [...files.keys()].filter((name) => name.startsWith(prefix)).map((name) => name.slice(prefix.length)).sort();
    },
    async active(app: AppKind): Promise<string | null> {
      return (files.get(`${app}/active`) as string | undefined) ?? null;
    },
    async setActive(app: AppKind, id: string | null): Promise<void> {
      if (store.fail?.(`${app}/active`) === true) throw new Error("the store could not write the workspace in use");
      if (id === null) files.delete(`${app}/active`);
      else files.set(`${app}/active`, id);
    },
    async order(app: AppKind): Promise<string[]> {
      return [...((files.get(`${app}/order`) as string[] | undefined) ?? [])];
    },
    async setOrder(app: AppKind, ids: readonly string[]): Promise<void> {
      if (store.fail?.(`${app}/order`) === true) throw new Error("the store could not write the order");
      files.set(`${app}/order`, [...ids]);
    },
  };
  return store;
}

async function readAll(p: WorkspacePersistence, app: AppKind, kind: StoredKind, extra: readonly string[]): Promise<Record<string, StoredRead>> {
  const ids = new Set([...(await p.list(app, kind)), ...extra]);
  const out: Record<string, StoredRead> = {};
  for (const id of ids) out[id] = await p.get(app, kind, id);
  return out;
}

/** Read every copy the store holds and build the set, falling back where a copy cannot be used. The result names every
 *  fallback in `warnings`. Nothing is written: whatever the store set aside is kept as it is. */
export async function loadWorkspaceSet(
  p: WorkspacePersistence,
  app: AppKind,
  factory: Readonly<Record<string, SavedWorkspace>>,
  aliases: Readonly<Record<string, string>> = {},
): Promise<Restored> {
  const factoryIds = Object.keys(factory);
  // A shipped workspace's session copy is read even if the author never saved one of their own.
  const [saved, session, lastGood, order, active] = await Promise.all([
    readAll(p, app, "saved", []),
    readAll(p, app, "session", factoryIds),
    readAll(p, app, "lastGood", factoryIds),
    p.order(app),
    p.active(app),
  ]);
  return restoreSet({ app, factory, saved, session, lastGood, order, activeId: active ?? undefined, aliases });
}

/** What changed between two sets, as the writes that carry it to the store. */
export interface Write {
  readonly kind: StoredKind;
  readonly id: string;
  /** `undefined` removes the file. */
  readonly value: SavedWorkspace | undefined;
}

/** The writes that make the store match `after`, given what it matched at `before`. A copy that is the same object is
 *  not written again; one that is gone is removed. Nothing is skipped here: a file written by a newer GrapiX is
 *  protected by the store itself, which refuses the write by name, so the page can say the change was not saved
 *  instead of believing it was. */
export function writesBetween(before: WorkspaceSet, after: WorkspaceSet): Write[] {
  const writes: Write[] = [];
  const kinds: [StoredKind, "saved" | "session" | "lastGood"][] = [["saved", "saved"], ["session", "session"], ["lastGood", "lastGood"]];
  for (const [kind, field] of kinds) {
    const was = before[field];
    const now = after[field];
    for (const id of Object.keys(now)) {
      if (was[id] !== now[id]) writes.push({ kind, id, value: now[id] });
    }
    for (const id of Object.keys(was)) {
      if (!(id in now)) writes.push({ kind, id, value: undefined });
    }
  }
  return writes;
}

/** Carry the difference between two sets to the store, in an order that never leaves a workspace without its saved copy:
 *  saved copies first, then the rest, then removals. The workspace in use and the order follow if they changed.
 *  Rejects with the first failure, having written what came before it. */
export async function persistChange(p: WorkspacePersistence, before: WorkspaceSet, after: WorkspaceSet): Promise<void> {
  const writes = writesBetween(before, after);
  const rank = (w: Write): number => (w.value === undefined ? 2 : w.kind === "saved" ? 0 : 1);
  for (const w of [...writes].sort((a, b) => rank(a) - rank(b))) {
    if (w.value === undefined) await p.remove(after.app, w.kind, w.id);
    else await p.put(after.app, w.kind, w.id, w.value);
  }
  if (before.activeId !== after.activeId) await p.setActive(after.app, after.activeId);
  if (JSON.stringify(workspaceIds(before)) !== JSON.stringify(workspaceIds(after)) || JSON.stringify(before.order) !== JSON.stringify(after.order)) {
    await p.setOrder(after.app, storedOrder(after));
  }
}

/** The order as it is written: every workspace this build lists, and, in the places the order gave them, the ones it
 *  did not load (written by a newer GrapiX, or not usable), so another computer finds them where the author put them. */
export function storedOrder(set: WorkspaceSet): string[] {
  const listed = workspaceIds(set);
  const keep = new Set([...listed, ...set.leftAlone, ...(set.unloaded ?? [])]);
  const out: string[] = [];
  for (const id of set.order) if (keep.has(id) && !out.includes(id)) out.push(id);
  for (const id of listed) if (!out.includes(id)) out.push(id);
  return out;
}

/** Write back the copies that are in use from a fallback, so the store holds what the author sees. */
export async function persistRepairs(p: WorkspacePersistence, set: WorkspaceSet, repairs: readonly Repair[]): Promise<void> {
  for (const repair of repairs) {
    const value = (repair.kind === "saved" ? set.saved : set.session)[repair.id];
    if (value !== undefined) await p.put(set.app, repair.kind, repair.id, value);
  }
}

/** What the page should show for the workspace in use. */
export function inUse(set: WorkspaceSet): SavedWorkspace | undefined {
  return currentOf(set, set.activeId) ?? baselineOf(set, set.activeId);
}
