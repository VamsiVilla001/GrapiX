/**
 * Tile manager: what gets rendered, and what gets thrown away.
 *
 * The selection rule from the requirements, implemented literally. A tile is
 * rendered only if it is in the union of:
 *
 *   - visible in an active viewport
 *   - dirty since its last render
 *   - required by an active output
 *   - required for a preview
 *   - required for an export
 *
 * Everything else is culled. On a mostly static 50,000-wide stage that means a
 * typical frame renders nothing at all, and a frame with one animating object
 * renders the handful of tiles that object touches.
 */

import { rectsIntersect, type StageRect } from "@grapix/stage-model";

import {
  allTiles,
  parseTileId,
  tileBounds,
  tileByteEstimate,
  tileId,
  tileIdsForRect,
  tileRenderBounds,
  type TileGrid,
  type TileId
} from "./grid.js";
import {
  isTilePinned,
  tileNeedsRender,
  type TileCacheState,
  type TileDescriptor,
  type TileSelectionReason
} from "./state.js";
import { TileObjectIndex, type IndexDelta, type ObjectPlacement } from "./object-index.js";

export interface TileManagerOptions {
  grid: TileGrid;
  /** GPU byte budget for resident tiles. */
  cacheBudgetBytes?: number;
  maxResidentTiles?: number;
  bytesPerPixel?: number;
  /** Render scale used when estimating tile byte cost. */
  renderScale?: number;
}

/** Logical rectangles that each demand tiles, tagged by why. */
export interface TileSelectionRequest {
  frame: number;
  viewports?: readonly StageRect[];
  outputs?: readonly StageRect[];
  previews?: readonly StageRect[];
  exports?: readonly StageRect[];
  /**
   * Include tiles that are required but already up to date.
   *
   * False (the default) is render-on-change: only tiles that actually need work
   * come back in `toRender`. True forces a full redraw of the required set, which
   * is what a device-loss recovery or a first frame after a resize needs.
   */
  includeClean?: boolean;
}

export interface TileSelection {
  /** Tiles some active consumer needs this frame. */
  required: TileDescriptor[];
  /** Subset of `required` that actually needs GPU work. */
  toRender: TileDescriptor[];
  /** Tiles in the grid that nothing needed. */
  culledCount: number;
  /** Why each required tile was selected. Diagnostics only. */
  reasons: Map<TileId, TileSelectionReason[]>;
}

export interface TileManagerStats {
  totalTiles: number;
  trackedTiles: number;
  residentTiles: number;
  dirtyTiles: number;
  renderedTiles: number;
  failedTiles: number;
  evictedTiles: number;
  pinnedTiles: number;
  cacheBytes: number;
  cacheBudgetBytes: number;
  maxResidentTiles: number;
  overBudget: boolean;
  objectCount: number;
  multiTileObjectCount: number;
}

const DEFAULT_CACHE_BUDGET_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_RESIDENT_TILES = 256;

export class TileManager {
  readonly grid: TileGrid;
  readonly index: TileObjectIndex;

  private readonly tiles = new Map<TileId, TileDescriptor>();
  private readonly cacheBudgetBytes: number;
  private readonly maxResidentTiles: number;
  private readonly bytesPerPixel: number;
  private readonly renderScale: number;
  private tick = 0;

  constructor(options: TileManagerOptions) {
    this.grid = options.grid;
    this.index = new TileObjectIndex(options.grid);
    this.cacheBudgetBytes = options.cacheBudgetBytes ?? DEFAULT_CACHE_BUDGET_BYTES;
    this.maxResidentTiles = options.maxResidentTiles ?? DEFAULT_MAX_RESIDENT_TILES;
    this.bytesPerPixel = options.bytesPerPixel ?? 4;
    this.renderScale = options.renderScale ?? 1;
  }

  // -------------------------------------------------------------------------
  // Scene synchronisation
  // -------------------------------------------------------------------------

  /**
   * Add or move an object, dirtying the minimum set of tiles.
   *
   * Tiles the object left are dirty because it is no longer there; tiles it
   * entered are dirty because it now is; and if it moved without changing tiles,
   * its current tiles are dirty because the pixels changed anyway.
   */
  syncObject(placement: ObjectPlacement): IndexDelta {
    const delta = this.index.upsert(placement);

    for (const id of delta.left) this.markDirty(id);
    for (const id of delta.entered) this.markDirty(id);
    if (delta.movedWithinTiles) {
      for (const id of this.index.tilesForObject(placement.objectId)) this.markDirty(id);
    }

    return delta;
  }

  /** Remove an object and dirty every tile it occupied. */
  removeObject(objectId: string): IndexDelta {
    const delta = this.index.remove(objectId);
    for (const id of delta.left) this.markDirty(id);
    return delta;
  }

  /**
   * Object content changed without moving.
   *
   * A text change or a material swap does not alter geometry, but every tile the
   * object touches still has to be redrawn.
   */
  invalidateObject(objectId: string): TileId[] {
    const tiles = this.index.tilesForObject(objectId);
    for (const id of tiles) this.markDirty(id);
    return tiles;
  }

  /** Drop all scene state. Used on scene unload. */
  reset(): void {
    this.index.clear();
    this.tiles.clear();
    this.tick = 0;
  }

  // -------------------------------------------------------------------------
  // Dirty tracking
  // -------------------------------------------------------------------------

  markDirty(id: TileId): void {
    const tile = this.ensureTile(id);
    if (!tile) return;
    tile.dirty = true;
    if (tile.renderState === "rendered" || tile.renderState === "failed") {
      tile.renderState = "idle";
    }
  }

  markRectDirty(bounds: StageRect): TileId[] {
    const ids = tileIdsForRect(this.grid, bounds);
    for (const id of ids) this.markDirty(id);
    return ids;
  }

  /** Invalidate everything. Device loss, resize, or a full scene resync. */
  markAllDirty(): void {
    for (const coord of allTiles(this.grid)) {
      this.markDirty(tileId(coord.column, coord.row));
    }
  }

  isDirty(id: TileId): boolean {
    return this.tiles.get(id)?.dirty ?? true;
  }

  // -------------------------------------------------------------------------
  // Selection
  // -------------------------------------------------------------------------

  /**
   * Decide which tiles to render this frame.
   *
   * Selection never allocates a descriptor for a tile nothing asked about, so
   * the cost is proportional to demand rather than to grid size.
   */
  selectTiles(request: TileSelectionRequest): TileSelection {
    this.tick += 1;

    const reasons = new Map<TileId, TileSelectionReason[]>();
    const addReason = (id: TileId, reason: TileSelectionReason): void => {
      const existing = reasons.get(id);
      if (existing) {
        if (!existing.includes(reason)) existing.push(reason);
        return;
      }
      reasons.set(id, [reason]);
    };

    const collect = (rects: readonly StageRect[] | undefined, reason: TileSelectionReason): void => {
      if (!rects) return;
      for (const bounds of rects) {
        if (!(bounds.width > 0) || !(bounds.height > 0)) continue;
        for (const id of tileIdsForRect(this.grid, bounds)) addReason(id, reason);
      }
    };

    collect(request.viewports, "viewport");
    collect(request.outputs, "output");
    collect(request.previews, "preview");
    collect(request.exports, "export");

    // A dirty tile only matters if something is looking at it. A dirty tile off
    // in an unwatched corner of a 50,000-wide stage stays dirty and unrendered
    // until a viewport or output actually needs it.
    for (const [id] of reasons) {
      if (this.isDirty(id)) addReason(id, "dirty");
    }

    const required: TileDescriptor[] = [];
    const toRender: TileDescriptor[] = [];

    for (const [id] of reasons) {
      const tile = this.ensureTile(id);
      if (!tile) continue;

      tile.lastUsedTick = this.tick;
      tile.cacheState = tile.cacheState === "evicted" ? "cold" : promote(tile.cacheState);
      required.push(tile);

      if (request.includeClean === true || tileNeedsRender(tile)) {
        toRender.push(tile);
      }
    }

    const order = (a: TileDescriptor, b: TileDescriptor): number =>
      a.row - b.row || a.column - b.column;
    required.sort(order);
    toRender.sort(order);

    return {
      required,
      toRender,
      culledCount: Math.max(0, this.grid.columns * this.grid.rows - required.length),
      reasons
    };
  }

  /** Tiles whose content overlaps a rectangle and that need work. */
  selectDirtyTilesInRect(bounds: StageRect): TileDescriptor[] {
    const result: TileDescriptor[] = [];
    for (const id of tileIdsForRect(this.grid, bounds)) {
      const tile = this.tiles.get(id);
      if (tile && tileNeedsRender(tile)) result.push(tile);
      if (!tile) {
        const created = this.ensureTile(id);
        if (created) result.push(created);
      }
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Render lifecycle
  // -------------------------------------------------------------------------

  beginRender(ids: readonly TileId[]): TileDescriptor[] {
    const started: TileDescriptor[] = [];
    for (const id of ids) {
      const tile = this.ensureTile(id);
      if (!tile) continue;
      tile.renderState = "rendering";
      tile.gpuState = tile.gpuState === "allocated" ? "allocated" : "allocating";
      started.push(tile);
    }
    return started;
  }

  completeRender(id: TileId, frame: number): TileDescriptor | undefined {
    const tile = this.tiles.get(id);
    if (!tile) return undefined;

    tile.renderState = "rendered";
    tile.gpuState = "allocated";
    tile.cacheState = "hot";
    tile.dirty = false;
    tile.lastRenderedFrame = frame;
    tile.lastUsedTick = this.tick;
    delete tile.failureReason;
    return tile;
  }

  failRender(id: TileId, reason: string): TileDescriptor | undefined {
    const tile = this.tiles.get(id);
    if (!tile) return undefined;

    tile.renderState = "failed";
    tile.failureReason = reason;
    // Stays dirty so the next frame retries rather than showing a stale tile.
    tile.dirty = true;
    return tile;
  }

  /** Note that an output depends on a tile. Pinned tiles never evict. */
  addOutputRef(id: TileId, outputId: string): void {
    const tile = this.ensureTile(id);
    if (!tile || tile.outputRefs.includes(outputId)) return;
    tile.outputRefs.push(outputId);
  }

  removeOutputRef(id: TileId, outputId: string): void {
    const tile = this.tiles.get(id);
    if (!tile) return;
    tile.outputRefs = tile.outputRefs.filter((candidate) => candidate !== outputId);
  }

  clearOutputRefs(outputId: string): void {
    for (const tile of this.tiles.values()) {
      tile.outputRefs = tile.outputRefs.filter((candidate) => candidate !== outputId);
    }
  }

  // -------------------------------------------------------------------------
  // Eviction
  // -------------------------------------------------------------------------

  /**
   * Evict least-recently-used tiles until both budgets are satisfied.
   *
   * Pinned tiles (referenced by an active output) are never candidates, and
   * neither is anything currently rendering. If the remaining candidates cannot
   * bring us under budget, eviction stops rather than dropping a tile an output
   * is about to transmit — going over budget is recoverable, dropping a live
   * output tile is not.
   */
  evict(): TileId[] {
    const evicted: TileId[] = [];

    const candidates = [...this.tiles.values()]
      .filter(
        (tile) =>
          tile.gpuState === "allocated"
          && tile.renderState !== "rendering"
          && tile.renderState !== "queued"
          && !isTilePinned(tile)
      )
      .sort((a, b) => a.lastUsedTick - b.lastUsedTick);

    for (const tile of candidates) {
      if (!this.overBudget()) break;
      tile.gpuState = "released";
      tile.cacheState = "evicted";
      tile.renderState = "idle";
      tile.dirty = true;
      tile.estimatedBytes = 0;
      evicted.push(tile.tileId);
    }

    return evicted;
  }

  private overBudget(): boolean {
    return this.cacheBytes() > this.cacheBudgetBytes || this.residentCount() > this.maxResidentTiles;
  }

  private residentCount(): number {
    let count = 0;
    for (const tile of this.tiles.values()) {
      if (tile.gpuState === "allocated") count += 1;
    }
    return count;
  }

  cacheBytes(): number {
    let total = 0;
    for (const tile of this.tiles.values()) {
      if (tile.gpuState === "allocated") total += tile.estimatedBytes;
    }
    return total;
  }

  // -------------------------------------------------------------------------
  // Inspection
  // -------------------------------------------------------------------------

  get(id: TileId): TileDescriptor | undefined {
    return this.tiles.get(id);
  }

  /** Descriptors the manager has actually allocated, in grid order. */
  trackedTiles(): TileDescriptor[] {
    return [...this.tiles.values()].sort((a, b) => a.row - b.row || a.column - b.column);
  }

  dirtyTiles(): TileDescriptor[] {
    return this.trackedTiles().filter((tile) => tile.dirty);
  }

  stats(): TileManagerStats {
    let residentTiles = 0;
    let dirtyTiles = 0;
    let renderedTiles = 0;
    let failedTiles = 0;
    let evictedTiles = 0;
    let pinnedTiles = 0;

    for (const tile of this.tiles.values()) {
      if (tile.gpuState === "allocated") residentTiles += 1;
      if (tile.dirty) dirtyTiles += 1;
      if (tile.renderState === "rendered") renderedTiles += 1;
      if (tile.renderState === "failed") failedTiles += 1;
      if (tile.cacheState === "evicted") evictedTiles += 1;
      if (isTilePinned(tile)) pinnedTiles += 1;
    }

    const cacheBytes = this.cacheBytes();

    return {
      totalTiles: this.grid.columns * this.grid.rows,
      trackedTiles: this.tiles.size,
      residentTiles,
      dirtyTiles,
      renderedTiles,
      failedTiles,
      evictedTiles,
      pinnedTiles,
      cacheBytes,
      cacheBudgetBytes: this.cacheBudgetBytes,
      maxResidentTiles: this.maxResidentTiles,
      overBudget: cacheBytes > this.cacheBudgetBytes || residentTiles > this.maxResidentTiles,
      objectCount: this.index.objectCount,
      multiTileObjectCount: this.index.multiTileObjects().length
    };
  }

  /**
   * Create a descriptor on demand, or refresh a stale one.
   *
   * Descriptors are lazy: a grid may have 9,604 tiles while the manager tracks
   * only the dozen anything has ever asked for.
   */
  private ensureTile(id: TileId): TileDescriptor | undefined {
    const existing = this.tiles.get(id);
    if (existing) {
      this.refreshOverscan(existing);
      return existing;
    }

    const coord = parseTileId(id);
    if (!coord || coord.column >= this.grid.columns || coord.row >= this.grid.rows) {
      return undefined;
    }

    const logicalBounds = tileBounds(this.grid, coord);
    const requiredOverscan = this.index.requiredOverscan(id, this.grid.overscan);

    const tile: TileDescriptor = {
      tileId: id,
      column: coord.column,
      row: coord.row,
      logicalBounds,
      renderBounds: tileRenderBounds(this.grid, coord, requiredOverscan),
      activeObjectIds: this.index.objectsInTile(id),
      dirty: true,
      renderState: "idle",
      gpuState: "none",
      cacheState: "cold",
      lastRenderedFrame: null,
      lastUsedTick: this.tick,
      outputRefs: [],
      requiredOverscan,
      estimatedBytes: tileByteEstimate(
        this.grid,
        coord,
        this.bytesPerPixel,
        this.renderScale,
        requiredOverscan
      )
    };

    this.tiles.set(id, tile);
    return tile;
  }

  /**
   * Recompute overscan and membership when the tile's objects changed.
   *
   * A new object with a large blur can raise a tile's overscan requirement, which
   * changes the render target size. Missing that would clip the blur exactly at
   * the seam.
   */
  private refreshOverscan(tile: TileDescriptor): void {
    const requiredOverscan = this.index.requiredOverscan(tile.tileId, this.grid.overscan);
    tile.activeObjectIds = this.index.objectsInTile(tile.tileId);

    if (requiredOverscan === tile.requiredOverscan) return;

    tile.requiredOverscan = requiredOverscan;
    tile.renderBounds = tileRenderBounds(
      this.grid,
      { column: tile.column, row: tile.row },
      requiredOverscan
    );
    tile.estimatedBytes = tileByteEstimate(
      this.grid,
      { column: tile.column, row: tile.row },
      this.bytesPerPixel,
      this.renderScale,
      requiredOverscan
    );
    // The render target changed size, so whatever is in it is unusable.
    tile.dirty = true;
    tile.gpuState = tile.gpuState === "allocated" ? "released" : tile.gpuState;
  }
}

function promote(state: TileCacheState): TileCacheState {
  if (state === "cold") return "warm";
  if (state === "warm") return "hot";
  return state;
}

/** Whether two rectangles could share a tile. Re-exported for callers. */
export function rectsOverlap(a: StageRect, b: StageRect): boolean {
  return rectsIntersect(a, b);
}
