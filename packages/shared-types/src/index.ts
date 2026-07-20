export type SceneObjectType =
  | "text"
  | "rect"
  | "ellipse"
  | "image"
  | "line"
  | "mesh"
  | "light"
  | "camera"
  | "layer"
  | "marker"
  | "group";

export type MeshPrimitiveKind = "model" | "cube" | "cylinder" | "torus" | "slab";
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
  | "opacity";

export type BindingMap = Partial<Record<SceneProperty, string>>;

export type AssetKind =
  | "image"
  | "video"
  | "svg"
  | "font"
  | "image-sequence"
  | "wgsl"
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
}

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

export interface SceneTimeline {
  fps: number;
  durationFrames: number;
  keyframes: SceneKeyframe[];
}

export interface SceneCanvas {
  width: number;
  height: number;
  background: string;
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
  opacity: number;
  visible: boolean;
  locked: boolean;
  fill: string;
  stroke: string;
  strokeWidth: number;
  bindings: BindingMap;
  materialSlots: MaterialSlotMap;
}

export interface TextSceneObject extends BaseSceneObject {
  type: "text";
  text: string;
  fontSize: number;
  fontFamily: string;
  fontWeight: "400" | "500" | "600" | "700" | "800";
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

export interface MeshSceneObject extends BaseSceneObject {
  type: "mesh";
  meshKind: MeshPrimitiveKind;
  depth: number;
  src?: string;
}

export interface LightSceneObject extends BaseSceneObject {
  type: "light";
  lightKind: LightKind;
  intensity: number;
  color: string;
}

export interface CameraSceneObject extends BaseSceneObject {
  type: "camera";
  cameraKind: CameraKind;
  fov: number;
  zoom: number;
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
  | MeshSceneObject
  | LightSceneObject
  | CameraSceneObject
  | LayerSceneObject
  | MarkerSceneObject
  | GroupSceneObject;

export interface SceneDocument {
  id: string;
  name: string;
  version: 1;
  canvas: SceneCanvas;
  dataContext: Record<string, unknown>;
  assets: AssetLibraryItem[];
  materials: Material[];
  materialInstances?: MaterialInstance[];
  shaders?: ShaderDefinition[];
  materialFolders?: MaterialFolder[];
  objects: SceneObject[];
  timeline: SceneTimeline;
  createdAt: string;
  updatedAt: string;
}

export interface RendererPatch {
  type:
    | "LOAD_SCENE"
    | "UNLOAD_SCENE"
    | "PLAY_TIMELINE"
    | "PAUSE_TIMELINE"
    | "STOP_TIMELINE"
    | "PATCH_SCENE_PROPERTY"
    | "PATCH_DATA_CONTEXT"
    | "SET_VISIBILITY"
    | "SET_LAYER"
    | "TAKE_IN"
    | "TAKE_OUT"
    | "CONTINUE";
  sceneId: string;
  objectId?: string;
  property?: SceneProperty;
  value?: unknown;
}

export interface ScenePackageAssetEntry {
  assetId: string;
  name: string;
  kind: AssetKind;
  path: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface ScenePackageManifest {
  packageVersion: 1;
  sceneId: string;
  sceneName: string;
  createdAt: string;
  canvas: SceneCanvas;
  fps: 60;
  files: {
    scene: "scene.json";
    bindings: "bindings.json";
    materials: "materials.json";
    timeline: "timeline.json";
  };
  assets: ScenePackageAssetEntry[];
  stats: {
    objectCount: number;
    assetCount: number;
    materialCount: number;
    bindingCount: number;
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
      return ["rect", "ellipse", "text", "image"].includes(objectType);
    case "image":
    case "svg-vector":
    case "unlit-texture":
      return ["rect", "image"].includes(objectType);
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
  return { materialIds, shaderIds };
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
  const errors: string[] = [];
  if (!name.trim()) errors.push("File name is required.");
  if (sizeBytes <= 0) errors.push("The file is empty.");
  if (sizeBytes > 50 * 1024 * 1024) errors.push("Files larger than 50 MiB require the future proxy importer.");
  if (!supportedImages.has(extension) && extension !== "wgsl") {
    errors.push(`.${extension || "unknown"} is not supported by the first material importer.`);
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
  return {
    ...material,
    shaderId: material.shaderId ?? defaultShaderId(material.type),
    textureSlots: material.textureSlots ?? defaultTextureSlots(material),
    parameters: {
      baseColor: material.color ?? "#ffffff",
      tint: "#ffffff",
      opacity: material.opacity,
      uvScale: [1, 1],
      uvOffset: [0, 0],
      ...(material.parameters ?? {})
    },
    blendMode: material.blendMode ?? "normal",
    alphaMode: material.alphaMode ?? "premultiplied",
    cullMode: material.cullMode ?? "none",
    depthMode: material.depthMode ?? "disabled",
    colorSpace: material.colorSpace ?? "srgb",
    doubleSided: material.doubleSided ?? true,
    enabled: material.enabled ?? true,
    tags: material.tags ?? [],
    createdAt: material.createdAt ?? timestamp,
    updatedAt: timestamp,
    supportedPrimitives: material.supportedPrimitives ?? defaultSupportedPrimitives(material.type)
  };
}

export function createMaterialDefinition(
  name: string,
  type: "solid-color" | "image" | "unlit-texture",
  assetId?: string
): Material {
  const timestamp = new Date().toISOString();
  const material: Material = {
    materialId: createSceneId("mat"),
    name,
    type,
    assetId,
    dynamic: false,
    opacity: 1,
    readiness: assetId ? "READY" : type === "solid-color" ? "READY" : "MISSING",
    shaderId: type === "solid-color" ? "grapix.material.solid-colour" : "grapix.material.textured",
    parameters: type === "solid-color"
      ? { baseColor: "#ffffff", opacity: 1 }
      : { tint: "#ffffff", opacity: 1, uvScale: [1, 1], uvOffset: [0, 0] },
    textureSlots: type === "solid-color" ? [] : [createDefaultTextureSlot("baseTexture", assetId)],
    blendMode: "normal",
    alphaMode: type === "solid-color" ? "premultiplied" : "straight",
    cullMode: "none",
    depthMode: "disabled",
    colorSpace: "srgb",
    doubleSided: true,
    enabled: true,
    tags: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    supportedPrimitives: type === "solid-color" ? ["rect", "ellipse", "text", "image"] : ["rect", "image"]
  };

  return normalizeMaterial(material);
}

function defaultShaderId(type: MaterialType): string {
  return ["image", "svg-vector", "video", "unlit-texture", "image-sequence"].includes(type)
    ? "grapix.material.textured"
    : "grapix.material.solid-colour";
}

function defaultTextureSlots(material: Material): MaterialTextureSlot[] {
  if (!["image", "svg-vector", "video", "unlit-texture", "image-sequence"].includes(material.type)) {
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
  if (["image", "svg-vector", "unlit-texture"].includes(type)) return ["rect", "image"];
  if (["video", "image-sequence"].includes(type)) return ["image"];
  if (type === "text-style") return ["text"];
  if (["basic-lit", "pbr"].includes(type)) return ["mesh"];
  return ["rect", "ellipse", "text", "image"];
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

export function buildScenePackageManifest(
  scene: SceneDocument,
  assets: ScenePackageAssetEntry[]
): ScenePackageManifest {
  return {
    packageVersion: 1,
    sceneId: scene.id,
    sceneName: scene.name,
    createdAt: new Date().toISOString(),
    canvas: scene.canvas,
    fps: 60,
    files: {
      scene: "scene.json",
      bindings: "bindings.json",
      materials: "materials.json",
      timeline: "timeline.json"
    },
    assets,
    stats: {
      objectCount: scene.objects.length,
      assetCount: assets.length,
      materialCount: scene.materials.length,
      bindingCount: countSceneBindings(scene)
    }
  };
}

export function preflightScenePackage(scene: SceneDocument): ScenePackagePreflight {
  const issues: ScenePackageIssue[] = [];
  let readyMaterials = 0;
  let fallbackReadyMaterials = 0;
  let missingMaterials = 0;

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

export function getMaterialReadiness(
  material: Material,
  assets: AssetLibraryItem[],
  dataContext: Record<string, unknown>
): MaterialReadinessState {
  if (material.type === "solid-color") {
    return resolveMaterialColor(material, dataContext) ? "READY" : "MISSING";
  }

  const textureAssetId = material.textureSlots?.find((slot) => slot.name === "baseTexture")?.assetId;
  if (textureAssetId) {
    const textureAsset = findAsset(assets, textureAssetId);
    if (!textureAsset || textureAsset.status === "MISSING" || textureAsset.status === "ERROR" || textureAsset.status === "UNSUPPORTED") {
      return "MISSING";
    }
    return "READY";
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
    case "opacity":
      if (typeof value === "number") {
        object[property] = value;
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
