/**
 * Stage structure: safe areas, regions, viewports, cameras, surface placements
 * and tiling configuration.
 *
 * These are the concepts that requirement 5 insists must never collapse into a
 * single width x height pair:
 *
 *   Region    a named logical rectangle (authoring and routing convenience)
 *   Viewport  WHAT is looked at  — a logical rect plus a render scale
 *   Camera    HOW it is looked at — projection and transform, into a viewport
 *   Surface   a physical display placed somewhere on the stage
 */

import {
  clamp,
  finiteOr,
  insetRect,
  intersectRects,
  normalizeInsets,
  normalizePoint,
  normalizeRect,
  positiveOr,
  rect,
  ZERO_INSETS,
  type StageInsets,
  type StagePoint,
  type StageRect,
  type StageSize
} from "./geometry.js";
import { canvasBounds, type VirtualCanvas } from "./canvas.js";

// ---------------------------------------------------------------------------
// Safe areas
// ---------------------------------------------------------------------------

export type StageSafeAreaKind = "action" | "title" | "custom";

/** What a safe area is measured against. */
export type StageSafeAreaScope =
  | { type: "stage" }
  | { type: "region"; regionId: string }
  | { type: "surface"; surfaceId: string };

export interface StageSafeArea {
  safeAreaId: string;
  name: string;
  kind: StageSafeAreaKind;
  scope: StageSafeAreaScope;
  /** Logical-unit insets from the scope's edges. */
  insets: StageInsets;
  /** Editor guide only. Never rendered to Preview or Program. */
  editorOnly: boolean;
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

export interface StageRegion {
  regionId: string;
  name: string;
  bounds: StageRect;
  /** Free-form operator grouping, e.g. "house-left", "ribbon". */
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Surface placement
// ---------------------------------------------------------------------------

/**
 * Where a physical display sits on the stage.
 *
 * This is deliberately the minimum the *stage* needs to know. The physical
 * detail — panel kind, pixel density, bezels, warp, edge blending, colour
 * profile — lives in `@grapix/surface-model`, whose `DisplaySurface` extends
 * this interface. The stage cares where a surface is; the surface model cares
 * what it is.
 */
export interface StageSurfacePlacement {
  surfaceId: string;
  name: string;
  position: StagePoint;
  size: StageSize;
  rotationDegrees: number;
  /** Sub-rectangle of the surface actually driven, in surface-local units. */
  crop?: StageRect;
  /** Output this surface is fed by, if assigned. */
  outputId?: string;
  enabled: boolean;
}

export function surfacePlacementBounds(placement: StageSurfacePlacement): StageRect {
  return rect(
    placement.position.x,
    placement.position.y,
    placement.size.width,
    placement.size.height
  );
}

// ---------------------------------------------------------------------------
// Viewports
// ---------------------------------------------------------------------------

/** What logical area a viewport covers. */
export type StageViewportSource =
  | { type: "full-stage" }
  | { type: "region"; regionId: string }
  | { type: "surface"; surfaceId: string }
  | { type: "rect"; bounds: StageRect };

export interface StageViewport {
  viewportId: string;
  name: string;
  source: StageViewportSource;
  /**
   * Logical-to-render pixel ratio for this viewport.
   *
   * This is how a 50,000 x 10,000 stage becomes a 1920 x 384 operator preview:
   * one viewport over the full stage at renderScale 0.0384.
   */
  renderScale: number;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Cameras
// ---------------------------------------------------------------------------

export type StageCameraProjection = "orthographic" | "perspective";

export interface StageCameraTransform {
  x: number;
  y: number;
  z: number;
  rotationX: number;
  rotationY: number;
  rotationZ: number;
}

export interface StageOrthographicCamera {
  /** Logical width covered by the camera. Height follows the viewport aspect. */
  logicalWidth: number;
  near: number;
  far: number;
}

export interface StagePerspectiveCamera {
  fovYDegrees: number;
  near: number;
  far: number;
}

/**
 * Binds a camera to a viewport.
 *
 * `sceneCameraId` optionally links to a `camera` object inside a SceneDocument,
 * so an authored scene camera can drive a stage viewport without the stage
 * document duplicating its animated transform.
 */
export interface StageCameraMapping {
  cameraId: string;
  name: string;
  viewportId: string;
  projection: StageCameraProjection;
  transform: StageCameraTransform;
  orthographic?: StageOrthographicCamera;
  perspective?: StagePerspectiveCamera;
  sceneCameraId?: string;
  enabled: boolean;
}

export const IDENTITY_CAMERA_TRANSFORM: Readonly<StageCameraTransform> = Object.freeze({
  x: 0,
  y: 0,
  z: 0,
  rotationX: 0,
  rotationY: 0,
  rotationZ: 0
});

// ---------------------------------------------------------------------------
// Tiling
// ---------------------------------------------------------------------------

/** Tile sizes offered as presets. Any positive power-of-two size is accepted. */
export const TILE_SIZE_PRESETS = [512, 1024, 2048, 4096] as const;
export type TileSizePreset = (typeof TILE_SIZE_PRESETS)[number];

export const DEFAULT_TILE_SIZE = 1024;
export const MIN_TILE_SIZE = 64;
export const MAX_TILE_SIZE = 8192;

/**
 * How the stage is decomposed for rendering.
 *
 * Lives in the stage document because it is a property of the installation, not
 * of a scene. `@grapix/tile-system` consumes this and owns the grid maths.
 */
export interface StageTilingConfig {
  enabled: boolean;
  tileWidth: number;
  tileHeight: number;
  /**
   * Logical-unit padding rendered outside each tile so filters have neighbouring
   * pixels to sample. The overscan ring is sampled and then discarded, which is
   * what makes the composite seam-free.
   */
  overscan: number;
  /** Resident tile ceiling. Beyond this the least-recently-used tiles evict. */
  maxResidentTiles: number;
  /** GPU byte budget for the tile cache. */
  cacheBudgetBytes: number;
}

export const DEFAULT_STAGE_TILING: Readonly<StageTilingConfig> = Object.freeze({
  enabled: true,
  tileWidth: DEFAULT_TILE_SIZE,
  tileHeight: DEFAULT_TILE_SIZE,
  overscan: 32,
  maxResidentTiles: 256,
  cacheBudgetBytes: 512 * 1024 * 1024
});

export function normalizeStageTiling(
  value: Partial<StageTilingConfig> | undefined
): StageTilingConfig {
  return {
    enabled: value?.enabled !== false,
    tileWidth: Math.round(
      clamp(positiveOr(value?.tileWidth, DEFAULT_TILE_SIZE), MIN_TILE_SIZE, MAX_TILE_SIZE)
    ),
    tileHeight: Math.round(
      clamp(positiveOr(value?.tileHeight, DEFAULT_TILE_SIZE), MIN_TILE_SIZE, MAX_TILE_SIZE)
    ),
    overscan: Math.round(clamp(finiteOr(value?.overscan, 32), 0, 1024)),
    maxResidentTiles: Math.round(clamp(positiveOr(value?.maxResidentTiles, 256), 1, 65_536)),
    cacheBudgetBytes: Math.round(
      clamp(positiveOr(value?.cacheBudgetBytes, 512 * 1024 * 1024), 1024 * 1024, 64 * 1024 ** 3)
    )
  };
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

export function normalizeSafeArea(
  value: Partial<StageSafeArea> & { safeAreaId: string }
): StageSafeArea {
  const kind: StageSafeAreaKind =
    value.kind === "title" || value.kind === "custom" ? value.kind : "action";
  return {
    safeAreaId: value.safeAreaId,
    name: value.name?.trim() || value.safeAreaId,
    kind,
    scope: normalizeSafeAreaScope(value.scope),
    insets: normalizeInsets(value.insets, ZERO_INSETS),
    editorOnly: value.editorOnly !== false
  };
}

function normalizeSafeAreaScope(value: StageSafeAreaScope | undefined): StageSafeAreaScope {
  if (value?.type === "region" && typeof value.regionId === "string" && value.regionId) {
    return { type: "region", regionId: value.regionId };
  }
  if (value?.type === "surface" && typeof value.surfaceId === "string" && value.surfaceId) {
    return { type: "surface", surfaceId: value.surfaceId };
  }
  return { type: "stage" };
}

export function normalizeRegion(value: Partial<StageRegion> & { regionId: string }): StageRegion {
  const region: StageRegion = {
    regionId: value.regionId,
    name: value.name?.trim() || value.regionId,
    bounds: normalizeRect(value.bounds, rect(0, 0, 0, 0))
  };
  const tags = Array.isArray(value.tags)
    ? value.tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0)
    : undefined;
  return tags && tags.length > 0 ? { ...region, tags } : region;
}

export function normalizeSurfacePlacement(
  value: Partial<StageSurfacePlacement> & { surfaceId: string }
): StageSurfacePlacement {
  const placement: StageSurfacePlacement = {
    surfaceId: value.surfaceId,
    name: value.name?.trim() || value.surfaceId,
    position: normalizePoint(value.position, { x: 0, y: 0 }),
    size: {
      width: Math.max(0, positiveOr(value.size?.width, 0)),
      height: Math.max(0, positiveOr(value.size?.height, 0))
    },
    rotationDegrees: finiteOr(value.rotationDegrees, 0),
    enabled: value.enabled !== false
  };
  if (value.crop) {
    placement.crop = normalizeRect(value.crop, rect(0, 0, placement.size.width, placement.size.height));
  }
  if (typeof value.outputId === "string" && value.outputId) {
    placement.outputId = value.outputId;
  }
  return placement;
}

export function normalizeViewport(
  value: Partial<StageViewport> & { viewportId: string }
): StageViewport {
  return {
    viewportId: value.viewportId,
    name: value.name?.trim() || value.viewportId,
    source: normalizeViewportSource(value.source),
    renderScale: clamp(positiveOr(value.renderScale, 1), 1 / 4096, 16),
    enabled: value.enabled !== false
  };
}

function normalizeViewportSource(value: StageViewportSource | undefined): StageViewportSource {
  if (value?.type === "region" && typeof value.regionId === "string" && value.regionId) {
    return { type: "region", regionId: value.regionId };
  }
  if (value?.type === "surface" && typeof value.surfaceId === "string" && value.surfaceId) {
    return { type: "surface", surfaceId: value.surfaceId };
  }
  if (value?.type === "rect") {
    return { type: "rect", bounds: normalizeRect(value.bounds, rect(0, 0, 0, 0)) };
  }
  return { type: "full-stage" };
}

export function normalizeCameraMapping(
  value: Partial<StageCameraMapping> & { cameraId: string; viewportId: string }
): StageCameraMapping {
  const projection: StageCameraProjection =
    value.projection === "perspective" ? "perspective" : "orthographic";

  const mapping: StageCameraMapping = {
    cameraId: value.cameraId,
    name: value.name?.trim() || value.cameraId,
    viewportId: value.viewportId,
    projection,
    transform: {
      x: finiteOr(value.transform?.x, 0),
      y: finiteOr(value.transform?.y, 0),
      z: finiteOr(value.transform?.z, 0),
      rotationX: finiteOr(value.transform?.rotationX, 0),
      rotationY: finiteOr(value.transform?.rotationY, 0),
      rotationZ: finiteOr(value.transform?.rotationZ, 0)
    },
    enabled: value.enabled !== false
  };

  if (projection === "perspective") {
    mapping.perspective = {
      fovYDegrees: clamp(positiveOr(value.perspective?.fovYDegrees, 45), 1, 179),
      near: positiveOr(value.perspective?.near, 0.1),
      far: positiveOr(value.perspective?.far, 100_000)
    };
  } else {
    mapping.orthographic = {
      logicalWidth: positiveOr(value.orthographic?.logicalWidth, 1920),
      near: finiteOr(value.orthographic?.near, -10_000),
      far: finiteOr(value.orthographic?.far, 10_000)
    };
  }

  if (typeof value.sceneCameraId === "string" && value.sceneCameraId) {
    mapping.sceneCameraId = value.sceneCameraId;
  }

  return mapping;
}

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

export interface StageResolutionContext {
  canvas: VirtualCanvas;
  regions: readonly StageRegion[];
  surfaces: readonly StageSurfacePlacement[];
}

/** Logical rectangle a viewport source refers to, clipped to the stage. */
export function resolveViewportSourceRect(
  context: StageResolutionContext,
  source: StageViewportSource
): StageRect {
  const stage = canvasBounds(context.canvas);

  switch (source.type) {
    case "region": {
      const region = context.regions.find((candidate) => candidate.regionId === source.regionId);
      return region ? intersectRects(region.bounds, stage) : stage;
    }
    case "surface": {
      const surface = context.surfaces.find(
        (candidate) => candidate.surfaceId === source.surfaceId
      );
      return surface ? intersectRects(surfacePlacementBounds(surface), stage) : stage;
    }
    case "rect":
      return intersectRects(source.bounds, stage);
    case "full-stage":
    default:
      return stage;
  }
}

export function resolveViewportRect(
  context: StageResolutionContext,
  viewport: StageViewport
): StageRect {
  return resolveViewportSourceRect(context, viewport.source);
}

/**
 * Render-target size in pixels for a viewport.
 *
 * Rounded up so a fractional render scale never silently drops the last row or
 * column of logical content.
 */
export function viewportRenderSize(
  context: StageResolutionContext,
  viewport: StageViewport
): StageSize {
  const bounds = resolveViewportRect(context, viewport);
  return {
    width: Math.max(1, Math.ceil(bounds.width * viewport.renderScale)),
    height: Math.max(1, Math.ceil(bounds.height * viewport.renderScale))
  };
}

/**
 * Render scale that fits a logical rectangle inside a pixel budget.
 *
 * This is how a preview request for a huge stage becomes a sane image instead of
 * a 10 GB frame.
 */
export function fitRenderScale(
  bounds: StageRect,
  maxWidth: number,
  maxHeight: number
): number {
  if (!(bounds.width > 0) || !(bounds.height > 0)) return 1;
  return Math.min(1, maxWidth / bounds.width, maxHeight / bounds.height);
}

/** Resolve a safe area to an absolute logical rectangle. */
export function resolveSafeAreaRect(
  context: StageResolutionContext,
  safeArea: StageSafeArea
): StageRect {
  const scope = safeArea.scope;
  let base: StageRect;

  if (scope.type === "region") {
    const region = context.regions.find((candidate) => candidate.regionId === scope.regionId);
    base = region ? region.bounds : canvasBounds(context.canvas);
  } else if (scope.type === "surface") {
    const surface = context.surfaces.find((candidate) => candidate.surfaceId === scope.surfaceId);
    base = surface ? surfacePlacementBounds(surface) : canvasBounds(context.canvas);
  } else {
    base = canvasBounds(context.canvas);
  }

  return insetRect(base, safeArea.insets);
}
