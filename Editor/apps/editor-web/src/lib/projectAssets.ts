/**
 * Resolving a scene's asset paths to something the browser can fetch.
 *
 * Imported design images are stored in the project as `images/<scene>/<layer>.png` and the scene
 * refers to them by exactly that path — no asset id, no expiring Figma URL. That is the right thing
 * to keep in a document: it survives a restart, it can be replaced by hand, and it means the same
 * string wherever the project is opened.
 *
 * It is not, however, something a page can fetch. A relative path resolves against the *page*
 * origin — the Vite dev server on 5173, or `tauri.localhost` in the desktop shell — and the bytes
 * live behind the project service. Everything that loads a scene asset goes through here, so that
 * translation happens in one place instead of being half-applied across the renderers.
 */

import {
  projectAssetContentPath,
  projectAssetId,
  type AssetLibraryItem,
  type ProjectAssetReference
} from "@grapix/shared-types";

import { apiBaseUrl } from "./apiClient";
import { currentAccessToken } from "./auth";

/**
 * One file in the project's asset folders, as a library entry.
 *
 * Here rather than in a store because two callers need exactly the same translation and must not
 * drift: `editorStore` uses it when an assignment makes the scene start carrying the file, and the
 * Material Manager uses it to show files the scene does not carry yet. If the two built the entry
 * differently, a reference would change identity at the moment it was assigned.
 *
 * `source` is the service route, so `resolveProjectAssetUrl` sends it to the project service and
 * the authenticated fetch applies. `sourcePath` carries the durable identity beside it: the
 * project-relative path is what survives the project being opened on another machine, where a URL
 * carrying this window's port does not.
 */
export function projectAssetLibraryItem(reference: ProjectAssetReference): AssetLibraryItem {
  return {
    assetId: projectAssetId(reference.path),
    name: reference.name,
    kind: reference.kind,
    source: projectAssetContentPath(reference.path),
    sourcePath: reference.path,
    mimeType: reference.mimeType,
    sizeBytes: reference.sizeBytes,
    importedAt: reference.modifiedAt,
    status: "READY",
    // sRGB is the assumption every one of these formats encodes in, and the one both renderers
    // apply. A file carrying a different profile is a real case, and reading ICC out of the header
    // is the work that would answer it — until then this is stated rather than silently assumed.
    colorSpace: "srgb",
    ...(reference.width !== undefined ? { width: reference.width } : {}),
    ...(reference.height !== undefined ? { height: reference.height } : {}),
    ...alphaFromReference(reference),
    tags: []
  };
}

/**
 * The asset's alpha, as far as the header can say.
 *
 * `hasAlphaChannel` is a fact about the format; `alphaMode` is how the surface should be drawn.
 * A file with an alpha channel is `straight` — which is what PNG, WebP and GIF store, and what
 * both renderers expect — and one without is `opaque`. Neither is written when the header could
 * not be read: `normalizeMaterialSceneDocument` then records `unknown`, which is the truth and
 * which the renderers treat conservatively, rather than a guess the panel would show as fact.
 */
function alphaFromReference(reference: ProjectAssetReference): Partial<AssetLibraryItem> {
  if (reference.hasAlphaChannel === undefined) return {};
  return reference.hasAlphaChannel
    ? { hasAlpha: true, alphaMode: "straight" }
    : { hasAlpha: false, alphaMode: "opaque" };
}

/**
 * A source string the browser can load.
 *
 * Absolute URLs and data URLs pass through untouched: an asset placed by hand, a font inlined at
 * publish time, and a video on a media server are all already addressable. Only a project-relative
 * path is rewritten, and it is rewritten to the project service that owns it.
 */
export function resolveProjectAssetUrl(source: string | undefined): string {
  const trimmed = source?.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) return trimmed;
  return `${apiBaseUrl}/${trimmed.replace(/^\/+/, "")}`;
}

/** True when the source is a path inside the project rather than an address of its own. */
export function isProjectRelativeAsset(source: string | undefined): boolean {
  const trimmed = source?.trim();
  if (!trimmed) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed) && !trimmed.startsWith("//");
}

/**
 * True when the resolved URL is served by the project service, and therefore sits behind the
 * same login as every other project route. `/api/assets/<id>/content` and `/images/…` both
 * answer 401 to a bare fetch; a data URL, a media server, or another host does not.
 */
export function isProjectServiceUrl(url: string): boolean {
  return url.startsWith(`${apiBaseUrl}/`);
}

/**
 * The one authenticated asset fetch.
 *
 * Everything the Editor draws from the project service — publish packaging, fonts, preview
 * textures — goes through the content routes, and every one of them requires the window's
 * session bearer. A bare `fetch` answers 401, which the publish dialog surfaced as
 * "Could not package image …" and the preview swallowed as an empty texture. Headers are
 * attached here and nowhere else so no caller can forget them again.
 */
export async function fetchProjectAsset(
  source: string,
  init?: RequestInit
): Promise<Response> {
  const url = resolveProjectAssetUrl(source);
  const token = currentAccessToken();
  const headers = new Headers(init?.headers);
  if (token && isProjectServiceUrl(url) && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return fetch(url, { ...init, headers });
}

/**
 * The authenticated fetch, as an object URL.
 *
 * Pixi's `Assets.load` and the SVG/`<img>` paths cannot attach a header — Pixi's loader
 * calls `fetch(url)` with no init, and an `<img>` sends none. For those the bytes are
 * fetched here and handed over as a blob URL the caller owns and must revoke. Data URLs
 * and remote sources pass straight through: nothing to fetch, nothing to revoke.
 */
/*
 * Keyed on the bytes, not the address. The content route answers with the asset checksum as
 * its etag, so a replaced asset — same id, new bytes — produces a new key and a fresh blob
 * instead of serving the stale picture the URL alone would hit. The URL is only the lookup
 * for the etag; the blob is what a caller must not outlive.
 */
const blobUrlCache = new Map<string, string>();

export async function resolveProjectAssetObjectUrl(source: string): Promise<string> {
  const url = resolveProjectAssetUrl(source);
  if (!isProjectServiceUrl(url)) return url;

  const response = await fetchProjectAsset(source);
  if (!response.ok) {
    throw new Error(`Project asset answered HTTP ${response.status}`);
  }
  const key = response.headers.get("etag") ?? url;
  const cached = blobUrlCache.get(key);
  if (cached) return cached;

  const objectUrl = URL.createObjectURL(await response.blob());
  blobUrlCache.set(key, objectUrl);
  return objectUrl;
}

/** Drop every blob URL `resolveProjectAssetObjectUrl` minted; called when a scene closes. */
export function releaseProjectAssetObjectUrls(): void {
  for (const url of blobUrlCache.values()) URL.revokeObjectURL(url);
  blobUrlCache.clear();
}
