import {
  type DesignImportReport,
  type FigmaDesignImportSource,
  type NormalizedDesignDocument,
  type NormalizedDesignNode
} from "@grapix/shared-types";
import { importFigmaDocument } from "./figmaImporter.js";
import { addDesignImportIssue } from "./importReport.js";

const FIGMA_API_BASE = "https://api.figma.com";
const REQUEST_TIMEOUT_MS = 60_000;

export interface FigmaLinkTarget {
  /** The key REST calls address. For a branch link this is the branch's own key. */
  fileKey: string;
  /** Present when the link pointed at a branch, for the import report. */
  branchKey?: string;
  /** API-form node ids (`123:456`), in link order. Empty means the whole file. */
  nodeIds: string[];
  /** Link flavour, or "key" when a bare file key was supplied. */
  kind: "design" | "file" | "proto" | "board" | "key";
}

/**
 * Parse a Figma link into the file key and node ids the REST API takes.
 *
 * Every Figma URL flavour carries the key in the same slot
 * (`figma.com/{design|file|proto|board}/{key}/{slug}`) and the selection in
 * `?node-id=`, where `:` is written as `-`. A branch link inserts
 * `/branch/{branchKey}/` and REST addresses that branch as its own file, so the
 * branch key replaces the parent key. Instance ids (`I1-2;3-4`) survive the same
 * dash-to-colon rewrite.
 */
export function parseFigmaLink(input: string): FigmaLinkTarget {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("A Figma file link or file key is required.");

  const linkMatch = /figma\.com\/(design|file|proto|board)\/([A-Za-z0-9]+)/i.exec(trimmed);
  if (!linkMatch) {
    // A bare key: Figma keys are alphanumeric and at least 20 characters.
    if (/^[A-Za-z0-9]{20,}$/.test(trimmed)) {
      return { fileKey: trimmed, nodeIds: [], kind: "key" };
    }
    throw new Error(
      "That is not a Figma link. Copy a link from Figma (Share, or Dev Mode -> Copy link) shaped like https://www.figma.com/design/<file-key>/<name>?node-id=1-2"
    );
  }

  const parentKey = linkMatch[2];
  const branchMatch = /\/branch\/([A-Za-z0-9]+)/i.exec(trimmed);
  const nodeIds = new Set<string>();
  const query = trimmed.includes("?") ? trimmed.slice(trimmed.indexOf("?") + 1) : "";
  for (const [name, value] of new URLSearchParams(query)) {
    if (name !== "node-id" && name !== "node_id") continue;
    for (const candidate of value.split(",")) {
      const normalized = normalizeFigmaNodeId(candidate);
      if (normalized) nodeIds.add(normalized);
    }
  }

  return {
    fileKey: branchMatch?.[1] ?? parentKey,
    branchKey: branchMatch?.[1],
    nodeIds: [...nodeIds],
    kind: linkMatch[1].toLowerCase() as FigmaLinkTarget["kind"]
  };
}

/** Node ids travel through URLs with `:` written as `-`; the API wants the colons back. */
export function normalizeFigmaNodeId(value: string): string | null {
  const candidate = decodeURIComponent(value.trim()).replace(/-/g, ":");
  return /^I?\d+:\d+(?:[;:]I?\d+:\d+)*$/.test(candidate) ? candidate : null;
}

export interface FigmaRestOptions {
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * Fetch genuine Figma document JSON over REST and convert it to editable objects.
 *
 * This is the only Figma route that yields the native document: the Desktop MCP
 * server returns sparse XML plus generated code and a screenshot, so it can never
 * produce editable layers. The response feeds the same `figma-json` adapter as an
 * exported document, including `geometry=paths` vector outlines and the image-fill
 * URLs that `imageRef` keys resolve to.
 */
export async function importFigmaRestDocument(
  source: FigmaDesignImportSource,
  report: DesignImportReport,
  options: FigmaRestOptions = {}
): Promise<NormalizedDesignDocument> {
  const call = options.fetchImpl ?? fetch;
  const token = resolveFigmaToken(source);
  const target = parseFigmaLink(source.url);
  const explicit = (source.nodeIds ?? [])
    .map((value) => normalizeFigmaNodeId(value))
    .filter((value): value is string => Boolean(value));
  const nodeIds = [...new Set([...explicit, ...target.nodeIds])];

  const document = nodeIds.length
    ? nodesResponseAsDocument(
        await figmaRequest(call, token, `/v1/files/${target.fileKey}/nodes?ids=${encodeURIComponent(nodeIds.join(","))}&geometry=paths`),
        nodeIds,
        report
      )
    : await figmaRequest(call, token, `/v1/files/${target.fileKey}?geometry=paths`);

  const imageUrls = await fetchImageFillUrls(call, token, target.fileKey);
  const sourceName = String((document as Record<string, unknown>).name ?? target.fileKey);

  addDesignImportIssue(report, {
    kind: "converted",
    severity: "info",
    message: target.branchKey
      ? `Imported branch ${target.branchKey} of Figma file ${target.fileKey} as native document JSON over the REST API.`
      : `Imported Figma file ${target.fileKey} as native document JSON over the REST API.`,
    fallback: nodeIds.length ? `Nodes: ${nodeIds.join(", ")}` : "Whole file"
  });

  const normalized = importFigmaDocument(
    { ...(document as Record<string, unknown>), key: target.fileKey },
    sourceName,
    report,
    "figma-json",
    imageUrls
  );

  await resolveUnmappedImageFills(normalized, call, token, target.fileKey, report);
  return normalized;
}

/**
 * Recover image fills that `/v1/files/:key/images` did not map.
 *
 * That endpoint only knows the refs of images stored in this file, so a fill coming
 * from a library component, another file, or a branch resolves to nothing - leaving an
 * asset with no bytes, no checksum, and therefore no way onto Program. For those, the
 * node carrying the fill is rendered once through `/v1/images/:key`, which gives real
 * pixels the asset pass can store. It is a raster of that node, so it is reported.
 */
async function resolveUnmappedImageFills(
  document: NormalizedDesignDocument,
  call: typeof fetch,
  token: { value: string; kind: "personal" | "oauth" },
  fileKey: string,
  report: DesignImportReport
): Promise<void> {
  const unresolved = new Map<string, { assetId: string; nodeName: string }>();
  const walk = (nodes: NormalizedDesignNode[]): void => {
    for (const node of nodes) {
      const asset = node.assetId
        ? document.assets.find((entry) => entry.id === node.assetId)
        : undefined;
      if (asset && !asset.sourceUrl && !asset.dataBase64 && node.sourceId) {
        unresolved.set(node.sourceId, { assetId: asset.id, nodeName: node.name });
      }
      walk(node.children);
    }
  };
  document.pages.forEach((page) => walk(page.nodes));
  if (!unresolved.size) return;

  const ids = [...unresolved.keys()];
  let images: Record<string, string | null> = {};
  try {
    const payload = await figmaRequest(
      call,
      token,
      `/v1/images/${fileKey}?ids=${encodeURIComponent(ids.join(","))}&format=png&scale=1`
    ) as { images?: Record<string, string | null> };
    images = payload.images ?? {};
  } catch {
    images = {};
  }

  for (const [nodeId, { assetId, nodeName }] of unresolved) {
    const url = images[nodeId];
    const asset = document.assets.find((entry) => entry.id === assetId);
    if (!asset) continue;
    if (!url) {
      addDesignImportIssue(report, {
        kind: "missing-asset",
        severity: "warning",
        message: `Figma did not expose the image fill on ${nodeName}: its imageRef is not in this file's image map and the node could not be rendered.`,
        sourceNodeId: nodeId,
        sourceNodeName: nodeName,
        fallback: "Object keeps its geometry without the fill"
      });
      continue;
    }
    asset.sourceUrl = url;
    addDesignImportIssue(report, {
      kind: "rasterized",
      severity: "warning",
      message: `The image fill on ${nodeName} is not in this file's image map, so the node was rendered by Figma and imported as pixels.`,
      sourceNodeId: nodeId,
      sourceNodeName: nodeName,
      fallback: "Figma node render"
    });
  }
}

/** True when a REST import can run: it needs a token, and nothing else. */
export function hasFigmaRestToken(source: FigmaDesignImportSource): boolean {
  return Boolean(figmaToken(source));
}

function figmaToken(source: FigmaDesignImportSource): string {
  return (
    source.accessToken?.trim()
    || process.env.FIGMA_ACCESS_TOKEN?.trim()
    || process.env.FIGMA_TOKEN?.trim()
    || ""
  );
}

function resolveFigmaToken(source: FigmaDesignImportSource): { value: string; kind: "personal" | "oauth" } {
  const value = figmaToken(source);
  if (!value) {
    throw new Error(
      "The Figma REST API requires a token. Provide a personal access token with the file_content:read scope (Figma -> Settings -> Security -> Personal access tokens), or set FIGMA_ACCESS_TOKEN on the machine running the project service. Without one, use the Figma Desktop MCP route, which imports a screenshot instead of editable layers."
    );
  }
  // Personal access tokens are `figd_…`; anything else is treated as an OAuth bearer.
  const kind = source.tokenKind ?? (value.startsWith("figd_") ? "personal" : "oauth");
  return { value, kind };
}

async function figmaRequest(
  call: typeof fetch,
  token: { value: string; kind: "personal" | "oauth" },
  path: string
): Promise<unknown> {
  const response = await call(`${FIGMA_API_BASE}${path}`, {
    headers: token.kind === "personal"
      ? { "X-Figma-Token": token.value }
      : { Authorization: `Bearer ${token.value}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });

  if (!response.ok) throw new Error(await figmaErrorMessage(response, path));
  const payload = await response.json() as Record<string, unknown>;
  // The REST API answers 200 with an `err`/`error` body for some failures.
  const embedded = payload.err ?? (payload.error === true ? payload.status : undefined);
  if (typeof embedded === "string" && embedded) throw new Error(`Figma API: ${embedded}`);
  return payload;
}

/** Map REST failures onto the thing the operator has to change. */
async function figmaErrorMessage(response: Response, path: string): Promise<string> {
  const detail = await response.text().catch(() => "");
  const trimmed = detail.slice(0, 300);
  if (response.status === 401) {
    return "Figma rejected the token (401). It is invalid or expired; issue a new personal access token.";
  }
  if (response.status === 403) {
    return "Figma refused the request (403). The token needs the file_content:read scope and the account must have access to this file.";
  }
  if (response.status === 404) {
    return `Figma could not find that file or node (404). Check the file key, and use the branch link when the design lives on a branch. Requested ${path}.`;
  }
  if (response.status === 429) {
    const retry = response.headers.get("retry-after");
    return `Figma rate-limited the request (429)${retry ? `; retry after ${retry}s` : ""}.`;
  }
  return `Figma API returned ${response.status}. ${trimmed}`;
}

/**
 * Wrap a `/nodes` response in the DOCUMENT/CANVAS shape the adapter reads.
 *
 * `/v1/files/:key/nodes` answers with one entry per requested id, each already a
 * whole subtree. A node the token cannot see is simply absent, which is reported
 * rather than silently dropped.
 */
function nodesResponseAsDocument(
  payload: unknown,
  ids: string[],
  report: DesignImportReport
): Record<string, unknown> {
  const root = (payload ?? {}) as Record<string, any>;
  const entries = (root.nodes ?? {}) as Record<string, any>;
  const documents = ids
    .map((id) => {
      const entry = entries[id];
      if (!entry?.document) {
        addDesignImportIssue(report, {
          kind: "warning",
          severity: "warning",
          message: `Figma returned no node ${id}; it was deleted, moved, or is outside what this token can read.`,
          sourceNodeId: id
        });
        return null;
      }
      return entry.document as Record<string, unknown>;
    })
    .filter((node): node is Record<string, unknown> => Boolean(node));

  if (!documents.length) {
    throw new Error(`Figma returned none of the requested nodes (${ids.join(", ")}).`);
  }

  const components: Record<string, unknown> = {};
  const componentSets: Record<string, unknown> = {};
  for (const id of ids) {
    Object.assign(components, entries[id]?.components ?? {});
    Object.assign(componentSets, entries[id]?.componentSets ?? {});
  }

  return {
    name: root.name ?? "Figma selection",
    components,
    componentSets,
    document: {
      id: "0:0",
      name: String(root.name ?? "Figma selection"),
      type: "DOCUMENT",
      children: [{
        id: "0:1",
        name: documents.length === 1 ? String(documents[0].name ?? "Figma node") : `Figma selection (${documents.length} nodes)`,
        type: "CANVAS",
        backgroundColor: { r: 0, g: 0, b: 0, a: 0 },
        children: documents
      }]
    }
  };
}

/**
 * Resolve `imageRef` fills to downloadable URLs.
 *
 * A REST document references raster fills by `imageRef` only;
 * `/v1/files/:key/images` is the map from those refs to short-lived S3 URLs, which
 * the asset pass then stores. Failing to read it costs image fills, not the import,
 * so it degrades to an empty map with a warning.
 */
async function fetchImageFillUrls(
  call: typeof fetch,
  token: { value: string; kind: "personal" | "oauth" },
  fileKey: string
): Promise<Record<string, string>> {
  try {
    const payload = await figmaRequest(call, token, `/v1/files/${fileKey}/images`) as Record<string, any>;
    const images = payload?.meta?.images ?? {};
    return Object.fromEntries(
      Object.entries(images)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0)
    );
  } catch {
    return {};
  }
}
