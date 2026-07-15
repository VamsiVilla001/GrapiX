import type { SceneDocument } from "@grapix/shared-types";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dataRoot = path.join(workspaceRoot, "data");
const sceneRoot = path.join(dataRoot, "scenes");
const packageRoot = path.join(dataRoot, "packages");
const assetRoot = path.join(dataRoot, "assets");
const assetIndexRoot = path.join(assetRoot, "index");

export interface StoredAssetRecord {
  assetId: string;
  fileName: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  importedAt: string;
  duplicate: boolean;
}

export interface StoredSceneSummary {
  id: string;
  name: string;
  updatedAt: string;
  objectCount: number;
  assetCount: number;
  materialCount: number;
}

export interface StoredPackageSummary {
  sceneId: string;
  fileName: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
}

export async function ensureStorage(): Promise<void> {
  await Promise.all([
    mkdir(sceneRoot, { recursive: true }),
    mkdir(packageRoot, { recursive: true }),
    mkdir(assetIndexRoot, { recursive: true })
  ]);
}

export async function importAssetBuffer(
  bytes: Buffer,
  fileName: string,
  mimeType: string,
  replaceAssetId?: string
): Promise<StoredAssetRecord> {
  await ensureStorage();
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const assetId = replaceAssetId?.replace(/[^a-zA-Z0-9_-]+/g, "-") || `asset_${checksum.slice(0, 20)}`;
  const kindFolder = assetFolderForMime(mimeType, fileName);
  const extension = safeExtension(fileName, mimeType);
  const relativePath = path.posix.join("assets", kindFolder, `${assetId}.${extension}`);
  const outputPath = path.join(dataRoot, ...relativePath.split("/"));
  const existing = await readStoredAsset(assetId);

  if (existing && existing.checksum === checksum) {
    return { ...existing, duplicate: true };
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes);

  const record: StoredAssetRecord = {
    assetId,
    fileName: path.basename(fileName),
    relativePath,
    mimeType,
    sizeBytes: bytes.byteLength,
    checksum,
    importedAt: new Date().toISOString(),
    duplicate: false
  };
  await writeFile(assetRecordPath(assetId), `${JSON.stringify(record, null, 2)}\n`, "utf8");

  return record;
}

export async function readStoredAsset(assetId: string): Promise<StoredAssetRecord | null> {
  try {
    return JSON.parse(await readFile(assetRecordPath(assetId), "utf8")) as StoredAssetRecord;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function readStoredAssetContent(
  assetId: string
): Promise<{ bytes: Buffer; record: StoredAssetRecord } | null> {
  const record = await readStoredAsset(assetId);
  if (!record) return null;

  try {
    const filePath = path.join(dataRoot, ...record.relativePath.split("/"));
    return { bytes: await readFile(filePath), record };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function saveScene(scene: SceneDocument): Promise<StoredSceneSummary> {
  await ensureStorage();
  await writeFile(scenePath(scene.id), `${JSON.stringify(scene, null, 2)}\n`, "utf8");
  return summarizeScene(scene);
}

export async function updateScene(
  sceneId: string,
  updater: (scene: SceneDocument) => SceneDocument
): Promise<SceneDocument | null> {
  const scene = await readScene(sceneId);

  if (!scene) {
    return null;
  }

  const updated = updater(scene);
  await saveScene(updated);
  return updated;
}

export async function listScenes(): Promise<StoredSceneSummary[]> {
  await ensureStorage();
  const files = await readdir(sceneRoot);
  const summaries = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => summarizeScene(JSON.parse(await readFile(path.join(sceneRoot, file), "utf8")) as SceneDocument))
  );

  return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readScene(sceneId: string): Promise<SceneDocument | null> {
  try {
    return JSON.parse(await readFile(scenePath(sceneId), "utf8")) as SceneDocument;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

export async function savePackage(
  sceneId: string,
  fileName: string,
  buffer: Buffer
): Promise<StoredPackageSummary> {
  await ensureStorage();
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const packagePath = path.join(packageRoot, `${sceneId}-${safeName}`);
  await writeFile(packagePath, buffer);
  const stats = await stat(packagePath);

  return {
    sceneId,
    fileName: path.basename(packagePath),
    path: packagePath,
    sizeBytes: stats.size,
    createdAt: new Date(stats.mtimeMs).toISOString()
  };
}

function scenePath(sceneId: string): string {
  return path.join(sceneRoot, `${sceneId.replace(/[^a-zA-Z0-9_-]+/g, "-")}.json`);
}

function assetRecordPath(assetId: string): string {
  return path.join(assetIndexRoot, `${assetId.replace(/[^a-zA-Z0-9_-]+/g, "-")}.json`);
}

function assetFolderForMime(mimeType: string, fileName: string): string {
  if (mimeType.startsWith("image/") || fileName.toLowerCase().endsWith(".svg")) return "images";
  if (mimeType.startsWith("video/")) return "videos";
  if (mimeType.startsWith("font/") || /\.(otf|ttf|woff2?)$/i.test(fileName)) return "fonts";
  if (fileName.toLowerCase().endsWith(".wgsl")) return "shaders";
  return "other";
}

function safeExtension(fileName: string, mimeType: string): string {
  const extension = path.extname(fileName).slice(1).toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (extension) return extension;
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/svg+xml") return "svg";
  return "bin";
}

function summarizeScene(scene: SceneDocument): StoredSceneSummary {
  return {
    id: scene.id,
    name: scene.name,
    updatedAt: scene.updatedAt,
    objectCount: scene.objects.length,
    assetCount: scene.assets.length,
    materialCount: scene.materials.length
  };
}
