import {
  buildScenePackageManifest,
  preflightScenePackage,
  type AssetKind,
  type SceneDocument,
  type ScenePackageAssetEntry,
  type ScenePackageManifest,
  type ScenePackagePreflight
} from "@grapix/shared-types";
import { createHash } from "node:crypto";
import path from "node:path";
import JSZip from "jszip";
import { readStoredAssetContent } from "./storage.js";

export interface BuiltScenePackage {
  buffer: Buffer;
  preflight: ScenePackagePreflight;
  fileName: string;
  manifest: ScenePackageManifest;
  checksums: Record<string, string>;
}

export interface VerifiedScenePackage {
  manifest: ScenePackageManifest;
  fileCount: number;
  checksums: Record<string, string>;
}

interface BindingTableEntry {
  kind: "object" | "material";
  targetId: string;
  property: string;
  path: string;
}

interface ChecksumsFile {
  algorithm: "sha256";
  files: Record<string, string>;
}

export async function buildScenePackage(scene: SceneDocument): Promise<BuiltScenePackage> {
  const preflight = preflightScenePackage(scene);

  if (!preflight.ok) {
    throw new Error("Scene package preflight failed");
  }

  const zip = new JSZip();
  const packageFiles = new Map<string, Buffer>();
  const assetEntries: ScenePackageAssetEntry[] = [];

  for (const asset of scene.assets) {
    const packaged = await resolveAssetBytes(asset);
    const packagePath = packagedAssetPath(asset.kind, asset.assetId, asset.name, asset.mimeType);
    const checksum = sha256(packaged);
    packageFiles.set(packagePath, packaged);
    assetEntries.push({
      assetId: asset.assetId,
      name: asset.name,
      kind: asset.kind,
      path: packagePath,
      mimeType: asset.mimeType,
      sizeBytes: packaged.byteLength,
      checksum
    });
  }

  const manifest = buildScenePackageManifest(scene, assetEntries);
  packageFiles.set("manifest.json", jsonBuffer(manifest));
  packageFiles.set("scene.json", jsonBuffer(scene));
  packageFiles.set("materials.json", jsonBuffer(scene.materials));
  packageFiles.set("bindings.json", jsonBuffer(createBindingTable(scene)));
  packageFiles.set("timeline.json", jsonBuffer(scene.timeline));
  if (scene.fonts?.length) packageFiles.set("fonts.json", jsonBuffer(scene.fonts));
  if (scene.automation) packageFiles.set("automation.json", jsonBuffer(scene.automation));
  packageFiles.set("metadata.json", jsonBuffer({
    generator: "GrapiX project service",
    packageVersion: manifest.packageVersion,
    sceneRevision: manifest.sceneRevision,
    generatedAt: manifest.createdAt,
    sourceSceneUpdatedAt: scene.updatedAt
  }));

  const checksums = Object.fromEntries(
    [...packageFiles.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([filePath, bytes]) => [filePath, sha256(bytes)])
  );
  const checksumsFile: ChecksumsFile = { algorithm: "sha256", files: checksums };
  packageFiles.set("checksums.json", jsonBuffer(checksumsFile));

  for (const [filePath, bytes] of packageFiles) {
    zip.file(filePath, bytes);
  }

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 }
  });

  // Publishing is all-or-nothing: independently reopen the final bytes and
  // verify every declared file before storage can atomically rename it.
  await verifyScenePackage(buffer);

  return {
    buffer,
    preflight,
    fileName: `${slugify(scene.name)}.gfxpkg`,
    manifest,
    checksums
  };
}

export async function verifyScenePackage(buffer: Buffer): Promise<VerifiedScenePackage> {
  const zip = await JSZip.loadAsync(buffer, {
    checkCRC32: true,
    createFolders: false
  });
  const manifest = await readZipJson<ScenePackageManifest>(zip, "manifest.json");
  const checksumDocument = await readZipJson<ChecksumsFile>(zip, "checksums.json");

  if (manifest.packageVersion !== 2 || manifest.minimumRendererProtocolVersion !== 2) {
    throw new Error(`unsupported GrapiX package version ${String(manifest.packageVersion)}`);
  }
  if (checksumDocument.algorithm !== "sha256") {
    throw new Error(`unsupported package checksum algorithm ${String(checksumDocument.algorithm)}`);
  }

  const requiredFiles = [
    manifest.files.scene,
    manifest.files.bindings,
    manifest.files.materials,
    manifest.files.timeline,
    manifest.files.fonts,
    manifest.files.automation,
    manifest.files.metadata,
    manifest.files.checksums
  ].filter((filePath): filePath is NonNullable<typeof filePath> => filePath !== undefined);
  for (const filePath of requiredFiles) {
    if (!zip.file(filePath)) throw new Error(`package is missing required file ${filePath}`);
  }

  for (const [filePath, expected] of Object.entries(checksumDocument.files)) {
    const entry = zip.file(filePath);
    if (!entry) throw new Error(`checksums.json references missing file ${filePath}`);
    const actual = sha256(await entry.async("nodebuffer"));
    if (actual !== expected) throw new Error(`checksum mismatch for ${filePath}`);
  }

  for (const asset of manifest.assets) {
    const entry = zip.file(asset.path);
    if (!entry) throw new Error(`manifest references missing asset ${asset.path}`);
    const actual = sha256(await entry.async("nodebuffer"));
    if (actual !== asset.checksum || checksumDocument.files[asset.path] !== actual) {
      throw new Error(`asset checksum mismatch for ${asset.assetId}`);
    }
  }

  return {
    manifest,
    fileCount: Object.keys(zip.files).filter((filePath) => !zip.files[filePath].dir).length,
    checksums: checksumDocument.files
  };
}

export function createBindingTable(scene: SceneDocument): BindingTableEntry[] {
  const objectBindings = scene.objects.flatMap((object) =>
    Object.entries(object.bindings).map(([property, bindingPath]) => ({
      kind: "object" as const,
      targetId: object.id,
      property,
      path: bindingPath
    }))
  );
  const materialBindings = scene.materials.flatMap((material) =>
    material.binding
      ? [{
          kind: "material" as const,
          targetId: material.materialId,
          property: material.binding.type,
          path: material.binding.path
        }]
      : []
  );

  return [...objectBindings, ...materialBindings];
}

async function resolveAssetBytes(asset: SceneDocument["assets"][number]): Promise<Buffer> {
  const dataUrl = dataUrlToBytes(asset.source);
  if (dataUrl) return dataUrl;

  const storageAssetId = asset.storageAssetId ?? inferStorageAssetId(asset.source) ?? asset.assetId;
  const stored = await readStoredAssetContent(storageAssetId);
  if (!stored) {
    throw new Error(`asset ${asset.assetId} has no locally stored bytes`);
  }
  const actualChecksum = sha256(stored.bytes);
  if (stored.record.checksum !== actualChecksum) {
    throw new Error(`stored asset ${storageAssetId} failed its content hash`);
  }
  if (asset.checksum && asset.checksum !== actualChecksum) {
    throw new Error(`scene asset ${asset.assetId} checksum does not match stored content`);
  }
  return stored.bytes;
}

function inferStorageAssetId(source: string): string | undefined {
  const match = source.match(/\/api\/assets\/([a-zA-Z0-9_-]+)\/content(?:[?#].*)?$/);
  return match?.[1];
}

function packagedAssetPath(kind: AssetKind, assetId: string, name: string, mimeType?: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(assetId)) {
    throw new Error(`unsafe asset id ${assetId}`);
  }
  const folder = kind === "wgsl"
    ? "shaders"
    : kind === "script"
      ? "scripts"
    : kind === "font"
      ? "fonts"
      : kind === "video" || kind === "image-sequence"
        ? "media"
        : "assets";
  return `${folder}/${assetId}.${extensionForAsset(name, mimeType)}`;
}

function dataUrlToBytes(source: string): Buffer | null {
  const match = source.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
  if (!match) return null;
  return match[2]
    ? Buffer.from(match[3] ?? "", "base64")
    : Buffer.from(decodeURIComponent(match[3] ?? ""), "utf8");
}

function extensionForAsset(fileName: string, mimeType?: string): string {
  const extension = path.extname(fileName).slice(1).toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (extension) return extension;
  switch (mimeType) {
    case "image/jpeg": return "jpg";
    case "image/png": return "png";
    case "image/svg+xml": return "svg";
    case "image/webp": return "webp";
    case "video/mp4": return "mp4";
    case "font/woff": return "woff";
    case "font/woff2": return "woff2";
    case "font/ttf": return "ttf";
    case "font/otf": return "otf";
    case "application/javascript":
    case "text/javascript": return "js";
    default: return "bin";
  }
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "scene";
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readZipJson<T>(zip: JSZip, filePath: string): Promise<T> {
  const entry = zip.file(filePath);
  if (!entry) throw new Error(`package is missing ${filePath}`);
  return JSON.parse(await entry.async("string")) as T;
}
