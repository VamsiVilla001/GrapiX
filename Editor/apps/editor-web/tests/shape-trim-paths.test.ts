import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSceneAtFrame, type BezierPath, type ShapeSceneObject } from "@grapix/shared-types";

/**
 * Trim Paths evaluation: the per-frame sampling of the start/end/offset channels.
 *
 * The channels are plain numbers on the shape until animated, and `evaluateSceneAtFrame`
 * samples them the same way it samples the path morph — because the Editor viewport and the
 * certification harness both read the evaluated document, and a trim that jumps rather than
 * interpolates on air is the fault this test exists to catch.
 */

function shapeWithTrim(trimAnimation?: ShapeSceneObject["trimAnimation"]): ShapeSceneObject {
  const path: BezierPath = {
    closed: false,
    vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
    inTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }],
    outTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }]
  };
  return {
    id: "shape_trim",
    name: "Trimmed",
    type: "shape",
    x: 0,
    y: 0,
    zIndex: 0,
    width: 100,
    height: 100,
    fillEnabled: false,
    strokeEnabled: true,
    fillRule: "nonzero",
    path,
    trimStart: 25,
    trimEnd: 75,
    ...(trimAnimation ? { trimAnimation } : {})
  };
}

function sceneWith(object: ShapeSceneObject) {
  return {
    id: "scene_trim",
    name: "Trim Test",
    version: 1,
    revision: 1,
    canvas: { width: 1920, height: 1080, background: "#000" },
    dataContext: {},
    assets: [],
    materials: [],
    objects: [object],
    timeline: { fps: 50, durationFrames: 100, keyframes: [] },
    createdAt: "2026-08-05T00:00:00.000Z",
    updatedAt: "2026-08-05T00:00:00.000Z"
  };
}

test("a static trim passes evaluation through unchanged", () => {
  const evaluated = evaluateSceneAtFrame(sceneWith(shapeWithTrim()), 40).objects[0] as ShapeSceneObject;
  assert.equal(evaluated.trimStart, 25);
  assert.equal(evaluated.trimEnd, 75);
  assert.equal(evaluated.trimOffset, undefined);
});

test("an animated end channel interpolates between its keys and holds outside them", () => {
  const shape = shapeWithTrim({
    end: [
      { id: "t0", frame: 0, value: 0 },
      { id: "t10", frame: 10, value: 100 }
    ]
  });
  const scene = sceneWith(shape);

  const atStart = evaluateSceneAtFrame(scene, 0).objects[0] as ShapeSceneObject;
  assert.equal(atStart.trimEnd, 0);

  const atMid = evaluateSceneAtFrame(scene, 5).objects[0] as ShapeSceneObject;
  assert.equal(atMid.trimEnd, 50);

  // Holds after the last key rather than extrapolating, the same rule every channel follows.
  const atEnd = evaluateSceneAtFrame(scene, 99).objects[0] as ShapeSceneObject;
  assert.equal(atEnd.trimEnd, 100);

  // A channel with no keys is untouched by its siblings' animation.
  assert.equal(atMid.trimStart, 25);
});

test("each trim channel animates independently", () => {
  const shape = shapeWithTrim({
    start: [{ id: "s0", frame: 0, value: 0 }, { id: "s10", frame: 10, value: 50 }],
    offset: [{ id: "o0", frame: 0, value: 0 }, { id: "o10", frame: 10, value: 360 }]
  });
  const atMid = evaluateSceneAtFrame(sceneWith(shape), 5).objects[0] as ShapeSceneObject;
  assert.equal(atMid.trimStart, 25);
  assert.equal(atMid.trimOffset, 180);
  assert.equal(atMid.trimEnd, 75, "the static end holds its authored value");
});
