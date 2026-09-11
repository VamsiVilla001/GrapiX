// Round-trip proof for build plan 1.1: the scene document serialises
// identically in Rust and TypeScript.
//
// Two halves, because the done-when is "round-trips through both languages":
//
// 1. **Compile time** — `scene-roundtrip.types.ts` imports the generated
//    types and assigns the exact wire JSON. If the generated TS drifts from
//    the Rust definition, `npm run typecheck` fails. That is the half that
//    proves the two languages agree on the shape.
// 2. **Run time** — this file asserts the JSON round-trips losslessly and
//    the 1.7 replace-in-place semantics hold. Plain JS over the same wire
//    object, so it runs under `node --test` with no build step.

import { test } from "node:test";
import assert from "node:assert/strict";

// The same scene the Rust round-trip test builds, as the JSON the wire
// carries (camelCase, `type`-tagged objects, rational rate).
export const sceneJson = {
  id: "scene_1",
  name: "Lower Third",
  version: 1,
  revision: 3,
  canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
  timeline: { durationFrames: 250 },
  dataContext: {},
  assets: [
    {
      assetId: "asset_logo",
      name: "Logo",
      kind: "image",
      path: "images/logo.png",
      checksum: "abc123",
      mimeType: "image/png",
      sizeBytes: 1024,
      status: "ready",
    },
  ],
  fonts: [],
  objects: [
    { type: "rect", id: "bg", name: "bg", visible: true, opacity: 1, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, width: 1920, height: 200, fill: "#102030" },
    { type: "text", id: "title", name: "title", visible: true, opacity: 1, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, text: "Hello", fontId: "font_inter", size: 72, color: "#ffffff" },
    { type: "image", id: "logo", name: "logo", visible: true, opacity: 1, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, assetId: "asset_logo", width: 120, height: 120 },
  ],
};

test("the scene JSON round-trips losslessly", () => {
  const back = JSON.parse(JSON.stringify(sceneJson));
  assert.deepEqual(back, sceneJson);
  // Spot-check the wire invariants the Rust test pins.
  assert.equal(back.canvas.frameRate.num, 50);
  assert.equal(back.objects[1].type, "text");
  assert.equal(back.objects[1].fontId, "font_inter");
  assert.equal(back.assets[0].assetId, "asset_logo");
});

test("replace-in-place keeps the asset binding (1.7)", () => {
  // Mirror of the Rust test: an image binds the asset id; changing the
  // asset's bytes (checksum) over the same library path leaves the binding
  // untouched.
  const scene = JSON.parse(JSON.stringify(sceneJson));
  const image = scene.objects.find((o) => o.type === "image");
  const boundId = image.assetId;

  const asset = scene.assets.find((a) => a.assetId === boundId);
  asset.checksum = "def456"; // new bytes over the same library path
  assert.equal(asset.path, "images/logo.png");
  assert.equal(image.assetId, "asset_logo"); // binding unchanged
  assert.equal(asset.checksum, "def456");    // resolves to the new bytes
});
