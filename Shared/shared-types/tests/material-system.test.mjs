import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  appendSceneHistory,
  buildFontCss,
  createMaterialDefinition,
  evaluateObjectPropertiesAtFrame,
  evaluateSceneAtFrame,
  faceSlotKey,
  interpolatePath,
  findAssetUsage,
  findAssetUsageDetails,
  findMaterialUsage,
  getBindableFaces,
  getMaterialReadiness,
  IMPLEMENTED_BLEND_MODES,
  UNIMPLEMENTED_BLEND_MODES,
  MATERIAL_BLEND_MODES,
  isImplementedBlendMode,
  IMPLEMENTED_TEXTURE_FIT_MODES,
  resolveTextureFit,
  textureWrapForFit,
  isMaterialCompatibleWithFace,
  normalizeMaterialSceneDocument,
  parameterDefaults,
  preflightScenePackage,
  PRIMARY_MATERIAL_SLOT,
  redoSceneHistory,
  resolveSceneObjectHierarchy,
  resolvePrimitiveMaterial,
  sampleChannel,
  undoSceneHistory,
  validateFontDefinition,
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

test("creates one reusable Standard Material with physical renderer defaults", () => {
  const material = createMaterialDefinition("Score Plate");
  assert.match(material.materialId, /^mat_/);
  assert.equal(material.type, "pbr");
  assert.equal(material.shaderId, "grapix.material.pbr");
  assert.equal(material.blendMode, "normal");
  assert.equal(material.depthMode, "read-write");
  assert.equal(material.cullMode, "back");
  assert.equal(material.doubleSided, false);
  assert.equal(material.parameters.baseColor, "#ffffff");
  assert.equal(material.parameters.metalness, 0.08);
  assert.equal(material.parameters.roughness, 0.62);
  assert.equal(material.parameters.emissiveColor, "#000000");
  assert.equal(material.parameters.emissiveIntensity, 0);
  assert.equal(material.readiness, "READY");
  assert.deepEqual(material.textureSlots, []);
  assert.deepEqual(material.supportedPrimitives, ["rect", "ellipse", "text", "image", "mesh"]);
});

test("the Standard Material factory supports an optional base texture", () => {
  const textured = createMaterialDefinition("Logo", { baseTextureAssetId: "asset_logo" });
  const readyAsset = {
    assetId: "asset_logo", name: "Logo", kind: "image", source: "/logo.png",
    importedAt: timestamp, status: "READY"
  };

  assert.equal(textured.type, "pbr");
  assert.equal(textured.assetId, "asset_logo");
  assert.equal(textured.textureSlots.length, 1);
  assert.equal(textured.textureSlots[0].name, "baseTexture");
  assert.equal(textured.textureSlots[0].assetId, "asset_logo");
  assert.equal(textured.alphaMode, "straight");
  assert.equal(getMaterialReadiness(textured, [readyAsset], {}), "READY");
  assert.equal(getMaterialReadiness(textured, [{ ...readyAsset, status: "MISSING" }], {}), "MISSING");
  assert.equal(getMaterialReadiness(createMaterialDefinition("Colour only"), [], {}), "READY");
});

test("legacy factory overloads remain source-compatible but only emit canonical pbr", () => {
  for (const alias of ["solid-color", "image", "unlit-texture", "basic-lit", "pbr"]) {
    const material = createMaterialDefinition(alias, alias, alias === "image" ? "asset_logo" : undefined);
    assert.equal(material.type, "pbr");
    assert.equal(material.shaderId, "grapix.material.pbr");
    assert.equal(material.parameters.metalness, 0.08);
    assert.equal(material.parameters.roughness, 0.62);
  }
});

test("stable assignment resolves one shared material for every primitive and reflects updates", () => {
  const material = createMaterialDefinition("Shared");
  material.parameters.baseColor = "#ff0000";
  const document = scene([material], [rect("a", material.materialId), rect("b", material.materialId)]);
  assert.equal(resolvePrimitiveMaterial(document, document.objects[0]).parameters.baseColor, "#ff0000");
  const updated = { ...document, materials: [{ ...material, parameters: { ...material.parameters, baseColor: "#00ff00" } }] };
  assert.equal(resolvePrimitiveMaterial(updated, updated.objects[0]).parameters.baseColor, "#00ff00");
  assert.equal(resolvePrimitiveMaterial(updated, updated.objects[1]).parameters.baseColor, "#00ff00");
});

test("repeat wrap and nearest filtering resolve without a warning; tile fit still warns", () => {
  const material = createMaterialDefinition("Frame", { baseTextureAssetId: "asset_frame" });
  material.textureSlots = [{
    name: "baseTexture", assetId: "asset_frame", fit: "fill", wrap: "repeat", filtering: "nearest",
    uvScale: [3, 3], uvOffset: [0, 0], uvRotation: 30, uvPivot: [0.5, 0.5]
  }];
  const object = rect("frame_rect", material.materialId);
  const doc = scene([material], [object], {
    assets: [{ assetId: "asset_frame", name: "frame.png", kind: "image", source: "frame.png", status: "READY", importedAt: timestamp }]
  });
  const resolved = resolvePrimitiveMaterial(doc, object);

  // wrap=repeat and filtering=nearest are supported by the editor sampler +
  // TilingSprite path, so they must NOT produce a warning.
  assert.ok(!resolved.warnings.some((w) => /wrap mode/i.test(w)), `unexpected wrap warning: ${resolved.warnings}`);
  assert.ok(!resolved.warnings.some((w) => /filtering mode/i.test(w)), `unexpected filtering warning: ${resolved.warnings}`);

  // Tile is implemented: a UV repeat past 1.0 with repeat wrapping, which needs no extra geometry.
  material.textureSlots[0].fit = "tile";
  const tiled = resolvePrimitiveMaterial(scene([material], [object], {
    assets: [{ assetId: "asset_frame", name: "frame.png", kind: "image", source: "frame.png", status: "READY", importedAt: timestamp }]
  }), object);
  assert.ok(!tiled.warnings.some((w) => /fit mode tile/i.test(w)), `unexpected tile warning: ${tiled.warnings}`);

  // Nine-slice still is not, and the warning must survive: its nine regions scale differently from
  // one another, which is real geometry rather than a sampler transform.
  material.textureSlots[0].fit = "nine-slice";
  const sliced = resolvePrimitiveMaterial(scene([material], [object], {
    assets: [{ assetId: "asset_frame", name: "frame.png", kind: "image", source: "frame.png", status: "READY", importedAt: timestamp }]
  }), object);
  assert.ok(
    sliced.warnings.some((w) => /fit mode nine-slice/i.test(w)),
    `expected nine-slice warning: ${sliced.warnings}`
  );
});

test("one-level material instance overrides only selected parameters", () => {
  const material = createMaterialDefinition("Team");
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

test("shader manifest exposes Standard Material as its only user-facing material", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../../render-shaders/manifests/shader-manifest.json", import.meta.url),
    "utf8"
  ));
  const userFacing = manifest.shaders.filter((shader) => shader.userFacing === true);
  assert.deepEqual(userFacing.map((shader) => shader.shaderId), ["grapix.material.pbr"]);
  assert.equal(userFacing[0].name, "Standard Material");
  assert.deepEqual(userFacing[0].supportedPrimitives, ["rect", "ellipse", "text", "image", "mesh"]);
  assert.deepEqual(userFacing[0].textureSlots, [
    { name: "baseTexture", label: "Base texture", required: false }
  ]);
  assert.ok(
    manifest.shaders
      .filter((shader) => shader.shaderId !== "grapix.material.pbr")
      .every((shader) => shader.userFacing === false && shader.compatibilityAliasFor === "grapix.material.pbr")
  );
});

test("asset import validation accepts first-version formats and clearly rejects unsupported media", () => {
  assert.deepEqual(validateMaterialAssetImportDescriptor("logo.png", "image/png", 42), []);
  assert.deepEqual(validateMaterialAssetImportDescriptor("effect.wgsl", "text/plain", 42), []);
  assert.deepEqual(validateMaterialAssetImportDescriptor("studio.glb", "model/gltf-binary", 42), []);
  assert.ok(validateMaterialAssetImportDescriptor("sponsor.mp4", "video/mp4", 42).some((error) => error.includes("Video")));
  assert.ok(validateMaterialAssetImportDescriptor("plate.exr", "image/x-exr", 42).some((error) => error.includes("EXR")));
});

test("missing assets remain referenced and are reported by resolution", () => {
  const material = createMaterialDefinition("Missing Image", { baseTextureAssetId: "asset_missing" });
  const object = rect("image_plate", material.materialId);
  const document = scene([material], [object], {
    assets: [{ assetId: "asset_missing", name: "Missing", kind: "image", source: "/missing.png", importedAt: timestamp, status: "MISSING" }]
  });
  const resolved = resolvePrimitiveMaterial(document, object);
  assert.equal(resolved.textureSlots[0].assetId, "asset_missing");
  assert.ok(resolved.warnings.some((warning) => warning.includes("missing or unavailable")));
});

test("all material aliases migrate idempotently to pbr without losing authored values", () => {
  const aliases = ["solid-color", "image", "unlit-texture", "basic-lit", "pbr"];
  const textureSlot = {
    name: "baseTexture", assetId: "asset_legacy", fit: "fit", wrap: "repeat",
    filtering: "nearest", uvScale: [2, 3], uvOffset: [0.1, 0.2],
    uvRotation: 15, uvPivot: [0.25, 0.75], flipX: true, flipY: false
  };
  const legacy = scene(aliases.map((type, index) => ({
    materialId: `legacy_${index}`,
    name: `Legacy ${type}`,
    type,
    assetId: "asset_legacy",
    color: "#123456",
    dynamic: false,
    opacity: 0.37,
    readiness: "READY",
    shaderId: type === "pbr" ? "grapix.material.pbr" : `grapix.material.${type}`,
    textureSlots: [{ ...textureSlot }],
    parameters: {
      tint: "#abcdef",
      opacity: 0.41,
      metalness: 0.23,
      customGain: 0.75
    }
  })), [rect("legacy_rect", "legacy_0")]);
  const reloaded = normalizeMaterialSceneDocument(JSON.parse(JSON.stringify(legacy)));

  for (const [index, material] of reloaded.materials.entries()) {
    assert.equal(material.materialId, `legacy_${index}`);
    assert.equal(material.type, "pbr");
    assert.equal(material.shaderId, "grapix.material.pbr");
    assert.equal(material.assetId, "asset_legacy");
    assert.equal(material.color, "#123456");
    assert.equal(material.opacity, 0.37);
    assert.deepEqual(material.textureSlots, [textureSlot]);
    assert.equal(material.parameters.baseColor, "#abcdef");
    assert.equal(material.parameters.tint, "#abcdef");
    assert.equal(material.parameters.opacity, 0.41);
    assert.equal(material.parameters.metalness, 0.23);
    assert.equal(material.parameters.roughness, 0.62);
    assert.equal(material.parameters.customGain, 0.75);
  }

  assert.deepEqual(normalizeMaterialSceneDocument(reloaded), reloaded);
  assert.deepEqual(reloaded.materialInstances, []);
  assert.equal(JSON.stringify(reloaded).includes("data:image/png;base64"), false);
});

test("a legacy texture alias with no referenced image stays explicitly missing", () => {
  const legacy = scene([{
    materialId: "legacy_missing", name: "Legacy missing", type: "image",
    dynamic: false, opacity: 1, readiness: "READY", textureSlots: []
  }]);
  const material = normalizeMaterialSceneDocument(legacy).materials[0];

  assert.equal(material.type, "pbr");
  assert.equal(material.readiness, "MISSING");
  assert.equal(material.textureSlots.length, 1);
  assert.equal(material.textureSlots[0].name, "baseTexture");
  assert.equal(material.textureSlots[0].assetId, undefined);
  assert.equal(getMaterialReadiness(material, [], {}), "MISSING");
});

test("usage queries protect material and asset deletion", () => {
  const material = createMaterialDefinition("Logo", { baseTextureAssetId: "asset_logo" });
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
  assert.deepEqual(findAssetUsageDetails(document, "asset_shader"), { materialIds: [], shaderIds: [shader.shaderId], objectIds: [] });
});

test("scene history performs reversible undo and redo snapshots, carrying each step's description", () => {
  const original = scene([], []);
  const changed = { ...original, name: "Changed" };
  // An entry is the document *before* a change, labelled with the change it reverts, so a caller can
  // say "Undo Rename scene" rather than undoing anonymously.
  const undoStack = appendSceneHistory([], {
    scene: original,
    label: "Rename scene",
    scope: "scene-manager"
  });

  const undone = undoSceneHistory(changed, undoStack, []);
  assert.equal(undone.scene.name, "Material Test");
  assert.equal(undone.applied.label, "Rename scene");
  assert.equal(undone.applied.scope, "scene-manager");
  // Redo re-applies the same change, so it is described the same way.
  assert.equal(undone.redoStack.at(-1).label, "Rename scene");

  const redone = redoSceneHistory(undone.scene, undone.undoStack, undone.redoStack);
  assert.equal(redone.scene.name, "Changed");
  assert.equal(redone.applied.label, "Rename scene");
  assert.equal(redone.undoStack.at(-1).label, "Rename scene");
});

test("scene history refuses to move past either end", () => {
  const original = scene([], []);
  assert.equal(undoSceneHistory(original, [], []), null);
  assert.equal(redoSceneHistory(original, [], []), null);
});

test("scene history is bounded, dropping the oldest step first", () => {
  const original = scene([], []);
  let stack = [];
  for (let index = 0; index < 5; index += 1) {
    stack = appendSceneHistory(stack, { scene: original, label: `step ${index}` }, 3);
  }
  assert.equal(stack.length, 3);
  assert.deepEqual(stack.map((entry) => entry.label), ["step 2", "step 3", "step 4"]);
});

test("TypeScript and Rust consume the declared 304-byte gradient-capable uniform contract", async () => {
  const layouts = JSON.parse(await readFile(new URL("../../render-shaders/layouts.json", import.meta.url), "utf8"));
  assert.equal(layouts.shaders.composite_quad.uniforms.QuadUniforms.sizeBytes, 304);
  assert.equal(layouts.blendModes.find((mode) => mode.name === "add").implemented, true);
});

test("implemented blend modes match the shared layout contract exactly", async () => {
  const layouts = JSON.parse(await readFile(new URL("../../render-shaders/layouts.json", import.meta.url), "utf8"));
  const implementedInContract = layouts.blendModes
    .filter((mode) => mode.implemented)
    .map((mode) => mode.name)
    .sort();

  // The TypeScript IMPLEMENTED_BLEND_MODES list and the layouts.json contract
  // must describe the same set — this is the drift guard between the editor
  // guard/inspector and the shared renderer contract.
  assert.deepEqual([...IMPLEMENTED_BLEND_MODES].sort(), implementedInContract);
  assert.deepEqual([...IMPLEMENTED_BLEND_MODES].sort(), ["add", "darken", "lighten", "multiply", "normal", "screen"]);

  // Every implemented mode declares both a color and an alpha equation, and
  // the ids are stable and contiguous (the render core indexes pipelines by id).
  for (const mode of layouts.blendModes) {
    assert.ok(typeof mode.color === "string" && mode.color.length > 0, `${mode.name} missing color equation`);
    assert.ok(typeof mode.alpha === "string" && mode.alpha.length > 0, `${mode.name} missing alpha equation`);
  }
  assert.deepEqual(layouts.blendModes.map((mode) => mode.id), [0, 1, 2, 3, 4, 5]);
});

function mesh(id, meshKind) {
  return {
    id, type: "mesh", meshKind, name: id, x: 0, y: 0, zDepth: 0, zIndex: 0, layerId: "main",
    width: 100, height: 100, depth: 100, rotation: 0, opacity: 1, visible: true, locked: false,
    bindings: {}, materialSlots: {}
  };
}

function text(id) {
  return {
    id, type: "text", name: id, x: 0, y: 0, zDepth: 0, zIndex: 0, layerId: "main",
    width: 100, height: 40, rotation: 0, opacity: 1, visible: true, locked: false,
    text: "Hello", fontSize: 24, fontFamily: "Inter", fontWeight: 400, align: "left",
    fill: "#ffffff", bindings: {}, materialSlots: {}
  };
}

function hierarchyContainer(id, type, childIds, patch = {}) {
  return {
    ...rect(id),
    type,
    name: id,
    childIds,
    ...(type === "layer" ? { layerKind: "object" } : {}),
    ...patch
  };
}

function closeTo(actual, expected, epsilon = 1e-9) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${actual} to be within ${epsilon} of ${expected}`
  );
}

test("scene hierarchy composes a layer transform and inherited render state without mutating its source", () => {
  const layer = hierarchyContainer("layer", "layer", ["cube"], {
    x: 100,
    y: 200,
    zDepth: 5,
    rotation: 90,
    rotationX: 5,
    rotationY: 7,
    scaleX: 2,
    scaleY: 3,
    scaleZ: 2,
    anchor: { x: 10, y: 20 },
    opacity: 0.5,
    locked: true
  });
  const cube = {
    ...mesh("cube", "cube"),
    x: 30,
    y: 20,
    zDepth: 3,
    rotation: 4,
    rotationX: 10,
    rotationY: 20,
    rotationZ: 15,
    scaleX: 0.5,
    scaleY: 2,
    scaleZ: 0.5,
    opacity: 0.4
  };
  const source = [layer, cube];
  const before = structuredClone(source);
  const resolved = resolveSceneObjectHierarchy(source);
  const effectiveCube = resolved.renderableObjects.find((object) => object.id === "cube");

  assert.deepEqual(source, before);
  assert.notEqual(resolved.objects[0], source[0]);
  assert.equal(resolved.containerObjects.length, 1);
  assert.deepEqual(resolved.containerObjects[0].childIds, ["cube"]);
  assert.equal(resolved.renderableObjects.length, 1);
  closeTo(effectiveCube.x, 100);
  closeTo(effectiveCube.y, 240);
  assert.equal(effectiveCube.zDepth, 8);
  assert.equal(effectiveCube.rotation, 105);
  assert.equal(effectiveCube.rotationX, 15);
  assert.equal(effectiveCube.rotationY, 27);
  assert.equal(effectiveCube.rotationZ, 105);
  assert.equal(effectiveCube.scaleX, 1);
  assert.equal(effectiveCube.scaleY, 6);
  assert.equal(effectiveCube.scaleZ, 1);
  assert.equal(effectiveCube.opacity, 0.2);
  assert.equal(effectiveCube.visible, true);
  assert.equal(effectiveCube.locked, true);
});

test("scene hierarchy recursively composes nested container positions", () => {
  const root = hierarchyContainer("root", "group", ["nested"], {
    x: 100,
    y: 100,
    rotation: 90,
    anchor: { x: 0, y: 0 }
  });
  const nested = hierarchyContainer("nested", "layer", ["leaf"], {
    x: 20,
    y: 0,
    rotation: 10,
    anchor: { x: 0, y: 0 }
  });
  const leaf = {
    ...rect("leaf"),
    x: 10,
    y: 0,
    rotation: 5
  };
  const resolved = resolveSceneObjectHierarchy([root, nested, leaf]);
  const effectiveLeaf = resolved.renderableObjects[0];
  const nestedRadians = 10 * Math.PI / 180;

  closeTo(effectiveLeaf.x, 100 - Math.sin(nestedRadians) * 10);
  closeTo(effectiveLeaf.y, 120 + Math.cos(nestedRadians) * 10);
  assert.equal(effectiveLeaf.rotation, 105);
  assert.deepEqual(resolved.parentByChildId, { nested: "root", leaf: "nested" });
  assert.deepEqual(resolved.childrenByParentId, { root: ["nested"], nested: ["leaf"] });
});

test("scene hierarchy inherits hidden, opacity, and lock state through nested containers", () => {
  const root = hierarchyContainer("root", "group", ["nested"], {
    visible: false,
    opacity: 0.5,
    locked: false
  });
  const nested = hierarchyContainer("nested", "group", ["leaf"], {
    visible: true,
    opacity: 0.4,
    locked: true
  });
  const leaf = { ...rect("leaf"), opacity: 0.25, visible: true, locked: false };
  const effectiveLeaf = resolveSceneObjectHierarchy([root, nested, leaf]).renderableObjects[0];

  assert.equal(effectiveLeaf.visible, false);
  assert.equal(effectiveLeaf.opacity, 0.05);
  assert.equal(effectiveLeaf.locked, true);
});

test("scene hierarchy keeps the first ordered parent and reports ignored invalid references", () => {
  const first = hierarchyContainer("first", "group", [
    "first",
    "missing",
    "leaf",
    "second",
    "leaf"
  ]);
  const second = hierarchyContainer("second", "group", ["leaf", "first"]);
  const third = hierarchyContainer("third", "layer", ["leaf"]);
  const leaf = rect("leaf");
  const resolved = resolveSceneObjectHierarchy([first, second, third, leaf]);

  assert.deepEqual(resolved.parentByChildId, { leaf: "first", second: "first" });
  assert.deepEqual(resolved.childrenByParentId, { first: ["leaf", "second"] });
  assert.deepEqual(
    resolved.diagnostics.map((diagnostic) => diagnostic.code),
    [
      "self-reference",
      "missing-child",
      "multiple-parents",
      "multiple-parents",
      "cycle",
      "multiple-parents"
    ]
  );
  assert.equal(resolved.diagnostics[2].existingParentId, "first");
  assert.deepEqual(
    resolved.containerObjects.find((object) => object.id === "second").childIds,
    []
  );
});

test("bindable faces come from the object: continuous-surface primitives expose one primary 'main' surface", () => {
  for (const object of [rect("quad"), text("caption"), mesh("sphere", "sphere"), mesh("torus", "torus"), mesh("model", "model")]) {
    const faces = getBindableFaces(object);
    assert.equal(faces.length, 1, `${object.id} should expose a single face`);
    assert.equal(faces[0].index, 0);
    assert.equal(faces[0].slotKey, PRIMARY_MATERIAL_SLOT);
    assert.equal(faces[0].primary, true);
  }
});

test("box and slab meshes expose their authored material regions, all starting at 'main'", () => {
  const cube = getBindableFaces(mesh("cube", "cube"));
  assert.equal(cube.length, 6);
  assert.equal(cube[0].slotKey, PRIMARY_MATERIAL_SLOT);
  assert.deepEqual(cube.map((f) => f.label), ["Front", "Back", "Left", "Right", "Top", "Bottom"]);
  assert.deepEqual(cube.map((f) => f.slotKey), ["main", "face:back", "face:left", "face:right", "face:top", "face:bottom"]);
  const slab = getBindableFaces(mesh("slab", "slab"));
  assert.deepEqual(slab.map((face) => face.label), ["Face", "Bevel", "Extrusion", "Back Bevel", "Back Face"]);
  assert.deepEqual(slab.map((face) => face.slotKey), ["main", "face:bevel", "face:extrusion", "face:back-bevel", "face:back"]);

  const cylinder = getBindableFaces(mesh("cyl", "cylinder"));
  assert.equal(cylinder.length, 3);
  assert.equal(cylinder[0].slotKey, PRIMARY_MATERIAL_SLOT);
  assert.deepEqual(cylinder.map((f) => f.kind), ["surface", "cap", "cap"]);

  assert.equal(faceSlotKey(mesh("cube", "cube"), 4), "face:top");
  assert.equal(faceSlotKey(mesh("cube", "cube"), 99), undefined);
});

test("imported glTF material elements become independently assignable model surfaces", () => {
  const model = {
    ...mesh("studio", "model"),
    modelAssetId: "asset_studio",
    materialElements: ["Body PBR", "Sponsor Screen"]
  };
  assert.deepEqual(
    getBindableFaces(model).map((face) => [face.slotKey, face.label]),
    [["main", "Whole Model"], ["element:0", "Body PBR"], ["element:1", "Sponsor Screen"]]
  );
  assert.deepEqual(
    findAssetUsageDetails(scene([], [model], {
      assets: [{ assetId: "asset_studio", name: "studio.glb", kind: "model", source: "/studio.glb", importedAt: timestamp }]
    }), "asset_studio").objectIds,
    ["studio"]
  );
});

function keyframe(objectId, frame, properties, easing = "linear") {
  return { id: `kf_${objectId}_${frame}`, objectId, frame, properties, easing };
}

test("keyframe evaluation interpolates numbers and colours and holds outside the range", () => {
  const kfs = [keyframe("a", 0, { x: 0, opacity: 1, fill: "#000000" }), keyframe("a", 30, { x: 90, opacity: 0, fill: "#ffffff" })];
  const mid = evaluateObjectPropertiesAtFrame(kfs, 15);
  assert.equal(mid.x, 45);
  assert.equal(mid.opacity, 0.5);
  assert.equal(mid.fill, "#808080");
  // Holds before the first and after the last defining keyframe.
  assert.equal(evaluateObjectPropertiesAtFrame(kfs, -10).x, 0);
  assert.equal(evaluateObjectPropertiesAtFrame(kfs, 999).x, 90);
});

test("keyframe easing shapes the interpolation curve (ease-in is quadratic)", () => {
  const kfs = [keyframe("a", 0, { x: 0 }, "ease-in"), keyframe("a", 10, { x: 100 })];
  // ease-in at t=0.5 -> 0.25 -> x = 25
  assert.equal(evaluateObjectPropertiesAtFrame(kfs, 5).x, 25);
});

test("transform keyframes interpolate object scale and anchor", () => {
  const kfs = [
    keyframe("a", 0, { scaleX: 1, scaleY: 1, anchor: { x: 0, y: 0 } }),
    keyframe("a", 20, { scaleX: 2, scaleY: 0.5, anchor: { x: 100, y: 60 } })
  ];
  const mid = evaluateObjectPropertiesAtFrame(kfs, 10);
  assert.equal(mid.scaleX, 1.5);
  assert.equal(mid.scaleY, 0.75);
  assert.deepEqual(mid.anchor, { x: 50, y: 30 });
});

test("3D transform keyframes interpolate mesh XYZ rotation, Z position, and Z scale", () => {
  const kfs = [
    keyframe("mesh", 0, { zDepth: 0, rotationX: 0, rotationY: 10, rotationZ: 20, scaleZ: 1 }),
    keyframe("mesh", 20, { zDepth: 400, rotationX: 90, rotationY: 50, rotationZ: 100, scaleZ: 2 })
  ];
  const mid = evaluateObjectPropertiesAtFrame(kfs, 10);
  assert.equal(mid.zDepth, 200);
  assert.equal(mid.rotationX, 45);
  assert.equal(mid.rotationY, 30);
  assert.equal(mid.rotationZ, 60);
  assert.equal(mid.scaleZ, 1.5);
});

test("evaluateSceneAtFrame patches only keyframed objects and leaves the rest (and keyframe-less scenes) untouched", () => {
  const animated = rect("mover");
  const still = rect("static");
  const doc = scene([], [animated, still], {
    timeline: { fps: 60, durationFrames: 60, keyframes: [keyframe("mover", 0, { x: 0 }), keyframe("mover", 20, { x: 200 })] }
  });
  const sampled = evaluateSceneAtFrame(doc, 10);
  assert.equal(sampled.objects.find((o) => o.id === "mover").x, 100);
  assert.equal(sampled.objects.find((o) => o.id === "static").x, still.x);
  // No keyframes -> same object reference back (no needless churn).
  const none = scene([], [rect("z")]);
  assert.equal(evaluateSceneAtFrame(none, 5), none);
});

test("per-property stopwatch channels animate independently and temporal handles shape speed", () => {
  const animated = rect("stopwatched");
  animated.x = 240;
  animated.animation = {
    x: {
      keys: [
        { id: "x0", frame: 0, value: 240, easing: "linear" },
        { id: "x30", frame: 30, value: 500, easing: "linear" }
      ]
    },
    opacity: {
      keys: [
        { id: "a0", frame: 0, value: 1, easing: "linear" },
        { id: "a30", frame: 30, value: 0.5, easing: "linear" }
      ]
    }
  };
  const doc = scene([], [animated], {
    timeline: { fps: 60, durationFrames: 60, keyframes: [] }
  });
  const sampled = evaluateSceneAtFrame(doc, 15).objects[0];
  assert.equal(sampled.x, 370);
  assert.equal(sampled.opacity, 0.75);

  const speedShaped = {
    keys: [
      { id: "lo", frame: 0, value: 0, easing: "linear", outTangent: { x: 10, y: 0 } },
      { id: "hi", frame: 30, value: 100, easing: "linear", inTangent: { x: -10, y: 0 } }
    ]
  };
  assert.ok(sampleChannel(speedShaped, 7.5) < 25);
  assert.equal(sampleChannel(speedShaped, 15), 50);
});

test("interpolatePath morphs matched-count bezier paths and holds on a vertex-count mismatch", () => {
  const zero = () => [{ x: 0, y: 0 }, { x: 0, y: 0 }];
  const a = { closed: true, vertices: [{ x: 0, y: 0 }, { x: 100, y: 0 }], inTangents: zero(), outTangents: zero() };
  const b = { closed: true, vertices: [{ x: 0, y: 0 }, { x: 300, y: 200 }], inTangents: zero(), outTangents: zero() };
  const mid = interpolatePath(a, b, 0.5);
  assert.deepEqual(mid.vertices[1], { x: 200, y: 100 });
  // Mismatched counts hold the nearer keyframe rather than morph wrongly.
  const c = { closed: true, vertices: [{ x: 0, y: 0 }], inTangents: [{ x: 0, y: 0 }], outTangents: [{ x: 0, y: 0 }] };
  assert.equal(interpolatePath(a, c, 0.2).vertices.length, 2); // < 0.5 -> holds `a`
  assert.equal(interpolatePath(a, c, 0.8).vertices.length, 1); // >= 0.5 -> holds `c`
});

test("face compatibility lets textures bind to mesh faces but keeps object-type rules for non-mesh", () => {
  const image = createMaterialDefinition("Logo", { baseTextureAssetId: "asset_logo" });
  const solid = createMaterialDefinition("Fill");

  // Standard materials work on both a whole object and independently bindable
  // mesh faces, with or without their optional base texture.
  assert.equal(isMaterialCompatibleWithFace(image, mesh("cube", "cube"), 2), true);
  assert.equal(isMaterialCompatibleWithFace(solid, mesh("cube", "cube"), 0), true);
  // Out-of-range face is never compatible.
  assert.equal(isMaterialCompatibleWithFace(image, mesh("cube", "cube"), 9), false);
  // Non-mesh objects keep the existing object-type rule (solid ok on quad).
  assert.equal(isMaterialCompatibleWithFace(solid, rect("quad"), 0), true);
});

test("strict package preflight catches duplicate ids and unavailable production runtimes", () => {
  const video = {
    assetId: "asset_video",
    name: "Alpha Video",
    kind: "video",
    source: "data:video/mp4;base64,AA==",
    mimeType: "video/mp4",
    sizeBytes: 1,
    importedAt: timestamp,
    status: "READY",
    codec: "h264",
    colorSpace: "rec709"
  };
  const document = scene([], [rect("duplicate"), rect("duplicate"), mesh("model", "model")], {
    assets: [video]
  });
  const preflight = preflightScenePackage(document);
  const codes = preflight.issues.map((issue) => issue.code);
  assert.equal(preflight.ok, false);
  assert.ok(codes.includes("DUPLICATE_ID"));
  assert.ok(codes.includes("VIDEO_DECODER_NOT_CERTIFIED"));
  assert.ok(codes.includes("COLOR_SPACE_MISMATCH"));
  assert.ok(codes.includes("NATIVE_3D_RUNTIME_NOT_READY"));
});

test("font definitions encode packaged files and explicit remote stylesheet links", () => {
  const asset = {
    assetId: "font_inter",
    name: "Inter.woff2",
    kind: "font",
    source: "/api/assets/font_inter/content",
    mimeType: "font/woff2",
    importedAt: timestamp,
    checksum: "a".repeat(64)
  };
  const fileFont = {
    fontId: "font_family_inter",
    family: "Inter",
    displayName: "Inter",
    faces: [{
      faceId: "face_inter_700",
      family: "Inter",
      weight: 700,
      style: "normal",
      source: { kind: "file", assetId: asset.assetId, format: "woff2" }
    }],
    fallbackFamilies: ["Arial", "sans-serif"],
    embeddingPolicy: "package",
    status: "READY"
  };
  const linkedFont = {
    fontId: "font_adobe",
    family: "Acumin Pro",
    displayName: "Acumin Pro",
    faces: [{
      faceId: "face_adobe",
      family: "Acumin Pro",
      weight: 400,
      style: "normal",
      source: {
        kind: "adobe-fonts",
        projectId: "abc123",
        url: "https://use.typekit.net/abc123.css"
      }
    }],
    fallbackFamilies: ["Arial"],
    embeddingPolicy: "reference",
    status: "UNVERIFIED"
  };
  assert.deepEqual(validateFontDefinition(fileFont, [asset]), []);
  assert.deepEqual(validateFontDefinition(linkedFont), []);
  const css = buildFontCss([linkedFont, fileFont], (assetId) => `/content/${assetId}`);
  assert.match(css, /@import url\("https:\/\/use\.typekit\.net\/abc123\.css"\)/);
  assert.match(css, /font-family: "Inter"/);
  assert.match(css, /format\("woff2"\)/);
});

test("preflight validates scene automation and checksummed script references", () => {
  const scriptAsset = {
    assetId: "script_score",
    name: "score.mjs",
    kind: "script",
    source: "/api/assets/script_score/content",
    mimeType: "application/javascript",
    importedAt: timestamp,
    checksum: "b".repeat(64),
    status: "READY"
  };
  const checked = preflightScenePackage(scene([], [rect("plate")], {
    assets: [scriptAsset],
    automation: {
      version: 1,
      transitions: [{ transitionId: "cut", name: "Cut", kind: "cut", durationFrames: 0, easing: "linear" }],
      triggers: [{
        triggerId: "trigger_score",
        name: "Score reaches ten",
        enabled: true,
        event: { type: "data-change", name: "score.changed" },
        condition: {
          kind: "compare",
          left: { source: "scene-data", path: "score.home" },
          operator: "gte",
          right: { source: "literal", value: 10 }
        },
        actions: [{ type: "take-scene", sceneId: "scene_material_test" }],
        priority: 10
      }],
      script: {
        scriptId: "script_score",
        assetId: "script_score",
        apiVersion: 1,
        entrypoint: "default",
        enabled: true,
        checksum: scriptAsset.checksum,
        permissions: ["read-data", "emit-event"],
        execution: "control-sandbox"
      }
    }
  }));
  assert.equal(checked.issues.some((issue) => issue.code === "SCENE_SCRIPT_HASH_MISMATCH"), false);
  assert.equal(checked.ok, true);
});

test("a cover fit crops the overflowing axis and leaves the other whole", () => {
  // A 256x128 texture is wider than a 360x210 surface, so height fills and width is cropped.
  const wide = resolveTextureFit("fill", {
    surfaceWidth: 360,
    surfaceHeight: 210,
    textureWidth: 256,
    textureHeight: 128
  });
  assert.equal(wide.repeat[1], 1, "the short axis samples the whole texture");
  assert.ok(wide.repeat[0] < 1, "the long axis samples less than the whole texture");
  // (360/210) / (256/128) = 0.857142...
  assert.ok(Math.abs(wide.repeat[0] - (360 / 210) / (256 / 128)) < 1e-12);
  assert.ok(Math.abs(wide.offset[0] - (1 - wide.repeat[0]) / 2) < 1e-12, "the crop is centred");
  assert.equal(wide.offset[1], 0);

  // A texture taller than the surface crops the other axis.
  const tall = resolveTextureFit("fill", {
    surfaceWidth: 400,
    surfaceHeight: 100,
    textureWidth: 100,
    textureHeight: 400
  });
  assert.equal(tall.repeat[0], 1);
  assert.ok(tall.repeat[1] < 1);
  assert.ok(Math.abs(tall.offset[1] - (1 - tall.repeat[1]) / 2) < 1e-12);
});

test("a cover fit never samples outside the texture, so clamp and repeat wrap agree", () => {
  // This is what makes cover implementable in every renderer: the sampled rectangle stays inside
  // [0,1] on both axes, so no behaviour outside the texture is observable. The modes excluded from
  // IMPLEMENTED_TEXTURE_FIT_MODES are excluded precisely because they break this.
  for (const [sw, sh, tw, th] of [[360, 210, 256, 128], [100, 900, 1920, 1080], [640, 640, 1, 4096]]) {
    const fit = resolveTextureFit("fill", {
      surfaceWidth: sw, surfaceHeight: sh, textureWidth: tw, textureHeight: th
    });
    for (const axis of [0, 1]) {
      assert.ok(fit.repeat[axis] > 0 && fit.repeat[axis] <= 1, `repeat[${axis}] within (0,1]`);
      assert.ok(fit.offset[axis] >= 0, `offset[${axis}] not before the texture`);
      assert.ok(
        fit.offset[axis] + fit.repeat[axis] <= 1 + 1e-12,
        `offset[${axis}] + repeat[${axis}] not past the texture`
      );
    }
  }
});

/**
 * The cover-style fits answer "which rectangle of the texture does this surface sample", so when
 * the aspects already match there is nothing to crop and they are the identity.
 *
 * Tile is deliberately not one of them: it answers "how many copies of the texture fit", which
 * depends on the texture's pixel size rather than its aspect. A 256px texture on a 512px surface is
 * untouched by a cover fit and is 2x2 copies under tile — both correct, for different questions.
 */
test("a square texture on a square surface is untouched by every cover fit", () => {
  const coverFits = IMPLEMENTED_TEXTURE_FIT_MODES.filter((mode) => mode !== "tile");
  assert.ok(coverFits.length >= 3, "the cover fits are what this test is about");

  for (const mode of coverFits) {
    const fit = resolveTextureFit(mode, {
      surfaceWidth: 512, surfaceHeight: 512, textureWidth: 256, textureHeight: 256
    });
    assert.deepEqual(fit.repeat, [1, 1], `${mode} keeps matching aspects whole`);
    assert.deepEqual(fit.offset, [0, 0], `${mode} does not offset matching aspects`);
  }

  assert.deepEqual(
    resolveTextureFit("tile", {
      surfaceWidth: 512, surfaceHeight: 512, textureWidth: 256, textureHeight: 256
    }).repeat,
    [2, 2],
    "tile counts copies, so a matching aspect is no reason to leave it alone"
  );
});

test("stretch and unimplemented fit modes resolve to the identity transform", () => {
  // Unimplemented modes must degrade to exactly today's behaviour rather than invent numbers; the
  // scene validator is what tells the operator the mode is not honoured.
  const surface = { surfaceWidth: 360, surfaceHeight: 210, textureWidth: 256, textureHeight: 128 };
  for (const mode of ["stretch", "fit", "original", "pixel-perfect", "nine-slice"]) {
    const fit = resolveTextureFit(mode, surface);
    assert.deepEqual(fit.repeat, [1, 1], `${mode} repeat is identity`);
    assert.deepEqual(fit.offset, [0, 0], `${mode} offset is identity`);
  }
  assert.equal(IMPLEMENTED_TEXTURE_FIT_MODES.includes("stretch"), true);
  assert.equal(IMPLEMENTED_TEXTURE_FIT_MODES.includes("fit"), false);
});

test("a degenerate surface or texture extent cannot divide by zero", () => {
  for (const surface of [
    { surfaceWidth: 0, surfaceHeight: 210, textureWidth: 256, textureHeight: 128 },
    { surfaceWidth: 360, surfaceHeight: 210, textureWidth: 0, textureHeight: 128 },
    { surfaceWidth: 360, surfaceHeight: 0, textureWidth: 256, textureHeight: 0 },
    { surfaceWidth: Number.NaN, surfaceHeight: 210, textureWidth: 256, textureHeight: 128 },
    { surfaceWidth: 360, surfaceHeight: 210, textureWidth: Number.POSITIVE_INFINITY, textureHeight: 128 },
    { surfaceWidth: -360, surfaceHeight: 210, textureWidth: 256, textureHeight: 128 }
  ]) {
    const fit = resolveTextureFit("fill", surface);
    assert.deepEqual(fit.repeat, [1, 1]);
    assert.deepEqual(fit.offset, [0, 0]);
    assert.ok(fit.repeat.every(Number.isFinite) && fit.offset.every(Number.isFinite));
  }
});

test("the scene validator reports every fit mode it cannot honour", () => {
  // The UI offers eight fit modes. Only the implemented ones may pass silently: a mode that is
  // authored, saved and then drawn as `stretch` with no warning is the exact defect this guards.
  const build = (mode) => {
    const material = createMaterialDefinition("Fit warning", { baseTextureAssetId: "asset_fit" });
    material.textureSlots = [{
      name: "baseTexture", assetId: "asset_fit", fit: mode, wrap: "clamp", filtering: "linear",
      uvScale: [1, 1], uvOffset: [0, 0], uvRotation: 0, uvPivot: [0.5, 0.5]
    }];
    const object = rect("fit_rect", material.materialId);
    return resolvePrimitiveMaterial(scene([material], [object], {
      assets: [{
        assetId: "asset_fit", name: "fit.png", kind: "image", source: "fit.png",
        status: "READY", importedAt: timestamp
      }]
    }), object);
  };

  for (const mode of ["fit", "original", "pixel-perfect", "nine-slice"]) {
    const resolved = build(mode);
    assert.ok(
      resolved.warnings.some((warning) => warning.includes(`fit mode ${mode}`)),
      `expected ${mode} to be reported: ${resolved.warnings}`
    );
  }

  for (const mode of IMPLEMENTED_TEXTURE_FIT_MODES) {
    const resolved = build(mode);
    assert.equal(
      resolved.warnings.some((warning) => /fit mode/i.test(warning)),
      false,
      `${mode} must not be reported as unimplemented: ${resolved.warnings}`
    );
  }
});

/* ── Tile fit ─────────────────────────────────────────────────────────────────────────────── */

/**
 * Tiling keeps the texture at its own pixel size and repeats it, so `repeat` is the surface
 * measured in texture widths. It was excluded from the implemented set for years on the grounds
 * that it "needs extra geometry" — it does not; that is nine-slice. It needs repeat wrapping,
 * which every sampler in the product already has.
 */
test("tile repeats the texture at its own size", () => {
  assert.deepEqual(
    resolveTextureFit("tile", {
      surfaceWidth: 512, surfaceHeight: 256, textureWidth: 128, textureHeight: 128
    }),
    { repeat: [4, 2], offset: [0, 0] }
  );
});

/** A partial tile is correct: 300 across a 128 texture is two copies and a bit. */
test("a surface that is not a whole number of tiles keeps the remainder", () => {
  const fit = resolveTextureFit("tile", {
    surfaceWidth: 300, surfaceHeight: 128, textureWidth: 128, textureHeight: 128
  });
  assert.ok(Math.abs(fit.repeat[0] - 300 / 128) < 1e-9);
  assert.equal(fit.repeat[1], 1);
});

/**
 * Anchored at the origin, not centred. Centring would put a seam through the middle of the first
 * tile and move every tile whenever the surface resized.
 */
test("a tiled surface is anchored at its origin", () => {
  assert.deepEqual(
    resolveTextureFit("tile", {
      surfaceWidth: 333, surfaceHeight: 777, textureWidth: 64, textureHeight: 64
    }).offset,
    [0, 0]
  );
});

test("tile is an implemented fit mode, and nine-slice still is not", () => {
  assert.ok(IMPLEMENTED_TEXTURE_FIT_MODES.includes("tile"));
  assert.ok(!IMPLEMENTED_TEXTURE_FIT_MODES.includes("nine-slice"), "nine-slice needs real geometry");
  assert.ok(!IMPLEMENTED_TEXTURE_FIT_MODES.includes("fit"), "fit needs a transparent border");
});

/**
 * A tile authored against a clamped slot must still tile. Under clamp, sampling past 1.0 smears
 * the edge row across the whole surface — a result so unlike tiling that drawing it would be the
 * silent-wrong-render this codebase refuses everywhere else.
 */
test("tile forces repeat wrapping, whatever the author selected", () => {
  assert.equal(textureWrapForFit("tile", "clamp"), "repeat");
  assert.equal(textureWrapForFit("tile", "mirror-repeat"), "repeat");
});

test("every other fit mode leaves the authored wrap alone", () => {
  for (const mode of ["stretch", "fill", "crop", "fit", "nine-slice"]) {
    assert.equal(textureWrapForFit(mode, "clamp"), "clamp", `${mode} must not override wrap`);
    assert.equal(textureWrapForFit(mode, "mirror-repeat"), "mirror-repeat");
  }
});

/** A degenerate extent has no tile count to compute; stretching is the only answer that is safe. */
test("tile falls back to the identity when an extent is unusable", () => {
  for (const surface of [
    { surfaceWidth: 0, surfaceHeight: 100, textureWidth: 10, textureHeight: 10 },
    { surfaceWidth: 100, surfaceHeight: 100, textureWidth: 0, textureHeight: 10 },
    { surfaceWidth: Number.NaN, surfaceHeight: 100, textureWidth: 10, textureHeight: 10 }
  ]) {
    assert.deepEqual(resolveTextureFit("tile", surface), { repeat: [1, 1], offset: [0, 0] });
  }
});

/* ── Blend-mode refusal ───────────────────────────────────────────────────────────────────── */

/**
 * The validator's half of the no-silent-fallback rule, mirroring the fit-mode test above.
 *
 * The renderer refuses an unsupported mode by throwing; this is what an *author* sees instead — a
 * named warning on the resolved material. Both halves must name the mode, or "my overlay looks
 * wrong" has no answer anywhere in the product.
 */
test("the scene validator reports every blend mode it cannot honour", () => {
  const build = (mode) => {
    const material = createMaterialDefinition("Blend warning");
    material.blendMode = mode;
    const object = rect("blend_rect", material.materialId);
    return resolvePrimitiveMaterial(scene([material], [object]), object);
  };

  assert.ok(UNIMPLEMENTED_BLEND_MODES.length > 0, "there are unsupported modes to report");

  for (const mode of UNIMPLEMENTED_BLEND_MODES) {
    const resolved = build(mode);
    assert.ok(
      resolved.warnings.some((warning) => warning.includes(`Blend mode ${mode}`)),
      `expected ${mode} to be reported by name: ${resolved.warnings}`
    );
  }

  for (const mode of IMPLEMENTED_BLEND_MODES) {
    const resolved = build(mode);
    assert.equal(
      resolved.warnings.some((warning) => /Blend mode/i.test(warning)),
      false,
      `${mode} must not be reported as unimplemented: ${resolved.warnings}`
    );
  }
});

/** The two sets are derived from one vocabulary, so they cannot drift apart or overlap. */
test("implemented and unimplemented blend modes partition the vocabulary", () => {
  assert.deepEqual(
    [...IMPLEMENTED_BLEND_MODES, ...UNIMPLEMENTED_BLEND_MODES].sort(),
    [...MATERIAL_BLEND_MODES].sort()
  );
  for (const mode of UNIMPLEMENTED_BLEND_MODES) {
    assert.equal(isImplementedBlendMode(mode), false, `${mode} must not be both`);
  }
  for (const mode of IMPLEMENTED_BLEND_MODES) {
    assert.equal(isImplementedBlendMode(mode), true);
  }
});

/** `overlay` specifically: excluded because PixiJS core aliases it to screen. */
test("overlay is in the vocabulary and not implemented", () => {
  assert.ok(MATERIAL_BLEND_MODES.includes("overlay"));
  assert.equal(isImplementedBlendMode("overlay"), false);
});
