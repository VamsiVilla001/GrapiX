/**
 * Copy the footage one composition draws into the project's `Assets/AEP` folder.
 *
 * Collecting is what makes an imported template stand on its own. Without it the scene points at
 * the artist's `(Footage)` directory, and the template breaks the moment it is opened on the
 * playout machine, the drive is unmapped, or the artist reorganises their project. With it the
 * project folder holds everything the template draws, which is the same guarantee After Effects'
 * own Collect Files gives — and the reason the operator picked a project location at all.
 *
 * ## Why the closure and not the project
 *
 * The reference project here declares 65 footage items across 9 unique files totalling 3.9 GB, and
 * a single composition needs between 0.6 MB and 3.7 GB of that. Collecting the whole project on
 * every import would copy gigabytes the composition never draws. `resolveCompositionClosure`
 * already answers "what does this composition actually reach, through its whole precomp tree", so
 * collection follows it.
 *
 * ## Why the copy is streamed
 *
 * One file in that project is 3.66 GB. The asset pipeline's `importAssetBuffer` takes a `Buffer`,
 * and reading 3.66 GB into one would exceed Node's buffer ceiling and pin the whole file in memory
 * on the way past. `pipeline(createReadStream, createWriteStream)` copies it in constant memory,
 * which is also why this does not hash contents to deduplicate: hashing means a second full read of
 * every gigabyte to answer a question that size, mtime and name already answer well enough.
 *
 * ## Why deletion is reference-counted
 *
 * One `.psd` backs 54 of this project's footage items, because After Effects imports each PSD layer
 * as its own footage item pointing at the same file. An import that released files on removal
 * without counting would delete that `.psd` out from under every other import still drawing it.
 */

import type { AeAssetRef, AeManifest, CollectedAeAsset } from "@grapix/shared-types";
import { loadImage } from "@napi-rs/canvas";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import {
  projectFolder,
  readCollectedAeIndex,
  uniqueCollectedFileName,
  writeCollectedAeIndex
} from "../projectWorkspace.js";
import { importAssetBuffer } from "../storage.js";
import { resolveCompositionClosure } from "./aePackageBuilder.js";
import { readPsdCatalog, type PsdLayerEntry } from "./psdLayerCatalog.js";
import { readMp4Dimensions } from "./videoMetadata.js";

/**
 * How large a movie may be before the preview stops carrying it.
 *
 * Registering an asset means buffering it, and this project's reference movie is 3.66 GB. Below
 * the cap the layer draws; above it the project still holds the streamed copy and the layer
 * imports without a texture, which `oversizedFootage` reports so it is a stated limit rather than
 * a silent blank.
 */
const VIDEO_REGISTER_MAX_BYTES = 256 * 1024 * 1024;

export interface CollectedFootage {
  /** Project-item id of the AE footage this file backs. */
  assetIds: string[];
  fileName: string;
  sizeBytes: number;
  mediaType: string;
}

/**
 * What a scene object needs to draw one piece of footage.
 *
 * `width`/`height` are the footage's own pixel size, which is what makes the placement correct:
 * an After Effects layer's `position` and `anchorPoint` are meaningless without the intrinsic size
 * they were authored against, and defaulting to the composition frame stretches every layer to
 * full canvas.
 */
export interface ResolvedFootage {
  src: string;
  width?: number;
  height?: number;
  /**
   * The stored bytes' media type.
   *
   * Required, not decorative: `/api/assets/<id>/content` carries no file extension, so the
   * renderer picks its texture parser from this MIME. An asset registered without one loads as
   * `null` and draws the missing-texture placeholder — the exact failure this import kept hitting.
   */
  mimeType?: string;
}

export interface FootageCollectionResult {
  /**
   * Where a scene object should draw from.
   *
   * Keyed twice on purpose: by AE footage-item id, and — for a layered `.psd` — by lowercased
   * Photoshop layer name. After Effects names the footage items it generates from a PSD
   * `Footage 7192`, so the item name resolves nothing; the *layer* name is what matches, and the
   * converter looks the AE layer's own name up here.
   */
  pathByAssetId: Map<string, ResolvedFootage>;
  collected: CollectedFootage[];
  /** Footage the project declares but that is not on this machine. */
  missing: { assetId: string; name: string; sourcePath?: string }[];
  bytesCopied: number;
  reusedFiles: number;
  /** Photoshop layers extracted as their own images, the way After Effects imports them. */
  psdLayersExtracted: number;
  /** Footage too large to carry into the preview; the project still holds the streamed copy. */
  oversizedFootage: { fileName: string; sizeBytes: number }[];
}

/**
 * Identity of a source file, without reading it.
 *
 * Size and mtime distinguish two files at the same path across an edit, and the basename keeps two
 * same-sized files from different folders apart in the index. Deliberately not a content hash: see
 * the note above about the 3.66 GB read that would cost.
 */
function sourceKeyFor(sourcePath: string, sizeBytes: number, mtimeMs: number): string {
  return `${sizeBytes}-${Math.round(mtimeMs)}-${path.basename(sourcePath).toLowerCase()}`;
}

/**
 * Collect everything one composition reaches, and record `importId` as an owner of each file.
 *
 * Re-collecting a file another import already brought in copies nothing; it only adds this import
 * to the owner list, so the second template to use the same `.psd` is free.
 */
export async function collectCompositionFootage(
  manifest: AeManifest,
  compositionId: string,
  importId: string
): Promise<FootageCollectionResult> {
  const closure = resolveCompositionClosure(manifest, [String(compositionId)]);
  const refById = new Map(manifest.assets.map((asset) => [String(asset.id), asset]));
  const destinationFolder = await projectFolder("aepFootage");
  const index = await readCollectedAeIndex();
  const byKey = new Map(index.assets.map((asset) => [asset.sourceKey, asset]));

  const result: FootageCollectionResult = {
    pathByAssetId: new Map(),
    collected: [],
    missing: [],
    bytesCopied: 0,
    reusedFiles: 0,
    psdLayersExtracted: 0,
    oversizedFootage: []
  };

  // Group the closure's footage items by the file they share, so a `.psd` backing 54 items is
  // considered — and copied — exactly once.
  const bySourceKey = new Map<string, { ref: AeAssetRef; sizeBytes: number; mtimeMs: number; assetIds: string[] }>();
  for (const assetId of closure.assetIds) {
    const ref = refById.get(String(assetId));
    if (!ref || ref.kind !== "footage") continue;
    if (!ref.sourcePath) {
      result.missing.push({ assetId: String(assetId), name: ref.name });
      continue;
    }
    let info;
    try {
      info = await stat(ref.sourcePath);
    } catch {
      result.missing.push({ assetId: String(assetId), name: ref.name, sourcePath: ref.sourcePath });
      continue;
    }
    const key = sourceKeyFor(ref.sourcePath, info.size, info.mtimeMs);
    const existing = bySourceKey.get(key);
    if (existing) existing.assetIds.push(String(assetId));
    else bySourceKey.set(key, { ref, sizeBytes: info.size, mtimeMs: info.mtimeMs, assetIds: [String(assetId)] });
  }

  for (const [key, entry] of bySourceKey) {
    let record = byKey.get(key);
    if (record) {
      // Already in the project. Claim ownership; copy nothing.
      if (!record.usedBy.includes(importId)) record.usedBy.push(importId);
      result.reusedFiles += 1;
    } else {
      const fileName = await uniqueCollectedFileName(path.basename(entry.ref.sourcePath!));
      await pipeline(
        createReadStream(entry.ref.sourcePath!),
        createWriteStream(path.join(destinationFolder, fileName))
      );
      record = {
        sourceKey: key,
        fileName,
        sourcePath: entry.ref.sourcePath!,
        sizeBytes: entry.sizeBytes,
        mediaType: entry.ref.mediaType ?? "other",
        usedBy: [importId],
        collectedAt: new Date().toISOString()
      };
      byKey.set(key, record);
      index.assets.push(record);
      result.bytesCopied += entry.sizeBytes;
    }
    const sourceFilePath = entry.ref.sourcePath!;
    const isPhotoshop = entry.ref.mediaType === "photoshop" || /\.psb?$|\.psd$/i.test(sourceFilePath);

    if (isPhotoshop) {
      // After Effects turns a layered PSD into one footage item per layer. Registering the `.psd`
      // itself would hand the renderer a file it cannot decode, so the layers are registered
      // instead and the AE layer name is what resolves them.
      const extracted = await registerPsdLayers(sourceFilePath, result);
      if (extracted.length > 0) {
        // Ordinal fallback: AE numbers the footage items it generates in Photoshop document
        // order. A project that imported the same PSD twice repeats that run, so the position is
        // taken modulo the layer count rather than across the whole list.
        const ordered = entry.assetIds
          .slice()
          .sort((left, right) => Number(left) - Number(right));
        for (let position = 0; position < ordered.length; position += 1) {
          const byOrdinal = extracted[position % extracted.length]!;
          const assetId = ordered[position]!;
          if (!result.pathByAssetId.has(assetId)) {
            result.pathByAssetId.set(assetId, byOrdinal.resolved);
          }
        }
      }
    } else {
      const resolved = await registerPlainFootage(sourceFilePath, record.fileName, entry, result);
      for (const assetId of entry.assetIds) result.pathByAssetId.set(assetId, resolved);
    }

    result.collected.push({
      assetIds: entry.assetIds,
      fileName: record.fileName,
      sizeBytes: record.sizeBytes,
      mediaType: record.mediaType
    });
  }

  await writeCollectedAeIndex(index);
  return result;
}

/** One Photoshop layer registered as its own asset, in document order. */
interface RegisteredPsdLayer {
  entry: PsdLayerEntry;
  resolved: ResolvedFootage;
}

/**
 * Register every layer of a `.psd` as its own image asset and key them by layer name.
 *
 * The name is the resolution key that actually works. After Effects names a PSD-derived footage
 * item `Footage 7192`, which matches nothing, but it names the *composition layer* after the
 * Photoshop layer it came from — so the converter looks up the AE layer's own name here.
 */
async function registerPsdLayers(
  sourceFilePath: string,
  result: FootageCollectionResult
): Promise<RegisteredPsdLayer[]> {
  let catalog;
  try {
    catalog = readPsdCatalog(await readFile(sourceFilePath));
  } catch {
    return [];
  }

  const baseName = path.basename(sourceFilePath).replace(/\.[^.]+$/, "");
  const registered: RegisteredPsdLayer[] = [];
  for (const layer of catalog.layers) {
    let stored;
    try {
      stored = await importAssetBuffer(layer.png, `${baseName} - ${layer.name}.png`, "image/png");
    } catch {
      continue;
    }
    const resolved: ResolvedFootage = {
      src: `/api/assets/${stored.assetId}/content`,
      mimeType: "image/png",
      width: layer.width,
      height: layer.height
    };
    registered.push({ entry: layer, resolved });
    result.psdLayersExtracted += 1;

  }

  // Only an unambiguous name is a usable key. This PSD carries two layers called `Group 2` and two
  // called `Group 2 copy`, and a name that maps to two different rectangles cannot say which one an
  // AE layer meant — so duplicates are left out and resolved by their ordinal instead, which is
  // exact because After Effects numbers the footage items in document order.
  const nameCounts = new Map<string, number>();
  for (const item of registered) {
    const key = item.entry.name.toLowerCase().trim();
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  for (const item of registered) {
    const key = item.entry.name.toLowerCase().trim();
    if (!key || nameCounts.get(key) !== 1) continue;
    if (!result.pathByAssetId.has(key)) result.pathByAssetId.set(key, item.resolved);
  }
  return registered;
}

/**
 * Register a non-Photoshop footage file and read its intrinsic size.
 *
 * The size matters as much as the bytes: an AE layer's `position` is the world position of its
 * anchor, and without the footage's own width and height the object has no bounds to anchor
 * against. Video is the exception — nothing here decodes a container — so it keeps the caller's
 * fallback and is reported rather than guessed.
 */
async function registerPlainFootage(
  sourceFilePath: string,
  fileName: string,
  entry: { sizeBytes: number; ref: AeAssetRef },
  result: FootageCollectionResult
): Promise<ResolvedFootage> {
  const projectRelative = `Assets/AEP/${fileName}`;
  const isVideo = entry.ref.mediaType === "video";

  /*
   * A movie is registered like any other asset, so the preview can actually draw it.
   *
   * It is capped, though. `importAssetBuffer` takes a `Buffer`, and this project's largest movie
   * is 3.66 GB — reading that in would exceed Node's buffer ceiling and pin the file in memory.
   * Past the cap the scene keeps the streamed copy under `Assets/AEP` and the layer imports with
   * its transform and timing but no texture, which is reported rather than hidden.
   */
  const registerCap = isVideo ? VIDEO_REGISTER_MAX_BYTES : 96 * 1024 * 1024;
  if (entry.sizeBytes > registerCap) {
    result.oversizedFootage.push({ fileName, sizeBytes: entry.sizeBytes });
    return { src: projectRelative };
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(sourceFilePath);
  } catch {
    return { src: projectRelative };
  }

  let width: number | undefined;
  let height: number | undefined;
  if (isVideo) {
    // No frame decoder here, but the frame size is written in the MP4 track header.
    const dimensions = readMp4Dimensions(bytes);
    if (dimensions) {
      width = dimensions.width;
      height = dimensions.height;
    }
  } else {
    try {
      const image = await loadImage(bytes);
      width = image.width;
      height = image.height;
    } catch {
      // An image the canvas cannot decode still gets registered; only its bounds are unknown.
    }
  }

  const mimeType = mimeForFootage(sourceFilePath);
  try {
    const stored = await importAssetBuffer(bytes, fileName, mimeType);
    return { src: `/api/assets/${stored.assetId}/content`, width, height, mimeType };
  } catch {
    return { src: projectRelative, width, height, mimeType };
  }
}

function mimeForFootage(sourceFilePath: string): string {
  const extension = path.extname(sourceFilePath).toLowerCase();
  const table: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm"
  };
  return table[extension] ?? "application/octet-stream";
}

/**
 * Release one import's claim on collected footage, deleting only what nothing else draws.
 *
 * This is the half of "remove from template" that touches disk, and the only thing it may ever
 * delete is a file this project collected. The source `.aep` and its `(Footage)` folder are not
 * reachable from here at all — the index records where a file came from, but removal works on the
 * copy under `Assets/AEP` and never on `sourcePath`.
 */
export async function releaseImportFootage(importId: string): Promise<{ deleted: string[]; retained: string[] }> {
  const folder = await projectFolder("aepFootage");
  const index = await readCollectedAeIndex();
  const deleted: string[] = [];
  const retained: string[] = [];

  const survivors: CollectedAeAsset[] = [];
  for (const asset of index.assets) {
    const owners = asset.usedBy.filter((owner) => owner !== importId);
    if (owners.length > 0) {
      retained.push(asset.fileName);
      survivors.push({ ...asset, usedBy: owners });
      continue;
    }
    await rm(path.join(folder, asset.fileName), { force: true });
    deleted.push(asset.fileName);
  }

  await writeCollectedAeIndex({ version: 1, assets: survivors });
  return { deleted, retained };
}
