import {
  createDesignNode,
  type DesignIR
} from "@grapix/design-ir";
import assert from "node:assert/strict";
import { test } from "node:test";
import { persistDesignAssets, readDesignAsset } from "../assetStore.js";
import { createApiServer } from "../index.js";

/**
 * Asset persistence.
 *
 * Neither Figma front-end hands back a source that can be stored as-is: REST returns
 * short-lived signed S3 URLs, the plugin returns base64 data URIs. Both have to become
 * local files before the design is written, or a stored DesignIR rots (REST) or bloats
 * (plugin).
 */

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

function designWithAsset(source: string, designId = "design_test_assets"): DesignIR {
  return {
    designId,
    source: "figma",
    sourceRef: "showfile01#1:1",
    sourceRevision: "rev1",
    sourceFileName: "Show Graphics",
    importedAt: new Date().toISOString(),
    importerVersion: "test",
    canvas: { width: 1920, height: 1080 },
    root: createDesignNode({ nodeId: "root", sourcePath: "", name: "root", kind: "frame" }),
    assets: [
      {
        assetId: "asset_logo",
        name: "logo",
        kind: "image",
        mimeType: "image/png",
        source
      }
    ],
    fonts: [],
    warnings: []
  };
}

test("a plugin data URI becomes a local file and leaves the design JSON small", async () => {
  const design = designWithAsset(`data:image/png;base64,${PNG_BASE64}`, "design_datauri_test");
  const result = await persistDesignAssets(design);

  assert.equal(result.stored, 1);
  assert.equal(result.failed.length, 0);

  const asset = result.design.assets[0];
  assert.equal(asset.source, "/api/designs/design_datauri_test/assets/asset_logo.png");
  assert.ok(asset.sizeBytes && asset.sizeBytes > 0);
  assert.ok(!JSON.stringify(result.design).includes(PNG_BASE64), "bytes must not stay inline");

  const served = await readDesignAsset("design_datauri_test", "asset_logo.png");
  assert.ok(served, "the stored file is readable back");
  assert.equal(served.mimeType, "image/png");
  assert.equal(served.bytes.toString("base64"), PNG_BASE64);
});

test("an expiring REST url is downloaded once and rewritten to a local source", async () => {
  const bytes = Buffer.from(PNG_BASE64, "base64");
  let calls = 0;

  const fetchImpl = (async () => {
    calls += 1;

    return new Response(bytes, {
      status: 200,
      headers: { "content-type": "image/png" }
    });
  }) as unknown as typeof fetch;

  const design = designWithAsset(
    "https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/abc?expires=soon",
    "design_resturl_test"
  );
  const result = await persistDesignAssets(design, { fetchImpl });

  assert.equal(calls, 1);
  assert.equal(result.stored, 1);
  assert.equal(
    result.design.assets[0].source,
    "/api/designs/design_resturl_test/assets/asset_logo.png"
  );
  assert.ok(!result.design.assets[0].source.includes("amazonaws"), "the expiring url is gone");
});

test("an asset that cannot be fetched warns and keeps its original source", async () => {
  const fetchImpl = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
  const originalSource = "https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/gone";
  const result = await persistDesignAssets(designWithAsset(originalSource, "design_failed_test"), {
    fetchImpl
  });

  assert.equal(result.stored, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.design.assets[0].source, originalSource, "source is preserved, not lost");

  const warning = result.design.warnings.find((entry) => entry.code === "ASSET_NOT_STORED");
  assert.ok(warning, "the failure is reported, not swallowed");
  assert.equal(warning.severity, "warning");
});

test("asset file names cannot escape the design directory", async () => {
  for (const attempt of ["../../../package.json", "..\\..\\secrets.json", "../assets/x.png"]) {
    assert.equal(
      await readDesignAsset("design_datauri_test", attempt),
      null,
      `traversal attempt must be refused: ${attempt}`
    );
  }
});

test("re-importing the same file returns a reviewable diff", async () => {
  const app = await createApiServer({ logger: false });

  try {
    const payload = (version: string, includeScorer: boolean) => ({
      origin: "plugin" as const,
      fileKey: "difffile01",
      fileName: "Diff Test",
      version,
      nodes: [
        {
          id: "1:1",
          name: "Lower Third",
          type: "FRAME",
          size: { x: 1920, y: 1080 },
          children: [
            {
              id: "1:2",
              name: "Bar",
              type: "RECTANGLE",
              size: { x: 960, y: 120 },
              fills: [{ type: "SOLID", color: { r: 0.1, g: 0.8, b: 0.9, a: 1 } }]
            },
            ...(includeScorer
              ? [
                  {
                    id: "1:3",
                    name: "Scorer {{scorer.name}}",
                    type: "TEXT",
                    size: { x: 880, y: 70 },
                    characters: "MAYA CHEN"
                  }
                ]
              : [])
          ]
        }
      ]
    });

    const first = await app.inject({
      method: "POST",
      url: "/api/imports/figma/plugin",
      payload: payload("v1", true)
    });
    assert.equal(first.statusCode, 200);
    const firstBody = JSON.parse(first.body) as { diff: unknown; design: { designId: string } };
    assert.equal(firstBody.diff, null, "a first import has nothing to diff against");

    // Same file, new revision, with the text layer deleted.
    const second = await app.inject({
      method: "POST",
      url: "/api/imports/figma/plugin",
      payload: payload("v2", false)
    });
    assert.equal(second.statusCode, 200);

    const secondBody = JSON.parse(second.body) as {
      needsReview: boolean;
      design: { designId: string };
      diff: {
        summary: { removed: number; matched: number; added: number };
        removed: Array<{ nodeId: string }>;
      };
    };

    assert.ok(secondBody.diff, "a re-import is diffed against the previous one");
    assert.equal(secondBody.diff.summary.removed, 1);
    assert.equal(secondBody.diff.removed[0].nodeId, "fig:1:3");
    assert.equal(secondBody.needsReview, true, "a removal must not apply unattended");

    // The diff is also addressable after the fact.
    const viaEndpoint = await app.inject({
      method: "GET",
      url: `/api/designs/${secondBody.design.designId}/diff`
    });
    assert.equal(viaEndpoint.statusCode, 200);
    assert.equal(
      (JSON.parse(viaEndpoint.body) as { diff: { summary: { removed: number } } }).diff.summary.removed,
      1
    );

    await app.inject({ method: "DELETE", url: `/api/designs/${firstBody.design.designId}` });
    await app.inject({ method: "DELETE", url: `/api/designs/${secondBody.design.designId}` });
  } finally {
    await app.close();
  }
});

test("figma auto-layout, constraints and component identity survive the import", async () => {
  const app = await createApiServer({ logger: false });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/imports/figma/plugin",
      payload: {
        origin: "plugin",
        fileKey: "layoutfile01",
        fileName: "Layout Test",
        version: "v1",
        nodes: [
          {
            id: "2:1",
            name: "Row",
            type: "FRAME",
            size: { x: 800, y: 100 },
            layoutMode: "HORIZONTAL",
            primaryAxisAlignItems: "SPACE_BETWEEN",
            counterAxisAlignItems: "CENTER",
            primaryAxisSizingMode: "AUTO",
            counterAxisSizingMode: "FIXED",
            itemSpacing: 16,
            paddingTop: 8,
            paddingRight: 24,
            paddingBottom: 8,
            paddingLeft: 24,
            constraints: { horizontal: "STRETCH", vertical: "MAX" },
            children: [
              {
                id: "2:2",
                name: "Badge",
                type: "INSTANCE",
                componentId: "C:99",
                pluginComponentName: "Team Badge",
                size: { x: 64, y: 64 }
              }
            ]
          }
        ]
      }
    });

    assert.equal(response.statusCode, 200);
    const designId = (JSON.parse(response.body) as { design: { designId: string } }).design.designId;

    const stored = await app.inject({ method: "GET", url: `/api/designs/${designId}` });
    const design = (JSON.parse(stored.body) as { design: DesignIR }).design;
    const row = design.root.children[0];

    assert.equal(row.autoLayout?.axis, "horizontal");
    assert.equal(row.autoLayout?.primaryAlign, "space-between");
    assert.equal(row.autoLayout?.counterAlign, "center");
    assert.equal(row.autoLayout?.primarySizing, "hug");
    assert.equal(row.autoLayout?.itemSpacing, 16);
    assert.deepEqual(row.autoLayout?.padding, { top: 8, right: 24, bottom: 8, left: 24 });
    assert.equal(row.constraints?.horizontal, "stretch");
    assert.equal(row.constraints?.vertical, "max");

    const badge = row.children[0];
    assert.equal(badge.componentRef?.componentId, "C:99");
    assert.equal(badge.componentRef?.componentName, "Team Badge");
    assert.equal(badge.componentRef?.isInstance, true);

    await app.inject({ method: "DELETE", url: `/api/designs/${designId}` });
  } finally {
    await app.close();
  }
});
