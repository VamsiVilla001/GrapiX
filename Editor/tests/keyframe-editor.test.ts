// Keyframe panel projection: diamonds, multi-select and toggle intent (11.21).
// Rust supplies the vocabulary and owns mutations; this test pins selection,
// current-frame, Mixed values and the create/remove intent a toggle carries.

import { describe, expect, it } from "vitest";

import type { AnimationSurface, SceneDocument, SceneObject } from "@grapix/contracts";
import {
  clampFrame,
  customBezierFromInputs,
  keyframeContextItems,
  keyframeForValue,
  keyframePanelModel,
  toggleIntent,
} from "../src/keyframe-editor";

const surface: AnimationSurface = {
  properties: ["opacity", "x", "width"],
  objectKinds: ["rect"],
  easings: ["linear", "hold", "ease-in", "ease-out", "ease-in-out", "custom-bezier"],
};

function rect(id: string, overrides: Record<string, unknown> = {}): SceneObject {
  return {
    type: "rect",
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 0.8,
    x: 120,
    y: 80,
    zDepth: 0,
    zIndex: 0,
    layerId: "",
    width: 640,
    height: 180,
    rotation: 0,
    rotationX: 0,
    rotationY: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    strokeWidth: 0,
    radius: 0,
    ...overrides,
  } as unknown as SceneObject;
}

function scene(objects: SceneObject[], channels: unknown[] = []): SceneDocument {
  return {
    id: "motion",
    name: "Motion",
    version: 1,
    workingColorSpace: "srgb",
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    timeline: { durationFrames: 100 as unknown as bigint, channels, phases: [] },
    dataContext: {},
    assets: [],
    fonts: [],
    materials: [],
    controls: [],
    textStyles: [],
    objects,
  } as SceneDocument;
}

const xKeyAt20 = {
  objectId: "card",
  property: "x",
  keys: [{ frame: 20 as unknown as bigint, value: 200, easing: "custom-bezier", bezier: { x1: 0.2, y1: 0.8, x2: 0.4, y2: 1 } }],
};

describe("keyframe panel model", () => {
  it("shows the evaluated value and neighboring keys at the playhead", () => {
    const document = scene([rect("card", { x: 999 })], [{ objectId: "card", property: "x", keys: [
      { frame: 0, value: 20, easing: "linear" }, { frame: 100, value: 220, easing: "linear" },
    ] }]);
    const model = keyframePanelModel(document, ["card"], surface, 50);
    expect(model.available).toBe(true);
    if (!model.available) return;
    expect(model.rows.find((row) => row.property === "x")).toMatchObject({
      value: 120, keyState: "none", previousFrame: 0, nextFrame: 100,
    });
  });
  it("uses the Rust vocabulary and marks the diamond at the playhead", () => {
    const model = keyframePanelModel(scene([rect("card")], [xKeyAt20]), ["card"], surface, 20);
    expect(model.available).toBe(true);
    if (!model.available) return;

    expect(model.rows.map((row) => row.property)).toEqual(["opacity", "x", "width"]);
    const x = model.rows.find((row) => row.property === "x")!;
    expect(x.keyState).toBe("all");
    expect(x.currentKey).toMatchObject({ value: 200, easing: "custom-bezier" });
    expect(model.rows.find((row) => row.property === "width")!.keyState).toBe("none");

    expect(keyframeContextItems(model, "x")).toEqual([
      { property: "x", label: "Remove X key at frame 20", action: "remove" },
    ]);
    expect(keyframeContextItems(model, "width")).toEqual([
      { property: "width", label: "Add Width key at frame 20", action: "create" },
    ]);
  });

  it("reports Mixed across a multi-selection and a partial key state", () => {
    const document = scene([rect("card"), rect("banner", { x: 40 })], [xKeyAt20]);
    const model = keyframePanelModel(document, ["card", "banner"], surface, 20);
    expect(model.available).toBe(true);
    if (!model.available) return;

    expect(model.single).toBe(false);
    const x = model.rows.find((row) => row.property === "x")!;
    // Values differ (120 vs 40) → Mixed.
    expect(x.value).toBeNull();
    expect(x.objectIds).toEqual(["card", "banner"]);
    // Only "card" carries a key at frame 20.
    expect(x.keyState).toBe("partial");
    expect(x.objectsWithKey).toEqual(["card"]);

    // A partial toggle adds keys to the objects that lack one, not a removal.
    expect(toggleIntent(x)).toEqual({ action: "create", objectIds: ["banner"] });

    const opacity = model.rows.find((row) => row.property === "opacity")!;
    expect(opacity.value).toBe(0.8); // shared → concrete
    expect(toggleIntent(opacity)).toEqual({ action: "create", objectIds: ["card", "banner"] });
  });

  it("names empty and non-animatable selections instead of guessing", () => {
    expect(keyframePanelModel(scene([rect("card")]), [], surface, 0)).toMatchObject({
      available: false,
      reason: "Select an object to edit keyframes",
    });
    const light = { type: "light", id: "l", name: "L" } as unknown as SceneObject;
    expect(keyframePanelModel(scene([light]), ["l"], surface, 0)).toMatchObject({
      available: false,
    });
  });

  it("clamps the playhead and keeps a created key JSON-serialisable", () => {
    expect(clampFrame(-4, 100)).toBe(0);
    expect(clampFrame(101, 100)).toBe(100);
    const key = keyframeForValue(120, 7, "ease-in-out");
    expect(typeof key.frame).toBe("number");
    expect(JSON.stringify(key)).toBe('{"frame":7,"value":120,"easing":"ease-in-out"}');
  });

  it("validates custom Bezier time controls before sending them to Rust", () => {
    expect(customBezierFromInputs([0.2, 0.8, 0.4, 1])).toEqual({ x1: 0.2, y1: 0.8, x2: 0.4, y2: 1 });
    expect(customBezierFromInputs([-0.1, 0, 0.4, 1])).toBeUndefined();
    expect(customBezierFromInputs([0.2, 0, 1.1, 1])).toBeUndefined();
  });
});
