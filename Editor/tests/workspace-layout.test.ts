// The dockable workspace layout (11.5).
//
// The interesting failures are all in reconciliation: a stored layout is
// always slightly wrong because panels come and go between builds, and the
// choice is between reporting that and losing a panel silently.

import { describe, expect, it } from "vitest";

import {
  allPanels,
  defaultLayout,
  isRefused,
  LAYOUT_STORAGE_KEY,
  LAYOUT_VERSION,
  movePanel,
  persistLayout,
  CARD_SORT_LAYOUT,
  regionOf,
  resizeRegion,
  restoreLayout,
  setCollapsed,
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
    expect(source.regions.right.panels).toContain("control-contract");
  });

  it("places every panel exactly once", () => {
    const panels = allPanels(CARD_SORT_LAYOUT);
    expect(new Set(panels).size).toBe(panels.length);
  });
});
