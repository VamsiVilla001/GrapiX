import {
  applyBindings,
  findAsset,
  findMaterial,
  getBindableFaces,
  isImplementedBlendMode,
  IMPLEMENTED_TEXTURE_FIT_MODES,
  resolveMaterialAsset,
  resolveMaterialColor,
  resolvePrimitiveMaterial,
  resolveSceneObjectHierarchy,
  type ResolvedMaterial,
  type SceneDocument,
  type SceneObject
} from "@grapix/shared-types";

/** A face slot's material resolved to what the symbol painter needs. */
export interface ResolvedFaceMaterial {
  color?: string;
  assetSource?: string;
  assetMime?: string;
  opacity?: number;
  resolved: ResolvedMaterial;
}

export type RenderableSceneObject = SceneObject & {
  resolvedMaterial?: ResolvedMaterial;
  materialAssetSource?: string;
  materialAssetMime?: string;
  /** Per-face resolutions keyed by materialSlots slot key (incl. "main"). */
  faceMaterials?: Record<string, ResolvedFaceMaterial>;
};

export function resolveRenderableObjects(scene: SceneDocument): RenderableSceneObject[] {
  const hierarchy = resolveSceneObjectHierarchy(scene.objects);
  return sortObjectsForRender(
    hierarchy.objects.map((object) => applyMaterialSlots(applyBindings(object, scene.dataContext), scene))
  );
}

/** Resolve one bound slot to the color/texture the mesh-symbol painter consumes. */
function resolveFaceMaterial(scene: SceneDocument, object: SceneObject, slotKey: string): ResolvedFaceMaterial | null {
  const material = findMaterial(scene.materials, object.materialSlots[slotKey]);
  if (!material || material.enabled === false) {
    return null;
  }
  const resolved = resolvePrimitiveMaterial(scene, object, slotKey);
  if (!isResolvedMaterialPreviewSupported(resolved)) {
    return null;
  }
  const boundColor = material.dynamic
    ? resolveMaterialColor(material, scene.dataContext)
    : resolved?.parameters.baseColor ?? resolved?.parameters.tint ?? material.color;
  const legacyAsset = resolveMaterialAsset(material, scene.assets, scene.dataContext);
  const textureAsset = findAsset(scene.assets, resolved?.textureSlots[0]?.assetId);
  const asset = material.dynamic ? legacyAsset : textureAsset ?? legacyAsset;
  const usableAsset = asset && asset.status !== "MISSING" && asset.status !== "ERROR" && asset.status !== "UNSUPPORTED" ? asset : undefined;
  if (!resolved) {
    return null;
  }
  return {
    color: typeof boundColor === "string" ? boundColor : undefined,
    assetSource: usableAsset?.source,
    assetMime: usableAsset?.mimeType,
    opacity: typeof resolved.parameters.opacity === "number"
      ? resolved.parameters.opacity
      : material.opacity,
    resolved
  };
}

/**
 * Mesh geometry resolves every bound surface (main + face:*) independently.
 * The resulting records include shader parameters and texture sampler/UV
 * metadata so the 3D renderer does not flatten a material into a colour swatch.
 */
function resolveSurfaceMaterials(scene: SceneDocument, object: SceneObject): Record<string, ResolvedFaceMaterial> | undefined {
  if (!["mesh", "rect", "ellipse", "image"].includes(object.type)) {
    return undefined;
  }
  const entries: Record<string, ResolvedFaceMaterial> = {};
  for (const face of getBindableFaces(object)) {
    const resolved = object.materialSlots[face.slotKey] ? resolveFaceMaterial(scene, object, face.slotKey) : null;
    if (resolved) {
      entries[face.slotKey] = resolved;
    }
  }
  return Object.keys(entries).length ? entries : undefined;
}

export function applyMaterialSlots<T extends SceneObject>(object: T, scene: SceneDocument): T & RenderableSceneObject {
  const faceMaterials = resolveSurfaceMaterials(scene, object);
  const material = findMaterial(scene.materials, object.materialSlots.main);

  if (!material) {
    // Direct image objects retain their source URL rather than binding an asset
    // through a material. Carry the matching asset MIME so Pixi can select a
    // parser for extension-less /api/assets/<id>/content URLs.
    const directAsset = object.type === "image"
      ? scene.assets.find((asset) => asset.source === object.src)
      : undefined;
    const directAssetMime = directAsset
      && directAsset.status !== "MISSING"
      && directAsset.status !== "ERROR"
      && directAsset.status !== "UNSUPPORTED"
      ? directAsset.mimeType
      : undefined;
    if (faceMaterials || directAssetMime) {
      return {
        ...object,
        faceMaterials,
        materialAssetMime: directAssetMime
      } as T & RenderableSceneObject;
    }
    return object as T & RenderableSceneObject;
  }

  const nextObject = { ...object } as RenderableSceneObject;
  if (faceMaterials) {
    nextObject.faceMaterials = faceMaterials;
  }
  const resolved = resolvePrimitiveMaterial(scene, object);
  if (!isResolvedMaterialPreviewSupported(resolved)) {
    return nextObject as T & RenderableSceneObject;
  }
  const color = material.dynamic
    ? resolveMaterialColor(material, scene.dataContext)
    : resolved?.parameters.baseColor;
  const legacyAsset = resolveMaterialAsset(material, scene.assets, scene.dataContext);
  const textureAsset = findAsset(scene.assets, resolved?.textureSlots[0]?.assetId);
  const asset = material.dynamic ? legacyAsset : textureAsset ?? legacyAsset;
  const opacity = resolved?.parameters.opacity;

  if (typeof color === "string") {
    nextObject.fill = color;
    // Rich colour values take precedence in the Pixi renderer. Updating only
    // the legacy fill string leaves an older fillStyle visible and makes a
    // successfully-bound material appear to do nothing.
    nextObject.fillStyle = { type: "solid", color };
  }

  // Three.js applies each mesh face's material opacity in createMaterial().
  // Multiplying the mesh object here as well squares the main-face opacity and
  // leaks it into independently-bound faces. Pixi primitives still need their
  // single display-object alpha multiplied here.
  if (typeof opacity === "number" && nextObject.type !== "mesh") {
    nextObject.opacity = Math.max(0, Math.min(1, nextObject.opacity * opacity));
  }

  if (asset?.status !== "MISSING" && asset?.status !== "ERROR" && asset?.status !== "UNSUPPORTED") {
    nextObject.materialAssetSource = asset?.source;
    nextObject.materialAssetMime = asset?.mimeType;
    if (
      asset
      && nextObject.type === "image"
      && Boolean(material.assetId || resolved?.textureSlots.some((slot) => Boolean(slot.assetId)))
    ) {
      nextObject.src = asset.source;
    }
  }

  nextObject.resolvedMaterial = resolved ?? undefined;
  return nextObject as T & RenderableSceneObject;
}

export function isResolvedMaterialPreviewSupported(
  resolved: ResolvedMaterial | null | undefined
): resolved is ResolvedMaterial {
  return Boolean(
    resolved
    && resolved.material.enabled !== false
    && isImplementedBlendMode(resolved.blendMode)
    && ["opaque", "straight", "premultiplied"].includes(resolved.alphaMode)
    && resolved.textureSlots.every((slot) => IMPLEMENTED_TEXTURE_FIT_MODES.includes(slot.fit))
  );
}

/**
 * Whether a source should be drawn as a moving picture.
 *
 * The extension is the weaker signal of the two. An asset served by the project service is a bare
 * `/api/assets/<id>/content` with no extension at all, so a collected movie looked exactly like a
 * still and was handed to the image loader, which produced nothing. The MIME the asset library
 * records is authoritative and is checked first.
 */
export function isVideoSource(source: string, mimeHint?: string): boolean {
  if (mimeHint?.startsWith("video/")) return true;

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
