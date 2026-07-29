import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_ADAPTER_DESCRIPTORS,
  bytesPerPixel,
  createDescriptorRegistry,
  frameByteSize,
  NULL_OUTPUT_DESCRIPTOR,
  PENDING_ADAPTER_DESCRIPTORS,
  RECORDING_OUTPUT_DESCRIPTOR,
  validateOutputFormat
} from "../dist/index.js";

function format(overrides = {}) {
  return {
    width: 1920,
    height: 1080,
    frameRate: { numerator: 50, denominator: 1 },
    colorFormat: "bgra8",
    alphaMode: "premultiplied",
    scanMode: "progressive",
    colorSpace: "srgb",
    pixelAspectRatio: 1,
    ...overrides
  };
}

test("the null output accepts any progressive format", () => {
  const result = validateOutputFormat(NULL_OUTPUT_DESCRIPTOR, format());
  assert.equal(result.ok, true);
  assert.deepEqual(result.warnings, []);

  // Resolution is unconstrained, including a huge one.
  assert.equal(
    validateOutputFormat(NULL_OUTPUT_DESCRIPTOR, format({ width: 15_360, height: 4_320 })).ok,
    true
  );
});

test("an unavailable adapter is refused with its reason", () => {
  const ndi = PENDING_ADAPTER_DESCRIPTORS.find((adapter) => adapter.adapterId === "ndi");
  assert.equal(ndi.available, false);
  assert.equal(ndi.hardwareCertified, false);

  const result = validateOutputFormat(ndi, format());
  assert.equal(result.ok, false);
  assert.equal(result.code, "ADAPTER_UNAVAILABLE");
  assert.ok(result.message.includes("NDI SDK 6.x"));
});

test("an unsupported colour format is refused, listing what is supported", () => {
  const result = validateOutputFormat(RECORDING_OUTPUT_DESCRIPTOR, format({ colorFormat: "v210" }));

  assert.equal(result.ok, false);
  assert.equal(result.code, "FORMAT_UNSUPPORTED");
  assert.ok(result.message.includes("bgra8"));
});

test("interlaced is refused by adapters that do not declare it", () => {
  const result = validateOutputFormat(
    NULL_OUTPUT_DESCRIPTOR,
    format({ scanMode: "interlaced-upper" })
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, "INTERLACED_UNSUPPORTED");
});

test("an adapter with fixed formats refuses anything else", () => {
  const sdi = {
    ...NULL_OUTPUT_DESCRIPTOR,
    adapterId: "fixed",
    name: "Fixed SDI",
    fixedFormats: [{ width: 1920, height: 1080, frameRate: { numerator: 50, denominator: 1 } }]
  };

  assert.equal(validateOutputFormat(sdi, format()).ok, true);
  // Frame rate equality is by value, so 100/2 also matches.
  assert.equal(
    validateOutputFormat(sdi, format({ frameRate: { numerator: 100, denominator: 2 } })).ok,
    true
  );

  const wrong = validateOutputFormat(sdi, format({ width: 3840, height: 2160 }));
  assert.equal(wrong.ok, false);
  assert.equal(wrong.code, "RESOLUTION_UNSUPPORTED");
});

test("uncertified adapters warn rather than pretending to be production-ready", () => {
  const almost = {
    ...PENDING_ADAPTER_DESCRIPTORS.find((adapter) => adapter.adapterId === "decklink"),
    available: true,
    unavailableReason: undefined
  };

  const result = validateOutputFormat(almost, format({ colorSpace: "rec709" }));
  assert.equal(result.ok, true);
  assert.ok(
    result.warnings.some((warning) => warning.includes("not been certified against real hardware"))
  );
});

test("losing alpha is a warning, not a silent discard", () => {
  const opaqueOnly = {
    ...NULL_OUTPUT_DESCRIPTOR,
    adapterId: "opaque",
    supportsAlpha: false
  };

  const result = validateOutputFormat(opaqueOnly, format({ alphaMode: "premultiplied" }));
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some((warning) => warning.includes("key channel will be lost")));
});

test("every SDI and network adapter ships declared but uncertified", () => {
  for (const adapter of PENDING_ADAPTER_DESCRIPTORS) {
    assert.equal(adapter.available, false, `${adapter.adapterId} must not claim availability`);
    assert.equal(adapter.hardwareCertified, false);
    assert.ok(adapter.unavailableReason, `${adapter.adapterId} must explain why`);
  }
});

test("the registry separates available adapters from declared ones", () => {
  const registry = createDescriptorRegistry(ALL_ADAPTER_DESCRIPTORS);

  assert.equal(registry.descriptors().length, ALL_ADAPTER_DESCRIPTORS.length);
  assert.deepEqual(
    registry.available().map((adapter) => adapter.adapterId),
    ["null", "recording"]
  );
  assert.equal(registry.get("ndi").available, false);
  assert.equal(registry.get("nonexistent"), undefined);
});

test("frame sizes account for pixel format and row alignment", () => {
  assert.equal(bytesPerPixel("bgra8"), 4);
  assert.equal(bytesPerPixel("rgba16f"), 8);
  assert.equal(bytesPerPixel("uyvy422"), 2);

  assert.equal(frameByteSize(format()), 1920 * 1080 * 4);

  // wgpu wants 256-byte aligned rows for a buffer copy; 1920*4 is already 7680,
  // which divides by 256, so a 1921-wide frame is the interesting case.
  const odd = frameByteSize(format({ width: 1_921 }), 256);
  assert.equal(odd % 256, 0);
  assert.ok(odd > 1_921 * 4 * 1_080);
});
