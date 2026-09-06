import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSceneAtFrame, type BezierPath, type ShapeSceneObject } from "@grapix/shared-types";

test("evaluateSceneAtFrame morphs shape path when pathAnimation keyframes exist", () => {
  const path1: BezierPath = {
    closed: true,
    vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }],
    inTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
    outTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]
  };
  const path2: BezierPath = {
    closed: true,
    vertices: [{ x: 10, y: 10 }, { x: 200, y: 10 }, { x: 200, y: 200 }, { x: 10, y: 200 }],
    inTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
    outTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]
  };

  const shape: ShapeSceneObject = {
    id: "shape_test",
    name: "Animated Path",
    type: "shape",
    x: 0,
    y: 0,
    zIndex: 0,
    width: 100,
    height: 100,
    fillEnabled: true,
    strokeEnabled: true,
    fillRule: "nonzero",
    path: path1,
    pathAnimation: [
      { id: "k0", frame: 0, value: path1 },
      { id: "k10", frame: 10, value: path2 }
    ]
  };

  const scene = {
    id: "scene_test",
    name: "Path Animation Test",
    version: 1,
    revision: 1,
    canvas: { width: 1920, height: 1080, background: "#000" },
    dataContext: {},
    assets: [],
    materials: [],
    objects: [shape],
    timeline: { fps: 50, durationFrames: 100, keyframes: [] },
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:00:00.000Z"
  };

  const evaluatedAt5 = evaluateSceneAtFrame(scene, 5).objects[0] as ShapeSceneObject;
  assert.equal(evaluatedAt5.path.vertices[0].x, 5);
  assert.equal(evaluatedAt5.path.vertices[0].y, 5);
  assert.equal(evaluatedAt5.path.vertices[1].x, 150);

  const evaluatedAt10 = evaluateSceneAtFrame(scene, 10).objects[0] as ShapeSceneObject;
  assert.equal(evaluatedAt10.path.vertices[0].x, 10);
  assert.equal(evaluatedAt10.path.vertices[1].x, 200);
});
