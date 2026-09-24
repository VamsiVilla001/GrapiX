// The timeline follows its container's size and scrolls by wheel (11.10).
//
// The bug these tests pin: a dock resize, a dock move or a layout reset
// changed the timeline's container without re-measuring the timeline, so the
// canvases kept their old backing size and CSS stretched them. The fixes are
// a size watcher on the container and a snapshot that carries the real row
// window and scroll offset. The 11.11 gate — a scrub never repaints the
// static layer — must still hold after a resize and after a scroll.

import { describe, expect, it } from "vitest";

import type { SceneDocument, SceneObject } from "@grapix/contracts";
import { backingStore, sizeCanvasForRatio } from "../src/dpi";
import { timelineModel, type TimelineModel } from "../src/timeline/model";
import { renderTimelinePanel } from "../src/timeline/panel";
import {
  planRepaint,
  TIMELINE_LAYERS,
  type TimelineLayerId,
  type TimelineSnapshot,
} from "../src/timeline/repaint-plan";
import {
  scrollViewportByWheel,
  TIMELINE_HEADER_WIDTH,
  timelineSnapshotFor,
  viewportForBounds,
  watchSurfaceSize,
  type SurfaceSize,
} from "../src/timeline/surface";
import { rowWindow, type TimelineViewport } from "../src/timeline/viewport";

// --- fakes ------------------------------------------------------------------

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  className = "";
  textContent = "";
  width = 0;
  height = 0;
  constructor(readonly tag: string) {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }
}

const fakeDocument = {
  createElement: (tag: string) => new FakeElement(tag),
} as unknown as Document;

function countNodes(element: FakeElement): number {
  return 1 + element.children.reduce((total, child) => total + countNodes(child), 0);
}

/// A ResizeObserver and animation-frame queue driven by hand.
function fakeEnvironment(initial: SurfaceSize) {
  let size = initial;
  let observerCallback: (() => void) | undefined;
  const frames = new Map<number, () => void>();
  let nextHandle = 1;
  const stats = { observed: 0, disconnected: 0, requested: 0, cancelled: 0 };
  return {
    stats,
    setSize(next: SurfaceSize): void {
      size = next;
    },
    /// What the browser does when the observed box changes.
    notify(): void {
      observerCallback?.();
    },
    /// Run every queued animation frame.
    runFrames(): void {
      const queued = [...frames.values()];
      frames.clear();
      for (const callback of queued) callback();
    },
    environment: {
      createObserver: (callback: () => void) => {
        observerCallback = callback;
        return {
          observe: () => {
            stats.observed += 1;
          },
          disconnect: () => {
            stats.disconnected += 1;
          },
        };
      },
      requestFrame: (callback: () => void) => {
        stats.requested += 1;
        const handle = nextHandle++;
        frames.set(handle, callback);
        return handle;
      },
      cancelFrame: (handle: number) => {
        stats.cancelled += 1;
        frames.delete(handle);
      },
      measure: () => size,
    },
  };
}

// --- fixtures ---------------------------------------------------------------

function rect(id: string): SceneObject {
  return { type: "rect", id, name: id, radius: 0, x: 0, y: 0 } as unknown as SceneObject;
}

function scene(tracks: number, perTrack: number, durationFrames = 100_000): SceneDocument {
  const objects = Array.from({ length: tracks }, (_, index) => rect(`o${index}`));
  const channels = Array.from({ length: tracks }, (_, index) => ({
    objectId: `o${index}`,
    property: "x",
    keys: Array.from({ length: perTrack }, (_, key) => ({
      frame: Math.floor((key * durationFrames) / perTrack) as unknown as bigint,
      value: key,
      easing: "linear" as const,
    })),
  }));
  return {
    id: "s",
    name: "S",
    version: 1,
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    timeline: { durationFrames: durationFrames as unknown as bigint, channels, phases: [] },
    dataContext: {},
    assets: [],
    fonts: [],
    materials: [],
    controls: [],
    textStyles: [],
    objects,
  } as SceneDocument;
}

const initial: TimelineViewport = {
  startFrame: 0,
  pixelsPerFrame: 6,
  width: 0,
  height: 0,
  scrollTop: 0,
  rowHeight: 22,
};

function snapshot(
  model: TimelineModel,
  viewport: TimelineViewport,
  currentFrame: number,
  devicePixelRatio = 1,
): TimelineSnapshot {
  return timelineSnapshotFor({
    viewport,
    rowCount: model.rows.length,
    devicePixelRatio,
    contentRevision: 1,
    selectionRevision: 1,
    phaseRevision: 1,
    currentFrame,
  });
}

/// Count which layers a run of scrubs dirties, starting from a snapshot.
function scrubCounts(
  model: TimelineModel,
  viewport: TimelineViewport,
  from: TimelineSnapshot,
  scrubs: number,
  devicePixelRatio = 1,
): Record<TimelineLayerId, number> {
  const counts: Record<TimelineLayerId, number> = { static: 0, content: 0, interaction: 0 };
  let previous = from;
  for (let step = 1; step <= scrubs; step += 1) {
    const next = snapshot(model, viewport, from.currentFrame + step, devicePixelRatio);
    for (const layer of planRepaint(previous, next)) counts[layer] += 1;
    previous = next;
  }
  return counts;
}

// --- the size watcher -------------------------------------------------------

describe("the timeline follows its container's size", () => {
  it("renders once per frame with the new size, however many observations arrive", () => {
    const fake = fakeEnvironment({ width: 1110, height: 220 });
    const renders: SurfaceSize[] = [];
    watchSurfaceSize({}, fake.environment, (size) => renders.push(size));
    expect(fake.stats.observed).toBe(1);

    // The observer's first delivery on `observe`.
    fake.notify();
    fake.runFrames();
    expect(renders).toEqual([{ width: 1110, height: 220 }]);

    // A resizer drag: many observations inside one frame, one render.
    for (const height of [240, 260, 280, 300]) {
      fake.setSize({ width: 1110, height });
      fake.notify();
    }
    expect(fake.stats.requested).toBe(2);
    fake.runFrames();
    expect(renders).toEqual([
      { width: 1110, height: 220 },
      { width: 1110, height: 300 },
    ]);
  });

  it("does not render when the size did not change, so a render cannot loop", () => {
    const fake = fakeEnvironment({ width: 800, height: 200 });
    let renders = 0;
    watchSurfaceSize({}, fake.environment, () => (renders += 1));
    fake.notify();
    fake.runFrames();
    fake.notify();
    fake.runFrames();
    expect(renders).toBe(1);
  });

  it("disposes the observer and any pending frame", () => {
    const fake = fakeEnvironment({ width: 800, height: 200 });
    let renders = 0;
    const dispose = watchSurfaceSize({}, fake.environment, () => (renders += 1));
    fake.notify();
    dispose();
    fake.runFrames();
    fake.notify();
    fake.runFrames();
    expect(renders).toBe(0);
    expect(fake.stats.disconnected).toBe(1);
    expect(fake.stats.cancelled).toBe(1);
  });

  it("a resize produces canvases at the new size, backed at CSS size × ratio", () => {
    const model = timelineModel(scene(40, 2_500));
    const ratio = 1.25;

    // Bottom dock at 1110×220, then dragged to 1110×340, then moved to a side
    // dock at 530×700.
    const sizes: SurfaceSize[] = [
      { width: 1110, height: 220 },
      { width: 1110, height: 340 },
      { width: 530, height: 700 },
    ];
    let viewport = initial;
    let previous: TimelineSnapshot | null = null;
    for (const bounds of sizes) {
      viewport = viewportForBounds(viewport, bounds, model.durationFrames, model.rows.length);
      expect(viewport.width).toBe(bounds.width - TIMELINE_HEADER_WIDTH);
      expect(viewport.height).toBe(bounds.height);

      const parts = renderTimelinePanel(fakeDocument, model, viewport);
      for (const layer of TIMELINE_LAYERS) {
        const canvas = parts.canvases[layer] as unknown as FakeElement & {
          style: { width: string; height: string };
        };
        sizeCanvasForRatio(canvas, viewport.width, viewport.height, ratio);
        const expected = backingStore(viewport.width, viewport.height, ratio);
        expect(canvas.width).toBe(expected.width);
        expect(canvas.height).toBe(expected.height);
        expect(canvas.style.width).toBe(`${viewport.width}px`);
        expect(canvas.style.height).toBe(`${viewport.height}px`);
      }

      // A geometry change legitimately dirties all three layers...
      const next = snapshot(model, viewport, 10, ratio);
      if (previous) expect(planRepaint(previous, next).size).toBe(3);
      // ...and ten scrubs after it dirty only the interaction layer.
      expect(scrubCounts(model, viewport, next, 10, ratio)).toEqual({
        static: 0,
        content: 0,
        interaction: 10,
      });
      previous = next;
    }
  });

  it("a shrink clamps the scroll so the view cannot sit past the content", () => {
    const model = timelineModel(scene(5, 4));
    const tall = viewportForBounds(
      { ...initial, scrollTop: 150 },
      { width: 900, height: 100 },
      model.durationFrames,
      model.rows.length,
    );
    // 10 rows × 22px = 220px of content in a 100px view: at most 120px scroll.
    expect(tall.scrollTop).toBe(120);
    const grown = viewportForBounds(tall, { width: 900, height: 400 }, model.durationFrames, model.rows.length);
    expect(grown.scrollTop).toBe(0);
  });
});

// --- the snapshot ------------------------------------------------------------

describe("the repaint snapshot carries the real view", () => {
  it("uses the rendered row window, not the whole track range", () => {
    const model = timelineModel(scene(500, 4));
    const viewport = viewportForBounds(initial, { width: 1110, height: 220 }, model.durationFrames, model.rows.length);
    const shot = snapshot(model, viewport, 0);
    const window_ = rowWindow(viewport, model.rows.length);
    expect(shot.rowWindowFirst).toBe(window_.first);
    expect(shot.rowWindowLast).toBe(window_.last);
    expect(shot.rowWindowLast).toBeLessThan(20);
  });

  it("a sub-row scroll is geometry, and a scrub after it still skips static", () => {
    const model = timelineModel(scene(500, 4));
    const viewport = viewportForBounds(initial, { width: 1110, height: 220 }, model.durationFrames, model.rows.length);
    const before = snapshot(model, viewport, 0);
    const scrolled = { ...viewport, scrollTop: 5 };
    const after = snapshot(model, scrolled, 0);
    // Same row window, different pixels: every layer is stale.
    expect(after.rowWindowFirst).toBe(before.rowWindowFirst);
    expect(planRepaint(before, after).size).toBe(3);
    expect(scrubCounts(model, scrolled, after, 10)).toEqual({ static: 0, content: 0, interaction: 10 });
  });
});

// --- wheel scroll --------------------------------------------------------------

describe("wheel scroll reaches every row and frame", () => {
  const wheel = (deltaY: number, extra: Partial<{ deltaX: number; deltaMode: number; shiftKey: boolean }> = {}) => ({
    deltaX: 0,
    deltaMode: 0,
    shiftKey: false,
    ...extra,
    deltaY,
  });

  it("scrolls rows vertically, clamped at both ends", () => {
    const model = timelineModel(scene(500, 4));
    let viewport = viewportForBounds(initial, { width: 1110, height: 220 }, model.durationFrames, model.rows.length);
    viewport = scrollViewportByWheel(viewport, wheel(-100), model.durationFrames, model.rows.length);
    expect(viewport.scrollTop).toBe(0);
    viewport = scrollViewportByWheel(viewport, wheel(3, { deltaMode: 1 }), model.durationFrames, model.rows.length);
    expect(viewport.scrollTop).toBe(3 * 22);
    viewport = scrollViewportByWheel(viewport, wheel(1e9), model.durationFrames, model.rows.length);
    expect(viewport.scrollTop).toBe(model.rows.length * 22 - 220);
    // The last row is now in the rendered window.
    expect(rowWindow(viewport, model.rows.length).last).toBe(model.rows.length);
  });

  it("scrolls frames horizontally or with Shift, in whole frames", () => {
    const model = timelineModel(scene(4, 25));
    let viewport = viewportForBounds(initial, { width: 1110, height: 220 }, model.durationFrames, model.rows.length);
    viewport = scrollViewportByWheel(viewport, wheel(60, { shiftKey: true }), model.durationFrames, model.rows.length);
    expect(viewport.startFrame).toBe(10);
    expect(viewport.scrollTop).toBe(0);
    viewport = scrollViewportByWheel(viewport, wheel(0, { deltaX: 2 }), model.durationFrames, model.rows.length);
    // A 2px trackpad nudge still moves a frame rather than rounding to none.
    expect(viewport.startFrame).toBe(11);
    viewport = scrollViewportByWheel(viewport, wheel(0, { deltaX: -1e9 }), model.durationFrames, model.rows.length);
    expect(viewport.startFrame).toBe(0);
    viewport = scrollViewportByWheel(viewport, wheel(0, { deltaX: 1e9 }), model.durationFrames, model.rows.length);
    expect(Number.isInteger(viewport.startFrame)).toBe(true);
    expect(viewport.startFrame).toBeLessThanOrEqual(model.durationFrames);
  });

  it("node count stays flat from 100 to 100,000 keys at any scroll position", () => {
    const small = timelineModel(scene(200, 1));
    const large = timelineModel(scene(200, 500));
    expect(small.keyCount).toBe(200);
    expect(large.keyCount).toBe(100_000);
    // Per scroll position, the two documents render the same DOM. (Positions
    // differ by an overscan row at the ends, which is viewport, not keys.)
    const counts: number[][] = [];
    for (const model of [small, large]) {
      const perPosition: number[] = [];
      counts.push(perPosition);
      let viewport = viewportForBounds(initial, { width: 1110, height: 220 }, model.durationFrames, model.rows.length);
      for (const deltaY of [0, 500, 3_000, 1e9]) {
        viewport = scrollViewportByWheel(viewport, wheel(deltaY), model.durationFrames, model.rows.length);
        viewport = scrollViewportByWheel(viewport, wheel(0, { deltaX: 900 }), model.durationFrames, model.rows.length);
        const parts = renderTimelinePanel(fakeDocument, model, viewport);
        perPosition.push(countNodes(parts.root as unknown as FakeElement));
      }
    }
    expect(counts[0]).toEqual(counts[1]);
    expect(Math.max(...counts[0]!)).toBeLessThan(40);
  });
});
