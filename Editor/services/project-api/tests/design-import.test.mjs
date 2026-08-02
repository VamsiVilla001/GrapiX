import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { writePsd } from "ag-psd";
import {
  DEFAULT_DESIGN_IMPORT_OPTIONS,
  IMPLEMENTED_BLEND_MODES
} from "@grapix/shared-types";
import { normalizeDesignDocument } from "../dist/importers/design/designDocumentNormalizer.js";
import { importFigmaDocument } from "../dist/importers/design/figmaImporter.js";
import {
  documentFromFigmaMcpCaptures,
  parseFigmaMcpNodeIds
} from "../dist/importers/design/figmaMcpImporter.js";
import { convertDesignDocumentToScenes } from "../dist/importers/design/grapixObjectConverter.js";
import { createDesignImportReport, pruneDesignImportIssues } from "../dist/importers/design/importReport.js";
import { importIllustratorDocument, importSvgDocument } from "../dist/importers/design/illustratorImporter.js";
import { importPsdDocument } from "../dist/importers/design/psdImporter.js";

const fixtureRoot = fileURLToPath(new URL("./fixtures/", import.meta.url));

test("SVG/Illustrator-compatible import preserves hierarchy, editable paths, gradients, clipping, and text", async () => {
  const xml = await readFile(`${fixtureRoot}/design-import.svg`, "utf8");
  const report = createDesignImportReport("svg", "design-import.svg");
  const normalized = normalizeDesignDocument(
    importSvgDocument(xml, "design-import.svg", report),
    DEFAULT_DESIGN_IMPORT_OPTIONS
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
    normalizeDesignDocument(document, DEFAULT_DESIGN_IMPORT_OPTIONS),
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
    DEFAULT_DESIGN_IMPORT_OPTIONS
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
    parseFigmaMcpNodeIds({ ...source, nodeIds: ["7:8", "7-8", "bad"] }),
    ["7:8"]
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
    normalizeDesignDocument(document, DEFAULT_DESIGN_IMPORT_OPTIONS),
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
  });
  const [scene] = convertDesignDocumentToScenes(document, DEFAULT_DESIGN_IMPORT_OPTIONS, report);
  assert.equal(scene.canvas.width, 320);
  assert.ok(scene.objects.some((object) => object.type === "group" && object.name === "Nested Group"));
  assert.ok(scene.objects.some((object) => object.type === "text" && object.text === "PSD Headline"));
  assert.ok(scene.objects.some((object) => object.type === "image" && object.name === "Pixel Layer"));
  assert.ok(scene.objects.some((object) => object.type === "shape" && object.name === "Vector Shape"));
  const pixel = scene.objects.find((object) => object.name === "Pixel Layer");
  assert.ok(pixel.importedDesign.effects.some((effect) => effect.type === "drop-shadow"));
  assert.ok(report.visualDifferences.some((message) => message.includes("Photoshop layer effects")));
});

test("visual compatibility fingerprint retains source geometry and alpha stops", async () => {
  const xml = await readFile(`${fixtureRoot}/design-import.svg`, "utf8");
  const report = createDesignImportReport("svg", "visual.svg");
  const [scene] = convertDesignDocumentToScenes(
    normalizeDesignDocument(importSvgDocument(xml, "visual.svg", report), DEFAULT_DESIGN_IMPORT_OPTIONS),
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
  });
  assert.equal(selected.pages[0].nodes.length, 1);
  assert.deepEqual(selected.pages[0].nodes[0].children.map((node) => node.name), ["Team Name"]);

  const flattened = normalizeDesignDocument(source, {
    ...DEFAULT_DESIGN_IMPORT_OPTIONS,
    preserveHierarchy: false,
    convertComponents: false
  });
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
    DEFAULT_DESIGN_IMPORT_OPTIONS
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
    { ...DEFAULT_DESIGN_IMPORT_OPTIONS, importHiddenLayers: true }
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
    { ...DEFAULT_DESIGN_IMPORT_OPTIONS, importHiddenLayers: true }
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
    DEFAULT_DESIGN_IMPORT_OPTIONS
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
