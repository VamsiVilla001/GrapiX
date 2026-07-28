import assert from "node:assert/strict";
import test from "node:test";
import {
  createMaterialDefinition,
  resolvePrimitiveMaterial,
  type Material,
  type MeshSceneObject,
  type RectSceneObject,
  type SceneObject,
  type SceneDocument
} from "@grapix/shared-types";
import {
  describeMeshSurfaceMaterial,
  type MeshSurfaceMaterialDescriptor
} from "../src/rendering/ThreeSceneLayer";
import { resolveRenderableObjects } from "../src/rendering/sceneMaterial";

const timestamp = "2026-07-27T00:00:00.000Z";

function mesh(materialId?: string, opacity = 1): MeshSceneObject {
  return {
    id: "mesh_test",
    type: "mesh",
    meshKind: "cube",
    name: "Test Cube",
    x: 400,
    y: 300,
    zDepth: 0,
    zIndex: 0,
    layerId: "main",
    width: 200,
    height: 200,
    depth: 200,
    rotation: 0,
    rotationX: 20,
    rotationY: 30,
    rotationZ: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    anchor: { x: 100, y: 100 },
    anchor3d: { x: 100, y: 100, z: 100 },
    opacity,
    visible: true,
    locked: false,
    fill: "#23c7d9",
    stroke: "transparent",
    strokeWidth: 0,
    bindings: {},
    materialSlots: materialId ? { main: materialId } : {}
  };
}

function scene(material: Material, object: SceneObject = mesh(material.materialId)): SceneDocument {
  return {
    id: "scene_material_renderer",
    name: "Material Renderer Test",
    version: 1,
    canvas: { width: 1920, height: 1080, background: "#101722" },
    dataContext: {},
    assets: [],
    materials: [material],
    materialInstances: [],
    shaders: [],
    materialFolders: [],
    fonts: [],
    objects: [object],
    timeline: { fps: 60, durationFrames: 1, keyframes: [] },
    createdAt: timestamp,
    updatedAt: timestamp
  };
}

function descriptor(material: Material, objectOpacity = 1): MeshSurfaceMaterialDescriptor {
  const object = mesh(material.materialId, objectOpacity);
  const document = scene(material, object);
  const resolved = resolvePrimitiveMaterial(document, object, "main");
  return describeMeshSurfaceMaterial({
    color: String(resolved.parameters.baseColor ?? resolved.parameters.tint ?? "#ffffff"),
    opacity: Number(resolved.parameters.opacity ?? material.opacity),
    resolved
  }, object.fill, object.opacity);
}

test("legacy colour and texture inputs resolve to the same physically lit material", () => {
  const material = createMaterialDefinition("Colour", "solid-color");
  const textured = createMaterialDefinition("Texture", "image", "asset_texture");
  const result = descriptor(material);
  const texturedResult = descriptor(textured);

  assert.equal(result.lit, true);
  assert.equal(texturedResult.lit, true);
  assert.equal(result.color, "#ffffff");
  assert.equal(result.depthTest, true);
  assert.equal(result.depthWrite, true);
});

test("one material exposes physical and emissive surface values", () => {
  const material = createMaterialDefinition("Material", "pbr");
  material.parameters = {
    ...material.parameters,
    metalness: 0.72,
    roughness: 0.21,
    emissiveColor: "#123456",
    emissiveIntensity: 1.5
  };
  const result = descriptor(material);

  assert.equal(result.lit, true);
  assert.equal(result.metalness, 0.72);
  assert.equal(result.roughness, 0.21);
  assert.equal(result.emissiveColor, "#123456");
  assert.equal(result.emissiveIntensity, 1.5);
});

test("mesh material opacity is applied once per object and once per face", () => {
  const material = createMaterialDefinition("Half", "pbr");
  material.opacity = 0.5;
  material.parameters = { ...material.parameters, opacity: 0.5 };
  const object = mesh(material.materialId, 0.8);
  const rendered = resolveRenderableObjects(scene(material, object))[0];

  assert.equal(rendered.opacity, 0.8, "scene resolution must not fold the face opacity into the mesh");
  assert.equal(rendered.faceMaterials?.main.opacity, 0.5);
  const result = describeMeshSurfaceMaterial(rendered.faceMaterials?.main, rendered.fill, rendered.opacity);
  assert.equal(result.opacity, 0.4);
  assert.equal(result.transparent, true);
  assert.equal(result.depthWrite, false);
});

test("disabled material bindings preserve a visible unbound mesh fallback", () => {
  const material = createMaterialDefinition("Disabled", "pbr");
  material.enabled = false;
  const rendered = resolveRenderableObjects(scene(material))[0];

  assert.equal(rendered.resolvedMaterial, undefined);
  assert.equal(rendered.faceMaterials, undefined);
  assert.equal(rendered.visible, true);
  assert.equal(describeMeshSurfaceMaterial(undefined, rendered.fill, rendered.opacity).lit, true);
});

test("2D material assignment replaces both legacy fill and rich fillStyle", () => {
  const material = createMaterialDefinition("Red");
  material.parameters = { ...material.parameters, baseColor: "#ff3355" };
  const object: RectSceneObject = {
    id: "rect_test",
    type: "rect",
    name: "Test Rectangle",
    x: 10,
    y: 20,
    zDepth: 0,
    zIndex: 0,
    layerId: "main",
    width: 300,
    height: 180,
    radius: 12,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    anchor: { x: 0, y: 0 },
    opacity: 1,
    visible: true,
    locked: false,
    fill: "#224466",
    fillStyle: {
      type: "linear-gradient",
      angle: 0,
      startX: 0,
      startY: 0,
      endX: 1,
      endY: 0,
      stops: [
        { id: "start", position: 0, color: "#224466", opacity: 1 },
        { id: "end", position: 1, color: "#88aacc", opacity: 1 }
      ],
      spread: "pad",
      coordinateMode: "object"
    },
    stroke: "transparent",
    strokeWidth: 0,
    bindings: {},
    materialSlots: { main: material.materialId }
  };

  const rendered = resolveRenderableObjects(scene(material, object))[0];
  assert.equal(rendered.fill, "#ff3355");
  assert.deepEqual(rendered.fillStyle, { type: "solid", color: "#ff3355" });
});
