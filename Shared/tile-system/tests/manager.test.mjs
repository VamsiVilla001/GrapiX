import assert from "node:assert/strict";
import test from "node:test";

import { createVirtualCanvas, normalizeStageTiling, rect } from "@grapix/stage-model";
import {
  createTileGrid,
  objectRectInTile,
  planFullStageComposite,
  planTileComposite,
  TileManager,
  TileObjectIndex,
  tileClipRect,
  tileCompositeRect,
  tileLocalOrigin,
  tileSourceRect,
  verifySeamlessCoverage
} from "../dist/index.js";

function makeGrid(width, height, tileSize = 2048, overscan = 0) {
  return createTileGrid(
    createVirtualCanvas(width, height),
    normalizeStageTiling({ tileWidth: tileSize, tileHeight: tileSize, overscan })
  );
}

function makeManager(options = {}) {
  const {
    width = 8192,
    height = 8192,
    tileSize = 2048,
    overscan = 0,
    ...rest
  } = options;
  return new TileManager({ grid: makeGrid(width, height, tileSize, overscan), ...rest });
}

// ---------------------------------------------------------------------------
// Object index
// ---------------------------------------------------------------------------

test("the index reports exactly which tiles an object entered and left", () => {
  const index = new TileObjectIndex(makeGrid(8192, 8192, 2048));

  const first = index.upsert({ objectId: "a", bounds: rect(0, 0, 100, 100) });
  assert.deepEqual(first.entered, ["t:0:0"]);
  assert.deepEqual(first.left, []);

  // Move it into the neighbouring tile.
  const moved = index.upsert({ objectId: "a", bounds: rect(3000, 0, 100, 100) });
  assert.deepEqual(moved.entered, ["t:1:0"]);
  assert.deepEqual(moved.left, ["t:0:0"]);

  // Move within the same tile: membership unchanged, but pixels changed.
  const nudged = index.upsert({ objectId: "a", bounds: rect(3010, 0, 100, 100) });
  assert.deepEqual(nudged.entered, []);
  assert.deepEqual(nudged.left, []);
  assert.equal(nudged.movedWithinTiles, true);

  // Identical update: nothing changed at all.
  const same = index.upsert({ objectId: "a", bounds: rect(3010, 0, 100, 100) });
  assert.equal(same.movedWithinTiles, false);
});

test("removing an object frees its tiles", () => {
  const index = new TileObjectIndex(makeGrid(4096, 4096, 2048));
  index.upsert({ objectId: "a", bounds: rect(0, 0, 100, 100) });

  const delta = index.remove("a");
  assert.deepEqual(delta.left, ["t:0:0"]);
  assert.equal(index.objectCount, 0);
  assert.equal(index.occupiedTileCount, 0);
  assert.deepEqual(index.objectsInTile("t:0:0"), []);

  // Removing again is a no-op, not an error.
  assert.deepEqual(index.remove("a").left, []);
});

test("filter extent widens an object's tile footprint", () => {
  const index = new TileObjectIndex(makeGrid(8192, 8192, 2048));

  // Well inside tile 0,0 geometrically.
  const plain = index.upsert({ objectId: "a", bounds: rect(1900, 1900, 100, 100) });
  assert.deepEqual(plain.entered, ["t:0:0"]);

  // A 60-unit blur pushes it across the boundary at 2048.
  const blurred = index.upsert({
    objectId: "b",
    bounds: rect(1900, 1900, 100, 100),
    filters: [{ kind: "gaussian-blur", sigma: 20 }]
  });
  assert.deepEqual(blurred.entered.sort(), ["t:0:0", "t:0:1", "t:1:0", "t:1:1"]);
  assert.equal(index.get("b").filterExtent, 60);
});

test("tile overscan is the largest filter extent among its objects", () => {
  const index = new TileObjectIndex(makeGrid(4096, 4096, 2048, 0));

  index.upsert({ objectId: "small", bounds: rect(100, 100, 10, 10), filterExtent: 8 });
  index.upsert({ objectId: "large", bounds: rect(200, 200, 10, 10), filterExtent: 48 });

  assert.equal(index.requiredOverscan("t:0:0"), 48);
  // A grid minimum floors the result.
  assert.equal(index.requiredOverscan("t:0:0", 64), 64);
  // An empty tile just returns the minimum.
  assert.equal(index.requiredOverscan("t:1:1", 16), 16);
});

test("the index answers spatial queries and flags multi-tile objects", () => {
  const index = new TileObjectIndex(makeGrid(8192, 8192, 2048));

  index.upsert({ objectId: "corner", bounds: rect(0, 0, 50, 50) });
  index.upsert({ objectId: "straddle", bounds: rect(2000, 2000, 100, 100) });
  index.upsert({ objectId: "far", bounds: rect(7000, 7000, 50, 50) });

  assert.deepEqual(index.objectsInRect(rect(0, 0, 100, 100)), ["corner"]);
  assert.deepEqual(index.objectsInRect(rect(2050, 2050, 10, 10)), ["straddle"]);
  assert.deepEqual(index.objectsInRect(rect(4100, 4100, 10, 10)), []);

  assert.deepEqual(index.multiTileObjects(), ["straddle"]);
  assert.deepEqual(index.contentBounds(), rect(0, 0, 7050, 7050));
  assert.deepEqual(index.tilesForObject("corner"), ["t:0:0"]);
});

// ---------------------------------------------------------------------------
// Selection and culling
// ---------------------------------------------------------------------------

test("only tiles an active consumer asks for are selected", () => {
  const manager = makeManager({ width: 50_000, height: 50_000, tileSize: 2048 });
  assert.equal(manager.grid.columns * manager.grid.rows, 625);

  const selection = manager.selectTiles({
    frame: 0,
    viewports: [rect(0, 0, 3840, 2160)]
  });

  // A UHD viewport touches 2x2 tiles of a 2048 grid.
  assert.equal(selection.required.length, 4);
  assert.equal(selection.culledCount, 621);
  // The manager allocated descriptors for four tiles, not 625.
  assert.equal(manager.stats().trackedTiles, 4);
});

test("selection reasons record why each tile was chosen", () => {
  const manager = makeManager({ width: 8192, height: 8192, tileSize: 2048 });

  const selection = manager.selectTiles({
    frame: 1,
    viewports: [rect(0, 0, 100, 100)],
    outputs: [rect(0, 0, 100, 100)],
    previews: [rect(2100, 0, 100, 100)]
  });

  assert.deepEqual(selection.reasons.get("t:0:0").sort(), ["dirty", "output", "viewport"]);
  assert.deepEqual(selection.reasons.get("t:1:0").sort(), ["dirty", "preview"]);
});

test("render-on-change: a clean tile is required but not re-rendered", () => {
  const manager = makeManager({ width: 4096, height: 4096, tileSize: 2048 });
  const viewport = [rect(0, 0, 100, 100)];

  const first = manager.selectTiles({ frame: 0, viewports: viewport });
  assert.equal(first.toRender.length, 1);

  manager.beginRender(["t:0:0"]);
  manager.completeRender("t:0:0", 0);

  // Nothing changed, so nothing needs rendering.
  const second = manager.selectTiles({ frame: 1, viewports: viewport });
  assert.equal(second.required.length, 1);
  assert.equal(second.toRender.length, 0);

  // includeClean forces a redraw, as device-loss recovery needs.
  const forced = manager.selectTiles({ frame: 2, viewports: viewport, includeClean: true });
  assert.equal(forced.toRender.length, 1);
});

test("moving an object dirties only the tiles it left and entered", () => {
  const manager = makeManager({ width: 8192, height: 8192, tileSize: 2048 });
  const wide = [rect(0, 0, 8192, 8192)];

  manager.syncObject({ objectId: "a", bounds: rect(100, 100, 50, 50) });
  manager.selectTiles({ frame: 0, viewports: wide, includeClean: true });
  for (const tile of manager.trackedTiles()) {
    manager.beginRender([tile.tileId]);
    manager.completeRender(tile.tileId, 0);
  }
  assert.equal(manager.dirtyTiles().length, 0);

  // Move it two tiles across.
  manager.syncObject({ objectId: "a", bounds: rect(5000, 100, 50, 50) });

  const dirty = manager.dirtyTiles().map((tile) => tile.tileId).sort();
  assert.deepEqual(dirty, ["t:0:0", "t:2:0"]);

  const selection = manager.selectTiles({ frame: 1, viewports: wide });
  assert.deepEqual(selection.toRender.map((tile) => tile.tileId).sort(), ["t:0:0", "t:2:0"]);
});

test("invalidateObject dirties a tile without geometry changing", () => {
  const manager = makeManager({ width: 4096, height: 4096, tileSize: 2048 });
  manager.syncObject({ objectId: "text", bounds: rect(10, 10, 100, 40) });
  manager.selectTiles({ frame: 0, viewports: [rect(0, 0, 4096, 4096)], includeClean: true });
  manager.beginRender(["t:0:0"]);
  manager.completeRender("t:0:0", 0);
  assert.equal(manager.isDirty("t:0:0"), false);

  // A text change moves nothing but must still redraw.
  assert.deepEqual(manager.invalidateObject("text"), ["t:0:0"]);
  assert.equal(manager.isDirty("t:0:0"), true);
});

test("a dirty tile nobody is looking at is not rendered", () => {
  const manager = makeManager({ width: 50_000, height: 10_000, tileSize: 2048 });

  // Something changes at the far end of the stage.
  manager.syncObject({ objectId: "far", bounds: rect(49_000, 500, 100, 100) });

  // The operator is looking at the left end.
  const selection = manager.selectTiles({ frame: 0, viewports: [rect(0, 0, 1920, 1080) ] });
  assert.ok(!selection.toRender.some((tile) => tile.column === 23 || tile.column === 24));

  // It renders as soon as a viewport reaches it.
  const later = manager.selectTiles({ frame: 1, viewports: [rect(48_500, 0, 1920, 1080)] });
  assert.ok(later.toRender.length > 0);
});

test("a failed tile stays dirty so the next frame retries", () => {
  const manager = makeManager({ width: 4096, height: 4096, tileSize: 2048 });
  manager.selectTiles({ frame: 0, viewports: [rect(0, 0, 100, 100)] });

  manager.beginRender(["t:0:0"]);
  manager.failRender("t:0:0", "shader compilation failed");

  const tile = manager.get("t:0:0");
  assert.equal(tile.renderState, "failed");
  assert.equal(tile.dirty, true);
  assert.equal(tile.failureReason, "shader compilation failed");

  const retry = manager.selectTiles({ frame: 1, viewports: [rect(0, 0, 100, 100)] });
  assert.equal(retry.toRender.length, 1);
});

test("markAllDirty invalidates every tile, as device loss requires", () => {
  const manager = makeManager({ width: 4096, height: 4096, tileSize: 2048 });
  manager.selectTiles({ frame: 0, viewports: [rect(0, 0, 4096, 4096)], includeClean: true });
  for (const tile of manager.trackedTiles()) {
    manager.beginRender([tile.tileId]);
    manager.completeRender(tile.tileId, 0);
  }
  assert.equal(manager.dirtyTiles().length, 0);

  manager.markAllDirty();
  assert.equal(manager.dirtyTiles().length, 4);
});

// ---------------------------------------------------------------------------
// Overscan changes
// ---------------------------------------------------------------------------

test("adding a filter grows the tile target and invalidates it", () => {
  const manager = makeManager({ width: 4096, height: 4096, tileSize: 2048, overscan: 0 });

  manager.syncObject({ objectId: "a", bounds: rect(100, 100, 200, 200) });
  manager.selectTiles({ frame: 0, viewports: [rect(0, 0, 100, 100)] });
  manager.beginRender(["t:0:0"]);
  manager.completeRender("t:0:0", 0);

  const before = manager.get("t:0:0");
  assert.equal(before.requiredOverscan, 0);
  assert.deepEqual(before.renderBounds, rect(0, 0, 2048, 2048));
  const bytesBefore = before.estimatedBytes;

  // Now the object gains a blur.
  manager.syncObject({
    objectId: "a",
    bounds: rect(100, 100, 200, 200),
    filters: [{ kind: "gaussian-blur", sigma: 16 }]
  });
  manager.selectTiles({ frame: 1, viewports: [rect(0, 0, 100, 100)] });

  const after = manager.get("t:0:0");
  assert.equal(after.requiredOverscan, 48);
  assert.deepEqual(after.renderBounds, rect(-48, -48, 2048 + 96, 2048 + 96));
  assert.ok(after.estimatedBytes > bytesBefore);
  // The render target changed size, so the old contents are unusable.
  assert.equal(after.dirty, true);
});

// ---------------------------------------------------------------------------
// Eviction
// ---------------------------------------------------------------------------

test("eviction drops least-recently-used tiles under a byte budget", () => {
  const manager = makeManager({
    width: 8192,
    height: 8192,
    tileSize: 2048,
    // Three tiles' worth of budget; 2048^2 * 4 = 16 MiB each.
    cacheBudgetBytes: 2048 * 2048 * 4 * 3,
    maxResidentTiles: 100
  });

  const ids = ["t:0:0", "t:1:0", "t:2:0", "t:3:0"];
  for (const [step, id] of ids.entries()) {
    const coord = id.split(":");
    const bounds = rect(Number(coord[1]) * 2048, 0, 10, 10);
    manager.selectTiles({ frame: step, viewports: [bounds] });
    manager.beginRender([id]);
    manager.completeRender(id, step);
  }

  assert.equal(manager.stats().residentTiles, 4);
  assert.equal(manager.stats().overBudget, true);

  const evicted = manager.evict();
  // The oldest tile goes first.
  assert.deepEqual(evicted, ["t:0:0"]);
  assert.equal(manager.stats().overBudget, false);

  const gone = manager.get("t:0:0");
  assert.equal(gone.gpuState, "released");
  assert.equal(gone.cacheState, "evicted");
  // Evicted means it must be re-rendered, not silently reused.
  assert.equal(gone.dirty, true);
});

test("tiles an output references are never evicted", () => {
  const manager = makeManager({
    width: 8192,
    height: 8192,
    tileSize: 2048,
    cacheBudgetBytes: 1, // impossible budget, so eviction wants everything
    maxResidentTiles: 1
  });

  for (const [step, id] of ["t:0:0", "t:1:0"].entries()) {
    manager.selectTiles({ frame: step, viewports: [rect(step * 2048, 0, 10, 10)] });
    manager.beginRender([id]);
    manager.completeRender(id, step);
  }

  manager.addOutputRef("t:0:0", "output_program");

  const evicted = manager.evict();
  assert.deepEqual(evicted, ["t:1:0"]);
  // Going over budget is recoverable; dropping a live output tile is not.
  assert.equal(manager.get("t:0:0").gpuState, "allocated");
  assert.equal(manager.stats().pinnedTiles, 1);

  manager.removeOutputRef("t:0:0", "output_program");
  assert.deepEqual(manager.evict(), ["t:0:0"]);
});

test("eviction respects the resident tile count as well as bytes", () => {
  const manager = makeManager({
    width: 8192,
    height: 8192,
    tileSize: 2048,
    cacheBudgetBytes: 1024 ** 4, // effectively unlimited bytes
    maxResidentTiles: 2
  });

  for (const [step, id] of ["t:0:0", "t:1:0", "t:2:0"].entries()) {
    manager.selectTiles({ frame: step, viewports: [rect(step * 2048, 0, 10, 10)] });
    manager.beginRender([id]);
    manager.completeRender(id, step);
  }

  assert.equal(manager.evict().length, 1);
  assert.equal(manager.stats().residentTiles, 2);
});

test("reset clears scene state", () => {
  const manager = makeManager({ width: 4096, height: 4096 });
  manager.syncObject({ objectId: "a", bounds: rect(0, 0, 10, 10) });
  manager.selectTiles({ frame: 0, viewports: [rect(0, 0, 10, 10)] });
  assert.ok(manager.stats().trackedTiles > 0);

  manager.reset();
  assert.equal(manager.stats().trackedTiles, 0);
  assert.equal(manager.stats().objectCount, 0);
});

// ---------------------------------------------------------------------------
// Compositing and seams
// ---------------------------------------------------------------------------

/** Render every tile a target needs so a composite plan is complete. */
function renderTilesFor(manager, target, frame = 0) {
  const selection = manager.selectTiles({ frame, outputs: [target], includeClean: true });
  for (const tile of selection.toRender) {
    manager.beginRender([tile.tileId]);
    manager.completeRender(tile.tileId, frame);
  }
  return selection.required;
}

test("a composite plan tiles its target exactly, with no gap and no overlap", () => {
  const manager = makeManager({ width: 8192, height: 8192, tileSize: 2048, overscan: 32 });
  const target = rect(0, 0, 8192, 8192);

  const tiles = renderTilesFor(manager, target);
  assert.equal(tiles.length, 16);

  const plan = planTileComposite(target, tiles);
  const report = verifySeamlessCoverage(plan);

  assert.equal(report.seamless, true, JSON.stringify(report.gaps));
  assert.deepEqual(report.gaps, []);
  assert.equal(report.coveredArea, report.targetArea);
  assert.equal(plan.missingTileIds.length, 0);
});

test("a partial target composites seamlessly from the tiles it crosses", () => {
  const manager = makeManager({ width: 8192, height: 8192, tileSize: 2048, overscan: 32 });
  // Deliberately straddles four tiles and is not boundary aligned.
  const target = rect(1900, 1900, 300, 300);

  const tiles = renderTilesFor(manager, target);
  assert.equal(tiles.length, 4);

  const plan = planTileComposite(target, tiles);
  assert.equal(plan.ops.length, 4);
  assert.equal(verifySeamlessCoverage(plan).seamless, true);

  // Each op contributes a distinct quadrant of the target.
  const areas = plan.ops.map((op) => op.logicalRect.width * op.logicalRect.height);
  assert.equal(
    areas.reduce((sum, area) => sum + area, 0),
    300 * 300
  );
});

test("a 50000-wide stage composites seamlessly from 625 tiles", () => {
  const manager = makeManager({
    width: 50_000,
    height: 50_000,
    tileSize: 2048,
    overscan: 32,
    cacheBudgetBytes: 1024 ** 4,
    maxResidentTiles: 100_000
  });
  const target = manager.grid.logicalBounds;

  const tiles = renderTilesFor(manager, target);
  assert.equal(tiles.length, 625);

  const plan = planFullStageComposite(manager.grid, tiles);
  const report = verifySeamlessCoverage(plan);

  assert.equal(report.seamless, true, JSON.stringify(report.gaps.slice(0, 3)));
  // The ragged right and bottom edges still sum to exactly the stage area.
  assert.equal(report.coveredArea, 50_000 * 50_000);
});

test("a missing tile is reported rather than silently omitted", () => {
  const manager = makeManager({ width: 4096, height: 4096, tileSize: 2048, overscan: 0 });
  const target = rect(0, 0, 4096, 4096);

  const tiles = manager.selectTiles({ frame: 0, outputs: [target] }).required;
  // Render three of the four.
  for (const tile of tiles.slice(0, 3)) {
    manager.beginRender([tile.tileId]);
    manager.completeRender(tile.tileId, 0);
  }

  const plan = planTileComposite(target, tiles);
  assert.equal(plan.ops.length, 3);
  assert.equal(plan.missingTileIds.length, 1);

  const report = verifySeamlessCoverage(plan);
  assert.equal(report.seamless, false);
  assert.ok(report.gaps.some((gap) => gap.kind === "gap"));
});

test("the composite reads past the overscan ring, never into it", () => {
  const manager = makeManager({ width: 4096, height: 4096, tileSize: 2048, overscan: 0 });
  manager.syncObject({
    objectId: "blurred",
    bounds: rect(100, 100, 200, 200),
    filters: [{ kind: "gaussian-blur", sigma: 16 }]
  });

  const target = rect(0, 0, 2048, 2048);
  const tiles = renderTilesFor(manager, target);
  const tile = tiles.find((candidate) => candidate.tileId === "t:0:0");

  assert.equal(tile.requiredOverscan, 48);
  // The render target is padded...
  assert.deepEqual(tile.renderBounds, rect(-48, -48, 2144, 2144));
  // ...but only the inner rectangle may reach an output.
  assert.deepEqual(tileCompositeRect(tile), rect(0, 0, 2048, 2048));
  // The read starts exactly at the overscan offset.
  assert.deepEqual(tileSourceRect(tile), rect(48, 48, 2048, 2048));

  const plan = planTileComposite(target, tiles);
  const op = plan.ops.find((candidate) => candidate.tileId === "t:0:0");
  assert.deepEqual(op.sourceInTile, rect(48, 48, 2048, 2048));
  assert.deepEqual(op.destination, rect(0, 0, 2048, 2048));
});

test("render scale applies to source, destination, and the overscan offset", () => {
  const manager = makeManager({ width: 4096, height: 4096, tileSize: 2048, overscan: 32 });
  const target = rect(0, 0, 2048, 2048);
  const tiles = renderTilesFor(manager, target);

  const plan = planTileComposite(target, tiles, { renderScale: 0.5 });
  const op = plan.ops[0];

  assert.equal(plan.targetWidth, 1024);
  assert.deepEqual(op.sourceInTile, rect(16, 16, 1024, 1024));
  assert.deepEqual(op.destination, rect(0, 0, 1024, 1024));
});

test("object geometry rebases onto the padded tile origin", () => {
  const manager = makeManager({
    width: 50_000,
    height: 50_000,
    tileSize: 2048,
    overscan: 32
  });
  // An object near the far edge of the stage.
  const bounds = rect(49_200.37, 49_200.81, 400, 200);
  manager.syncObject({ objectId: "far", bounds });

  const target = rect(49_152, 49_152, 848, 848);
  const tiles = renderTilesFor(manager, target);
  const tile = tiles.find((candidate) => candidate.tileId === "t:24:24");

  // The render origin is the padded corner, not the tile corner.
  assert.deepEqual(tileLocalOrigin(tile), { x: 49_152 - 32, y: 49_152 - 32 });

  const local = objectRectInTile(bounds, tile);
  // Magnitude drops from ~49,200 to ~80, which is where float32 is accurate.
  assert.ok(Math.abs(local.x - 80.37) < 1e-9, `got ${local.x}`);
  assert.ok(Math.abs(local.y - 80.81) < 1e-9, `got ${local.y}`);
  assert.ok(Math.abs(Math.fround(local.x) - local.x) < 1e-5);

  // The clip rect covers the padded target so filters may write into overscan.
  assert.deepEqual(tileClipRect(tile), rect(0, 0, tile.renderBounds.width, tile.renderBounds.height));
});

test("an object crossing a boundary lands at the same world position in both tiles", () => {
  const manager = makeManager({ width: 8192, height: 8192, tileSize: 2048, overscan: 0 });
  const bounds = rect(2000, 500, 200, 100); // straddles x = 2048

  manager.syncObject({ objectId: "straddle", bounds });
  const tiles = renderTilesFor(manager, rect(0, 0, 4096, 2048));

  const left = tiles.find((tile) => tile.tileId === "t:0:0");
  const right = tiles.find((tile) => tile.tileId === "t:1:0");

  const inLeft = objectRectInTile(bounds, left);
  const inRight = objectRectInTile(bounds, right);

  // Different local coordinates...
  assert.deepEqual(inLeft, rect(2000, 500, 200, 100));
  assert.deepEqual(inRight, rect(-48, 500, 200, 100));

  // ...but adding each tile's origin back recovers the identical world rect.
  assert.equal(inLeft.x + left.renderBounds.x, bounds.x);
  assert.equal(inRight.x + right.renderBounds.x, bounds.x);
  // That equality is exactly why the two halves line up with no seam.
});

test("stats summarise the tile cache for diagnostics", () => {
  const manager = makeManager({ width: 8192, height: 8192, tileSize: 2048 });
  manager.syncObject({ objectId: "straddle", bounds: rect(2000, 2000, 100, 100) });
  renderTilesFor(manager, rect(0, 0, 4096, 4096));

  const stats = manager.stats();
  assert.equal(stats.totalTiles, 16);
  assert.equal(stats.trackedTiles, 4);
  assert.equal(stats.residentTiles, 4);
  assert.equal(stats.renderedTiles, 4);
  assert.equal(stats.dirtyTiles, 0);
  assert.equal(stats.objectCount, 1);
  assert.equal(stats.multiTileObjectCount, 1);
  assert.equal(stats.cacheBytes, 4 * 2048 * 2048 * 4);
});
