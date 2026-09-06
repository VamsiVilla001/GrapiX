import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { writePsd } from "ag-psd";
import {
  DEFAULT_DESIGN_IMPORT_OPTIONS,
  IMPLEMENTED_BLEND_MODES,
  validateSceneEffects
} from "@grapix/shared-types";
import { normalizeDesignDocument } from "../dist/importers/design/designDocumentNormalizer.js";
import { importFigmaDocument } from "../dist/importers/design/figmaImporter.js";
import {
  documentFromFigmaMcpCaptures,
  parseFigmaMcpNodeIds,
  validateFigmaMcpImportSource
} from "../dist/importers/design/figmaMcpImporter.js";
import { convertDesignDocumentToScenes } from "../dist/importers/design/grapixObjectConverter.js";
import {
  createDesignImportReport,
  populateDesignImportCounts,
  pruneDesignImportIssues
} from "../dist/importers/design/importReport.js";
import { importIllustratorDocument, importSvgDocument } from "../dist/importers/design/illustratorImporter.js";
import { convertPsdEffects, importPsdDocument } from "../dist/importers/design/psdImporter.js";
import { parseDesignImportOptions } from "../dist/importers/design/designImportManager.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures/", import.meta.url));

test("SVG/Illustrator-compatible import preserves hierarchy, editable paths, gradients, clipping, and text", async () => {
  const xml = await readFile(`${fixtureRoot}/design-import.svg`, "utf8");
  const report = createDesignImportReport("svg", "design-import.svg");
  const normalized = normalizeDesignDocument(
    importSvgDocument(xml, "design-import.svg", report),
    DEFAULT_DESIGN_IMPORT_OPTIONS, report
  );
  const [scene] = convertDesignDocumentToScenes(normalized, DEFAULT_DESIGN_IMPORT_OPTIONS, report);
  assert.equal(scene.canvas.width, 640);
  assert.equal(scene.canvas.height, 360);
  const group = scene.objects.find((object) => object.type === "group" && object.name === "Hero Group");
  assert.ok(group);
  assert.ok(group.childIds.length >= 3);
  const card = scene.objects.find((object) => object.name === "Gradient Card");
  assert.equal(card?.type, "rect");
  assert.equal(card.fillStyle?.type, "linear-gradient");
  assert.equal(card.masks?.length, 1);
  const curve = scene.objects.find((object) => object.name === "Open Curve");
  assert.equal(curve?.type, "shape");
  assert.equal(curve.path.closed, false);
  assert.ok(curve.path.outTangents.some((point) => point.x !== 0 || point.y !== 0));
  const headline = scene.objects.find((object) => object.name === "Headline");
  assert.equal(headline?.type, "text");
  assert.match(headline.text, /Editable headline/);
});

test("AI fixture dispatches through the Illustrator adapter and remains native/editable", async () => {
  const bytes = await readFile(`${fixtureRoot}/design-import.ai`);
  const report = createDesignImportReport("ai", "design-import.ai");
  const document = await importIllustratorDocument(bytes, "design-import.ai", report);
  const [scene] = convertDesignDocumentToScenes(
    normalizeDesignDocument(document, DEFAULT_DESIGN_IMPORT_OPTIONS, report),
    DEFAULT_DESIGN_IMPORT_OPTIONS,
    report
  );
  assert.equal(document.sourceFormat, "ai");
  assert.equal(scene.canvas.width, 640);
  assert.ok(scene.objects.some((object) => object.type === "shape" && object.name === "Open Curve"));
  assert.ok(scene.objects.some((object) => object.type === "text" && object.name === "Headline"));
  assert.ok(scene.objects.some((object) => object.masks?.length > 0));
});

test("Figma import converts auto layout, components, masks, effects, gradients, and missing fonts", async () => {
  const json = JSON.parse(await readFile(`${fixtureRoot}/figma-design.json`, "utf8"));
  const report = createDesignImportReport("figma-json", "figma-design.json");
  const document = normalizeDesignDocument(
    importFigmaDocument(json, "figma-design.json", report, "figma-json"),
    DEFAULT_DESIGN_IMPORT_OPTIONS, report
  );
  const [scene] = convertDesignDocumentToScenes(document, DEFAULT_DESIGN_IMPORT_OPTIONS, report);
  const component = scene.objects.find((object) => object.name === "Score Card");
  assert.equal(component?.type, "group");
  assert.equal(component.importedDesign?.responsiveLayout?.mode, "horizontal");
  assert.ok(component.importedDesign?.effects?.some((effect) => effect.type === "drop-shadow"));
  const text = scene.objects.find((object) => object.name === "Team Name");
  assert.equal(text?.type, "text");
  assert.equal(text.fontFamily, "Fixture Sans");
  assert.equal(text.masks?.length, 1);
  assert.ok(report.missingFonts.includes("Fixture Sans"));
  assert.equal(document.components["component-key"].name, "Score Card");
  assert.ok(report.visualDifferences.some((message) => message.includes("drop-shadow")));
  const reloaded = JSON.parse(JSON.stringify(scene));
  const reloadedComponent = reloaded.objects.find((object) => object.name === "Score Card");
  assert.equal(reloadedComponent.importedDesign.responsiveLayout.mode, "horizontal");
  assert.equal(reloadedComponent.importedDesign.effects[0].type, "drop-shadow");
  assert.equal(reloaded.objects.find((object) => object.name === "Team Name").masks.length, 1);
});

test("Figma MCP link import creates a raster scene without an API token", () => {
  const source = { url: "https://www.figma.com/design/file-key/Fixture?node-id=123-456" };
  assert.deepEqual(parseFigmaMcpNodeIds(source), ["123:456"]);
  assert.deepEqual(
    parseFigmaMcpNodeIds({ ...source, nodeIds: ["7:8", "7-8", "bad", "123:456"] }),
    ["7:8", "123:456"]
  );
  assert.throws(
    () => validateFigmaMcpImportSource({ url: "https://example.com/not-figma", nodeIds: ["7:8"] }),
    /not a Figma link/
  );
  assert.throws(
    () => validateFigmaMcpImportSource({ url: "https://www.figma.com/design/abc123DEF456ghi789JK/Fixture" }),
    /will not import its active selection/
  );

  const report = createDesignImportReport("figma-mcp", source.url);
  const document = documentFromFigmaMcpCaptures(source, [{
    nodeId: "123:456",
    name: "Broadcast Frame",
    metadata: "<frame id=\"123:456\" name=\"Broadcast Frame\" width=\"1920\" height=\"1080\" />",
    imageBase64: "aGVsbG8=",
    mimeType: "image/png",
    width: 1920,
    height: 1080
  }], report);
  const [scene] = convertDesignDocumentToScenes(
    normalizeDesignDocument(document, DEFAULT_DESIGN_IMPORT_OPTIONS, report),
    DEFAULT_DESIGN_IMPORT_OPTIONS,
    report
  );

  assert.equal(document.sourceFormat, "figma-mcp");
  assert.equal(document.sourceId, "file-key");
  assert.equal(scene.canvas.width, 1920);
  assert.equal(scene.canvas.height, 1080);
  assert.equal(scene.objects[0].type, "image");
  assert.match(scene.objects[0].src, /^data:image\/png;base64,/);
  assert.deepEqual(report.rasterizedObjects, ["Broadcast Frame"]);
});

test("PSD fixture imports nested groups, editable text, vector shape, raster asset, mask and effects", () => {
  const pixels = new Uint8ClampedArray(16 * 16 * 4);
  for (let index = 0; index < pixels.length; index += 4) {
    pixels[index] = 30;
    pixels[index + 1] = 140;
    pixels[index + 2] = 220;
    pixels[index + 3] = 255;
  }
  const psdBytes = Buffer.from(writePsd({
    width: 320,
    height: 180,
    children: [{
      name: "Nested Group",
      children: [{
        name: "Editable Text",
        top: 20,
        left: 30,
        bottom: 70,
        right: 250,
        text: {
          text: "PSD Headline",
          shapeType: "box",
          orientation: "horizontal",
          style: {
            font: { name: "PSD Fixture Sans" },
            fontSize: 32,
            fauxBold: true,
            fillColor: { r: 255, g: 255, b: 255 }
          }
        }
      }, {
        name: "Pixel Layer",
        top: 90,
        left: 40,
        bottom: 106,
        right: 56,
        imageData: { width: 16, height: 16, data: pixels },
        effects: {
          dropShadow: [{
            enabled: true,
            size: { units: "Pixels", value: 8 },
            distance: { units: "Pixels", value: 4 },
            angle: 90,
            opacity: 0.5,
            color: { r: 0, g: 0, b: 0 }
          }]
        }
      }, {
        name: "Vector Shape",
        top: 20,
        left: 260,
        bottom: 80,
        right: 310,
        vectorFill: { type: "color", color: { r: 255, g: 60, b: 80 } },
        vectorMask: {
          paths: [{
            open: false,
            fillRule: "non-zero",
            operation: "combine",
            knots: [
              { linked: false, points: [260, 20, 260, 20, 260, 20] },
              { linked: false, points: [310, 20, 310, 20, 310, 20] },
              { linked: false, points: [310, 80, 310, 80, 310, 80] },
              { linked: false, points: [260, 80, 260, 80, 260, 80] }
            ]
          }]
        }
      }]
    }]
  }, { generateThumbnail: false }));
  const report = createDesignImportReport("psd", "fixture.psd");
  const document = normalizeDesignDocument(importPsdDocument(psdBytes, "fixture.psd", report), {
    ...DEFAULT_DESIGN_IMPORT_OPTIONS,
    importHiddenLayers: true
  }, report);
  const [scene] = convertDesignDocumentToScenes(document, DEFAULT_DESIGN_IMPORT_OPTIONS, report);
  assert.equal(scene.canvas.width, 320);
  assert.ok(scene.objects.some((object) => object.type === "group" && object.name === "Nested Group"));
  assert.ok(scene.objects.some((object) => object.type === "text" && object.text === "PSD Headline"));
  assert.ok(scene.objects.some((object) => object.type === "image" && object.name === "Pixel Layer"));
  assert.ok(scene.objects.some((object) => object.type === "shape" && object.name === "Vector Shape"));
  const pixel = scene.objects.find((object) => object.name === "Pixel Layer");
  assert.ok(pixel.importedDesign.effects.some((effect) => effect.type === "drop-shadow"));
  assert.ok(report.visualDifferences.some((message) => message.includes("Photoshop layer effects")));
  assert.ok(report.warnings.some((message) => message.includes("PSD feature checking was enabled")));
});

test("PSD effects retain every style, warn only for enabled effects, and never invent missing patterns", () => {
  const report = createDesignImportReport("psd", "synthetic-effects.psd");
  const effects = convertPsdEffects({
    dropShadow: [{ enabled: true, color: { r: 1, g: 2, b: 3 }, angle: 45, distance: { units: "Pixels", value: 9 }, choke: { units: "Pixels", value: 2 }, size: { units: "Pixels", value: 7 }, opacity: 0.4, useGlobalLight: true, layerConceals: true }],
    innerShadow: [{ enabled: true, color: { r: 4, g: 5, b: 6 }, angle: 90, distance: { units: "Pixels", value: 8 }, choke: { units: "Pixels", value: 3 }, size: { units: "Pixels", value: 6 }, opacity: 0.5 }],
    outerGlow: { enabled: true, color: { r: 7, g: 8, b: 9 }, choke: { units: "Pixels", value: 4 }, size: { units: "Pixels", value: 5 }, noise: 0.1, range: 0.8, jitter: 0.2 },
    innerGlow: { enabled: true, color: { r: 10, g: 11, b: 12 }, technique: "precise", source: "center", choke: { units: "Pixels", value: 5 }, size: { units: "Pixels", value: 4 } },
    bevel: { enabled: true, style: "pillow emboss", technique: "chisel hard", strength: 1.5, direction: "down", size: { units: "Pixels", value: 6 }, soften: { units: "Pixels", value: 2 }, angle: 120, altitude: 35, highlightColor: { r: 255, g: 255, b: 255 }, highlightOpacity: 0.8, shadowColor: { r: 0, g: 0, b: 0 }, shadowOpacity: 0.6, useTexture: true },
    satin: { enabled: true, color: { r: 20, g: 21, b: 22 }, angle: 30, distance: { units: "Pixels", value: 3 }, size: { units: "Pixels", value: 9 }, invert: true },
    solidFill: [{ enabled: true, color: { r: 23, g: 24, b: 25 }, opacity: 0.7 }],
    gradientOverlay: [{ enabled: true, type: "radial", angle: 25, scale: 0.6, offset: { x: 0.2, y: 0.3 }, reverse: true, dither: true, align: false, gradient: { name: "Fixture", type: "solid", colorStops: [{ location: 0, midpoint: 0.5, color: { r: 0, g: 0, b: 0 } }, { location: 1, midpoint: 0.5, color: { r: 255, g: 255, b: 255 } }], opacityStops: [{ location: 0, midpoint: 0.5, opacity: 1 }, { location: 1, midpoint: 0.5, opacity: 1 }] } }],
    patternOverlay: { enabled: true, pattern: { id: "unavailable", name: "Unresolved Pattern" }, scale: 0.5, phase: { x: 3, y: 4 }, align: true },
    stroke: [{ enabled: true, size: { units: "Pixels", value: 2 }, position: "inside", fillType: "color", color: { r: 26, g: 27, b: 28 }, overprint: true }]
  }, undefined, new Map(), report, "Synthetic PSD layer", "synthetic-layer");

  assert.deepEqual(
    new Set(effects.map((effect) => effect.type)),
    new Set(["drop-shadow", "inner-shadow", "outer-glow", "inner-glow", "bevel-emboss", "satin", "color-overlay", "gradient-overlay", "pattern-overlay", "stroke"])
  );
  assert.deepEqual(effects.find((effect) => effect.type === "drop-shadow")?.offset, { x: Math.cos(Math.PI / 4) * 9, y: Math.sin(Math.PI / 4) * 9 });
  assert.equal(effects.find((effect) => effect.type === "bevel-emboss")?.bevelTechnique, "chisel-hard");
  const pattern = effects.find((effect) => effect.type === "pattern-overlay");
  assert.equal(pattern?.patternName, "Unresolved Pattern");
  assert.equal(pattern?.patternAssetId, undefined);
  assert.ok(report.issues.some((issue) => issue.message.includes("could not be resolved to pixels")));
  assert.deepEqual(report.unsupportedEffects, ["Synthetic PSD layer"]);

  const disabledReport = createDesignImportReport("psd", "disabled-effects.psd");
  convertPsdEffects({
    dropShadow: [{ enabled: false, color: { r: 0, g: 0, b: 0 }, size: { units: "Pixels", value: 4 }, distance: { units: "Pixels", value: 2 } }]
  }, undefined, new Map(), disabledReport, "Disabled PSD layer", "disabled-layer");
  assert.deepEqual(disabledReport.unsupportedEffects, []);
  assert.deepEqual(disabledReport.visualDifferences, []);
});

test("real Photoshop PSD imports typed scene effects that capability audit reports as unrendered", async () => {
  const source = await readFile(fileURLToPath(new URL("../../../../vendor/adobe/photoshop-api-sdk/testfiles/input/input01.psd", import.meta.url)));
  const report = createDesignImportReport("psd", "input01.psd");
  const document = normalizeDesignDocument(importPsdDocument(source, "input01.psd", report), DEFAULT_DESIGN_IMPORT_OPTIONS, report);
  const nodes = [];
  const walk = (items) => items.forEach((node) => {
    nodes.push(node);
    walk(node.children);
  });
  document.pages.forEach((page) => walk(page.nodes));
  assert.ok(nodes.some((node) => node.effects.some((effect) => effect.type === "drop-shadow")));

  const [scene] = convertDesignDocumentToScenes(document, DEFAULT_DESIGN_IMPORT_OPTIONS, report);
  const object = scene.objects.find((candidate) => candidate.effects?.some((effect) => effect.type === "drop-shadow"));
  assert.ok(object?.effects?.length);
  assert.equal(typeof object?.blendingOptions?.fillOpacity, "number");
  const audit = validateSceneEffects(scene);
  assert.ok(audit.affectedObjectIds.includes(object.id));
  assert.ok(audit.unrenderedByType["drop-shadow"] >= 1);
});

test("visual compatibility fingerprint retains source geometry and alpha stops", async () => {
  const xml = await readFile(`${fixtureRoot}/design-import.svg`, "utf8");
  const report = createDesignImportReport("svg", "visual.svg");
  const [scene] = convertDesignDocumentToScenes(
    normalizeDesignDocument(importSvgDocument(xml, "visual.svg", report), DEFAULT_DESIGN_IMPORT_OPTIONS, report),
    DEFAULT_DESIGN_IMPORT_OPTIONS,
    report
  );
  const fingerprint = scene.objects
    .filter((object) => object.type !== "group")
    .map((object) => [object.name, Math.round(object.x), Math.round(object.y), Math.round(object.width), Math.round(object.height), object.fillStyle?.type]);
  assert.deepEqual(fingerprint, [
    ["Gradient Card", 32, 28, 300, 140, "linear-gradient"],
    ["Open Curve", 50, 120, 460, 220, "none"],
    ["Headline", 48, 92, 1, 1, "solid"],
    ["circle", 0, 0, 1, 1, "solid"]
  ]);
  const gradient = scene.objects.find((object) => object.name === "Gradient Card")?.fillStyle;
  assert.equal(gradient.type, "linear-gradient");
  assert.equal(gradient.stops[1].opacity, 0.8);
});

test("import options prune nested selections, flatten hierarchy, and disable component semantics", async () => {
  const json = JSON.parse(await readFile(`${fixtureRoot}/figma-design.json`, "utf8"));
  const sourceReport = createDesignImportReport("figma-json", "figma-options.json");
  const source = importFigmaDocument(json, "figma-options.json", sourceReport, "figma-json");
  const componentNode = source.pages[0].nodes[0];
  const targetText = componentNode.children.find((node) => node.name === "Team Name");
  assert.ok(targetText);

  const selected = normalizeDesignDocument(source, {
    ...DEFAULT_DESIGN_IMPORT_OPTIONS,
    selectedNodeIds: [targetText.id]
  }, sourceReport);
  assert.equal(selected.pages[0].nodes.length, 1);
  assert.deepEqual(selected.pages[0].nodes[0].children.map((node) => node.name), ["Team Name"]);

  const flattened = normalizeDesignDocument(source, {
    ...DEFAULT_DESIGN_IMPORT_OPTIONS,
    preserveHierarchy: false,
    convertComponents: false
  }, sourceReport);
  assert.ok(flattened.pages[0].nodes.every((node) => node.children.length === 0));
  assert.ok(flattened.pages[0].nodes.every((node) => !["group", "frame", "component", "component-set", "instance"].includes(node.type)));
  assert.ok(flattened.pages[0].nodes.every((node) => node.componentId === undefined));
});

/**
 * A PSD whose hidden group carries a bitmap mask and layer effects, plus a visible
 * layer whose effects are all switched off, plus a visible layer with a live effect.
 * Only the last one is an honest report entry.
 */
function warningFixturePsd() {
  const pixels = new Uint8ClampedArray(8 * 8 * 4).fill(200);
  const maskPixels = new Uint8ClampedArray(8 * 8 * 4).fill(255);
  const disabledEffects = {
    bevel: { enabled: false, size: { units: "Pixels", value: 4 }, angle: 90 },
    dropShadow: [{ enabled: false, size: { units: "Pixels", value: 8 }, distance: { units: "Pixels", value: 4 }, angle: 90, color: { r: 0, g: 0, b: 0 } }]
  };
  return Buffer.from(writePsd({
    width: 200,
    height: 120,
    children: [{
      name: "Hidden Group",
      hidden: true,
      children: [{
        name: "Masked In Hidden Group",
        top: 0,
        left: 0,
        bottom: 8,
        right: 8,
        imageData: { width: 8, height: 8, data: pixels },
        mask: { top: 0, left: 0, bottom: 8, right: 8, defaultColor: 0, imageData: { width: 8, height: 8, data: maskPixels } },
        effects: { bevel: { enabled: true, size: { units: "Pixels", value: 4 }, angle: 90 } },
        text: {
          text: "Hidden",
          shapeType: "box",
          orientation: "horizontal",
          style: { font: { name: "Hidden Only Sans" }, fontSize: 12, fillColor: { r: 0, g: 0, b: 0 } }
        }
      }]
    }, {
      name: "Disabled Effects Layer",
      top: 20,
      left: 20,
      bottom: 28,
      right: 28,
      imageData: { width: 8, height: 8, data: pixels },
      effects: disabledEffects
    }, {
      name: "Live Effect Layer",
      top: 40,
      left: 20,
      bottom: 48,
      right: 28,
      imageData: { width: 8, height: 8, data: pixels },
      effects: { bevel: { enabled: true, size: { units: "Pixels", value: 4 }, angle: 90 } }
    }]
  }, { generateThumbnail: false }));
}

test("PSD import reports effects only where a live effect reaches an imported layer", () => {
  const report = createDesignImportReport("psd", "warnings.psd");
  const document = normalizeDesignDocument(
    importPsdDocument(warningFixturePsd(), "warnings.psd", report),
    DEFAULT_DESIGN_IMPORT_OPTIONS, report
  );
  pruneDesignImportIssues(report, collectNodeIds(document));
  convertDesignDocumentToScenes(document, DEFAULT_DESIGN_IMPORT_OPTIONS, report);

  assert.deepEqual(report.unsupportedEffects, ["Live Effect Layer"]);
  assert.deepEqual(
    report.visualDifferences,
    ["Photoshop layer effects on Live Effect Layer remain editable after import, but current canvas and output renderers do not reproduce them yet."]
  );
  assert.ok(report.issues.every((issue) => !issue.message.includes("Masked In Hidden Group")));
  assert.ok(report.issues.every((issue) => !issue.message.includes("Disabled Effects Layer")));
  assert.deepEqual(report.missingFonts, []);
  // The disabled effects are still round-trippable on the object that owns them.
  const [scene] = convertDesignDocumentToScenes(document, DEFAULT_DESIGN_IMPORT_OPTIONS, createDesignImportReport("psd", "warnings.psd"));
  const disabled = scene.objects.find((object) => object.name === "Disabled Effects Layer");
  assert.ok(disabled.importedDesign.effects.some((effect) => effect.type === "bevel-emboss" && effect.enabled === false));
});

test("PSD bitmap mask is carried with its alpha asset and clips nothing until a renderer samples it", () => {
  const report = createDesignImportReport("psd", "warnings.psd");
  const document = normalizeDesignDocument(
    importPsdDocument(warningFixturePsd(), "warnings.psd", report),
    { ...DEFAULT_DESIGN_IMPORT_OPTIONS, importHiddenLayers: true }, report
  );
  pruneDesignImportIssues(report, collectNodeIds(document));
  const [scene] = convertDesignDocumentToScenes(document, DEFAULT_DESIGN_IMPORT_OPTIONS, report);

  const masked = scene.objects.find((object) => object.name === "Masked In Hidden Group");
  assert.equal(masked.masks.length, 1);
  const [mask] = masked.masks;
  // mode "none" is the renderer's skip condition, so the layer draws unmasked
  // rather than being clipped by its own bounding box.
  assert.equal(mask.mode, "none");
  assert.ok(mask.alphaAssetId);
  assert.ok(document.assets.some((asset) => asset.id === mask.alphaAssetId));
  assert.ok(report.visualDifferences.some((message) => message.includes("renders unmasked")));
});

function collectNodeIds(document) {
  const ids = new Set();
  const walk = (nodes) => nodes.forEach((node) => {
    ids.add(node.id);
    walk(node.children);
  });
  document.pages.forEach((page) => walk(page.nodes));
  return ids;
}

/**
 * `layerId` is a compositing layer and the first key both renderers sort on
 * (`sortObjectsForRender`, and the same rule in `services/render-daemon/src/scene/
 * document.rs`). The converter used to write the parent object's id into it, so a
 * PSD's opaque bottom layer on "main" sorted after - and painted over - every
 * nested object.
 */
test("imported nesting lives in childIds, never in the compositing layer key", () => {
  const report = createDesignImportReport("psd", "warnings.psd");
  const document = normalizeDesignDocument(
    importPsdDocument(warningFixturePsd(), "warnings.psd", report),
    { ...DEFAULT_DESIGN_IMPORT_OPTIONS, importHiddenLayers: true }, report
  );
  const [scene] = convertDesignDocumentToScenes(document, DEFAULT_DESIGN_IMPORT_OPTIONS, report);

  assert.deepEqual([...new Set(scene.objects.map((object) => object.layerId))], ["main"]);
  const group = scene.objects.find((object) => object.name === "Hidden Group");
  assert.ok(group.childIds.length > 0);
  const child = scene.objects.find((object) => object.id === group.childIds[0]);
  assert.ok(child.zIndex > group.zIndex, "a child must draw above the group that contains it");
  const order = scene.objects.map((object) => object.zIndex);
  assert.deepEqual(order, [...order].sort((left, right) => left - right).slice(), "zIndex must follow document order");
  assert.equal(new Set(order).size, order.length, "one zIndex per object, so ordering is total");
  // A layered PSD contributes no canvas colour of its own.
  assert.equal(scene.canvas.background, "#00000000");
  assert.equal(scene.canvas.backgroundStyle.type, "none");
});

test("PSD layers keep a local pivot and a rendered blend mode", () => {
  const pixels = new Uint8ClampedArray(8 * 8 * 4).fill(180);
  const psdBytes = Buffer.from(writePsd({
    width: 1920,
    height: 1080,
    children: [{
      name: "Full Frame Plate",
      top: 0,
      left: 0,
      bottom: 1080,
      right: 1920,
      // Photoshop's free-transform reference, in document space. Importing it as the
      // object-local pivot drew this layer one canvas height above the frame.
      referencePoint: { x: -1, y: 1080 },
      blendMode: "vivid light",
      imageData: { width: 8, height: 8, data: pixels }
    }]
  }, { generateThumbnail: false }));

  const report = createDesignImportReport("psd", "pivot.psd");
  const document = normalizeDesignDocument(
    importPsdDocument(psdBytes, "pivot.psd", report),
    DEFAULT_DESIGN_IMPORT_OPTIONS, report
  );
  const [scene] = convertDesignDocumentToScenes(document, DEFAULT_DESIGN_IMPORT_OPTIONS, report);
  const plate = scene.objects.find((object) => object.name === "Full Frame Plate");

  assert.deepEqual(plate.anchor, { x: 0, y: 0 });
  assert.deepEqual(plate.importedDesign.raw.referencePoint, { x: -1, y: 1080 });

  // The renderers implement six blend modes; an unrendered one must never be authored.
  const material = scene.materials.find((entry) => entry.materialId === plate.materialSlots.main);
  assert.equal(material.blendMode, "screen");
  assert.ok(IMPLEMENTED_BLEND_MODES.includes(material.blendMode));
  assert.ok(report.visualDifferences.some((message) => message.includes('blend mode "vivid light"')));
});

test("flattening composes group translation, rotation, scale, and anchor", async () => {
  const json = JSON.parse(await readFile(`${fixtureRoot}/figma-design.json`, "utf8"));
  const report = createDesignImportReport("figma-json", "transform.json");
  const source = importFigmaDocument(json, "transform.json", report, "figma-json");
  const child = {
    ...source.pages[0].nodes[0].children.find((node) => !node.isMask),
    id: "transformed-child",
    name: "Transformed child",
    type: "rectangle",
    x: 5,
    y: 10,
    width: 20,
    height: 10,
    rotation: 0,
    scaleX: 3,
    scaleY: 4,
    anchor: { x: 0, y: 0 },
    children: []
  };
  source.pages[0].nodes = [{
    ...source.pages[0].nodes[0],
    id: "transformed-group",
    type: "group",
    x: 10,
    y: 20,
    width: 100,
    height: 80,
    rotation: 90,
    scaleX: 2,
    scaleY: 2,
    anchor: { x: 0, y: 0 },
    children: [child]
  }];

  const normalized = normalizeDesignDocument(source, {
    ...DEFAULT_DESIGN_IMPORT_OPTIONS,
    preserveHierarchy: false
  }, report);
  const [flattened] = normalized.pages[0].nodes;
  assert.equal(flattened.id, "transformed-child");
  assert.ok(Math.abs(flattened.x + 10) < 1e-9);
  assert.ok(Math.abs(flattened.y - 30) < 1e-9);
  assert.equal(flattened.rotation, 90);
  assert.equal(flattened.scaleX, 6);
  assert.equal(flattened.scaleY, 8);
});

test("remote SVG assets are streamed under the cap despite a lied content length", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "grapix-stream-cap-"));
  const originalFetch = globalThis.fetch;
  const chunk = new Uint8Array(1024 * 1024);
  let fetches = 0;
  process.env.GRAPIX_DATA_ROOT = root;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), "https://cdn.example.test/huge.png");
    fetches += 1;
    let sent = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (sent >= 101) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      }
    }), { status: 200, headers: { "content-length": "1" } });
  };
  try {
    const { DesignImportManager } = await import(`../dist/importers/design/designImportManager.js?stream-cap=${Date.now()}`);
    const manager = new DesignImportManager();
    const result = await manager.importFile(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><image href="https://cdn.example.test/huge.png" width="1" height="1"/></svg>'),
      "oversized.svg",
      { assetMode: "embed" }
    );

    assert.equal(fetches, 1, "the external asset was fetched exactly once");
    assert.equal(result.report.counts.assetsFailed, 1);
    assert.ok(result.report.warnings.some((entry) => entry.includes("exceeds 100 MB")));

    const blocked = await manager.importFile(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><image href="https://127.0.0.1/private.png" width="1" height="1"/></svg>'),
      "blocked.svg",
      { assetMode: "embed" }
    );
    assert.equal(fetches, 1, "a blocked private address must never be fetched");
    assert.equal(blocked.report.counts.assetsFailed, 1);
    assert.ok(blocked.report.warnings.some((entry) => entry.includes("blocked local or private host")));
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.GRAPIX_DATA_ROOT;
    await rm(root, { recursive: true, force: true });
  }
});

test("report counts partition every normalized source node and reject unknown options", async () => {
  const xml = await readFile(`${fixtureRoot}/design-import.svg`, "utf8");
  const report = createDesignImportReport("svg", "design-import.svg");
  const document = normalizeDesignDocument(
    importSvgDocument(xml, "design-import.svg", report),
    DEFAULT_DESIGN_IMPORT_OPTIONS,
    report
  );
  populateDesignImportCounts(document, report);
  assert.equal(report.counts.native + report.counts.genericContainers + report.counts.flattened, report.counts.nodes);
  assert.throws(() => parseDesignImportOptions('{"flattenGroups":false}'), /Unknown import option "flattenGroups"/);
});

test("unsupported feature policies preserve nested subtrees or report unavailable raster fallback", async () => {
  const json = JSON.parse(await readFile(`${fixtureRoot}/figma-design.json`, "utf8"));
  const report = createDesignImportReport("figma-json", "policy.json");
  const source = importFigmaDocument(json, "policy.json", report, "figma-json");
  const unsupported = {
    ...source.pages[0].nodes[0],
    id: "unsupported-group",
    name: "Unsupported group",
    type: "group",
    genericContainer: true,
    children: [source.pages[0].nodes[0].children.find((node) => !node.isMask)]
  };
  source.pages[0].nodes = [unsupported];

  const nested = normalizeDesignDocument(source, {
    ...DEFAULT_DESIGN_IMPORT_OPTIONS,
    preserveHierarchy: false,
    unsupportedFeaturePolicy: "nested-composition"
  }, report);
  assert.equal(nested.pages[0].nodes[0].type, "group");
  assert.equal(nested.pages[0].nodes[0].children.length, 1);
  assert.ok(report.issues.some((issue) => issue.message.includes("requested nested-composition")));

  const rasterReport = createDesignImportReport("figma-json", "policy-raster.json");
  const raster = normalizeDesignDocument(source, {
    ...DEFAULT_DESIGN_IMPORT_OPTIONS,
    unsupportedFeaturePolicy: "rasterize-layer"
  }, rasterReport);
  convertDesignDocumentToScenes(raster, DEFAULT_DESIGN_IMPORT_OPTIONS, rasterReport);
  assert.ok(rasterReport.issues.some((issue) => issue.message.includes("requested rasterize-layer") && issue.message.includes("no source-rendered fallback")));
});

test("SVG blend substitutions are reported", () => {
  const report = createDesignImportReport("svg", "overlay.svg");
  importSvgDocument(
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect id="overlay" width="10" height="10" fill="#fff" style="mix-blend-mode:overlay"/></svg>',
    "overlay.svg",
    report
  );
  assert.ok(report.visualDifferences.some((message) => message.includes('blend mode "overlay"') && message.includes('"screen"')));
});
