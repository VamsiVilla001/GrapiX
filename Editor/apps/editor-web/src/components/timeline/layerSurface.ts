/**
 * The three canvases the timeline draws on, and their backing stores.
 *
 * A canvas has two sizes: the CSS box the page lays out, and the pixel buffer it rasterises into.
 * Leaving the second at its default draws a 1x image and scales it up, which is what makes canvas
 * text look soft next to the DOM text beside it on a 2x display. The buffer is therefore sized by
 * `devicePixelRatio` and the context scaled by the same factor, so every draw call below can work
 * in CSS pixels and land on whole device pixels.
 *
 * ## DPR is not constant
 *
 * Dragging a window from a 2x laptop panel to a 1x external monitor changes `devicePixelRatio`
 * without resizing the element — no `resize` event, no `ResizeObserver` callback, and the canvas
 * silently starts rendering at the wrong scale. The only notification is a `matchMedia` query on
 * the current resolution, which stops matching the moment the ratio changes.
 *
 * ## Why the policy is separate from the canvas
 *
 * `backingStoreSize` and `needsResize` are pure and exported: resizing a canvas clears it, so
 * "should this resize?" decides whether a frame is preserved or thrown away, and getting it wrong
 * shows up as flicker that is painful to reproduce by hand. They are unit-tested; the class below
 * is the thin part that owns a `<canvas>`.
 */

import type { TimelineLayerId } from "./repaintPlan";

/** A canvas backing store, in device pixels. */
export interface BackingStoreSize {
  width: number;
  height: number;
}

/**
 * The buffer size for a CSS box at a given ratio.
 *
 * Rounded, not truncated: a 100.5 CSS-pixel box at 2x is 201 device pixels, and flooring to 200
 * leaves a half-pixel column unpainted at the right edge. Clamped to at least 1 because a
 * zero-sized canvas throws on `getContext` in some engines and is never what the layout meant.
 */
export function backingStoreSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number
): BackingStoreSize {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return {
    width: Math.max(1, Math.round(cssWidth * ratio)),
    height: Math.max(1, Math.round(cssHeight * ratio))
  };
}

/**
 * Whether the backing store must be reallocated.
 *
 * Assigning `canvas.width` clears the canvas even when the value is unchanged, so this is checked
 * rather than assigned unconditionally — an unconditional assignment inside a resize handler blanks
 * every layer on every scroll.
 */
export function needsResize(current: BackingStoreSize, next: BackingStoreSize): boolean {
  return current.width !== next.width || current.height !== next.height;
}

/**
 * One layer's canvas.
 *
 * Owns nothing but the element, its backing store and its 2D context. What to draw is entirely the
 * caller's; this exists so the DPR arithmetic happens in one place instead of three.
 */
export class TimelineLayerSurface {
  readonly id: TimelineLayerId;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private size: BackingStoreSize = { width: 0, height: 0 };
  private ratio = 1;

  constructor(id: TimelineLayerId, canvas: HTMLCanvasElement) {
    this.id = id;
    this.canvas = canvas;
    const context = canvas.getContext("2d", {
      // The static and content layers are composited over the panel background, so they need alpha.
      alpha: true,
      // Every layer is fully redrawn or dirty-rect cleared before drawing; none reads back.
      desynchronized: true
    });
    if (!context) {
      throw new Error(`timeline layer "${id}" could not acquire a 2D context`);
    }
    this.context = context;
  }

  get ctx(): CanvasRenderingContext2D {
    return this.context;
  }

  /** CSS pixel width of the layer. Draw calls work in this space. */
  get cssWidth(): number {
    return this.ratio > 0 ? this.size.width / this.ratio : 0;
  }

  get cssHeight(): number {
    return this.ratio > 0 ? this.size.height / this.ratio : 0;
  }

  /**
   * Match the backing store to a CSS box and ratio.
   *
   * Returns whether the buffer was reallocated — and therefore cleared — so the caller knows the
   * layer needs a full redraw rather than a dirty-rect one.
   */
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): boolean {
    const next = backingStoreSize(cssWidth, cssHeight, devicePixelRatio);
    const ratioChanged = this.ratio !== devicePixelRatio;
    if (!needsResize(this.size, next) && !ratioChanged) return false;

    this.canvas.width = next.width;
    this.canvas.height = next.height;
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.size = next;
    this.ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;

    // Reset before scaling: the transform survives a resize in some engines and compounds.
    this.context.setTransform(1, 0, 0, 1, 0, 0);
    this.context.scale(this.ratio, this.ratio);
    return true;
  }

  /** Clear the whole layer, in CSS pixels. */
  clear(): void {
    this.context.clearRect(0, 0, this.cssWidth, this.cssHeight);
  }

  /** Clear one rectangle, in CSS pixels. The content layer's dirty-rect path. */
  clearRect(x: number, y: number, width: number, height: number): void {
    this.context.clearRect(x, y, width, height);
  }
}

/**
 * Watch `devicePixelRatio` and report changes.
 *
 * A `matchMedia` query on the *current* ratio stops matching the instant it changes, which is the
 * only signal the platform gives for a window moving between displays of different densities. The
 * listener is re-armed against the new ratio each time, because the query is bound to the value it
 * was created with.
 *
 * Returns an unsubscribe. Safe to call where `matchMedia` does not exist (tests, older engines):
 * the ratio is then simply never re-reported, which degrades to today's behaviour.
 */
export function watchDevicePixelRatio(
  onChange: (devicePixelRatio: number) => void,
  scope: { matchMedia?: (query: string) => MediaQueryList; devicePixelRatio?: number } = globalThis as never
): () => void {
  if (typeof scope.matchMedia !== "function") return () => {};

  let query: MediaQueryList | null = null;
  let disposed = false;

  const arm = () => {
    if (disposed) return;
    const ratio = scope.devicePixelRatio ?? 1;
    query = scope.matchMedia!(`(resolution: ${ratio}dppx)`);
    query.addEventListener("change", handle);
  };

  const handle = () => {
    query?.removeEventListener("change", handle);
    query = null;
    if (disposed) return;
    onChange(scope.devicePixelRatio ?? 1);
    arm();
  };

  arm();
  return () => {
    disposed = true;
    query?.removeEventListener("change", handle);
    query = null;
  };
}
