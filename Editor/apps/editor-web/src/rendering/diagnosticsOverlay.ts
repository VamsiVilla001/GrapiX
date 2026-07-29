/**
 * Editor diagnostic overlay geometry.
 *
 * Requirement 11: the Editor draws tile boundaries, surface outlines, camera
 * frames, safe areas, and labels in a DOM/SVG layer *above* the graphics canvas,
 * and these must never appear in Preview or Program.
 *
 * That guarantee is structural rather than a convention. This module computes
 * geometry only — it returns plain numbers for an SVG layer and touches no
 * renderer, no scene document, and nothing the engine ever sees. There is no code
 * path by which an overlay could reach an output, because nothing here produces
 * anything an output could consume.
 *
 * Every returned shape carries `editorOnly: true`, so a consumer that ever did try
 * to feed one to a renderer would be doing so against an explicit marker.
 */

import {
  canvasBounds,
  intersectRects,
  resolveSafeAreaRect,
  type StageDocument,
  type StageRect
} from "@grapix/stage-model";
import { createTileGrid, tileBounds, tileId, tilesForRect } from "@grapix/tile-system";

/** A rectangle in screen pixels, ready for an SVG `rect`. */
export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type OverlayShapeKind =
  | "tile"
  | "tile-dirty"
  | "surface"
  | "surface-uncalibrated"
  | "region"
  | "viewport"
  | "camera-frame"
  | "safe-area";

export interface OverlayShape {
  kind: OverlayShapeKind;
  /** Stable identity, so React can key on it. */
  id: string;
  screen: OverlayRect;
  /** Logical rectangle this shape represents, for tooltips. */
  logical: StageRect;
  label?: string;
  /** Always true. A structural marker, not a flag to be checked at runtime. */
  editorOnly: true;
}

/**
 * Maps logical stage coordinates to screen pixels.
 *
 * The Editor viewport is a window onto the stage: `visibleLogical` is what the
 * operator has scrolled to, and `screenWidth`/`screenHeight` is the element it is
 * drawn into. On a 50,000-wide stage the visible window is a small fraction of the
 * whole thing, which is why overlay generation must be driven by it.
 */
export interface OverlayViewTransform {
  visibleLogical: StageRect;
  screenWidth: number;
  screenHeight: number;
}

export function logicalToScreen(
  transform: OverlayViewTransform,
  logical: StageRect
): OverlayRect {
  const scaleX =
    transform.visibleLogical.width > 0
      ? transform.screenWidth / transform.visibleLogical.width
      : 0;
  const scaleY =
    transform.visibleLogical.height > 0
      ? transform.screenHeight / transform.visibleLogical.height
      : 0;

  return {
    x: (logical.x - transform.visibleLogical.x) * scaleX,
    y: (logical.y - transform.visibleLogical.y) * scaleY,
    width: logical.width * scaleX,
    height: logical.height * scaleY
  };
}

export interface OverlayOptions {
  /** Draw the tile grid. Off by default; it is a diagnostic, not chrome. */
  showTiles?: boolean;
  /** Mark tiles the engine reports as dirty. */
  dirtyTileIds?: readonly string[];
  showSurfaces?: boolean;
  showRegions?: boolean;
  showViewports?: boolean;
  showSafeAreas?: boolean;
  /** Label each shape. Useful on a big stage, noisy on a small one. */
  showLabels?: boolean;
  /**
   * Cap on tile rectangles produced.
   *
   * A 512-tile grid over a 50,000² stage has 9,604 tiles. Emitting an SVG node per
   * tile would make the overlay slower than the renderer, so generation stops and
   * says it stopped rather than quietly truncating.
   */
  maxTileShapes?: number;
}

export interface OverlayResult {
  shapes: OverlayShape[];
  /** True when tile generation hit `maxTileShapes`. */
  tilesTruncated: boolean;
  /** Tiles overlapping the visible area, whether or not shapes were emitted. */
  visibleTileCount: number;
}

const DEFAULT_MAX_TILE_SHAPES = 400;

/**
 * Build the overlay for the currently visible part of a stage.
 *
 * Only ever considers the visible window, so cost is bounded by what is on screen
 * rather than by stage size.
 */
export function buildDiagnosticsOverlay(
  stage: StageDocument,
  transform: OverlayViewTransform,
  options: OverlayOptions = {}
): OverlayResult {
  const shapes: OverlayShape[] = [];
  const stageRect = canvasBounds(stage.canvas);
  const visible = intersectRects(transform.visibleLogical, stageRect);

  const context = {
    canvas: stage.canvas,
    regions: stage.regions,
    surfaces: stage.surfaces
  };

  let tilesTruncated = false;
  let visibleTileCount = 0;

  if (stage.tiling.enabled) {
    const grid = createTileGrid(stage.canvas, stage.tiling);
    const coords = tilesForRect(grid, visible);
    visibleTileCount = coords.length;

    if (options.showTiles) {
      const limit = options.maxTileShapes ?? DEFAULT_MAX_TILE_SHAPES;
      const dirty = new Set(options.dirtyTileIds ?? []);
      tilesTruncated = coords.length > limit;

      for (const coord of coords.slice(0, limit)) {
        const id = tileId(coord.column, coord.row);
        const logical = tileBounds(grid, coord);
        shapes.push({
          kind: dirty.has(id) ? "tile-dirty" : "tile",
          id: `tile:${id}`,
          screen: logicalToScreen(transform, logical),
          logical,
          ...(options.showLabels ? { label: id } : {}),
          editorOnly: true
        });
      }
    }
  }

  if (options.showRegions) {
    for (const region of stage.regions) {
      const logical = intersectRects(region.bounds, visible);
      if (logical.width <= 0 || logical.height <= 0) continue;
      shapes.push({
        kind: "region",
        id: `region:${region.regionId}`,
        screen: logicalToScreen(transform, logical),
        logical,
        ...(options.showLabels ? { label: region.name } : {}),
        editorOnly: true
      });
    }
  }

  if (options.showSurfaces) {
    for (const surface of stage.surfaces) {
      const bounds = {
        x: surface.position.x,
        y: surface.position.y,
        width: surface.size.width,
        height: surface.size.height
      };
      const logical = intersectRects(bounds, visible);
      if (logical.width <= 0 || logical.height <= 0) continue;

      // An uncalibrated surface is drawn differently, because the operator needs
      // to see that what is on screen is not what the projector will show.
      const uncalibrated = surface.crop !== undefined && surface.rotationDegrees !== 0;

      shapes.push({
        kind: uncalibrated ? "surface-uncalibrated" : "surface",
        id: `surface:${surface.surfaceId}`,
        screen: logicalToScreen(transform, logical),
        logical,
        ...(options.showLabels
          ? {
              label: surface.outputId
                ? `${surface.name} → ${surface.outputId}`
                : `${surface.name} (unassigned)`
            }
          : {}),
        editorOnly: true
      });
    }
  }

  if (options.showViewports) {
    for (const viewport of stage.viewports) {
      if (!viewport.enabled) continue;

      const source = resolveViewportRectLocal(stage, viewport.source);
      const logical = intersectRects(source, visible);
      if (logical.width <= 0 || logical.height <= 0) continue;

      // A viewport with a camera bound to it is drawn as a camera frame, which is
      // the thing an operator is actually looking for.
      const camera = stage.cameras.find(
        (candidate) => candidate.viewportId === viewport.viewportId && candidate.enabled
      );

      shapes.push({
        kind: camera ? "camera-frame" : "viewport",
        id: `viewport:${viewport.viewportId}`,
        screen: logicalToScreen(transform, logical),
        logical,
        ...(options.showLabels
          ? {
              label: camera
                ? `${camera.name} (${camera.projection})`
                : `${viewport.name} @ ${viewport.renderScale.toFixed(4)}`
            }
          : {}),
        editorOnly: true
      });
    }
  }

  if (options.showSafeAreas) {
    for (const safeArea of stage.safeAreas) {
      const resolved = resolveSafeAreaRect(context, safeArea);
      const logical = intersectRects(resolved, visible);
      if (logical.width <= 0 || logical.height <= 0) continue;
      shapes.push({
        kind: "safe-area",
        id: `safe:${safeArea.safeAreaId}`,
        screen: logicalToScreen(transform, logical),
        logical,
        ...(options.showLabels ? { label: safeArea.name } : {}),
        editorOnly: true
      });
    }
  }

  return { shapes, tilesTruncated, visibleTileCount };
}

function resolveViewportRectLocal(
  stage: StageDocument,
  source: StageDocument["viewports"][number]["source"]
): StageRect {
  const stageRect = canvasBounds(stage.canvas);

  switch (source.type) {
    case "region": {
      const region = stage.regions.find((candidate) => candidate.regionId === source.regionId);
      return region ? region.bounds : stageRect;
    }
    case "surface": {
      const surface = stage.surfaces.find(
        (candidate) => candidate.surfaceId === source.surfaceId
      );
      return surface
        ? {
            x: surface.position.x,
            y: surface.position.y,
            width: surface.size.width,
            height: surface.size.height
          }
        : stageRect;
    }
    case "rect":
      return source.bounds;
    default:
      return stageRect;
  }
}

/**
 * Assert that no overlay shape can reach an output.
 *
 * A cheap invariant check for tests and for a development assertion. It holds by
 * construction — nothing here builds a renderable object — and this makes the
 * guarantee explicit rather than implicit.
 */
export function assertOverlayIsEditorOnly(shapes: readonly OverlayShape[]): void {
  for (const shape of shapes) {
    if (shape.editorOnly !== true) {
      throw new Error(
        `overlay shape ${shape.id} is not marked editor-only; diagnostic overlays must never reach Preview or Program`
      );
    }
  }
}
