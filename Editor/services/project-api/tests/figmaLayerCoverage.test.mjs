import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_DESIGN_IMPORT_OPTIONS, resolveSceneObjectHierarchy } from "@grapix/shared-types";
import { normalizeDesignDocument } from "../dist/importers/design/designDocumentNormalizer.js";
import { importFigmaRestDocument } from "../dist/importers/design/figmaRestImporter.js";
import { mapFigmaType } from "../dist/importers/design/figmaImporter.js";
import { convertDesignDocumentToScenes } from "../dist/importers/design/grapixObjectConverter.js";
import { createDesignImportReport } from "../dist/importers/design/importReport.js";
import { roundedRectanglePath } from "../dist/importers/design/svgPath.js";

/**
 * The rule this file exists to defend: **no Figma node disappears.**
 *
 * Every layer must arrive as a native object, as a container whose children survive, or as pixels
 * the source tool rendered. A missing layer is silent — nothing in a scene says "there used to be
 * something here" — so these tests count nodes and name them rather than spot-checking a few.
 */

/**
 * A document exercising every mechanism at once.
 *
 * Deliberately awkward: nesting four deep, a clipping frame with rounded corners, a vector mask
 * group whose outline comes from a child, an alpha mask, hidden layers, an image fill *and* an image
 * stroke, a boolean operation with no returned geometry, a rotated layer, and a sticky note — a type
 * GrapiX cannot draw at all.
 */
function coverageResponse() {
  return {
    name: "Coverage Kit",
    nodes: {
      "1:1": {
        document: {
          id: "1:1",
          name: "Root Frame",
          type: "FRAME",
          absoluteBoundingBox: { x: 100, y: 200, width: 1920, height: 1080 },
          clipsContent: false,
          children: [
            {
              id: "1:2",
              name: "Clip Frame",
              type: "FRAME",
              absoluteBoundingBox: { x: 200, y: 300, width: 400, height: 200 },
              // The clip group: children must not draw outside this, and its corners are rounded.
              clipsContent: true,
              cornerRadius: 24,
              children: [
                {
                  id: "1:3",
                  name: "Overflowing Plate",
                  type: "RECTANGLE",
                  absoluteBoundingBox: { x: 150, y: 250, width: 1200, height: 800 },
                  fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }]
                },
                {
                  id: "1:4",
                  name: "Nested Group",
                  type: "GROUP",
                  absoluteBoundingBox: { x: 220, y: 320, width: 100, height: 100 },
                  children: [
                    {
                      id: "1:5",
                      name: "Deep Text",
                      type: "TEXT",
                      absoluteBoundingBox: { x: 230, y: 330, width: 80, height: 20 },
                      characters: "DEEP",
                      style: { fontFamily: "Saira", fontSize: 18, fontWeight: 700 }
                    }
                  ]
                }
              ]
            },
            {
              id: "1:6",
              name: "Mask Group",
              type: "GROUP",
              absoluteBoundingBox: { x: 700, y: 300, width: 300, height: 300 },
              children: [
                {
                  id: "1:7",
                  name: "Vector Mask",
                  type: "VECTOR",
                  absoluteBoundingBox: { x: 700, y: 300, width: 300, height: 300 },
                  isMask: true,
                  maskType: "VECTOR",
                  fillGeometry: [{ path: "M700 300 L1000 300 L850 600 Z" }]
                },
                {
                  id: "1:8",
                  name: "Masked Photo",
                  type: "RECTANGLE",
                  absoluteBoundingBox: { x: 700, y: 300, width: 300, height: 300 },
                  fills: [{ type: "IMAGE", imageRef: "ref-photo", scaleMode: "FILL" }]
                },
                {
                  id: "1:9",
                  name: "Also Masked",
                  type: "RECTANGLE",
                  absoluteBoundingBox: { x: 760, y: 360, width: 100, height: 100 },
                  fills: [{ type: "SOLID", color: { r: 0, g: 1, b: 0, a: 1 } }]
                }
              ]
            },
            {
              id: "1:10",
              name: "Alpha Mask Group",
              type: "GROUP",
              absoluteBoundingBox: { x: 1100, y: 300, width: 200, height: 200 },
              children: [
                {
                  id: "1:11",
                  name: "Soft Alpha",
                  type: "RECTANGLE",
                  absoluteBoundingBox: { x: 1100, y: 300, width: 200, height: 200 },
                  isMask: true,
                  maskType: "ALPHA"
                },
                {
                  id: "1:12",
                  name: "Under Alpha",
                  type: "ELLIPSE",
                  absoluteBoundingBox: { x: 1100, y: 300, width: 200, height: 200 },
                  fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 1, a: 1 } }]
                }
              ]
            },
            {
              id: "1:13",
              name: "Hidden Alternate",
              type: "RECTANGLE",
              absoluteBoundingBox: { x: 100, y: 900, width: 200, height: 60 },
              visible: false,
              fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 0, a: 1 } }]
            },
            {
              id: "1:14",
              name: "Bool Cut",
              type: "BOOLEAN_OPERATION",
              booleanOperation: "SUBTRACT",
              absoluteBoundingBox: { x: 400, y: 700, width: 120, height: 120 },
              // No fillGeometry: Figma sometimes withholds it, and the importer must render it.
              children: [
                {
                  id: "1:15",
                  name: "Operand",
                  type: "RECTANGLE",
                  absoluteBoundingBox: { x: 400, y: 700, width: 120, height: 120 }
                }
              ]
            },
            {
              id: "1:16",
              name: "Note",
              type: "STICKY",
              absoluteBoundingBox: { x: 1500, y: 700, width: 180, height: 180 },
              characters: "Check the lower third"
            },
            {
              id: "1:17",
              name: "Turned Badge",
              type: "RECTANGLE",
              // A 30-degree rotation: the reported box is the axis-aligned box around the turned
              // rectangle, while `size` is its own extent.
              absoluteBoundingBox: { x: 800, y: 800, width: 236.6, height: 236.6 },
              size: { x: 200, y: 100 },
              relativeTransform: [
                [0.866, 0.5, 800],
                [-0.5, 0.866, 800]
              ],
              fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
              strokes: [{ type: "IMAGE", imageRef: "ref-edge" }],
              strokeWeight: 4
            },
            {
              id: "1:18",
              name: "Export Marker",
              type: "SLICE",
              absoluteBoundingBox: { x: 0, y: 0, width: 10, height: 10 }
            }
          ]
        }
      }
    }
  };
}

function stubFetch(handlers) {
  return async (url, init) => {
    const target = String(url);
    for (const [fragment, respond] of Object.entries(handlers)) {
      if (target.includes(fragment)) return respond(target, init);
    }
    throw new Error(`unexpected request ${target}`);
  };
}

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Import the coverage document, recording every URL the importer asked for. */
async function importCoverage(overrides = {}) {
  const requests = [];
  const fetchImpl = stubFetch({
    "/nodes?": (url) => {
      requests.push(url);
      return jsonResponse(coverageResponse());
    },
    "/files/abc123DEF456ghi789JK/images": (url) => {
      requests.push(url);
      return jsonResponse({
        error: false,
        meta: {
          images: {
            "ref-photo": "https://figma-alpha-api.s3.amazonaws.com/images/photo.png",
            "ref-edge": "https://figma-alpha-api.s3.amazonaws.com/images/edge.png"
          }
        }
      });
    },
    "/v1/images/": (url) => {
      requests.push(url);
      // Everything the importer asks to be rendered, answered.
      const ids = new URL(url).searchParams.get("ids").split(",");
      return jsonResponse({
        err: null,
        images: Object.fromEntries(ids.map((id) => [id, `https://figma-alpha-api.s3.amazonaws.com/render/${id}.png`]))
      });
    },
    ...overrides
  });

  const report = createDesignImportReport("figma-json", "coverage");
  const document = await importFigmaRestDocument(
    { url: "https://www.figma.com/design/abc123DEF456ghi789JK/Kit?node-id=1-1", accessToken: "figd_test-token" },
    report,
    { fetchImpl }
  );
  // Hidden layers are kept, as the Figma route does by default.
  const options = { ...DEFAULT_DESIGN_IMPORT_OPTIONS, importHiddenLayers: true };
  const normalized = normalizeDesignDocument(document, options, report);
  const [scene] = convertDesignDocumentToScenes(normalized, options, report);
  return { document, normalized, scene, report, requests };
}

/** Every node in a normalized tree, by name. */
function nodesByName(nodes, into = new Map()) {
  for (const node of nodes) {
    into.set(node.name, node);
    nodesByName(node.children, into);
  }
  return into;
}

test("every layer in the document reaches the scene", async () => {
  const { normalized, scene } = await importCoverage();
  const nodes = nodesByName(normalized.pages[0].nodes);

  // 18 source nodes; the two mask layers are consumed into masks on what they mask, and the rest
  // must all be present.
  const expected = [
    "Root Frame",
    "Clip Frame",
    "Overflowing Plate",
    "Nested Group",
    "Deep Text",
    "Mask Group",
    "Masked Photo",
    "Also Masked",
    "Alpha Mask Group",
    "Under Alpha",
    "Hidden Alternate",
    "Bool Cut",
    "Operand",
    "Note",
    "Turned Badge",
    "Export Marker"
  ];
  for (const name of expected) {
    assert.ok(nodes.has(name), `${name} is missing from the imported document`);
    assert.ok(
      scene.objects.some((object) => object.name === name),
      `${name} is missing from the scene`
    );
  }

  // The mask layers themselves are not drawn — that is what a mask is — and nothing else vanished.
  assert.equal(nodes.has("Vector Mask"), false);
  assert.equal(nodes.has("Soft Alpha"), false);
});

test("nested layers keep their depth and their parent-relative position", async () => {
  const { normalized, scene } = await importCoverage();
  const nodes = nodesByName(normalized.pages[0].nodes);

  // Root at (100,200), Clip Frame at (200,300), Nested Group at (220,320), Deep Text at (230,330).
  assert.deepEqual([nodes.get("Clip Frame").x, nodes.get("Clip Frame").y], [100, 100]);
  assert.deepEqual([nodes.get("Nested Group").x, nodes.get("Nested Group").y], [20, 20]);
  assert.deepEqual([nodes.get("Deep Text").x, nodes.get("Deep Text").y], [10, 10]);

  // Hierarchy survives into the scene as childIds, four levels deep. A clipping frame is a clip
  // composition, so its children sit inside a "<name> contents" layer rather than directly under it
  // — the clip has to be on something, and putting it on a layer above the children is what lets
  // every child be clipped without any of them being rewritten.
  const byId = new Map(scene.objects.map((object) => [object.id, object]));
  const childNamed = (object, name) => byId.get(object.childIds.find((id) => byId.get(id).name === name));
  const root = scene.objects.find((object) => object.name === "Root Frame");
  const clip = childNamed(root, "Clip Frame");
  const contents = childNamed(clip, "Clip Frame contents");
  const group = childNamed(contents, "Nested Group");
  const text = byId.get(group.childIds[0]);
  assert.equal(text.name, "Deep Text");
  assert.equal(text.type, "text");
  assert.equal(text.text, "DEEP");
});

test("a clipping frame clips every descendant, with its own corner radius", async () => {
  const { scene, report } = await importCoverage();

  // The clip is authored once, on the composition that holds the children.
  const contents = scene.objects.find((object) => object.name === "Clip Frame contents");
  assert.equal(contents.masks.length, 1, "the clip is on the content composition");
  assert.equal(contents.masks[0].name, "Clip Frame clip");

  // Resolution hands it to every drawn descendant, in that descendant's own coordinate space.
  const resolution = resolveSceneObjectHierarchy(scene.objects);
  const drawn = new Map(resolution.renderableObjects.map((object) => [object.name, object]));

  const plate = drawn.get("Overflowing Plate");
  assert.equal(plate.masks.length, 1, "a child of a clipping frame carries the clip");

  // The frame is at (200,300) and the plate at (150,250), so the clip starts at (+50,+50).
  const clip = plate.masks[0];
  const xs = clip.path.vertices.map((vertex) => vertex.x);
  const ys = clip.path.vertices.map((vertex) => vertex.y);
  assert.equal(Math.round(Math.min(...xs)), 50);
  assert.equal(Math.round(Math.min(...ys)), 50);
  assert.equal(Math.round(Math.max(...xs)), 450, "50 + the frame's 400 width");
  assert.equal(Math.round(Math.max(...ys)), 250, "50 + the frame's 200 height");
  // Rounded, because the frame is: a square clip would show corners the designer rounded.
  assert.equal(clip.path.vertices.length, roundedRectanglePath(400, 200, [24, 24, 24, 24]).vertices.length);

  // And it reaches the grandchild too, not just the direct children.
  assert.equal(drawn.get("Deep Text").masks.length, 1);
  assert.ok(report.counts.clippedContainers >= 1);
});

test("a clipping frame is not clipped by itself", async () => {
  const { scene } = await importCoverage();
  const shape = scene.objects.find((object) => object.name === "Clip Frame clip shape");
  assert.deepEqual(shape.masks, [], "a frame's own fill and stroke draw in full");
  // This fixture's frame is unpainted, so the shape is too: it defines the clip and draws nothing.
  assert.equal(shape.fill, "transparent");
  assert.equal(shape.type, "shape", "and it is a real editable outline, not a bounding box");
});

test("a vector mask masks its later siblings with the outline the designer drew", async () => {
  const { normalized, scene } = await importCoverage();
  const nodes = nodesByName(normalized.pages[0].nodes);

  const photo = nodes.get("Masked Photo");
  assert.equal(photo.masks.length, 1);
  // The triangle from `fillGeometry`, not a bounding rectangle: three vertices, not four.
  assert.equal(photo.masks[0].path.vertices.length, 3);
  assert.equal(photo.masks[0].name, "Vector Mask");

  // Sibling order decides: both layers above the mask are masked.
  assert.equal(nodes.get("Also Masked").masks.length, 1);
  // ...and the mask is in each layer's own space, so the second one's copy is shifted.
  const first = photo.masks[0].path.vertices[0];
  const second = nodes.get("Also Masked").masks[0].path.vertices[0];
  assert.deepEqual([second.x - first.x, second.y - first.y], [-60, -60]);

  // Each masked object gets its own mask id, so editing one does not edit the other.
  const objects = scene.objects.filter((object) => ["Masked Photo", "Also Masked"].includes(object.name));
  assert.notEqual(objects[0].masks[0].id, objects[1].masks[0].id);
});

test("an alpha mask keeps its pixels as the mask's alpha, and says it is an approximation", async () => {
  const { normalized, report, requests } = await importCoverage();
  const nodes = nodesByName(normalized.pages[0].nodes);

  const masked = nodes.get("Under Alpha");
  assert.equal(masked.masks.length, 1);
  assert.ok(masked.masks[0].alphaAssetId, "the rendered alpha travels with the mask");

  // The mask layer was rendered as PNG, because its pixels are the mask.
  assert.ok(requests.some((url) => url.includes("/v1/images/") && url.includes("1%3A11") && url.includes("format=png")));
  assert.ok(
    report.issues.some((issue) => issue.message.includes("alpha mask")),
    "the operator is told the outline is an approximation"
  );
});

test("image fills and image strokes are both collected, deduplicated, and downloaded", async () => {
  const { document, normalized, report } = await importCoverage();
  const nodes = nodesByName(normalized.pages[0].nodes);

  const photo = nodes.get("Masked Photo");
  const fillAsset = document.assets.find((asset) => asset.id === photo.assetId);
  assert.equal(fillAsset.sourceUrl, "https://figma-alpha-api.s3.amazonaws.com/images/photo.png");

  // The image *stroke* is collected too — it used to be dropped without a word.
  const badge = nodes.get("Turned Badge");
  assert.deepEqual(badge.strokeImageAssetIds, ["figma-image-ref-edge"]);
  assert.ok(document.assets.some((asset) => asset.id === "figma-image-ref-edge"));
  assert.ok(report.visualDifferences.some((entry) => entry.includes("stroked with an image")));

  // One asset per imageRef, however many layers use it.
  const refs = document.assets.filter((asset) => asset.id.startsWith("figma-image-"));
  assert.equal(new Set(refs.map((asset) => asset.id)).size, refs.length);
});

test("a rotated layer keeps its own size and angle instead of its bounding box", async () => {
  const { normalized } = await importCoverage();
  const badge = nodesByName(normalized.pages[0].nodes).get("Turned Badge");

  // `size`, not the 236.6 axis-aligned box that a 30-degree rotation produces.
  assert.equal(badge.width, 200);
  assert.equal(badge.height, 100);
  assert.ok(Math.abs(badge.rotation - -30) < 0.01, `rotation was ${badge.rotation}`);
  // Pivoted about its centre, so the rotated box still covers the box Figma reported.
  assert.deepEqual([badge.anchor.x, badge.anchor.y], [100, 50]);
});

test("a hidden layer is imported hidden rather than dropped", async () => {
  const { normalized, scene } = await importCoverage();
  const hidden = nodesByName(normalized.pages[0].nodes).get("Hidden Alternate");
  assert.equal(hidden.visible, false);

  const object = scene.objects.find((item) => item.name === "Hidden Alternate");
  assert.equal(object.visible, false, "the scene keeps it, switched off");
});

test("a type GrapiX cannot draw becomes a container plus a Figma render, never nothing", async () => {
  const { normalized, scene, report, requests } = await importCoverage();
  const nodes = nodesByName(normalized.pages[0].nodes);

  const note = nodes.get("Note");
  assert.equal(note.sourceType, "STICKY");
  assert.equal(note.genericContainer, true);
  assert.equal(note.flattenedFromFigma, true);
  assert.ok(note.renderedAssetId, "Figma was asked to draw it");

  // A leaf becomes the render itself, so the scene shows the sticky note.
  const object = scene.objects.find((item) => item.name === "Note");
  assert.equal(object.type, "image");
  assert.equal(object.importedDesign.flattenedFromFigma, true);
  assert.equal(object.importedDesign.sourceType, "STICKY");

  assert.ok(requests.some((url) => url.includes("1%3A16")));
  assert.ok(report.counts.flattened >= 1);
});

test("a boolean operation with no returned geometry is rendered as SVG and keeps its operands", async () => {
  const { normalized, scene, requests } = await importCoverage();
  const nodes = nodesByName(normalized.pages[0].nodes);

  const bool = nodes.get("Bool Cut");
  assert.equal(bool.type, "boolean-operation");
  assert.equal(bool.flattenedFromFigma, true);
  // SVG, because a vector should not become pixels.
  assert.ok(requests.some((url) => url.includes("/v1/images/") && url.includes("format=svg") && url.includes("1%3A14")));

  // The operand is still there for an author who wants to rebuild the operation.
  assert.ok(nodes.has("Operand"));
  assert.ok(scene.objects.some((object) => object.name === "Operand"));
});

test("a failed render costs pixels, not the layer or the import", async () => {
  const { normalized, scene, report } = await importCoverage({
    "/v1/images/": () => jsonResponse({ err: "rate limited" }, 429)
  });
  const nodes = nodesByName(normalized.pages[0].nodes);

  // Still present, still named, still positioned — with its bounds and metadata.
  assert.ok(nodes.has("Note"));
  assert.equal(nodes.get("Note").renderedAssetId, undefined);
  assert.ok(scene.objects.some((object) => object.name === "Note"));
  assert.ok(report.counts.assetsFailed > 0);
  assert.ok(report.warnings.some((message) => message.includes("could not render")));
});

test("the report accounts for every node Figma returned", async () => {
  const { report, normalized } = await importCoverage();
  const surviving = nodesByName(normalized.pages[0].nodes).size;

  // Every node the source returned is either native or a generic container...
  assert.equal(report.counts.nodes, report.counts.native + report.counts.genericContainers);
  // ...and every one either survives as a layer or was consumed into a mask. That equality is the
  // whole promise of this importer: nothing is unaccounted for. `syntheticLayers` is the other
  // direction — layers in the scene that no source node produced, because expressing a clip takes
  // a shape and a composition — so it is subtracted rather than left to make the sum drift.
  assert.equal(report.counts.nodes, surviving - report.counts.syntheticLayers + report.counts.masks);
  assert.equal(
    report.counts.syntheticLayers,
    report.counts.clippedContainers * 2,
    "two layers per clip: the shape that defines it and the composition that carries it"
  );
  assert.equal(report.counts.masks, 2, "one vector mask and one alpha mask");
  assert.equal(report.counts.clippedContainers, 1);
  assert.ok(report.counts.genericContainers >= 1);
  assert.ok(report.counts.flattened >= 2, "the sticky note and the geometry-less boolean");
});

test("every Figma node type maps to something, and nothing falls through to a bare group", () => {
  const families = {
    FRAME: "frame",
    GROUP: "group",
    SECTION: "section",
    COMPONENT: "component",
    COMPONENT_SET: "component-set",
    INSTANCE: "instance",
    RECTANGLE: "rectangle",
    ELLIPSE: "ellipse",
    LINE: "line",
    VECTOR: "path",
    STAR: "path",
    REGULAR_POLYGON: "path",
    BOOLEAN_OPERATION: "boolean-operation",
    TEXT: "text",
    SLICE: "slice",
    STICKY: "annotation",
    CONNECTOR: "annotation",
    TABLE: "annotation",
    WIDGET: "annotation",
    EMBED: "annotation"
  };
  for (const [figma, expected] of Object.entries(families)) {
    assert.equal(mapFigmaType(figma), expected, `${figma} must map to ${expected}`);
  }

  // Something Figma has not shipped yet: explicitly unsupported, which is what triggers the render
  // fallback — never silently a group, which is what used to happen.
  assert.equal(mapFigmaType("HOLOGRAM"), "unsupported");
});

test("a rounded clip rectangle is a real rounded rectangle", () => {
  const path = roundedRectanglePath(400, 200, [24, 0, 24, 0]);
  // Two anchors for each rounded corner, one for each square corner.
  assert.equal(path.vertices.length, 6);
  assert.equal(path.closed, true);

  // A corner with no radius contributes the corner point itself.
  assert.ok(path.vertices.some((vertex) => vertex.x === 400 && vertex.y === 0));
  // A rounded corner never reaches its corner point.
  assert.equal(path.vertices.some((vertex) => vertex.x === 0 && vertex.y === 0), false);

  // Radii larger than the box are clamped rather than producing a self-crossing outline.
  const clamped = roundedRectanglePath(100, 40, [999, 999, 999, 999]);
  assert.ok(clamped.vertices.every((vertex) => vertex.x >= 0 && vertex.x <= 100 && vertex.y >= 0 && vertex.y <= 40));
});
