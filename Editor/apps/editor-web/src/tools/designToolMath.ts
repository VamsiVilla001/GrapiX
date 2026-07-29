import {
  normalizeColorValue,
  normalizeGradientStops,
  type BezierPath,
  type BrushPoint,
  type ColorValue,
  type GradientPreset,
  type SceneObject,
  type Vec2
} from "@grapix/shared-types";
import type { MarqueeOptions, MarqueeSelection } from "../store/uiStore";

const ELLIPSE_KAPPA = 0.5522847498307936;

export const BUILT_IN_GRADIENT_PRESETS: GradientPreset[] = [
  preset("gradient_black_white", "Black to white", "#000000", "#ffffff"),
  preset("gradient_white_transparent", "White to transparent", "#ffffff", "#ffffff", 1, 0),
  preset("gradient_black_transparent", "Black to transparent", "#000000", "#000000", 1, 0),
  preset("gradient_two_colour", "Two-colour gradient", "#17b9a8", "#7c5cff"),
  {
    presetId: "gradient_three_colour",
    name: "Three-colour gradient",
    builtIn: true,
    value: {
      type: "linear-gradient",
      angle: 0,
      startX: 0,
      startY: 0.5,
      endX: 1,
      endY: 0.5,
      spread: "pad",
      coordinateMode: "object",
      stops: [
        { id: "stop_0", position: 0, color: "#17b9a8", opacity: 1 },
        { id: "stop_1", position: 0.5, color: "#ffd166", opacity: 1 },
        { id: "stop_2", position: 1, color: "#7c5cff", opacity: 1 }
      ]
    }
  }
];

function preset(
  presetId: string,
  name: string,
  from: string,
  to: string,
  fromOpacity = 1,
  toOpacity = 1
): GradientPreset {
  return {
    presetId,
    name,
    builtIn: true,
    value: {
      type: "linear-gradient",
      angle: 0,
      startX: 0,
      startY: 0.5,
      endX: 1,
      endY: 0.5,
      spread: "pad",
      coordinateMode: "object",
      stops: [
        { id: "stop_0", position: 0, color: from, opacity: fromOpacity },
        { id: "stop_1", position: 1, color: to, opacity: toOpacity }
      ]
    }
  };
}

export function createRectPath(x: number, y: number, width: number, height: number): BezierPath {
  const zero = { x: 0, y: 0 };
  return {
    closed: true,
    vertices: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height }
    ],
    inTangents: [zero, zero, zero, zero],
    outTangents: [zero, zero, zero, zero]
  };
}

export function createEllipsePath(x: number, y: number, width: number, height: number): BezierPath {
  const rx = width / 2;
  const ry = height / 2;
  const cx = x + rx;
  const cy = y + ry;
  const kx = rx * ELLIPSE_KAPPA;
  const ky = ry * ELLIPSE_KAPPA;
  return {
    closed: true,
    vertices: [
      { x: cx, y },
      { x: x + width, y: cy },
      { x: cx, y: y + height },
      { x, y: cy }
    ],
    inTangents: [
      { x: -kx, y: 0 },
      { x: 0, y: -ky },
      { x: kx, y: 0 },
      { x: 0, y: ky }
    ],
    outTangents: [
      { x: kx, y: 0 },
      { x: 0, y: ky },
      { x: -kx, y: 0 },
      { x: 0, y: -ky }
    ]
  };
}

export function marqueeFromDrag(
  kind: MarqueeSelection["kind"],
  start: Vec2,
  current: Vec2,
  options: MarqueeOptions,
  modifiers: { square: boolean; fromCenter: boolean }
): MarqueeSelection {
  let deltaX = current.x - start.x;
  let deltaY = current.y - start.y;
  const constraint = modifiers.square ? "fixed-ratio" : options.constraint;
  if (constraint === "fixed-size") {
    deltaX = Math.sign(deltaX || 1) * options.fixedWidth;
    deltaY = Math.sign(deltaY || 1) * options.fixedHeight;
  } else if (constraint === "fixed-ratio") {
    const ratio = modifiers.square ? 1 : Math.max(0.0001, options.ratio);
    if (Math.abs(deltaX) / Math.max(0.0001, Math.abs(deltaY)) > ratio) {
      deltaY = Math.sign(deltaY || 1) * Math.abs(deltaX) / ratio;
    } else {
      deltaX = Math.sign(deltaX || 1) * Math.abs(deltaY) * ratio;
    }
  }
  const fromCenter = modifiers.fromCenter || options.fromCenter;
  const x1 = fromCenter ? start.x - Math.abs(deltaX) : start.x;
  const y1 = fromCenter ? start.y - Math.abs(deltaY) : start.y;
  const x2 = fromCenter ? start.x + Math.abs(deltaX) : start.x + deltaX;
  const y2 = fromCenter ? start.y + Math.abs(deltaY) : start.y + deltaY;
  return {
    kind,
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
    feather: Math.max(0, options.feather),
    operation: options.operation
  };
}

export function marqueePath(selection: MarqueeSelection): BezierPath {
  return selection.kind === "ellipse"
    ? createEllipsePath(selection.x, selection.y, selection.width, selection.height)
    : createRectPath(selection.x, selection.y, selection.width, selection.height);
}

export function objectIntersectsMarquee(
  object: SceneObject,
  selection: MarqueeSelection,
  containment: MarqueeOptions["objectContainment"]
): boolean {
  if (!object.visible || object.locked) return false;
  const corners = objectWorldCorners(object);
  const contains = (point: Vec2) => pointInMarquee(point, selection);
  if (containment === "enclosed") return corners.every(contains);
  if (corners.some(contains)) return true;
  const marqueeCorners = [
    { x: selection.x, y: selection.y },
    { x: selection.x + selection.width, y: selection.y },
    { x: selection.x + selection.width, y: selection.y + selection.height },
    { x: selection.x, y: selection.y + selection.height }
  ];
  return marqueeCorners.some((point) => pointInConvexPolygon(point, corners));
}

function pointInMarquee(point: Vec2, selection: MarqueeSelection): boolean {
  if (selection.kind === "rectangle") {
    return point.x >= selection.x && point.x <= selection.x + selection.width
      && point.y >= selection.y && point.y <= selection.y + selection.height;
  }
  const rx = Math.max(0.0001, selection.width / 2);
  const ry = Math.max(0.0001, selection.height / 2);
  const cx = selection.x + rx;
  const cy = selection.y + ry;
  const nx = (point.x - cx) / rx;
  const ny = (point.y - cy) / ry;
  return nx * nx + ny * ny <= 1;
}

function objectWorldCorners(object: SceneObject): Vec2[] {
  const anchor = object.anchor ?? { x: 0, y: 0 };
  const radians = object.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const transform = (point: Vec2) => {
    const x = (point.x - anchor.x) * (object.scaleX ?? 1);
    const y = (point.y - anchor.y) * (object.scaleY ?? 1);
    return {
      x: object.x + x * cosine - y * sine,
      y: object.y + x * sine + y * cosine
    };
  };
  return [
    transform({ x: 0, y: 0 }),
    transform({ x: object.width, y: 0 }),
    transform({ x: object.width, y: object.height }),
    transform({ x: 0, y: object.height })
  ];
}

function pointInConvexPolygon(point: Vec2, polygon: Vec2[]): boolean {
  let sign = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const a = polygon[index];
    const b = polygon[(index + 1) % polygon.length];
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (Math.abs(cross) < 0.0001) continue;
    const next = Math.sign(cross);
    if (sign && next !== sign) return false;
    sign = next;
  }
  return true;
}

export function smoothBrushPoints(
  points: BrushPoint[],
  smoothing: number,
  spacingPixels: number
): BrushPoint[] {
  if (points.length < 2) return points.slice();
  const alpha = Math.min(0.95, Math.max(0, smoothing));
  const filtered: BrushPoint[] = [{ ...points[0] }];
  for (let index = 1; index < points.length; index += 1) {
    const previous = filtered.at(-1)!;
    const input = points[index];
    filtered.push({
      x: previous.x * alpha + input.x * (1 - alpha),
      y: previous.y * alpha + input.y * (1 - alpha),
      pressure: input.pressure,
      time: input.time
    });
  }
  const spacing = Math.max(0.5, spacingPixels);
  const result: BrushPoint[] = [{ ...filtered[0] }];
  for (let index = 1; index < filtered.length; index += 1) {
    const from = result.at(-1)!;
    const to = filtered[index];
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(distance / spacing));
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      result.push({
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        pressure: (from.pressure ?? 1) + ((to.pressure ?? 1) - (from.pressure ?? 1)) * t,
        time: to.time
      });
    }
  }
  return result;
}

export function sampleColorValue(value: ColorValue | string | undefined, local: Vec2): string {
  const normalized = normalizeColorValue(value);
  if (normalized.type === "none") return "#00000000";
  if (normalized.type === "solid") return normalizeHex(normalized.color);
  const stops = normalizeGradientStops(normalized.stops);
  let position = 0;
  if (normalized.type === "linear-gradient") {
    const dx = normalized.endX - normalized.startX;
    const dy = normalized.endY - normalized.startY;
    const denominator = dx * dx + dy * dy;
    position = denominator > 0
      ? ((local.x - normalized.startX) * dx + (local.y - normalized.startY) * dy) / denominator
      : 0;
  } else {
    const rx = Math.max(0.0001, normalized.radiusX);
    const ry = Math.max(0.0001, normalized.radiusY);
    const dx = (local.x - normalized.centerX) / rx;
    const dy = (local.y - normalized.centerY) / ry;
    position = Math.hypot(dx, dy);
  }
  position = applySpread(position, normalized.spread);
  const upperIndex = Math.max(1, stops.findIndex((stop) => stop.position >= position));
  const lower = stops[upperIndex - 1] ?? stops[0];
  const upper = stops[upperIndex] ?? stops.at(-1)!;
  const range = Math.max(0.0001, upper.position - lower.position);
  return interpolateHex(lower.color, upper.color, (position - lower.position) / range, lower.opacity, upper.opacity);
}

function applySpread(value: number, spread: "pad" | "repeat" | "reflect"): number {
  if (spread === "repeat") return ((value % 1) + 1) % 1;
  if (spread === "reflect") {
    const wrapped = ((value % 2) + 2) % 2;
    return wrapped <= 1 ? wrapped : 2 - wrapped;
  }
  return Math.min(1, Math.max(0, value));
}

function interpolateHex(from: string, to: string, t: number, fromOpacity: number, toOpacity: number): string {
  const a = hexToRgba(from);
  const b = hexToRgba(to);
  const mix = (left: number, right: number) => Math.round(left + (right - left) * Math.min(1, Math.max(0, t)));
  return rgbaToHex(
    mix(a[0], b[0]),
    mix(a[1], b[1]),
    mix(a[2], b[2]),
    mix(a[3] * fromOpacity, b[3] * toOpacity)
  );
}

function normalizeHex(value: string): string {
  return rgbaToHex(...hexToRgba(value));
}

function hexToRgba(value: string): [number, number, number, number] {
  const raw = value.replace("#", "");
  if (raw.length === 3 || raw.length === 4) {
    return [
      parseInt(raw[0] + raw[0], 16),
      parseInt(raw[1] + raw[1], 16),
      parseInt(raw[2] + raw[2], 16),
      raw.length === 4 ? parseInt(raw[3] + raw[3], 16) : 255
    ];
  }
  if (raw.length === 6 || raw.length === 8) {
    return [
      parseInt(raw.slice(0, 2), 16),
      parseInt(raw.slice(2, 4), 16),
      parseInt(raw.slice(4, 6), 16),
      raw.length === 8 ? parseInt(raw.slice(6, 8), 16) : 255
    ];
  }
  return [255, 255, 255, 255];
}

function rgbaToHex(red: number, green: number, blue: number, alpha: number): string {
  const byte = (value: number) => Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, "0");
  return `#${byte(red)}${byte(green)}${byte(blue)}${byte(alpha)}`;
}
