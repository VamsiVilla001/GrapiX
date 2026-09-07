/**
 * The timeline's draw calls.
 *
 * Split from the component so the drawing can be tested without a DOM: every function here takes a
 * `Canvas2DLike`, which a recording double satisfies. That is what makes "drawing a row of 100,000
 * keys issues draw calls only for the visible ones" an assertion rather than a claim.
 *
 * All coordinates are CSS pixels. The surface has already scaled the context by
 * `devicePixelRatio` (see `./layerSurface.ts`), so nothing here multiplies by it.
 *
 * ## Layer discipline
 *
 * Each function belongs to exactly one layer and says so. Drawing something on the wrong layer is
 * how a playhead ends up forcing a ruler re-rasterise, which is the specific cost this design
 * exists to avoid — so the layer is in the function name, not in a comment at the call site.
 */

import {
  frameToX,
  type TimelineViewport
} from "./timelineViewport";
import { visibleSlice, type KeyIndex } from "./keyIndex";

/**
 * The part of `CanvasRenderingContext2D` the timeline uses.
 *
 * Narrow on purpose: a smaller surface is a smaller double, and a draw function that needs
 * something outside this list is doing something the layer model did not anticipate.
 */
export interface Canvas2DLike {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
  save(): void;
  restore(): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  rect(x: number, y: number, width: number, height: number): void;
  fill(): void;
  stroke(): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
}

/** Colours and metrics, so a theme change is one object rather than a sweep through draw calls. */
export interface TimelineTheme {
  rulerText: string;
  rulerTick: string;
  gridLine: string;
  rowBandEven: string;
  rowBandOdd: string;
  key: string;
  keySelected: string;
  keyStroke: string;
  playhead: string;
  marqueeFill: string;
  marqueeStroke: string;
  font: string;
}

export interface TimelineMetrics {
  rowHeight: number;
  rulerHeight: number;
  /** Half-width of a key diamond, in CSS pixels. */
  markerRadius: number;
}

/**
 * Choose a tick interval that keeps labels readable at any zoom.
 *
 * Ticks are placed on frame multiples rather than at fixed pixel intervals, so a label always names
 * a round frame number instead of whatever frame happened to land near a pixel. The 1-2-5 ladder is
 * the usual one: it keeps the gap between labels within a factor of 2.5 of the target at every
 * decade, so labels never crowd or strand.
 */
export function chooseTickInterval(pixelsPerFrame: number, targetPixels = 90): number {
  const targetFrames = Math.max(1, targetPixels / pixelsPerFrame);
  const magnitude = 10 ** Math.floor(Math.log10(targetFrames));

  for (const step of [1, 2, 5, 10]) {
    const candidate = step * magnitude;
    if (candidate >= targetFrames) return candidate;
  }
  return 10 * magnitude;
}

/**
 * L0 — the ruler, gridlines and row banding.
 *
 * Redrawn only on zoom, scroll, resize or DPR change. Never on a scrub.
 */
export function drawStaticLayer(
  ctx: Canvas2DLike,
  options: {
    viewport: TimelineViewport;
    height: number;
    rowCount: number;
    firstRowIndex: number;
    durationFrames: number;
    theme: TimelineTheme;
    metrics: TimelineMetrics;
  }
): void {
  const { viewport, height, rowCount, firstRowIndex, theme, metrics } = options;
  ctx.clearRect(0, 0, viewport.width, height);

  // Row banding first, so gridlines sit on top of it.
  for (let row = 0; row < rowCount; row += 1) {
    const absoluteRow = firstRowIndex + row;
    ctx.fillStyle = absoluteRow % 2 === 0 ? theme.rowBandEven : theme.rowBandOdd;
    ctx.fillRect(0, metrics.rulerHeight + row * metrics.rowHeight, viewport.width, metrics.rowHeight);
  }

  const interval = chooseTickInterval(viewport.pixelsPerFrame);
  const firstTick = Math.ceil(viewport.startFrame / interval) * interval;
  const lastFrame = viewport.startFrame + viewport.width / viewport.pixelsPerFrame;

  ctx.font = theme.font;
  ctx.textBaseline = "middle";
  ctx.lineWidth = 1;

  for (let frame = firstTick; frame <= lastFrame; frame += interval) {
    // +0.5 puts a 1px line on a whole device pixel instead of straddling two and rendering grey.
    const x = Math.round(frameToX(viewport, frame)) + 0.5;

    ctx.strokeStyle = theme.gridLine;
    ctx.beginPath();
    ctx.moveTo(x, metrics.rulerHeight);
    ctx.lineTo(x, height);
    ctx.stroke();

    ctx.strokeStyle = theme.rulerTick;
    ctx.beginPath();
    ctx.moveTo(x, metrics.rulerHeight - 6);
    ctx.lineTo(x, metrics.rulerHeight);
    ctx.stroke();

    ctx.fillStyle = theme.rulerText;
    ctx.fillText(`${frame}f`, x + 4, metrics.rulerHeight / 2);
  }
}

/** One row's worth of keys to draw. */
export interface KeyRowDraw {
  index: KeyIndex;
  /** Row position within the mounted window, not the absolute row index. */
  windowRow: number;
  /** Positions within `index` that are selected. */
  selected: ReadonlySet<number>;
}

/**
 * L1 — keyframe diamonds.
 *
 * The visible run comes from two binary searches per row, so the number of draw calls follows how
 * many keys are on screen rather than how many the row holds. A row of 100,000 keys zoomed to show
 * 40 of them issues 40 diamonds.
 *
 * Returns the number of keys drawn, which the tests assert on and the caller can log.
 */
export function drawKeyRows(
  ctx: Canvas2DLike,
  options: {
    rows: readonly KeyRowDraw[];
    viewport: TimelineViewport;
    firstFrame: number;
    lastFrame: number;
    theme: TimelineTheme;
    metrics: TimelineMetrics;
  }
): number {
  const { rows, viewport, firstFrame, lastFrame, theme, metrics } = options;
  let drawn = 0;

  ctx.lineWidth = 1;
  ctx.strokeStyle = theme.keyStroke;

  for (const row of rows) {
    const { start, end } = visibleSlice(row.index, firstFrame, lastFrame);
    if (start === end) continue;

    const centreY = metrics.rulerHeight + row.windowRow * metrics.rowHeight + metrics.rowHeight / 2;

    for (let position = start; position < end; position += 1) {
      const x = frameToX(viewport, row.index.frames[position]);

      // Selection is a fill colour. It changes no geometry and creates nothing.
      ctx.fillStyle = row.selected.has(position) ? theme.keySelected : theme.key;

      ctx.beginPath();
      ctx.moveTo(x, centreY - metrics.markerRadius);
      ctx.lineTo(x + metrics.markerRadius, centreY);
      ctx.lineTo(x, centreY + metrics.markerRadius);
      ctx.lineTo(x - metrics.markerRadius, centreY);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      drawn += 1;
    }
  }

  return drawn;
}

/**
 * L2 — playhead, marquee and drag ghost.
 *
 * Cleared and redrawn whole every interaction frame. It holds a handful of shapes, so a full clear
 * is cheaper than tracking what moved — and it is the layer that must never dirty another.
 */
export function drawInteractionLayer(
  ctx: Canvas2DLike,
  options: {
    viewport: TimelineViewport;
    height: number;
    currentFrame: number;
    marquee: { frameFrom: number; frameTo: number; rowFrom: number; rowTo: number } | null;
    theme: TimelineTheme;
    metrics: TimelineMetrics;
  }
): void {
  const { viewport, height, currentFrame, marquee, theme, metrics } = options;
  ctx.clearRect(0, 0, viewport.width, height);

  if (marquee) {
    const left = frameToX(viewport, Math.min(marquee.frameFrom, marquee.frameTo));
    const right = frameToX(viewport, Math.max(marquee.frameFrom, marquee.frameTo));
    const top = metrics.rulerHeight + Math.min(marquee.rowFrom, marquee.rowTo) * metrics.rowHeight;
    const bottom = metrics.rulerHeight + (Math.max(marquee.rowFrom, marquee.rowTo) + 1) * metrics.rowHeight;

    ctx.fillStyle = theme.marqueeFill;
    ctx.fillRect(left, top, right - left, bottom - top);
    ctx.strokeStyle = theme.marqueeStroke;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(left + 0.5, top + 0.5, right - left, bottom - top);
    ctx.stroke();
  }

  const x = Math.round(frameToX(viewport, currentFrame)) + 0.5;
  ctx.strokeStyle = theme.playhead;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, height);
  ctx.stroke();
}
