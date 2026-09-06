import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_DESIGN_IMPORT_OPTIONS } from "@grapix/shared-types";
import { normalizeDesignDocument } from "../dist/importers/design/designDocumentNormalizer.js";
import { importFigmaDocument } from "../dist/importers/design/figmaImporter.js";
import { convertDesignDocumentToScenes } from "../dist/importers/design/grapixObjectConverter.js";
import { createDesignImportReport } from "../dist/importers/design/importReport.js";
import { parseSvgPathData } from "../dist/importers/design/svgPath.js";

/**
 * Two ways an import can look wrong while reporting success.
 *
 * **Geometry.** A vector is only imported if its curves, its subpaths and its seam all survive. A
 * source writes the closing segment explicitly and then closes (`M a … L a Z`), so a naive parse
 * gains a duplicate anchor at the seam — and when that last segment is a curve, its incoming handle
 * lands on the duplicate instead of on the anchor the curve arrives at, which draws the seam of a
 * rounded shape straight. A real 66-layer file had this on 116 of its 117 paths.
 *
 * **Text.** Case and decoration are how a source *draws* text, not what it stores: a layer typed
 * "mvp" with Figma's `textCase: UPPER` reads MVP on the canvas. Importing only `characters` gives a
 * document that looks right in an inspector and wrong on air, with nothing left to recover the case
 * from.
 */

test("a closed path keeps its seam as one anchor, not two", () => {
  // A square written the way Figma writes it: the closing edge is explicit, then `Z`.
  const [square] = parseSvgPathData("M0 0L100 0L100 100L0 100L0 0Z");

  assert.equal(square.closed, true);
  assert.equal(square.vertices.length, 4, "four corners, not five");
  assert.deepEqual(square.vertices.at(-1), { x: 0, y: 100 }, "the last anchor is the last corner");
  assert.equal(square.inTangents.length, 4);
  assert.equal(square.outTangents.length, 4);
});

test("a curve arriving at the seam keeps its handle, so the shape closes round", () => {
  // A circle-ish shape: four cubics, the last returning to the start point.
  const [round] = parseSvgPathData(
    "M50 0C78 0 100 22 100 50C100 78 78 100 50 100C22 100 0 78 0 50C0 22 22 0 50 0Z"
  );

  assert.equal(round.vertices.length, 4, "four anchors: the closing curve lands on the first");
  // The handle that the final curve arrives with belongs to the anchor it arrives at.
  assert.ok(
    Math.abs(round.inTangents[0].x) > 1 || Math.abs(round.inTangents[0].y) > 1,
    `the seam handle was lost: ${JSON.stringify(round.inTangents[0])}`
  );
  // And it points back along the curve — leftwards from (50,0), the way it came.
  assert.ok(round.inTangents[0].x < 0, `expected the handle to point back: ${JSON.stringify(round.inTangents[0])}`);
});

test("an open path is left alone even when its ends happen to touch", () => {
  const [open] = parseSvgPathData("M0 0L100 0L0 0");
  assert.equal(open.closed, false);
  assert.equal(open.vertices.length, 3, "nothing is merged on a path that never closed");
});

test("every subpath of a compound path survives to the scene", () => {
  // A ring: outer square, inner square. The inner one is the hole.
  const document = {
    name: "Ring",
    document: {
      id: "0:0",
      name: "Ring",
      type: "DOCUMENT",
      children: [{
        id: "0:1",
        name: "Page",
        type: "CANVAS",
        children: [{
          id: "1:1",
          name: "Ring",
          type: "VECTOR",
          absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
          size: { x: 100, y: 100 },
          fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
          fillGeometry: [{
            path: "M0 0L100 0L100 100L0 100L0 0ZM25 25L75 25L75 75L25 75L25 25Z",
            windingRule: "EVENODD"
          }]
        }]
      }]
    }
  };

  const report = createDesignImportReport("figma-json", "ring.json");
  const normalized = normalizeDesignDocument(
    importFigmaDocument(document, "ring.json", report, "figma-json"),
    DEFAULT_DESIGN_IMPORT_OPTIONS,
    report
  );
  const [scene] = convertDesignDocumentToScenes(normalized, DEFAULT_DESIGN_IMPORT_OPTIONS, report);
  const ring = scene.objects.find((object) => object.name === "Ring" && object.type === "shape");

  assert.ok(ring, "the vector reached the scene as a shape");
  assert.equal(ring.compoundPaths?.length, 1, "the hole is a subpath, not a second object");
  assert.equal(ring.path.vertices.length, 4, "outer square");
  assert.equal(ring.compoundPaths[0].vertices.length, 4, "inner square");

  // The hole is inside the outer ring, which is what makes it a hole rather than a shape beside it.
  const outerX = ring.path.vertices.map((vertex) => vertex.x);
  const innerX = ring.compoundPaths[0].vertices.map((vertex) => vertex.x);
  assert.ok(Math.min(...innerX) > Math.min(...outerX) && Math.max(...innerX) < Math.max(...outerX));
});

/** A Figma text node with the case and decoration a designer set. */
function textDocument(style) {
  return {
    name: "Type",
    document: {
      id: "0:0",
      name: "Type",
      type: "DOCUMENT",
      children: [{
        id: "0:1",
        name: "Page",
        type: "CANVAS",
        children: [{
          id: "1:1",
          name: "Headline",
          type: "TEXT",
          absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 80 },
          size: { x: 400, y: 80 },
          characters: "mvp of the match",
          fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
          style: { fontFamily: "Inter", fontSize: 48, fontWeight: 700, ...style }
        }]
      }]
    }
  };
}

function importText(style) {
  const report = createDesignImportReport("figma-json", "type.json");
  const normalized = normalizeDesignDocument(
    importFigmaDocument(textDocument(style), "type.json", report, "figma-json"),
    DEFAULT_DESIGN_IMPORT_OPTIONS,
    report
  );
  const [scene] = convertDesignDocumentToScenes(normalized, DEFAULT_DESIGN_IMPORT_OPTIONS, report);
  return { scene, object: scene.objects.find((object) => object.type === "text"), report };
}

test("the case a designer applied is imported, and the characters are left as typed", () => {
  const { object } = importText({ textCase: "UPPER" });

  assert.equal(object.textCase, "upper", "the case travels");
  assert.equal(
    object.text,
    "mvp of the match",
    "and the characters do not: a binding can replace them and the case still applies"
  );
});

test("every Figma text case maps to something GrapiX draws", () => {
  const cases = {
    ORIGINAL: "original",
    UPPER: "upper",
    LOWER: "lower",
    TITLE: "title",
    SMALL_CAPS: "small-caps",
    SMALL_CAPS_FORCED: "small-caps"
  };
  for (const [figma, grapix] of Object.entries(cases)) {
    assert.equal(importText({ textCase: figma }).object.textCase, grapix, figma);
  }
  // An unknown value is not silently a transform: it is the text as typed.
  assert.equal(importText({ textCase: "SOMETHING_NEW" }).object.textCase, "original");
  assert.equal(importText({}).object.textCase, "original", "no case set means no case applied");
});

test("small caps says what it did, because it is an approximation", () => {
  const { object, report } = importText({ textCase: "SMALL_CAPS" });

  assert.equal(object.textCase, "small-caps");
  assert.ok(
    report.issues.some((issue) =>
      issue.sourceNodeName === "Headline" && /small caps/i.test(issue.message) && issue.fallback === "Upper case"),
    `no report line for small caps: ${JSON.stringify(report.issues.map((issue) => issue.message))}`
  );

  // And a case GrapiX reproduces exactly says nothing, so the report stays worth reading.
  assert.equal(
    importText({ textCase: "UPPER" }).report.issues.some((issue) => /small caps/i.test(issue.message)),
    false
  );
});

test("underline and strikethrough are imported, and absent when there are none", () => {
  assert.deepEqual(importText({ textDecoration: "UNDERLINE" }).object.textDecoration, { underline: true });
  assert.deepEqual(importText({ textDecoration: "STRIKETHROUGH" }).object.textDecoration, { strikethrough: true });
  assert.deepEqual(importText({}).object.textDecoration, {}, "nothing invented for plain text");
});

test("a rotated text layer keeps its rotation", () => {
  // The other reading of "text transforms": the layer's own transform.
  const report = createDesignImportReport("figma-json", "rot.json");
  const document = textDocument({});
  document.document.children[0].children[0].relativeTransform = [
    [Math.cos(-0.0955), -Math.sin(-0.0955), 10],
    [Math.sin(-0.0955), Math.cos(-0.0955), 20]
  ];
  const normalized = normalizeDesignDocument(
    importFigmaDocument(document, "rot.json", report, "figma-json"),
    DEFAULT_DESIGN_IMPORT_OPTIONS,
    report
  );
  const [scene] = convertDesignDocumentToScenes(normalized, DEFAULT_DESIGN_IMPORT_OPTIONS, report);
  const text = scene.objects.find((object) => object.type === "text");

  assert.ok(Math.abs(text.rotation - -5.47) < 0.1, `expected about -5.47 degrees, got ${text.rotation}`);
  assert.equal(text.width, 400, "and its own size, not the box its rotation sweeps");
});
