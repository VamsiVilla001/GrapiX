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
  | "json"
  | "lut"
  | "unknown";

export interface AssetLibraryItem {
  assetId: string;
  name: string;
  kind: AssetKind;
  source: string;
  mimeType?: string;
  sizeBytes?: number;
  importedAt: string;
}

export type MaterialType =
  | "image"
  | "video"
  | "solid-color"
  | "gradient"
  | "text-style"
  | "svg-vector"
  | "shader";

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
}

export type MaterialSlotMap = Record<string, string>;

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
  materialId: string | undefined
): Material | undefined {
  if (!materialId) {
    return undefined;
  }

  return materials.find((material) => material.materialId === materialId);
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
    return material.color;
  }

  const boundValue = resolveDataPath(dataContext, material.binding.path);

  if (material.binding.type === "color" && typeof boundValue === "string") {
    return boundValue;
  }

  return material.binding.fallbackColor ?? material.color;
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
    for (const [slotName, materialId] of Object.entries(object.materialSlots)) {
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

  if (!material.dynamic) {
    return findAsset(assets, material.assetId) ? "READY" : "MISSING";
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
