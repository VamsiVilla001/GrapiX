import assert from "node:assert/strict";
import test from "node:test";

import { createStageDocument, normalizeStageDocument, rect } from "@grapix/stage-model";
import type { SceneDocument } from "@grapix/shared-types";

import {
  assertOverlayIsEditorOnly,
  buildDiagnosticsOverlay,
  logicalToScreen
} from "../src/rendering/diagnosticsOverlay.js";
import {
  CANVAS_LOST_CAPABILITIES,
  describeBackendSelection,
  isBackendRepresentative,
  selectEditorBackend
} from "../src/rendering/rendererPreference.js";
import { sceneRequirements, stageRequirements } from "../src/rendering/engineClient.js";

// ---------------------------------------------------------------------------
// Renderer preference policy
// ---------------------------------------------------------------------------

const allAvailable = { webgl: true, webgpu: true, canvas: true };

test("WebGL is the default even when WebGPU is available", () => {
  const selection = selectEditorBackend({ availability: allAvailable });

  // "The API exists" is not "it has been tested with this content".
  assert.equal(selection?.kind, "webgl");
  assert.equal(selection?.pixiPreference, "webgl");
  assert.equal(selection?.degraded, false);
  assert.equal(isBackendRepresentative(selection!), true);
  // A healthy default says nothing to the operator.
  assert.equal(describeBackendSelection(selection!), "");
});

test("WebGPU is used only when explicitly enabled", () => {
  const enabled = selectEditorBackend({
    availability: allAvailable,
    enableWebGpu: true
  });
  assert.equal(enabled?.kind, "webgpu");
  assert.equal(enabled?.pixiPreference, "webgpu");
  assert.equal(enabled?.degraded, false);

  // Enabled but unavailable falls back to WebGL without complaint.
  const unavailable = selectEditorBackend({
    availability: { webgl: true, webgpu: false, canvas: true },
    enableWebGpu: true
  });
  assert.equal(unavailable?.kind, "webgl");
  assert.equal(unavailable?.degraded, false);
});

test("falling back past WebGL is always marked degraded", () => {
  const webgpuFallback = selectEditorBackend({
    availability: { webgl: false, webgpu: true, canvas: true }
  });
  assert.equal(webgpuFallback?.kind, "webgpu");
  assert.equal(webgpuFallback?.degraded, true);
  assert.equal(isBackendRepresentative(webgpuFallback!), false);
});

test("the Canvas fallback names exactly what the operator is not seeing", () => {
  const canvas = selectEditorBackend({
    availability: { webgl: false, webgpu: false, canvas: true }
  });

  assert.equal(canvas?.kind, "canvas");
  assert.equal(canvas?.degraded, true);
  assert.deepEqual(canvas?.lostCapabilities, [...CANVAS_LOST_CAPABILITIES]);

  const message = describeBackendSelection(canvas!);
  assert.ok(message.includes("degraded"));
  assert.ok(message.includes("filters"));
  assert.ok(message.includes("3D"));
  // And it says who is actually authoritative.
  assert.ok(message.includes("standalone render engine remains authoritative"));
});

test("no backend at all returns undefined rather than a blank viewport", () => {
  assert.equal(
    selectEditorBackend({ availability: { webgl: false, webgpu: false, canvas: false } }),
    undefined
  );
});

// ---------------------------------------------------------------------------
// Diagnostic overlay
// ---------------------------------------------------------------------------

/** The requirement-5 stage: 50,000 x 10,000 with regions, a ribbon, and outputs. */
function arenaStage() {
  return normalizeStageDocument({
    stageId: "stage_arena",
    canvas: { logicalWidth: 50_000, logicalHeight: 10_000 },
    regions: [
      { regionId: "region_left", name: "Left", bounds: rect(0, 0, 3840, 2160) },
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
      {
        viewportId: "vp_operator",
        name: "Operator",
        source: { type: "full-stage" },
        renderScale: 0.0384
      }
    ],
    cameras: [
      {
        cameraId: "cam_left",
        name: "Left camera",
        viewportId: "vp_left",
        projection: "orthographic",
        orthographic: { logicalWidth: 3840 }
      }
    ],
    outputs: [{ outputId: "output_a", name: "Output A", width: 3840, height: 2160 }],
    safeAreas: [
      {
        safeAreaId: "safe_title",
        name: "Title safe",
        kind: "title",
        insets: { top: 54, right: 96, bottom: 54, left: 96 }
      }
    ],
    tiling: { tileWidth: 2048, tileHeight: 2048, overscan: 32 }
  });
}

/** Looking at the top-left 4096 x 2048 of the stage in a 1024 x 512 element. */
const view = {
  visibleLogical: rect(0, 0, 4096, 2048),
  screenWidth: 1024,
  screenHeight: 512
};

test("logical coordinates map to screen pixels", () => {
  assert.deepEqual(logicalToScreen(view, rect(0, 0, 4096, 2048)), {
    x: 0,
    y: 0,
    width: 1024,
    height: 512
  });
  // Quarter scale in both axes.
  assert.deepEqual(logicalToScreen(view, rect(2048, 1024, 2048, 1024)), {
    x: 512,
    y: 256,
    width: 512,
    height: 256
  });
});

test("the overlay is empty until a diagnostic is switched on", () => {
  const result = buildDiagnosticsOverlay(arenaStage(), view);

  // Tile boundaries are a diagnostic, not chrome.
  assert.deepEqual(result.shapes, []);
  // But the visible tile count is always reported for the status bar.
  assert.equal(result.visibleTileCount, 2);
});

test("tile boundaries cover only the visible window", () => {
  const stage = arenaStage();
  const result = buildDiagnosticsOverlay(stage, view, { showTiles: true, showLabels: true });

  // The 50,000 x 10,000 stage has 125 tiles at 2048; the visible window touches 2.
  assert.equal(result.visibleTileCount, 2);
  assert.equal(result.shapes.length, 2);
  assert.deepEqual(
    result.shapes.map((shape) => shape.id).sort(),
    ["tile:t:0:0", "tile:t:1:0"]
  );
  assert.equal(result.shapes[0].label, "t:0:0");
  assert.equal(result.tilesTruncated, false);
});

test("dirty tiles are distinguishable from clean ones", () => {
  const result = buildDiagnosticsOverlay(arenaStage(), view, {
    showTiles: true,
    dirtyTileIds: ["t:1:0"]
  });

  const kinds = new Map(result.shapes.map((shape) => [shape.id, shape.kind]));
  assert.equal(kinds.get("tile:t:0:0"), "tile");
  assert.equal(kinds.get("tile:t:1:0"), "tile-dirty");
});

test("tile generation is capped and says when it truncated", () => {
  const stage = arenaStage();
  // Look at the whole stage: 25 x 5 = 125 tiles.
  const wholeStage = {
    visibleLogical: rect(0, 0, 50_000, 10_000),
    screenWidth: 1920,
    screenHeight: 384
  };

  const capped = buildDiagnosticsOverlay(stage, wholeStage, {
    showTiles: true,
    maxTileShapes: 10
  });

  // An SVG node per tile would make the overlay slower than the renderer.
  assert.equal(capped.visibleTileCount, 125);
  assert.equal(capped.shapes.length, 10);
  assert.equal(capped.tilesTruncated, true);

  const uncapped = buildDiagnosticsOverlay(stage, wholeStage, {
    showTiles: true,
    maxTileShapes: 500
  });
  assert.equal(uncapped.shapes.length, 125);
  assert.equal(uncapped.tilesTruncated, false);
});

test("a viewport with a camera bound to it is drawn as a camera frame", () => {
  const result = buildDiagnosticsOverlay(arenaStage(), view, {
    showViewports: true,
    showLabels: true
  });

  const left = result.shapes.find((shape) => shape.id === "viewport:vp_left");
  assert.equal(left?.kind, "camera-frame");
  assert.equal(left?.label, "Left camera (orthographic)");

  // The operator viewport has no camera, so it stays a plain viewport, and its
  // render scale is shown because that is what makes it a preview.
  const operator = result.shapes.find((shape) => shape.id === "viewport:vp_operator");
  assert.equal(operator?.kind, "viewport");
  assert.ok(operator?.label?.includes("0.0384"));
});

test("surfaces show their output assignment, or that they lack one", () => {
  const stage = arenaStage();
  const assigned = buildDiagnosticsOverlay(stage, view, {
    showSurfaces: true,
    showLabels: true
  });
  // The ribbon sits at y 8000, outside the visible window.
  assert.equal(assigned.shapes.length, 0);

  const ribbonView = {
    visibleLogical: rect(0, 7_000, 4096, 3_000),
    screenWidth: 1024,
    screenHeight: 750
  };
  const visible = buildDiagnosticsOverlay(stage, ribbonView, {
    showSurfaces: true,
    showLabels: true
  });
  assert.equal(visible.shapes.length, 1);
  assert.equal(visible.shapes[0].label, "Ribbon → output_a");

  const unassigned = normalizeStageDocument({
    ...stage,
    surfaces: [{ surfaceId: "s", name: "Loose panel", size: { width: 500, height: 500 } }]
  });
  const loose = buildDiagnosticsOverlay(unassigned, view, {
    showSurfaces: true,
    showLabels: true
  });
  assert.ok(loose.shapes[0].label?.includes("unassigned"));
});

test("regions and safe areas are drawn when asked for", () => {
  const result = buildDiagnosticsOverlay(arenaStage(), view, {
    showRegions: true,
    showSafeAreas: true,
    showLabels: true
  });

  const region = result.shapes.find((shape) => shape.id === "region:region_left");
  assert.equal(region?.kind, "region");
  assert.equal(region?.label, "Left");
  // The far-right region is outside the visible window.
  assert.equal(
    result.shapes.some((shape) => shape.id === "region:region_right"),
    false
  );

  const safeArea = result.shapes.find((shape) => shape.id === "safe:safe_title");
  assert.equal(safeArea?.kind, "safe-area");
});

test("every overlay shape is marked editor-only", () => {
  const result = buildDiagnosticsOverlay(arenaStage(), view, {
    showTiles: true,
    showSurfaces: true,
    showRegions: true,
    showViewports: true,
    showSafeAreas: true
  });

  assert.ok(result.shapes.length > 0);
  // Structural, not a runtime flag: nothing here builds a renderable object.
  assert.ok(result.shapes.every((shape) => shape.editorOnly === true));
  assert.doesNotThrow(() => assertOverlayIsEditorOnly(result.shapes));

  // And the invariant check actually catches a violation.
  assert.throws(
    () =>
      assertOverlayIsEditorOnly([
        { ...result.shapes[0], editorOnly: false as unknown as true }
      ]),
    /must never reach Preview or Program/
  );
});

test("a stage with tiling disabled produces no tile shapes", () => {
  const stage = normalizeStageDocument({
    stageId: "s",
    canvas: { logicalWidth: 1920, logicalHeight: 1080 },
    tiling: { enabled: false }
  });

  const result = buildDiagnosticsOverlay(
    stage,
    { visibleLogical: rect(0, 0, 1920, 1080), screenWidth: 960, screenHeight: 540 },
    { showTiles: true }
  );

  assert.deepEqual(result.shapes, []);
  assert.equal(result.visibleTileCount, 0);
});

// ---------------------------------------------------------------------------
// Capability requirement derivation
// ---------------------------------------------------------------------------

test("stage requirements are derived from the stage document", () => {
  const requirements = stageRequirements(arenaStage());

  assert.equal(requirements.logicalWidth, 50_000);
  assert.equal(requirements.logicalHeight, 10_000);
  assert.equal(requirements.tilingEnabled, true);
  assert.equal(requirements.tileWidth, 2048);
  assert.equal(requirements.overscan, 32);
  assert.equal(requirements.surfaceCount, 1);
  assert.equal(requirements.outputCount, 1);
  assert.deepEqual(requirements.requiredOutputAdapters, ["null"]);
});

test("a default stage needs no tiling", () => {
  const requirements = stageRequirements(createStageDocument({ name: "HD" }));
  assert.equal(requirements.logicalWidth, 1920);
  assert.equal(requirements.tilingEnabled, true);
  assert.deepEqual(requirements.requiredOutputAdapters, []);
});

test("scene requirements report what the engine must support", () => {
  const scene: SceneDocument = {
    id: "scene_1",
    name: "Mixed",
    version: 1,
    canvas: { width: 1920, height: 1080, background: "#000000" },
    dataContext: {},
    assets: [
      {
        assetId: "a_video",
        name: "clip",
        kind: "video",
        source: "clip.mp4",
        importedAt: "2026-01-01T00:00:00.000Z"
      }
    ],
    materials: [],
    objects: [
      {
        id: "t",
        name: "Title",
        type: "text",
        x: 0,
        y: 0,
        zDepth: 0,
        zIndex: 0,
        layerId: "l",
        visible: true
      } as SceneDocument["objects"][number],
      {
        id: "m",
        name: "Cube",
        type: "mesh",
        x: 0,
        y: 0,
        zDepth: 0,
        zIndex: 1,
        layerId: "l",
        visible: true
      } as SceneDocument["objects"][number]
    ],
    timeline: {
      fps: 50,
      durationFrames: 100,
      keyframes: [],
      markers: [
        { markerId: "m1", name: "Hold", kind: "continue-point", frame: 25 }
      ]
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };

  const requirements = sceneRequirements(scene);

  assert.equal(requirements.sceneDocumentVersion, 1);
  assert.deepEqual(requirements.objectTypes.sort(), ["mesh", "text"]);
  assert.equal(requirements.usesNativeText, true);
  assert.equal(requirements.uses3d, true);
  assert.equal(requirements.usesVideo, true);
  assert.equal(requirements.assetCount, 1);
  // A continue point means the scene expects transition handling.
  assert.deepEqual(requirements.transitionKinds, ["cut"]);
});
