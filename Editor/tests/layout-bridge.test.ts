import { describe, expect, it } from "vitest";

import { validateWorkspace } from "../src/dock-validate";
import { PAGE_LAYOUT_KEY, isUnavailable, pageLayoutOf, workspaceWithPageLayout } from "../src/layout-bridge";
import { parseWorkspaceText, serializeWorkspace, workspaceFromLayout } from "../src/workspace-io";
import { CARD_SORT_LAYOUT, isRefused, movePanel, type Layout } from "../src/workspace-layout";

const meta = { workspaceId: "user.mine", name: "Mine", origin: "user", app: "editor" } as const;
const panels = (layout: Layout): string[] => Object.values(layout.regions).flatMap((r) => [...r.panels]);

describe("a workspace carries the page's own layout beside its tree", () => {
  it("gives back the layout it was made from", () => {
    const ws = workspaceWithPageLayout(CARD_SORT_LAYOUT, meta);
    const read = pageLayoutOf(ws, panels(CARD_SORT_LAYOUT));
    expect(isUnavailable(read)).toBe(false);
    if (!isUnavailable(read)) {
      expect(read.layout).toEqual(CARD_SORT_LAYOUT);
      expect(read.notes).toEqual([]);
    }
  });

  it("gives back a layout the author changed", () => {
    const moved = movePanel(CARD_SORT_LAYOUT, "inspector", "left");
    if (isRefused(moved)) throw new Error(moved.refused);
    const read = pageLayoutOf(workspaceWithPageLayout(moved, meta), panels(moved));
    expect(isUnavailable(read)).toBe(false);
    if (!isUnavailable(read)) expect(read.layout.regions.left.panels).toContain("inspector");
  });

  it("is a workspace that passes the layout rules and survives being written and read", () => {
    const ws = workspaceWithPageLayout(CARD_SORT_LAYOUT, meta);
    expect(validateWorkspace(ws)).toEqual([]);
    const back = parseWorkspaceText(serializeWorkspace(ws));
    expect("workspace" in back).toBe(true);
    if ("workspace" in back) expect(pageLayoutOf(back.workspace, panels(CARD_SORT_LAYOUT))).toEqual({ layout: CARD_SORT_LAYOUT, notes: [] });
  });
});

describe("a workspace the page cannot show is refused by name, not guessed at", () => {
  it("one made elsewhere, with no layout carried", () => {
    const read = pageLayoutOf(workspaceFromLayout(CARD_SORT_LAYOUT, meta), panels(CARD_SORT_LAYOUT));
    expect(read).toEqual({ unavailable: expect.stringContaining("was not arranged on this page") });
  });

  it("one whose tree was changed after the page saved it", () => {
    const ws = workspaceWithPageLayout(CARD_SORT_LAYOUT, meta);
    const edited = { ...ws, root: { kind: "tabs", id: "root", panelInstanceIds: [], activePanelInstanceId: null } } as typeof ws;
    expect(pageLayoutOf(edited, panels(CARD_SORT_LAYOUT))).toEqual({ unavailable: expect.stringContaining("do not agree") });
  });

  it("one whose carried layout is not a layout", () => {
    const ws = workspaceWithPageLayout(CARD_SORT_LAYOUT, meta);
    for (const nonsense of [7, "text", null, { regions: 3 }]) {
      const read = pageLayoutOf({ ...ws, viewState: { [PAGE_LAYOUT_KEY]: nonsense } }, panels(CARD_SORT_LAYOUT));
      expect(isUnavailable(read)).toBe(true);
    }
  });
});

describe("a panel this build no longer has is dropped and said so, not a refusal", () => {
  it("reconciles the carried layout against today's panels", () => {
    const ws = workspaceWithPageLayout(CARD_SORT_LAYOUT, meta);
    const today = panels(CARD_SORT_LAYOUT).filter((p) => p !== "bindings");
    const read = pageLayoutOf(ws, today);
    expect(isUnavailable(read)).toBe(false);
    if (!isUnavailable(read)) {
      expect(panels(read.layout)).not.toContain("bindings");
      expect(read.notes.join(" ")).toContain("bindings");
    }
  });
});
