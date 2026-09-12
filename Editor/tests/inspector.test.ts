// The type-aware inspector (11.9): Mixed state, and one undo per gesture.
//
// Two failures these tests exist to prevent:
//   - a disagreement rendered as the first object's value, which silently
//     flattens a property across a selection the author never touched;
//   - one gesture becoming N undo steps, after which an author presses undo,
//     sees most of their change still applied, and stops trusting undo.

import { describe, expect, it } from "vitest";

import type { SceneDocument, SceneObject } from "@grapix/contracts";
import { agentView, findNode } from "../src/agent-surface";
import { applyEdit, inspectorPanel, isRefused, type EditTransaction } from "../src/inspector";

function base(id: string, name: string): Record<string, unknown> {
  return {
    id,
    name,
    visible: true,
    locked: false,
    opacity: 1,
    x: 0,
    y: 0,
    zDepth: 0,
    zIndex: 0,
    layerId: "",
    width: 100,
    height: 50,
    rotation: 0,
    rotationX: 0,
    rotationY: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    strokeWidth: 0,
  };
}

function rect(id: string, overrides: Record<string, unknown> = {}): SceneObject {
  return { type: "rect", ...base(id, id), radius: 0, ...overrides } as unknown as SceneObject;
}

function text(id: string, overrides: Record<string, unknown> = {}): SceneObject {
  return {
    type: "text",
    ...base(id, id),
    text: "Headline",
    fontId: "inter",
    size: 48,
    ...overrides,
  } as unknown as SceneObject;
}

function scene(objects: SceneObject[]): SceneDocument {
  return {
    id: "s",
    name: "Scene",
    version: 1,
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    timeline: { durationFrames: 1 },
    dataContext: {},
    assets: [],
    fonts: [],
    materials: [],
    objects,
  } as unknown as SceneDocument;
}

const value = (panel: ReturnType<typeof inspectorPanel>, key: string): string | undefined =>
  findNode(panel, `inspector/${key}`)?.value;

describe("type awareness", () => {
  it("shows a kind's own fields only when that kind is selected", () => {
    const document = scene([text("t"), rect("r")]);

    const onText = inspectorPanel(document, ["t"]);
    expect(value(onText, "text")).toBe("Headline");
    expect(value(onText, "size")).toBe("48");
    // A rect has no text: the field is absent entirely, because it is not a
    // property of anything selected.
    expect(findNode(onText, "inspector/radius")).toBeUndefined();

    const onRect = inspectorPanel(document, ["r"]);
    expect(findNode(onRect, "inspector/text")).toBeUndefined();
    expect(value(onRect, "radius")).toBe("0");
  });

  it("a field missing from part of the selection is shown and explained", () => {
    // Hiding it would read as "this object has no such property". It is
    // present, refused, and names the kind that lacks it.
    const document = scene([text("t"), rect("r")]);
    const panel = inspectorPanel(document, ["t", "r"]);

    const field = findNode(panel, "inspector/text")!;
    expect(field).toBeDefined();
    expect(field.description).toContain("rect");

    const edit = field.actions!.find((action) => action.name === "edit")!;
    expect(edit.unavailable).toBe("Text is not a property of rect");

    // A shared field over the same selection stays editable.
    const opacity = findNode(panel, "inspector/opacity")!;
    expect(opacity.actions![0]!.unavailable).toBeUndefined();
  });
});

describe("Mixed across a multi-selection", () => {
  it("reports a disagreement as Mixed and an agreement as the value", () => {
    const document = scene([rect("a", { opacity: 0.5 }), rect("b", { opacity: 1 })]);
    const panel = inspectorPanel(document, ["a", "b"]);

    expect(value(panel, "opacity")).toBe("Mixed");
    // They agree on rotation, so it shows the value rather than Mixed.
    expect(value(panel, "rotation")).toBe("0");
  });

  it("an agent can tell 'they differ' from 'it is empty'", () => {
    const document = scene([rect("a", { opacity: 0.5 }), rect("b", { opacity: 1 })]);
    const view = agentView(inspectorPanel(document, ["a", "b"]));

    const opacity = view.children.find((child) => child.id === "inspector/opacity")!;
    expect(opacity.value).toBe("Mixed");
    expect(opacity.value).not.toBe("");
  });
});

describe("one gesture, one undo transaction", () => {
  it("editing across N objects yields one transaction with N changes", () => {
    const document = scene([
      rect("a", { opacity: 0.1 }),
      rect("b", { opacity: 0.2 }),
      rect("c", { opacity: 0.3 }),
    ]);

    const outcome = applyEdit(document, ["a", "b", "c"], "opacity", 1);
    expect(isRefused(outcome)).toBe(false);
    const transaction = outcome as EditTransaction;

    expect(transaction.changes).toHaveLength(3);
    expect(transaction.changes.map((change) => change.objectId)).toEqual(["a", "b", "c"]);
    // The count is in the label because that is what the undo menu shows.
    expect(transaction.label).toBe("Set Opacity on 3 objects");
    // Each change carries what it replaced, so undo is a fact rather than a
    // value recomputed later against a document that has since moved.
    expect(transaction.changes.map((change) => change.from)).toEqual([0.1, 0.2, 0.3]);
  });

  it("objects already holding the value contribute no change", () => {
    // Recording them would make undo step over objects it never changed.
    const document = scene([rect("a", { opacity: 1 }), rect("b", { opacity: 0.5 })]);
    const transaction = applyEdit(document, ["a", "b"], "opacity", 1) as EditTransaction;

    expect(transaction.changes).toHaveLength(1);
    expect(transaction.changes[0]!.objectId).toBe("b");
    expect(transaction.label).toBe("Set Opacity");
  });

  it("applying to a Mixed field sets every applicable object", () => {
    const document = scene([rect("a", { opacity: 0.5 }), rect("b", { opacity: 1 })]);
    const transaction = applyEdit(document, ["a", "b"], "opacity", 0.25) as EditTransaction;

    expect(transaction.changes.map((change) => [change.objectId, change.to])).toEqual([
      ["a", 0.25],
      ["b", 0.25],
    ]);
  });

  it("a mixed-kind edit touches the objects it means something for", () => {
    const document = scene([text("t"), rect("r")]);
    const transaction = applyEdit(document, ["t", "r"], "size", 24) as EditTransaction;

    expect(transaction.changes.map((change) => change.objectId)).toEqual(["t"]);
  });
});

describe("an edit that would do nothing is refused, not silently accepted", () => {
  it("names the condition in each case", () => {
    const document = scene([rect("r")]);

    const noField = applyEdit(document, ["r"], "notAField", 1);
    expect(isRefused(noField) && noField.refused).toContain("no inspector field");

    const noSelection = applyEdit(document, [], "opacity", 1);
    expect(isRefused(noSelection) && noSelection.refused).toBe("nothing is selected");

    const wrongKind = applyEdit(document, ["r"], "size", 12);
    expect(isRefused(wrongKind) && wrongKind.refused).toBe("Size is not a property of rect");

    const alreadySet = applyEdit(document, ["r"], "opacity", 1);
    expect(isRefused(alreadySet) && alreadySet.refused).toContain("already has");
  });
});

describe("an empty selection says so", () => {
  it("reports nothing selected rather than an empty field list", () => {
    const panel = inspectorPanel(scene([rect("r")]), []);
    expect(panel.description).toBe("Nothing selected");
    expect(panel.children).toHaveLength(0);
  });
});
