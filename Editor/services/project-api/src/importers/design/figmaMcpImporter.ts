import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type DesignImportReport,
  type FigmaDesignImportSource,
  type NormalizedDesignDocument,
  type NormalizedDesignNode,
  type NormalizedDesignPage
} from "@grapix/shared-types";
import { addDesignImportIssue } from "./importReport.js";

const DEFAULT_FIGMA_MCP_ENDPOINT = "http://127.0.0.1:3845/mcp";

type McpContent = {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
};

type McpToolResult = {
  content?: McpContent[];
  isError?: boolean;
};

export interface FigmaMcpCapture {
  nodeId: string;
  name: string;
  metadata: string;
  imageBase64: string;
  mimeType: string;
  /** The frame's own size. This is the scene size; it never includes the frame position. */
  width: number;
  height: number;
  /** The frame's position on its Figma page, retained as provenance only. */
  absoluteX?: number;
  absoluteY?: number;
}

export async function importFigmaMcpDocument(
  source: FigmaDesignImportSource,
  report: DesignImportReport
): Promise<NormalizedDesignDocument> {
  if (!source.url.trim()) throw new Error("A Figma Dev Mode link is required.");
  const endpoint = resolveFigmaMcpEndpoint();
  const client = new Client({ name: "grapix-figma-import", version: "0.1.0" });

  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    const availableTools = new Set((await client.listTools()).tools.map((tool) => tool.name));
    for (const required of ["get_metadata", "get_screenshot"]) {
      if (!availableTools.has(required)) {
        throw new Error(`Figma MCP server does not provide ${required}. Update Figma Desktop and re-enable its MCP server.`);
      }
    }

    let nodeIds = parseFigmaMcpNodeIds(source);
    if (!nodeIds.length) {
      const discovery = await callFigmaTool(client, "get_metadata", {});
      nodeIds = selectedNodeIds(discovery);
    }
    if (!nodeIds.length) {
      throw new Error(
        "The link has no node-id and Figma MCP reported no selected node. Select a frame in Figma Desktop or paste a Dev Mode link containing node-id."
      );
    }

    const captures: FigmaMcpCapture[] = [];
    for (const nodeId of nodeIds) {
      const metadataResult = await callFigmaTool(client, "get_metadata", { nodeId });
      const screenshotResult = await callFigmaTool(client, "get_screenshot", {
        nodeId,
        contentsOnly: true
      });
      captures.push(captureFromResults(nodeId, metadataResult, screenshotResult));
    }

    return documentFromFigmaMcpCaptures(source, captures, report, endpoint.toString());
  } catch (error) {
    if (isConnectionFailure(error)) {
      throw new Error(
        `Figma Desktop MCP is not reachable at ${endpoint.toString()}. Open the file in Figma Desktop, switch to Dev Mode, and enable the desktop MCP server.`
      );
    }
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function parseFigmaMcpNodeIds(source: FigmaDesignImportSource): string[] {
  const explicit = (source.nodeIds ?? []).map(normalizeNodeId).filter(Boolean);
  if (explicit.length) return [...new Set(explicit)];

  const input = source.url.trim();
  if (/^\d+[:-]\d+$/.test(input)) return [normalizeNodeId(input)];
  try {
    const url = new URL(input);
    const nodeId = url.searchParams.get("node-id");
    return nodeId ? [normalizeNodeId(nodeId)] : [];
  } catch {
    return [];
  }
}

export function documentFromFigmaMcpCaptures(
  source: FigmaDesignImportSource,
  captures: FigmaMcpCapture[],
  report: DesignImportReport,
  endpoint = DEFAULT_FIGMA_MCP_ENDPOINT
): NormalizedDesignDocument {
  if (!captures.length) throw new Error("Figma MCP returned no nodes to import.");
  const pages = captures.map((capture) => pageFromCapture(capture, report));
  const fileKey = parseFigmaFileKey(source.url);
  const sourceName = captures.length === 1
    ? captures[0].name
    : `Figma MCP selection (${captures.length} nodes)`;

  return {
    schemaVersion: 1,
    sourceFormat: "figma-mcp",
    sourceName,
    sourceId: fileKey,
    colorSpace: "sRGB",
    width: pages[0].width,
    height: pages[0].height,
    pages,
    assets: captures.map((capture) => ({
      id: assetId(capture.nodeId),
      name: `${capture.name}.png`,
      kind: "image",
      mimeType: capture.mimeType,
      dataBase64: capture.imageBase64,
      linked: false,
      width: capture.width,
      height: capture.height
    })),
    fonts: [],
    components: {},
    variables: {},
    sourceMetadata: {
      transport: "figma-desktop-mcp",
      endpoint,
      nodeIds: captures.map((capture) => capture.nodeId),
      fidelity: "pixel-accurate-raster-selection"
    }
  };
}

function pageFromCapture(capture: FigmaMcpCapture, report: DesignImportReport): NormalizedDesignPage {
  const node: NormalizedDesignNode = {
    id: `figma-mcp-${safeId(capture.nodeId)}`,
    sourceId: capture.nodeId,
    name: capture.name,
    type: "image",
    x: 0,
    y: 0,
    width: capture.width,
    height: capture.height,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    anchor: { x: 0, y: 0 },
    opacity: 1,
    visible: true,
    locked: false,
    blendMode: "normal",
    fills: [{ type: "none" }],
    strokes: [{ type: "none" }],
    strokeWidth: 0,
    assetId: assetId(capture.nodeId),
    masks: [],
    effects: [],
    children: [],
    sourceData: {
      transport: "figma-desktop-mcp",
      metadata: capture.metadata,
      // Where the frame sat on its Figma page. The node itself is at the scene origin.
      pagePosition: { x: capture.absoluteX ?? 0, y: capture.absoluteY ?? 0 }
    }
  };

  addDesignImportIssue(report, {
    kind: "rasterized",
    severity: "warning",
    message: `${capture.name} was imported as the screenshot returned by Figma MCP; MCP does not expose the REST document JSON required for editable layer conversion.`,
    sourceNodeId: capture.nodeId,
    sourceNodeName: capture.name,
    fallback: "Figma MCP screenshot"
  });

  // The selected frame IS the scene: it is placed at the origin above, and the canvas is
  // its own width/height. Its page position never contributes to either.
  return {
    id: `figma-mcp-page-${safeId(capture.nodeId)}`,
    name: capture.name,
    width: capture.width,
    height: capture.height,
    background: { type: "solid", color: "#00000000" },
    nodes: [node]
  };
}

async function callFigmaTool(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<McpToolResult> {
  const result = await client.callTool({ name, arguments: args }) as McpToolResult;
  if (result.isError) {
    const detail = textContent(result) || `${name} failed`;
    throw new Error(`Figma MCP ${name} failed: ${detail}`);
  }
  return result;
}

function captureFromResults(
  requestedNodeId: string,
  metadataResult: McpToolResult,
  screenshotResult: McpToolResult
): FigmaMcpCapture {
  const metadata = textContent(metadataResult);
  const root = rootMetadata(metadata);
  if (root.id && normalizeNodeId(root.id) !== normalizeNodeId(requestedNodeId)) {
    throw new Error(`Figma MCP returned node ${root.id} while ${requestedNodeId} was requested.`);
  }
  const image = screenshotResult.content?.find((item) => item.type === "image" && item.data);
  if (!image?.data) throw new Error(`Figma MCP returned no screenshot for node ${requestedNodeId}.`);
  const mimeType = image.mimeType ?? "image/png";
  const pixelSize = mimeType === "image/png" ? pngDimensions(image.data) : null;
  // The frame's own declared size is the scene size. `x`/`y` are the frame's position
  // on its Figma page and must never reach a dimension: a frame at y = 4875 is still
  // 1080 high. They are kept only as source metadata.
  const width = positive(root.width) ?? pixelSize?.width;
  const height = positive(root.height) ?? pixelSize?.height;
  if (!width || !height) throw new Error(`Figma MCP returned no usable dimensions for node ${requestedNodeId}.`);

  return {
    nodeId: normalizeNodeId(root.id || requestedNodeId),
    name: root.name || `Figma ${requestedNodeId}`,
    metadata,
    imageBase64: image.data,
    mimeType,
    width,
    height,
    absoluteX: Number(root.x) || 0,
    absoluteY: Number(root.y) || 0
  };
}

/**
 * Attributes of the selected frame in a `get_metadata` document.
 *
 * Prefer the first element that declares both a width and a height: the response can
 * open with a wrapper (`<page id="0:1">`) that carries neither, and falling back to
 * the screenshot's pixel size then silently adopts its scale factor as the canvas.
 */
function rootMetadata(metadata: string): Record<string, string> {
  const elements = [...metadata.matchAll(/<[\w-]+\s+([^>]*\bid="[^"]+"[^>]*)>/g)]
    .map((match) => {
      const attributes: Record<string, string> = {};
      for (const attribute of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) {
        attributes[attribute[1]] = decodeXml(attribute[2]);
      }
      return attributes;
    });
  return elements.find((element) => positive(element.width) && positive(element.height)) ?? elements[0] ?? {};
}

function selectedNodeIds(result: McpToolResult): string[] {
  const firstText = result.content?.find((item) => item.type === "text")?.text ?? "";
  const values = [...firstText.matchAll(/^\s*-\s+(\d+[:-]\d+)(?::|\s|$)/gm)]
    .map((match) => normalizeNodeId(match[1]));
  return [...new Set(values)];
}

function textContent(result: McpToolResult): string {
  return (result.content ?? [])
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function resolveFigmaMcpEndpoint(): URL {
  const endpoint = new URL(process.env.GRAPIX_FIGMA_MCP_URL?.trim() || DEFAULT_FIGMA_MCP_ENDPOINT);
  const loopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost" || endpoint.hostname === "[::1]";
  if (endpoint.protocol !== "http:" || !loopback) {
    throw new Error("GRAPIX_FIGMA_MCP_URL must be an HTTP loopback URL; remote custom clients are not supported by Figma MCP.");
  }
  return endpoint;
}

function parseFigmaFileKey(input: string): string {
  const match = /figma\.com\/(?:design|file|proto|board)\/([^/?#]+)/i.exec(input.trim());
  return (match?.[1] ?? "").replace(/[^a-zA-Z0-9_-]/g, "");
}

function normalizeNodeId(value: string): string {
  const match = /^(\d+)[:-](\d+)$/.exec(value.trim());
  return match ? `${match[1]}:${match[2]}` : "";
}

function pngDimensions(base64: string): { width: number; height: number } | null {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < 24 || bytes.subarray(1, 4).toString("ascii") !== "PNG") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function positive(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function assetId(nodeId: string): string {
  return `figma-mcp-image-${safeId(nodeId)}`;
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function isConnectionFailure(error: unknown): boolean {
  const value = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /ECONNREFUSED|fetch failed|connection|connect/i.test(value);
}
