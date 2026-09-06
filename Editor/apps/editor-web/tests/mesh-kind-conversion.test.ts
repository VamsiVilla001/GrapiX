import assert from "node:assert/strict";
import test from "node:test";
import {
  MESH_PRIMITIVE_KINDS,
  getBindableFaces,
  normalizeSlabProperties,
  type MeshPrimitiveKind,
  type MeshSceneObject,
  type SceneDocument
} from "@grapix/shared-types";
import { useEditorStore } from "../src/store/editorStore";

const now = "2026-08-10T00:00:00.000Z";
const MODEL_FIELDS = [
  "src",
  "modelAssetId",
  "materialElements",
  "clipName",
  "clipIndex",
  "timeScale",
  "frameOffset",
  "animationLoop"
] as const;

function mesh(kind: MeshPrimitiveKind): MeshSceneObject {
  const object: MeshSceneObject = {
    id: "mesh-1",
    name: `${kind} mesh`,
    type: "mesh",
    meshKind: kind,
    x: 100,
    y: 100,
    zDepth: 0,
    zIndex: 0,
    layerId: "main",
    width: 320,
    height: 240,
    depth: 80,
    rotation: 0,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    anchor: { x: 0, y: 0 },
    anchor3d: { x: 160, y: 120, z: 40 },
    opacity: 1,
    visible: true,
    locked: false,
    fill: "#ffffff",
    stroke: "#000000",
    strokeWidth: 0,
    bindings: {},
    materialSlots: {},
    ...(kind === "slab" ? {
      slab: normalizeSlabProperties({ cornerRadius: 24, frontBevel: { enabled: true, size: 6, depth: 4 } })
    } : {}),
    ...(kind === "model" ? {
      src: "assets/model.glb",
      modelAssetId: "asset-model",
      materialElements: ["Body", "Trim"],
      clipName: "Idle",
      clipIndex: 2,
      timeScale: 0.75,
      frameOffset: 12,
      animationLoop: true
    } : {})
  };
  object.materialSlots = Object.fromEntries([
    ...getBindableFaces(object).map((face) => [face.slotKey, `mat-${face.slotKey}`] as const),
    ["invalid:stale", "mat-stale"]
  ]);
  return object;
}

function sceneOf(object: MeshSceneObject): SceneDocument {
  return {
    id: "scene-mesh-conversion",
    name: "Mesh conversion",
    version: 1,
    canvas: { width: 1920, height: 1080, background: "#000000" },
    dataContext: {},
    assets: [],
    materials: [],
    objects: [object],
    timeline: { fps: 50, durationFrames: 100, keyframes: [] },
    createdAt: now,
    updatedAt: now
  } as SceneDocument;
}

for (const from of MESH_PRIMITIVE_KINDS) {
  for (const to of MESH_PRIMITIVE_KINDS) {
    test(`converts ${from} to ${to} without stale geometry or face data`, () => {
      const original = mesh(from);
      useEditorStore.getState().loadScene(sceneOf(original));
      useEditorStore.setState({ selectedObjectId: original.id, selectedFaceIndices: [99], faceSelectionAnchor: 99 });

      assert.equal(useEditorStore.getState().convertMeshKind(original.id, to), true);
      const converted = useEditorStore.getState().scene.objects[0] as MeshSceneObject;
      const validSlots = new Set(getBindableFaces(converted).map((face) => face.slotKey));

      assert.equal(converted.meshKind, to);
      assert.deepEqual(
        Object.keys(converted.materialSlots).sort(),
        Object.keys(original.materialSlots).filter((slot) => validSlots.has(slot)).sort(),
        "only bindings named by the destination face vocabulary survive"
      );
      assert.equal(converted.materialSlots.main, original.materialSlots.main, "face zero survives every conversion");
      assert.deepEqual(useEditorStore.getState().selectedFaceIndices, [0], "an invalid selected face falls back to main");

      if (to === "slab") {
        assert.deepEqual(converted.slab, normalizeSlabProperties(from === "slab" ? original.slab : undefined));
      } else {
        assert.equal("slab" in converted, false, `${to} must not carry slab geometry fields`);
      }

      if (to === "model" && from === "model") {
        for (const field of MODEL_FIELDS) assert.deepEqual(converted[field], original[field], field);
      } else {
        for (const field of MODEL_FIELDS) {
          assert.equal(field in converted, false, `${String(field)} must not survive ${from} -> ${to}`);
        }
      }
    });
  }
}

test("conversion refuses a non-mesh object", () => {
  const document = sceneOf(mesh("cube"));
  document.objects[0] = { ...document.objects[0], type: "rect" } as never;
  useEditorStore.getState().loadScene(document);
  assert.equal(useEditorStore.getState().convertMeshKind("mesh-1", "slab"), false);
});
