import assert from "node:assert/strict";
import test from "node:test";

import { createStageDocument, rect } from "@grapix/stage-model";
import {
  createDisplaySurface,
  createSurfaceLayout,
  findSurfaceOverlaps,
  normalizeSurfaceLayout,
  stageToSurfaceLocal,
  stageToSurfacePixel,
  summarizeSurfaceLayout,
  surfaceCalibrationPending,
  surfaceCoverageBounds,
  surfaceDeviceSize,
  surfaceLocalToStage,
  surfaceLocalToUv,
  surfacePhysicalSize,
  surfacesForStageRect,
  surfaceSourceRect,
  surfaceStageBounds,
  toStagePlacements,
  totalSurfacePixels,
  validateSurfaceLayout
} from "../dist/index.js";

test("a ribbon surface maps stage coordinates onto device pixels", () => {
  const ribbon = createDisplaySurface("ribbon", {
    kind: "ribbon",
    position: { x: 0, y: 8_000 },
    size: { width: 50_000, height: 2_000 },
    deviceWidth: 15_360,
    deviceHeight: 614
  });

  assert.deepEqual(surfaceDeviceSize(ribbon), { width: 15_360, height: 614 });

  // Top-left of the ribbon.
  const origin = stageToSurfacePixel(ribbon, { x: 0, y: 8_000 });
  assert.deepEqual(origin, { x: 0, y: 0 });

  // Centre of the ribbon.
  const centre = stageToSurfacePixel(ribbon, { x: 25_000, y: 9_000 });
  assert.ok(Math.abs(centre.x - 7_680) < 1e-9);
  assert.ok(Math.abs(centre.y - 307) < 1e-9);

  // Off the surface entirely.
  assert.equal(stageToSurfacePixel(ribbon, { x: 25_000, y: 100 }), undefined);
});

test("surface-local coordinates round-trip through rotation", () => {
  const surface = createDisplaySurface("panel", {
    position: { x: 40_000, y: 20_000 },
    size: { width: 1_000, height: 500 },
    rotationDegrees: 30
  });

  const stagePoint = { x: 40_250, y: 20_125 };
  const local = stageToSurfaceLocal(surface, stagePoint);
  const back = surfaceLocalToStage(surface, local);

  assert.ok(Math.abs(back.x - stagePoint.x) < 1e-9);
  assert.ok(Math.abs(back.y - stagePoint.y) < 1e-9);
});

test("rotation grows the axis-aligned stage bounds", () => {
  const unrotated = createDisplaySurface("a", {
    position: { x: 0, y: 0 },
    size: { width: 1_000, height: 200 }
  });
  assert.deepEqual(surfaceStageBounds(unrotated), rect(0, 0, 1_000, 200));

  const rotated = createDisplaySurface("b", {
    position: { x: 0, y: 0 },
    size: { width: 1_000, height: 200 },
    rotationDegrees: 90
  });
  const bounds = surfaceStageBounds(rotated);
  // A 1000x200 panel turned on its side occupies 200x1000, centred where it was.
  assert.ok(Math.abs(bounds.width - 200) < 1e-9);
  assert.ok(Math.abs(bounds.height - 1_000) < 1e-9);
  assert.ok(Math.abs(bounds.x - 400) < 1e-9);
  assert.ok(Math.abs(bounds.y + 400) < 1e-9);
});

test("crop removes pixels outside the driven area", () => {
  const surface = createDisplaySurface("cropped", {
    position: { x: 0, y: 0 },
    size: { width: 1_000, height: 1_000 },
    crop: rect(100, 100, 800, 800)
  });

  assert.equal(stageToSurfacePixel(surface, { x: 50, y: 50 }), undefined);
  assert.notEqual(stageToSurfacePixel(surface, { x: 500, y: 500 }), undefined);
});

test("bezel compensation hides content behind monitor frames", () => {
  // A 2x2 video wall: each panel is 500x500 logical with a 10-unit frame.
  const wall = createDisplaySurface("wall", {
    kind: "multi-monitor",
    position: { x: 0, y: 0 },
    size: { width: 1_000, height: 1_000 },
    deviceWidth: 3_840,
    deviceHeight: 2_160,
    bezel: {
      mode: "compensate",
      topLogical: 10,
      rightLogical: 10,
      bottomLogical: 10,
      leftLogical: 10,
      columns: 2,
      rows: 2
    }
  });

  // Just inside the top-left panel's frame: hidden.
  assert.equal(stageToSurfacePixel(wall, { x: 5, y: 5 }), undefined);

  // First visible column of the top-left panel.
  const firstVisible = stageToSurfacePixel(wall, { x: 10, y: 10 });
  assert.deepEqual(firstVisible, { x: 0, y: 0 });

  // Centre of the top-left panel maps to the centre of its pixel quadrant.
  const panelCentre = stageToSurfacePixel(wall, { x: 250, y: 250 });
  assert.ok(Math.abs(panelCentre.x - 960) < 1e-9);
  assert.ok(Math.abs(panelCentre.y - 540) < 1e-9);

  // The gap between panels 1 and 2 is hidden.
  assert.equal(stageToSurfacePixel(wall, { x: 495, y: 250 }), undefined);
  assert.equal(stageToSurfacePixel(wall, { x: 505, y: 250 }), undefined);

  // Second panel starts at half the device width.
  const secondPanel = stageToSurfacePixel(wall, { x: 510, y: 250 });
  assert.ok(Math.abs(secondPanel.x - 1_920) < 1e-9);
});

test("ignoring bezels maps linearly with no hidden regions", () => {
  const wall = createDisplaySurface("wall", {
    size: { width: 1_000, height: 1_000 },
    deviceWidth: 2_000,
    deviceHeight: 2_000,
    bezel: {
      mode: "ignore",
      topLogical: 10,
      rightLogical: 10,
      bottomLogical: 10,
      leftLogical: 10,
      columns: 2,
      rows: 2
    }
  });

  assert.deepEqual(stageToSurfacePixel(wall, { x: 495, y: 250 }), { x: 990, y: 500 });
});

test("normalized UV mapping stretches an explicit stage rect over the surface", () => {
  const direct = createDisplaySurface("direct", {
    position: { x: 100, y: 100 },
    size: { width: 400, height: 200 }
  });
  assert.deepEqual(surfaceSourceRect(direct), rect(100, 100, 400, 200));

  const normalized = createDisplaySurface("stretch", {
    position: { x: 0, y: 5_000 },
    size: { width: 20_000, height: 500 },
    uvMapping: { mode: "normalized", source: rect(0, 0, 1_920, 1_080) }
  });
  // One 1920x1080 graphic feeds a 20,000-unit-wide ribbon.
  assert.deepEqual(surfaceSourceRect(normalized), rect(0, 0, 1_920, 1_080));
});

test("local UVs are normalised to the surface extent", () => {
  const surface = createDisplaySurface("s", { size: { width: 800, height: 400 } });
  assert.deepEqual(surfaceLocalToUv(surface, { x: 400, y: 100 }), { x: 0.5, y: 0.25 });
});

test("physical size follows pixel density", () => {
  const surface = createDisplaySurface("s", {
    size: { width: 3_840, height: 2_160 },
    pixelDensity: 0.384 // logical units per millimetre
  });
  const physical = surfacePhysicalSize(surface);
  assert.ok(Math.abs(physical.widthMillimetres - 10_000) < 1e-6);
});

test("surfaces are selected by stage rectangle in draw order", () => {
  const surfaces = [
    createDisplaySurface("far", { position: { x: 40_000, y: 0 }, size: { width: 1_000, height: 1_000 }, zOrder: 5 }),
    createDisplaySurface("near", { position: { x: 0, y: 0 }, size: { width: 1_000, height: 1_000 }, zOrder: 1 }),
    createDisplaySurface("mid", { position: { x: 500, y: 500 }, size: { width: 1_000, height: 1_000 }, zOrder: 3 })
  ];

  const hits = surfacesForStageRect(surfaces, rect(0, 0, 800, 800));
  assert.deepEqual(hits.map((surface) => surface.surfaceId), ["near", "mid"]);

  const none = surfacesForStageRect(surfaces, rect(20_000, 0, 100, 100));
  assert.equal(none.length, 0);
});

test("coverage bounds union every enabled surface", () => {
  const surfaces = [
    createDisplaySurface("a", { position: { x: 0, y: 0 }, size: { width: 1_000, height: 1_000 } }),
    createDisplaySurface("b", { position: { x: 49_000, y: 9_000 }, size: { width: 1_000, height: 1_000 } }),
    createDisplaySurface("off", {
      position: { x: -50_000, y: 0 },
      size: { width: 10, height: 10 },
      enabled: false
    })
  ];

  assert.deepEqual(surfaceCoverageBounds(surfaces), rect(0, 0, 50_000, 10_000));
});

test("overlaps are detected and classified by edge blending", () => {
  const plain = [
    createDisplaySurface("a", { position: { x: 0, y: 0 }, size: { width: 1_000, height: 1_000 } }),
    createDisplaySurface("b", { position: { x: 900, y: 0 }, size: { width: 1_000, height: 1_000 } })
  ];
  const overlaps = findSurfaceOverlaps(plain);
  assert.equal(overlaps.length, 1);
  assert.deepEqual(overlaps[0].bounds, rect(900, 0, 100, 1_000));

  const layout = normalizeSurfaceLayout({ stageId: "stage_1", surfaces: plain });
  const validation = validateSurfaceLayout(layout);
  assert.ok(validation.issues.some((issue) => issue.code === "SURFACE_OVERLAP"));

  const blended = normalizeSurfaceLayout({
    stageId: "stage_1",
    surfaces: [
      plain[0],
      {
        ...plain[1],
        edgeBlend: { enabled: true, leftLogical: 100, topLogical: 0, rightLogical: 0, bottomLogical: 0, gamma: 2 }
      }
    ]
  });
  const blendedValidation = validateSurfaceLayout(blended);
  assert.ok(blendedValidation.issues.some((issue) => issue.code === "SURFACE_BLEND_OVERLAP"));
  assert.ok(!blendedValidation.issues.some((issue) => issue.code === "SURFACE_OVERLAP"));
});

test("declared warp and edge blend are never reported as implemented", () => {
  const surface = createDisplaySurface("projector", {
    kind: "projection",
    warp: { mode: "grid", columns: 3, rows: 3 },
    edgeBlend: { enabled: true, leftLogical: 50, topLogical: 0, rightLogical: 0, bottomLogical: 0, gamma: 2.2 }
  });

  assert.equal(surface.warp.implemented, false);
  assert.equal(surface.edgeBlend.implemented, false);
  assert.equal(surfaceCalibrationPending(surface), true);

  const layout = normalizeSurfaceLayout({ stageId: "s", surfaces: [surface] });
  const validation = validateSurfaceLayout(layout);
  assert.ok(validation.issues.some((issue) => issue.code === "CALIBRATION_NOT_IMPLEMENTED"));
  // Info-level: the layout is still usable, just uncalibrated.
  assert.equal(validation.valid, true);
});

test("a warp grid with the wrong control-point count is an error", () => {
  const layout = normalizeSurfaceLayout({
    stageId: "s",
    surfaces: [
      createDisplaySurface("p", {
        warp: { mode: "grid", columns: 3, rows: 3, controlPoints: [{ x: 0, y: 0 }] }
      })
    ]
  });

  const validation = validateSurfaceLayout(layout);
  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((issue) => issue.code === "WARP_GRID_MISMATCH"));
});

test("layout validation catches missing colour profiles and outputs", () => {
  const stage = createStageDocument({ stageId: "stage_1" });
  const layout = normalizeSurfaceLayout({
    stageId: "stage_1",
    surfaces: [
      createDisplaySurface("s", { colorProfileRef: "ghost", outputId: "nowhere" })
    ]
  });

  const validation = validateSurfaceLayout(layout, stage);
  assert.equal(validation.valid, false);
  const codes = validation.issues.map((issue) => issue.code);
  assert.ok(codes.includes("SURFACE_PROFILE_MISSING"));
  assert.ok(codes.includes("SURFACE_OUTPUT_MISSING"));
});

test("a layout validated against the wrong stage is rejected", () => {
  const stage = createStageDocument({ stageId: "stage_a" });
  const layout = createSurfaceLayout("stage_b");
  const validation = validateSurfaceLayout(layout, stage);

  assert.equal(validation.valid, false);
  assert.ok(validation.issues.some((issue) => issue.code === "LAYOUT_STAGE_MISMATCH"));
});

test("surfaces narrow to stage placements without drifting", () => {
  const layout = normalizeSurfaceLayout({
    stageId: "stage_1",
    surfaces: [
      createDisplaySurface("s", {
        position: { x: 12.5, y: 34.75 },
        size: { width: 400, height: 200 },
        rotationDegrees: 15,
        outputId: "out"
      })
    ]
  });

  const placements = toStagePlacements(layout);
  assert.equal(placements.length, 1);
  assert.deepEqual(placements[0].position, { x: 12.5, y: 34.75 });
  assert.equal(placements[0].rotationDegrees, 15);
  assert.equal(placements[0].outputId, "out");
});

test("layout summary counts pixels, kinds, and pending calibration", () => {
  const layout = normalizeSurfaceLayout({
    stageId: "stage_1",
    surfaces: [
      createDisplaySurface("led", { kind: "led-wall", deviceWidth: 3_840, deviceHeight: 2_160 }),
      createDisplaySurface("proj", {
        kind: "projection",
        deviceWidth: 1_920,
        deviceHeight: 1_080,
        warp: { mode: "mesh", columns: 2, rows: 2 }
      }),
      createDisplaySurface("dark", { kind: "ribbon", enabled: false })
    ]
  });

  const summary = summarizeSurfaceLayout(layout);
  assert.equal(summary.surfaceCount, 3);
  assert.equal(summary.enabledSurfaceCount, 2);
  assert.equal(summary.totalDevicePixels, 3_840 * 2_160 + 1_920 * 1_080);
  assert.equal(summary.kinds["led-wall"], 1);
  assert.equal(summary.calibrationPendingCount, 1);
  assert.equal(totalSurfacePixels(layout.surfaces), summary.totalDevicePixels);
});

test("normalisation is deterministic and idempotent", () => {
  const once = normalizeSurfaceLayout({
    stageId: "s",
    surfaces: [createDisplaySurface("a", { kind: "stadium", pixelDensity: 0.5 })]
  });
  assert.deepEqual(normalizeSurfaceLayout(once), once);
});

test("unknown surface kinds fall back to a documented default", () => {
  const surface = createDisplaySurface("s", { kind: "hologram" });
  assert.equal(surface.kind, "led-wall");
});
