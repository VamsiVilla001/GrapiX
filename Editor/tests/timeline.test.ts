// Timeline rendering architecture (11.10).
//
// The done-when is a cost property — "node count flat from 100 to 100,000
// keys" — so the tests measure cost, not appearance. Three failures they exist
// to catch:
//
//   - a key becoming a DOM node, which makes the document size the DOM size;
//   - a row becoming a DOM node whether or not it is visible, which makes
//     track count the DOM size;
//   - a scrub dirtying the static layer, which turns dragging the playhead
//     into a full re-rasterise of every tick and gridline.

import { describe, expect, it } from "vitest";

import type { SceneDocument, SceneObject } from "@grapix/contracts";
import {
  buildKeyIndex,
  countInSpan,
  keyNear,
  lowerBound,
  upperBound,
  visibleRange,
} from "../src/timeline/key-index";
import { timelineModel } from "../src/timeline/model";
import {
  planRepaint,
  rowSpanDirtyRect,
  unionDirty,
  type TimelineSnapshot,
} from "../src/timeline/repaint-plan";
import { renderTimelinePanel, visibleKeyCount } from "../src/timeline/panel";
import { timelineLayers } from "../src/timeline/layers";
import {
  clampViewport,
  frameToSeconds,
  rowWindow,
  visibleFrames,
  xToFrame,
  type TimelineViewport,
} from "../src/timeline/viewport";

// --- a fake DOM, following the convention in overlay.test.ts ---------------

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

// --- fixtures ---------------------------------------------------------------

function rect(id: string): SceneObject {
  return { type: "rect", id, name: id, radius: 0, x: 0, y: 0 } as unknown as SceneObject;
}

/// A document with `tracks` channels of `perTrack` keys each, spread evenly
/// across the timeline.
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
    workingColorSpace: "srgb",
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

const viewport: TimelineViewport = {
  startFrame: 0,
  pixelsPerFrame: 6,
  width: 900,
  height: 220,
  scrollTop: 0,
  rowHeight: 22,
};

describe("node count is flat in key count (11.10 done-when)", () => {
  it("renders the same DOM for 100 keys and for 100,000", () => {
    // Same tracks, same viewport; only the number of keys differs, by three
    // orders of magnitude.
    const small = renderTimelinePanel(fakeDocument, timelineModel(scene(4, 25)), viewport);
    const large = renderTimelinePanel(fakeDocument, timelineModel(scene(4, 25_000)), viewport);

    expect(timelineModel(scene(4, 25)).keyCount).toBe(100);
    expect(timelineModel(scene(4, 25_000)).keyCount).toBe(100_000);
    expect(countNodes(small.root as unknown as FakeElement)).toBe(
      countNodes(large.root as unknown as FakeElement),
    );
  });

  it("draws only the keys inside the visible frame span", () => {
    // The other half of the cost property: the DOM is flat, and so is the
    // paint. 100,000 keys over 100,000 frames at 6px/frame means a 900px
    // viewport can only show ~150 frames' worth.
    const model = timelineModel(scene(4, 25_000));
    const drawn = visibleKeyCount(model, viewport);
    expect(model.keyCount).toBe(100_000);
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(1_000);
  });

  it("renders only the rows in the window, not every track", () => {
    // 500 tracks, a 220px viewport at 22px rows: ~10 visible plus overscan.
    const many = renderTimelinePanel(fakeDocument, timelineModel(scene(500, 4)), viewport);
    const few = renderTimelinePanel(fakeDocument, timelineModel(scene(12, 4)), viewport);
    const rows = (parts: typeof many): number =>
      (parts.headers as unknown as FakeElement).children.filter(
        (child) =>
          child.className === "timeline-row-header" ||
          child.className === "timeline-group-header",
      ).length;

    expect(rows(many)).toBe(rows(few));
    expect(rows(many)).toBeLessThan(20);
    // The full count is still announced, so assistive technology is not told
    // there are a dozen rows when there are a thousand. 500 objects with one
    // track each is 500 group rows plus 500 track rows.
    expect((many.headers as unknown as FakeElement).attributes.get("aria-setsize")).toBe("1000");
  });
});

describe("the layer fold control", () => {
  // The object manager builds the layer rows, so objects need their full base.
  const full = (doc: SceneDocument): SceneDocument => ({
    ...doc,
    objects: doc.objects.map((object) => ({
      ...object, visible: true, locked: false, opacity: 1, zDepth: 0, zIndex: 0, layerId: "", width: 100, height: 50,
      rotation: 0, rotationX: 0, rotationY: 0, scaleX: 1, scaleY: 1, scaleZ: 1,
    })) as unknown as SceneDocument["objects"],
  });
  const layerRows = (source: SceneDocument, collapsed: readonly string[] = []): FakeElement[] => {
    const doc = full(source);
    const parts = renderTimelinePanel(fakeDocument, timelineModel(doc, { collapsedIds: collapsed }), viewport, timelineLayers(doc));
    return (parts.headers as unknown as FakeElement).children.filter((child) => child.className === "timeline-group-header");
  };
  const caretOf = (row: FakeElement): FakeElement => row.children.find((child) => child.className === "timeline-caret")!;

  it("is a button of its own, so one click does what the arrow says", () => {
    const [row] = layerRows(scene(2, 3));
    const caret = caretOf(row!);
    expect(caret.dataset.timelineToggle).toBe("o0");
    expect(caret.attributes.get("aria-expanded")).toBe("true");
    expect(caret.attributes.get("aria-label")).toBe("Collapse o0 tracks");
    expect(caret.textContent).toBe("▾");
    // The name no longer carries the arrow as text.
    const name = row!.children.find((child) => child.className === "timeline-layer-name")!;
    expect(name.textContent).toBe("o0");
  });

  it("says expanded or collapsed in its label and glyph", () => {
    const [collapsed] = layerRows(scene(2, 3), ["o0"]);
    expect(caretOf(collapsed!).attributes.get("aria-expanded")).toBe("false");
    expect(caretOf(collapsed!).attributes.get("aria-label")).toBe("Expand o0 tracks");
    expect(caretOf(collapsed!).textContent).toBe("▸");

  });
});

describe("repaint planning", () => {
  const base: TimelineSnapshot = {
    startFrame: 0,
    pixelsPerFrame: 6,
    width: 900,
    height: 220,
    scrollTop: 0,
    devicePixelRatio: 1,
    rowWindowFirst: 0,
    rowWindowLast: 10,
    contentRevision: 1,
    selectionRevision: 1,
    phaseRevision: 1,
    currentFrame: 0,
    marqueeRevision: 0,
    dragRevision: 0,
  };

  it("a scrub dirties interaction alone, never static", () => {
    // 11.11's done-when, provable here because the plan is a pure function.
    const dirty = planRepaint(base, { ...base, currentFrame: 42 });
    expect([...dirty]).toEqual(["interaction"]);
    expect(dirty.has("static")).toBe(false);
    expect(dirty.has("content")).toBe(false);
  });

  it("a phase edit dirties static, and a scrub still does not", () => {
    // Phases are painted with the ruler, so editing one must reach `static` —
    // and the 11.11 gate above must survive that new dependency.
    const phased = planRepaint(base, { ...base, phaseRevision: 2 });
    expect(phased.has("static")).toBe(true);
    expect(planRepaint(base, { ...base, currentFrame: 99 }).has("static")).toBe(false);
  });

  it("a key edit dirties content, and a selection change does too", () => {
    expect([...planRepaint(base, { ...base, contentRevision: 2 })]).toEqual(["content"]);
    expect([...planRepaint(base, { ...base, selectionRevision: 2 })]).toEqual(["content"]);
  });

  it("geometry cascades to every layer, and the first paint does too", () => {
    expect(planRepaint(base, { ...base, startFrame: 10 }).size).toBe(3);
    expect(planRepaint(base, { ...base, rowWindowLast: 11 }).size).toBe(3);
    expect(planRepaint(null, base).size).toBe(3);
  });

  it("an unchanged snapshot dirties nothing", () => {
    expect(planRepaint(base, { ...base }).size).toBe(0);
  });

  it("a dirty rect covers the drawn marker, and unions accumulate", () => {
    const rect_ = rowSpanDirtyRect(100, 160, 22, 44, 4);
    // Padded past the frames that moved, or a drag leaves a sliver behind.
    expect(rect_.x).toBeLessThan(100);
    expect(rect_.x + rect_.width).toBeGreaterThan(160);
    expect(rect_.y).toBe(22);
    expect(rect_.height).toBe(22);

    const union = unionDirty(rect_, rowSpanDirtyRect(400, 420, 44, 66, 4));
    expect(union!.x).toBe(rect_.x);
    expect(union!.y).toBe(22);
    expect(union!.height).toBe(44);
    expect(unionDirty(null, rect_)).toBe(rect_);
  });
});

describe("key index", () => {
  it("finds a visible run by binary search", () => {
    const index = buildKeyIndex(
      [0, 10, 20, 30, 40].map((frame) => ({
        frame: frame as unknown as bigint,
        value: 0,
        easing: "linear" as const,
      })),
    );
    expect(visibleRange(index, 10, 30)).toEqual({ from: 1, to: 4 });
    expect(countInSpan(index, 10, 30)).toBe(3);
    expect(countInSpan(index, 41, 90)).toBe(0);
    expect(lowerBound(index.frames, 15)).toBe(2);
    expect(upperBound(index.frames, 20)).toBe(3);
  });

  it("sorts defensively, because a binary search over unsorted data lies", () => {
    const index = buildKeyIndex(
      [30, 0, 20].map((frame) => ({
        frame: frame as unknown as bigint,
        value: 0,
        easing: "linear" as const,
      })),
    );
    expect([...index.frames]).toEqual([0, 20, 30]);
  });

  it("hit-tests within a frame tolerance, not a pixel one", () => {
    const index = buildKeyIndex(
      [0, 50].map((frame) => ({
        frame: frame as unknown as bigint,
        value: 0,
        easing: "linear" as const,
      })),
    );
    expect(keyNear(index, 2, 3)).toBe(0);
    expect(keyNear(index, 47, 3)).toBe(50);
    expect(keyNear(index, 20, 3)).toBeUndefined();
  });
});

describe("viewport", () => {
  it("rounds a pixel to the nearest frame rather than biasing left", () => {
    expect(xToFrame(viewport, 0)).toBe(0);
    expect(xToFrame(viewport, 6)).toBe(1);
    // Halfway between frames 1 and 2 rounds up, not down.
    expect(xToFrame(viewport, 9)).toBe(2);
  });

  it("windows rows by scroll position and stays bounded", () => {
    expect(rowWindow(viewport, 500)).toEqual({ first: 0, last: 12 });
    const scrolled = rowWindow({ ...viewport, scrollTop: 220 }, 500);
    expect(scrolled.first).toBe(9);
    expect(scrolled.last - scrolled.first).toBeLessThan(20);
    expect(rowWindow(viewport, 0)).toEqual({ first: 0, last: 0 });
  });

  it("clamps scrolling to the content and derives seconds from the rational rate", () => {
    const clamped = clampViewport(
      { ...viewport, startFrame: 99_999, scrollTop: 10_000 },
      1_000,
      4,
    );
    expect(clamped.startFrame).toBeLessThanOrEqual(1_000);
    expect(clamped.scrollTop).toBe(0); // 4 rows of 22px do not fill 220px
    // 29.97 is 30000/1001, not 29.97: a decimal would drift.
    expect(frameToSeconds({ num: 30_000, den: 1_001 }, 30_000)).toBeCloseTo(1_001, 9);
    expect(visibleFrames(viewport, 100).last).toBe(100);
  });
});
