import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

/**
 * A design import extracts one set of bytes once per referencing layer, so a
 * Photoshop file that reuses a texture hands the store several assets with the
 * same content. Content addressing turns those into one target path, and the
 * writes run concurrently: `Promise.all` over `document.assets`.
 *
 * Before the per-path write queue, the second concurrent `rename` onto that
 * shared path failed on Windows with `EPERM`, which the importer surfaced as
 * "Asset X could not be embedded" and left the layer pointing at an inline data
 * URL instead of a stored asset.
 */
test("concurrent writes of identical asset bytes store the asset once", async () => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), "grapix-asset-store-"));
  process.env.GRAPIX_DATA_ROOT = dataRoot;
  const { importAssetBuffer } = await import(`../dist/storage.js?root=${encodeURIComponent(dataRoot)}`);

  try {
    const bytes = Buffer.from("shared texture bytes");
    const names = ["Texture.png", "Texture copy.png", "Texture copy 2.png", "Texture copy 3.png"];
    const records = await Promise.all(
      names.map((name) => importAssetBuffer(bytes, name, "image/png"))
    );

    const ids = new Set(records.map((record) => record.assetId));
    assert.equal(ids.size, 1, "identical bytes must resolve to one content-addressed asset");
    const [assetId] = [...ids];

    const stored = await readdir(path.join(dataRoot, "assets", "images"));
    assert.deepEqual(stored, [`${assetId}.png`], "no temporary files may survive the writes");
    assert.equal(await readFile(path.join(dataRoot, "assets", "images", `${assetId}.png`), "utf8"), "shared texture bytes");

    const index = JSON.parse(await readFile(path.join(dataRoot, "assets", "index", `${assetId}.json`), "utf8"));
    assert.equal(index.assetId, assetId);
    assert.equal(index.sizeBytes, bytes.byteLength);
  } finally {
    delete process.env.GRAPIX_DATA_ROOT;
    await rm(dataRoot, { recursive: true, force: true });
  }
});
