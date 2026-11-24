// Carrying the workspace set to and from the store (11.94, 2.29): reading with fallbacks, writing only what changed, in an
// order that never leaves a workspace without its saved copy.
import { describe, expect, it } from "vitest";
import { movePanel, type SavedWorkspace } from "../src/dock-model";
import { loadWorkspaceSet, memoryPersistence, persistChange, persistRepairs, storedOrder, tauriPersistence, writesBetween, inUse } from "../src/workspace-persistence";
import { EDITOR_DESIGN_ID, factoryWorkspaces, shippedSet, PANEL_ALIASES } from "../src/workspace-catalog";
import { activate, changeSession, currentOf, markGood, remove, reorder, resetToFactory, save, saveAs, workspaceIds, type WorkspaceSet } from "../src/workspace-presets";
import { validateWorkspace } from "../src/dock-validate";
import { ok } from "./dock-fixtures";

const D = EDITOR_DESIGN_ID;
const edit = (set: WorkspaceSet, id: string): WorkspaceSet => ok(changeSession(set, id, ok(movePanel(currentOf(set, id)!, "scene-manager-1", "inspector-group", "center"))));

describe("what ships", () => {
  it("is the Design workspace, valid, as the Editor's four-region layout arranged it, and nothing for Playout yet", () => {
    const editor = factoryWorkspaces("editor");
    expect(Object.keys(editor)).toEqual([D]);
    expect(editor[D]).toMatchObject({ name: "Design", origin: "factory", app: "editor", workspaceId: D });
    expect(validateWorkspace(editor[D]!)).toEqual([]);
    // left 7, centre 1, right 11 (the Pivot panel since 11.103, the Masks panel since 11.117), bottom 1.
    expect(Object.keys(editor[D]!.instances)).toHaveLength(20);
    expect(factoryWorkspaces("playout")).toEqual({});
    expect(shippedSet("playout").activeId).toBe("");
    expect(PANEL_ALIASES).toEqual({});
  });
});

describe("reading the store", () => {
  it("is just what ships when the store is empty, and writes nothing", async () => {
    const p = memoryPersistence();
    const { set, warnings } = await loadWorkspaceSet(p, "editor", factoryWorkspaces("editor"));
    expect(workspaceIds(set)).toEqual([D]);
    expect(warnings).toEqual([]);
    expect(p.writes).toEqual([]);
  });

  it("reads every copy, the order and the workspace in use", async () => {
    const p = memoryPersistence();
    const set0 = ok(saveAs(shippedSet("editor"), D, "Mine"));
    const set1 = ok(activate(edit(set0.set, set0.id), set0.id));
    await persistChange(p, shippedSet("editor"), set1);
    const { set, warnings } = await loadWorkspaceSet(p, "editor", factoryWorkspaces("editor"));
    expect(warnings).toEqual([]);
    expect(set.activeId).toBe(set0.id);
    expect(workspaceIds(set)).toEqual(workspaceIds(set1));
    expect(JSON.stringify(currentOf(set, set0.id))).toBe(JSON.stringify(currentOf(set1, set0.id)));
  });

  it("writes back a copy that is in use from a fallback, so the workspace is still there at the next start", async () => {
    const p = memoryPersistence();
    const made = ok(saveAs(shippedSet("editor"), D, "Mine"));
    await persistChange(p, shippedSet("editor"), ok(markGood(made.set, made.id)));
    const real = p.get.bind(p);
    let broken = true;
    p.get = async (app, kind, id) => (broken && kind === "saved" && id === made.id ? { read: "setAside", aside: "u.corrupt-1" } : real(app, kind, id));
    const first = await loadWorkspaceSet(p, "editor", factoryWorkspaces("editor"));
    expect(first.repairs).toEqual([{ kind: "saved", id: made.id }]);
    // The store set the broken file aside when it read it: it is gone from its place.
    p.files.delete(`editor/saved/${made.id}`);
    await persistRepairs(p, first.set, first.repairs);
    expect(p.files.has(`editor/saved/${made.id}`)).toBe(true);
    broken = false;
    const second = await loadWorkspaceSet(p, "editor", factoryWorkspaces("editor"));
    expect(workspaceIds(second.set)).toEqual([D, made.id]);
    expect(second.warnings).toEqual([]);
    expect(second.repairs).toEqual([]);
  });

  it("falls back where a copy was set aside and names it", async () => {
    const p = memoryPersistence();
    const made = ok(saveAs(shippedSet("editor"), D, "Mine"));
    await persistChange(p, shippedSet("editor"), made.set);
    // The store answers a set-aside for the session copy, as it does for a file that did not read.
    const real = p.get.bind(p);
    p.get = async (app, kind, id) => (kind === "session" && id === made.id ? { read: "setAside", aside: "s.corrupt-1" } : real(app, kind, id));
    const { set, warnings } = await loadWorkspaceSet(p, "editor", factoryWorkspaces("editor"));
    expect(workspaceIds(set)).toEqual([D, made.id]);
    expect(warnings.map((w) => w.kind)).toEqual(["session-set-aside"]);
    expect(warnings[0]!.detail).toContain("s.corrupt-1");
  });

  it("reads a shipped workspace's session copy even though the author never saved one of their own", async () => {
    const p = memoryPersistence();
    const changed = edit(shippedSet("editor"), D);
    await p.put("editor", "session", D, changed.session[D]);
    const { set } = await loadWorkspaceSet(p, "editor", factoryWorkspaces("editor"));
    expect(JSON.stringify(currentOf(set, D)!.root)).toBe(JSON.stringify(changed.session[D]!.root));
  });

  it("keeps the two applications apart", async () => {
    const p = memoryPersistence();
    const made = ok(saveAs(shippedSet("editor"), D, "Mine"));
    await persistChange(p, shippedSet("editor"), made.set);
    const playout = await loadWorkspaceSet(p, "playout", factoryWorkspaces("playout"));
    expect(workspaceIds(playout.set)).toEqual([]);
  });
});

describe("what to write", () => {
  it("is nothing when nothing changed, and only the copies that did", () => {
    const set = shippedSet("editor");
    expect(writesBetween(set, set)).toEqual([]);
    const changed = edit(set, D);
    expect(writesBetween(set, changed)).toEqual([{ kind: "session", id: D, value: changed.session[D] }]);
    const saved = ok(save(changed, D));
    expect(writesBetween(changed, saved).map((w) => `${w.kind}:${w.id}`).sort()).toEqual([`saved:${D}`, `session:${D}`].sort());
    const good = ok(markGood(saved, D));
    expect(writesBetween(saved, good)).toEqual([{ kind: "lastGood", id: D, value: good.lastGood[D] }]);
  });

  it("removes the files of a workspace that was deleted, and of a shipped one that was reset", () => {
    const made = ok(saveAs(shippedSet("editor"), D, "Mine"));
    const gone = ok(remove(ok(markGood(made.set, made.id)), made.id));
    expect(writesBetween(ok(markGood(made.set, made.id)), gone).map((w) => `${w.kind}:${w.id}:${w.value === undefined ? "remove" : "write"}`).sort()).toEqual([
      `lastGood:${made.id}:remove`, `saved:${made.id}:remove`, `session:${made.id}:remove`,
    ].sort());
    const saved = ok(save(edit(shippedSet("editor"), D), D));
    const reset = ok(resetToFactory(saved, D));
    expect(writesBetween(saved, reset).map((w) => `${w.kind}:${w.value === undefined ? "remove" : "write"}`).sort()).toEqual(["saved:remove", "session:remove"]);
  });

  it("does not skip a write for a workspace with a newer file: the store refuses it by name, so it is never lost silently", async () => {
    // The session copy of Design was written by a newer GrapiX; the author's changes still go to the store, which
    // refuses that one file by name, and the save of the saved copy is not skipped.
    const before: WorkspaceSet = { ...shippedSet("editor"), leftAlone: [D] };
    const after = ok(save(edit(before, D), D));
    expect(writesBetween(before, after).map((w) => `${w.kind}:${w.id}`).sort()).toEqual([`saved:${D}`, `session:${D}`]);
    const p = memoryPersistence();
    p.fail = (what) => what === `editor/session/${D}`;
    await expect(persistChange(p, before, after)).rejects.toThrow(`the store could not write editor/session/${D}`);
    expect(p.writes).toEqual([`editor/saved/${D}`]);
  });

  it("keeps in the order the places of workspaces this build did not load", () => {
    const made = ok(saveAs(shippedSet("editor"), D, "Mine"));
    const set: WorkspaceSet = { ...made.set, order: ["user.future", D, "user.broken", "user.gone", made.id], leftAlone: ["user.future"], unloaded: ["user.broken"] };
    expect(storedOrder(set)).toEqual(["user.future", D, "user.broken", made.id]);
    expect(storedOrder(shippedSet("editor"))).toEqual([D]);
  });
});

describe("writing", () => {
  it("writes the saved copy before the session copy, and removals last, so a workspace is never left without its saved copy", async () => {
    const p = memoryPersistence();
    const first = ok(saveAs(shippedSet("editor"), D, "Mine"));
    await persistChange(p, shippedSet("editor"), first.set);
    expect(p.writes).toEqual([`editor/saved/${first.id}`, `editor/session/${first.id}`]);
    expect(await p.list("editor", "saved")).toEqual([first.id]);
    expect(await p.order("editor")).toEqual([D, first.id]);
    expect(await p.active("editor")).toBeNull();
    p.writes.length = 0;
    const removed = ok(remove(first.set, first.id));
    await persistChange(p, first.set, removed);
    expect(p.writes).toEqual([]);
    expect(await p.list("editor", "saved")).toEqual([]);
    expect(await p.list("editor", "session")).toEqual([]);
    expect(await p.order("editor")).toEqual([D]);
  });

  it("writes the workspace in use and the order only when they changed", async () => {
    const p = memoryPersistence();
    const made = ok(saveAs(shippedSet("editor"), D, "Mine"));
    await persistChange(p, shippedSet("editor"), made.set);
    const switched = ok(activate(made.set, made.id));
    await persistChange(p, made.set, switched);
    expect(await p.active("editor")).toBe(made.id);
    const reordered = ok(reorder(switched, [made.id, D]));
    await persistChange(p, switched, reordered);
    expect(await p.order("editor")).toEqual([made.id, D]);
    p.files.set("editor/active", "sentinel");
    p.files.set("editor/order", ["sentinel"]);
    await persistChange(p, reordered, reordered);
    expect(await p.active("editor")).toBe("sentinel");
    expect(await p.order("editor")).toEqual(["sentinel"]);
  });

  it("rejects with what failed, having written what came before it, and does not claim the rest", async () => {
    const p = memoryPersistence();
    const made = ok(saveAs(shippedSet("editor"), D, "Mine"));
    p.fail = (what) => what.includes("/session/");
    await expect(persistChange(p, shippedSet("editor"), made.set)).rejects.toThrow(`the store could not write editor/session/${made.id}`);
    expect(p.writes).toEqual([`editor/saved/${made.id}`]);
    expect(await p.get("editor", "session", made.id)).toEqual({ read: "missing" });
  });

  it("shows the arrangement of the workspace in use", () => {
    const set = edit(shippedSet("editor"), D);
    expect(inUse(set)).toBe(currentOf(set, D));
    expect(inUse({ ...set, activeId: "ghost" })).toBeUndefined();
  });
});

describe("the real store, through the shell", () => {
  it("sends each call to its own command with the application, the kind and the id", async () => {
    const calls: [string, unknown][] = [];
    const answers: Record<string, unknown> = {
      cmd_workspace_get: { read: "missing" }, cmd_workspace_delete: true, cmd_workspace_list: ["a"], cmd_workspace_active: "a", cmd_workspace_order: ["a", "b"],
    };
    const p = tauriPersistence(async (command, args) => {
      calls.push([command, args]);
      return answers[command] as never;
    });
    expect(await p.get("editor", "lastGood", "a")).toEqual({ read: "missing" });
    await p.put("playout", "saved", "b", { schemaVersion: 1 });
    expect(await p.remove("editor", "session", "c")).toBe(true);
    expect(await p.list("editor", "saved")).toEqual(["a"]);
    expect(await p.active("editor")).toBe("a");
    await p.setActive("editor", null);
    expect(await p.order("playout")).toEqual(["a", "b"]);
    await p.setOrder("editor", ["x", "y"]);
    expect(calls).toEqual([
      ["cmd_workspace_get", { app: "editor", kind: "lastGood", id: "a" }],
      ["cmd_workspace_put", { app: "playout", kind: "saved", id: "b", value: { schemaVersion: 1 } }],
      ["cmd_workspace_delete", { app: "editor", kind: "session", id: "c" }],
      ["cmd_workspace_list", { app: "editor", kind: "saved" }],
      ["cmd_workspace_active", { app: "editor" }],
      ["cmd_workspace_set_active", { app: "editor", id: null }],
      ["cmd_workspace_order", { app: "playout" }],
      ["cmd_workspace_set_order", { app: "editor", ids: ["x", "y"] }],
    ]);
  });
});

describe("the in-memory store behaves like the real one", () => {
  it("keeps what is put, lists it sorted per kind and application, and removes it", async () => {
    const p = memoryPersistence();
    const ws: SavedWorkspace = shippedSet("editor").factory[D]!;
    await p.put("editor", "saved", "b", ws);
    await p.put("editor", "saved", "a", ws);
    await p.put("editor", "session", "z", ws);
    await p.put("playout", "saved", "p", ws);
    expect(await p.list("editor", "saved")).toEqual(["a", "b"]);
    expect(await p.list("playout", "saved")).toEqual(["p"]);
    expect(await p.get("editor", "saved", "a")).toEqual({ read: "found", value: ws });
    expect(await p.remove("editor", "saved", "a")).toBe(true);
    expect(await p.remove("editor", "saved", "a")).toBe(false);
    // A value put is a copy: changing the original later does not change what is kept.
    const mutable = { schemaVersion: 1, list: [1] };
    await p.put("editor", "saved", "m", mutable);
    mutable.list.push(2);
    expect(await p.get("editor", "saved", "m")).toEqual({ read: "found", value: { schemaVersion: 1, list: [1] } });
  });
});

describe("the layout version", () => {
  it("is the same number in the page and in the Rust store", async () => {
    const { WORKSPACE_SCHEMA_VERSION } = await import("../src/dock-model");
    const rust = (await import("../../Shared/workspace-store/src/lib.rs?raw")).default;
    const found = /pub const LAYOUT_SCHEMA_VERSION: u32 = (\d+);/.exec(rust);
    expect(found?.[1]).toBe(String(WORKSPACE_SCHEMA_VERSION));
  });
});
