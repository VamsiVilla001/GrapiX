import assert from "node:assert/strict";
import test from "node:test";
import {
  createFileFontDefinition,
  createLinkedFontDefinition
} from "../dist/fontManager.js";
import { inspectSceneScript } from "../dist/importers/sceneScriptImporter.js";

test("creates file and Adobe font definitions without rehosting linked fonts", () => {
  const fileFont = createFileFontDefinition({
    assetId: "asset_font",
    fileName: "Inter.woff2",
    relativePath: "assets/fonts/asset_font.woff2",
    mimeType: "font/woff2",
    sizeBytes: 100,
    checksum: "a".repeat(64),
    importedAt: "2026-01-01T00:00:00.000Z",
    duplicate: false,
    referenceCount: 0,
    referencedByScenes: [],
    cacheTier: "DISK",
    lastAccessedAt: "2026-01-01T00:00:00.000Z"
  }, { family: "Inter", weight: 700 });
  assert.equal(fileFont.embeddingPolicy, "package");
  assert.equal(fileFont.faces[0].source.kind, "file");

  const adobe = createLinkedFontDefinition({
    source: "adobe-fonts",
    family: "Acumin Pro",
    projectId: "abc123"
  });
  assert.equal(adobe.faces[0].source.url, "https://use.typekit.net/abc123.css");
  assert.equal(adobe.embeddingPolicy, "reference");
  assert.throws(() => createLinkedFontDefinition({
    source: "adobe-fonts",
    family: "Acumin Pro",
    projectId: "../bad"
  }), /projectId/);
  assert.throws(() => createLinkedFontDefinition({
    source: "css-url",
    family: "Unsafe",
    url: "https://example.com/site.css"
  }), /not approved/);
});

test("scene script importer accepts SDK modules and rejects host/network access", () => {
  const accepted = inspectSceneScript(
    Buffer.from("export default defineSceneScript({ apiVersion: 1, onEvent(api) { api.emit('ready'); } });"),
    "score.mjs"
  );
  assert.equal(accepted.accepted, true);
  assert.match(accepted.checksum, /^[a-f0-9]{64}$/);

  const rejected = inspectSceneScript(
    Buffer.from("export default defineSceneScript({ apiVersion: 1, onEvent() { return fetch('https://example.com'); } });"),
    "unsafe.mjs"
  );
  assert.equal(rejected.accepted, false);
  assert.ok(rejected.errors.some((message) => message.includes("network")));
});
