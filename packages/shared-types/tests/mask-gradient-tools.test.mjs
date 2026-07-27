import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateSceneAtFrame,
  normalizeColorValue,
  normalizeGradientStops
} from "../dist/index.js";

test("legacy colours normalize without changing saved appearance", () => {
  assert.deepEqual(normalizeColorValue("#23c7d9"), { type: "solid", color: "#23c7d9" });
  assert.deepEqual(normalizeColorValue("transparent"), { type: "none" });
});

test("gradient stops clamp, sort, and retain opacity", () => {
  const stops = normalizeGradientStops([
    { id: "right", position: 2, color: "#ffffff", opacity: 2 },
    { id: "left", position: -1, color: "#000000", opacity: -1 }
  ]);
  assert.deepEqual(stops.map(({ id, position, opacity }) => ({ id, position, opacity })), [
    { id: "left", position: 0, opacity: 0 },
    { id: "right", position: 1, opacity: 1 }
  ]);
});

test("mask opacity, feather, expansion, and compatible paths evaluate at the playhead", () => {
  const pathA = {
    closed: true,
    vertices: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
    inTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
    outTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]
  };
  const pathB = {
    ...pathA,
    vertices: [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }]
  };
  const object = {
    id: "rect",
    name: "Rect",
    type: "rect",
    x: 0,
    y: 0,
    zDepth: 0,
    zIndex: 0,
    layerId: "main",
    width: 100,
    height: 100,
    rotation: 0,
    opacity: 1,
    visible: true,
    locked: false,
    fill: "#ffffff",
    stroke: "transparent",
    strokeWidth: 0,
    bindings: {},
    materialSlots: {},
    radius: 0,
    masks: [{
      id: "mask",
      name: "Mask",
      path: pathA,
      mode: "add",
      inverted: false,
      opacity: 0,
      feather: { x: 0, y: 0 },
      expansion: 0,
      animation: {
        opacity: [{ id: "a", frame: 0, value: 0 }, { id: "b", frame: 10, value: 1 }],
        feather: [{ id: "a", frame: 0, value: { x: 0, y: 0 } }, { id: "b", frame: 10, value: { x: 20, y: 10 } }],
        expansion: [{ id: "a", frame: 0, value: 0 }, { id: "b", frame: 10, value: 10 }],
        path: [{ id: "a", frame: 0, value: pathA }, { id: "b", frame: 10, value: pathB }]
      }
    }]
  };
  const scene = {
    id: "scene",
    name: "Scene",
    version: 1,
    canvas: { width: 100, height: 100, background: "#000000" },
    dataContext: {},
    assets: [],
    materials: [],
    objects: [object],
    timeline: { fps: 50, durationFrames: 10, keyframes: [] },
    createdAt: "",
    updatedAt: ""
  };
  const mask = evaluateSceneAtFrame(scene, 5).objects[0].masks[0];
  assert.equal(mask.opacity, 0.5);
  assert.deepEqual(mask.feather, { x: 10, y: 5 });
  assert.equal(mask.expansion, 5);
  assert.deepEqual(mask.path.vertices[0], { x: 5, y: 5 });
});
