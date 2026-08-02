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
import { importFigmaMcpDocument } from "./figmaMcpImporter.js";
import { hasFigmaRestToken, importFigmaRestDocument } from "./figmaRestImporter.js";
import { convertDesignDocumentToScenes } from "./grapixObjectConverter.js";
import {
  completeDesignImportReport,
  createDesignImportReport,
  pruneDesignImportIssues,
  reportImportWarning
} from "./importReport.js";
import { importIllustratorDocument, importSvgDocument } from "./illustratorImporter.js";
import { importPsdDocument } from "./psdImporter.js";

/**
 * Base for the asset URLs written into an imported scene. Derived from the port the
 * service was told to bind, because a hardcoded 4100 makes an import running on any
 * other port fetch a different process's asset store - or nothing at all.
 */
const PUBLIC_ASSET_BASE = process.env.GRAPIX_API_PUBLIC_BASE?.trim()
  || `http://127.0.0.1:${Number(process.env.GRAPIX_API_PORT ?? 4100)}`;
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
      sourceUrl: `${PUBLIC_ASSET_BASE}/api/assets/${source.assetId}/content`,
      checksum: source.checksum,
      sizeBytes: source.sizeBytes
    });
    document = await persistExtractedAssets(document, options, report);
    document = normalizeDesignDocument(document, options);
    pruneDesignImportIssues(report, importedNodeIds(document));
    const scenes = convertDesignDocumentToScenes(document, options, report);
    completeDesignImportReport(report, countNodes(document));
    return { document, scenes, report };
  }

  /**
   * Import a Figma link.
   *
   * `rest` is the editable route: it fetches the native document JSON, so text stays
   * text and vectors stay paths. `desktop-mcp` needs no token but can only return the
   * screenshot Figma renders, so the node lands as one image. `auto` prefers REST
   * whenever a token is available.
   */
  async importFigma(
    source: FigmaDesignImportSource,
    suppliedOptions: Partial<DesignImportOptions> = {}
  ): Promise<DesignImportResult> {
    const options = mergeOptions(suppliedOptions);
    const transport = figmaTransport(source);
    const report = createDesignImportReport(
      transport === "rest" ? "figma-json" : "figma-mcp",
      source.url.trim() || "Figma selection"
    );
    let document = transport === "rest"
      ? await importFigmaRestDocument(source, report)
      : await importFigmaMcpDocument(source, report);
    if (transport === "rest") {
      // Provenance: the exact JSON this scene came from, stored like an uploaded file.
      const stored = await importAssetBuffer(
        Buffer.from(JSON.stringify(document, null, 2)),
        `${document.sourceName || "figma"}.figma.json`,
        "application/json"
      );
      document.assets.push({
        id: stored.assetId,
        name: stored.fileName,
        kind: "source",
        mimeType: stored.mimeType,
        sourceUrl: `${PUBLIC_ASSET_BASE}/api/assets/${stored.assetId}/content`,
        checksum: stored.checksum,
        sizeBytes: stored.sizeBytes
      });
    }
    document = await persistExtractedAssets(document, options, report);
    document = normalizeDesignDocument(document, options);
    pruneDesignImportIssues(report, importedNodeIds(document));
    const scenes = convertDesignDocumentToScenes(document, options, report);
    completeDesignImportReport(report, countNodes(document));
    return { document, scenes, report };
  }
}

/** Resolve the requested transport, refusing REST with no token rather than silently rasterizing. */
function figmaTransport(source: FigmaDesignImportSource): "rest" | "desktop-mcp" {
  const requested = source.transport ?? "auto";
  if (requested === "desktop-mcp") return "desktop-mcp";
  if (requested === "rest") {
    if (!hasFigmaRestToken(source)) {
      throw new Error(
        "Native Figma JSON needs a REST token. Provide a personal access token with the file_content:read scope, set FIGMA_ACCESS_TOKEN on the project service, or choose the Figma Desktop MCP transport, which imports a screenshot instead of editable layers."
      );
    }
    return "rest";
  }
  return hasFigmaRestToken(source) ? "rest" : "desktop-mcp";
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
    // An asset already in this store needs no work: `importFile` stores the source
    // document before this pass, and re-fetching its own bytes over loopback to
    // hash them into the same path costs a full copy of the file (93 MB for a
    // real PSD) and fails outright if the public base does not resolve.
    if (isStoredHere(asset)) return asset;
    if (!asset.dataBase64 && !(options.assetMode === "embed" && asset.sourceUrl)) {
      // A linked remote asset has no bytes in this project, so the engine cannot
      // register it and Program cannot show it. Say so at import time rather than at
      // Take time.
      if (asset.sourceUrl && asset.kind !== "source") {
        reportImportWarning(
          report,
          `Asset ${asset.name} stays linked to ${asset.sourceUrl.replace(/\?.*$/, "")} and has no stored bytes, so the render engine cannot register it. Re-import with "Embed extracted assets" to put it on air.`,
          "missing-asset",
          asset.name,
          "External link only; not available to Program"
        );
      }
      return asset;
    }
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
        linked: false,
        // The engine registers assets by SHA-256; without it the scene is refused at
        // `asset.register` with "has no checksum and cannot be sent to the render engine".
        checksum: stored.checksum,
        sizeBytes: stored.sizeBytes
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

/** True when the asset already lives in this project's store under its own id. */
function isStoredHere(asset: NormalizedDesignDocument["assets"][number]): boolean {
  return !asset.dataBase64
    && asset.sourceUrl === `${PUBLIC_ASSET_BASE}/api/assets/${asset.id}/content`;
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

/** Every node id that survived selection, hidden-layer and hierarchy normalization. */
function importedNodeIds(document: NormalizedDesignDocument): Set<string> {
  const ids = new Set<string>();
  const walk = (nodes: NormalizedDesignNode[]): void => {
    for (const node of nodes) {
      ids.add(node.id);
      walk(node.children);
    }
  };
  document.pages.forEach((page) => walk(page.nodes));
  return ids;
}

async function downloadAsset(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`download returned ${response.status}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_EXTRACTED_ASSET_BYTES) throw new Error("download exceeds 100 MB");
  return Buffer.from(await response.arrayBuffer());
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

