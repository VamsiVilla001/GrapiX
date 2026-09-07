/**
 * The one payload shape both Figma front-ends emit.
 *
 * The REST fallback (`figma-rest.ts`) fills the base fields that `/v1/files/:key/nodes`
 * returns. The plugin (`apps/figma-plugin`) fills the same base fields *plus* the
 * `plugin*` fields, which carry fidelity the REST API does not expose: source vector
 * paths and real per-run text styling.
 *
 * Keeping one shape means one mapper, so the two front-ends cannot drift.
 */

export type FigmaPayloadOrigin = "plugin" | "rest";

export interface FigmaColor {
  r: number;
  g: number;
  b: number;
  a?: number;
}

export interface FigmaGradientStop {
  position: number;
  color: FigmaColor;
}

export interface FigmaPaint {
  type?: string;
  visible?: boolean;
  opacity?: number;
  blendMode?: string;
  color?: FigmaColor;
  gradientStops?: FigmaGradientStop[];
  gradientHandlePositions?: Array<{ x: number; y: number }>;
  imageRef?: string;
  scaleMode?: string;
  /**
   * Plugin-only: the gradient's affine transform, as [[a, c, e], [b, d, f]].
   * The plugin API exposes this directly, where REST only gives handle positions.
   */
  pluginGradientTransform?: [[number, number, number], [number, number, number]];
}

export interface FigmaEffect {
  type?: string;
  visible?: boolean;
  radius?: number;
  spread?: number;
  offset?: { x: number; y: number };
  color?: FigmaColor;
  blendMode?: string;
}

export interface FigmaTypeStyle {
  fontFamily?: string;
  fontPostScriptName?: string | null;
  fontWeight?: number;
  fontSize?: number;
  letterSpacing?: number;
  lineHeightPx?: number;
  lineHeightPercent?: number;
  textAlignHorizontal?: string;
  textAlignVertical?: string;
  textAutoResize?: string;
  textCase?: string;
  textDecoration?: string;
  paragraphSpacing?: number;
  italic?: boolean;
  fills?: FigmaPaint[];
}

/** Plugin-only: one styled text segment, straight from getStyledTextSegments(). */
export interface FigmaTextSegment {
  characters: string;
  fontFamily: string;
  fontStyle: string;
  fontWeight: number;
  fontSize: number;
  letterSpacing: number;
  lineHeight: number | "auto";
  textCase: string;
  textDecoration: string;
  fills: FigmaPaint[];
}

/** Plugin-only: the node's source vector geometry. */
export interface FigmaVectorPath {
  data: string;
  windingRule?: string;
}

export interface FigmaNodePayload {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  locked?: boolean;
  opacity?: number;
  blendMode?: string;
  clipsContent?: boolean;
  isMask?: boolean;

  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  /** [[a, c, e], [b, d, f]] — Figma's own row layout, in both REST and the plugin API. */
  relativeTransform?: [[number, number, number], [number, number, number]];
  size?: { x: number; y: number };
  width?: number;
  height?: number;

  fills?: FigmaPaint[];
  strokes?: FigmaPaint[];
  strokeWeight?: number;
  strokeAlign?: string;
  strokeCap?: string;
  strokeJoin?: string;
  strokeDashes?: number[];
  effects?: FigmaEffect[];

  cornerRadius?: number;
  rectangleCornerRadii?: [number, number, number, number];
  cornerSmoothing?: number;

  /** Auto-layout. Same field names in both the REST response and the plugin API. */
  layoutMode?: string;
  primaryAxisAlignItems?: string;
  counterAxisAlignItems?: string;
  primaryAxisSizingMode?: string;
  counterAxisSizingMode?: string;
  itemSpacing?: number;
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  layoutAlign?: string;
  layoutGrow?: number;

  constraints?: { horizontal?: string; vertical?: string };

  /** Component identity. REST exposes componentId; the plugin resolves the main component. */
  componentId?: string;
  pluginComponentName?: string;

  /** REST: outlined geometry. Present only when queried with geometry=paths. */
  fillGeometry?: FigmaVectorPath[];
  strokeGeometry?: FigmaVectorPath[];

  characters?: string;
  style?: FigmaTypeStyle;
  /** REST: per-character style override ids, indexed into styleOverrideTable. */
  characterStyleOverrides?: number[];
  styleOverrideTable?: Record<string, FigmaTypeStyle>;

  /** Plugin-only fidelity. */
  pluginVectorPaths?: FigmaVectorPath[];
  pluginTextSegments?: FigmaTextSegment[];

  children?: FigmaNodePayload[];
}

export interface FigmaImagePayload {
  imageRef: string;
  /** Data URI from the plugin, or a signed S3 URL from the REST image endpoint. */
  source: string;
  mimeType?: string;
  width?: number;
  height?: number;
}

export interface FigmaImportPayload {
  origin: FigmaPayloadOrigin;
  fileKey: string;
  fileName: string;
  /** Figma file version, or the plugin's own revision marker. */
  version: string;
  /** The selected roots. One import can bring in several artboards. */
  nodes: FigmaNodePayload[];
  images?: FigmaImagePayload[];
  /** Plugin build id, so a DesignIR records which front-end produced it. */
  clientVersion?: string;
}

export interface ParsedFigmaUrl {
  fileKey: string;
  nodeIds: string[];
}

/**
 * Pulls the file key and any node id out of a Figma URL.
 *
 * Accepts /file/, /design/ and /proto/ forms, and the `node-id` query parameter in both
 * its `1-2` and legacy `1:2` spellings. A bare file key is passed through unchanged.
 */
export function parseFigmaUrl(input: string): ParsedFigmaUrl | null {
  const trimmed = input.trim();

  if (!trimmed) {
    return null;
  }

  if (/^[A-Za-z0-9]{10,}$/.test(trimmed)) {
    return { fileKey: trimmed, nodeIds: [] };
  }

  const keyMatch = /\/(?:file|design|proto)\/([A-Za-z0-9]+)/.exec(trimmed);

  if (!keyMatch) {
    return null;
  }

  const nodeIds: string[] = [];
  const nodeMatch = /[?&]node-id=([^&]+)/.exec(trimmed);

  if (nodeMatch) {
    // Figma writes `1-2` in URLs but the API wants `1:2`.
    nodeIds.push(decodeURIComponent(nodeMatch[1]).replace(/-/g, ":"));
  }

  return { fileKey: keyMatch[1], nodeIds };
}
