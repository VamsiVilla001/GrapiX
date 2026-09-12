// The object manager treegrid (11.8): hierarchy, visibility, lock, alpha,
// transforms — and the refusals that keep a control from lying.
//
// The sharp case is inherited state. Toggling the visibility of an object
// whose parent is hidden changes nothing an author can see, so an interface
// that offers the toggle and appears to do nothing is the silent failure
// invariant 18 forbids. The row says which parent is responsible instead.

import { describe, expect, it } from "vitest";

import type { SceneDocument, SceneObject } from "@grapix/contracts";
import { agentView, findNode, moveFocus, visibleRows } from "../src/agent-surface";
import { alphaLabel, objectManagerPanel, transformSummary } from "../src/object-manager";

function base(id: string, name: string): Omit<SceneObject & { type: "rect" }, "type"> {
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
  } as unknown as Omit<SceneObject & { type: "rect" }, "type">;
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

const NOTHING_COLLAPSED = { selectedIds: [], collapsedIds: [] };

describe("hierarchy", () => {
  it("reports depth as aria-level, 1-based, through nested containers", () => {
    const document = scene([
      group("outer", "Outer", ["inner"]),
      group("inner", "Inner", ["leaf"]),
      rect("leaf", "Leaf"),
    ]);

    const panel = objectManagerPanel(document, NOTHING_COLLAPSED);
    const levels = (panel.children ?? []).map((row) => [row.id, row.level]);

    expect(levels).toEqual([
      ["outer", 1],
      ["inner", 2],
      ["leaf", 3],
    ]);
  });

  it("a leaf is not a collapsed container", () => {
    // `expanded: false` on a leaf would announce it as something a person
    // could open, and expanding it would then do nothing.
    const document = scene([group("g", "Group", ["leaf"]), rect("leaf", "Leaf")]);
    const panel = objectManagerPanel(document, NOTHING_COLLAPSED);

    expect(findNode(panel, "g")!.expanded).toBe(true);
    expect(findNode(panel, "leaf")!.expanded).toBeUndefined();

    const expand = findNode(panel, "leaf")!.actions!.find((a) => a.name === "expand")!;
    expect(expand.unavailable).toContain("no children");
  });

  it("a collapsed container's descendants are not rows at all", () => {
    // Collapsed means absent, not present-and-hidden: what a keyboard walks,
    // a screen reader announces and an agent reads must be one set.
    const document = scene([
      group("g", "Group", ["a", "b"]),
      rect("a", "A"),
      rect("b", "B"),
      rect("outside", "Outside"),
    ]);

    const open = objectManagerPanel(document, NOTHING_COLLAPSED);
    expect(visibleRows(open).map((row) => row.id)).toEqual(["g", "a", "b", "outside"]);

    const shut = objectManagerPanel(document, { selectedIds: [], collapsedIds: ["g"] });
    expect(visibleRows(shut).map((row) => row.id)).toEqual(["g", "outside"]);
    expect(findNode(shut, "a")).toBeUndefined();
    // The objects are still in the document; only the rows are gone.
    expect(document.objects.some((object) => object.id === "a")).toBe(true);
  });

  it("an object claimed by nobody is still a row", () => {
    // An object the author cannot see is worse than one in the wrong place.
    const document = scene([group("g", "Group", ["missing"]), rect("orphan", "Orphan")]);
    const panel = objectManagerPanel(document, NOTHING_COLLAPSED);
    expect(visibleRows(panel).map((row) => row.id)).toEqual(["g", "orphan"]);
  });
});

describe("the columns the step names", () => {
  it("visibility, lock, alpha and transform all carry the authored value", () => {
    const document = scene([
      rect("r", "Rect", { visible: false, locked: true, opacity: 0.5, x: 12, y: -4, scaleX: 2 }),
    ]);
    const panel = objectManagerPanel(document, NOTHING_COLLAPSED);

    const cellValue = (key: string): string | undefined => findNode(panel, `r/${key}`)?.value;
    expect(cellValue("visible")).toBe("hidden");
    expect(cellValue("locked")).toBe("locked");
    expect(cellValue("alpha")).toBe("50%");
    expect(cellValue("transform")).toBe("x 12, y -4, scale 2×1");
  });

  it("identity scale and rotation stay out of the summary", () => {
    // A column of `1×1 0°` on every row hides the one row where it matters.
    expect(transformSummary(rect("r", "R"))).toBe("x 0, y 0");
    expect(transformSummary(rect("r", "R", { rotation: 90 }))).toBe("x 0, y 0, rot 90°");
    expect(alphaLabel(0.125)).toBe("13%");
  });
});

describe("a control that could not work says so", () => {
  it("visibility under a hidden parent is unavailable, and names the parent", () => {
    const document = scene([
      group("bug", "Bug", ["logo"], { visible: false }),
      rect("logo", "Logo"),
    ]);
    const panel = objectManagerPanel(document, NOTHING_COLLAPSED);

    const toggle = findNode(panel, "logo")!.actions!.find((a) => a.name === "toggleVisibility")!;
    expect(toggle.unavailable).toBe("hidden by parent 'Bug'");
    // The parent's own toggle still works — that is where the fix is.
    const parentToggle = findNode(panel, "bug")!.actions!.find(
      (a) => a.name === "toggleVisibility",
    )!;
    expect(parentToggle.unavailable).toBeUndefined();
  });

  it("a lock inherited from a parent cannot be released from the child", () => {
    const document = scene([
      group("locked-group", "Locked group", ["child"], { locked: true }),
      rect("child", "Child"),
    ]);
    const panel = objectManagerPanel(document, NOTHING_COLLAPSED);

    const lock = findNode(panel, "child")!.actions!.find((a) => a.name === "toggleLock")!;
    expect(lock.unavailable).toBe("locked by parent 'Locked group'");
  });

  it("an object's own lock blocks its visibility toggle by name", () => {
    const document = scene([rect("r", "Rect", { locked: true })]);
    const panel = objectManagerPanel(document, NOTHING_COLLAPSED);
    const toggle = findNode(panel, "r")!.actions!.find((a) => a.name === "toggleVisibility")!;
    expect(toggle.unavailable).toBe("Rect is locked");
  });
});

describe("an agent sees what a person sees", () => {
  it("rows, levels and action availability match the rendered tree", () => {
    const document = scene([
      group("bug", "Bug", ["logo"], { visible: false }),
      rect("logo", "Logo"),
    ]);
    const panel = objectManagerPanel(document, { selectedIds: ["logo"], collapsedIds: [] });
    const view = agentView(panel);

    const rows = view.children.filter((child) => child.role === "row");
    expect(rows.map((row) => [row.id, row.level])).toEqual([
      ["bug", 1],
      ["logo", 2],
    ]);
    expect(rows[1]!.selected).toBe(true);

    const toggle = rows[1]!.actions.find((a) => a.name === "toggleVisibility")!;
    expect(toggle.available).toBe(false);
    expect(toggle.unavailableReason).toBe("hidden by parent 'Bug'");
  });

  it("keyboard traversal follows the same visible order", () => {
    const document = scene([
      group("g", "Group", ["a"]),
      rect("a", "A"),
      rect("z", "Z"),
    ]);
    const panel = objectManagerPanel(document, NOTHING_COLLAPSED);

    expect(moveFocus(panel, "g", "ArrowDown")).toBe("a");
    expect(moveFocus(panel, "a", "ArrowDown")).toBe("z");
    expect(moveFocus(panel, "z", "End")).toBe("z");

    const shut = objectManagerPanel(document, { selectedIds: [], collapsedIds: ["g"] });
    // With the group shut, the next row is the one after its subtree.
    expect(moveFocus(shut, "g", "ArrowDown")).toBe("z");
  });
});
