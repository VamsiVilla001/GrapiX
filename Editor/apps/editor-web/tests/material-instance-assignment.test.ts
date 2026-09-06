import assert from "node:assert/strict";
import test from "node:test";
import {
  createMaterialDefinition,
  resolvePrimitiveMaterial,
  type MaterialInstance,
  type RectSceneObject,
  type SceneDocument
} from "@grapix/shared-types";
import { useEditorStore } from "../src/store/editorStore";

const now = "2026-08-10T00:00:00.000Z";

function rect(): RectSceneObject {
  return {
    id: "rect-1",
    name: "Plate",
    type: "rect",
    x: 0,
    y: 0,
    zDepth: 0,
    zIndex: 0,
    layerId: "main",
    width: 400,
    height: 200,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    anchor: { x: 0, y: 0 },
    opacity: 1,
    visible: true,
    locked: false,
    fill: "#ffffff",
    stroke: "#000000",
    strokeWidth: 0,
    bindings: {},
    materialSlots: {},
    radius: 0
  };
}

function fixture() {
  const base = createMaterialDefinition("Team base", { baseColor: "#224466" });
  const other = createMaterialDefinition("Other base", { baseColor: "#111111" });
  const instance: MaterialInstance = {
    materialInstanceId: "instance-b",
    name: "Team red",
    baseMaterialId: base.materialId,
    parameterOverrides: { baseColor: "#dd2244", roughness: 0.2 },
    textureOverrides: {},
    createdAt: now,
    updatedAt: now
  };
  const scene: SceneDocument = {
    id: "scene-material-instance",
    name: "Instance assignment",
    version: 1,
    canvas: { width: 1920, height: 1080, background: "#000000" },
    dataContext: {},
    assets: [],
    materials: [base, other],
    materialInstances: [instance],
    objects: [rect()],
    timeline: { fps: 50, durationFrames: 100, keyframes: [] },
    createdAt: now,
    updatedAt: now
  };
  return { base, other, instance, scene };
}

test("assigning instance B preserves its two-part payload and projects B's parameters", () => {
  const { base, instance, scene } = fixture();
  useEditorStore.getState().loadScene(scene);

  assert.equal(useEditorStore.getState().assignMaterialToFaces("rect-1", [0], {
    materialId: base.materialId,
    instanceId: instance.materialInstanceId
  }), true);

  const stored = useEditorStore.getState().scene.objects[0];
  assert.deepEqual(stored.materialSlots.main, {
    materialId: base.materialId,
    instanceId: instance.materialInstanceId
  });
  const resolved = resolvePrimitiveMaterial(useEditorStore.getState().scene, stored, "main");
  assert.equal(resolved?.instance?.materialInstanceId, instance.materialInstanceId);
  assert.equal(resolved?.parameters.baseColor, "#dd2244");
  assert.equal(resolved?.parameters.roughness, 0.2);
});

test("an instance cannot be paired with a different base material", () => {
  const { other, instance, scene } = fixture();
  useEditorStore.getState().loadScene(scene);

  assert.equal(useEditorStore.getState().assignMaterialToFaces("rect-1", [0], {
    materialId: other.materialId,
    instanceId: instance.materialInstanceId
  }), false);
  assert.deepEqual(useEditorStore.getState().scene.objects[0].materialSlots, {});
  assert.match(useEditorStore.getState().materialActionError ?? "", /different base material/i);
});
