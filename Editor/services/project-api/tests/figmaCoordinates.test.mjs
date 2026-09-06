import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_DESIGN_IMPORT_OPTIONS } from "@grapix/shared-types";
import { normalizeDesignDocument } from "../dist/importers/design/designDocumentNormalizer.js";
import { importFigmaDocument } from "../dist/importers/design/figmaImporter.js";
import { documentFromFigmaMcpCaptures } from "../dist/importers/design/figmaMcpImporter.js";
import { convertDesignDocumentToScenes } from "../dist/importers/design/grapixObjectConverter.js";
import { createDesignImportReport } from "../dist/importers/design/importReport.js";

/**
 * A root frame far down its Figma page. `absoluteBoundingBox` is page space, so the
 * frame's own y is 4875 and its height is 1080 - the canvas is 1920 x 1080, never
 * 4875 + 1080.
 */
function pageWithOffsetRootFrame() {
  return {
    name: "Broadcast Kit",
    document: {
      id: "0:0",
      type: "DOCUMENT",
      children: [{
        id: "0:1",
        name: "Page 1",
        type: "CANVAS",
        children: [{
          id: "94:13013",
          name: "Team Reveal",
          type: "FRAME",
          absoluteBoundingBox: { x: 1884, y: 4875, width: 1920, height: 1080 },
          children: [
            {
              id: "94:13014",
              name: "Headline",
              type: "TEXT",
              absoluteBoundingBox: { x: 1964, y: 4995, width: 600, height: 90 },
              characters: "WOLFRAHH",
              style: { fontFamily: "Saira Condensed", fontSize: 72 }
            },
            {
              id: "94:13015",
              name: "Inner Group",
              type: "GROUP",
              absoluteBoundingBox: { x: 2884, y: 5415, width: 400, height: 300 },
              children: [{
                id: "94:13016",
                name: "Nested Plate",
                type: "RECTANGLE",
                absoluteBoundingBox: { x: 2934, y: 5465, width: 200, height: 100 }
              }]
            }
          ]
        }]
      }]
    }
  };
}

test("the selected root frame becomes the scene origin and the scene size", () => {
  const report = createDesignImportReport("figma-json", "offset.json");
  const document = importFigmaDocument(pageWithOffsetRootFrame(), "offset.json", report, "figma-json");

  // Scene dimensions come from the frame itself: 1920 x 1080, not 3804 x 5955.
  assert.equal(document.pages[0].width, 1920);
  assert.equal(document.pages[0].height, 1080);
  assert.equal(document.width, 1920);
  assert.equal(document.height, 1080);

  const [root] = document.pages[0].nodes;
  assert.equal(root.name, "Team Reveal");
  assert.deepEqual({ x: root.x, y: root.y }, { x: 0, y: 0 });

  // localX = node.absoluteX - root.absoluteX, at every depth.
  const headline = root.children.find((node) => node.name === "Headline");
  assert.deepEqual({ x: headline.x, y: headline.y }, { x: 80, y: 120 });

  const group = root.children.find((node) => node.name === "Inner Group");
  assert.deepEqual({ x: group.x, y: group.y }, { x: 1000, y: 540 });
  const nested = group.children[0];
  // A nested node is relative to its own parent, which is already root-relative.
  assert.deepEqual({ x: nested.x, y: nested.y }, { x: 50, y: 50 });
});

test("Figma relative transforms retain a rotated and scaled hierarchy in local space", () => {
  const report = createDesignImportReport("figma-json", "transform.json");
  const document = importFigmaDocument({
    document: {
      type: "DOCUMENT",
      children: [{
        type: "CANVAS",
        children: [{
          id: "1:1",
          name: "Root",
          type: "FRAME",
          absoluteBoundingBox: { x: 0, y: 0, width: 500, height: 500 },
          size: { x: 500, y: 500 },
          relativeTransform: [[1, 0, 0], [0, 1, 0]],
          children: [{
            id: "1:2",
            name: "Rotated parent",
            type: "GROUP",
            absoluteBoundingBox: { x: 0, y: 50, width: 100, height: 200 },
            size: { x: 100, y: 50 },
            relativeTransform: [[0, -2, 100], [2, 0, 50]],
            children: [{
              id: "1:3",
              name: "Nested child",
              type: "RECTANGLE",
              absoluteBoundingBox: { x: 40, y: 90, width: 30, height: 20 },
              size: { x: 20, y: 40 },
              relativeTransform: [[1.5, 0, 20], [0, 0.5, 30]]
            }]
          }]
        }]
      }]
    }
  }, "transform.json", report, "figma-json");

  const parent = document.pages[0].nodes[0].children[0];
  const child = parent.children[0];
  assert.deepEqual(
    { x: parent.x, y: parent.y, scaleX: parent.scaleX, scaleY: parent.scaleY, rotation: parent.rotation },
    { x: 100, y: 50, scaleX: 2, scaleY: 2, rotation: 90 }
  );
  assert.deepEqual(
    { x: child.x, y: child.y, scaleX: child.scaleX, scaleY: child.scaleY, rotation: child.rotation },
    { x: 20, y: 30, scaleX: 1.5, scaleY: 0.5, rotation: 0 }
  );
});

test("Figma gradient stop opacity includes paint opacity exactly once", () => {
  const report = createDesignImportReport("figma-json", "gradient.json");
  const document = importFigmaDocument({
    document: {
      type: "DOCUMENT",
      children: [{
        type: "CANVAS",
        children: [{
          id: "2:1",
          name: "Gradient",
          type: "RECTANGLE",
          absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
          fills: [{
            type: "GRADIENT_LINEAR",
            opacity: 0.5,
            gradientStops: [
              { position: 0, color: { r: 1, g: 0, b: 0, a: 0.8 } },
              { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }
            ],
            gradientHandlePositions: [{ x: 0, y: 0 }, { x: 1, y: 0 }]
          }]
        }]
      }]
    }
  }, "gradient.json", report, "figma-json");
  const gradient = document.pages[0].nodes[0].fills[0];
  assert.equal(gradient.type, "linear-gradient");
  assert.deepEqual(gradient.stops.map((stop) => stop.opacity), [0.4, 0.5]);
  assert.deepEqual(gradient.stops.map((stop) => stop.color), ["#ff0000", "#0000ff"]);
});

test("Figma mixed text and per-side strokes are preserved with fidelity warnings", () => {
  const report = createDesignImportReport("figma-json", "fidelity.json");
  const document = importFigmaDocument({
    document: {
      type: "DOCUMENT",
      children: [{
        type: "CANVAS",
        children: [{
          id: "3:1",
          name: "Mixed label",
          type: "TEXT",
          absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 20 },
          characters: "AB",
          style: { fontFamily: "Inter", fontSize: 16 },
          characterStyleOverrides: [0, 1],
          styleOverrideTable: { "1": { fontWeight: 700 } }
        }, {
          id: "3:2",
          name: "Border",
          type: "RECTANGLE",
          absoluteBoundingBox: { x: 0, y: 30, width: 100, height: 100 },
          strokeWeight: 1,
          individualStrokeWeights: { top: 1, right: 2, bottom: 1, left: 2 }
        }]
      }]
    }
  }, "fidelity.json", report, "figma-json");
  const [label, border] = document.pages[0].nodes;
  assert.deepEqual(label.sourceData.characterStyleOverrides, [0, 1]);
  assert.deepEqual(label.sourceData.styleOverrideTable, { "1": { fontWeight: 700 } });
  assert.deepEqual(border.sourceData.individualStrokeWeights, { top: 1, right: 2, bottom: 1, left: 2 });
  assert.ok(report.visualDifferences.some((message) => message.includes("mixed Figma text styles")));
  assert.ok(report.visualDifferences.some((message) => message.includes("per-side Figma stroke weights")));
});

test("the converted scene places the imported frame at the canvas origin", () => {
  const report = createDesignImportReport("figma-json", "offset.json");
  const [scene] = convertDesignDocumentToScenes(
    normalizeDesignDocument(
      importFigmaDocument(pageWithOffsetRootFrame(), "offset.json", report, "figma-json"),
      DEFAULT_DESIGN_IMPORT_OPTIONS, report
    ),
    DEFAULT_DESIGN_IMPORT_OPTIONS,
    report
  );

  assert.equal(scene.canvas.width, 1920);
  assert.equal(scene.canvas.height, 1080);

  const frame = scene.objects.find((object) => object.name === "Team Reveal");
  assert.deepEqual({ x: frame.x, y: frame.y }, { x: 0, y: 0 });

  // Flattening keeps world positions inside the canvas rather than 4875 px below it.
  const [flattened] = convertDesignDocumentToScenes(
    normalizeDesignDocument(
      importFigmaDocument(pageWithOffsetRootFrame(), "offset.json", report, "figma-json"),
      { ...DEFAULT_DESIGN_IMPORT_OPTIONS, preserveHierarchy: false }, report
    ),
    { ...DEFAULT_DESIGN_IMPORT_OPTIONS, preserveHierarchy: false },
    report
  );
  const plate = flattened.objects.find((object) => object.name === "Nested Plate");
  assert.deepEqual({ x: plate.x, y: plate.y }, { x: 1050, y: 590 });
  assert.ok(plate.y + plate.height <= flattened.canvas.height);
});

test("several root frames use their common top-left as the origin and their extent as the size", () => {
  const report = createDesignImportReport("figma-json", "multi.json");
  const document = importFigmaDocument({
    document: {
      id: "0:0",
      type: "DOCUMENT",
      children: [{
        id: "0:1",
        name: "Page 1",
        type: "CANVAS",
        children: [
          { id: "1:1", name: "Left", type: "FRAME", absoluteBoundingBox: { x: 100, y: 4875, width: 400, height: 300 } },
          { id: "1:2", name: "Right", type: "FRAME", absoluteBoundingBox: { x: 700, y: 5000, width: 400, height: 300 } }
        ]
      }]
    }
  }, "multi.json", report, "figma-json");

  // Extent is 100..1100 x 4875..5300, so 1000 x 425 - not 1100 x 5300.
  assert.equal(document.pages[0].width, 1000);
  assert.equal(document.pages[0].height, 425);
  assert.deepEqual(
    document.pages[0].nodes.map((node) => ({ name: node.name, x: node.x, y: node.y })),
    [{ name: "Left", x: 0, y: 0 }, { name: "Right", x: 600, y: 125 }]
  );
});

test("an MCP capture sizes the scene from the frame, not from its page position", () => {
  const report = createDesignImportReport("figma-mcp", "mcp");
  const document = documentFromFigmaMcpCaptures(
    { url: "https://www.figma.com/design/abc123DEF456ghi789JK/Kit?node-id=94-13013" },
    [{
      nodeId: "94:13013",
      name: "Team Reveal",
      metadata: '<frame id="94:13013" name="Team Reveal" x="1884" y="4875" width="1920" height="1080" />',
      imageBase64: "aGVsbG8=",
      mimeType: "image/png",
      width: 1920,
      height: 1080,
      absoluteX: 1884,
      absoluteY: 4875
    }],
    report
  );

  assert.equal(document.width, 1920);
  assert.equal(document.height, 1080);
  assert.equal(document.pages[0].width, 1920);
  assert.equal(document.pages[0].height, 1080);
  const [node] = document.pages[0].nodes;
  assert.deepEqual({ x: node.x, y: node.y }, { x: 0, y: 0 });
  // The page position survives as provenance, and only as provenance.
  assert.deepEqual(node.sourceData.pagePosition, { x: 1884, y: 4875 });
});
