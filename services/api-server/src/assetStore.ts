/**
 * Design asset storage.
 *
 * Importers hand back asset sources that cannot be persisted as-is:
 * - the Figma REST API returns short-lived signed S3 URLs, which expire within hours, so a
 *   stored DesignIR would reference dead links
 * - the Figma plugin returns base64 data URIs, which would bloat the design JSON
 *
 * This module materialises both into files under `data/designs/<designId>/assets/` and
 * rewrites each asset's `source` to a stable local URL the editor can load forever.
 */

import type { DesignAsset, DesignIR } from "@grapix/design-ir";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const designRoot = path.join(workspaceRoot, "data", "designs");

/** Kept small and explicit: these are the only types an importer can produce today. */
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "font/woff2": ".woff2",
  "font/woff": ".woff",
  "font/ttf": ".ttf",
  "font/otf": ".otf"
};

const MAX_ASSET_BYTES = 64 * 1024 * 1024;

export interface AssetPersistResult {
  design: DesignIR;
  stored: number;
  failed: Array<{ assetId: string; reason: string }>;
}

/**
 * Downloads or decodes every asset in the design, writes it to disk, and returns the design
 * with local sources. Assets that cannot be fetched are left with their original source and
 * reported as import warnings, so a dead logo never fails the whole import.
 */
export async function persistDesignAssets(
  design: DesignIR,
  options: { fetchImpl?: typeof fetch } = {}
): Promise<AssetPersistResult> {
  if (!design.assets.length) {
    return { design, stored: 0, failed: [] };
  }

  const doFetch = options.fetchImpl ?? fetch;
  const assetDir = designAssetDir(design.designId);
  await mkdir(assetDir, { recursive: true });

  const assets: DesignAsset[] = [];
  const failed: Array<{ assetId: string; reason: string }> = [];
  let stored = 0;

  for (const asset of design.assets) {
    if (isLocalSource(asset.source)) {
      assets.push(asset);
      continue;
    }

    try {
      const loaded = await loadAssetBytes(asset, doFetch);
      const extension =
        EXTENSION_BY_MIME[loaded.mimeType ?? ""] ?? (path.extname(asset.name) || ".bin");
      const fileName = `${asset.assetId}${extension}`;

      await writeAssetFile(path.join(assetDir, fileName), loaded.bytes);

      assets.push({
        ...asset,
        mimeType: loaded.mimeType ?? asset.mimeType,
        sizeBytes: loaded.bytes.byteLength,
        source: `/api/designs/${design.designId}/assets/${fileName}`
      });
      stored += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown error";
      failed.push({ assetId: asset.assetId, reason });
      assets.push(asset);
    }
  }

  const warnings = failed.length
    ? [
        ...design.warnings,
        ...failed.map((entry) => ({
          severity: "warning" as const,
          code: "ASSET_NOT_STORED",
          message: `Asset ${entry.assetId} could not be stored locally (${entry.reason}); it will render as a missing asset once the source expires.`
        }))
      ]
    : design.warnings;

  return {
    design: { ...design, assets, warnings },
    stored,
    failed
  };
}

/** Resolves an asset file for serving. Returns null when the id escapes the design's dir. */
export async function readDesignAsset(
  designId: string,
  fileName: string
): Promise<{ bytes: Buffer; mimeType: string } | null> {
  const assetDir = designAssetDir(designId);
  const target = path.resolve(assetDir, fileName);

  // Path traversal guard: a crafted file name must not read outside the asset directory.
  if (!target.startsWith(assetDir + path.sep)) {
    return null;
  }

  try {
    const bytes = await readFile(target);

    return { bytes, mimeType: mimeForExtension(path.extname(target)) };
  } catch {
    return null;
  }
}

export async function deleteDesignAssets(designId: string): Promise<void> {
  await rm(designAssetDir(designId), { recursive: true, force: true });
}

async function loadAssetBytes(
  asset: DesignAsset,
  doFetch: typeof fetch
): Promise<{ bytes: Buffer; mimeType?: string }> {
  if (asset.source.startsWith("data:")) {
    return decodeDataUri(asset.source);
  }

  if (!/^https?:\/\//i.test(asset.source)) {
    throw new Error("Unsupported source scheme");
  }

  const response = await doFetch(asset.source);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const declaredLength = Number(response.headers.get("content-length") ?? "0");

  if (declaredLength > MAX_ASSET_BYTES) {
    throw new Error(`Asset is larger than the ${MAX_ASSET_BYTES / (1024 * 1024)}MB limit`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());

  if (bytes.byteLength > MAX_ASSET_BYTES) {
    throw new Error(`Asset is larger than the ${MAX_ASSET_BYTES / (1024 * 1024)}MB limit`);
  }

  return {
    bytes,
    mimeType: response.headers.get("content-type")?.split(";")[0]?.trim() || asset.mimeType
  };
}

function decodeDataUri(source: string): { bytes: Buffer; mimeType?: string } {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(source);

  if (!match) {
    throw new Error("Malformed data URI");
  }

  const [, mimeType, base64Flag, payload] = match;
  const bytes = base64Flag
    ? Buffer.from(payload, "base64")
    : Buffer.from(decodeURIComponent(payload), "utf8");

  if (bytes.byteLength > MAX_ASSET_BYTES) {
    throw new Error("Asset exceeds the size limit");
  }

  return { bytes, mimeType: mimeType || undefined };
}

/** Atomic, for the same reason profiles are: a reader must never see a partial file. */
async function writeAssetFile(target: string, bytes: Buffer): Promise<void> {
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, bytes);
  await rename(temp, target);
}

function isLocalSource(source: string): boolean {
  return source.startsWith("/api/designs/");
}

function designAssetDir(designId: string): string {
  return path.join(designRoot, safeSegment(designId), "assets");
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

function mimeForExtension(extension: string): string {
  const entry = Object.entries(EXTENSION_BY_MIME).find(([, value]) => value === extension);

  return entry?.[0] ?? "application/octet-stream";
}
