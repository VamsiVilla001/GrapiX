import assert from "node:assert/strict";
import test from "node:test";
import {
  ANIMATABLE_PROPERTIES,
  evaluateSceneAtFrame,
  sampleChannel
} from "../dist/index.js";

/**
 * The animation specification both renderers implement.
 *
 * There are two implementations of this: `evaluateSceneAtFrame` here, which the Editor viewport
 * samples with, and `SceneAnimation` in `services/render-engine/src/animation.rs`, which Program
 * samples with. They must agree, because a scene that animates in the Editor and sits still on
 * air — which is exactly what happened before the Rust side existed — is a silent on-air fault.
 *
 * These tests pin the parts that are easy to get subtly different: which properties are
 * animatable, the hold-not-extrapolate rule, where segment easing comes from, and the shared
 * rotation axis.
 */

const now = "2026-07-29T00:00:00.000Z";

function meshScene(animation, timeline = { keyframes: [] }) {
  return {
    id: "spec_scene",
    name: "Spec",
    version: 1,
    canvas: { width: 1920, height: 1080, background: "#00000000" },
    dataContext: {},
    assets: [],
    materials: [],
    objects: [
      {
        id: "mesh_1",
        name: "Cube",
        type: "mesh",
        meshKind: "cube",
        depth: 200,
        x: 100,
        y: 200,
        zDepth: 5,
        zIndex: 0,
        layerId: "main",
        width: 200,
        height: 200,
        rotation: 30,
        rotationX: 10,
        rotationY: 20,
        scaleX: 2,
        scaleY: 3,
        scaleZ: 4,
        anchor: { x: 0, y: 0 },
        opacity: 1,
        visible: true,
        locked: false,
        fill: "#c98b3a",
        stroke: "#ffffff",
        strokeWidth: 0,
        bindings: {},
        materialSlots: {},
        animation
      }
    ],
    timeline: {
      fps: 50,
      durationFrames: 100,
      frameRate: { numerator: 50, denominator: 1 },
      ...timeline
    },
    createdAt: now,
    updatedAt: now
  };
}

/** A two-key channel between two values. */
const ramp = (from, to, lastFrame = 10, easing = "linear") => ({
  keys: [
    { id: "a", frame: 0, value: from, easing },
    { id: "b", frame: lastFrame, value: to, easing }
  ]
});

test("the animatable property set is exactly what both renderers implement", () => {
  // The Rust side parses these names in `AnimatedProperty::parse`. Adding one here without
  // adding it there gives a property that animates in the Editor and not on air.
  assert.deepEqual(
    [...ANIMATABLE_PROPERTIES].sort(),
    [
      "opacity",
      "rotation",
      "rotationX",
      "rotationY",
      "rotationZ",
      "scaleX",
      "scaleY",
      "scaleZ",
      "x",
      "y",
      "zDepth"
    ]
  );
});

test("a mesh samples all three translation and rotation axes", () => {
  const scene = meshScene({
    x: ramp(100, 300),
    y: ramp(200, 600),
    zDepth: ramp(0, 50),
    rotationX: ramp(0, 90),
    rotationY: ramp(0, 45),
    scaleZ: ramp(1, 3)
  });

  const midpoint = evaluateSceneAtFrame(scene, 5).objects[0];
  assert.equal(midpoint.x, 200);
  assert.equal(midpoint.y, 400);
  assert.equal(midpoint.zDepth, 25);
  assert.equal(midpoint.rotationX, 45);
  assert.equal(midpoint.rotationY, 22.5);
  assert.equal(midpoint.scaleZ, 2);
});

test("rotationZ and rotation are one axis, and rotationZ is the one consumers read", () => {
  const scene = meshScene({
    rotation: ramp(15, 15),
    rotationZ: ramp(90, 90)
  });
  const evaluated = evaluateSceneAtFrame(scene, 5).objects[0];

  // Both are patched — they are separate channels here — but every consumer resolves the axis
  // as `rotationZ ?? rotation`, which is what the Rust side collapses them to.
  assert.equal(evaluated.rotationZ, 90);
  assert.equal(evaluated.rotationZ ?? evaluated.rotation, 90);
});

test("values hold outside the keyed range instead of extrapolating", () => {
  const scene = meshScene({ x: { keys: [
    { id: "a", frame: 10, value: 100, easing: "linear" },
    { id: "b", frame: 20, value: 200, easing: "linear" }
  ] } });

  // Extrapolating would fling a graphic off the canvas before its In animation started.
  assert.equal(evaluateSceneAtFrame(scene, 0).objects[0].x, 100);
  assert.equal(evaluateSceneAtFrame(scene, 999).objects[0].x, 200);
});

test("segment easing comes from the outgoing key", () => {
  // ease-in at the midpoint is 0.5^2 = 0.25. Taking easing from the incoming key instead would
  // reverse every curve in the show.
  const eased = sampleChannel(
    { keys: [
      { id: "a", frame: 0, value: 0, easing: "ease-in" },
      { id: "b", frame: 10, value: 100, easing: "linear" }
    ] },
    5
  );
  assert.ok(Math.abs(eased - 25) < 1e-9, `got ${eased}`);
});

test("each named easing curve has the shape the Rust side reproduces", () => {
  const at = (easing, frame) =>
    sampleChannel(
      { keys: [
        { id: "a", frame: 0, value: 0, easing },
        { id: "b", frame: 100, value: 100, easing: "linear" }
      ] },
      frame
    );

  assert.equal(at("linear", 50), 50);
  assert.equal(at("ease-in", 50), 25);
  assert.equal(at("ease-out", 50), 75);
  assert.ok(Math.abs(at("ease-in-out", 25) - 12.5) < 1e-9);
  assert.ok(Math.abs(at("ease-in-out", 75) - 87.5) < 1e-9);
});

test("a per-property channel wins over a legacy keyframe for the same property", () => {
  const scene = meshScene({ x: ramp(0, 10) }, {
    keyframes: [
      { id: "l0", objectId: "mesh_1", frame: 0, easing: "linear", properties: { x: 500, y: 5 } },
      { id: "l1", objectId: "mesh_1", frame: 10, easing: "linear", properties: { x: 900, y: 25 } }
    ]
  });

  const evaluated = evaluateSceneAtFrame(scene, 5).objects[0];
  assert.equal(evaluated.x, 5, "the channel, not the legacy snapshot");
  assert.equal(evaluated.y, 15, "y exists only in the legacy model, so it still applies");
});

test("a scene with no animation is returned unchanged", () => {
  const scene = meshScene({});
  // Reference equality: the evaluator must not clone a still scene on every frame.
  assert.equal(evaluateSceneAtFrame(scene, 42), scene);
});
