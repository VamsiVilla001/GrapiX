import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFontFamilyStack,
  fontDefinitionForText,
  validateFontDefinition
} from "../dist/index.js";

const font = {
  fontId: "font_broadcast",
  family: "Broadcast Sans",
  displayName: "On Air Sans",
  enabled: true,
  faces: [{
    faceId: "face_regular",
    family: "Broadcast Sans",
    weight: 400,
    style: "normal",
    status: "READY",
    source: { kind: "file", assetId: "asset_font", format: "woff2" }
  }],
  fallbackFamilies: ["Noto Sans Arabic", "sans-serif"],
  embeddingPolicy: "package",
  status: "READY"
};

test("uses stable fontId and constructs an escaped deduplicated fallback stack", () => {
  assert.equal(fontDefinitionForText([font], {
    fontId: "font_broadcast",
    fontFamily: "Old Family"
  }), font);
  assert.equal(
    buildFontFamilyStack(font, "Old Family", ["Noto Sans Arabic", "Arial"]),
    '"Broadcast Sans", "Noto Sans Arabic", "Arial", sans-serif'
  );
});

test("rejects a font whose packaged face asset is missing", () => {
  assert.ok(validateFontDefinition(font, []).some((message) => message.includes("missing font asset")));
});
