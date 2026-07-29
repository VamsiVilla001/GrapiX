import assert from "node:assert/strict";
import test from "node:test";

import {
  createStageDocument,
  createVirtualCanvas,
  fitRenderScale,
  implicitStageForScene,
  intersectRects,
  normalizeStageDocument,
  normalizeStageTiling,
  rect,
  resolveOutputPlacement,
  resolveSafeAreaRect,
  resolveViewportRect,
  summarizeStage,
  validateStageAgainstCapabilities,
  validateStageDocument,
  viewportRenderSize
} from "../dist/index.js";

/**
 * The stage from the requirements: a 50,000 x 10,000 LED installation driven by
 * three UHD outputs, plus a scaled operator preview.
 */
function hugeStage() {
  return normalizeStageDocument({
    stageId: "stage_arena",
    name: "Arena",
    canvas: { logicalWidth: 50_000, logicalHeight: 10_000 },
    regions: [
      { regionId: "region_left", name: "Left", bounds: rect(0, 0, 3840, 2160) },
      { regionId: "region_centre", name: "Centre", bounds: rect(23_080, 0, 3840, 2160) },
      { regionId: "region_right", name: "Right", bounds: rect(46_160, 0, 3840, 2160) }
    ],
    surfaces: [
      {
        surfaceId: "surface_ribbon",
        name: "Ribbon",
        position: { x: 0, y: 8_000 },
        size: { width: 50_000, height: 2_000 },
        outputId: "output_a"
      }
    ],
    viewports: [
      { viewportId: "vp_left", name: "Left", source: { type: "region", regionId: "region_left" } },
      { viewportId: "vp_full", name: "Operator", source: { type: "full-stage" }, renderScale: 0.0384 }
    ],
    cameras: [
      {
        cameraId: "cam_left",
        name: "Left",
        viewportId: "vp_left",
        projection: "orthographic",
        orthographic: { logicalWidth: 3840 }
      }
    ],
    outputs: [
      { outputId: "output_a", name: "Output A", width: 3840, height: 2160 },
      { outputId: "output_b", name: "Output B", width: 3840, height: 2160 },
      { outputId: "output_c", name: "Output C", width: 3840, height: 2160 },
      { outputId: "output_preview", name: "Preview", width: 1920, height: 384 }
    ],
    outputMappings: [
      {
        mappingId: "map_a",
        outputId: "output_a",
        source: { type: "region", regionId: "region_left" },
        fit: "contain"
      },
      {
        mappingId: "map_b",
        outputId: "output_b",
        source: { type: "region", regionId: "region_centre" },
        fit: "contain"
      },
      {
        mappingId: "map_c",
        outputId: "output_c",
        source: { type: "region", regionId: "region_right" },
        fit: "contain"
      },
      {
        mappingId: "map_preview",
        outputId: "output_preview",
        source: { type: "full-stage" },
        fit: "contain"
      }
    ],
    tiling: { tileWidth: 2048, tileHeight: 2048, overscan: 32 }
  });
}

test("a 50000 x 10000 stage validates and summarises", () => {
  const stage = hugeStage();
  const validation = validateStageDocument(stage);

  assert.equal(validation.valid, true, JSON.stringify(validation.issues));

  const summary = summarizeStage(stage);
  assert.equal(summary.logicalWidth, 50_000);
  assert.equal(summary.logicalHeight, 10_000);
  // 25 columns x 5 rows at 2048.
  assert.equal(summary.tileCount, 25 * 5);
  assert.equal(summary.outputCount, 4);
  assert.equal(summary.totalOutputPixels, 3840 * 2160 * 3 + 1920 * 384);
  assert.equal(summary.fullResolutionBytes, 50_000 * 10_000 * 4);
});

test("stage resolution and output resolution stay independent", () => {
  const stage = hugeStage();
  const context = {
    canvas: stage.canvas,
    regions: stage.regions,
    surfaces: stage.surfaces,
    viewports: stage.viewports
  };

  const outputA = stage.outputs.find((output) => output.outputId === "output_a");
  const mappingA = stage.outputMappings.find((mapping) => mapping.mappingId === "map_a");
  const placementA = resolveOutputPlacement(context, mappingA, outputA);

  // The left region is exactly UHD, so it maps 1:1 onto a UHD output even though
  // the stage it lives on is 50,000 wide.
  assert.deepEqual(placementA.source, rect(0, 0, 3840, 2160));
  assert.deepEqual(placementA.destination, rect(0, 0, 3840, 2160));
  assert.deepEqual(placementA.scale, { x: 1, y: 1 });

  const centreMapping = stage.outputMappings.find((mapping) => mapping.mappingId === "map_b");
  const centrePlacement = resolveOutputPlacement(context, centreMapping, outputA);
  assert.deepEqual(centrePlacement.source, rect(23_080, 0, 3840, 2160));
});

test("the full stage letterboxes onto a small operator output", () => {
  const stage = hugeStage();
  const context = {
    canvas: stage.canvas,
    regions: stage.regions,
    surfaces: stage.surfaces,
    viewports: stage.viewports
  };

  const output = stage.outputs.find((o) => o.outputId === "output_preview");
  const mapping = stage.outputMappings.find((m) => m.mappingId === "map_preview");
  const placement = resolveOutputPlacement(context, mapping, output);

  // 50000:10000 is 5:1; the output is 1920x384, also 5:1, so contain fills it.
  // Placements are f64, so compare with a tolerance rather than exactly: the two
  // candidate scale factors (1920/50000 and 384/10000) differ in the last bit.
  assert.ok(Math.abs(placement.destination.width - 1920) < 1e-9);
  assert.ok(Math.abs(placement.destination.height - 384) < 1e-9);
  assert.ok(placement.visible.width > 0 && placement.visible.height > 0);
});

test("viewport render scale is how a huge stage becomes a small preview", () => {
  const stage = hugeStage();
  const context = { canvas: stage.canvas, regions: stage.regions, surfaces: stage.surfaces };

  const operator = stage.viewports.find((viewport) => viewport.viewportId === "vp_full");
  assert.deepEqual(resolveViewportRect(context, operator), rect(0, 0, 50_000, 10_000));

  const renderSize = viewportRenderSize(context, operator);
  assert.equal(renderSize.width, 1920);
  assert.equal(renderSize.height, 384);

  const left = stage.viewports.find((viewport) => viewport.viewportId === "vp_left");
  assert.deepEqual(resolveViewportRect(context, left), rect(0, 0, 3840, 2160));
  assert.deepEqual(viewportRenderSize(context, left), { width: 3840, height: 2160 });
});

test("fitRenderScale keeps a preview inside a pixel budget", () => {
  const scale = fitRenderScale(rect(0, 0, 50_000, 50_000), 1920, 1080);
  assert.ok(scale <= 1080 / 50_000 + 1e-12);
  assert.equal(Math.ceil(50_000 * scale) <= 1080, true);

  // Never upscales a small source.
  assert.equal(fitRenderScale(rect(0, 0, 100, 100), 1920, 1080), 1);
});

test("output fit modes behave distinctly", () => {
  const stage = normalizeStageDocument({
    stageId: "stage_fit",
    canvas: { logicalWidth: 2000, logicalHeight: 1000 },
    outputs: [{ outputId: "out", width: 1000, height: 1000 }],
    outputMappings: [{ mappingId: "m", outputId: "out", source: { type: "full-stage" } }]
  });
  const context = {
    canvas: stage.canvas,
    regions: stage.regions,
    surfaces: stage.surfaces,
    viewports: stage.viewports
  };
  const output = stage.outputs[0];
  const base = stage.outputMappings[0];

  const contain = resolveOutputPlacement(context, { ...base, fit: "contain" }, output);
  assert.deepEqual(contain.destination, rect(0, 250, 1000, 500));

  const cover = resolveOutputPlacement(context, { ...base, fit: "cover" }, output);
  assert.deepEqual(cover.destination, rect(-500, 0, 2000, 1000));
  // Cover overflows on purpose; only the visible part is transmitted.
  assert.deepEqual(cover.visible, rect(0, 0, 1000, 1000));

  const stretch = resolveOutputPlacement(context, { ...base, fit: "stretch" }, output);
  assert.deepEqual(stretch.destination, rect(0, 0, 1000, 1000));

  const none = resolveOutputPlacement(context, { ...base, fit: "none" }, output);
  assert.deepEqual(none.destination, rect(0, 0, 2000, 1000));
});

test("quarter-turn rotation swaps the fitted axes", () => {
  const stage = normalizeStageDocument({
    stageId: "stage_rot",
    canvas: { logicalWidth: 1920, logicalHeight: 1080 },
    outputs: [{ outputId: "out", width: 1080, height: 1920 }],
    outputMappings: [
      { mappingId: "m", outputId: "out", source: { type: "full-stage" }, fit: "contain", rotationDegrees: 90 }
    ]
  });
  const context = {
    canvas: stage.canvas,
    regions: stage.regions,
    surfaces: stage.surfaces,
    viewports: stage.viewports
  };

  const placement = resolveOutputPlacement(context, stage.outputMappings[0], stage.outputs[0]);
  assert.equal(placement.rotationDegrees, 90);
  // A 1920x1080 source rotated 90 degrees is 1080x1920, which fills the portrait
  // output exactly.
  assert.deepEqual(placement.destination, rect(0, 0, 1080, 1920));
});

test("pixel aspect ratio affects fitting rather than being ignored", () => {
  const stage = normalizeStageDocument({
    stageId: "stage_par",
    canvas: { logicalWidth: 1440, logicalHeight: 1080, pixelAspectRatio: 4 / 3 },
    outputs: [{ outputId: "out", width: 1920, height: 1080, pixelAspectRatio: 1 }],
    outputMappings: [{ mappingId: "m", outputId: "out", source: { type: "full-stage" }, fit: "contain" }]
  });
  const context = {
    canvas: stage.canvas,
    regions: stage.regions,
    surfaces: stage.surfaces,
    viewports: stage.viewports
  };

  const placement = resolveOutputPlacement(context, stage.outputMappings[0], stage.outputs[0]);
  // 1440 anamorphic pixels at 4:3 PAR present as 1920 square pixels, so the
  // source fills the output instead of being letterboxed.
  assert.equal(Math.round(placement.destination.width), 1920);
  assert.equal(Math.round(placement.destination.height), 1080);
});

test("crop is relative to the source rectangle", () => {
  const stage = normalizeStageDocument({
    stageId: "stage_crop",
    canvas: { logicalWidth: 10_000, logicalHeight: 2_000 },
    regions: [{ regionId: "r", name: "R", bounds: rect(4_000, 0, 2_000, 2_000) }],
    outputs: [{ outputId: "out", width: 1920, height: 1080 }],
    outputMappings: [
      {
        mappingId: "m",
        outputId: "out",
        source: { type: "region", regionId: "r" },
        crop: rect(500, 250, 1000, 500)
      }
    ]
  });
  const context = {
    canvas: stage.canvas,
    regions: stage.regions,
    surfaces: stage.surfaces,
    viewports: stage.viewports
  };

  const placement = resolveOutputPlacement(context, stage.outputMappings[0], stage.outputs[0]);
  assert.deepEqual(placement.source, rect(4_500, 250, 1_000, 500));
});

test("safe areas resolve against their scope", () => {
  const stage = normalizeStageDocument({
    stageId: "stage_safe",
    canvas: { logicalWidth: 1920, logicalHeight: 1080 },
    regions: [{ regionId: "r", name: "R", bounds: rect(100, 100, 800, 600) }],
    safeAreas: [
      {
        safeAreaId: "safe_stage",
        name: "Title",
        kind: "title",
        insets: { top: 54, right: 96, bottom: 54, left: 96 }
      },
      {
        safeAreaId: "safe_region",
        name: "Region title",
        kind: "title",
        scope: { type: "region", regionId: "r" },
        insets: { top: 10, right: 10, bottom: 10, left: 10 }
      }
    ]
  });
  const context = { canvas: stage.canvas, regions: stage.regions, surfaces: stage.surfaces };

  assert.deepEqual(
    resolveSafeAreaRect(context, stage.safeAreas[0]),
    rect(96, 54, 1920 - 192, 1080 - 108)
  );
  assert.deepEqual(
    resolveSafeAreaRect(context, stage.safeAreas[1]),
    rect(110, 110, 780, 580)
  );
  // Safe areas are editor guides by default and must never reach output.
  assert.equal(stage.safeAreas[0].editorOnly, true);
});

test("validation reports dangling references as errors", () => {
  const stage = normalizeStageDocument({
    stageId: "stage_bad",
    canvas: { logicalWidth: 1920, logicalHeight: 1080 },
    viewports: [{ viewportId: "vp", name: "VP", source: { type: "region", regionId: "missing" } }],
    cameras: [{ cameraId: "cam", name: "Cam", viewportId: "nope" }],
    outputMappings: [{ mappingId: "m", outputId: "ghost", source: { type: "full-stage" } }],
    surfaces: [
      { surfaceId: "s", name: "S", size: { width: 100, height: 100 }, outputId: "ghost" }
    ]
  });

  const validation = validateStageDocument(stage);
  assert.equal(validation.valid, false);

  const codes = validation.issues.map((issue) => issue.code);
  assert.ok(codes.includes("VIEWPORT_REGION_MISSING"));
  assert.ok(codes.includes("CAMERA_VIEWPORT_MISSING"));
  assert.ok(codes.includes("MAPPING_OUTPUT_MISSING"));
  assert.ok(codes.includes("SURFACE_OUTPUT_MISSING"));
});

test("duplicate identifiers are dropped, keeping the first", () => {
  const stage = normalizeStageDocument({
    stageId: "stage_dupe",
    canvas: { logicalWidth: 1920, logicalHeight: 1080 },
    regions: [
      { regionId: "r", name: "First", bounds: rect(0, 0, 10, 10) },
      { regionId: "r", name: "Second", bounds: rect(0, 0, 20, 20) }
    ]
  });

  assert.equal(stage.regions.length, 1);
  assert.equal(stage.regions[0].name, "First");
});

test("capability validation warns before publishing an unrenderable stage", () => {
  const stage = hugeStage();

  const capable = validateStageAgainstCapabilities(stage, {
    maxLogicalCanvasWidth: 50_000,
    maxLogicalCanvasHeight: 50_000,
    maxTextureDimension: 16_384,
    tileRendering: true
  });
  assert.equal(capable.valid, true, JSON.stringify(capable.issues));

  // Same stage, an engine that cannot tile.
  const noTiling = validateStageAgainstCapabilities(stage, {
    maxLogicalCanvasWidth: 50_000,
    maxLogicalCanvasHeight: 50_000,
    maxTextureDimension: 16_384,
    tileRendering: false
  });
  assert.equal(noTiling.valid, false);
  assert.ok(noTiling.issues.some((issue) => issue.code === "ENGINE_NO_TILING"));

  // Same stage, an engine with a smaller logical limit.
  const smallEngine = validateStageAgainstCapabilities(stage, {
    maxLogicalCanvasWidth: 16_384,
    maxLogicalCanvasHeight: 16_384,
    maxTextureDimension: 16_384,
    tileRendering: true
  });
  assert.equal(smallEngine.valid, false);
  assert.ok(smallEngine.issues.some((issue) => issue.code === "ENGINE_CANVAS_WIDTH"));
});

test("a tile larger than the engine texture limit is rejected", () => {
  const stage = normalizeStageDocument({
    stageId: "stage_tile",
    canvas: { logicalWidth: 50_000, logicalHeight: 50_000 },
    tiling: { tileWidth: 8192, tileHeight: 8192, overscan: 256 }
  });

  const validation = validateStageAgainstCapabilities(stage, {
    maxLogicalCanvasWidth: 50_000,
    maxLogicalCanvasHeight: 50_000,
    maxTextureDimension: 8192,
    tileRendering: true
  });

  // 8192 + 2*256 overscan is 8704, past the limit.
  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((issue) => issue.code === "TILE_EXCEEDS_TEXTURE_LIMIT"));
});

test("tiling config clamps to safe bounds", () => {
  const tiling = normalizeStageTiling({ tileWidth: 99_999, tileHeight: 4, overscan: -10 });
  assert.equal(tiling.tileWidth, 8192);
  assert.equal(tiling.tileHeight, 64);
  assert.equal(tiling.overscan, 0);
});

test("a legacy scene without a stage gets an implicit single-surface stage", () => {
  const scene = {
    id: "scene_1",
    name: "Lower Third",
    version: 1,
    canvas: { width: 1920, height: 1080, background: "#000000" },
    dataContext: {},
    assets: [],
    materials: [],
    objects: [],
    timeline: { fps: 50, durationFrames: 100, keyframes: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };

  const stage = implicitStageForScene(scene);
  assert.equal(stage.canvas.logicalWidth, 1920);
  assert.equal(stage.canvas.logicalHeight, 1080);
  assert.equal(stage.viewports.length, 1);
  assert.equal(stage.viewports[0].source.type, "full-stage");
  // A canvas-sized stage fits one texture, so the legacy single-target path is
  // preserved rather than forced through the tiler.
  assert.equal(stage.tiling.enabled, false);
  assert.equal(validateStageDocument(stage).valid, true);
});

test("createStageDocument produces a valid default stage", () => {
  const stage = createStageDocument({ name: "Default" });
  assert.equal(stage.canvas.logicalWidth, 1920);
  assert.equal(validateStageDocument(stage).valid, true);
  assert.equal(stage.version, 1);
});

test("intersectRects is exported for consumers that index the stage", () => {
  assert.deepEqual(
    intersectRects(rect(0, 0, 100, 100), rect(50, 50, 100, 100)),
    rect(50, 50, 50, 50)
  );
  const disjoint = intersectRects(rect(0, 0, 10, 10), rect(100, 100, 10, 10));
  assert.equal(disjoint.width, 0);
});

test("createVirtualCanvas is re-exported for stage-free consumers", () => {
  assert.equal(createVirtualCanvas(640, 480).logicalWidth, 640);
});
