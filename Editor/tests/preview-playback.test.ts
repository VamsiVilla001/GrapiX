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
    workingColorSpace: "srgb",
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
      phases: [],
    },
    dataContext: {},
    assets: [],
    fonts: [],
    materials: [],
    controls: [],
    textStyles: [],
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
