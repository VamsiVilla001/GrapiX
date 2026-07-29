import assert from "node:assert/strict";
import test from "node:test";

import { createVirtualCanvas, normalizeStageTiling, rect } from "@grapix/stage-model";
import {
  allTiles,
  countTilesForRect,
  createTileGrid,
  filterExtent,
  filterStackExtent,
  gridFitsTextureLimit,
  parseTileId,
  tileAtPoint,
  tileBounds,
  tileByteEstimate,
  tileColumnRange,
  tileCount,
  tileFullBounds,
  tileId,
  tileIdsForRect,
  tileRenderBounds,
  tileRenderSize,
  tileRowRange,
  tilesForRect
} from "../dist/index.js";

function grid(width, height, tileSize = 2048, overscan = 32) {
  return createTileGrid(
    createVirtualCanvas(width, height),
    normalizeStageTiling({ tileWidth: tileSize, tileHeight: tileSize, overscan })
  );
}

test("a 50000 x 50000 stage tiles into a tractable grid", () => {
  const g = grid(50_000, 50_000, 2048);

  assert.equal(g.columns, 25); // ceil(50000 / 2048)
  assert.equal(g.rows, 25);
  assert.equal(tileCount(g), 625);

  // At 512 the same stage is 98x98. Large, but still index-driven.
  const fine = grid(50_000, 50_000, 512);
  assert.equal(fine.columns, 98);
  assert.equal(tileCount(fine), 9_604);
});

test("tile ids round-trip and reject malformed input", () => {
  assert.equal(tileId(24, 12), "t:24:12");
  assert.deepEqual(parseTileId("t:24:12"), { column: 24, row: 12 });
  assert.equal(parseTileId("24:12"), undefined);
  assert.equal(parseTileId("t:-1:0"), undefined);
  assert.equal(parseTileId("t:a:b"), undefined);
});

test("edge tiles are clipped to the stage", () => {
  const g = grid(50_000, 50_000, 2048);

  // Interior tile: full size.
  assert.deepEqual(tileBounds(g, { column: 0, row: 0 }), rect(0, 0, 2048, 2048));

  // Last column starts at 24*2048 = 49152 and only 848 units remain.
  const last = tileBounds(g, { column: 24, row: 0 });
  assert.deepEqual(last, rect(49_152, 0, 848, 2048));

  // The unclipped view still reports the full tile, for grid overlays.
  assert.deepEqual(tileFullBounds(g, { column: 24, row: 0 }), rect(49_152, 0, 2048, 2048));
});

test("the grid is a partition: a boundary-aligned edge does not enter the next tile", () => {
  const g = grid(8192, 8192, 2048, 0);

  // Exactly one tile wide, ending on the boundary.
  assert.deepEqual(tileColumnRange(g, rect(0, 0, 2048, 10)), { start: 0, end: 0 });

  // One unit past the boundary reaches the second column.
  assert.deepEqual(tileColumnRange(g, rect(0, 0, 2049, 10)), { start: 0, end: 1 });

  // Starting exactly on a boundary belongs to the new tile.
  assert.deepEqual(tileColumnRange(g, rect(2048, 0, 10, 10)), { start: 1, end: 1 });

  // A zero-area rect touches nothing.
  assert.equal(tileColumnRange(g, rect(100, 0, 0, 10)), undefined);
  assert.equal(tileRowRange(g, rect(0, 100, 10, 0)), undefined);
});

test("rectangles off the grid select no tiles", () => {
  const g = grid(4096, 4096, 2048, 0);
  assert.deepEqual(tilesForRect(g, rect(-1000, -1000, 500, 500)), []);
  assert.deepEqual(tilesForRect(g, rect(10_000, 10_000, 100, 100)), []);
});

test("rectangles partly off the grid clamp to valid tiles", () => {
  const g = grid(4096, 4096, 2048, 0);
  const ids = tileIdsForRect(g, rect(-500, -500, 1000, 1000));
  assert.deepEqual(ids, ["t:0:0"]);
});

test("an object crossing a boundary selects every tile it overlaps", () => {
  const g = grid(8192, 8192, 2048, 0);

  // Straddles the vertical boundary at x = 2048 and the horizontal at y = 2048.
  const coords = tilesForRect(g, rect(2000, 2000, 100, 100));
  assert.equal(coords.length, 4);
  assert.deepEqual(
    coords.map((c) => tileId(c.column, c.row)).sort(),
    ["t:0:0", "t:0:1", "t:1:0", "t:1:1"]
  );
  assert.equal(countTilesForRect(g, rect(2000, 2000, 100, 100)), 4);
});

test("a wide object on a huge stage selects only the rows it crosses", () => {
  const g = grid(50_000, 10_000, 2048, 0);
  assert.equal(g.columns, 25);
  assert.equal(g.rows, 5);

  // A ribbon sitting inside one row band (row 3 spans 6144..8192).
  assert.equal(countTilesForRect(g, rect(0, 6_200, 50_000, 200)), 25);

  // The same ribbon straddling the row boundary at 8192 needs two rows.
  assert.equal(countTilesForRect(g, rect(0, 8_000, 50_000, 200)), 50);

  // Either way it is a small fraction of the 125-tile grid.
  assert.equal(tileCount(g), 125);
});

test("overscan expands the render bounds and is not clipped to the stage", () => {
  const g = grid(4096, 4096, 2048, 32);

  const bounds = tileRenderBounds(g, { column: 0, row: 0 });
  // Overscan reaches outside the stage on purpose: a blur at the stage edge
  // still needs to know there is nothing out there.
  assert.deepEqual(bounds, rect(-32, -32, 2048 + 64, 2048 + 64));

  const size = tileRenderSize(g, { column: 0, row: 0 });
  assert.deepEqual(size, { width: 2112, height: 2112 });

  // Explicit overscan overrides the grid default.
  assert.deepEqual(
    tileRenderBounds(g, { column: 0, row: 0 }, 0),
    rect(0, 0, 2048, 2048)
  );
});

test("render scale shrinks the tile target", () => {
  const g = grid(4096, 4096, 2048, 0);
  assert.deepEqual(tileRenderSize(g, { column: 0, row: 0 }, 0.5), {
    width: 1024,
    height: 1024
  });
});

test("tile byte estimates account for overscan", () => {
  const g = grid(4096, 4096, 1024, 0);
  assert.equal(tileByteEstimate(g, { column: 0, row: 0 }), 1024 * 1024 * 4);

  const padded = grid(4096, 4096, 1024, 32);
  // 1088^2 instead of 1024^2 — overscan costs about 13% more memory.
  assert.equal(tileByteEstimate(padded, { column: 0, row: 0 }), 1088 * 1088 * 4);
});

test("a grid whose padded tiles exceed the texture limit is rejected", () => {
  const fits = grid(50_000, 50_000, 2048, 32);
  assert.equal(gridFitsTextureLimit(fits, 16_384), true);
  assert.equal(gridFitsTextureLimit(fits, 2048), false); // 2048 + 64 > 2048

  const large = grid(50_000, 50_000, 8192, 256);
  assert.equal(gridFitsTextureLimit(large, 8192), false);
  assert.equal(gridFitsTextureLimit(large, 16_384), true);
});

test("disabling tiling collapses the grid to one tile covering the stage", () => {
  const g = createTileGrid(
    createVirtualCanvas(1920, 1080),
    normalizeStageTiling({ enabled: false, tileWidth: 512, tileHeight: 512, overscan: 64 })
  );

  assert.equal(g.columns, 1);
  assert.equal(g.rows, 1);
  assert.equal(g.overscan, 0);
  assert.deepEqual(tileBounds(g, { column: 0, row: 0 }), rect(0, 0, 1920, 1080));
});

test("the grid origin follows the canvas origin anchor", () => {
  const centered = createTileGrid(
    createVirtualCanvas(4096, 4096, { origin: { anchor: "center", offsetX: 0, offsetY: 0 } }),
    normalizeStageTiling({ tileWidth: 2048, tileHeight: 2048, overscan: 0 })
  );

  assert.deepEqual(centered.origin, { x: -2048, y: -2048 });
  assert.deepEqual(tileBounds(centered, { column: 0, row: 0 }), rect(-2048, -2048, 2048, 2048));
  assert.deepEqual(tileAtPoint(centered, { x: 0, y: 0 }), { column: 1, row: 1 });
  assert.deepEqual(tileAtPoint(centered, { x: -2048, y: -2048 }), { column: 0, row: 0 });
});

test("tileAtPoint rejects points off the stage", () => {
  const g = grid(4096, 4096, 2048, 0);
  assert.equal(tileAtPoint(g, { x: -1, y: 0 }), undefined);
  assert.equal(tileAtPoint(g, { x: 5000, y: 0 }), undefined);
});

test("allTiles enumerates row-major", () => {
  const g = grid(4096, 2048, 2048, 0);
  assert.deepEqual(
    allTiles(g).map((c) => tileId(c.column, c.row)),
    ["t:0:0", "t:1:0"]
  );
});

test("filter extents follow the documented formulas", () => {
  // Three sigma captures 99.7% of a Gaussian.
  assert.equal(filterExtent({ kind: "gaussian-blur", sigma: 10 }), 30);
  assert.equal(filterExtent({ kind: "box-blur", radius: 7.2 }), 8);
  assert.equal(
    filterExtent({ kind: "drop-shadow", sigma: 4, offsetX: 10, offsetY: -20 }),
    12 + 20
  );
  assert.equal(filterExtent({ kind: "glow", sigma: 5, spread: 3 }), 15 + 3);
  assert.equal(filterExtent({ kind: "outline", width: 2.5 }), 3);
  assert.equal(filterExtent({ kind: "custom", extent: 64 }), 64);

  // Negative and zero values never produce negative padding.
  assert.equal(filterExtent({ kind: "gaussian-blur", sigma: -5 }), 0);
});

test("filter stacks sum, because a blur then a shadow reaches further than either", () => {
  const stack = [
    { kind: "gaussian-blur", sigma: 10 },
    { kind: "drop-shadow", sigma: 4, offsetX: 0, offsetY: 8 }
  ];
  assert.equal(filterStackExtent(stack), 30 + (12 + 8));
  assert.equal(filterStackExtent([]), 0);
});
