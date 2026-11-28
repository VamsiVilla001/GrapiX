// The Layout dropdown and the Layouts dialog's logic (plan row 11.96): the named workspaces of the Editor, kept in the store by the
// shell, with the page's four-region layout carried inside each (layout-bridge.ts).
//
// Everything that changes a workspace goes through workspace-presets.ts, so the rules are the model's: a shipped workspace is never
// changed and keeps its name, the one in use cannot be deleted, a name is unique. This file adds the store, the pause before a change
// is written, and what the page needs back: the layout to show. Switching a workspace changes only the arrangement of panels: it
// never touches a scene, the selection, undo or any output.

import type { Layout } from "./workspace-layout";
import { isUnavailable, pageLayoutOf, workspaceWithPageLayout } from "./layout-bridge";
import { PANEL_ALIASES, factoryWorkspaces, shippedSet } from "./workspace-catalog";
import { inUse, loadWorkspaceSet, persistChange, persistRepairs, type WorkspacePersistence } from "./workspace-persistence";
import * as presets from "./workspace-presets";
import type { WorkspaceSet } from "./workspace-presets";

export interface LayoutItem {
  readonly id: string;
  readonly name: string;
  /** Changed since it was last saved (a shipped one: since it shipped). Shown as a dot. */
  readonly modified: boolean;
  /** Ships with GrapiX: it keeps its name and cannot be deleted. */
  readonly shipped: boolean;
  readonly active: boolean;
}

export interface Outcome {
  readonly ok: boolean;
  /** In words, for the dialog and the activity line. */
  readonly message: string;
  /** The layout the page should now show, when the action changed which one that is. */
  readonly layout?: Layout;
}

export interface SwitcherDeps {
  readonly persistence: WorkspacePersistence;
  /** The panels the page has now, to reconcile a stored arrangement against. */
  readonly panels: () => readonly string[];
  /** What the page is showing now. */
  readonly currentLayout: () => Layout;
  /** The arrangement the author already had before named workspaces existed, if any: it becomes Design's session copy on first run. */
  readonly previousLayout?: Layout | undefined;
  /** Something the person should be told that is not the answer to what they did (a fallback, a write that failed). */
  readonly say?: (message: string, tone: "good" | "bad") => void;
  /** Milliseconds to wait after a change before writing it; a negative number never writes by itself (tests call `flush`). */
  readonly delayMs?: number;
  readonly now?: () => string;
}

export interface LayoutSwitcher {
  start(): Promise<{ readonly layout?: Layout }>;
  items(): readonly LayoutItem[];
  activeId(): string;
  /** The page's layout changed: the session copy follows after a short pause (never during a drag: the page calls this when it ends). */
  changed(layout: Layout): void;
  switchTo(id: string): Promise<Outcome>;
  saveAs(name: string): Promise<Outcome>;
  save(): Promise<Outcome>;
  rename(id: string, name: string): Promise<Outcome>;
  remove(id: string): Promise<Outcome>;
  /** Back to the saved copy, or for a shipped workspace back to the arrangement it ships with. */
  reset(id: string): Promise<Outcome>;
  flush(): Promise<void>;
  /** Whether the workspace in use has been changed since it was saved. */
  activeModified(): boolean;
}

const refusedWords = (refusal: presets.PresetRefusal): string => refusal.refused;

export function createLayoutSwitcher(deps: SwitcherDeps): LayoutSwitcher {
  const app = "editor" as const;
  let set: WorkspaceSet = shippedSet(app);
  let persisted: WorkspaceSet = set;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<void> = Promise.resolve();
  const delay = deps.delayMs ?? 800;
  const say = deps.say ?? (() => undefined);

  const metaOf = (id: string) => {
    const ws = presets.currentOf(set, id) ?? presets.baselineOf(set, id);
    return { workspaceId: id, name: ws?.name ?? id, origin: ws?.origin ?? "user", app } as const;
  };

  const write = (): Promise<void> => {
    queue = queue.then(async () => {
      const target = set;
      try {
        await persistChange(deps.persistence, persisted, target);
        persisted = target;
      } catch (error) {
        say(`The layout was changed but not saved: ${error instanceof Error ? error.message : String(error)}`, "bad");
      }
    });
    return queue;
  };

  const flush = async (): Promise<void> => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    await write();
  };

  const layoutOfActive = (): { readonly layout: Layout; readonly notes: readonly string[] } | { readonly unavailable: string } => {
    const ws = inUse(set);
    if (ws === undefined) return { unavailable: "there is no workspace in use" };
    return pageLayoutOf(ws, deps.panels());
  };

  /** Keep the page's layout as the session copy of the workspace in use. Refused arrangements are named and not kept. */
  const keepCurrent = (layout: Layout): boolean => {
    const next = presets.changeSession(set, set.activeId, workspaceWithPageLayout(layout, metaOf(set.activeId)));
    if (presets.isPresetRefused(next)) {
      say(refusedWords(next), "bad");
      return false;
    }
    set = next;
    return true;
  };

  const record = (next: WorkspaceSet): void => {
    const good = presets.markGood(next, next.activeId);
    set = presets.isPresetRefused(good) ? next : good;
  };

  const fail = (refusal: presets.PresetRefusal): Outcome => ({ ok: false, message: refusedWords(refusal) });

  return {
    async start() {
      const restored = await loadWorkspaceSet(deps.persistence, app, factoryWorkspaces(app), PANEL_ALIASES);
      set = restored.set;
      for (const warning of restored.warnings) say(`Layouts: ${warning.detail}`, "bad");
      await persistRepairs(deps.persistence, set, restored.repairs);
      // First run with named layouts: what the author had arranged becomes the session copy of the workspace in use, so nothing moves.
      if (deps.previousLayout !== undefined && set.session[set.activeId] === undefined && presets.isFactory(set, set.activeId)) {
        const kept = presets.changeSession(set, set.activeId, workspaceWithPageLayout(deps.previousLayout, metaOf(set.activeId)));
        if (!presets.isPresetRefused(kept)) set = kept;
      }
      persisted = restored.set;
      const read = layoutOfActive();
      if (isUnavailable(read)) {
        say(`Layouts: ${read.unavailable}`, "bad");
        await write();
        return {};
      }
      for (const note of read.notes) say(`Layouts: ${note}`, "bad");
      record(set);
      await write();
      return { layout: read.layout };
    },

    items() {
      return presets.workspaceIds(set).map((id) => ({
        id,
        name: presets.nameOf(set, id) ?? id,
        modified: presets.isModified(set, id),
        shipped: presets.isFactory(set, id),
        active: id === set.activeId,
      }));
    },

    activeId: () => set.activeId,
    activeModified: () => presets.isModified(set, set.activeId),

    changed(layout) {
      if (!keepCurrent(layout) || delay < 0) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void write();
      }, delay);
    },

    async switchTo(id) {
      if (id === set.activeId) return { ok: true, message: "That layout is already in use." };
      keepCurrent(deps.currentLayout());
      const next = presets.activate(set, id);
      if (presets.isPresetRefused(next)) return fail(next);
      const before = set;
      set = next;
      const read = layoutOfActive();
      if (isUnavailable(read)) {
        set = before;
        return { ok: false, message: read.unavailable };
      }
      record(set);
      await flush();
      return { ok: true, message: `Layout: ${presets.nameOf(set, id) ?? id}`, layout: read.layout };
    },

    async saveAs(name) {
      keepCurrent(deps.currentLayout());
      const made = presets.saveAs(set, set.activeId, name, deps.now?.());
      if (presets.isPresetRefused(made)) return fail(made);
      const next = presets.activate(made.set, made.id);
      if (presets.isPresetRefused(next)) return fail(next);
      set = next;
      record(set);
      await flush();
      return { ok: true, message: `Saved as ${presets.nameOf(set, made.id) ?? name}. It is the layout in use.` };
    },

    async save() {
      keepCurrent(deps.currentLayout());
      const next = presets.save(set, set.activeId, deps.now?.());
      if (presets.isPresetRefused(next)) return fail(next);
      set = next;
      record(set);
      await flush();
      return { ok: true, message: `Saved ${presets.nameOf(set, set.activeId) ?? "the layout"}.` };
    },

    async rename(id, name) {
      const next = presets.rename(set, id, name);
      if (presets.isPresetRefused(next)) return fail(next);
      set = next;
      await flush();
      return { ok: true, message: `Renamed to ${presets.nameOf(set, id) ?? name}.` };
    },

    async remove(id) {
      const label = presets.nameOf(set, id) ?? id;
      const next = presets.remove(set, id);
      if (presets.isPresetRefused(next)) return fail(next);
      set = next;
      await flush();
      return { ok: true, message: `Deleted ${label}.` };
    },

    async reset(id) {
      const next = presets.isFactory(set, id) ? presets.resetToFactory(set, id) : presets.resetToSaved(set, id);
      if (presets.isPresetRefused(next)) return fail(next);
      set = next;
      if (id !== set.activeId) {
        await flush();
        return { ok: true, message: `${presets.nameOf(set, id) ?? id} is back as it was saved.` };
      }
      const read = layoutOfActive();
      if (isUnavailable(read)) return { ok: false, message: read.unavailable };
      record(set);
      await flush();
      return { ok: true, message: `${presets.nameOf(set, id) ?? id} is back as it was.`, layout: read.layout };
    },

    flush,
  };
}
