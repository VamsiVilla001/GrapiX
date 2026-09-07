/**
 * The timeline's track area, drawn on three canvases.
 *
 * Replaces one DOM node per keyframe, per track line and per ruler tick with three canvas elements
 * whose count does not depend on the scene. A show-sized document reaches tens of thousands of
 * keys; the panel used to mount one `<button>` for every key on a visible row, and reconcile all of
 * them on every scrub tick.
 *
 * ## Why this component almost never re-renders
 *
 * React's job here is structural: how many rows are mounted, how big the box is, which rows they
 * are. Scrubbing and dragging change none of that — they change where a line is drawn — so this
 * component **subscribes to the interaction stores imperatively** and repaints a canvas from the
 * subscription callback. Nothing in a scrub reaches React at all.
 *
 * That is the whole reason `useUiStore.subscribe` appears instead of `useUiStore(selector)`: the
 * hook form would re-render the component sixty times a second and reconcile the label gutter with
 * it, which is the cost this file exists to remove.
 *
 * ## Layers
 *
 * `static` (ruler, gridlines, banding), `content` (keys), `interaction` (playhead, marquee) — see
 * `./repaintPlan.ts` for which state dirties which, and for the rule that a scrub must never dirty
 * `static`.
 */

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { useUiStore } from "../../store/uiStore";
import {
  drawInteractionLayer,
  drawKeyRows,
  drawStaticLayer,
  type KeyRowDraw,
  type TimelineMetrics,
  type TimelineTheme
} from "./drawTimeline";
import { TimelineLayerSurface, watchDevicePixelRatio } from "./layerSurface";
import { planRepaint, type TimelineSnapshot } from "./repaintPlan";
import { createViewport, visibleFrameRange, type TimelineViewport } from "./timelineViewport";

export interface TimelineCanvasProps {
  /** Rows currently mounted, in window order, with their key data. */
  rows: readonly KeyRowDraw[];
  /** Absolute index of the first mounted row, so banding does not jump when scrolling. */
  firstRowIndex: number;
  durationFrames: number;
  /** Leftmost visible frame. Integer. */
  startFrame: number;
  pixelsPerFrame: number;
  theme: TimelineTheme;
  metrics: TimelineMetrics;
  /** Bumped by the caller whenever key data changes. Compared, never deep-inspected. */
  contentRevision: number;
  /** Bumped whenever the selected set changes. */
  selectionRevision: number;
  /** The live marquee, or null. Read imperatively; changing it does not re-render this component. */
  marqueeRef: React.RefObject<{ frameFrom: number; frameTo: number; rowFrom: number; rowTo: number } | null>;
  /** Bumped by the caller to force an interaction repaint (marquee or drag ghost moved). */
  interactionRevision: number;
}

export function TimelineCanvas(props: TimelineCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const staticRef = useRef<HTMLCanvasElement>(null);
  const contentRef = useRef<HTMLCanvasElement>(null);
  const interactionRef = useRef<HTMLCanvasElement>(null);

  const surfaces = useRef<{
    static?: TimelineLayerSurface;
    content?: TimelineLayerSurface;
    interaction?: TimelineLayerSurface;
  }>({});

  /** Last snapshot drawn, for the repaint plan. Never state: comparing it must not re-render. */
  const lastSnapshot = useRef<TimelineSnapshot | null>(null);
  /** Current box and ratio, written by the observers below and read by every draw. */
  const geometry = useRef({ width: 0, height: 0, devicePixelRatio: 1 });
  /** Props the imperative draw needs. A ref so the subscription callback is never stale. */
  const latest = useRef(props);
  latest.current = props;

  /**
   * Draw whichever layers the transition dirties.
   *
   * The single entry point: React effects, the resize observer, the DPR watcher and the store
   * subscriptions all call this, and the plan decides what actually gets rasterised.
   */
  const paint = useCallback((options: { force?: boolean } = {}) => {
    const { width, height, devicePixelRatio } = geometry.current;
    if (width <= 0 || height <= 0) return;

    const current = latest.current;
    const viewport: TimelineViewport = createViewport(current.startFrame, current.pixelsPerFrame, width);
    const currentFrame = useUiStore.getState().currentFrame;

    const snapshot: TimelineSnapshot = {
      startFrame: viewport.startFrame,
      pixelsPerFrame: viewport.pixelsPerFrame,
      width,
      height,
      devicePixelRatio,
      rowWindowFirst: current.firstRowIndex,
      rowWindowLast: current.firstRowIndex + current.rows.length,
      contentRevision: current.contentRevision,
      selectionRevision: current.selectionRevision,
      currentFrame,
      marqueeRevision: current.interactionRevision,
      dragRevision: current.interactionRevision
    };

    const dirty = options.force ? new Set(["static", "content", "interaction"] as const) : planRepaint(lastSnapshot.current, snapshot);
    lastSnapshot.current = snapshot;
    if (dirty.size === 0) return;

    const range = visibleFrameRange(viewport, current.durationFrames);

    if (dirty.has("static") && surfaces.current.static) {
      drawStaticLayer(surfaces.current.static.ctx, {
        viewport,
        height,
        rowCount: current.rows.length,
        firstRowIndex: current.firstRowIndex,
        durationFrames: current.durationFrames,
        theme: current.theme,
        metrics: current.metrics
      });
    }

    if (dirty.has("content") && surfaces.current.content) {
      surfaces.current.content.clear();
      drawKeyRows(surfaces.current.content.ctx, {
        rows: current.rows,
        viewport,
        firstFrame: range.first,
        lastFrame: range.last,
        theme: current.theme,
        metrics: current.metrics
      });
    }

    if (dirty.has("interaction") && surfaces.current.interaction) {
      drawInteractionLayer(surfaces.current.interaction.ctx, {
        viewport,
        height,
        currentFrame,
        marquee: current.marqueeRef.current,
        theme: current.theme,
        metrics: current.metrics
      });
    }
  }, []);

  /** Match every backing store to the box, then redraw everything a resize cleared. */
  const resizeAll = useCallback(() => {
    const { width, height, devicePixelRatio } = geometry.current;
    if (width <= 0 || height <= 0) return;

    let reallocated = false;
    for (const surface of [surfaces.current.static, surfaces.current.content, surfaces.current.interaction]) {
      if (surface?.resize(width, height, devicePixelRatio)) reallocated = true;
    }
    // Resizing a canvas clears it, so the plan's opinion is irrelevant: everything must be redrawn.
    paint({ force: reallocated });
  }, [paint]);

  // Layout effect, not effect: the canvases must be sized before the browser paints, or the first
  // frame shows an unsized canvas at its 300x150 default.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || !staticRef.current || !contentRef.current || !interactionRef.current) return undefined;

    surfaces.current = {
      static: new TimelineLayerSurface("static", staticRef.current),
      content: new TimelineLayerSurface("content", contentRef.current),
      interaction: new TimelineLayerSurface("interaction", interactionRef.current)
    };

    const measure = () => {
      const rect = host.getBoundingClientRect();
      geometry.current = {
        width: rect.width,
        height: rect.height,
        devicePixelRatio: window.devicePixelRatio || 1
      };
      resizeAll();
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);

    const stopWatchingDpr = watchDevicePixelRatio((devicePixelRatio) => {
      geometry.current = { ...geometry.current, devicePixelRatio };
      resizeAll();
    });

    return () => {
      observer.disconnect();
      stopWatchingDpr();
      surfaces.current = {};
      lastSnapshot.current = null;
    };
  }, [resizeAll]);

  /**
   * The playhead, without React.
   *
   * `subscribe` rather than the hook: a scrub changes `currentFrame` sixty times a second, and the
   * hook form would re-render this component and reconcile the row gutter beside it on every one of
   * them. The subscription repaints one canvas and touches nothing else.
   */
  useEffect(() => {
    let scheduled = 0;
    const repaint = () => {
      scheduled = 0;
      paint();
    };

    return useUiStore.subscribe((state, previous) => {
      if (state.currentFrame === previous.currentFrame) return;
      // Coalesce to one repaint per frame: playback ticks on an interval that need not align with
      // the compositor, and two ticks inside one frame should cost one draw.
      if (scheduled === 0) scheduled = window.requestAnimationFrame(repaint);
    });
  }, [paint]);

  // Structural changes — row window, zoom, scroll, key data, selection — arrive as prop changes and
  // repaint through the plan, which decides whether that means all three layers or only content.
  useEffect(() => {
    paint();
  }, [
    paint,
    props.contentRevision,
    props.selectionRevision,
    props.interactionRevision,
    props.firstRowIndex,
    props.rows,
    props.startFrame,
    props.pixelsPerFrame,
    props.durationFrames
  ]);

  return (
    <div className="timeline-canvas-stack" ref={hostRef}>
      <canvas aria-hidden="true" className="timeline-layer timeline-layer-static" ref={staticRef} />
      <canvas aria-hidden="true" className="timeline-layer timeline-layer-content" ref={contentRef} />
      <canvas aria-hidden="true" className="timeline-layer timeline-layer-interaction" ref={interactionRef} />
    </div>
  );
}
