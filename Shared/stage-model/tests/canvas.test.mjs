import assert from "node:assert/strict";
import test from "node:test";

import {
  canvasBounds,
  canvasOriginPoint,
  canvasToNormalized,
  createVirtualCanvas,
  exceedsSingleTextureLimit,
  f32Error,
  f32Spacing,
  fullResolutionByteEstimate,
  localF32Error,
  logicalUnitsPerMillimetre,
  MAX_LOGICAL_CANVAS_DIMENSION,
  narrowRectToF32,
  normalizedToCanvas,
  normalizeVirtualCanvas,
  rect,
  stageToLocalPoint,
  stageToLocalRect
} from "../dist/index.js";

test("supports a 50000 x 50000 logical canvas without allocating anything", () => {
  const canvas = createVirtualCanvas(50_000, 50_000);

  assert.equal(canvas.logicalWidth, 50_000);
  assert.equal(canvas.logicalHeight, 50_000);
  assert.equal(MAX_LOGICAL_CANVAS_DIMENSION, 50_000);

  // The reason tiling is mandatory: one stage-sized RGBA8 target is 10 GB.
  assert.equal(fullResolutionByteEstimate(canvas), 10_000_000_000);
  assert.equal(exceedsSingleTextureLimit(canvas, 16_384), true);
  assert.equal(exceedsSingleTextureLimit(canvas, 65_536), false);
});

test("clamps canvas dimensions to the documented range", () => {
  assert.equal(normalizeVirtualCanvas({ logicalWidth: 120_000 }).logicalWidth, 50_000);
  assert.equal(normalizeVirtualCanvas({ logicalWidth: 0 }).logicalWidth, 1920);
  assert.equal(normalizeVirtualCanvas({ logicalWidth: -5 }).logicalWidth, 1920);
  assert.equal(normalizeVirtualCanvas({ logicalHeight: Number.NaN }).logicalHeight, 1080);
});

test("normalisation is deterministic and idempotent", () => {
  const once = normalizeVirtualCanvas({ logicalWidth: 50_000, logicalHeight: 10_000 });
  const twice = normalizeVirtualCanvas(once);
  assert.deepEqual(twice, once);
});

test("origin anchor changes the coordinate space, not the size", () => {
  const topLeft = createVirtualCanvas(50_000, 10_000);
  assert.deepEqual(canvasBounds(topLeft), rect(0, 0, 50_000, 10_000));

  const centered = createVirtualCanvas(50_000, 10_000, { origin: { anchor: "center", offsetX: 0, offsetY: 0 } });
  assert.deepEqual(canvasBounds(centered), rect(-25_000, -5_000, 50_000, 10_000));
  assert.deepEqual(canvasOriginPoint(centered), { x: -25_000, y: -5_000 });

  const custom = createVirtualCanvas(1920, 1080, {
    origin: { anchor: "custom", offsetX: 100, offsetY: 50 }
  });
  assert.deepEqual(canvasBounds(custom), rect(-100, -50, 1920, 1080));
});

test("normalised coordinates round-trip through any origin", () => {
  const centered = createVirtualCanvas(50_000, 10_000, {
    origin: { anchor: "center", offsetX: 0, offsetY: 0 }
  });

  assert.deepEqual(canvasToNormalized(centered, { x: -25_000, y: -5_000 }), { x: 0, y: 0 });
  assert.deepEqual(canvasToNormalized(centered, { x: 25_000, y: 5_000 }), { x: 1, y: 1 });
  assert.deepEqual(normalizedToCanvas(centered, { x: 0.5, y: 0.5 }), { x: 0, y: 0 });
});

test("rebasing onto a tile origin recovers precision the GPU would otherwise lose", () => {
  // A coordinate near the far edge of a 50,000 unit stage.
  const absolute = 49_999.37;
  const tileOrigin = 49_152; // column 24 of a 2048 grid

  const absoluteError = f32Error(absolute);
  const localError = localF32Error(absolute, tileOrigin);

  // Float32 near 50,000 steps in units of 2^-8, so absolute coordinates are
  // wrong by roughly a thousandth of a pixel before any transform compounds it.
  assert.ok(absoluteError > 1e-4, `expected absolute f32 error > 1e-4, got ${absoluteError}`);

  // After the f64 subtraction the magnitude is under 1024, where float32 steps
  // in units of 2^-14.
  assert.ok(localError < 1e-4, `expected local f32 error < 1e-4, got ${localError}`);
  assert.ok(
    absoluteError / localError > 32,
    `expected at least 32x improvement, got ${absoluteError / localError}`
  );
});

test("f32 spacing grows with magnitude as documented", () => {
  assert.equal(f32Spacing(50_000), Math.pow(2, 15 - 23));
  assert.equal(f32Spacing(1_000), Math.pow(2, 9 - 23));
  assert.ok(f32Spacing(50_000) > f32Spacing(1_000));
});

test("stageToLocalRect subtracts in double precision and preserves extent", () => {
  const source = rect(49_999.37, 24_999.81, 640, 360);
  const local = stageToLocalRect(source, { x: 49_152, y: 24_576 });

  assert.equal(local.width, 640);
  assert.equal(local.height, 360);
  assert.ok(Math.abs(local.x - 847.37) < 1e-9);
  assert.ok(Math.abs(local.y - 423.81) < 1e-9);

  // Narrowing the rebased rect keeps sub-thousandth-pixel accuracy.
  const narrowed = narrowRectToF32(local);
  assert.ok(Math.abs(narrowed.x - local.x) < 1e-4);
  assert.ok(Math.abs(narrowed.y - local.y) < 1e-4);
});

test("stageToLocalPoint is exact for the tile origin itself", () => {
  const origin = { x: 49_152, y: 24_576 };
  assert.deepEqual(stageToLocalPoint({ x: 49_152, y: 24_576 }, origin), { x: 0, y: 0 });
});

test("physical measurements convert to logical units per millimetre", () => {
  const canvas = createVirtualCanvas(50_000, 10_000);
  const density = logicalUnitsPerMillimetre(canvas, {
    widthMillimetres: 100_000,
    heightMillimetres: 20_000
  });

  assert.deepEqual(density, { x: 0.5, y: 0.5 });
  assert.equal(
    logicalUnitsPerMillimetre(canvas, { widthMillimetres: 0, heightMillimetres: 0 }),
    undefined
  );
});
