import { describe, expect, it } from "vitest";

import type { ControlField, ControlValue, SceneDocument } from "@grapix/contracts";
import { findNode } from "../src/agent-surface";
import { takePagePanel, valueForField } from "../src/take-page";

const title: ControlField = {
  fieldId: "headline",
  label: "Headline",
  objectId: "title",
  property: "text",
  kind: "text",
  default: { type: "text", value: "Breaking news" },
};

function template(controls: readonly ControlField[]): SceneDocument {
  return {
    id: "lower-third",
    name: "Lower Third",
    version: 1,
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    timeline: { durationFrames: 1 as unknown as bigint, channels: [], phases: [] },
    dataContext: {},
    assets: [],
    fonts: [],
    materials: [],
    controls: [...controls],
    textStyles: [],
    objects: [],
  } as SceneDocument;
}

describe("take-page operator form", () => {
  it("generates one row from every declared field", () => {
    const score: ControlField = {
      fieldId: "score",
      label: "Home score",
      objectId: "score",
      property: "text",
      kind: "number",
      default: { type: "number", value: 0 },
    };
    const panel = takePagePanel(template([title, score]), {
      values: {},
      pageId: "",
      name: "",
    });

    expect(findNode(panel, "take-page/field/headline")?.label).toBe("Headline");
    expect(findNode(panel, "take-page/field/score")?.label).toBe("Home score");
  });

  it("keeps a Rust-reported type mismatch visible instead of substituting the default", () => {
    const wrongValue = { type: "number", value: 9 } as ControlValue;
    const panel = takePagePanel(template([title]), {
      values: { headline: wrongValue },
      pageId: "breaking",
      name: "Breaking",
      refusal: "control field headline requires text, not number",
    });

    expect(valueForField(title, { values: { headline: wrongValue }, pageId: "", name: "" })).toBe(
      wrongValue,
    );
    expect(findNode(panel, "take-page/refusal")?.value).toContain("headline requires text");
  });
});
