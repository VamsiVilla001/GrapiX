import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_DESIGN_IMPORT_OPTIONS, resolveSceneObjectHierarchy } from "@grapix/shared-types";
import { normalizeDesignDocument } from "../dist/importers/design/designDocumentNormalizer.js";
import { importFigmaDocument } from "../dist/importers/design/figmaImporter.js";
import { convertDesignDocumentToScenes } from "../dist/importers/design/grapixObjectConverter.js";
import { createDesignImportReport } from "../dist/importers/design/importReport.js";

/**
 * A clip group is a nested composition, and the clip has to reach what is inside it.
 *
 * Two halves, both load-bearing:
 *
 * 1. The importer builds `Clip Composition → [Clip Shape, Content Composition]`, so one clip exists
 *    in one place and an author can reshape it.
 * 2. `resolveSceneObjectHierarchy` carries a container's mask down to the objects that are actually
 *    drawn. Without that the structure is decoration: a container is never rendered, so a mask
 *    authored on one clips nothing at all.
 */

/** A clipping frame with a rounded corner, a child that overflows it, and a nested clip inside. */
function clipDocument() {
  return {
    name: "Clip Kit",
    document: {
      id: "0:0",
      name: "Clip Kit",
      type: "DOCUMENT",
      children: [{
        id: "0:1",
        name: "Page",
        type: "CANVAS",
        children: [{
          id: "1:1",
          name: "Card",
          type: "FRAME",
          absoluteBoundingBox: { x: 100, y: 100, width: 600, height: 400 },
          clipsContent: true,
          cornerRadius: 32,
          fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0, a: 0.5 } }],
          children: [
            {
              id: "1:2",
              name: "Overflowing Photo",
              type: "RECTANGLE",
              absoluteBoundingBox: { x: 50, y: 50, width: 1200, height: 900 },
              fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }]
            },
            {
              id: "1:3",
              name: "Inner Clip",
              type: "FRAME",
              absoluteBoundingBox: { x: 200, y: 200, width: 200, height: 100 },
              clipsContent: true,
              children: [{
                id: "1:4",
                name: "Deep Label",
                type: "TEXT",
                absoluteBoundingBox: { x: 210, y: 210, width: 400, height: 40 },
                characters: "DEEP",
                style: { fontFamily: "Inter", fontSize: 24, fontWeight: 700 }
              }]
            }
          ]
        }]
      }]
    }
  };
}

function importClipScene() {
  const report = createDesignImportReport("figma-json", "clip.json");
  const document = normalizeDesignDocument(
    importFigmaDocument(clipDocument(), "clip.json", report, "figma-json"),
    DEFAULT_DESIGN_IMPORT_OPTIONS,
    report
  );
  const [scene] = convertDesignDocumentToScenes(document, DEFAULT_DESIGN_IMPORT_OPTIONS, report);
  return { document, scene, report };
}

/** The scene's objects indexed by name, plus a child lookup that follows `childIds`. */
function sceneIndex(scene) {
  const byId = new Map(scene.objects.map((object) => [object.id, object]));
  const byName = new Map(scene.objects.map((object) => [object.name, object]));
  const childrenOf = (name) => (byName.get(name)?.childIds ?? []).map((id) => byId.get(id));
  return { byId, byName, childrenOf };
}

test("a clipping frame becomes a clip composition holding a clip shape and a content composition", () => {
  const { scene } = importClipScene();
  const { byName, childrenOf } = sceneIndex(scene);

  const composition = byName.get("Card");
  assert.equal(composition.type, "group", "the composition itself draws nothing");
  // The card is the only root on the page, so the page's origin is its own top-left corner.
  assert.deepEqual([composition.x, composition.y], [0, 0], "it keeps the frame's position");
  assert.deepEqual([composition.width, composition.height], [600, 400], "and the frame's size");

  const children = childrenOf("Card");
  assert.deepEqual(
    children.map((child) => child.name),
    ["Card clip shape", "Card contents"],
    "the clip shape comes first, then the contents"
  );

  const [clipShape, contents] = children;

  // The clip shape carries the frame's exact geometry and its paint.
  assert.equal(clipShape.type, "shape");
  assert.deepEqual([clipShape.x, clipShape.y], [0, 0], "at the composition's origin");
  assert.notEqual(clipShape.fill, "transparent", "the frame's background moved to the shape that defines it");
  assert.equal(composition.fill, "transparent", "so the composition does not paint it a second time");
  const xs = clipShape.path.vertices.map((vertex) => vertex.x);
  const ys = clipShape.path.vertices.map((vertex) => vertex.y);
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [0, 600], "the frame's width");
  assert.deepEqual([Math.min(...ys), Math.max(...ys)], [0, 400], "the frame's height");
  assert.ok(clipShape.path.vertices.length > 4, "rounded corners, not a bare rectangle");

  // The content composition carries the clip, and nothing else.
  assert.equal(contents.type, "group");
  assert.equal(contents.masks.length, 1);
  assert.equal(contents.masks[0].name, "Card clip");
  assert.deepEqual([contents.x, contents.y], [0, 0]);
});

test("the children keep their own transforms and their original order", () => {
  const { scene } = importClipScene();
  const { childrenOf } = sceneIndex(scene);

  const inside = childrenOf("Card contents");
  assert.deepEqual(
    inside.map((child) => child.name),
    ["Overflowing Photo", "Inner Clip"],
    "document order is preserved"
  );

  // The photo is at (50,50) absolute inside a frame at (100,100): -50,-50 in the frame's space,
  // untouched by the clip composition.
  const photo = inside[0];
  assert.deepEqual([photo.x, photo.y], [-50, -50]);
  assert.deepEqual([photo.width, photo.height], [1200, 900]);
  assert.deepEqual(photo.masks, [], "the child is not given a mask of its own");
});

test("the clip reaches every drawn object beneath it, in that object's own space", () => {
  const { scene } = importClipScene();
  const resolution = resolveSceneObjectHierarchy(scene.objects);
  const drawn = new Map(resolution.renderableObjects.map((object) => [object.name, object]));

  const photo = drawn.get("Overflowing Photo");
  assert.ok(photo, "the photo is a drawn object");
  assert.equal(photo.masks.length, 1, "the container's clip reached it");

  // The clip is the frame's rectangle. The photo sits at (-50,-50) in the frame, so in the photo's
  // own space the clip starts at (+50, +50) and ends 600x400 later.
  const xs = photo.masks[0].path.vertices.map((vertex) => vertex.x);
  const ys = photo.masks[0].path.vertices.map((vertex) => vertex.y);
  assert.equal(Math.round(Math.min(...xs)), 50);
  assert.equal(Math.round(Math.min(...ys)), 50);
  assert.equal(Math.round(Math.max(...xs)), 650);
  assert.equal(Math.round(Math.max(...ys)), 450);
});

test("a clipped frame inside a clipped frame nests, and both clips are in force", () => {
  const { scene } = importClipScene();
  const { byName, childrenOf } = sceneIndex(scene);

  // The inner frame is itself a clip composition, inside the outer one's contents.
  const innerNames = childrenOf("Inner Clip").map((child) => child.name);
  assert.deepEqual(innerNames, ["Inner Clip clip shape", "Inner Clip contents"]);
  assert.ok(byName.get("Inner Clip contents").masks.length === 1);

  // The label is inside both, so resolution hands it both clips.
  const resolution = resolveSceneObjectHierarchy(scene.objects);
  const label = resolution.renderableObjects.find((object) => object.name === "Deep Label");
  assert.ok(label);
  assert.equal(label.masks.length, 2, "the outer clip and the inner clip");

  const extents = label.masks.map((mask) => {
    const xs = mask.path.vertices.map((vertex) => vertex.x);
    const ys = mask.path.vertices.map((vertex) => vertex.y);
    return {
      width: Math.round(Math.max(...xs) - Math.min(...xs)),
      height: Math.round(Math.max(...ys) - Math.min(...ys))
    };
  });
  // One is the 600x400 card, the other the 200x100 inner frame — the intersection is what clips.
  assert.ok(extents.some((extent) => extent.width === 600 && extent.height === 400));
  assert.ok(extents.some((extent) => extent.width === 200 && extent.height === 100));

  // Measured in the label's own space: the inner frame is at (200,200) and the label at (210,210),
  // so the inner clip starts 10 units before the label in both axes.
  const inner = label.masks.find((mask) => mask.path.vertices.some((vertex) => Math.round(vertex.x) === -10));
  assert.ok(inner, `no mask starts at -10: ${JSON.stringify(label.masks.map((m) => m.path.vertices[0]))}`);
});

test("a container mask is restated through rotation, not merely offset", () => {
  // A container rotated 90° with a clip, and a child inside it. The clip in the child's space must
  // come back rotated: a translation-only implementation would put it in the wrong place entirely.
  const container = {
    id: "c1",
    name: "Turned",
    type: "group",
    x: 100,
    y: 100,
    zDepth: 0,
    zIndex: 0,
    layerId: "main",
    width: 200,
    height: 100,
    rotation: 90,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    anchor: { x: 0, y: 0 },
    opacity: 1,
    visible: true,
    locked: false,
    fill: "transparent",
    stroke: "transparent",
    strokeWidth: 0,
    bindings: {},
    materialSlots: {},
    childIds: ["c2"],
    masks: [{
      id: "m1",
      name: "clip",
      type: "bezier",
      path: {
        closed: true,
        vertices: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }],
        inTangents: Array.from({ length: 4 }, () => ({ x: 0, y: 0 })),
        outTangents: Array.from({ length: 4 }, () => ({ x: 0, y: 0 }))
      },
      mode: "add",
      inverted: false,
      opacity: 1,
      feather: { x: 0, y: 0 },
      expansion: 0,
      visible: true,
      locked: false
    }]
  };
  const child = { ...container, id: "c2", name: "Inside", type: "rect", x: 0, y: 0, rotation: 0, childIds: undefined, masks: [], radius: 0 };
  delete child.childIds;

  const resolution = resolveSceneObjectHierarchy([container, child]);
  const drawn = resolution.renderableObjects.find((object) => object.name === "Inside");
  assert.equal(drawn.masks.length, 1);

  // The child inherits the container's 90° rotation, so in the child's own (also rotated) space the
  // clip is back to an axis-aligned 200x100 box at the origin.
  const xs = drawn.masks[0].path.vertices.map((vertex) => Math.round(vertex.x));
  const ys = drawn.masks[0].path.vertices.map((vertex) => Math.round(vertex.y));
  assert.deepEqual([Math.min(...xs), Math.max(...xs)], [0, 200]);
  assert.deepEqual([Math.min(...ys), Math.max(...ys)], [0, 100]);
});

test("an object's own masks survive alongside an inherited clip, and stay last", () => {
  const { scene } = importClipScene();
  const withOwnMask = scene.objects.map((object) =>
    object.name === "Overflowing Photo"
      ? {
          ...object,
          masks: [{
            id: "own",
            name: "authored",
            type: "bezier",
            path: { closed: true, vertices: [{ x: 1, y: 1 }], inTangents: [{ x: 0, y: 0 }], outTangents: [{ x: 0, y: 0 }] },
            mode: "add",
            inverted: false,
            opacity: 1,
            feather: { x: 0, y: 0 },
            expansion: 0,
            visible: true,
            locked: false
          }]
        }
      : object
  );

  const resolution = resolveSceneObjectHierarchy(withOwnMask);
  const photo = resolution.renderableObjects.find((object) => object.name === "Overflowing Photo");
  assert.equal(photo.masks.length, 2);
  assert.equal(photo.masks.at(-1).name, "authored", "the authored mask is the one an author edits, so it is last");
});

test("the report explains the clip composition rather than leaving it implicit", () => {
  const { report } = importClipScene();
  const lines = report.issues.map((issue) => issue.message);
  assert.ok(lines.some((line) => line.includes("Card clips its contents") && line.includes("clip composition")));
  assert.equal(report.counts.clippedContainers, 2, "the outer card and the inner frame");
});

/**
 * A board whose outlines come back in a space of their own.
 *
 * This is a real file, not a hypothetical: `geometry=paths` returned every outline around x=14590
 * whatever the layer's position, while the layers themselves were at sensible offsets. Subtracting a
 * node's absolute position — the obvious localisation, and what the importer used to do — left the
 * board's clip outline ten thousand pixels off the canvas, so the clip masked away every layer it
 * contained and the scene rendered completely transparent.
 */
function foreignOriginDocument() {
  const outline = (x, y, width, height) =>
    [{ path: `M${x} ${y}L${x + width} ${y}L${x + width} ${y + height}L${x} ${y + height}Z` }];

  return {
    name: "Foreign Origin",
    document: {
      id: "0:0",
      name: "Foreign Origin",
      type: "DOCUMENT",
      children: [{
        id: "0:1",
        name: "Board",
        type: "CANVAS",
        children: [{
          id: "1:1",
          name: "Card",
          type: "FRAME",
          // The layer's real place in the file.
          absoluteBoundingBox: { x: 10250, y: -7589, width: 1920, height: 1080 },
          size: { x: 1920, y: 1080 },
          clipsContent: true,
          cornerRadius: 24,
          fills: [{ type: "SOLID", color: { r: 0.1, g: 0.1, b: 0.2, a: 1 } }],
          // The outline's place in whatever space the source chose: nowhere near it.
          fillGeometry: outline(14590, 3120, 1920, 1080),
          children: [{
            id: "1:2",
            name: "Vector",
            type: "VECTOR",
            absoluteBoundingBox: { x: 10250, y: -7589, width: 1920, height: 1080 },
            size: { x: 1920, y: 1080 },
            fillGeometry: outline(14590, 3120, 1920, 1080)
          }]
        }]
      }]
    }
  };
}

test("geometry that arrives in a foreign coordinate space is localised to the node", () => {
  const report = createDesignImportReport("figma-json", "foreign.json");
  const document = normalizeDesignDocument(
    importFigmaDocument(foreignOriginDocument(), "foreign.json", report, "figma-json"),
    DEFAULT_DESIGN_IMPORT_OPTIONS,
    report
  );
  const [scene] = convertDesignDocumentToScenes(document, DEFAULT_DESIGN_IMPORT_OPTIONS, report);

  const shape = scene.objects.find((object) => object.name === "Card clip shape");
  const xs = shape.path.vertices.map((vertex) => vertex.x);
  const ys = shape.path.vertices.map((vertex) => vertex.y);
  assert.equal(Math.round(Math.min(...xs)), 0, "the clip outline starts at the node's own origin");
  assert.equal(Math.round(Math.min(...ys)), 0);
  assert.equal(Math.round(Math.max(...xs)), 1920, "and keeps the shape the source drew");
  assert.equal(Math.round(Math.max(...ys)), 1080);

  // A vector layer gets the same treatment, so artwork lands on the canvas rather than beside it.
  const vector = scene.objects.find((object) => object.name === "Vector");
  assert.equal(Math.round(Math.min(...vector.path.vertices.map((vertex) => vertex.x))), 0);

  // And the consequence that made this fatal: the inherited clip must cover what it clips.
  const resolution = resolveSceneObjectHierarchy(scene.objects);
  const drawn = resolution.renderableObjects.find((object) => object.name === "Vector");
  assert.equal(drawn.masks.length, 1);
  const maskXs = drawn.masks[0].path.vertices.map((vertex) => vertex.x);
  const maskYs = drawn.masks[0].path.vertices.map((vertex) => vertex.y);
  assert.ok(
    Math.min(...maskXs) <= 0 && Math.max(...maskXs) >= drawn.width - 1,
    `the clip does not cover the object it clips: x ${Math.round(Math.min(...maskXs))}..${Math.round(Math.max(...maskXs))} for a ${drawn.width}-wide layer`
  );
  assert.ok(Math.min(...maskYs) <= 0 && Math.max(...maskYs) >= drawn.height - 1);
});
