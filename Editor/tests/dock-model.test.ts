// The dock model (11.92): every operation, held to the hand-off's list of layout tests.
import { describe, expect, it } from "vitest";
import {
  MIN_FRACTION,
  closePanel,
  dragDivider,
  findGroup,
  findSplit,
  focusPanel,
  freshId,
  groupOfInstance,
  instanceIdsInOrder,
  instanceOf,
  isDockRefused,
  maximizeGroup,
  moveGroup,
  movePanel,
  normalizeWeights,
  normalizeWorkspace,
  reorderTab,
  restoreGroup,
  setSplitWeights,
  type DockRefusal,
  type SavedWorkspace,
  type SplitNode,
  type TabsNode,
} from "../src/dock-model";
import { validateWorkspace } from "../src/dock-validate";
import { deepFreeze, design, ok } from "./dock-fixtures";

const split = (workspace: SavedWorkspace, id: string): SplitNode => {
  const found = findSplit(workspace, id);
  if (found === undefined) throw new Error(`no split ${id}`);
  return found;
};
const group = (workspace: SavedWorkspace, id: string): TabsNode => {
  const found = findGroup(workspace, id);
  if (found === undefined) throw new Error(`no group ${id}`);
  return found;
};
const refusal = (result: SavedWorkspace | DockRefusal): DockRefusal => {
  if (!isDockRefused(result)) throw new Error("not refused");
  return result;
};
const sorted = (workspace: SavedWorkspace): string[] => [...instanceIdsInOrder(workspace)].sort();

describe("the fixture is a valid workspace", () => {
  it("breaks no rule", () => {
    expect(validateWorkspace(design())).toEqual([]);
  });
});

describe("dropping a panel on a group's centre", () => {
  it("adds it as the last tab of that group and shows it, leaving the group it left with the rest", () => {
    const next = ok(movePanel(design(), "objects-1", "timeline-group", "center"));
    expect(group(next, "timeline-group").panelInstanceIds).toEqual(["timeline-1", "curves-1", "objects-1"]);
    expect(group(next, "timeline-group").activePanelInstanceId).toBe("objects-1");
    expect(group(next, "left").panelInstanceIds).toEqual(["assets-1"]);
    expect(group(next, "left").activePanelInstanceId).toBe("assets-1");
    expect(next.activeGroupId).toBe("timeline-group");
    expect(validateWorkspace(next)).toEqual([]);
  });

  it("puts it at a given tab position, and moving within a group is a reorder", () => {
    const first = ok(movePanel(design(), "objects-1", "timeline-group", "center", 1));
    expect(group(first, "timeline-group").panelInstanceIds).toEqual(["timeline-1", "objects-1", "curves-1"]);
    const again = ok(movePanel(design(), "curves-1", "timeline-group", "center", 0));
    expect(group(again, "timeline-group").panelInstanceIds).toEqual(["curves-1", "timeline-1"]);
  });

  it("collapses the group it emptied and the split that was left with one child", () => {
    const next = ok(movePanel(design(), "viewport-1", "timeline-group", "center"));
    expect(findGroup(next, "viewport-group")).toBeUndefined();
    // The centre split had two children; with one left it is that child, in the root's second place.
    expect(findSplit(next, "center")).toBeUndefined();
    expect(split(next, "root").children[1]!.id).toBe("timeline-group");
    expect(split(next, "root").weights).toEqual([0.2, 0.6, 0.2]);
    expect(validateWorkspace(next)).toEqual([]);
  });
});

describe("dropping a panel beside a group", () => {
  it("wraps the target in a split of the right direction when its parent runs the other way", () => {
    const next = ok(movePanel(design(), "assets-1", "viewport-group", "right"));
    const center = split(next, "center");
    // viewport-group sat in a vertical split; a drop to its right makes a horizontal split in its place.
    const wrapper = center.children[0] as SplitNode;
    expect(wrapper.kind).toBe("split");
    expect(wrapper.direction).toBe("horizontal");
    expect(wrapper.children.map((child) => child.id)).toEqual(["viewport-group", "asset-browser-group"]);
    expect(wrapper.weights).toEqual([0.5, 0.5]);
    expect(center.weights).toEqual([0.68, 0.32]);
    expect(group(next, "asset-browser-group").panelInstanceIds).toEqual(["assets-1"]);
    expect(validateWorkspace(next)).toEqual([]);
  });

  it("joins a split of the same direction and takes half of the target's share", () => {
    const above = ok(movePanel(design(), "assets-1", "timeline-group", "top"));
    const center = split(above, "center");
    expect(center.children.map((child) => child.id)).toEqual(["viewport-group", "asset-browser-group", "timeline-group"]);
    expect(center.weights[0]).toBeCloseTo(0.68);
    expect(center.weights[1]).toBeCloseTo(0.16);
    expect(center.weights[2]).toBeCloseTo(0.16);
    const below = ok(movePanel(design(), "assets-1", "timeline-group", "bottom"));
    expect(split(below, "center").children.map((child) => child.id)).toEqual(["viewport-group", "timeline-group", "asset-browser-group"]);
    const leftOf = ok(movePanel(design(), "assets-1", "right", "left"));
    expect(split(leftOf, "root").children.map((child) => child.id)).toEqual(["left", "center", "asset-browser-group", "right"]);
    expect(split(leftOf, "root").weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it("wraps the root when the target is the whole workspace", () => {
    const one: SavedWorkspace = {
      ...design(),
      root: { kind: "tabs", id: "only", panelInstanceIds: ["a-1", "b-1"], activePanelInstanceId: "a-1" },
      instances: { "a-1": { instanceId: "a-1", panelType: "a" }, "b-1": { instanceId: "b-1", panelType: "b" } },
    };
    const next = ok(movePanel(one, "b-1", "only", "bottom"));
    expect(next.root.kind).toBe("split");
    expect((next.root as SplitNode).direction).toBe("vertical");
    expect((next.root as SplitNode).children.map((child) => child.id)).toEqual(["only", "b-group"]);
  });

  it("refuses to dock a panel that is alone in its group beside that group", () => {
    const result = refusal(movePanel(design(), "viewport-1", "viewport-group", "left"));
    expect(result.code).toBe("INVALID_DOCK_TARGET");
    // With company it may: the panel leaves its group and takes the side.
    const next = ok(movePanel(design(), "timeline-1", "timeline-group", "left"));
    expect(group(next, "timeline-group").panelInstanceIds).toEqual(["curves-1"]);
    // The new group is named after the panel kind, and `timeline-group` was taken.
    expect(group(next, "timeline-group-2").panelInstanceIds).toEqual(["timeline-1"]);
  });
});

describe("a move never duplicates or loses a panel", () => {
  it("keeps every panel exactly once through every kind of drop", () => {
    const before = sorted(design());
    for (const position of ["left", "right", "top", "bottom", "center"] as const) {
      const next = ok(movePanel(design(), "curves-1", "right", position));
      expect(sorted(next)).toEqual(before);
      expect(validateWorkspace(next)).toEqual([]);
    }
  });

  it("reorders tabs within a group", () => {
    const next = ok(reorderTab(design(), "curves-1", 0));
    expect(group(next, "timeline-group").panelInstanceIds).toEqual(["curves-1", "timeline-1"]);
    expect(group(ok(reorderTab(design(), "timeline-1", 99)), "timeline-group").panelInstanceIds).toEqual(["curves-1", "timeline-1"]);
    expect(group(ok(reorderTab(design(), "curves-1", -5)), "timeline-group").panelInstanceIds).toEqual(["curves-1", "timeline-1"]);
    expect(refusal(reorderTab(design(), "curves-1", Number.NaN)).code).toBe("INVALID_DOCK_TARGET");
    expect(refusal(reorderTab(design(), "nope", 0)).code).toBe("PANEL_NOT_AVAILABLE");
  });
});

describe("moving a whole group", () => {
  it("keeps its tabs in order and its showing tab, beside the target", () => {
    const first = ok(reorderTab(design(), "curves-1", 0));
    const active = ok(focusPanel(first, "timeline-1"));
    const next = ok(moveGroup(active, "timeline-group", "right", "left"));
    const moved = group(next, "timeline-group");
    expect(moved.panelInstanceIds).toEqual(["curves-1", "timeline-1"]);
    expect(moved.activePanelInstanceId).toBe("timeline-1");
    // The viewport group, alone in the centre column now, and the moved group beside the right-hand column.
    expect(split(next, "root").children.map((child) => child.id)).toEqual(["left", "viewport-group", "timeline-group", "right"]);
    expect(split(next, "root").weights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1);
    expect(sorted(next)).toEqual(sorted(design()));
    expect(validateWorkspace(next)).toEqual([]);
  });

  it("merges into another group, after its tabs, showing the moved group's tab", () => {
    const next = ok(moveGroup(design(), "left", "right", "center"));
    expect(group(next, "right").panelInstanceIds).toEqual(["inspector-1", "bindings-1", "objects-1", "assets-1"]);
    expect(group(next, "right").activePanelInstanceId).toBe("objects-1");
    expect(findGroup(next, "left")).toBeUndefined();
    expect(split(next, "root").weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it("refuses a group moved onto itself or to a group that is not there", () => {
    expect(refusal(moveGroup(design(), "left", "left", "right")).code).toBe("INVALID_DOCK_TARGET");
    expect(refusal(moveGroup(design(), "left", "ghost", "right")).code).toBe("INVALID_DOCK_TARGET");
    expect(refusal(moveGroup(design(), "ghost", "left", "right")).code).toBe("INVALID_DOCK_TARGET");
  });
});

describe("a cancelled or refused move", () => {
  it("returns a refusal and changes nothing it was given", () => {
    const frozen = deepFreeze(design());
    const before = JSON.stringify(frozen);
    expect(isDockRefused(movePanel(frozen, "viewport-1", "viewport-group", "left"))).toBe(true);
    expect(isDockRefused(movePanel(frozen, "nope", "left", "center"))).toBe(true);
    expect(isDockRefused(movePanel(frozen, "objects-1", "ghost", "center"))).toBe(true);
    expect(isDockRefused(movePanel(frozen, "objects-1", "left", "diagonal" as never))).toBe(true);
    expect(isDockRefused(moveGroup(frozen, "left", "left", "left"))).toBe(true);
    expect(JSON.stringify(frozen)).toBe(before);
  });

  it("never writes to its input on a good move either", () => {
    const frozen = deepFreeze(design());
    const before = JSON.stringify(frozen);
    ok(movePanel(frozen, "assets-1", "viewport-group", "right"));
    ok(moveGroup(frozen, "left", "right", "center"));
    ok(closePanel(frozen, "curves-1"));
    ok(dragDivider(frozen, "root", 0, 0.1));
    expect(JSON.stringify(frozen)).toBe(before);
  });
});

describe("closing a panel", () => {
  it("shows the next tab, or the one before when the last closes", () => {
    const next = ok(closePanel(design(), "timeline-1"));
    expect(group(next, "timeline-group").panelInstanceIds).toEqual(["curves-1"]);
    expect(group(next, "timeline-group").activePanelInstanceId).toBe("curves-1");
    const three = ok(movePanel(design(), "objects-1", "right", "center", 1));
    const shown = ok(focusPanel(three, "objects-1"));
    expect(group(ok(closePanel(shown, "objects-1")), "right").activePanelInstanceId).toBe("bindings-1");
    const last = ok(focusPanel(ok(movePanel(design(), "objects-1", "right", "center")), "objects-1"));
    expect(group(ok(closePanel(last, "objects-1")), "right").activePanelInstanceId).toBe("bindings-1");
  });

  it("collapses a group closed empty, and the split left with one child, and adds the weights up again", () => {
    const one = ok(closePanel(design(), "viewport-1"));
    expect(findGroup(one, "viewport-group")).toBeUndefined();
    expect(findSplit(one, "center")).toBeUndefined();
    const both = ok(closePanel(ok(closePanel(one, "timeline-1")), "curves-1"));
    expect(split(both, "root").children.map((child) => child.id)).toEqual(["left", "right"]);
    expect(split(both, "root").weights).toEqual([0.5, 0.5]);
    expect(validateWorkspace(both)).toEqual([]);
  });

  it("removes the panel's instance but keeps its saved view state", () => {
    const withState: SavedWorkspace = { ...design(), viewState: { "objects-1": { columns: ["name", "type"] } } };
    const next = ok(closePanel(withState, "objects-1"));
    expect(next.instances["objects-1"]).toBeUndefined();
    expect(next.viewState).toEqual({ "objects-1": { columns: ["name", "type"] } });
  });

  it("leaves an empty root, which is valid, when the last panel closes", () => {
    let next = design();
    for (const id of Object.keys(design().instances)) next = ok(closePanel(next, id));
    expect(next.root.kind).toBe("tabs");
    expect(instanceIdsInOrder(next)).toEqual([]);
    expect(validateWorkspace(next)).toEqual([]);
    expect(refusal(closePanel(next, "objects-1")).code).toBe("PANEL_NOT_AVAILABLE");
  });

  it("joins a split of the same direction that closing brings together", () => {
    // left | (center: viewport over timeline) | right. Close the viewport, then put something beside the
    // timeline vertically: no split inside a split of the same direction remains.
    const nested: SavedWorkspace = {
      ...design(),
      root: {
        kind: "split",
        id: "root",
        direction: "vertical",
        weights: [0.5, 0.5],
        children: [
          { kind: "tabs", id: "a", panelInstanceIds: ["viewport-1"], activePanelInstanceId: "viewport-1" },
          {
            kind: "split",
            id: "inner",
            direction: "vertical",
            weights: [0.5, 0.5],
            children: [
              { kind: "tabs", id: "b", panelInstanceIds: ["timeline-1"], activePanelInstanceId: "timeline-1" },
              { kind: "tabs", id: "c", panelInstanceIds: ["curves-1"], activePanelInstanceId: "curves-1" },
            ],
          },
        ],
      },
      instances: {
        "viewport-1": design().instances["viewport-1"]!,
        "timeline-1": design().instances["timeline-1"]!,
        "curves-1": design().instances["curves-1"]!,
      },
    };
    const flat = normalizeWorkspace(nested);
    expect((flat.root as SplitNode).children.map((child) => child.id)).toEqual(["a", "b", "c"]);
    expect((flat.root as SplitNode).weights).toEqual([0.5, 0.25, 0.25]);
  });
});

describe("resizing", () => {
  it("moves the divider between two children and keeps their sum", () => {
    const next = ok(dragDivider(design(), "root", 0, 0.1));
    expect(split(next, "root").weights[0]).toBeCloseTo(0.3);
    expect(split(next, "root").weights[1]).toBeCloseTo(0.5);
    expect(split(next, "root").weights[2]).toBeCloseTo(0.2);
  });

  it("stops at a child's smallest share instead of going past it", () => {
    const pushed = ok(dragDivider(design(), "root", 0, 5));
    expect(split(pushed, "root").weights[1]).toBeCloseTo(MIN_FRACTION);
    expect(split(pushed, "root").weights[0]).toBeCloseTo(0.8 - MIN_FRACTION);
    const pulled = ok(dragDivider(design(), "root", 0, -5));
    expect(split(pulled, "root").weights[0]).toBeCloseTo(MIN_FRACTION);
    // A panel's own minimum (a fraction of this split) is respected too.
    const guarded = ok(dragDivider(design(), "root", 1, -5, [0, 0.45, 0]));
    expect(split(guarded, "root").weights[1]).toBeCloseTo(0.45);
    for (const weight of split(guarded, "root").weights) expect(Number.isFinite(weight) && weight > 0).toBe(true);
  });

  it("leaves a pair as it is when its two minimums do not fit", () => {
    const same = ok(dragDivider(design(), "root", 0, 0.1, [0.6, 0.6, 0]));
    expect(split(same, "root").weights).toEqual([0.2, 0.6, 0.2]);
  });

  it("refuses a move it cannot make, by name", () => {
    expect(refusal(dragDivider(design(), "root", 0, Number.NaN)).code).toBe("INVALID_DOCK_TARGET");
    expect(refusal(dragDivider(design(), "root", 2, 0.1)).code).toBe("INVALID_DOCK_TARGET");
    expect(refusal(dragDivider(design(), "root", -1, 0.1)).code).toBe("INVALID_DOCK_TARGET");
    expect(refusal(dragDivider(design(), "root", 0.5, 0.1)).code).toBe("INVALID_DOCK_TARGET");
    expect(refusal(dragDivider(design(), "ghost", 0, 0.1)).code).toBe("INVALID_DOCK_TARGET");
  });

  it("sets weights that are as many as the children, positive and finite, and scales them", () => {
    const next = ok(setSplitWeights(design(), "root", [1, 2, 1]));
    expect(split(next, "root").weights).toEqual([0.25, 0.5, 0.25]);
    expect(refusal(setSplitWeights(design(), "root", [1, 2])).code).toBe("INVALID_DOCK_TARGET");
    expect(refusal(setSplitWeights(design(), "root", [1, 0, 1])).code).toBe("INVALID_DOCK_TARGET");
    expect(refusal(setSplitWeights(design(), "root", [1, -1, 1])).code).toBe("INVALID_DOCK_TARGET");
    expect(refusal(setSplitWeights(design(), "root", [1, Infinity, 1])).code).toBe("INVALID_DOCK_TARGET");
    expect(refusal(setSplitWeights(design(), "ghost", [1, 1])).code).toBe("INVALID_DOCK_TARGET");
  });

  it("scales weights to one, and turns anything unusable into equal shares", () => {
    expect(normalizeWeights([2, 2])).toEqual([0.5, 0.5]);
    expect(normalizeWeights([1, 0, 1])).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(normalizeWeights([Number.NaN, 1])).toEqual([0.5, 0.5]);
    expect(normalizeWeights([])).toEqual([]);
  });
});

describe("maximising a group", () => {
  it("does not change the tree, so restoring brings back every proportion", () => {
    const before = JSON.stringify(design().root);
    const maximised = ok(maximizeGroup(design(), "viewport-group"));
    expect(maximised.maximizedGroupId).toBe("viewport-group");
    expect(JSON.stringify(maximised.root)).toBe(before);
    const restored = ok(restoreGroup(maximised, "viewport-group"));
    expect(restored.maximizedGroupId).toBeUndefined();
    // Only the focus the maximise gave is left; the tree, the weights and every panel are as they were.
    expect({ ...restored, activeGroupId: undefined }).toEqual({ ...design(), activeGroupId: undefined });
  });

  it("is ended by showing a panel in another group, but not by showing one in the same group", () => {
    const maximised = ok(maximizeGroup(design(), "timeline-group"));
    expect(ok(focusPanel(maximised, "curves-1")).maximizedGroupId).toBe("timeline-group");
    expect(ok(focusPanel(maximised, "objects-1")).maximizedGroupId).toBeUndefined();
  });

  it("is dropped when the group it names is gone", () => {
    const maximised = ok(maximizeGroup(design(), "viewport-group"));
    expect(ok(closePanel(maximised, "viewport-1")).maximizedGroupId).toBeUndefined();
  });

  it("refuses a group that is not there, and restoring another group leaves it", () => {
    expect(refusal(maximizeGroup(design(), "ghost")).code).toBe("INVALID_DOCK_TARGET");
    expect(refusal(restoreGroup(design(), "ghost")).code).toBe("INVALID_DOCK_TARGET");
    const maximised = ok(maximizeGroup(design(), "viewport-group"));
    expect(ok(restoreGroup(maximised, "left")).maximizedGroupId).toBe("viewport-group");
  });
});

describe("focus and ids", () => {
  it("shows a panel's tab and makes its group the active one", () => {
    const next = ok(focusPanel(design(), "curves-1"));
    expect(group(next, "timeline-group").activePanelInstanceId).toBe("curves-1");
    expect(next.activeGroupId).toBe("timeline-group");
    expect(refusal(focusPanel(design(), "nope")).code).toBe("PANEL_NOT_AVAILABLE");
  });

  it("makes ids that no node, float or panel uses", () => {
    expect(freshId(design(), "split")).toBe("split");
    expect(freshId(design(), "root")).toBe("root-2");
    expect(freshId(design(), "root", new Set(["root-2"]))).toBe("root-3");
    expect(freshId(design(), "objects-1")).toBe("objects-1-2");
  });

  it("finds a panel's group", () => {
    expect(groupOfInstance(design(), "bindings-1")?.id).toBe("right");
    expect(groupOfInstance(design(), "ghost")).toBeUndefined();
  });
});

describe("floating groups take part in every operation", () => {
  const withFloat = (): SavedWorkspace => ({
    ...design(),
    floats: [
      {
        id: "float-1",
        root: { kind: "tabs", id: "float-tabs", panelInstanceIds: ["curves-1"], activePanelInstanceId: "curves-1" },
        bounds: { x: 10, y: 10, width: 400, height: 300 },
      },
    ],
    root: {
      ...(design().root as SplitNode),
      children: (design().root as SplitNode).children.map((child) =>
        child.id === "timeline-group" || child.kind !== "split"
          ? child
          : { ...child, children: [child.children[0]!, { kind: "tabs" as const, id: "timeline-group", panelInstanceIds: ["timeline-1"], activePanelInstanceId: "timeline-1" }] },
      ),
    },
  });

  it("starts valid", () => {
    expect(validateWorkspace(withFloat())).toEqual([]);
  });

  it("redocks a panel dropped from a float into the main layout, and drops the float it empties", () => {
    const next = ok(movePanel(withFloat(), "curves-1", "right", "center"));
    expect(next.floats).toEqual([]);
    expect(group(next, "right").panelInstanceIds).toContain("curves-1");
    expect(validateWorkspace(next)).toEqual([]);
  });

  it("closing the only panel of a float drops the float", () => {
    expect(ok(closePanel(withFloat(), "curves-1")).floats).toEqual([]);
  });

  it("moves a floating group into the main layout whole", () => {
    const next = ok(moveGroup(withFloat(), "float-tabs", "right", "bottom"));
    expect(next.floats).toEqual([]);
    expect(group(next, "float-tabs").panelInstanceIds).toEqual(["curves-1"]);
    expect(validateWorkspace(next)).toEqual([]);
  });
});

describe("what the survivors of the mutant run showed was not held (11.92)", () => {
  it("makes a tab group show one of its own tabs when normalising finds it showing a panel it does not hold", () => {
    const broken: SavedWorkspace = {
      ...design(),
      root: { kind: "tabs", id: "g", panelInstanceIds: ["objects-1", "assets-1"], activePanelInstanceId: "ghost-9" },
      instances: { "objects-1": design().instances["objects-1"]!, "assets-1": design().instances["assets-1"]! },
    };
    const fixed = normalizeWorkspace(broken);
    expect((fixed.root as TabsNode).activePanelInstanceId).toBe("objects-1");
    expect(validateWorkspace(fixed)).toEqual([]);
    // A workspace that is already in order comes back as it was.
    expect(JSON.stringify(normalizeWorkspace(design()))).toBe(JSON.stringify(design()));
  });

  it("forgets the active group when its group is gone, like the maximised one", () => {
    const focused = ok(focusPanel(design(), "viewport-1"));
    expect(focused.activeGroupId).toBe("viewport-group");
    const closed = ok(closePanel(focused, "viewport-1"));
    expect(closed.activeGroupId).toBeUndefined();
    expect(validateWorkspace(closed)).toEqual([]);
  });

  it("puts a tab at the end or the start for an index past either end, with three tabs", () => {
    const three = ok(movePanel(design(), "objects-1", "timeline-group", "center"));
    expect(group(three, "timeline-group").panelInstanceIds).toEqual(["timeline-1", "curves-1", "objects-1"]);
    expect(group(ok(reorderTab(three, "objects-1", -1)), "timeline-group").panelInstanceIds).toEqual(["objects-1", "timeline-1", "curves-1"]);
    expect(group(ok(reorderTab(three, "timeline-1", 1.9)), "timeline-group").panelInstanceIds).toEqual(["curves-1", "timeline-1", "objects-1"]);
    expect(group(ok(reorderTab(three, "timeline-1", 50)), "timeline-group").panelInstanceIds).toEqual(["curves-1", "objects-1", "timeline-1"]);
  });

  it("keeps floating groups and the rest of the tree when a group is maximised", () => {
    const withFloat: SavedWorkspace = {
      ...design(),
      floats: [{ id: "float-1", root: { kind: "tabs", id: "float-tabs", panelInstanceIds: [], activePanelInstanceId: null }, bounds: { x: 0, y: 0, width: 10, height: 10 } }],
    };
    const maximised = ok(maximizeGroup(withFloat, "left"));
    expect(maximised.floats).toEqual(withFloat.floats);
    expect(maximised.root).toEqual(withFloat.root);
    expect(maximised.instances).toEqual(withFloat.instances);
  });

  it("says in words that a divider cannot be moved by something that is not a number", () => {
    expect(refusal(dragDivider(design(), "root", 0, Number.NaN)).refused).toBe("the divider was not moved: the pointer position it was given is not a number");
  });

  it("does not make an id that a floating group already has", () => {
    const withFloat: SavedWorkspace = {
      ...design(),
      floats: [{ id: "float-1", root: { kind: "tabs", id: "float-tabs", panelInstanceIds: [], activePanelInstanceId: null }, bounds: { x: 0, y: 0, width: 10, height: 10 } }],
    };
    expect(freshId(withFloat, "float-1")).toBe("float-1-2");
  });
});

describe("what the code review of 23 Nov found (11.92)", () => {
  const mainAndFloat = (): SavedWorkspace => ({
    ...design(),
    root: { kind: "tabs", id: "main", panelInstanceIds: ["objects-1", "assets-1"], activePanelInstanceId: "assets-1" },
    floats: [{ id: "float-1", root: { kind: "tabs", id: "f", panelInstanceIds: ["curves-1", "timeline-1"], activePanelInstanceId: "timeline-1" }, bounds: { x: 0, y: 0, width: 300, height: 200 } }],
    instances: {
      "objects-1": design().instances["objects-1"]!,
      "assets-1": design().instances["assets-1"]!,
      "curves-1": design().instances["curves-1"]!,
      "timeline-1": design().instances["timeline-1"]!,
    },
  });

  it("starts from a valid workspace", () => {
    expect(validateWorkspace(mainAndFloat())).toEqual([]);
  });

  it("does not leave two groups with one id when the whole main layout is moved beside a floating group", () => {
    for (const position of ["left", "right", "top", "bottom"] as const) {
      const next = ok(moveGroup(mainAndFloat(), "main", "f", position));
      expect(validateWorkspace(next), position).toEqual([]);
      // The moved group keeps its id, its tabs and its showing tab, and has focus.
      expect(group(next, "main").panelInstanceIds).toEqual(["objects-1", "assets-1"]);
      expect(group(next, "main").activePanelInstanceId).toBe("assets-1");
      expect(next.activeGroupId).toBe("main");
      expect(next.root.kind).toBe("tabs");
      expect(next.root.id).not.toBe("main");
      expect((next.root as TabsNode).panelInstanceIds).toEqual([]);
    }
  });

  it("merges the whole main layout into a floating group without a clash either", () => {
    const next = ok(moveGroup(mainAndFloat(), "main", "f", "center"));
    expect(validateWorkspace(next)).toEqual([]);
    expect(group(next, "f").panelInstanceIds).toEqual(["curves-1", "timeline-1", "objects-1", "assets-1"]);
  });

  it("refuses to move a group that holds no panel, and does not change which tab the target shows", () => {
    const empty: SavedWorkspace = { ...mainAndFloat(), root: { kind: "tabs", id: "main", panelInstanceIds: [], activePanelInstanceId: null }, instances: { "curves-1": design().instances["curves-1"]!, "timeline-1": design().instances["timeline-1"]! } };
    expect(validateWorkspace(empty)).toEqual([]);
    const frozen = deepFreeze(empty);
    const result = refusal(moveGroup(frozen, "main", "f", "center"));
    expect(result).toMatchObject({ code: "INVALID_DOCK_TARGET", refused: "group main holds no panel, so there is nothing to move" });
    expect(refusal(moveGroup(frozen, "main", "f", "left")).code).toBe("INVALID_DOCK_TARGET");
  });

  it("restores a maximised group when a panel or a group is moved somewhere else, so what was moved is seen", () => {
    const maximised = ok(maximizeGroup(design(), "left"));
    const moved = ok(movePanel(maximised, "assets-1", "right", "bottom"));
    expect(moved.maximizedGroupId).toBeUndefined();
    expect(moved.activeGroupId).toBe("asset-browser-group");
    expect(ok(movePanel(maximised, "assets-1", "right", "center")).maximizedGroupId).toBeUndefined();
    expect(ok(moveGroup(ok(maximizeGroup(design(), "viewport-group")), "left", "right", "top")).maximizedGroupId).toBeUndefined();
    expect(ok(moveGroup(ok(maximizeGroup(design(), "viewport-group")), "left", "right", "center")).maximizedGroupId).toBeUndefined();
    // A move that ends in the maximised group keeps it maximised: the panel is in sight there.
    expect(ok(movePanel(ok(maximizeGroup(design(), "right")), "assets-1", "right", "center")).maximizedGroupId).toBe("right");
    expect(ok(moveGroup(ok(maximizeGroup(design(), "right")), "left", "right", "center")).maximizedGroupId).toBe("right");
  });

  it("refuses a tab position that is not a number, as reordering does, and rounds a fraction down", () => {
    const frozen = deepFreeze(design());
    expect(refusal(movePanel(frozen, "objects-1", "timeline-group", "center", Number.NaN))).toMatchObject({ code: "INVALID_DOCK_TARGET", refused: "a tab cannot be put at a place that is not a number" });
    expect(refusal(movePanel(frozen, "objects-1", "timeline-group", "center", Infinity)).code).toBe("INVALID_DOCK_TARGET");
    expect(group(ok(movePanel(design(), "objects-1", "timeline-group", "center", 1.9)), "timeline-group").panelInstanceIds).toEqual(["timeline-1", "objects-1", "curves-1"]);
    expect(group(ok(movePanel(design(), "objects-1", "timeline-group", "center", -3)), "timeline-group").panelInstanceIds).toEqual(["objects-1", "timeline-1", "curves-1"]);
  });

  it("looks a panel up as its own record only", () => {
    expect(instanceOf(design(), "objects-1")?.panelType).toBe("object-manager");
    expect(instanceOf(design(), "constructor")).toBeUndefined();
    expect(instanceOf(design(), "toString")).toBeUndefined();
    expect(refusal(closePanel(design(), "constructor")).code).toBe("PANEL_NOT_AVAILABLE");
  });
});
