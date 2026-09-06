import assert from "node:assert/strict";
import test from "node:test";

import { withoutInlineAssetBytes } from "../dist/engineController.js";

/**
 * What a scene document may weigh on the wire.
 *
 * The engine enforces a message limit (8 MiB by default) before it parses, and it declares a
 * scene's assets from `assets[].assetId` — it never reads `source`. So embedded bytes in a scene
 * document are both redundant with `asset.upload` and, past the limit, fatal: a published scene
 * with eight inlined images weighed 13.06 MiB and the engine rejected the frame with
 * MESSAGE_TOO_LARGE. The operator saw "connection closed: reconnecting" a minute after Take.
 */

const PNG_DATA_URL = `data:image/png;base64,${"A".repeat(2048)}`;

function sceneWithInlineImage() {
  return {
    id: "scene_1",
    name: "Inline",
    revision: 3,
    assets: [
      { assetId: "asset_photo", name: "photo.png", kind: "image", source: PNG_DATA_URL, checksum: "abc", mimeType: "image/png" },
      { assetId: "asset_linked", name: "clip.mp4", kind: "video", source: "http://media.example/clip.mp4", checksum: "def" }
    ],
    objects: [
      { id: "o1", name: "photo", type: "image", src: PNG_DATA_URL },
      { id: "o2", name: "box", type: "rect" }
    ]
  };
}

test("inline asset bytes are replaced by a reference the engine already understands", () => {
  const scene = sceneWithInlineImage();
  const wire = withoutInlineAssetBytes(scene);

  assert.equal(wire.assets[0].source, "asset:asset_photo");
  assert.equal(wire.objects[0].src, "asset:asset_photo", "the object stops carrying a second copy");

  // Everything that identifies the asset survives, because that is what registration uses.
  assert.equal(wire.assets[0].assetId, "asset_photo");
  assert.equal(wire.assets[0].checksum, "abc");
  assert.equal(wire.assets[0].name, "photo.png");
});

test("the document shrinks by the bytes it was carrying", () => {
  const scene = sceneWithInlineImage();
  const before = JSON.stringify(scene).length;
  const after = JSON.stringify(withoutInlineAssetBytes(scene)).length;

  // Two copies of a 2 KiB payload leave, and only short references arrive.
  assert.ok(after < before - 4000, `expected the bytes to go: ${before} -> ${after}`);
});

test("a linked asset is left exactly as published", () => {
  const wire = withoutInlineAssetBytes(sceneWithInlineImage());
  assert.equal(wire.assets[1].source, "http://media.example/clip.mp4");
});

test("a scene with nothing inlined is returned unchanged, not rebuilt", () => {
  const scene = {
    id: "scene_2",
    name: "Linked",
    revision: 1,
    assets: [{ assetId: "a", source: "http://media.example/a.png" }],
    objects: [{ id: "o", type: "image", src: "http://media.example/a.png" }]
  };
  assert.equal(withoutInlineAssetBytes(scene), scene, "same object: no allocation for the common case");
});

test("an object pointing at bytes no asset declares is left alone", () => {
  // Nothing else can be inferred about it, and inventing a reference would silently blank the layer.
  const orphan = `data:image/png;base64,${"B".repeat(64)}`;
  const scene = {
    id: "scene_3",
    name: "Orphan",
    revision: 1,
    assets: [{ assetId: "a", source: PNG_DATA_URL }],
    objects: [{ id: "o", type: "image", src: orphan }]
  };
  const wire = withoutInlineAssetBytes(scene);
  assert.equal(wire.objects[0].src, orphan);
});
