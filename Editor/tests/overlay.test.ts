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
    expect(bounds.x + bounds.width / 2).toBeCloseTo(100, 10);
    expect(bounds.y + bounds.height / 2).toBeCloseTo(100, 10);
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
