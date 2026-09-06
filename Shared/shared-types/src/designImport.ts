import type {
  FigmaMotionImportMode,
  FigmaMotionImportReport,
  FigmaMotionManifest
} from "./figmaMotion.js";
import type {
  BezierPath,
  ColorValue,
  EffectBlendIfChannel,
  EffectContour,
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
  /**
   * How a node that GrapiX cannot reproduce exactly is handled: retain its closest editable
   * representation and metadata, retain an unsupported subtree as a nested group, or request
   * source-rendered fallback pixels. Every non-exact result is recorded in the import report.
   */
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
  /**
   * Project-relative path of the stored file, e.g. `images/player-stats/player-photo.png`.
   *
   * Set for images a design placed. It is the path the scene refers to, and the reason no expiring
   * source URL survives an import: the bytes are in the project, under a name a person can read,
   * and every consumer resolves the same path.
   */
  projectPath?: string;
}

export interface NormalizedDesignFont {
  family: string;
  style?: string;
  weight?: number;
  sourceName?: string;
}

/**
 * Layer style data normalized from a design source before it becomes an
 * `ObjectEffect`. The source effect id is optional because not every design
 * format assigns one; the scene converter assigns a stable object-local id.
 */
export interface NormalizedDesignEffect {
  id?: string;
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
  blendMode?: MaterialBlendMode;
  sourceBlendMode?: string;
  opacity?: number;
  color?: string;
  paint?: ColorValue;
  offset?: Vec2;
  angle?: number;
  distance?: number;
  radius?: number;
  size?: number;
  spread?: number;
  choke?: number;
  noise?: number;
  antialiased?: boolean;
  contour?: EffectContour;
  useGlobalLight?: boolean;
  layerConceals?: boolean;
  technique?: "softer" | "precise";
  source?: "edge" | "center";
  range?: number;
  jitter?: number;
  style?: "outer-bevel" | "inner-bevel" | "emboss" | "pillow-emboss" | "stroke-emboss";
  bevelTechnique?: "smooth" | "chisel-hard" | "chisel-soft";
  depth?: number;
  direction?: "up" | "down";
  soften?: number;
  altitude?: number;
  highlightColor?: string;
  highlightBlendMode?: MaterialBlendMode;
  highlightSourceBlendMode?: string;
  highlightOpacity?: number;
  shadowColor?: string;
  shadowBlendMode?: MaterialBlendMode;
  shadowSourceBlendMode?: string;
  shadowOpacity?: number;
  glossContour?: EffectContour;
  antialiasGloss?: boolean;
  contourEnabled?: boolean;
  contourRange?: number;
  textureEnabled?: boolean;
  texturePatternName?: string;
  texturePatternAssetId?: string;
  textureScale?: number;
  textureDepth?: number;
  textureInvert?: boolean;
  textureLinked?: boolean;
  invert?: boolean;
  gradientStyle?: "linear" | "radial" | "angle" | "reflected" | "diamond";
  scale?: number;
  reverse?: boolean;
  dither?: boolean;
  alignWithLayer?: boolean;
  patternName?: string;
  patternAssetId?: string;
  linked?: boolean;
  position?: "outside" | "inside" | "center";
  fillType?: "color" | "gradient" | "pattern";
  overprint?: boolean;
  sourceData?: Record<string, unknown>;
}

/** Photoshop's Blending Options, normalized alongside a layer's styles. */
export interface NormalizedDesignBlendingOptions {
  fillOpacity?: number;
  knockout?: "none" | "shallow" | "deep";
  blendInteriorEffectsAsGroup?: boolean;
  blendClippedLayersAsGroup?: boolean;
  transparencyShapesLayer?: boolean;
  layerMaskHidesEffects?: boolean;
  vectorMaskHidesEffects?: boolean;
  blendIf?: EffectBlendIfChannel[];
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
  /**
   * The case the source applies when it draws, leaving the characters alone.
   *
   * Figma calls it `textCase`, CSS calls it `text-transform`, and a designer calls it either. It is
   * not baked into the characters: a layer typed "mvp" and set to UPPER reads MVP on screen and
   * "mvp" in the document, so dropping it changes what goes on air. `small-caps` needs a font
   * feature no browser text engine applies on its own, and is reported where it cannot be honoured.
   */
  textCase?: "original" | "upper" | "lower" | "title" | "small-caps";
  /** Underline and strikethrough, which are drawn rather than typed. */
  textDecoration?: { underline?: boolean; strikethrough?: boolean };
}

export type NormalizedDesignNodeType =
  | "group"
  | "artboard"
  | "frame"
  | "component"
  | "component-set"
  | "instance"
  /** A Figma section: a container that holds frames and clips them. */
  | "section"
  /** A resolved boolean operation. Its geometry is a path; its operands stay as children. */
  | "boolean-operation"
  | "text"
  | "rectangle"
  | "ellipse"
  | "line"
  | "path"
  | "image"
  | "video"
  | "adjustment"
  | "smart-object"
  /** An export marker. It has bounds and a name but nothing to render. */
  | "slice"
  /**
   * A FigJam or widget node: sticky, connector, stamp, washi tape, table, embed, code block.
   *
   * One type rather than a dozen, because GrapiX renders none of them natively and the
   * distinction that matters downstream — "this is annotation, not artwork" — is the same for
   * all of them. `sourceType` carries which one it actually was.
   */
  | "annotation"
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
  /**
   * Further image fills on the same layer, and images used as a stroke.
   *
   * A design tool stacks any number of image paints on one layer and strokes it with another;
   * GrapiX draws one image per object and its strokes are paint, not texture. The topmost fill
   * becomes the object, and these keep the rest reachable in the asset library instead of
   * discarding bytes an author asked to import.
   */
  additionalImageAssetIds?: string[];
  strokeImageAssetIds?: string[];
  masks: NormalizedDesignMask[];
  effects: NormalizedDesignEffect[];
  blendingOptions?: NormalizedDesignBlendingOptions;
  children: NormalizedDesignNode[];
  layout?: NormalizedDesignLayout;
  componentId?: string;
  componentProperties?: Record<string, unknown>;
  /**
   * The source's own type name, verbatim: `BOOLEAN_OPERATION`, `STICKY`, `smart-object`.
   *
   * Reported and preserved, never branched on for behaviour — behaviour comes from `type`, which
   * is the taxonomy every importer maps into. This exists so a report can name the thing an
   * author sees in their design tool rather than our approximation of it.
   */
  sourceType?: string;
  /**
   * The node clips its children to its own bounds.
   *
   * Figma's `clipsContent` on a frame, section, component or instance; an SVG `clipPath` on a
   * container; a Photoshop clip group. Resolved into real masks on the descendants during
   * normalization, so it survives both hierarchy-preserving and flattening imports — a clip that
   * only existed as a container property would be lost the moment the container was flattened
   * away, which is exactly how clipped artwork ends up painted across a whole canvas.
   */
  clipsContent?: boolean;
  /** Corner radii for the clip rectangle, when the clipping container has them. */
  clipCornerRadii?: [number, number, number, number];
  /**
   * This node masks its later siblings instead of being drawn itself.
   *
   * Figma's `isMask`. The node stays in the tree until normalization resolves it, because its
   * geometry — including the geometry of its own children, for a mask group — is what the mask
   * is made of.
   */
  isMask?: boolean;
  /**
   * What the mask samples.
   *
   * `vector` uses the outline, which is what GrapiX masks do. `alpha` and `luminance` sample the
   * masking layer's pixels; those are reported as an approximation rather than silently treated
   * as an outline.
   */
  maskType?: "alpha" | "vector" | "luminance";
  /** Everything the source said that this contract does not model. Provenance, never behaviour. */
  sourceData?: Record<string, unknown>;
  /**
   * An asset holding this node as the source tool draws it.
   *
   * Two uses, one meaning — "pixels of this node, rendered by the tool that owns it": a node whose
   * type GrapiX cannot draw is imported as this image rather than dropped, and an alpha or
   * luminance mask uses it as the alpha the mask samples.
   */
  renderedAssetId?: string;
  /**
   * The source tool rendered this node and the import brought in pixels.
   *
   * Set when a node's type or appearance has no GrapiX equivalent, so it is imported as an image
   * rather than dropped. The name says which tool did the rendering, because "this is a raster of
   * something Figma drew" is a different thing to an author than "this is an image the designer
   * placed" — one can be re-rendered from source, the other cannot.
   */
  flattenedFromFigma?: boolean;
  /** A container invented because the source type has no GrapiX equivalent; its children are real. */
  genericContainer?: boolean;
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

/**
 * What an import did, and everything it could not do exactly.
 *
 * The counters show whether each design layer arrived without asking an author to infer it from
 * the Inspector. Each source node that reaches conversion partitions into exactly one of `native`
 * or `genericContainers`, so `nodes = native + genericContainers`; `flattened` marks how many of
 * those nodes were additionally raster-rendered by the source tool, and masks and synthetic
 * layers describe additional composition work rather than another node outcome.
 */
export interface DesignImportCounts {
  /** Nodes that reached the scene in any form. */
  nodes: number;
  /** Nodes that became a native GrapiX object of their own kind. */
  native: number;
  /** Nodes whose type has no GrapiX equivalent and became a container so their children survive. */
  genericContainers: number;
  /** Nodes rendered by the source tool and imported as pixels. */
  flattened: number;
  /** Containers whose clip became a clip composition. */
  clippedContainers: number;
  /**
   * Layers the importer created that no source node corresponds to.
   *
   * Expressing a clip takes two: the shape that defines it, and the composition that carries it.
   * Counting them is what keeps the accounting checkable — the number of layers in the scene is
   * otherwise larger than the number of nodes the source returned, with nothing saying why.
   */
  syntheticLayers: number;
  /** Mask layers resolved into masks on the layers they mask. */
  masks: number;
  /** Assets downloaded and stored in the project's asset library. */
  assetsDownloaded: number;
  /** Assets the source named but did not deliver. */
  assetsFailed: number;
  /** Nodes the source did not return at all, by id. */
  missingNodes: string[];
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
  counts: DesignImportCounts;
}

export interface DesignImportResult {
  document: NormalizedDesignDocument;
  scenes: SceneDocument[];
  report: DesignImportReport;
  /**
   * What happened to the design's motion, when any was requested.
   *
   * Absent for a design-only import. Present and possibly empty otherwise — an empty report is
   * itself the answer to "did my prototype come across", and is not the same as no report.
   */
  motion?: FigmaMotionImportReport;
}

export interface FigmaDesignImportSource {
  /**
   * Figma design/Dev Mode/proto/board link, or a bare file key.
   *
   * Desktop MCP requires this to identify the intended file; it never falls back
   * to the active desktop selection when neither this link nor `nodeIds` targets a node.
   */
  url: string;
  /** Optional API-form node IDs (for example 123:456). Unioned with node IDs in the link; explicit IDs come first and duplicates are removed. */
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
  /**
   * How much motion to bring across. Defaults to `design-only`, so an existing caller keeps the
   * behaviour it has today and motion is something a user opts into.
   */
  motionMode?: FigmaMotionImportMode;
  /**
   * A `grapix-figma-motion.json` from the export bridge, for `full-motion-manifest`.
   *
   * Supplied by the caller rather than fetched, because the REST API cannot produce it — it
   * comes from a plugin running inside Figma, where the document model is available.
   */
  motionManifest?: FigmaMotionManifest;
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
