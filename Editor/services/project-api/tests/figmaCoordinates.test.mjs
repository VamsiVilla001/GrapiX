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

test("the converted scene places the imported frame at the canvas origin", () => {
  const report = createDesignImportReport("figma-json", "offset.json");
  const [scene] = convertDesignDocumentToScenes(
    normalizeDesignDocument(
      importFigmaDocument(pageWithOffsetRootFrame(), "offset.json", report, "figma-json"),
      DEFAULT_DESIGN_IMPORT_OPTIONS
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
      { ...DEFAULT_DESIGN_IMPORT_OPTIONS, preserveHierarchy: false }
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
