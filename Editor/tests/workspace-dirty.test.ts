// Unsaved changes are owned by the scene, not by the project-save flag (11.29).
//
// The bug these guard: the shell wrote its project-save flag over the
// session's unsaved flag every time it captured the active scene. A scene that
// had never been bound to a project (New scene, Open file) therefore had its
// edit marked on the tab and then erased on the next switch or close, and a
// close with unsaved work went through with no refusal. Saving to a file never
// cleared the flag either. Nothing errored in either case, which is why it
// needs a test.

import { describe, expect, it } from "vitest";

import type { SceneDocument } from "@grapix/contracts";
import {
  activate,
  captureWorkingCopy,
  closeSession,
  emptyWorkspace,
  isRefused,
  markEdited,
  markSaved,
  markSavedToFile,
  openSession,
  sceneTabs,
  type SceneSession,
  type SessionWorkingCopy,
} from "../src/workspace";

function doc(id: string, name = id): SceneDocument {
  return {
    id,
    name,
    version: 1,
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    timeline: { durationFrames: 100 as unknown as bigint, channels: [], phases: [] },
    dataContext: {},
    assets: [],
    fonts: [],
    materials: [],
    controls: [],
    textStyles: [],
    objects: [],
  } as SceneDocument;
}

/// What the shell writes back when it leaves a scene. The project-save flag is
/// the shell's own, and for an unbound scene it is always false.
function workingCopy(session: SceneSession, projectDirty: boolean): SessionWorkingCopy {
  return {
    document: session.document,
    selection: session.selection,
    collapsed: session.collapsed,
    timelineCollapsed: session.timelineCollapsed,
    currentFrame: session.currentFrame,
    undoStack: session.undoStack,
    redoStack: session.redoStack,
    path: session.path,
    takePage: session.takePage,
    takePagePreview: session.takePagePreview,
    projectDirty,
  };
}

describe("unsaved changes belong to the scene", () => {
  it("an edited unbound scene still refuses to close after it is captured", () => {
    const workspace = emptyWorkspace();
    const created = openSession(workspace, doc("untitled", "Untitled"), { path: null });
    markEdited(created);
    expect(created.dirty).toBe(true);

    // The close path captures the working copy first; the project-save flag
    // is false because the scene is not in a project.
    captureWorkingCopy(created, workingCopy(created, false));

    const result = closeSession(workspace, created.key);
    expect(isRefused(result)).toBe(true);
    if (isRefused(result)) expect(result.refused).toContain("Untitled");
    expect(workspace.sessions).toContain(created);
  });

  it("switching away and back keeps an unbound scene's unsaved mark", () => {
    const workspace = emptyWorkspace();
    const opened = openSession(workspace, doc("from-file", "From file"), { path: "C:/a.json" });
    markEdited(opened);
    captureWorkingCopy(opened, workingCopy(opened, false));
    const other = openSession(workspace, doc("other"));
    captureWorkingCopy(other, workingCopy(other, false));
    activate(workspace, opened.key);

    const tab = sceneTabs(workspace).find((candidate) => candidate.key === opened.key);
    expect(tab?.dirty).toBe(true);
  });

  it("an edit marks project-unsaved only for a scene bound to a project", () => {
    const workspace = emptyWorkspace();
    const unbound = openSession(workspace, doc("a"));
    const bound = openSession(workspace, doc("b"), {
      origin: { project: "news", sceneId: "b" },
    });
    markEdited(unbound);
    markEdited(bound);
    expect(unbound).toMatchObject({ dirty: true, projectDirty: false });
    expect(bound).toMatchObject({ dirty: true, projectDirty: true });
  });

  it("saving to a file clears the unsaved mark and records the path", () => {
    const workspace = emptyWorkspace();
    const created = openSession(workspace, doc("untitled", "Untitled"));
    markEdited(created);
    markSavedToFile(created, "C:/shows/untitled.json");
    expect(created.dirty).toBe(false);
    expect(created.path).toBe("C:/shows/untitled.json");
    expect(isRefused(closeSession(workspace, created.key))).toBe(false);
  });

  it("saving to a file leaves the project copy stale", () => {
    // The project still holds the old graphic; publishing it would air the
    // version the author did not save there.
    const workspace = emptyWorkspace();
    const bound = openSession(workspace, doc("b"), { origin: { project: "news", sceneId: "b" } });
    markEdited(bound);
    markSavedToFile(bound, "C:/b.json");
    expect(bound).toMatchObject({ dirty: false, projectDirty: true });
  });

  it("saving to the project clears both marks and binds the origin", () => {
    const workspace = emptyWorkspace();
    const created = openSession(workspace, doc("untitled"));
    markEdited(created);
    markSaved(created, { project: "news", sceneId: "untitled" });
    expect(created).toMatchObject({
      dirty: false,
      projectDirty: false,
      origin: { project: "news", sceneId: "untitled" },
    });
  });

  it("capturing the working copy never writes the unsaved mark", () => {
    const workspace = emptyWorkspace();
    const session = openSession(workspace, doc("a"));
    // A clean scene stays clean even if the shell's project flag is stale.
    captureWorkingCopy(session, workingCopy(session, true));
    expect(session.dirty).toBe(false);
    expect(session.projectDirty).toBe(true);
  });
});

describe("timeline collapse state belongs to the scene", () => {
  it("each session starts with nothing folded and keeps its own folds", () => {
    const workspace = emptyWorkspace();
    const lower = openSession(workspace, doc("lower"));
    const strap = openSession(workspace, doc("strap"));
    expect(lower.timelineCollapsed).toEqual([]);

    captureWorkingCopy(lower, { ...workingCopy(lower, false), timelineCollapsed: ["group-1"] });
    captureWorkingCopy(strap, { ...workingCopy(strap, false), timelineCollapsed: ["group-9"] });

    expect(lower.timelineCollapsed).toEqual(["group-1"]);
    expect(strap.timelineCollapsed).toEqual(["group-9"]);
    // Distinct from the object manager's folds, which are a separate view.
    expect(lower.collapsed).toEqual([]);
  });
});
