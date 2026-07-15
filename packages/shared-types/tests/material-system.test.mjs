import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  appendSceneHistory,
  createMaterialDefinition,
  findAssetUsage,
  findAssetUsageDetails,
  findMaterialUsage,
  normalizeMaterialSceneDocument,
  parameterDefaults,
  redoSceneHistory,
  resolvePrimitiveMaterial,
  undoSceneHistory,
  validateMaterialAssetImportDescriptor,
  validateShaderDefinition
} from "../dist/index.js";

const timestamp = "2026-07-15T00:00:00.000Z";

function rect(id, binding) {
  return {
    id, type: "rect", name: id, x: 0, y: 0, zDepth: 0, zIndex: 0, layerId: "main",
    width: 100, height: 100, rotation: 0, opacity: 1, visible: true, locked: false,
    fill: "#000000", stroke: "transparent", strokeWidth: 0, radius: 0, bindings: {},
    materialSlots: binding ? { main: binding } : {}
  };
}

function scene(materials = [], objects = [], extras = {}) {
  return {
    id: "scene_material_test", name: "Material Test", version: 1,
    canvas: { width: 1920, height: 1080, background: "#000000" }, dataContext: {},
    assets: [], materials, materialInstances: [], shaders: [], materialFolders: [], objects,
    timeline: { fps: 60, durationFrames: 1, keyframes: [] }, createdAt: timestamp, updatedAt: timestamp,
    ...extras
  };
}

test("creates a reusable solid-colour material with renderer defaults", () => {
  const material = createMaterialDefinition("Score Plate", "solid-color");
  assert.match(material.materialId, /^mat_/);
  assert.equal(material.shaderId, "grapix.material.solid-colour");
  assert.equal(material.blendMode, "normal");
  assert.deepEqual(material.supportedPrimitives, ["rect", "ellipse", "text", "image"]);
});

test("stable assignment resolves one shared material for every primitive and reflects updates", () => {
  const material = createMaterialDefinition("Shared", "solid-color");
  material.parameters.baseColor = "#ff0000";
  const document = scene([material], [rect("a", material.materialId), rect("b", material.materialId)]);
  assert.equal(resolvePrimitiveMaterial(document, document.objects[0]).parameters.baseColor, "#ff0000");
  const updated = { ...document, materials: [{ ...material, parameters: { ...material.parameters, baseColor: "#00ff00" } }] };
  assert.equal(resolvePrimitiveMaterial(updated, updated.objects[0]).parameters.baseColor, "#00ff00");
  assert.equal(resolvePrimitiveMaterial(updated, updated.objects[1]).parameters.baseColor, "#00ff00");
});

test("one-level material instance overrides only selected parameters", () => {
  const material = createMaterialDefinition("Team", "solid-color");
  material.parameters = { baseColor: "#ffffff", opacity: 0.8 };
  const instance = {
    materialInstanceId: "matinst_team_a", name: "Team A", baseMaterialId: material.materialId,
    parameterOverrides: { baseColor: "#0044ff" }, textureOverrides: {}, createdAt: timestamp, updatedAt: timestamp
  };
  const object = rect("team_a", { materialId: material.materialId, instanceId: instance.materialInstanceId });
  const resolved = resolvePrimitiveMaterial(scene([material], [object], { materialInstances: [instance] }), object);
  assert.equal(resolved.parameters.baseColor, "#0044ff");
  assert.equal(resolved.parameters.opacity, 0.8);
});

test("validates shader manifests and returns shader parameter defaults", () => {
  const shader = {
    shaderId: "test.shader", name: "Test Shader", version: 1, sourcePath: "test.wgsl",
    vertexEntry: "vs_main", fragmentEntry: "fs_main", textureSlots: [], supportedPrimitives: ["rect"],
    parameters: [{ name: "opacity", type: "float", default: 1 }], validationStatus: "VALID",
    compilationErrors: [], builtIn: false, updatedAt: timestamp
  };
  assert.deepEqual(validateShaderDefinition(shader), []);
  assert.deepEqual(parameterDefaults(shader.parameters), { opacity: 1 });
  assert.ok(validateShaderDefinition({ ...shader, parameters: [...shader.parameters, ...shader.parameters] }).some((error) => error.includes("Duplicate")));
});

test("asset import validation accepts first-version formats and clearly rejects unsupported media", () => {
  assert.deepEqual(validateMaterialAssetImportDescriptor("logo.png", "image/png", 42), []);
  assert.deepEqual(validateMaterialAssetImportDescriptor("effect.wgsl", "text/plain", 42), []);
  assert.ok(validateMaterialAssetImportDescriptor("sponsor.mp4", "video/mp4", 42).some((error) => error.includes("Video")));
  assert.ok(validateMaterialAssetImportDescriptor("plate.exr", "image/x-exr", 42).some((error) => error.includes("EXR")));
});

test("missing assets remain referenced and are reported by resolution", () => {
  const material = createMaterialDefinition("Missing Image", "image", "asset_missing");
  const object = rect("image_plate", material.materialId);
  const document = scene([material], [object], {
    assets: [{ assetId: "asset_missing", name: "Missing", kind: "image", source: "/missing.png", importedAt: timestamp, status: "MISSING" }]
  });
  const resolved = resolvePrimitiveMaterial(document, object);
  assert.equal(resolved.textureSlots[0].assetId, "asset_missing");
  assert.ok(resolved.warnings.some((warning) => warning.includes("missing or unavailable")));
});

test("old scenes serialize, deserialize, and migrate material fields without binaries", () => {
  const legacy = scene([{ materialId: "legacy", name: "Legacy", type: "solid-color", color: "#123456", dynamic: false, opacity: 1, readiness: "READY" }], [rect("legacy_rect", "legacy")]);
  const reloaded = normalizeMaterialSceneDocument(JSON.parse(JSON.stringify(legacy)));
  assert.equal(reloaded.materials[0].parameters.baseColor, "#123456");
  assert.equal(reloaded.materials[0].shaderId, "grapix.material.solid-colour");
  assert.deepEqual(reloaded.materialInstances, []);
  assert.equal(JSON.stringify(reloaded).includes("data:image/png;base64"), false);
});

test("usage queries protect material and asset deletion", () => {
  const material = createMaterialDefinition("Logo", "image", "asset_logo");
  const document = scene([material], [rect("logo_quad", material.materialId)], {
    assets: [{ assetId: "asset_logo", name: "Logo", kind: "image", source: "/logo.png", importedAt: timestamp }]
  });
  assert.deepEqual(findMaterialUsage(document, material.materialId).objectIds, ["logo_quad"]);
  assert.deepEqual(findAssetUsage(document, "asset_logo"), [material.materialId]);
});

test("WGSL assets are protected while shader definitions reference their source path", () => {
  const shader = {
    shaderId: "custom.shader", name: "Custom", version: 1, sourcePath: "assets/shaders/custom.wgsl",
    vertexEntry: "vs_main", fragmentEntry: "fs_main", textureSlots: [], parameters: [],
    supportedPrimitives: ["rect"], validationStatus: "VALID", compilationErrors: [], builtIn: false,
    updatedAt: timestamp
  };
  const document = scene([], [], {
    assets: [{ assetId: "asset_shader", name: "custom.wgsl", kind: "wgsl", source: "/custom.wgsl", sourcePath: shader.sourcePath, importedAt: timestamp }],
    shaders: [shader]
  });
  assert.deepEqual(findAssetUsageDetails(document, "asset_shader"), { materialIds: [], shaderIds: [shader.shaderId] });
});

test("scene history performs reversible undo and redo snapshots", () => {
  const original = scene([], []);
  const changed = { ...original, name: "Changed" };
  const undoStack = appendSceneHistory([], original);
  const undone = undoSceneHistory(changed, undoStack, []);
  assert.equal(undone.scene.name, "Material Test");
  const redone = redoSceneHistory(undone.scene, undone.undoStack, undone.redoStack);
  assert.equal(redone.scene.name, "Changed");
});

test("TypeScript and Rust consume the declared 96-byte shared uniform contract", async () => {
  const layouts = JSON.parse(await readFile(new URL("../../render-shaders/layouts.json", import.meta.url), "utf8"));
  assert.equal(layouts.shaders.composite_quad.uniforms.QuadUniforms.sizeBytes, 96);
  assert.equal(layouts.blendModes.find((mode) => mode.name === "add").implemented, true);
});
