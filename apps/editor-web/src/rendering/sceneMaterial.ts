import {
  applyBindings,
  findMaterial,
  resolveMaterialAsset,
  resolveMaterialColor,
  type SceneDocument,
  type SceneObject
} from "@grapix/shared-types";

export function resolveRenderableObjects(scene: SceneDocument): SceneObject[] {
  return sortObjectsForRender(scene.objects.map((object) => applyMaterialSlots(applyBindings(object, scene.dataContext), scene)));
}

export function applyMaterialSlots<T extends SceneObject>(object: T, scene: SceneDocument): T {
  const material = findMaterial(scene.materials, object.materialSlots.main);

  if (!material) {
    return object;
  }

  const nextObject = { ...object } as SceneObject;
  const color = resolveMaterialColor(material, scene.dataContext);
  const asset = resolveMaterialAsset(material, scene.assets, scene.dataContext);

  if (color && ["solid-color", "gradient", "text-style"].includes(material.type)) {
    nextObject.fill = color;
  }

  if (asset && nextObject.type === "image" && ["image", "svg-vector", "video"].includes(material.type)) {
    nextObject.src = asset.source;
  }

  return nextObject as T;
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
