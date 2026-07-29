/**
 * Tile state and filter overscan.
 *
 * Every tile tracks its identity, logical bounds, active objects, dirty flag,
 * render state, GPU resource state, cache state, last rendered frame, and output
 * references. Three separate state machines, because they genuinely move
 * independently: a tile can be `rendered` and `hot` while its GPU texture has
 * been `released` under memory pressure.
 */

import type { StageRect } from "@grapix/stage-model";

import type { TileId } from "./grid.js";

/** Progress of a tile's render. */
export const TILE_RENDER_STATES = ["idle", "queued", "rendering", "rendered", "failed"] as const;
export type TileRenderState = (typeof TILE_RENDER_STATES)[number];

/** Lifetime of the tile's GPU render target. */
export const TILE_GPU_STATES = ["none", "allocating", "allocated", "released"] as const;
export type TileGpuState = (typeof TILE_GPU_STATES)[number];

/** Residency, which drives eviction order. */
export const TILE_CACHE_STATES = ["cold", "warm", "hot", "evicted"] as const;
export type TileCacheState = (typeof TILE_CACHE_STATES)[number];

/** Why a tile was selected. Kept for diagnostics, not for control flow. */
export const TILE_SELECTION_REASONS = [
  "viewport",
  "output",
  "preview",
  "export",
  "dirty"
] as const;
export type TileSelectionReason = (typeof TILE_SELECTION_REASONS)[number];

export interface TileDescriptor {
  tileId: TileId;
  column: number;
  row: number;
  /** Logical rectangle this tile owns, clipped to the stage. */
  logicalBounds: StageRect;
  /** Logical rectangle actually rendered: bounds plus required overscan. */
  renderBounds: StageRect;
  /** Scene object ids overlapping this tile, including via filter extent. */
  activeObjectIds: string[];
  dirty: boolean;
  renderState: TileRenderState;
  gpuState: TileGpuState;
  cacheState: TileCacheState;
  /** Frame number of the last completed render, or null if never rendered. */
  lastRenderedFrame: number | null;
  /** Monotonic tick of last use, for LRU. */
  lastUsedTick: number;
  /** Outputs currently depending on this tile. */
  outputRefs: string[];
  /** Overscan this tile needs, derived from the filters of its objects. */
  requiredOverscan: number;
  estimatedBytes: number;
  failureReason?: string;
}

// ---------------------------------------------------------------------------
// Filter overscan
// ---------------------------------------------------------------------------

/**
 * A filter that needs pixels from outside its object's bounds.
 *
 * The engine and the browser preview both derive overscan from this, so a blur
 * cannot look different across a tile seam in one renderer and not the other.
 */
export type FilterOverscanSource =
  | { kind: "gaussian-blur"; sigma: number }
  | { kind: "box-blur"; radius: number }
  | { kind: "drop-shadow"; sigma: number; offsetX: number; offsetY: number }
  | { kind: "glow"; sigma: number; spread?: number }
  | { kind: "outline"; width: number }
  /** Escape hatch: an effect that declares its own extent in logical units. */
  | { kind: "custom"; extent: number };

/**
 * Sigma-to-radius factor for a Gaussian.
 *
 * Three sigma captures 99.7% of the kernel. Truncating tighter than this is
 * visible as a hard edge exactly where a tile seam would be, which is the one
 * place it must not be visible.
 */
export const GAUSSIAN_SIGMA_RADIUS_FACTOR = 3;

/** Logical units a single filter reaches beyond its source. */
export function filterExtent(filter: FilterOverscanSource): number {
  switch (filter.kind) {
    case "gaussian-blur":
      return Math.ceil(Math.max(0, filter.sigma) * GAUSSIAN_SIGMA_RADIUS_FACTOR);
    case "box-blur":
      return Math.ceil(Math.max(0, filter.radius));
    case "drop-shadow":
      return (
        Math.ceil(Math.max(0, filter.sigma) * GAUSSIAN_SIGMA_RADIUS_FACTOR)
        + Math.ceil(Math.max(Math.abs(filter.offsetX), Math.abs(filter.offsetY)))
      );
    case "glow":
      return (
        Math.ceil(Math.max(0, filter.sigma) * GAUSSIAN_SIGMA_RADIUS_FACTOR)
        + Math.ceil(Math.max(0, filter.spread ?? 0))
      );
    case "outline":
      return Math.ceil(Math.max(0, filter.width));
    case "custom":
      return Math.ceil(Math.max(0, filter.extent));
    default:
      return 0;
  }
}

/**
 * Combined extent of a filter stack.
 *
 * Filters compose by summing: a blur followed by a drop shadow reaches further
 * than either alone. Taking the maximum would under-pad and produce seams.
 */
export function filterStackExtent(filters: readonly FilterOverscanSource[]): number {
  return filters.reduce((total, filter) => total + filterExtent(filter), 0);
}

/** Overscan a tile needs, given the extents of the objects touching it. */
export function requiredTileOverscan(
  objectExtents: readonly number[],
  minimumOverscan = 0
): number {
  let maximum = minimumOverscan;
  for (const extent of objectExtents) {
    if (extent > maximum) maximum = extent;
  }
  return Math.max(0, Math.ceil(maximum));
}

// ---------------------------------------------------------------------------
// Descriptor helpers
// ---------------------------------------------------------------------------

export function isTileRenderable(tile: TileDescriptor): boolean {
  return tile.renderState !== "rendering" && tile.renderState !== "queued";
}

/** A tile needs work when it has never rendered or has been invalidated. */
export function tileNeedsRender(tile: TileDescriptor): boolean {
  return (
    tile.dirty
    || tile.lastRenderedFrame === null
    || tile.renderState === "failed"
    || tile.cacheState === "evicted"
    || tile.gpuState === "released"
  );
}

/** Tiles referenced by an output must never be evicted. */
export function isTilePinned(tile: TileDescriptor): boolean {
  return tile.outputRefs.length > 0;
}
