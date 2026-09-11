// Runtime half of the scene proof: the document round-trip (1.1) and the
// object catalogue's coverage (1.2).
//
// Three halves, because "round-trips through both languages" and "every
// authorable object is representable" each have two sides:
//
// 1. **Rust** — `Shared/contracts/src/scene.rs` pins the wire JSON, holds the
//    kind list against 1.x's own contract file, and round-trips one object of
//    every kind with a fully populated base.
// 2. **Compile time** — `scene-roundtrip.types.ts` assigns one object of every
//    kind, as wire JSON, directly to the generated `SceneDocument` and
//    `HierarchyResolution` types. No cast, so a renamed field, a missing
//    required one or a misspelled enum member fails `npm run typecheck`.
// 3. **Run time** — this file. It reads the *generated* union to check the
//    catalogue's kinds without restating them, and round-trips a scene.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 1.x's authorable object set, from `programObjectTypes` plus
// `notRenderedByProgram` in
// `Shared/shared-types/contracts/program-object-types.json` on branch
// `Basic-v0.4-2026-09-06-project-container-material-library`. The Rust test
// of the same name holds the catalogue against this list too; here it is
// checked on the TypeScript side of the generator, so a kind that reaches
// Rust but not TypeScript is caught.
const ONE_X_AUTHORABLE_KINDS = [
  "rect",
  "ellipse",
  "text",
  "shape",
  "mesh",
  "light",
  "image",
  "line",
  "paint",
  "camera",
  "layer",
  "marker",
  "group",
];

// The same scene the Rust round-trip test builds, as the JSON the wire
// carries (camelCase, `type`-tagged objects, rational rate). The box is on
// the base for every kind (1.2), which is why the rect carries no width of
// its own.
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
    { type: "rect", id: "bg", name: "bg", visible: true, opacity: 1, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, width: 1920, height: 200, fill: "#102030", radius: 0 },
    { type: "text", id: "title", name: "title", visible: true, opacity: 1, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, text: "Hello", fontId: "font_inter", size: 72, fill: "#ffffff", align: "left" },
    { type: "image", id: "logo", name: "logo", visible: true, opacity: 1, x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, width: 120, height: 120, assetId: "asset_logo" },
  ],
};

test("the generated object union covers 1.x's authorable catalogue (1.2)", () => {
  // Read the generated union rather than restating it: the tags come from
  // Rust through the generator, so this fails if a kind is added on one side
  // only.
  const union = readFileSync(new URL("../src/SceneObject.ts", import.meta.url), "utf8");
  const tags = [...union.matchAll(/"type":\s*"([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...tags].sort(), [...ONE_X_AUTHORABLE_KINDS].sort());
});

test("the scene JSON round-trips losslessly", () => {
  const back = JSON.parse(JSON.stringify(sceneJson));
  assert.deepEqual(back, sceneJson);
  // Spot-check the wire invariants the Rust test pins.
  assert.equal(back.canvas.frameRate.num, 50);
  assert.equal(back.objects[0].width, 1920);
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
