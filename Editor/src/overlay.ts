//! Viewport interaction overlays (build plan 11.7).
//!
//! The raster and the interaction layer are deliberately separate. The render
//! engine can replace Three's canvas later without changing selection, guides,
//! handles or marquee behavior: this module consumes only the Rust-owned scene
//! contract and emits SVG primitives in scene coordinates.

import type { SceneDocument, SceneObject } from "@grapix/contracts";

export interface OverlayPoint {
  readonly x: number;
  readonly y: number;
}

export interface OverlayBounds extends OverlayPoint {
  readonly width: number;
  readonly height: number;
}

export type HandlePosition = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

export interface OverlayGuide {
  readonly axis: "x" | "y";
  readonly position: number;
  readonly label?: string;
}

export interface OverlayState {
  readonly selectedIds: readonly string[];
  readonly marquee?: OverlayBounds;
  readonly guides?: readonly OverlayGuide[];
}

export type OverlayPrimitive =
  | { readonly kind: "selection"; readonly objectId: string; readonly bounds: OverlayBounds; readonly locked: boolean }
  | {
      readonly kind: "handle";
      readonly objectId: string;
      readonly position: HandlePosition;
      readonly point: OverlayPoint;
    }
  | { readonly kind: "guide"; readonly guide: OverlayGuide }
  | { readonly kind: "marquee"; readonly bounds: OverlayBounds };

export interface ViewportOverlayModel {
  readonly width: number;
  readonly height: number;
  readonly primitives: readonly OverlayPrimitive[];
}

const HANDLE_POSITIONS: readonly HandlePosition[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Axis-aligned screen bounds of an authored object after XY scale/rotation. */
export function objectOverlayBounds(object: SceneObject): OverlayBounds {
  const width = Math.abs(object.width * object.scaleX);
  const height = Math.abs(object.height * object.scaleY);
  const radians = (object.rotation * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const projectedWidth = width * cos + height * sin;
  const projectedHeight = width * sin + height * cos;
  return {
    x: object.x - projectedWidth / 2,
    y: object.y - projectedHeight / 2,
    width: projectedWidth,
    height: projectedHeight,
  };
}

function handlePoint(bounds: OverlayBounds, position: HandlePosition): OverlayPoint {
  const left = bounds.x;
  const centreX = bounds.x + bounds.width / 2;
  const right = bounds.x + bounds.width;
  const top = bounds.y;
  const centreY = bounds.y + bounds.height / 2;
  const bottom = bounds.y + bounds.height;
  const x = position.includes("w") ? left : position.includes("e") ? right : centreX;
  const y = position.includes("n") ? top : position.includes("s") ? bottom : centreY;
  return { x, y };
}

/** Build the complete interaction layer from document + ephemeral UI state. */
export function buildViewportOverlay(
  document: SceneDocument,
  state: OverlayState,
): ViewportOverlayModel {
  const byId = new Map(document.objects.map((object) => [object.id, object]));
  const primitives: OverlayPrimitive[] = [];

  for (const objectId of state.selectedIds) {
    const object = byId.get(objectId);
    if (!object) continue;
    const bounds = objectOverlayBounds(object);
    primitives.push({ kind: "selection", objectId, bounds, locked: object.locked });
    if (!object.locked) {
      for (const position of HANDLE_POSITIONS) {
        primitives.push({ kind: "handle", objectId, position, point: handlePoint(bounds, position) });
      }
    }
  }

  for (const guide of state.guides ?? []) {
    primitives.push({ kind: "guide", guide });
  }
  if (state.marquee !== undefined) {
    primitives.push({ kind: "marquee", bounds: normalizeBounds(state.marquee) });
  }

  return { width: document.canvas.width, height: document.canvas.height, primitives };
}

/** A drag may run in any direction; the model always stores positive extents. */
export function boundsFromDrag(start: OverlayPoint, end: OverlayPoint): OverlayBounds {
  return normalizeBounds({ x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y });
}

export function normalizeBounds(bounds: OverlayBounds): OverlayBounds {
  return {
    x: bounds.width < 0 ? bounds.x + bounds.width : bounds.x,
    y: bounds.height < 0 ? bounds.y + bounds.height : bounds.y,
    width: Math.abs(bounds.width),
    height: Math.abs(bounds.height),
  };
}

function intersects(a: OverlayBounds, b: OverlayBounds): boolean {
  return (
    a.x <= b.x + b.width &&
    a.x + a.width >= b.x &&
    a.y <= b.y + b.height &&
    a.y + a.height >= b.y
  );
}

function canSelect(object: SceneObject): boolean {
  return object.visible && !["layer", "group", "light", "camera", "marker"].includes(object.type);
}

/** Select visible drawable objects whose projected bounds intersect a marquee. */
export function objectsInMarquee(document: SceneDocument, marquee: OverlayBounds): string[] {
  const area = normalizeBounds(marquee);
  return document.objects
    .filter((object) => canSelect(object) && intersects(objectOverlayBounds(object), area))
    .map((object) => object.id);
}

/** Topmost visible drawable object at a scene-coordinate point. */
export function hitTestOverlay(document: SceneDocument, point: OverlayPoint): string | undefined {
  return document.objects
    .map((object, index) => ({ object, index }))
    .filter(({ object }) => {
      if (!canSelect(object)) return false;
      const bounds = objectOverlayBounds(object);
      return (
        point.x >= bounds.x &&
        point.x <= bounds.x + bounds.width &&
        point.y >= bounds.y &&
        point.y <= bounds.y + bounds.height
      );
    })
    .sort(
      (a, b) =>
        b.object.zDepth - a.object.zDepth ||
        b.object.zIndex - a.object.zIndex ||
        b.index - a.index,
    )[0]?.object.id;
}

/** Convert CSS client coordinates to the SVG's scene-coordinate viewBox. */
export function scenePointFromClient(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  scene: { readonly width: number; readonly height: number },
  client: OverlayPoint,
): OverlayPoint {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  return {
    x: ((client.x - rect.left) / rect.width) * scene.width,
    y: ((client.y - rect.top) / rect.height) * scene.height,
  };
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svgElement<K extends keyof SVGElementTagNameMap>(
  document: Document,
  name: K,
  attributes: Record<string, string>,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

/** Render a model into an SVG that remains independent of the raster canvas. */
export function renderViewportOverlay(
  document: Document,
  svg: SVGSVGElement,
  model: ViewportOverlayModel,
): void {
  svg.setAttribute("viewBox", `0 0 ${model.width} ${model.height}`);
  svg.setAttribute("width", String(model.width));
  svg.setAttribute("height", String(model.height));
  svg.replaceChildren(
    svgElement(document, "rect", {
      class: "overlay-hit-surface",
      x: "0",
      y: "0",
      width: String(model.width),
      height: String(model.height),
    }),
  );

  for (const primitive of model.primitives) {
    switch (primitive.kind) {
      case "selection": {
        const { x, y, width, height } = primitive.bounds;
        svg.append(
          svgElement(document, "rect", {
            class: `overlay-selection${primitive.locked ? " is-locked" : ""}`,
            x: String(x),
            y: String(y),
            width: String(width),
            height: String(height),
            "data-object-id": primitive.objectId,
          }),
        );
        break;
      }
      case "handle":
        svg.append(
          svgElement(document, "rect", {
            class: "overlay-handle",
            x: String(primitive.point.x - 5),
            y: String(primitive.point.y - 5),
            width: "10",
            height: "10",
            "data-object-id": primitive.objectId,
            "data-handle": primitive.position,
          }),
        );
        break;
      case "guide": {
        const vertical = primitive.guide.axis === "x";
        svg.append(
          svgElement(document, "line", {
            class: "overlay-guide",
            x1: String(vertical ? primitive.guide.position : 0),
            y1: String(vertical ? 0 : primitive.guide.position),
            x2: String(vertical ? primitive.guide.position : model.width),
            y2: String(vertical ? model.height : primitive.guide.position),
            ...(primitive.guide.label === undefined ? {} : { "aria-label": primitive.guide.label }),
          }),
        );
        break;
      }
      case "marquee": {
        const { x, y, width, height } = primitive.bounds;
        svg.append(
          svgElement(document, "rect", {
            class: "overlay-marquee",
            x: String(x),
            y: String(y),
            width: String(width),
            height: String(height),
          }),
        );
        break;
      }
    }
  }
}
