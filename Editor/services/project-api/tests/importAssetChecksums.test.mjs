import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { writePsd } from "ag-psd";

/**
 * The render engine registers assets by SHA-256 and refuses a scene carrying one
 * without it: `engineController.syncAssets` throws "asset <id> has no checksum and
 * cannot be sent to the render engine". A design import must therefore emit the
 * checksum of every asset it stored, and must not present an unstored external
 * reference as READY.
 */
async function withImportManager(run) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "grapix-import-checksum-"));
  process.env.GRAPIX_DATA_ROOT = dataRoot;
  const { DesignImportManager } = await import(`../dist/importers/design/designImportManager.js?root=${encodeURIComponent(dataRoot)}`);
  try {
    await run(new DesignImportManager());
  } finally {
    delete process.env.GRAPIX_DATA_ROOT;
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function psdWithRaster() {
  const pixels = new Uint8ClampedArray(16 * 16 * 4).fill(160);
  return Buffer.from(writePsd({
    width: 320,
    height: 180,
    children: [{
      name: "Plate",
      top: 10,
      left: 10,
      bottom: 26,
      right: 26,
      imageData: { width: 16, height: 16, data: pixels }
    }]
  }, { generateThumbnail: false }));
}

test("every stored import asset carries the checksum the engine registers by", async () => {
  await withImportManager(async (manager) => {
    const result = await manager.importFile(psdWithRaster(), "checksum.psd");
    const [scene] = result.scenes;

    assert.ok(scene.assets.length >= 1, "the extracted raster is in the scene library");
    for (const asset of scene.assets) {
      assert.match(asset.assetId, /^asset_[0-9a-f]{20}$/, `${asset.name} must have a stored asset id`);
      assert.match(asset.checksum, /^[0-9a-f]{64}$/, `${asset.name} must carry a sha256`);
      assert.ok(asset.sizeBytes > 0, `${asset.name} must carry its byte size`);
      assert.equal(asset.status, "READY");
      // The id is the checksum prefix, so the two must agree.
      assert.ok(asset.checksum.startsWith(asset.assetId.replace("asset_", "")));
    }

    // The authoring source is provenance: stored and referenced, never shipped to the
    // engine as scene content.
    assert.ok(scene.assets.every((asset) => asset.kind !== "source"));
    assert.deepEqual(
      scene.dataContext.__designImport.sourceAssetIds,
      result.document.assets.filter((asset) => asset.kind === "source").map((asset) => asset.id)
    );
    assert.equal(scene.dataContext.__designImport.sourceAssetIds.length, 1);
  });
});

test("an asset that never reached storage is MISSING and reported, not a READY entry that fails at Take", async () => {
  await withImportManager(async (manager) => {
    // `link` mode keeps remote references instead of downloading them, so nothing is
    // stored for the image fill and the engine could never register it.
    const figmaJson = Buffer.from(JSON.stringify({
      name: "Linked",
      document: {
        id: "0:0",
        type: "DOCUMENT",
        children: [{
          id: "0:1",
          name: "Page 1",
          type: "CANVAS",
          children: [{
            id: "1:1",
            name: "Hero",
            type: "RECTANGLE",
            absoluteBoundingBox: { x: 0, y: 0, width: 1920, height: 1080 },
            fills: [{ type: "IMAGE", visible: true, imageRef: "7268045ea106bfcc05545cff9c8b923afec3bb73" }]
          }]
        }]
      }
    }));

    const result = await manager.importFile(figmaJson, "linked.figma.json", { assetMode: "link" });
    const [scene] = result.scenes;
    const fill = scene.assets.find((asset) => asset.assetId.startsWith("figma-image-"));

    assert.ok(fill, "the unresolved fill is still listed for the author");
    assert.equal(fill.checksum, undefined);
    assert.equal(fill.status, "MISSING", "an asset with no checksum may not claim READY");

    // The report names it, so the failure is visible at import instead of at Take.
    assert.ok(
      result.report.missingLinkedAssets.some((name) => name.includes("Hero")) ||
      result.report.warnings.some((message) => message.includes("checksum")),
      "the import must report the asset the engine cannot register"
    );

    // Every asset that IS ready carries a checksum: that is the engine's precondition.
    for (const asset of scene.assets.filter((entry) => entry.status === "READY")) {
      assert.match(asset.checksum, /^[0-9a-f]{64}$/);
    }
  });
});
