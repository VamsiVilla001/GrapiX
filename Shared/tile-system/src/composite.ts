/**
 * Seam-free tile compositing.
 *
 * Two facts make tiled rendering seamless, and this module encodes both:
 *
 * 1. **Every tile draws every object it overlaps**, using the same world
 *    transform, differing only by which origin was subtracted. An object
 *    crossing a boundary therefore lands on the same world position in both
 *    tiles, so the two halves line up exactly.
 *
 * 2. **Only the inner rectangle is composited.** A tile is rendered at
 *    `renderBounds` (bounds + overscan) so filters have neighbouring pixels to
 *    sample, but the composite reads back only `logicalBounds`. The overscan
 *    ring is sampled and discarded, never written to an output.
 *
 * `verifySeamlessCoverage` turns "seamless" from a claim into an assertion: the
 * composite rectangles must tile the target exactly, with no gap and no overlap.
 */

import {
  intersectRects,
  isEmptyRect,
  rect,
  rectBottom,
  rectRight,
  stageToLocalRect,
  type StagePoint,
  type StageRect
} from "@grapix/stage-model";

import type { TileGrid, TileId } from "./grid.js";
import type { TileDescriptor } from "./state.js";

/**
 * One tile's contribution to a composite target.
 *
 * `sourceInTile` is in the tile's *render target* pixel space, already offset by
 * the overscan ring, so a consumer can blit without re-deriving the padding.
 */
export interface TileCompositeOp {
  tileId: TileId;
  /** Logical rectangle this op contributes. Never includes overscan. */
  logicalRect: StageRect;
  /** Source rectangle inside the tile's render target, in render-target units. */
  sourceInTile: StageRect;
  /** Destination rectangle inside the composite target, in target units. */
  destination: StageRect;
  /** Overscan the tile was rendered with, in logical units. */
  overscan: number;
}

export interface TileCompositePlan {
  /** Logical rectangle being assembled. */
  target: StageRect;
  /** Target size in pixels. */
  targetWidth: number;
  targetHeight: number;
  renderScale: number;
  ops: TileCompositeOp[];
  /** Tiles that overlap the target but are not ready to contribute. */
  missingTileIds: TileId[];
}

/**
 * Where a tile's usable content sits inside its own render target.
 *
 * The render target starts at `renderBounds`, so the inner rectangle begins at
 * exactly the overscan offset. In pixels that is `overscan * renderScale`.
 */
export function tileSourceRect(tile: TileDescriptor, renderScale = 1): StageRect {
  const offset = tile.requiredOverscan * renderScale;
  return rect(
    offset,
    offset,
    tile.logicalBounds.width * renderScale,
    tile.logicalBounds.height * renderScale
  );
}

/**
 * The only rectangle of a tile that may reach an output.
 *
 * Compositing anything wider would double-count the overscan ring and produce
 * a visible seam — the exact failure this module exists to prevent.
 */
export function tileCompositeRect(tile: TileDescriptor): StageRect {
  return { ...tile.logicalBounds };
}

/**
 * Build a composite plan for a logical target rectangle.
 *
 * Only tiles that have actually rendered contribute. Tiles that overlap but are
 * not ready are reported in `missingTileIds` rather than silently omitted, so a
 * caller can choose to wait, to render them, or to accept a partial frame — but
 * never to accept one without knowing.
 */
export function planTileComposite(
  target: StageRect,
  tiles: readonly TileDescriptor[],
  options: { renderScale?: number; requireRendered?: boolean } = {}
): TileCompositePlan {
  const renderScale = options.renderScale ?? 1;
  const requireRendered = options.requireRendered !== false;

  const ops: TileCompositeOp[] = [];
  const missingTileIds: TileId[] = [];

  for (const tile of tiles) {
    const logicalRect = intersectRects(tile.logicalBounds, target);
    if (isEmptyRect(logicalRect)) continue;

    const ready = tile.renderState === "rendered" && tile.gpuState === "allocated";
    if (requireRendered && !ready) {
      missingTileIds.push(tile.tileId);
      continue;
    }

    // Offset within the tile's own content, then shifted past the overscan ring.
    const withinTile = stageToLocalRect(logicalRect, {
      x: tile.logicalBounds.x,
      y: tile.logicalBounds.y
    });
    const overscanOffset = tile.requiredOverscan * renderScale;

    const sourceInTile = rect(
      withinTile.x * renderScale + overscanOffset,
      withinTile.y * renderScale + overscanOffset,
      withinTile.width * renderScale,
      withinTile.height * renderScale
    );

    // Destination is relative to the target's own origin, in target pixels.
    const withinTarget = stageToLocalRect(logicalRect, { x: target.x, y: target.y });
    const destination = rect(
      withinTarget.x * renderScale,
      withinTarget.y * renderScale,
      withinTarget.width * renderScale,
      withinTarget.height * renderScale
    );

    ops.push({
      tileId: tile.tileId,
      logicalRect,
      sourceInTile,
      destination,
      overscan: tile.requiredOverscan
    });
  }

  // Row-major so two engines composite in the same order.
  ops.sort((a, b) => a.logicalRect.y - b.logicalRect.y || a.logicalRect.x - b.logicalRect.x);

  return {
    target: { ...target },
    targetWidth: Math.max(1, Math.ceil(target.width * renderScale)),
    targetHeight: Math.max(1, Math.ceil(target.height * renderScale)),
    renderScale,
    ops,
    missingTileIds
  };
}

export interface SeamGap {
  kind: "gap" | "overlap";
  bounds: StageRect;
  tileIds: TileId[];
}

export interface SeamReport {
  seamless: boolean;
  /** Logical area of the target covered exactly once. */
  coveredArea: number;
  /** Logical area of the target. */
  targetArea: number;
  gaps: SeamGap[];
}

/**
 * Prove a composite plan tiles its target exactly.
 *
 * A gap means a strip of the output would be transparent; an overlap means a
 * strip would be composited twice, which is visible for anything non-opaque.
 * Either is a seam.
 *
 * The check is exact rather than sampled: it sums op areas, compares against the
 * target area, and separately looks for pairwise intersections. Because tile
 * bounds come from a grid partition, a correct plan has zero overlap by
 * construction — this asserts that the construction was not broken.
 */
export function verifySeamlessCoverage(plan: TileCompositePlan): SeamReport {
  const targetArea = Math.max(0, plan.target.width) * Math.max(0, plan.target.height);
  const gaps: SeamGap[] = [];

  let coveredArea = 0;
  for (const op of plan.ops) {
    coveredArea += op.logicalRect.width * op.logicalRect.height;
  }

  // Pairwise overlap. Grid tiles never overlap, so any hit is a real defect.
  for (let i = 0; i < plan.ops.length; i += 1) {
    for (let j = i + 1; j < plan.ops.length; j += 1) {
      const overlap = intersectRects(plan.ops[i].logicalRect, plan.ops[j].logicalRect);
      if (!isEmptyRect(overlap)) {
        gaps.push({
          kind: "overlap",
          bounds: overlap,
          tileIds: [plan.ops[i].tileId, plan.ops[j].tileId]
        });
      }
    }
  }

  // Anything the ops did not cover. Uses an epsilon because logical bounds are
  // f64 and a 50,000-unit target accumulates representation error.
  const epsilon = Math.max(1e-9, targetArea * 1e-12);
  if (targetArea - coveredArea > epsilon) {
    gaps.push({
      kind: "gap",
      bounds: findUncoveredRect(plan),
      tileIds: plan.ops.map((op) => op.tileId)
    });
  }

  return {
    seamless: gaps.length === 0 && plan.missingTileIds.length === 0,
    coveredArea,
    targetArea,
    gaps
  };
}

/**
 * Locate an uncovered area, for a useful diagnostic message.
 *
 * Scans the distinct x and y edges the ops introduce and returns the first cell
 * of that arrangement no op covers. Exact for axis-aligned rectangles, which is
 * all a tile grid ever produces.
 */
function findUncoveredRect(plan: TileCompositePlan): StageRect {
  const xs = new Set<number>([plan.target.x, rectRight(plan.target)]);
  const ys = new Set<number>([plan.target.y, rectBottom(plan.target)]);

  for (const op of plan.ops) {
    xs.add(op.logicalRect.x);
    xs.add(rectRight(op.logicalRect));
    ys.add(op.logicalRect.y);
    ys.add(rectBottom(op.logicalRect));
  }

  const sortedX = [...xs].sort((a, b) => a - b);
  const sortedY = [...ys].sort((a, b) => a - b);

  for (let yi = 0; yi < sortedY.length - 1; yi += 1) {
    for (let xi = 0; xi < sortedX.length - 1; xi += 1) {
      const cell = rect(
        sortedX[xi],
        sortedY[yi],
        sortedX[xi + 1] - sortedX[xi],
        sortedY[yi + 1] - sortedY[yi]
      );
      if (isEmptyRect(cell)) continue;
      if (isEmptyRect(intersectRects(cell, plan.target))) continue;

      const covered = plan.ops.some(
        (op) => !isEmptyRect(intersectRects(cell, op.logicalRect))
      );
      if (!covered) return cell;
    }
  }

  return rect(0, 0, 0, 0);
}

/**
 * Origin to subtract before narrowing a tile's geometry for the GPU.
 *
 * The render target starts at `renderBounds`, not `logicalBounds`, so this is
 * the padded origin. Getting it wrong shifts everything in the tile by the
 * overscan amount.
 */
export function tileLocalOrigin(tile: TileDescriptor): StagePoint {
  return { x: tile.renderBounds.x, y: tile.renderBounds.y };
}

/**
 * An object's geometry expressed in one tile's local space.
 *
 * This is the call sites' single entry point for the precision rule: subtract in
 * f64 here, and only then narrow to f32 for the GPU.
 */
export function objectRectInTile(objectBounds: StageRect, tile: TileDescriptor): StageRect {
  return stageToLocalRect(objectBounds, tileLocalOrigin(tile));
}

/**
 * Clip rectangle for a tile's render pass, in render-target local units.
 *
 * Draws are clipped to the padded target, not to the inner bounds: filters must
 * be allowed to write into the overscan ring so that neighbouring tiles can read
 * consistent values there.
 */
export function tileClipRect(tile: TileDescriptor, renderScale = 1): StageRect {
  return rect(
    0,
    0,
    tile.renderBounds.width * renderScale,
    tile.renderBounds.height * renderScale
  );
}

/**
 * Whole-stage composite plan, tile by tile.
 *
 * Used by the recording output, which assembles a full 50,000-wide frame off the
 * GPU rather than in one texture.
 */
export function planFullStageComposite(
  grid: TileGrid,
  tiles: readonly TileDescriptor[],
  options: { renderScale?: number; requireRendered?: boolean } = {}
): TileCompositePlan {
  return planTileComposite(grid.logicalBounds, tiles, options);
}
