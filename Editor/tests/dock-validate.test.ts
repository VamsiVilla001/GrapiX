// The rules a saved workspace must keep (11.92), one broken example for each.
import { describe, expect, it } from "vitest";
import type { DockNode, SavedWorkspace, SplitNode } from "../src/dock-model";
import { validateWorkspace } from "../src/dock-validate";
import { design } from "./dock-fixtures";

const rules = (workspace: SavedWorkspace): number[] => [...new Set(validateWorkspace(workspace).map((problem) => problem.rule))].sort();
const reasons = (workspace: SavedWorkspace): string => validateWorkspace(workspace).map((problem) => problem.reason).join(" | ");

function withRoot(root: DockNode): SavedWorkspace {
  return { ...design(), root };
}

describe("rule 1: every panel is a known instance, once, and every instance is in a tree", () => {
  it("names a panel in the layout that has no instance record", () => {
    const workspace = design();
    const { "objects-1": _gone, ...instances } = workspace.instances;
    expect(rules({ ...workspace, instances })).toEqual([1]);
    expect(reasons({ ...workspace, instances })).toContain("objects-1 is in the layout but has no instance record");
  });

  it("names an instance that is in no tab group", () => {
    const workspace = design();
    const extra = { ...workspace, instances: { ...workspace.instances, "ghost-1": { instanceId: "ghost-1", panelType: "ghost" } } };
    expect(rules(extra)).toEqual([1]);
    expect(reasons(extra)).toContain("ghost-1 has an instance record but is in no tab group");
  });

  it("names a panel in two places, and a record that calls itself something else", () => {
    const workspace = design();
    const twice = withRoot({
      ...(workspace.root as SplitNode),
      children: (workspace.root as SplitNode).children.map((child) =>
        child.id === "right" && child.kind === "tabs" ? { ...child, panelInstanceIds: [...child.panelInstanceIds, "objects-1"] } : child,
      ),
    });
    expect(reasons(twice)).toContain("objects-1 is in 2 places");
    const renamed = { ...workspace, instances: { ...workspace.instances, "objects-1": { instanceId: "other", panelType: "object-manager" } } };
    expect(reasons(renamed)).toContain("objects-1 calls itself other");
  });
});

describe("rule 3: a tab group has a panel and shows one of its own", () => {
  it("names an empty group that is not the whole workspace", () => {
    const workspace = design();
    const root = workspace.root as SplitNode;
    const empty = { ...workspace, root: { ...root, children: [{ kind: "tabs" as const, id: "empty", panelInstanceIds: [], activePanelInstanceId: null }, ...root.children.slice(1)] } };
    expect(reasons(empty)).toContain("tab group empty holds no panel");
  });

  it("allows an empty root, which is a workspace with nothing open", () => {
    expect(validateWorkspace({ ...design(), root: { kind: "tabs", id: "root", panelInstanceIds: [], activePanelInstanceId: null }, instances: {} })).toEqual([]);
  });

  it("names a group that shows a panel it does not hold, or none", () => {
    const wrong = withRoot({ kind: "tabs", id: "g", panelInstanceIds: ["objects-1"], activePanelInstanceId: "assets-1" });
    expect(reasons(wrong)).toContain("tab group g shows assets-1, which is not one of its panels");
    const none = withRoot({ kind: "tabs", id: "g", panelInstanceIds: ["objects-1"], activePanelInstanceId: null });
    expect(reasons(none)).toContain("shows null");
  });

  it("names a maximised or active group that is not there", () => {
    expect(reasons({ ...design(), maximizedGroupId: "ghost" })).toContain("the maximised group ghost does not exist");
    expect(reasons({ ...design(), activeGroupId: "ghost" })).toContain("the active group ghost does not exist");
  });
});

describe("rule 4: a split has two or more children and one positive weight each, adding up to one", () => {
  const root = (): SplitNode => design().root as SplitNode;

  it("names a split with one child", () => {
    const one = withRoot({ ...root(), weights: [1], children: [root().children[0]!] });
    expect(reasons(one)).toContain("split root has 1 children");
  });

  it("names weights that are not as many as the children", () => {
    expect(reasons(withRoot({ ...root(), weights: [0.5, 0.5] }))).toContain("3 children but 2 weights");
  });

  it("names a weight that is zero, negative, infinite or not a number", () => {
    for (const bad of [0, -0.1, Infinity, Number.NaN]) {
      expect(reasons(withRoot({ ...root(), weights: [0.5, bad, 0.5] }))).toContain("not a positive number");
    }
  });

  it("names weights that do not add up to one, and allows a rounding difference", () => {
    expect(reasons(withRoot({ ...root(), weights: [0.2, 0.6, 0.3] }))).toContain("do not add up to one");
    expect(validateWorkspace(withRoot({ ...root(), weights: [0.2, 0.6, 0.2 + 1e-9] }))).toEqual([]);
  });
});

describe("rule 5: no id is used twice and no node is inside itself", () => {
  it("names an id used by two nodes", () => {
    const root = design().root as SplitNode;
    const clash = withRoot({ ...root, children: root.children.map((child) => (child.id === "right" ? { ...child, id: "left" } : child)) });
    expect(reasons(clash)).toContain("the id left is used 2 times");
  });

  it("names a float whose id is a node's", () => {
    const float = { id: "left", root: { kind: "tabs" as const, id: "ft", panelInstanceIds: [], activePanelInstanceId: null }, bounds: { x: 0, y: 0, width: 10, height: 10 } };
    expect(reasons({ ...design(), floats: [float] })).toContain("the id left is used 2 times");
  });

  it("names a node that is reached twice, and does not loop on a node that is its own descendant", () => {
    const shared = { kind: "tabs" as const, id: "shared", panelInstanceIds: ["objects-1"], activePanelInstanceId: "objects-1" };
    const twice = withRoot({ kind: "split", id: "root", direction: "horizontal", weights: [0.5, 0.5], children: [shared, shared] });
    expect(rules(twice)).toContain(5);
    const loop = { kind: "split" as const, id: "loop", direction: "horizontal" as const, weights: [0.5, 0.5], children: [] as DockNode[] };
    (loop.children as DockNode[]).push(shared, loop);
    expect(rules(withRoot(loop))).toContain(5);
  });
});

describe("rule 7: a floating group's bounds are finite and have a size", () => {
  const float = (bounds: { x: number; y: number; width: number; height: number }) => ({
    id: "float-1",
    root: { kind: "tabs" as const, id: "ft", panelInstanceIds: ["curves-1"], activePanelInstanceId: "curves-1" },
    bounds,
  });
  const base = (): SavedWorkspace => {
    const workspace = design();
    const root = workspace.root as SplitNode;
    const center = root.children[1] as SplitNode;
    return {
      ...workspace,
      root: { ...root, children: [root.children[0]!, { ...center, children: [center.children[0]!, { kind: "tabs", id: "timeline-group", panelInstanceIds: ["timeline-1"], activePanelInstanceId: "timeline-1" }] }, root.children[2]!] },
    };
  };

  it("accepts good bounds", () => {
    expect(validateWorkspace({ ...base(), floats: [float({ x: -100, y: 5, width: 300, height: 200 })] })).toEqual([]);
  });

  it("names bounds that are not numbers or have no size", () => {
    expect(reasons({ ...base(), floats: [float({ x: Number.NaN, y: 0, width: 10, height: 10 })] })).toContain("not finite numbers");
    expect(reasons({ ...base(), floats: [float({ x: 0, y: 0, width: Infinity, height: 10 })] })).toContain("not finite numbers");
    expect(reasons({ ...base(), floats: [float({ x: 0, y: 0, width: 0, height: 10 })] })).toContain("has no size");
    expect(reasons({ ...base(), floats: [float({ x: 0, y: 0, width: 10, height: -1 })] })).toContain("has no size");
  });
});

describe("rule 9: no password, token or secret is kept in a panel's view state", () => {
  it("names a key that is called like a secret, at any depth", () => {
    for (const key of ["password", "apiKey", "api_key", "Authorization", "accessToken", "client_secret", "bearer", "credential", "privateKey"]) {
      expect(rules({ ...design(), viewState: { panel: { nested: { [key]: "x" } } } }), key).toEqual([9]);
    }
  });

  it("names a value that is a GrapiX credential or a bearer header, whatever its key is called", () => {
    expect(reasons({ ...design(), viewState: { note: "gx1.abc.def" } })).toContain("viewState.note");
    expect(reasons({ ...design(), viewState: { list: ["fine", "Bearer abc123def456"] } })).toContain("viewState.list[1]");
    expect(reasons({ ...design(), viewState: { h: "  basic dXNlcjpwYXNz" } })).toContain("viewState.h");
  });

  it("looks in a panel's context too, and allows ordinary preferences", () => {
    const context = { ...design(), instances: { ...design().instances, "objects-1": { instanceId: "objects-1", panelType: "object-manager", context: { mode: "pinned" as const, entityId: "gx1.secret" } } } };
    expect(reasons(context)).toContain("instances.objects-1.context.entityId");
    expect(validateWorkspace({ ...design(), viewState: { "objects-1": { columns: ["name", "type"], widths: [120, 80], filter: "tokens of text", expanded: true } } })).toEqual([]);
  });

  it("stops looking below twelve levels instead of running away", () => {
    let deep: Record<string, unknown> = { password: "x" };
    for (let i = 0; i < 40; i += 1) deep = { next: deep };
    expect(() => validateWorkspace({ ...design(), viewState: deep })).not.toThrow();
  });
});

describe("what the survivors of the mutant run showed was not held (11.92)", () => {
  it("names one node used in the main layout and in a floating group", () => {
    const workspace = design();
    const shared = { kind: "tabs" as const, id: "shared", panelInstanceIds: ["curves-1"], activePanelInstanceId: "curves-1" };
    const root = workspace.root as SplitNode;
    const both: SavedWorkspace = {
      ...workspace,
      root: { ...root, children: root.children.map((child) => (child.id === "right" ? shared : child)) },
      floats: [{ id: "float-1", root: shared, bounds: { x: 0, y: 0, width: 10, height: 10 } }],
    };
    expect(reasons(both)).toContain("node shared is reached twice");
  });

  it("does not run out of stack on a secret hunt through a very deep value", () => {
    let deep: Record<string, unknown> = { fine: "x" };
    for (let i = 0; i < 20000; i += 1) deep = { next: deep };
    expect(() => validateWorkspace({ ...design(), viewState: deep })).not.toThrow();
  });
});

describe("what the code review of 23 Nov found (rule 9)", () => {
  it("does not take an ordinary preference for a secret because a secret word is inside its name", () => {
    const ordinary = { effects: { bypass: true, designTokens: ["a"], tokenFilter: "x", compass: 1, passes: 3, secretary: "k", keyboard: "us", monkey: 1, hotkey: "F5", keyFrames: [1], sortKey: "name", primaryKey: "id" } };
    expect(validateWorkspace({ ...design(), viewState: ordinary })).toEqual([]);
  });

  it("still names a key that ends in a secret word, however it is written", () => {
    for (const key of ["token", "access_token", "refresh-token", "AuthToken", "API_KEY", "apikey", "secretKey", "access-key", "dbPassword", "passphrase", "client.secret", "Credentials"]) {
      expect(rules({ ...design(), viewState: { [key]: "x" } }), key).toEqual([9]);
    }
  });

  it("does not take a search for words that start like a header for a credential", () => {
    for (const value of ["Basic 3D", "basic shapes", "Bearer of news", "bearer", "gx1. and more", "Basic"]) {
      expect(validateWorkspace({ ...design(), viewState: { filter: value } }), value).toEqual([]);
    }
    for (const value of ["Basic dXNlcjpwYXNz", "bearer eyJhbGciOi.J9", "gx1.editor.abc123"]) {
      expect(rules({ ...design(), viewState: { filter: value } }), value).toEqual([9]);
    }
  });

  it("refuses view state nested too deep to check, instead of passing whatever is down there", () => {
    let deep: unknown = { password: "hunter2" };
    for (let i = 0; i < 13; i += 1) deep = { next: deep };
    const found = validateWorkspace({ ...design(), viewState: { deep } });
    expect(found.map((problem) => problem.rule)).toEqual([9]);
    expect(found[0]!.reason).toContain("is nested deeper than 12 levels, which is too deep to check for secrets");
    // Twelve levels of ordinary values is allowed, and a secret at the last level that is checked is found.
    let shallow: unknown = { password: "x" };
    for (let i = 0; i < 10; i += 1) shallow = { next: shallow };
    expect(reasons({ ...design(), viewState: { shallow } })).toContain("looks like a password");
    let fine: unknown = "plain";
    for (let i = 0; i < 11; i += 1) fine = { next: fine };
    expect(validateWorkspace({ ...design(), viewState: { fine } })).toEqual([]);
  });
});
