// The type-aware inspector (11.9): Mixed state, and one undo per gesture.
//
// Two failures these tests exist to prevent:
//   - a disagreement rendered as the first object's value, which silently
//     flattens a property across a selection the author never touched;
//   - one gesture becoming N undo steps, after which an author presses undo,
//     sees most of their change still applied, and stops trusting undo.

import { describe, expect, it } from "vitest";

import type { SceneDocument, SceneEdit, SceneObject } from "@grapix/contracts";
import { agentView, findNode } from "../src/agent-surface";
import {
  fieldEditLabel,
  fieldEditStart,
  inspectorEdits,
  inspectorPanel,
  isRefused,
  parseFieldInput,
  type EditRefused,
} from "../src/inspector";

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

function group(id: string, childIds: string[], overrides: Record<string, unknown> = {}): SceneObject {
  return { type: "group", ...base(id, id), childIds, ...overrides } as unknown as SceneObject;
}

// The edit rules (Mixed-kind refusal, unchanged-value refusal, inherited hide
// and lock) are Rust's (`gx_contracts::object_edit`) and tested there. The
// inspector's job is to turn one gesture into the one batch Rust applies.
describe("one gesture is one atomic SceneEdit batch", () => {
  it("a field edit across N objects is one setObjectField naming all N", () => {
    const document = scene([
      rect("a", { opacity: 0.1 }),
      rect("b", { opacity: 0.2 }),
      rect("c", { opacity: 0.3 }),
    ]);
    expect(inspectorEdits(document, ["a", "b", "c"], "opacity", 0.75)).toEqual([
      { edit: "setObjectField", objectIds: ["a", "b", "c"], field: { name: "opacity", value: 0.75 } },
    ]);
  });

  it("a mixed-kind selection is sent whole, so Rust refuses it for the selection", () => {
    const document = scene([text("t"), rect("r")]);
    expect(inspectorEdits(document, ["t", "r"], "size", 24)).toEqual([
      { edit: "setObjectField", objectIds: ["t", "r"], field: { name: "size", value: 24 } },
    ]);
  });

  it("ids no longer in the document are not sent", () => {
    const document = scene([rect("a")]);
    expect(inspectorEdits(document, ["a", "gone"], "x", 5)).toEqual([
      { edit: "setObjectField", objectIds: ["a"], field: { name: "x", value: 5 } },
    ]);
  });

  it("name, visibility and lock are the object manager's own edits, one per object", () => {
    const document = scene([rect("a"), rect("b")]);
    expect(inspectorEdits(document, ["a", "b"], "name", "Card")).toEqual([
      { edit: "renameObject", objectId: "a", name: "Card" },
      { edit: "renameObject", objectId: "b", name: "Card" },
    ]);
    expect(inspectorEdits(document, ["a"], "locked", true)).toEqual([
      { edit: "setObjectLocked", objectId: "a", locked: true },
    ]);
  });

  it("orders a group and its child so the batch cannot refuse on itself", () => {
    // Rust refuses a change under a hidden or locked ancestor, so hiding runs
    // innermost first and showing outermost first.
    const document = scene([group("g", ["child"]), rect("child")]);
    const order = (field: string, value: boolean): string[] => {
      const edits = inspectorEdits(document, ["g", "child"], field, value);
      if (isRefused(edits)) throw new Error(edits.refused);
      return edits.map((edit) => ("objectId" in edit ? edit.objectId : edit.edit));
    };
    expect(order("visible", false)).toEqual(["child", "g"]);
    expect(order("visible", true)).toEqual(["g", "child"]);
    expect(order("locked", true)).toEqual(["child", "g"]);
    expect(order("locked", false)).toEqual(["g", "child"]);
  });

  it("names what it cannot build", () => {
    const document = scene([rect("r")]);
    const refused = (outcome: readonly SceneEdit[] | EditRefused): string | undefined =>
      isRefused(outcome) ? outcome.refused : undefined;
    expect(refused(inspectorEdits(document, ["r"], "notAField", 1))).toContain("no inspector field");
    expect(refused(inspectorEdits(document, [], "opacity", 1))).toBe("nothing is selected");
    expect(refused(inspectorEdits(document, ["r"], "opacity", "high"))).toBe("Opacity cannot be set to high");
  });

  it("the history label counts the objects Rust changed", () => {
    expect(fieldEditLabel("opacity", 3)).toBe("Set Opacity on 3 objects");
    expect(fieldEditLabel("opacity", 1)).toBe("Set Opacity");
  });

  it("the panel explains a field missing from part of the selection before any edit", () => {
    const panel = inspectorPanel(scene([text("t"), rect("r")]), ["t", "r"]);
    expect(findNode(panel, "inspector/size")!.actions![0]!.unavailable).toBe(
      "Size is not a property of rect",
    );
  });
});

describe("typed entries become field values or named refusals", () => {
  it("parses per field kind and refuses rather than clamps", () => {
    expect(parseFieldInput("opacity", "50%")).toEqual({ value: 0.5 });
    expect(parseFieldInput("opacity", "0.25")).toEqual({ value: 0.25 });
    expect(isRefused(parseFieldInput("opacity", "150%"))).toBe(true);
    expect(parseFieldInput("x", " 12.5 ")).toEqual({ value: 12.5 });
    expect(isRefused(parseFieldInput("x", "twelve"))).toBe(true);
    expect(isRefused(parseFieldInput("x", ""))).toBe(true);
    expect(parseFieldInput("visible", "false")).toEqual({ value: false });
    expect(isRefused(parseFieldInput("visible", "no"))).toBe(true);
    expect(isRefused(parseFieldInput("name", "   "))).toBe(true);
    expect(parseFieldInput("text", " spaced ")).toEqual({ value: " spaced " });
  });

  it("a Mixed field starts the prompt empty rather than from one object", () => {
    const document = scene([rect("a", { opacity: 0.5 }), rect("b", { opacity: 1 })]);
    expect(fieldEditStart(document, ["a", "b"], "opacity")).toEqual({
      label: "Opacity",
      initial: "",
      mixed: true,
    });
    expect(fieldEditStart(document, ["a"], "opacity")?.initial).toBe("0.5");
  });
});

describe("an empty selection says so", () => {
  it("reports nothing selected rather than an empty field list", () => {
    const panel = inspectorPanel(scene([rect("r")]), []);
    expect(panel.description).toBe("Nothing selected");
    expect(panel.children).toHaveLength(0);
  });
});
