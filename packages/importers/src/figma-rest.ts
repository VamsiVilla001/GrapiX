/**
 * Figma REST front-end — the fallback path.
 *
 * Uses a personal access token held by the active profile. Lower fidelity than the plugin
 * (outlined geometry, reconstructed text runs), so the mapper tags every DesignIR produced
 * here with a FIGMA_REST_FALLBACK notice.
 */

import {
  parseFigmaUrl,
  type FigmaImagePayload,
  type FigmaImportPayload,
  type FigmaNodePayload
} from "./figma-payload.js";

const FIGMA_API_BASE = "https://api.figma.com/v1";

export interface FigmaRestOptions {
  token: string;
  /** File URL or bare file key. */
  target: string;
  /** Overrides any node id found in the URL. */
  nodeIds?: string[];
  /** Resolve image-fill URLs. On by default; the URLs Figma returns are short-lived. */
  resolveImages?: boolean;
  fetchImpl?: typeof fetch;
}

/** Shared style definitions, as returned alongside the nodes. */
type FigmaStyleTable = Record<
  string,
  { name?: string; styleType?: string; key?: string; description?: string }
>;

interface FigmaNodesResponse {
  name?: string;
  version?: string;
  lastModified?: string;
  nodes?: Record<
    string,
    { document?: FigmaNodePayload; styles?: FigmaStyleTable } | undefined
  >;
}

interface FigmaFileResponse {
  name?: string;
  version?: string;
  lastModified?: string;
  document?: FigmaNodePayload;
  styles?: FigmaStyleTable;
}

interface FigmaImageFillsResponse {
  meta?: { images?: Record<string, string> };
}

export class FigmaRestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "FigmaRestError";
    this.status = status;
  }
}

export async function fetchFigmaPayload(options: FigmaRestOptions): Promise<FigmaImportPayload> {
  const parsed = parseFigmaUrl(options.target);

  if (!parsed) {
    throw new FigmaRestError(
      "Could not read a Figma file key. Paste the file URL, or the bare file key.",
      400
    );
  }

  const doFetch = options.fetchImpl ?? fetch;
  const nodeIds = options.nodeIds?.length ? options.nodeIds : parsed.nodeIds;

  const { nodes, fileName, version, styles } = nodeIds.length
    ? await fetchSelectedNodes(doFetch, options.token, parsed.fileKey, nodeIds)
    : await fetchWholeFile(doFetch, options.token, parsed.fileKey);

  const images =
    options.resolveImages === false ? [] : await fetchImageFills(doFetch, options.token, parsed.fileKey);

  return {
    origin: "rest",
    fileKey: parsed.fileKey,
    fileName,
    version,
    nodes,
    images,
    styles
  };
}

async function fetchSelectedNodes(
  doFetch: typeof fetch,
  token: string,
  fileKey: string,
  nodeIds: string[]
): Promise<{
  nodes: FigmaNodePayload[];
  fileName: string;
  version: string;
  styles: FigmaStyleTable;
}> {
  const query = new URLSearchParams({
    ids: nodeIds.join(","),
    geometry: "paths"
  });
  const response = await figmaRequest<FigmaNodesResponse>(
    doFetch,
    token,
    `/files/${fileKey}/nodes?${query.toString()}`
  );

  const entries = Object.values(response.nodes ?? {});
  const nodes = entries
    .map((entry) => entry?.document)
    .filter((document): document is FigmaNodePayload => Boolean(document));
  // Each requested node carries its own styles table; merge them into one.
  const styles: FigmaStyleTable = Object.assign({}, ...entries.map((entry) => entry?.styles ?? {}));

  if (!nodes.length) {
    throw new FigmaRestError(
      `Figma returned no nodes for ${nodeIds.join(", ")}. Check the node id and that the token can read this file.`,
      404
    );
  }

  return {
    nodes,
    styles,
    fileName: response.name ?? fileKey,
    version: response.version ?? response.lastModified ?? "unknown"
  };
}

async function fetchWholeFile(
  doFetch: typeof fetch,
  token: string,
  fileKey: string
): Promise<{
  nodes: FigmaNodePayload[];
  fileName: string;
  version: string;
  styles: FigmaStyleTable;
}> {
  const response = await figmaRequest<FigmaFileResponse>(
    doFetch,
    token,
    `/files/${fileKey}?geometry=paths`
  );

  // Import the frames on the first page rather than the whole document: a document root
  // holds every page, which is never what someone means by "import this design".
  const firstPage = response.document?.children?.[0];
  const nodes = firstPage?.children?.length ? firstPage.children : firstPage ? [firstPage] : [];

  return {
    nodes,
    styles: response.styles ?? {},
    fileName: response.name ?? fileKey,
    version: response.version ?? response.lastModified ?? "unknown"
  };
}

async function fetchImageFills(
  doFetch: typeof fetch,
  token: string,
  fileKey: string
): Promise<FigmaImagePayload[]> {
  try {
    const response = await figmaRequest<FigmaImageFillsResponse>(
      doFetch,
      token,
      `/files/${fileKey}/images`
    );

    return Object.entries(response.meta?.images ?? {}).map(([imageRef, source]) => ({
      imageRef,
      source
    }));
  } catch {
    // Image fills are best-effort: the mapper already warns per unresolved fill, and a
    // missing image endpoint must not fail the whole import.
    return [];
  }
}

async function figmaRequest<T>(doFetch: typeof fetch, token: string, path: string): Promise<T> {
  const response = await doFetch(`${FIGMA_API_BASE}${path}`, {
    headers: {
      "X-Figma-Token": token
    }
  });

  if (response.status === 403 || response.status === 401) {
    throw new FigmaRestError(
      "Figma rejected the personal access token. Check the token in the active profile and that it has file_read scope.",
      response.status
    );
  }

  if (response.status === 404) {
    throw new FigmaRestError("Figma could not find that file. Check the file key.", 404);
  }

  if (response.status === 429) {
    throw new FigmaRestError("Figma rate limit reached. Retry in a minute.", 429);
  }

  if (!response.ok) {
    throw new FigmaRestError(`Figma request failed with ${response.status}.`, response.status);
  }

  return (await response.json()) as T;
}
