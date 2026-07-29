/**
 * Physical display surfaces.
 *
 * `@grapix/stage-model` knows *where* a surface sits (`StageSurfacePlacement`).
 * This module knows *what it physically is*: panel kind, pixel density, pixel
 * aspect, monitor bezels, projector warp, edge blending, and colour profile.
 *
 * Warp and edge-blend *maths* are deliberately not implemented yet, and the
 * types say so. The data model and the renderer interfaces carry them now so
 * adding calibration later is a feature, not an architecture change.
 */

import {
  clamp,
  finiteOr,
  normalizePoint,
  normalizeRect,
  positiveOr,
  rect,
  type StagePoint,
  type StageRect,
  type StageSurfacePlacement
} from "@grapix/stage-model";

export type DisplaySurfaceKind =
  | "led-wall"
  | "curved-led"
  | "projection"
  | "ribbon"
  | "scoreboard"
  | "multi-monitor"
  | "stadium"
  | "virtual-production"
  | "irregular";

export const DISPLAY_SURFACE_KINDS: readonly DisplaySurfaceKind[] = [
  "led-wall",
  "curved-led",
  "projection",
  "ribbon",
  "scoreboard",
  "multi-monitor",
  "stadium",
  "virtual-production",
  "irregular"
];

/**
 * How stage pixels land on the surface.
 *
 * `direct` samples the stage rectangle the surface occupies, one logical pixel
 * per surface pixel. `normalized` stretches an explicit stage rectangle across
 * the whole surface, which is how one source feeds several differently sized
 * ribbons. `explicit` gives per-corner UVs for irregular panels.
 */
export type SurfaceUvMapping =
  | { mode: "direct" }
  | { mode: "normalized"; source: StageRect }
  | { mode: "explicit"; corners: SurfaceUvCorners };

export interface SurfaceUvCorners {
  topLeft: StagePoint;
  topRight: StagePoint;
  bottomRight: StagePoint;
  bottomLeft: StagePoint;
}

/**
 * Gaps between monitors in a video wall.
 *
 * When `mode` is `compensate` the bezel width is consumed from the image, so a
 * line crossing the wall stays straight across the physical gap. When it is
 * `ignore` the image is continuous in pixel space and the gap eats content.
 */
export interface BezelCompensation {
  mode: "ignore" | "compensate";
  /** Logical units hidden behind each edge of every panel. */
  topLogical: number;
  rightLogical: number;
  bottomLogical: number;
  leftLogical: number;
  /** Panel grid, for walls built from identical monitors. */
  columns: number;
  rows: number;
}

/**
 * Geometric correction data.
 *
 * `implemented` is always false in this phase. The renderer reads the data,
 * reports the surface as uncalibrated, and renders unwarped rather than
 * silently pretending the correction was applied.
 */
export interface SurfaceWarp {
  mode: "none" | "grid" | "mesh" | "cylindrical" | "spherical";
  /** Control-point grid dimensions for `grid`/`mesh`. */
  columns: number;
  rows: number;
  /**
   * Control points in normalised surface space, row-major, `columns * rows`
   * entries. Empty means "declared but not yet calibrated".
   */
  controlPoints: StagePoint[];
  /** Radius in logical units for `cylindrical`/`spherical`. */
  radiusLogical?: number;
  /** Arc covered in degrees for curved surfaces. */
  arcDegrees?: number;
  /** False until the warp compositor exists. Never claim otherwise. */
  implemented: false;
}

/**
 * Projector overlap blending.
 *
 * Same honesty rule as warp: the data is carried and reported, the maths is a
 * later phase.
 */
export interface EdgeBlend {
  enabled: boolean;
  /** Blend widths in logical units on each edge. */
  topLogical: number;
  rightLogical: number;
  bottomLogical: number;
  leftLogical: number;
  /** Blend falloff curve exponent. 1 is linear. */
  gamma: number;
  implemented: false;
}

/**
 * A physical display placed on the stage.
 *
 * Extends the stage's placement view rather than duplicating it, so the stage
 * document and the surface layout cannot disagree about where a surface is.
 */
export interface DisplaySurface extends StageSurfacePlacement {
  kind: DisplaySurfaceKind;
  uvMapping: SurfaceUvMapping;
  /** Physical device resolution, when it differs from the logical footprint. */
  deviceWidth?: number;
  deviceHeight?: number;
  /** Logical units per physical millimetre. */
  pixelDensity: number;
  pixelAspectRatio: number;
  bezel?: BezelCompensation;
  warp?: SurfaceWarp;
  edgeBlend?: EdgeBlend;
  /** Reference into a colour-profile registry; not the profile itself. */
  colorProfileRef?: string;
  /** Draw order when surfaces overlap on the stage. */
  zOrder: number;
}

export const DEFAULT_UV_MAPPING: Readonly<SurfaceUvMapping> = Object.freeze({ mode: "direct" });

export function createDisplaySurface(
  surfaceId: string,
  overrides: Partial<DisplaySurface> = {}
): DisplaySurface {
  return normalizeDisplaySurface({ ...overrides, surfaceId });
}

export function normalizeDisplaySurface(
  value: Partial<DisplaySurface> & { surfaceId: string }
): DisplaySurface {
  const kind: DisplaySurfaceKind = DISPLAY_SURFACE_KINDS.includes(value.kind as DisplaySurfaceKind)
    ? (value.kind as DisplaySurfaceKind)
    : "led-wall";

  const size = {
    width: Math.max(0, positiveOr(value.size?.width, 1920)),
    height: Math.max(0, positiveOr(value.size?.height, 1080))
  };

  const surface: DisplaySurface = {
    surfaceId: value.surfaceId,
    name: value.name?.trim() || value.surfaceId,
    position: normalizePoint(value.position, { x: 0, y: 0 }),
    size,
    rotationDegrees: finiteOr(value.rotationDegrees, 0),
    enabled: value.enabled !== false,
    kind,
    uvMapping: normalizeUvMapping(value.uvMapping, size),
    pixelDensity: clamp(positiveOr(value.pixelDensity, 1), 1 / 1000, 1000),
    pixelAspectRatio: clamp(positiveOr(value.pixelAspectRatio, 1), 1 / 16, 16),
    zOrder: Math.round(finiteOr(value.zOrder, 0))
  };

  if (value.crop) {
    surface.crop = normalizeRect(value.crop, rect(0, 0, size.width, size.height));
  }
  if (typeof value.outputId === "string" && value.outputId) {
    surface.outputId = value.outputId;
  }
  if (value.deviceWidth !== undefined) {
    surface.deviceWidth = Math.round(clamp(positiveOr(value.deviceWidth, size.width), 1, 262_144));
  }
  if (value.deviceHeight !== undefined) {
    surface.deviceHeight = Math.round(
      clamp(positiveOr(value.deviceHeight, size.height), 1, 262_144)
    );
  }
  if (value.bezel) {
    surface.bezel = normalizeBezel(value.bezel);
  }
  if (value.warp) {
    surface.warp = normalizeWarp(value.warp);
  }
  if (value.edgeBlend) {
    surface.edgeBlend = normalizeEdgeBlend(value.edgeBlend);
  }
  if (typeof value.colorProfileRef === "string" && value.colorProfileRef) {
    surface.colorProfileRef = value.colorProfileRef;
  }

  return surface;
}

function normalizeUvMapping(
  value: SurfaceUvMapping | undefined,
  size: { width: number; height: number }
): SurfaceUvMapping {
  if (value?.mode === "normalized") {
    return { mode: "normalized", source: normalizeRect(value.source, rect(0, 0, size.width, size.height)) };
  }
  if (value?.mode === "explicit") {
    return {
      mode: "explicit",
      corners: {
        topLeft: normalizePoint(value.corners?.topLeft, { x: 0, y: 0 }),
        topRight: normalizePoint(value.corners?.topRight, { x: 1, y: 0 }),
        bottomRight: normalizePoint(value.corners?.bottomRight, { x: 1, y: 1 }),
        bottomLeft: normalizePoint(value.corners?.bottomLeft, { x: 0, y: 1 })
      }
    };
  }
  return { mode: "direct" };
}

function normalizeBezel(value: Partial<BezelCompensation>): BezelCompensation {
  return {
    mode: value.mode === "compensate" ? "compensate" : "ignore",
    topLogical: Math.max(0, finiteOr(value.topLogical, 0)),
    rightLogical: Math.max(0, finiteOr(value.rightLogical, 0)),
    bottomLogical: Math.max(0, finiteOr(value.bottomLogical, 0)),
    leftLogical: Math.max(0, finiteOr(value.leftLogical, 0)),
    columns: Math.round(clamp(positiveOr(value.columns, 1), 1, 4096)),
    rows: Math.round(clamp(positiveOr(value.rows, 1), 1, 4096))
  };
}

function normalizeWarp(value: Partial<SurfaceWarp>): SurfaceWarp {
  const mode: SurfaceWarp["mode"] =
    value.mode === "grid"
    || value.mode === "mesh"
    || value.mode === "cylindrical"
    || value.mode === "spherical"
      ? value.mode
      : "none";

  const warp: SurfaceWarp = {
    mode,
    columns: Math.round(clamp(positiveOr(value.columns, 2), 2, 256)),
    rows: Math.round(clamp(positiveOr(value.rows, 2), 2, 256)),
    controlPoints: Array.isArray(value.controlPoints)
      ? value.controlPoints.map((candidate) => normalizePoint(candidate, { x: 0, y: 0 }))
      : [],
    implemented: false
  };

  if (value.radiusLogical !== undefined) {
    warp.radiusLogical = positiveOr(value.radiusLogical, 1);
  }
  if (value.arcDegrees !== undefined) {
    warp.arcDegrees = clamp(finiteOr(value.arcDegrees, 0), -360, 360);
  }

  return warp;
}

function normalizeEdgeBlend(value: Partial<EdgeBlend>): EdgeBlend {
  return {
    enabled: value.enabled === true,
    topLogical: Math.max(0, finiteOr(value.topLogical, 0)),
    rightLogical: Math.max(0, finiteOr(value.rightLogical, 0)),
    bottomLogical: Math.max(0, finiteOr(value.bottomLogical, 0)),
    leftLogical: Math.max(0, finiteOr(value.leftLogical, 0)),
    gamma: clamp(positiveOr(value.gamma, 1), 0.1, 10),
    implemented: false
  };
}

/**
 * Physical resolution a surface actually drives.
 *
 * Defaults to the logical footprint. Declaring a device resolution different
 * from the logical size is how a 2,000-logical-unit-wide ribbon can be a
 * 7,680-pixel-wide physical panel.
 */
export function surfaceDeviceSize(surface: DisplaySurface): { width: number; height: number } {
  return {
    width: surface.deviceWidth ?? Math.max(1, Math.round(surface.size.width)),
    height: surface.deviceHeight ?? Math.max(1, Math.round(surface.size.height))
  };
}

/** Surface footprint in real-world millimetres, when density is meaningful. */
export function surfacePhysicalSize(
  surface: DisplaySurface
): { widthMillimetres: number; heightMillimetres: number } | undefined {
  if (!(surface.pixelDensity > 0)) return undefined;
  return {
    widthMillimetres: surface.size.width / surface.pixelDensity,
    heightMillimetres: surface.size.height / surface.pixelDensity
  };
}

/** Whether any declared correction is still awaiting an implementation. */
export function surfaceCalibrationPending(surface: DisplaySurface): boolean {
  const warpPending = surface.warp !== undefined && surface.warp.mode !== "none";
  const blendPending = surface.edgeBlend?.enabled === true;
  const bezelPending = surface.bezel?.mode === "compensate";
  return warpPending || blendPending || bezelPending;
}
