// The asset manager panel (build plan 11.18, provenance 11.39).
//
// The library keeps the immutable store address and mutable library address
// together. A filename alone is neither: it hides the content that will render
// and it loses the project path that replacement-in-place deliberately keeps.
// Each asset also shows its provenance record. An empty field reads "not
// recorded", never a guess: an origin nobody stated is not "human".

import type { AssetLibraryItem, SceneDocument, SceneObject } from "@grapix/contracts";

import type { UiNode } from "./agent-surface";

/// File types the import picker offers. The bytes, not the extension, decide
/// the kind; the shell refuses a file that is none of these by name.
export const ASSET_FILE_EXTENSIONS = ["png", "jpg", "jpeg", "svg", "glb", "mp4", "mov", "webm", "mkv"];

export interface AssetManagerState {
  readonly selectedAssetId?: string;
  /// An import is in flight; a second one would race the first's batch.
  readonly importing?: boolean;
  /// The last import outcome, shown as a status line.
  readonly notice?: string;
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

const NOT_RECORDED = "not recorded";

function provenanceCells(asset: AssetLibraryItem): UiNode[] {
  const record = asset.provenance;
  const tool = record.tool === undefined
    ? NOT_RECORDED
    : record.tool.version === undefined
      ? record.tool.name
      : `${record.tool.name} ${record.tool.version}`;
  const fields: [string, string, string][] = [
    ["origin", "Origin", record.origin ?? NOT_RECORDED],
    ["tool", "Tool or model", tool],
    ["provider", "Provider", record.provider ?? NOT_RECORDED],
    ["license-class", "Licence class", record.licenseClass ?? NOT_RECORDED],
    ["prompt-hash", "Prompt hash", record.promptHash ?? NOT_RECORDED],
    ["sources", "Sources", record.sources.length === 0 ? NOT_RECORDED : record.sources.join(", ")],
    [
      "approval",
      "Approved by",
      record.approval === undefined ? "not approved" : `${record.approval.user} at ${record.approval.at}`,
    ],
    ["c2pa", "C2PA manifest", record.c2paManifest ?? NOT_RECORDED],
  ];
  return fields.map(([key, label, value]) => ({
    id: `asset/${asset.assetId}/provenance/${key}`,
    role: "gridcell",
    label,
    value,
  }));
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
      description: `${asset.kind} · ${availability(asset)} · origin ${asset.provenance.origin ?? NOT_RECORDED}`,
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
        ...provenanceCells(asset),
      ],
    };
  });

  const children: UiNode[] = [];
  if (state.notice !== undefined) {
    children.push({ id: "asset-manager/notice", role: "status", label: "Asset manager", value: state.notice });
  }
  children.push({ id: "asset-manager/list", role: "list", label: "Assets", children: items });
  return {
    id: "asset-manager",
    role: "region",
    label: "Assets",
    description: `${document.assets.length} asset(s) in ${document.name}`,
    actions: [
      {
        name: "importFiles",
        label: "Import files",
        ...(state.importing ? { unavailable: "an asset import is already running" } : {}),
      },
    ],
    children,
  };
}
