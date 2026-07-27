export type SceneObjectType =
  | "text"
  | "rect"
  | "ellipse"
  | "image"
  | "line"
  | "shape"
  | "paint"
  | "mesh"
  | "light"
  | "camera"
  | "layer"
  | "marker"
  | "group";

export * from "./designImport.js";

export type MeshPrimitiveKind = "model" | "cube" | "sphere" | "cylinder" | "torus" | "slab";
export type LightKind = "directional" | "point" | "spot";
export type CameraKind = "perspective" | "orthographic";
export type LayerKind = "object" | "camera";
export type MarkerKind = "event";

export type SceneProperty =
  | "text"
  | "src"
  | "fill"
  | "stroke"
  | "visible"
  | "x"
  | "y"
  | "width"
  | "height"
  | "zDepth"
  | "rotation"
  | "rotationX"
  | "rotationY"
  | "rotationZ"
  | "scaleX"
  | "scaleY"
  | "scaleZ"
  | "anchor"
  | "opacity"
  | "path";

export type BindingMap = Partial<Record<SceneProperty, string>>;

export interface GradientStop {
  id: string;
  position: number;
  color: string;
  opacity: number;
}

export type GradientSpread = "pad" | "repeat" | "reflect";
export type GradientCoordinateMode = "object" | "scene";

export type ColorValue =
  | { type: "none" }
  | { type: "solid"; color: string }
  | {
      type: "linear-gradient";
      angle: number;
      startX: number;
      startY: number;
      endX: number;
      endY: number;
      stops: GradientStop[];
      spread: GradientSpread;
      coordinateMode: GradientCoordinateMode;
    }
  | {
      type: "radial-gradient";
      centerX: number;
      centerY: number;
      radiusX: number;
      radiusY: number;
      focalX?: number;
      focalY?: number;
      stops: GradientStop[];
      spread: GradientSpread;
      coordinateMode: GradientCoordinateMode;
    };

export interface GradientPreset {
  presetId: string;
  name: string;
  value: Extract<ColorValue, { type: "linear-gradient" | "radial-gradient" }>;
  builtIn?: boolean;
}

export function solidColorValue(color: string): ColorValue {
  return color === "transparent" ? { type: "none" } : { type: "solid", color };
}

/** Accept legacy colour strings and normalize malformed authored gradients safely. */
export function normalizeColorValue(value: ColorValue | string | undefined, fallback = "#ffffff"): ColorValue {
  if (typeof value === "string") return solidColorValue(value);
  if (!value || typeof value !== "object") return solidColorValue(fallback);
  if (value.type === "none") return value;
  if (value.type === "solid") return solidColorValue(value.color || fallback);
  return {
    ...value,
    stops: normalizeGradientStops(value.stops)
  };
}

export function normalizeGradientStops(stops: GradientStop[] | undefined): GradientStop[] {
  const source = Array.isArray(stops) ? stops : [];
  const normalized = source
    .filter((stop) => stop && typeof stop.color === "string")
    .map((stop, index) => ({
      id: stop.id || `stop_${index}`,
      position: Math.min(1, Math.max(0, Number.isFinite(stop.position) ? stop.position : 0)),
      color: stop.color,
      opacity: Math.min(1, Math.max(0, Number.isFinite(stop.opacity) ? stop.opacity : 1))
    }))
    .sort((left, right) => left.position - right.position);
  if (normalized.length >= 2) return normalized;
  return [
    { id: "stop_0", position: 0, color: normalized[0]?.color ?? "#000000", opacity: normalized[0]?.opacity ?? 1 },
    { id: "stop_1", position: 1, color: "#ffffff", opacity: 1 }
  ];
}

export type AssetKind =
  | "image"
  | "video"
  | "svg"
  | "font"
  | "model"
  | "image-sequence"
  | "wgsl"
  | "script"
  | "live"
  | "render-texture"
  | "json"
  | "lut"
  | "unknown";

export type AssetAvailability = "READY" | "MISSING" | "IMPORTING" | "UNSUPPORTED" | "ERROR";
export type AssetAlphaMode = "opaque" | "straight" | "premultiplied" | "alpha-test" | "alpha-mask" | "unknown";
export type AssetColorSpace = "srgb" | "linear" | "display-p3" | "rec709" | "unknown";

export interface AssetLibraryItem {
  assetId: string;
  name: string;
  kind: AssetKind;
  source: string;
  mimeType?: string;
  sizeBytes?: number;
  importedAt: string;
  sourcePath?: string;
  /** API storage object ID; differs from the stable scene assetId after an undoable relink. */
  storageAssetId?: string;
  checksum?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  frameRate?: number;
  codec?: string;
  hasAlpha?: boolean | "unknown";
  hasAudio?: boolean | "unknown";
  alphaMode?: AssetAlphaMode;
  colorSpace?: AssetColorSpace;
  loop?: boolean;
  status?: AssetAvailability;
  error?: string;
  tags?: string[];
  folderId?: string;
  thumbnailSource?: string;
  license?: string;
  /** Ordered glTF material elements exposed as independently assignable surfaces. */
  modelMaterialNames?: string[];
}

/** The only material type authored by scene-v1 writers. */
export const CANONICAL_MATERIAL_TYPE = "pbr" as const;
export type CanonicalMaterialType = typeof CANONICAL_MATERIAL_TYPE;

/**
 * Historical scene-v1 values accepted by the loader. They are load-only
 * compatibility aliases: normalizeMaterial() rewrites every one to `pbr`.
 */
export const STANDARD_MATERIAL_WIRE_TYPES = [
  "solid-color",
  "image",
  "unlit-texture",
  "basic-lit",
  CANONICAL_MATERIAL_TYPE
] as const;
export type StandardMaterialWireType = (typeof STANDARD_MATERIAL_WIRE_TYPES)[number];

export type MaterialType =
  | "image"
  | "video"
  | "solid-color"
  | "gradient"
  | "text-style"
  | "svg-vector"
  | "shader"
  | "image-sequence"
  | "unlit-texture"
  | "chroma-key"
  | "mask"
  | "matte"
  | "additive-glow"
  | "basic-lit"
  | "pbr";

export type MaterialBlendMode = "normal" | "add" | "multiply" | "screen" | "overlay" | "darken" | "lighten" | "subtract" | "alpha-mask" | "inverse-alpha-mask";

/**
 * Blend modes implemented identically in BOTH renderers (PixiJS preview and
 * the Rust render daemon) as fixed-function GPU blending, using Adobe's
 * standard blend-mode math where it is fixed-function-expressible. The exact
 * per-mode blend equations are the contract in
 * packages/render-shaders/layouts.json; both renderers mirror PixiJS's
 * premultiplied-alpha equations so preview and program output match.
 *
 * Deliberately excluded until a shader-compositing path exists: "overlay"
 * (PixiJS core silently aliases it to screen — misrepresenting it would
 * violate the no-silent-fallback rule), "subtract", "alpha-mask",
 * "inverse-alpha-mask".
 */
export const IMPLEMENTED_BLEND_MODES: readonly MaterialBlendMode[] = [
  "normal",
  "add",
  "multiply",
  "screen",
  "darken",
  "lighten"
];
export type MaterialAlphaMode = "opaque" | "straight" | "premultiplied" | "alpha-test" | "alpha-mask";
export type MaterialCullMode = "none" | "front" | "back";
export type MaterialDepthMode = "disabled" | "read" | "read-write";
export type TextureFitMode = "stretch" | "fit" | "fill" | "crop" | "tile" | "original" | "pixel-perfect" | "nine-slice";
export type TextureWrapMode = "clamp" | "repeat" | "mirror-repeat";
export type TextureFilteringMode = "nearest" | "linear";
export type MaterialParameterType = "float" | "integer" | "boolean" | "colour" | "vector2" | "vector3" | "vector4" | "texture" | "sampler" | "enum" | "matrix";
export type MaterialParameterValue = number | boolean | string | number[];

export interface MaterialParameterDefinition {
  name: string;
  label?: string;
  type: MaterialParameterType;
  default: MaterialParameterValue;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  animatable?: boolean;
  bindable?: boolean;
  group?: string;
}

export interface ShaderTextureSlotDefinition {
  name: string;
  label?: string;
  required: boolean;
}

export interface MaterialTextureSlot {
  name: string;
  assetId?: string;
  fit: TextureFitMode;
  wrap: TextureWrapMode;
  filtering: TextureFilteringMode;
  uvScale: [number, number];
  uvOffset: [number, number];
  uvRotation: number;
  uvPivot: [number, number];
  flipX: boolean;
  flipY: boolean;
}

export interface ShaderDefinition {
  shaderId: string;
  name: string;
  version: number;
  sourcePath: string;
  vertexEntry: string;
  fragmentEntry: string;
  textureSlots: ShaderTextureSlotDefinition[];
  parameters: MaterialParameterDefinition[];
  supportedPrimitives: SceneObjectType[];
  validationStatus: "VALID" | "INVALID" | "UNSUPPORTED";
  compilationErrors: string[];
  builtIn: boolean;
  updatedAt: string;
  /** Whether authoring UIs should offer this shader as a material choice. */
  userFacing?: boolean;
  /** Canonical shader represented by a hidden compatibility definition. */
  compatibilityAliasFor?: string;
}

export type MaterialBindingType =
  | "assetId"
  | "filePath"
  | "url"
  | "databaseField"
  | "apiField"
  | "color"
  | "video"
  | "conditional";

export type MaterialReadinessState =
  | "MISSING"
  | "LOADING"
  | "READY"
  | "FAILED"
  | "FALLBACK_READY";

export interface MaterialBinding {
  path: string;
  type: MaterialBindingType;
  fallbackAssetId?: string;
  fallbackColor?: string;
}

export interface Material {
  materialId: string;
  name: string;
  type: MaterialType;
  assetId?: string;
  color?: string;
  dynamic: boolean;
  binding?: MaterialBinding;
  sampling?: "linear" | "nearest";
  wrap?: "clamp" | "repeat" | "mirror";
  opacity: number;
  readiness: MaterialReadinessState;
  shaderId?: string;
  textureSlots?: MaterialTextureSlot[];
  parameters?: Record<string, MaterialParameterValue>;
  blendMode?: MaterialBlendMode;
  alphaMode?: MaterialAlphaMode;
  cullMode?: MaterialCullMode;
  depthMode?: MaterialDepthMode;
  colorSpace?: AssetColorSpace;
  doubleSided?: boolean;
  enabled?: boolean;
  tags?: string[];
  folderId?: string;
  createdAt?: string;
  updatedAt?: string;
  supportedPrimitives?: SceneObjectType[];
  builtIn?: boolean;
}

export type MaterialDefinition = Material;

export interface MaterialInstance {
  materialInstanceId: string;
  name: string;
  baseMaterialId: string;
  parameterOverrides: Record<string, MaterialParameterValue>;
  textureOverrides: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface PrimitiveMaterialBinding {
  materialId: string;
  instanceId?: string;
  overrides?: Record<string, MaterialParameterValue>;
}

export interface MaterialFolder {
  folderId: string;
  name: string;
  parentId?: string;
  kind: "material" | "asset" | "shader" | "mixed";
}

export type MaterialSlotMap = Record<string, string | PrimitiveMaterialBinding>;

export type SceneKeyframeEasing = "linear" | "ease-in" | "ease-out" | "ease-in-out";

export interface SceneKeyframe {
  id: string;
  objectId: string;
  frame: number;
  properties: Partial<Record<SceneProperty, unknown>>;
  easing: SceneKeyframeEasing;
}

/**
 * Numeric object properties that can be keyframed per-channel (the columns of
 * the XPression-style object table). `opacity` is shown as Alpha 0-100.
 */
export type AnimatableProperty =
  | "opacity"
  | "x"
  | "y"
  | "zDepth"
  | "rotationX"
  | "rotationY"
  | "rotation"
  | "rotationZ"
  | "scaleX"
  | "scaleY"
  | "scaleZ";

export const ANIMATABLE_PROPERTIES: readonly AnimatableProperty[] = [
  "opacity",
  "x",
  "y",
  "zDepth",
  "rotationX",
  "rotationY",
  "rotation",
  "rotationZ",
  "scaleX",
  "scaleY",
  "scaleZ"
];

/**
 * One key on a per-property channel. `inTangent`/`outTangent` are the temporal
 * bezier handles used by the curve / speed-graph editor, expressed as
 * (frames, value) offsets from this key. When absent the segment falls back to
 * `easing`.
 */
export interface PropertyKeyframe {
  id: string;
  frame: number;
  value: number;
  easing: SceneKeyframeEasing;
  inTangent?: Vec2;
  outTangent?: Vec2;
}

/** Keys for a single animated property, kept sorted by frame. */
export interface PropertyChannel {
  keys: PropertyKeyframe[];
}

export type PropertyChannelMap = Partial<Record<AnimatableProperty, PropertyChannel>>;

/** Default value for an animatable property when the object doesn't define it. */
export function animatablePropertyDefault(property: AnimatableProperty): number {
  if (property === "opacity") return 1;
  if (property === "scaleX" || property === "scaleY" || property === "scaleZ") return 1;
  return 0;
}

/** Read the current static value of an animatable property off an object. */
export function readAnimatableProperty(object: SceneObject, property: AnimatableProperty): number {
  const value = (object as unknown as Record<string, unknown>)[property];
  return typeof value === "number" ? value : animatablePropertyDefault(property);
}

/**
 * Sample one channel at a frame. Holds before the first / after the last key;
 * interpolates between with the outgoing key's easing (cubic-bezier temporal
 * handles are honoured when both sides define them).
 */
export function sampleChannel(channel: PropertyChannel, frame: number): number | undefined {
  const keys = channel.keys;
  if (keys.length === 0) return undefined;
  if (frame <= keys[0].frame) return keys[0].value;
  const last = keys[keys.length - 1];
  if (frame >= last.frame) return last.value;

  let lo = keys[0];
  let hi = last;
  for (let index = 0; index < keys.length - 1; index += 1) {
    if (keys[index].frame <= frame && frame <= keys[index + 1].frame) {
      lo = keys[index];
      hi = keys[index + 1];
      break;
    }
  }
  const span = hi.frame - lo.frame;
  if (span <= 0) return hi.value;
  const t = (frame - lo.frame) / span;
  const eased = lo.outTangent || hi.inTangent
    ? bezierEase(t, lo.outTangent, hi.inTangent, span)
    : easeKeyframeT(t, lo.easing);
  return lo.value + (hi.value - lo.value) * eased;
}

/** Sample every enabled numeric property channel on an object. */
export function evaluatePropertyChannelsAtFrame(
  object: SceneObject,
  frame: number
): Partial<Record<AnimatableProperty, number>> {
  const patch: Partial<Record<AnimatableProperty, number>> = {};

  for (const property of ANIMATABLE_PROPERTIES) {
    const channel = object.animation?.[property];
    if (!channel) continue;
    const value = sampleChannel(channel, frame);
    if (value !== undefined) patch[property] = value;
  }

  return patch;
}

/**
 * Cubic-bezier temporal easing from a key's out handle and the next key's in
 * handle. Handles are (frames, value) offsets; we only need their normalized
 * time components to shape the curve, solved with a few Newton iterations.
 */
function bezierEase(t: number, out: Vec2 | undefined, inn: Vec2 | undefined, span: number): number {
  const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
  const x1 = clamp01((out?.x ?? span / 3) / span);
  const y1 = out?.y ?? 0;
  const x2 = clamp01(1 - (inn ? Math.abs(inn.x) / span : 1 / 3));
  const y2 = 1 + (inn?.y ?? 0);
  const curveX = (u: number) => 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
  const curveY = (u: number) => 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
  let u = t;
  for (let index = 0; index < 5; index += 1) {
    const dx = curveX(u) - t;
    if (Math.abs(dx) < 0.0005) break;
    const slope =
      3 * (1 - u) * (1 - u) * x1 + 6 * (1 - u) * u * (x2 - x1) + 3 * u * u * (1 - x2);
    if (Math.abs(slope) < 1e-6) break;
    u = clamp01(u - dx / slope);
  }
  return curveY(u);
}

export interface SceneTimeline {
  fps: number;
  durationFrames: number;
  keyframes: SceneKeyframe[];
}

export type FontSource =
  | {
      kind: "file";
      assetId: string;
      format: "otf" | "ttf" | "woff" | "woff2";
    }
  | {
      kind: "css-url";
      url: string;
      integrity?: string;
    }
  | {
      kind: "adobe-fonts";
      projectId: string;
      url: string;
    };

export interface FontFaceDefinition {
  faceId: string;
  family: string;
  weight: number;
  style: "normal" | "italic" | "oblique";
  stretch?: string;
  unicodeRange?: string;
  source: FontSource;
}

export interface FontDefinition {
  fontId: string;
  family: string;
  displayName: string;
  faces: FontFaceDefinition[];
  fallbackFamilies: string[];
  embeddingPolicy: "package" | "reference" | "restricted";
  license?: string;
  status: "READY" | "MISSING" | "UNVERIFIED" | "ERROR";
}

export type TransitionKind = "cut" | "mix" | "wipe" | "dip" | "push" | "custom";

export interface SceneTransitionDefinition {
  transitionId: string;
  name: string;
  kind: TransitionKind;
  durationFrames: number;
  easing: SceneKeyframeEasing;
  direction?: "left" | "right" | "up" | "down";
  color?: string;
  shaderId?: string;
}

export type TriggerEventType =
  | "manual"
  | "api"
  | "webhook"
  | "data-change"
  | "timer"
  | "timecode"
  | "keyboard"
  | "scene-event";

export interface GrapixTriggerEvent {
  type: TriggerEventType;
  name: string;
  timestampMs: number;
  payload: Record<string, unknown>;
}

export type ConditionValueSource = "event" | "scene-data" | "rundown-variable" | "literal";

export interface ConditionOperand {
  source: ConditionValueSource;
  path?: string;
  value?: unknown;
}

export type ConditionComparisonOperator =
  | "eq"
  | "not-eq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "starts-with"
  | "ends-with"
  | "matches"
  | "in";

export type SceneConditionExpression =
  | { kind: "all"; conditions: SceneConditionExpression[] }
  | { kind: "any"; conditions: SceneConditionExpression[] }
  | { kind: "not"; condition: SceneConditionExpression }
  | { kind: "exists"; operand: ConditionOperand }
  | {
      kind: "compare";
      left: ConditionOperand;
      operator: ConditionComparisonOperator;
      right: ConditionOperand;
      caseSensitive?: boolean;
    };

export type GrapixAutomationAction =
  | { type: "warm-scene"; sceneId: string }
  | { type: "preview-scene"; sceneId: string }
  | { type: "take-scene"; sceneId: string; transitionId?: string }
  | { type: "release-scene"; sceneId: string }
  | { type: "patch-data"; sceneId: string; path: string; value: unknown }
  | { type: "start-timeline"; sceneId: string; fromFrame?: number }
  | { type: "pause-timeline"; sceneId: string }
  | { type: "goto-cue"; sequenceId: string; cueId: string }
  | { type: "emit-event"; name: string; payload?: Record<string, unknown> };

export interface GrapixTriggerRule {
  triggerId: string;
  name: string;
  enabled: boolean;
  event: {
    type: TriggerEventType;
    name?: string;
  };
  condition?: SceneConditionExpression;
  actions: GrapixAutomationAction[];
  priority: number;
  cooldownMs?: number;
  once?: boolean;
}

export type SceneScriptPermission =
  | "read-data"
  | "patch-data"
  | "control-preview"
  | "control-program"
  | "control-timeline"
  | "emit-event";

export interface SceneScriptReference {
  scriptId: string;
  assetId: string;
  apiVersion: 1;
  entrypoint: "default";
  enabled: boolean;
  checksum: string;
  permissions: SceneScriptPermission[];
  execution: "control-sandbox";
}

export interface SceneAutomationDefinition {
  version: 1;
  transitions: SceneTransitionDefinition[];
  triggers: GrapixTriggerRule[];
  script?: SceneScriptReference;
}

export interface SequenceCue {
  cueId: string;
  name: string;
  sceneId: string;
  startFrame: number;
  durationFrames: number;
  prewarmFrames: number;
  transitionInId?: string;
  transitionOutId?: string;
  condition?: SceneConditionExpression;
  autoTake: boolean;
}

export interface SequenceTrack {
  trackId: string;
  name: string;
  role: "program" | "overlay" | "automation" | "audio";
  enabled: boolean;
  cues: SequenceCue[];
}

export interface SequenceDocument {
  sequenceId: string;
  name: string;
  fps: number;
  durationFrames: number;
  tracks: SequenceTrack[];
  transitions: SceneTransitionDefinition[];
  triggers: GrapixTriggerRule[];
}

export interface RundownDocument {
  rundownId: string;
  name: string;
  version: 1;
  revision?: number;
  activeSequenceId?: string;
  variables: Record<string, unknown>;
  sequences: SequenceDocument[];
  createdAt: string;
  updatedAt: string;
}

// --- Animation evaluation -------------------------------------------------
// Runtime the timeline currently lacks: interpolate keyframes into a concrete
// scene the renderer can draw. Built on today's scalar-snapshot keyframe model;
// the typed per-property Animatable<T> model (see docs/3d-engine-architecture.md
// §A) will extend this with typed values incl. animatable bezier paths.

function easeKeyframeT(t: number, easing: SceneKeyframeEasing): number {
  const c = Math.max(0, Math.min(1, t));
  switch (easing) {
    case "ease-in":
      return c * c;
    case "ease-out":
      return 1 - (1 - c) * (1 - c);
    case "ease-in-out":
      return c < 0.5 ? 2 * c * c : 1 - Math.pow(-2 * c + 2, 2) / 2;
    default:
      return c;
  }
}

function lerpNumber(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpHexColor(a: string, b: string, t: number): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(a) || !/^#[0-9a-fA-F]{6}$/.test(b)) {
    return t < 1 ? a : b;
  }
  const channel = (hex: string, offset: number) => parseInt(hex.slice(offset, offset + 2), 16);
  const mix = (offset: number) => Math.round(lerpNumber(channel(a, offset), channel(b, offset), t)).toString(16).padStart(2, "0");
  return `#${mix(1)}${mix(3)}${mix(5)}`;
}

const NUMERIC_KEYFRAME_PROPERTIES: SceneProperty[] = [
  "x",
  "y",
  "width",
  "height",
  "zDepth",
  "rotation",
  "rotationX",
  "rotationY",
  "rotationZ",
  "scaleX",
  "scaleY",
  "scaleZ",
  "opacity"
];
const COLOUR_KEYFRAME_PROPERTIES: SceneProperty[] = ["fill", "stroke"];

function isBezierPathValue(value: unknown): value is BezierPath {
  return typeof value === "object" && value !== null && Array.isArray((value as BezierPath).vertices);
}

function isVec2Value(value: unknown): value is Vec2 {
  return typeof value === "object"
    && value !== null
    && typeof (value as Vec2).x === "number"
    && typeof (value as Vec2).y === "number";
}

/**
 * Interpolate a bezier path (shape/mask morph). Requires MATCHED vertex counts
 * across keyframes — After Effects' rule — so vertices/tangents can be lerped
 * component-wise. On a mismatch the animation holds the nearer keyframe rather
 * than morph incorrectly. `closed` switches at the segment midpoint.
 */
export function interpolatePath(from: BezierPath, to: BezierPath, t: number): BezierPath {
  if (from.vertices.length !== to.vertices.length) {
    return t < 0.5 ? from : to;
  }
  const pair = (a: Vec2[], b: Vec2[]) => a.map((value, index) => ({
    x: lerpNumber(value.x, b[index]?.x ?? value.x, t),
    y: lerpNumber(value.y, b[index]?.y ?? value.y, t)
  }));
  return {
    closed: t < 0.5 ? from.closed : to.closed,
    vertices: pair(from.vertices, to.vertices),
    inTangents: pair(from.inTangents, to.inTangents),
    outTangents: pair(from.outTangents, to.outTangents)
  };
}

function interpolateKeyframeProperty(property: SceneProperty, from: unknown, to: unknown, t: number): unknown {
  if (NUMERIC_KEYFRAME_PROPERTIES.includes(property) && typeof from === "number" && typeof to === "number") {
    return lerpNumber(from, to, t);
  }
  if (COLOUR_KEYFRAME_PROPERTIES.includes(property) && typeof from === "string" && typeof to === "string") {
    return lerpHexColor(from, to, t);
  }
  if (property === "path" && isBezierPathValue(from) && isBezierPathValue(to)) {
    return interpolatePath(from, to, t);
  }
  if (property === "anchor" && isVec2Value(from) && isVec2Value(to)) {
    return {
      x: lerpNumber(from.x, to.x, t),
      y: lerpNumber(from.y, to.y, t)
    };
  }
  // text / src / visible and anything non-interpolable: step at the segment end.
  return t < 1 ? from : to;
}

/**
 * Interpolate one object's animatable scalar properties from its keyframes at
 * the given frame. Each property is sampled independently across only the
 * keyframes that define it. Segment easing uses the outgoing (earlier) keyframe;
 * before the first / after the last defining keyframe the value holds.
 */
export function evaluateObjectPropertiesAtFrame(
  keyframes: SceneKeyframe[],
  frame: number
): Partial<Record<SceneProperty, unknown>> {
  if (keyframes.length === 0) {
    return {};
  }
  const sorted = [...keyframes].sort((a, b) => a.frame - b.frame);
  const properties = new Set<SceneProperty>();
  for (const keyframe of sorted) {
    for (const property of Object.keys(keyframe.properties) as SceneProperty[]) {
      properties.add(property);
    }
  }
  const patch: Partial<Record<SceneProperty, unknown>> = {};
  for (const property of properties) {
    const defining = sorted.filter((keyframe) => property in keyframe.properties);
    if (defining.length === 0) {
      continue;
    }
    if (frame <= defining[0].frame) {
      patch[property] = defining[0].properties[property];
      continue;
    }
    const last = defining[defining.length - 1];
    if (frame >= last.frame) {
      patch[property] = last.properties[property];
      continue;
    }
    let lo = defining[0];
    let hi = last;
    for (let index = 0; index < defining.length - 1; index += 1) {
      if (defining[index].frame <= frame && frame <= defining[index + 1].frame) {
        lo = defining[index];
        hi = defining[index + 1];
        break;
      }
    }
    const span = hi.frame - lo.frame;
    const t = span <= 0 ? 1 : easeKeyframeT((frame - lo.frame) / span, lo.easing);
    patch[property] = interpolateKeyframeProperty(property, lo.properties[property], hi.properties[property], t);
  }
  return patch;
}

/**
 * Sample the whole scene at a frame: apply each object's interpolated keyframe
 * properties and return a new SceneDocument to resolve + render. Objects without
 * keyframes are returned unchanged; a scene with no keyframes returns unchanged.
 */
export function evaluateSceneAtFrame(scene: SceneDocument, frame: number): SceneDocument {
  const byObject = new Map<string, SceneKeyframe[]>();
  for (const keyframe of scene.timeline.keyframes) {
    const list = byObject.get(keyframe.objectId) ?? [];
    list.push(keyframe);
    byObject.set(keyframe.objectId, list);
  }
  const hasPropertyChannels = scene.objects.some((object) =>
    ANIMATABLE_PROPERTIES.some((property) => Boolean(object.animation?.[property]?.keys.length))
    || object.masks?.some((mask) => Boolean(
      mask.animation?.path?.length
      || mask.animation?.opacity?.length
      || mask.animation?.feather?.length
      || mask.animation?.expansion?.length
    ))
  );
  if (byObject.size === 0 && !hasPropertyChannels) {
    return scene;
  }
  return {
    ...scene,
    objects: scene.objects.map((object) => {
      const keyframes = byObject.get(object.id);
      const legacyPatch = keyframes?.length
        ? evaluateObjectPropertiesAtFrame(keyframes, frame)
        : {};
      // Per-property stopwatch channels are authoritative when both models
      // define the same numeric value; legacy snapshots remain readable.
      const channelPatch = evaluatePropertyChannelsAtFrame(object, frame);
      const patch = { ...legacyPatch, ...channelPatch };
      const evaluated = Object.keys(patch).length
        ? ({ ...object, ...patch } as SceneObject)
        : object;
      return evaluated.masks?.some((mask) => mask.animation)
        ? ({ ...evaluated, masks: evaluated.masks.map((mask) => evaluateMaskAtFrame(mask, frame)) } as SceneObject)
        : evaluated;
    })
  };
}

function evaluateMaskAtFrame(mask: ObjectMask, frame: number): ObjectMask {
  if (!mask.animation) return mask;
  return {
    ...mask,
    path: sampleMaskPath(mask.animation.path, frame) ?? mask.path,
    opacity: sampleMaskNumber(mask.animation.opacity, frame) ?? mask.opacity,
    feather: sampleMaskVec2(mask.animation.feather, frame) ?? mask.feather,
    expansion: sampleMaskNumber(mask.animation.expansion, frame) ?? mask.expansion
  };
}

function sampleMaskNumber(keys: MaskNumberKeyframe[] | undefined, frame: number): number | undefined {
  return sampleMaskKeys(keys, frame, (left, right, amount) => left + (right - left) * amount);
}

function sampleMaskVec2(keys: MaskVec2Keyframe[] | undefined, frame: number): Vec2 | undefined {
  return sampleMaskKeys(keys, frame, (left, right, amount) => ({
    x: left.x + (right.x - left.x) * amount,
    y: left.y + (right.y - left.y) * amount
  }));
}

function sampleMaskPath(keys: MaskPathKeyframe[] | undefined, frame: number): BezierPath | undefined {
  return sampleMaskKeys(keys, frame, (left, right, amount) => {
    if (left.vertices.length !== right.vertices.length) return amount < 0.5 ? left : right;
    const mixPoints = (a: Vec2[], b: Vec2[]) => a.map((point, index) => ({
      x: point.x + ((b[index]?.x ?? point.x) - point.x) * amount,
      y: point.y + ((b[index]?.y ?? point.y) - point.y) * amount
    }));
    return {
      closed: amount < 0.5 ? left.closed : right.closed,
      vertices: mixPoints(left.vertices, right.vertices),
      inTangents: mixPoints(left.inTangents, right.inTangents),
      outTangents: mixPoints(left.outTangents, right.outTangents)
    };
  });
}

function sampleMaskKeys<V, T extends { frame: number; value: V }>(
  keys: T[] | undefined,
  frame: number,
  interpolate: (left: V, right: V, amount: number) => V
): V | undefined {
  if (!keys?.length) return undefined;
  const sorted = [...keys].sort((left, right) => left.frame - right.frame);
  if (frame <= sorted[0].frame) return sorted[0].value;
  if (frame >= sorted.at(-1)!.frame) return sorted.at(-1)!.value;
  const upperIndex = sorted.findIndex((key) => key.frame >= frame);
  const lower = sorted[Math.max(0, upperIndex - 1)];
  const upper = sorted[upperIndex];
  const amount = (frame - lower.frame) / Math.max(1, upper.frame - lower.frame);
  return interpolate(lower.value, upper.value, amount);
}

export interface SceneCanvas {
  width: number;
  height: number;
  background: string;
  backgroundStyle?: ColorValue;
  /** Editor viewport chrome saved with the project; render output ignores it. */
  editorViewport?: SceneViewportSettings;
}

export interface CanvasMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface CanvasGuide {
  guideId: string;
  orientation: "horizontal" | "vertical";
  /** Position in scene pixels from the top or left canvas edge. */
  position: number;
}

export interface SceneViewportSettings {
  showRulers: boolean;
  margins: CanvasMargins;
  guides: CanvasGuide[];
}

export type VideoScanMode = "p" | "i";

export interface VideoProfile {
  id: string;
  label: string;
  width: number;
  height: number;
  frameRate: number;
  scanMode: VideoScanMode;
  timebase: string;
}

export interface TemplateScene {
  templateId: string;
  sceneId: string;
  name: string;
  shortLabel: string;
  description?: string;
  videoProfile: VideoProfile;
  favorite: boolean;
  thumbnailVariant: "blue" | "red" | "navy" | "purple" | "green" | "gold";
  scene: SceneDocument;
  createdAt: string;
  updatedAt: string;
}

export interface BaseSceneObject {
  id: string;
  name: string;
  type: SceneObjectType;
  x: number;
  y: number;
  zDepth: number;
  zIndex: number;
  layerId: string;
  width: number;
  height: number;
  rotation: number;
  /**
   * 3D rotation about X/Y in degrees (`rotation` is the Z axis). Optional so
   * pre-3D scenes stay valid; renderers treat missing values as 0.
   */
  rotationX?: number;
  rotationY?: number;
  /** Local X/Y/Z scale. Optional so version-1 scenes created before transform tools remain valid. */
  scaleX?: number;
  scaleY?: number;
  scaleZ?: number;
  /**
   * After Effects–style per-property keyframe channels, keyed by animatable
   * property. Present only for properties the user has "stopwatched"; absent
   * means the property is static. Coexists with the legacy whole-object
   * `timeline.keyframes` snapshots, which still evaluate for older scenes.
   */
  animation?: PropertyChannelMap;
  /**
   * Object-local pivot in scene pixels. `x/y` is the world-space position of
   * this anchor; renderers apply T(x,y) · R · S · T(-anchor).
   */
  anchor?: Vec2;
  opacity: number;
  visible: boolean;
  locked: boolean;
  fill: string;
  stroke: string;
  /** Rich colour model; legacy fill/stroke strings remain the fallback wire representation. */
  fillStyle?: ColorValue;
  strokeStyle?: ColorValue;
  strokeWidth: number;
  bindings: BindingMap;
  materialSlots: MaterialSlotMap;
  /** After Effects–style layer masks (bezier paths that clip the object). */
  masks?: ObjectMask[];
  /** Round-trippable source metadata retained by the professional design importer. */
  importedDesign?: {
    sourceFormat: "psd" | "ai" | "svg" | "figma-json" | "figma-api";
    sourceName: string;
    sourceNodeId?: string;
    sourceNodeType: string;
    fillOpacity?: number;
    clipping?: boolean;
    componentId?: string;
    componentProperties?: Record<string, unknown>;
    responsiveLayout?: Record<string, unknown>;
    effects?: Array<Record<string, unknown>>;
    additionalFills?: ColorValue[];
    additionalStrokes?: ColorValue[];
    raw?: Record<string, unknown>;
  };
}

export interface TextSceneObject extends BaseSceneObject {
  type: "text";
  text: string;
  textLayout?: "point" | "paragraph";
  writingMode?: "horizontal-tb" | "vertical-rl" | "vertical-lr";
  verticalAlign?: "top" | "middle" | "bottom";
  direction?: "ltr" | "rtl";
  fontSize: number;
  fontFamily: string;
  fontAssetId?: string;
  fontWeight: "400" | "500" | "600" | "700" | "800";
  fontStyle?: "normal" | "italic";
  textDecoration?: {
    underline?: boolean;
    strikethrough?: boolean;
  };
  lineHeight?: number;
  letterSpacing?: number;
  wordSpacing?: number;
  paragraphSpacing?: number;
  textIndent?: number;
  overflow?: "visible" | "hidden" | "clip";
  align: "left" | "center" | "right";
}

export interface RectSceneObject extends BaseSceneObject {
  type: "rect";
  radius: number;
}

export interface EllipseSceneObject extends BaseSceneObject {
  type: "ellipse";
}

export interface ImageSceneObject extends BaseSceneObject {
  type: "image";
  src: string;
  objectFit: "cover" | "contain" | "stretch";
}

export interface LineSceneObject extends BaseSceneObject {
  type: "line";
  points: Array<{ x: number; y: number }>;
}

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * A cubic bezier path, structured exactly like Lottie/Bodymovin's "sh" shape so
 * it round-trips with the web's proven vector-animation format. Segment k→k+1 is
 * a cubic bezier: P0=vertices[k], P1=vertices[k]+outTangents[k],
 * P2=vertices[k+1]+inTangents[k+1], P3=vertices[k+1]. Tangents are RELATIVE to
 * their vertex. `closed` adds the final segment back to vertices[0].
 * All three arrays must stay the same length (the constraint that also makes a
 * path animatable — see docs/3d-engine-architecture.md §B.3).
 */
export interface BezierPath {
  closed: boolean;
  vertices: Vec2[];
  inTangents: Vec2[];
  outTangents: Vec2[];
}

/**
 * An After-Effects-style shape layer (S-1: a single bezier path with fill and
 * stroke; groups/operators/masks arrive in later slices). Reuses BaseSceneObject
 * `fill`/`stroke`/`strokeWidth`. Path vertices are in object-local space.
 */
export interface ShapeSceneObject extends BaseSceneObject {
  type: "shape";
  path: BezierPath;
  /** Additional subpaths for compound paths; path remains the primary compatibility path. */
  compoundPaths?: BezierPath[];
  fillEnabled: boolean;
  strokeEnabled: boolean;
  fillRule: "nonzero" | "evenodd";
}

/**
 * After Effects–style mask modes. A mask is a bezier path that clips the layer.
 * The editor renderer accepts every authored mode plus inversion. Add,
 * subtract, expansion, opacity, and feather have direct alpha-mask behavior;
 * the remaining AE modes use deterministic reveal/hide composition until the
 * native multi-pass mask compositor lands.
 */
export type MaskMode = "none" | "add" | "subtract" | "intersect" | "lighten" | "darken" | "difference";

/** Mask modes accepted by the editor renderer. */
export const IMPLEMENTED_MASK_MODES: readonly MaskMode[] = [
  "none",
  "add",
  "subtract",
  "intersect",
  "lighten",
  "darken",
  "difference"
];

/** One layer mask: a bezier path plus AE-style mask properties. Path is in object-local space. */
export interface ObjectMask {
  id: string;
  name: string;
  type?: "rectangle" | "ellipse" | "bezier" | "paint";
  path: BezierPath;
  mode: MaskMode;
  inverted: boolean;
  opacity: number;
  expansion: number;
  feather: Vec2;
  visible?: boolean;
  locked?: boolean;
  editorColor?: string;
  animation?: MaskAnimation;
  paintStrokes?: PaintStroke[];
}

export interface MaskPathKeyframe {
  id: string;
  frame: number;
  value: BezierPath;
}

export interface MaskNumberKeyframe {
  id: string;
  frame: number;
  value: number;
}

export interface MaskVec2Keyframe {
  id: string;
  frame: number;
  value: Vec2;
}

export interface MaskAnimation {
  path?: MaskPathKeyframe[];
  opacity?: MaskNumberKeyframe[];
  feather?: MaskVec2Keyframe[];
  expansion?: MaskNumberKeyframe[];
}

export interface BrushPoint extends Vec2 {
  pressure?: number;
  time?: number;
}

export type BrushBlendMode = "normal" | "multiply" | "screen" | "add" | "erase";

export interface PaintStroke {
  id: string;
  points: BrushPoint[];
  size: number;
  hardness: number;
  opacity: number;
  flow: number;
  spacing: number;
  smoothing: number;
  roundness: number;
  angle: number;
  color: ColorValue;
  blendMode: BrushBlendMode;
  maskMode?: "paint" | "erase" | "reveal";
}

export interface PaintSceneObject extends BaseSceneObject {
  type: "paint";
  strokes: PaintStroke[];
  paintBlendMode: BrushBlendMode;
}

/** Axis-aligned bounds of a bezier path from its vertices + tangent handles (approximate; fine for selection/gizmo). */
export function bezierPathBounds(path: BezierPath): { x: number; y: number; width: number; height: number } {
  if (path.vertices.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (let index = 0; index < path.vertices.length; index += 1) {
    const vertex = path.vertices[index];
    add(vertex.x, vertex.y);
    const out = path.outTangents[index];
    if (out) add(vertex.x + out.x, vertex.y + out.y);
    const inn = path.inTangents[index];
    if (inn) add(vertex.x + inn.x, vertex.y + inn.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export interface MeshSceneObject extends BaseSceneObject {
  type: "mesh";
  meshKind: MeshPrimitiveKind;
  depth: number;
  src?: string;
  modelAssetId?: string;
  /** Ordered material elements copied from the imported glTF asset metadata. */
  materialElements?: string[];
  rotationX?: number;
  rotationY?: number;
  /** Mesh-local Z rotation. Falls back to BaseSceneObject.rotation for legacy scenes. */
  rotationZ?: number;
  scaleZ?: number;
  anchor3d?: Vec3;
  clipName?: string;
  clipIndex?: number;
  timeScale?: number;
  frameOffset?: number;
  animationLoop?: boolean;
}

export interface LightSceneObject extends BaseSceneObject {
  type: "light";
  lightKind: LightKind;
  intensity: number;
  color: string;
  range?: number;
  decay?: number;
  coneAngleDeg?: number;
  penumbra?: number;
  target?: Vec3;
  castShadow?: boolean;
}

export interface CameraSceneObject extends BaseSceneObject {
  type: "camera";
  cameraKind: CameraKind;
  fov: number;
  zoom: number;
  near?: number;
  far?: number;
  target?: Vec3;
  up?: Vec3;
}

export interface LayerSceneObject extends BaseSceneObject {
  type: "layer";
  layerKind: LayerKind;
  childIds: string[];
}

export interface MarkerSceneObject extends BaseSceneObject {
  type: "marker";
  markerKind: MarkerKind;
  eventName: string;
}

export interface GroupSceneObject extends BaseSceneObject {
  type: "group";
  childIds: string[];
}

export type SceneObject =
  | TextSceneObject
  | RectSceneObject
  | EllipseSceneObject
  | ImageSceneObject
  | LineSceneObject
  | ShapeSceneObject
  | PaintSceneObject
  | MeshSceneObject
  | LightSceneObject
  | CameraSceneObject
  | LayerSceneObject
  | MarkerSceneObject
  | GroupSceneObject;

/** A scene-graph node that affects descendants but does not paint pixels. */
export type SceneHierarchyContainerObject = LayerSceneObject | GroupSceneObject;

/** A leaf object that can be submitted to a renderer after hierarchy resolution. */
export type SceneHierarchyRenderableObject = Exclude<SceneObject, SceneHierarchyContainerObject>;

export type SceneHierarchyDiagnosticCode =
  | "missing-child"
  | "self-reference"
  | "multiple-parents"
  | "cycle";

export interface SceneHierarchyDiagnostic {
  code: SceneHierarchyDiagnosticCode;
  parentId: string;
  childId: string;
  /** Set when a later parent loses to the first ordered parent. */
  existingParentId?: string;
  message: string;
}

export interface SceneHierarchyResolution {
  /** Every source object with its effective inherited transform/state, in source order. */
  objects: SceneObject[];
  /** Pixel-producing objects only; layer/group containers are deliberately omitted. */
  renderableObjects: SceneHierarchyRenderableObject[];
  /** Effective non-pixel containers, useful for editor guides and hierarchy inspectors. */
  containerObjects: SceneHierarchyContainerObject[];
  /** Accepted one-parent relationship for each child. */
  parentByChildId: Readonly<Record<string, string>>;
  /** Accepted, validated child order for each container. */
  childrenByParentId: Readonly<Record<string, readonly string[]>>;
  /** Invalid references ignored while resolving the graph. */
  diagnostics: SceneHierarchyDiagnostic[];
}

interface SceneHierarchyAffine2d {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
}

interface SceneHierarchyInheritedState {
  transform: SceneHierarchyAffine2d;
  zDepth: number;
  rotationX: number;
  rotationY: number;
  rotationZ: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  visible: boolean;
  opacity: number;
  locked: boolean;
}

const IDENTITY_SCENE_HIERARCHY_STATE: SceneHierarchyInheritedState = {
  transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
  zDepth: 0,
  rotationX: 0,
  rotationY: 0,
  rotationZ: 0,
  scaleX: 1,
  scaleY: 1,
  scaleZ: 1,
  visible: true,
  opacity: 1,
  locked: false
};

export function isSceneHierarchyContainer(
  object: SceneObject
): object is SceneHierarchyContainerObject {
  return object.type === "layer" || object.type === "group";
}

/**
 * Resolve layer/group inheritance without mutating the authored objects.
 *
 * Container `childIds` are interpreted in scene order. A child belongs to the
 * first valid parent that claims it; missing/self/cyclic/later-parent edges are
 * ignored and reported. Parent transforms use the same 2D
 * T(position) · R(rotation) · S(scale) · T(-anchor) convention as the editor.
 * The effective scalar fields are kept renderer-friendly: Z/rotations add,
 * scales multiply, visibility is ANDed, opacity multiplied, and lock is ORed.
 */
export function resolveSceneObjectHierarchy(
  sourceObjects: readonly SceneObject[]
): SceneHierarchyResolution {
  const byId = new Map<string, SceneObject>();
  for (const object of sourceObjects) {
    // Duplicate ids are rejected by package preflight. Keeping the first here
    // makes hierarchy resolution deterministic even while an invalid scene is
    // being repaired in the editor.
    if (!byId.has(object.id)) {
      byId.set(object.id, object);
    }
  }

  const diagnostics: SceneHierarchyDiagnostic[] = [];
  const parentByChild = new Map<string, string>();
  const acceptedChildren = new Map<string, string[]>();

  for (const parent of sourceObjects) {
    if (!isSceneHierarchyContainer(parent) || byId.get(parent.id) !== parent) {
      continue;
    }

    for (const childId of parent.childIds) {
      if (childId === parent.id) {
        diagnostics.push({
          code: "self-reference",
          parentId: parent.id,
          childId,
          message: `Container ${parent.id} cannot contain itself; the reference was ignored.`
        });
        continue;
      }

      if (!byId.has(childId)) {
        diagnostics.push({
          code: "missing-child",
          parentId: parent.id,
          childId,
          message: `Container ${parent.id} references missing child ${childId}; the reference was ignored.`
        });
        continue;
      }

      const existingParentId = parentByChild.get(childId);
      if (existingParentId) {
        diagnostics.push({
          code: "multiple-parents",
          parentId: parent.id,
          childId,
          existingParentId,
          message: `Child ${childId} already belongs to ${existingParentId}; later parent ${parent.id} was ignored.`
        });
        continue;
      }

      if (createsSceneHierarchyCycle(parent.id, childId, parentByChild)) {
        diagnostics.push({
          code: "cycle",
          parentId: parent.id,
          childId,
          message: `Container edge ${parent.id} -> ${childId} would create a cycle; the reference was ignored.`
        });
        continue;
      }

      parentByChild.set(childId, parent.id);
      acceptedChildren.set(parent.id, [...(acceptedChildren.get(parent.id) ?? []), childId]);
    }
  }

  const effectiveById = new Map<string, SceneObject>();

  const resolveSubtree = (object: SceneObject, inherited: SceneHierarchyInheritedState): void => {
    if (effectiveById.has(object.id)) {
      return;
    }

    const point = applySceneHierarchyTransform(inherited.transform, object.x, object.y);
    const localRotationZ = object.type === "mesh"
      ? object.rotationZ ?? object.rotation
      : object.rotation;
    const effectiveRotationZ = inherited.rotationZ + localRotationZ;
    const effectiveScaleX = inherited.scaleX * (object.scaleX ?? 1);
    const effectiveScaleY = inherited.scaleY * (object.scaleY ?? 1);
    const effectiveScaleZ = inherited.scaleZ * (object.scaleZ ?? 1);
    const effectiveVisible = inherited.visible && object.visible;
    const effectiveOpacity = inherited.opacity * object.opacity;
    const effectiveLocked = inherited.locked || object.locked;

    let effective = {
      ...object,
      x: point.x,
      y: point.y,
      zDepth: inherited.zDepth + object.zDepth,
      rotation: effectiveRotationZ,
      scaleX: effectiveScaleX,
      scaleY: effectiveScaleY,
      scaleZ: effectiveScaleZ,
      visible: effectiveVisible,
      opacity: effectiveOpacity,
      locked: effectiveLocked
    } as SceneObject;

    if (effective.type === "mesh") {
      effective = {
        ...effective,
        rotationX: inherited.rotationX + (object.rotationX ?? 0),
        rotationY: inherited.rotationY + (object.rotationY ?? 0),
        rotationZ: effectiveRotationZ
      };
    } else if (isSceneHierarchyContainer(effective)) {
      effective = {
        ...effective,
        childIds: [...(acceptedChildren.get(object.id) ?? [])]
      };
    }

    effectiveById.set(object.id, effective);

    if (!isSceneHierarchyContainer(object)) {
      return;
    }

    const nextState: SceneHierarchyInheritedState = {
      transform: multiplySceneHierarchyTransforms(
        inherited.transform,
        sceneHierarchyObjectTransform(object)
      ),
      zDepth: inherited.zDepth + object.zDepth,
      rotationX: inherited.rotationX + (object.rotationX ?? 0),
      rotationY: inherited.rotationY + (object.rotationY ?? 0),
      rotationZ: inherited.rotationZ + object.rotation,
      scaleX: effectiveScaleX,
      scaleY: effectiveScaleY,
      scaleZ: effectiveScaleZ,
      visible: effectiveVisible,
      opacity: effectiveOpacity,
      locked: effectiveLocked
    };

    for (const childId of acceptedChildren.get(object.id) ?? []) {
      const child = byId.get(childId);
      if (child) {
        resolveSubtree(child, nextState);
      }
    }
  };

  for (const object of sourceObjects) {
    if (byId.get(object.id) === object && !parentByChild.has(object.id)) {
      resolveSubtree(object, IDENTITY_SCENE_HIERARCHY_STATE);
    }
  }

  // Accepted edges are acyclic, so every unique object should have been
  // reached from a root. Keep this defensive path for malformed duplicate-id
  // documents so resolution always returns a complete, inspectable result.
  for (const object of sourceObjects) {
    if (byId.get(object.id) === object && !effectiveById.has(object.id)) {
      resolveSubtree(object, IDENTITY_SCENE_HIERARCHY_STATE);
    }
  }

  const objects = sourceObjects.map((object) =>
    effectiveById.get(object.id) ?? ({ ...object } as SceneObject)
  );
  const renderableObjects = objects.filter(
    (object): object is SceneHierarchyRenderableObject => !isSceneHierarchyContainer(object)
  );
  const containerObjects = objects.filter(isSceneHierarchyContainer);

  return {
    objects,
    renderableObjects,
    containerObjects,
    parentByChildId: Object.fromEntries(parentByChild),
    childrenByParentId: Object.fromEntries(
      [...acceptedChildren].map(([parentId, childIds]) => [parentId, [...childIds]])
    ),
    diagnostics
  };
}

function createsSceneHierarchyCycle(
  parentId: string,
  childId: string,
  parentByChild: ReadonlyMap<string, string>
): boolean {
  let ancestorId: string | undefined = parentId;
  const visited = new Set<string>();

  while (ancestorId) {
    if (ancestorId === childId) {
      return true;
    }
    if (visited.has(ancestorId)) {
      return true;
    }
    visited.add(ancestorId);
    ancestorId = parentByChild.get(ancestorId);
  }

  return false;
}

function sceneHierarchyObjectTransform(object: SceneObject): SceneHierarchyAffine2d {
  const radians = object.rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const scaleX = object.scaleX ?? 1;
  const scaleY = object.scaleY ?? 1;
  const anchor = object.anchor ?? { x: 0, y: 0 };
  const a = cosine * scaleX;
  const b = sine * scaleX;
  const c = -sine * scaleY;
  const d = cosine * scaleY;

  return {
    a,
    b,
    c,
    d,
    tx: object.x - a * anchor.x - c * anchor.y,
    ty: object.y - b * anchor.x - d * anchor.y
  };
}

function multiplySceneHierarchyTransforms(
  parent: SceneHierarchyAffine2d,
  child: SceneHierarchyAffine2d
): SceneHierarchyAffine2d {
  return {
    a: parent.a * child.a + parent.c * child.b,
    b: parent.b * child.a + parent.d * child.b,
    c: parent.a * child.c + parent.c * child.d,
    d: parent.b * child.c + parent.d * child.d,
    tx: parent.a * child.tx + parent.c * child.ty + parent.tx,
    ty: parent.b * child.tx + parent.d * child.ty + parent.ty
  };
}

function applySceneHierarchyTransform(
  transform: SceneHierarchyAffine2d,
  x: number,
  y: number
): Vec2 {
  return {
    x: transform.a * x + transform.c * y + transform.tx,
    y: transform.b * x + transform.d * y + transform.ty
  };
}

export interface SceneDocument {
  id: string;
  name: string;
  version: 1;
  /** Monotonic project-service revision. Optional on legacy/editor-only v1 documents. */
  revision?: number;
  /** Program camera; absence means the legacy synthetic 2D orthographic camera. */
  activeCameraId?: string;
  canvas: SceneCanvas;
  dataContext: Record<string, unknown>;
  assets: AssetLibraryItem[];
  materials: Material[];
  materialInstances?: MaterialInstance[];
  shaders?: ShaderDefinition[];
  materialFolders?: MaterialFolder[];
  gradientPresets?: GradientPreset[];
  objects: SceneObject[];
  timeline: SceneTimeline;
  /** Font families available to editor preview and package consumers. */
  fonts?: FontDefinition[];
  /** Declarative triggers plus an optional checksummed JavaScript module. */
  automation?: SceneAutomationDefinition;
  createdAt: string;
  updatedAt: string;
}

export type RendererPatch =
  | {
      type: "PATCH_DATA_CONTEXT";
      sceneId: string;
      /** Dot/bracket path such as `player.name` or `scores[0].value`. */
      path: string;
      value: unknown;
    }
  | {
      type: "PATCH_SCENE_PROPERTY";
      sceneId: string;
      objectId: string;
      property: SceneProperty;
      value: unknown;
    }
  | {
      type: "SET_VISIBILITY";
      sceneId: string;
      objectId: string;
      value: boolean;
    };

export interface ScenePackageAssetEntry {
  assetId: string;
  name: string;
  kind: AssetKind;
  path: string;
  mimeType?: string;
  sizeBytes?: number;
  /** SHA-256 of the exact packaged bytes. */
  checksum: string;
}

export interface ScenePackageManifest {
  packageVersion: 2;
  minimumRendererProtocolVersion: 2;
  sceneId: string;
  sceneName: string;
  sceneRevision: number | string;
  createdAt: string;
  videoProfile: "PROGRAM_HD" | "PROGRAM_UHD" | "CUSTOM";
  width: number;
  height: number;
  frameRate: {
    numerator: number;
    denominator: number;
  };
  scanMode: "p";
  colorSpace: AssetColorSpace;
  alphaMode: "premultiplied";
  requiredRendererFeatures: string[];
  requiredFonts: string[];
  requiredShaders: string[];
  requiredCodecs: string[];
  estimatedMemoryBytes: number;
  fallbackPolicy: "fail-take" | "allow-declared-fallbacks";
  files: {
    scene: "scene.json";
    bindings: "bindings.json";
    materials: "materials.json";
    timeline: "timeline.json";
    fonts?: "fonts.json";
    automation?: "automation.json";
    metadata: "metadata.json";
    checksums: "checksums.json";
  };
  assets: ScenePackageAssetEntry[];
  stats: {
    objectCount: number;
    assetCount: number;
    materialCount: number;
    bindingCount: number;
    fontCount: number;
    triggerCount: number;
  };
}

export type ScenePackageIssueSeverity = "error" | "warning";

export interface ScenePackageIssue {
  severity: ScenePackageIssueSeverity;
  code: string;
  message: string;
  objectId?: string;
  materialId?: string;
  assetId?: string;
}

export interface ScenePackagePreflight {
  ok: boolean;
  issues: ScenePackageIssue[];
  readyMaterials: number;
  fallbackReadyMaterials: number;
  missingMaterials: number;
}

export function createSceneId(prefix = "scene"): string {
  return `${prefix}_${cryptoRandomSegment()}`;
}

export function createObjectId(prefix: SceneObjectType): string {
  return `${prefix}_${cryptoRandomSegment()}`;
}

export function resolveDataPath(data: Record<string, unknown>, path: string): unknown {
  if (!path.trim()) {
    return undefined;
  }

  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((current, key) => {
      if (current === null || current === undefined) {
        return undefined;
      }

      if (Array.isArray(current)) {
        return current[Number(key)];
      }

      if (typeof current === "object" && key in current) {
        return (current as Record<string, unknown>)[key];
      }

      return undefined;
    }, data);
}

export function applyBindings<T extends SceneObject>(
  object: T,
  dataContext: Record<string, unknown>
): T {
  const resolved: SceneObject = { ...object };

  for (const [property, path] of Object.entries(object.bindings)) {
    if (!path) {
      continue;
    }

    const value = resolveDataPath(dataContext, path);
    if (value === undefined) {
      continue;
    }

    assignBoundValue(resolved, property as SceneProperty, value);
  }

  return resolved as T;
}

export function findAsset(
  assets: AssetLibraryItem[],
  assetId: string | undefined
): AssetLibraryItem | undefined {
  if (!assetId) {
    return undefined;
  }

  return assets.find((asset) => asset.assetId === assetId);
}

export function findMaterial(
  materials: Material[],
  materialId: string | PrimitiveMaterialBinding | undefined
): Material | undefined {
  const resolvedMaterialId = getMaterialBindingId(materialId);

  if (!resolvedMaterialId) {
    return undefined;
  }

  return materials.find((material) => material.materialId === resolvedMaterialId);
}

export function normalizePrimitiveMaterialBinding(
  binding: string | PrimitiveMaterialBinding | undefined
): PrimitiveMaterialBinding | null {
  if (typeof binding === "string") {
    return binding ? { materialId: binding } : null;
  }

  return binding?.materialId ? binding : null;
}

export function getMaterialBindingId(
  binding: string | PrimitiveMaterialBinding | undefined
): string | undefined {
  return normalizePrimitiveMaterialBinding(binding)?.materialId;
}

export interface ResolvedMaterial {
  material: Material;
  instance?: MaterialInstance;
  parameters: Record<string, MaterialParameterValue>;
  textureSlots: MaterialTextureSlot[];
  blendMode: MaterialBlendMode;
  alphaMode: MaterialAlphaMode;
  warnings: string[];
}

export function resolvePrimitiveMaterial(
  scene: SceneDocument,
  object: SceneObject,
  slotName = "main"
): ResolvedMaterial | null {
  const binding = normalizePrimitiveMaterialBinding(object.materialSlots[slotName]);
  if (!binding) {
    return null;
  }

  const material = findMaterial(scene.materials, binding.materialId);
  if (!material) {
    return null;
  }

  const instance = binding.instanceId
    ? (scene.materialInstances ?? []).find((item) => item.materialInstanceId === binding.instanceId)
    : undefined;
  const warnings: string[] = [];

  if (binding.instanceId && (!instance || instance.baseMaterialId !== material.materialId)) {
    warnings.push(`Material instance ${binding.instanceId} is missing or does not inherit from ${material.name}.`);
  }

  const shader = material.shaderId
    ? (scene.shaders ?? []).find((item) => item.shaderId === material.shaderId)
    : undefined;
  const parameters = {
    ...parameterDefaults(shader?.parameters ?? []),
    ...(material.parameters ?? {}),
    ...(instance?.parameterOverrides ?? {}),
    ...(binding.overrides ?? {})
  };
  const textureOverrides = instance?.textureOverrides ?? {};
  const textureSlots = (material.textureSlots ?? defaultTextureSlots(material)).map((slot) => ({
    ...slot,
    assetId: textureOverrides[slot.name] ?? slot.assetId
  }));

  for (const slot of textureSlots) {
    const asset = slot.assetId ? findAsset(scene.assets, slot.assetId) : undefined;
    if (slot.assetId && (!asset || asset.status === "MISSING" || asset.status === "ERROR" || asset.status === "UNSUPPORTED")) {
      warnings.push(`Texture ${slot.assetId} used by ${material.name} is missing or unavailable.`);
    }
    // wrap (clamp/repeat/mirror) and filtering (linear/nearest) are applied by
    // the editor's texture sampler + TilingSprite path. Only tile and
    // nine-slice fit modes remain unimplemented.
    if (["tile", "nine-slice"].includes(slot.fit)) {
      warnings.push(`Texture fit mode ${slot.fit} is not implemented by both renderers.`);
    }
  }

  if (shader?.validationStatus === "INVALID") {
    warnings.push(`Shader ${shader.name} is invalid; the last valid material state remains active.`);
  }

  const blendMode = material.blendMode ?? "normal";
  const alphaMode = material.alphaMode ?? "premultiplied";
  if (!IMPLEMENTED_BLEND_MODES.includes(blendMode)) {
    warnings.push(`Blend mode ${blendMode} is not implemented by both GrapiX renderers.`);
  }
  if (!["opaque", "straight", "premultiplied"].includes(alphaMode)) {
    warnings.push(`Alpha mode ${alphaMode} is not implemented by both GrapiX renderers.`);
  }

  return {
    material,
    instance,
    parameters,
    textureSlots,
    blendMode,
    alphaMode,
    warnings
  };
}

export function isMaterialCompatible(material: Material, objectType: SceneObjectType): boolean {
  if (material.supportedPrimitives) {
    return material.supportedPrimitives.includes(objectType);
  }

  switch (material.type) {
    case "solid-color":
    case "gradient":
      return ["rect", "ellipse", "text", "image", "mesh"].includes(objectType);
    case "image":
    case "svg-vector":
    case "unlit-texture":
      return ["rect", "image", "mesh"].includes(objectType);
    case "text-style":
      return objectType === "text";
    case "video":
    case "image-sequence":
      return objectType === "image";
    case "basic-lit":
    case "pbr":
      return objectType === "mesh";
    default:
      return false;
  }
}

/**
 * The materialSlots key of an object's primary/front face. Kept as the literal
 * "main" so every pre-face scene, published package, and the Rust daemon (which
 * reads material_slots.get("main")) keep resolving their single material. Every
 * object's bindable-face list therefore starts with this slot at index 0.
 */
export const PRIMARY_MATERIAL_SLOT = "main";

export type MaterialFaceKind = "surface" | "cap" | "text-element" | "mesh-element";

/**
 * One bindable material face / element of an object. `index` is the stable
 * position used by the face-index binding API; `slotKey` is the materialSlots
 * key the binding is written to (faces[0].slotKey is always PRIMARY_MATERIAL_SLOT).
 */
export interface MaterialFace {
  index: number;
  slotKey: string;
  label: string;
  kind: MaterialFaceKind;
  primary: boolean;
}

function buildMaterialFaces(defs: ReadonlyArray<readonly [string, string, MaterialFaceKind]>): MaterialFace[] {
  return defs.map(([slotKey, label, kind], index) => ({ index, slotKey, label, kind, primary: index === 0 }));
}

/**
 * The ordered, bindable material faces/elements of an object — the single
 * source of truth shared by the Inspector face list, the central binding API,
 * and per-face rendering. The face vocabulary comes from the object
 * itself (type + meshKind), never hard-coded per call site. faces[0] is always
 * the primary surface at slot "main", so single-material objects are unchanged.
 */
export function getBindableFaces(object: SceneObject): MaterialFace[] {
  if (object.type === "mesh") {
    switch (object.meshKind) {
      case "cube":
      case "slab":
        return buildMaterialFaces([
          [PRIMARY_MATERIAL_SLOT, "Front", "surface"],
          ["face:back", "Back", "surface"],
          ["face:left", "Left", "surface"],
          ["face:right", "Right", "surface"],
          ["face:top", "Top", "surface"],
          ["face:bottom", "Bottom", "surface"]
        ]);
      case "cylinder":
        return buildMaterialFaces([
          [PRIMARY_MATERIAL_SLOT, "Side", "surface"],
          ["face:cap-top", "Top Cap", "cap"],
          ["face:cap-bottom", "Bottom Cap", "cap"]
        ]);
      case "model":
        return buildMaterialFaces([
          [PRIMARY_MATERIAL_SLOT, "Whole Model", "mesh-element"],
          ...(object.materialElements ?? []).map((name, index) =>
            [`element:${index}`, name || `Material ${index + 1}`, "mesh-element"] as const
          )
        ]);
      case "sphere":
      case "torus":
      default:
        return buildMaterialFaces([[PRIMARY_MATERIAL_SLOT, "Surface", "surface"]]);
    }
  }

  if (object.type === "text") {
    // A per-character / per-run model does not exist yet; expose the whole-text
    // element. Structured as a list so text runs can extend it later without a
    // call-site change. The override lives in a material slot, so unbinding it
    // restores the font-style-derived look (see removeMaterialFace).
    return buildMaterialFaces([[PRIMARY_MATERIAL_SLOT, "All Text", "text-element"]]);
  }

  // Flat single-surface primitives — rect (Quad/Background), ellipse (Sphere),
  // image, line, and anything else — bind on their primary surface.
  return buildMaterialFaces([[PRIMARY_MATERIAL_SLOT, "Surface", "surface"]]);
}

/** Resolve a face index to its materialSlots key for the given object. */
export function faceSlotKey(object: SceneObject, faceIndex: number): string | undefined {
  return getBindableFaces(object)[faceIndex]?.slotKey;
}

/**
 * Face-aware compatibility. Mesh faces (cube walls, cylinder caps, etc.) accept
 * any surface material type — the legacy object-type gate in isMaterialCompatible
 * predates faces and only allowed lit/solid materials on `mesh`, which would
 * reject the XPression workflow of texturing a cube face. A bound face is still
 * a flat renderable surface, so only text-style (text-only) is excluded here.
 * Non-mesh objects defer to the existing object-type rule unchanged.
 */
export function isMaterialCompatibleWithFace(material: Material, object: SceneObject, faceIndex: number): boolean {
  if (getBindableFaces(object)[faceIndex] === undefined) {
    return false;
  }
  if (object.type === "mesh") {
    return material.type !== "text-style";
  }
  return isMaterialCompatible(material, object.type);
}

export interface MaterialUsage {
  objectIds: string[];
  objectNames: string[];
  instanceIds: string[];
  assetIds: string[];
  shaderIds: string[];
}

export function findMaterialUsage(scene: SceneDocument, materialId: string): MaterialUsage {
  const objects = scene.objects.filter((object) =>
    Object.values(object.materialSlots).some((binding) => getMaterialBindingId(binding) === materialId)
  );
  const material = findMaterial(scene.materials, materialId);

  return {
    objectIds: objects.map((object) => object.id),
    objectNames: objects.map((object) => object.name),
    instanceIds: (scene.materialInstances ?? [])
      .filter((instance) => instance.baseMaterialId === materialId)
      .map((instance) => instance.materialInstanceId),
    assetIds: material
      ? [...new Set([material.assetId, ...(material.textureSlots ?? []).map((slot) => slot.assetId)].filter((value): value is string => Boolean(value)))]
      : [],
    shaderIds: material?.shaderId ? [material.shaderId] : []
  };
}

export function findAssetUsage(scene: SceneDocument, assetId: string): string[] {
  return findAssetUsageDetails(scene, assetId).materialIds;
}

export interface AssetUsage {
  materialIds: string[];
  shaderIds: string[];
  objectIds: string[];
}

export function findAssetUsageDetails(scene: SceneDocument, assetId: string): AssetUsage {
  const asset = findAsset(scene.assets, assetId);
  const materialIds = scene.materials
    .filter((material) =>
      material.assetId === assetId || material.textureSlots?.some((slot) => slot.assetId === assetId)
    )
    .map((material) => material.materialId);
  const shaderIds = asset?.sourcePath
    ? (scene.shaders ?? []).filter((shader) => shader.sourcePath === asset.sourcePath).map((shader) => shader.shaderId)
    : [];
  const objectIds = scene.objects
    .filter((object) => object.type === "mesh" && object.modelAssetId === assetId)
    .map((object) => object.id);
  return { materialIds, shaderIds, objectIds };
}

export function parameterDefaults(
  definitions: MaterialParameterDefinition[]
): Record<string, MaterialParameterValue> {
  return Object.fromEntries(definitions.map((definition) => [definition.name, definition.default]));
}

export function validateShaderDefinition(shader: ShaderDefinition): string[] {
  const errors: string[] = [];

  if (!shader.shaderId.trim()) errors.push("Shader ID is required.");
  if (!shader.name.trim()) errors.push("Shader name is required.");
  if (!shader.sourcePath.toLowerCase().endsWith(".wgsl")) errors.push("Shader source must be a WGSL file.");
  if (!shader.vertexEntry.trim()) errors.push("Vertex entry point is required.");
  if (!shader.fragmentEntry.trim()) errors.push("Fragment entry point is required.");
  if (shader.supportedPrimitives.length === 0) errors.push("At least one supported primitive is required.");

  const parameterNames = new Set<string>();
  for (const parameter of shader.parameters) {
    if (!parameter.name.trim()) errors.push("Shader parameters require names.");
    if (parameterNames.has(parameter.name)) errors.push(`Duplicate shader parameter ${parameter.name}.`);
    parameterNames.add(parameter.name);
  }

  const textureNames = new Set<string>();
  for (const slot of shader.textureSlots) {
    if (textureNames.has(slot.name)) errors.push(`Duplicate texture slot ${slot.name}.`);
    textureNames.add(slot.name);
  }

  return errors;
}

export function validateMaterialAssetImportDescriptor(
  name: string,
  mimeType: string,
  sizeBytes: number
): string[] {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  const supportedImages = new Set(["png", "jpg", "jpeg", "webp", "svg", "tif", "tiff"]);
  const supportedModels = new Set(["glb", "gltf"]);
  const errors: string[] = [];
  if (!name.trim()) errors.push("File name is required.");
  if (sizeBytes <= 0) errors.push("The file is empty.");
  if (sizeBytes > 50 * 1024 * 1024) errors.push("Files larger than 50 MiB require the future proxy importer.");
  if (!supportedImages.has(extension) && !supportedModels.has(extension) && extension !== "wgsl") {
    errors.push(`.${extension || "unknown"} is not supported by the asset importer.`);
  }
  if (extension === "exr") errors.push("EXR import is reserved for the future linear/HDR loader.");
  if (mimeType.startsWith("video/")) errors.push("Video metadata and shared decoding are not enabled in this first importer.");
  return errors;
}

export interface SceneHistorySnapshot {
  scene: SceneDocument;
  undoStack: SceneDocument[];
  redoStack: SceneDocument[];
}

export function appendSceneHistory(stack: SceneDocument[], scene: SceneDocument, limit = 100): SceneDocument[] {
  return [...stack, scene].slice(-Math.max(1, limit));
}

export function undoSceneHistory(
  scene: SceneDocument,
  undoStack: SceneDocument[],
  redoStack: SceneDocument[]
): SceneHistorySnapshot | null {
  const previous = undoStack.at(-1);
  if (!previous) return null;
  return {
    scene: previous,
    undoStack: undoStack.slice(0, -1),
    redoStack: appendSceneHistory(redoStack, scene)
  };
}

export function redoSceneHistory(
  scene: SceneDocument,
  undoStack: SceneDocument[],
  redoStack: SceneDocument[]
): SceneHistorySnapshot | null {
  const next = redoStack.at(-1);
  if (!next) return null;
  return {
    scene: next,
    undoStack: appendSceneHistory(undoStack, scene),
    redoStack: redoStack.slice(0, -1)
  };
}

export function normalizeMaterialSceneDocument(scene: SceneDocument): SceneDocument {
  return {
    ...scene,
    assets: (scene.assets ?? []).map((asset) => ({
      ...asset,
      status: asset.status ?? "READY",
      alphaMode: asset.alphaMode ?? "unknown",
      colorSpace: asset.colorSpace ?? "srgb",
      tags: asset.tags ?? []
    })),
    materials: (scene.materials ?? []).map(normalizeMaterial),
    materialInstances: scene.materialInstances ?? [],
    shaders: scene.shaders ?? [],
    materialFolders: scene.materialFolders ?? []
  };
}

export function normalizeMaterial(material: Material): Material {
  const timestamp = material.updatedAt ?? material.createdAt ?? new Date(0).toISOString();
  const isStandard = isStandardMaterialWireType(material.type);
  const textureSlots = isStandard
    ? normalizeStandardTextureSlots(material)
    : material.textureSlots ?? defaultTextureSlots(material);
  const authoredParameters = material.parameters ?? {};
  const authoredBaseColor = authoredParameters.baseColor;
  const authoredTint = authoredParameters.tint;
  // Precedence for the unified material: an explicitly authored parameter always
  // outranks the legacy top-level `color` convenience field, whichever alias the
  // scene was written with. baseColor -> tint -> legacy color -> white.
  const baseColor = typeof authoredBaseColor === "string"
    ? authoredBaseColor
    : typeof authoredTint === "string"
      ? authoredTint
      : material.color ?? "#ffffff";
  const parameterOpacity = authoredParameters.opacity;
  const opacity = typeof material.opacity === "number"
    ? material.opacity
    : typeof parameterOpacity === "number"
      ? parameterOpacity
      : 1;
  const parameters: Record<string, MaterialParameterValue> = isStandard
    ? {
      baseColor,
      opacity,
      metalness: 0.08,
      roughness: 0.62,
      emissiveColor: "#000000",
      emissiveIntensity: 0,
      ...authoredParameters
      }
    : {
        baseColor: material.color ?? "#ffffff",
        tint: "#ffffff",
        opacity,
        uvScale: [1, 1],
        uvOffset: [0, 0],
        ...authoredParameters
      };

  return {
    ...material,
    type: isStandard ? CANONICAL_MATERIAL_TYPE : material.type,
    opacity,
    readiness: isStandard && textureSlots.some((slot) => slot.name === "baseTexture" && !slot.assetId)
      ? "MISSING"
      : material.readiness ?? "READY",
    shaderId: isStandard ? "grapix.material.pbr" : material.shaderId ?? defaultShaderId(material.type),
    textureSlots,
    parameters,
    blendMode: material.blendMode ?? "normal",
    alphaMode: material.alphaMode
      ?? (isStandard && textureSlots.some((slot) => slot.name === "baseTexture") ? "straight" : "premultiplied"),
    cullMode: material.cullMode ?? (isStandard ? "back" : "none"),
    depthMode: material.depthMode ?? (isStandard ? "read-write" : "disabled"),
    colorSpace: material.colorSpace ?? "srgb",
    doubleSided: material.doubleSided ?? !isStandard,
    enabled: material.enabled ?? true,
    tags: material.tags ?? [],
    createdAt: material.createdAt ?? timestamp,
    updatedAt: timestamp,
    supportedPrimitives: isStandard
      ? defaultSupportedPrimitives(CANONICAL_MATERIAL_TYPE)
      : material.supportedPrimitives ?? defaultSupportedPrimitives(material.type)
  };
}

export interface CreateStandardMaterialOptions {
  /** Optional image asset assigned to the Standard Material's base texture. */
  baseTextureAssetId?: string;
}

export function createMaterialDefinition(
  name: string,
  options?: CreateStandardMaterialOptions
): Material;
/** @deprecated Material aliases are load-only. New callers should pass options. */
export function createMaterialDefinition(
  name: string,
  legacyType: StandardMaterialWireType,
  legacyAssetId?: string
): Material;
export function createMaterialDefinition(
  name: string,
  optionsOrLegacyType: CreateStandardMaterialOptions | StandardMaterialWireType = {},
  legacyAssetId?: string
): Material {
  const timestamp = new Date().toISOString();
  const assetId = typeof optionsOrLegacyType === "string"
    ? legacyAssetId
    : optionsOrLegacyType.baseTextureAssetId;
  const material: Material = {
    materialId: createSceneId("mat"),
    name,
    type: CANONICAL_MATERIAL_TYPE,
    assetId,
    dynamic: false,
    opacity: 1,
    readiness: "READY",
    shaderId: "grapix.material.pbr",
    parameters: {
      baseColor: "#ffffff",
      opacity: 1,
      metalness: 0.08,
      roughness: 0.62,
      emissiveColor: "#000000",
      emissiveIntensity: 0
    },
    textureSlots: assetId ? [createDefaultTextureSlot("baseTexture", assetId)] : [],
    blendMode: "normal",
    alphaMode: assetId ? "straight" : "premultiplied",
    cullMode: "back",
    depthMode: "read-write",
    colorSpace: "srgb",
    doubleSided: false,
    enabled: true,
    tags: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    supportedPrimitives: ["rect", "ellipse", "text", "image", "mesh"]
  };

  return normalizeMaterial(material);
}

function isStandardMaterialWireType(type: MaterialType): type is StandardMaterialWireType {
  return (STANDARD_MATERIAL_WIRE_TYPES as readonly MaterialType[]).includes(type);
}

function normalizeStandardTextureSlots(material: Material): MaterialTextureSlot[] {
  if (material.textureSlots?.length) {
    return material.textureSlots;
  }
  if (material.type === "image" || material.type === "unlit-texture" || material.assetId) {
    return [createDefaultTextureSlot("baseTexture", material.assetId, material)];
  }
  return [];
}

function defaultShaderId(type: MaterialType): string {
  if (isStandardMaterialWireType(type)) return "grapix.material.pbr";
  return ["image", "svg-vector", "video", "unlit-texture", "image-sequence"].includes(type)
    ? "grapix.material.textured"
    : "grapix.material.solid-colour";
}

function defaultTextureSlots(material: Material): MaterialTextureSlot[] {
  const loadOnlyTextureAlias = material.type === "image" || material.type === "unlit-texture";
  const optionalStandardTexture = isStandardMaterialWireType(material.type) && Boolean(material.assetId);
  if (!loadOnlyTextureAlias
    && !optionalStandardTexture
    && !["svg-vector", "video", "image-sequence"].includes(material.type)) {
    return [];
  }

  return [createDefaultTextureSlot("baseTexture", material.assetId, material)];
}

function createDefaultTextureSlot(
  name: string,
  assetId?: string,
  legacy?: Pick<Material, "wrap" | "sampling">
): MaterialTextureSlot {
  return {
    name,
    assetId,
    fit: "fill",
    wrap: legacy?.wrap === "repeat" ? "repeat" : legacy?.wrap === "mirror" ? "mirror-repeat" : "clamp",
    filtering: legacy?.sampling ?? "linear",
    uvScale: [1, 1],
    uvOffset: [0, 0],
    uvRotation: 0,
    uvPivot: [0.5, 0.5],
    flipX: false,
    flipY: false
  };
}

function defaultSupportedPrimitives(type: MaterialType): SceneObjectType[] {
  if (isStandardMaterialWireType(type)) return ["rect", "ellipse", "text", "image", "mesh"];
  if (["image", "svg-vector", "unlit-texture"].includes(type)) return ["rect", "image", "mesh"];
  if (["video", "image-sequence"].includes(type)) return ["image"];
  if (type === "text-style") return ["text"];
  return ["rect", "ellipse", "text", "image", "mesh"];
}

export function resolveMaterialAsset(
  material: Material,
  assets: AssetLibraryItem[],
  dataContext: Record<string, unknown>
): AssetLibraryItem | undefined {
  if (!material.dynamic || !material.binding) {
    return findAsset(assets, material.assetId);
  }

  const boundValue = resolveDataPath(dataContext, material.binding.path);

  if (material.binding.type === "assetId" && typeof boundValue === "string") {
    return findAsset(assets, boundValue) ?? findAsset(assets, material.binding.fallbackAssetId);
  }

  if (material.binding.type === "url" && typeof boundValue === "string") {
    return {
      assetId: `runtime_${material.materialId}`,
      name: `${material.name} Runtime URL`,
      kind: "image",
      source: boundValue,
      importedAt: new Date().toISOString()
    };
  }

  return findAsset(assets, material.binding.fallbackAssetId ?? material.assetId);
}

export function resolveMaterialColor(
  material: Material,
  dataContext: Record<string, unknown>
): string | undefined {
  if (!material.dynamic || !material.binding) {
    const parameterColor = material.parameters?.baseColor;
    return material.color ?? (typeof parameterColor === "string" ? parameterColor : undefined);
  }

  const boundValue = resolveDataPath(dataContext, material.binding.path);

  if (material.binding.type === "color" && typeof boundValue === "string") {
    return boundValue;
  }

  const parameterColor = material.parameters?.baseColor;
  return material.binding.fallbackColor ?? material.color ?? (typeof parameterColor === "string" ? parameterColor : undefined);
}

export function validateFontDefinition(
  font: FontDefinition,
  assets: AssetLibraryItem[] = []
): string[] {
  const errors: string[] = [];
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(font.fontId)) {
    errors.push("fontId must contain only letters, numbers, underscore, or hyphen.");
  }
  if (!font.family.trim() || font.family.length > 128) {
    errors.push("Font family must contain 1 to 128 characters.");
  }
  if (font.faces.length === 0) {
    errors.push("At least one font face is required.");
  }

  const faceIds = new Set<string>();
  for (const face of font.faces) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(face.faceId)) {
      errors.push(`Font face ${face.faceId || "(empty)"} has an unsafe faceId.`);
    }
    if (faceIds.has(face.faceId)) errors.push(`Duplicate font face ${face.faceId}.`);
    faceIds.add(face.faceId);
    if (face.family !== font.family) {
      errors.push(`Font face ${face.faceId} must use family ${font.family}.`);
    }
    if (!Number.isInteger(face.weight) || face.weight < 1 || face.weight > 1000) {
      errors.push(`Font face ${face.faceId} has an invalid weight.`);
    }
    if (face.source.kind === "file") {
      const assetId = face.source.assetId;
      const asset = assets.find((item) => item.assetId === assetId);
      if (!asset || asset.kind !== "font") {
        errors.push(`Font face ${face.faceId} references missing font asset ${assetId}.`);
      } else if (!asset.checksum) {
        errors.push(`Font asset ${asset.name} must have a checksum.`);
      }
    } else {
      try {
        const url = new URL(face.source.url);
        if (url.protocol !== "https:") {
          errors.push(`Font face ${face.faceId} must use an HTTPS stylesheet URL.`);
        }
        if (!isTrustedFontCssUrl(url.toString())) {
          errors.push(`Font face ${face.faceId} uses an unapproved stylesheet host.`);
        }
        if (face.source.kind === "adobe-fonts" && url.hostname !== "use.typekit.net") {
          errors.push(`Adobe Fonts face ${face.faceId} must use use.typekit.net.`);
        }
      } catch {
        errors.push(`Font face ${face.faceId} has an invalid stylesheet URL.`);
      }
    }
  }
  return errors;
}

/**
 * Build the editor/browser stylesheet for scene fonts. File fonts become
 * @font-face rules; CSS/Adobe sources remain explicit HTTPS @imports so their
 * licensing and network dependency cannot be mistaken for packaged bytes.
 */
export function buildFontCss(
  fonts: FontDefinition[],
  resolveAssetUrl: (assetId: string) => string
): string {
  const imports = new Set<string>();
  const rules: string[] = [];

  for (const font of fonts) {
    for (const face of font.faces) {
      if (face.source.kind === "css-url" || face.source.kind === "adobe-fonts") {
        if (isTrustedFontCssUrl(face.source.url)) {
          imports.add(`@import url("${escapeCssString(face.source.url)}");`);
        }
        continue;
      }
      const sourceUrl = resolveAssetUrl(face.source.assetId);
      rules.push([
        "@font-face {",
        `  font-family: "${escapeCssString(font.family)}";`,
        `  src: url("${escapeCssString(sourceUrl)}") format("${face.source.format === "ttf" ? "truetype" : face.source.format === "otf" ? "opentype" : face.source.format}");`,
        `  font-weight: ${face.weight};`,
        `  font-style: ${face.style};`,
        face.stretch ? `  font-stretch: ${face.stretch};` : "",
        face.unicodeRange ? `  unicode-range: ${face.unicodeRange};` : "",
        "  font-display: swap;",
        "}"
      ].filter(Boolean).join("\n"));
    }
  }
  return [...imports].sort().concat(rules).join("\n\n");
}

export function isTrustedFontCssUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && ["use.typekit.net", "fonts.googleapis.com", "fonts.bunny.net"].includes(url.hostname)
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

function escapeCssString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n\f]/g, "");
}

export function buildScenePackageManifest(
  scene: SceneDocument,
  assets: ScenePackageAssetEntry[]
): ScenePackageManifest {
  const requiredRendererFeatures = new Set<string>(["2d"]);
  const requiredFonts = new Set<string>();
  const requiredShaders = new Set(scene.shaders?.map((shader) => shader.shaderId) ?? []);
  const requiredCodecs = new Set<string>();

  for (const object of scene.objects) {
    if (object.type === "mesh" || object.type === "light" || object.type === "camera") {
      requiredRendererFeatures.add("3d");
    }
    if (object.type === "shape" || object.masks?.length) {
      requiredRendererFeatures.add("vector-paths");
    }
  }
  for (const asset of scene.assets) {
    if (asset.kind === "video" || asset.kind === "image-sequence") {
      requiredRendererFeatures.add(asset.kind);
    }
    if (asset.kind === "font") requiredFonts.add(asset.name);
    if (asset.kind === "script") requiredRendererFeatures.add("scene-script");
    if (asset.codec) requiredCodecs.add(asset.codec);
  }
  for (const font of scene.fonts ?? []) {
    requiredFonts.add(font.family);
    if (font.faces.some((face) => face.source.kind !== "file")) {
      requiredRendererFeatures.add("remote-font-css");
    }
  }
  if (scene.automation?.triggers.length) requiredRendererFeatures.add("scene-automation");
  if (scene.automation?.script?.enabled) requiredRendererFeatures.add("scene-script");
  for (const material of scene.materials) {
    if (material.type === "shader") requiredRendererFeatures.add("custom-shaders");
  }

  return {
    packageVersion: 2,
    minimumRendererProtocolVersion: 2,
    sceneId: scene.id,
    sceneName: scene.name,
    sceneRevision: scene.revision ?? scene.updatedAt,
    createdAt: new Date().toISOString(),
    videoProfile: scene.canvas.width === 3840 && scene.canvas.height === 2160
      ? "PROGRAM_UHD"
      : scene.canvas.width === 1920 && scene.canvas.height === 1080
        ? "PROGRAM_HD"
        : "CUSTOM",
    width: scene.canvas.width,
    height: scene.canvas.height,
    frameRate: { numerator: scene.timeline.fps, denominator: 1 },
    scanMode: "p",
    colorSpace: "srgb",
    alphaMode: "premultiplied",
    requiredRendererFeatures: [...requiredRendererFeatures].sort(),
    requiredFonts: [...requiredFonts].sort(),
    requiredShaders: [...requiredShaders].sort(),
    requiredCodecs: [...requiredCodecs].sort(),
    estimatedMemoryBytes: estimateSceneMemoryBytes(scene),
    fallbackPolicy: "allow-declared-fallbacks",
    files: {
      scene: "scene.json",
      bindings: "bindings.json",
      materials: "materials.json",
      timeline: "timeline.json",
      fonts: scene.fonts?.length ? "fonts.json" : undefined,
      automation: scene.automation ? "automation.json" : undefined,
      metadata: "metadata.json",
      checksums: "checksums.json"
    },
    assets,
    stats: {
      objectCount: scene.objects.length,
      assetCount: assets.length,
      materialCount: scene.materials.length,
      bindingCount: countSceneBindings(scene),
      fontCount: scene.fonts?.length ?? 0,
      triggerCount: scene.automation?.triggers.length ?? 0
    }
  };
}

export function preflightScenePackage(scene: SceneDocument): ScenePackagePreflight {
  const issues: ScenePackageIssue[] = [];
  let readyMaterials = 0;
  let fallbackReadyMaterials = 0;
  let missingMaterials = 0;

  if (scene.version !== 1) {
    issues.push({
      severity: "error",
      code: "SCENE_VERSION_UNSUPPORTED",
      message: `SceneDocument version ${String(scene.version)} is not supported.`
    });
  }
  if (scene.canvas.width <= 0 || scene.canvas.height <= 0) {
    issues.push({
      severity: "error",
      code: "INVALID_CANVAS",
      message: "Canvas width and height must be positive."
    });
  }
  if (scene.timeline.fps <= 0 || scene.timeline.fps > 120) {
    issues.push({
      severity: "error",
      code: "FRAME_RATE_UNSUPPORTED",
      message: `Timeline frame rate ${scene.timeline.fps} is outside the supported 1–120 fps package range.`
    });
  } else if (![24, 25, 30, 50, 60].includes(scene.timeline.fps)) {
    issues.push({
      severity: "warning",
      code: "FRAME_RATE_NONSTANDARD",
      message: `Timeline frame rate ${scene.timeline.fps} fps requires an explicitly matched output profile.`
    });
  }
  const estimatedBytes = estimateSceneMemoryBytes(scene);
  if (estimatedBytes > 1536 * 1024 * 1024) {
    issues.push({
      severity: "error",
      code: "UNSAFE_MEMORY_ESTIMATE",
      message: `Estimated scene memory ${estimatedBytes} bytes exceeds the 1.5 GiB package safety limit.`
    });
  }

  const duplicateIds = findDuplicateSceneIds(scene);
  for (const duplicateId of duplicateIds) {
    issues.push({
      severity: "error",
      code: "DUPLICATE_ID",
      message: `Duplicate scene identifier ${duplicateId}.`
    });
  }

  const fontIds = new Set<string>();
  for (const font of scene.fonts ?? []) {
    if (fontIds.has(font.fontId)) {
      issues.push({
        severity: "error",
        code: "FONT_ID_DUPLICATE",
        message: `Duplicate font definition ${font.fontId}.`
      });
    }
    fontIds.add(font.fontId);
    if (font.status === "MISSING" || font.status === "ERROR") {
      issues.push({
        severity: "error",
        code: "FONT_NOT_READY",
        message: `${font.displayName} is ${font.status.toLowerCase()}.`
      });
    }
    for (const message of validateFontDefinition(font, scene.assets)) {
      issues.push({
        severity: "error",
        code: "FONT_DEFINITION_INVALID",
        message
      });
    }
    if (font.faces.some((face) => face.source.kind !== "file")) {
      issues.push({
        severity: "warning",
        code: "FONT_REQUIRES_NETWORK",
        message: `${font.displayName} uses a remote CSS/Adobe Fonts reference. Package a licensed file face for offline Program reliability.`
      });
    }
  }

  if ((scene.automation?.triggers.length ?? 0) > 256) {
    issues.push({
      severity: "error",
      code: "TRIGGER_LIMIT_EXCEEDED",
      message: "A scene may define at most 256 trigger rules."
    });
  }
  for (const transition of scene.automation?.transitions ?? []) {
    if (!Number.isInteger(transition.durationFrames) || transition.durationFrames < 0 || transition.durationFrames > 600) {
      issues.push({
        severity: "error",
        code: "TRANSITION_DURATION_INVALID",
        message: `${transition.name} must use a duration between 0 and 600 frames.`
      });
    }
    if (transition.kind === "custom" && !transition.shaderId) {
      issues.push({
        severity: "error",
        code: "TRANSITION_SHADER_MISSING",
        message: `${transition.name} is custom but does not declare a shaderId.`
      });
    }
  }
  for (const trigger of scene.automation?.triggers ?? []) {
    if (trigger.actions.length === 0 || trigger.actions.length > 32) {
      issues.push({
        severity: "error",
        code: "TRIGGER_ACTION_LIMIT",
        message: `${trigger.name} must contain between 1 and 32 actions.`
      });
    }
    if (trigger.condition && conditionDepth(trigger.condition) > 16) {
      issues.push({
        severity: "error",
        code: "CONDITION_DEPTH_LIMIT",
        message: `${trigger.name} exceeds the 16-level conditional-expression limit.`
      });
    }
  }
  const script = scene.automation?.script;
  if (script?.enabled) {
    const asset = scene.assets.find((item) => item.assetId === script.assetId && item.kind === "script");
    if (!asset) {
      issues.push({
        severity: "error",
        code: "SCENE_SCRIPT_MISSING",
        message: `Scene script ${script.scriptId} references missing asset ${script.assetId}.`,
        assetId: script.assetId
      });
    } else if (!asset.checksum || asset.checksum !== script.checksum) {
      issues.push({
        severity: "error",
        code: "SCENE_SCRIPT_HASH_MISMATCH",
        message: `Scene script ${script.scriptId} does not match its approved asset checksum.`,
        assetId: script.assetId
      });
    }
  }

  for (const asset of scene.assets) {
    if ((asset.width ?? 0) > 16384 || (asset.height ?? 0) > 16384) {
      issues.push({
        severity: "error",
        code: "TEXTURE_DIMENSION_UNSAFE",
        message: `${asset.name} exceeds the 16384-pixel texture dimension limit.`,
        assetId: asset.assetId
      });
    }
    if (asset.status === "MISSING" || asset.status === "ERROR" || asset.status === "UNSUPPORTED") {
      issues.push({
        severity: "error",
        code: "ASSET_NOT_READY",
        message: `${asset.name} is ${asset.status.toLowerCase()} and cannot be packaged.`,
        assetId: asset.assetId
      });
    }
    if ((asset.kind === "video" || asset.kind === "image-sequence") && !asset.codec) {
      issues.push({
        severity: "warning",
        code: "MEDIA_CODEC_UNVERIFIED",
        message: `${asset.name} has no verified production codec metadata.`,
        assetId: asset.assetId
      });
    }
    if (asset.kind === "video") {
      issues.push({
        severity: "error",
        code: "VIDEO_DECODER_NOT_CERTIFIED",
        message: `${asset.name} cannot publish until its native codec/alpha/colour profile is certified.`,
        assetId: asset.assetId
      });
    }
    if (asset.colorSpace && !["srgb", "unknown"].includes(asset.colorSpace)) {
      issues.push({
        severity: "error",
        code: "COLOR_SPACE_MISMATCH",
        message: `${asset.name} uses ${asset.colorSpace}; the current package/output contract is sRGB.`,
        assetId: asset.assetId
      });
    }
    if (asset.kind === "font" && !asset.checksum) {
      issues.push({
        severity: "error",
        code: "FONT_HASH_MISSING",
        message: `${asset.name} has no content hash.`,
        assetId: asset.assetId
      });
    }
  }

  for (const shader of scene.shaders ?? []) {
    if (shader.validationStatus !== "VALID") {
      issues.push({
        severity: "error",
        code: "SHADER_NOT_READY",
        message: `${shader.name} has not passed shader validation.`
      });
    }
  }

  for (const object of scene.objects) {
    if (object.type === "text" && object.fontAssetId && !scene.assets.some(
      (asset) => asset.assetId === object.fontAssetId && asset.kind === "font"
    )) {
      issues.push({
        severity: "error",
        code: "FONT_MISSING",
        message: `${object.name} references missing font asset ${object.fontAssetId}.`,
        objectId: object.id,
        assetId: object.fontAssetId
      });
    }
    if (["mesh", "light", "camera"].includes(object.type)) {
      issues.push({
        severity: "error",
        code: "NATIVE_3D_RUNTIME_NOT_READY",
        message: `${object.name} requires the native 3D runtime, which is not production-ready.`,
        objectId: object.id
      });
    }
    for (const [property, bindingPath] of Object.entries(object.bindings)) {
      if (!bindingPath?.trim()) {
        issues.push({
          severity: "error",
          code: "BINDING_PATH_INVALID",
          message: `${object.name}.${property} has an empty binding path.`,
          objectId: object.id
        });
      } else if (resolveDataPath(scene.dataContext, bindingPath) === undefined) {
        issues.push({
          severity: "warning",
          code: "BINDING_VALUE_MISSING",
          message: `${object.name}.${property} has no current value at ${bindingPath}; its authored fallback will be used.`,
          objectId: object.id
        });
      }
    }
  }

  for (const object of scene.objects) {
    for (const [slotName, materialBinding] of Object.entries(object.materialSlots)) {
      const materialId = getMaterialBindingId(materialBinding);
      if (!materialId) {
        continue;
      }

      const material = findMaterial(scene.materials, materialId);
      if (!material) {
        issues.push({
          severity: "error",
          code: "MATERIAL_SLOT_NOT_FOUND",
          message: `${object.name} uses missing material ${materialId} in slot ${slotName}.`,
          objectId: object.id,
          materialId
        });
      }
    }
  }

  for (const material of scene.materials) {
    const readiness = getMaterialReadiness(material, scene.assets, scene.dataContext);

    if (readiness === "READY") {
      readyMaterials += 1;
    }

    if (readiness === "FALLBACK_READY") {
      fallbackReadyMaterials += 1;
      issues.push({
        severity: "warning",
        code: "MATERIAL_FALLBACK_READY",
        message: `${material.name} will publish with fallback media for the current data.`,
        materialId: material.materialId,
        assetId: material.binding?.fallbackAssetId ?? material.assetId
      });
    }

    if (readiness === "MISSING" || readiness === "FAILED") {
      missingMaterials += 1;
      issues.push({
        severity: "error",
        code: "MATERIAL_NOT_READY",
        message: `${material.name} is not ready for publish.`,
        materialId: material.materialId,
        assetId: material.assetId
      });
    }
  }

  return {
    ok: !issues.some((issue) => issue.severity === "error"),
    issues,
    readyMaterials,
    fallbackReadyMaterials,
    missingMaterials
  };
}

function findDuplicateSceneIds(scene: SceneDocument): string[] {
  const ids = [
    ...scene.objects.map((object) => object.id),
    ...scene.assets.map((asset) => asset.assetId),
    ...scene.materials.map((material) => material.materialId),
    ...(scene.materialInstances ?? []).map((instance) => instance.materialInstanceId),
    ...(scene.shaders ?? []).map((shader) => shader.shaderId)
  ];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].sort();
}

export function estimateSceneMemoryBytes(scene: SceneDocument): number {
  const canvasBytes = scene.canvas.width * scene.canvas.height * 4 * 3;
  const declaredAssets = scene.assets.reduce((sum, asset) => sum + (asset.sizeBytes ?? 0), 0);
  const decodedImages = scene.assets.reduce((sum, asset) => {
    if (!["image", "svg"].includes(asset.kind) || !asset.width || !asset.height) return sum;
    return sum + asset.width * asset.height * 4;
  }, 0);
  const objectAndMaterialOverhead = (scene.objects.length + scene.materials.length) * 4096;
  return Math.ceil(canvasBytes + declaredAssets + decodedImages + objectAndMaterialOverhead);
}

export function getMaterialReadiness(
  material: Material,
  assets: AssetLibraryItem[],
  dataContext: Record<string, unknown>
): MaterialReadinessState {
  const standard = isStandardMaterialWireType(material.type);
  const baseTextureSlot = material.textureSlots?.find((slot) => slot.name === "baseTexture");
  const textureAssetId = baseTextureSlot?.assetId;
  if (textureAssetId) {
    const textureAsset = findAsset(assets, textureAssetId);
    if (!textureAsset || textureAsset.status === "MISSING" || textureAsset.status === "ERROR" || textureAsset.status === "UNSUPPORTED") {
      return "MISSING";
    }
    return "READY";
  }

  if (baseTextureSlot && !textureAssetId) {
    return "MISSING";
  }

  if (material.type === "solid-color") {
    return resolveMaterialColor(material, dataContext) ? "READY" : "MISSING";
  }

  if (standard && !material.dynamic) {
    if (!material.assetId) {
      return "READY";
    }
    const legacyTexture = findAsset(assets, material.assetId);
    return legacyTexture
      && legacyTexture.status !== "MISSING"
      && legacyTexture.status !== "ERROR"
      && legacyTexture.status !== "UNSUPPORTED"
      ? "READY"
      : "MISSING";
  }

  if (standard && material.binding?.type === "color") {
    const boundColor = resolveDataPath(dataContext, material.binding.path);
    if (typeof boundColor === "string") {
      return "READY";
    }
    return resolveMaterialColor(material, dataContext) ? "FALLBACK_READY" : "MISSING";
  }

  if (!material.dynamic) {
    const asset = findAsset(assets, material.assetId);
    return asset && asset.status !== "MISSING" && asset.status !== "ERROR" && asset.status !== "UNSUPPORTED" ? "READY" : "MISSING";
  }

  if (!material.binding) {
    return "MISSING";
  }

  const boundValue = resolveDataPath(dataContext, material.binding.path);
  const resolvedAsset = resolveMaterialAsset(material, assets, dataContext);

  if (typeof boundValue === "string" && findAsset(assets, boundValue)) {
    return "READY";
  }

  return resolvedAsset ? "FALLBACK_READY" : "MISSING";
}

function countSceneBindings(scene: SceneDocument): number {
  const objectBindings = scene.objects.reduce(
    (count, object) => count + Object.keys(object.bindings).length,
    0
  );
  const materialBindings = scene.materials.filter((material) => material.dynamic && material.binding).length;

  return objectBindings + materialBindings;
}

function conditionDepth(condition: SceneConditionExpression): number {
  switch (condition.kind) {
    case "all":
    case "any":
      return 1 + Math.max(0, ...condition.conditions.map(conditionDepth));
    case "not":
      return 1 + conditionDepth(condition.condition);
    default:
      return 1;
  }
}

function assignBoundValue(object: SceneObject, property: SceneProperty, value: unknown): void {
  switch (property) {
    case "text":
      if (object.type === "text") {
        object.text = String(value);
      }
      break;
    case "src":
      if (object.type === "image") {
        object.src = String(value);
      }
      break;
    case "fill":
    case "stroke":
      if (typeof value === "string") {
        object[property] = value;
      }
      break;
    case "visible":
      object.visible = Boolean(value);
      break;
    case "x":
    case "y":
    case "zDepth":
    case "width":
    case "height":
    case "rotation":
    case "rotationX":
    case "rotationY":
    case "rotationZ":
    case "scaleX":
    case "scaleY":
    case "scaleZ":
    case "opacity":
      if (typeof value === "number") {
        if (property === "rotationX" || property === "rotationY" || property === "rotationZ" || property === "scaleZ") {
          if (object.type === "mesh") {
            object[property] = value;
          }
        } else {
          object[property] = value;
        }
      }
      break;
  }
}

function cryptoRandomSegment(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().slice(0, 8);
  }

  return Math.random().toString(16).slice(2, 10);
}
