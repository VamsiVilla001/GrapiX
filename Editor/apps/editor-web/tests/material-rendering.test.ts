import assert from "node:assert/strict";
import test from "node:test";
import {
  createMaterialDefinition,
  resolvePrimitiveMaterial,
  type Material,
  type MeshSceneObject,
  type ImageSceneObject,
  type RectSceneObject,
  type SceneObject,
  type SceneDocument
} from "@grapix/shared-types";
import {
  describeMeshSurfaceMaterial,
  projectMeshBounds,
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
  assert.equal(rendered.faceMaterials?.main.color, "#ff3355");
  assert.equal(rendered.faceMaterials?.main.resolved.material.materialId, material.materialId);
});

test("textured canonical material reaches a flat object as one physical surface", () => {
  const material = createMaterialDefinition("Screen", { baseTextureAssetId: "asset_screen" });
  const object = {
    ...mesh(undefined),
    id: "rect_screen",
    type: "rect" as const,
    name: "Screen",
    width: 640,
    height: 360,
    radius: 0,
    depth: undefined,
    meshKind: undefined,
    rotationX: undefined,
    rotationY: undefined,
    rotationZ: undefined,
    anchor3d: undefined,
    materialSlots: { main: material.materialId }
  } as unknown as RectSceneObject;
  const document = scene(material, object);
  document.assets = [{
    assetId: "asset_screen",
    name: "Screen texture",
    kind: "image",
    source: "data:image/png;base64,AA==",
    mimeType: "image/png",
    importedAt: timestamp,
    status: "READY"
  }];

  const rendered = resolveRenderableObjects(document)[0];
  assert.equal(rendered.materialAssetSource, "data:image/png;base64,AA==");
  assert.equal(rendered.faceMaterials?.main.assetSource, "data:image/png;base64,AA==");
  assert.equal(rendered.faceMaterials?.main.resolved.material.type, "pbr");
});

test("direct image assets carry MIME hints for extension-less content URLs", () => {
  const material = createMaterialDefinition("Unused", "pbr");
  const source = "http://127.0.0.1:4100/api/assets/asset_imported/content";
  const object: ImageSceneObject = {
    ...mesh(undefined),
    id: "image_imported",
    type: "image",
    name: "Imported image",
    src: source,
    objectFit: "stretch"
  } as ImageSceneObject;
  const document = scene(material, object);
  document.assets = [{
    assetId: "asset_imported",
    name: "Imported image",
    kind: "image",
    source,
    mimeType: "image/webp",
    importedAt: timestamp,
    status: "READY"
  }];

  const rendered = resolveRenderableObjects(document)[0];
  assert.equal(rendered.type, "image");
  assert.equal(rendered.materialAssetMime, "image/webp");
});

test("Three.js projection follows GrapiX canvas movement without mirroring either axis", () => {
  const material = createMaterialDefinition("Projection", "pbr");
  const object = mesh(material.materialId);
  const document = scene(material, object);
  const initial = projectMeshBounds(document, object);

  assert.ok(Math.abs(initial.center.x - object.x) < 0.001);
  assert.ok(Math.abs(initial.center.y - object.y) < 0.001);

  const moved = { ...object, x: object.x + 125, y: object.y + 80 };
  document.objects = [moved];
  const projected = projectMeshBounds(document, moved);
  assert.ok(Math.abs(projected.center.x - (initial.center.x + 125)) < 0.001);
  assert.ok(Math.abs(projected.center.y - (initial.center.y + 80)) < 0.001);
});

test("a Z rotation turns the same way on screen as it does on the canvas", () => {
  // The editor's 3D layer converts canvas Y (down-positive) to three.js world Y by negating it.
  // Negating an axis reverses rotations about the other two, so X and Z rotations have to be
  // negated alongside it. This is invisible on an unrotated object, which is why it needs a test:
  // the previous approach reflected the whole content root, got the reversal for free, and
  // silently mirrored every texture and triangle winding as the price.
  const material = createMaterialDefinition("Rotation", "pbr");
  const flat = {
    ...mesh(material.materialId),
    // A wide, shallow slab so a Z rotation changes the bounds unmistakably.
    width: 400,
    height: 40,
    depth: 40,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0
  };
  const document = scene(material, flat);

  const unrotated = projectMeshBounds(document, flat);
  assert.ok(unrotated.width > unrotated.height, "the slab starts wider than it is tall");

  const quarter = { ...flat, rotationZ: 90 };
  document.objects = [quarter];
  const turned = projectMeshBounds(document, quarter);
  assert.ok(turned.height > turned.width, "a quarter turn makes the slab taller than it is wide");

  // Direction, which is what a sign error breaks. On the canvas Y grows downward, so a positive
  // rotation must extend the slab further down the screen than its unrotated extent.
  const tilted = { ...flat, rotationZ: 20 };
  document.objects = [tilted];
  const tiltedBounds = projectMeshBounds(document, tilted);
  assert.ok(
    tiltedBounds.y + tiltedBounds.height > unrotated.y + unrotated.height,
    "a positive canvas rotation must extend the slab downward, not upward"
  );
});

test("rotating a sphere keeps its projected selection bounds spherical", () => {
  const material = createMaterialDefinition("Sphere bounds", "pbr");
  const sphere = {
    ...mesh(material.materialId),
    meshKind: "sphere" as const,
    rotationX: 0,
    rotationY: 0,
    rotationZ: 0
  };
  const document = scene(material, sphere);
  const unrotated = projectMeshBounds(document, sphere);

  const rotated = { ...sphere, rotationX: 45 };
  document.objects = [rotated];
  const rotatedBounds = projectMeshBounds(document, rotated);

  assert.ok(
    Math.abs(rotatedBounds.width - unrotated.width) < 2,
    `X rotation must not stretch sphere width (${unrotated.width} -> ${rotatedBounds.width})`
  );
  assert.ok(
    Math.abs(rotatedBounds.height - unrotated.height) < 2,
    `X rotation must not stretch sphere height (${unrotated.height} -> ${rotatedBounds.height})`
  );
});
