/**
 * Outputs and output mappings.
 *
 * Stage resolution and output resolution are unrelated numbers, and this module
 * is where that separation is enforced. An `OutputTarget` is a device that wants
 * pixels at its own resolution and frame rate. An `OutputMapping` says which
 * part of the logical stage feeds it and how it is fitted.
 *
 * No resolution, transport, or vendor is hard-coded. `adapterId` is an opaque
 * string resolved against the engine's registered output adapters, so NDI, SDI,
 * DeckLink, AJA, display, and file outputs can be added without touching this
 * contract.
 */

import type { RationalFrameRate } from "@grapix/shared-types";

import {
  clamp,
  finiteOr,
  intersectRects,
  normalizePoint,
  normalizeRect,
  positiveOr,
  rect,
  type StagePoint,
  type StageRect,
  type StageSize
} from "./geometry.js";
import { canvasBounds } from "./canvas.js";
import {
  surfacePlacementBounds,
  type StageRegion,
  type StageResolutionContext,
  type StageSurfacePlacement,
  type StageViewport
} from "./stage.js";

export type OutputAlphaMode = "premultiplied" | "straight" | "opaque";

/** A device that consumes frames. Resolution is the device's, not the stage's. */
export interface OutputTarget {
  outputId: string;
  name: string;
  /** Device pixel width. Completely independent of the logical canvas. */
  width: number;
  height: number;
  frameRate: RationalFrameRate;
  /** Opaque adapter identifier; resolved against the engine's registry. */
  adapterId: string;
  /** Adapter-specific settings, passed through untouched. */
  adapterOptions?: Readonly<Record<string, string | number | boolean>>;
  pixelAspectRatio: number;
  alphaMode: OutputAlphaMode;
  enabled: boolean;
}

/** Which part of the stage feeds an output. */
export type OutputMappingSource =
  | { type: "full-stage" }
  | { type: "region"; regionId: string }
  | { type: "surface"; surfaceId: string }
  | { type: "viewport"; viewportId: string }
  | { type: "rect"; bounds: StageRect };

export type OutputFitMode = "stretch" | "contain" | "cover" | "none";

/** Quarter-turn rotations only. Arbitrary rotation belongs to surface warp. */
export type OutputRotation = 0 | 90 | 180 | 270;

export interface OutputMapping {
  mappingId: string;
  name: string;
  outputId: string;
  source: OutputMappingSource;
  fit: OutputFitMode;
  rotationDegrees: OutputRotation;
  /** Crop applied to the source rectangle, in logical units. */
  crop?: StageRect;
  /** Destination offset in output device pixels. */
  offset: StagePoint;
  opacity: number;
  enabled: boolean;
}

export const DEFAULT_OUTPUT_FRAME_RATE: Readonly<RationalFrameRate> = Object.freeze({
  numerator: 50,
  denominator: 1
});

export function normalizeFrameRate(
  value: Partial<RationalFrameRate> | undefined,
  fallback: RationalFrameRate = DEFAULT_OUTPUT_FRAME_RATE
): RationalFrameRate {
  const numerator = Math.round(positiveOr(value?.numerator, fallback.numerator));
  const denominator = Math.round(positiveOr(value?.denominator, fallback.denominator));
  return { numerator, denominator };
}

export function normalizeOutputTarget(
  value: Partial<OutputTarget> & { outputId: string }
): OutputTarget {
  const target: OutputTarget = {
    outputId: value.outputId,
    name: value.name?.trim() || value.outputId,
    width: Math.round(clamp(positiveOr(value.width, 1920), 1, 65_536)),
    height: Math.round(clamp(positiveOr(value.height, 1080), 1, 65_536)),
    frameRate: normalizeFrameRate(value.frameRate),
    adapterId: value.adapterId?.trim() || "null",
    pixelAspectRatio: clamp(positiveOr(value.pixelAspectRatio, 1), 1 / 16, 16),
    alphaMode:
      value.alphaMode === "straight" || value.alphaMode === "opaque"
        ? value.alphaMode
        : "premultiplied",
    enabled: value.enabled !== false
  };
  if (value.adapterOptions && typeof value.adapterOptions === "object") {
    target.adapterOptions = { ...value.adapterOptions };
  }
  return target;
}

export function normalizeOutputMapping(
  value: Partial<OutputMapping> & { mappingId: string; outputId: string }
): OutputMapping {
  const mapping: OutputMapping = {
    mappingId: value.mappingId,
    name: value.name?.trim() || value.mappingId,
    outputId: value.outputId,
    source: normalizeOutputMappingSource(value.source),
    fit: normalizeFitMode(value.fit),
    rotationDegrees: normalizeRotation(value.rotationDegrees),
    offset: normalizePoint(value.offset, { x: 0, y: 0 }),
    opacity: clamp(finiteOr(value.opacity, 1), 0, 1),
    enabled: value.enabled !== false
  };
  if (value.crop) {
    mapping.crop = normalizeRect(value.crop, rect(0, 0, 0, 0));
  }
  return mapping;
}

function normalizeOutputMappingSource(value: OutputMappingSource | undefined): OutputMappingSource {
  if (value?.type === "region" && typeof value.regionId === "string" && value.regionId) {
    return { type: "region", regionId: value.regionId };
  }
  if (value?.type === "surface" && typeof value.surfaceId === "string" && value.surfaceId) {
    return { type: "surface", surfaceId: value.surfaceId };
  }
  if (value?.type === "viewport" && typeof value.viewportId === "string" && value.viewportId) {
    return { type: "viewport", viewportId: value.viewportId };
  }
  if (value?.type === "rect") {
    return { type: "rect", bounds: normalizeRect(value.bounds, rect(0, 0, 0, 0)) };
  }
  return { type: "full-stage" };
}

function normalizeFitMode(value: OutputFitMode | undefined): OutputFitMode {
  return value === "stretch" || value === "cover" || value === "none" ? value : "contain";
}

function normalizeRotation(value: number | undefined): OutputRotation {
  const rounded = ((Math.round(finiteOr(value, 0)) % 360) + 360) % 360;
  if (rounded === 90 || rounded === 180 || rounded === 270) return rounded;
  return 0;
}

// ---------------------------------------------------------------------------
// Mapping resolution
// ---------------------------------------------------------------------------

export interface OutputMappingContext extends StageResolutionContext {
  viewports: readonly StageViewport[];
}

/** Logical rectangle an output mapping reads from, after crop, clipped to stage. */
export function resolveOutputSourceRect(
  context: OutputMappingContext,
  mapping: OutputMapping
): StageRect {
  const stage = canvasBounds(context.canvas);
  let base: StageRect;

  switch (mapping.source.type) {
    case "region": {
      const region = findRegion(context.regions, mapping.source.regionId);
      base = region ? region.bounds : stage;
      break;
    }
    case "surface": {
      const surface = findSurface(context.surfaces, mapping.source.surfaceId);
      base = surface ? surfacePlacementBounds(surface) : stage;
      break;
    }
    case "viewport": {
      const viewport = context.viewports.find(
        (candidate) => candidate.viewportId === (mapping.source as { viewportId: string }).viewportId
      );
      base = viewport
        ? resolveViewportSourceRectLocal(context, viewport)
        : stage;
      break;
    }
    case "rect":
      base = mapping.source.bounds;
      break;
    case "full-stage":
    default:
      base = stage;
      break;
  }

  const cropped = mapping.crop ? applyCrop(base, mapping.crop) : base;
  return intersectRects(cropped, stage);
}

/**
 * Crop is expressed relative to the source rectangle's own origin, so a mapping
 * stays correct when the region it points at moves.
 */
function applyCrop(base: StageRect, crop: StageRect): StageRect {
  const absolute = rect(base.x + crop.x, base.y + crop.y, crop.width, crop.height);
  return intersectRects(absolute, base);
}

function resolveViewportSourceRectLocal(
  context: OutputMappingContext,
  viewport: StageViewport
): StageRect {
  const stage = canvasBounds(context.canvas);
  switch (viewport.source.type) {
    case "region": {
      const region = findRegion(context.regions, viewport.source.regionId);
      return region ? intersectRects(region.bounds, stage) : stage;
    }
    case "surface": {
      const surface = findSurface(context.surfaces, viewport.source.surfaceId);
      return surface ? intersectRects(surfacePlacementBounds(surface), stage) : stage;
    }
    case "rect":
      return intersectRects(viewport.source.bounds, stage);
    default:
      return stage;
  }
}

function findRegion(
  regions: readonly StageRegion[],
  regionId: string
): StageRegion | undefined {
  return regions.find((candidate) => candidate.regionId === regionId);
}

function findSurface(
  surfaces: readonly StageSurfacePlacement[],
  surfaceId: string
): StageSurfacePlacement | undefined {
  return surfaces.find((candidate) => candidate.surfaceId === surfaceId);
}

/**
 * Where the source lands inside the output, in device pixels.
 *
 * `destination` may extend outside the output rectangle for `cover`; that is
 * intentional, and `visible` reports the part actually transmitted.
 */
export interface ResolvedOutputPlacement {
  outputId: string;
  mappingId: string;
  /** Logical stage rectangle being read. */
  source: StageRect;
  /** Device-pixel rectangle written, before clipping. */
  destination: StageRect;
  /** Device-pixel rectangle actually inside the output. */
  visible: StageRect;
  /** Device pixels per logical unit along each axis. */
  scale: StagePoint;
  rotationDegrees: OutputRotation;
  opacity: number;
}

/**
 * Compute the device-pixel placement for one mapping.
 *
 * Pixel aspect ratio is folded into the aspect comparison so anamorphic stages
 * and non-square-pixel outputs letterbox correctly rather than stretching.
 */
export function resolveOutputPlacement(
  context: OutputMappingContext,
  mapping: OutputMapping,
  output: OutputTarget
): ResolvedOutputPlacement {
  const source = resolveOutputSourceRect(context, mapping);
  const rotated = mapping.rotationDegrees === 90 || mapping.rotationDegrees === 270;

  // After a quarter turn the source's width drives the output's height.
  const sourceWidth = rotated ? source.height : source.width;
  const sourceHeight = rotated ? source.width : source.height;

  const parRatio = context.canvas.pixelAspectRatio / output.pixelAspectRatio;
  const correctedSourceWidth = sourceWidth * parRatio;

  let width: number;
  let height: number;

  if (correctedSourceWidth <= 0 || sourceHeight <= 0) {
    width = 0;
    height = 0;
  } else if (mapping.fit === "stretch") {
    width = output.width;
    height = output.height;
  } else if (mapping.fit === "none") {
    width = correctedSourceWidth;
    height = sourceHeight;
  } else {
    const scaleX = output.width / correctedSourceWidth;
    const scaleY = output.height / sourceHeight;
    const factor = mapping.fit === "cover" ? Math.max(scaleX, scaleY) : Math.min(scaleX, scaleY);
    width = correctedSourceWidth * factor;
    height = sourceHeight * factor;
  }

  // `none` pins to the offset; fitted modes centre inside the output.
  const centeredX = mapping.fit === "none" ? 0 : (output.width - width) / 2;
  const centeredY = mapping.fit === "none" ? 0 : (output.height - height) / 2;

  const destination = rect(
    centeredX + mapping.offset.x,
    centeredY + mapping.offset.y,
    width,
    height
  );

  const visible = intersectRects(destination, rect(0, 0, output.width, output.height));

  return {
    outputId: output.outputId,
    mappingId: mapping.mappingId,
    source,
    destination,
    visible,
    scale: {
      x: sourceWidth > 0 ? width / sourceWidth : 0,
      y: sourceHeight > 0 ? height / sourceHeight : 0
    },
    rotationDegrees: mapping.rotationDegrees,
    opacity: mapping.opacity
  };
}

/** True when a mapping produces no transmitted pixels. */
export function isPlacementEmpty(placement: ResolvedOutputPlacement): boolean {
  return !(placement.visible.width > 0) || !(placement.visible.height > 0);
}

/**
 * Union of every logical rectangle an active output needs.
 *
 * The tile system uses this to decide which tiles are required by outputs, so
 * nothing outside any output's reach is ever rendered.
 */
export function requiredLogicalCoverage(
  context: OutputMappingContext,
  mappings: readonly OutputMapping[],
  outputs: readonly OutputTarget[]
): StageRect[] {
  const enabledOutputs = new Set(
    outputs.filter((output) => output.enabled).map((output) => output.outputId)
  );

  const rects: StageRect[] = [];
  for (const mapping of mappings) {
    if (!mapping.enabled || !enabledOutputs.has(mapping.outputId)) continue;
    const source = resolveOutputSourceRect(context, mapping);
    if (source.width > 0 && source.height > 0) {
      rects.push(source);
    }
  }
  return rects;
}

/**
 * Device-pixel budget for a set of outputs.
 *
 * Reported in diagnostics so an operator can see that three UHD outputs on one
 * engine is 24.9 Mpix per frame regardless of how large the logical stage is.
 */
export function totalOutputPixels(outputs: readonly OutputTarget[]): number {
  return outputs.reduce(
    (total, output) => (output.enabled ? total + output.width * output.height : total),
    0
  );
}

/** Convenience: the output rectangle in its own device pixels. */
export function outputBounds(output: OutputTarget): StageRect {
  return rect(0, 0, output.width, output.height);
}

export function outputSize(output: OutputTarget): StageSize {
  return { width: output.width, height: output.height };
}

/** Exact frame duration in nanoseconds; integer maths, so it cannot drift. */
export function frameDurationNanos(frameRate: RationalFrameRate): number {
  return Math.round((1_000_000_000 * frameRate.denominator) / frameRate.numerator);
}

/** Approximate decimal rate, for display only. Never use for scheduling. */
export function approximateFrameRate(frameRate: RationalFrameRate): number {
  return frameRate.numerator / frameRate.denominator;
}
