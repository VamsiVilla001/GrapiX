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
  const packageFiles = new Map<string, Uint8Array>();

  for (const asset of scene.assets) {
    const assetFile = dataUrlToAssetFile(asset.source, asset.assetId, asset.mimeType)
      ?? await fetchAssetFile(asset.source, asset.assetId, asset.name, asset.mimeType);
    const path = `${asset.kind === "wgsl" ? "shaders" : asset.kind === "script" ? "scripts" : asset.kind === "font" ? "fonts" : ["video", "image-sequence"].includes(asset.kind) ? "media" : "assets"}/${assetFile.fileName}`;
    packageFiles.set(path, assetFile.bytes);
    assetEntries.push({
      assetId: asset.assetId,
      name: asset.name,
      kind: asset.kind,
      path,
      mimeType: asset.mimeType,
      sizeBytes: assetFile.bytes.byteLength,
      checksum: await sha256(assetFile.bytes)
    });
  }

  const manifest = buildScenePackageManifest(scene, assetEntries);
  packageFiles.set("manifest.json", encodeJson(manifest));
  packageFiles.set("scene.json", encodeJson(scene));
  packageFiles.set("materials.json", encodeJson(scene.materials));
  packageFiles.set("bindings.json", encodeJson(createBindingTable(scene)));
  packageFiles.set("timeline.json", encodeJson(scene.timeline));
  if (scene.fonts?.length) packageFiles.set("fonts.json", encodeJson(scene.fonts));
  if (scene.automation) packageFiles.set("automation.json", encodeJson(scene.automation));
  packageFiles.set("metadata.json", encodeJson({
    generator: "GrapiX editor",
    packageVersion: manifest.packageVersion,
    sceneRevision: manifest.sceneRevision,
    generatedAt: manifest.createdAt,
    sourceSceneUpdatedAt: scene.updatedAt
  }));
  const checksums = Object.fromEntries(await Promise.all(
    [...packageFiles.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([filePath, bytes]) => [filePath, await sha256(bytes)])
  ));
  packageFiles.set("checksums.json", encodeJson({ algorithm: "sha256", files: checksums }));
  for (const [filePath, bytes] of packageFiles) zip.file(filePath, bytes);

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

async function fetchAssetFile(
  source: string,
  assetId: string,
  name: string,
  mimeType: string | undefined
): Promise<{ fileName: string; bytes: Uint8Array }> {
  const response = await fetch(source);
  if (!response.ok) throw new Error(`Could not read package asset ${assetId} (${response.status}).`);
  return {
    fileName: `${assetId}.${extensionFromName(name) || extensionForMime(mimeType ?? response.headers.get("content-type") ?? "")}`,
    bytes: new Uint8Array(await response.arrayBuffer())
  };
}

function extensionFromName(name: string): string {
  return name.toLowerCase().split(".").pop()?.replace(/[^a-z0-9]+/g, "") ?? "";
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

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
