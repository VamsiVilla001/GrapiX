// Structured viewport interaction layer (11.7).
//
// The failures guarded here are architectural: overlay geometry drifting from
// the scene, zIndex becoming fake depth, a backward drag producing a negative
// marquee, and replacing the preview raster requiring interaction code changes.

import { describe, expect, it } from "vitest";

import type { SceneDocument, SceneObject } from "@grapix/contracts";
import {
  boundsFromDrag,
  buildViewportOverlay,
  hitTestOverlay,
  objectOverlayBounds,
  objectsInMarquee,
  renderViewportOverlay,
  scenePointFromClient,
} from "../src/overlay";

function rect(id: string, overrides: Partial<SceneObject> = {}): SceneObject {
  return {
    type: "rect",
    id,
    name: id,
    visible: true,
    locked: false,
    opacity: 1,
    x: 100,
    y: 100,
    zDepth: 0,
    zIndex: 0,
    layerId: "",
    width: 80,
    height: 40,
    rotation: 0,
    rotationX: 0,
    rotationY: 0,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
    strokeWidth: 0,
    radius: 0,
    ...overrides,
  } as SceneObject;
}

function scene(objects: SceneObject[]): SceneDocument {
  return {
    id: "overlay",
    name: "Overlay",
    version: 1,
    canvas: { width: 1920, height: 1080, frameRate: { num: 50, den: 1 } },
    timeline: { durationFrames: 1 },
    dataContext: {},
    assets: [],
    fonts: [],
    materials: [],
    objects,
  } as unknown as SceneDocument;
}

describe("selection outlines and handles", () => {
  it("derives bounds from authored transform", () => {
    const bounds = objectOverlayBounds(rect("rotated", { width: 100, height: 40, rotation: 90 }));
    expect(bounds.width).toBeCloseTo(40, 10);
    expect(bounds.height).toBeCloseTo(100, 10);
    expect(bounds.x).toBeCloseTo(60, 10);
    expect(bounds.y).toBeCloseTo(100, 10);
  });

  it("includes authored anchors and mirrored scales in selection and hit bounds", () => {
    const object = rect("anchored", { anchor: { x: 20, y: 10 }, scaleX: -2 });
    expect(objectOverlayBounds(object)).toEqual({ x: -20, y: 90, width: 160, height: 40 });
    expect(hitTestOverlay(scene([object]), { x: -10, y: 100 })).toBe("anchored");
    expect(hitTestOverlay(scene([object]), { x: 150, y: 100 })).toBeUndefined();
  });

  it("draws the path the Pen is drawing, and nothing before it has a point", () => {
    const document = scene([rect("a")]);
    const sketch = { d: "M 0 0 C 0 0 10 10 10 10", vertices: [{ x: 0, y: 0, first: true }], handles: [], closing: false };
    expect(buildViewportOverlay(document, { selectedIds: [], pen: sketch }).primitives).toContainEqual({ kind: "pen", sketch });
    expect(buildViewportOverlay(document, { selectedIds: [], pen: { ...sketch, vertices: [] } }).primitives.some((p) => p.kind === "pen")).toBe(false);
    expect(buildViewportOverlay(document, { selectedIds: [] }).primitives.some((p) => p.kind === "pen")).toBe(false);
  });

  it("picks a straight line, which has no height, within a few pixels", () => {
    const zero = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
    const line = {
      ...rect("line"),
      type: "shape",
      x: 0,
      y: 0,
      width: 300,
      height: 0,
      path: { closed: false, vertices: [{ x: 100, y: 500 }, { x: 400, y: 500 }], inTangents: zero, outTangents: zero },
    } as unknown as SceneObject;
    const document = scene([line]);
    expect(hitTestOverlay(document, { x: 250, y: 500 })).toBe("line");
    expect(hitTestOverlay(document, { x: 250, y: 503 })).toBe("line");
    expect(hitTestOverlay(document, { x: 250, y: 520 })).toBeUndefined();
    expect(hitTestOverlay(document, { x: 50, y: 500 })).toBeUndefined();
    // And a vertical one, which has no width.
    const zero2 = [{ x: 0, y: 0 }, { x: 0, y: 0 }];
    const upright = {
      ...rect("upright"),
      type: "shape",
      x: 0,
      y: 0,
      width: 0,
      height: 300,
      path: { closed: false, vertices: [{ x: 700, y: 100 }, { x: 700, y: 400 }], inTangents: zero2, outTangents: zero2 },
    } as unknown as SceneObject;
    expect(hitTestOverlay(scene([upright]), { x: 703, y: 250 })).toBe("upright");
    expect(hitTestOverlay(scene([upright]), { x: 720, y: 250 })).toBeUndefined();
  });

  it("marks where each selected object's pivot is, only when asked (the Pivot tool, 11.102)", () => {
    const document = scene([rect("a", { x: 300, y: 200 }), rect("b", { x: 10, y: 20 })]);
    const without = buildViewportOverlay(document, { selectedIds: ["a"] });
    expect(without.primitives.some((p) => p.kind === "pivot")).toBe(false);
    const withPivots = buildViewportOverlay(document, { selectedIds: ["a"], pivots: true });
    expect(withPivots.primitives.filter((p) => p.kind === "pivot")).toEqual([{ kind: "pivot", objectId: "a", point: { x: 300, y: 200 } }]);
    // A group draws nothing of its own, so it has no pivot to mark.
    const group = { ...rect("g"), type: "group", childIds: [] } as unknown as SceneObject;
    expect(buildViewportOverlay(scene([group]), { selectedIds: ["g"], pivots: true }).primitives.some((p) => p.kind === "pivot")).toBe(false);
  });

  it("emits one outline and eight handles for an editable selection", () => {
    const model = buildViewportOverlay(scene([rect("title")]), { selectedIds: ["title"] });
    expect(model.primitives.filter((primitive) => primitive.kind === "selection")).toHaveLength(1);
    expect(model.primitives.filter((primitive) => primitive.kind === "handle")).toHaveLength(8);
  });

  it("shows a locked selection but offers no transform handles", () => {
    const model = buildViewportOverlay(scene([rect("locked", { locked: true })]), {
      selectedIds: ["locked"],
    });
    expect(model.primitives).toMatchObject([{ kind: "selection", objectId: "locked", locked: true }]);
    expect(model.primitives.some((primitive) => primitive.kind === "handle")).toBe(false);
  });
});

describe("marquee and hit testing", () => {
  it("normalises a drag in any direction", () => {
    expect(boundsFromDrag({ x: 200, y: 150 }, { x: 50, y: 75 })).toEqual({
      x: 50,
      y: 75,
      width: 150,
      height: 75,
    });
  });

  it("selects visible intersecting objects and excludes hidden ones", () => {
    const document = scene([
      rect("inside", { x: 100, y: 100 }),
      rect("hidden", { x: 120, y: 100, visible: false }),
      rect("outside", { x: 500, y: 500 }),
    ]);
    expect(objectsInMarquee(document, { x: 50, y: 50, width: 150, height: 100 })).toEqual(["inside"]);
  });

  it("hits real depth first, then zIndex and document order", () => {
    const document = scene([
      rect("front", { zDepth: 20, zIndex: -100 }),
      rect("back-high-index", { zDepth: -20, zIndex: 100_000 }),
    ]);
    expect(hitTestOverlay(document, { x: 100, y: 100 })).toBe("front");
  });

  it("maps scaled CSS coordinates back to scene coordinates", () => {
    expect(
      scenePointFromClient(
        { left: 10, top: 20, width: 960, height: 540 },
        { width: 1920, height: 1080 },
        { x: 490, y: 290 },
      ),
    ).toEqual({ x: 960, y: 540 });
  });
});

class FakeSvgElement {
  readonly attributes = new Map<string, string>();
  readonly children: FakeSvgElement[] = [];

  constructor(readonly tag: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  append(...children: FakeSvgElement[]): void {
    this.children.push(...children);
  }

  replaceChildren(...children: FakeSvgElement[]): void {
    this.children.length = 0;
    this.children.push(...children);
  }
}

describe("SVG projection stays separate from the raster", () => {
  it("renders selection, handles, guides and marquee from one model", () => {
    const document = scene([rect("title")]);
    const model = buildViewportOverlay(document, {
      selectedIds: ["title"],
      guides: [{ axis: "x", position: 960, label: "Canvas centre" }],
      marquee: { x: 300, y: 200, width: 100, height: 50 },
    });
    const root = new FakeSvgElement("svg");
    const fakeDocument = {
      createElementNS: (_namespace: string, tag: string) => new FakeSvgElement(tag),
    };

    renderViewportOverlay(
      fakeDocument as unknown as Document,
      root as unknown as SVGSVGElement,
      model,
    );

    expect(root.attributes.get("viewBox")).toBe("0 0 1920 1080");
    expect(root.children.map((child) => child.attributes.get("class"))).toEqual([
      "overlay-hit-surface",
      "overlay-selection",
      ...Array(8).fill("overlay-handle"),
      "overlay-guide",
      "overlay-marquee",
    ]);
  });
});
