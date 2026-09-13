// Scenes as first-class entities (11.29).
//
// The failure these guard is the one that loses work silently: a second scene
// opening on top of the first, taking its selection, playhead and undo history
// with it. Nothing errors when that happens, which is why it needs a test.

import { describe, expect, it } from "vitest";

import type { SceneDocument } from "@grapix/contracts";
import {
  activate,
  activeSession,
  closeSession,
  commit,
  emptyWorkspace,
  isRefused,
  markSaved,
  openSession,
  redo,
  sceneTabs,
  undo,
  MAX_HISTORY,
} from "../src/workspace";

function doc(id: string, name = id): SceneDocument {
  return {
    id,
    name,
    version: 1,
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    timeline: { durationFrames: 100 as unknown as bigint, channels: [] },
    dataContext: {},
    assets: [],
    fonts: [],
    materials: [],
    objects: [],
  } as SceneDocument;
}

describe("a scene is a distinct entity", () => {
  it("keeps each scene's selection, playhead and collapse across a switch", () => {
    const workspace = emptyWorkspace();
    const lower = openSession(workspace, doc("lower-third", "Lower third"));
    lower.selection = ["card"];
    lower.currentFrame = 40;
    lower.collapsed = ["group-1"];

    const bug = openSession(workspace, doc("bug", "Bug"));
    bug.selection = ["logo"];
    bug.currentFrame = 90;

    // Opening the second scene must not have reached into the first.
    expect(lower.selection).toEqual(["card"]);
    expect(lower.currentFrame).toBe(40);
    expect(lower.collapsed).toEqual(["group-1"]);

    const back = activate(workspace, lower.key);
    expect(isRefused(back)).toBe(false);
    expect(activeSession(workspace)?.key).toBe(lower.key);
    expect(activeSession(workspace)?.selection).toEqual(["card"]);
    expect(activeSession(workspace)?.currentFrame).toBe(40);
    // And the scene switched away from kept its own place too.
    expect(bug.currentFrame).toBe(90);
  });

  it("gives each scene its own undo history", () => {
    const workspace = emptyWorkspace();
    const a = openSession(workspace, doc("a"));
    const b = openSession(workspace, doc("b"));

    commit(a, doc("a", "A edited"));
    commit(b, doc("b", "B edited"));
    commit(b, doc("b", "B edited twice"));

    // Undoing in B must not reach A, and must reverse exactly one gesture.
    undo(b);
    expect(b.document.name).toBe("B edited");
    expect(a.document.name).toBe("A edited");

    undo(a);
    expect(a.document.name).toBe("a");
    // B is untouched by A's undo.
    expect(b.document.name).toBe("B edited");

    redo(a);
    expect(a.document.name).toBe("A edited");
  });

  it("an edit in one scene cannot alter another", () => {
    const workspace = emptyWorkspace();
    const a = openSession(workspace, doc("a"));
    const b = openSession(workspace, doc("b"));
    const beforeB = b.document;

    commit(a, doc("a", "changed"));

    expect(b.document).toBe(beforeB);
    expect(b.undoStack).toHaveLength(0);
  });

  it("undo on a scene with no history is a no-op, not a crash", () => {
    const session = openSession(emptyWorkspace(), doc("a"));
    expect(undo(session)).toBeUndefined();
    expect(redo(session)).toBeUndefined();
    expect(session.document.id).toBe("a");
  });

  it("bounds one scene's history without bounding the workspace", () => {
    const workspace = emptyWorkspace();
    const session = openSession(workspace, doc("a"));
    for (let index = 0; index < MAX_HISTORY + 50; index += 1) {
      commit(session, doc("a", `edit ${index}`));
    }
    expect(session.undoStack).toHaveLength(MAX_HISTORY);
  });
});

describe("opening and closing", () => {
  it("reveals the existing session rather than opening a scene twice", () => {
    const workspace = emptyWorkspace();
    const origin = { project: "news", sceneId: "lower-third" };
    const first = openSession(workspace, doc("lower-third"), { origin });
    first.selection = ["card"];
    openSession(workspace, doc("bug"));

    const again = openSession(workspace, doc("lower-third"), { origin });

    // Two sessions over one stored scene would mean two divergent histories
    // for one graphic, and no answer to which one a save should win with.
    expect(workspace.sessions).toHaveLength(2);
    expect(again.key).toBe(first.key);
    expect(again.selection).toEqual(["card"]);
    expect(workspace.activeKey).toBe(first.key);
  });

  it("refuses to close a scene with unsaved changes, by name", () => {
    const workspace = emptyWorkspace();
    const session = openSession(workspace, doc("lower-third", "Lower third"));
    commit(session, doc("lower-third", "Lower third"));

    const refusal = closeSession(workspace, session.key);
    expect(isRefused(refusal)).toBe(true);
    expect(isRefused(refusal) && refusal.refused).toContain("Lower third");
    expect(isRefused(refusal) && refusal.refused).toContain("unsaved");
    expect(workspace.sessions).toHaveLength(1);

    // Explicit confirmation closes it; saving also clears the block.
    markSaved(session);
    expect(isRefused(closeSession(workspace, session.key))).toBe(false);
    expect(workspace.sessions).toHaveLength(0);
  });

  it("closing the active scene activates a neighbour, never nothing-while-scenes-remain", () => {
    const workspace = emptyWorkspace();
    const a = openSession(workspace, doc("a"));
    const b = openSession(workspace, doc("b"));
    openSession(workspace, doc("c"));

    activate(workspace, b.key);
    closeSession(workspace, b.key);

    expect(workspace.sessions.map((s) => s.document.id)).toEqual(["a", "c"]);
    expect(activeSession(workspace)?.key).toBe(a.key);
  });

  it("closing the last scene leaves nothing active", () => {
    const workspace = emptyWorkspace();
    const only = openSession(workspace, doc("a"));
    closeSession(workspace, only.key);
    expect(workspace.activeKey).toBeUndefined();
    expect(activeSession(workspace)).toBeUndefined();
  });

  it("activating a scene that is not open is refused rather than ignored", () => {
    const workspace = emptyWorkspace();
    openSession(workspace, doc("a"));
    const refusal = activate(workspace, "session-does-not-exist");
    expect(isRefused(refusal)).toBe(true);
  });
});

describe("the scene switcher", () => {
  it("names each scene, marks the active one, and flags unsaved work", () => {
    const workspace = emptyWorkspace();
    const a = openSession(workspace, doc("lower-third", "Lower third"), {
      origin: { project: "news", sceneId: "lower-third" },
    });
    openSession(workspace, doc("bug", "Bug"));
    commit(a, doc("lower-third", "Lower third"));
    activate(workspace, a.key);

    const tabs = sceneTabs(workspace);
    expect(tabs.map((tab) => tab.label)).toEqual(["Lower third", "Bug"]);
    expect(tabs[0]).toMatchObject({ active: true, dirty: true, origin: "news/lower-third" });
    // An unbound scene says so by absence rather than inventing a project.
    expect(tabs[1]).toMatchObject({ active: false, dirty: false });
    expect(tabs[1]!.origin).toBeUndefined();
  });

  it("a renamed scene keeps its tab identity", () => {
    const workspace = emptyWorkspace();
    const session = openSession(workspace, doc("lower-third", "Lower third"));
    const key = session.key;
    commit(session, doc("lower-third", "Renamed"));

    expect(session.key).toBe(key);
    expect(sceneTabs(workspace)[0]).toMatchObject({ key, label: "Renamed" });
  });
});
