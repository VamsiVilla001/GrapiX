import { findDesignNode, parseDesignTokens, summarizeDesignIR, walkDesignNodes } from "@grapix/design-ir";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { importIllustrator } from "../illustrator-importer.js";
import { mapFigmaPayloadToDesignIR } from "../figma-mapper.js";
import { parseFigmaUrl, type FigmaImportPayload } from "../figma-payload.js";
import { importPsd } from "../psd-importer.js";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../test-fixtures");

const readFixture = async (name: string): Promise<Uint8Array> =>
  new Uint8Array(await readFile(path.join(fixtureDir, name)));

test("design tokens parse out of layer names", () => {
  const tokens = parseDesignTokens("Scorer {{scorer.name}} @fit #headline_slot");

  assert.deepEqual(
    tokens.map((token) => [token.kind, token.value]).sort(),
    [
      ["bind", "scorer.name"],
      ["fit", "shrink"],
      ["slot", "headline_slot"]
    ].sort()
  );

  const repeat = parseDesignTokens("Standings Row @repeat(table.rows) @variant(team=away)");
  assert.deepEqual(
    repeat.find((token) => token.kind === "repeat")?.value,
    "table.rows"
  );
  const variant = repeat.find((token) => token.kind === "variant");
  assert.equal(variant?.key, "team");
  assert.equal(variant?.value, "away");
});

test("figma urls yield a file key and node id", () => {
  assert.deepEqual(parseFigmaUrl("https://www.figma.com/design/abc123XYZ89/Show?node-id=12-34"), {
    fileKey: "abc123XYZ89",
    nodeIds: ["12:34"]
  });
  assert.deepEqual(parseFigmaUrl("abc123XYZ89"), { fileKey: "abc123XYZ89", nodeIds: [] });
  assert.equal(parseFigmaUrl("not a figma link"), null);
});

test("figma payload maps to DesignIR with stable ids and tokens", () => {
  const payload: FigmaImportPayload = {
    origin: "plugin",
    fileKey: "abc123XYZ89",
    fileName: "Match Graphics",
    version: "12345",
    clientVersion: "0.1.0",
    images: [{ imageRef: "img1", source: "data:image/png;base64,AA==" }],
    nodes: [
      {
        id: "1:2",
        name: "Lower Third",
        type: "FRAME",
        size: { x: 1920, y: 1080 },
        relativeTransform: [
          [1, 0, 0],
          [0, 1, 0]
        ],
        clipsContent: true,
        children: [
          {
            id: "1:3",
            name: "Bar",
            type: "RECTANGLE",
            size: { x: 960, y: 120 },
            relativeTransform: [
              [1, 0, 120],
              [0, 1, 820]
            ],
            cornerRadius: 8,
            fills: [{ type: "SOLID", color: { r: 0.13, g: 0.78, b: 0.85, a: 1 } }],
            strokes: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }],
            strokeWeight: 2,
            strokeAlign: "INSIDE"
          },
          {
            id: "1:4",
            name: "Scorer {{scorer.name}} @fit",
            type: "TEXT",
            size: { x: 880, y: 70 },
            characters: "MAYA CHEN",
            style: {
              fontFamily: "Inter",
              fontWeight: 700,
              fontSize: 48,
              textAlignHorizontal: "LEFT",
              textCase: "UPPER"
            },
            pluginTextSegments: [
              {
                characters: "MAYA CHEN",
                fontFamily: "Inter",
                fontStyle: "Bold",
                fontWeight: 700,
                fontSize: 48,
                letterSpacing: 0,
                lineHeight: 56,
                textCase: "UPPER",
                textDecoration: "NONE",
                fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1, a: 1 } }]
              }
            ]
          },
          {
            id: "1:5",
            name: "Sponsor",
            type: "RECTANGLE",
            size: { x: 320, y: 140 },
            fills: [{ type: "IMAGE", imageRef: "img1", scaleMode: "FILL" }]
          }
        ]
      }
    ]
  };

  const design = mapFigmaPayloadToDesignIR(payload);
  const summary = summarizeDesignIR(design);

  assert.equal(design.source, "figma");
  assert.equal(summary.nodeCount, 5, "root + frame + three children");
  assert.equal(summary.errorCount, 0);

  // Figma node ids are the identity anchor; that is the whole reason Figma is the reference source.
  const bar = findDesignNode(design.root, "fig:1:3");
  assert.ok(bar, "rectangle keeps its figma node id");
  assert.equal(bar.kind, "rectangle");
  assert.equal(bar.transform[4], 120);
  assert.equal(bar.transform[5], 820);
  assert.equal(bar.fills.length, 1);
  assert.equal(bar.strokes[0].weight, 2);
  assert.equal(bar.strokes[0].align, "inside");
  assert.equal(bar.geometry?.cornerRadius, 8);

  const text = findDesignNode(design.root, "fig:1:4");
  assert.ok(text);
  assert.equal(text.text?.plainText, "MAYA CHEN");
  assert.equal(text.text?.runs.length, 1);
  assert.equal(text.text?.runs[0].fontWeight, 700);
  assert.equal(text.text?.runs[0].textCase, "upper");
  assert.deepEqual(
    text.tokens.map((token) => token.kind).sort(),
    ["bind", "fit"]
  );
  assert.equal(text.displayName, "Scorer");

  const sponsor = findDesignNode(design.root, "fig:1:5");
  assert.ok(sponsor?.imageAssetId, "image fill resolves to an asset");
  assert.equal(design.assets.length, 1);

  // Fonts are collected for preflight and subsetting.
  assert.deepEqual(design.fonts.map((font) => font.family), ["Inter"]);
});

test("figma REST payload without geometry warns instead of failing", () => {
  const design = mapFigmaPayloadToDesignIR({
    origin: "rest",
    fileKey: "abc123XYZ89",
    fileName: "Rest Import",
    version: "1",
    nodes: [{ id: "2:1", name: "Badge", type: "VECTOR", size: { x: 10, y: 10 } }]
  });

  const codes = design.warnings.map((warning) => warning.code);
  assert.ok(codes.includes("FIGMA_GEOMETRY_MISSING"));
  assert.ok(codes.includes("FIGMA_REST_FALLBACK"));
  assert.equal(design.warnings.filter((warning) => warning.severity === "error").length, 0);
});

test("psd import keeps layer order, bounds, text and tokens", async () => {
  const design = importPsd({
    fileName: "lower-third.psd",
    data: await readFixture("lower-third.psd")
  });

  assert.equal(design.source, "psd");
  assert.deepEqual(design.canvas, { width: 1920, height: 1080 });

  // ag-psd yields children bottom-first, which is DesignIR paint order.
  assert.deepEqual(
    design.root.children.map((child) => child.displayName),
    ["Lower Third", "Sponsor"]
  );

  const group = design.root.children[0];
  assert.equal(group.kind, "group");
  assert.deepEqual(group.size, { width: 960, height: 120 });

  const bar = group.children.find((child) => child.name === "Bar");
  assert.ok(bar);
  assert.deepEqual(bar.size, { width: 960, height: 120 });
  assert.equal(bar.fills.length, 1);
  assert.ok((bar.fills[0].color?.g ?? 0) > 0.7, "cyan bar fill survives the import");

  const text = group.children.find((child) => child.kind === "text");
  assert.ok(text);
  assert.equal(text.text?.plainText, "MAYA CHEN");
  assert.equal(text.text?.runs[0].fontSize, 48);
  assert.deepEqual(text.tokens.map((token) => token.kind).sort(), ["bind", "fit"]);

  const sponsor = design.root.children[1];
  assert.equal(sponsor.blendMode, "multiply");
  assert.equal(sponsor.tokens[0].kind, "slot");
  assert.equal(sponsor.tokens[0].value, "sponsor_slot");
});

test("psd node ids are stable across identical imports", async () => {
  const data = await readFixture("lower-third.psd");
  const first = importPsd({ fileName: "lower-third.psd", data });
  const second = importPsd({ fileName: "lower-third.psd", data: new Uint8Array(data) });

  const ids = (design: typeof first): string[] => {
    const collected: string[] = [];
    walkDesignNodes(design.root, (node) => collected.push(node.nodeId));

    return collected;
  };

  assert.deepEqual(ids(first), ids(second), "re-import must reproduce the same node ids");
});

test("illustrator import recovers layer names, geometry and text", async () => {
  const design = await importIllustrator({
    fileName: "lower-third.pdf",
    data: await readFixture("lower-third.pdf")
  });

  assert.equal(design.source, "ai");
  assert.deepEqual(design.canvas, { width: 400, height: 200 });

  const artboard = design.root.children[0];
  assert.equal(artboard.name, "Artboard 1");

  // Illustrator layer names live in PDF optional content groups.
  const layerNames = artboard.children.map((child) => child.name);
  assert.deepEqual(layerNames, ["Background", "Headline {{scorer.name}} @fit"]);

  const headline = artboard.children[1];
  assert.deepEqual(headline.tokens.map((token) => token.kind).sort(), ["bind", "fit"]);
  assert.equal(headline.displayName, "Headline");

  const shape = artboard.children[0].children[0];
  assert.equal(shape.kind, "vector");
  // PDF is y-up: a rect at y=40 height 90 in a 200-tall page sits at design y=70.
  assert.equal(shape.transform[4], 40);
  assert.equal(shape.transform[5], 70);
  assert.deepEqual(shape.size, { width: 320, height: 90 });
  assert.ok(shape.geometry?.paths[0].startsWith("M "));

  const text = artboard.children[1].children[0];
  assert.equal(text.kind, "text");
  assert.equal(text.text?.plainText, "GrapiX Lower Third");
  assert.equal(text.transform[4], 48);

  assert.equal(design.warnings.filter((warning) => warning.severity === "error").length, 0);
});
