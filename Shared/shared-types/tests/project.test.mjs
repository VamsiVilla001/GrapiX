import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PROJECT_SETTINGS,
  MAX_PROJECT_DIMENSION,
  MIN_PROJECT_DIMENSION,
  PROJECT_COLOR_SPACES,
  PROJECT_COLOR_SPACE_INFO,
  PROJECT_PIXEL_ASPECT_RATIO,
  RESOLUTION_PRESET_INFO,
  findResolutionMismatches,
  normalizeProjectSettings,
  presetForResolution,
  projectCanvasSize,
  projectSafeAreaInsets,
  resolutionForPreset,
  validateProjectSettings
} from "../dist/index.js";

test("the default project is broadcast HD with square pixels", () => {
  const settings = DEFAULT_PROJECT_SETTINGS;

  assert.equal(settings.resolution.width, 1920);
  assert.equal(settings.resolution.height, 1080);
  assert.equal(settings.resolution.preset, "hd-1080");
  // Rec.709 rather than sRGB: this is a broadcast tool.
  assert.equal(settings.colorSpace, "rec709");
  assert.equal(settings.resolution.pixelAspectRatio, 1);
  assert.equal(PROJECT_PIXEL_ASPECT_RATIO, 1);
});

test("every resolution preset is even in both axes", () => {
  for (const preset of Object.values(RESOLUTION_PRESET_INFO)) {
    assert.equal(preset.width % 2, 0, `${preset.id} width must be even`);
    assert.equal(preset.height % 2, 0, `${preset.id} height must be even`);
  }
  assert.deepEqual(resolutionForPreset("uhd-4k"), {
    id: "uhd-4k",
    label: "UHD 4K (3840 × 2160)",
    width: 3840,
    height: 2160
  });
  assert.equal(resolutionForPreset("custom"), undefined);
});

test("a preset name wins over dimensions stored beside it", () => {
  // A hand-edited file must not be able to claim HD 1080 at 720p dimensions.
  const settings = normalizeProjectSettings({
    resolution: { preset: "hd-1080", width: 1280, height: 720, pixelAspectRatio: 1 }
  });

  assert.equal(settings.resolution.width, 1920);
  assert.equal(settings.resolution.height, 1080);
  assert.equal(settings.resolution.preset, "hd-1080");
});

test("a custom resolution is accepted and labelled custom", () => {
  const settings = normalizeProjectSettings({
    resolution: { preset: "custom", width: 2560, height: 1440, pixelAspectRatio: 1 }
  });

  assert.equal(settings.resolution.width, 2560);
  assert.equal(settings.resolution.height, 1440);
  assert.equal(settings.resolution.preset, "custom");
});

test("custom dimensions that match a preset snap to that preset", () => {
  // So the UI cannot show "custom" for what is plainly UHD.
  const settings = normalizeProjectSettings({
    resolution: { preset: "custom", width: 3840, height: 2160, pixelAspectRatio: 1 }
  });
  assert.equal(settings.resolution.preset, "uhd-4k");
  assert.equal(presetForResolution(3840, 2160), "uhd-4k");
  assert.equal(presetForResolution(2560, 1440), "custom");
});

test("odd dimensions are rounded up to even", () => {
  // Odd widths break 4:2:0 chroma subsampling in every broadcast codec, so the
  // constraint is enforced here rather than surfacing at encode time.
  const settings = normalizeProjectSettings({
    resolution: { preset: "custom", width: 1921, height: 1081, pixelAspectRatio: 1 }
  });
  assert.equal(settings.resolution.width, 1922);
  assert.equal(settings.resolution.height, 1082);
});

test("dimensions clamp to the documented range", () => {
  const tiny = normalizeProjectSettings({
    resolution: { preset: "custom", width: 2, height: 2, pixelAspectRatio: 1 }
  });
  assert.equal(tiny.resolution.width, MIN_PROJECT_DIMENSION);

  const huge = normalizeProjectSettings({
    resolution: { preset: "custom", width: 999_999, height: 999_999, pixelAspectRatio: 1 }
  });
  assert.equal(huge.resolution.width, MAX_PROJECT_DIMENSION);
  assert.equal(huge.resolution.height, MAX_PROJECT_DIMENSION);

  const nonsense = normalizeProjectSettings({
    resolution: { preset: "custom", width: Number.NaN, height: -5, pixelAspectRatio: 1 }
  });
  assert.equal(nonsense.resolution.width, 1920);
  assert.equal(nonsense.resolution.height, 1080);
});

test("pixel aspect ratio is always forced to 1", () => {
  const settings = normalizeProjectSettings({
    resolution: {
      preset: "custom",
      width: 1440,
      height: 1080,
      // An anamorphic value must not survive: non-square delivery is an output
      // concern, not an authoring one.
      pixelAspectRatio: 4 / 3
    }
  });
  assert.equal(settings.resolution.pixelAspectRatio, 1);
});

test("normalisation is deterministic and idempotent", () => {
  const once = normalizeProjectSettings({
    name: "  Arena  ",
    resolution: { preset: "custom", width: 2560, height: 1440, pixelAspectRatio: 1 },
    colorSpace: "rec2020-pq"
  });
  assert.equal(once.name, "Arena");
  assert.deepEqual(normalizeProjectSettings(once), once);
});

test("an unknown colour space falls back to the broadcast default", () => {
  const settings = normalizeProjectSettings({ colorSpace: "adobe-rgb" });
  assert.equal(settings.colorSpace, "rec709");
});

test("every colour space declares its primaries and transfer function", () => {
  for (const id of PROJECT_COLOR_SPACES) {
    const info = PROJECT_COLOR_SPACE_INFO[id];
    assert.ok(info, `${id} must have info`);
    assert.ok(info.primaries.length > 0, `${id} needs primaries`);
    assert.ok(info.transferFunction.length > 0, `${id} needs a transfer function`);
    assert.ok(info.description.length > 0, `${id} needs a description`);
  }
  assert.equal(PROJECT_COLOR_SPACE_INFO["rec2020-pq"].highDynamicRange, true);
  assert.equal(PROJECT_COLOR_SPACE_INFO.rec709.highDynamicRange, false);
});

test("HDR gets a default peak luminance and SDR does not carry one", () => {
  const hdr = normalizeProjectSettings({ colorSpace: "rec2020-hlg" });
  assert.equal(hdr.peakLuminanceNits, 1_000);

  // A misleading value must not survive a switch back to SDR.
  const sdr = normalizeProjectSettings({ colorSpace: "rec709", peakLuminanceNits: 4_000 });
  assert.equal(sdr.peakLuminanceNits, undefined);

  const explicit = normalizeProjectSettings({
    colorSpace: "rec2020-pq",
    peakLuminanceNits: 4_000
  });
  assert.equal(explicit.peakLuminanceNits, 4_000);

  const capped = normalizeProjectSettings({
    colorSpace: "rec2020-pq",
    peakLuminanceNits: 99_999
  });
  assert.equal(capped.peakLuminanceNits, 10_000);
});

test("frame rate stays rational", () => {
  const drop = normalizeProjectSettings({
    frameRate: { numerator: 60_000, denominator: 1_001 }
  });
  assert.deepEqual(drop.frameRate, { numerator: 60_000, denominator: 1_001 });

  const nonsense = normalizeProjectSettings({ frameRate: { numerator: 0, denominator: 0 } });
  assert.deepEqual(nonsense.frameRate, { numerator: 50, denominator: 1 });
});

test("a default project validates with no issues", () => {
  const validation = validateProjectSettings(normalizeProjectSettings(undefined));
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.issues, []);
});

test("a project needing tiling is valid but warns", () => {
  const settings = normalizeProjectSettings({
    resolution: { preset: "custom", width: 20_000, height: 4_000, pixelAspectRatio: 1 }
  });
  const validation = validateProjectSettings(settings);

  // Legal, but the operator must know tiling is mandatory rather than optional.
  assert.equal(validation.valid, true);
  assert.ok(validation.issues.some((issue) => issue.code === "REQUIRES_TILING"));
});

test("a very large project warns about frame rate", () => {
  const settings = normalizeProjectSettings({
    resolution: { preset: "custom", width: 20_000, height: 10_000, pixelAspectRatio: 1 }
  });
  const validation = validateProjectSettings(settings);
  assert.ok(validation.issues.some((issue) => issue.code === "VERY_LARGE_PROJECT"));
});

test("non-square pixels are an error if they somehow appear", () => {
  const settings = {
    ...normalizeProjectSettings(undefined),
    resolution: {
      preset: "custom",
      width: 1440,
      height: 1080,
      pixelAspectRatio: 1.333
    }
  };
  const validation = validateProjectSettings(settings);

  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((issue) => issue.code === "NON_SQUARE_PIXELS"));
});

test("a non-broadcast colour space warns", () => {
  const validation = validateProjectSettings(normalizeProjectSettings({ colorSpace: "srgb" }));
  assert.equal(validation.valid, true);
  const issue = validation.issues.find((i) => i.code === "NON_BROADCAST_COLOR_SPACE");
  assert.ok(issue.message.includes("Rec.709"));
});

test("HDR without a peak luminance warns", () => {
  // Built by hand so normalisation cannot supply the default.
  const settings = {
    ...normalizeProjectSettings({ colorSpace: "rec2020-pq" }),
    peakLuminanceNits: undefined
  };
  const validation = validateProjectSettings(settings);
  assert.ok(validation.issues.some((issue) => issue.code === "HDR_WITHOUT_PEAK_LUMINANCE"));
});

test("the project canvas and safe area derive from the settings", () => {
  const settings = normalizeProjectSettings({
    resolution: { preset: "uhd-4k", width: 0, height: 0, pixelAspectRatio: 1 },
    safeAreaPercent: 0.05
  });

  assert.deepEqual(projectCanvasSize(settings), { width: 3840, height: 2160 });
  assert.deepEqual(projectSafeAreaInsets(settings), {
    top: 108,
    right: 192,
    bottom: 108,
    left: 192
  });
});

test("safe area percent is clamped to something sane", () => {
  assert.equal(normalizeProjectSettings({ safeAreaPercent: 0.9 }).safeAreaPercent, 0.25);
  assert.equal(normalizeProjectSettings({ safeAreaPercent: -1 }).safeAreaPercent, 0.05);
});

test("scenes that disagree with the project resolution are found", () => {
  const settings = normalizeProjectSettings({
    resolution: { preset: "hd-1080", width: 1920, height: 1080, pixelAspectRatio: 1 }
  });

  const mismatches = findResolutionMismatches(settings, [
    { id: "s1", name: "Conforming", canvas: { width: 1920, height: 1080 } },
    { id: "s2", name: "Old 720", canvas: { width: 1280, height: 720 } },
    { id: "s3", name: "UHD", canvas: { width: 3840, height: 2160 } }
  ]);

  // Two scenes at different resolutions cannot be cut between on air, which is the
  // whole reason project resolution is one setting.
  assert.equal(mismatches.length, 2);
  assert.deepEqual(
    mismatches.map((m) => m.sceneId),
    ["s2", "s3"]
  );
  assert.equal(mismatches[0].sceneWidth, 1280);
});
