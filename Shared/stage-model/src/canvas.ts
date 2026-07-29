/**
 * The virtual canvas.
 *
 * A virtual canvas is a logical coordinate space, not a framebuffer. Declaring
 * a 50,000 x 50,000 canvas costs nothing: it allocates no texture and no memory.
 * Only tiles become GPU render targets, and only when something actually needs
 * them.
 */

import {
  clamp,
  finiteOr,
  isFiniteNumber,
  positiveOr,
  rect,
  type StagePoint,
  type StageRect,
  type StageSize
} from "./geometry.js";

/**
 * Largest logical canvas dimension the architecture commits to supporting.
 *
 * This is a logical limit, deliberately far above any GPU texture limit. An
 * engine reports its own `maxLogicalCanvas` during capability negotiation; the
 * two are unrelated numbers and the smaller one wins at publish time.
 */
export const MAX_LOGICAL_CANVAS_DIMENSION = 50_000;

/** Guard against a stage so large that even tile bookkeeping is unreasonable. */
export const MAX_LOGICAL_CANVAS_AREA = MAX_LOGICAL_CANVAS_DIMENSION * MAX_LOGICAL_CANVAS_DIMENSION;

export const MIN_LOGICAL_CANVAS_DIMENSION = 1;

/**
 * Where logical (0, 0) sits.
 *
 * Broadcast authoring is top-left based; large physical installations are often
 * described from the stage centre. Both are supported so nobody has to bake an
 * offset into every object position.
 */
export type StageOriginAnchor = "top-left" | "center" | "custom";

export interface StageOrigin {
  anchor: StageOriginAnchor;
  /** Only meaningful for the `custom` anchor. Logical units. */
  offsetX: number;
  offsetY: number;
}

/** Y direction. Screen space is y-down; some LED tooling is y-up. */
export type StageAxisDirection = "y-down" | "y-up";

export interface VirtualCanvas {
  logicalWidth: number;
  logicalHeight: number;
  origin: StageOrigin;
  axisDirection: StageAxisDirection;
  /**
   * Default logical-to-render pixel ratio. 1 renders at logical resolution;
   * 0.5 halves it. Viewports and outputs may override per use.
   */
  renderScale: number;
  /** Non-square pixel support, e.g. anamorphic or certain LED products. */
  pixelAspectRatio: number;
}

/** Real-world size of the installation, for physical-to-logical reasoning. */
export interface PhysicalStageMeasurements {
  widthMillimetres: number;
  heightMillimetres: number;
  /** Optional depth for volumetric/virtual-production stages. */
  depthMillimetres?: number;
}

export const DEFAULT_STAGE_ORIGIN: Readonly<StageOrigin> = Object.freeze({
  anchor: "top-left",
  offsetX: 0,
  offsetY: 0
});

export function createVirtualCanvas(
  logicalWidth: number,
  logicalHeight: number,
  overrides: Partial<Omit<VirtualCanvas, "logicalWidth" | "logicalHeight">> = {}
): VirtualCanvas {
  return normalizeVirtualCanvas({ ...overrides, logicalWidth, logicalHeight });
}

export function normalizeStageOrigin(value: Partial<StageOrigin> | undefined): StageOrigin {
  const anchor: StageOriginAnchor =
    value?.anchor === "center" || value?.anchor === "custom" ? value.anchor : "top-left";
  return {
    anchor,
    offsetX: anchor === "custom" ? finiteOr(value?.offsetX, 0) : 0,
    offsetY: anchor === "custom" ? finiteOr(value?.offsetY, 0) : 0
  };
}

export function normalizeVirtualCanvas(value: Partial<VirtualCanvas> | undefined): VirtualCanvas {
  const logicalWidth = clamp(
    positiveOr(value?.logicalWidth, 1920),
    MIN_LOGICAL_CANVAS_DIMENSION,
    MAX_LOGICAL_CANVAS_DIMENSION
  );
  const logicalHeight = clamp(
    positiveOr(value?.logicalHeight, 1080),
    MIN_LOGICAL_CANVAS_DIMENSION,
    MAX_LOGICAL_CANVAS_DIMENSION
  );

  return {
    logicalWidth,
    logicalHeight,
    origin: normalizeStageOrigin(value?.origin),
    axisDirection: value?.axisDirection === "y-up" ? "y-up" : "y-down",
    renderScale: clamp(positiveOr(value?.renderScale, 1), 1 / 4096, 16),
    pixelAspectRatio: clamp(positiveOr(value?.pixelAspectRatio, 1), 1 / 16, 16)
  };
}

export function canvasSize(canvas: VirtualCanvas): StageSize {
  return { width: canvas.logicalWidth, height: canvas.logicalHeight };
}

/**
 * The whole stage as a rectangle in the canvas's own coordinate system.
 *
 * With a top-left origin this is `(0, 0, w, h)`. With a centre origin it is
 * `(-w/2, -h/2, w, h)`, so object coordinates can be symmetric about the middle
 * of a wide LED wall.
 */
export function canvasBounds(canvas: VirtualCanvas): StageRect {
  const { logicalWidth, logicalHeight, origin } = canvas;
  switch (origin.anchor) {
    case "center":
      return rect(-logicalWidth / 2, -logicalHeight / 2, logicalWidth, logicalHeight);
    case "custom":
      return rect(-origin.offsetX, -origin.offsetY, logicalWidth, logicalHeight);
    case "top-left":
    default:
      return rect(0, 0, logicalWidth, logicalHeight);
  }
}

/** Top-left corner of the stage. The rebase origin for tile-local coordinates. */
export function canvasOriginPoint(canvas: VirtualCanvas): StagePoint {
  const bounds = canvasBounds(canvas);
  return { x: bounds.x, y: bounds.y };
}

/**
 * Convert a canvas-space coordinate into a normalised 0..1 stage coordinate.
 * Useful for surface UV mapping, which is origin-independent by definition.
 */
export function canvasToNormalized(canvas: VirtualCanvas, value: StagePoint): StagePoint {
  const bounds = canvasBounds(canvas);
  return {
    x: (value.x - bounds.x) / bounds.width,
    y: (value.y - bounds.y) / bounds.height
  };
}

export function normalizedToCanvas(canvas: VirtualCanvas, value: StagePoint): StagePoint {
  const bounds = canvasBounds(canvas);
  return { x: bounds.x + value.x * bounds.width, y: bounds.y + value.y * bounds.height };
}

/** Logical units per physical millimetre, when physical size is known. */
export function logicalUnitsPerMillimetre(
  canvas: VirtualCanvas,
  physical: PhysicalStageMeasurements
): StagePoint | undefined {
  if (!(physical.widthMillimetres > 0) || !(physical.heightMillimetres > 0)) {
    return undefined;
  }
  return {
    x: canvas.logicalWidth / physical.widthMillimetres,
    y: canvas.logicalHeight / physical.heightMillimetres
  };
}

export function normalizePhysicalMeasurements(
  value: Partial<PhysicalStageMeasurements> | undefined
): PhysicalStageMeasurements | undefined {
  if (!value) return undefined;
  const widthMillimetres = positiveOr(value.widthMillimetres, 0);
  const heightMillimetres = positiveOr(value.heightMillimetres, 0);
  if (!(widthMillimetres > 0) || !(heightMillimetres > 0)) {
    return undefined;
  }
  const depthMillimetres = isFiniteNumber(value.depthMillimetres) && value.depthMillimetres > 0
    ? value.depthMillimetres
    : undefined;
  return depthMillimetres === undefined
    ? { widthMillimetres, heightMillimetres }
    : { widthMillimetres, heightMillimetres, depthMillimetres };
}

/**
 * Bytes a single full-resolution RGBA8 image of this canvas would need.
 *
 * This exists to be *reported*, not allocated. It is the number that makes the
 * case for tiling: a 50,000 x 50,000 stage is 10 GB, which is why the engine
 * never materialises a stage-sized target.
 */
export function fullResolutionByteEstimate(canvas: VirtualCanvas, bytesPerPixel = 4): number {
  return canvas.logicalWidth * canvas.logicalHeight * bytesPerPixel;
}

/**
 * Whether this canvas could ever be one GPU texture.
 *
 * Used to explain to the operator why tiling is mandatory for their stage,
 * rather than failing with a driver error.
 */
export function exceedsSingleTextureLimit(canvas: VirtualCanvas, maxTextureDimension: number): boolean {
  return canvas.logicalWidth > maxTextureDimension || canvas.logicalHeight > maxTextureDimension;
}
