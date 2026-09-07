import { diffNeedsReview, reconcileDesigns, type DesignIR } from "@grapix/design-ir";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { mapFigmaPayloadToDesignIR } from "../figma-mapper.js";
import type { FigmaImportPayload, FigmaNodePayload } from "../figma-payload.js";
import { importPsd } from "../psd-importer.js";

/**
 * Re-import reconciliation — the behaviour that decides whether a rig survives a design
 * change. Figma is the reference case: stable node ids mean a rename plus a move plus a
 * restyle still matches with full confidence.
 */

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../test-fixtures");

function figmaDesign(version: string, children: FigmaNodePayload[]): DesignIR {
  const payload: FigmaImportPayload = {
    origin: "plugin",
    fileKey: "showfile01",
    fileName: "Show Graphics",
    version,
    nodes: [
      {
        id: "1:1",
        name: "Lower Third",
        type: "FRAME",
        size: { x: 1920, y: 1080 },
        relativeTransform: [
          [1, 0, 0],
          [0, 1, 0]
        ],
        children
      }
    ]
  };

  return mapFigmaPayloadToDesignIR(payload);
}

const bar = (overrides: Partial<FigmaNodePayload> = {}): FigmaNodePayload => ({
  id: "1:2",
  name: "Bar",
  type: "RECTANGLE",
  size: { x: 960, y: 120 },
  relativeTransform: [
    [1, 0, 120],
    [0, 1, 820]
  ],
  fills: [{ type: "SOLID", color: { r: 0.13, g: 0.78, b: 0.85, a: 1 } }],
  ...overrides
});

const scorer = (overrides: Partial<FigmaNodePayload> = {}): FigmaNodePayload => ({
  id: "1:3",
  name: "Scorer {{scorer.name}} @fit",
  type: "TEXT",
  size: { x: 880, y: 70 },
  characters: "MAYA CHEN",
  style: { fontFamily: "Inter", fontWeight: 700, fontSize: 48 },
  ...overrides
});

test("an unchanged re-import matches everything at full confidence", () => {
  const diff = reconcileDesigns(figmaDesign("1", [bar(), scorer()]), figmaDesign("2", [bar(), scorer()]));

  assert.equal(diff.summary.matched, 3, "frame plus two children");
  assert.equal(diff.summary.added, 0);
  assert.equal(diff.summary.removed, 0);
  assert.equal(diff.summary.changed, 0);
  assert.equal(diff.summary.byStrategy["source-node-id"], 3);
  assert.equal(diffNeedsReview(diff), false);
});

test("a renamed, moved and restyled node still matches on its figma node id", () => {
  const diff = reconcileDesigns(
    figmaDesign("1", [bar(), scorer()]),
    figmaDesign("2", [
      bar({
        name: "Accent Bar",
        relativeTransform: [
          [1, 0, 200],
          [0, 1, 700]
        ],
        fills: [{ type: "SOLID", color: { r: 1, g: 0.8, b: 0.1, a: 1 } }]
      }),
      scorer()
    ])
  );

  const match = diff.matched.find((entry) => entry.nodeId === "fig:1:2");

  assert.ok(match, "the rectangle matched despite the rename");
  assert.equal(match.strategy, "source-node-id");
  assert.equal(match.confidence, 1);
  assert.deepEqual(match.changes.sort(), ["moved", "restyled"]);
  // Nothing was lost, so a rig can be carried across this unattended.
  assert.equal(diffNeedsReview(diff), false);
});

test("a deleted node is reported as removed and forces review", () => {
  const diff = reconcileDesigns(figmaDesign("1", [bar(), scorer()]), figmaDesign("2", [bar()]));

  assert.equal(diff.summary.removed, 1);
  assert.equal(diff.removed[0].nodeId, "fig:1:3");
  assert.match(diff.removed[0].name, /Scorer/);
  // A rig pointing at that node would orphan, so this must not apply unattended.
  assert.equal(diffNeedsReview(diff), true);
});

test("a new node is reported as added without forcing review", () => {
  const diff = reconcileDesigns(
    figmaDesign("1", [bar()]),
    figmaDesign("2", [bar(), { id: "1:9", name: "Sponsor #sponsor_slot", type: "RECTANGLE", size: { x: 320, y: 140 } }])
  );

  assert.equal(diff.summary.added, 1);
  assert.equal(diff.added[0].nodeId, "fig:1:9");
  assert.equal(diff.summary.removed, 0);
  assert.equal(diffNeedsReview(diff), false);
});

test("text and token edits are detected separately", () => {
  const diff = reconcileDesigns(
    figmaDesign("1", [scorer()]),
    figmaDesign("2", [scorer({ characters: "SAM OKORO", name: "Scorer {{scorer.fullName}} @fit" })])
  );

  const match = diff.matched.find((entry) => entry.nodeId === "fig:1:3");

  assert.ok(match);
  assert.ok(match.changes.includes("text-changed"));
  assert.ok(match.changes.includes("tokens-changed"));
});

test("a retyped node is flagged rather than treated as add plus remove", () => {
  const diff = reconcileDesigns(
    figmaDesign("1", [bar()]),
    figmaDesign("2", [bar({ type: "ELLIPSE" })])
  );

  const match = diff.matched.find((entry) => entry.nodeId === "fig:1:2");

  assert.ok(match, "same id, so still the same node");
  assert.ok(match.changes.includes("retyped"));
  assert.equal(diff.summary.added, 0);
  assert.equal(diff.summary.removed, 0);
});

test("ambiguous names never match: two identical layers stay unmatched", () => {
  // Without stable ids, two layers called "Row" must not be paired arbitrarily — a wrong
  // match silently moves someone's rig onto the wrong element.
  const previous = figmaDesign("1", [
    { id: "1:4", name: "Row", type: "RECTANGLE", size: { x: 100, y: 20 } },
    { id: "1:5", name: "Row", type: "RECTANGLE", size: { x: 100, y: 20 } }
  ]);
  const next = figmaDesign("2", [
    { id: "9:4", name: "Row", type: "RECTANGLE", size: { x: 100, y: 20 } },
    { id: "9:5", name: "Row", type: "RECTANGLE", size: { x: 100, y: 20 } }
  ]);

  const diff = reconcileDesigns(previous, next);
  const rowMatches = diff.matched.filter((entry) => entry.sourcePath.endsWith("Row"));

  assert.equal(rowMatches.length, 0, "duplicate names must not be guessed at");
  assert.equal(diff.summary.removed, 2);
  assert.equal(diff.summary.added, 2);
  assert.equal(diffNeedsReview(diff), true);
});

test("psd re-import matches by layer path when ids are content-derived", async () => {
  const data = new Uint8Array(await readFile(path.join(fixtureDir, "lower-third.psd")));
  const first = importPsd({ fileName: "lower-third.psd", data });
  const second = importPsd({ fileName: "lower-third.psd", data: new Uint8Array(data) });

  const diff = reconcileDesigns(first, second);

  assert.equal(diff.summary.removed, 0);
  assert.equal(diff.summary.added, 0);
  assert.equal(diff.summary.changed, 0);
  // PSD has no native ids, so identity comes from GrapiX's own derived nodeId.
  assert.equal(diff.summary.byStrategy["node-id"], diff.summary.matched);
});
