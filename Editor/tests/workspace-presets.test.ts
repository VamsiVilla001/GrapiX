// Named workspaces (11.94): the shipped, saved, session and last-good copies, and every step between them.
import { describe, expect, it } from "vitest";
import { maximizeGroup, movePanel, type SavedWorkspace, type SplitNode } from "../src/dock-model";
import { validateWorkspace } from "../src/dock-validate";
import { serializeWorkspace } from "../src/workspace-io";
import { EDITOR_DESIGN_ID, shippedSet } from "../src/workspace-catalog";
import {
  activate, baselineOf, changeSession, checkName, currentOf, duplicate, exportWorkspace, freeName, hasOverride, importWorkspace, isFactory,
  isModified, isPresetRefused, isUser, markGood, newIdFor, nameOf, remove, rename, reorder, resetToFactory, resetToSaved, restoreSet, save,
  saveAs, workspaceIds, type PresetRefusal, type StoredRead, type WorkspaceSet,
} from "../src/workspace-presets";
import { deepFreeze, ok } from "./dock-fixtures";

const D = EDITOR_DESIGN_ID;
const refusal = (result: unknown): PresetRefusal => {
  if (!isPresetRefused(result as PresetRefusal)) throw new Error(`not refused: ${JSON.stringify(result).slice(0, 100)}`);
  return result as PresetRefusal;
};

/** The arrangement of `id` with one panel moved, so it differs from what was saved. */
function changed(set: WorkspaceSet, id: string): SavedWorkspace {
  const ws = currentOf(set, id)!;
  const groupHolding = (panel: string) => JSON.stringify(ws.root).includes(`"${panel}"`);
  expect(groupHolding("scene-manager-1")).toBe(true);
  return ok(movePanel(ws, "scene-manager-1", "inspector-group", "center"));
}

const withChange = (set: WorkspaceSet, id: string): WorkspaceSet => ok(changeSession(set, id, changed(set, id)));
const found = (value: unknown): StoredRead => ({ read: "found", value: JSON.parse(JSON.stringify(value)) });

describe("what ships", () => {
  it("is one workspace, Design, valid, as it ships, with nothing saved or changed", () => {
    const set = shippedSet("editor");
    expect(workspaceIds(set)).toEqual([D]);
    expect(set.activeId).toBe(D);
    expect(nameOf(set, D)).toBe("Design");
    expect(baselineOf(set, D)).toBe(set.factory[D]);
    expect(currentOf(set, D)).toBe(set.factory[D]);
    expect(isFactory(set, D)).toBe(true);
    expect(isUser(set, D)).toBe(false);
    expect(hasOverride(set, D)).toBe(false);
    expect(isModified(set, D)).toBe(false);
    expect(validateWorkspace(set.factory[D]!)).toEqual([]);
    expect(set.factory[D]!.origin).toBe("factory");
  });

  it("answers for a workspace that is not there with nothing", () => {
    const set = shippedSet("editor");
    for (const probe of ["ghost", "constructor", "__proto__", "toString"]) {
      expect(baselineOf(set, probe), probe).toBeUndefined();
      expect(currentOf(set, probe), probe).toBeUndefined();
      expect(isFactory(set, probe), probe).toBe(false);
    }
  });
});

describe("changing the arrangement", () => {
  it("keeps it as the session copy and marks the workspace changed, leaving the shipped one and the last good one alone", () => {
    const set = shippedSet("editor");
    const next = withChange(set, D);
    expect(isModified(next, D)).toBe(true);
    expect(next.factory).toBe(set.factory);
    expect(baselineOf(next, D)).toBe(set.factory[D]);
    expect(next.saved).toEqual({});
    expect(next.lastGood).toEqual({});
    expect(currentOf(next, D)).not.toBe(set.factory[D]);
  });

  it("does not count which group is maximised or has focus as a change", () => {
    const set = shippedSet("editor");
    const maximised = ok(maximizeGroup(set.factory[D]!, "viewport-group"));
    expect(isModified(ok(changeSession(set, D, maximised)), D)).toBe(false);
  });

  it("counts a panel's preferences as a change", () => {
    const set = shippedSet("editor");
    const withPrefs: SavedWorkspace = { ...set.factory[D]!, viewState: { "object-manager-1": { columns: ["name"] } } };
    expect(isModified(ok(changeSession(set, D, withPrefs)), D)).toBe(true);
  });

  it("refuses an arrangement that breaks a rule, naming it, and keeps the session copy as it was", () => {
    const set = withChange(shippedSet("editor"), D);
    const frozen = deepFreeze(set);
    const broken = { ...changed(set, D), root: { ...(changed(set, D).root as SplitNode), weights: [0.9, 0.9, 0.9] } };
    const result = refusal(changeSession(frozen, D, broken));
    expect(result.code).toBe("LAYOUT_VALIDATION_FAILED");
    expect(result.refused).toMatch(/^the arrangement was not kept: rule 4:/);
    expect(result.problems?.length).toBeGreaterThan(0);
  });

  it("refuses an arrangement for another workspace, another application, or a workspace that is not there", () => {
    const set = shippedSet("editor");
    expect(refusal(changeSession(set, "ghost", set.factory[D]!)).code).toBe("WORKSPACE_UNKNOWN");
    expect(refusal(changeSession(set, D, { ...set.factory[D]!, workspaceId: "other" })).refused).toBe("the arrangement is for other, not factory.editor.design");
    expect(refusal(changeSession(set, D, { ...set.factory[D]!, app: "playout" })).code).toBe("WORKSPACE_WRONG_APP");
  });
});

describe("switching", () => {
  it("only changes the choice, and the workspace comes back as its session copy", () => {
    const base = ok(saveAs(withChange(shippedSet("editor"), D), D, "Mine")).set;
    const second = ok(saveAs(base, D, "Second"));
    const mine = second.id;
    const set = ok(activate(ok(changeSession(second.set, mine, ok(movePanel(currentOf(second.set, mine)!, "fonts-1", "viewport-group", "center")))), mine));
    expect(set.activeId).toBe(mine);
    expect(ok(activate(set, D)).session).toBe(set.session);
    expect(isModified(ok(activate(set, D)), mine)).toBe(true);
    expect(refusal(activate(set, "ghost")).refused).toBe("there is no workspace called ghost");
  });
});

describe("saving", () => {
  it("makes the author's own copy of a shipped workspace beside it, and leaves the shipped one as it ships", () => {
    const frozenFactory = deepFreeze(shippedSet("editor").factory);
    const set = withChange({ ...shippedSet("editor"), factory: frozenFactory }, D);
    const saved = ok(save(set, D, "2026-11-23T10:00:00Z"));
    expect(saved.factory).toBe(frozenFactory);
    expect(hasOverride(saved, D)).toBe(true);
    expect(isModified(saved, D)).toBe(false);
    expect(isFactory(saved, D)).toBe(true);
    expect(isUser(saved, D)).toBe(false);
    expect(baselineOf(saved, D)!.origin).toBe("user");
    expect(baselineOf(saved, D)!.metadata?.updatedAt).toBe("2026-11-23T10:00:00Z");
    expect(JSON.stringify(baselineOf(saved, D)!.root)).toBe(JSON.stringify(changed(shippedSet("editor"), D).root));
  });

  it("does not keep which group is maximised or has focus", () => {
    const set = shippedSet("editor");
    const maximised = ok(maximizeGroup(changed(set, D), "viewport-group"));
    const saved = ok(save(ok(changeSession(set, D, maximised)), D));
    expect(baselineOf(saved, D)!.maximizedGroupId).toBeUndefined();
    expect(baselineOf(saved, D)!.activeGroupId).toBeUndefined();
  });

  it("refuses a workspace that is not there", () => {
    expect(refusal(save(shippedSet("editor"), "ghost")).code).toBe("WORKSPACE_UNKNOWN");
  });

  it("saving a workspace that was not changed keeps it as it is", () => {
    const saved = ok(save(shippedSet("editor"), D));
    expect(isModified(saved, D)).toBe(false);
    expect(JSON.stringify(baselineOf(saved, D)!.root)).toBe(JSON.stringify(shippedSet("editor").factory[D]!.root));
  });
});

describe("resetting", () => {
  it("goes back to the saved copy, which for a shipped workspace is the author's own if they saved one", () => {
    const set = shippedSet("editor");
    const savedOnce = ok(save(withChange(set, D), D));
    const savedRoot = JSON.stringify(baselineOf(savedOnce, D)!.root);
    // Change it again, in another way, then reset: back to what was saved, not to what ships.
    const again: SavedWorkspace = ok(movePanel(currentOf(savedOnce, D)!, "fonts-1", "viewport-group", "center"));
    const edited = ok(changeSession(savedOnce, D, again));
    expect(isModified(edited, D)).toBe(true);
    const reset = ok(resetToSaved(edited, D));
    expect(JSON.stringify(currentOf(reset, D)!.root)).toBe(savedRoot);
    expect(isModified(reset, D)).toBe(false);
    expect(reset.session[D]).toBeUndefined();
    expect(hasOverride(reset, D)).toBe(true);
  });

  it("goes back to what ships, and removes the author's own copy", () => {
    const edited = ok(save(withChange(shippedSet("editor"), D), D));
    const factory = ok(resetToFactory(edited, D));
    expect(hasOverride(factory, D)).toBe(false);
    expect(currentOf(factory, D)).toBe(factory.factory[D]);
    expect(factory.session).toEqual({});
    expect(isModified(factory, D)).toBe(false);
  });

  it("has no shipped arrangement for a workspace the author made, and says what to do", () => {
    const made = ok(saveAs(shippedSet("editor"), D, "Mine"));
    const result = refusal(resetToFactory(made.set, made.id));
    expect(result.code).toBe("WORKSPACE_NOT_FACTORY");
    expect(result.refused).toBe("Mine is your own workspace, so there is no shipped arrangement to go back to. Use Reset to saved.");
    expect(refusal(resetToFactory(made.set, "ghost")).code).toBe("WORKSPACE_UNKNOWN");
    expect(refusal(resetToSaved(made.set, "ghost")).code).toBe("WORKSPACE_UNKNOWN");
  });
});

describe("names and ids", () => {
  it("trims a name and joins its spaces, and refuses one that is empty, too long or holds a control character", () => {
    expect(checkName("  My   layout ")).toBe("My layout");
    expect(refusal(checkName("   ")).code).toBe("WORKSPACE_NAME_INVALID");
    expect(refusal(checkName("x".repeat(61)).valueOf()).refused).toBe("a workspace name is at most 60 characters");
    expect(checkName("x".repeat(60))).toBe("x".repeat(60));
    expect(refusal(checkName("a\u0000b")).refused).toBe("a workspace name cannot hold a control character");
    expect(refusal(checkName("a\u007fb")).code).toBe("WORKSPACE_NAME_INVALID");
  });

  it("makes an id that is always a safe file name, whatever the name holds", () => {
    const set = shippedSet("editor");
    const safe = /^[a-z0-9][a-z0-9._-]{0,63}$/;
    const cases: [string, string][] = [["My layout", "user.my-layout"], ["BGMI Finals — Day 2", "user.bgmi-finals-day-2"], ["日本語", "user.workspace"], ["../../etc", "user.etc"], ["CON", "user.con"], ["  ", "user.workspace"]];
    for (const [name, id] of cases) {
      expect(newIdFor(set, name), name).toBe(id);
      expect(newIdFor(set, name)).toMatch(safe);
    }
    expect(newIdFor(set, "x".repeat(60))).toBe(`user.${"x".repeat(40)}`);
    expect(newIdFor(set, "Ünïcode")).toMatch(safe);
  });

  it("numbers an id that is taken, whether the id is a workspace, a session or last-good copy, or one left alone", () => {
    const base = ok(saveAs(shippedSet("editor"), D, "Mine")).set;
    expect(newIdFor(base, "Mine")).toBe("user.mine-2");
    expect(newIdFor({ ...base, saved: {}, session: {}, order: [], lastGood: { "user.mine": base.saved["user.mine"]! } }, "Mine")).toBe("user.mine-2");
    expect(newIdFor({ ...base, saved: {}, session: {}, order: [], leftAlone: ["user.mine"] }, "Mine")).toBe("user.mine-2");
  });

  it("finds a free display name for a copy", () => {
    const set = ok(saveAs(shippedSet("editor"), D, "Mine")).set;
    expect(freeName(set, "Fresh")).toBe("Fresh");
    expect(freeName(set, "mine")).toBe("mine (2)");
    expect(freeName(ok(saveAs(set, D, "mine (2)")).set, "Mine")).toBe("Mine (3)");
    expect(freeName(set, "design")).toBe("design (2)");
    expect(freeName(set, "  ")).toBe("Workspace");
    expect(freeName(set, "x".repeat(60)).length).toBeLessThanOrEqual(60);
    // However many copies there are, the name stays within the limit.
    let many = set;
    for (let n = 0; n < 12; n += 1) many = ok(saveAs(many, D, freeName(many, "y".repeat(60)))).set;
    expect(freeName(many, "y".repeat(60)).length).toBeLessThanOrEqual(60);
    expect(freeName(many, "y".repeat(60))).toMatch(/ \(13\)$/);
  });
});

describe("saving as a new workspace, and duplicating", () => {
  it("makes the author's own workspace from what they see, and leaves the one it came from as it was", () => {
    const edited = withChange(shippedSet("editor"), D);
    const made = ok(saveAs(edited, D, "  BGMI   Design ", "2026-11-23T11:00:00Z"));
    const set = made.set;
    expect(made.id).toBe("user.bgmi-design");
    expect(nameOf(set, made.id)).toBe("BGMI Design");
    expect(baselineOf(set, made.id)!.workspaceId).toBe(made.id);
    expect(baselineOf(set, made.id)!.origin).toBe("user");
    expect(baselineOf(set, made.id)!.metadata?.updatedAt).toBe("2026-11-23T11:00:00Z");
    expect(isUser(set, made.id)).toBe(true);
    expect(isModified(set, made.id)).toBe(false);
    expect(JSON.stringify(currentOf(set, made.id)!.root)).toBe(JSON.stringify(currentOf(edited, D)!.root));
    // The one it came from still has its changes, and is still the one in use.
    expect(isModified(set, D)).toBe(true);
    expect(set.activeId).toBe(D);
    expect(workspaceIds(set)).toEqual([D, made.id]);
    expect(validateWorkspace(baselineOf(set, made.id)!)).toEqual([]);
  });

  it("refuses a name that is invalid, or taken by any workspace including a shipped one, in any case", () => {
    const set = ok(saveAs(shippedSet("editor"), D, "Mine")).set;
    expect(refusal(saveAs(set, D, "  ")).code).toBe("WORKSPACE_NAME_INVALID");
    expect(refusal(saveAs(set, D, "mine")).refused).toBe("a workspace is already called mine");
    expect(refusal(saveAs(set, D, "DESIGN")).code).toBe("WORKSPACE_NAME_TAKEN");
    expect(refusal(saveAs(set, "ghost", "New")).code).toBe("WORKSPACE_UNKNOWN");
  });

  it("makes a copy without switching to it", () => {
    const set = shippedSet("editor");
    const copy = ok(duplicate(set, D, "Copy of design"));
    expect(copy.set.activeId).toBe(D);
    expect(workspaceIds(copy.set)).toEqual([D, copy.id]);
    expect(refusal(duplicate(copy.set, D, "copy of design")).code).toBe("WORKSPACE_NAME_TAKEN");
  });
});

describe("renaming and deleting", () => {
  const made = (): { set: WorkspaceSet; id: string } => {
    const first = ok(saveAs(withChange(shippedSet("editor"), D), D, "Mine"));
    return { id: first.id, set: ok(markGood(first.set, first.id)) };
  };

  it("renames a workspace the author made everywhere it is kept, and keeps its id", () => {
    const { set, id } = made();
    const next = ok(rename(set, id, "Renamed"));
    expect(nameOf(next, id)).toBe("Renamed");
    expect(next.saved[id]!.name).toBe("Renamed");
    expect(next.session[id]!.name).toBe("Renamed");
    expect(next.lastGood[id]!.name).toBe("Renamed");
    expect(workspaceIds(next)).toEqual(workspaceIds(set));
    // Its own name again is not a clash.
    expect(nameOf(ok(rename(next, id, "renamed")), id)).toBe("renamed");
  });

  it("does not rename a shipped workspace, or to a name that is taken, or to nothing", () => {
    const { set, id } = made();
    expect(refusal(rename(set, D, "Other")).code).toBe("WORKSPACE_FACTORY_IMMUTABLE");
    expect(refusal(rename(set, D, "Other")).refused).toBe("Design ships with GrapiX and keeps its name. Save a copy under another name instead.");
    expect(refusal(rename(set, id, "design")).code).toBe("WORKSPACE_NAME_TAKEN");
    expect(refusal(rename(set, id, " ")).code).toBe("WORKSPACE_NAME_INVALID");
    expect(refusal(rename(set, "ghost", "x")).code).toBe("WORKSPACE_UNKNOWN");
  });

  it("deletes a workspace the author made, every copy of it, and its place in the order", () => {
    const { set, id } = made();
    const gone = ok(remove(set, id));
    expect(workspaceIds(gone)).toEqual([D]);
    expect(gone.saved[id]).toBeUndefined();
    expect(gone.session[id]).toBeUndefined();
    expect(gone.lastGood[id]).toBeUndefined();
    expect(gone.order).not.toContain(id);
  });

  it("does not delete a shipped workspace, the one in use, or one that is not there, and says what to do", () => {
    const { set, id } = made();
    expect(refusal(remove(set, D)).refused).toBe("Design ships with GrapiX and cannot be deleted. Reset to shipped puts it back as it was.");
    const inUse = ok(activate(set, id));
    expect(refusal(remove(inUse, id)).refused).toBe("Mine is the workspace in use. Switch to another workspace first, then delete it.");
    expect(refusal(remove(inUse, id)).code).toBe("WORKSPACE_IN_USE");
    expect(refusal(remove(set, "ghost")).code).toBe("WORKSPACE_UNKNOWN");
  });
});

describe("ordering", () => {
  const three = (): { set: WorkspaceSet; a: string; b: string } => {
    const a = ok(saveAs(shippedSet("editor"), D, "Alpha"));
    const b = ok(saveAs(a.set, D, "Beta"));
    return { set: b.set, a: a.id, b: b.id };
  };

  it("lists the shipped one first, then the author's in the order they were made, until the author orders them", () => {
    const { set, a, b } = three();
    expect(workspaceIds(set)).toEqual([D, a, b]);
    const next = ok(reorder(set, [b, D, a]));
    expect(workspaceIds(next)).toEqual([b, D, a]);
  });

  it("lists a workspace the order does not name after the ones it does, shipped first, and ignores a name that is gone", () => {
    const { set, a, b } = three();
    expect(workspaceIds({ ...set, order: [b, "ghost", b] })).toEqual([b, D, a]);
    expect(workspaceIds({ ...set, order: [] })).toEqual([D, a, b]);
  });

  it("takes a new order only if it names every workspace once and no other", () => {
    const { set, a, b } = three();
    for (const bad of [[D, a], [D, a, b, "ghost"], [D, a, a], [D, a, "ghost"], []]) {
      expect(refusal(reorder(set, bad)).code).toBe("WORKSPACE_ORDER_INVALID");
    }
  });
});

describe("last good", () => {
  it("records what the workspace is now, and refuses one that breaks a rule", () => {
    const set = withChange(shippedSet("editor"), D);
    const good = ok(markGood(set, D));
    expect(good.lastGood[D]).toBe(currentOf(set, D));
    const broken: WorkspaceSet = { ...set, session: { [D]: { ...currentOf(set, D)!, root: { ...(currentOf(set, D)!.root as SplitNode), weights: [0.9, 0.9, 0.9] } } } };
    expect(refusal(markGood(broken, D)).refused).toBe("factory.editor.design does not pass the layout rules, so it is not recorded as good");
    expect(refusal(markGood(set, "ghost")).code).toBe("WORKSPACE_UNKNOWN");
  });
});

describe("reading what was stored", () => {
  const factory = shippedSet("editor").factory;
  const input = (over: Partial<Parameters<typeof restoreSet>[0]> = {}): Parameters<typeof restoreSet>[0] => ({
    app: "editor", factory, saved: {}, session: {}, lastGood: {}, order: [], activeId: undefined, ...over,
  });
  const userWs = (id: string, name: string, mutate?: (ws: SavedWorkspace) => SavedWorkspace): SavedWorkspace => {
    const made = ok(saveAs(shippedSet("editor"), D, name));
    const ws = made.set.saved[made.id]!;
    expect(made.id).toBe(id);
    return mutate === undefined ? ws : mutate(ws);
  };
  const edited = (ws: SavedWorkspace): SavedWorkspace => ok(movePanel(ws, "fonts-1", "viewport-group", "center"));

  it("is just what ships when nothing is stored, with Design in use", () => {
    const { set, warnings } = restoreSet(input());
    expect(workspaceIds(set)).toEqual([D]);
    expect(set.activeId).toBe(D);
    expect(warnings).toEqual([]);
  });

  it("loads the author's workspaces, their session copies and the order, and the one in use", () => {
    const mine = userWs("user.mine", "Mine");
    const { set, warnings } = restoreSet(input({
      saved: { "user.mine": found(mine) },
      session: { "user.mine": found(edited(mine)) },
      order: ["user.mine", D],
      activeId: "user.mine",
    }));
    expect(warnings).toEqual([]);
    expect(workspaceIds(set)).toEqual(["user.mine", D]);
    expect(set.activeId).toBe("user.mine");
    expect(isModified(set, "user.mine")).toBe(true);
  });

  it("uses the copy kept from the save before when the session copy was set aside, and says where the file went", () => {
    const mine = userWs("user.mine", "Mine");
    const { set, warnings } = restoreSet(input({
      saved: { "user.mine": found(mine) },
      session: { "user.mine": { read: "setAside", aside: "C:\\data\\session\\user.mine.json.corrupt-5", backup: JSON.parse(JSON.stringify(edited(mine))) } },
    }));
    expect(isModified(set, "user.mine")).toBe(true);
    expect(warnings).toEqual([{
      id: "user.mine",
      kind: "session-set-aside",
      detail: "The arrangement last left for user.mine could not be read (the file could not be read); the one kept before it is in use. The file was kept as C:\\data\\session\\user.mine.json.corrupt-5.",
    }]);
  });

  it("falls back from a session copy that is set aside to the last good one, then to the saved one", () => {
    const mine = userWs("user.mine", "Mine");
    const setAside: StoredRead = { read: "setAside", aside: "x.corrupt-1" };
    const withGood = restoreSet(input({ saved: { "user.mine": found(mine) }, session: { "user.mine": setAside }, lastGood: { "user.mine": found(edited(mine)) } }));
    expect(isModified(withGood.set, "user.mine")).toBe(true);
    expect(withGood.warnings[0]!.detail).toContain("the last good one is in use");
    const without = restoreSet(input({ saved: { "user.mine": found(mine) }, session: { "user.mine": setAside } }));
    expect(isModified(without.set, "user.mine")).toBe(false);
    expect(without.warnings[0]!.detail).toContain("the saved one is in use");
  });

  it("does not use a backup or a last good copy that itself breaks a rule", () => {
    const mine = userWs("user.mine", "Mine");
    const broken = { ...mine, root: { ...(mine.root as SplitNode), weights: [0.9, 0.9, 0.9] } };
    const out = restoreSet(input({
      saved: { "user.mine": found(mine) },
      session: { "user.mine": { read: "setAside", aside: "x.corrupt-1", backup: broken } },
      lastGood: { "user.mine": found(broken) },
    }));
    expect(isModified(out.set, "user.mine")).toBe(false);
    expect(out.set.lastGood["user.mine"]).toBeUndefined();
  });

  it("does not use a session copy that breaks a rule, says so accurately, and leaves the file as it is", () => {
    const mine = userWs("user.mine", "Mine");
    const broken = { ...edited(mine), root: { ...(edited(mine).root as SplitNode), weights: [0.9, 0.9, 0.9] } };
    const { set, warnings, repairs } = restoreSet(input({ saved: { "user.mine": found(mine) }, session: { "user.mine": found(broken) } }));
    expect(isModified(set, "user.mine")).toBe(false);
    expect(warnings.map((w) => w.kind)).toEqual(["session-invalid"]);
    expect(warnings[0]!.detail).toMatch(/^The arrangement last left for user\.mine cannot be used \(the layout breaks rule 4: .*\), so the saved one is used\. The file is left as it is\.$/);
    expect(repairs).toEqual([]);
  });

  it("never gives the id of a saved file it could not use to a new workspace", () => {
    const mine = userWs("user.mine", "Mine");
    const broken = { ...mine, root: { ...(mine.root as SplitNode), weights: [0.9, 0.9, 0.9] } };
    const { set, warnings } = restoreSet(input({ saved: { "user.mine": found(broken) } }));
    expect(warnings.map((w) => w.kind)).toEqual(["dropped"]);
    expect(set.unloaded).toEqual(["user.mine"]);
    expect(newIdFor(set, "Mine")).toBe("user.mine-2");
  });

  it("names the copies in use from a fallback, so they are written back", () => {
    const mine = userWs("user.mine", "Mine");
    const aside: StoredRead = { read: "setAside", aside: "x.corrupt-1" };
    const out = restoreSet(input({ saved: { "user.mine": aside }, session: { "user.mine": aside }, lastGood: { "user.mine": found(mine) } }));
    expect(out.repairs).toEqual([{ kind: "saved", id: "user.mine" }, { kind: "session", id: "user.mine" }]);
    expect(restoreSet(input({ saved: { "user.mine": found(mine) } })).repairs).toEqual([]);
  });

  it("uses the copy from the save before for a saved copy that was set aside, then the last good one, else leaves the workspace out", () => {
    const mine = userWs("user.mine", "Mine");
    const aside: StoredRead = { read: "setAside", aside: "u.corrupt-9" };
    const viaBackup = restoreSet(input({ saved: { "user.mine": { ...aside, backup: JSON.parse(JSON.stringify(mine)) } as StoredRead } }));
    expect(nameOf(viaBackup.set, "user.mine")).toBe("Mine");
    expect(viaBackup.warnings[0]!.detail).toContain("the copy kept from the save before it is in use");
    const viaGood = restoreSet(input({ saved: { "user.mine": aside }, lastGood: { "user.mine": found(mine) } }));
    expect(nameOf(viaGood.set, "user.mine")).toBe("Mine");
    expect(viaGood.warnings[0]!.detail).toContain("the last good copy is in use");
    const dropped = restoreSet(input({ saved: { "user.mine": aside } }));
    expect(workspaceIds(dropped.set)).toEqual([D]);
    expect(dropped.warnings).toEqual([{ id: "user.mine", kind: "dropped", detail: "user.mine could not be used (the file could not be read) and has no good copy, so it was left out. The file was kept as u.corrupt-9." }]);
  });

  it("uses the shipped workspace when the author's copy of it cannot be read", () => {
    const { set, warnings } = restoreSet(input({ saved: { [D]: { read: "setAside", aside: "d.corrupt-2" } } }));
    expect(currentOf(set, D)).toBe(factory[D]);
    expect(warnings[0]).toMatchObject({ id: D, kind: "saved-invalid" });
    expect(warnings[0]!.detail).toContain("the shipped one is in use");
  });

  it("leaves a copy from a newer GrapiX alone: not loaded, never written, and its id is not handed out again", () => {
    const { set, warnings } = restoreSet(input({ saved: { "user.future": { read: "newer", found: 2, supported: 1 } }, session: { "user.future": { read: "newer", found: 2, supported: 1 } } }));
    expect(workspaceIds(set)).toEqual([D]);
    expect(set.leftAlone).toEqual(["user.future"]);
    expect(warnings.every((w) => w.kind === "newer-left-alone")).toBe(true);
    expect(warnings[0]!.detail).toBe("user.future it was saved by a newer GrapiX (layout version 2; this one reads up to 1), so it was left alone and not loaded.");
    expect(newIdFor(set, "future")).toBe("user.future-2");
  });

  it("refuses a copy that is for another application or another id, and one from a newer layout version inside a readable file", () => {
    const mine = userWs("user.mine", "Mine");
    const other = restoreSet(input({ saved: { "user.mine": found({ ...mine, app: "playout" }) } }));
    expect(workspaceIds(other.set)).toEqual([D]);
    expect(other.warnings[0]!.detail).toContain("it is a playout workspace, not an editor one");
    const wrongId = restoreSet(input({ saved: { "user.mine": found({ ...mine, workspaceId: "user.other" }) } }));
    expect(wrongId.warnings[0]!.detail).toContain("it is for user.other, not user.mine");
    const newerInside = restoreSet(input({ saved: { "user.mine": found({ ...mine, schemaVersion: 7 }) } }));
    expect(newerInside.warnings[0]!.detail).toContain("newer GrapiX");
  });

  it("brings a layout up to date for renamed panels, and says so", () => {
    const mine = userWs("user.mine", "Mine");
    const { set, warnings } = restoreSet({ ...input({ saved: { "user.mine": found(mine) } }), aliases: { fonts: "typefaces" } });
    expect(set.saved["user.mine"]!.instances["fonts-1"]!.panelType).toBe("typefaces");
    expect(warnings).toEqual([{ id: "user.mine", kind: "migrated", detail: "Mine was brought up to date for this version." }]);
  });

  it("ignores a session copy of a workspace that has no saved copy and does not ship, and never lists it", () => {
    const orphan = userWs("user.mine", "Mine");
    const { set } = restoreSet(input({ session: { "user.mine": found(orphan) } }));
    expect(workspaceIds(set)).toEqual([D]);
    expect(set.session["user.mine"]).toBeUndefined();
  });

  it("puts the first shipped workspace in use when the one chosen is gone, and says so", () => {
    const { set, warnings } = restoreSet(input({ activeId: "user.gone" }));
    expect(set.activeId).toBe(D);
    expect(warnings).toEqual([{ id: "user.gone", kind: "active-reset", detail: "The workspace in use (user.gone) is not there any more, so factory.editor.design is in use." }]);
    expect(restoreSet(input({ activeId: D })).warnings).toEqual([]);
  });
});

describe("exporting and importing", () => {
  const stored = (): WorkspaceSet => {
    const made = ok(saveAs(shippedSet("editor"), D, "Mine"));
    const ws: SavedWorkspace = {
      ...made.set.saved[made.id]!,
      viewState: { "assets-1": { folder: "C:\\Users\\CG\\Pictures", filters: ["a", "D:/shows/x"], keep: "yes", nested: { path: "\\\\server\\share", fine: 1 } } },
      floats: [],
    };
    return { ...made.set, saved: { ...made.set.saved, [made.id]: ws }, session: { ...made.set.session, [made.id]: ws } };
  };

  it("exports what the author sees as a layout of their own, without what only means something on this computer", () => {
    const set = stored();
    const out = ok(exportWorkspace(set, "user.mine"));
    const file = JSON.parse(out.text) as SavedWorkspace;
    expect(file.origin).toBe("user");
    expect(file.name).toBe("Mine");
    expect(file.maximizedGroupId).toBeUndefined();
    expect(file.metadata).toBeUndefined();
    expect(file.viewState).toEqual({ "assets-1": { filters: ["a"], keep: "yes", nested: { fine: 1 } } });
    expect(out.removed).toEqual(["viewState.assets-1.folder", "viewState.assets-1.filters[1]", "viewState.assets-1.nested.path"]);
    expect(refusal(exportWorkspace(set, "ghost")).code).toBe("WORKSPACE_UNKNOWN");
  });

  it("exports the arrangement as it is now (the session copy), and a shipped workspace as the author's own", () => {
    const set = withChange(shippedSet("editor"), D);
    const file = JSON.parse(ok(exportWorkspace(set, D)).text) as SavedWorkspace;
    expect(file.origin).toBe("user");
    expect(JSON.stringify(file.root)).toBe(JSON.stringify(currentOf(set, D)!.root));
    expect(set.factory[D]!.origin).toBe("factory");
  });

  it("drops the display a floating group was on, and keeps its place", () => {
    const set = shippedSet("editor");
    const floating: SavedWorkspace = {
      ...set.factory[D]!,
      floats: [{ id: "float-1", displayIdHint: "DISPLAY2", bounds: { x: 1, y: 2, width: 300, height: 200 }, root: { kind: "tabs", id: "float-tabs", panelInstanceIds: ["fonts-1"], activePanelInstanceId: "fonts-1" } }],
      root: JSON.parse(JSON.stringify(set.factory[D]!.root).replace(/"fonts-1",?/g, "").replace(/,\]/g, "]")) as SavedWorkspace["root"],
    };
    const withFloat = ok(changeSession(set, D, floating));
    const file = JSON.parse(ok(exportWorkspace(withFloat, D)).text) as SavedWorkspace;
    expect(file.floats).toEqual([{ id: "float-1", bounds: { x: 1, y: 2, width: 300, height: 200 }, root: floating.floats[0]!.root }]);
  });

  it("imports a file as a new workspace of the author's own, not switched to, and reports what it found", () => {
    const set = stored();
    const text = ok(exportWorkspace(set, "user.mine")).text;
    const done = ok(importWorkspace(set, text, { now: "2026-11-23T12:00:00Z", isAvailable: (kind) => kind !== "fonts" }));
    expect(done.id).toBe("user.mine-2");
    expect(done.report).toEqual({
      name: "Mine (2)",
      renamedFrom: "Mine",
      unavailable: [{ instanceId: "fonts-1", panelType: "fonts" }],
      renamed: [],
      floats: 0,
    });
    expect(done.set.activeId).toBe(set.activeId);
    expect(nameOf(done.set, done.id)).toBe("Mine (2)");
    expect(baselineOf(done.set, done.id)!.workspaceId).toBe(done.id);
    expect(isModified(done.set, done.id)).toBe(false);
    expect(workspaceIds(done.set)).toEqual([D, "user.mine", "user.mine-2"]);
    expect(validateWorkspace(baselineOf(done.set, done.id)!)).toEqual([]);
    // A second import of the same file gets its own place again.
    expect(ok(importWorkspace(done.set, text)).id).toBe("user.mine-3");
  });

  it("keeps a name that is free, and brings renamed panel kinds up to date", () => {
    const text = serializeWorkspace({ ...shippedSet("editor").factory[D]!, name: "Brand new", origin: "factory" });
    const done = ok(importWorkspace(shippedSet("editor"), text, { aliases: { fonts: "typefaces" } }));
    expect(done.report.name).toBe("Brand new");
    expect(done.report.renamedFrom).toBeUndefined();
    expect(done.report.renamed).toEqual(["fonts -> typefaces"]);
    expect(baselineOf(done.set, done.id)!.origin).toBe("user");
    expect(baselineOf(done.set, done.id)!.instances["fonts-1"]!.panelType).toBe("typefaces");
  });

  it("refuses a file that is not a layout, is for the other application, is from a newer GrapiX or breaks a rule, and adds nothing", () => {
    const set = deepFreeze(shippedSet("editor"));
    expect(refusal(importWorkspace(set, "{ nope")).refused).toBe("this file is not a GrapiX layout: its contents could not be read. Choose a layout that GrapiX exported. Nothing was changed.");
    expect(refusal(importWorkspace(set, "[1]")).code).toBe("LAYOUT_VALIDATION_FAILED");
    const playout = serializeWorkspace({ ...set.factory[D]!, app: "playout" });
    expect(refusal(importWorkspace(set, playout)).code).toBe("WORKSPACE_WRONG_APP");
    expect(refusal(importWorkspace(set, JSON.stringify({ ...set.factory[D]!, schemaVersion: 5 }))).code).toBe("LAYOUT_SCHEMA_NEWER");
    const broken = JSON.parse(serializeWorkspace(set.factory[D]!)) as { root: { weights: number[] } };
    broken.root.weights = [0.9, 0.9, 0.9];
    expect(refusal(importWorkspace(set, JSON.stringify(broken))).code).toBe("LAYOUT_VALIDATION_FAILED");
  });

  it("gives a workspace with a name that is not usable a usable one", () => {
    const text = JSON.stringify({ ...shippedSet("editor").factory[D]!, name: "x".repeat(200) });
    const done = ok(importWorkspace(shippedSet("editor"), text));
    expect(done.report.name).toBe("Imported workspace");
    expect(done.report.renamedFrom).toBe("x".repeat(200));
  });
});
