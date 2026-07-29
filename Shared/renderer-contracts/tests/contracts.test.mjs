import assert from "node:assert/strict";
import test from "node:test";

import {
  BROWSER_BACKEND_PREFERENCE,
  selectBrowserBackend,
  validateRenderGraph
} from "../dist/index.js";

test("the browser backend preference order is WebGL, then WebGPU, then Canvas", () => {
  assert.deepEqual([...BROWSER_BACKEND_PREFERENCE], ["webgl", "webgpu", "canvas2d"]);
});

test("WebGL is the default even when WebGPU is available but not enabled", () => {
  const selection = selectBrowserBackend({
    webglAvailable: true,
    webgpuAvailable: true,
    webgpuEnabled: false,
    canvas2dAvailable: true
  });

  // "The API exists" is not "it has been tested with this content".
  assert.equal(selection.kind, "webgl");
  assert.equal(selection.degraded, false);
});

test("WebGPU is chosen only when explicitly enabled", () => {
  const enabled = selectBrowserBackend({
    webglAvailable: true,
    webgpuAvailable: true,
    webgpuEnabled: true,
    canvas2dAvailable: true
  });
  assert.equal(enabled.kind, "webgpu");
  assert.equal(enabled.degraded, false);

  // Enabled but unavailable falls back to WebGL without complaint.
  const unavailable = selectBrowserBackend({
    webglAvailable: true,
    webgpuAvailable: false,
    webgpuEnabled: true,
    canvas2dAvailable: true
  });
  assert.equal(unavailable.kind, "webgl");
});

test("falling back past WebGL is always marked degraded", () => {
  const webgpuFallback = selectBrowserBackend({
    webglAvailable: false,
    webgpuAvailable: true,
    webgpuEnabled: false,
    canvas2dAvailable: true
  });
  assert.equal(webgpuFallback.kind, "webgpu");
  assert.equal(webgpuFallback.degraded, true);

  const canvas = selectBrowserBackend({
    webglAvailable: false,
    webgpuAvailable: false,
    webgpuEnabled: false,
    canvas2dAvailable: true
  });
  assert.equal(canvas.kind, "canvas2d");
  assert.equal(canvas.degraded, true);
  // The operator is told what they lose.
  assert.ok(canvas.reason.includes("filters"));
  assert.ok(canvas.reason.includes("3D"));
});

test("no backend at all returns undefined rather than a lie", () => {
  assert.equal(
    selectBrowserBackend({
      webglAvailable: false,
      webgpuAvailable: false,
      webgpuEnabled: false,
      canvas2dAvailable: false
    }),
    undefined
  );
});

// ---------------------------------------------------------------------------
// Render graph
// ---------------------------------------------------------------------------

function pass(passId, kind, reads, writes) {
  return {
    passId,
    kind,
    reads,
    writes,
    logicalBounds: { x: 0, y: 0, width: 1920, height: 1080 },
    localOrigin: { x: 0, y: 0 },
    renderScale: 1
  };
}

test("a tile-then-composite graph validates and orders correctly", () => {
  const graph = [
    pass("composite", "composite", ["tile:0:0", "tile:1:0"], ["viewport:program"]),
    pass("tile-a", "tile", [], ["tile:0:0"]),
    pass("tile-b", "tile", [], ["tile:1:0"]),
    pass("output", "output", ["viewport:program"], ["output:program"])
  ];

  const validation = validateRenderGraph(graph);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));

  // Tiles before the composite, composite before the output.
  const order = validation.order;
  assert.ok(order.indexOf("tile-a") < order.indexOf("composite"));
  assert.ok(order.indexOf("tile-b") < order.indexOf("composite"));
  assert.ok(order.indexOf("composite") < order.indexOf("output"));
});

test("a cycle is reported rather than hanging at draw time", () => {
  const validation = validateRenderGraph([
    pass("a", "tile", ["r:b"], ["r:a"]),
    pass("b", "tile", ["r:a"], ["r:b"])
  ]);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.startsWith("cycle among passes")));
});

test("reading a resource nothing writes is an error", () => {
  const validation = validateRenderGraph([pass("only", "composite", ["tile:9:9"], ["out"])]);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes('reads "tile:9:9"')));
});

test("two passes writing the same resource is an error", () => {
  const validation = validateRenderGraph([
    pass("a", "tile", [], ["shared"]),
    pass("b", "tile", [], ["shared"])
  ]);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes("written by both")));
});

test("duplicate pass ids are rejected", () => {
  const validation = validateRenderGraph([
    pass("same", "tile", [], ["a"]),
    pass("same", "tile", [], ["b"])
  ]);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.includes("duplicate pass ids"));
});

test("a pass may read what it writes without being a cycle", () => {
  // Ping-pong within one pass, e.g. accumulating into its own target.
  const validation = validateRenderGraph([pass("accumulate", "tile", ["acc"], ["acc"])]);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.order, ["accumulate"]);
});

test("an empty graph is valid", () => {
  const validation = validateRenderGraph([]);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.order, []);
});
