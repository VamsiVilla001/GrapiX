import { findDesignNode } from "@grapix/design-ir";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mapFigmaPayloadToDesignIR } from "../figma-mapper.js";
import type { FigmaImportPayload, FigmaNodePayload } from "../figma-payload.js";

/**
 * Layer-style coverage through the REST shape. See docs/figma-coverage.md — these are the
 * fields that were being dropped, each of which visibly changes a design.
 */

function restPayload(node: FigmaNodePayload, styles?: FigmaImportPayload["styles"]): FigmaImportPayload {
  return {
    origin: "rest",
    fileKey: "stylefile01",
    fileName: "Style Coverage",
    version: "v1",
    nodes: [node],
    images: [{ imageRef: "img1", source: "https://example.invalid/img.png" }],
    styles
  };
}

test("image paint crop, tile, rotation and filters survive", () => {
  const design = mapFigmaPayloadToDesignIR(
    restPayload({
      id: "1:2",
      name: "Headshot",
      type: "RECTANGLE",
      size: { x: 400, y: 400 },
      fills: [
        {
          type: "IMAGE",
          imageRef: "img1",
          scaleMode: "TILE",
          scalingFactor: 0.5,
          rotation: 90,
          // Figma rows: [[a, c, e], [b, d, f]]
          imageTransform: [
            [2, 0, 0.25],
            [0, 2, 0.5]
          ],
          filters: { exposure: 0.3, contrast: -0.1 }
        }
      ]
    })
  );

  const paint = findDesignNode(design.root, "fig:1:2")?.fills[0];

  assert.ok(paint);
  assert.equal(paint.kind, "image");
  assert.equal(paint.scaleMode, "tile");
  assert.equal(paint.tileScale, 0.5);
  assert.equal(paint.rotation, 90);
  // Rows are flattened to [a, b, c, d, e, f].
  assert.deepEqual(paint.imageTransform, [2, 0, 0, 2, 0.25, 0.5]);
  assert.equal(paint.filters?.exposure, 0.3);
  assert.equal(paint.filters?.contrast, -0.1);
  assert.equal(paint.filters?.saturation, 0, "unspecified filters default to neutral");
});

test("an all-neutral filter set is dropped rather than stored", () => {
  const design = mapFigmaPayloadToDesignIR(
    restPayload({
      id: "1:3",
      name: "Plain",
      type: "RECTANGLE",
      size: { x: 10, y: 10 },
      fills: [{ type: "IMAGE", imageRef: "img1", filters: { exposure: 0, contrast: 0 } }]
    })
  );

  assert.equal(findDesignNode(design.root, "fig:1:3")?.fills[0].filters, undefined);
});

test("per-side stroke weights are recorded only when the sides differ", () => {
  const uneven = mapFigmaPayloadToDesignIR(
    restPayload({
      id: "1:4",
      name: "Rule",
      type: "RECTANGLE",
      size: { x: 200, y: 40 },
      strokes: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
      strokeWeight: 0,
      individualStrokeWeights: { top: 0, right: 0, bottom: 4, left: 0 },
      strokeMiterAngle: 30
    })
  );

  const stroke = findDesignNode(uneven.root, "fig:1:4")?.strokes[0];
  assert.deepEqual(stroke?.individualWeights, { top: 0, right: 0, bottom: 4, left: 0 });
  assert.equal(stroke?.miterAngle, 30);

  const even = mapFigmaPayloadToDesignIR(
    restPayload({
      id: "1:5",
      name: "Box",
      type: "RECTANGLE",
      size: { x: 200, y: 40 },
      strokes: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
      strokeWeight: 2,
      individualStrokeWeights: { top: 2, right: 2, bottom: 2, left: 2 }
    })
  );

  assert.equal(
    findDesignNode(even.root, "fig:1:5")?.strokes[0].individualWeights,
    undefined,
    "uniform sides add nothing over strokeWeight"
  );
});

test("a luminance mask is recorded and warned about", () => {
  const design = mapFigmaPayloadToDesignIR(
    restPayload({
      id: "1:6",
      name: "Fade",
      type: "RECTANGLE",
      size: { x: 400, y: 100 },
      isMask: true,
      maskType: "LUMINANCE"
    })
  );

  const node = findDesignNode(design.root, "fig:1:6");
  assert.equal(node?.isMask, true);
  assert.equal(node?.maskType, "luminance");
  // Compositing by alpha instead of luminance would silently change the fade.
  assert.ok(design.warnings.some((warning) => warning.code === "FIGMA_LUMINANCE_MASK"));
});

test("a mask with no maskType defaults to alpha, and a non-mask records none", () => {
  const design = mapFigmaPayloadToDesignIR(
    restPayload({
      id: "1:7",
      name: "Clip",
      type: "RECTANGLE",
      size: { x: 10, y: 10 },
      isMask: true,
      children: [{ id: "1:8", name: "Plain", type: "RECTANGLE", size: { x: 5, y: 5 } }]
    })
  );

  assert.equal(findDesignNode(design.root, "fig:1:7")?.maskType, "alpha");
  assert.equal(findDesignNode(design.root, "fig:1:8")?.maskType, undefined);
});

test("shared styles are linked by id and collected into a table", () => {
  const design = mapFigmaPayloadToDesignIR(
    restPayload(
      {
        id: "1:9",
        name: "Brand Bar",
        type: "RECTANGLE",
        size: { x: 100, y: 20 },
        styles: { fill: "S:brandfill", effect: "S:brandshadow" }
      },
      {
        "S:brandfill": { name: "Brand/Cyan", styleType: "FILL", key: "abc" },
        "S:brandshadow": { name: "Brand/Shadow", styleType: "EFFECT" }
      }
    )
  );

  const node = findDesignNode(design.root, "fig:1:9");

  assert.equal(node?.styleRefs?.fill, "S:brandfill");
  assert.equal(node?.styleRefs?.effect, "S:brandshadow");
  assert.equal(design.sharedStyles["S:brandfill"].name, "Brand/Cyan");
  assert.equal(design.sharedStyles["S:brandfill"].styleType, "FILL");
  assert.equal(design.sharedStyles["S:brandshadow"].styleType, "EFFECT");
});

test("a referenced style missing from the payload warns instead of vanishing", () => {
  const design = mapFigmaPayloadToDesignIR(
    restPayload({
      id: "1:10",
      name: "Orphan Style",
      type: "RECTANGLE",
      size: { x: 10, y: 10 },
      fills: [{ type: "SOLID", color: { r: 1, g: 0, b: 0, a: 1 } }],
      styles: { fill: "S:gone" }
    })
  );

  const node = findDesignNode(design.root, "fig:1:10");

  // The node still renders from its resolved values; only the style link is lost.
  assert.equal(node?.fills.length, 1);
  assert.equal(node?.styleRefs?.fill, "S:gone");
  assert.equal(design.sharedStyles["S:gone"], undefined);
  assert.ok(design.warnings.some((warning) => warning.code === "FIGMA_STYLE_NOT_RESOLVED"));
});

test("variable bindings are flattened to property -> id", () => {
  const design = mapFigmaPayloadToDesignIR(
    restPayload({
      id: "1:11",
      name: "Themed",
      type: "RECTANGLE",
      size: { x: 10, y: 10 },
      boundVariables: {
        fills: [{ type: "VARIABLE_ALIAS", id: "VariableID:1:100" }],
        itemSpacing: { type: "VARIABLE_ALIAS", id: "VariableID:1:200" }
      }
    })
  );

  const refs = findDesignNode(design.root, "fig:1:11")?.variableRefs;

  assert.equal(refs?.fills, "VariableID:1:100");
  assert.equal(refs?.itemSpacing, "VariableID:1:200");
});

test("render bounds, shadow-behind and text truncation are carried", () => {
  const design = mapFigmaPayloadToDesignIR(
    restPayload({
      id: "1:12",
      name: "Shadowed",
      type: "TEXT",
      size: { x: 200, y: 50 },
      characters: "MAYA CHEN",
      absoluteRenderBounds: { x: -4, y: -4, width: 208, height: 58 },
      effects: [
        {
          type: "DROP_SHADOW",
          radius: 8,
          color: { r: 0, g: 0, b: 0, a: 0.5 },
          showShadowBehindNode: false
        }
      ],
      style: {
        fontFamily: "Inter",
        fontPostScriptName: "Inter-Bold",
        fontWeight: 700,
        fontSize: 40,
        textTruncation: "ENDING",
        maxLines: 2
      }
    })
  );

  const node = findDesignNode(design.root, "fig:1:12");

  // Render bounds include the shadow bleed that absoluteBoundingBox excludes.
  assert.deepEqual(node?.renderBounds, { x: -4, y: -4, width: 208, height: 58 });
  assert.equal(node?.effects[0].showBehindNode, false);
  assert.equal(node?.text?.layout.truncation, "ending");
  assert.equal(node?.text?.layout.maxLines, 2);
  assert.equal(node?.text?.runs[0].fontPostScriptName, "Inter-Bold");
});
