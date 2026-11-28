// Local preview timing and scene evaluation (11.24).

import { describe, expect, it } from "vitest";

import type { AnimationSurface, SceneDocument, SceneObject } from "@grapix/contracts";
import { previewFrameAtElapsed, previewSceneAt } from "../src/preview-playback";

const surface: AnimationSurface = {
  properties: [
    "opacity",
    "x",
    "y",
    "zDepth",
    "rotation",
    "rotationX",
    "rotationY",
    "scaleX",
    "scaleY",
    "scaleZ",
    "width",
    "height",
  ],
  objectKinds: ["rect"],
  easings: ["linear"],
};

function documentWithChannels(): SceneDocument {
  const card = {
    type: "rect",
    id: "card",
    name: "Card",
    x: 10,
    y: 20,
    zDepth: 0,
    zIndex: 0,
    rotation: 0,
    rotationX: 0,
    rotationY: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    opacity: 1,
    width: 100,
    height: 50,
    radius: 0,
  } as SceneObject;
  return {
    id: "preview",
    name: "Preview",
    version: 1,
    workingColorSpace: "srgb", colorDepth: "32",
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    timeline: {
      durationFrames: 100 as unknown as bigint,
      channels: [
        {
          objectId: "card",
          property: "x",
          keys: [
            { frame: 0 as unknown as bigint, value: 10, easing: "linear" },
            { frame: 100 as unknown as bigint, value: 210, easing: "linear" },
          ],
        },
        {
          objectId: "card",
          property: "opacity",
          keys: [
            { frame: 0 as unknown as bigint, value: 1, easing: "hold" },
            { frame: 100 as unknown as bigint, value: 0, easing: "linear" },
          ],
        },
      ],
      phases: [], pathChannels: [],
    },
    dataContext: {},
    assets: [],
    fonts: [],
    materials: [],
    controls: [],
    textStyles: [], pathLinks: [], guides: [],
    objects: [card],
  } as SceneDocument;
}

describe("rational preview clock", () => {
  it("derives frames from absolute time at 30000/1001 without accumulation", () => {
    const rate = { num: 30_000, den: 1_001 };
    expect(previewFrameAtElapsed(0, 1_001, rate, 10_000)).toEqual({
      frame: 30,
      ended: false,
    });
    expect(previewFrameAtElapsed(0, 28_800_000, rate, 1_000_000).frame).toBe(863_136);
  });

  it("continues from the playhead and stops exactly at duration", () => {
    expect(previewFrameAtElapsed(40, 200, { num: 50, den: 1 }, 100)).toEqual({
      frame: 50,
      ended: false,
    });
    expect(previewFrameAtElapsed(90, 500, { num: 50, den: 1 }, 100)).toEqual({
      frame: 100,
      ended: true,
    });
  });
});

describe("preview scene evaluation", () => {
  it("applies the same eased channel model without changing authored state", () => {
    const authored = documentWithChannels();
    const result = previewSceneAt(authored, 50, surface);
    expect(result.issues).toEqual([]);
    expect(result.document.objects[0]).toMatchObject({ x: 110, opacity: 1 });
    expect(authored.objects[0]).toMatchObject({ x: 10, opacity: 1 });
  });

  it("names unsupported and duplicate channels rather than dropping them", () => {
    const authored = documentWithChannels();
    const duplicate = authored.timeline.channels[0]!;
    const invalid = {
      ...authored,
      timeline: {
        ...authored.timeline,
        channels: [
          ...authored.timeline.channels,
          duplicate,
          { ...duplicate, property: "notAProperty" },
          { ...duplicate, objectId: "missing" },
        ],
      },
    };
    const result = previewSceneAt(invalid, 10, surface);
    expect(result.issues).toEqual([
      "animation preview refused duplicate channel card.x",
      "animation preview does not support property notAProperty on card",
      "animation preview cannot find object missing",
    ]);
  });

  it("names a missing Rust animation surface", () => {
    const authored = documentWithChannels();
    const result = previewSceneAt(authored, 10, null);
    expect(result.document).toBe(authored);
    expect(result.issues).toEqual([
      "animation preview unavailable: the Rust animation surface was not loaded",
    ]);
  });
});

describe("the dash offset channel in the preview", () => {
  const dashSurface: AnimationSurface = {
    properties: ["strokeStyle.dashOffset", "x"],
    objectKinds: ["rect"],
    propertyKinds: { "strokeStyle.dashOffset": ["rect"], x: ["rect"] },
    easings: ["linear"],
  };
  const keys = [
    { frame: 0 as unknown as bigint, value: 0, easing: "linear" },
    { frame: 10 as unknown as bigint, value: 100, easing: "linear" },
  ];
  const withStyle = (strokeStyle: unknown): SceneDocument => {
    const base = documentWithChannels();
    const card = { ...base.objects[0]!, ...(strokeStyle === undefined ? {} : { strokeStyle }) } as SceneObject;
    return { ...base, objects: [card], timeline: { ...base.timeline, channels: [{ objectId: "card", property: "strokeStyle.dashOffset", keys }] } } as SceneDocument;
  };
  const styleOf = (doc: SceneDocument) => (doc.objects[0] as unknown as { strokeStyle?: Record<string, unknown> }).strokeStyle;

  it("sets the offset inside the object's stroke style and keeps its dash pattern, join, cap and miter limit", () => {
    const authored = { join: "round", cap: "square", miterLimit: 2, dash: [8, 4], dashOffset: 0 };
    const evaluated = previewSceneAt(withStyle(authored), 5, dashSurface);
    expect(evaluated.issues).toEqual([]);
    expect(styleOf(evaluated.document)).toEqual({ ...authored, dashOffset: 50 });
  });

  it("makes no top-level field named after the path", () => {
    const evaluated = previewSceneAt(withStyle({ join: "miter", cap: "butt", miterLimit: 4, dash: [], dashOffset: 0 }), 5, dashSurface);
    expect(Object.keys(evaluated.document.objects[0]!)).not.toContain("strokeStyle.dashOffset");
  });

  it("starts from the contract's default style when the object stores none", () => {
    const evaluated = previewSceneAt(withStyle(undefined), 10, dashSurface);
    expect(styleOf(evaluated.document)).toEqual({ join: "miter", cap: "butt", miterLimit: 4, dash: [], dashOffset: 100 });
  });

  it("leaves the authored document untouched", () => {
    const authored = { join: "round", cap: "butt", miterLimit: 4, dash: [2], dashOffset: 1 };
    const doc = withStyle(authored);
    previewSceneAt(doc, 5, dashSurface);
    expect(styleOf(doc)).toEqual(authored);
  });

  it("evaluates a plain channel beside it as before", () => {
    const doc = documentWithChannels();
    const channels = [...doc.timeline.channels, { objectId: "card", property: "strokeStyle.dashOffset", keys }];
    const evaluated = previewSceneAt({ ...doc, timeline: { ...doc.timeline, channels } } as SceneDocument, 5, dashSurface);
    expect((evaluated.document.objects[0] as unknown as { x: number }).x).toBeGreaterThan(10);
    expect(styleOf(evaluated.document)?.["dashOffset"]).toBe(50);
  });
});
