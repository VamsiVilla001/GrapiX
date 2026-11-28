// A dash pattern's entries are animatable one by one (`strokeStyle.dash.N`, released by codex, Panchayati 749): a Properties row per
// entry, a name a person counts from 1, the value an entry has, and what the Draft view draws between keys.

import { describe, expect, it } from "vitest";

import type { SceneDocument } from "@grapix/contracts";

import { findNode } from "../src/agent-surface";
import { dashIndexOf, fieldEditLabel, inspectorPanel, inspectorSections, parseFieldInput } from "../src/inspector";
import { baseValueOf, propertyLabel } from "../src/keyframe-editor";
import { previewSceneAt } from "../src/preview-playback";

const stroke = (dash: number[], dashOffset = 0) => ({ join: "miter", cap: "butt", miterLimit: 4, dash, dashOffset });

const doc = (): SceneDocument =>
  ({
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    objects: [
      { id: "a", name: "A", type: "rect", strokeWidth: 2, strokeStyle: stroke([10, 5, 3], 2) },
      { id: "b", name: "B", type: "rect", strokeWidth: 2, strokeStyle: stroke([8]) },
      { id: "c", name: "C", type: "rect", strokeWidth: 2 },
      { id: "t", name: "T", type: "group", childIds: [] },
    ],
    timeline: {
      durationFrames: 100n,
      channels: [
        { objectId: "a", property: "strokeStyle.dash.1", keys: [{ frame: 0n, value: 0, easing: "linear" }, { frame: 10n, value: 20, easing: "linear" }] },
      ],
      phases: [],
      pathChannels: [],
    },
  }) as unknown as SceneDocument;

const surface = { properties: ["strokeStyle.dash.0", "strokeStyle.dash.1", "strokeStyle.dash.2", "strokeStyle.dash.4"], objectKinds: ["rect"], easings: ["linear"] } as never;

describe("dash entries", () => {
  it("are addressed as strokeStyle.dash.N and counted from 1 by a person", () => {
    expect(dashIndexOf("strokeStyle.dash.0")).toBe(0);
    expect(dashIndexOf("strokeStyle.dash.12")).toBe(12);
    for (const bad of ["strokeStyle.dash", "strokeStyle.dash.", "strokeStyle.dash.01", "strokeStyle.dash.-1", "strokeStyle.dashOffset", "strokeStyle.dash.1x"]) {
      expect(dashIndexOf(bad), bad).toBeUndefined();
    }
    expect(propertyLabel("strokeStyle.dash.0")).toBe("Dash 1");
    expect(propertyLabel("strokeStyle.dash.2")).toBe("Dash 3");
    expect(propertyLabel("strokeStyle.dashOffset")).toBe("Dash offset");
    expect(fieldEditLabel("strokeStyle.dash.1", 1)).toBe("Set Dash 2");
  });

  it("read the entry's value, and nothing where the stroke has no such entry", () => {
    const document = doc();
    expect(baseValueOf(document, "a", "strokeStyle.dash.0")).toBe(10);
    expect(baseValueOf(document, "a", "strokeStyle.dash.2")).toBe(3);
    expect(baseValueOf(document, "b", "strokeStyle.dash.1")).toBeUndefined();
    expect(baseValueOf(document, "c", "strokeStyle.dash.0")).toBeUndefined();
  });

  it("are rows in the Stroke section, one per entry of the longest selected pattern, after the width and offset", () => {
    const panel = inspectorPanel(doc(), ["a"]);
    const stroke_ = inspectorSections(panel).find((section) => section.id === "stroke")!;
    expect(stroke_.fields.map((field) => field.label)).toEqual(["Stroke width", "Dash offset", "Dash 1", "Dash 2", "Dash 3"]);
    expect(findNode(panel, "inspector/strokeStyle.dash.1")!.input!.value).toBe("5");
    // Two strokes: the longer pattern sets the rows, and the shorter one is told it has no such entry.
    const both = inspectorPanel(doc(), ["a", "b"]);
    expect(inspectorSections(both).find((section) => section.id === "stroke")!.fields.map((field) => field.label)).toEqual(["Stroke width", "Dash offset", "Dash 1", "Dash 2", "Dash 3"]);
    expect(findNode(both, "inspector/strokeStyle.dash.0")!.input!.mixed).toBe(true);
    expect(findNode(both, "inspector/strokeStyle.dash.1")!.input!.value).toBe("5");
  });

  it("are not offered where nothing has a pattern", () => {
    const none = inspectorPanel(doc(), ["c"]);
    expect(inspectorSections(none).find((section) => section.id === "stroke")!.fields.map((field) => field.label)).toEqual(["Stroke width", "Dash offset"]);
    expect(findNode(inspectorPanel(doc(), ["t"]), "inspector/strokeStyle.dash.0")).toBeUndefined();
  });

  it("take a finite number from a person", () => {
    expect(parseFieldInput("strokeStyle.dash.0", "7.5")).toEqual({ value: 7.5 });
    expect(parseFieldInput("strokeStyle.dash.0", "abc")).toEqual({ refused: 'Dash 1 needs a finite number, not "abc"' });
    expect(parseFieldInput("strokeStyle.dash.0", "")).toEqual({ refused: 'Dash 1 needs a finite number, not ""' });
  });
});

describe("dash entries in the Draft view", () => {
  it("move between keys while the rest of the stroke style stays as authored", () => {
    const at5 = previewSceneAt(doc(), 5, surface).document;
    const style = (at5.objects[0] as unknown as { strokeStyle: ReturnType<typeof stroke> }).strokeStyle;
    expect(style.dash).toEqual([10, 10, 3]);
    expect(style).toMatchObject({ join: "miter", cap: "butt", miterLimit: 4, dashOffset: 2 });
    // The other strokes are not touched.
    expect((at5.objects[1] as unknown as { strokeStyle: ReturnType<typeof stroke> }).strokeStyle.dash).toEqual([8]);
  });

  it("ignore an entry past the authored pattern", () => {
    const document = doc();
    document.timeline.channels.push({ objectId: "b", property: "strokeStyle.dash.4", keys: [{ frame: 0n, value: 1, easing: "linear" }] } as never);
    const drawn = previewSceneAt(document, 0, surface).document;
    expect((drawn.objects[1] as unknown as { strokeStyle: ReturnType<typeof stroke> }).strokeStyle.dash).toEqual([8]);
  });
});
