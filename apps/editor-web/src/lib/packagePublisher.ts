import {
  buildScenePackageManifest,
  preflightScenePackage,
  type SceneDocument,
  type ScenePackageAssetEntry,
  type ScenePackagePreflight
} from "@grapix/shared-types";
import JSZip from "jszip";

interface PublishResult {
  preflight: ScenePackagePreflight;
  published: boolean;
}

interface BindingTableEntry {
  kind: "object" | "material";
  targetId: string;
  property: string;
  path: string;
}

export async function publishScenePackage(scene: SceneDocument): Promise<PublishResult> {
  const preflight = preflightScenePackage(scene);

  if (!preflight.ok) {
    return {
      preflight,
      published: false
    };
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

  const blob = await zip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: {
      level: 6
    }
  });

  downloadBlob(blob, `${slugify(scene.name)}.gfxpkg`);

  return {
    preflight,
    published: true
  };
}

export function summarizePreflight(preflight: ScenePackagePreflight): string {
  const issueLines = preflight.issues.map(
    (issue) => `${issue.severity.toUpperCase()}: ${issue.message}`
  );

  return [
    preflight.ok ? "Scene package is ready to publish." : "Scene package is not ready to publish.",
    `Materials: ${preflight.readyMaterials} ready, ${preflight.fallbackReadyMaterials} fallback, ${preflight.missingMaterials} missing.`,
    ...issueLines
  ].join("\n");
}

function createBindingTable(scene: SceneDocument): BindingTableEntry[] {
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
): { fileName: string; bytes: Uint8Array } | null {
  const match = source.match(/^data:([^;,]+)?(;base64)?,(.*)$/);

  if (!match) {
    return null;
  }

  const resolvedMimeType = mimeType ?? match[1] ?? "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const payload = match[3] ?? "";
  const binary = isBase64 ? atob(payload) : decodeURIComponent(payload);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));

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

function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "scene";
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
