import assert from "node:assert/strict";
import test from "node:test";
import type { SceneObject } from "@grapix/shared-types";
import {
  createEllipsePath,
  marqueeFromDrag,
  objectIntersectsMarquee,
  sampleColorValue,
  smoothBrushPoints
} from "../src/tools/designToolMath";
import type { MarqueeOptions } from "../src/store/uiStore";

const marqueeOptions: MarqueeOptions = {
  mode: "objects",
  operation: "new",
  constraint: "free",
  ratio: 1,
  fixedWidth: 320,
  fixedHeight: 180,
  fromCenter: false,
  feather: 0,
  antiAlias: true,
  objectContainment: "touching"
};

test("marquee normalizes every drag direction and supports centre-square constraints", () => {
  const reversed = marqueeFromDrag(
    "rectangle",
    { x: 100, y: 80 },
    { x: 20, y: 10 },
    marqueeOptions,
    { square: false, fromCenter: false }
  );
  assert.deepEqual(
    { x: reversed.x, y: reversed.y, width: reversed.width, height: reversed.height },
    { x: 20, y: 10, width: 80, height: 70 }
  );

  const centred = marqueeFromDrag(
    "ellipse",
    { x: 50, y: 50 },
    { x: 80, y: 70 },
    marqueeOptions,
    { square: true, fromCenter: true }
  );
  assert.deepEqual(
    { x: centred.x, y: centred.y, width: centred.width, height: centred.height },
    { x: 20, y: 20, width: 60, height: 60 }
  );
});

test("ellipse paths use four cubic anchors and preserve closed geometry", () => {
  const path = createEllipsePath(10, 20, 100, 60);
  assert.equal(path.closed, true);
  assert.equal(path.vertices.length, 4);
  assert.deepEqual(path.vertices[0], { x: 60, y: 20 });
  assert.ok(path.outTangents.some((handle) => handle.x !== 0 || handle.y !== 0));
});

test("object marquee hit testing respects authored rotation", () => {
  const object = {
    id: "rect_test",
    name: "Rotated",
    type: "rect",
    x: 100,
    y: 100,
    zDepth: 0,
    zIndex: 0,
    layerId: "main",
    width: 100,
    height: 40,
    rotation: 45,
    scaleX: 1,
    scaleY: 1,
    anchor: { x: 50, y: 20 },
    opacity: 1,
    visible: true,
    locked: false,
    fill: "#ffffff",
    stroke: "transparent",
    strokeWidth: 0,
    bindings: {},
    materialSlots: {},
    radius: 0
  } satisfies SceneObject;
  const selection = {
    kind: "rectangle" as const,
    x: 90,
    y: 80,
    width: 20,
    height: 20,
    feather: 0,
    operation: "new" as const
  };
  assert.equal(objectIntersectsMarquee(object, selection, "touching"), true);
  assert.equal(objectIntersectsMarquee(object, selection, "enclosed"), false);
});

test("brush smoothing resamples pressure-bearing points without mutating input", () => {
  const input = [
    { x: 0, y: 0, pressure: 0.25 },
    { x: 20, y: 0, pressure: 1 }
  ];
  const output = smoothBrushPoints(input, 0, 5);
  assert.equal(input.length, 2);
  assert.ok(output.length >= 5);
  assert.equal(output[0].pressure, 0.25);
  assert.equal(output.at(-1)?.pressure, 1);
});

test("gradient eyedropper interpolates colour and alpha", () => {
  const sampled = sampleColorValue({
    type: "linear-gradient",
    angle: 0,
    startX: 0,
    startY: 0,
    endX: 1,
    endY: 0,
    spread: "pad",
    coordinateMode: "object",
    stops: [
      { id: "left", position: 0, color: "#000000", opacity: 1 },
      { id: "right", position: 1, color: "#ffffff", opacity: 0 }
    ]
  }, { x: 0.5, y: 0 });
  assert.equal(sampled, "#80808080");
});
