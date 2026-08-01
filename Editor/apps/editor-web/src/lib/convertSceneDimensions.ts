import {
  MAX_PROJECT_DIMENSION,
  MIN_PROJECT_DIMENSION,
  type BezierPath,
  type ObjectMask,
  type PropertyChannel,
  type SceneDocument,
  type SceneKeyframe,
  type SceneObject,
  type Vec2
} from "@grapix/shared-types";

/**
 * Convert one scene's canvas to a different size.
 *
 * This is the per-template counterpart to `conformScene`, which brings a canvas onto the project
 * resolution and deliberately never touches the objects. Conforming is a repair; converting is an
 * authoring decision — "this lower third now has to exist at 1280 × 720" — so the caller says what
 * should happen to the content instead of the tool guessing.
 *
 * The project still has one resolution, and Project Settings still reports every scene that no
 * longer matches it. Converting a template away from the project size is legal and sometimes
 * necessary, but it is not free: scenes at different resolutions cannot be cut between on air, so
 * the mismatch list is the safety net rather than something to silence.
 */

export type CanvasConversionMode =
  /** Canvas only. Every object keeps its pixel position and size, exactly like conforming. */
  | "canvas-only"
  /** Uniform scale by the smaller ratio, then centred. Aspect is preserved; spare space appears. */
  | "fit"
  /** Independent X and Y scale. Content fills the new canvas exactly and its aspect changes. */
  | "stretch";

export const CANVAS_CONVERSION_MODES: readonly CanvasConversionMode[] = [
  "fit",
  "stretch",
  "canvas-only"
];

export interface CanvasConversionRequest {
  width: number;
  height: number;
  mode: CanvasConversionMode;
}

export interface CanvasConversionPlan {
  from: { width: number; height: number };
  to: { width: number; height: number };
  mode: CanvasConversionMode;
  /** Horizontal and vertical factors applied to geometry. Both 1 for `canvas-only`. */
  scaleX: number;
  scaleY: number;
  /** Scene-pixel offset applied after scaling, so `fit` lands centred. */
  offsetX: number;
  offsetY: number;
  /** Single factor for values with no axis — stroke width, font size, corner radius, depth. */
  uniformScale: number;
  /** False when the requested size is the size it already is and the mode changes nothing. */
  changed: boolean;
}

/**
 * Snap a requested dimension to something a broadcast pipeline can encode.
 *
 * Same rule the project resolution uses: even numbers only, because odd sizes break 4:2:0 chroma
 * subsampling, and clamped to the same bounds so a template cannot be authored outside the range
 * a project can be set to.
 */
export function normalizeCanvasDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  const rounded = Math.round(value);
  const even = rounded % 2 === 0 ? rounded : rounded + 1;
  return Math.min(MAX_PROJECT_DIMENSION, Math.max(MIN_PROJECT_DIMENSION, even));
}

export function planCanvasConversion(
  scene: SceneDocument,
  request: CanvasConversionRequest
): CanvasConversionPlan {
  const from = { width: scene.canvas.width, height: scene.canvas.height };
  const to = {
    width: normalizeCanvasDimension(request.width, from.width),
    height: normalizeCanvasDimension(request.height, from.height)
  };

  const ratioX = to.width / Math.max(1, from.width);
  const ratioY = to.height / Math.max(1, from.height);

  let scaleX = 1;
  let scaleY = 1;
  if (request.mode === "stretch") {
    scaleX = ratioX;
    scaleY = ratioY;
  } else if (request.mode === "fit") {
    scaleX = Math.min(ratioX, ratioY);
    scaleY = scaleX;
  }

  return {
    from,
    to,
    mode: request.mode,
    scaleX,
    scaleY,
    offsetX: request.mode === "fit" ? (to.width - from.width * scaleX) / 2 : 0,
    offsetY: request.mode === "fit" ? (to.height - from.height * scaleY) / 2 : 0,
    uniformScale: (scaleX + scaleY) / 2,
    changed: to.width !== from.width || to.height !== from.height
  };
}

export function convertSceneDimensions(
  scene: SceneDocument,
  request: CanvasConversionRequest
): SceneDocument {
  const plan = planCanvasConversion(scene, request);
  if (!plan.changed) return scene;

  return {
    ...scene,
    canvas: {
      ...scene.canvas,
      width: plan.to.width,
      height: plan.to.height,
      editorViewport: scene.canvas.editorViewport
        ? convertViewport(scene.canvas.editorViewport, plan)
        : undefined
    },
    objects: scene.objects.map((object) => convertObject(object, plan)),
    timeline: {
      ...scene.timeline,
      keyframes: scene.timeline.keyframes.map((keyframe) => convertLegacyKeyframe(keyframe, plan))
    },
    updatedAt: new Date().toISOString()
  };
}

function convertViewport(
  viewport: NonNullable<SceneDocument["canvas"]["editorViewport"]>,
  plan: CanvasConversionPlan
): NonNullable<SceneDocument["canvas"]["editorViewport"]> {
  // Margins are safe-area insets measured from an edge, so they follow the axis they sit on
  // rather than the object transform: a 5% title-safe inset stays 5%.
  const marginX = plan.to.width / Math.max(1, plan.from.width);
  const marginY = plan.to.height / Math.max(1, plan.from.height);
  return {
    ...viewport,
    margins: {
      top: Math.round(viewport.margins.top * marginY),
      right: Math.round(viewport.margins.right * marginX),
      bottom: Math.round(viewport.margins.bottom * marginY),
      left: Math.round(viewport.margins.left * marginX)
    },
    guides: viewport.guides.map((guide) => ({
      ...guide,
      position: Math.round(
        guide.orientation === "horizontal"
          ? guide.position * marginY
          : guide.position * marginX
      )
    }))
  };
}

/**
 * Scale one object's geometry.
 *
 * Only values measured in scene pixels move. Rotations, opacity and the unitless scale factors
 * are left exactly as authored, because multiplying them would change the look rather than the
 * size — a 45° corner is 45° at any resolution.
 */
function convertObject(object: SceneObject, plan: CanvasConversionPlan): SceneObject {
  const { scaleX, scaleY, offsetX, offsetY, uniformScale } = plan;
  if (scaleX === 1 && scaleY === 1 && offsetX === 0 && offsetY === 0) return object;

  const next = {
    ...object,
    x: object.x * scaleX + offsetX,
    y: object.y * scaleY + offsetY,
    width: object.width * scaleX,
    height: object.height * scaleY,
    zDepth: object.zDepth * uniformScale,
    strokeWidth: object.strokeWidth * uniformScale,
    ...(object.anchor
      ? { anchor: { x: object.anchor.x * scaleX, y: object.anchor.y * scaleY } }
      : {}),
    ...(object.animation ? { animation: convertChannels(object.animation, plan) } : {}),
    ...(object.masks ? { masks: object.masks.map((mask) => convertMask(mask, plan)) } : {})
  } as SceneObject;

  switch (next.type) {
    case "rect":
      return { ...next, radius: next.radius * uniformScale };

    case "text":
      return {
        ...next,
        fontSize: next.fontSize * uniformScale,
        ...(next.lineHeight === undefined ? {} : { lineHeight: next.lineHeight * uniformScale }),
        ...(next.letterSpacing === undefined ? {} : { letterSpacing: next.letterSpacing * uniformScale }),
        ...(next.wordSpacing === undefined ? {} : { wordSpacing: next.wordSpacing * uniformScale }),
        ...(next.paragraphSpacing === undefined ? {} : { paragraphSpacing: next.paragraphSpacing * uniformScale }),
        ...(next.textIndent === undefined ? {} : { textIndent: next.textIndent * uniformScale })
      };

    case "line":
      return {
        ...next,
        points: next.points.map((point) => ({ x: point.x * scaleX, y: point.y * scaleY }))
      };

    case "shape":
      return {
        ...next,
        path: convertPath(next.path, plan),
        ...(next.compoundPaths
          ? { compoundPaths: next.compoundPaths.map((path) => convertPath(path, plan)) }
          : {})
      };

    case "paint":
      return {
        ...next,
        strokes: next.strokes.map((stroke) => ({
          ...stroke,
          size: stroke.size * uniformScale,
          points: stroke.points.map((point) => ({
            ...point,
            x: point.x * scaleX,
            y: point.y * scaleY
          }))
        }))
      };

    case "mesh":
      return {
        ...next,
        depth: next.depth * uniformScale,
        ...(next.anchor3d
          ? {
              anchor3d: {
                x: next.anchor3d.x * scaleX,
                y: next.anchor3d.y * scaleY,
                z: next.anchor3d.z * uniformScale
              }
            }
          : {}),
        ...(next.slab
          ? {
              slab: {
                ...next.slab,
                cornerRadius: next.slab.cornerRadius * uniformScale,
                skew: next.slab.skew * scaleX,
                frontBevel: {
                  ...next.slab.frontBevel,
                  size: next.slab.frontBevel.size * uniformScale,
                  depth: next.slab.frontBevel.depth * uniformScale
                },
                backBevel: {
                  ...next.slab.backBevel,
                  size: next.slab.backBevel.size * uniformScale,
                  depth: next.slab.backBevel.depth * uniformScale
                }
              }
            }
          : {})
      };

    case "light":
      return {
        ...next,
        ...(next.range === undefined ? {} : { range: next.range * uniformScale }),
        ...(next.target ? { target: convertScenePoint(next.target, plan) } : {})
      };

    case "camera":
      // `up` is a direction, not a distance, so it is left alone. Near and far are distances in
      // the same space the geometry just moved in, so they follow it.
      return {
        ...next,
        ...(next.near === undefined ? {} : { near: next.near * uniformScale }),
        ...(next.far === undefined ? {} : { far: next.far * uniformScale }),
        ...(next.target ? { target: convertScenePoint(next.target, plan) } : {})
      };

    default:
      return next;
  }
}

function convertScenePoint(
  point: { x: number; y: number; z: number },
  plan: CanvasConversionPlan
): { x: number; y: number; z: number } {
  return {
    x: point.x * plan.scaleX + plan.offsetX,
    y: point.y * plan.scaleY + plan.offsetY,
    z: point.z * plan.uniformScale
  };
}

/** Path vertices are object-local, so they scale but never take the centring offset. */
function convertPath(path: BezierPath, plan: CanvasConversionPlan): BezierPath {
  const scalePoint = (point: Vec2): Vec2 => ({
    x: point.x * plan.scaleX,
    y: point.y * plan.scaleY
  });
  return {
    ...path,
    vertices: path.vertices.map(scalePoint),
    inTangents: path.inTangents.map(scalePoint),
    outTangents: path.outTangents.map(scalePoint)
  };
}

function convertMask(mask: ObjectMask, plan: CanvasConversionPlan): ObjectMask {
  return {
    ...mask,
    path: convertPath(mask.path, plan),
    expansion: mask.expansion * plan.uniformScale,
    feather: { x: mask.feather.x * plan.scaleX, y: mask.feather.y * plan.scaleY },
    ...(mask.paintStrokes
      ? {
          paintStrokes: mask.paintStrokes.map((stroke) => ({
            ...stroke,
            size: stroke.size * plan.uniformScale,
            points: stroke.points.map((point) => ({
              ...point,
              x: point.x * plan.scaleX,
              y: point.y * plan.scaleY
            }))
          }))
        }
      : {}),
    ...(mask.animation
      ? {
          animation: {
            ...mask.animation,
            ...(mask.animation.path
              ? {
                  path: mask.animation.path.map((key) => ({
                    ...key,
                    value: convertPath(key.value, plan)
                  }))
                }
              : {}),
            ...(mask.animation.expansion
              ? {
                  expansion: mask.animation.expansion.map((key) => ({
                    ...key,
                    value: key.value * plan.uniformScale
                  }))
                }
              : {}),
            ...(mask.animation.feather
              ? {
                  feather: mask.animation.feather.map((key) => ({
                    ...key,
                    value: { x: key.value.x * plan.scaleX, y: key.value.y * plan.scaleY }
                  }))
                }
              : {})
          }
        }
      : {})
  };
}

/**
 * Scale the animated channels that carry pixels.
 *
 * `x`, `y` and `zDepth` are distances; `rotation*`, `scale*` and `opacity` are not, and scaling
 * them would turn a resolution change into an animation change. The temporal bezier handles are
 * (frames, value) pairs, so only their value component moves — scaling the frame component would
 * retime the animation.
 */
function convertChannels(
  channels: NonNullable<SceneObject["animation"]>,
  plan: CanvasConversionPlan
): NonNullable<SceneObject["animation"]> {
  const scaleChannel = (channel: PropertyChannel, factor: number, offset: number): PropertyChannel => ({
    keys: channel.keys.map((key) => ({
      ...key,
      value: key.value * factor + offset,
      ...(key.inTangent ? { inTangent: { x: key.inTangent.x, y: key.inTangent.y * factor } } : {}),
      ...(key.outTangent ? { outTangent: { x: key.outTangent.x, y: key.outTangent.y * factor } } : {})
    }))
  });

  return {
    ...channels,
    ...(channels.x ? { x: scaleChannel(channels.x, plan.scaleX, plan.offsetX) } : {}),
    ...(channels.y ? { y: scaleChannel(channels.y, plan.scaleY, plan.offsetY) } : {}),
    ...(channels.zDepth ? { zDepth: scaleChannel(channels.zDepth, plan.uniformScale, 0) } : {})
  };
}

/** The pre-channel whole-object keyframes, which older scenes still evaluate. */
function convertLegacyKeyframe(keyframe: SceneKeyframe, plan: CanvasConversionPlan): SceneKeyframe {
  const scaled: Record<string, unknown> = { ...keyframe.properties };
  const apply = (key: string, factor: number, offset: number) => {
    const value = scaled[key];
    if (typeof value === "number" && Number.isFinite(value)) scaled[key] = value * factor + offset;
  };

  apply("x", plan.scaleX, plan.offsetX);
  apply("y", plan.scaleY, plan.offsetY);
  apply("width", plan.scaleX, 0);
  apply("height", plan.scaleY, 0);
  apply("zDepth", plan.uniformScale, 0);

  return { ...keyframe, properties: scaled as SceneKeyframe["properties"] };
}
