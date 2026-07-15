import {
  applyBindings,
  findAsset,
  findMaterial,
  resolveMaterialAsset,
  resolveMaterialColor,
  resolvePrimitiveMaterial,
  type ResolvedMaterial,
  type SceneDocument,
  type SceneObject
} from "@grapix/shared-types";

export type RenderableSceneObject = SceneObject & {
  resolvedMaterial?: ResolvedMaterial;
  materialAssetSource?: string;
};

export function resolveRenderableObjects(scene: SceneDocument): RenderableSceneObject[] {
  return sortObjectsForRender(scene.objects.map((object) => applyMaterialSlots(applyBindings(object, scene.dataContext), scene)));
}

export function applyMaterialSlots<T extends SceneObject>(object: T, scene: SceneDocument): T & RenderableSceneObject {
  const material = findMaterial(scene.materials, object.materialSlots.main);

  if (!material) {
    return object as T & RenderableSceneObject;
  }

  const nextObject = { ...object } as RenderableSceneObject;
  const resolved = resolvePrimitiveMaterial(scene, object);
  const color = material.dynamic
    ? resolveMaterialColor(material, scene.dataContext)
    : resolved?.parameters.baseColor;
  const legacyAsset = resolveMaterialAsset(material, scene.assets, scene.dataContext);
  const textureAsset = findAsset(scene.assets, resolved?.textureSlots[0]?.assetId);
  const asset = material.dynamic ? legacyAsset : textureAsset ?? legacyAsset;
  const opacity = resolved?.parameters.opacity;

  if (typeof color === "string" && ["solid-color", "gradient", "text-style"].includes(material.type)) {
    nextObject.fill = color;
  }

  if (typeof opacity === "number") {
    nextObject.opacity = Math.max(0, Math.min(1, nextObject.opacity * opacity));
  }

  if (asset?.status !== "MISSING" && asset?.status !== "ERROR" && asset?.status !== "UNSUPPORTED") {
    nextObject.materialAssetSource = asset?.source;
    if (asset && nextObject.type === "image" && ["image", "svg-vector", "video", "unlit-texture"].includes(material.type)) {
      nextObject.src = asset.source;
    }
  }

  nextObject.resolvedMaterial = resolved ?? undefined;
  return nextObject as T & RenderableSceneObject;
}

export function isVideoSource(source: string): boolean {
  const normalizedSource = source.toLowerCase();

  return (
    normalizedSource.startsWith("data:video/") ||
    normalizedSource.endsWith(".mp4") ||
    normalizedSource.endsWith(".webm") ||
    normalizedSource.endsWith(".mov") ||
    normalizedSource.includes(".mp4?") ||
    normalizedSource.includes(".webm?") ||
    normalizedSource.includes(".mov?")
  );
}

export function sortObjectsForRender(objects: SceneObject[]): SceneObject[] {
  return [...objects].sort((left, right) => {
    if (left.layerId !== right.layerId) {
      return left.layerId.localeCompare(right.layerId);
    }

    if (left.zDepth !== right.zDepth) {
      return left.zDepth - right.zDepth;
    }

    return left.zIndex - right.zIndex;
  });
}
