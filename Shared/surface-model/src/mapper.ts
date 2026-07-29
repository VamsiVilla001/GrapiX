/**
 * Surface mapping maths.
 *
 * Three coordinate spaces, kept explicit so nothing silently conflates them:
 *
 *   stage    logical units on the virtual canvas, f64, possibly near 50,000
 *   local    logical units relative to the surface's own top-left, rotation
 *            removed — this is the rebased space that is safe to narrow to f32
 *   device   physical pixels the panel actually lights up
 *
 * Rotation is about the surface centre, which is what an operator expects when
 * they rotate a panel in place.
 */

import {
  intersectRects,
  rect,
  rectsIntersect,
  type StagePoint,
  type StageRect,
  type StageSize
} from "@grapix/stage-model";

import { surfaceDeviceSize, type BezelCompensation, type DisplaySurface } from "./surface.js";

const DEGREES_TO_RADIANS = Math.PI / 180;

/** Unrotated footprint: where the surface would sit at 0 degrees. */
export function surfaceUnrotatedBounds(surface: DisplaySurface): StageRect {
  return rect(surface.position.x, surface.position.y, surface.size.width, surface.size.height);
}

export function surfaceCenter(surface: DisplaySurface): StagePoint {
  return {
    x: surface.position.x + surface.size.width / 2,
    y: surface.position.y + surface.size.height / 2
  };
}

/**
 * Axis-aligned stage bounds of a possibly rotated surface.
 *
 * The tile system needs an AABB to decide which tiles a surface touches, and a
 * rotated panel covers more stage area than its own width and height.
 */
export function surfaceStageBounds(surface: DisplaySurface): StageRect {
  if (surface.rotationDegrees % 360 === 0) {
    return surfaceUnrotatedBounds(surface);
  }

  const center = surfaceCenter(surface);
  const radians = surface.rotationDegrees * DEGREES_TO_RADIANS;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const halfWidth = surface.size.width / 2;
  const halfHeight = surface.size.height / 2;

  const corners: StagePoint[] = [
    { x: -halfWidth, y: -halfHeight },
    { x: halfWidth, y: -halfHeight },
    { x: halfWidth, y: halfHeight },
    { x: -halfWidth, y: halfHeight }
  ].map((corner) => ({
    x: center.x + corner.x * cos - corner.y * sin,
    y: center.y + corner.x * sin + corner.y * cos
  }));

  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);

  return rect(minX, minY, Math.max(...xs) - minX, Math.max(...ys) - minY);
}

/**
 * Stage point to surface-local logical coordinates.
 *
 * The subtraction of the surface centre happens in f64 before anything else,
 * which is the same precision rule the tile system uses.
 */
export function stageToSurfaceLocal(surface: DisplaySurface, value: StagePoint): StagePoint {
  const center = surfaceCenter(surface);
  const dx = value.x - center.x;
  const dy = value.y - center.y;

  const radians = -surface.rotationDegrees * DEGREES_TO_RADIANS;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  return {
    x: dx * cos - dy * sin + surface.size.width / 2,
    y: dx * sin + dy * cos + surface.size.height / 2
  };
}

/** Inverse of {@link stageToSurfaceLocal}. */
export function surfaceLocalToStage(surface: DisplaySurface, value: StagePoint): StagePoint {
  const center = surfaceCenter(surface);
  const dx = value.x - surface.size.width / 2;
  const dy = value.y - surface.size.height / 2;

  const radians = surface.rotationDegrees * DEGREES_TO_RADIANS;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);

  return { x: center.x + dx * cos - dy * sin, y: center.y + dx * sin + dy * cos };
}

/** Surface-local logical coordinates as 0..1 UVs. */
export function surfaceLocalToUv(surface: DisplaySurface, value: StagePoint): StagePoint {
  return {
    x: surface.size.width > 0 ? value.x / surface.size.width : 0,
    y: surface.size.height > 0 ? value.y / surface.size.height : 0
  };
}

export function surfaceUvToLocal(surface: DisplaySurface, uv: StagePoint): StagePoint {
  return { x: uv.x * surface.size.width, y: uv.y * surface.size.height };
}

/**
 * Which part of the stage a surface samples.
 *
 * `direct` uses the surface's own footprint. `normalized` stretches an explicit
 * stage rectangle across the whole surface, which is how one graphic can feed
 * several differently sized ribbons.
 */
export function surfaceSourceRect(surface: DisplaySurface): StageRect {
  if (surface.uvMapping.mode === "normalized") {
    return surface.uvMapping.source;
  }
  return surfaceUnrotatedBounds(surface);
}

/**
 * Stage point to physical pixel on the surface.
 *
 * Returns `undefined` when the point is outside the surface, outside its crop,
 * or hidden behind a compensated bezel. `undefined` means "no pixel here",
 * which is different from pixel (0, 0).
 */
export function stageToSurfacePixel(
  surface: DisplaySurface,
  value: StagePoint
): StagePoint | undefined {
  const local = stageToSurfaceLocal(surface, value);

  if (
    local.x < 0
    || local.y < 0
    || local.x >= surface.size.width
    || local.y >= surface.size.height
  ) {
    return undefined;
  }

  if (surface.crop) {
    const crop = surface.crop;
    if (
      local.x < crop.x
      || local.y < crop.y
      || local.x >= crop.x + crop.width
      || local.y >= crop.y + crop.height
    ) {
      return undefined;
    }
  }

  const device = surfaceDeviceSize(surface);

  if (surface.bezel && surface.bezel.mode === "compensate") {
    return compensatedPixel(surface.bezel, surface.size, device, local);
  }

  return {
    x: (local.x / surface.size.width) * device.width,
    y: (local.y / surface.size.height) * device.height
  };
}

/**
 * Bezel-compensated local-to-device mapping.
 *
 * The surface's logical footprint is its *physical* extent, bezels included.
 * Each panel hides content behind its frame, so a stage point that lands on a
 * bezel has no pixel at all. Everything else is mapped into the panel's visible
 * pixel area, which keeps a line crossing the wall straight in the real world.
 */
function compensatedPixel(
  bezel: BezelCompensation,
  size: StageSize,
  device: { width: number; height: number },
  local: StagePoint
): StagePoint | undefined {
  const x = compensatedAxis(
    local.x,
    size.width,
    device.width,
    bezel.columns,
    bezel.leftLogical,
    bezel.rightLogical
  );
  if (x === undefined) return undefined;

  const y = compensatedAxis(
    local.y,
    size.height,
    device.height,
    bezel.rows,
    bezel.topLogical,
    bezel.bottomLogical
  );
  if (y === undefined) return undefined;

  return { x, y };
}

function compensatedAxis(
  local: number,
  logicalExtent: number,
  deviceExtent: number,
  panels: number,
  leadingBezel: number,
  trailingBezel: number
): number | undefined {
  const panelLogical = logicalExtent / panels;
  const visibleLogical = panelLogical - leadingBezel - trailingBezel;
  if (!(visibleLogical > 0)) return undefined;

  const index = Math.min(panels - 1, Math.max(0, Math.floor(local / panelLogical)));
  const offset = local - index * panelLogical;

  if (offset < leadingBezel || offset >= panelLogical - trailingBezel) {
    return undefined; // hidden behind the frame
  }

  const panelDevice = deviceExtent / panels;
  return index * panelDevice + ((offset - leadingBezel) / visibleLogical) * panelDevice;
}

/** Surfaces whose stage footprint overlaps a rectangle, in draw order. */
export function surfacesForStageRect(
  surfaces: readonly DisplaySurface[],
  bounds: StageRect
): DisplaySurface[] {
  return surfaces
    .filter((surface) => surface.enabled && rectsIntersect(surfaceStageBounds(surface), bounds))
    .slice()
    .sort((a, b) => a.zOrder - b.zOrder || a.surfaceId.localeCompare(b.surfaceId));
}

/** Total stage area covered by enabled surfaces, as their union AABB. */
export function surfaceCoverageBounds(surfaces: readonly DisplaySurface[]): StageRect {
  let result: StageRect | undefined;
  for (const surface of surfaces) {
    if (!surface.enabled) continue;
    const bounds = surfaceStageBounds(surface);
    if (!result) {
      result = bounds;
      continue;
    }
    const minX = Math.min(result.x, bounds.x);
    const minY = Math.min(result.y, bounds.y);
    const maxX = Math.max(result.x + result.width, bounds.x + bounds.width);
    const maxY = Math.max(result.y + result.height, bounds.y + bounds.height);
    result = rect(minX, minY, maxX - minX, maxY - minY);
  }
  return result ?? rect(0, 0, 0, 0);
}

export interface SurfaceOverlap {
  a: string;
  b: string;
  bounds: StageRect;
}

/**
 * Overlapping surface pairs.
 *
 * Overlap is legitimate for blended projectors and a mistake for LED walls, so
 * this reports rather than judges. Validation decides which case applies.
 */
export function findSurfaceOverlaps(surfaces: readonly DisplaySurface[]): SurfaceOverlap[] {
  const overlaps: SurfaceOverlap[] = [];
  const enabled = surfaces.filter((surface) => surface.enabled);

  for (let i = 0; i < enabled.length; i += 1) {
    for (let j = i + 1; j < enabled.length; j += 1) {
      const boundsA = surfaceStageBounds(enabled[i]);
      const boundsB = surfaceStageBounds(enabled[j]);
      if (!rectsIntersect(boundsA, boundsB)) continue;
      overlaps.push({
        a: enabled[i].surfaceId,
        b: enabled[j].surfaceId,
        bounds: intersectRects(boundsA, boundsB)
      });
    }
  }

  return overlaps;
}

/** Total physical pixels driven by enabled surfaces. */
export function totalSurfacePixels(surfaces: readonly DisplaySurface[]): number {
  return surfaces.reduce((total, surface) => {
    if (!surface.enabled) return total;
    const device = surfaceDeviceSize(surface);
    return total + device.width * device.height;
  }, 0);
}
