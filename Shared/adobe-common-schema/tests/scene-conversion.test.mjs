import { test } from "node:test";
import assert from "node:assert/strict";
import { preflightScenePackage } from "@grapix/shared-types";

import { adobeDocumentToScene } from "../dist/index.js";

function transform(overrides = {}) {
  return { x: 0, y: 0, scaleX: 1, scaleY: 1, opacity: 1, ...overrides };
}

function sourceDocument() {
  return {
    source: "photoshop",
    documentId: "psd://lower-third",
    name: "Lower Third.psd",
    width: 1920,
    height: 1080,
    assets: [],
    warnings: [],
    layers: [
      {
        id: "title-group",
        name: "Title group",
        type: "group",
        visible: true,
        locked: false,
        opacity: 1,
        transform: transform({ x: 50, y: 500 }),
        children: [
          {
            id: "headline",
            name: "Headline",
            type: "text",
            visible: true,
            locked: false,
            opacity: 1,
            transform: transform({ x: 0, y: 0 }),
            textData: {
              text: "BREAKING NEWS",
              fontSize: 48,
              fontFamily: "Inter",
              color: "#ffffff",
              align: "left"
            }
          },
          {
            id: "pixel/id",
            name: "Logo pixels",
            type: "pixel",
            visible: true,
            locked: false,
            opacity: 1,
            transform: transform({ x: 700, y: 0 })
          }
        ]
      },
      {
        id: "pixel-id",
        name: "Duplicate-safe id",
        type: "pixel",
        visible: true,
        locked: false,
        opacity: 1,
        transform: transform({ x: 1200, y: 0 })
      }
    ]
  };
}

test("Photoshop text remains editable with its authored string, family, and size", () => {
  const { scene } = adobeDocumentToScene(sourceDocument());
  const headline = scene.objects.find((object) => object.name === "Headline");

  assert.equal(headline?.type, "text");
  assert.equal(headline?.text, "BREAKING NEWS");
  assert.equal(headline?.fontFamily, "Inter");
  assert.equal(headline?.fontSize, 48);
  assert.equal(headline?.importedDesign?.sourceFormat, "psd");
});

test("Photoshop groups use childIds while every object stays on main", () => {
  const { scene } = adobeDocumentToScene(sourceDocument());
  const group = scene.objects.find((object) => object.name === "Title group");
  const headline = scene.objects.find((object) => object.name === "Headline");
  const pixels = scene.objects.find((object) => object.name === "Logo pixels");

  assert.equal(group?.type, "group");
  assert.deepEqual(group?.childIds, [headline?.id, pixels?.id]);
  assert.ok(scene.objects.every((object) => object.layerId === "main"));
  assert.deepEqual(scene.objects.map((object) => object.zIndex), [0, 1, 2, 3]);
});

test("manifest pixel layers become transparent rectangles and name their missing rendition", () => {
  const { scene, report } = adobeDocumentToScene(sourceDocument());
  const pixels = scene.objects.find((object) => object.name === "Logo pixels");
  const warning = report.warnings.find((item) => item.layerId === "pixel/id" && item.code === "photoshop.rendition.required");

  assert.equal(pixels?.type, "rect");
  assert.equal(pixels?.fill, "transparent");
  assert.equal(warning?.status, "Converted");
  assert.match(warning?.message ?? "", /geometry imported.*no layer pixels.*rendition/i);
});

test("converted scenes have unique object ids and pass package preflight without errors", () => {
  const { scene, report } = adobeDocumentToScene(sourceDocument());
  const ids = scene.objects.map((object) => object.id);
  const preflight = preflightScenePackage(scene);

  assert.equal(report.converted, scene.objects.length);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(scene.version, 1);
  assert.deepEqual(scene.materials, []);
  assert.deepEqual(scene.timeline, { fps: 50, durationFrames: 300, keyframes: [] });
  assert.equal(preflight.issues.filter((issue) => issue.severity === "error").length, 0);
});
