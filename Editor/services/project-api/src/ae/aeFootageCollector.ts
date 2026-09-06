/**
 * Copy an After Effects project's footage into a published package.
 *
 * A package must never leave Playout pointing at the designer's drive: the footage travels with
 * the project, under the package's own `assets/` tree. Every referenced file is copied — originals
 * are read, never written — into a layout that keeps the source's useful structure, deduped by
 * content hash so a logo referenced by forty layers is stored once.
 *
 * Two hard rules, both enforced by path construction rather than by trusting input:
 * - every stored path is built under the package root and re-checked before the write, so a `../`
 *   or an absolute path in a malicious or corrupted manifest cannot escape;
 * - a file the collector cannot find is reported in `missing`, not silently skipped, so publish
 *   validation can refuse by name instead of shipping a package that fails on air.
 *
 * This descends from the import-time collector that wrote into the project's asset folder. The
 * resolution order and the safety rules are the same; the destination is the package, and the
 * result is expressed in the published-package contract so the builder can embed it unchanged.
 */
import type { AeAssetRef, AeManifest } from "@grapix/shared-types";
import type { AePackagedAsset } from "@grapix/ae-runtime-contract";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface AeCollectionOptions {
  /**
   * A *File > Dependencies > Collect Files* folder to fall back to.
   *
   * When present, a source path that no longer exists where After Effects recorded it is
   * re-resolved against this folder — by relative path, then by bare filename, then by search.
   */
  collectedFootageDir?: string;
  signal?: AbortSignal;
}

export interface AeCollectionResult {
  assets: AePackagedAsset[];
  /** Source paths that resolved nowhere. Named, so validation can refuse by filename. */
  missing: string[];
  /**
   * Files found only by searching the collected folder for a matching name.
   *
   * Reported because a name match is a guess: two `logo.png` in different folders are one
   * filename, and the author should be told which files were resolved that way.
   */
  resolvedBySearch: string[];
  totalBytes: number;
}

/** One file as this collector stores it, before it becomes a contract asset. */
interface CollectedFile {
  name: string;
  sourcePath: string;
  packagedPath: string;
  sizeBytes: number;
  checksum: string;
  checksumDuplicate: boolean;
}

interface CollectContext {
  packageRoot: string;
  sourceDir: string;
  byChecksum: Map<string, CollectedFile>;
  options: AeCollectionOptions;
  result: AeCollectionResult;
}

/** The subfolder each media kind lands in, beneath `assets/`. */
const KIND_FOLDER: Record<string, string> = {
  video: "video",
  audio: "audio",
  image: "images",
  "image-sequence": "image-sequences",
  font: "fonts",
  photoshop: "footage",
  illustrator: "footage",
  other: "footage"
};

/** Collect every resolvable footage reference in a manifest into `<packageRoot>/assets/`. */
export async function collectAeFootage(
  manifest: AeManifest,
  packageRoot: string,
  options: AeCollectionOptions = {}
): Promise<AeCollectionResult> {
  const result: AeCollectionResult = { assets: [], missing: [], resolvedBySearch: [], totalBytes: 0 };
  const byChecksum = new Map<string, CollectedFile>();
  const sourceDir = path.dirname(manifest.sourceFile);

  for (const asset of manifest.assets) {
    if (options.signal?.aborted) throw new Error("publish cancelled");
    if (asset.kind !== "footage") continue;
    const collected = await collectOneAsset(asset, {
      packageRoot,
      sourceDir,
      byChecksum,
      options,
      result
    });
    if (collected) {
      result.assets.push(collected);
      if (!collected.checksumDuplicate) result.totalBytes += collected.sizeBytes;
    }
  }
  return result;
}

async function collectOneAsset(
  asset: AeAssetRef,
  context: CollectContext
): Promise<(AePackagedAsset & { checksumDuplicate?: boolean }) | null> {
  const candidates = asset.sequenceFrames?.length ? asset.sequenceFrames : [asset.sourcePath ?? ""];
  const resolved: string[] = [];
  let anyMissing = false;

  for (const candidate of candidates) {
    if (!candidate) continue;
    const found = await resolveFootage(candidate, context);
    if (found) resolved.push(found);
    else {
      anyMissing = true;
      context.result.missing.push(candidate);
    }
  }

  if (resolved.length === 0) {
    // A reference that produced no candidates at all still has to be named, or an asset with an
    // empty `sourcePath` would vanish from the report entirely.
    if (!anyMissing && asset.sourcePath) context.result.missing.push(asset.sourcePath);
    return null;
  }

  const folder = KIND_FOLDER[asset.mediaType ?? "other"] ?? "footage";

  if (asset.sequenceFrames?.length) {
    // An image sequence is one asset: all its frames under a folder named for the sequence, so a
    // 900-frame sequence is one entry in the manifest rather than 900.
    const sequenceName = sanitizeSegment(asset.name.replace(/\.[^.]+$/, "")) || "sequence";
    const frames: string[] = [];
    let first: CollectedFile | null = null;
    let bytes = 0;
    for (const framePath of resolved) {
      const copied = await copyOne(framePath, path.posix.join(folder, sequenceName), context);
      frames.push(copied.packagedPath);
      bytes += copied.checksumDuplicate ? 0 : copied.sizeBytes;
      first ??= copied;
    }
    if (!first) return null;
    return {
      ...first,
      itemId: asset.id,
      name: asset.name,
      sourcePath: asset.sourcePath ?? resolved[0]!,
      mediaType: asset.mediaType,
      sizeBytes: bytes,
      sequenceFrames: frames,
      checksumDuplicate: false
    };
  }

  const copied = await copyOne(resolved[0]!, folder, context);
  return {
    ...copied,
    itemId: asset.id,
    name: asset.name,
    // The path the `.aep` references is the relink key, so it is recorded as AE wrote it — not as
    // the collector happened to resolve it.
    sourcePath: asset.sourcePath ?? resolved[0]!,
    mediaType: asset.mediaType
  };
}

/**
 * Resolve one footage reference to a real file.
 *
 * Order: the path as After Effects recorded it, then relative to the project file, then — for a
 * collected project — relative to the footage folder and by bare filename inside it. The first that
 * exists wins; a path that exists nowhere is missing.
 */
export async function resolveFootagePath(
  recorded: string,
  sourceDir: string,
  collectedFootageDir?: string
): Promise<{ path: string; viaSearch: boolean } | undefined> {
  const candidates: string[] = [];
  if (path.isAbsolute(recorded)) candidates.push(recorded);
  else {
    candidates.push(path.resolve(sourceDir, recorded));
    candidates.push(path.resolve(recorded));
  }
  if (collectedFootageDir) {
    candidates.push(path.resolve(collectedFootageDir, path.basename(recorded)));
    candidates.push(path.resolve(collectedFootageDir, recorded));
  }

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return { path: candidate, viaSearch: false };
  }

  // Last resort for a collected project: search the folder for the filename. Reported, because a
  // name match is a guess rather than a resolution.
  if (collectedFootageDir) {
    const found = await findByName(collectedFootageDir, path.basename(recorded));
    if (found) return { path: found, viaSearch: true };
  }
  return undefined;
}

async function resolveFootage(recorded: string, context: CollectContext): Promise<string | undefined> {
  const found = await resolveFootagePath(recorded, context.sourceDir, context.options.collectedFootageDir);
  if (found?.viaSearch) context.result.resolvedBySearch.push(recorded);
  return found?.path;
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function findByName(directory: string, fileName: string, depth = 0): Promise<string | undefined> {
  if (depth > 6) return undefined;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return full;
    if (entry.isDirectory()) {
      const found = await findByName(full, fileName, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Copy one file into the package, deduped by content hash.
 *
 * The stored name is the original filename, made safe. Identical bytes are written once, so
 * re-publishing the same project produces the same paths and the same package size.
 */
async function copyOne(sourcePath: string, folder: string, context: CollectContext): Promise<CollectedFile> {
  const bytes = await readFile(sourcePath);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const existing = context.byChecksum.get(checksum);
  if (existing) return { ...existing, sourcePath, checksumDuplicate: true };

  const fileName = sanitizeFileName(path.basename(sourcePath));
  const packagedPath = path.posix.join("assets", folder, fileName);
  // Re-check the joined path stays under the package root before writing. The segment sanitiser
  // makes this unreachable from a normal filename, but the manifest is external input and the rule
  // that it cannot write outside the package is enforced here, not assumed.
  const absolute = safePackagePath(context.packageRoot, packagedPath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await copyFile(sourcePath, absolute);

  const collected: CollectedFile = {
    name: fileName,
    sourcePath,
    packagedPath,
    sizeBytes: bytes.byteLength,
    checksum,
    checksumDuplicate: false
  };
  context.byChecksum.set(checksum, collected);
  return collected;
}

/** Join a package-relative path and refuse anything that escapes the package root. */
export function safePackagePath(packageRoot: string, relativePath: string): string {
  const resolved = path.resolve(packageRoot, ...relativePath.split("/"));
  const rootWithSeparator = `${path.resolve(packageRoot)}${path.sep}`;
  if (!resolved.startsWith(rootWithSeparator)) {
    throw new Error(`package path escapes the package directory: ${relativePath}`);
  }
  return resolved;
}

/** One path segment with anything unsafe stripped, so a name cannot traverse. */
function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9 _.-]/g, "").replace(/\.{2,}/g, ".").trim();
}

/** A filename made safe to store: no separators, no traversal, no leading dots. */
function sanitizeFileName(value: string): string {
  const cleaned = value.replace(/[\\/]/g, "_").replace(/\.{2,}/g, ".").replace(/^\.+/, "").trim();
  return cleaned || "file";
}
