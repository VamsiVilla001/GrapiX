import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import JSZip from "jszip";
import { buildScenePackage, verifyScenePackage } from "../dist/packageBuilder.js";

const fixturePath = new URL(
  "../../../../Shared/shared-types/fixtures/scene-document.v1.json",
  import.meta.url
);

test("builds and independently verifies a strict v2 scene package", async () => {
  const scene = JSON.parse(await readFile(fixturePath, "utf8"));
  const built = await buildScenePackage(scene);
  const verified = await verifyScenePackage(built.buffer);

  assert.equal(verified.manifest.packageVersion, 2);
  assert.equal(verified.manifest.minimumRendererProtocolVersion, 2);
  assert.equal(verified.manifest.sceneId, scene.id);
  assert.ok(verified.fileCount >= 8);
  assert.match(built.manifest.assets[0].checksum, /^[a-f0-9]{64}$/);
  assert.ok(verified.checksums["scene.json"]);
  assert.ok(verified.checksums[built.manifest.assets[0].path]);
});

test("rejects a package whose checked file was changed", async () => {
  const scene = JSON.parse(await readFile(fixturePath, "utf8"));
  const built = await buildScenePackage(scene);
  const zip = await JSZip.loadAsync(built.buffer);
  zip.file("scene.json", "{}\n");
  const tampered = await zip.generateAsync({ type: "nodebuffer" });

  await assert.rejects(() => verifyScenePackage(tampered), /checksum mismatch/);
});

test("packages font and automation manifests as checksummed optional v2 files", async () => {
  const scene = JSON.parse(await readFile(fixturePath, "utf8"));
  scene.fonts = [{
    fontId: "font_acumin",
    family: "Acumin Pro",
    displayName: "Acumin Pro",
    faces: [{
      faceId: "face_acumin",
      family: "Acumin Pro",
      weight: 400,
      style: "normal",
      source: { kind: "adobe-fonts", projectId: "abc123", url: "https://use.typekit.net/abc123.css" }
    }],
    fallbackFamilies: ["Arial"],
    embeddingPolicy: "reference",
    status: "UNVERIFIED"
  }];
  scene.automation = {
    version: 1,
    transitions: [{ transitionId: "cut", name: "Cut", kind: "cut", durationFrames: 0, easing: "linear" }],
    triggers: [{
      triggerId: "trigger_manual",
      name: "Manual take",
      enabled: true,
      event: { type: "manual", name: "take" },
      actions: [{ type: "take-scene", sceneId: scene.id }],
      priority: 1
    }]
  };
  const built = await buildScenePackage(scene);
  const verified = await verifyScenePackage(built.buffer);
  assert.equal(verified.manifest.files.fonts, "fonts.json");
  assert.equal(verified.manifest.files.automation, "automation.json");
  assert.ok(verified.checksums["fonts.json"]);
  assert.ok(verified.checksums["automation.json"]);
});
