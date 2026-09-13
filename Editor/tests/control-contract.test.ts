import { describe, expect, it } from "vitest";

import type { SceneDocument } from "@grapix/contracts";

import { findNode } from "../src/agent-surface";
import { controlContractPanel } from "../src/control-contract";

function scene(): SceneDocument {
  return {
    id: "scoreboard",
    name: "Scoreboard",
    version: 1,
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    timeline: { durationFrames: 1 },
    dataContext: {},
    assets: [],
    fonts: [],
    materials: [],
    controls: [
      {
        fieldId: "headline",
        label: "Headline",
        objectId: "title",
        property: "text",
        kind: "text",
        default: { type: "text", value: "Tonight" },
      },
    ],
    objects: [
      {
        type: "text",
        id: "title",
        name: "Title",
        visible: true,
        locked: false,
        opacity: 1,
        x: 0,
        y: 0,
        zDepth: 0,
        zIndex: 0,
        layerId: "",
        width: 200,
        height: 50,
        rotation: 0,
        rotationX: 0,
        rotationY: 0,
        scaleX: 1,
        scaleY: 1,
        scaleZ: 1,
        strokeWidth: 0,
        text: "Tonight",
        fontId: "brand",
        fontSize: 32,
      },
    ],
  } as unknown as SceneDocument;
}

describe("declared template controls", () => {
  it("states each declared target and concrete type, with editable metadata", () => {
    const panel = controlContractPanel(scene());
    const row = findNode(panel, "control/field/headline")!;

    expect(row.description).toBe("title.text · Text");
    expect(row.actions?.map((action) => action.name)).toEqual(["setLabel", "setDefault", "remove"]);
  });

  it("offers only Rust-supplied properties for the selected object", () => {
    const panel = controlContractPanel(scene(), {
      selectedIds: ["title"],
      fillableProperties: [{ property: "text", kind: "text" }],
    });

    expect(findNode(panel, "control/property/text")?.actions?.[0]?.unavailable).toBeUndefined();
    expect(findNode(panel, "control/property/fontId")).toBeUndefined();
  });

  it("names why declaration is unavailable when no object is selected", () => {
    const panel = controlContractPanel(scene(), {
      fillableProperties: [{ property: "text", kind: "text" }],
    });

    expect(findNode(panel, "control/property/text")?.actions?.[0]?.unavailable).toBe(
      "Select one object to declare an operator field",
    );
  });
});
