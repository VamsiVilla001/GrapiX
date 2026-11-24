//! Viewport interaction overlays (build plan 11.7).
//!
//! The raster and the interaction layer are deliberately separate. The render
//! engine can replace Three's canvas later without changing selection, guides,
//! handles or marquee behavior: this module consumes only the Rust-owned scene
//! contract and emits SVG primitives in scene coordinates.

import type { SceneDocument, SceneObject } from "@grapix/contracts";
import type { PathEditSketch } from "./path-edit";
import type { PenSketch } from "./pen-tool";

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
  /** An explicit guide the author put on the canvas (11.44), always drawn, as opposed to a snap line shown while a point is held. */
  readonly fixed?: boolean;
}

/** One mask of the selected layer as the viewport draws it (11.117): its boundary, and the band its feather softens. */
export interface MaskSketch {
  /** The SVG path data of the boundary, in canvas coordinates. */
  readonly d: string;
  /** The feather across the edge in canvas pixels, 0 for a hard edge. */
  readonly feather: number;
  /** An open path is drawn dashed: it does not clip until it is closed. */
  readonly open: boolean;
  readonly mode: string;
  readonly index: number;
  /** The mask the path tools are editing. */
  readonly active: boolean;
  /** The feather points of a variable feather (11.108): where each is on the canvas and how far its feather reaches (negative: inward). */
  readonly featherPoints?: readonly { readonly x: number; readonly y: number; readonly radius: number }[];
}

export interface OverlayState {
  readonly selectedIds: readonly string[];
  /** The masks of the selected layer: boundaries and feather bands (11.117). */
  readonly masks?: readonly MaskSketch[];
  /** Mark where each selected object's pivot is (the Pivot tool is in use). */
  readonly pivots?: boolean;
  /** The path the Pen tool is drawing (11.104). */
  readonly pen?: PenSketch;
  /** The path of the selected shape as the Edit path tools show it (11.107): its vertices, and the handles of the selected ones. */
  readonly pathEdit?: PathEditSketch;
  /** Canvas pixels to a screen pixel (1 when the picture is shown at its own size; 0.25 when zoomed in four times), so
   *  handles and markers keep one size on the screen at any zoom (11.105). */
  readonly unit?: number;
  readonly marquee?: OverlayBounds;
  readonly guides?: readonly OverlayGuide[];
  /** Whether the scene's explicit guides are drawn (the Show switch); on when absent. */
  readonly showGuides?: boolean;
}

export type OverlayPrimitive =
  | { readonly kind: "selection"; readonly objectId: string; readonly bounds: OverlayBounds; readonly locked: boolean }
  | {
      readonly kind: "handle";
      readonly objectId: string;
      readonly position: HandlePosition;
      readonly point: OverlayPoint;
    }
  | { readonly kind: "pivot"; readonly objectId: string; readonly point: OverlayPoint }
  | { readonly kind: "pen"; readonly sketch: PenSketch }
  | { readonly kind: "pathEdit"; readonly sketch: PathEditSketch }
  | { readonly kind: "masks"; readonly sketches: readonly MaskSketch[] }
  | { readonly kind: "guide"; readonly guide: OverlayGuide }
  | { readonly kind: "marquee"; readonly bounds: OverlayBounds };

export interface ViewportOverlayModel {
  readonly width: number;
  readonly height: number;
  /** Canvas pixels to a screen pixel; handles and markers are drawn this much larger or smaller. */
  readonly unit: number;
  readonly primitives: readonly OverlayPrimitive[];
}

/** Kinds that draw nothing of their own and so have no pivot to mark. */
const NO_BOX_KINDS = new Set(["layer", "group", "light", "camera", "marker"]);

const HANDLE_POSITIONS: readonly HandlePosition[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** The box an object occupies in its own space, before position, rotation and scale: a box type's width and height from
 *  its top left, a shape's path bounds (a path is placed by its own coordinates). Nothing for a kind with no box. */
export function localBox(object: SceneObject): { left: number; top: number; width: number; height: number } | undefined {
  switch (object.type) {
    case "rect":
    case "ellipse":
    case "image":
    case "text":
      return object.width > 0 && object.height > 0 ? { left: 0, top: 0, width: object.width, height: object.height } : undefined;
    case "shape": {
      const paths = [object.path, ...(object.compoundPaths ?? [])];
      const points = paths.flatMap((path) => path.vertices);
      if (points.length === 0) return undefined;
      const left = Math.min(...points.map((p) => p.x));
      const top = Math.min(...points.map((p) => p.y));
      return {
        left,
        top,
        width: Math.max(...points.map((p) => p.x)) - left,
        height: Math.max(...points.map((p) => p.y)) - top,
      };
    }
    default:
      return undefined;
  }
}

/** Axis-aligned screen bounds of an authored object after XY scale/rotation. */
export function objectOverlayBounds(object: SceneObject): OverlayBounds {
  const radians = (object.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  // Planar content uses the engine's top-left origin and authored anchor;
  // mesh geometry remains centred on its 3D origin.
  const anchorX = object.type === "mesh" ? object.width / 2 : (object.anchor?.x ?? 0);
  const anchorY = object.type === "mesh" ? object.height / 2 : (object.anchor?.y ?? 0);
  const box = localBox(object) ?? { left: 0, top: 0, width: object.width, height: object.height };
  const corners = [
    [box.left, box.top], [box.left + box.width, box.top], [box.left, box.top + box.height], [box.left + box.width, box.top + box.height],
  ].map(([x = 0, y = 0]) => {
    const scaledX = (x - anchorX) * object.scaleX;
    const scaledY = (y - anchorY) * object.scaleY;
    return {
      x: object.x + scaledX * cos - scaledY * sin,
      y: object.y + scaledX * sin + scaledY * cos,
    };
  });
  const left = Math.min(...corners.map((point) => point.x));
  const top = Math.min(...corners.map((point) => point.y));
  return {
    x: left,
    y: top,
    width: Math.max(...corners.map((point) => point.x)) - left,
    height: Math.max(...corners.map((point) => point.y)) - top,
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
    // Where the object turns and grows about: its position, which is where its pivot is set down.
    if (state.pivots === true && !NO_BOX_KINDS.has(object.type)) {
      primitives.push({ kind: "pivot", objectId, point: { x: object.x, y: object.y } });
    }
    // While a path is edited its own points are the thing to grab: the box handles would sit in the way.
    if (!object.locked && state.pathEdit === undefined) {
      for (const position of HANDLE_POSITIONS) {
        primitives.push({ kind: "handle", objectId, position, point: handlePoint(bounds, position) });
      }
    }
  }

  if (state.showGuides !== false) {
    for (const guide of document.guides ?? []) {
      primitives.push({ kind: "guide", guide: { axis: guide.axis, position: guide.position, label: `Guide ${guide.id}`, fixed: true } });
    }
  }
  for (const guide of state.guides ?? []) {
    primitives.push({ kind: "guide", guide });
  }
  if (state.masks !== undefined && state.masks.length > 0) primitives.push({ kind: "masks", sketches: state.masks });
  if (state.pen !== undefined && state.pen.vertices.length > 0) primitives.push({ kind: "pen", sketch: state.pen });
  if (state.pathEdit !== undefined && state.pathEdit.vertices.length > 0) primitives.push({ kind: "pathEdit", sketch: state.pathEdit });
  if (state.marquee !== undefined) {
    primitives.push({ kind: "marquee", bounds: normalizeBounds(state.marquee) });
  }

  const unit = state.unit !== undefined && Number.isFinite(state.unit) && state.unit > 0 ? state.unit : 1;
  return { width: document.canvas.width, height: document.canvas.height, unit, primitives };
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

/** The least width and height, in canvas pixels, an object is picked over. */
export const MIN_PICK = 10;

/** Topmost visible drawable object at a scene-coordinate point. */
export function hitTestOverlay(document: SceneDocument, point: OverlayPoint): string | undefined {
  return document.objects
    .map((object, index) => ({ object, index }))
    .filter(({ object }) => {
      if (!canSelect(object)) return false;
      const bounds = objectOverlayBounds(object);
      // A straight line has no width or no height; it is picked within a few pixels, like any thin thing.
      const padX = Math.max(0, (MIN_PICK - bounds.width) / 2);
      const padY = Math.max(0, (MIN_PICK - bounds.height) / 2);
      return (
        point.x >= bounds.x - padX &&
        point.x <= bounds.x + bounds.width + padX &&
        point.y >= bounds.y - padY &&
        point.y <= bounds.y + bounds.height + padY
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
            x: String(primitive.point.x - 5 * model.unit),
            y: String(primitive.point.y - 5 * model.unit),
            width: String(10 * model.unit),
            height: String(10 * model.unit),
            "data-object-id": primitive.objectId,
            "data-handle": primitive.position,
          }),
        );
        break;
      case "pen": {
        const { sketch } = primitive;
        const group = svgElement(document, "g", { class: "overlay-pen-group" });
        if (sketch.rubber !== undefined) group.append(svgElement(document, "path", { class: "overlay-pen-rubber", d: sketch.rubber }));
        if (sketch.d !== "") group.append(svgElement(document, "path", { class: "overlay-pen", d: sketch.d }));
        for (const h of sketch.handles) {
          group.append(
            svgElement(document, "line", { class: "overlay-pen-handle", x1: String(h.x1), y1: String(h.y1), x2: String(h.x2), y2: String(h.y2) }),
            svgElement(document, "circle", { class: "overlay-pen-handle-end", cx: String(h.x2), cy: String(h.y2), r: String(4 * model.unit) }),
          );
        }
        for (const v of sketch.vertices) {
          const size = (v.first ? 14 : 10) * model.unit;
          group.append(
            svgElement(document, "rect", {
              class: `overlay-pen-vertex${v.first ? " is-first" : ""}${v.first && sketch.closing ? " is-closing" : ""}`,
              x: String(v.x - size / 2),
              y: String(v.y - size / 2),
              width: String(size),
              height: String(size),
            }),
          );
        }
        svg.append(group);
        break;
      }
      case "masks": {
        const group = svgElement(document, "g", { class: "overlay-masks" });
        for (const mask of primitive.sketches) {
          if (mask.d === "") continue;
          // The feather first, under the boundary: a band as wide as the feather, centred on the edge.
          if (mask.feather > 0 && !mask.open) {
            group.append(svgElement(document, "path", { class: "overlay-mask-feather", d: mask.d, "stroke-width": String(mask.feather), "data-mask-index": String(mask.index) }));
          }
          group.append(
            svgElement(document, "path", {
              class: `overlay-mask mode-${mask.mode}${mask.open ? " is-open" : ""}${mask.active ? " is-active" : ""}`,
              d: mask.d,
              "data-mask-index": String(mask.index),
            }),
          );
          for (const point of mask.featherPoints ?? []) {
            group.append(
              svgElement(document, "circle", { class: `overlay-feather-reach${point.radius < 0 ? " is-inward" : ""}`, cx: String(point.x), cy: String(point.y), r: String(Math.abs(point.radius)) }),
              svgElement(document, "circle", { class: "overlay-feather-point", cx: String(point.x), cy: String(point.y), r: String(4 * model.unit), "data-mask-index": String(mask.index) }),
            );
          }
        }
        svg.append(group);
        break;
      }
      case "pathEdit": {
        const { sketch } = primitive;
        const group = svgElement(document, "g", { class: "overlay-path-group" });
        if (sketch.d !== "") group.append(svgElement(document, "path", { class: "overlay-path", d: sketch.d }));
        for (const h of sketch.handles) {
          group.append(
            svgElement(document, "line", { class: "overlay-path-handle", x1: String(h.x1), y1: String(h.y1), x2: String(h.x2), y2: String(h.y2) }),
            svgElement(document, "circle", { class: "overlay-path-handle-end", cx: String(h.x2), cy: String(h.y2), r: String(4 * model.unit) }),
          );
        }
        for (const v of sketch.vertices) {
          const size = 9 * model.unit;
          group.append(
            svgElement(document, "rect", {
              class: `overlay-path-vertex${v.selected ? " is-selected" : ""}`,
              x: String(v.x - size / 2),
              y: String(v.y - size / 2),
              width: String(size),
              height: String(size),
            }),
          );
        }
        svg.append(group);
        break;
      }
      case "pivot": {
        const { x, y } = primitive.point;
        const group = svgElement(document, "g", { class: "overlay-pivot", "data-object-id": primitive.objectId });
        group.append(
          svgElement(document, "circle", { cx: String(x), cy: String(y), r: String(9 * model.unit) }),
          svgElement(document, "line", { x1: String(x - 16 * model.unit), y1: String(y), x2: String(x + 16 * model.unit), y2: String(y) }),
          svgElement(document, "line", { x1: String(x), y1: String(y - 16 * model.unit), x2: String(x), y2: String(y + 16 * model.unit) }),
        );
        svg.append(group);
        break;
      }
      case "guide": {
        const vertical = primitive.guide.axis === "x";
        svg.append(
          svgElement(document, "line", {
            class: primitive.guide.fixed === true ? "overlay-guide overlay-guide-fixed" : "overlay-guide",
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
