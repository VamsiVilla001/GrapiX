/**
 * The tile grid.
 *
 * A tile grid is a partition of the stage into rectangles small enough to be
 * real GPU render targets. Tiles are the *only* thing in GrapiX that becomes a
 * framebuffer, which is what lets a 50,000 x 50,000 logical stage exist on a
 * GPU whose maximum texture dimension is 16,384.
 *
 * Two properties matter and are enforced here:
 *
 * 1. The grid is a partition. An object whose right edge lands exactly on a
 *    tile boundary belongs to the left tile only, never to both. Touching is
 *    not overlapping.
 * 2. Tile identity is derived from the grid, never stored. Change the tile size
 *    and every identity changes with it, so a stale tile cannot be mistaken for
 *    a current one.
 */

import {
  canvasBounds,
  intersectRects,
  rect,
  rectBottom,
  rectRight,
  type StagePoint,
  type StageRect,
  type StageTilingConfig,
  type VirtualCanvas
} from "@grapix/stage-model";

/** `t:<column>:<row>`. Derived, so it is safe to use as a cache key. */
export type TileId = string;

export interface TileCoord {
  column: number;
  row: number;
}

export interface TileGrid {
  /** Stage top-left. Tile 0,0 starts here, whatever the canvas origin anchor. */
  origin: StagePoint;
  tileWidth: number;
  tileHeight: number;
  columns: number;
  rows: number;
  /** Logical padding rendered outside each tile so filters have neighbours. */
  overscan: number;
  /** The whole stage, in canvas coordinates. */
  logicalBounds: StageRect;
}

export function createTileGrid(canvas: VirtualCanvas, tiling: StageTilingConfig): TileGrid {
  const logicalBounds = canvasBounds(canvas);

  // Tiling disabled means a single tile covering the stage. That keeps the
  // legacy single-target path expressible in the same model instead of needing a
  // separate code path.
  const tileWidth = tiling.enabled ? tiling.tileWidth : Math.max(1, Math.ceil(logicalBounds.width));
  const tileHeight = tiling.enabled
    ? tiling.tileHeight
    : Math.max(1, Math.ceil(logicalBounds.height));

  return {
    origin: { x: logicalBounds.x, y: logicalBounds.y },
    tileWidth,
    tileHeight,
    columns: Math.max(1, Math.ceil(logicalBounds.width / tileWidth)),
    rows: Math.max(1, Math.ceil(logicalBounds.height / tileHeight)),
    overscan: tiling.enabled ? tiling.overscan : 0,
    logicalBounds
  };
}

export function tileId(column: number, row: number): TileId {
  return `t:${column}:${row}`;
}

export function parseTileId(value: TileId): TileCoord | undefined {
  const parts = value.split(":");
  if (parts.length !== 3 || parts[0] !== "t") return undefined;
  const column = Number.parseInt(parts[1], 10);
  const row = Number.parseInt(parts[2], 10);
  if (!Number.isInteger(column) || !Number.isInteger(row) || column < 0 || row < 0) {
    return undefined;
  }
  return { column, row };
}

export function tileCount(grid: TileGrid): number {
  return grid.columns * grid.rows;
}

export function isValidTile(grid: TileGrid, coord: TileCoord): boolean {
  return (
    coord.column >= 0
    && coord.row >= 0
    && coord.column < grid.columns
    && coord.row < grid.rows
  );
}

/**
 * A tile's logical rectangle, clipped to the stage.
 *
 * Right and bottom edge tiles are partial when the stage is not an exact
 * multiple of the tile size. Clipping here rather than at render time means the
 * composite never has to know about the ragged edge.
 */
export function tileBounds(grid: TileGrid, coord: TileCoord): StageRect {
  const x = grid.origin.x + coord.column * grid.tileWidth;
  const y = grid.origin.y + coord.row * grid.tileHeight;
  return intersectRects(rect(x, y, grid.tileWidth, grid.tileHeight), grid.logicalBounds);
}

/** A tile's unclipped rectangle. Useful for grid overlays and diagnostics. */
export function tileFullBounds(grid: TileGrid, coord: TileCoord): StageRect {
  return rect(
    grid.origin.x + coord.column * grid.tileWidth,
    grid.origin.y + coord.row * grid.tileHeight,
    grid.tileWidth,
    grid.tileHeight
  );
}

/**
 * The rectangle a tile is actually rendered at: its bounds plus overscan.
 *
 * The overscan ring is sampled by filters and then discarded during compositing.
 * Overscan is *not* clipped to the stage, because a blur at the stage edge still
 * needs to know that there is nothing out there.
 */
export function tileRenderBounds(
  grid: TileGrid,
  coord: TileCoord,
  overscan: number = grid.overscan
): StageRect {
  const bounds = tileBounds(grid, coord);
  const padding = Math.max(0, overscan);
  return rect(
    bounds.x - padding,
    bounds.y - padding,
    bounds.width + padding * 2,
    bounds.height + padding * 2
  );
}

/**
 * Pixel dimensions of a tile's render target at a given scale.
 *
 * Rounded up so a fractional render scale never drops the last row of pixels.
 */
export function tileRenderSize(
  grid: TileGrid,
  coord: TileCoord,
  renderScale = 1,
  overscan: number = grid.overscan
): { width: number; height: number } {
  const bounds = tileRenderBounds(grid, coord, overscan);
  return {
    width: Math.max(1, Math.ceil(bounds.width * renderScale)),
    height: Math.max(1, Math.ceil(bounds.height * renderScale))
  };
}

/**
 * Column range a logical rectangle touches, clamped to the grid.
 *
 * Returns `undefined` when the rectangle is empty or entirely outside the grid.
 * Partition semantics: a right edge landing exactly on a boundary does not enter
 * the next column.
 */
export function tileColumnRange(
  grid: TileGrid,
  bounds: StageRect
): { start: number; end: number } | undefined {
  if (!(bounds.width > 0)) return undefined;

  const relativeLeft = bounds.x - grid.origin.x;
  const relativeRight = rectRight(bounds) - grid.origin.x;

  const start = Math.floor(relativeLeft / grid.tileWidth);
  // `ceil - 1` is what makes a boundary-aligned right edge stay in one column.
  const end = Math.ceil(relativeRight / grid.tileWidth) - 1;

  const clampedStart = Math.max(0, start);
  const clampedEnd = Math.min(grid.columns - 1, end);
  if (clampedEnd < clampedStart) return undefined;

  return { start: clampedStart, end: clampedEnd };
}

export function tileRowRange(
  grid: TileGrid,
  bounds: StageRect
): { start: number; end: number } | undefined {
  if (!(bounds.height > 0)) return undefined;

  const relativeTop = bounds.y - grid.origin.y;
  const relativeBottom = rectBottom(bounds) - grid.origin.y;

  const start = Math.floor(relativeTop / grid.tileHeight);
  const end = Math.ceil(relativeBottom / grid.tileHeight) - 1;

  const clampedStart = Math.max(0, start);
  const clampedEnd = Math.min(grid.rows - 1, end);
  if (clampedEnd < clampedStart) return undefined;

  return { start: clampedStart, end: clampedEnd };
}

/**
 * Every tile a logical rectangle overlaps.
 *
 * Index-driven, so cost is proportional to the tiles actually touched rather
 * than to the size of the grid. That distinction matters: a 512-tile grid over
 * a 50,000 x 50,000 stage has 9,604 tiles, and a lower third touches four.
 */
export function tilesForRect(grid: TileGrid, bounds: StageRect): TileCoord[] {
  const columns = tileColumnRange(grid, bounds);
  const rows = tileRowRange(grid, bounds);
  if (!columns || !rows) return [];

  const result: TileCoord[] = [];
  for (let row = rows.start; row <= rows.end; row += 1) {
    for (let column = columns.start; column <= columns.end; column += 1) {
      result.push({ column, row });
    }
  }
  return result;
}

export function tileIdsForRect(grid: TileGrid, bounds: StageRect): TileId[] {
  return tilesForRect(grid, bounds).map((coord) => tileId(coord.column, coord.row));
}

/** How many tiles a rectangle touches, without materialising the list. */
export function countTilesForRect(grid: TileGrid, bounds: StageRect): number {
  const columns = tileColumnRange(grid, bounds);
  const rows = tileRowRange(grid, bounds);
  if (!columns || !rows) return 0;
  return (columns.end - columns.start + 1) * (rows.end - rows.start + 1);
}

/** Tile containing a point, or `undefined` when the point is off-stage. */
export function tileAtPoint(grid: TileGrid, value: StagePoint): TileCoord | undefined {
  const column = Math.floor((value.x - grid.origin.x) / grid.tileWidth);
  const row = Math.floor((value.y - grid.origin.y) / grid.tileHeight);
  const coord = { column, row };
  return isValidTile(grid, coord) ? coord : undefined;
}

/** Iterate every tile in the grid, row-major. */
export function allTiles(grid: TileGrid): TileCoord[] {
  const result: TileCoord[] = [];
  for (let row = 0; row < grid.rows; row += 1) {
    for (let column = 0; column < grid.columns; column += 1) {
      result.push({ column, row });
    }
  }
  return result;
}

/**
 * Bytes one tile's render target needs, overscan included.
 *
 * Used for cache budgeting. Overscan is not free: a 1024 tile with 32 units of
 * overscan is 1088 x 1088, which is 13% more memory than the tile itself.
 */
export function tileByteEstimate(
  grid: TileGrid,
  coord: TileCoord,
  bytesPerPixel = 4,
  renderScale = 1,
  overscan: number = grid.overscan
): number {
  const size = tileRenderSize(grid, coord, renderScale, overscan);
  return size.width * size.height * bytesPerPixel;
}

/** Whether a grid's padded tiles fit the GPU's texture limit. */
export function gridFitsTextureLimit(grid: TileGrid, maxTextureDimension: number): boolean {
  return (
    grid.tileWidth + grid.overscan * 2 <= maxTextureDimension
    && grid.tileHeight + grid.overscan * 2 <= maxTextureDimension
  );
}
