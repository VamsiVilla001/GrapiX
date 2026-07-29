/**
 * Stage geometry primitives and the precision rules for extreme canvas sizes.
 *
 * Every coordinate in this package is a logical stage coordinate held as a
 * double (`number`). At the 50,000-unit limit the double spacing is about
 * 7.3e-12, so absolute positions are effectively exact.
 *
 * The precision hazard is not storage, it is handing absolute stage coordinates
 * to a GPU. Float32 spacing at 50,000 is 0.00390625 logical units, which is
 * already visible jitter before any transform chain compounds it. The rule this
 * module enforces:
 *
 *   Subtract the tile or viewport origin in double precision FIRST, and only
 *   then narrow to float32.
 *
 * `stageToLocalRect` is that subtraction. `f32Error` and `localF32Error` exist
 * so the improvement is asserted by tests rather than assumed.
 */

export interface StagePoint {
  x: number;
  y: number;
}

export interface StageSize {
  width: number;
  height: number;
}

export interface StageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface StageInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export const ZERO_POINT: Readonly<StagePoint> = Object.freeze({ x: 0, y: 0 });

export const ZERO_INSETS: Readonly<StageInsets> = Object.freeze({
  top: 0,
  right: 0,
  bottom: 0,
  left: 0
});

export function point(x: number, y: number): StagePoint {
  return { x, y };
}

export function size(width: number, height: number): StageSize {
  return { width, height };
}

export function rect(x: number, y: number, width: number, height: number): StageRect {
  return { x, y, width, height };
}

export function rectRight(value: StageRect): number {
  return value.x + value.width;
}

export function rectBottom(value: StageRect): number {
  return value.y + value.height;
}

export function rectArea(value: StageRect): number {
  return Math.max(0, value.width) * Math.max(0, value.height);
}

export function rectCenter(value: StageRect): StagePoint {
  return { x: value.x + value.width / 2, y: value.y + value.height / 2 };
}

export function isEmptyRect(value: StageRect): boolean {
  return !(value.width > 0) || !(value.height > 0);
}

export function rectsEqual(a: StageRect, b: StageRect, epsilon = 0): boolean {
  return (
    Math.abs(a.x - b.x) <= epsilon
    && Math.abs(a.y - b.y) <= epsilon
    && Math.abs(a.width - b.width) <= epsilon
    && Math.abs(a.height - b.height) <= epsilon
  );
}

/**
 * True when the rectangles share any interior area.
 *
 * Touching edges do not count as an intersection. That matters for tiling: a
 * tile grid is a partition, so an object whose right edge lands exactly on a
 * tile boundary must belong to one tile, not two.
 */
export function rectsIntersect(a: StageRect, b: StageRect): boolean {
  return (
    a.x < rectRight(b)
    && b.x < rectRight(a)
    && a.y < rectBottom(b)
    && b.y < rectBottom(a)
  );
}

export function rectContainsRect(outer: StageRect, inner: StageRect): boolean {
  return (
    inner.x >= outer.x
    && inner.y >= outer.y
    && rectRight(inner) <= rectRight(outer)
    && rectBottom(inner) <= rectBottom(outer)
  );
}

export function rectContainsPoint(value: StageRect, candidate: StagePoint): boolean {
  return (
    candidate.x >= value.x
    && candidate.x < rectRight(value)
    && candidate.y >= value.y
    && candidate.y < rectBottom(value)
  );
}

/** Overlapping area of two rectangles, or an empty rectangle when disjoint. */
export function intersectRects(a: StageRect, b: StageRect): StageRect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(rectRight(a), rectRight(b));
  const bottom = Math.min(rectBottom(a), rectBottom(b));
  if (right <= x || bottom <= y) {
    return { x, y, width: 0, height: 0 };
  }
  return { x, y, width: right - x, height: bottom - y };
}

/** Smallest rectangle containing both inputs. Empty inputs are ignored. */
export function unionRects(a: StageRect, b: StageRect): StageRect {
  if (isEmptyRect(a)) return { ...b };
  if (isEmptyRect(b)) return { ...a };
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(rectRight(a), rectRight(b));
  const bottom = Math.max(rectBottom(a), rectBottom(b));
  return { x, y, width: right - x, height: bottom - y };
}

/** Grow (or shrink, with a negative amount) a rectangle on every side. */
export function inflateRect(value: StageRect, amount: number): StageRect {
  return {
    x: value.x - amount,
    y: value.y - amount,
    width: value.width + amount * 2,
    height: value.height + amount * 2
  };
}

export function insetRect(value: StageRect, insets: StageInsets): StageRect {
  const width = value.width - insets.left - insets.right;
  const height = value.height - insets.top - insets.bottom;
  return {
    x: value.x + insets.left,
    y: value.y + insets.top,
    width: Math.max(0, width),
    height: Math.max(0, height)
  };
}

export function translateRect(value: StageRect, delta: StagePoint): StageRect {
  return { x: value.x + delta.x, y: value.y + delta.y, width: value.width, height: value.height };
}

/** Expand to whole logical units. Used when deriving GPU allocation sizes. */
export function alignRectOutward(value: StageRect): StageRect {
  const x = Math.floor(value.x);
  const y = Math.floor(value.y);
  return {
    x,
    y,
    width: Math.ceil(rectRight(value)) - x,
    height: Math.ceil(rectBottom(value)) - y
  };
}

// ---------------------------------------------------------------------------
// Precision
// ---------------------------------------------------------------------------

/**
 * Rebase a point onto a local origin in double precision.
 *
 * Call this before narrowing anything for the GPU. The subtraction is the whole
 * point: it removes the large magnitude that destroys float32 resolution.
 */
export function stageToLocalPoint(value: StagePoint, origin: StagePoint): StagePoint {
  return { x: value.x - origin.x, y: value.y - origin.y };
}

/** Rebase a rectangle onto a local origin in double precision. */
export function stageToLocalRect(value: StageRect, origin: StagePoint): StageRect {
  return {
    x: value.x - origin.x,
    y: value.y - origin.y,
    width: value.width,
    height: value.height
  };
}

/** Inverse of {@link stageToLocalPoint}. */
export function localToStagePoint(value: StagePoint, origin: StagePoint): StagePoint {
  return { x: value.x + origin.x, y: value.y + origin.y };
}

/** Inverse of {@link stageToLocalRect}. */
export function localToStageRect(value: StageRect, origin: StagePoint): StageRect {
  return {
    x: value.x + origin.x,
    y: value.y + origin.y,
    width: value.width,
    height: value.height
  };
}

/** Narrow to the precision the GPU actually uses. */
export function narrowToF32(value: number): number {
  return Math.fround(value);
}

export function narrowRectToF32(value: StageRect): StageRect {
  return {
    x: Math.fround(value.x),
    y: Math.fround(value.y),
    width: Math.fround(value.width),
    height: Math.fround(value.height)
  };
}

/** Absolute error introduced by storing `value` as a float32. */
export function f32Error(value: number): number {
  return Math.abs(Math.fround(value) - value);
}

/**
 * Absolute error after rebasing onto `origin` and then narrowing.
 *
 * Compare against {@link f32Error} on the same absolute coordinate to see the
 * benefit of the rebase. The tests assert the ratio rather than trusting it.
 */
export function localF32Error(value: number, origin: number): number {
  const local = value - origin;
  return Math.abs(Math.fround(local) - local);
}

/** Float32 spacing at a magnitude — the smallest representable step there. */
export function f32Spacing(magnitude: number): number {
  const absolute = Math.abs(magnitude);
  if (!Number.isFinite(absolute) || absolute === 0) {
    return Math.pow(2, -149);
  }
  const exponent = Math.floor(Math.log2(absolute));
  return Math.pow(2, exponent - 23);
}

// ---------------------------------------------------------------------------
// Numeric guards
// ---------------------------------------------------------------------------

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function finiteOr(value: unknown, fallback: number): number {
  return isFiniteNumber(value) ? value : fallback;
}

export function positiveOr(value: unknown, fallback: number): number {
  return isFiniteNumber(value) && value > 0 ? value : fallback;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

export function normalizeRect(value: Partial<StageRect> | undefined, fallback: StageRect): StageRect {
  if (!value) return { ...fallback };
  return {
    x: finiteOr(value.x, fallback.x),
    y: finiteOr(value.y, fallback.y),
    width: Math.max(0, finiteOr(value.width, fallback.width)),
    height: Math.max(0, finiteOr(value.height, fallback.height))
  };
}

export function normalizePoint(value: Partial<StagePoint> | undefined, fallback: StagePoint): StagePoint {
  if (!value) return { ...fallback };
  return { x: finiteOr(value.x, fallback.x), y: finiteOr(value.y, fallback.y) };
}

export function normalizeInsets(
  value: Partial<StageInsets> | undefined,
  fallback: StageInsets = ZERO_INSETS
): StageInsets {
  if (!value) return { ...fallback };
  return {
    top: Math.max(0, finiteOr(value.top, fallback.top)),
    right: Math.max(0, finiteOr(value.right, fallback.right)),
    bottom: Math.max(0, finiteOr(value.bottom, fallback.bottom)),
    left: Math.max(0, finiteOr(value.left, fallback.left))
  };
}
