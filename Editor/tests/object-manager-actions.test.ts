// The object manager's row actions (11.8) as edits, not just buttons.
//
// The treegrid rendered Hide/Show, Lock/Unlock and Expand/Collapse as enabled
// controls with no handler behind them — a control that appears to work and
// does nothing, which invariant 18 forbids. These tests pin the decisions the
// Editor now commits: visibility and lock are one undoable document edit each,
// a refusal names its cause and leaves the document identical, and
// expand/collapse is view state that never touches the document.

import { describe, expect, it } from "vitest";

import type { SceneDocument, SceneObject } from "@grapix/contracts";
import { findNode } from "../src/agent-surface";
import {
  objectManagerPanel,
  setObjectExpanded,
  toggleObjectLock,
  toggleObjectVisibility,
} from "../src/object-manager";
import { commit, emptyWorkspace, openSession, undo, redo } from "../src/workspace";

function base(id: string, name: string): Record<string, unknown> {
  return {
    id,
    name,
    visible: true,
    locked: false,
    opacity: 1,
    x: 0,
    y: 0,
    zDepth: 0,
    zIndex: 0,
    layerId: "",
    width: 100,
    height: 50,
    rotation: 0,
    rotationX: 0,
    rotationY: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    strokeWidth: 0,
    cornerRadius: 0,
  };
}

function rect(id: string, name: string, overrides: Partial<SceneObject> = {}): SceneObject {
  return { type: "rect", ...base(id, name), ...overrides } as SceneObject;
}

function group(
  id: string,
  name: string,
  childIds: string[],
  overrides: Partial<SceneObject> = {},
): SceneObject {
  return { type: "group", ...base(id, name), childIds, ...overrides } as SceneObject;
}

function scene(objects: SceneObject[]): SceneDocument {
  return {
    id: "lower-third",
    name: "Lower third",
    version: 1,
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    timeline: { durationFrames: 1 },
    dataContext: {},
    assets: [],
    fonts: [],
    materials: [],
    objects,
  } as unknown as SceneDocument;
}

function objectIn(document: SceneDocument, id: string): SceneObject {
  const object = document.objects.find((candidate) => candidate.id === id);
  if (!object) throw new Error(`fixture has no ${id}`);
  return object;
}

/// Whether the rendered row offers an action, and why not if it does not.
function offered(document: SceneDocument, rowId: string, action: string): string | undefined {
  const row = findNode(objectManagerPanel(document, { selectedIds: [], collapsedIds: [] }), rowId);
  return row!.actions!.find((candidate) => candidate.name === action)!.unavailable;
}

describe("visibility is a real edit", () => {
  it("hides, then shows, the one object and nothing else", () => {
    const document = scene([rect("a", "A"), rect("b", "B")]);

    const hidden = toggleObjectVisibility(document, "a");
    expect(hidden).toMatchObject({ ok: true, label: "Hid A" });
    if (!hidden.ok) throw new Error("unreachable");
    expect(objectIn(hidden.document, "a").visible).toBe(false);
    expect(objectIn(hidden.document, "b")).toBe(objectIn(document, "b"));
    // The source document is untouched: history holds it as the undo target.
    expect(objectIn(document, "a").visible).toBe(true);

    const shown = toggleObjectVisibility(hidden.document, "a");
    expect(shown).toMatchObject({ ok: true, label: "Showed A" });
    if (!shown.ok) throw new Error("unreachable");
    expect(objectIn(shown.document, "a").visible).toBe(true);
  });

  it("the row's cell reports the new value once committed", () => {
    const document = scene([rect("a", "A")]);
    const hidden = toggleObjectVisibility(document, "a");
    if (!hidden.ok) throw new Error(hidden.reason);
    const panel = objectManagerPanel(hidden.document, { selectedIds: [], collapsedIds: [] });
    expect(findNode(panel, "a/visible")!.value).toBe("hidden");
    expect(findNode(panel, "a")!.actions!.find((a) => a.name === "toggleVisibility")!.label).toBe(
      "Show",
    );
  });

  it("one toggle is one undo entry, and undo restores the document exactly", () => {
    const original = scene([group("g", "Group", ["a"]), rect("a", "A")]);
    const workspace = emptyWorkspace();
    const session = openSession(workspace, original);

    const hidden = toggleObjectVisibility(session.document, "g");
    if (!hidden.ok) throw new Error(hidden.reason);
    commit(session, hidden.document);
    expect(session.undoStack).toHaveLength(1);
    expect(objectIn(session.document, "g").visible).toBe(false);

    expect(undo(session)).toBe(original);
    expect(session.document).toEqual(original);
    expect(objectIn(session.document, "g").visible).toBe(true);

    redo(session);
    expect(objectIn(session.document, "g").visible).toBe(false);
  });
});

describe("lock is a real edit", () => {
  it("locks and unlocks, and undo reverts the lock", () => {
    const original = scene([rect("a", "A")]);
    const session = openSession(emptyWorkspace(), original);

    const locked = toggleObjectLock(session.document, "a");
    expect(locked).toMatchObject({ ok: true, label: "Locked A" });
    if (!locked.ok) throw new Error(locked.reason);
    commit(session, locked.document);
    expect(objectIn(session.document, "a").locked).toBe(true);

    const unlocked = toggleObjectLock(session.document, "a");
    expect(unlocked).toMatchObject({ ok: true, label: "Unlocked A" });

    undo(session);
    expect(session.document).toEqual(original);
    expect(objectIn(session.document, "a").locked).toBe(false);
  });

  it("an own lock can be released even though it blocks visibility", () => {
    const document = scene([rect("a", "A", { locked: true })]);
    expect(offered(document, "a", "toggleLock")).toBeUndefined();
    expect(toggleObjectLock(document, "a").ok).toBe(true);
  });
});

describe("a refused toggle changes nothing and says why", () => {
  it("visibility under a hidden parent is refused and names the parent", () => {
    const document = scene([
      group("bug", "Bug", ["logo"], { visible: false }),
      rect("logo", "Logo"),
    ]);
    const before = structuredClone(document);

    const outcome = toggleObjectVisibility(document, "logo");
    expect(outcome).toEqual({
      ok: false,
      reason: "cannot change visibility of Logo: hidden by parent 'Bug'",
    });
    expect(outcome).not.toHaveProperty("document");
    expect(document).toEqual(before);
  });

  it("a refused toggle leaves the session's document and history identical", () => {
    const original = scene([
      group("bug", "Bug", ["logo"], { visible: false }),
      rect("logo", "Logo"),
    ]);
    const session = openSession(emptyWorkspace(), original);

    const outcome = toggleObjectVisibility(session.document, "logo");
    // What main.ts does: a refusal is logged and nothing is committed.
    if (outcome.ok) commit(session, outcome.document);
    expect(outcome.ok).toBe(false);
    expect(session.document).toBe(original);
    expect(session.undoStack).toHaveLength(0);
    expect(session.dirty).toBe(false);
  });

  it("the parent's own toggle still works — that is where the fix is", () => {
    const document = scene([
      group("bug", "Bug", ["logo"], { visible: false }),
      rect("logo", "Logo"),
    ]);
    expect(toggleObjectVisibility(document, "bug")).toMatchObject({ ok: true, label: "Showed Bug" });
  });

  it("an object's own lock refuses its visibility toggle by name", () => {
    const document = scene([rect("r", "Rect", { locked: true })]);
    expect(toggleObjectVisibility(document, "r")).toEqual({
      ok: false,
      reason: "cannot change visibility of Rect: Rect is locked",
    });
  });

  it("an inherited lock refuses both toggles on the child, naming the parent", () => {
    const document = scene([
      group("lg", "Locked group", ["child"], { locked: true }),
      rect("child", "Child"),
    ]);
    const before = structuredClone(document);
    expect(toggleObjectLock(document, "child")).toEqual({
      ok: false,
      reason: "cannot change the lock on Child: locked by parent 'Locked group'",
    });
    expect(toggleObjectVisibility(document, "child")).toEqual({
      ok: false,
      reason: "cannot change visibility of Child: locked by parent 'Locked group'",
    });
    expect(document).toEqual(before);
  });

  it("an unknown object is refused by id", () => {
    const document = scene([rect("a", "A")]);
    expect(toggleObjectVisibility(document, "ghost")).toEqual({
      ok: false,
      reason: "no object ghost in this scene",
    });
    expect(toggleObjectLock(document, "ghost").ok).toBe(false);
  });

  it("the edit refuses exactly where the rendered button is disabled", () => {
    // One decision serves both: a button that is offered is an edit that
    // applies, and a disabled one is an edit that refuses with the same cause.
    const document = scene([
      group("hidden", "Hidden", ["h1"], { visible: false }),
      rect("h1", "H1"),
      group("locked", "Locked", ["l1"], { locked: true }),
      rect("l1", "L1"),
      rect("own", "Own", { locked: true }),
      rect("free", "Free"),
    ]);
    for (const id of ["hidden", "h1", "locked", "l1", "own", "free"]) {
      const visibility = offered(document, id, "toggleVisibility");
      const vOutcome = toggleObjectVisibility(document, id);
      expect(vOutcome.ok).toBe(visibility === undefined);
      if (!vOutcome.ok) expect(vOutcome.reason).toContain(visibility!);

      const lock = offered(document, id, "toggleLock");
      const lOutcome = toggleObjectLock(document, id);
      expect(lOutcome.ok).toBe(lock === undefined);
      if (!lOutcome.ok) expect(lOutcome.reason).toContain(lock!);
    }
  });
});

describe("expand and collapse are view state", () => {
  it("collapse then expand round-trips the collapsed ids, never the document", () => {
    const document = scene([group("g", "Group", ["a"]), rect("a", "A")]);
    const before = structuredClone(document);

    const shut = setObjectExpanded(document, [], "g", false);
    expect(shut).toEqual({ ok: true, collapsedIds: ["g"], label: "Collapsed Group" });
    if (!shut.ok) throw new Error(shut.reason);
    const panel = objectManagerPanel(document, { selectedIds: [], collapsedIds: shut.collapsedIds });
    expect(findNode(panel, "a")).toBeUndefined();
    expect(findNode(panel, "g")!.actions!.some((a) => a.name === "expand")).toBe(true);

    const open = setObjectExpanded(document, shut.collapsedIds, "g", true);
    expect(open).toEqual({ ok: true, collapsedIds: [], label: "Expanded Group" });
    expect(document).toEqual(before);
    expect(open).not.toHaveProperty("document");
  });

  it("a leaf refuses to expand, by name", () => {
    const document = scene([rect("a", "A")]);
    expect(setObjectExpanded(document, [], "a", true)).toEqual({
      ok: false,
      reason: "A has no children",
    });
  });

  it("a stale click is refused rather than silently doing the opposite", () => {
    const document = scene([group("g", "Group", [])]);
    expect(setObjectExpanded(document, [], "g", true)).toEqual({
      ok: false,
      reason: "Group is already expanded",
    });
    expect(setObjectExpanded(document, ["g"], "g", false)).toEqual({
      ok: false,
      reason: "Group is already collapsed",
    });
  });

  it("is kept per scene session, not shared between scenes", () => {
    const workspace = emptyWorkspace();
    const first = openSession(workspace, scene([group("g", "Group", ["a"]), rect("a", "A")]));
    const second = openSession(workspace, scene([group("g", "Group", ["a"]), rect("a", "A")]));

    const shut = setObjectExpanded(first.document, first.collapsed, "g", false);
    if (!shut.ok) throw new Error(shut.reason);
    first.collapsed = [...shut.collapsedIds];

    expect(first.collapsed).toEqual(["g"]);
    expect(second.collapsed).toEqual([]);
    expect(first.undoStack).toHaveLength(0);
    expect(first.dirty).toBe(false);
  });
});
