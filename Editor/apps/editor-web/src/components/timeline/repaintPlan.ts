/**
 * Which timeline layers a state change dirties.
 *
 * The timeline draws on three canvases with independent repaint triggers, because the three kinds
 * of content change at wildly different rates:
 *
 * | Layer | Holds | Redraws when |
 * | --- | --- | --- |
 * | `static` | ruler, gridlines, row banding | zoom, scroll, resize, DPR — geometry only |
 * | `content` | keys, tangents, speed graph | key data or selection changes, or geometry moves |
 * | `interaction` | playhead, marquee, drag ghost | every interaction frame; cheap full clear |
 *
 * The rule this exists to enforce is that **scrubbing must not touch `static`**. A scrub changes
 * one integer, and if that redraws the ruler then dragging the playhead costs a full re-rasterise
 * of every tick and gridline on every frame — which is exactly the cost the DOM version had, moved
 * to a canvas.
 *
 * ## Why a plan rather than three `useEffect`s
 *
 * Effects would express the same dependencies, but nothing could assert them: "scrubbing produces
 * no static repaint" is a property of the dependency graph, and a graph spread across three effect
 * bodies can only be checked by rendering and counting. As a pure function of two snapshots it is
 * a unit test.
 *
 * Geometry cascades to all three deliberately: when the viewport scrolls, the keys and the playhead
 * move with the gridlines, so all three are stale together. Nothing else cascades.
 */

export const TIMELINE_LAYERS = ["static", "content", "interaction"] as const;

export type TimelineLayerId = (typeof TIMELINE_LAYERS)[number];

/**
 * Everything a repaint decision depends on, flattened.
 *
 * Deliberately all scalars. Two snapshots are compared field by field, so a nested object would
 * need a deep compare — and a deep compare is where "did the keys change?" quietly becomes O(keys)
 * on every frame, which is the cost this whole design exists to remove. Key data is represented by
 * a revision counter the store bumps instead.
 */
export interface TimelineSnapshot {
  /* Geometry — dirties every layer. */
  startFrame: number;
  pixelsPerFrame: number;
  width: number;
  height: number;
  devicePixelRatio: number;
  rowWindowFirst: number;
  rowWindowLast: number;

  /* Content. */
  /** Bumped by the store whenever any key's frame, easing or existence changes. */
  contentRevision: number;
  /** Bumped when the selected set changes. Selection is a fill colour, not a structure. */
  selectionRevision: number;

  /* Interaction. */
  currentFrame: number;
  marqueeRevision: number;
  dragRevision: number;
}

/** True when the two snapshots describe different viewport geometry. */
function geometryChanged(previous: TimelineSnapshot, next: TimelineSnapshot): boolean {
  return (
    previous.startFrame !== next.startFrame
    || previous.pixelsPerFrame !== next.pixelsPerFrame
    || previous.width !== next.width
    || previous.height !== next.height
    || previous.devicePixelRatio !== next.devicePixelRatio
    || previous.rowWindowFirst !== next.rowWindowFirst
    || previous.rowWindowLast !== next.rowWindowLast
  );
}

/**
 * The layers to repaint for a transition.
 *
 * `null` for `previous` means the first paint, which dirties everything.
 */
export function planRepaint(
  previous: TimelineSnapshot | null,
  next: TimelineSnapshot
): Set<TimelineLayerId> {
  if (!previous) return new Set(TIMELINE_LAYERS);

  const dirty = new Set<TimelineLayerId>();
  const geometry = geometryChanged(previous, next);

  if (geometry) {
    // Everything is positioned in the same space, so a change to that space stales all of it.
    return new Set(TIMELINE_LAYERS);
  }

  if (
    previous.contentRevision !== next.contentRevision
    || previous.selectionRevision !== next.selectionRevision
  ) {
    dirty.add("content");
  }

  if (
    previous.currentFrame !== next.currentFrame
    || previous.marqueeRevision !== next.marqueeRevision
    || previous.dragRevision !== next.dragRevision
  ) {
    dirty.add("interaction");
  }

  return dirty;
}

/**
 * A rectangle in CSS pixels that a content repaint may be confined to.
 *
 * `null` means the whole layer. The content layer redraws by dirty rect so that moving one key does
 * not re-rasterise a screen of them; the union of the rows and frame span a change touched is
 * enough, because nothing on the content layer draws outside its own row band.
 */
export interface DirtyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The smallest rectangle covering both, for accumulating a frame's dirty region. */
export function unionDirty(left: DirtyRect | null, right: DirtyRect | null): DirtyRect | null {
  if (!left) return right;
  if (!right) return left;

  const x = Math.min(left.x, right.x);
  const y = Math.min(left.y, right.y);
  return {
    x,
    y,
    width: Math.max(left.x + left.width, right.x + right.width) - x,
    height: Math.max(left.y + left.height, right.y + right.height) - y
  };
}

/**
 * The dirty rectangle for a frame span across a row band, padded for marker width.
 *
 * A key is drawn as a diamond centred on its frame, so the rectangle has to reach half a marker
 * beyond the frames that changed or a drag leaves a sliver of the old marker behind. The padding is
 * in pixels because it describes a drawn shape, not a time.
 */
export function rowSpanDirtyRect(
  xFrom: number,
  xTo: number,
  rowTop: number,
  rowBottom: number,
  markerRadiusPx: number
): DirtyRect {
  const left = Math.min(xFrom, xTo) - markerRadiusPx - 1;
  const right = Math.max(xFrom, xTo) + markerRadiusPx + 1;
  return {
    x: left,
    y: rowTop,
    width: Math.max(0, right - left),
    height: Math.max(0, rowBottom - rowTop)
  };
}
