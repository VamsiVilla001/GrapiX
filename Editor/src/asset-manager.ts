// The asset manager panel (build plan 11.18).
//
// The library keeps the immutable store address and mutable library address
// together. A filename alone is neither: it hides the content that will render
// and it loses the project path that replacement-in-place deliberately keeps.

import type { SceneDocument, SceneObject } from "@grapix/contracts";

import type { UiNode } from "./agent-surface";

export interface AssetManagerState {
  readonly selectedAssetId?: string;
}

/// The object ids that reference an asset, in document order.
///
/// Covers `ImageObject.assetId`, `MeshObject.modelAssetId`, and
/// `ObjectBase.materialSlots -> MaterialDefinition.textures[].assetId`.
/// A material texture reaches every object assigned that material, not only a
/// mesh, because material slots are part of the shared object base.
export function assetUsers(document: SceneDocument, assetId: string): string[] {
  return document.objects
    .filter((object) => usesAsset(document, object, assetId))
    .map((object) => object.id);
}

function usesAsset(document: SceneDocument, object: SceneObject, assetId: string): boolean {
  if (object.type === "image" && object.assetId === assetId) return true;
  if (object.type === "mesh" && object.modelAssetId === assetId) return true;

  const materialIds = Object.values(object.materialSlots ?? {})
    .filter((binding): binding is { materialId: string } => Boolean(binding))
    .map((binding) => binding.materialId);
  return document.materials.some(
    (material) =>
      materialIds.includes(material.materialId) &&
      material.textures.some((texture) => texture.assetId === assetId),
  );
}

function availability(asset: SceneDocument["assets"][number]): string {
  switch (asset.status) {
    case "ready":
      return "ready — bytes are available";
    case "missing":
      return "missing — declared but bytes have not arrived";
    case "importing":
      return "importing — declared but bytes have not arrived";
    case "unsupported":
      return "unsupported — bytes cannot be used";
    case "error":
      return "error — bytes could not be read";
    default:
      return "not reported — scene does not state whether bytes are available";
  }
}

export function assetManagerPanel(
  document: SceneDocument,
  state: AssetManagerState = {},
): UiNode {
  const items: UiNode[] = document.assets.map((asset) => {
    const users = assetUsers(document, asset.assetId);

    return {
      id: `asset/${asset.assetId}`,
      role: "listitem",
      label: asset.name,
      description: `${asset.kind} · ${availability(asset)}`,
      selected: state.selectedAssetId === asset.assetId,
      children: [
        {
          id: `asset/${asset.assetId}/kind`,
          role: "gridcell",
          label: "Kind",
          value: asset.kind,
        },
        {
          id: `asset/${asset.assetId}/content-hash`,
          role: "gridcell",
          label: "Content hash (store address)",
          value: asset.checksum ?? "not available — no content hash has arrived",
        },
        {
          id: `asset/${asset.assetId}/path`,
          role: "gridcell",
          label: "Project-relative path (library address)",
          value: asset.path,
        },
        {
          id: `asset/${asset.assetId}/availability`,
          role: "gridcell",
          label: "Availability",
          value: availability(asset),
        },
        {
          id: `asset/${asset.assetId}/usage`,
          role: "gridcell",
          label: "Used by",
          value:
            users.length === 0
              ? "used by no objects"
              : `used by ${users.length} object(s): ${users.join(", ")}`,
        },
      ],
    };
  });

  return {
    id: "asset-manager",
    role: "region",
    label: "Assets",
    description: `${document.assets.length} asset(s) in ${document.name}`,
    children: [
      { id: "asset-manager/list", role: "list", label: "Assets", children: items },
    ],
  };
}
