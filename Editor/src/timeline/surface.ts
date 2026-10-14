// The timeline's on-screen surface: its measured size, its snapshot, its
// wheel scroll, and the watcher that keeps the size current (11.10).
//
// **The bug this module exists to prevent.** The timeline's canvases and
// viewport were measured only when the document rendered or the window
// resized. Dragging a dock resizer, moving the timeline to a side dock or
// resetting the layout changes the container without either, so the backing
// stores kept their old size, CSS stretched them, the keys drifted off their
// row headers and pointer-to-frame mapping was wrong. The container's size is
// the input; whatever changed it, the timeline re-measures. A
// `ResizeObserver` on the container is the one signal that covers every
// cause, including ones added later.
//
// Everything here is a pure function or takes its browser dependencies as
// structural parameters, so each property is a unit test without a browser.

import { rowWindow, clampViewport, type TimelineViewport } from "./viewport";
import type { TimelineSnapshot } from "./repaint-plan";

/// The header column's width in CSS pixels: `grid-template-columns: 240px 1fr`
/// in `web/style.css`. The stage gets the rest of the container. Widened from
/// 210 for the 11.63 layer switches, swatch and index.
export const TIMELINE_HEADER_WIDTH = 240;

export interface SurfaceSize {
  readonly width: number;
  readonly height: number;
}

/// The viewport for a measured container, clamped so a shrink cannot leave the
/// view scrolled past the content.
export function viewportForBounds(
  viewport: TimelineViewport,
  bounds: SurfaceSize,
  durationFrames: number,
  rowCount: number,
): TimelineViewport {
  return clampViewport(
    {
      ...viewport,
      width: Math.max(0, bounds.width - TIMELINE_HEADER_WIDTH),
      height: Math.max(0, bounds.height),
    },
    durationFrames,
    rowCount,
  );
}

export interface SnapshotInput {
  readonly viewport: TimelineViewport;
  readonly rowCount: number;
  readonly devicePixelRatio: number;
  readonly contentRevision: number;
  readonly selectionRevision: number;
  readonly phaseRevision: number;
  readonly currentFrame: number;
  readonly marqueeRevision?: number;
  readonly dragRevision?: number;
}

/// The repaint snapshot for the current state.
///
/// The row window is the one actually rendered, from `rowWindow`, not the
/// whole row range: a snapshot that claimed every row was visible could not
/// see a scroll move the window.
export function timelineSnapshotFor(input: SnapshotInput): TimelineSnapshot {
  const window_ = rowWindow(input.viewport, input.rowCount);
  return {
    startFrame: input.viewport.startFrame,
    pixelsPerFrame: input.viewport.pixelsPerFrame,
    width: input.viewport.width,
    height: input.viewport.height,
    scrollTop: input.viewport.scrollTop,
    devicePixelRatio: input.devicePixelRatio,
    rowWindowFirst: window_.first,
    rowWindowLast: window_.last,
    contentRevision: input.contentRevision,
    selectionRevision: input.selectionRevision,
    phaseRevision: input.phaseRevision,
    currentFrame: input.currentFrame,
    marqueeRevision: input.marqueeRevision ?? 0,
    dragRevision: input.dragRevision ?? 0,
  };
}

/// The fields of a `WheelEvent` a scroll needs.
export interface WheelInput {
  readonly deltaX: number;
  readonly deltaY: number;
  /// 0 pixels, 1 lines, 2 pages — `WheelEvent.DOM_DELTA_*`.
  readonly deltaMode: number;
  readonly shiftKey: boolean;
}

/// Apply one wheel event to the viewport, clamped to the content.
///
/// Vertical wheel scrolls rows; horizontal wheel, or Shift with a vertical
/// wheel, scrolls frames. `startFrame` stays a whole frame — the integer frame
/// is the canonical unit — and a non-zero delta always moves at least one frame
/// so a trackpad's small deltas are not swallowed by rounding.
export function scrollViewportByWheel(
  viewport: TimelineViewport,
  wheel: WheelInput,
  durationFrames: number,
  rowCount: number,
): TimelineViewport {
  const unit =
    wheel.deltaMode === 1 ? viewport.rowHeight : wheel.deltaMode === 2 ? viewport.height : 1;
  const vertical = wheel.shiftKey ? 0 : wheel.deltaY * unit;
  const horizontal = (wheel.shiftKey ? wheel.deltaY + wheel.deltaX : wheel.deltaX) * unit;

  let frameDelta = 0;
  if (horizontal !== 0 && viewport.pixelsPerFrame > 0) {
    const raw = horizontal / viewport.pixelsPerFrame;
    frameDelta = Math.sign(raw) * Math.max(1, Math.round(Math.abs(raw)));
  }
  const next = clampViewport(
    {
      ...viewport,
      scrollTop: viewport.scrollTop + vertical,
      startFrame: Math.round(viewport.startFrame + frameDelta),
    },
    durationFrames,
    rowCount,
  );
  // `clampViewport` can leave a fractional maximum start; keep it a frame.
  return { ...next, startFrame: Math.floor(next.startFrame) };
}

// ---------------------------------------------------------------------------
// Watching the container
// ---------------------------------------------------------------------------

export interface ResizeObserverLike {
  observe(target: unknown): void;
  disconnect(): void;
}

export interface SizeWatchEnvironment {
  createObserver(callback: () => void): ResizeObserverLike;
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  /// The container's current CSS size. Read at frame time, not from the
  /// observer's entry, so the value is the same measure the render uses.
  measure(): SurfaceSize;
}

/// Call `onResize` once per animation frame in which the container's size
/// actually changed, whatever changed it.
///
/// Coalesced: a resizer drag delivers many observations per frame, and each
/// would otherwise rebuild the timeline's DOM. Guarded on the size itself, so
/// the render `onResize` triggers cannot feed back into another one.
///
/// Returns a dispose function.
export function watchSurfaceSize(
  target: unknown,
  environment: SizeWatchEnvironment,
  onResize: (size: SurfaceSize) => void,
): () => void {
  let pending: number | undefined;
  let last: SurfaceSize | undefined;
  let disposed = false;

  const flush = (): void => {
    pending = undefined;
    if (disposed) return;
    const size = environment.measure();
    if (last && last.width === size.width && last.height === size.height) return;
    last = size;
    onResize(size);
  };

  const observer = environment.createObserver(() => {
    if (disposed || pending !== undefined) return;
    pending = environment.requestFrame(flush);
  });
  observer.observe(target);

  return () => {
    disposed = true;
    if (pending !== undefined) environment.cancelFrame(pending);
    pending = undefined;
    observer.disconnect();
  };
}
