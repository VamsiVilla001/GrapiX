// Scene Manager (11.64): one container, independent graphics, no brand-pack gate.
import { describe, expect, it } from "vitest";
import { agentView, findNode } from "../src/agent-surface";
import { graphicStatus, sceneManagerPanel, type ManagedScene } from "../src/scene-manager";

const graphic = (overrides: Partial<ManagedScene> & { sceneId: string }): ManagedScene => ({
  name: overrides.sceneId, unsavedChanges: false, ...overrides,
});

const panelFor = (scenes: ManagedScene[], query?: string) => sceneManagerPanel({
  project: "Match broadcast", scenes, ...(query === undefined ? {} : { query }),
});

describe("one scene container, multiple graphics", () => {
  it("lists independent graphics with stable addresses and command actions", () => {
    const panel = panelFor([graphic({ sceneId: "lower-third" }), graphic({ sceneId: "score" })]);
    expect(panel.label).toBe("Scene: Match broadcast");
    expect(panel.description).toBe("2 graphic(s) · independent layers and timelines");
    expect(findNode(panel, "scene-manager/list")!.children!.map(item => item.id)).toEqual(["scene/lower-third", "scene/score"]);
    expect(findNode(panel, "scene/score")!.actions!.map(a => a.name)).toEqual(["open", "duplicate", "publish", "delete"]);
    expect(JSON.stringify(agentView(panel))).not.toMatch(/design.system|conformance|unstamped/i);
  });

  it("unsaved graphics refuse publish and delete by name, while open stays safe", () => {
    const item = findNode(panelFor([graphic({ sceneId: "lower-third", name: "Lower third", unsavedChanges: true })]), "scene/lower-third")!;
    expect(item.actions!.find(a => a.name === "publish")!.unavailable).toBe("Lower third has unsaved changes");
    expect(item.actions!.find(a => a.name === "delete")!.unavailable).toBe("Lower third has unsaved changes");
    expect(item.actions!.find(a => a.name === "open")!.unavailable).toBeUndefined();
    expect(item.actions!.find(a => a.name === "duplicate")!.unavailable).toBeUndefined();
  });

  it("keeps unreadable graphics visible with a named refusal", () => {
    const reason = "scene file is unreadable: unknown field /legacy";
    const item = findNode(panelFor([graphic({ sceneId: "legacy", unavailableReason: reason })]), "scene/legacy")!;
    expect(item.description).toContain(reason);
    for (const action of ["open", "duplicate", "publish"]) expect(item.actions!.find(a => a.name === action)!.unavailable).toBe(reason);
    expect(item.actions!.find(a => a.name === "delete")!.unavailable).toBeUndefined();
  });

  it("searches name and id without changing the container count or source", () => {
    const graphics = [graphic({ sceneId: "score", name: "Live scores" }), graphic({ sceneId: "lower-third", name: "Player card" })];
    const panel = panelFor(graphics, " LOWER-THIRD ");
    expect(findNode(panel, "scene-manager/list")!.children!.map(item => item.label)).toEqual(["Player card"]);
    expect(panel.description).toContain("2 graphic(s)");
    expect(findNode(panelFor(graphics, "SCORES"), "scene-manager/list")!.children).toHaveLength(1);
    expect(findNode(panelFor(graphics, "missing"), "scene-manager/list")!.children).toHaveLength(0);
    expect(graphics).toHaveLength(2);
  });

  it("reports active, open and modified states for each graphic separately", () => {
    const panel = panelFor([
      graphic({ sceneId: "a", active: true, open: true }),
      graphic({ sceneId: "b", open: true, unsavedChanges: true }),
      graphic({ sceneId: "c" }),
    ]);
    expect(findNode(panel, "scene/a/status")!.value).toBe("Editing · Saved");
    expect(findNode(panel, "scene/b/status")!.value).toBe("Open · Unsaved changes");
    expect(findNode(panel, "scene/c/status")!.value).toBe("Saved");
    expect(findNode(panel, "scene/b")!.actions!.find(a => a.name === "publish")!.unavailable).toContain("unsaved");
  });

  it("reports publication revision independently of a design system", () => {
    expect(graphicStatus(graphic({ sceneId: "a", publishedRevision: 7 }))).toBe("Saved · Published r7");
    expect(graphicStatus(graphic({ sceneId: "a" }))).toBe("Saved");
  });

  it("exposes the same per-graphic status to agents and accessibility", () => {
    const view = agentView(panelFor([graphic({ sceneId: "a", active: true, unsavedChanges: true })]));
    const status = view.children[0]!.children[0]!.children[0]!;
    expect(status.role).toBe("status");
    expect(status.value).toBe("Editing · Unsaved changes");
  });
});
