import type {
  FontDefinition,
  FontFaceDefinition,
  FontSource,
  SceneScriptPermission
} from "@grapix/shared-types";
import { isTrustedFontCssUrl } from "@grapix/shared-types";
import { createHash } from "node:crypto";
import path from "node:path";
import type { StoredAssetRecord } from "./storage.js";

export interface FontFaceOptions {
  family: string;
  displayName?: string;
  weight?: number;
  style?: FontFaceDefinition["style"];
  fallbackFamilies?: string[];
  license?: string;
}

export interface LinkedFontRequest extends FontFaceOptions {
  source: "css-url" | "adobe-fonts";
  url?: string;
  projectId?: string;
  integrity?: string;
}

export function createFileFontDefinition(
  asset: StoredAssetRecord,
  options: FontFaceOptions
): FontDefinition {
  const family = normalizeFamily(options.family);
  const format = fontFormat(asset.fileName, asset.mimeType);
  const identity = asset.checksum.slice(0, 16);
  return {
    fontId: `font_${identity}`,
    family,
    displayName: options.displayName?.trim() || family,
    faces: [{
      faceId: `face_${identity}`,
      family,
      weight: normalizeWeight(options.weight),
      style: options.style ?? "normal",
      source: {
        kind: "file",
        assetId: asset.assetId,
        format
      }
    }],
    fallbackFamilies: normalizeFallbacks(options.fallbackFamilies),
    embeddingPolicy: "package",
    license: options.license?.trim() || undefined,
    status: "READY"
  };
}

export function createLinkedFontDefinition(request: LinkedFontRequest): FontDefinition {
  const family = normalizeFamily(request.family);
  const source = linkedSource(request);
  const identity = createHash("sha256")
    .update(`${source.kind}:${source.url}:${family}:${normalizeWeight(request.weight)}`)
    .digest("hex")
    .slice(0, 16);
  return {
    fontId: `font_${identity}`,
    family,
    displayName: request.displayName?.trim() || family,
    faces: [{
      faceId: `face_${identity}`,
      family,
      weight: normalizeWeight(request.weight),
      style: request.style ?? "normal",
      source
    }],
    fallbackFamilies: normalizeFallbacks(request.fallbackFamilies),
    embeddingPolicy: "reference",
    license: request.license?.trim() || undefined,
    status: "UNVERIFIED"
  };
}

export function parseScriptPermissions(value: string | undefined): SceneScriptPermission[] {
  const allowed = new Set<SceneScriptPermission>([
    "read-data",
    "patch-data",
    "control-preview",
    "control-program",
    "control-timeline",
    "emit-event"
  ]);
  const permissions = (value ?? "read-data,emit-event")
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is SceneScriptPermission => allowed.has(item as SceneScriptPermission));
  return [...new Set(permissions)];
}

function linkedSource(request: LinkedFontRequest): Exclude<FontSource, { kind: "file" }> {
  if (request.source === "adobe-fonts") {
    const projectId = request.projectId?.trim() ?? "";
    if (!/^[a-z0-9]{3,32}$/i.test(projectId)) {
      throw new Error("Adobe Fonts projectId must contain 3 to 32 letters or numbers");
    }
    const canonicalUrl = `https://use.typekit.net/${projectId}.css`;
    if (request.url && request.url !== canonicalUrl) {
      throw new Error(`Adobe Fonts URL must be ${canonicalUrl}`);
    }
    return { kind: "adobe-fonts", projectId, url: canonicalUrl };
  }

  const url = new URL(request.url ?? "");
  if (url.protocol !== "https:") {
    throw new Error("Font stylesheets must use HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Font stylesheet URLs cannot contain credentials");
  }
  if (!isTrustedFontCssUrl(url.toString())) {
    throw new Error("Font stylesheet host is not approved; use Adobe Fonts, Google Fonts, Bunny Fonts, or package a font file");
  }
  return {
    kind: "css-url",
    url: url.toString(),
    integrity: request.integrity?.trim() || undefined
  };
}

function normalizeFamily(value: string): string {
  const family = value.trim().replace(/[\r\n\f]/g, "");
  if (!family || family.length > 128) {
    throw new Error("Font family must contain 1 to 128 characters");
  }
  return family;
}

function normalizeWeight(weight = 400): number {
  if (!Number.isInteger(weight) || weight < 1 || weight > 1000) {
    throw new Error("Font weight must be an integer from 1 to 1000");
  }
  return weight;
}

function normalizeFallbacks(values: string[] | undefined): string[] {
  const fallbacks = values?.map((value) => value.trim()).filter(Boolean) ?? ["Arial", "sans-serif"];
  return [...new Set(fallbacks)].slice(0, 8);
}

function fontFormat(fileName: string, mimeType: string): "otf" | "ttf" | "woff" | "woff2" {
  const extension = path.extname(fileName).slice(1).toLowerCase();
  if (extension === "otf" || extension === "ttf" || extension === "woff" || extension === "woff2") {
    return extension;
  }
  switch (mimeType) {
    case "font/otf": return "otf";
    case "font/ttf": return "ttf";
    case "font/woff": return "woff";
    case "font/woff2": return "woff2";
    default: throw new Error("Font file must be OTF, TTF, WOFF, or WOFF2");
  }
}
