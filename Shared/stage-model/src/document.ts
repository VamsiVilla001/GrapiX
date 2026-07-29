/**
 * The stage document.
 *
 * A `SceneDocument` is content. A `StageDocument` is the installation the
 * content lives in: how big the logical space is, what physical displays exist,
 * what is looked at, and where pixels go. Many scenes share one stage, so the
 * two are separate documents joined by `SceneDocument.stageId`.
 */

import type { SceneDocument } from "@grapix/shared-types";

import {
  canvasBounds,
  exceedsSingleTextureLimit,
  fullResolutionByteEstimate,
  MAX_LOGICAL_CANVAS_DIMENSION,
  normalizePhysicalMeasurements,
  normalizeVirtualCanvas,
  type PhysicalStageMeasurements,
  type VirtualCanvas
} from "./canvas.js";
import { intersectRects, rectContainsRect, type StageRect } from "./geometry.js";
import {
  DEFAULT_STAGE_TILING,
  normalizeCameraMapping,
  normalizeRegion,
  normalizeSafeArea,
  normalizeStageTiling,
  normalizeSurfacePlacement,
  normalizeViewport,
  surfacePlacementBounds,
  type StageCameraMapping,
  type StageRegion,
  type StageSafeArea,
  type StageSurfacePlacement,
  type StageTilingConfig,
  type StageViewport
} from "./stage.js";
import {
  normalizeOutputMapping,
  normalizeOutputTarget,
  type OutputMapping,
  type OutputTarget
} from "./outputs.js";

export const STAGE_DOCUMENT_VERSION = 1 as const;

export interface StageDocument {
  stageId: string;
  name: string;
  version: typeof STAGE_DOCUMENT_VERSION;
  /** Monotonic revision assigned by whoever persists the document. */
  revision?: number;
  canvas: VirtualCanvas;
  safeAreas: StageSafeArea[];
  regions: StageRegion[];
  /** Placement only; physical detail lives in `@grapix/surface-model`. */
  surfaces: StageSurfacePlacement[];
  viewports: StageViewport[];
  cameras: StageCameraMapping[];
  outputs: OutputTarget[];
  outputMappings: OutputMapping[];
  tiling: StageTilingConfig;
  physical?: PhysicalStageMeasurements;
  createdAt: string;
  updatedAt: string;
}

export function createStageId(prefix = "stage"): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${random}`;
}

export interface CreateStageDocumentOptions {
  stageId?: string;
  name?: string;
  logicalWidth?: number;
  logicalHeight?: number;
  tiling?: Partial<StageTilingConfig>;
  physical?: Partial<PhysicalStageMeasurements>;
  timestamp?: string;
}

export function createStageDocument(options: CreateStageDocumentOptions = {}): StageDocument {
  const timestamp = options.timestamp ?? new Date(0).toISOString();
  return normalizeStageDocument({
    stageId: options.stageId ?? createStageId(),
    name: options.name ?? "Stage",
    version: STAGE_DOCUMENT_VERSION,
    canvas: {
      logicalWidth: options.logicalWidth ?? 1920,
      logicalHeight: options.logicalHeight ?? 1080
    },
    safeAreas: [],
    regions: [],
    surfaces: [],
    viewports: [],
    cameras: [],
    outputs: [],
    outputMappings: [],
    tiling: options.tiling ?? { ...DEFAULT_STAGE_TILING },
    physical: options.physical,
    createdAt: timestamp,
    updatedAt: timestamp
  });
}

/**
 * The implicit stage for a legacy scene that has no `stageId`.
 *
 * Every pre-stage SceneDocument behaves as a single-surface stage exactly the
 * size of its canvas, with one full-stage viewport. That keeps every existing
 * scene renderable without migration.
 */
export function implicitStageForScene(scene: SceneDocument): StageDocument {
  const width = scene.canvas.width > 0 ? scene.canvas.width : 1920;
  const height = scene.canvas.height > 0 ? scene.canvas.height : 1080;

  return normalizeStageDocument({
    stageId: scene.stageId ?? `stage_implicit_${scene.id}`,
    name: `${scene.name} stage`,
    version: STAGE_DOCUMENT_VERSION,
    canvas: { logicalWidth: width, logicalHeight: height },
    safeAreas: [],
    regions: [],
    surfaces: [],
    viewports: [
      {
        viewportId: "viewport_program",
        name: "Program",
        source: { type: "full-stage" },
        renderScale: 1,
        enabled: true
      }
    ],
    cameras: [],
    outputs: [],
    outputMappings: [],
    // A canvas-sized stage fits in one texture on any modern GPU, so tiling is
    // off by default here and the legacy single-target path stays untouched.
    tiling: { ...DEFAULT_STAGE_TILING, enabled: false },
    createdAt: scene.createdAt,
    updatedAt: scene.updatedAt
  });
}

type StageDocumentInput = Omit<
  Partial<StageDocument>,
  | "canvas"
  | "safeAreas"
  | "regions"
  | "surfaces"
  | "viewports"
  | "cameras"
  | "outputs"
  | "outputMappings"
  | "tiling"
  | "physical"
> & {
  canvas?: Partial<VirtualCanvas>;
  safeAreas?: readonly (Partial<StageSafeArea> & { safeAreaId: string })[];
  regions?: readonly (Partial<StageRegion> & { regionId: string })[];
  surfaces?: readonly (Partial<StageSurfacePlacement> & { surfaceId: string })[];
  viewports?: readonly (Partial<StageViewport> & { viewportId: string })[];
  cameras?: readonly (Partial<StageCameraMapping> & { cameraId: string; viewportId: string })[];
  outputs?: readonly (Partial<OutputTarget> & { outputId: string })[];
  outputMappings?: readonly (Partial<OutputMapping> & { mappingId: string; outputId: string })[];
  tiling?: Partial<StageTilingConfig>;
  physical?: Partial<PhysicalStageMeasurements>;
};

/**
 * Deterministic normalisation.
 *
 * Absent fields take documented defaults, out-of-range values clamp, and
 * duplicate identifiers are dropped keeping the first occurrence. The same input
 * always produces the same output, which is what lets the engine and the editor
 * agree without exchanging normalisation logic.
 */
export function normalizeStageDocument(value: StageDocumentInput): StageDocument {
  const timestamp = new Date(0).toISOString();
  const canvas = normalizeVirtualCanvas(value.canvas);

  const document: StageDocument = {
    stageId: value.stageId?.trim() || createStageId(),
    name: value.name?.trim() || "Stage",
    version: STAGE_DOCUMENT_VERSION,
    canvas,
    safeAreas: dedupeById(value.safeAreas ?? [], (item) => item.safeAreaId).map(normalizeSafeArea),
    regions: dedupeById(value.regions ?? [], (item) => item.regionId).map(normalizeRegion),
    surfaces: dedupeById(value.surfaces ?? [], (item) => item.surfaceId).map(
      normalizeSurfacePlacement
    ),
    viewports: dedupeById(value.viewports ?? [], (item) => item.viewportId).map(normalizeViewport),
    cameras: dedupeById(value.cameras ?? [], (item) => item.cameraId).map(normalizeCameraMapping),
    outputs: dedupeById(value.outputs ?? [], (item) => item.outputId).map(normalizeOutputTarget),
    outputMappings: dedupeById(value.outputMappings ?? [], (item) => item.mappingId).map(
      normalizeOutputMapping
    ),
    tiling: normalizeStageTiling(value.tiling),
    createdAt: value.createdAt ?? timestamp,
    updatedAt: value.updatedAt ?? timestamp
  };

  if (typeof value.revision === "number" && Number.isFinite(value.revision)) {
    document.revision = Math.max(0, Math.floor(value.revision));
  }

  const physical = normalizePhysicalMeasurements(value.physical);
  if (physical) {
    document.physical = physical;
  }

  return document;
}

function dedupeById<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const id = key(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type StageIssueSeverity = "error" | "warning";

export interface StageIssue {
  severity: StageIssueSeverity;
  code: string;
  message: string;
  /** Identifier of the offending element, when there is one. */
  subject?: string;
}

export interface StageValidation {
  valid: boolean;
  issues: StageIssue[];
}

/**
 * Structural validation.
 *
 * Errors mean the document cannot be rendered as written; warnings mean it will
 * render but probably not as the author intended. Nothing here needs a GPU —
 * hardware-dependent checks are {@link validateStageAgainstCapabilities}.
 */
export function validateStageDocument(stage: StageDocument): StageValidation {
  const issues: StageIssue[] = [];
  const stageRect = canvasBounds(stage.canvas);

  if (stage.canvas.logicalWidth > MAX_LOGICAL_CANVAS_DIMENSION) {
    issues.push({
      severity: "error",
      code: "CANVAS_WIDTH_EXCEEDED",
      message: `logical width ${stage.canvas.logicalWidth} exceeds the ${MAX_LOGICAL_CANVAS_DIMENSION} limit`
    });
  }
  if (stage.canvas.logicalHeight > MAX_LOGICAL_CANVAS_DIMENSION) {
    issues.push({
      severity: "error",
      code: "CANVAS_HEIGHT_EXCEEDED",
      message: `logical height ${stage.canvas.logicalHeight} exceeds the ${MAX_LOGICAL_CANVAS_DIMENSION} limit`
    });
  }

  const regionIds = new Set(stage.regions.map((region) => region.regionId));
  const surfaceIds = new Set(stage.surfaces.map((surface) => surface.surfaceId));
  const viewportIds = new Set(stage.viewports.map((viewport) => viewport.viewportId));
  const outputIds = new Set(stage.outputs.map((output) => output.outputId));

  for (const region of stage.regions) {
    if (region.bounds.width <= 0 || region.bounds.height <= 0) {
      issues.push({
        severity: "warning",
        code: "REGION_EMPTY",
        message: `region "${region.name}" has no area`,
        subject: region.regionId
      });
      continue;
    }
    if (!rectContainsRect(stageRect, region.bounds)) {
      const overlap = intersectRects(region.bounds, stageRect);
      issues.push({
        severity: overlap.width > 0 && overlap.height > 0 ? "warning" : "error",
        code: "REGION_OUTSIDE_STAGE",
        message: `region "${region.name}" extends outside the stage`,
        subject: region.regionId
      });
    }
  }

  for (const surface of stage.surfaces) {
    if (surface.size.width <= 0 || surface.size.height <= 0) {
      issues.push({
        severity: "warning",
        code: "SURFACE_EMPTY",
        message: `surface "${surface.name}" has no area`,
        subject: surface.surfaceId
      });
    }
    if (surface.outputId && !outputIds.has(surface.outputId)) {
      issues.push({
        severity: "error",
        code: "SURFACE_OUTPUT_MISSING",
        message: `surface "${surface.name}" references unknown output ${surface.outputId}`,
        subject: surface.surfaceId
      });
    }
    const bounds = surfacePlacementBounds(surface);
    const overlap = intersectRects(bounds, stageRect);
    if (!(overlap.width > 0 && overlap.height > 0) && surface.enabled) {
      issues.push({
        severity: "warning",
        code: "SURFACE_OFF_STAGE",
        message: `surface "${surface.name}" lies entirely outside the stage`,
        subject: surface.surfaceId
      });
    }
  }

  for (const viewport of stage.viewports) {
    const source = viewport.source;
    if (source.type === "region" && !regionIds.has(source.regionId)) {
      issues.push({
        severity: "error",
        code: "VIEWPORT_REGION_MISSING",
        message: `viewport "${viewport.name}" references unknown region ${source.regionId}`,
        subject: viewport.viewportId
      });
    }
    if (source.type === "surface" && !surfaceIds.has(source.surfaceId)) {
      issues.push({
        severity: "error",
        code: "VIEWPORT_SURFACE_MISSING",
        message: `viewport "${viewport.name}" references unknown surface ${source.surfaceId}`,
        subject: viewport.viewportId
      });
    }
  }

  for (const camera of stage.cameras) {
    if (!viewportIds.has(camera.viewportId)) {
      issues.push({
        severity: "error",
        code: "CAMERA_VIEWPORT_MISSING",
        message: `camera "${camera.name}" references unknown viewport ${camera.viewportId}`,
        subject: camera.cameraId
      });
    }
  }

  for (const mapping of stage.outputMappings) {
    if (!outputIds.has(mapping.outputId)) {
      issues.push({
        severity: "error",
        code: "MAPPING_OUTPUT_MISSING",
        message: `output mapping "${mapping.name}" references unknown output ${mapping.outputId}`,
        subject: mapping.mappingId
      });
    }
    const source = mapping.source;
    if (source.type === "region" && !regionIds.has(source.regionId)) {
      issues.push({
        severity: "error",
        code: "MAPPING_REGION_MISSING",
        message: `output mapping "${mapping.name}" references unknown region ${source.regionId}`,
        subject: mapping.mappingId
      });
    }
    if (source.type === "surface" && !surfaceIds.has(source.surfaceId)) {
      issues.push({
        severity: "error",
        code: "MAPPING_SURFACE_MISSING",
        message: `output mapping "${mapping.name}" references unknown surface ${source.surfaceId}`,
        subject: mapping.mappingId
      });
    }
    if (source.type === "viewport" && !viewportIds.has(source.viewportId)) {
      issues.push({
        severity: "error",
        code: "MAPPING_VIEWPORT_MISSING",
        message: `output mapping "${mapping.name}" references unknown viewport ${source.viewportId}`,
        subject: mapping.mappingId
      });
    }
  }

  for (const safeArea of stage.safeAreas) {
    const scope = safeArea.scope;
    if (scope.type === "region" && !regionIds.has(scope.regionId)) {
      issues.push({
        severity: "warning",
        code: "SAFE_AREA_REGION_MISSING",
        message: `safe area "${safeArea.name}" references unknown region ${scope.regionId}`,
        subject: safeArea.safeAreaId
      });
    }
    if (scope.type === "surface" && !surfaceIds.has(scope.surfaceId)) {
      issues.push({
        severity: "warning",
        code: "SAFE_AREA_SURFACE_MISSING",
        message: `safe area "${safeArea.name}" references unknown surface ${scope.surfaceId}`,
        subject: safeArea.safeAreaId
      });
    }
  }

  // A stage that cannot be one texture and has tiling off cannot be rendered.
  if (!stage.tiling.enabled && stage.canvas.logicalWidth * stage.canvas.logicalHeight > 8192 * 8192) {
    issues.push({
      severity: "warning",
      code: "TILING_DISABLED_ON_LARGE_STAGE",
      message:
        "tiling is disabled on a stage larger than 8192x8192; most GPUs cannot allocate a single target this size"
    });
  }

  return { valid: !issues.some((issue) => issue.severity === "error"), issues };
}

/**
 * Hardware-dependent validation, run against a connected engine's capabilities.
 *
 * This is the pre-publish warning path required by requirement 9: the operator
 * learns that a stage will not fit *before* it is taken on air.
 */
export interface StageCapabilityLimits {
  maxLogicalCanvasWidth: number;
  maxLogicalCanvasHeight: number;
  maxTextureDimension: number;
  tileRendering: boolean;
  gpuMemoryBytes?: number;
}

export function validateStageAgainstCapabilities(
  stage: StageDocument,
  limits: StageCapabilityLimits
): StageValidation {
  const issues: StageIssue[] = [];

  if (stage.canvas.logicalWidth > limits.maxLogicalCanvasWidth) {
    issues.push({
      severity: "error",
      code: "ENGINE_CANVAS_WIDTH",
      message: `engine supports a logical width of ${limits.maxLogicalCanvasWidth}; stage needs ${stage.canvas.logicalWidth}`
    });
  }
  if (stage.canvas.logicalHeight > limits.maxLogicalCanvasHeight) {
    issues.push({
      severity: "error",
      code: "ENGINE_CANVAS_HEIGHT",
      message: `engine supports a logical height of ${limits.maxLogicalCanvasHeight}; stage needs ${stage.canvas.logicalHeight}`
    });
  }

  const tileFootprint = Math.max(
    stage.tiling.tileWidth + stage.tiling.overscan * 2,
    stage.tiling.tileHeight + stage.tiling.overscan * 2
  );
  if (stage.tiling.enabled && tileFootprint > limits.maxTextureDimension) {
    issues.push({
      severity: "error",
      code: "TILE_EXCEEDS_TEXTURE_LIMIT",
      message: `tile plus overscan is ${tileFootprint}px; engine maximum texture dimension is ${limits.maxTextureDimension}`
    });
  }

  if (exceedsSingleTextureLimit(stage.canvas, limits.maxTextureDimension)) {
    if (!stage.tiling.enabled) {
      issues.push({
        severity: "error",
        code: "TILING_REQUIRED",
        message: `stage exceeds the engine texture limit of ${limits.maxTextureDimension}px and requires tiling`
      });
    } else if (!limits.tileRendering) {
      issues.push({
        severity: "error",
        code: "ENGINE_NO_TILING",
        message: "stage requires tiled rendering but the engine does not support it"
      });
    }
  }

  if (limits.gpuMemoryBytes !== undefined) {
    const budget = stage.tiling.cacheBudgetBytes;
    if (budget > limits.gpuMemoryBytes) {
      issues.push({
        severity: "warning",
        code: "TILE_CACHE_OVER_VRAM",
        message: `tile cache budget ${formatBytes(budget)} exceeds the engine's ${formatBytes(limits.gpuMemoryBytes)} of GPU memory`
      });
    }
  }

  return { valid: !issues.some((issue) => issue.severity === "error"), issues };
}

function formatBytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${value} B`;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

export interface StageSummary {
  stageId: string;
  logicalWidth: number;
  logicalHeight: number;
  logicalBounds: StageRect;
  /** Bytes a stage-sized RGBA8 target would need. Reported, never allocated. */
  fullResolutionBytes: number;
  regionCount: number;
  surfaceCount: number;
  viewportCount: number;
  outputCount: number;
  totalOutputPixels: number;
  tilingEnabled: boolean;
  tileWidth: number;
  tileHeight: number;
  /** Total tiles the grid would contain. Not how many are resident. */
  tileCount: number;
}

export function summarizeStage(stage: StageDocument): StageSummary {
  const bounds = canvasBounds(stage.canvas);
  const columns = stage.tiling.enabled
    ? Math.ceil(stage.canvas.logicalWidth / stage.tiling.tileWidth)
    : 1;
  const rows = stage.tiling.enabled
    ? Math.ceil(stage.canvas.logicalHeight / stage.tiling.tileHeight)
    : 1;

  return {
    stageId: stage.stageId,
    logicalWidth: stage.canvas.logicalWidth,
    logicalHeight: stage.canvas.logicalHeight,
    logicalBounds: bounds,
    fullResolutionBytes: fullResolutionByteEstimate(stage.canvas),
    regionCount: stage.regions.length,
    surfaceCount: stage.surfaces.length,
    viewportCount: stage.viewports.length,
    outputCount: stage.outputs.filter((output) => output.enabled).length,
    totalOutputPixels: stage.outputs.reduce(
      (total, output) => (output.enabled ? total + output.width * output.height : total),
      0
    ),
    tilingEnabled: stage.tiling.enabled,
    tileWidth: stage.tiling.tileWidth,
    tileHeight: stage.tiling.tileHeight,
    tileCount: columns * rows
  };
}
