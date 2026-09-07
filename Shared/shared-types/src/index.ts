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

// A value import, not just a re-export: `isPropertyAnimatable` below asks the contract whether any
// renderer reads a property. Safe despite the re-export cycle because it is read at call time —
// `propertyRendererSupport.ts` imports only types from here, so nothing runs during this module's init.
import { propertyRendererSupport } from "./propertyRendererSupport.js";

export * from "./designImport.js";
export * from "./aeTime.js";
export * from "./figmaMotion.js";
export * from "./figmaMotionBridge.js";
export * from "./project.js";
export * from "./projectWorkspace.js";
export * from "./bounds.js";
export * from "./propertyRendererSupport.js";
export * from "./propertyConstraints.js";
export * from "./propertySource.js";

export const MESH_PRIMITIVE_KINDS = ["model", "cube", "sphere", "cylinder", "torus", "slab"] as const;
export type MeshPrimitiveKind = typeof MESH_PRIMITIVE_KINDS[number];
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

/**
 * Every blend mode the authoring vocabulary contains, implemented or not.
 *
 * A runtime list with the type derived from it, rather than a bare union, so the *unsupported* set
 * can be computed as this minus `IMPLEMENTED_BLEND_MODES` rather than written out a second time
 * somewhere that can fall behind. Adding a mode here and nowhere else makes it unsupported by
 * construction, which is the safe default.
 */
export const MATERIAL_BLEND_MODES = [
  "normal",
  "add",
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "subtract",
  "alpha-mask",
  "inverse-alpha-mask"
] as const;

export type MaterialBlendMode = (typeof MATERIAL_BLEND_MODES)[number];

/**
 * Blend modes implemented identically in BOTH renderers (PixiJS preview and
 * the Rust render core) as fixed-function GPU blending, using Adobe's
 * standard blend-mode math where it is fixed-function-expressible. The exact
 * per-mode blend equations are the contract in
 * Shared/render-shaders/layouts.json; both renderers mirror PixiJS's
 * premultiplied-alpha equations so preview and program output match.
 *
 * Deliberately excluded until a shader-compositing path exists: "overlay"
 * (PixiJS core silently aliases it to screen — misrepresenting it would
 * violate the no-silent-fallback rule), "subtract", "alpha-mask",
 * "inverse-alpha-mask".
 */
export const IMPLEMENTED_BLEND_MODES = [
  "normal",
  "add",
  "multiply",
  "screen",
  "darken",
  "lighten"
] as const satisfies readonly MaterialBlendMode[];

/**
 * The supported modes as a union, derived from the list rather than restated.
 *
 * This is what lets a renderer's mapping table be keyed on exactly the supported set: adding a mode
 * here without giving it a mapping is a compile error in every renderer that maps them, and
 * removing one leaves an excess key that also fails. `satisfies` above keeps the list checked
 * against `MaterialBlendMode` while preserving the literal types this needs.
 */
export type ImplementedBlendMode = (typeof IMPLEMENTED_BLEND_MODES)[number];

/**
 * Whether a blend mode is one both renderers implement, narrowing the type when it is.
 *
 * A predicate rather than a bare `.includes` so callers get the narrowing: a renderer that has
 * checked this can then index a mapping table without a cast, and one that has not cannot index it
 * at all. That is the whole mechanism preventing an unsupported mode from being quietly drawn as
 * something else.
 */
export function isImplementedBlendMode(
  mode: MaterialBlendMode | undefined
): mode is ImplementedBlendMode {
  return mode !== undefined && (IMPLEMENTED_BLEND_MODES as readonly MaterialBlendMode[]).includes(mode);
}

/**
 * The modes the renderers do not implement, derived rather than restated.
 *
 * Declared *after* `IMPLEMENTED_BLEND_MODES` deliberately. It is computed at module evaluation, so
 * placing it beside `MATERIAL_BLEND_MODES` — where it reads more naturally — put it in the temporal
 * dead zone of the const it filters against, and every import of this package threw
 * "Cannot access 'IMPLEMENTED_BLEND_MODES' before initialization". TypeScript does not catch that.
 */
export const UNIMPLEMENTED_BLEND_MODES: readonly Exclude<MaterialBlendMode, ImplementedBlendMode>[] =
  MATERIAL_BLEND_MODES.filter(
    (mode): mode is Exclude<MaterialBlendMode, ImplementedBlendMode> => !isImplementedBlendMode(mode)
  );
export type MaterialAlphaMode = "opaque" | "straight" | "premultiplied" | "alpha-test" | "alpha-mask";
export type MaterialCullMode = "none" | "front" | "back";
export type MaterialDepthMode = "disabled" | "read" | "read-write";
export type TextureFitMode = "stretch" | "fit" | "fill" | "crop" | "tile" | "original" | "pixel-perfect" | "nine-slice";
export type TextureWrapMode = "clamp" | "repeat" | "mirror-repeat";
export type TextureFilteringMode = "nearest" | "linear";

/**
 * Fit modes whose result is a pure UV scale/offset, so every renderer can honour them with the
 * sampler transform it already has.
 *
 * A cover crop only ever samples a sub-rectangle of the texture (repeat <= 1), which needs no
 * behaviour outside [0,1] and therefore looks identical in the editor preview and the native
 * engine.
 *
 * `tile` is the mirror image of that, and it was excluded for a reason that turned out to be
 * wrong: it samples repeat >= 1 and needs no extra geometry at all, only `repeat` wrapping, which
 * every sampler in the product already has. Nine-slice is the mode that genuinely needs geometry,
 * because its nine regions scale differently from one another.
 *
 * Still excluded: `fit`, `original` and `pixel-perfect` draw the texture *smaller* than the
 * surface, which requires a transparent border. Sampling outside [0,1] smears the edge under clamp
 * and wraps under repeat, so neither wrap mode can express "nothing here" — that needs an alpha
 * cutoff in both renderers' shaders, or the two would disagree. They stay
 * declared-but-unimplemented rather than silently rendering as `stretch`.
 */
export const IMPLEMENTED_TEXTURE_FIT_MODES: readonly TextureFitMode[] = Object.freeze([
  "stretch",
  "fill",
  "crop",
  "tile"
]);

/**
 * The wrap mode a fit mode requires, whatever the author selected.
 *
 * `tile` is the only one that overrides. It works by sampling past 1.0, and under `clamp` that
 * smears the edge row across the whole surface rather than repeating — a result so unlike tiling
 * that drawing it would be the silent-wrong-render this codebase refuses everywhere else. Every
 * other mode samples inside [0,1] and leaves the author's choice untouched.
 *
 * Both renderers call this rather than each deciding for itself: a tile that repeats in the editor
 * and smears in Program is a parity break that would only be found on air.
 */
export function textureWrapForFit(
  mode: TextureFitMode,
  authoredWrap: TextureWrapMode
): TextureWrapMode {
  return mode === "tile" ? "repeat" : authoredWrap;
}

export interface TextureFitSurface {
  surfaceWidth: number;
  surfaceHeight: number;
  textureWidth: number;
  textureHeight: number;
}

export interface TextureFitTransform {
  /** UV span sampled across the surface. 1 means the whole texture. */
  repeat: [number, number];
  /** UV of the sampled rectangle's origin. */
  offset: [number, number];
}

export const TEXTURE_FIT_IDENTITY: TextureFitTransform = Object.freeze({
  repeat: [1, 1] as [number, number],
  offset: [0, 0] as [number, number]
});

/**
 * The UV transform that makes `mode` respect the texture's own resolution on a given surface.
 *
 * This is the single definition of fit for the whole product: the editor's Three and Pixi paths
 * and the native engine all derive their sampler transform here, so Preview and Program cannot
 * disagree about where a texture's edges land. Returns the identity for `stretch` and for any
 * mode outside `IMPLEMENTED_TEXTURE_FIT_MODES`, so an unimplemented mode degrades to today's
 * behaviour instead of producing invented numbers.
 */
export function resolveTextureFit(mode: TextureFitMode, surface: TextureFitSurface): TextureFitTransform {
  const { surfaceWidth, surfaceHeight, textureWidth, textureHeight } = surface;
  // A zero or non-finite extent has no aspect ratio to preserve; stretching is the only answer
  // that cannot divide by zero, and it is what every mode already did.
  if (
    mode === "stretch"
    || !IMPLEMENTED_TEXTURE_FIT_MODES.includes(mode)
    || !(surfaceWidth > 0 && surfaceHeight > 0 && textureWidth > 0 && textureHeight > 0)
    || ![surfaceWidth, surfaceHeight, textureWidth, textureHeight].every(Number.isFinite)
  ) {
    return { repeat: [1, 1], offset: [0, 0] };
  }

  /*
   * Tile: the texture keeps its own pixel size and repeats to fill the surface.
   *
   * `repeat` is how many copies span each axis, so it is simply the surface measured in texture
   * widths. Offset stays at the origin — a tiled pattern is anchored at the surface's top-left the
   * way a wallpaper is, not centred, because centring would put a seam through the middle of the
   * first tile and move it every time the surface resized.
   *
   * A fractional result is correct and wanted: a 300px surface with a 128px texture shows two full
   * copies and a partial third, which is what tiling means.
   */
  if (mode === "tile") {
    return {
      repeat: [surfaceWidth / textureWidth, surfaceHeight / textureHeight],
      offset: [0, 0]
    };
  }

  // Cover: scale the texture until it covers both axes, then centre the crop. The wider-aspect
  // side is the one that overflows, so it is the one sampled short.
  const surfaceAspect = surfaceWidth / surfaceHeight;
  const textureAspect = textureWidth / textureHeight;
  const repeat: [number, number] = textureAspect > surfaceAspect
    ? [surfaceAspect / textureAspect, 1]
    : [1, textureAspect / surfaceAspect];
  return {
    repeat,
    offset: [(1 - repeat[0]) / 2, (1 - repeat[1]) / 2]
  };
}

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

// Easing is one specification with a Rust twin; see `easing.ts`. Re-exported here so
// `SceneKeyframeEasing` stays part of the scene contract's own surface, and imported because
// `export *` does not bring the names into this module's scope.
import { applyEasing, reportAnimationDiagnostic, type SceneKeyframeEasing } from "./easing.js";
export * from "./easing.js";

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
 * Which object kinds Program animates through the **mesh** path.
 *
 * `mesh` is obvious. `shape` is not: a bezier shape is tessellated into a `PreparedMesh` like a
 * real mesh is (`services/render-daemon/src/scene/mesh_prepare.rs`, the `type == "shape"` walk),
 * so the engine patches it with `mesh_transforms` and it inherits every mesh rule. Anything
 * else that draws becomes a `PreparedRect` or a `PreparedText`.
 */
const MESH_PATH_OBJECT_TYPES: readonly SceneObject["type"][] = ["mesh", "shape"];

/**
 * Whether a channel on this property, on this kind of object, is worth offering an author.
 *
 * **Two gates, not one**, and they exist for different reasons:
 *
 * 1. **Program discards the channel per frame.** `zDepth` on a 2D type is paint order, resolved during
 *    preparation, and `services/render-engine/src/animation.rs` drops `AnimatedProperty::Z` rather than
 *    move a value without re-sorting.
 * 2. **No renderer reads the property at all.** A light's `rotation` and a camera's `scaleY` are read by
 *    neither, animated or static, so a channel on them is a curve with no consumer anywhere.
 *
 * Either way the defect is the same and it is the one this rule prevents: the channel animates in the
 * Editor, where `evaluateSceneAtFrame` patches the object and the preview re-resolves every frame, and
 * does nothing on air. The author is shown their animation working. Same family as
 * `IMPLEMENTED_TEXTURE_FIT_MODES`.
 *
 * What this deliberately does **not** decide: whether Program applies a channel to an object kind it
 * animates nowhere. `animation.rs` has no light, camera, container or marker branch, so *no* channel
 * reaches those on air — including a light's `opacity`, which both renderers do read as a dimmer when
 * it is static. Gating every one of them here would delete controls to describe an engine gap, and the
 * repair is an engine that animates them. Recorded as a finding rather than answered by deletion.
 *
 * The rule is the twin of the match arms in `services/render-engine/src/animation.rs`
 * (`apply` for rects and texts, `mesh_transforms` for meshes) and changes with them, in one commit.
 * `fixtures/animatable-properties.json` is the checked-in table both languages assert against.
 *
 * Currently one property is gated:
 *
 * - **`zDepth` on anything not on the mesh path.** For a rect or a text, depth is *paint order*,
 *   resolved when the scene is prepared; the engine discards `AnimatedProperty::Z` for both rather
 *   than move a value without re-sorting. On the mesh path it is a real Z translation and animates
 *   correctly, so it stays authorable there.
 *
 * Deliberately **not** gated here, though the engine also ignores them per frame: `width`, `height`
 * and `opacity` on the mesh path. Those are surface properties the engine bakes during preparation,
 * they reach `shape` objects as well as meshes — where fading a logo is ordinary authoring the
 * preview honours — and the honest repair is an engine that patches prepared surfaces per frame,
 * not an Editor that removes the control. Tracked as a separate decision, not smuggled in here.
 *
 * Object kinds the engine never prepares at all (`camera`, `layer`, `group`, `marker`, `image`, `line`,
 * `paint`) are not decided wholesale here: what a container's animation should mean on air is an open
 * question, and answering it by quietly deleting controls would be a guess. Where a specific property
 * of a specific kind is read by **no** renderer, the contract says so and this returns false — a
 * light's `rotation`, a camera's `scaleY` — because that is a checked fact rather than a guess.
 */
export function isPropertyAnimatable(
  objectType: SceneObject["type"],
  property: AnimatableProperty
): boolean {
  if (property === "zDepth") return MESH_PATH_OBJECT_TYPES.includes(objectType);
  /*
   * A channel on a property no renderer reads is a curve that draws nothing.
   *
   * This used to return `true` for everything but `zDepth`, so the Timeline offered a camera's `scaleY`
   * and a light's `rotation` — keys an author could set, ease and scrub, with no effect anywhere. The
   * Inspector had reached the right answer separately by hiding those controls behind a
   * `supportsDetailedTransform` flag, which is two homes for one question and is how they disagreed
   * about a light's `opacity`: hidden by the panel, and honoured by *both* renderers as a dimmer.
   *
   * `PROPERTY_RENDERER_SUPPORT` is the home. `neither` means no renderer reads it, so there is nothing
   * to animate; anything else — `both`, `preview`, `program`, `editor` — leaves a channel meaningful to
   * at least one consumer, and the support note says which.
   */
  return propertyRendererSupport(objectType, property)?.support !== "neither";
}

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
 *
 * `context` names the object and property in any diagnostic the sample raises. It is optional
 * because a caller sampling a bare channel has nothing to name, and a missing name is worth
 * less than a missing report.
 */
export function sampleChannel(
  channel: PropertyChannel,
  frame: number,
  context: { objectId?: string; property?: string } = {}
): number | undefined {
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
    : easeKeyframeT(t, lo.easing, { frame, ...context });
  // An unimplemented easing holds the outgoing key's value rather than guessing a curve.
  if (eased === undefined) return lo.value;
  return lo.value + (hi.value - lo.value) * eased;
}

/**
 * Sample every enabled numeric property channel on an object that Program actually honours.
 *
 * A channel `isPropertyAnimatable` rejects is skipped rather than patched, so Preview shows what
 * Program will show. Skipping here rather than refusing to store the channel is deliberate: a scene
 * authored before the gate keeps its keys, `preflightScenePackage` reports them, and the author
 * decides — nothing is silently rewritten on load.
 */
export function evaluatePropertyChannelsAtFrame(
  object: SceneObject,
  frame: number
): Partial<Record<AnimatableProperty, number>> {
  const patch: Partial<Record<AnimatableProperty, number>> = {};

  for (const property of ANIMATABLE_PROPERTIES) {
    const channel = object.animation?.[property];
    if (!channel) continue;
    if (!isPropertyAnimatable(object.type, property)) continue;
    const value = sampleChannel(channel, frame, { objectId: object.id, property });
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

/**
 * Exact broadcast frame rate.
 *
 * Broadcast rates are rational, not decimal: 29.97 is 30000/1001 and 59.94 is
 * 60000/1001. Storing them as floats accumulates drift over a long show, so the
 * durable contract carries the pair and the frame clock does integer maths on
 * it. `SceneTimeline.fps` remains the legacy approximate value.
 */
export interface RationalFrameRate {
  numerator: number;
  denominator: number;
}

export type SceneTimelineMarkerKind =
  | "marker"
  | "continue-point"
  | "pause-point"
  | "in"
  | "out"
  | "loop-start"
  | "loop-end";

/**
 * Named point on the scene timeline.
 *
 * Continue points are where a scene waits for an operator `Continue`; pause
 * points stop playback without ending the scene. Both are frame-addressed so
 * browser preview and the native engine agree exactly.
 */
export interface SceneTimelineMarker {
  markerId: string;
  name: string;
  kind: SceneTimelineMarkerKind;
  frame: number;
}

export interface SceneTimeline {
  fps: number;
  durationFrames: number;
  keyframes: SceneKeyframe[];
  /** Exact rate. Absent on legacy documents; derive from `fps` when missing. */
  frameRate?: RationalFrameRate;
  /** Named markers, continue points, and pause points. */
  markers?: SceneTimelineMarker[];
}

export type FontSource =
  | {
      kind: "file";
      assetId: string;
      format: "otf" | "ttf" | "woff" | "woff2";
      /** Original public URL when this face was resolved and cached from CSS. */
      originalUrl?: string;
      /** Stylesheet/project URL that declared this cached face. */
      stylesheetUrl?: string;
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
    }
  | {
      kind: "direct-url";
      url: string;
      format?: "otf" | "ttf" | "woff" | "woff2";
    };

export type FontLoadStatus =
  | "LOADING"
  | "READY"
  | "MISSING"
  | "INVALID"
  | "UNSUPPORTED"
  | "UNVERIFIED"
  | "ERROR";

export interface FontFaceDefinition {
  faceId: string;
  family: string;
  weight: number;
  style: "normal" | "italic" | "oblique";
  stretch?: string;
  unicodeRange?: string;
  source: FontSource;
  status?: FontLoadStatus;
  errorMessage?: string;
}

export interface FontDefinition {
  fontId: string;
  family: string;
  displayName: string;
  faces: FontFaceDefinition[];
  fallbackFamilies: string[];
  embeddingPolicy: "package" | "reference" | "restricted";
  license?: string;
  enabled?: boolean;
  sourceLabel?: string;
  status: FontLoadStatus;
  errorMessage?: string;
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

// --- Playout operator documents -------------------------------------------
//
// The operator model is Ross XPression's, not a newsroom rundown's. Two surfaces:
//
//   Scene Manager   every published scene, grouped by category, each with a numeric
//                   Take ID. An operator recalls a scene straight to air by typing its
//                   number. This is the primary surface and it needs no playlist.
//   Take List       an ordered list of takes for a scripted show, with a cursor and
//                   Take In / Continue / Take Out.
//
// What was deliberately removed with the rundown: segments (grouping is the Scene
// Manager's category), per-item page numbers (superseded by the scene's Take ID) and
// document revisions (a take list autosaves; it is not a versioned publication).

export const PLAYOUT_TAKE_STATES = [
  "NOT_LOADED",
  "LOADING",
  "LOADED",
  "CUED",
  "IN_PREVIEW",
  "TAKING_ONLINE",
  "ONLINE",
  "CONTINUING",
  "TAKING_OFFLINE",
  "OFFLINE",
  "MISSING_ASSET",
  "DISCONNECTED",
  "ERROR"
] as const;

export type PlayoutTakeState = (typeof PLAYOUT_TAKE_STATES)[number];

export interface PublishedSceneMetadata {
  sceneId: string;
  name: string;
  version: number;
  sceneRevision: string;
  thumbnailDataUrl?: string;
  durationFrames: number;
  frameRateNumerator: number;
  frameRateDenominator: number;
  /**
   * Scene resolution at publish time, governed by the project settings.
   *
   * Carried in the metadata so Playout can configure an output at the right size
   * without opening the document. Absent on scenes published before this field
   * existed; treat a missing value as unknown rather than assuming 1920x1080.
   */
  canvasWidth?: number;
  canvasHeight?: number;
  /** Project colour space, so an output can tag its stream correctly. */
  colorSpace?: string;
  defaultTransition: "cut" | "mix" | "dip" | "wipe" | "push";
  /**
   * The Scene Manager recall number.
   *
   * XPression's Take ID: an operator types it to put this scene on air without any list.
   * Assigned by Playout on first publish and stable across republishes, so a rehearsed
   * number does not change under an operator when a designer republishes mid-show.
   */
  takeId: number;
  tags: string[];
  category?: string;
  sourceEditorId?: string;
  sourceEndpoint?: string;
  packageChecksum: string;
  publishedAt: string;
  updatedAt: string;
  validationStatus: "ready" | "warning" | "invalid";
  assetReadiness: "ready" | "missing" | "checking";
  requiredCapabilities: string[];
  estimatedMemoryBytes?: number;
}

export interface PublishedSceneVersion extends PublishedSceneMetadata {
  scene: SceneDocument;
}

export interface PlayoutTransition {
  type: "cut" | "mix" | "dip" | "wipe" | "push";
  durationFrames: number;
  delayFrames: number;
}

/** One entry in a Take List. */
export interface PlayoutTakeEntry {
  /** Identity within the list. Not the scene's Take ID. */
  entryId: string;
  sceneId: string;
  sceneVersion: number;
  /**
   * `pinned` keeps rendering the version the operator rehearsed even after a republish.
   * `latest` follows the newest published version.
   */
  versionPolicy: "pinned" | "latest";
  /** Editable label. Defaults to the scene name. */
  name: string;
  layer: string;
  transitionIn: PlayoutTransition;
  transitionOut: PlayoutTransition;
  /** Overrides the published scene's data without changing the published scene. */
  instanceData: Record<string, unknown>;
  notes: string;
  color: string;
  completed: boolean;
}

/**
 * An ordered list of takes.
 *
 * Autosaved, not published: it has no revision number because it is operator working
 * state, not a versioned artifact. The published scenes it points at are the immutable
 * things.
 */
export interface PlayoutTakeList {
  takeListId: string;
  name: string;
  version: 1;
  /** The entry Take In will operate on. Null when the list has been run to the end. */
  cursorEntryId: string | null;
  entries: PlayoutTakeEntry[];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PlayoutRuntimeStatus {
  rendererConnection: "connected" | "connecting" | "disconnected" | "error";
  /**
   * What is on Preview and Program.
   *
   * A take-list entry id when the operator worked from the list, or `scene:<sceneId>` when
   * they recalled a scene directly from the Scene Manager by Take ID — because a direct
   * recall has no list entry, and reporting a fake one would make the UI highlight a row
   * that is not what is on air.
   */
  previewRef: string | null;
  programRef: string | null;
  takeStates: Record<string, PlayoutTakeState>;
  lastError: string | null;
  updatedAt: string;
}

// --- Animation evaluation -------------------------------------------------
// Runtime the timeline currently lacks: interpolate keyframes into a concrete
// scene the renderer can draw. Built on today's scalar-snapshot keyframe model;
// the typed per-property Animatable<T> model (see docs/3d-engine-architecture.md
// §A) will extend this with typed values incl. animatable bezier paths.

/**
 * Ease a normalised segment position, reporting an easing nobody implements.
 *
 * Returns `undefined` for an unrecognised name so the caller can hold the previous value.
 * Substituting linear was the old behaviour and it is the wrong one: a scene authored against
 * an easing this build does not have then animates, smoothly and confidently, along a curve
 * the designer never chose — and nothing anywhere says so.
 */
function easeKeyframeT(
  t: number,
  easing: SceneKeyframeEasing,
  context: { frame: number; objectId?: string; property?: string }
): number | undefined {
  const eased = applyEasing(easing, t);
  if (eased === undefined) {
    reportAnimationDiagnostic({
      code: "animation.unknown-easing",
      message: `Easing "${String(easing)}" is not implemented by this build; the previous value is held.`,
      value: String(easing),
      frame: context.frame,
      ...(context.objectId ? { objectId: context.objectId } : {}),
      ...(context.property ? { property: context.property } : {})
    });
  }
  return eased;
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
    const eased = span <= 0 ? 1 : easeKeyframeT((frame - lo.frame) / span, lo.easing, {
      frame,
      objectId: lo.objectId,
      property
    });
    // Unknown easing holds the outgoing key, matching `sampleChannel`.
    patch[property] = eased === undefined
      ? lo.properties[property]
      : interpolateKeyframeProperty(property, lo.properties[property], hi.properties[property], eased);
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
    || (object.type === "shape" && Boolean(object.pathAnimation?.length))
    || (object.type === "shape" && Boolean(
      object.trimAnimation?.start?.length
      || object.trimAnimation?.end?.length
      || object.trimAnimation?.offset?.length
    ))
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
      const shapeEvaluated = evaluated.type === "shape" && evaluated.pathAnimation?.length
        ? ({ ...evaluated, path: sampleShapePath(evaluated.pathAnimation, frame) ?? evaluated.path } as SceneObject)
        : evaluated;
      const trimEvaluated = shapeEvaluated.type === "shape" && shapeEvaluated.trimAnimation
        ? ({
            ...shapeEvaluated,
            trimStart: sampleMaskNumber(shapeEvaluated.trimAnimation.start, frame) ?? shapeEvaluated.trimStart,
            trimEnd: sampleMaskNumber(shapeEvaluated.trimAnimation.end, frame) ?? shapeEvaluated.trimEnd,
            trimOffset: sampleMaskNumber(shapeEvaluated.trimAnimation.offset, frame) ?? shapeEvaluated.trimOffset
          } as SceneObject)
        : shapeEvaluated;
      return trimEvaluated.masks?.some((mask) => mask.animation)
        ? ({ ...trimEvaluated, masks: trimEvaluated.masks.map((mask) => evaluateMaskAtFrame(mask, frame)) } as SceneObject)
        : trimEvaluated;
    })
  };
}

function sampleShapePath(keys: PathKeyframe[] | undefined, frame: number): BezierPath | undefined {
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
  /**
   * Photoshop-style layer styles, in the order they composite.
   *
   * First-class scene data: the inspector lists them, preflight audits them and
   * `validateSceneEffects` reports every enabled one no renderer draws. Absent
   * means the object has no styles, which is not the same as having disabled ones.
   */
  effects?: ObjectEffect[];
  /** Photoshop Blending Options: fill opacity, knockout, blend-if. */
  blendingOptions?: ObjectBlendingOptions;
  /** Round-trippable source metadata retained by the professional design importer. */
  importedDesign?: {
    sourceFormat: "psd" | "ai" | "svg" | "figma-json" | "figma-mcp" | "aep";
    sourceName: string;
    sourceNodeId?: string;
    sourceNodeType: string;
    fillOpacity?: number;
    clipping?: boolean;
    componentId?: string;
    componentProperties?: Record<string, unknown>;
    responsiveLayout?: Record<string, unknown>;
    /**
     * Verbatim importer effect records. Superseded by the typed `effects` above
     * for anything that reads them; kept because it round-trips source fields
     * the typed model does not name.
     */
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
  autoFit?: "none" | "shrink" | "fit";
  writingMode?: "horizontal-tb" | "vertical-rl" | "vertical-lr";
  verticalAlign?: "top" | "middle" | "bottom";
  direction?: "auto" | "ltr" | "rtl";
  fontSize: number;
  /** Stable project-registry reference. fontFamily remains for old projects and fallback. */
  fontId?: string;
  fontFamily: string;
  fontAssetId?: string;
  fallbackFamilies?: string[];
  fontWeight: string;
  fontStyle?: "normal" | "italic" | "oblique";
  textDecoration?: {
    underline?: boolean;
    strikethrough?: boolean;
  };
  /**
   * Case applied when the text is drawn, not when it is typed.
   *
   * The authored characters stay as they are, which is what separates this from retyping them: a data
   * binding can replace the text and the case still applies, and switching it off returns the
   * author's own capitalisation. `small-caps` is approximated as upper case by both renderers.
   */
  textCase?: "original" | "upper" | "lower" | "title" | "small-caps";
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

// --- Trim Paths ------------------------------------------------------------
// One definition of "the stroke from start% to end% of a bezier path" for both
// renderers. The editor's Pixi viewport and the native engine's tessellator each
// flatten a path before stroking it; if each derived the trim window its own way
// the two would disagree about where a cut lands on a curve, the same class of
// divergence rule 18 exists to catch. So the trim operates on a flattened
// polyline here, in f64, and each renderer tessellates the result.

/** A flattened polyline: the points a path's stroke passes through, in order. */
export type FlattenedPath = Vec2[];

/**
 * Flatten one bezier path to a polyline, adaptive on flatness.
 *
 * `tolerance` is the maximum allowed distance between the curve and its chord, in
 * object-local pixels; 0.5px is below what either renderer can show at 100% zoom.
 * A closed path's polyline does not repeat the first point — `closed` stays on the
 * source path and the caller closes explicitly.
 */
export function flattenBezierPath(path: BezierPath, tolerance = 0.5): FlattenedPath {
  const { vertices, inTangents, outTangents, closed } = path;
  const count = vertices.length;
  if (count === 0) return [];
  const points: FlattenedPath = [{ x: vertices[0].x, y: vertices[0].y }];
  const segments = closed ? count : count - 1;
  for (let index = 0; index < segments; index += 1) {
    const from = vertices[index];
    const to = vertices[(index + 1) % count];
    const out = outTangents[index] ?? { x: 0, y: 0 };
    const inn = inTangents[(index + 1) % count] ?? { x: 0, y: 0 };
    flattenCubicSegment(
      from,
      { x: from.x + out.x, y: from.y + out.y },
      { x: to.x + inn.x, y: to.y + inn.y },
      to,
      tolerance,
      points
    );
  }
  return points;
}

function flattenCubicSegment(
  p0: Vec2,
  p1: Vec2,
  p2: Vec2,
  p3: Vec2,
  tolerance: number,
  out: FlattenedPath,
  depth = 0
): void {
  // de Casteljau subdivision, bounded so a degenerate curve cannot recurse forever.
  if (depth >= 16 || cubicIsFlat(p0, p1, p2, p3, tolerance)) {
    out.push({ x: p3.x, y: p3.y });
    return;
  }
  const mid = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const p01 = mid(p0, p1);
  const p12 = mid(p1, p2);
  const p23 = mid(p2, p3);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const p0123 = mid(p012, p123);
  flattenCubicSegment(p0, p01, p012, p0123, tolerance, out, depth + 1);
  flattenCubicSegment(p0123, p123, p23, p3, tolerance, out, depth + 1);
}

function cubicIsFlat(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, tolerance: number): boolean {
  // Both control points near the chord: the curve is within tolerance of its line.
  const chordX = p3.x - p0.x;
  const chordY = p3.y - p0.y;
  const chordLength = Math.hypot(chordX, chordY);
  if (chordLength === 0) {
    return Math.hypot(p1.x - p0.x, p1.y - p0.y) <= tolerance
      && Math.hypot(p2.x - p0.x, p2.y - p0.y) <= tolerance;
  }
  const distance = (p: Vec2) => Math.abs(chordX * (p0.y - p.y) - (p0.x - p.x) * chordY) / chordLength;
  return distance(p1) <= tolerance && distance(p2) <= tolerance;
}

/** Total length of a flattened path, closing the loop when the source path is closed. */
export function flattenedPathLength(points: FlattenedPath, closed: boolean): number {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  if (closed && points.length > 2) {
    length += Math.hypot(points[0].x - points[points.length - 1].x, points[0].y - points[points.length - 1].y);
  }
  return length;
}

/** Whether an authored trim changes the stroke at all — 0→100 with no offset is the whole path. */
export function trimPathsActive(start: number | undefined, end: number | undefined, offset: number | undefined): boolean {
  const s = start ?? 0;
  const e = end ?? 100;
  const o = offset ?? 0;
  return !(s === 0 && e === 100 && o % 100 === 0);
}

/**
 * Cut the `start`–`end` window out of a flattened path, rotated by `offset`.
 *
 * AE semantics, one definition for both renderers:
 * - `start`, `end`, `offset` are percentages of the path's total length.
 * - The window is computed first, then rotated by `offset` (negative shifts backward).
 * - On a closed path the window may wrap the seam; on an open path it is clamped.
 * - `start > end` inverts: the result is the complement, as separate pieces.
 * - Returns one polyline per piece — a wrapped window on a closed path is two.
 *   An empty window returns no pieces; the caller draws no stroke, which is what
 *   distinguishes a 0%-wide trim from a path that was never authored.
 */
export function trimFlattenedPath(
  points: FlattenedPath,
  closed: boolean,
  start: number,
  end: number,
  offset: number
): FlattenedPath[] {
  if (points.length < 2) return [];
  const total = flattenedPathLength(points, closed);
  if (total <= 0) return [];

  // Offset rotates the measuring origin before any cut is taken, so a wrapped window is an
  // ordinary window on a rotated walk of the same loop. On an open path there is no loop to
  // rotate around; the trim simply clamps at the ends, matching AE's open-path behaviour.
  const rotation = ((offset % 100) + 100) % 100;
  const base = closed && rotation !== 0 ? rotateClosedWalk(points, rotation / 100 * total) : points;
  const sliceClosed = closed && rotation !== 0 ? false : closed;

  const clamp = (percent: number) => Math.max(0, Math.min(100, percent)) / 100 * total;
  const inverted = start > end;
  const from = inverted ? clamp(end) : clamp(start);
  const to = inverted ? clamp(start) : clamp(end);

  const window_ = sliceFlattenedPath(base, sliceClosed, total, from, to);
  if (!inverted) return window_.length >= 2 ? [window_] : [];

  // Inverted: everything before `from` and everything after `to`, as two pieces.
  const pieces: FlattenedPath[] = [];
  const head = sliceFlattenedPath(base, sliceClosed, total, 0, from);
  const tail = sliceFlattenedPath(base, sliceClosed, total, to, total);
  if (head.length >= 2) pieces.push(head);
  if (tail.length >= 2) pieces.push(tail);
  return pieces;
}

/**
 * Re-walk a closed path starting `distance` along it, returning one open polyline that
 * covers the whole loop exactly once (the cut point appears at both ends). Slicing that
 * polyline as open is then the wrapped-window case for free.
 */
function rotateClosedWalk(points: FlattenedPath, distance: number): FlattenedPath {
  const total = flattenedPathLength(points, true);
  const start = pointAtDistance(points, true, total, distance);
  // Continue from the vertex after the cut point, around the loop and back to it. `remainder`
  // is the vertices after the cut in path order; the ones before it follow the seam.
  const startIndex = points.length - start.remainder.length;
  const order = [...points.slice(startIndex), ...points.slice(0, startIndex)];
  const walked: FlattenedPath = [start.point];
  let covered = 0;
  for (const vertex of order) {
    if (covered >= total) break;
    const last = walked[walked.length - 1];
    const step = Math.hypot(vertex.x - last.x, vertex.y - last.y);
    if (covered + step >= total) {
      const t = step === 0 ? 0 : (total - covered) / step;
      walked.push({ x: last.x + (vertex.x - last.x) * t, y: last.y + (vertex.y - last.y) * t });
      break;
    }
    walked.push(vertex);
    covered += step;
  }
  return walked;
}

/** Walk a flattened path and return the point at `distance`, plus the points still ahead. */
function pointAtDistance(
  points: FlattenedPath,
  closed: boolean,
  total: number,
  distance: number
): { point: Vec2; remainder: FlattenedPath } {
  const d = closed ? ((distance % total) + total) % total : Math.max(0, Math.min(total, distance));
  let walked = 0;
  const count = points.length;
  const segments = closed ? count : count - 1;
  for (let index = 0; index < segments; index += 1) {
    const from = points[index];
    const to = points[(index + 1) % count];
    const step = Math.hypot(to.x - from.x, to.y - from.y);
    if (walked + step >= d) {
      const t = step === 0 ? 0 : (d - walked) / step;
      return {
        point: { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t },
        remainder: points.slice(index + 1)
      };
    }
    walked += step;
  }
  return { point: points[closed ? 0 : points.length - 1], remainder: closed ? points.slice(1) : [] };
}

/** The polyline between two arc-length positions. Open paths clamp; closed paths wrap the seam. */
function sliceFlattenedPath(
  points: FlattenedPath,
  closed: boolean,
  total: number,
  from: number,
  to: number
): FlattenedPath {
  const start = pointAtDistance(points, closed, total, from);
  const end = pointAtDistance(points, closed, total, to);
  if (to <= from) return [];
  const between: Vec2[] = [];
  // Collect the vertices strictly inside the window. On a closed path with from > to the
  // window wraps, which rotateFlattenedPath has already normalised away, so a straight
  // distance comparison is correct here.
  let walked = 0;
  const count = points.length;
  const segments = closed ? count : count - 1;
  for (let index = 0; index < segments; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % count];
    const step = Math.hypot(b.x - a.x, b.y - a.y);
    const next = walked + step;
    if (next > from && next < to) between.push(b);
    walked = next;
  }
  return [start.point, ...between, end.point];
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
  /** Per-frame path keyframe sequence (shape/path morphing). */
  pathAnimation?: PathKeyframe[];
  /**
   * AE-style Trim Paths, as percentages of the total path length: the stroke draws from
   * `trimStart` to `trimEnd`, rotated by `trimOffset`. Absent or 0/100/0 draws the whole
   * stroke. The trimmed window is stroke-only — the fill always covers the full region,
   * which is what AE does and what separates a wipe reveal from a scaling mask.
   */
  trimStart?: number;
  trimEnd?: number;
  trimOffset?: number;
  /** Per-property stopwatches for the trim values, sampled per frame at evaluation. */
  trimAnimation?: TrimPathsAnimation;
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
  /**
   * Asset holding this mask's alpha channel, for masks whose shape is a bitmap
   * rather than a path (a Photoshop layer mask, for example). Neither renderer
   * samples it yet; a mask carrying one is authored with `mode: "none"` so the
   * layer renders unmasked rather than clipped by the wrong shape.
   */
  alphaAssetId?: string;
}

/* ---------------------------------------------------------------------------
   Layer styles / effects

   The complete Photoshop "fx" set, modelled as first-class scene data rather
   than provenance. Before this existed the design importer read every layer
   style out of the PSD and then dropped it into `importedDesign.effects` as an
   opaque `Record<string, unknown>`: the information survived a round trip and
   nothing else in the system could see it — not the inspector, not preflight,
   not the capability audit, not a renderer that might one day draw it.
   --------------------------------------------------------------------------- */

/** Photoshop's ten layer styles, in the order its Layer Style dialog lists them. */
export type ObjectEffectType =
  | "bevel-emboss"
  | "stroke"
  | "inner-shadow"
  | "inner-glow"
  | "satin"
  | "color-overlay"
  | "gradient-overlay"
  | "pattern-overlay"
  | "outer-glow"
  | "drop-shadow";

/**
 * Effects both renderers draw.
 *
 * Deliberately empty. Every layer style needs a multi-pass shader compositing
 * path that neither the PixiJS preview nor the Rust core has, and the same rule
 * that governs `IMPLEMENTED_BLEND_MODES` governs this: a scene may carry an
 * effect, and `validateSceneEffects` reports it, but nothing pretends to draw
 * it. An effect silently ignored looks like a renderer bug; an effect reported
 * as unimplemented is a known gap with a name.
 */
export const IMPLEMENTED_OBJECT_EFFECTS: readonly ObjectEffectType[] = Object.freeze([]);

/** A Photoshop contour curve: control points in a 0..1 square. */
export interface EffectContour {
  name?: string;
  curve: Vec2[];
}

/** Shared by every effect, so a consumer can list and toggle them without narrowing. */
export interface ObjectEffectBase {
  id: string;
  type: ObjectEffectType;
  /** Photoshop keeps switched-off styles in the file; a disabled effect contributes no pixels. */
  enabled: boolean;
  blendMode?: MaterialBlendMode;
  opacity?: number;
  /**
   * The authored Photoshop mode when it has no `MaterialBlendMode` equivalent.
   * Kept so a round trip back to Photoshop restores what the designer chose,
   * rather than the mode GrapiX substituted.
   */
  sourceBlendMode?: string;
  /** Verbatim source parameters, for a round trip and for anything not modelled above. */
  sourceData?: Record<string, unknown>;
}

export interface DropShadowEffect extends ObjectEffectBase {
  type: "drop-shadow";
  color: string;
  /** Degrees. Photoshop's global light angle when `useGlobalLight` is set. */
  angle: number;
  useGlobalLight?: boolean;
  /** Photoshop "Distance": offset along `angle`. `offset` is the resolved x/y. */
  distance: number;
  offset?: Vec2;
  /** Photoshop "Spread" (choke), 0..1. */
  spread: number;
  /** Photoshop "Size": blur radius in pixels. */
  size: number;
  noise?: number;
  antialiased?: boolean;
  contour?: EffectContour;
  /** Photoshop "Layer Knocks Out Drop Shadow". */
  layerConceals?: boolean;
}

export interface InnerShadowEffect extends ObjectEffectBase {
  type: "inner-shadow";
  color: string;
  angle: number;
  useGlobalLight?: boolean;
  distance: number;
  offset?: Vec2;
  /** Photoshop "Choke", 0..1. */
  choke: number;
  size: number;
  noise?: number;
  antialiased?: boolean;
  contour?: EffectContour;
}

export interface OuterGlowEffect extends ObjectEffectBase {
  type: "outer-glow";
  /** A glow may be a flat colour or a gradient; `paint` wins when present. */
  color?: string;
  paint?: ColorValue;
  technique?: "softer" | "precise";
  spread: number;
  size: number;
  range?: number;
  jitter?: number;
  noise?: number;
  antialiased?: boolean;
  contour?: EffectContour;
}

export interface InnerGlowEffect extends ObjectEffectBase {
  type: "inner-glow";
  color?: string;
  paint?: ColorValue;
  technique?: "softer" | "precise";
  /** Photoshop "Source": a centre glow and an edge glow are different pictures. */
  source?: "edge" | "center";
  choke: number;
  size: number;
  range?: number;
  jitter?: number;
  noise?: number;
  antialiased?: boolean;
  contour?: EffectContour;
}

export interface BevelEmbossEffect extends ObjectEffectBase {
  type: "bevel-emboss";
  style: "outer-bevel" | "inner-bevel" | "emboss" | "pillow-emboss" | "stroke-emboss";
  technique?: "smooth" | "chisel-hard" | "chisel-soft";
  /** Photoshop "Depth", 0..n where 1 is 100%. */
  depth: number;
  direction: "up" | "down";
  size: number;
  soften: number;
  angle: number;
  altitude: number;
  useGlobalLight?: boolean;
  highlightColor: string;
  highlightBlendMode?: MaterialBlendMode;
  highlightOpacity: number;
  shadowColor: string;
  shadowBlendMode?: MaterialBlendMode;
  shadowOpacity: number;
  glossContour?: EffectContour;
  antialiasGloss?: boolean;
  /** The Contour and Texture sub-effects, which Photoshop nests under Bevel & Emboss. */
  contourEnabled?: boolean;
  contour?: EffectContour;
  contourRange?: number;
  textureEnabled?: boolean;
  texturePatternName?: string;
  texturePatternAssetId?: string;
  textureScale?: number;
  textureDepth?: number;
  textureInvert?: boolean;
  textureLinked?: boolean;
}

export interface SatinEffect extends ObjectEffectBase {
  type: "satin";
  color: string;
  angle: number;
  distance: number;
  size: number;
  invert?: boolean;
  antialiased?: boolean;
  contour?: EffectContour;
}

export interface ColorOverlayEffect extends ObjectEffectBase {
  type: "color-overlay";
  color: string;
  paint?: ColorValue;
}

export interface GradientOverlayEffect extends ObjectEffectBase {
  type: "gradient-overlay";
  paint?: ColorValue;
  style?: "linear" | "radial" | "angle" | "reflected" | "diamond";
  angle: number;
  scale?: number;
  offset?: Vec2;
  reverse?: boolean;
  dither?: boolean;
  /** Photoshop "Align with Layer". */
  alignWithLayer?: boolean;
}

export interface PatternOverlayEffect extends ObjectEffectBase {
  type: "pattern-overlay";
  patternName?: string;
  /**
   * The pattern's pixels, once the importer has stored them. Photoshop patterns
   * live in the file's pattern table rather than on the layer, so an import that
   * could not resolve one leaves this absent and says so in the report.
   */
  patternAssetId?: string;
  scale?: number;
  offset?: Vec2;
  linked?: boolean;
}

export interface StrokeEffect extends ObjectEffectBase {
  type: "stroke";
  size: number;
  position: "outside" | "inside" | "center";
  fillType: "color" | "gradient" | "pattern";
  color?: string;
  paint?: ColorValue;
  patternName?: string;
  patternAssetId?: string;
  overprint?: boolean;
}

export type ObjectEffect =
  | DropShadowEffect
  | InnerShadowEffect
  | OuterGlowEffect
  | InnerGlowEffect
  | BevelEmbossEffect
  | SatinEffect
  | ColorOverlayEffect
  | GradientOverlayEffect
  | PatternOverlayEffect
  | StrokeEffect;

/**
 * Photoshop's Blending Options — the top pane of the same Layer Style dialog.
 *
 * Separate from `opacity` because Photoshop's two opacities differ: `opacity`
 * fades the layer *and* its effects, `fillOpacity` fades only the layer's own
 * pixels and leaves the effects at full strength. A stroke on a fill-0 shape is
 * a common broadcast lower-third build, and collapsing the two erases it.
 */
export interface ObjectBlendingOptions {
  fillOpacity?: number;
  knockout?: "none" | "shallow" | "deep";
  blendInteriorEffectsAsGroup?: boolean;
  blendClippedLayersAsGroup?: boolean;
  transparencyShapesLayer?: boolean;
  layerMaskHidesEffects?: boolean;
  vectorMaskHidesEffects?: boolean;
  /** Photoshop "Blend If" sliders, per channel. Values are 0..255 source levels. */
  blendIf?: EffectBlendIfChannel[];
}

export interface EffectBlendIfChannel {
  channel: "gray" | "red" | "green" | "blue";
  sourceBlackPoint: number;
  sourceWhitePoint: number;
  targetBlackPoint: number;
  targetWhitePoint: number;
}

/** Every effect type, so a consumer can iterate without restating the union. */
export const OBJECT_EFFECT_TYPES: readonly ObjectEffectType[] = Object.freeze([
  "bevel-emboss",
  "stroke",
  "inner-shadow",
  "inner-glow",
  "satin",
  "color-overlay",
  "gradient-overlay",
  "pattern-overlay",
  "outer-glow",
  "drop-shadow"
]);

/**
 * Bring imported or hand-edited effects into range.
 *
 * Unknown effect types are dropped rather than kept as an untyped record: the
 * whole point of the typed model is that anything reading `effects` can narrow
 * on `type` without a fallback branch. What was dropped is recoverable from
 * `importedDesign.effects`, which keeps the verbatim source records.
 */
export function normalizeObjectEffects(effects: unknown): ObjectEffect[] {
  if (!Array.isArray(effects)) return [];
  const normalized: ObjectEffect[] = [];

  effects.forEach((candidate, index) => {
    if (!candidate || typeof candidate !== "object") return;
    const effect = candidate as Partial<ObjectEffect> & Record<string, unknown>;
    if (typeof effect.type !== "string") return;
    if (!OBJECT_EFFECT_TYPES.includes(effect.type as ObjectEffectType)) return;

    normalized.push({
      ...effect,
      id: typeof effect.id === "string" && effect.id ? effect.id : `effect-${effect.type}-${index}`,
      // Photoshop keeps switched-off styles in the file, so absence means "on":
      // only an explicit `false` disables one.
      enabled: effect.enabled !== false,
      opacity: clampUnit(effect.opacity)
    } as ObjectEffect);
  });

  return normalized;
}

function clampUnit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

export interface SceneEffectAudit {
  /** Enabled effects, grouped by type, that no renderer draws. */
  unrenderedByType: Partial<Record<ObjectEffectType, number>>;
  /** Objects carrying at least one enabled, unrendered effect. */
  affectedObjectIds: string[];
  warnings: string[];
}

/**
 * Report every enabled layer style that will not reach the screen.
 *
 * The rule this enforces is the repository's oldest one: a fallback may not
 * silently produce visually different pixels. A drop shadow that imports, saves,
 * validates and then renders as nothing is exactly that, so it is named here —
 * once per type, with the objects that carry it — rather than discovered on air.
 */
export function validateSceneEffects(scene: SceneDocument): SceneEffectAudit {
  const unrenderedByType: Partial<Record<ObjectEffectType, number>> = {};
  const affectedObjectIds: string[] = [];

  for (const object of scene.objects) {
    let objectAffected = false;
    for (const effect of object.effects ?? []) {
      if (!effect.enabled) continue;
      if (IMPLEMENTED_OBJECT_EFFECTS.includes(effect.type)) continue;
      unrenderedByType[effect.type] = (unrenderedByType[effect.type] ?? 0) + 1;
      objectAffected = true;
    }
    if (objectAffected) affectedObjectIds.push(object.id);
  }

  const warnings = Object.entries(unrenderedByType).map(
    ([type, count]) =>
      `${count} enabled ${type} effect${count === 1 ? "" : "s"} will not be drawn: no GrapiX renderer implements layer styles yet.`
  );

  return { unrenderedByType, affectedObjectIds, warnings };
}

export type PathKeyframe = MaskPathKeyframe;
export interface MaskPathKeyframe {
  id: string;
  frame: number;
  value: BezierPath;
}

/** One numeric trim channel keyframe (start / end / offset), AE-style. */
export interface TrimNumberKeyframe {
  id: string;
  frame: number;
  value: number;
}

/**
 * After Effects–style Trim Paths channels for a shape's stroke.
 *
 * Each channel is an independent stopwatch; an absent channel is a static value. `start` and
 * `end` are percentages of the path's total length and `offset` rotates the trimmed window
 * around the path — all three evaluated by `evaluateSceneAtFrame` so Preview and Program agree.
 */
export interface TrimPathsAnimation {
  start?: TrimNumberKeyframe[];
  end?: TrimNumberKeyframe[];
  offset?: TrimNumberKeyframe[];
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

export interface SlabBevelProperties {
  enabled: boolean;
  /** Width of the bevel measured inward from the slab outline, in scene pixels. */
  size: number;
  /** Z depth occupied by the bevel, in scene pixels. */
  depth: number;
}

export interface SlabProperties {
  /** Corner radius of the slab outline, in scene pixels. */
  cornerRadius: number;
  /** Curved-corner tessellation quality. */
  cornerSegments: number;
  /** Horizontal displacement between the slab's bottom and top edges. */
  skew: number;
  /** Whether texture coordinates follow the skewed outline. */
  skewTexture: boolean;
  /** Object-level face culling, matching XPression's slab culling control. */
  culling: MaterialCullMode;
  frontBevel: SlabBevelProperties;
  backBevel: SlabBevelProperties;
}

export type SlabPropertiesInput = Partial<Omit<SlabProperties, "frontBevel" | "backBevel">> & {
  frontBevel?: Partial<SlabBevelProperties>;
  backBevel?: Partial<SlabBevelProperties>;
};

export const DEFAULT_SLAB_PROPERTIES: SlabProperties = {
  cornerRadius: 18,
  cornerSegments: 6,
  skew: 0,
  skewTexture: false,
  culling: "back",
  frontBevel: {
    enabled: true,
    size: 6,
    depth: 4
  },
  backBevel: {
    enabled: false,
    size: 6,
    depth: 4
  }
};

export function normalizeSlabProperties(value?: SlabPropertiesInput): SlabProperties {
  return {
    cornerRadius: value?.cornerRadius ?? DEFAULT_SLAB_PROPERTIES.cornerRadius,
    cornerSegments: value?.cornerSegments ?? DEFAULT_SLAB_PROPERTIES.cornerSegments,
    skew: value?.skew ?? DEFAULT_SLAB_PROPERTIES.skew,
    skewTexture: value?.skewTexture ?? DEFAULT_SLAB_PROPERTIES.skewTexture,
    culling: value?.culling ?? DEFAULT_SLAB_PROPERTIES.culling,
    frontBevel: {
      ...DEFAULT_SLAB_PROPERTIES.frontBevel,
      ...value?.frontBevel
    },
    backBevel: {
      ...DEFAULT_SLAB_PROPERTIES.backBevel,
      ...value?.backBevel
    }
  };
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
  /** XPression-style rounded, skewed and independently beveled slab controls. */
  slab?: SlabProperties;
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
  /**
   * Masks a container imposes on everything inside it, with the transform that maps each mask's
   * own coordinates into the scene.
   *
   * A container is never drawn — `renderableObjects` excludes it — so a mask authored on one used
   * to have no effect whatsoever: a clipping composition clipped nothing. Carrying the mask down
   * to the objects that *are* drawn is what makes a clip group a clip group.
   */
  masks: readonly InheritedSceneMask[];
}

interface InheritedSceneMask {
  mask: ObjectMask;
  /** Mask-local space to scene space, so it can be re-expressed in any descendant's space. */
  toScene: SceneHierarchyAffine2d;
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
  locked: false,
  masks: []
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

    // Where this object's own local space sits in the scene. Needed twice: to re-express an
    // inherited mask in this object's coordinates, and to hand descendants a mask that is still
    // measured from the right origin.
    const localToScene = multiplySceneHierarchyTransforms(
      inherited.transform,
      sceneHierarchyObjectTransform(object)
    );

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
      locked: effectiveLocked,
      /*
       * A container's masks reach the objects it contains.
       *
       * Both renderers draw leaves only, each in its own local space, so a mask path must be
       * restated in that space: mask-local → scene → this object's local. The object's own masks
       * stay last, because those are the ones an author edits directly.
       */
      masks: [
        ...inheritedMasksFor(inherited.masks, localToScene),
        ...(object.masks ?? [])
      ]
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
      transform: localToScene,
      zDepth: inherited.zDepth + object.zDepth,
      rotationX: inherited.rotationX + (object.rotationX ?? 0),
      rotationY: inherited.rotationY + (object.rotationY ?? 0),
      rotationZ: inherited.rotationZ + object.rotation,
      scaleX: effectiveScaleX,
      scaleY: effectiveScaleY,
      scaleZ: effectiveScaleZ,
      visible: effectiveVisible,
      opacity: effectiveOpacity,
      locked: effectiveLocked,
      // This container's own masks join the ones it inherited, measured from its local space.
      masks: [
        ...inherited.masks,
        ...(object.masks ?? []).map((mask) => ({ mask, toScene: localToScene }))
      ]
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

/**
 * Restate inherited masks in one object's local space.
 *
 * `toScene` maps a mask's own coordinates into the scene; `localToScene` does the same for the
 * object about to carry it. The mask therefore needs `inverse(localToScene) · toScene` applied to
 * every point. A degenerate object transform — a zero scale — has no inverse, and the object is
 * invisible anyway, so its inherited masks are dropped rather than producing infinities.
 */
function inheritedMasksFor(
  masks: readonly InheritedSceneMask[],
  localToScene: SceneHierarchyAffine2d
): ObjectMask[] {
  if (masks.length === 0) return [];
  const sceneToLocal = invertSceneHierarchyTransform(localToScene);
  if (!sceneToLocal) return [];

  return masks.map(({ mask, toScene }) => {
    const maskToLocal = multiplySceneHierarchyTransforms(sceneToLocal, toScene);
    return {
      ...mask,
      // A fresh id per carrier: two objects must not share a mask id, or the Inspector would edit
      // both at once, and an inherited mask is not the authored one — it is a projection of it.
      id: `${mask.id}__inherited`,
      path: transformMaskPath(mask.path, maskToLocal)
    };
  });
}

/**
 * Move a mask path through an affine transform.
 *
 * Tangents are offsets from their vertex, so they take the linear part only — translating a tangent
 * would drag every control point toward the origin and flatten the curve.
 */
function transformMaskPath(path: BezierPath, transform: SceneHierarchyAffine2d): BezierPath {
  const linear = (point: Vec2): Vec2 => ({
    x: transform.a * point.x + transform.c * point.y,
    y: transform.b * point.x + transform.d * point.y
  });
  return {
    ...path,
    vertices: path.vertices.map((vertex) => applySceneHierarchyTransform(transform, vertex.x, vertex.y)),
    inTangents: path.inTangents.map(linear),
    outTangents: path.outTangents.map(linear)
  };
}

/** The inverse of a 2D affine, or null when it has none. */
function invertSceneHierarchyTransform(
  transform: SceneHierarchyAffine2d
): SceneHierarchyAffine2d | null {
  const determinant = transform.a * transform.d - transform.b * transform.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;

  const a = transform.d / determinant;
  const b = -transform.b / determinant;
  const c = -transform.c / determinant;
  const d = transform.a / determinant;
  return {
    a,
    b,
    c,
    d,
    tx: -(a * transform.tx + c * transform.ty),
    ty: -(b * transform.tx + d * transform.ty)
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
  /**
   * Stage this scene is authored against (`@grapix/stage-model`).
   *
   * Absent on every legacy document, which means "the implicit single-surface
   * stage the size of `canvas`". Never required.
   */
  stageId?: string;
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
  /**
   * Always `"scene-package"`. A project manifest and a published scene package now share the
   * `.gpxpkg` extension, so the file says which it is instead of a reader inferring it from the
   * fields it can find. Optional only so packages built before the field existed still read.
   */
  kind?: "scene-package";
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
    // wrap (clamp/repeat/mirror) and filtering (linear/nearest) are applied by the editor's
    // texture sampler and the native engine. Fit is narrower: only the modes in
    // IMPLEMENTED_TEXTURE_FIT_MODES resolve to a UV transform both renderers can honour, so every
    // other mode is reported rather than silently drawn as `stretch`.
    if (!IMPLEMENTED_TEXTURE_FIT_MODES.includes(slot.fit)) {
      warnings.push(`Texture fit mode ${slot.fit} is not implemented by both renderers.`);
    }
  }

  if (shader?.validationStatus === "INVALID") {
    warnings.push(`Shader ${shader.name} is invalid; the last valid material state remains active.`);
  }

  const blendMode = material.blendMode ?? "normal";
  const alphaMode = material.alphaMode ?? "premultiplied";
  if (!isImplementedBlendMode(blendMode)) {
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
 * "main" so every pre-face scene, published package, and the Rust render core (which
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
        return buildMaterialFaces([
          [PRIMARY_MATERIAL_SLOT, "Front", "surface"],
          ["face:back", "Back", "surface"],
          ["face:left", "Left", "surface"],
          ["face:right", "Right", "surface"],
          ["face:top", "Top", "surface"],
          ["face:bottom", "Bottom", "surface"]
        ]);
      case "slab":
        return buildMaterialFaces([
          [PRIMARY_MATERIAL_SLOT, "Face", "surface"],
          ["face:bevel", "Bevel", "surface"],
          ["face:extrusion", "Extrusion", "surface"],
          ["face:back-bevel", "Back Bevel", "surface"],
          ["face:back", "Back Face", "surface"]
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

/**
 * One step of scene history: the document **before** a change, and what that change was.
 *
 * The label describes the change the entry reverts, so `undoStack.at(-1)!.label` is exactly what
 * "Undo" is about to do. Snapshots used to be bare documents, which meant every undo was anonymous
 * — the label `beginHistory` collected was thrown away at commit — and nothing could tell an author
 * what a keystroke was about to take back.
 *
 * `scope` is the module that made the change. It is attribution, **not** a separate stack: every
 * panel edits one `SceneDocument`, so reverting one module's older entry while another module's
 * newer entry stands would produce a document that never existed and silently discard the second
 * module's work. One history, labelled by owner.
 */
export interface SceneHistoryEntry {
  scene: SceneDocument;
  label?: string;
  scope?: string;
}

export interface SceneHistorySnapshot {
  scene: SceneDocument;
  undoStack: SceneHistoryEntry[];
  redoStack: SceneHistoryEntry[];
  /** The entry that was applied, so a caller can report what it just undid or redid. */
  applied: SceneHistoryEntry;
}

export function appendSceneHistory(
  stack: SceneHistoryEntry[],
  entry: SceneHistoryEntry,
  limit = 100
): SceneHistoryEntry[] {
  return [...stack, entry].slice(-Math.max(1, limit));
}

export function undoSceneHistory(
  scene: SceneDocument,
  undoStack: SceneHistoryEntry[],
  redoStack: SceneHistoryEntry[]
): SceneHistorySnapshot | null {
  const previous = undoStack.at(-1);
  if (!previous) return null;
  return {
    scene: previous.scene,
    undoStack: undoStack.slice(0, -1),
    // Redo re-applies the same change, so it carries the same description.
    redoStack: appendSceneHistory(redoStack, { scene, label: previous.label, scope: previous.scope }),
    applied: previous
  };
}

export function redoSceneHistory(
  scene: SceneDocument,
  undoStack: SceneHistoryEntry[],
  redoStack: SceneHistoryEntry[]
): SceneHistorySnapshot | null {
  const next = redoStack.at(-1);
  if (!next) return null;
  return {
    scene: next.scene,
    undoStack: appendSceneHistory(undoStack, { scene, label: next.label, scope: next.scope }),
    redoStack: redoStack.slice(0, -1),
    applied: next
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
  /**
   * The surface's alpha handling, when the caller knows what the image actually is.
   *
   * Omitted, a textured material assumes `straight`, which is the safe assumption for an unknown
   * image: a key drawn as opaque is a black rectangle on air, where an opaque photo drawn with
   * blending enabled is merely slower. When the source has been read and has no alpha channel —
   * a JPEG always, a 24-bit BMP, a lossy WebP — passing `opaque` avoids paying for blending and
   * the depth-sorting artefacts that come with a transparent surface that never needed to be one.
   */
  alphaMode?: MaterialAlphaMode;
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
  const requestedAlphaMode = typeof optionsOrLegacyType === "string" ? undefined : optionsOrLegacyType.alphaMode;
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
    alphaMode: requestedAlphaMode ?? (assetId ? "straight" : "premultiplied"),
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
          errors.push(`Font face ${face.faceId} must use an HTTPS URL.`);
        }
        if (url.username || url.password) {
          errors.push(`Font face ${face.faceId} URL cannot contain credentials.`);
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
    if (font.enabled === false) continue;
    for (const face of font.faces) {
      if (face.source.kind === "css-url" || face.source.kind === "adobe-fonts") {
        if (isTrustedFontCssUrl(face.source.url)) {
          imports.add(`@import url("${escapeCssString(face.source.url)}");`);
        }
        continue;
      }
      const sourceUrl = face.source.kind === "file"
        ? resolveAssetUrl(face.source.assetId)
        : face.source.url;
      const sourceFormat = face.source.kind === "file"
        ? face.source.format
        : face.source.format;
      rules.push([
        "@font-face {",
        `  font-family: "${escapeCssString(font.family)}";`,
        `  src: url("${escapeCssString(sourceUrl)}")${sourceFormat ? ` format("${sourceFormat === "ttf" ? "truetype" : sourceFormat === "otf" ? "opentype" : sourceFormat}")` : ""};`,
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

/** Escape and quote a family name unless it is a CSS generic family. */
export function cssFontFamily(value: string): string {
  const family = value.trim();
  const generic = new Set([
    "serif", "sans-serif", "monospace", "cursive", "fantasy",
    "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "emoji", "math", "fangsong"
  ]);
  return generic.has(family.toLowerCase())
    ? family
    : `"${escapeCssString(family)}"`;
}

export function buildFontFamilyStack(
  font: Pick<FontDefinition, "family" | "fallbackFamilies"> | undefined,
  legacyFamily = "sans-serif",
  objectFallbacks: string[] = []
): string {
  const values = font
    ? [font.family, ...objectFallbacks, ...font.fallbackFamilies]
    : [legacyFamily, ...objectFallbacks];
  const seen = new Set<string>();
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().replace(/^['"]|['"]$/g, ""))
    .filter((value) => value && !seen.has(value.toLowerCase()) && !!seen.add(value.toLowerCase()))
    .map(cssFontFamily)
    .join(", ");
}

export function fontDefinitionForText(
  fonts: FontDefinition[],
  text: Pick<TextSceneObject, "fontId" | "fontFamily">
): FontDefinition | undefined {
  return (text.fontId ? fonts.find((font) => font.fontId === text.fontId) : undefined)
    ?? fonts.find((font) => font.family === text.fontFamily);
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
    kind: "scene-package",
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

  // A layer style that imports, validates and then renders as nothing is a
  // visual difference the operator must be told about before the scene is cued.
  const effectAudit = validateSceneEffects(scene);
  for (const warning of effectAudit.warnings) {
    issues.push({ severity: "warning", code: "EFFECT_NOT_RENDERED", message: warning });
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
    if (font.enabled === false && scene.objects.some((object) =>
      object.type === "text" && (object.fontId === font.fontId || (!object.fontId && object.fontFamily === font.family))
    )) {
      issues.push({
        severity: "error",
        code: "FONT_DISABLED_IN_USE",
        message: `${font.displayName} is disabled but remains assigned to text.`
      });
    }
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

  for (const object of scene.objects) {
    if (object.type !== "text" || !object.fontId) continue;
    if (!(scene.fonts ?? []).some((font) => font.fontId === object.fontId)) {
      issues.push({
        severity: "error",
        code: "TEXT_FONT_MISSING",
        message: `${object.name} references missing project font ${object.fontId}.`,
        objectId: object.id
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
    // A channel authored before the animatability gate existed. It is inert in Preview and on air
    // alike, so this is a warning: the scene renders the same either way, and blocking a package
    // over keys that move nothing would stop a show for a cosmetic cleanup. Never stripped here —
    // the author is told which object holds it and decides.
    for (const property of ANIMATABLE_PROPERTIES) {
      if (!object.animation?.[property]?.keys.length) continue;
      if (isPropertyAnimatable(object.type, property)) continue;
      issues.push({
        severity: "warning",
        code: "ANIMATION_CHANNEL_NOT_RENDERED",
        message: `${object.name} animates ${property}, which is not rendered for a ${object.type} object: depth is paint order for 2D content and is resolved when the scene is prepared. The keys are kept and ignored.`,
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

// ---------------------------------------------------------------------------
// After Effects project import — the intermediate manifest
//
// One shape, three producers. The AE bridge (ExtendScript walking an open .aep),
// the AEPX direct parser (XML, no After Effects), and the collected-footage
// resolver all emit the same `AeManifest`, so the converter and the report read
// one structure no matter where the project came from. A field is optional when
// a producer can legitimately not know it — the AEPX parser reads no pixel data,
// and the bridge reads no XML — so absence always means "not readable", never
// "default".
// ---------------------------------------------------------------------------

/**
 * How faithfully one imported item survives the move to GrapiX.
 *
 * Ordered from most to least editable. `baked` and below are not editable in
 * GrapiX; the report groups on this so an author can see at a glance what they
 * can still change and what arrived as a picture of itself.
 */
export type AECompatibility =
  /** A native GrapiX object with full editability (a text layer, a solid). */
  | "native-editable"
  /** Mapped to a native object with an approximation the report names. */
  | "translated"
  /** An expression or animated property reduced to evaluated keyframes. */
  | "sampled"
  /** An effect or layer rendered to a fallback by After Effects. */
  | "baked"
  /** A third-party effect whose plugin is not installed. */
  | "missing-plugin"
  /** Footage or a font the project references but the collector could not find. */
  | "missing-asset"
  /** No GrapiX representation exists and none was approximated. */
  | "unsupported";

/** A layer, effect, or property and the state it imported with. */
export interface AeCompatibilityEntry {
  id: string;
  name: string;
  kind: "layer" | "effect" | "expression" | "mask" | "asset" | "font" | "property";
  status: AECompatibility;
  /** Why, when the status is not native-editable. */
  reason?: string;
}

export interface AeMarker {
  time: number;
  comment?: string;
  label?: number;
}

/** One keyframe on an animatable stream. Times are seconds within the layer. */
export interface AeKeyframe {
  time: number;
  value: number | number[] | string | boolean;
  /** `linear`, `bezier`, `hold` — AE_KEY_INTERP names. */
  interpolation: "linear" | "bezier" | "hold";
  inTangent?: { x: number; y: number };
  outTangent?: { x: number; y: number };
  /** Spatial tangents for position streams, in comp pixels. */
  spatialIn?: number[];
  spatialOut?: number[];
  roving?: boolean;
  label?: number;
}

/** One animatable property's keyframes, keyed by AE_LayerStream name. */
export interface AePropertyStream {
  /** AE stream name: anchorPoint, position, scale, rotation, opacity, rotateX, ... */
  property: string;
  keyframes: AeKeyframe[];
  /** The original expression source, when the stream is expression-driven. */
  expression?: string;
  /** True when the expression was sampled into `keyframes` because it has no translation. */
  expressionSampled?: boolean;
}

export interface AeMask {
  name: string;
  /** GrapiX mask mode, already resolved from PF_MaskMode. */
  mode: "none" | "add" | "subtract" | "intersect" | "lighten" | "darken" | "difference";
  inverted: boolean;
  opacity: number;
  feather: { x: number; y: number };
  expansion: number;
  /** Bezier path, object-local, same shape as GrapiX `BezierPath`. */
  path: { closed: boolean; vertices: { x: number; y: number }[]; inTangents: { x: number; y: number }[]; outTangents: { x: number; y: number }[] };
  pathKeyframes?: AeKeyframe[];
}

export interface AeEffect {
  /** Display name, e.g. "Gaussian Blur". */
  name: string;
  /** Stable match name, e.g. "ADBE Gaussian Blur 2" — the plugin identifier. */
  matchName: string;
  enabled: boolean;
  /** Parameters by display name; values may be animated (then they carry keyframes). */
  parameters: Record<string, unknown>;
  /** The compatibility the importer assigned. Unsupported/native-third-party -> baked. */
  status: AECompatibility;
}

export interface AeTrackMatte {
  /** alpha | notAlpha | luma | notLuma, resolved from AEGP_TrackMatte. */
  type: "alpha" | "notAlpha" | "luma" | "notLuma";
  /** The layer index (1-based, comp order) supplying the matte. */
  sourceLayerIndex: number;
}

export interface AeLayer {
  /** 1-based index in composition stacking order; layer 1 is topmost. */
  index: number;
  name: string;
  /** GrapiX-facing type, resolved from AEGP_ObjectType plus the null/adjustment flags. */
  type: "video" | "image" | "image-sequence" | "audio" | "text" | "shape" | "solid" | "null" | "adjustment" | "precomp" | "camera" | "light";
  /** Project-item id of the footage/precomp this layer draws from, when it has one. */
  sourceItemId?: string;
  inPoint: number;
  outPoint: number;
  startTime: number;
  stretch: number;
  visible: boolean;
  locked: boolean;
  shy: boolean;
  solo: boolean;
  is3d: boolean;
  guide: boolean;
  collapseTransformations: boolean;
  continuouslyRasterize: boolean;
  motionBlur: boolean;
  frameBlending: boolean;
  blendingMode: string;
  label?: number;
  comment?: string;
  parentIndex?: number;
  trackMatte?: AeTrackMatte;
  /** Transform + animatable streams. */
  anchorPoint: number[];
  position: number[];
  scale: number[];
  rotation: number[];
  orientation?: number[];
  opacity: number;
  streams: AePropertyStream[];
  masks: AeMask[];
  effects: AeEffect[];
  markers: AeMarker[];
  text?: {
    content: string;
    fontFamily: string;
    fontStyle?: string;
    fontSize: number;
    fillColor: string;
    strokeColor?: string;
    strokeWidth?: number;
    align: "left" | "center" | "right" | "justify";
    tracking?: number;
    leading?: number;
    baselineShift?: number;
    boxSize?: { x: number; y: number };
  };
  /** Solid fill, when type is solid. */
  solidColor?: string;
  status: AECompatibility;
}

export interface AeComposition {
  /** Project-item id; precomp layers reference this. */
  id: string;
  name: string;
  width: number;
  height: number;
  duration: number;
  frameRate: number;
  displayStartTime: number;
  workAreaStart: number;
  workAreaDuration: number;
  backgroundColor: string;
  layers: AeLayer[];
  markers: AeMarker[];
}

/** A footage or project item the collector must resolve and copy. */
export interface AeAssetRef {
  /** Project-item id. */
  id: string;
  name: string;
  kind: "footage" | "composition" | "folder";
  /** For footage: the source file path exactly as AE recorded it. */
  sourcePath?: string;
  /** True when the file was missing in AE. */
  missing?: boolean;
  /** Image sequence: the ordered frame file names, when it is one. */
  sequenceFrames?: string[];
  /** A still used as a proxy / alternate source. */
  proxyPath?: string;
  mediaType?: "video" | "audio" | "image" | "image-sequence" | "font" | "photoshop" | "illustrator" | "other";
}

/** The folder tree is preserved as nesting; compositions and footage carry the full path. */
export interface AeManifest {
  formatVersion: 1;
  /**
   * Which producer made this manifest.
   *
   * `aep-native` reads the binary `.aep` directly, without After Effects; `ae-bridge` runs the
   * ExtendScript exporter inside an installed After Effects. They emit the same structure but
   * not the same coverage, so the report names the producer — an author looking at a missing
   * effect parameter needs to know which path the project took.
   */
  producer: "ae-bridge" | "aep-native" | "aepx-direct" | "collected";
  projectName: string;
  /** Absolute path of the source .aep/.aepx, never modified. */
  sourceFile: string;
  frameRate: number;
  compositions: AeComposition[];
  assets: AeAssetRef[];
  /** Fonts the text layers reference, for missing-font detection. */
  fonts: { family: string; style?: string; usedBy: string[] }[];
  /** Warnings the producer already knows (parse degradation, sampled expressions). */
  warnings: string[];
}

/** One composition that converted, mapped to the scene it became. */
export interface AeImportedComposition {
  id: string;
  name: string;
  sceneId: string;
}

/**
 * The compatibility report an import ends with.
 *
 * This is the answer to "what can I still edit, and what arrived as a picture of itself?".
 * `entries` is the per-item breakdown; the `missing*` lists feed the relink and font-replace
 * windows; `counts` lets the report open with the one-line summary an author reads first.
 */
export interface AeImportReport {
  projectName: string;
  producer: AeManifest["producer"];
  compositions: AeImportedComposition[];
  entries: AeCompatibilityEntry[];
  missingFootage: string[];
  missingFonts: string[];
  missingPlugins: string[];
  warnings: string[];
  counts: Record<AECompatibility, number>;
}
