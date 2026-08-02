import { test } from "node:test";
import assert from "node:assert/strict";
import {
  defaultTransform,
  normalizeTransform,
  classifyCompatibility,
  validateAdobeImportDocument
} from "../dist/index.js";

test("defaultTransform returns unit transforms", () => {
  const t = defaultTransform();
  assert.equal(t.x, 0);
  assert.equal(t.y, 0);
  assert.equal(t.scaleX, 1);
  assert.equal(t.scaleY, 1);
  assert.equal(t.opacity, 1);
});

test("normalizeTransform clamps opacity and fills missing defaults", () => {
  const t = normalizeTransform({ x: 100, opacity: 1.5 });
  assert.equal(t.x, 100);
  assert.equal(t.y, 0);
  assert.equal(t.opacity, 1);
});

test("classifyCompatibility identifies Native vs Converted vs Unsupported", () => {
  assert.equal(classifyCompatibility("text"), "Native");
  assert.equal(classifyCompatibility("smart-object"), "Converted");
  assert.equal(classifyCompatibility("third-party-plugin"), "Unsupported");
  assert.equal(classifyCompatibility("text", true), "Converted");
});

test("validateAdobeImportDocument validates valid and invalid documents", () => {
  const invalid = validateAdobeImportDocument({});
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.length >= 3);

  const validDoc = {
    source: "photoshop",
    documentId: "psd-101",
    name: "LowerThird.psd",
    width: 1920,
    height: 1080,
    layers: [
      {
        id: "layer-1",
        name: "Headline Text",
        type: "text",
        transform: { x: 50, y: 500, scaleX: 1, scaleY: 1, opacity: 1 },
        textData: {
          text: "BREAKING NEWS",
          fontSize: 48,
          fontFamily: "Inter",
          color: "#ffffff"
        }
      }
    ],
    assets: [],
    warnings: []
  };

  const valid = validateAdobeImportDocument(validDoc);
  assert.equal(valid.valid, true);
  assert.equal(valid.normalized?.layers.length, 1);
  assert.equal(valid.normalized?.layers[0].textData?.text, "BREAKING NEWS");
});

test("document validation rejects non-finite dimensions and normalizes non-finite optional values", () => {
  const invalid = validateAdobeImportDocument({
    source: "photoshop",
    documentId: "psd-invalid",
    name: "Invalid",
    width: Infinity,
    height: NaN
  });
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join("\n"), /finite positive number/);

  const normalized = validateAdobeImportDocument({
    source: "photoshop",
    documentId: "psd-normalized",
    name: "Normalized",
    width: 1920,
    height: 1080,
    frameRate: Infinity,
    duration: NaN,
    layers: [{ opacity: NaN }]
  });
  assert.equal(normalized.valid, true);
  assert.equal(normalized.normalized?.frameRate, 30);
  assert.equal(normalized.normalized?.duration, 10);
  assert.equal(normalized.normalized?.layers[0].opacity, 1);
});
