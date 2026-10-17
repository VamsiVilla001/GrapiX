// The timeline's frame/pixel viewport and its row window (11.10).
//
// Two rules, and the rest follows:
//
// 1. **The integer frame is the canonical unit.** Positions, hit-tests and the
//    visible range are integer frames. Nothing here stores a time in seconds;
//    seconds are a display conversion computed from a frame on demand, never
//    accumulated. Accumulating at 29.97 drifts about a frame and a half across
//    a broadcast day, which is why `RationalRate` is rational everywhere
//    (invariant 12).
//
// 2. **The rate belongs to the scene.** It is read from the document per call.
//    Caching it here would let a rate change leave a stale copy behind.
//
// The row window is the virtualisation: `rowWindow` returns the half-open span
// of rows that intersect the scrolled viewport, and the panel renders only
// those. It is what keeps DOM node count independent of track count, exactly
// as the key index keeps drawing independent of key count.

import type { RationalRate } from "@grapix/contracts";

/// The scrolled, zoomed window onto the timeline.
export interface TimelineViewport {
  /// Leftmost visible frame.
  readonly startFrame: number;
  /// Horizontal zoom. Deliberately pixels-per-frame rather than a zoom factor:
  /// every conversion below is then a multiply, with no hidden base.
  readonly pixelsPerFrame: number;
  /// Track area size in CSS pixels.
  readonly width: number;
  readonly height: number;
  /// Vertical scroll offset in CSS pixels.
  readonly scrollTop: number;
  /// Uniform row height in CSS pixels.
  readonly rowHeight: number;
}

export const DEFAULT_ROW_HEIGHT = 24;
export const DEFAULT_PIXELS_PER_FRAME = 6;

export function frameToX(viewport: TimelineViewport, frame: number): number {
  return (frame - viewport.startFrame) * viewport.pixelsPerFrame;
}

/// The frame under a CSS-pixel offset, rounded to the nearest.
///
/// Rounds rather than floors: a pointer halfway between two frames belongs to
/// the nearer one, and flooring would bias every hit-test one frame left.
export function xToFrame(viewport: TimelineViewport, x: number): number {
  if (viewport.pixelsPerFrame <= 0) return viewport.startFrame;
  return Math.round(viewport.startFrame + x / viewport.pixelsPerFrame);
}

/// The inclusive frame span the viewport shows.
///
/// Padded by one frame each side so a key whose marker straddles the edge is
/// still drawn; a marker is a diamond centred on its frame, so half of it can
/// be visible while its frame is not.
export function visibleFrames(
  viewport: TimelineViewport,
  durationFrames: number,
): { readonly first: number; readonly last: number } {
  if (viewport.pixelsPerFrame <= 0) {
    return { first: 0, last: 0 };
  }
  const span = viewport.width / viewport.pixelsPerFrame;
  const first = Math.max(0, Math.floor(viewport.startFrame) - 1);
  const last = Math.min(durationFrames, Math.ceil(viewport.startFrame + span) + 1);
  return { first, last: Math.max(first, last) };
}

/// The half-open row span `[first, last)` that intersects the viewport.
///
/// **This is the virtualisation.** An overscan row each side keeps a
/// half-scrolled row from popping in at the edge; it is a constant, so the
/// window stays bounded by viewport height, never by row count.
export function rowWindow(
  viewport: TimelineViewport,
  rowCount: number,
  overscan = 1,
): { readonly first: number; readonly last: number } {
  if (rowCount <= 0 || viewport.rowHeight <= 0) return { first: 0, last: 0 };
  const firstVisible = Math.floor(viewport.scrollTop / viewport.rowHeight);
  const visibleCount = Math.ceil(viewport.height / viewport.rowHeight) + 1;
  const first = Math.max(0, firstVisible - overscan);
  const last = Math.min(rowCount, firstVisible + visibleCount + overscan);
  return { first, last: Math.max(first, last) };
}

/// A row's top edge in CSS pixels, relative to the scrolled content.
export function rowTop(viewport: TimelineViewport, row: number): number {
  return row * viewport.rowHeight;
}

/// The total scrollable content height. Rows are uniform, so this is a
/// multiply rather than a running sum — a sum would be O(rows) per frame.
export function contentHeight(viewport: TimelineViewport, rowCount: number): number {
  return rowCount * viewport.rowHeight;
}

/// A frame's position in seconds, for the ruler.
///
/// Computed from the frame every time, never accumulated, and through the
/// scene's rational rate rather than a decimal.
export function frameToSeconds(rate: RationalRate, frame: number): number {
  if (rate.num <= 0) return 0;
  return (Math.max(0, Math.trunc(frame)) * rate.den) / rate.num;
}

/// Clamp a viewport's start so it cannot scroll past the content.
export function clampViewport(
  viewport: TimelineViewport,
  durationFrames: number,
  rowCount: number,
): TimelineViewport {
  const span = viewport.pixelsPerFrame > 0 ? viewport.width / viewport.pixelsPerFrame : 0;
  const maxStart = Math.max(0, durationFrames - span);
  const maxScroll = Math.max(0, contentHeight(viewport, rowCount) - viewport.height);
  return {
    ...viewport,
    startFrame: Math.min(Math.max(0, viewport.startFrame), maxStart),
    scrollTop: Math.min(Math.max(0, viewport.scrollTop), maxScroll),
  };
}
