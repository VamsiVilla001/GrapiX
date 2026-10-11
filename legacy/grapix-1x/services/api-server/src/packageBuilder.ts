import {
  buildScenePackageManifest,
  preflightScenePackage,
  type SceneDocument,
  type ScenePackageAssetEntry,
  type ScenePackagePreflight
} from "@grapix/shared-types";
import JSZip from "jszip";

export interface BuiltScenePackage {
  buffer: Buffer;
  preflight: ScenePackagePreflight;
  fileName: string;
}

interface BindingTableEntry {
  kind: "object" | "material";
  targetId: string;
  property: string;
  path: string;
}

export async function buildScenePackage(scene: SceneDocument): Promise<BuiltScenePackage> {
  const preflight = preflightScenePackage(scene);

  if (!preflight.ok) {
    throw new Error("Scene package preflight failed");
  }

  const zip = new JSZip();
  const assetEntries: ScenePackageAssetEntry[] = [];

  for (const asset of scene.assets) {
    const assetFile = dataUrlToAssetFile(asset.source, asset.assetId, asset.mimeType);

    if (!assetFile) {
      assetEntries.push({
        assetId: asset.assetId,
        name: asset.name,
        kind: asset.kind,
        path: asset.source,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes
      });
      continue;
    }

    const path = `assets/${assetFile.fileName}`;
    zip.file(path, assetFile.bytes);
    assetEntries.push({
      assetId: asset.assetId,
      name: asset.name,
      kind: asset.kind,
      path,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes
    });
  }

  zip.file("manifest.json", stableJson(buildScenePackageManifest(scene, assetEntries)));
  zip.file("scene.json", stableJson(scene));
  zip.file("materials.json", stableJson(scene.materials));
  zip.file("bindings.json", stableJson(createBindingTable(scene)));
  zip.file("timeline.json", stableJson(scene.timeline));

  return {
    buffer: await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: {
        level: 6
      }
    }),
    preflight,
    fileName: `${slugify(scene.name)}.gfxpkg`
  };
}

export function createBindingTable(scene: SceneDocument): BindingTableEntry[] {
  const objectBindings = scene.objects.flatMap((object) =>
    Object.entries(object.bindings).map(([property, path]) => ({
      kind: "object" as const,
      targetId: object.id,
      property,
      path
    }))
  );
  const materialBindings = scene.materials.flatMap((material) =>
    material.binding
      ? [
          {
            kind: "material" as const,
            targetId: material.materialId,
            property: material.binding.type,
            path: material.binding.path
          }
        ]
      : []
  );

  return [...objectBindings, ...materialBindings];
}

function dataUrlToAssetFile(
  source: string,
  assetId: string,
  mimeType: string | undefined
): { fileName: string; bytes: Buffer } | null {
  const match = source.match(/^data:([^;,]+)?(;base64)?,(.*)$/);

  if (!match) {
    return null;
  }

  const resolvedMimeType = mimeType ?? match[1] ?? "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? "";
  const bytes = isBase64
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");

  return {
    fileName: `${assetId}.${extensionForMime(resolvedMimeType)}`,
    bytes
  };
}

function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/svg+xml":
      return "svg";
    case "image/webp":
      return "webp";
    case "video/mp4":
      return "mp4";
    case "font/woff":
      return "woff";
    case "font/woff2":
      return "woff2";
    default:
      return "bin";
  }
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "scene";
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
