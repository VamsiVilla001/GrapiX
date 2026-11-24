// The workspace manager's commands (11.92, 11.93): opening, closing and what cannot be shown.
import { describe, expect, it } from "vitest";
import { findGroup, groupOfInstance, isDockRefused, maximizeGroup, type DockRefusal, type SavedWorkspace } from "../src/dock-model";
import { validateWorkspace } from "../src/dock-validate";
import { closePanelChecked, openPanel, openTypes, setPanelViewState, unavailableInstances, type OpenResult } from "../src/workspace-manager";
import { DEFINITIONS, deepFreeze, design, ok, registry } from "./dock-fixtures";

const opened = (result: OpenResult | DockRefusal): OpenResult => {
  if (isDockRefused(result)) throw new Error(`refused: ${result.refused}`);
  return result;
};
const refusal = (result: unknown): DockRefusal => {
  if (!isDockRefused(result as DockRefusal)) throw new Error("not refused");
  return result as DockRefusal;
};

describe("opening a panel", () => {
  it("shows a panel that is already open instead of opening it twice", () => {
    const behind = design();
    const result = opened(openPanel(behind, registry(), "curve-editor"));
    expect(result.created).toBe(false);
    expect(result.instanceId).toBe("curves-1");
    // It was behind the Timeline tab; now it shows, and its group has focus.
    expect(findGroup(result.workspace, "timeline-group")?.activePanelInstanceId).toBe("curves-1");
    expect(result.workspace.activeGroupId).toBe("timeline-group");
    expect(Object.keys(result.workspace.instances)).toEqual(Object.keys(behind.instances));
  });

  it("opens a closed panel at its registered group and tab position, and gives it an instance", () => {
    const without = ok(closePanelChecked(design(), registry(), "assets-1"));
    const result = opened(openPanel(without, registry(), "asset-browser"));
    expect(result.created).toBe(true);
    expect(result.instanceId).toBe("asset-browser-1");
    expect(result.workspace.instances["asset-browser-1"]).toEqual({ instanceId: "asset-browser-1", panelType: "asset-browser" });
    expect(groupOfInstance(result.workspace, "asset-browser-1")?.id).toBe("left");
    expect(findGroup(result.workspace, "left")?.panelInstanceIds).toEqual(["objects-1", "asset-browser-1"]);
    expect(validateWorkspace(result.workspace)).toEqual([]);
  });

  it("puts it at the tab position its registration asks for", () => {
    const without = ok(closePanelChecked(design(), registry(), "objects-1"));
    const result = opened(openPanel(without, registry(), "object-manager"));
    expect(findGroup(result.workspace, "left")?.panelInstanceIds).toEqual(["object-manager-1", "assets-1"]);
    expect(findGroup(result.workspace, "left")?.activePanelInstanceId).toBe("object-manager-1");
  });

  it("refuses to open a second one of a panel that can only be open once, by name", () => {
    const result = refusal(openPanel(design(), registry(), "timeline", { newInstance: true }));
    expect(result.code).toBe("DUPLICATE_SINGLETON");
    expect(result.refused).toBe("Timeline can only be open once, and it is already open");
  });

  it("opens a second viewport, and a third, with ids that do not clash", () => {
    const first = opened(openPanel(design(), registry(), "scene-viewport", { newInstance: true }));
    expect(first.created).toBe(true);
    expect(first.instanceId).toBe("scene-viewport-1");
    const second = opened(openPanel(first.workspace, registry(), "scene-viewport", { newInstance: true }));
    expect(second.instanceId).toBe("scene-viewport-2");
    // The layout had one (`viewport-1`); these are the second and third.
    expect(Object.values(second.workspace.instances).filter((instance) => instance.panelType === "scene-viewport")).toHaveLength(3);
    expect(validateWorkspace(second.workspace)).toEqual([]);
    // Without asking for another, an open viewport is shown, not duplicated.
    expect(opened(openPanel(second.workspace, registry(), "scene-viewport")).created).toBe(false);
  });

  it("falls back to the group that last had focus, then to the first group, when there is no registered place", () => {
    const focused: SavedWorkspace = { ...design(), activeGroupId: "right" };
    const there = opened(openPanel(focused, registry(), "import-report"));
    expect(groupOfInstance(there.workspace, "import-report-1")?.id).toBe("right");
    const first = opened(openPanel(design(), registry(), "import-report"));
    expect(groupOfInstance(first.workspace, "import-report-1")?.id).toBe("left");
    const ghost = opened(openPanel(design(), { ...registry(), get: (type) => (type === "import-report" ? { ...DEFINITIONS.find((d) => d.type === "import-report")!, defaultPlacement: { groupHint: "ghost" } } : registry().get(type)) }, "import-report"));
    expect(groupOfInstance(ghost.workspace, "import-report-1")?.id).toBe("left");
  });

  it("opens into an empty workspace", () => {
    const empty: SavedWorkspace = { ...design(), root: { kind: "tabs", id: "root", panelInstanceIds: [], activePanelInstanceId: null }, instances: {} };
    const result = opened(openPanel(empty, registry(), "timeline"));
    expect(groupOfInstance(result.workspace, "timeline-1")?.id).toBe("root");
    expect(validateWorkspace(result.workspace)).toEqual([]);
  });

  it("ends a maximise that would hide the panel opened, but keeps one it is opened into", () => {
    const maximised = ok(maximizeGroup(design(), "viewport-group"));
    const elsewhere = opened(openPanel(ok(closePanelChecked(maximised, registry(), "assets-1")), registry(), "asset-browser"));
    expect(elsewhere.workspace.maximizedGroupId).toBeUndefined();
    const into = opened(openPanel(ok(closePanelChecked(ok(maximizeGroup(design(), "left")), registry(), "assets-1")), registry(), "asset-browser"));
    expect(into.workspace.maximizedGroupId).toBe("left");
  });

  it("refuses a panel that is not available here, with the reason, and changes nothing", () => {
    const frozen = deepFreeze(design());
    const before = JSON.stringify(frozen);
    expect(refusal(openPanel(frozen, registry(), "from-the-future"))).toMatchObject({ code: "PANEL_NOT_AVAILABLE", refused: "this build does not know a panel called from-the-future" });
    expect(refusal(openPanel(frozen, registry(), "rundown")).refused).toBe("Rundown belongs to the playout application");
    expect(refusal(openPanel(frozen, registry(), "conformance")).refused).toContain("needs conformance");
    expect(isDockRefused(openPanel(frozen, registry(), "conformance", { capabilities: new Set(["conformance"]) }))).toBe(false);
    expect(JSON.stringify(frozen)).toBe(before);
  });
});

describe("closing a panel", () => {
  it("closes one that may be closed", () => {
    const next = ok(closePanelChecked(design(), registry(), "bindings-1"));
    expect(next.instances["bindings-1"]).toBeUndefined();
    expect(findGroup(next, "right")?.panelInstanceIds).toEqual(["inspector-1"]);
  });

  it("refuses one that may not, by name, and changes nothing", () => {
    const frozen = deepFreeze(design());
    const result = refusal(closePanelChecked(frozen, registry(), "viewport-1"));
    expect(result).toMatchObject({ code: "PANEL_NOT_CLOSABLE", refused: "Composition cannot be closed. It can be moved to another place, or its group shown at full size." });
  });

  it("refuses a panel that is not open, and closes an unregistered one, which it has no rule against", () => {
    expect(refusal(closePanelChecked(design(), registry(), "ghost-1")).code).toBe("PANEL_NOT_AVAILABLE");
    const odd: SavedWorkspace = { ...design(), instances: { ...design().instances, "objects-1": { instanceId: "objects-1", panelType: "from-the-future" } } };
    expect(ok(closePanelChecked(odd, registry(), "objects-1")).instances["objects-1"]).toBeUndefined();
  });
});

describe("a layout from a build that had more panels", () => {
  const future: SavedWorkspace = {
    ...design(),
    instances: {
      ...design().instances,
      "assets-1": { instanceId: "assets-1", panelType: "from-the-future" },
      "bindings-1": { instanceId: "bindings-1", panelType: "conformance" },
    },
  };

  it("keeps every panel in place and names which cannot be shown and why", () => {
    const missing = unavailableInstances(future, registry());
    expect(missing).toEqual([
      { instanceId: "assets-1", panelType: "from-the-future", reason: "this build does not know a panel called from-the-future" },
      { instanceId: "bindings-1", panelType: "conformance", reason: "Conformance needs conformance, which this build does not have" },
    ]);
    // The layout itself is untouched, so a build that has them later finds them where they were.
    expect(validateWorkspace(future)).toEqual([]);
    expect(findGroup(future, "left")?.panelInstanceIds).toEqual(["objects-1", "assets-1"]);
    expect(unavailableInstances(future, registry(), new Set(["conformance"])).map((item) => item.instanceId)).toEqual(["assets-1"]);
  });

  it("lists the open kinds for the Panels menu's check marks", () => {
    expect([...openTypes(design())].sort()).toEqual(["asset-browser", "curve-editor", "data-bindings", "inspector", "object-manager", "scene-viewport", "timeline"]);
  });
});

describe("what the survivors of the mutant run showed was not held (11.93)", () => {
  it("makes the group of a panel opened the one with focus", () => {
    const without = ok(closePanelChecked(design(), registry(), "assets-1"));
    const result = opened(openPanel(without, registry(), "asset-browser"));
    expect(result.workspace.activeGroupId).toBe("left");
  });

  it("treats a panel that is not a singleton but does not allow more than one as open-once", () => {
    const single = registry([...DEFINITIONS, { type: "one-only", title: "One only", app: "editor", singleton: false, allowMultiple: false, allowClose: true, allowFloat: true }]);
    const first = opened(openPanel(design(), single, "one-only"));
    expect(first.created).toBe(true);
    expect(refusal(openPanel(first.workspace, single, "one-only", { newInstance: true })).code).toBe("DUPLICATE_SINGLETON");
    expect(opened(openPanel(first.workspace, single, "one-only")).created).toBe(false);
  });
});

describe("what the code review of 23 Nov found (view state, and odd panel ids)", () => {
  it("keeps a panel's ordinary preferences, and refuses a secret at the moment a panel tries to keep one", () => {
    const kept = ok(setPanelViewState(design(), "objects-1", { columns: ["name"], bypass: true }));
    expect(kept.viewState).toEqual({ "objects-1": { columns: ["name"], bypass: true } });
    expect(validateWorkspace(kept)).toEqual([]);
    const frozen = deepFreeze(design());
    const secret = refusal(setPanelViewState(frozen, "publish-1", { endpoint: "x", apiKey: "abc" }));
    expect(secret.code).toBe("LAYOUT_VALIDATION_FAILED");
    expect(secret.refused).toBe("this view state was not kept: viewState.publish-1.apiKey looks like a password, token or secret, which a layout never keeps");
    expect(refusal(setPanelViewState(frozen, "token", "x")).problems![0]!.rule).toBe(9);
    expect(refusal(setPanelViewState(frozen, "__proto__", { a: 1 })).refused).toContain("__proto__");
    expect(refusal(setPanelViewState(frozen, "", 1)).code).toBe("LAYOUT_VALIDATION_FAILED");
  });

  it("replaces what was kept under a key and leaves the other keys", () => {
    const one = ok(setPanelViewState(design(), "a", { n: 1 }));
    const two = ok(setPanelViewState(ok(setPanelViewState(one, "b", { n: 2 })), "a", { n: 3 }));
    expect(two.viewState).toEqual({ a: { n: 3 }, b: { n: 2 } });
  });

  it("does not take a name every object has for an open panel", () => {
    expect(refusal(closePanelChecked(design(), registry(), "constructor")).code).toBe("PANEL_NOT_AVAILABLE");
    const odd = registry([...DEFINITIONS, { type: "constructor", title: "Odd", app: "editor", singleton: true, allowMultiple: false, allowClose: true, allowFloat: true }]);
    const result = opened(openPanel(design(), odd, "constructor"));
    expect(result.instanceId).toBe("constructor-1");
    expect(validateWorkspace(result.workspace)).toEqual([]);
  });
});
