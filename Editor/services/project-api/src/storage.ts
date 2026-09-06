import {
  AE_RUNTIME_CONTAINER_SCHEMA_VERSION,
  AE_DYNAMIC_CONTROL_UUID_PATTERN,
  AeRuntimeContainerError,
  type AeRuntimeContainer,
  type CreateAeRuntimeContainerRequest,
  type UpdateAeRuntimeContainerRequest
} from "@grapix/ae-runtime-contract";
import type { RundownDocument, SceneDocument } from "@grapix/shared-types";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

import { projectDataRoot } from "./dataRoot.js";
import { currentProject, projectFolder } from "./projectWorkspace.js";


const dataRoot = projectDataRoot();

/**
 * The service's own state directory.
 *
 * Re-exported from here because most of this service already imports it from `storage`. The
 * definition moved to `dataRoot.ts` when storage began resolving paths through the open project:
 * `projectWorkspace` needs the data root, storage needs the project, and one of the two had to
 * stop being the other's dependency.
 */
export { projectDataRoot };

/* ── Where a scene's work lives ─────────────────────────────────────────────────────────────
 *
 * Scenes, their backups, their autosaves and the packages built from them belong to a project,
 * not to this service, so each one is resolved when it is needed rather than joined once at
 * import. `projectFolder` refuses with `NO_PROJECT_OPEN` when there is no project, which is what
 * makes "you can work, but nothing is written until you save it somewhere" true of the service
 * rather than merely of the UI that calls it.
 *
 * Rundowns, the asset store and the AE root registry stay on the data root. Rundowns are
 * Playout's domain; the asset store is about to change shape entirely when assets become
 * references with an explicit collect step, and moving it twice would migrate the same bytes for
 * nothing.
 */

/**
 * A project folder that exists, refusing when there is no project.
 *
 * The folders are created when the project is opened, so the `mkdir` is almost always a no-op —
 * but "almost always" is the wrong guarantee for a write path. A project restored from the saved
 * pointer is only read, never re-created, and a folder an operator moved or deleted between
 * sessions would otherwise turn the next save into `ENOENT` on a path that looks perfectly valid.
 */
async function ensuredProjectFolder(folder: "scenes" | "packages" | "backups" | "autosaves"): Promise<string> {
  const resolved = await projectFolder(folder);
  await mkdir(resolved, { recursive: true });
  return resolved;
}

/** `<project>/Scenes` — the scenes an operator opens. */
async function sceneRoot(): Promise<string> {
  return ensuredProjectFolder("scenes");
}

/**
 * `<project>/Scenes`, or `null` when the session has no project yet.
 *
 * Listing is a question, not a write. "Which scenes are saved?" has a true answer before a project
 * exists — none — and refusing it would make every scene picker show an error where it should show
 * an empty list. Writers use `sceneRoot()` and get the refusal; readers use this and get nothing.
 */
async function openSceneRoot(): Promise<string | null> {
  const { root } = await currentProject();
  return root ? projectFolder("scenes") : null;
}

/** `<project>/Packages` — built `.gpxpkg` scene packages. */
async function packageRoot(): Promise<string> {
  return ensuredProjectFolder("packages");
}

/** `<project>/Backups` — pre-write copies, per scene. */
async function sceneBackupRoot(): Promise<string> {
  return ensuredProjectFolder("backups");
}

/**
 * `<project>/Autosaves` — snapshots, deliberately outside `Scenes/`.
 *
 * `listScenes` reads `Scenes/` and would otherwise offer autosaves in every scene picker —
 * and eventually let someone publish one to air.
 */
async function sceneAutosaveRoot(): Promise<string> {
  return ensuredProjectFolder("autosaves");
}

const rundownRoot = path.join(dataRoot, "rundowns");
const assetRoot = path.join(dataRoot, "assets");
const assetIndexRoot = path.join(assetRoot, "index");
const autosaveIndexFile = "index.json";
/**
 * Pre-write copies kept per scene. Deeper than the autosave ring because these are cheap
 * insurance against a bad write, not a history anyone browses.
 */
const backupRetention = 20;
/**
 * After Effects defaults to 5. A broadcast day is long and its deadlines are hard, so the
 * default here is deeper; Preferences allows 1-50.
 */
const defaultAutosaveVersions = 10;
const sceneWriteLocks = new Map<string, Promise<void>>();
const fileWriteLocks = new Map<string, Promise<void>>();
const aeContainerLocks = new Map<string, Promise<void>>();

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

/** One slot in a scene's autosave ring. */
export interface StoredAutosaveEntry {
  /** 1-based ring slot. Stable across overwrites, which is what the file name encodes. */
  version: number;
  fileName: string;
  /** Scene name at snapshot time, so a rename is visible in the recovery list. */
  sceneName: string;
  revision: number;
  savedAt: string;
  sizeBytes: number;
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

/**
 * Create the service's own directories.
 *
 * Only the service's: the project's folders are created by `createOrOpenProject` when the operator
 * chooses where the project lives. Creating them here would mean every read path that calls this
 * first — and most do — refuses with `NO_PROJECT_OPEN` before it can answer a harmless question
 * like "are there any rundowns", which is not the same as "you cannot save yet".
 */
export async function ensureStorage(): Promise<void> {
  await Promise.all([
    mkdir(rundownRoot, { recursive: true }),
    mkdir(assetIndexRoot, { recursive: true })
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

/**
 * Why a container operation refuses before it looks at a path.
 *
 * Names the remedy rather than only the variable: the packaged Editor provisions a root of its own, so
 * an operator only ever sees this when running from a checkout or after clearing the variable, and the
 * next step is then the useful part of the sentence.
 */
const AE_PROJECT_ROOT_NOT_CONFIGURED_MESSAGE =
  "no After Effects project is available yet: choose one in the After Effects connector, or set " +
  "GRAPIX_AE_PROJECT_ROOTS to one or more directories containing .aep projects";

/** Where the projects an author has chosen are remembered between restarts. */
const aeProjectRegistryPath = path.join(dataRoot, "ae-project-roots.json");

/**
 * Roots an author added by choosing a project, cached after the first read.
 *
 * `null` means "not read yet" rather than "empty", so an empty registry is not re-read from disk on
 * every resolve — and every resolve does read it, because the browser calls this per composition.
 */
let registeredRoots: string[] | null = null;

function readRegisteredRootsSync(): string[] {
  if (registeredRoots) return registeredRoots;
  try {
    const parsed = JSON.parse(readFileSync(aeProjectRegistryPath, "utf8")) as { roots?: unknown };
    registeredRoots = Array.isArray(parsed.roots)
      ? parsed.roots.filter((root): root is string => typeof root === "string").map((root) => path.resolve(root))
      : [];
  } catch {
    // A missing or unreadable registry is simply no remembered projects. It must never stop the
    // service booting: an author can always choose a project again.
    registeredRoots = [];
  }
  return registeredRoots;
}

/**
 * Remember the directory of a project an author chose.
 *
 * This is what replaces up-front configuration. The allowlist still exists and still refuses
 * anything outside it — that is what stops a crafted `projectUri` reading arbitrary files — but it
 * now grows by an explicit, authenticated act rather than by an environment variable set before the
 * service started.
 *
 * The *file* is registered and its containing directory becomes the root, never a directory the
 * caller names: "trust this folder" is a much larger grant than "I picked this project", and only
 * the second is what the author actually did. Even then the reach is bounded — `resolveAeProjectUri`
 * resolves nothing but `.aep` files.
 */
export async function registerAeProjectPath(projectPath: string): Promise<{ root: string; projectUri: string }> {
  const resolved = path.resolve(projectPath);
  if (path.extname(resolved).toLowerCase() !== ".aep") {
    throw new AeRuntimeContainerError("INVALID_PROJECT_URI", "only an .aep project can be registered");
  }
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new AeRuntimeContainerError("PROJECT_NOT_FOUND", `no file exists at ${resolved}`);
  }
  if (!info.isFile()) {
    throw new AeRuntimeContainerError("INVALID_PROJECT_URI", `${resolved} is not a file`);
  }

  const root = path.dirname(resolved);
  const roots = readRegisteredRootsSync();
  if (!roots.some((existing) => existing.toLowerCase() === root.toLowerCase())) {
    const next = [...roots, root];
    await mkdir(dataRoot, { recursive: true });
    await writeFile(aeProjectRegistryPath, `${JSON.stringify({ roots: next }, null, 2)}
`);
    registeredRoots = next;
  }

  return { root, projectUri: path.basename(resolved) };
}

/** Forget a remembered root, so a project an author is done with stops being readable. */
export async function forgetAeProjectRoot(root: string): Promise<void> {
  const target = path.resolve(root);
  const next = readRegisteredRootsSync().filter((existing) => existing.toLowerCase() !== target.toLowerCase());
  await mkdir(dataRoot, { recursive: true });
  await writeFile(aeProjectRegistryPath, `${JSON.stringify({ roots: next }, null, 2)}
`);
  registeredRoots = next;
}

/**
 * The directories a project may be read from: chosen by an author, or configured for the facility.
 *
 * Exported so the project browser can enumerate them: a browser that took its own view of which
 * roots are allowed would be a second answer to the question `resolveAeProjectUri` already refuses
 * on, and the two would drift.
 */
export function configuredAeProjectRoots(): string[] {
  const fromEnvironment = (process.env.GRAPIX_AE_PROJECT_ROOTS ?? "")
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => path.resolve(root));

  const all = [...fromEnvironment, ...readRegisteredRootsSync()];
  // Deduplicated case-insensitively: Windows will happily hand back the same directory spelled two
  // ways, and a duplicated root makes the browser list every project twice.
  const seen = new Set<string>();
  return all.filter((root) => {
    const key = root.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Every allowlisted candidate for one project URI, in root order.
 *
 * A URI is root-relative, so it is *within* every root it resolves under — "within" alone cannot
 * pick the right root when two roots could hold the same relative path. The existence-aware
 * resolver below is what actually chooses; this only enforces the allowlist.
 */
function aeProjectCandidates(projectUri: string): { normalized: string; candidates: { root: string; projectPath: string; projectUri: string }[] } {
  const roots = configuredAeProjectRoots();
  if (roots.length === 0) {
    throw new AeRuntimeContainerError(
      "AE_PROJECT_ROOT_NOT_CONFIGURED",
      AE_PROJECT_ROOT_NOT_CONFIGURED_MESSAGE
    );
  }
  if (!projectUri || path.isAbsolute(projectUri) || projectUri.includes("\\") || projectUri.includes("\0")) {
    throw new AeRuntimeContainerError("INVALID_PROJECT_URI", "projectUri must be a root-relative POSIX path");
  }
  const segments = projectUri.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new AeRuntimeContainerError("INVALID_PROJECT_URI", "projectUri contains an invalid path segment");
  }
  if (path.posix.extname(projectUri).toLowerCase() !== ".aep") {
    throw new AeRuntimeContainerError("INVALID_PROJECT_URI", "projectUri must reference an .aep project");
  }
  const normalized = segments.join("/");
  const candidates: { root: string; projectPath: string; projectUri: string }[] = [];
  for (const root of roots) {
    const projectPath = path.resolve(root, ...segments);
    if (isPathWithin(root, projectPath)) candidates.push({ root, projectPath, projectUri: normalized });
  }
  return { normalized, candidates };
}

/**
 * Resolve one client-safe project URI under exactly one configured root.
 *
 * Synchronous, so it cannot check existence: it returns the first allowlisted candidate. That is
 * only ever correct for a caller doing nothing but an allowlist check — every caller that then
 * touches the file MUST use `resolveExistingAeProjectUri`, because a root-relative URI resolves
 * "within" every configured root and the first one is not necessarily the one holding the project.
 */
export function resolveAeProjectUri(projectUri: string): { root: string; projectPath: string; projectUri: string } {
  const { candidates } = aeProjectCandidates(projectUri);
  if (candidates.length > 0) return candidates[0];
  throw new AeRuntimeContainerError("INVALID_PROJECT_URI", "projectUri is outside every allowlisted project root");
}

/**
 * Resolve one project URI to the root where the file actually exists.
 *
 * The allowlist holds more than one root — one provisioned by the installation, plus one per
 * project an author has chosen — and a root-relative URI is *within* all of them. Picking the
 * first "within" candidate (the sync resolver's behaviour) stats the project under the wrong
 * root whenever the same relative path resolves under an earlier, emptier root. So each candidate
 * is checked in order and the first that exists on disk wins. Only when none exists does this
 * fall back to the first allowlisted candidate, which is the path a *create* should write to.
 */
export async function resolveExistingAeProjectUri(projectUri: string): Promise<{ root: string; projectPath: string; projectUri: string }> {
  const { candidates } = aeProjectCandidates(projectUri);
  if (candidates.length === 0) {
    throw new AeRuntimeContainerError("INVALID_PROJECT_URI", "projectUri is outside every allowlisted project root");
  }
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate.projectPath)).isFile()) return candidate;
    } catch {
      // Not under this root — try the next.
    }
  }
  return candidates[0];
}

export async function createAeRuntimeContainer(
  request: CreateAeRuntimeContainerRequest
): Promise<AeRuntimeContainer> {
  const id = assertAeContainerId(request.id);
  return withKeyedLock(aeContainerLocks, id, async () => {
    // Existence-aware: the *sidecar* being written is new, but the project it is declared against
    // must already exist — this digests it on the next line.
    const resolved = await resolveExistingAeProjectUri(request.projectUri);
    const digest = await digestAeProject(resolved.projectPath);
    if (digest !== request.projectDigest.toLowerCase()) {
      throw new AeRuntimeContainerError(
        "PROJECT_DIGEST_MISMATCH",
        `project digest ${digest} does not match requested digest ${request.projectDigest.toLowerCase()}`
      );
    }
    const target = aeContainerSidecarPath(resolved.projectPath, id);
    if (await pathExists(target)) {
      throw new AeRuntimeContainerError("CONTAINER_ALREADY_EXISTS", `container ${id} already exists`);
    }
    const now = new Date().toISOString();
    const container: AeRuntimeContainer = {
      schemaVersion: AE_RUNTIME_CONTAINER_SCHEMA_VERSION,
      id,
      name: request.name.trim(),
      projectUri: resolved.projectUri,
      projectDigest: digest,
      profile: request.profile,
      compositions: request.compositions,
      controls: request.controls ?? [],
      dataBindings: request.dataBindings ?? [],
      cachePolicy: request.cachePolicy,
      status: "offline",
      createdAt: now,
      updatedAt: now
    };
    assertAeRuntimeContainer(container);
    await atomicWriteJson(target, container);
    return container;
  });
}

export async function readAeRuntimeContainer(containerId: string): Promise<AeRuntimeContainer | null> {
  const id = assertAeContainerId(containerId);
  for (const root of configuredAeProjectRoots()) {
    const found = await findAeContainerSidecar(root, id);
    if (!found) continue;
    const container = JSON.parse(await readFile(found, "utf8")) as AeRuntimeContainer;
    assertAeRuntimeContainer(container);
    const resolved = await resolveExistingAeProjectUri(container.projectUri);
    const digest = await digestAeProject(resolved.projectPath);
    if (digest !== container.projectDigest) {
      throw new AeRuntimeContainerError(
        "PROJECT_DIGEST_MISMATCH",
        `authoritative project digest changed for container ${id}`
      );
    }
    return container;
  }
  return null;
}

export async function listAeRuntimeContainers(): Promise<AeRuntimeContainer[]> {
  const roots = configuredAeProjectRoots();
  if (roots.length === 0) {
    throw new AeRuntimeContainerError(
      "AE_PROJECT_ROOT_NOT_CONFIGURED",
      AE_PROJECT_ROOT_NOT_CONFIGURED_MESSAGE
    );
  }
  const containers: AeRuntimeContainer[] = [];
  for (const root of roots) {
    for (const sidecar of await listAeContainerSidecars(root)) {
      const container = JSON.parse(await readFile(sidecar, "utf8")) as AeRuntimeContainer;
      assertAeRuntimeContainer(container);
      containers.push(container);
    }
  }
  return containers.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function updateAeRuntimeContainer(
  containerId: string,
  update: UpdateAeRuntimeContainerRequest
): Promise<AeRuntimeContainer | null> {
  const id = assertAeContainerId(containerId);
  return withKeyedLock(aeContainerLocks, id, async () => {
    const current = await readAeRuntimeContainer(id);
    if (!current) return null;
    const resolved = await resolveExistingAeProjectUri(current.projectUri);
    const next: AeRuntimeContainer = {
      ...current,
      ...(update.name !== undefined ? { name: update.name.trim() } : {}),
      ...(update.profile !== undefined ? { profile: update.profile } : {}),
      ...(update.compositions !== undefined ? { compositions: update.compositions } : {}),
      ...(update.controls !== undefined ? { controls: update.controls } : {}),
      ...(update.dataBindings !== undefined ? { dataBindings: update.dataBindings } : {}),
      ...(update.cachePolicy !== undefined ? { cachePolicy: update.cachePolicy } : {}),
      ...(update.status !== undefined ? { status: update.status } : {}),
      updatedAt: new Date().toISOString()
    };
    assertAeRuntimeContainer(next);
    await atomicWriteJson(aeContainerSidecarPath(resolved.projectPath, id), next);
    return next;
  });
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

/**
 * Where a scene's images live on disk: `images/<scene>/<file>`.
 *
 * A second home for bytes beside the content-addressed asset store, and deliberately so. The asset
 * store is keyed by hash, which is right for deduplication and wrong for a human: a designer
 * looking for the photo they imported finds `assets/images/asset_9f2c….png`. Imported design images
 * land in a folder named after the scene, under the name of the layer that used them, so the project
 * directory is readable and a file can be replaced by hand.
 *
 * Nothing here expires. A Figma image URL is valid for minutes; these paths are valid for as long as
 * the project exists, which is the whole point of copying the bytes in.
 */
const projectImageRoot = path.join(dataRoot, "images");

export interface StoredProjectImage {
  /** Project-relative POSIX path, e.g. `images/PlayerStats/player-photo.png`. Goes into the scene. */
  relativePath: string;
  fileName: string;
  sizeBytes: number;
  checksum: string;
  mimeType: string;
}

/**
 * Store one image under a scene's image folder.
 *
 * The name is made safe and made unique: two layers called "Photo" in one scene must not overwrite
 * each other, so a colliding name gains a short suffix from the content hash rather than a counter —
 * re-importing the same design then produces the same paths instead of `photo-2`, `photo-3`.
 * Identical bytes under the same name are left alone, which makes a re-import idempotent.
 */
export async function storeProjectImage(
  sceneName: string,
  preferredFileName: string,
  bytes: Buffer,
  mimeType: string
): Promise<StoredProjectImage> {
  await ensureStorage();
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const folder = safePathSegment(sceneName) || "scene";
  const extension = safeExtension(preferredFileName, mimeType);
  const base = safePathSegment(preferredFileName.replace(/\.[^.]+$/, "")) || "image";

  const directory = path.join(projectImageRoot, folder);
  await mkdir(directory, { recursive: true });

  let fileName = `${base}.${extension}`;
  let outputPath = path.join(directory, fileName);
  const existing = await readFile(outputPath).catch(() => null);
  if (existing) {
    const existingChecksum = createHash("sha256").update(existing).digest("hex");
    if (existingChecksum !== checksum) {
      // Same name, different bytes: keep both, and keep the name stable across re-imports.
      fileName = `${base}-${checksum.slice(0, 8)}.${extension}`;
      outputPath = path.join(directory, fileName);
    }
  }

  if (!existing || fileName !== `${base}.${extension}`) {
    await atomicWriteFile(outputPath, bytes);
  }

  return {
    relativePath: path.posix.join("images", folder, fileName),
    fileName,
    sizeBytes: bytes.byteLength,
    checksum,
    mimeType
  };
}

/**
 * Read an image back by its project-relative path.
 *
 * Every segment is re-checked rather than trusted: the path travels inside a scene document, and a
 * scene can be hand-edited or arrive from elsewhere. `..` or an absolute path is refused outright —
 * this route reads whatever it is given, so a traversal here reads any file the service can.
 */
export async function readProjectImage(
  relativePath: string
): Promise<{ bytes: Buffer; mimeType: string; relativePath: string } | null> {
  const segments = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  if (segments[0] !== "images" || segments.length < 2) return null;
  if (segments.some((segment) => segment === ".." || segment === "." || segment !== safePathSegment(segment))) {
    return null;
  }

  const absolute = path.join(projectImageRoot, ...segments.slice(1));
  // Belt and braces: even with every segment sanitised, confirm the resolved path is inside the
  // image root before reading it.
  if (!absolute.startsWith(projectImageRoot + path.sep)) return null;

  const bytes = await readFile(absolute).catch(() => null);
  if (!bytes) return null;
  return {
    bytes,
    mimeType: mimeForExtension(path.extname(absolute)),
    relativePath: segments.join("/")
  };
}

/**
 * A path segment that is safe on every filesystem and readable by a person.
 *
 * Spaces become hyphens rather than being stripped: `Player Photo` reads better as `player-photo`
 * than `playerphoto`, and a URL with no escaping is one less thing to get wrong.
 */
function safePathSegment(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\w\s.-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 64)
    .toLowerCase();
}

function mimeForExtension(extension: string): string {
  const table: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".avif": "image/avif"
  };
  return table[extension.toLowerCase()] ?? "application/octet-stream";
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

/** Rewrite the access stamp at most this often. A scene open reads every asset it uses. */
const ACCESS_STAMP_INTERVAL_MS = 60_000;

export async function readStoredAssetContent(
  assetId: string
): Promise<{ bytes: Buffer; record: StoredAssetRecord } | null> {
  const record = await readStoredAsset(assetId);
  if (!record) return null;

  let bytes: Buffer;
  try {
    bytes = await readFile(safeDataPath(record.relativePath));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }

  // Serving the bytes is the contract; `lastAccessedAt` is cache bookkeeping. Rewriting
  // the sidecar on every read made a scene open rewrite one JSON per asset (86 for an
  // imported PSD) against the reference-index rebuild a save runs, and one failed
  // rename turned an image request into a 500 - which the editor draws as an empty
  // white quad. The stamp is now throttled and never fails a read.
  const stampAge = Date.now() - Date.parse(record.lastAccessedAt);
  if (!Number.isFinite(stampAge) || stampAge > ACCESS_STAMP_INTERVAL_MS) {
    const touched = { ...record, lastAccessedAt: new Date().toISOString() };
    try {
      await atomicWriteJson(assetRecordPath(record.assetId), touched);
      return { bytes, record: touched };
    } catch {
      return { bytes, record };
    }
  }
  return { bytes, record };
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
    await atomicWriteJson(await scenePath(scene.id), next);
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
    await atomicWriteJson(await scenePath(sceneId), next);
    return next;
  });
  if (updated) await rebuildAssetReferenceIndex();
  return updated;
}

export async function listScenes(): Promise<StoredSceneSummary[]> {
  await ensureStorage();
  const root = await openSceneRoot();
  if (!root) return [];
  const files = await readdir(root).catch(() => [] as string[]);
  const summaries = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => summarizeScene(JSON.parse(await readFile(path.join(root, file), "utf8")) as SceneDocument))
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
    const backupDirectory = path.join(await sceneBackupRoot(), sceneId);
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
    await atomicWriteJson(await scenePath(sceneId), next);
    return next;
  });
  if (recovered) await rebuildAssetReferenceIndex();
  return recovered;
}

/**
 * Write an autosave snapshot into the scene's ring buffer.
 *
 * Modelled on After Effects: files are named `<scene> autosave <n>.json` and the slot number
 * cycles, so version `n` is overwritten once `maxVersions` snapshots exist. A ring bounds disk
 * without a pruning job, and it is what a designer moving from AE already expects.
 *
 * Deliberately *not* a scene write. Autosaves live outside `scenes/`, carry no scene identity
 * in a place `listScenes` can see, and never touch the document the operator has open — the
 * one behaviour guaranteed to get us blamed for data loss we did not cause. Recovery is an
 * explicit read through `readSceneAutosave`.
 */
export async function autosaveScene(
  scene: SceneDocument,
  maxVersions: number
): Promise<StoredAutosaveEntry> {
  assertSceneDocumentIdentity(scene);
  const sceneId = assertSafeStorageId(scene.id, "sceneId");
  const cap = clampAutosaveVersions(maxVersions);
  await ensureStorage();

  // Serialized against the scene's own writes: an autosave and a save racing on the same
  // index would both claim the same slot and one snapshot would be silently lost.
  return withSceneWriteLock(sceneId, async () => {
    const directory = path.join(await sceneAutosaveRoot(), sceneId);
    const index = await readAutosaveIndex(directory);

    // Fill empty slots first, then recycle the oldest. Advancing *past* the oldest slot
    // instead of reusing it leaves slot 1 permanently pinned, so the ring keeps its very
    // first snapshot forever and silently discards newer ones.
    const firstFreeSlot = index.entries.length < cap ? index.entries.length + 1 : null;
    const version = firstFreeSlot ?? oldestAutosaveVersion(index.entries);

    // The revision is the service's, and a posted document cannot carry it: `POST /api/scenes`
    // returns the new revision and no client reads it back, so trusting `scene.revision` filed
    // every snapshot under revision 0 and left the recovery dialog's "older than the open
    // scene" warning comparing a constant. Autosave persists before it snapshots, so the
    // stored scene's revision is the revision of the content being captured. Read inside the
    // lock, which is also what makes that true.
    const storedRevision = (await readSceneUnlocked(sceneId))?.revision ?? scene.revision ?? 0;

    const entry: StoredAutosaveEntry = {
      version,
      fileName: autosaveFileName(scene.name, version),
      sceneName: scene.name,
      revision: storedRevision,
      savedAt: new Date().toISOString(),
      sizeBytes: 0
    };

    const target = path.join(directory, entry.fileName);
    await atomicWriteJson(target, scene);
    entry.sizeBytes = (await stat(target)).size;

    // A renamed scene changes the file name, so the stale file for this slot must go or the
    // ring leaks one file per rename.
    const previous = index.entries.find((candidate) => candidate.version === version);
    if (previous && previous.fileName !== entry.fileName) {
      await unlink(path.join(directory, previous.fileName)).catch(() => undefined);
    }

    const entries = index.entries
      .filter((candidate) => candidate.version !== version)
      .concat(entry)
      .sort((left, right) => left.version - right.version);

    // Shrinking the cap in Preferences must drop the now-unreachable slots, not orphan them.
    const retained: StoredAutosaveEntry[] = [];
    for (const candidate of entries) {
      if (candidate.version <= cap) retained.push(candidate);
      else await unlink(path.join(directory, candidate.fileName)).catch(() => undefined);
    }

    await atomicWriteJson(path.join(directory, autosaveIndexFile), {
      sceneId,
      maxVersions: cap,
      entries: retained
    });

    return entry;
  });
}

/** Autosave snapshots for a scene, newest first. */
export async function listSceneAutosaves(sceneId: string): Promise<StoredAutosaveEntry[]> {
  assertSafeStorageId(sceneId, "sceneId");
  const index = await readAutosaveIndex(path.join(await sceneAutosaveRoot(), sceneId));
  return [...index.entries].sort((left, right) => right.savedAt.localeCompare(left.savedAt));
}

/**
 * Read one autosave snapshot without restoring it.
 *
 * Returning the document rather than writing it over the scene is deliberate: a snapshot may
 * be older than what Playout has already taken to air, so the operator has to see the
 * revision and timestamp and choose. The caller decides whether to save it.
 */
export async function readSceneAutosave(
  sceneId: string,
  version: number
): Promise<SceneDocument | null> {
  assertSafeStorageId(sceneId, "sceneId");
  const directory = path.join(await sceneAutosaveRoot(), sceneId);
  const index = await readAutosaveIndex(directory);
  const entry = index.entries.find((candidate) => candidate.version === version);
  if (!entry) return null;

  try {
    const document = JSON.parse(
      await readFile(path.join(directory, entry.fileName), "utf8")
    ) as SceneDocument;
    assertSceneDocumentIdentity(document);
    if (document.id !== sceneId) {
      throw new Error("autosave identity does not match the requested scene");
    }
    return document;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readSceneUnlocked(sceneId: string): Promise<SceneDocument | null> {
  try {
    const scene = JSON.parse(await readFile(await scenePath(sceneId), "utf8")) as SceneDocument;
    return { ...scene, revision: scene.revision ?? 0, assets: await hydrateAssetChecksums(scene.assets ?? []) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

/**
 * Fill in the checksum of every asset that is in this store but does not carry one.
 *
 * The render engine registers assets by SHA-256 and refuses a scene containing one
 * without it, and scenes written before the design importer emitted checksums are
 * still on disk. The store already knows the hash of the bytes, so the repair is a
 * lookup; reading a scene fixes it in memory and the next save persists it.
 */
async function hydrateAssetChecksums(assets: SceneDocument["assets"]): Promise<SceneDocument["assets"]> {
  if (!assets.some((asset) => !asset.checksum)) return assets;
  return Promise.all(assets.map(async (asset) => {
    if (asset.checksum) return asset;
    const record = await readStoredAsset(asset.storageAssetId ?? asset.assetId).catch(() => null);
    if (record) {
      return { ...asset, checksum: record.checksum, sizeBytes: asset.sizeBytes ?? record.sizeBytes };
    }
    // Not in this store and not inline: the engine can never register it, so the
    // document must stop advertising it as ready. Older imports wrote exactly this -
    // a `figma-image-<ref>` fill that no asset pass ever stored.
    const inline = asset.source?.startsWith("data:") ?? false;
    return inline || asset.status !== "READY" ? asset : { ...asset, status: "MISSING" as const };
  }));
}

export async function savePackage(
  sceneId: string,
  fileName: string,
  buffer: Buffer
): Promise<StoredPackageSummary> {
  await ensureStorage();
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const packagePath = path.join(
    await packageRoot(),
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

async function scenePath(sceneId: string): Promise<string> {
  return path.join(await sceneRoot(), `${assertSafeStorageId(sceneId, "sceneId")}.json`);
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

/**
 * Copy the previous scene aside before it is overwritten.
 *
 * Distinct from autosave: this is an involuntary pre-write safety net keyed by revision, not
 * a user-facing snapshot. It is pruned because it is written on *every* save, and autosave
 * makes saves far more frequent — unbounded, a busy scene would fill the disk with copies
 * nobody browses.
 */
async function backupScene(scene: SceneDocument | null): Promise<void> {
  if (!scene) return;
  const sceneId = assertSafeStorageId(scene.id, "sceneId");
  const directory = path.join(await sceneBackupRoot(), sceneId);
  await atomicWriteJson(
    path.join(directory, `${scene.revision ?? 0}-${Date.now()}.json`),
    scene
  );
  await pruneSceneBackups(directory);
}

/** Keep the newest `backupRetention` pre-write copies; drop the rest. */
async function pruneSceneBackups(directory: string): Promise<void> {
  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    return;
  }

  const stale = files
    .filter((file) => /^\d+-\d+\.json$/.test(file))
    .sort((left, right) => backupStamp(right) - backupStamp(left))
    .slice(backupRetention);

  // Failure to prune must never fail the save that triggered it: the copy is already on
  // disk and the scene write is what the operator is waiting for.
  await Promise.all(
    stale.map((file) => unlink(path.join(directory, file)).catch(() => undefined))
  );
}

function backupStamp(file: string): number {
  return Number(file.slice(file.lastIndexOf("-") + 1, -5));
}

function clampAutosaveVersions(value: number): number {
  if (!Number.isFinite(value)) return defaultAutosaveVersions;
  return Math.min(50, Math.max(1, Math.trunc(value)));
}

/**
 * After Effects' naming, so the files read the same to a designer arriving from it:
 * `Lower Third autosave 3.json`. Characters a file system rejects are replaced rather than
 * stripped, so two scenes cannot collapse onto one name.
 */
function autosaveFileName(sceneName: string, version: number): string {
  const safe = (sceneName || "Untitled")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${safe || "Untitled"} autosave ${version}.json`;
}

function oldestAutosaveVersion(entries: readonly StoredAutosaveEntry[]): number {
  return entries.reduce(
    (oldest, entry) => (entry.savedAt < oldest.savedAt ? entry : oldest),
    entries[0]
  ).version;
}

interface AutosaveIndex {
  sceneId?: string;
  maxVersions: number;
  entries: StoredAutosaveEntry[];
}

/**
 * Read a scene's autosave index, treating any damage as "no history".
 *
 * A corrupt index must not block autosaving — losing the list of snapshots is recoverable,
 * refusing to take new ones is not.
 */
async function readAutosaveIndex(directory: string): Promise<AutosaveIndex> {
  try {
    const parsed = JSON.parse(
      await readFile(path.join(directory, autosaveIndexFile), "utf8")
    ) as AutosaveIndex;
    if (!Array.isArray(parsed.entries)) return { maxVersions: defaultAutosaveVersions, entries: [] };
    return {
      sceneId: parsed.sceneId,
      maxVersions: clampAutosaveVersions(parsed.maxVersions),
      entries: parsed.entries.filter(
        (entry) => Number.isInteger(entry?.version) && typeof entry?.fileName === "string"
      )
    };
  } catch {
    return { maxVersions: defaultAutosaveVersions, entries: [] };
  }
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

  // A scene save must not fail because a reference-count sidecar could not be
  // rewritten: the scene is the durable artifact, the counts are derived and are
  // rebuilt by the next save. Writing them only where they changed also stops a save
  // from rewriting every sidecar in the project.
  const files = await readdir(assetIndexRoot);
  await Promise.all(
    files.filter((file) => file.endsWith(".json")).map(async (file) => {
      const assetId = path.basename(file, ".json");
      const record = await readStoredAsset(assetId);
      if (!record) return;
      const sceneIds = [...(references.get(assetId) ?? [])].sort();
      const unchanged = record.referenceCount === sceneIds.length
        && record.referencedByScenes.length === sceneIds.length
        && record.referencedByScenes.every((id, index) => id === sceneIds[index]);
      if (unchanged) return;
      try {
        await atomicWriteJson(assetRecordPath(assetId), {
          ...record,
          referenceCount: sceneIds.length,
          referencedByScenes: sceneIds
        });
      } catch {
        // Left for the next save to reconcile.
      }
    })
  );
}

async function listSceneDocuments(): Promise<SceneDocument[]> {
  await ensureStorage();
  const root = await openSceneRoot();
  if (!root) return [];
  const files = await readdir(root).catch(() => [] as string[]);
  return Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => JSON.parse(await readFile(path.join(root, file), "utf8")) as SceneDocument)
  );
}

async function atomicWriteJson(targetPath: string, value: unknown): Promise<void> {
  await atomicWriteFile(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Runtime-container helpers live beside the atomic writer because both operate on sidecars outside
 * the central data root. Every path still enters through the configured allowlist.
 */
function assertAeContainerId(value: string): string {
  try {
    return assertSafeStorageId(value, "containerId");
  } catch {
    throw new AeRuntimeContainerError(
      "INVALID_CONTAINER_ID",
      "containerId must contain only letters, numbers, underscore, or hyphen"
    );
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function digestAeProject(projectPath: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(projectPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new AeRuntimeContainerError("PROJECT_NOT_FOUND", "After Effects project was not found");
    }
    throw error;
  }
  return createHash("sha256").update(bytes).digest("hex");
}

function aeContainerSidecarPath(projectPath: string, containerId: string): string {
  return path.join(path.dirname(projectPath), ".grapix", "ae-runtime", containerId, "container.json");
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function findAeContainerSidecar(root: string, containerId: string): Promise<string | null> {
  const matches = await listAeContainerSidecars(root, containerId);
  return matches[0] ?? null;
}

async function listAeContainerSidecars(root: string, containerId?: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries: import("node:fs").Dirent<string>[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(directory, entry.name);
      if (entry.name === ".grapix") {
        const sidecar = path.join(
          child,
          "ae-runtime",
          containerId ?? "",
          containerId ? "container.json" : ""
        );
        if (containerId) {
          if (await pathExists(sidecar)) found.push(sidecar);
        } else {
          let ids: import("node:fs").Dirent<string>[] = [];
          try {
            ids = await readdir(path.join(child, "ae-runtime"), { withFileTypes: true });
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
          }
          for (const id of ids) {
            if (!id.isDirectory()) continue;
            const candidate = path.join(child, "ae-runtime", id.name, "container.json");
            if (await pathExists(candidate)) found.push(candidate);
          }
        }
        continue;
      }
      await visit(child);
    }
  };
  await visit(root);
  return found;
}

function assertAeRuntimeContainer(container: AeRuntimeContainer): void {
  if (container.schemaVersion !== AE_RUNTIME_CONTAINER_SCHEMA_VERSION) {
    throw new AeRuntimeContainerError("INVALID_CONTAINER", "unsupported runtime container schema version");
  }
  assertAeContainerId(container.id);
  if (!container.name.trim() || container.name.length > 180) {
    throw new AeRuntimeContainerError("INVALID_CONTAINER", "container name must contain 1 to 180 characters");
  }
  if (!/^[0-9a-f]{64}$/.test(container.projectDigest)) {
    throw new AeRuntimeContainerError("INVALID_CONTAINER", "projectDigest must be a lowercase SHA-256");
  }
  resolveAeProjectUri(container.projectUri);
  if (!/^\d+\/\d+$/.test(container.profile.frameRate)) {
    throw new AeRuntimeContainerError("INVALID_CONTAINER", "profile.frameRate must be rational");
  }
  if (!container.profile.aeVersion.trim() || !container.profile.renderer.trim() || !container.profile.workingColorSpace.trim()) {
    throw new AeRuntimeContainerError("INVALID_CONTAINER", "runtime profile fields must be non-empty");
  }
  if (container.compositions.length < 1) {
    throw new AeRuntimeContainerError("INVALID_CONTAINER", "at least one composition must be selected");
  }
  const itemIds = new Set<number>();
  for (const composition of container.compositions) {
    if (!Number.isInteger(composition.itemId) || composition.itemId <= 0 || itemIds.has(composition.itemId)) {
      throw new AeRuntimeContainerError("INVALID_CONTAINER", "composition item ids must be unique positive integers");
    }
    itemIds.add(composition.itemId);
    if (!composition.name.trim() || !Number.isInteger(composition.width) || composition.width < 1
      || !Number.isInteger(composition.height) || composition.height < 1) {
      throw new AeRuntimeContainerError("INVALID_CONTAINER", "composition metadata is invalid");
    }
  }
  if (!Array.isArray(container.controls)) container.controls = [];
  const controlIds = new Set<string>();
  for (const control of container.controls) {
    if (!AE_DYNAMIC_CONTROL_UUID_PATTERN.test(control.controlId) || controlIds.has(control.controlId)) {
      throw new AeRuntimeContainerError("INVALID_CONTAINER", "control ids must be unique UUIDs");
    }
    controlIds.add(control.controlId);
    if (!control.displayName.trim() || !control.writable || control.target.propertyPath.length < 1
      || !Number.isInteger(control.target.compositionItemId) || !Number.isInteger(control.target.layerId)
      || control.target.propertyPath.some((segment) => !segment.matchName.trim() || !Number.isInteger(segment.ordinal) || segment.ordinal < 0)) {
      throw new AeRuntimeContainerError("INVALID_CONTAINER", "declared control target is invalid");
    }
  }
  // Old sidecars predate bindings; an absent list is "none declared", never "accept anything".
  if (!Array.isArray(container.dataBindings)) container.dataBindings = [];
  const boundControlIds = new Set<string>();
  for (const binding of container.dataBindings) {
    if (!controlIds.has(binding.controlId)) {
      throw new AeRuntimeContainerError("INVALID_CONTAINER", `data binding names undeclared control ${binding.controlId}`);
    }
    if (boundControlIds.has(binding.controlId)) {
      throw new AeRuntimeContainerError("INVALID_CONTAINER", `control ${binding.controlId} is bound more than once`);
    }
    boundControlIds.add(binding.controlId);
    if (typeof binding.dataPath !== "string" || !binding.dataPath.trim()) {
      throw new AeRuntimeContainerError("INVALID_CONTAINER", "data binding path is invalid");
    }
  }
  if (!Number.isInteger(container.cachePolicy.maxPreparedFrames)
    || container.cachePolicy.maxPreparedFrames < 0
    || (container.cachePolicy.mode === "none" && container.cachePolicy.maxPreparedFrames !== 0)
    || (container.cachePolicy.mode === "bounded" && container.cachePolicy.maxPreparedFrames < 1)) {
    throw new AeRuntimeContainerError("INVALID_CONTAINER", "cache policy is invalid");
  }
}

/**
 * Write `targetPath` through a temporary file in the same directory.
 *
 * Serialized per target path. Two concurrent writers of the *same* path is the
 * normal case for a content-addressed store: one design import can extract the
 * same bytes under several layer names, and every copy resolves to one
 * `asset_<checksum>` path. Windows fails the second `MoveFileEx` with
 * `ERROR_ACCESS_DENIED` (reported as `EPERM`) while the first replacement still
 * holds the destination, which surfaced as spurious "could not be embedded"
 * import warnings for duplicated Photoshop layers. Queuing also lets the
 * checksum short-circuit in `importAssetBuffer` see the first write, so the
 * duplicates stop re-writing identical bytes.
 */
async function atomicWriteFile(targetPath: string, data: string | Buffer): Promise<void> {
  await withKeyedLock(fileWriteLocks, path.resolve(targetPath), async () => {
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
      await renameWithRetry(temporaryPath, targetPath);
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  });
}

/**
 * Replace `target` with `temporary`, retrying the Windows-transient failures.
 *
 * `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING` fails with `ERROR_ACCESS_DENIED`
 * (`EPERM`) or `ERROR_SHARING_VIOLATION` (`EBUSY`) while any other handle holds the
 * destination - an indexer, a virus scanner, or a reader that opened it a
 * millisecond earlier. The condition clears in milliseconds, and the alternative to
 * retrying is losing a write that had nothing wrong with it: this is what turned
 * asset reads and scene saves into 500s while the editor was open.
 */
async function renameWithRetry(temporary: string, target: string): Promise<void> {
  const transient = new Set(["EPERM", "EACCES", "EBUSY"]);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporary, target);
      return;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (attempt >= 5 || !transient.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
}

async function withSceneWriteLock<T>(sceneId: string, operation: () => Promise<T>): Promise<T> {
  return withKeyedLock(sceneWriteLocks, sceneId, operation);
}

async function withKeyedLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => gate);
  locks.set(key, queued);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
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
