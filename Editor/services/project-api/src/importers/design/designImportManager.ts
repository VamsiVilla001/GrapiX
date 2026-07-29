import {
  DEFAULT_DESIGN_IMPORT_OPTIONS,
  type DesignImportOptions,
  type DesignImportResult,
  type DesignSourceFormat,
  type FigmaDesignImportSource,
  type NormalizedDesignDocument,
  type NormalizedDesignNode
} from "@grapix/shared-types";
import { importAssetBuffer } from "../../storage.js";
import { normalizeDesignDocument } from "./designDocumentNormalizer.js";
import { importFigmaDocument } from "./figmaImporter.js";
import { convertDesignDocumentToScenes } from "./grapixObjectConverter.js";
import {
  completeDesignImportReport,
  createDesignImportReport,
  reportImportWarning
} from "./importReport.js";
import { importIllustratorDocument, importSvgDocument } from "./illustratorImporter.js";
import { importPsdDocument } from "./psdImporter.js";

const PUBLIC_ASSET_BASE = "http://127.0.0.1:4100";
const MAX_EXTRACTED_ASSET_BYTES = 100 * 1024 * 1024;

export class DesignImportManager {
  async importFile(
    bytes: Buffer,
    fileName: string,
    suppliedOptions: Partial<DesignImportOptions> = {}
  ): Promise<DesignImportResult> {
    const options = mergeOptions(suppliedOptions);
    const format = detectFormat(fileName, bytes);
    const report = createDesignImportReport(format, fileName);
    let document: NormalizedDesignDocument;
    if (format === "psd") document = importPsdDocument(bytes, fileName, report);
    else if (format === "ai") document = await importIllustratorDocument(bytes, fileName, report);
    else if (format === "svg") document = importSvgDocument(bytes.toString("utf8"), fileName, report);
    else if (format === "figma-json") document = importFigmaDocument(JSON.parse(bytes.toString("utf8")), fileName, report, "figma-json");
    else throw new Error(`Unsupported design format ${format}.`);

    const source = await importAssetBuffer(bytes, fileName, sourceMime(format));
    document.assets.push({
      id: source.assetId,
      name: fileName,
      kind: "source",
      mimeType: source.mimeType,
      sourceUrl: `${PUBLIC_ASSET_BASE}/api/assets/${source.assetId}/content`
    });
    document = await persistExtractedAssets(document, options, report);
    document = normalizeDesignDocument(document, options);
    const scenes = convertDesignDocumentToScenes(document, options, report);
    completeDesignImportReport(report, countNodes(document));
    return { document, scenes, report };
  }

  async importFigma(
    source: FigmaDesignImportSource,
    suppliedOptions: Partial<DesignImportOptions> = {}
  ): Promise<DesignImportResult> {
    const options = mergeOptions({
      ...suppliedOptions,
      selectedNodeIds: suppliedOptions.selectedNodeIds ?? source.nodeIds
    });
    const fileKey = parseFigmaFileKey(source.fileKey);
    if (!fileKey || !source.accessToken.trim()) throw new Error("A Figma file key/URL and access token are required.");
    const report = createDesignImportReport("figma-api", `Figma ${fileKey}`);
    const headers = { "X-Figma-Token": source.accessToken.trim() };
    const documentResponse = source.nodeIds?.length
      ? await figmaJson(`https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(source.nodeIds.join(","))}&geometry=paths`, headers)
      : await figmaJson(`https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}?geometry=paths`, headers);
    const payload = source.nodeIds?.length ? nodesResponseAsDocument(documentResponse, source.nodeIds) : documentResponse;
    let imageUrls: Record<string, string> = {};
    try {
      const images = await figmaJson(`https://api.figma.com/v1/files/${encodeURIComponent(fileKey)}/images`, headers);
      imageUrls = asStringMap((images as { images?: unknown }).images);
    } catch (error) {
      reportImportWarning(report, `Figma image-fill URLs could not be loaded: ${message(error)}`, "missing-asset");
    }
    let document = importFigmaDocument(payload, String((payload as any).name ?? `Figma ${fileKey}`), report, "figma-api", imageUrls);
    document.sourceId = fileKey;
    document = await persistExtractedAssets(document, options, report);
    document = normalizeDesignDocument(document, options);
    const scenes = convertDesignDocumentToScenes(document, options, report);
    completeDesignImportReport(report, countNodes(document));
    return { document, scenes, report };
  }
}

export function parseDesignImportOptions(value: string | undefined): Partial<DesignImportOptions> {
  if (!value) return {};
  const parsed = JSON.parse(value) as Partial<DesignImportOptions>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Import options must be a JSON object.");
  return parsed;
}

async function persistExtractedAssets(
  document: NormalizedDesignDocument,
  options: DesignImportOptions,
  report: DesignImportResult["report"]
): Promise<NormalizedDesignDocument> {
  const idMap = new Map<string, string>();
  const assets = await Promise.all(document.assets.map(async (asset) => {
    if (!asset.dataBase64 && !(options.assetMode === "embed" && asset.sourceUrl)) return asset;
    try {
      const bytes = asset.dataBase64
        ? Buffer.from(asset.dataBase64, "base64")
        : await downloadAsset(asset.sourceUrl!);
      if (bytes.byteLength > MAX_EXTRACTED_ASSET_BYTES) throw new Error("extracted asset exceeds 100 MB");
      const stored = await importAssetBuffer(bytes, asset.name, asset.mimeType);
      idMap.set(asset.id, stored.assetId);
      return {
        ...asset,
        id: stored.assetId,
        dataBase64: undefined,
        sourceUrl: `${PUBLIC_ASSET_BASE}/api/assets/${stored.assetId}/content`,
        linked: false
      };
    } catch (error) {
      reportImportWarning(report, `Asset ${asset.name} could not be embedded: ${message(error)}`, "missing-asset", asset.name, "Link/reference preserved");
      return asset;
    }
  }));
  const pages = document.pages.map((page) => ({
    ...page,
    nodes: page.nodes.map((node) => remapNodeAssets(node, idMap))
  }));
  return { ...document, assets, pages };
}

function remapNodeAssets(node: NormalizedDesignNode, ids: Map<string, string>): NormalizedDesignNode {
  return {
    ...node,
    assetId: node.assetId ? ids.get(node.assetId) ?? node.assetId : undefined,
    masks: node.masks.map((mask) => ({
      ...mask,
      alphaAssetId: mask.alphaAssetId ? ids.get(mask.alphaAssetId) ?? mask.alphaAssetId : undefined
    })),
    children: node.children.map((child) => remapNodeAssets(child, ids))
  };
}

function detectFormat(fileName: string, bytes: Buffer): DesignSourceFormat {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".psd") || bytes.subarray(0, 4).toString("ascii") === "8BPS") return "psd";
  if (lower.endsWith(".ai")) return "ai";
  if (lower.endsWith(".svg") || /^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(bytes.toString("utf8", 0, Math.min(bytes.length, 4096)))) return "svg";
  if (lower.endsWith(".figma.json") || lower.endsWith(".fig.json") || lower.endsWith(".json")) return "figma-json";
  if (lower.endsWith(".pdf") || bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "ai";
  throw new Error("Supported design files are PSD, PDF-compatible AI/PDF, SVG, and exported Figma JSON.");
}

function mergeOptions(options: Partial<DesignImportOptions>): DesignImportOptions {
  return {
    ...DEFAULT_DESIGN_IMPORT_OPTIONS,
    ...options,
    scale: Number.isFinite(options.scale) && options.scale! > 0 ? options.scale! : 1,
    selectedPageIds: options.selectedPageIds?.filter(Boolean),
    selectedNodeIds: options.selectedNodeIds?.filter(Boolean)
  };
}

function sourceMime(format: DesignSourceFormat): string {
  if (format === "psd") return "image/vnd.adobe.photoshop";
  if (format === "ai") return "application/pdf";
  if (format === "svg") return "image/svg+xml";
  return "application/json";
}

function countNodes(document: NormalizedDesignDocument): number {
  const count = (nodes: NormalizedDesignNode[]): number => nodes.reduce((total, node) => total + 1 + count(node.children), 0);
  return document.pages.reduce((total, page) => total + count(page.nodes), 0);
}

async function figmaJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Figma API returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return response.json();
}

async function downloadAsset(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`download returned ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_EXTRACTED_ASSET_BYTES) throw new Error("download exceeds 100 MB");
  return Buffer.from(await response.arrayBuffer());
}

function parseFigmaFileKey(input: string): string {
  const trimmed = input.trim();
  const match = /figma\.com\/(?:design|file|proto|board)\/([^/?#]+)/i.exec(trimmed);
  return (match?.[1] ?? trimmed).replace(/[^a-zA-Z0-9_-]/g, "");
}

function nodesResponseAsDocument(response: any, ids: string[]): unknown {
  const nodes = response?.nodes ?? {};
  return {
    ...response,
    document: {
      id: "selected-document",
      name: response?.name ?? "Selected Figma nodes",
      type: "DOCUMENT",
      children: [{
        id: "selected-page",
        name: "Selected nodes",
        type: "CANVAS",
        children: ids.map((id) => nodes[id]?.document).filter(Boolean)
      }]
    }
  };
}

function asStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
