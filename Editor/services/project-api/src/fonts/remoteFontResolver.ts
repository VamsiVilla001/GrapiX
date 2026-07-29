import type { FontDefinition, FontFaceDefinition } from "@grapix/shared-types";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import path from "node:path";
import { validateImportedAsset } from "../importers/assetValidation.js";
import { importAssetBuffer, type StoredAssetRecord } from "../storage.js";
import { parseFontStylesheet, type ParsedCssFontFace, type ParsedCssFontSource } from "./cssFontParser.js";
import { inspectFontFile } from "./fontMetadata.js";

const MAX_CSS_BYTES = 1024 * 1024;
const MAX_FONT_BYTES = 30 * 1024 * 1024;
const MAX_IMPORT_DEPTH = 3;
const MAX_FACES = 64;
const TIMEOUT_MS = 12_000;

export interface ResolveRemoteFontRequest {
  source: "css-url" | "adobe-fonts" | "direct-url";
  url?: string;
  projectId?: string;
  displayName?: string;
  family?: string;
  license?: string;
}

export interface ResolvedRemoteFonts {
  fonts: FontDefinition[];
  assets: Array<StoredAssetRecord & { kind: "font"; contentUrl: string }>;
  warnings: string[];
}

export async function resolveRemoteFonts(request: ResolveRemoteFontRequest): Promise<ResolvedRemoteFonts> {
  const sourceUrl = canonicalSourceUrl(request);
  if (request.source === "direct-url") {
    const downloaded = await downloadFont(sourceUrl);
    const metadata = inspectFontFile(downloaded.bytes);
    const family = normalizeFamily(request.family || metadata.family);
    const asset = await storeDownloadedFont(downloaded.bytes, downloaded.finalUrl, downloaded.format);
    return {
      fonts: [fontDefinition(family, request.displayName || metadata.displayName, [{
        faceId: faceIdentity(family, metadata.weight, metadata.style, asset.checksum),
        family,
        weight: metadata.weight,
        style: metadata.style,
        status: "READY",
        source: fileSource(asset, downloaded.format, downloaded.finalUrl)
      }], request, sourceUrl)],
      assets: [publicAsset(asset)],
      warnings: []
    };
  }

  const warnings: string[] = [];
  const parsedFaces = await collectStylesheetFaces(sourceUrl, 0, new Set(), warnings);
  if (!parsedFaces.length) throw new Error("The stylesheet did not contain any usable @font-face rules");
  if (parsedFaces.length > MAX_FACES) throw new Error(`Stylesheet declares more than ${MAX_FACES} font faces`);
  const parsedFamilyCount = new Set(parsedFaces.map((face) => face.family)).size;

  const assets = new Map<string, ReturnType<typeof publicAsset>>();
  const families = new Map<string, FontFaceDefinition[]>();
  for (const face of parsedFaces) {
    try {
      const candidate = preferredSource(face.sources);
      const downloaded = await downloadFont(candidate.url, candidate.format);
      const asset = await storeDownloadedFont(downloaded.bytes, downloaded.finalUrl, downloaded.format);
      assets.set(asset.assetId, publicAsset(asset));
      const family = normalizeFamily(request.family && parsedFamilyCount === 1 ? request.family : face.family);
      const definitions = families.get(family) ?? [];
      definitions.push({
        faceId: faceIdentity(family, face.weight, face.style, asset.checksum),
        family,
        weight: face.weight,
        style: face.style,
        stretch: face.stretch,
        unicodeRange: face.unicodeRange,
        status: "READY",
        source: fileSource(asset, downloaded.format, downloaded.finalUrl, sourceUrl)
      });
      families.set(family, definitions);
    } catch (error) {
      warnings.push(`${face.family} ${face.weight}: ${error instanceof Error ? error.message : "download failed"}`);
    }
  }
  if (!families.size) throw new Error(warnings[0] || "No font files could be downloaded from the stylesheet");

  return {
    fonts: [...families].map(([family, faces]) =>
      fontDefinition(
        family,
        request.displayName && parsedFamilyCount === 1 ? request.displayName : family,
        dedupeFaces(faces),
        request,
        sourceUrl
      )
    ),
    assets: [...assets.values()],
    warnings
  };
}

async function collectStylesheetFaces(
  url: string,
  depth: number,
  visited: Set<string>,
  warnings: string[]
): Promise<ParsedCssFontFace[]> {
  if (depth > MAX_IMPORT_DEPTH || visited.has(url)) return [];
  visited.add(url);
  const response = await safeFetch(url, MAX_CSS_BYTES, "text/css");
  const parsed = parseFontStylesheet(response.bytes.toString("utf8"), response.finalUrl);
  const imported = await Promise.all(parsed.imports.map(async (importUrl) => {
    try {
      return await collectStylesheetFaces(importUrl, depth + 1, visited, warnings);
    } catch (error) {
      warnings.push(`Could not read imported stylesheet ${importUrl}: ${error instanceof Error ? error.message : "request failed"}`);
      return [];
    }
  }));
  return parsed.faces.concat(imported.flat());
}

async function downloadFont(url: string, declaredFormat?: ParsedCssFontSource["format"]) {
  const response = await safeFetch(url, MAX_FONT_BYTES);
  const format = declaredFormat ?? fontFormat(response.finalUrl, response.contentType, response.bytes);
  const fileName = `remote-font.${format}`;
  const validation = validateImportedAsset(response.bytes, fileName);
  if (validation.length) throw new Error(validation.join("; "));
  inspectFontFile(response.bytes);
  return { ...response, format };
}

async function safeFetch(urlValue: string, maximumBytes: number, expectedType?: string) {
  let current = new URL(urlValue);
  for (let redirects = 0; redirects <= 4; redirects += 1) {
    await assertPublicHttpsUrl(current);
    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "GrapiX-Font-Resolver/0.1" }
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Remote server returned redirect ${response.status} without a location`);
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`Remote server returned HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get("content-length"));
    if (declaredLength > maximumBytes) throw new Error(`Remote response exceeds ${maximumBytes} bytes`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maximumBytes) throw new Error(`Remote response exceeds ${maximumBytes} bytes`);
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (expectedType && contentType && contentType !== expectedType && contentType !== "text/plain") {
      throw new Error(`Expected ${expectedType}, received ${contentType}`);
    }
    return { bytes, finalUrl: current.toString(), contentType };
  }
  throw new Error("Remote font URL redirected too many times");
}

async function assertPublicHttpsUrl(url: URL): Promise<void> {
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Remote font URLs must use HTTPS and cannot contain credentials");
  }
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost")) {
    throw new Error("Local network font URLs are not allowed");
  }
  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Private or unresolved network font hosts are not allowed");
  }
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  const mappedV4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mappedV4) return isPrivateAddress(mappedV4);
  if (normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function canonicalSourceUrl(request: ResolveRemoteFontRequest): string {
  if (request.source === "adobe-fonts") {
    const projectId = request.projectId?.trim() ?? "";
    if (!/^[a-z0-9]{3,32}$/i.test(projectId)) throw new Error("Adobe Fonts project ID must contain 3 to 32 letters or numbers");
    return `https://use.typekit.net/${projectId}.css`;
  }
  if (!request.url?.trim()) throw new Error("A CSS or font URL is required");
  return new URL(request.url).toString();
}

async function storeDownloadedFont(
  bytes: Buffer,
  url: string,
  format: "otf" | "ttf" | "woff" | "woff2"
): Promise<StoredAssetRecord> {
  const stem = path.basename(new URL(url).pathname).replace(/\.[^.]+$/, "").replace(/[^\w .()+-]/g, "_").slice(0, 120) || "remote-font";
  return importAssetBuffer(bytes, `${stem}.${format}`, fontMime(format));
}

function fontDefinition(
  family: string,
  displayName: string,
  faces: FontFaceDefinition[],
  request: ResolveRemoteFontRequest,
  sourceUrl: string
): FontDefinition {
  const identity = createHash("sha256")
    .update(`${family}:${sourceUrl}:${faces.map((face) => face.faceId).join(",")}`)
    .digest("hex").slice(0, 16);
  return {
    fontId: `font_${identity}`,
    family,
    displayName: displayName.trim().slice(0, 128) || family,
    faces,
    fallbackFamilies: ["Arial", "sans-serif"],
    embeddingPolicy: "package",
    license: request.license?.trim() || undefined,
    enabled: true,
    sourceLabel: request.source === "adobe-fonts" ? `Adobe Fonts ${request.projectId}` : sourceUrl,
    status: "READY"
  };
}

function fileSource(
  asset: StoredAssetRecord,
  format: "otf" | "ttf" | "woff" | "woff2",
  originalUrl: string,
  stylesheetUrl?: string
): Extract<FontFaceDefinition["source"], { kind: "file" }> {
  return { kind: "file", assetId: asset.assetId, format, originalUrl, stylesheetUrl };
}

function publicAsset(asset: StoredAssetRecord): StoredAssetRecord & { kind: "font"; contentUrl: string } {
  return { ...asset, kind: "font", contentUrl: `/api/assets/${asset.assetId}/content` };
}

function preferredSource(sources: ParsedCssFontSource[]): ParsedCssFontSource {
  return [...sources].sort((left, right) =>
    ["woff2", "woff", "otf", "ttf", undefined].indexOf(left.format)
    - ["woff2", "woff", "otf", "ttf", undefined].indexOf(right.format)
  )[0]!;
}

function dedupeFaces(faces: FontFaceDefinition[]): FontFaceDefinition[] {
  const seen = new Set<string>();
  return faces.filter((face) => {
    const key = `${face.weight}:${face.style}:${face.stretch ?? ""}:${face.unicodeRange ?? ""}`;
    return !seen.has(key) && !!seen.add(key);
  });
}

function faceIdentity(family: string, weight: number, style: string, checksum: string): string {
  return `face_${createHash("sha256").update(`${family}:${weight}:${style}:${checksum}`).digest("hex").slice(0, 16)}`;
}

function normalizeFamily(value: string): string {
  const family = value.trim().replace(/[\r\n\f]/g, " ").slice(0, 128);
  if (!family) throw new Error("Font family is missing");
  return family;
}

function fontFormat(url: string, contentType: string, bytes: Buffer): "otf" | "ttf" | "woff" | "woff2" {
  const extension = new URL(url).pathname.toLowerCase().match(/\.(woff2?|otf|ttf)$/)?.[1];
  if (extension === "woff2" || extension === "woff" || extension === "otf" || extension === "ttf") return extension;
  if (contentType.includes("woff2")) return "woff2";
  if (contentType.includes("woff")) return "woff";
  if (contentType.includes("otf") || contentType.includes("opentype")) return "otf";
  if (contentType.includes("ttf") || contentType.includes("truetype")) return "ttf";
  const magic = bytes.subarray(0, 4).toString("ascii");
  if (magic === "wOF2") return "woff2";
  if (magic === "wOFF") return "woff";
  if (magic === "OTTO") return "otf";
  if (bytes.readUInt32BE(0) === 0x00010000 || magic === "true") return "ttf";
  throw new Error("Remote response is not a supported OTF, TTF, WOFF, or WOFF2 font");
}

function fontMime(format: "otf" | "ttf" | "woff" | "woff2"): string {
  return `font/${format}`;
}
