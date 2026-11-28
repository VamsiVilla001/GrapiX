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

/// A font's file is not relinked here: the font records the family and faces
/// read from that file, and only the Fonts panel's Replace updates them with
/// the bytes (`replaceFont`).
export const FONT_ASSET_RELINK_UNAVAILABLE =
  "a font's file is replaced with Replace in the Fonts panel, which updates the font with it";

/// What a relink would send: the asset keeps its id, its users and its
/// project path, and points at the replacement's bytes (1.x's Relink).
export interface AssetRelinkPlan {
  readonly assetId: string;
  readonly newHash: string;
  readonly newSize?: NonNullable<AssetLibraryItem["sizeBytes"]>;
}

/// Check a relink before it is sent. The replacement must be the same kind of
/// asset (an image cannot stand in for a video: its users would draw nothing)
/// and must be different bytes. `refused` names the reason.
export function planAssetRelink(
  document: SceneDocument,
  assetId: string,
  replacement: Pick<AssetLibraryItem, "name" | "kind" | "checksum" | "sizeBytes">,
): AssetRelinkPlan | { readonly refused: string } {
  const asset = document.assets.find((candidate) => candidate.assetId === assetId);
  if (!asset) return { refused: `no asset ${assetId} in ${document.name}` };
  if (asset.kind === "font") return { refused: FONT_ASSET_RELINK_UNAVAILABLE };
  if (replacement.checksum === undefined) return { refused: `${replacement.name} has no content hash` };
  if (replacement.kind !== asset.kind) {
    return { refused: `${asset.name} is ${asset.kind}; ${replacement.name} is ${replacement.kind}` };
  }
  if (replacement.checksum === asset.checksum) {
    return { refused: `${asset.name} already holds the bytes of ${replacement.name}` };
  }
  return {
    assetId,
    newHash: replacement.checksum,
    ...(replacement.sizeBytes === undefined ? {} : { newSize: replacement.sizeBytes }),
  };
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
    return "import cache only: save this scene into a project to keep its assets with it";
  }
  if (asset.checksum !== undefined && state.projectStored?.has(asset.checksum) === true) {
    return `in project ${state.project}`;
  }
  return `not in project ${state.project} yet`;
}

export function previewNodes(asset: AssetLibraryItem, state: AssetManagerState): { image?: UiNode["image"]; cells: UiNode[] } {
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

export function availability(asset: SceneDocument["assets"][number]): string {
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

export function provenanceCells(asset: AssetLibraryItem): UiNode[] {
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
