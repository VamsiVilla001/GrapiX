// The scene / template manager and the live conformance indicator (11.16).
//
// The done-when is "drift visible as it happens, not at publish". These tests
// hold two things: that the drift status is derivable without anyone
// publishing, and that "predates stamping" never collapses into "behind" —
// reporting unknown conformance as a distance would assert a fact nobody can
// verify, and it sends someone to redo work that may be perfectly fine.

import { describe, expect, it } from "vitest";

import { agentView, findNode } from "../src/agent-surface";
import {
  conformanceLabel,
  conformanceOf,
  sceneManagerPanel,
  type ManagedScene,
} from "../src/scene-manager";

const scene = (overrides: Partial<ManagedScene> & { sceneId: string }): ManagedScene => ({
  name: overrides.sceneId,
  unsavedChanges: false,
  ...overrides,
});

describe("the scene list", () => {
  it("lists scenes with stable ids and the manager's actions", () => {
    const panel = sceneManagerPanel({
      project: "news",
      scenes: [scene({ sceneId: "lower-third" }), scene({ sceneId: "bug" })],
      currentDesignSystemVersion: 4,
    });

    const list = findNode(panel, "scene-manager/list")!;
    expect((list.children ?? []).map((item) => item.id)).toEqual([
      "scene/lower-third",
      "scene/bug",
    ]);

    const actions = findNode(panel, "scene/bug")!.actions!.map((action) => action.name);
    expect(actions).toEqual(["open", "duplicate", "publish", "delete"]);
  });

  it("unsaved work blocks publish and delete, by name", () => {
    // Publishing what is on disk while the author looks at something newer is
    // the near-miss that is only noticed on air.
    const panel = sceneManagerPanel({
      project: "news",
      scenes: [scene({ sceneId: "lower-third", name: "Lower third", unsavedChanges: true })],
      currentDesignSystemVersion: 4,
    });

    const item = findNode(panel, "scene/lower-third")!;
    const reason = "Lower third has unsaved changes";
    expect(item.actions!.find((a) => a.name === "publish")!.unavailable).toBe(reason);
    expect(item.actions!.find((a) => a.name === "delete")!.unavailable).toBe(reason);
    // Opening and duplicating are safe with unsaved work and stay available.
    expect(item.actions!.find((a) => a.name === "open")!.unavailable).toBeUndefined();
    expect(item.actions!.find((a) => a.name === "duplicate")!.unavailable).toBeUndefined();
  });

  it("keeps an unreadable file visible but disables content actions with its reason", () => {
    const reason = "scene file is unreadable: unknown field /legacy";
    const panel = sceneManagerPanel({
      project: "news",
      scenes: [scene({ sceneId: "legacy", unavailableReason: reason })],
      currentDesignSystemVersion: 4,
    });

    const item = findNode(panel, "scene/legacy")!;
    expect(item.description).toContain(reason);
    expect(item.actions!.find((a) => a.name === "open")!.unavailable).toBe(reason);
    expect(item.actions!.find((a) => a.name === "duplicate")!.unavailable).toBe(reason);
    expect(item.actions!.find((a) => a.name === "publish")!.unavailable).toBe(reason);
    expect(item.actions!.find((a) => a.name === "delete")!.unavailable).toBeUndefined();
  });
});

describe("conformance, computed continuously", () => {
  it("reports how far behind a template is without anyone publishing", () => {
    const behind = conformanceOf(scene({ sceneId: "s", publishedVersion: 1 }), 4);
    expect(behind).toEqual({ kind: "behind", version: 1, versionsBehind: 3 });
    expect(conformanceLabel(behind)).toContain("3 version(s) behind");
  });

  it("a template on the current version is current, not behind", () => {
    expect(conformanceOf(scene({ sceneId: "s", publishedVersion: 4 }), 4).kind).toBe("current");
    // A template published against a newer system than the project's current
    // one is not "behind" either; it is ahead, and reporting it as drift
    // would send someone to fix a scene that is fine.
    expect(conformanceOf(scene({ sceneId: "s", publishedVersion: 5 }), 4).kind).toBe("current");
  });

  it("unstamped is its own state and never a distance", () => {
    const unstamped = conformanceOf(
      scene({ sceneId: "s", publishedUnstamped: true }),
      4,
    );
    expect(unstamped.kind).toBe("unstamped");
    expect(conformanceLabel(unstamped)).toContain("conformance unknown");
    // The specific failure guarded: it must not be reported as behind.
    expect(unstamped.kind).not.toBe("behind");
    expect(conformanceLabel(unstamped)).not.toMatch(/version\(s\) behind/);
  });

  it("never published and no system are distinct from drift", () => {
    expect(conformanceOf(scene({ sceneId: "s" }), 4).kind).toBe("unpublished");
    expect(conformanceOf(scene({ sceneId: "s", publishedVersion: 1 }), undefined).kind).toBe(
      "no-system",
    );
  });

  it("the header counts behind and unstamped separately", () => {
    const panel = sceneManagerPanel({
      project: "news",
      scenes: [
        scene({ sceneId: "a", publishedVersion: 1 }),
        scene({ sceneId: "b", publishedVersion: 4 }),
        scene({ sceneId: "c", publishedUnstamped: true }),
      ],
      currentDesignSystemVersion: 4,
    });
    expect(panel.description).toBe("design system v4 · 1 behind · 1 unstamped");
  });
});

describe("the indicator announces itself", () => {
  it("each scene's conformance is a live status region", () => {
    // Drift changes while the author works — someone confirms a new brand
    // pack — and the row must be able to say so without being gone looking for.
    const panel = sceneManagerPanel({
      project: "news",
      scenes: [scene({ sceneId: "lower-third", publishedVersion: 2 })],
      currentDesignSystemVersion: 4,
    });

    const status = findNode(panel, "scene/lower-third/conformance")!;
    expect(status.role).toBe("status");
    expect(status.value).toBe("v2, 2 version(s) behind");
  });

  it("an agent reads conformance without publishing anything", () => {
    const panel = sceneManagerPanel({
      project: "news",
      scenes: [
        scene({ sceneId: "a", publishedVersion: 1 }),
        scene({ sceneId: "c", publishedUnstamped: true }),
      ],
      currentDesignSystemVersion: 4,
    });
    const view = agentView(panel);

    const statuses: string[] = [];
    const walk = (node: { role: string; value?: string; children: readonly unknown[] }): void => {
      if (node.role === "status" && node.value) statuses.push(node.value);
      for (const child of node.children) {
        walk(child as Parameters<typeof walk>[0]);
      }
    };
    walk(view);

    expect(statuses).toEqual([
      "v1, 3 version(s) behind",
      "predates design-system stamping — conformance unknown",
    ]);
  });
});
