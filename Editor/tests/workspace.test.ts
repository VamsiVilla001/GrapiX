// Scenes as first-class entities (11.29), with Rust owning each session (11.36).
//
// The failure these guard is the one that loses work silently: a second scene
// opening on top of the first, or an edit's answer arriving, and taking the
// author's selection, playhead or folds with it. Nothing errors when that
// happens, which is why it needs a test. History, unsaved marks, dedupe by
// origin and the close refusal are the Rust workspace's
// (`gx_editor::command`), tested there.

import { describe, expect, it } from "vitest";

import type { SceneDocument, SceneOrigin, SessionView } from "@grapix/contracts";
import {
  activate,
  activeSession,
  applySessionView,
  captureWorkingCopy,
  emptyWorkspace,
  isRefused,
  removeSession,
  sceneTabs,
  sessionFor,
  type SceneSession,
  type Workspace,
} from "../src/workspace";

function doc(id: string, name = id): SceneDocument {
  return {
    id,
    name,
    version: 1,
    workingColorSpace: "srgb",
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

/// A projection as Rust returns it.
function view(
  session: number,
  document: SceneDocument,
  marks: { dirty?: boolean; projectDirty?: boolean; origin?: SceneOrigin; undoDepth?: number } = {},
): SessionView {
  return {
    session,
    document,
    ...(marks.origin === undefined ? {} : { origin: marks.origin }),
    undoDepth: marks.undoDepth ?? 0,
    redoDepth: 0,
    dirty: marks.dirty ?? false,
    projectDirty: marks.projectDirty ?? false,
  };
}

function open(workspace: Workspace, projection: SessionView): SceneSession {
  const session = applySessionView(workspace, projection);
  activate(workspace, session.key);
  return session;
}

describe("a scene is a distinct entity", () => {
  it("keeps each scene's selection, playhead and collapse across a switch", () => {
    const workspace = emptyWorkspace();
    const lower = open(workspace, view(1, doc("lower-third", "Lower third")));
    lower.selection = ["card"];
    lower.currentFrame = 40;
    lower.collapsed = ["group-1"];

    const bug = open(workspace, view(2, doc("bug", "Bug")));
    bug.selection = ["logo"];
    bug.currentFrame = 90;

    // Opening the second scene must not have reached into the first.
    expect(lower).toMatchObject({ selection: ["card"], currentFrame: 40, collapsed: ["group-1"] });

    const back = activate(workspace, lower.key);
    expect(isRefused(back)).toBe(false);
    expect(activeSession(workspace)).toMatchObject({ key: 1, selection: ["card"], currentFrame: 40 });
    // And the scene switched away from kept its own place too.
    expect(bug.currentFrame).toBe(90);
  });

  it("an edit's answer replaces the projection and keeps the view state", () => {
    const workspace = emptyWorkspace();
    const session = open(workspace, view(1, doc("a")));
    session.selection = ["card"];
    session.currentFrame = 12;
    session.timelineCollapsed = ["group-1"];

    const edited = applySessionView(workspace, view(1, doc("a", "A edited"), { dirty: true, undoDepth: 1 }));

    expect(edited).toBe(session);
    expect(workspace.sessions).toHaveLength(1);
    expect(session.view.document.name).toBe("A edited");
    expect(session).toMatchObject({ selection: ["card"], currentFrame: 12, timelineCollapsed: ["group-1"] });
  });

  it("an answer for one scene cannot alter another", () => {
    const workspace = emptyWorkspace();
    const a = open(workspace, view(1, doc("a")));
    const b = open(workspace, view(2, doc("b")));
    const beforeB = b.view;

    applySessionView(workspace, view(1, doc("a", "changed"), { dirty: true }));

    expect(b.view).toBe(beforeB);
    expect(a.view.document.name).toBe("changed");
  });

  it("a projection for a new key is a new session, not an activation", () => {
    const workspace = emptyWorkspace();
    open(workspace, view(1, doc("a")));
    const added = applySessionView(workspace, view(2, doc("b")));
    expect(added).toMatchObject({ key: 2, selection: [], currentFrame: 0, collapsed: [] });
    expect(workspace.activeKey).toBe(1);
  });

  it("capturing the working copy never writes Rust's projection", () => {
    const workspace = emptyWorkspace();
    const session = open(workspace, view(1, doc("a"), { dirty: true }));
    const projection = session.view;
    captureWorkingCopy(session, {
      selection: ["x"],
      collapsed: [],
      timelineCollapsed: ["group-9"],
      currentFrame: 3,
      takePage: session.takePage,
      takePagePreview: null,
    });
    expect(session.view).toBe(projection);
    expect(sceneTabs(workspace)[0]?.dirty).toBe(true);
    expect(session.timelineCollapsed).toEqual(["group-9"]);
  });
});

describe("finding and closing", () => {
  it("finds the open session for a stored scene by origin", () => {
    const workspace = emptyWorkspace();
    const origin = { project: "news", sceneId: "lower-third" };
    open(workspace, view(1, doc("bug")));
    const bound = open(workspace, view(2, doc("lower-third"), { origin }));
    expect(sessionFor(workspace, origin)).toBe(bound);
    expect(sessionFor(workspace, { project: "sport", sceneId: "lower-third" })).toBeUndefined();
  });

  it("closing the active scene activates a neighbour, never nothing-while-scenes-remain", () => {
    const workspace = emptyWorkspace();
    const a = open(workspace, view(1, doc("a")));
    const b = open(workspace, view(2, doc("b")));
    open(workspace, view(3, doc("c")));

    activate(workspace, b.key);
    removeSession(workspace, b.key);

    expect(workspace.sessions.map((s) => s.view.document.id)).toEqual(["a", "c"]);
    expect(activeSession(workspace)?.key).toBe(a.key);
  });

  it("closing the last scene leaves nothing active", () => {
    const workspace = emptyWorkspace();
    const only = open(workspace, view(1, doc("a")));
    removeSession(workspace, only.key);
    expect(workspace.activeKey).toBeUndefined();
    expect(activeSession(workspace)).toBeUndefined();
  });

  it("activating a scene that is not open is refused rather than ignored", () => {
    const workspace = emptyWorkspace();
    open(workspace, view(1, doc("a")));
    expect(isRefused(activate(workspace, 99))).toBe(true);
    expect(workspace.activeKey).toBe(1);
  });
});

describe("the scene switcher", () => {
  it("names each scene, marks the active one, and shows Rust's unsaved mark", () => {
    const workspace = emptyWorkspace();
    open(workspace, view(2, doc("bug", "Bug")));
    open(
      workspace,
      view(1, doc("lower-third", "Lower third"), {
        dirty: true,
        origin: { project: "news", sceneId: "lower-third" },
      }),
    );

    const tabs = sceneTabs(workspace);
    expect(tabs.map((tab) => tab.label)).toEqual(["Bug", "Lower third"]);
    expect(tabs[1]).toMatchObject({ key: 1, active: true, dirty: true, origin: "news/lower-third" });
    // An unbound scene says so by absence rather than inventing a project.
    expect(tabs[0]).toMatchObject({ active: false, dirty: false });
    expect(tabs[0]!.origin).toBeUndefined();
  });

  it("a renamed scene keeps its tab identity", () => {
    const workspace = emptyWorkspace();
    open(workspace, view(1, doc("lower-third", "Lower third")));
    applySessionView(workspace, view(1, doc("lower-third", "Renamed"), { dirty: true }));
    expect(sceneTabs(workspace)[0]).toMatchObject({ key: 1, label: "Renamed" });
  });
});
