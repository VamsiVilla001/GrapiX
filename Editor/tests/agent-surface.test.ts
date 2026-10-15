// The agent surface: one panel description, two consumers (11.5-11.17).
//
// What these tests defend is the property the whole Phase 11 UI rests on: the
// DOM a person uses and the snapshot an agent reads are projections of ONE
// tree. If they could disagree, an agent would confidently operate a control
// that is not there, and nobody would find out until it mattered.
//
// The second property is that an unavailable action always says why. A greyed
// control with no reason is the interface form of the silent fallback the
// architecture forbids (invariant 18): the caller is left guessing.

import { describe, expect, it } from "vitest";

import {
  agentView,
  findNode,
  isMixed,
  MIXED,
  moveFocus,
  renderNode,
  resolveAction,
  unify,
  visibleRows,
  type AgentNode,
  type DocumentLike,
  type ElementLike,
  type UiNode,
} from "../src/agent-surface";

/// A DOM stand-in that records what was set, so the ARIA mapping can be
/// asserted without a browser.
class FakeElement implements ElementLike {
  readonly attributes = new Map<string, string>();
  readonly children: FakeElement[] = [];
  textContent: string | null = null;
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  appendChild(child: ElementLike): void {
    this.children.push(child as FakeElement);
  }
  /// Every element in the subtree, for whole-tree assertions.
  flatten(): FakeElement[] {
    return [this, ...this.children.flatMap((child) => child.flatten())];
  }
}

const fakeDocument: DocumentLike = {
  createElement: (tag: string) => new FakeElement(tag),
};

function tree(): UiNode {
  return {
    id: "objects",
    role: "treegrid",
    label: "Objects",
    children: [
      {
        id: "group-1",
        role: "row",
        label: "Lower third",
        level: 1,
        expanded: true,
        selected: false,
        actions: [
          { name: "select", label: "Select" },
          {
            name: "delete",
            label: "Delete",
            unavailable: "the object is locked",
          },
        ],
        children: [
          { id: "text-1", role: "row", label: "Headline", level: 2, selected: true },
          { id: "text-2", role: "row", label: "Strap", level: 2, selected: false },
        ],
      },
      {
        id: "group-2",
        role: "row",
        label: "Bug",
        level: 1,
        expanded: false,
        children: [{ id: "logo", role: "row", label: "Logo", level: 2 }],
      },
    ],
  };
}

describe("one description, two consumers", () => {
  it("renders an inline edit action with the same value and named disabled reason", () => {
    const node: UiNode = { id: "inspector/x", role: "gridcell", label: "X", value: "Mixed",
      input: { type: "number", value: "", mixed: true },
      actions: [{ name: "edit", label: "Edit X", unavailable: "Selection is locked" }] };
    const rendered = renderNode(fakeDocument, node) as FakeElement;
    const input = rendered.children.find((child) => child.tag === "input")!;
    expect(input.attributes.get("aria-label")).toBe("X");
    expect(input.attributes.get("placeholder")).toBe("Mixed");
    expect(input.attributes.get("title")).toBe("Selection is locked");
    expect(input.attributes.has("disabled")).toBe(true);
    expect(agentView(node).actions[0]!.available).toBe(false);
  });
  it("the agent snapshot reports exactly the rows, levels and state the tree carries", () => {
    const view = agentView(tree());

    expect(view.id).toBe("objects");
    expect(view.children.map((child) => child.id)).toEqual(["group-1", "group-2"]);

    const group = view.children[0]!;
    expect(group.level).toBe(1);
    expect(group.expanded).toBe(true);
    expect(group.children.map((child) => [child.id, child.level, child.selected])).toEqual([
      ["text-1", 2, true],
      ["text-2", 2, false],
    ]);
  });

  it("the DOM carries the same facts as the snapshot, from the same node", () => {
    // The point of the test: these are not two hand-maintained mappings. A
    // divergence here means the panel a screen reader announces is not the
    // panel an agent was told about.
    const view = agentView(tree());
    const rendered = renderNode(fakeDocument, tree()) as FakeElement;
    const byId = new Map(
      rendered
        .flatten()
        .filter((element) => element.attributes.has("id"))
        .map((element) => [element.attributes.get("id")!, element]),
    );
    const check = (node: AgentNode): void => {
      const element = byId.get(node.id);
      expect(element, `${node.id} must be rendered`).toBeDefined();
      expect(element!.attributes.get("role")).toBe(node.role);
      expect(element!.attributes.get("aria-label")).toBe(node.label);
      if (node.level !== undefined) {
        expect(element!.attributes.get("aria-level")).toBe(String(node.level));
      }
      if (node.selected !== undefined) {
        expect(element!.attributes.get("aria-selected")).toBe(String(node.selected));
      }
      if (node.expanded !== undefined) {
        expect(element!.attributes.get("aria-expanded")).toBe(String(node.expanded));
      }
      node.children.forEach(check);
    };
    check(view);
  });
});

describe("an unavailable action always names its condition", () => {
  it("the reason reaches both the agent and the rendered control", () => {
    const view = agentView(tree());
    const group = view.children[0]!;

    const del = group.actions.find((action) => action.name === "delete")!;
    expect(del.available).toBe(false);
    expect(del.unavailableReason).toBe("the object is locked");

    const select = group.actions.find((action) => action.name === "select")!;
    expect(select.available).toBe(true);
    expect(select.unavailableReason).toBeUndefined();

    // And the person sees the same sentence, on the control itself.
    const rendered = renderNode(fakeDocument, tree()) as FakeElement;
    const button = rendered
      .flatten()
      .find((element) => element.attributes.get("data-action") === "delete")!;
    expect(button.attributes.get("aria-disabled")).toBe("true");
    expect(button.attributes.get("title")).toBe("the object is locked");
  });

  it("resolveAction distinguishes the three ways an action can fail", () => {
    // A caller that got a bare `false` would have to guess which happened,
    // and the three need different responses: re-read the panel, use a
    // different action, or clear the blocking condition.
    const root = tree();

    const missingNode = resolveAction(root, "no-such-node", "select");
    expect(missingNode.ok).toBe(false);
    expect(!missingNode.ok && missingNode.reason).toContain("no node no-such-node");

    const missingAction = resolveAction(root, "group-1", "fly");
    expect(missingAction.ok).toBe(false);
    // It names what the node does offer, so the caller can correct itself.
    expect(!missingAction.ok && missingAction.reason).toContain("select");

    const blocked = resolveAction(root, "group-1", "delete");
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.reason).toBe("the object is locked");

    const fine = resolveAction(root, "group-1", "select");
    expect(fine.ok).toBe(true);
  });
});

describe("navigation follows what is actually shown", () => {
  it("a collapsed container hides its descendants from traversal but not from the model", () => {
    const root = tree();
    const rows = visibleRows(root).map((row) => row.id);

    // `logo` is inside a collapsed group: a keyboard user and a screen reader
    // must walk what is displayed, not the underlying document.
    expect(rows).toEqual(["group-1", "text-1", "text-2", "group-2"]);
    // It is still addressable, because it still exists.
    expect(findNode(root, "logo")).toBeDefined();
  });

  it("arrow keys walk visible rows and never fall off either end", () => {
    const root = tree();
    expect(moveFocus(root, "group-1", "ArrowDown")).toBe("text-1");
    expect(moveFocus(root, "text-2", "ArrowDown")).toBe("group-2");
    // Past the last row stays on the last row: focus must never land on
    // nothing, or the next keystroke has no origin.
    expect(moveFocus(root, "group-2", "ArrowDown")).toBe("group-2");
    expect(moveFocus(root, "group-1", "ArrowUp")).toBe("group-1");
    expect(moveFocus(root, "text-2", "Home")).toBe("group-1");
    expect(moveFocus(root, "group-1", "End")).toBe("group-2");
  });
});

describe("Mixed is a state, not an absence", () => {
  it("values that differ report Mixed rather than the first value", () => {
    // Rendering a disagreement as the first object's value is how an edit
    // silently flattens a property the author never touched (11.9).
    expect(unify([1, 1, 1])).toBe(1);
    expect(isMixed(unify([1, 2, 1])!)).toBe(true);
    expect(unify([])).toBeUndefined();
    expect(unify(["a"])).toBe("a");
  });

  it("Mixed survives the agent projection as a readable value", () => {
    const node: UiNode = {
      id: "opacity",
      role: "gridcell",
      label: "Opacity",
      value: isMixed(MIXED) ? "Mixed" : "",
    };
    expect(agentView(node).value).toBe("Mixed");
  });
});

describe("live regions announce themselves", () => {
  it("a status is polite and an alert interrupts", () => {
    // Only genuinely blocking conditions interrupt. A panel that shouted
    // every routine change would train an operator to ignore it.
    const status = renderNode(fakeDocument, {
      id: "drift",
      role: "status",
      label: "Design system",
      value: "current",
    }) as FakeElement;
    expect(status.attributes.get("aria-live")).toBe("polite");

    const alert = renderNode(fakeDocument, {
      id: "font-missing",
      role: "alert",
      label: "Font unresolved",
      value: "Inter is not resolved",
    }) as FakeElement;
    expect(alert.attributes.get("aria-live")).toBe("assertive");
  });
});
