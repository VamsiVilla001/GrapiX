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

/// What the panel knows about one asset's preview, keyed by content hash.
/// A preview that cannot be made says why, in words, on the asset itself: an
/// empty box would read as "still loading" forever.
export type AssetPreview =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly src: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface AssetManagerState {
  readonly selectedAssetId?: string;
  /// Previews by content hash.
  readonly previews?: ReadonlyMap<string, AssetPreview>;
  /// The project the open graphic belongs to. Absent means an independent
  /// graphic, whose assets are held only in the per-user import cache until it
  /// is saved into a project.
  readonly project?: string;
  /// Content hashes of assets the project's own folder holds.
  readonly projectStored?: ReadonlySet<string>;
  /// Assets the project holds that this graphic does not use yet.
  readonly projectLibrary?: readonly AssetLibraryItem[];
  /// Assets that could not be taken into the project, with the reason.
  readonly projectProblems?: readonly string[];
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

/// Video codecs a QuickTime or MP4 file names in its sample description, by
/// four-character code. Only codecs worth naming to an author are listed.
const VIDEO_CODECS: readonly (readonly [string, string])[] = [
  ["ap4x", "ProRes 4444 XQ"],
  ["ap4h", "ProRes 4444"],
  ["apch", "ProRes 422 HQ"],
  ["apcn", "ProRes 422"],
  ["apcs", "ProRes 422 LT"],
  ["apco", "ProRes 422 Proxy"],
  ["hvc1", "HEVC (H.265)"],
  ["hev1", "HEVC (H.265)"],
  ["avc1", "H.264"],
  ["mjpa", "Motion JPEG"],
  ["vp09", "VP9"],
  ["av01", "AV1"],
];

/// Name the codec of a QuickTime/MP4 video from its bytes, looking at the head
/// and the tail where the movie header usually sits. `undefined` when none of
/// the known codes appear: the caller then says nothing about the codec rather
/// than guessing one.
export function describeVideoCodec(bytes: Uint8Array): string | undefined {
  const window = 4 * 1024 * 1024;
  const text = (view: Uint8Array): string => {
    let out = "";
    for (let index = 0; index < view.length; index += 1) out += String.fromCharCode(view[index]!);
    return out;
  };
  const head = text(bytes.subarray(0, Math.min(bytes.length, window)));
  const tail = bytes.length > window ? text(bytes.subarray(Math.max(window, bytes.length - window))) : "";
  for (const [code, name] of VIDEO_CODECS) {
    if (head.includes(code) || tail.includes(code)) return name;
  }
  return undefined;
}

/// The one-line statement of where an asset's bytes live.
export function storageStatement(
  asset: AssetLibraryItem,
  state: Pick<AssetManagerState, "project" | "projectStored">,
): string {
  if (state.project === undefined) {
    return "import cache only: save this graphic into a project to keep its assets with it";
  }
  if (asset.checksum !== undefined && state.projectStored?.has(asset.checksum) === true) {
    return `in project ${state.project}`;
  }
  return `not in project ${state.project} yet`;
}

function previewNodes(asset: AssetLibraryItem, state: AssetManagerState): { image?: UiNode["image"]; cells: UiNode[] } {
  const preview = asset.checksum === undefined ? undefined : state.previews?.get(asset.checksum);
  const label = "Preview";
  const id = `asset/${asset.assetId}/preview`;
  if (asset.checksum === undefined) {
    return { cells: [{ id, role: "gridcell", label, value: "unavailable — no content hash has arrived" }] };
  }
  if (preview === undefined || preview.kind === "loading") {
    return { cells: [{ id, role: "gridcell", label, value: "loading…" }] };
  }
  if (preview.kind === "unavailable") {
    return { cells: [{ id, role: "gridcell", label, value: `unavailable — ${preview.reason}` }] };
  }
  return { image: { src: preview.src, alt: `Preview of ${asset.name}` }, cells: [] };
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
    const preview = previewNodes(asset, state);

    return {
      id: `asset/${asset.assetId}`,
      role: "listitem",
      label: asset.name,
      description: `${asset.kind} · ${availability(asset)} · origin ${asset.provenance.origin ?? NOT_RECORDED}`,
      selected: state.selectedAssetId === asset.assetId,
      ...(preview.image === undefined ? {} : { image: preview.image }),
      children: [
        ...preview.cells,
        {
          id: `asset/${asset.assetId}/storage`,
          role: "gridcell",
          label: "Stored",
          value: storageStatement(asset, state),
        },
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
  for (const [index, problem] of (state.projectProblems ?? []).entries()) {
    children.push({ id: `asset-manager/problem/${index}`, role: "alert", label: "Asset not in project", value: problem });
  }
  children.push({ id: "asset-manager/list", role: "list", label: "Assets", children: items });

  // What the project already holds and this graphic does not use: reusing one
  // is one action, so the same file is never imported into a project twice.
  const inScene = new Set(document.assets.map((asset) => asset.checksum).filter((hash) => hash !== undefined));
  const reusable = (state.projectLibrary ?? []).filter(
    (asset) => asset.checksum === undefined || !inScene.has(asset.checksum),
  );
  if (state.project !== undefined) {
    children.push({
      id: "asset-manager/project-library",
      role: "list",
      label: `Project library · ${state.project}`,
      description:
        reusable.length === 0
          ? "every asset in this project is already in this graphic"
          : `${reusable.length} asset(s) in the project not used by this graphic`,
      children: reusable.map((asset): UiNode => {
        const preview = previewNodes(asset, state);
        const clash = document.assets.find((candidate) => candidate.assetId === asset.assetId);
        return {
          id: `project-asset/${asset.assetId}`,
          role: "listitem",
          label: asset.name,
          description: `${asset.kind} · in project ${state.project}`,
          ...(preview.image === undefined ? {} : { image: preview.image }),
          actions: [
            {
              name: "addToScene",
              label: "Add to graphic",
              ...(clash === undefined ? {} : { unavailable: `this graphic already has an asset with id ${asset.assetId}` }),
            },
          ],
          children: preview.cells,
        };
      }),
    });
  }
  return {
    id: "asset-manager",
    role: "region",
    label: "Assets",
    description:
      state.project === undefined
        ? `${document.assets.length} asset(s) in ${document.name} · independent graphic, not in a project`
        : `${document.assets.length} asset(s) in ${document.name} · kept in project ${state.project}`,
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
