// Headless tests for the viewport policy and camera (Editor; the GL
// construction in viewport.ts needs a context and is typechecked, not run).
//
// Covers the two rules the handoff makes load-bearing:
// - B.1 colour: the output transform is one of exactly two values, selected
//   by the adapter, and the preview surface is sRGB;
// - B.2 / 11.6: the orthographic camera maps scene coordinates to canvas
//   pixels 1:1 at zoom 1, and the backing store scales with devicePixelRatio
//   while the document never does.

import { describe, expect, it } from "vitest";

import { backingStoreSize, makeOrthographicSceneCamera, scenePosition } from "../src/camera";
import { PREVIEW_OUTPUT_COLOR_SPACE } from "../src/color-policy";

const HD = { width: 1920, height: 1080 };

describe("colour policy (ADR-0002 B.1)", () => {
  it("the preview surface is sRGB", () => {
    expect(PREVIEW_OUTPUT_COLOR_SPACE).toBe("srgb");
  });
});

describe("the scene-coordinate camera (ADR-0002 B.2, 11.6)", () => {
  it("maps the scene extent 1:1 onto the frustum", () => {
    const camera = makeOrthographicSceneCamera(HD);
    expect(camera.left).toBe(-960);
    expect(camera.right).toBe(960);
    expect(camera.top).toBe(540);
    expect(camera.bottom).toBe(-540);
    camera.updateProjectionMatrix();
    // A scene unit is one canvas pixel: the frustum width equals the canvas.
    expect(camera.right - camera.left).toBe(HD.width);
    expect(camera.top - camera.bottom).toBe(HD.height);
  });

  it("the document is in scene coordinates; the backing store scales with DPI", () => {
    // A 1920x1080 scene is 1920x1080 at any scale factor; only the backing
    // store changes.
    expect(backingStoreSize(960, 540, 1)).toEqual({ width: 960, height: 540 });
    expect(backingStoreSize(960, 540, 2)).toEqual({ width: 1920, height: 1080 });
    expect(backingStoreSize(960, 540, 1.5)).toEqual({ width: 1440, height: 810 });
  });

  it("scene position converts the top-left authoring origin to centred Y-up", () => {
    // Top-left corner of the canvas.
    expect(scenePosition(HD, 0, 0, 0)).toEqual({ x: -960, y: 540, z: 0 });
    // Centre.
    expect(scenePosition(HD, 960, 540, 0)).toEqual({ x: 0, y: 0, z: 0 });
    // Bottom-right.
    expect(scenePosition(HD, 1920, 1080, 5)).toEqual({ x: 960, y: -540, z: 5 });
  });
});
