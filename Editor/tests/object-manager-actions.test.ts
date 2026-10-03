// The object manager's row actions (11.8).
//
// The treegrid rendered Hide/Show, Lock/Unlock and Expand/Collapse as enabled
// controls with no handler behind them — a control that appears to work and
// does nothing, which invariant 18 forbids. Visibility and lock are now
// `SceneEdit`s Rust applies and refuses by name (11.36); these tests pin the
// panel's side: a disabled button names its cause, and expand/collapse is view
// state that never touches the document.

import { describe, expect, it } from "vitest";

import type { SceneDocument, SceneObject, SessionView } from "@grapix/contracts";
import { findNode } from "../src/agent-surface";
import { objectManagerPanel, setObjectExpanded } from "../src/object-manager";
import { applySessionView, emptyWorkspace } from "../src/workspace";

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

function view(session: number, document: SceneDocument): SessionView {
  return { session, document, undoDepth: 0, redoDepth: 0, dirty: false, projectDirty: false };
}

/// Whether the rendered row offers an action, and why not if it does not.
function offered(document: SceneDocument, rowId: string, action: string): string | undefined {
  const row = findNode(objectManagerPanel(document, { selectedIds: [], collapsedIds: [] }), rowId);
  return row!.actions!.find((candidate) => candidate.name === action)!.unavailable;
}

// The edits themselves (`setObjectVisible`, `setObjectLocked`) are applied and
// refused by Rust (gx_contracts::object_edit, with its own tests). What the
// panel owns is the offer: a button that is disabled says why before a click.
describe("the row offers what applies and explains what does not", () => {
  it("the row's cell and button reflect the document's value", () => {
    const panel = objectManagerPanel(scene([rect("a", "A", { visible: false })]), {
      selectedIds: [],
      collapsedIds: [],
    });
    expect(findNode(panel, "a/visible")!.value).toBe("hidden");
    expect(findNode(panel, "a")!.actions!.find((a) => a.name === "toggleVisibility")!.label).toBe(
      "Show",
    );
  });

  it("an own lock can be released even though it blocks visibility", () => {
    const document = scene([rect("a", "A", { locked: true })]);
    expect(offered(document, "a", "toggleLock")).toBeUndefined();
    expect(offered(document, "a", "toggleVisibility")).toBe("A is locked");
  });

  it("inherited hiding and locking name the parent that causes them", () => {
    const document = scene([
      group("bug", "Bug", ["logo"], { visible: false }),
      rect("logo", "Logo"),
      group("lg", "Locked group", ["child"], { locked: true }),
      rect("child", "Child"),
    ]);
    expect(offered(document, "logo", "toggleVisibility")).toBe("hidden by parent 'Bug'");
    // The parent's own toggle still works — that is where the fix is.
    expect(offered(document, "bug", "toggleVisibility")).toBeUndefined();
    expect(offered(document, "child", "toggleLock")).toBe("locked by parent 'Locked group'");
    expect(offered(document, "child", "toggleVisibility")).toBe("locked by parent 'Locked group'");
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
    const first = applySessionView(workspace, view(1, scene([group("g", "Group", ["a"]), rect("a", "A")])));
    const second = applySessionView(workspace, view(2, scene([group("g", "Group", ["a"]), rect("a", "A")])));

    const shut = setObjectExpanded(first.view.document, first.collapsed, "g", false);
    if (!shut.ok) throw new Error(shut.reason);
    first.collapsed = [...shut.collapsedIds];

    expect(first.collapsed).toEqual(["g"]);
    expect(second.collapsed).toEqual([]);
    // View state: Rust's projection is untouched, so nothing is unsaved.
    expect(first.view.dirty).toBe(false);
    expect(first.view.undoDepth).toBe(0);
  });
});
