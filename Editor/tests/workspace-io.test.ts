// Reading, migrating and converting a saved workspace (11.92, 11.94): what is refused and what is kept.
import { describe, expect, it } from "vitest";
import { WORKSPACE_SCHEMA_VERSION, allNodes, findGroup, instanceIdsInOrder, isDockRefused, type DockRefusal, type SavedWorkspace, type SplitNode } from "../src/dock-model";
import { validateWorkspace } from "../src/dock-validate";
import { migrateWorkspace, parseWorkspaceText, readWorkspace, serializeWorkspace, workspaceFromLayout, type MigrationResult } from "../src/workspace-io";
import { CARD_SORT_LAYOUT, activateTab, allPanels, defaultLayout, groupPanels, movePanel as moveLayoutPanel, resizeRegion, setCollapsed, splitRegion, isRefused as layoutRefused, type Layout } from "../src/workspace-layout";
import { design } from "./dock-fixtures";

const refusal = (result: unknown): DockRefusal => {
  if (!isDockRefused(result as DockRefusal)) throw new Error(`not refused: ${JSON.stringify(result).slice(0, 80)}`);
  return result as DockRefusal;
};
/** The row of left dock, centre and right dock, which sits over the timeline. */
const topRow = (workspace: SavedWorkspace): SplitNode => (workspace.root as SplitNode).children[0] as SplitNode;
const migrated = (result: MigrationResult | DockRefusal): MigrationResult => {
  if (isDockRefused(result)) throw new Error(`refused: ${result.refused}`);
  return result;
};

describe("writing and reading a layout", () => {
  it("returns what was written, and the layout breaks no rule", () => {
    const text = serializeWorkspace(design());
    const back = migrated(parseWorkspaceText(text));
    expect(back.workspace).toEqual(design());
    expect(back.migrated).toBe(false);
    expect(back.renamed).toEqual([]);
  });

  it("keeps the interface state and the metadata it was given", () => {
    const rich: SavedWorkspace = {
      ...design(),
      maximizedGroupId: "viewport-group",
      activeGroupId: "left",
      metadata: { updatedAt: "2026-11-23T10:00:00Z", description: "Mine" },
      viewState: { "objects-1": { columns: ["name"] } },
      instances: { ...design().instances, "inspector-1": { instanceId: "inspector-1", panelType: "inspector", context: { mode: "pinned", entityId: "rect-1" }, viewStateRef: "inspector-1" } },
    };
    expect(readWorkspace(JSON.parse(serializeWorkspace(rich)))).toEqual(rich);
  });

  it("refuses text that is not JSON, and JSON that is not a layout, by name", () => {
    expect(refusal(parseWorkspaceText("{ nope")).refused).toBe(
      "this file is not a GrapiX layout: its contents could not be read. Choose a layout that GrapiX exported. Nothing was changed.",
    );
    expect(refusal(parseWorkspaceText("[]")).refused).toBe("this is not a layout file: it does not hold a layout. Choose a layout that GrapiX exported. Nothing was changed.");
    expect(refusal(parseWorkspaceText("null")).code).toBe("LAYOUT_VALIDATION_FAILED");
    expect(refusal(parseWorkspaceText('{"schemaVersion":"1"}')).refused).toContain("schemaVersion must be a whole number");
    expect(refusal(parseWorkspaceText('{"schemaVersion":0}')).code).toBe("LAYOUT_VALIDATION_FAILED");
    expect(refusal(parseWorkspaceText('{"schemaVersion":1.5}')).code).toBe("LAYOUT_VALIDATION_FAILED");
  });

  it("refuses a shape that is wrong anywhere, naming where", () => {
    const base = (): Record<string, unknown> => JSON.parse(serializeWorkspace(design())) as Record<string, unknown>;
    const wrong = (edit: (raw: Record<string, unknown>) => void): string => {
      const raw = base();
      edit(raw);
      return refusal(readWorkspace(raw)).refused;
    };
    expect(wrong((raw) => (raw["app"] = "both"))).toContain("app must be editor or playout");
    expect(wrong((raw) => (raw["origin"] = "me"))).toContain("origin must be factory or user");
    expect(wrong((raw) => delete raw["name"])).toContain("name must be a word or more");
    expect(wrong((raw) => (raw["instances"] = []))).toContain("instances must be an object");
    expect(wrong((raw) => (raw["floats"] = {}))).toContain("floats must be a list");
    expect(wrong((raw) => ((raw["root"] as { kind: string }).kind = "grid"))).toContain("root.kind must be a group of tabs or a split");
    expect(wrong((raw) => ((raw["root"] as { direction: string }).direction = "diagonal"))).toContain("root.direction must be horizontal or vertical");
    expect(wrong((raw) => ((raw["root"] as { weights: unknown[] }).weights[1] = "0.6"))).toContain("root.weights[1] must be a number");
    expect(wrong((raw) => ((raw["root"] as { children: { panelInstanceIds: unknown[] }[] }).children[0]!.panelInstanceIds[0] = 7))).toContain("root.children[0].panelInstanceIds[0] must be a word or more");
    expect(wrong((raw) => ((raw["root"] as { children: { activePanelInstanceId: unknown }[] }).children[0]!.activePanelInstanceId = 3))).toContain("activePanelInstanceId must be a panel id or null");
    expect(wrong((raw) => ((raw["instances"] as Record<string, Record<string, unknown>>)["objects-1"]!["panelType"] = ""))).toContain("instances.objects-1.panelType");
    expect(wrong((raw) => ((raw["instances"] as Record<string, Record<string, unknown>>)["objects-1"]!["context"] = { mode: "stuck" }))).toContain("context.mode must be follow or pinned");
    expect(wrong((raw) => (raw["maximizedGroupId"] = 4))).toContain("maximizedGroupId must be a word");
    expect(wrong((raw) => (raw["metadata"] = { updatedAt: 3 }))).toContain("metadata.updatedAt");
    expect(wrong((raw) => (raw["floats"] = [{ id: "f", root: (raw["root"] as object), bounds: { x: 0, y: 0, width: "10", height: 1 } }]))).toContain("floats[0].bounds.width must be a number");
  });

  it("refuses a layout that is the right shape but breaks a rule, naming the rule", () => {
    const raw = JSON.parse(serializeWorkspace(design())) as { root: { weights: number[] } };
    raw.root.weights = [0.9, 0.9, 0.9];
    const result = refusal(readWorkspace(raw));
    expect(result.code).toBe("LAYOUT_VALIDATION_FAILED");
    expect(result.refused).toBe("the layout breaks rule 4: the weights of split root do not add up to one");
    expect(result.problems).toHaveLength(1);
    const two = JSON.parse(serializeWorkspace({ ...design(), viewState: { password: "x" } })) as { root: { weights: number[] } };
    two.root.weights = [0.9, 0.9, 0.9];
    expect(refusal(readWorkspace(two)).refused).toContain("(and 1 more)");
  });

  it("refuses a tree nested past sixty-four levels without running out of stack", () => {
    let node: Record<string, unknown> = { kind: "tabs", id: "leaf", panelInstanceIds: [], activePanelInstanceId: null };
    for (let i = 0; i < 200; i += 1) node = { kind: "split", id: `s${i}`, direction: "horizontal", weights: [1], children: [node] };
    const raw = { ...(JSON.parse(serializeWorkspace(design())) as Record<string, unknown>), root: node };
    expect(refusal(readWorkspace(raw)).refused).toContain("no deeper than 64 levels");
  });
});

describe("a layout from another version", () => {
  it("refuses a newer schema, saying nothing was changed, and does not read it", () => {
    const raw = { ...JSON.parse(serializeWorkspace(design())), schemaVersion: WORKSPACE_SCHEMA_VERSION + 1 };
    const result = refusal(migrateWorkspace(raw));
    expect(result.code).toBe("LAYOUT_SCHEMA_NEWER");
    expect(result.refused).toContain("saved by a newer GrapiX");
    expect(result.refused).toContain("Nothing was changed.");
  });

  it("does not change the value it was given", () => {
    const raw = JSON.parse(serializeWorkspace(design())) as { instances: Record<string, { panelType: string }> };
    const before = JSON.stringify(raw);
    migrated(migrateWorkspace(raw, { "object-manager": "objects" }));
    expect(JSON.stringify(raw)).toBe(before);
  });

  it("keeps a renamed panel's place under its new name, follows a chain of renames, and says what was renamed", () => {
    const raw = JSON.parse(serializeWorkspace(design())) as unknown;
    const result = migrated(migrateWorkspace(raw, { "object-manager": "objects", objects: "object-tree", "curve-editor": "graph" }));
    expect(result.workspace.instances["objects-1"]?.panelType).toBe("object-tree");
    expect(result.workspace.instances["curves-1"]?.panelType).toBe("graph");
    expect([...result.renamed].sort()).toEqual(["curve-editor -> graph", "object-manager -> objects", "objects -> object-tree"]);
    expect(findGroup(result.workspace, "left")?.panelInstanceIds).toEqual(["objects-1", "assets-1"]);
    expect(validateWorkspace(result.workspace)).toEqual([]);
  });

  it("does not loop on a rename that names itself back", () => {
    const raw = JSON.parse(serializeWorkspace(design())) as unknown;
    expect(() => migrateWorkspace(raw, { "object-manager": "objects", objects: "object-manager" })).not.toThrow();
  });
});

describe("a four-region layout (version 3) becomes a workspace", () => {
  const converted = (layout: Layout = defaultLayout()): SavedWorkspace => workspaceFromLayout(layout, { workspaceId: "user.migrated", name: "Mine", origin: "user" });

  it("breaks no rule, and keeps every panel exactly once", () => {
    const workspace = converted();
    expect(validateWorkspace(workspace)).toEqual([]);
    const types = instanceIdsInOrder(workspace).map((id) => workspace.instances[id]!.panelType);
    expect([...types].sort()).toEqual([...allPanels(CARD_SORT_LAYOUT)].sort());
    expect(Object.keys(workspace.instances).sort()).toEqual(instanceIdsInOrder(workspace).sort());
    expect(workspace.app).toBe("editor");
    expect(workspace.schemaVersion).toBe(WORKSPACE_SCHEMA_VERSION);
  });

  it("puts the timeline under all three columns, across the whole width, as the four-region page showed it", () => {
    const root = converted().root as SplitNode;
    expect(root.direction).toBe("vertical");
    expect(root.children.map((child) => child.id)).toEqual(["top-row", "timeline-group"]);
    expect(root.weights[0]).toBeCloseTo(0.66);
    expect(root.weights[1]).toBeCloseTo(0.34);
    const row = root.children[0] as SplitNode;
    expect(row.direction).toBe("horizontal");
    expect(row.children.map((child) => child.id)).toEqual(["left-column", "viewport-group", "right-column"]);
  });

  it("gives each side dock the share of the width it had, and the centre the rest", () => {
    // The page set the left and right widths from their sizes and let the centre take what was left; the
    // centre's own stored size (0.55) was never used, so it is not used here either.
    const row = topRow(converted());
    expect(row.weights[0]).toBeCloseTo(0.19);
    expect(row.weights[1]).toBeCloseTo(0.6);
    expect(row.weights[2]).toBeCloseTo(0.21);
    let wide: Layout = defaultLayout();
    for (const region of ["left", "right"] as const) {
      const next = resizeRegion(wide, region, 0.4);
      if (layoutRefused(next)) throw new Error(next.refused);
      wide = next;
    }
    const dragged = topRow(converted(wide));
    expect(dragged.weights[0]).toBeCloseTo(0.4);
    expect(dragged.weights[1]).toBeCloseTo(0.2);
    expect(dragged.weights[2]).toBeCloseTo(0.4);
    // Docks dragged so wide that nothing is left still leave the centre a strip.
    const squeezed: Layout = { ...wide, regions: { ...wide.regions, left: { ...wide.regions.left, size: 0.6 }, right: { ...wide.regions.right, size: 0.6 } } };
    const least = topRow(converted(squeezed));
    // 0.6 : 0.1 : 0.6, scaled to one.
    expect(least.weights[0]).toBeCloseTo(0.6 / 1.3);
    expect(least.weights[1]).toBeCloseTo(0.1 / 1.3);
    expect(least.weights.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1);
  });

  it("keeps each tab group with its tabs in order and its showing tab", () => {
    const workspace = converted();
    const delivery = findGroup(workspace, "delivery-group")!;
    expect(delivery.panelInstanceIds.map((id) => workspace.instances[id]!.panelType)).toEqual(["take-page", "control-contract", "bindings", "publish"]);
    expect(workspace.instances[delivery.activePanelInstanceId!]!.panelType).toBe("take-page");
    const inspector = findGroup(workspace, "inspector-group")!;
    expect(workspace.instances[inspector.activePanelInstanceId!]!.panelType).toBe("inspector");
    // A panel that was not in a group is a group of one, named after it.
    expect(findGroup(workspace, "viewport-group")?.panelInstanceIds).toEqual(["viewport-1"]);
  });

  it("applies the heights the author dragged, only to the entries they were measured for", () => {
    const base = defaultLayout();
    const split = layoutRefused(base) ? base : splitRegion(base, "left", ["scene-manager", "object-manager", "assets", "delivery-group"], [0.1, 0.2, 0.3, 0.4]);
    if (layoutRefused(split)) throw new Error(split.refused);
    const left = topRow(converted(split)).children[0] as SplitNode;
    expect(left.weights).toEqual([0.1, 0.2, 0.3, 0.4]);
    // A split that no longer matches the entries is ignored: equal shares.
    const stale = splitRegion(base, "left", ["scene-manager", "object-manager"], [0.5, 0.5]);
    if (!layoutRefused(stale)) {
      const left2 = topRow(converted(stale)).children[0] as SplitNode;
      expect(left2.weights.every((weight) => Math.abs(weight - 0.25) < 1e-9)).toBe(true);
    }
  });

  it("keeps a collapsed dock's panels as a narrow strip, and drops a dock with none", () => {
    const collapsed = setCollapsed(defaultLayout(), "right", true);
    if (layoutRefused(collapsed)) throw new Error(collapsed.refused);
    const workspace = converted(collapsed);
    expect(topRow(workspace).weights[2]).toBeLessThan(0.05);
    // The centre takes what the collapsed dock gave up.
    expect(topRow(workspace).weights[1]).toBeCloseTo(1 - 0.19 - 0.03);
    expect(validateWorkspace(workspace)).toEqual([]);
    const empty: Layout = { ...defaultLayout(), regions: { ...defaultLayout().regions, bottom: { ...defaultLayout().regions.bottom, panels: [], groups: [] } } };
    const without = converted(empty);
    const middle = (without.root as SplitNode).children[1]!;
    expect(middle.id).toBe("viewport-group");
    expect(validateWorkspace(without)).toEqual([]);
  });

  it("is the same whatever the author did to the layout first", () => {
    let layout: Layout = defaultLayout();
    for (const step of [
      (l: Layout) => moveLayoutPanel(l, "materials", "left", 0),
      (l: Layout) => groupPanels(l, "left", ["scene-manager", "object-manager"], "pair"),
      (l: Layout) => resizeRegion(l, "left", 0.3),
    ]) {
      const next = step(layout);
      if (layoutRefused(next)) continue;
      layout = next;
    }
    const workspace = converted(layout);
    expect(validateWorkspace(workspace)).toEqual([]);
    expect(instanceIdsInOrder(workspace)).toHaveLength(allPanels(layout).length);
    expect(allNodes(workspace).every((node) => node.id !== "")).toBe(true);
  });

  it("is a valid empty workspace when the layout has no panels, and one column when it has one dock", () => {
    const regions = defaultLayout().regions;
    const none: Layout = {
      ...defaultLayout(),
      regions: {
        left: { ...regions.left, panels: [], groups: [] },
        centre: { ...regions.centre, panels: [], groups: [] },
        right: { ...regions.right, panels: [], groups: [] },
        bottom: { ...regions.bottom, panels: [], groups: [] },
      },
    };
    const nothing = converted(none);
    expect(nothing.root.kind).toBe("tabs");
    expect(validateWorkspace(nothing)).toEqual([]);
    const justCentre: Layout = { ...none, regions: { ...none.regions, centre: { ...none.regions.centre, panels: ["viewport"] } } };
    expect(converted(justCentre).root.id).toBe("viewport-group");
  });
});

describe("what the survivors of the mutant run showed was not held (11.94)", () => {
  it("ignores dragged heights that were measured for different entries, in a layout read from storage", () => {
    const base = defaultLayout();
    const stale: Layout = {
      ...base,
      regions: { ...base.regions, left: { ...base.regions.left, split: { entries: ["something-else"], fractions: [1] } } },
    };
    const left = topRow(workspaceFromLayout(stale, { workspaceId: "u", name: "U", origin: "user" })).children[0] as SplitNode;
    expect(left.weights.every((weight) => Math.abs(weight - 0.25) < 1e-9)).toBe(true);
    // The same number of entries but different ones: heights measured for other panels are not applied either.
    const other: Layout = {
      ...base,
      regions: { ...base.regions, left: { ...base.regions.left, split: { entries: ["a", "b", "c", "d"], fractions: [0.1, 0.2, 0.3, 0.4] } } },
    };
    const sameCount = topRow(workspaceFromLayout(other, { workspaceId: "u", name: "U", origin: "user" })).children[0] as SplitNode;
    expect(sameCount.weights.every((weight) => Math.abs(weight - 0.25) < 1e-9)).toBe(true);
    const fitting: Layout = {
      ...base,
      regions: { ...base.regions, left: { ...base.regions.left, split: { entries: ["scene-manager", "object-manager", "assets", "delivery-group"], fractions: [0.1, 0.2, 0.3, 0.4] } } },
    };
    const fits = topRow(workspaceFromLayout(fitting, { workspaceId: "u", name: "U", origin: "user" })).children[0] as SplitNode;
    expect(fits.weights).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("keeps the showing tab of a group when it is not the first tab", () => {
    const shown = activateTab(defaultLayout(), "publish");
    if (layoutRefused(shown)) throw new Error(shown.refused);
    const workspace = workspaceFromLayout(shown, { workspaceId: "u", name: "U", origin: "user" });
    const delivery = findGroup(workspace, "delivery-group")!;
    expect(workspace.instances[delivery.activePanelInstanceId!]!.panelType).toBe("publish");
    expect(delivery.panelInstanceIds[0]).not.toBe(delivery.activePanelInstanceId);
  });
});

describe("what the code review of 23 Nov found (11.92, 11.94)", () => {
  const convert = (layout: Layout): SavedWorkspace => workspaceFromLayout(layout, { workspaceId: "u", name: "U", origin: "user" });

  it("gives a panel torn out of a tab group a group id that the group it left does not have", () => {
    // The lone Inspector's group would be named `inspector-group`, which is what the group it left is called.
    const torn = moveLayoutPanel(defaultLayout(), "inspector", "left", 0);
    if (layoutRefused(torn)) throw new Error(torn.refused);
    const workspace = convert(torn);
    expect(validateWorkspace(workspace)).toEqual([]);
    const ids = allNodes(workspace).map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The author's tab group keeps its id; the lone panel's group steps aside.
    expect(findGroup(workspace, "inspector-group")!.panelInstanceIds).toEqual(["pivot-1", "masks-1", "animation-1", "effect-controls-1", "text-styles-1", "fonts-1"]);
    expect(findGroup(workspace, "inspector-group-2")!.panelInstanceIds).toEqual(["inspector-1"]);
  });

  it("comes out in the one form the dock model keeps: a stacked column is joined to the stacked root", () => {
    const base = defaultLayout();
    const stacked: Layout = {
      ...base,
      regions: {
        left: { ...base.regions.left, panels: [], groups: [] },
        centre: { ...base.regions.centre, panels: ["viewport", "assets"] },
        right: { ...base.regions.right, panels: [], groups: [] },
        bottom: base.regions.bottom,
      },
    };
    const workspace = convert(stacked);
    expect(validateWorkspace(workspace)).toEqual([]);
    const root = workspace.root as SplitNode;
    expect(root.direction).toBe("vertical");
    expect(root.children.map((child) => child.id)).toEqual(["viewport-group", "assets-group", "timeline-group"]);
    expect(root.weights[0]).toBeCloseTo(0.33);
    expect(root.weights[1]).toBeCloseTo(0.33);
    expect(root.weights[2]).toBeCloseTo(0.34);
  });

  it("does not clash with a tab group the author named like one of the names it invents", () => {
    for (const name of ["root", "top-row", "left-column", "viewport-group", "timeline-group"]) {
      const grouped = groupPanels(defaultLayout(), "left", ["scene-manager", "object-manager"], name);
      if (layoutRefused(grouped)) throw new Error(grouped.refused);
      const workspace = convert(grouped);
      expect(validateWorkspace(workspace), name).toEqual([]);
      expect(findGroup(workspace, name)!.panelInstanceIds, name).toEqual(["scene-manager-1", "object-manager-1"]);
    }
  });

  it("refuses a panel id that only exists on every object, and an instance table keyed __proto__", () => {
    const raw = JSON.parse(serializeWorkspace(design())) as { root: unknown; instances: Record<string, unknown> };
    raw.root = { kind: "tabs", id: "g", panelInstanceIds: ["constructor"], activePanelInstanceId: "constructor" };
    raw.instances = {};
    expect(refusal(readWorkspace(raw)).refused).toContain("panel constructor is in the layout but has no instance record");
    const proto = JSON.parse(serializeWorkspace(design()).replace('"objects-1": {', '"__proto__": {')) as unknown;
    expect(refusal(readWorkspace(proto)).refused).toContain("instances.__proto__ must be a panel id");
  });

  it("does not follow a rename through a name every object has", () => {
    const raw = JSON.parse(serializeWorkspace(design())) as { instances: Record<string, { panelType: string }> };
    raw.instances["objects-1"]!.panelType = "constructor";
    const result = migrated(migrateWorkspace(raw, { "curve-editor": "graph" }));
    expect(result.workspace.instances["objects-1"]!.panelType).toBe("constructor");
    expect(result.renamed).toEqual(["curve-editor -> graph"]);
  });

  it("says what to do with a layout from a newer GrapiX, and with a file that is not a layout", () => {
    const newer = refusal(migrateWorkspace({ ...JSON.parse(serializeWorkspace(design())), schemaVersion: 9 }));
    expect(newer.refused).toContain("Open it with that version, or use a layout saved by this one.");
    const raw = JSON.parse(serializeWorkspace(design())) as { root: { kind: string } };
    raw.root.kind = "grid";
    expect(refusal(readWorkspace(raw)).refused).toBe(
      "this is not a layout GrapiX can read: root.kind must be a group of tabs or a split. The file may be damaged or made by something else. Nothing was changed.",
    );
  });
});
