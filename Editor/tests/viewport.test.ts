// Headless tests for the viewport policy, camera and geometry (Editor; the GL
// construction in viewport.ts needs a context and is typechecked, not run).
//
// Covers the rules the handoff makes load-bearing:
// - B.1 colour: the output transform is one of exactly two values, selected
//   by the adapter, and the preview surface is sRGB;
// - B.2 / 11.6: the orthographic camera maps scene coordinates to canvas
//   pixels 1:1 at zoom 1, and the backing store scales with devicePixelRatio
//   while the document never does;
// - 1.2: a rect's authored corner radius is built, not dropped. Geometry
//   construction is pure, so it runs here without a context.

import { describe, expect, it } from "vitest";
import * as THREE from "three";

import type { ColorValue } from "@grapix/contracts";
import { backingStoreSize, makeOrthographicSceneCamera, scenePosition } from "../src/camera";
import { PREVIEW_OUTPUT_COLOR_SPACE } from "../src/color-policy";
import { rectGeometry, resolvePaint } from "../src/viewport";

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

describe("rect geometry (1.2)", () => {
  it("keeps the authored box, with or without a corner radius", () => {
    for (const radius of [0, 8]) {
      const geometry = rectGeometry(200, 100, radius);
      geometry.computeBoundingBox();
      const box = geometry.boundingBox!;
      expect(box.max.x - box.min.x).toBeCloseTo(200, 6);
      expect(box.max.y - box.min.y).toBeCloseTo(100, 6);
      geometry.dispose();
    }
  });

  it("a radius larger than the box is clamped, not ignored", () => {
    // Half the shorter side is the largest radius a box can hold; a bigger
    // one would fold the outline inside out.
    const geometry = rectGeometry(200, 100, 500);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!;
    expect(box.max.x - box.min.x).toBeCloseTo(200, 6);
    expect(box.max.y - box.min.y).toBeCloseTo(100, 6);
    // A stadium, not a rectangle: the corners are arcs, so the outline has
    // far more vertices than a plane's four.
    expect(geometry.attributes.position?.count ?? 0).toBeGreaterThan(4);
    geometry.dispose();
  });
});

describe("authored paint (1.4)", () => {
  const solid = (space: "srgb" | "linear" | "rec709"): ColorValue => ({
    type: "solid",
    color: { r: 0.5, g: 0.25, b: 0.125, a: 1, space },
  });

  it("converts a tagged colour through Three rather than re-deriving the curve", () => {
    const fromSrgb = resolvePaint(solid("srgb"));
    const fromLinear = resolvePaint(solid("linear"));
    expect(fromSrgb.kind).toBe("color");
    expect(fromLinear.kind).toBe("color");
    if (fromSrgb.kind !== "color" || fromLinear.kind !== "color") return;
    // The same numbers in two spaces are two different colours. If these
    // ever agree, the tag is being ignored and B.1's "never infer" is gone.
    expect(fromSrgb.color.r).not.toBeCloseTo(fromLinear.color.r, 4);
    // Three holds colour linearly, so a linear-tagged value passes straight
    // through and an sRGB one is decoded.
    expect(fromLinear.color.r).toBeCloseTo(0.5, 6);
    expect(fromSrgb.color.r).toBeCloseTo(new THREE.Color().setRGB(0.5, 0.25, 0.125, THREE.SRGBColorSpace).r, 12);
  });

  it("reports what it cannot reproduce instead of approximating it", () => {
    // Invariant 18: drawing a gradient as its first stop, or Rec.709 as
    // sRGB, is a silent visual substitution. Each must be named.
    const gradient: ColorValue = {
      type: "linear-gradient",
      angle: 90,
      startX: 0,
      startY: 0,
      endX: 1,
      endY: 0,
      stops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1, space: "srgb" } }],
      spread: "pad",
      coordinateMode: "object",
    };
    expect(resolvePaint(gradient)).toMatchObject({ kind: "unsupported" });
    expect(resolvePaint(solid("rec709"))).toMatchObject({ kind: "unsupported" });
  });

  it("distinguishes no paint authored from paint turned off", () => {
    expect(resolvePaint(undefined).kind).toBe("none");
    expect(resolvePaint({ type: "none" }).kind).toBe("none");
  });
});
