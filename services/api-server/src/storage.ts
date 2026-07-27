import type { RundownDocument, SceneDocument } from "@grapix/shared-types";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dataRoot = process.env.GRAPIX_DATA_ROOT?.trim()
  ? path.resolve(process.env.GRAPIX_DATA_ROOT)
  : path.join(workspaceRoot, "data");
const sceneRoot = path.join(dataRoot, "scenes");
const rundownRoot = path.join(dataRoot, "rundowns");
const packageRoot = path.join(dataRoot, "packages");
const assetRoot = path.join(dataRoot, "assets");
const assetIndexRoot = path.join(assetRoot, "index");
const sceneBackupRoot = path.join(dataRoot, "backups", "scenes");
const sceneWriteLocks = new Map<string, Promise<void>>();

export interface StoredAssetRecord {
  assetId: string;
  fileName: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  importedAt: string;
  duplicate: boolean;
  referenceCount: number;
  referencedByScenes: string[];
  cacheTier: "DISK";
  lastAccessedAt: string;
}

export interface StoredSceneSummary {
  id: string;
  name: string;
  updatedAt: string;
  objectCount: number;
  assetCount: number;
  materialCount: number;
  revision: number;
}

export interface StoredPackageSummary {
  sceneId: string;
  fileName: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
}

export interface StoredRundownSummary {
  rundownId: string;
  name: string;
  updatedAt: string;
  sequenceCount: number;
  cueCount: number;
  triggerCount: number;
  revision: number;
}

export async function ensureStorage(): Promise<void> {
  await Promise.all([
    mkdir(sceneRoot, { recursive: true }),
    mkdir(rundownRoot, { recursive: true }),
    mkdir(packageRoot, { recursive: true }),
    mkdir(assetIndexRoot, { recursive: true }),
    mkdir(sceneBackupRoot, { recursive: true })
  ]);
}

export async function saveRundown(rundown: RundownDocument): Promise<StoredRundownSummary> {
  await ensureStorage();
  assertRundownDocument(rundown);
  const stored = await withSceneWriteLock(`rundown:${rundown.rundownId}`, async () => {
    const current = await readRundownUnlocked(rundown.rundownId);
    const next: RundownDocument = {
      ...rundown,
      revision: (current?.revision ?? 0) + 1,
      updatedAt: new Date().toISOString()
    };
    await atomicWriteJson(rundownPath(rundown.rundownId), next);
    return next;
  });
  return summarizeRundown(stored);
}

export async function readRundown(rundownId: string): Promise<RundownDocument | null> {
  assertSafeStorageId(rundownId, "rundownId");
  return readRundownUnlocked(rundownId);
}

export async function listRundowns(): Promise<StoredRundownSummary[]> {
  await ensureStorage();
  const files = await readdir(rundownRoot);
  const rundowns = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => JSON.parse(await readFile(path.join(rundownRoot, file), "utf8")) as RundownDocument)
  );
  return rundowns.map(summarizeRundown).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function importAssetBuffer(
  bytes: Buffer,
  fileName: string,
  mimeType: string,
  replaceAssetId?: string
): Promise<StoredAssetRecord> {
  await ensureStorage();
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const assetId = replaceAssetId
    ? assertSafeStorageId(replaceAssetId, "assetId")
    : `asset_${checksum.slice(0, 20)}`;
  const kindFolder = assetFolderForMime(mimeType, fileName);
  const extension = safeExtension(fileName, mimeType);
  const relativePath = path.posix.join("assets", kindFolder, `${assetId}.${extension}`);
  const outputPath = path.join(dataRoot, ...relativePath.split("/"));
  const existing = await readStoredAsset(assetId);

  if (existing && existing.checksum === checksum) {
    return { ...existing, duplicate: true };
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await atomicWriteFile(outputPath, bytes);

  const record: StoredAssetRecord = {
    assetId,
    fileName: path.basename(fileName),
    relativePath,
    mimeType,
    sizeBytes: bytes.byteLength,
    checksum,
    importedAt: new Date().toISOString(),
    duplicate: false,
    referenceCount: existing?.referenceCount ?? 0,
    referencedByScenes: existing?.referencedByScenes ?? [],
    cacheTier: "DISK",
    lastAccessedAt: new Date().toISOString()
  };
  await atomicWriteJson(assetRecordPath(assetId), record);

  return record;
}

export async function readStoredAsset(assetId: string): Promise<StoredAssetRecord | null> {
  try {
    const record = JSON.parse(await readFile(assetRecordPath(assetId), "utf8")) as StoredAssetRecord;
    return {
      ...record,
      referenceCount: record.referenceCount ?? 0,
      referencedByScenes: record.referencedByScenes ?? [],
      cacheTier: "DISK",
      lastAccessedAt: record.lastAccessedAt ?? record.importedAt
    };
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
    const filePath = safeDataPath(record.relativePath);
    const bytes = await readFile(filePath);
    const touched = { ...record, lastAccessedAt: new Date().toISOString() };
    await atomicWriteJson(assetRecordPath(record.assetId), touched);
    return { bytes, record: touched };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function saveScene(scene: SceneDocument): Promise<StoredSceneSummary> {
  await ensureStorage();
  assertSceneDocumentIdentity(scene);
  const stored = await withSceneWriteLock(scene.id, async () => {
    const current = await readSceneUnlocked(scene.id);
    const next = {
      ...scene,
      revision: (current?.revision ?? 0) + 1
    };
    await backupScene(current);
    await atomicWriteJson(scenePath(scene.id), next);
    return next;
  });
  await rebuildAssetReferenceIndex();
  return summarizeScene(stored);
}

export async function updateScene(
  sceneId: string,
  updater: (scene: SceneDocument) => SceneDocument
): Promise<SceneDocument | null> {
  assertSafeStorageId(sceneId, "sceneId");
  const updated = await withSceneWriteLock(sceneId, async () => {
    const scene = await readSceneUnlocked(sceneId);
    if (!scene) return null;
    const candidate = updater(scene);
    assertSceneDocumentIdentity(candidate);
    if (candidate.id !== sceneId) {
      throw new Error("scene updater cannot change the scene id");
    }
    const next = {
      ...candidate,
      revision: (scene.revision ?? 0) + 1
    };
    await backupScene(scene);
    await atomicWriteJson(scenePath(sceneId), next);
    return next;
  });
  if (updated) await rebuildAssetReferenceIndex();
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
  assertSafeStorageId(sceneId, "sceneId");
  return readSceneUnlocked(sceneId);
}

export async function recoverScene(sceneId: string): Promise<SceneDocument | null> {
  assertSafeStorageId(sceneId, "sceneId");
  await ensureStorage();
  const recovered = await withSceneWriteLock(sceneId, async () => {
    const backupDirectory = path.join(sceneBackupRoot, sceneId);
    let files: string[];
    try {
      files = await readdir(backupDirectory);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    }
    const candidates = files
      .filter((file) => /^\d+-\d+\.json$/.test(file))
      .sort((left, right) => {
        const leftTime = Number(left.slice(left.lastIndexOf("-") + 1, -5));
        const rightTime = Number(right.slice(right.lastIndexOf("-") + 1, -5));
        return rightTime - leftTime;
      });
    const latest = candidates[0];
    if (!latest) return null;
    const backup = JSON.parse(await readFile(path.join(backupDirectory, latest), "utf8")) as SceneDocument;
    assertSceneDocumentIdentity(backup);
    if (backup.id !== sceneId) throw new Error("scene backup identity does not match recovery target");
    const current = await readSceneUnlocked(sceneId);
    const next: SceneDocument = {
      ...backup,
      revision: Math.max(current?.revision ?? 0, backup.revision ?? 0) + 1,
      updatedAt: new Date().toISOString()
    };
    await backupScene(current);
    await atomicWriteJson(scenePath(sceneId), next);
    return next;
  });
  if (recovered) await rebuildAssetReferenceIndex();
  return recovered;
}

async function readSceneUnlocked(sceneId: string): Promise<SceneDocument | null> {
  try {
    const scene = JSON.parse(await readFile(scenePath(sceneId), "utf8")) as SceneDocument;
    return { ...scene, revision: scene.revision ?? 0 };
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
  const packagePath = path.join(
    packageRoot,
    `${assertSafeStorageId(sceneId, "sceneId")}-${safeName}`
  );
  await atomicWriteFile(packagePath, buffer);
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
  return path.join(sceneRoot, `${assertSafeStorageId(sceneId, "sceneId")}.json`);
}

function rundownPath(rundownId: string): string {
  return path.join(rundownRoot, `${assertSafeStorageId(rundownId, "rundownId")}.json`);
}

async function readRundownUnlocked(rundownId: string): Promise<RundownDocument | null> {
  try {
    const rundown = JSON.parse(await readFile(rundownPath(rundownId), "utf8")) as RundownDocument;
    assertRundownDocument(rundown);
    return { ...rundown, revision: rundown.revision ?? 0 };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function assetRecordPath(assetId: string): string {
  return path.join(assetIndexRoot, `${assertSafeStorageId(assetId, "assetId")}.json`);
}

function assetFolderForMime(mimeType: string, fileName: string): string {
  if (mimeType.startsWith("image/") || fileName.toLowerCase().endsWith(".svg")) return "images";
  if (mimeType.startsWith("video/")) return "videos";
  if (mimeType.startsWith("font/") || /\.(otf|ttf|woff2?)$/i.test(fileName)) return "fonts";
  if (["application/javascript", "text/javascript"].includes(mimeType) || /\.(m?js)$/i.test(fileName)) return "scripts";
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
    materialCount: scene.materials.length,
    revision: scene.revision ?? 0
  };
}

function summarizeRundown(rundown: RundownDocument): StoredRundownSummary {
  return {
    rundownId: rundown.rundownId,
    name: rundown.name,
    updatedAt: rundown.updatedAt,
    sequenceCount: rundown.sequences.length,
    cueCount: rundown.sequences.reduce(
      (total, sequence) => total + sequence.tracks.reduce((count, track) => count + track.cues.length, 0),
      0
    ),
    triggerCount: rundown.sequences.reduce((total, sequence) => total + sequence.triggers.length, 0),
    revision: rundown.revision ?? 0
  };
}

async function backupScene(scene: SceneDocument | null): Promise<void> {
  if (!scene) return;
  const backupPath = path.join(
    sceneBackupRoot,
    assertSafeStorageId(scene.id, "sceneId"),
    `${scene.revision ?? 0}-${Date.now()}.json`
  );
  await atomicWriteJson(backupPath, scene);
}

async function rebuildAssetReferenceIndex(): Promise<void> {
  const scenes = await listSceneDocuments();
  const references = new Map<string, Set<string>>();
  for (const scene of scenes) {
    for (const asset of scene.assets) {
      const storageAssetId = asset.storageAssetId ?? asset.assetId;
      if (!references.has(storageAssetId)) references.set(storageAssetId, new Set());
      references.get(storageAssetId)?.add(scene.id);
    }
  }

  const files = await readdir(assetIndexRoot);
  await Promise.all(
    files.filter((file) => file.endsWith(".json")).map(async (file) => {
      const assetId = path.basename(file, ".json");
      const record = await readStoredAsset(assetId);
      if (!record) return;
      const sceneIds = [...(references.get(assetId) ?? [])].sort();
      await atomicWriteJson(assetRecordPath(assetId), {
        ...record,
        referenceCount: sceneIds.length,
        referencedByScenes: sceneIds
      });
    })
  );
}

async function listSceneDocuments(): Promise<SceneDocument[]> {
  await ensureStorage();
  const files = await readdir(sceneRoot);
  return Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => JSON.parse(await readFile(path.join(sceneRoot, file), "utf8")) as SceneDocument)
  );
}

async function atomicWriteJson(targetPath: string, value: unknown): Promise<void> {
  await atomicWriteFile(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}

async function atomicWriteFile(targetPath: string, data: string | Buffer): Promise<void> {
  const parent = path.dirname(targetPath);
  await mkdir(parent, { recursive: true });
  const temporaryPath = path.join(
    parent,
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, "wx");
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function withSceneWriteLock<T>(sceneId: string, operation: () => Promise<T>): Promise<T> {
  const previous = sceneWriteLocks.get(sceneId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => gate);
  sceneWriteLocks.set(sceneId, queued);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (sceneWriteLocks.get(sceneId) === queued) sceneWriteLocks.delete(sceneId);
  }
}

function safeDataPath(relativePath: string): string {
  const resolved = path.resolve(dataRoot, ...relativePath.split("/"));
  const rootWithSeparator = `${path.resolve(dataRoot)}${path.sep}`;
  if (!resolved.startsWith(rootWithSeparator)) {
    throw new Error("stored asset path escapes the GrapiX data directory");
  }
  return resolved;
}

function assertSceneDocumentIdentity(scene: SceneDocument): void {
  assertSafeStorageId(scene.id, "scene.id");
  if (scene.version !== 1) {
    throw new Error(`unsupported SceneDocument version ${String(scene.version)}`);
  }
}

function assertRundownDocument(rundown: RundownDocument): void {
  assertSafeStorageId(rundown.rundownId, "rundownId");
  if (rundown.version !== 1) throw new Error(`unsupported RundownDocument version ${String(rundown.version)}`);
  if (!rundown.name.trim() || rundown.name.length > 180) throw new Error("rundown name must contain 1 to 180 characters");
  if (rundown.sequences.length > 128) throw new Error("a rundown may contain at most 128 sequences");
  const sequenceIds = new Set<string>();
  for (const sequence of rundown.sequences) {
    assertSafeStorageId(sequence.sequenceId, "sequenceId");
    if (sequenceIds.has(sequence.sequenceId)) throw new Error(`duplicate sequence ${sequence.sequenceId}`);
    sequenceIds.add(sequence.sequenceId);
    if (!Number.isFinite(sequence.fps) || sequence.fps < 1 || sequence.fps > 120) {
      throw new Error(`sequence ${sequence.sequenceId} has an invalid frame rate`);
    }
    if (!Number.isInteger(sequence.durationFrames) || sequence.durationFrames < 1) {
      throw new Error(`sequence ${sequence.sequenceId} has an invalid duration`);
    }
    if (sequence.tracks.length > 64) throw new Error(`sequence ${sequence.sequenceId} exceeds 64 tracks`);
    if (sequence.triggers.length > 256) throw new Error(`sequence ${sequence.sequenceId} exceeds 256 triggers`);
    const trackIds = new Set<string>();
    let cueCount = 0;
    for (const track of sequence.tracks) {
      assertSafeStorageId(track.trackId, "trackId");
      if (trackIds.has(track.trackId)) throw new Error(`duplicate track ${track.trackId}`);
      trackIds.add(track.trackId);
      cueCount += track.cues.length;
      if (cueCount > 4096) throw new Error(`sequence ${sequence.sequenceId} exceeds 4096 cues`);
      const cueIds = new Set<string>();
      for (const cue of track.cues) {
        assertSafeStorageId(cue.cueId, "cueId");
        assertSafeStorageId(cue.sceneId, "cue.sceneId");
        if (cueIds.has(cue.cueId)) throw new Error(`duplicate cue ${cue.cueId} on track ${track.trackId}`);
        cueIds.add(cue.cueId);
        if (!Number.isInteger(cue.startFrame) || cue.startFrame < 0
          || !Number.isInteger(cue.durationFrames) || cue.durationFrames < 1
          || !Number.isInteger(cue.prewarmFrames) || cue.prewarmFrames < 0) {
          throw new Error(`cue ${cue.cueId} has invalid frame timing`);
        }
      }
    }
    for (const trigger of sequence.triggers) {
      assertSafeStorageId(trigger.triggerId, "triggerId");
      if (trigger.actions.length < 1 || trigger.actions.length > 32) {
        throw new Error(`trigger ${trigger.triggerId} must contain 1 to 32 actions`);
      }
    }
  }
}

function assertSafeStorageId(value: string, label: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new Error(`${label} must contain only letters, numbers, underscore, or hyphen`);
  }
  return value;
}
