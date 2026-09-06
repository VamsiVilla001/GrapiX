import {
  DEFAULT_DESIGN_IMPORT_OPTIONS,
  type DesignImportOptions,
  type DesignImportResult,
  type DesignSourceFormat,
  type FigmaDesignImportSource,
  type FigmaMotionImportMode,
  type FigmaMotionImportReport,
  type FigmaMotionManifest,
  type NormalizedDesignDocument,
  type NormalizedDesignNode,
  type SceneDocument
} from "@grapix/shared-types";
import { applyFigmaMotion } from "./figmaMotion.js";
import { collectPrototypeTimelines } from "./figmaPrototype.js";
import { importAssetBuffer, storeProjectImage } from "../../storage.js";
import { normalizeDesignDocument } from "./designDocumentNormalizer.js";
import { importFigmaDocument } from "./figmaImporter.js";
import { importFigmaMcpDocument } from "./figmaMcpImporter.js";
import type { FigmaRestOptions } from "./figmaRestImporter.js";
import { hasFigmaRestToken, importFigmaRestDocument } from "./figmaRestImporter.js";
import { convertDesignDocumentToScenes } from "./grapixObjectConverter.js";
import {
  completeDesignImportReport,
  createDesignImportReport,
  populateDesignImportCounts,
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
const MAX_EXTRACTED_ASSET_BASE64_CHARS = Math.ceil(MAX_EXTRACTED_ASSET_BYTES / 3) * 4;

export class DesignImportManager {
  async importFile(
    bytes: Buffer,
    fileName: string,
    suppliedOptions: Partial<DesignImportOptions> = {},
    /**
     * A `grapix-figma-motion.json` to apply on top, for an exported Figma document.
     *
     * Separate from the options because it is not an option: it is a second source file, and the
     * design import must produce exactly the same scenes whether one is supplied or not.
     */
    motion: { motionMode?: FigmaMotionImportMode; motionManifest?: FigmaMotionManifest } = {}
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
    document = normalizeDesignDocument(document, options, report);
    populateDesignImportCounts(document, report);
    pruneDesignImportIssues(report, importedNodeIds(document));
    const scenes = convertDesignDocumentToScenes(document, options, report);
    completeDesignImportReport(report, countNodes(document));
    return applyMotion(document, scenes, report, motion);
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
    suppliedOptions: Partial<DesignImportOptions> = {},
    /** The HTTP layer, injected by tests so a whole import can run without a Figma account. */
    restOptions: FigmaRestOptions = {}
  ): Promise<DesignImportResult> {
    const options = mergeOptions({
      // A hidden Figma layer is authored information: a designer's alternate take, a state that a
      // data binding switches on, a variant they keep beside the live one. Dropping it means an
      // operator cannot turn it back on, so the Figma route keeps hidden layers unless the caller
      // explicitly says otherwise — they arrive with `visible: false`, exactly as authored.
      importHiddenLayers: true,
      ...suppliedOptions
    });
    const transport = figmaTransport(source);
    const report = createDesignImportReport(
      transport === "rest" ? "figma-json" : "figma-mcp",
      source.url.trim() || "Figma selection"
    );
    let document = transport === "rest"
      ? await importFigmaRestDocument(source, report, restOptions)
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
    document = await persistExtractedAssets(document, options, report, restOptions.fetchImpl ?? fetch);
    document = normalizeDesignDocument(document, options, report);
    populateDesignImportCounts(document, report);
    pruneDesignImportIssues(report, importedNodeIds(document));
    const scenes = convertDesignDocumentToScenes(document, options, report);
    completeDesignImportReport(report, countNodes(document));

    return applyMotion(document, scenes, report, source);
  }
}

/**
 * Bring a design's motion across, when any was asked for.
 *
 * Shared by both import routes rather than living inside the Figma one, because a manifest from
 * the export bridge is a *file the author downloads* — and the natural place to hand GrapiX a
 * downloaded file is the same tab they drop the design on. A motion path that only existed on the
 * link route would refuse the bridge's own output whenever the design came in as exported JSON.
 *
 * `collectPrototypeTimelines` reads whatever prototype data the document carries, so a file with
 * none simply contributes nothing and the manifest's timelines are the bridge's alone.
 */
function applyMotion(
  document: NormalizedDesignDocument,
  scenes: SceneDocument[],
  report: DesignImportResult["report"],
  motion: { motionMode?: FigmaMotionImportMode; motionManifest?: FigmaMotionManifest }
): DesignImportResult {
  const motionMode = motion.motionMode ?? "design-only";
  if (motionMode === "design-only") return { document, scenes, report };

  /*
   * Motion is applied after the scenes exist, and to copies.
   *
   * `applyFigmaMotion` returns a new scene rather than mutating one, so a failure anywhere in
   * here leaves `scenes` exactly as the design import produced them — the design still lands
   * and only the motion is lost. That is the rollback: there is nothing to undo, because
   * nothing was written in place.
   */
  const timelines = [
    ...collectPrototypeTimelines(document, report),
    ...(motionMode === "full-motion-manifest" ? motion.motionManifest?.timelines ?? [] : [])
  ];

  const manifest: FigmaMotionManifest = {
    version: 1,
    generator: motion.motionManifest?.generator ?? "grapix-figma-rest",
    fileKey: motion.motionManifest?.fileKey,
    fileName: motion.motionManifest?.fileName ?? document.sourceName,
    exportedAt: new Date().toISOString(),
    frames: motion.motionManifest?.frames,
    timelines
  };

  const animated: SceneDocument[] = [];
  const merged = emptyMotionReport(timelines.length);
  for (const scene of scenes) {
    const applied = applyFigmaMotion(scene, manifest, { fps: scene.timeline.fps });
    animated.push(applied.scene);
    mergeMotionReports(merged, applied.report);
  }

  if (motionMode === "full-motion-manifest" && !motion.motionManifest) {
    report.warnings.push(
      "Full motion manifest was requested but none was supplied, so only prototype transitions from the REST API were imported."
    );
  }

  return { document, scenes: animated, report, motion: merged };
}

function emptyMotionReport(timelines: number): FigmaMotionImportReport {
  return {
    timelines,
    timelinesConverted: 0,
    matchedNodes: 0,
    missingNodes: [],
    channelsCreated: 0,
    keyframesCreated: 0,
    entries: []
  };
}

/**
 * Fold one scene's motion report into the run's.
 *
 * A node missing from *every* scene is the one worth reporting; a node present in scene B is not
 * missing just because scene A did not hold it, which is why the missing set is intersected
 * rather than unioned once the first scene has been seen.
 */
function mergeMotionReports(into: FigmaMotionImportReport, from: FigmaMotionImportReport): void {
  into.timelinesConverted = Math.max(into.timelinesConverted, from.timelinesConverted);
  into.matchedNodes += from.matchedNodes;
  into.channelsCreated += from.channelsCreated;
  into.keyframesCreated += from.keyframesCreated;
  into.entries.push(...from.entries);

  const matched = new Set(from.entries.filter((entry) => entry.objectId).map((entry) => entry.nodeId));
  into.missingNodes = [...new Set([...into.missingNodes, ...from.missingNodes])].filter((id) => !matched.has(id));
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
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Import options must be a JSON object.");
  }
  for (const key of Object.keys(parsed)) {
    if (!(key in DESIGN_IMPORT_OPTION_KEYS)) throw new Error(`Unknown import option "${key}".`);
  }
  return parsed as Partial<DesignImportOptions>;
}

/**
 * A query-string motion mode → the typed one.
 *
 * An unrecognised value is rejected rather than quietly treated as `design-only`: a caller that
 * misspells the mode is asking for motion and would otherwise get a silent design-only import
 * and no way to tell why nothing animated.
 */
export function parseMotionMode(value: string | undefined): FigmaMotionImportMode | undefined {
  if (!value) return undefined;
  if (value === "design-only" || value === "design-and-prototype-motion" || value === "full-motion-manifest") {
    return value;
  }
  throw new Error(`Unknown motion mode "${value}".`);
}

async function persistExtractedAssets(
  document: NormalizedDesignDocument,
  options: DesignImportOptions,
  report: DesignImportResult["report"],
  /*
   * The same HTTP layer the document came through. A Figma image URL is signed for the caller that
   * asked for it, so downloading the bytes belongs to the same client — and it means an import can
   * be exercised whole, from link to stored file, without a Figma account.
   */
  call: typeof fetch = fetch
): Promise<NormalizedDesignDocument> {
  const idMap = new Map<string, string>();
  /**
   * Which scene each asset belongs to, and under what layer name.
   *
   * An image is filed under the scene that uses it and named after the layer that paints it, so the
   * project directory reads like the design rather than like a hash table. The first user wins when
   * several share a bitmap — Figma reuses one `imageRef` wherever the same photo is placed, and one
   * file is the point.
   */
  const placement = imagePlacements(document);

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
      if (asset.dataBase64 && asset.dataBase64.length > MAX_EXTRACTED_ASSET_BASE64_CHARS) {
        throw new Error("base64-encoded extracted asset exceeds the 100 MB decoded limit");
      }
      const bytes = asset.dataBase64
        ? Buffer.from(asset.dataBase64, "base64")
        : await downloadAsset(asset.sourceUrl!, call);
      if (bytes.byteLength > MAX_EXTRACTED_ASSET_BYTES) throw new Error("extracted asset exceeds 100 MB");
      const stored = await importAssetBuffer(bytes, asset.name, asset.mimeType);
      idMap.set(asset.id, stored.assetId);
      if (asset.kind !== "source") report.counts.assetsDownloaded += 1;

      /*
       * An image a design placed also gets a readable home: `images/<scene>/<layer>.png`, and the
       * scene refers to it by that path. The temporary Figma URL is gone the moment this returns —
       * it expires in minutes, and a scene that still pointed at one would open to a missing photo
       * the next day.
       */
      const place = placement.get(asset.id);
      const project = place && (asset.kind === "image" || asset.kind === "svg")
        ? await storeProjectImage(place.sceneName, place.fileName || asset.name, bytes, stored.mimeType)
        : null;

      return {
        ...asset,
        id: stored.assetId,
        dataBase64: undefined,
        // The project-relative path when there is one; the asset endpoint otherwise. Both are served
        // by this service, and neither expires.
        sourceUrl: project ? project.relativePath : `${PUBLIC_ASSET_BASE}/api/assets/${stored.assetId}/content`,
        ...(project ? { projectPath: project.relativePath } : {}),
        linked: false,
        // The engine registers assets by SHA-256; without it the scene is refused at
        // `asset.register` with "has no checksum and cannot be sent to the render engine".
        checksum: stored.checksum,
        sizeBytes: stored.sizeBytes
      };
    } catch (error) {
      report.counts.assetsFailed += 1;
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

/**
 * Which scene and file name each image asset should be stored under.
 *
 * Walks the pages in order and records the first layer that paints each asset. The layer's name is
 * what a designer recognises — `player-photo.png`, not `asset_9f2c….png` — and the scene folder is
 * the page, because that is what becomes a GrapiX scene.
 */
function imagePlacements(
  document: NormalizedDesignDocument
): Map<string, { sceneName: string; fileName: string }> {
  const placements = new Map<string, { sceneName: string; fileName: string }>();

  for (const page of document.pages) {
    const sceneName = page.name || document.sourceName.replace(/\.[^.]+$/, "") || "scene";
    const walk = (nodes: NormalizedDesignNode[]): void => {
      for (const node of nodes) {
        for (const id of imageAssetIdsOf(node)) {
          if (!placements.has(id)) placements.set(id, { sceneName, fileName: node.name });
        }
        walk(node.children);
      }
    };
    walk(page.nodes);
  }

  return placements;
}

/** Every asset id a node paints with, in the order they are painted. */
function imageAssetIdsOf(node: NormalizedDesignNode): string[] {
  return [
    ...(node.assetId ? [node.assetId] : []),
    ...(node.additionalImageAssetIds ?? []),
    ...(node.strokeImageAssetIds ?? [])
  ];
}

/** True when the asset already lives in this project's store under its own id. */
function isStoredHere(asset: NormalizedDesignDocument["assets"][number]): boolean {
  return !asset.dataBase64
    && asset.sourceUrl === `${PUBLIC_ASSET_BASE}/api/assets/${asset.id}/content`;
}

function remapNodeAssets(node: NormalizedDesignNode, ids: Map<string, string>): NormalizedDesignNode {
  const remap = (assetId: string | undefined): string | undefined =>
    assetId ? ids.get(assetId) ?? assetId : undefined;

  return {
    ...node,
    assetId: remap(node.assetId),
    // The rendered asset is remapped too. Missing it meant a flattened node still pointed at the
    // pre-storage id, the converter could not find the asset, and the node fell back to an empty
    // container — the pixels were downloaded and then not used.
    renderedAssetId: remap(node.renderedAssetId),
    // Every other image the layer uses — a stacked fill, an image stroke — is an id in the same
    // space and needs the same rewrite, or the library entry it names no longer exists.
    ...(node.additionalImageAssetIds
      ? { additionalImageAssetIds: node.additionalImageAssetIds.map((id) => remap(id)!).filter(Boolean) }
      : {}),
    ...(node.strokeImageAssetIds
      ? { strokeImageAssetIds: node.strokeImageAssetIds.map((id) => remap(id)!).filter(Boolean) }
      : {}),
    masks: node.masks.map((mask) => ({
      ...mask,
      alphaAssetId: remap(mask.alphaAssetId)
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

const DESIGN_IMPORT_OPTION_KEYS: Record<keyof DesignImportOptions, true> = {
  preserveHierarchy: true,
  keepTextEditable: true,
  importHiddenLayers: true,
  assetMode: true,
  convertComponents: true,
  missingFontPolicy: true,
  replacementFontFamily: true,
  unsupportedFeaturePolicy: true,
  scale: true,
  targetWidth: true,
  targetHeight: true,
  selectedPageIds: true,
  selectedNodeIds: true
};

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

/**
 * Every id an issue may legitimately refer to, for both nodes and source layers.
 *
 * Both forms: `node.id` is ours (`figma-10-9`) and `sourceId` is the design tool's (`10:9`), and
 * issues are raised with the *source* id because that is what an author sees in Figma. Collecting
 * only our own ids meant every node-scoped issue looked like it belonged to a discarded layer, so
 * the pruning pass deleted the entire per-layer report and left only the document-level lines.
 */
function importedNodeIds(document: NormalizedDesignDocument): Set<string> {
  const ids = new Set<string>();
  const walk = (nodes: NormalizedDesignNode[]): void => {
    for (const node of nodes) {
      ids.add(node.id);
      if (node.sourceId) ids.add(node.sourceId);
      walk(node.children);
    }
  };
  document.pages.forEach((page) => walk(page.nodes));

  // Mask layers are not nodes any more, but they were imported — as masks on what they mask.
  const consumed = document.sourceMetadata.consumedMaskNodeIds;
  if (Array.isArray(consumed)) {
    for (const id of consumed) if (typeof id === "string") ids.add(id);
  }
  return ids;
}

/**
 * Reject URLs that can address local or private infrastructure before sending a request.
 * This blocks literal addresses and obvious internal names; DNS rebinding remains a residual
 * risk until downloads run through a resolver that pins the validated remote address.
 */
function assertSafeAssetUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("asset URL is invalid");
  }
  if (url.protocol !== "https:") throw new Error("asset URL must use https");

  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const isPrivateIpv4 = isPrivateIpv4Address(hostname);
  const mappedIpv4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(hostname)?.[1];
  const isPrivateIpv6 = hostname === "::1"
    || /^fe[89ab][0-9a-f]*:/iu.test(hostname)
    || (mappedIpv4 !== undefined && isPrivateIpv4Address(mappedIpv4));
  if (
    isPrivateIpv4
    || isPrivateIpv6
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "internal"
    || hostname.endsWith(".internal")
    || hostname === "local"
    || hostname.endsWith(".local")
  ) {
    throw new Error("asset URL targets a blocked local or private host");
  }
  return url;
}

function isPrivateIpv4Address(hostname: string): boolean {
  const octets = hostname.split(".").map((part) => Number(part));
  if (octets.length !== 4 || !octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return false;
  }
  return (
    octets[0] === 0
    || octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
  );
}

async function downloadAsset(value: string, call: typeof fetch = fetch): Promise<Buffer> {
  const url = assertSafeAssetUrl(value);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await call(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok) throw new Error(`download returned ${response.status}`);
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > MAX_EXTRACTED_ASSET_BYTES) throw new Error("download exceeds 100 MB");
    if (!response.body) throw new Error("download returned no body");

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        received += chunk.byteLength;
        if (received > MAX_EXTRACTED_ASSET_BYTES) {
          controller.abort();
          await reader.cancel();
          throw new Error("download exceeds 100 MB");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks, received);
  } finally {
    clearTimeout(timeout);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

