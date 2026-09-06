import assert from "node:assert/strict";
import test from "node:test";
import {
  ANIMATABLE_PROPERTIES,
  evaluateSceneAtFrame,
  isPropertyAnimatable,
  preflightScenePackage,
  sampleChannel
} from "../dist/index.js";
import { animatablePropertiesContractFixture } from "../dist/fixtures.js";

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
test("shape path animation morphs vertices between keyframes", () => {
  const shape = {
    id: "shape_1",
    name: "Shape",
    type: "shape",
    x: 0,
    y: 0,
    zIndex: 0,
    width: 100,
    height: 100,
    fillEnabled: true,
    strokeEnabled: false,
    fillRule: "nonzero",
    path: {
      closed: true,
      vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }],
      inTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
      outTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]
    },
    pathAnimation: [
      {
        id: "pk0",
        frame: 0,
        value: {
          closed: true,
          vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }],
          inTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
          outTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]
        }
      },
      {
        id: "pk10",
        frame: 10,
        value: {
          closed: true,
          vertices: [{ x: 10, y: 20 }, { x: 200, y: 40 }, { x: 100, y: 200 }],
          inTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
          outTangents: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }]
        }
      }
    ]
  };

  const scene = {
    id: "scene_1",
    name: "Test",
    version: 1,
    revision: 1,
    canvas: { width: 1920, height: 1080, background: "#000" },
    dataContext: {},
    assets: [],
    materials: [],
    objects: [shape],
    timeline: { fps: 50, durationFrames: 100, keyframes: [] },
    createdAt: now,
    updatedAt: now
  };

  const evaluated = evaluateSceneAtFrame(scene, 5).objects[0];
  assert.equal(evaluated.path.vertices[0].x, 5);
  assert.equal(evaluated.path.vertices[0].y, 10);
  assert.equal(evaluated.path.vertices[1].x, 150);
});

/**
 * The animatability gate.
 *
 * `zDepth` is paint order for 2D content, resolved when a scene is prepared, so
 * `services/render-engine/src/animation.rs` discards a Z channel for rects and texts and never
 * re-sorts. The Editor used to patch it anyway and re-sort the preview every frame, so the author
 * watched an animation that did nothing on air. On the mesh path — `mesh`, and `shape`, which is
 * tessellated into a `PreparedMesh` — it is a real Z translation and stays authorable.
 */
test("zDepth is animatable only on the mesh path", () => {
  for (const objectType of ["mesh", "shape"]) {
    assert.equal(isPropertyAnimatable(objectType, "zDepth"), true, objectType);
  }
  for (const objectType of [
    "text", "rect", "ellipse", "image", "line", "paint",
    "light", "camera", "layer", "marker", "group"
  ]) {
    assert.equal(isPropertyAnimatable(objectType, "zDepth"), false, objectType);
  }
});

test("a property no renderer reads is not animatable, whatever its type", () => {
  /*
   * This used to assert that nothing but `zDepth` was gated, and that was true because the rule was
   * `return true`. A light's `rotation` and a camera's `scaleY` were therefore animatable: an author
   * could key them, ease them and scrub them, and nothing anywhere read the result. The Inspector had
   * separately reached the right answer by hiding those controls, which is two homes for one question.
   *
   * The rule now asks `PROPERTY_RENDERER_SUPPORT`, so this asserts the *reason* rather than the count.
   */
  for (const property of ANIMATABLE_PROPERTIES) {
    if (property === "zDepth") continue;
    for (const objectType of ["rect", "text", "mesh", "shape", "layer"]) {
      assert.equal(isPropertyAnimatable(objectType, property), true, `${objectType}.${property}`);
    }
  }
});

test("a light is aimed, not turned, so its orientation channels are gone", () => {
  for (const property of ["rotation", "rotationX", "rotationY", "rotationZ", "scaleX", "scaleY", "scaleZ"]) {
    assert.equal(isPropertyAnimatable("light", property), false, `light.${property}`);
  }
});

test("a light's opacity stays animatable, because both renderers read it as a dimmer", () => {
  // `ThreeSceneLayer.ts:412-413` and `document.rs:1092` multiply intensity by opacity. Gating this
  // alongside its neighbours would have removed a working control on the way to removing dead ones.
  assert.equal(isPropertyAnimatable("light", "opacity"), true);
  assert.equal(isPropertyAnimatable("light", "x"), true);
  assert.equal(isPropertyAnimatable("light", "y"), true);
});

test("a camera is positioned and aimed, so orientation and opacity are gone too", () => {
  for (const property of ["rotation", "rotationX", "rotationY", "rotationZ", "scaleX", "scaleY", "scaleZ", "opacity"]) {
    assert.equal(isPropertyAnimatable("camera", property), false, `camera.${property}`);
  }
  // Its position still animates: a camera move is the most ordinary thing an author asks for.
  assert.equal(isPropertyAnimatable("camera", "x"), true);
  assert.equal(isPropertyAnimatable("camera", "y"), true);
});

test("the emitted table is the rule, not a second copy of it", () => {
  // `services/render-engine/src/animation.rs` asserts against this file, so a table that drifts
  // from the rule would let the two languages disagree while both tests passed.
  for (const [objectType, properties] of Object.entries(animatablePropertiesContractFixture)) {
    assert.deepEqual(
      properties,
      ANIMATABLE_PROPERTIES.filter((property) => isPropertyAnimatable(objectType, property)),
      objectType
    );
  }
  assert.equal(Object.keys(animatablePropertiesContractFixture).length, 13);
});

test("a rect's zDepth channel is ignored while a mesh's is applied", () => {
  const channels = { zDepth: ramp(0, 50), x: ramp(100, 300) };

  const mesh = evaluateSceneAtFrame(meshScene(channels), 10).objects[0];
  assert.equal(mesh.zDepth, 50);
  assert.equal(mesh.x, 300);

  const rectScene = meshScene(channels);
  rectScene.objects[0] = { ...rectScene.objects[0], type: "rect" };
  const rect = evaluateSceneAtFrame(rectScene, 10).objects[0];
  // The authored value survives: nothing is rewritten, it simply does not animate.
  assert.equal(rect.zDepth, 5);
  assert.equal(rect.x, 300, "the other channels on the same object still animate");
});

test("an inert legacy channel is reported by package preflight rather than stripped", () => {
  const scene = meshScene({ zDepth: ramp(0, 50) });
  scene.objects[0] = { ...scene.objects[0], type: "rect", name: "Plate" };

  const preflight = preflightScenePackage(scene);
  const issue = preflight.issues.find((entry) => entry.code === "ANIMATION_CHANNEL_NOT_RENDERED");
  assert.ok(issue, "the channel must be reported");
  assert.equal(issue.severity, "warning");
  assert.equal(issue.objectId, "mesh_1");
  assert.match(issue.message, /Plate/);
  assert.match(issue.message, /zDepth/);
  // A warning, so the package still builds: the scene renders the same with or without the keys,
  // and blocking a publish over inert keys would stop a show for a cleanup.
  assert.equal(scene.objects[0].animation.zDepth.keys.length, 2, "keys are never stripped");
});
