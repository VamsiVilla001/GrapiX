import assert from "node:assert/strict";
import test from "node:test";
import type { SceneDocument, SceneObject } from "@grapix/shared-types";
import {
  convertSceneDimensions,
  normalizeCanvasDimension,
  planCanvasConversion
} from "../src/lib/convertSceneDimensions";

function baseObject(patch: Partial<SceneObject> = {}): SceneObject {
  return {
    id: "object-1",
    name: "Quad 1",
    type: "rect",
    x: 100,
    y: 200,
    zDepth: 10,
    zIndex: 0,
    layerId: "main",
    width: 400,
    height: 100,
    rotation: 45,
    scaleX: 2,
    scaleY: 2,
    opacity: 0.5,
    visible: true,
    locked: false,
    fill: "#ffffff",
    stroke: "#000000",
    strokeWidth: 4,
    radius: 8,
    bindings: {},
    materialSlots: {},
    ...patch
  } as SceneObject;
}

function sceneWith(objects: SceneObject[], width = 1920, height = 1080): SceneDocument {
  return {
    id: "001",
    name: "Scene",
    version: 1,
    canvas: { width, height, background: "#00000000" },
    dataContext: {},
    assets: [],
    materials: [],
    objects,
    timeline: { fps: 50, durationFrames: 100, keyframes: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  } as SceneDocument;
}

test("odd and out-of-range dimensions are snapped the way the project resolution is", () => {
  assert.equal(normalizeCanvasDimension(1921, 1920), 1922);
  assert.equal(normalizeCanvasDimension(0, 1080), 1080);
  assert.equal(normalizeCanvasDimension(Number.NaN, 720), 720);
  assert.equal(normalizeCanvasDimension(4, 1080), 16);
});

test("canvas-only leaves every object exactly where the author put it", () => {
  const scene = sceneWith([baseObject()]);
  const converted = convertSceneDimensions(scene, { width: 1280, height: 720, mode: "canvas-only" });

  assert.equal(converted.canvas.width, 1280);
  assert.equal(converted.canvas.height, 720);
  assert.deepEqual(
    { x: converted.objects[0].x, y: converted.objects[0].y, width: converted.objects[0].width },
    { x: 100, y: 200, width: 400 }
  );
});

test("stretch scales each axis independently", () => {
  const scene = sceneWith([baseObject()]);
  const converted = convertSceneDimensions(scene, { width: 960, height: 1080, mode: "stretch" });
  const object = converted.objects[0];

  assert.equal(object.x, 50);
  assert.equal(object.y, 200);
  assert.equal(object.width, 200);
  assert.equal(object.height, 100);
});

test("fit keeps the aspect ratio and centres what is left over", () => {
  // 1920x1080 into 1920x1920: the smaller ratio is 1.0 on X, so nothing scales and the content
  // is pushed down by half the extra height.
  const scene = sceneWith([baseObject()]);
  const converted = convertSceneDimensions(scene, { width: 1920, height: 1920, mode: "fit" });
  const object = converted.objects[0];

  assert.equal(object.width, 400);
  assert.equal(object.height, 100);
  assert.equal(object.x, 100);
  assert.equal(object.y, 200 + (1920 - 1080) / 2);
});

test("rotation, opacity and the object scale factors are never touched", () => {
  const scene = sceneWith([baseObject()]);
  const converted = convertSceneDimensions(scene, { width: 960, height: 540, mode: "fit" });
  const object = converted.objects[0];

  assert.equal(object.rotation, 45);
  assert.equal(object.opacity, 0.5);
  assert.equal(object.scaleX, 2);
  assert.equal(object.scaleY, 2);
  // Distances do move.
  assert.equal(object.strokeWidth, 2);
  assert.equal(object.zDepth, 5);
  assert.equal((object as Extract<SceneObject, { type: "rect" }>).radius, 4);
});

test("type-specific geometry scales with the object", () => {
  const scene = sceneWith([
    baseObject({
      type: "line",
      points: [{ x: 0, y: 0 }, { x: 200, y: 100 }]
    } as Partial<SceneObject>),
    baseObject({
      id: "object-2",
      name: "Text 1",
      type: "text",
      text: "Hello",
      fontSize: 64,
      lineHeight: 80,
      fontFamily: "Inter",
      fontWeight: "400",
      align: "left"
    } as Partial<SceneObject>)
  ]);
  const converted = convertSceneDimensions(scene, { width: 960, height: 540, mode: "fit" });
  const line = converted.objects[0] as Extract<SceneObject, { type: "line" }>;
  const text = converted.objects[1] as Extract<SceneObject, { type: "text" }>;

  assert.deepEqual(line.points, [{ x: 0, y: 0 }, { x: 100, y: 50 }]);
  assert.equal(text.fontSize, 32);
  assert.equal(text.lineHeight, 40);
});

test("animated pixel channels scale but their frames and unitless channels do not", () => {
  const scene = sceneWith([
    baseObject({
      animation: {
        x: { keys: [{ id: "k1", frame: 10, value: 400, easing: "linear", outTangent: { x: 5, y: 100 } }] },
        opacity: { keys: [{ id: "k2", frame: 10, value: 1, easing: "linear" }] }
      }
    } as Partial<SceneObject>)
  ]);
  const converted = convertSceneDimensions(scene, { width: 960, height: 540, mode: "fit" });
  const animation = converted.objects[0].animation!;

  assert.equal(animation.x!.keys[0].value, 200);
  assert.equal(animation.x!.keys[0].frame, 10, "retiming an animation is not a resolution change");
  assert.equal(animation.x!.keys[0].outTangent!.x, 5);
  assert.equal(animation.x!.keys[0].outTangent!.y, 50);
  assert.equal(animation.opacity!.keys[0].value, 1);
});

test("converting to the size it already is returns the same document", () => {
  const scene = sceneWith([baseObject()]);
  assert.equal(convertSceneDimensions(scene, { width: 1920, height: 1080, mode: "fit" }), scene);
});

test("the plan reports what it is about to do before anything is applied", () => {
  const plan = planCanvasConversion(sceneWith([]), { width: 1281, height: 720, mode: "fit" });

  assert.equal(plan.to.width, 1282, "odd widths are snapped up in the plan, not silently later");
  assert.equal(plan.changed, true);
  assert.ok(plan.scaleX === plan.scaleY, "fit is uniform by definition");
});
