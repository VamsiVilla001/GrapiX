/**
 * GrapiX Figma plugin — sandbox half.
 *
 * Serialises the selection into the same FigmaImportPayload the REST fallback produces,
 * but filled in with fidelity the REST API cannot give us: source vector paths and real
 * per-run text styling from getStyledTextSegments.
 *
 * The sandbox cannot make network requests, so the payload is posted to the UI iframe,
 * which sends it to the local GrapiX API. See docs/middle-layer-arch.md section 5.1.
 */

const PLUGIN_VERSION = "0.1.0";

interface SerializedPaint {
  type?: string;
  visible?: boolean;
  opacity?: number;
  blendMode?: string;
  color?: { r: number; g: number; b: number; a?: number };
  gradientStops?: Array<{ position: number; color: { r: number; g: number; b: number; a?: number } }>;
  gradientHandlePositions?: Array<{ x: number; y: number }>;
  imageRef?: string;
  scaleMode?: string;
  pluginGradientTransform?: [[number, number, number], [number, number, number]];
}

interface SerializedNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  locked?: boolean;
  opacity?: number;
  blendMode?: string;
  clipsContent?: boolean;
  isMask?: boolean;
  relativeTransform?: [[number, number, number], [number, number, number]];
  size?: { x: number; y: number };
  fills?: SerializedPaint[];
  strokes?: SerializedPaint[];
  strokeWeight?: number;
  strokeAlign?: string;
  strokeCap?: string;
  strokeJoin?: string;
  strokeDashes?: number[];
  effects?: unknown[];
  cornerRadius?: number;
  rectangleCornerRadii?: [number, number, number, number];
  cornerSmoothing?: number;
  characters?: string;
  style?: Record<string, unknown>;
  pluginVectorPaths?: Array<{ data: string; windingRule?: string }>;
  pluginTextSegments?: unknown[];
  children?: SerializedNode[];
}

/** Image hashes discovered while walking, resolved to data URIs before sending. */
const imageHashes = new Set<string>();

figma.showUI(__html__, { width: 380, height: 460 });

figma.ui.onmessage = async (message: { type?: string; apiBaseUrl?: string }) => {
  if (message?.type === "request-selection-info") {
    figma.ui.postMessage({
      type: "selection-info",
      count: figma.currentPage.selection.length,
      names: figma.currentPage.selection.map((node) => node.name),
      fileName: figma.root.name
    });

    return;
  }

  if (message?.type !== "export") {
    return;
  }

  try {
    imageHashes.clear();

    const roots = figma.currentPage.selection.length
      ? [...figma.currentPage.selection]
      : [...figma.currentPage.children];

    if (!roots.length) {
      figma.ui.postMessage({
        type: "error",
        message: "Nothing to export. Select at least one frame."
      });

      return;
    }

    const nodes: SerializedNode[] = [];

    for (const root of roots) {
      nodes.push(await serializeNode(root));
    }

    const images = await resolveImages();

    figma.ui.postMessage({
      type: "payload",
      payload: {
        origin: "plugin",
        fileKey: figma.fileKey ?? "local",
        fileName: figma.root.name,
        // Figma does not expose a file version to plugins, so the payload carries its own
        // revision marker. Node ids still carry identity, which is what re-import needs.
        version: `plugin-${Date.now()}`,
        clientVersion: PLUGIN_VERSION,
        nodes,
        images
      }
    });
  } catch (error) {
    figma.ui.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Export failed."
    });
  }
};

async function serializeNode(node: SceneNode | PageNode): Promise<SerializedNode> {
  const serialized: SerializedNode = {
    id: node.id,
    name: node.name,
    type: node.type
  };

  if ("visible" in node) {
    serialized.visible = node.visible;
  }

  if ("locked" in node) {
    serialized.locked = node.locked;
  }

  if ("opacity" in node) {
    serialized.opacity = node.opacity;
  }

  if ("blendMode" in node) {
    serialized.blendMode = node.blendMode;
  }

  if ("clipsContent" in node) {
    serialized.clipsContent = node.clipsContent;
  }

  if ("isMask" in node) {
    serialized.isMask = node.isMask;
  }

  if ("relativeTransform" in node) {
    const transform = node.relativeTransform;
    serialized.relativeTransform = [
      [transform[0][0], transform[0][1], transform[0][2]],
      [transform[1][0], transform[1][1], transform[1][2]]
    ];
  }

  if ("width" in node && "height" in node) {
    serialized.size = { x: node.width, y: node.height };
  }

  if ("fills" in node) {
    serialized.fills = serializePaints(node.fills);
  }

  if ("strokes" in node) {
    serialized.strokes = serializePaints(node.strokes);
  }

  if ("strokeWeight" in node && typeof node.strokeWeight === "number") {
    serialized.strokeWeight = node.strokeWeight;
  }

  if ("strokeAlign" in node) {
    serialized.strokeAlign = node.strokeAlign;
  }

  if ("strokeCap" in node && typeof node.strokeCap === "string") {
    serialized.strokeCap = node.strokeCap;
  }

  if ("strokeJoin" in node && typeof node.strokeJoin === "string") {
    serialized.strokeJoin = node.strokeJoin;
  }

  if ("dashPattern" in node) {
    serialized.strokeDashes = [...node.dashPattern];
  }

  if ("effects" in node) {
    serialized.effects = JSON.parse(JSON.stringify(node.effects)) as unknown[];
  }

  serializeCorners(node, serialized);

  // Source vector paths, which the REST API never returns.
  if ("vectorPaths" in node && node.vectorPaths) {
    serialized.pluginVectorPaths = node.vectorPaths.map((path) => ({
      data: path.data,
      windingRule: path.windingRule
    }));
  }

  if (node.type === "TEXT") {
    await serializeText(node, serialized);
  }

  if ("children" in node) {
    serialized.children = [];

    for (const child of node.children) {
      serialized.children.push(await serializeNode(child));
    }
  }

  return serialized;
}

function serializeCorners(node: SceneNode | PageNode, serialized: SerializedNode): void {
  if ("cornerRadius" in node && typeof node.cornerRadius === "number") {
    serialized.cornerRadius = node.cornerRadius;
  }

  if (
    "topLeftRadius" in node &&
    typeof node.topLeftRadius === "number" &&
    typeof node.topRightRadius === "number" &&
    typeof node.bottomRightRadius === "number" &&
    typeof node.bottomLeftRadius === "number"
  ) {
    serialized.rectangleCornerRadii = [
      node.topLeftRadius,
      node.topRightRadius,
      node.bottomRightRadius,
      node.bottomLeftRadius
    ];
  }

  if ("cornerSmoothing" in node && typeof node.cornerSmoothing === "number") {
    serialized.cornerSmoothing = node.cornerSmoothing;
  }
}

async function serializeText(node: TextNode, serialized: SerializedNode): Promise<void> {
  serialized.characters = node.characters;

  serialized.style = {
    textAlignHorizontal: node.textAlignHorizontal,
    textAlignVertical: node.textAlignVertical,
    textAutoResize: node.textAutoResize,
    paragraphSpacing: node.paragraphSpacing
  };

  const segments = node.getStyledTextSegments([
    "fontName",
    "fontSize",
    "fontWeight",
    "letterSpacing",
    "lineHeight",
    "textCase",
    "textDecoration",
    "fills"
  ]);

  serialized.pluginTextSegments = segments.map((segment) => ({
    characters: segment.characters,
    fontFamily: segment.fontName.family,
    fontStyle: segment.fontName.style,
    fontWeight: segment.fontWeight,
    fontSize: segment.fontSize,
    // Percent tracking is relative to the size; DesignIR stores absolute pixels.
    letterSpacing:
      segment.letterSpacing.unit === "PERCENT"
        ? (segment.letterSpacing.value / 100) * segment.fontSize
        : segment.letterSpacing.value,
    lineHeight: segment.lineHeight.unit === "AUTO" ? "auto" : segment.lineHeight.value,
    textCase: segment.textCase,
    textDecoration: segment.textDecoration,
    fills: serializePaints(segment.fills)
  }));
}

function serializePaints(paints: readonly Paint[] | typeof figma.mixed): SerializedPaint[] {
  // Only the figma.mixed check belongs here: Array.isArray widens `readonly Paint[]` to
  // `any[]` and loses the paint union.
  if (paints === figma.mixed) {
    return [];
  }

  return paints.map((paint) => {
    const serialized: SerializedPaint = {
      type: paint.type,
      visible: paint.visible,
      opacity: paint.opacity,
      blendMode: paint.blendMode
    };

    if (paint.type === "SOLID") {
      serialized.color = { ...paint.color, a: paint.opacity ?? 1 };
    }

    if (
      paint.type === "GRADIENT_LINEAR" ||
      paint.type === "GRADIENT_RADIAL" ||
      paint.type === "GRADIENT_ANGULAR" ||
      paint.type === "GRADIENT_DIAMOND"
    ) {
      serialized.gradientStops = paint.gradientStops.map((stop) => ({
        position: stop.position,
        color: stop.color
      }));
      const gradient = paint.gradientTransform;
      serialized.pluginGradientTransform = [
        [gradient[0][0], gradient[0][1], gradient[0][2]],
        [gradient[1][0], gradient[1][1], gradient[1][2]]
      ];
    }

    if (paint.type === "IMAGE" && paint.imageHash) {
      serialized.imageRef = paint.imageHash;
      serialized.scaleMode = paint.scaleMode;
      imageHashes.add(paint.imageHash);
    }

    return serialized;
  });
}

async function resolveImages(): Promise<
  Array<{ imageRef: string; source: string; mimeType?: string; width?: number; height?: number }>
> {
  const resolved: Array<{
    imageRef: string;
    source: string;
    mimeType?: string;
    width?: number;
    height?: number;
  }> = [];

  for (const hash of imageHashes) {
    try {
      const image = figma.getImageByHash(hash);

      if (!image) {
        continue;
      }

      const bytes = await image.getBytesAsync();
      const size = await image.getSizeAsync();

      resolved.push({
        imageRef: hash,
        source: `data:image/png;base64,${bytesToBase64(bytes)}`,
        mimeType: "image/png",
        width: size.width,
        height: size.height
      });
    } catch {
      // The mapper already warns per unresolved image fill; one bad asset must not fail
      // the whole export.
    }
  }

  return resolved;
}

/** The plugin sandbox has no Buffer and no btoa on binary, so encode by hand. */
function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";

  for (let index = 0; index < bytes.length; index += 3) {
    const byte1 = bytes[index];
    const byte2 = bytes[index + 1];
    const byte3 = bytes[index + 2];

    output += alphabet[byte1 >> 2];
    output += alphabet[((byte1 & 3) << 4) | ((byte2 ?? 0) >> 4)];
    output += byte2 === undefined ? "=" : alphabet[((byte2 & 15) << 2) | ((byte3 ?? 0) >> 6)];
    output += byte3 === undefined ? "=" : alphabet[byte3 & 63];
  }

  return output;
}
