// The dockable workspace layout (11.5).
//
// The interesting failures are all in reconciliation: a stored layout is
// always slightly wrong because panels come and go between builds, and the
// choice is between reporting that and losing a panel silently.

import { describe, expect, it } from "vitest";

import {
  activateTab,
  allPanels,
  clearSplit,
  defaultLayout,
  dragSplitter,
  entryIds,
  floorFractions,
  groupOf,
  groupPanels,
  isRefused,
  LAYOUT_STORAGE_KEY,
  LAYOUT_VERSION,
  movePanel,
  moveToGroup,
  persistLayout,
  CARD_SORT_LAYOUT,
  regionEntries,
  regionOf,
  resizeRegion,
  restoreLayout,
  setCollapsed,
  splitRegion,
  ungroup,
  MIN_SPLIT,
  type Layout,
  type LayoutStorage,
} from "../src/workspace-layout";

function storage(initial?: string): LayoutStorage & { value: string | null } {
  return {
    value: initial ?? null,
    getItem() {
      return this.value;
    },
    setItem(_key: string, next: string) {
      this.value = next;
    },
  };
}

const KNOWN = allPanels(CARD_SORT_LAYOUT);

function expectLayout(result: Layout | { refused: string }): Layout {
  if (isRefused(result)) throw new Error(`unexpected refusal: ${result.refused}`);
  return result;
}

describe("moving panels", () => {
  it("moves a panel to another region and keeps it out of the old one", () => {
    const moved = expectLayout(movePanel(defaultLayout(), "fonts", "left"));
    expect(regionOf(moved, "fonts")).toBe("left");
    expect(moved.regions.right.panels).not.toContain("fonts");
  });

  it("honours an explicit index", () => {
    const moved = expectLayout(movePanel(defaultLayout(), "fonts", "left", 0));
    expect(moved.regions.left.panels[0]).toBe("fonts");
  });

  it("clamps an out-of-range index rather than refusing a drag that overshot", () => {
    const moved = expectLayout(movePanel(defaultLayout(), "fonts", "left", 999));
    expect(moved.regions.left.panels.at(-1)).toBe("fonts");
  });

  it("refuses an unknown panel and an unknown region, by name", () => {
    const noPanel = movePanel(defaultLayout(), "nonexistent", "left");
    expect(isRefused(noPanel) && noPanel.refused).toContain("no panel nonexistent");
    const noRegion = movePanel(defaultLayout(), "fonts", "nowhere" as never);
    expect(isRefused(noRegion) && noRegion.refused).toContain("no region nowhere");
  });

  it("refuses to dock the viewport away, carrying the reason", () => {
    // A workspace that can hide its primary surface can be broken into a
    // state with no way back except clearing storage.
    const refusal = movePanel(defaultLayout(), "viewport", "right");
    expect(isRefused(refusal) && refusal.refused).toContain("cannot be docked away");
  });

  it("refuses to empty a required region", () => {
    const layout = defaultLayout();
    expect(layout.regions.centre.panels).toEqual(["viewport"]);
    const refusal = movePanel(layout, "viewport", "bottom");
    expect(isRefused(refusal)).toBe(true);
  });

  it("leaves the original layout untouched", () => {
    // Operations return a new layout; a caller holding the previous one for
    // undo must still have it.
    const before = defaultLayout();
    movePanel(before, "fonts", "left");
    expect(regionOf(before, "fonts")).toBe("right");
  });
});

describe("regions", () => {
  it("clamps a resize instead of refusing an overshot drag", () => {
    expect(expectLayout(resizeRegion(defaultLayout(), "left", 5)).regions.left.size).toBe(0.9);
    expect(expectLayout(resizeRegion(defaultLayout(), "left", -1)).regions.left.size).toBe(0.05);
  });

  it("collapses a region but refuses to collapse a required one", () => {
    expect(expectLayout(setCollapsed(defaultLayout(), "bottom", true)).regions.bottom.collapsed).toBe(
      true,
    );
    const refusal = setCollapsed(defaultLayout(), "centre", true);
    expect(isRefused(refusal) && refusal.refused).toContain("cannot be collapsed");
  });
});

describe("persistence and reconciliation", () => {
  it("returns the default when nothing is stored", () => {
    const { layout, notes } = restoreLayout(storage(), KNOWN);
    expect(layout).toEqual(defaultLayout());
    expect(notes).toEqual([]);
  });

  it("round-trips a moved panel", () => {
    const store = storage();
    const moved = expectLayout(movePanel(defaultLayout(), "fonts", "left", 0));
    persistLayout(store, moved);
    const { layout, notes } = restoreLayout(store, KNOWN);
    expect(regionOf(layout, "fonts")).toBe("left");
    expect(notes).toEqual([]);
  });

  it("drops a panel this build no longer has, and says so", () => {
    const store = storage();
    const stale = expectLayout(movePanel(defaultLayout(), "fonts", "left"));
    persistLayout(store, {
      ...stale,
      regions: {
        ...stale.regions,
        left: { ...stale.regions.left, panels: [...stale.regions.left.panels, "retired-panel"] },
      },
    });
    const { layout, notes } = restoreLayout(store, KNOWN);
    expect(allPanels(layout)).not.toContain("retired-panel");
    expect(notes.join(" ")).toContain("dropped retired-panel");
  });

  it("adds a panel that is new since the layout was saved rather than losing it", () => {
    // Without this a panel added in a new build would be invisible to every
    // author who had ever saved a layout — and nothing would report it.
    const store = storage();
    persistLayout(store, defaultLayout());
    const { layout, notes } = restoreLayout(store, [...KNOWN, "brand-new-panel"]);
    expect(allPanels(layout)).toContain("brand-new-panel");
    expect(notes.join(" ")).toContain("brand-new-panel");
  });

  it("refuses a layout from a newer schema rather than applying part of it", () => {
    const store = storage(JSON.stringify({ version: LAYOUT_VERSION + 1, regions: {} }));
    const { layout, notes } = restoreLayout(store, KNOWN);
    expect(layout).toEqual(defaultLayout());
    expect(notes.join(" ")).toContain("newer than this build understands");
  });

  it("resets rather than crashing on unreadable storage", () => {
    const { layout, notes } = restoreLayout(storage("{not json"), KNOWN);
    expect(layout).toEqual(defaultLayout());
    expect(notes.join(" ")).toContain("unreadable");
  });

  it("restores panels a stored layout left out entirely", () => {
    // A layout saved with empty regions is degenerate but real — an author
    // who collapsed everything, or a bad write. Every known panel is then
    // "new since saved" and returns to its default home, which is why the
    // required-region net below it rarely fires. What matters is that the
    // viewport comes back and the reconciliation says what it did, rather
    // than the Editor opening with no primary surface and no explanation.
    const store = storage(
      JSON.stringify({
        version: LAYOUT_VERSION,
        regions: {
          left: { panels: [], size: 0.2, collapsed: false },
          centre: { panels: [], size: 0.5, collapsed: false },
          right: { panels: [], size: 0.2, collapsed: false },
          bottom: { panels: [], size: 0.3, collapsed: false },
        },
      }),
    );
    const { layout, notes } = restoreLayout(store, KNOWN);
    expect(layout.regions.centre.panels).toContain("viewport");
    expect(notes.join(" ")).toContain("viewport");
    // Every panel is accounted for exactly once, not duplicated by the two
    // recovery paths overlapping.
    const panels = allPanels(layout);
    expect(new Set(panels).size).toBe(panels.length);
    expect(new Set(panels)).toEqual(new Set(KNOWN));
  });
});

describe("the selected card-sort layout", () => {
  it("keeps scene navigation, authoring, viewport and timeline in their selected regions", () => {
    const source = CARD_SORT_LAYOUT;
    expect(source.version).toBe(LAYOUT_VERSION);
    expect(source.regions.left.panels.slice(0, 2)).toEqual(["scene-manager", "object-manager"]);
    expect(source.regions.centre.panels).toEqual(["viewport"]);
    expect(source.regions.bottom.panels).toEqual(["timeline"]);
    expect(source.regions.right.panels).toContain("inspector");
    expect(source.regions.left.panels).toContain("control-contract");
  });

  it("places every panel exactly once", () => {
    const panels = allPanels(CARD_SORT_LAYOUT);
    expect(new Set(panels).size).toBe(panels.length);
  });
});

// 11.73: tab groups.
describe("tab groups in the default layout", () => {
  const right = CARD_SORT_LAYOUT.regions.right;
  const left = CARD_SORT_LAYOUT.regions.left;

  it("puts the right column's panels into two groups and leaves Preview on its own", () => {
    expect(right.groups.map((g) => g.id)).toEqual(["inspector-group", "library-group"]);
    expect(right.groups[0]!.panels).toEqual(["inspector", "pivot", "masks", "animation", "effect-controls", "text-styles", "fonts"]);
    expect(right.groups[1]!.panels).toEqual(["effects", "materials"]);
    expect(groupOf(CARD_SORT_LAYOUT, "preview")).toBeUndefined();
    expect(groupOf(CARD_SORT_LAYOUT, "unsupported")).toBeUndefined();
  });

  it("keeps what goes to Playout with the project, as a group at the left under Assets", () => {
    expect(left.groups.map((g) => g.id)).toEqual(["delivery-group"]);
    expect(left.groups[0]!.panels).toEqual(["take-page", "control-contract", "bindings", "publish"]);
    expect(left.panels.slice(0, 3)).toEqual(["scene-manager", "object-manager", "assets"]);
    expect(regionOf(CARD_SORT_LAYOUT, "publish")).toBe("left");
  });

  it("has valid groups: members in the region, adjacent, in order, unique, active inside", () => {
    for (const region of ["left", "centre", "right", "bottom"] as const) {
      const state = CARD_SORT_LAYOUT.regions[region];
      const claimed = new Set<string>();
      for (const group of state.groups) {
        expect(group.panels.length).toBeGreaterThanOrEqual(2);
        expect(group.panels).toContain(group.active);
        const places = group.panels.map((p) => state.panels.indexOf(p));
        expect(places.every((i) => i >= 0)).toBe(true);
        expect(places).toEqual(places.map((_, k) => places[0]! + k));
        for (const panel of group.panels) {
          expect(claimed.has(panel)).toBe(false);
          claimed.add(panel);
        }
      }
    }
  });

  it("shows each group once, at its first member's place, and every other panel on its own", () => {
    const entries = regionEntries(right);
    expect(entries.map((e) => (e.kind === "group" ? e.group.id : e.panel))).toEqual([
      "preview",
      "unsupported",
      "inspector-group",
      "library-group",
    ]);
    expect(entries.find((e) => e.kind === "group")!.index).toBe(right.panels.indexOf("inspector"));
  });
});

describe("tabs", () => {
  it("activates a tab and refuses a panel that is not in a group", () => {
    const next = expectLayout(activateTab(defaultLayout(), "fonts"));
    expect(groupOf(next, "fonts")!.group.active).toBe("fonts");
    expect(groupOf(defaultLayout(), "fonts")!.group.active).toBe("inspector");
    const refusal = activateTab(defaultLayout(), "preview");
    expect(isRefused(refusal) && refusal.refused).toContain("preview is not in a tab group");
  });

  it("tearing a tab off (moving the panel) takes it out of the group", () => {
    const moved = expectLayout(movePanel(defaultLayout(), "fonts", "left"));
    expect(groupOf(moved, "fonts")).toBeUndefined();
    expect(groupOf(moved, "inspector")!.group.panels).not.toContain("fonts");
  });

  it("a group left with one panel dissolves, and an active tab that left falls back to the first", () => {
    let layout = defaultLayout();
    layout = expectLayout(movePanel(layout, "materials", "left"));
    expect(groupOf(layout, "effects")).toBeUndefined();
    layout = expectLayout(activateTab(defaultLayout(), "animation"));
    layout = expectLayout(movePanel(layout, "animation", "left"));
    expect(groupOf(layout, "inspector")!.group.active).toBe("inspector");
  });

  it("a panel dropped between a group's members does not split the group", () => {
    const layout = expectLayout(movePanel(defaultLayout(), "preview", "right", 4));
    const group = layout.regions.right.groups[0]!;
    const places = group.panels.map((p) => layout.regions.right.panels.indexOf(p));
    expect(places).toEqual(places.map((_, k) => places[0]! + k));
  });

  it("moves a panel into a group at a tab position, from another region, and shows it", () => {
    const layout = expectLayout(moveToGroup(defaultLayout(), "assets", "library-group", 1));
    expect(regionOf(layout, "assets")).toBe("right");
    const group = groupOf(layout, "assets")!.group;
    expect(group.panels).toEqual(["effects", "assets", "materials"]);
    expect(group.active).toBe("assets");
  });

  it("reorders a group's own tabs and keeps the group, even a group of two", () => {
    const layout = expectLayout(moveToGroup(defaultLayout(), "effects", "library-group", 1));
    expect(groupOf(layout, "effects")!.group.panels).toEqual(["materials", "effects"]);
    expect(layout.regions.right.panels.indexOf("materials")).toBe(layout.regions.right.panels.indexOf("effects") - 1);
  });

  it("refuses to move the viewport into a group, an unknown group and an unknown panel, by name", () => {
    const pinned = moveToGroup(defaultLayout(), "viewport", "library-group");
    expect(isRefused(pinned) && pinned.refused).toContain("cannot be docked away");
    const noGroup = moveToGroup(defaultLayout(), "fonts", "nowhere");
    expect(isRefused(noGroup) && noGroup.refused).toContain("no tab group nowhere");
    const noPanel = moveToGroup(defaultLayout(), "ghost", "library-group");
    expect(isRefused(noPanel) && noPanel.refused).toContain("no panel ghost");
  });

  it("makes a group of ungrouped panels of one region and refuses the bad requests, by name", () => {
    const layout = expectLayout(groupPanels(defaultLayout(), "left", ["assets", "scene-manager"], "scenes-group"));
    expect(layout.regions.left.panels.slice(0, 2)).toEqual(["assets", "scene-manager"]);
    expect(groupOf(layout, "assets")!.group.active).toBe("assets");
    const reasons = [
      groupPanels(defaultLayout(), "left", ["assets"], "solo"),
      groupPanels(defaultLayout(), "left", ["assets", "fonts"], "mixed"),
      groupPanels(defaultLayout(), "right", ["fonts", "preview"], "taken"),
      groupPanels(defaultLayout(), "left", ["assets", "scene-manager"], "Bad Name"),
      groupPanels(defaultLayout(), "left", ["assets", "scene-manager"], "library-group"),
      groupPanels(defaultLayout(), "centre", ["viewport", "viewport"], "alone"),
    ].map((r) => (isRefused(r) ? r.refused : "accepted"));
    expect(reasons[0]).toContain("at least two");
    expect(reasons[1]).toContain("fonts is not in the left region");
    expect(reasons[2]).toContain("fonts is already in a tab group");
    expect(reasons[3]).toContain("not a group name");
    expect(reasons[4]).toContain("already a tab group named library-group");
    expect(reasons[5]).toContain("at least two");
  });

  it("ungroups without moving a panel, and leaves the original layout untouched", () => {
    const before = defaultLayout();
    const layout = expectLayout(ungroup(before, "library-group"));
    expect(groupOf(layout, "effects")).toBeUndefined();
    expect(layout.regions.right.panels).toEqual(before.regions.right.panels);
    expect(groupOf(before, "effects")).toBeDefined();
    const refusal = ungroup(before, "nowhere");
    expect(isRefused(refusal) && refusal.refused).toContain("no tab group nowhere");
  });
});

describe("tab groups persist and reconcile", () => {
  it("round-trips a re-activated tab and a joined group", () => {
    const store = storage();
    let layout = expectLayout(activateTab(defaultLayout(), "fonts"));
    layout = expectLayout(moveToGroup(layout, "assets", "library-group", 0));
    persistLayout(store, layout);
    const { layout: back, notes } = restoreLayout(store, KNOWN);
    expect(groupOf(back, "fonts")!.group.active).toBe("fonts");
    expect(groupOf(back, "assets")!.group.panels).toEqual(["assets", "effects", "materials"]);
    expect(notes).toEqual([]);
  });

  it("drops a member this build no longer has, dissolves a group left with one, and says so", () => {
    const stored = JSON.parse(JSON.stringify(defaultLayout())) as Layout;
    (stored.regions.right.groups[1]!.panels as string[]).push("retired-panel");
    (stored.regions.right.panels as string[]).push("retired-panel");
    persistLayout(storage(), stored);
    const store = storage(JSON.stringify(stored));
    const kept = restoreLayout(store, KNOWN);
    expect(groupOf(kept.layout, "effects")!.group.panels).toEqual(["effects", "materials"]);
    expect(kept.notes.join(" ")).toContain("dropped retired-panel");
    const thin = JSON.parse(JSON.stringify(defaultLayout())) as Layout;
    (thin.regions.right.groups[1]!.panels as string[]).splice(1, 1);
    const result = restoreLayout(storage(JSON.stringify(thin)), KNOWN);
    expect(groupOf(result.layout, "effects")).toBeUndefined();
    expect(result.notes.join(" ")).toContain("dissolved tab group library-group");
  });

  it("repairs a group whose members are not adjacent and an active tab that is not a member", () => {
    const stored = JSON.parse(JSON.stringify(defaultLayout())) as Layout;
    const panels = stored.regions.right.panels as string[];
    panels.splice(panels.indexOf("effects") + 1, 0, "preview");
    panels.splice(panels.indexOf("preview", 0), 1);
    panels.splice(panels.indexOf("materials") + 1, 0, "preview");
    (stored.regions.right.groups[1] as { active: string }).active = "not-a-member";
    const { layout } = restoreLayout(storage(JSON.stringify(stored)), KNOWN);
    const group = layout.regions.right.groups.find((g) => g.id === "library-group")!;
    expect(group.active).toBe("effects");
    const places = group.panels.map((p) => layout.regions.right.panels.indexOf(p));
    expect(places).toEqual(places.map((_, k) => places[0]! + k));
  });

  it("restores a layout stored without groups as stacked panels, and a version 2 layout as the default", () => {
    const stored = JSON.parse(JSON.stringify(defaultLayout())) as Record<string, unknown>;
    for (const region of Object.values(stored.regions as Record<string, Record<string, unknown>>)) delete region.groups;
    const stacked = restoreLayout(storage(JSON.stringify(stored)), KNOWN);
    expect(stacked.layout.regions.right.groups).toEqual([]);
    const old = restoreLayout(storage(JSON.stringify({ ...stored, version: 2 })), KNOWN);
    expect(old.layout).toEqual(defaultLayout());
    expect(old.notes.join(" ")).toContain("version 2");
  });

  it("refuses a repeated group name and keeps the first", () => {
    const stored = JSON.parse(JSON.stringify(defaultLayout())) as Layout;
    (stored.regions.right.groups[1] as { id: string }).id = "inspector-group";
    const { layout, notes } = restoreLayout(storage(JSON.stringify(stored)), KNOWN);
    expect(layout.regions.right.groups.map((g) => g.id)).toEqual(["inspector-group"]);
    expect(notes.join(" ")).toContain("repeated or invalid name");
  });
});

// 11.80: the sizes of the panels stacked in a dock.
describe("panel sizes", () => {
  const right = () => entryIds(defaultLayout().regions.right);

  it("starts with no stored sizes: a dock lays its entries out by content", () => {
    expect(defaultLayout().regions.right.split).toBeUndefined();
    expect(right()).toEqual(["preview", "unsupported", "inspector-group", "library-group"]);
  });

  it("stores the fractions of a dock's entries, normalised to one", () => {
    const layout = expectLayout(splitRegion(defaultLayout(), "right", right(), [1, 1, 4, 2]));
    const split = layout.regions.right.split!;
    expect(split.entries).toEqual(right());
    expect(split.fractions.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(split.fractions[2]).toBeCloseTo(0.5, 10);
    expect(defaultLayout().regions.right.split).toBeUndefined();
  });

  it("refuses sizes measured for other panels, too few panels, the wrong count, a tiny panel and non-numbers, by name", () => {
    const reasons = [
      splitRegion(defaultLayout(), "right", ["preview", "inspector-group"], [1, 1]),
      splitRegion(defaultLayout(), "centre", ["viewport"], [1]),
      splitRegion(defaultLayout(), "right", right(), [1, 1, 1]),
      splitRegion(defaultLayout(), "right", right(), [1, 1, 1, 0.01]),
      splitRegion(defaultLayout(), "right", right(), [1, 1, Number.NaN, 1]),
      splitRegion(defaultLayout(), "nowhere" as never, right(), [1, 1, 1, 1]),
    ].map((r) => (isRefused(r) ? r.refused : "accepted"));
    expect(reasons[0]).toContain("not the ones these sizes were measured for");
    expect(reasons[1]).toContain("nothing to divide");
    expect(reasons[2]).toContain("one size for each panel");
    expect(reasons[3]).toContain("cannot take less than");
    expect(reasons[4]).toContain("cannot take less than");
    expect(reasons[5]).toContain("no region nowhere");
  });

  it("clears the sizes of one dock and leaves the others", () => {
    let layout = expectLayout(splitRegion(defaultLayout(), "right", right(), [1, 1, 1, 1]));
    layout = expectLayout(splitRegion(layout, "left", entryIds(layout.regions.left), [1, 1, 1, 1]));
    layout = expectLayout(clearSplit(layout, "right"));
    expect(layout.regions.right.split).toBeUndefined();
    expect(layout.regions.left.split).toBeDefined();
  });

  it("forgets a dock's sizes when its entries change, and keeps them when only a tab changes", () => {
    const sized = expectLayout(splitRegion(defaultLayout(), "right", right(), [1, 1, 2, 2]));
    expect(expectLayout(activateTab(sized, "fonts")).regions.right.split).toBeDefined();
    expect(expectLayout(movePanel(sized, "preview", "left")).regions.right.split).toBeUndefined();
    expect(expectLayout(moveToGroup(sized, "preview", "library-group")).regions.right.split).toBeUndefined();
    expect(expectLayout(ungroup(sized, "library-group")).regions.right.split).toBeUndefined();
    const stackable = expectLayout(splitRegion(defaultLayout(), "left", entryIds(defaultLayout().regions.left), [1, 1, 1, 1]));
    expect(expectLayout(groupPanels(stackable, "left", ["assets", "scene-manager"], "scenes-group")).regions.left.split).toBeUndefined();
  });
});

describe("dragging a splitter", () => {
  it("trades height between the two entries beside it and leaves the rest", () => {
    const out = dragSplitter([0.2, 0.3, 0.5], 0, 0.1);
    expect(out[0]).toBeCloseTo(0.3, 10);
    expect(out[1]).toBeCloseTo(0.2, 10);
    expect(out[2]).toBe(0.5);
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("stops each neighbour at the smallest share instead of overshooting", () => {
    const down = dragSplitter([0.2, 0.3, 0.5], 0, 5);
    expect(down[1]).toBeCloseTo(MIN_SPLIT, 10);
    expect(down[0]).toBeCloseTo(0.5 - MIN_SPLIT, 10);
    const up = dragSplitter([0.2, 0.3, 0.5], 0, -5);
    expect(up[0]).toBeCloseTo(MIN_SPLIT, 10);
    expect(up[1]).toBeCloseTo(0.5 - MIN_SPLIT, 10);
  });

  it("ignores a splitter that does not exist, a delta that is not a number, and a pair too small to move", () => {
    expect(dragSplitter([0.5, 0.5], 1, 0.1)).toEqual([0.5, 0.5]);
    expect(dragSplitter([0.5, 0.5], -1, 0.1)).toEqual([0.5, 0.5]);
    expect(dragSplitter([0.5, 0.5], 0, Number.NaN)).toEqual([0.5, 0.5]);
    expect(dragSplitter([0.05, 0.05, 0.9], 0, 0.02)).toEqual([0.05, 0.05, 0.9]);
  });

  it("never changes the array it was given", () => {
    const before = [0.4, 0.6];
    dragSplitter(before, 0, 0.1);
    expect(before).toEqual([0.4, 0.6]);
  });
});

describe("panel sizes persist and reconcile", () => {
  const sizedLayout = () => {
    const base = defaultLayout();
    return expectLayout(splitRegion(base, "right", entryIds(base.regions.right), [1, 1, 3, 2]));
  };

  it("round-trips the sizes of a dock", () => {
    const store = storage();
    persistLayout(store, sizedLayout());
    const { layout, notes } = restoreLayout(store, KNOWN);
    expect(layout.regions.right.split!.entries).toEqual(entryIds(defaultLayout().regions.right));
    expect(layout.regions.right.split!.fractions[2]).toBeCloseTo(3 / 7, 10);
    expect(notes).toEqual([]);
  });

  it("normalises stored sizes that do not add up to one", () => {
    const stored = JSON.parse(JSON.stringify(sizedLayout())) as Layout;
    (stored.regions.right.split as unknown as { fractions: number[] }).fractions = [0.1, 0.1, 0.3, 0.2];
    const { layout } = restoreLayout(storage(JSON.stringify(stored)), KNOWN);
    const fractions = layout.regions.right.split!.fractions;
    expect(fractions.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(fractions[2]).toBeCloseTo(0.3 / 0.7, 10);
  });

  it("drops sizes whose entries no longer match, and says so", () => {
    const stored = JSON.parse(JSON.stringify(sizedLayout())) as Layout;
    (stored.regions.right.split!.entries as string[])[0] = "retired-entry";
    const { layout, notes } = restoreLayout(storage(JSON.stringify(stored)), KNOWN);
    expect(layout.regions.right.split).toBeUndefined();
    expect(notes.join(" ")).toContain("dropped the stored panel sizes of the right dock");
  });

  it("drops sizes that are malformed: a tiny share, a wrong count, not a number", () => {
    for (const mutate of [
      (f: number[]) => { f[0] = 0.001; },
      (f: number[]) => { f.pop(); },
      (f: unknown[]) => { f[1] = "wide"; },
    ]) {
      const stored = JSON.parse(JSON.stringify(sizedLayout())) as Layout;
      mutate(stored.regions.right.split!.fractions as never);
      const { layout, notes } = restoreLayout(storage(JSON.stringify(stored)), KNOWN);
      expect(layout.regions.right.split).toBeUndefined();
      expect(notes.join(" ")).toContain("dropped the stored panel sizes");
    }
  });

  it("drops the sizes of a dock that gained a panel since they were stored", () => {
    const { layout, notes } = restoreLayout(storage(JSON.stringify(sizedLayout())), [...KNOWN, "brand-new-panel"]);
    expect(layout.regions.right.split).toBeUndefined();
    expect(notes.join(" ")).toContain("brand-new-panel");
  });
});

describe("measured heights become sizes", () => {
  const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);

  it("adds up to one and keeps the proportions when every panel is big enough", () => {
    const out = floorFractions([100, 100, 200, 100]);
    expect(sum(out)).toBeCloseTo(1, 10);
    expect(out[2]).toBeCloseTo(0.4, 10);
    expect(out[0]).toBeCloseTo(0.2, 10);
  });

  it("lifts a hidden panel to the smallest share and still adds up to one", () => {
    // The right dock's hidden "unsupported" panel measures nothing.
    const out = floorFractions([265, 0, 190, 190]);
    expect(out[1]).toBeCloseTo(MIN_SPLIT, 10);
    expect(sum(out)).toBeCloseTo(1, 10);
    expect(out.every((f) => f >= MIN_SPLIT - 1e-12)).toBe(true);
    expect(out[2]).toBeCloseTo(out[3]!, 10);
  });

  it("lifts several small panels and takes the difference from the large ones in proportion", () => {
    const out = floorFractions([1, 2, 30, 60]);
    expect(out[0]).toBeCloseTo(MIN_SPLIT, 10);
    expect(out[1]).toBeCloseTo(MIN_SPLIT, 10);
    expect(sum(out)).toBeCloseTo(1, 10);
    // What each has above the smallest share shrinks by the same factor.
    expect((out[3]! - MIN_SPLIT) / (out[2]! - MIN_SPLIT)).toBeCloseTo((60 / 93 - MIN_SPLIT) / (30 / 93 - MIN_SPLIT), 6);
  });

  it("makes every panel equal when the dock cannot give each the smallest share, and for nothing measured", () => {
    expect(floorFractions(new Array(20).fill(10))).toEqual(new Array(20).fill(1 / 20));
    expect(floorFractions([0, 0, 0])).toEqual([1 / 3, 1 / 3, 1 / 3]);
    expect(floorFractions([])).toEqual([]);
  });

  it("treats a height that is not a number as nothing measured", () => {
    const out = floorFractions([Number.NaN, 100, 100]);
    expect(out[0]).toBeCloseTo(MIN_SPLIT, 10);
    expect(sum(out)).toBeCloseTo(1, 10);
  });

  it("gives sizes the stored form accepts, so a drag of any dock can be saved", () => {
    const base = defaultLayout();
    const entries = entryIds(base.regions.right);
    const fractions = floorFractions([265, 0, 190, 190]);
    expect(isRefused(splitRegion(base, "right", entries, fractions))).toBe(false);
  });
});
