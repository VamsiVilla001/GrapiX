// The timeline panel: virtualised DOM rows over three canvas layers (11.10).
//
// **The done-when is a node-count property**: flat from 100 to 100,000 keys.
// Two things make it hold, and they are the whole design:
//
//   1. **No key is a DOM node.** Keys are drawn on the content canvas. A
//      document with a hundred thousand keys produces exactly the same DOM as
//      one with a hundred, because the DOM does not represent keys at all.
//   2. **Only visible rows are DOM nodes.** `rowWindow` returns the rows that
//      intersect the viewport; the rest are represented by two spacer
//      elements whose heights preserve the scrollbar. Node count is therefore
//      bounded by viewport height, not by track count.
//
// Rendering and painting are separate on purpose. `renderTimelinePanel` builds
// structure and needs only a `Document`, so the node-count property is a
// headless unit test. `paintLayer` needs a real 2D context and runs in the
// browser. A test that had to obtain a canvas context could not prove the
// thing this step is measured on.

import type { DrawingContext } from "./drawing";
import { visibleRange, type KeyIndex } from "./key-index";
import { buildSpeedGraph, paintSpeedGraph } from "./speed-graph";
import { keyId, type TimelineModel } from "./model";
import { TIMELINE_LAYERS, type DirtyRect, type TimelineLayerId } from "./repaint-plan";
import {
  contentHeight,
  frameToX,
  rowTop,
  rowWindow,
  visibleFrames,
  type TimelineViewport,
} from "./viewport";

export interface TimelinePanelParts {
  readonly root: HTMLElement;
  readonly headers: HTMLElement;
  readonly stage: HTMLElement;
  readonly canvases: Readonly<Record<TimelineLayerId, HTMLCanvasElement>>;
  /// The rows actually present in the DOM, for the caller's hit-testing.
  readonly window: { readonly first: number; readonly last: number };
}

/// Build the panel's DOM for one viewport.
///
/// Deterministic and side-effect free apart from the elements it creates, so
/// the same model and viewport always produce the same node count.
export function renderTimelinePanel(
  document: Document,
  model: TimelineModel,
  viewport: TimelineViewport,
): TimelinePanelParts {
  const window_ = rowWindow(viewport, model.rows.length);

  const root = document.createElement("div");
  root.className = "timeline";
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Timeline");

  // --- the virtualised header column ---------------------------------------
  const headers = document.createElement("div");
  headers.className = "timeline-headers";
  headers.setAttribute("role", "list");
  headers.setAttribute("aria-label", "Animated properties");
  // The full row count is announced even though only a window is rendered: a
  // screen reader must not be told there are four rows because four are
  // painted.
  headers.setAttribute("aria-setsize", String(model.rows.length));

  const before = document.createElement("div");
  before.className = "timeline-spacer";
  before.setAttribute("aria-hidden", "true");
  before.style.height = `${rowTop(viewport, window_.first)}px`;
  headers.append(before);

  for (let row = window_.first; row < window_.last; row += 1) {
    const entry = model.rows[row]!;
    const element = document.createElement("div");
    element.setAttribute("role", "listitem");
    element.setAttribute("aria-posinset", String(row + 1));
    element.style.height = `${viewport.rowHeight}px`;
    element.dataset.objectId = entry.objectId;

    if (entry.kind === "object") {
      element.className = "timeline-group-header";
      // Expanded state is the fact a screen reader needs, and the same fact
      // the caret shows.
      element.setAttribute("aria-expanded", String(!entry.collapsed));
      element.dataset.group = "";
      element.textContent = `${entry.collapsed ? "▸" : "▾"} ${entry.label} (${entry.trackCount})`;
    } else {
      element.className = "timeline-row-header";
      element.dataset.property = entry.property;
      element.dataset.track = String(entry.track);
      element.textContent = entry.label;
    }
    headers.append(element);
  }

  const after = document.createElement("div");
  after.className = "timeline-spacer";
  after.setAttribute("aria-hidden", "true");
  after.style.height = `${Math.max(
    0,
    contentHeight(viewport, model.rows.length) - rowTop(viewport, window_.last),
  )}px`;
  headers.append(after);

  // --- the canvas stack -----------------------------------------------------
  const stage = document.createElement("div");
  stage.className = "timeline-stage";

  const canvases = {} as Record<TimelineLayerId, HTMLCanvasElement>;
  for (const layer of TIMELINE_LAYERS) {
    const canvas = document.createElement("canvas");
    canvas.className = `timeline-layer timeline-layer-${layer}`;
    canvas.dataset.layer = layer;
    canvas.width = Math.max(0, Math.round(viewport.width));
    canvas.height = Math.max(0, Math.round(viewport.height));
    // The raster is not the interface: everything an assistive technology or
    // an agent needs is in the header list above.
    canvas.setAttribute("aria-hidden", "true");
    canvases[layer] = canvas;
    stage.append(canvas);
  }

  root.append(headers, stage);
  return { root, headers, stage, canvases, window: window_ };
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

/// The colours a layer draws with. Passed in rather than read from CSS so a
/// paint is a pure function of its inputs and can be exercised against a stub
/// context.
export interface TimelineTheme {
  readonly ruler: string;
  readonly gridline: string;
  readonly rowBand: string;
  readonly key: string;
  readonly keySelected: string;
  readonly playhead: string;
  readonly marquee: string;
}

export const DEFAULT_THEME: TimelineTheme = {
  ruler: "#8494a3",
  gridline: "#29323b",
  rowBand: "#171d23",
  key: "#58b8ef",
  keySelected: "#f5fbff",
  playhead: "#df4dc4",
  marquee: "#67c4f5",
};

/// The marker half-width in CSS pixels. Shared with `rowSpanDirtyRect` so a
/// dirty rectangle always covers the shape that was drawn in it.
export const MARKER_RADIUS_PX = 4;

/// Re-exported so callers that already import the panel keep one import.
export type { DrawingContext } from "./drawing";

function diamond(context: DrawingContext, x: number, y: number, radius: number): void {
  context.beginPath();
  context.moveTo(x, y - radius);
  context.lineTo(x + radius, y);
  context.lineTo(x, y + radius);
  context.lineTo(x - radius, y);
  context.closePath();
  context.fill();
}

export interface PaintState {
  readonly model: TimelineModel;
  readonly viewport: TimelineViewport;
  readonly currentFrame: number;
  readonly selected: ReadonlySet<string>;
  readonly theme?: TimelineTheme;
  /// When set, the content layer draws that track's speed graph instead of
  /// the dope sheet. "Advanced curves appear on demand" (11.23) is this flag.
  readonly graphTrack?: number;
}

/// Paint one layer, optionally confined to a dirty rectangle.
///
/// The `dirty` rectangle is what makes moving one key cost one key's worth of
/// rasterisation rather than a screenful: the context is clipped to it and
/// only the rows it covers are visited.
export function paintLayer(
  context: DrawingContext,
  layer: TimelineLayerId,
  state: PaintState,
  dirty: DirtyRect | null = null,
): void {
  const { model, viewport, currentFrame, selected } = state;
  const theme = state.theme ?? DEFAULT_THEME;
  const window_ = rowWindow(viewport, model.rows.length);
  const frames = visibleFrames(viewport, model.durationFrames);

  context.save();
  if (dirty) {
    context.beginPath();
    context.rect(dirty.x, dirty.y, dirty.width, dirty.height);
    context.clip();
    context.clearRect(dirty.x, dirty.y, dirty.width, dirty.height);
  } else {
    context.clearRect(0, 0, viewport.width, viewport.height);
  }

  if (layer === "static") {
    // Row banding and gridlines. Both are geometry, and neither is touched by
    // a scrub — which is the property `planRepaint` exists to guarantee.
    context.fillStyle = theme.rowBand;
    for (let row = window_.first; row < window_.last; row += 1) {
      if (row % 2 === 1) continue;
      context.fillRect(0, rowTop(viewport, row) - viewport.scrollTop, viewport.width, viewport.rowHeight);
    }
    context.strokeStyle = theme.gridline;
    context.lineWidth = 1;
    context.beginPath();
    // One gridline per second, derived from the scene's rational rate rather
    // than a decimal so the ticks land on real frames.
    const perSecond = Math.max(1, Math.round(model.frameRate.num / model.frameRate.den));
    const firstTick = Math.ceil(frames.first / perSecond) * perSecond;
    for (let frame = firstTick; frame <= frames.last; frame += perSecond) {
      const x = frameToX(viewport, frame);
      context.moveTo(x, 0);
      context.lineTo(x, viewport.height);
    }
    context.stroke();
  }

  if (layer === "content") {
    // Advanced curves on demand (11.23): when a track is opened as a graph,
    // the content layer shows its value curve instead of the dope sheet. The
    // playhead stays on the interaction layer either way, so a scrub still
    // costs nothing here.
    const graphTrack = state.graphTrack;
    if (graphTrack !== undefined && model.tracks[graphTrack]) {
      const track = model.tracks[graphTrack]!;
      paintSpeedGraph(
        context,
        buildSpeedGraph(
        { keys: track.sourceKeys },
          viewport,
          viewport.height,
          model.durationFrames,
        ),
      );
      context.restore();
      return;
    }
    // Only visible rows, and within each only the visible key run — two
    // binary searches, never a scan. Group rows carry no keys of their own.
    for (let row = window_.first; row < window_.last; row += 1) {
      const entry = model.rows[row];
      if (!entry || entry.kind !== "track") continue;
      const track = model.tracks[entry.track]!;
      const y = rowTop(viewport, row) - viewport.scrollTop + viewport.rowHeight / 2;
      const span = visibleRange(track.keys, frames.first, frames.last);
      for (let index = span.from; index < span.to; index += 1) {
        const frame = track.keys.frames[index]!;
        const key = keyId(track.objectId, track.property, frame);
        const isSelected = selected.has(key);
        context.fillStyle = isSelected ? theme.keySelected : theme.key;
        // A selected key is drawn larger as well as lighter: colour alone is
        // not a distinction every author can see.
        diamond(
          context,
          frameToX(viewport, frame),
          y,
          isSelected ? MARKER_RADIUS_PX + 1.5 : MARKER_RADIUS_PX,
        );
      }
    }
  }

  if (layer === "interaction") {
    context.strokeStyle = theme.playhead;
    context.lineWidth = 1;
    context.beginPath();
    const x = frameToX(viewport, currentFrame);
    context.moveTo(x, 0);
    context.lineTo(x, viewport.height);
    context.stroke();
  }

  context.restore();
}

/// How many keys a full content paint would draw, for the flatness test.
///
/// Exposed because the done-when is about cost, and cost here is the count of
/// markers drawn. A caller can assert this stays bounded by the viewport while
/// the document's key count grows by three orders of magnitude.
export function visibleKeyCount(model: TimelineModel, viewport: TimelineViewport): number {
  const window_ = rowWindow(viewport, model.rows.length);
  const frames = visibleFrames(viewport, model.durationFrames);
  let total = 0;
  for (let row = window_.first; row < window_.last; row += 1) {
    const entry = model.rows[row];
    if (!entry || entry.kind !== "track") continue;
    const keys: KeyIndex = model.tracks[entry.track]!.keys;
    const span = visibleRange(keys, frames.first, frames.last);
    total += span.to - span.from;
  }
  return total;
}
