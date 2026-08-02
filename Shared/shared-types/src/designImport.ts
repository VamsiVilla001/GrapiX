import type {
  BezierPath,
  ColorValue,
  MaskMode,
  MaterialBlendMode,
  SceneDocument,
  Vec2
} from "./index.js";

export type DesignSourceFormat = "psd" | "ai" | "svg" | "figma-json" | "figma-mcp";

export interface DesignImportOptions {
  preserveHierarchy: boolean;
  keepTextEditable: boolean;
  importHiddenLayers: boolean;
  assetMode: "embed" | "link";
  convertComponents: boolean;
  missingFontPolicy: "preserve-name" | "replace";
  replacementFontFamily: string;
  unsupportedFeaturePolicy: "closest-editable" | "nested-composition" | "rasterize-layer";
  scale: number;
  targetWidth?: number;
  targetHeight?: number;
  selectedPageIds?: string[];
  selectedNodeIds?: string[];
}

export interface NormalizedDesignAsset {
  id: string;
  name: string;
  kind: "image" | "video" | "svg" | "source" | "unknown";
  mimeType: string;
  dataBase64?: string;
  sourceUrl?: string;
  linked?: boolean;
  width?: number;
  height?: number;
  /**
   * SHA-256 of the stored bytes, set once the asset is in the project store. The render
   * engine registers assets by checksum and refuses one without it, so an asset that
   * never reaches storage cannot go on air.
   */
  checksum?: string;
  sizeBytes?: number;
}

export interface NormalizedDesignFont {
  family: string;
  style?: string;
  weight?: number;
  sourceName?: string;
}

export interface NormalizedDesignEffect {
  type:
    | "drop-shadow"
    | "inner-shadow"
    | "outer-glow"
    | "inner-glow"
    | "bevel-emboss"
    | "satin"
    | "color-overlay"
    | "gradient-overlay"
    | "pattern-overlay"
    | "stroke"
    | "layer-blur"
    | "background-blur"
    | "unknown";
  enabled: boolean;
  opacity?: number;
  color?: string;
  offset?: Vec2;
  radius?: number;
  spread?: number;
  angle?: number;
  blendMode?: MaterialBlendMode;
  paint?: ColorValue;
  sourceData?: Record<string, unknown>;
}

export interface NormalizedDesignMask {
  id: string;
  name: string;
  path: BezierPath;
  mode: MaskMode;
  inverted: boolean;
  opacity: number;
  feather: Vec2;
  expansion: number;
  alphaAssetId?: string;
}

export interface NormalizedDesignText {
  characters: string;
  fontFamily: string;
  fontStyle?: "normal" | "italic";
  fontWeight: "400" | "500" | "600" | "700" | "800";
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  paragraphSpacing: number;
  align: "left" | "center" | "right";
  verticalAlign?: "top" | "middle" | "bottom";
  writingMode?: "horizontal-tb" | "vertical-rl" | "vertical-lr";
  textLayout: "point" | "paragraph";
  direction?: "ltr" | "rtl";
}

export type NormalizedDesignNodeType =
  | "group"
  | "artboard"
  | "frame"
  | "component"
  | "component-set"
  | "instance"
  | "text"
  | "rectangle"
  | "ellipse"
  | "line"
  | "path"
  | "image"
  | "video"
  | "adjustment"
  | "smart-object"
  | "unsupported";

export interface NormalizedDesignLayout {
  mode?: "none" | "horizontal" | "vertical";
  primaryAxisSizing?: "fixed" | "hug" | "fill";
  counterAxisSizing?: "fixed" | "hug" | "fill";
  gap?: number;
  padding?: { top: number; right: number; bottom: number; left: number };
  constraints?: { horizontal?: string; vertical?: string };
  layoutGrids?: Array<Record<string, unknown>>;
}

export interface NormalizedDesignNode {
  id: string;
  sourceId?: string;
  name: string;
  type: NormalizedDesignNodeType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  anchor: Vec2;
  opacity: number;
  fillOpacity?: number;
  visible: boolean;
  locked: boolean;
  blendMode: MaterialBlendMode;
  fills: ColorValue[];
  strokes: ColorValue[];
  strokeWidth: number;
  cornerRadius?: number;
  independentCorners?: [number, number, number, number];
  path?: BezierPath;
  compoundPaths?: BezierPath[];
  text?: NormalizedDesignText;
  assetId?: string;
  masks: NormalizedDesignMask[];
  effects: NormalizedDesignEffect[];
  children: NormalizedDesignNode[];
  layout?: NormalizedDesignLayout;
  componentId?: string;
  componentProperties?: Record<string, unknown>;
  sourceData?: Record<string, unknown>;
}

export interface NormalizedDesignPage {
  id: string;
  name: string;
  width: number;
  height: number;
  background: ColorValue;
  nodes: NormalizedDesignNode[];
  guides?: Array<{ orientation: "horizontal" | "vertical"; position: number }>;
}

export interface NormalizedDesignDocument {
  schemaVersion: 1;
  sourceFormat: DesignSourceFormat;
  sourceName: string;
  sourceId?: string;
  colorSpace?: string;
  width: number;
  height: number;
  pages: NormalizedDesignPage[];
  assets: NormalizedDesignAsset[];
  fonts: NormalizedDesignFont[];
  components: Record<string, { name: string; nodeId: string }>;
  variables: Record<string, unknown>;
  sourceMetadata: Record<string, unknown>;
}

export type DesignImportIssueKind =
  | "converted"
  | "missing-font"
  | "missing-asset"
  | "unsupported-effect"
  | "rasterized"
  | "visual-difference"
  | "warning"
  | "error";

export interface DesignImportIssue {
  id: string;
  kind: DesignImportIssueKind;
  severity: "info" | "warning" | "error";
  message: string;
  sourceNodeId?: string;
  sourceNodeName?: string;
  fallback?: string;
}

export interface DesignImportReport {
  sourceFormat: DesignSourceFormat;
  sourceName: string;
  startedAt: string;
  completedAt: string;
  importedItems: number;
  convertedProperties: number;
  missingFonts: string[];
  missingLinkedAssets: string[];
  unsupportedEffects: string[];
  rasterizedObjects: string[];
  visualDifferences: string[];
  errors: string[];
  warnings: string[];
  issues: DesignImportIssue[];
}

export interface DesignImportResult {
  document: NormalizedDesignDocument;
  scenes: SceneDocument[];
  report: DesignImportReport;
}

export interface FigmaDesignImportSource {
  /** Figma design/Dev Mode/proto/board link, or a bare file key. */
  url: string;
  /** Optional API-form node IDs (for example 123:456). Added to any in the link. */
  nodeIds?: string[];
  /**
   * Which Figma transport to use.
   *
   * - `rest` — the REST API, the only route that returns native document JSON, so
   *   the only one that yields editable layers. Requires a token.
   * - `desktop-mcp` — the local Figma Desktop MCP server. No token, but it exposes
   *   only sparse XML and a rendered screenshot, so the node arrives rasterized.
   * - `auto` (default) — REST when a token is available, Desktop MCP otherwise.
   */
  transport?: "auto" | "rest" | "desktop-mcp";
  /**
   * Figma token for the REST route, used for this request only: it is never stored
   * in the project, the scene, or the import report. Falls back to
   * `FIGMA_ACCESS_TOKEN`/`FIGMA_TOKEN` in the project service environment.
   */
  accessToken?: string;
  /** Defaults to `personal` for `figd_…` tokens and `oauth` for anything else. */
  tokenKind?: "personal" | "oauth";
}

export const DEFAULT_DESIGN_IMPORT_OPTIONS: DesignImportOptions = {
  preserveHierarchy: true,
  keepTextEditable: true,
  importHiddenLayers: false,
  assetMode: "embed",
  convertComponents: true,
  missingFontPolicy: "preserve-name",
  replacementFontFamily: "Inter",
  unsupportedFeaturePolicy: "closest-editable",
  scale: 1
};
