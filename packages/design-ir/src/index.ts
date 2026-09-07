/**
 * DesignIR: the faithful, immutable "as designed" tree produced by every importer.
 *
 * See docs/middle-layer-arch.md section 3.1. Rules that matter:
 * - Transforms are full affine matrices, never x/y/rotation scalars.
 * - Fills and strokes are arrays of paints, never a single colour string.
 * - Text is a run list, never a string.
 * - Warnings are mandatory: every approximation an importer makes is reportable.
 *
 * DesignIR never contains rig state. Timeline, bindings and broadcast objects live in
 * SceneRig and reference these nodes by `nodeId`.
 */

export type DesignSource = "figma" | "psd" | "ai" | "rive" | "svg";

export type DesignNodeKind =
  | "frame"
  | "group"
  | "vector"
  | "rectangle"
  | "ellipse"
  | "line"
  | "text"
  | "image"
  | "boolean"
  | "mask"
  | "unsupported";

export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion"
  | "hue"
  | "saturation"
  | "color"
  | "luminosity";

/** Affine transform, row-major: [a c e / b d f]. Identity is [1, 0, 0, 1, 0, 0]. */
export type Matrix2D = readonly [number, number, number, number, number, number];

export const IDENTITY_MATRIX: Matrix2D = [1, 0, 0, 1, 0, 0];

export interface Size {
  width: number;
  height: number;
}

export interface Rect extends Size {
  x: number;
  y: number;
}

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface GradientStop {
  position: number;
  color: RGBA;
}

export type PaintKind = "solid" | "linear" | "radial" | "angular" | "diamond" | "image" | "video";

export interface Paint {
  kind: PaintKind;
  visible: boolean;
  opacity: number;
  blendMode: BlendMode;
  color?: RGBA;
  stops?: GradientStop[];
  /** Gradient handle positions in normalised node space. */
  gradientTransform?: Matrix2D;
  assetId?: string;
  scaleMode?: "fill" | "fit" | "stretch" | "tile";
}

export type StrokeAlign = "inside" | "outside" | "center";

export interface Stroke {
  paint: Paint;
  weight: number;
  align: StrokeAlign;
  cap: "none" | "round" | "square";
  join: "miter" | "bevel" | "round";
  dashPattern: number[];
}

export type EffectKind = "drop-shadow" | "inner-shadow" | "layer-blur" | "background-blur";

export interface Effect {
  kind: EffectKind;
  visible: boolean;
  radius: number;
  spread?: number;
  offset?: { x: number; y: number };
  color?: RGBA;
  blendMode?: BlendMode;
}

export interface VectorGeometry {
  /** SVG path data. Multiple entries are separate subpaths with their own winding. */
  paths: string[];
  fillRule: "nonzero" | "evenodd";
  cornerRadius?: number | [number, number, number, number];
  cornerSmoothing?: number;
}

export interface TextRun {
  text: string;
  fontFamily: string;
  fontStyle: string;
  fontWeight: number;
  fontSize: number;
  letterSpacing: number;
  lineHeight: number | "auto";
  textCase: "original" | "upper" | "lower" | "title";
  textDecoration: "none" | "underline" | "strikethrough";
  baselineShift: number;
  fills: Paint[];
}

export interface TextLayout {
  horizontalAlign: "left" | "center" | "right" | "justified";
  verticalAlign: "top" | "middle" | "bottom";
  autoResize: "none" | "width" | "height" | "width-and-height";
  paragraphSpacing: number;
  maxLines?: number;
}

export interface TextContent {
  /** Flattened plain text, for search, diffing and token detection. */
  plainText: string;
  runs: TextRun[];
  layout: TextLayout;
}

export type AssetKind = "image" | "video" | "font" | "unknown";

export interface DesignAsset {
  assetId: string;
  name: string;
  kind: AssetKind;
  mimeType?: string;
  /** Data URI, absolute URL, or a path relative to the design store. */
  source: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
}

export interface FontRequirement {
  family: string;
  style: string;
  weight: number;
  /** Distinct codepoints the design actually uses, for subsetting and coverage checks. */
  sampleText: string;
}

export type ImportWarningSeverity = "info" | "warning" | "error";

export interface ImportWarning {
  severity: ImportWarningSeverity;
  code: string;
  message: string;
  nodeId?: string;
  sourcePath?: string;
}

// ---------------------------------------------------------------------------
// Tokens: designer-authored intent, parsed out of layer names. See section 5.4.
// ---------------------------------------------------------------------------

export type DesignTokenKind = "bind" | "fit" | "repeat" | "variant" | "slot" | "clock";

export interface DesignToken {
  kind: DesignTokenKind;
  /** Raw matched text, kept so the UI can show exactly what the designer typed. */
  raw: string;
  /** Data path for bind/repeat, mode for fit, slot name for slot, clock name for clock. */
  value?: string;
  /** Variant key/value pair. */
  key?: string;
}

const TOKEN_PATTERNS: Array<{ kind: DesignTokenKind; pattern: RegExp }> = [
  { kind: "bind", pattern: /\{\{\s*([A-Za-z0-9_.[\]-]+)\s*\}\}/g },
  { kind: "repeat", pattern: /@repeat\(\s*([A-Za-z0-9_.[\]-]+)\s*\)/g },
  { kind: "variant", pattern: /@variant\(\s*([A-Za-z0-9_-]+)\s*=\s*([A-Za-z0-9_-]+)\s*\)/g },
  { kind: "clock", pattern: /@clock\(\s*([A-Za-z0-9_-]+)\s*\)/g },
  { kind: "fit", pattern: /@fit(?:\(\s*(shrink|condense|scroll)\s*\))?/g },
  { kind: "slot", pattern: /#([A-Za-z][A-Za-z0-9_-]*)/g }
];

/**
 * Parses design tokens out of a layer name.
 *
 * `Score Home {{home.score}} @fit` yields a bind token for `home.score` and a fit token.
 * Unknown `@word` sequences are ignored rather than rejected, so a designer's stray
 * annotation never fails an import.
 */
export function parseDesignTokens(layerName: string): DesignToken[] {
  const tokens: DesignToken[] = [];

  for (const { kind, pattern } of TOKEN_PATTERNS) {
    // Fresh regex per call: the module-level literals carry lastIndex state.
    const scoped = new RegExp(pattern.source, pattern.flags);
    let match = scoped.exec(layerName);

    while (match) {
      if (kind === "variant") {
        tokens.push({ kind, raw: match[0], key: match[1], value: match[2] });
      } else {
        tokens.push({ kind, raw: match[0], value: match[1] ?? (kind === "fit" ? "shrink" : undefined) });
      }

      match = scoped.exec(layerName);
    }
  }

  return tokens;
}

/** Layer name with every recognised token stripped, for a readable display name. */
export function stripDesignTokens(layerName: string): string {
  let stripped = layerName;

  for (const { pattern } of TOKEN_PATTERNS) {
    stripped = stripped.replace(new RegExp(pattern.source, pattern.flags), " ");
  }

  return stripped.replace(/\s+/g, " ").trim() || layerName.trim();
}

// ---------------------------------------------------------------------------
// Nodes and documents
// ---------------------------------------------------------------------------

export interface DesignNode {
  /** GrapiX-stable identity. Survives re-import where the source allows it. */
  nodeId: string;
  /** Native id when the source has one that is stable across edits (Figma). */
  sourceNodeId?: string;
  /** Human-readable layer path, used by the manual re-link UI. */
  sourcePath: string;
  name: string;
  displayName: string;
  kind: DesignNodeKind;
  transform: Matrix2D;
  size: Size;
  clipsContent: boolean;
  blendMode: BlendMode;
  opacity: number;
  visible: boolean;
  locked: boolean;
  isMask: boolean;
  effects: Effect[];
  fills: Paint[];
  strokes: Stroke[];
  geometry?: VectorGeometry;
  text?: TextContent;
  imageAssetId?: string;
  autoLayout?: AutoLayout;
  constraints?: NodeConstraints;
  componentRef?: ComponentRef;
  tokens: DesignToken[];
  children: DesignNode[];
}

export interface DesignIR {
  designId: string;
  source: DesignSource;
  /** Where it came from: Figma file key + node, PSD/AI file name. */
  sourceRef: string;
  /** Figma version id, or a content hash for file-based sources. */
  sourceRevision: string;
  sourceFileName: string;
  importedAt: string;
  importerVersion: string;
  /** Design-space raster the artwork was authored against. */
  canvas: Size;
  root: DesignNode;
  assets: DesignAsset[];
  fonts: FontRequirement[];
  warnings: ImportWarning[];
}

export interface DesignIRSummary {
  designId: string;
  source: DesignSource;
  sourceFileName: string;
  sourceRef: string;
  sourceRevision: string;
  importedAt: string;
  canvas: Size;
  nodeCount: number;
  textNodeCount: number;
  tokenCount: number;
  assetCount: number;
  fontCount: number;
  warningCount: number;
  errorCount: number;
}

/** Identity strategy per source. See section 5.3 — the sources are uneven on purpose. */
export const IDENTITY_STRATEGY: Record<DesignSource, { primary: string; fallback: string }> = {
  figma: { primary: "native node id", fallback: "name + tree path + geometry hash" },
  psd: { primary: "layer path + name", fallback: "content hash + bounds" },
  ai: { primary: "name", fallback: "ordinal position + bounds + content hash" },
  rive: { primary: "component / artboard name", fallback: "ordinal position" },
  svg: { primary: "element id", fallback: "ordinal position" }
};

export function walkDesignNodes(
  node: DesignNode,
  visit: (node: DesignNode, depth: number) => void,
  depth = 0
): void {
  visit(node, depth);

  for (const child of node.children) {
    walkDesignNodes(child, visit, depth + 1);
  }
}

export function findDesignNode(root: DesignNode, nodeId: string): DesignNode | undefined {
  let found: DesignNode | undefined;

  walkDesignNodes(root, (node) => {
    if (!found && node.nodeId === nodeId) {
      found = node;
    }
  });

  return found;
}

export function collectDesignTokens(root: DesignNode): Array<{ node: DesignNode; token: DesignToken }> {
  const collected: Array<{ node: DesignNode; token: DesignToken }> = [];

  walkDesignNodes(root, (node) => {
    for (const token of node.tokens) {
      collected.push({ node, token });
    }
  });

  return collected;
}

export function summarizeDesignIR(design: DesignIR): DesignIRSummary {
  let nodeCount = 0;
  let textNodeCount = 0;
  let tokenCount = 0;

  walkDesignNodes(design.root, (node) => {
    nodeCount += 1;
    tokenCount += node.tokens.length;

    if (node.kind === "text") {
      textNodeCount += 1;
    }
  });

  return {
    designId: design.designId,
    source: design.source,
    sourceFileName: design.sourceFileName,
    sourceRef: design.sourceRef,
    sourceRevision: design.sourceRevision,
    importedAt: design.importedAt,
    canvas: design.canvas,
    nodeCount,
    textNodeCount,
    tokenCount,
    assetCount: design.assets.length,
    fontCount: design.fonts.length,
    warningCount: design.warnings.filter((warning) => warning.severity === "warning").length,
    errorCount: design.warnings.filter((warning) => warning.severity === "error").length
  };
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

/** FNV-1a, 32-bit, hex. Deterministic across processes — no crypto dependency. */
export function hashString(input: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
}

/**
 * Stable node id. `sourceNodeId` wins when the source guarantees stability across edits;
 * otherwise identity is derived from the layer path plus a content fingerprint so that a
 * moved-but-unchanged layer still matches on re-import.
 */
export function createStableNodeId(input: {
  source: DesignSource;
  sourceNodeId?: string;
  sourcePath: string;
  name: string;
  kind: DesignNodeKind;
  fingerprint?: string;
}): string {
  if (input.source === "figma" && input.sourceNodeId) {
    return `fig:${input.sourceNodeId}`;
  }

  const basis = [input.sourcePath, input.name, input.kind, input.fingerprint ?? ""].join("|");

  return `${input.source}:${hashString(basis)}`;
}

export function createDesignId(source: DesignSource, sourceRef: string, revision: string): string {
  return `design_${source}_${hashString(`${sourceRef}|${revision}`)}`;
}

export function createAssetId(designId: string, key: string): string {
  return `asset_${hashString(`${designId}|${key}`)}`;
}

// ---------------------------------------------------------------------------
// Construction helpers, so importers stay short and consistent
// ---------------------------------------------------------------------------

export function solidPaint(color: RGBA, opacity = 1): Paint {
  return {
    kind: "solid",
    visible: true,
    opacity,
    blendMode: "normal",
    color
  };
}

export function rgba(r: number, g: number, b: number, a = 1): RGBA {
  return { r, g, b, a };
}

export function rgbaFromHex(hex: string, alpha = 1): RGBA {
  const normalized = hex.replace("#", "").trim();
  const expanded =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => char + char)
          .join("")
      : normalized;

  return {
    r: Number.parseInt(expanded.slice(0, 2), 16) / 255,
    g: Number.parseInt(expanded.slice(2, 4), 16) / 255,
    b: Number.parseInt(expanded.slice(4, 6), 16) / 255,
    a: alpha
  };
}

export function rgbaToHex(color: RGBA): string {
  const channel = (value: number): string =>
    Math.max(0, Math.min(255, Math.round(value * 255)))
      .toString(16)
      .padStart(2, "0");

  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

export function translationMatrix(x: number, y: number): Matrix2D {
  return [1, 0, 0, 1, x, y];
}

export function matrixTranslation(matrix: Matrix2D): { x: number; y: number } {
  return { x: matrix[4], y: matrix[5] };
}

export function multiplyMatrix(a: Matrix2D, b: Matrix2D): Matrix2D {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5]
  ];
}

export function defaultTextLayout(): TextLayout {
  return {
    horizontalAlign: "left",
    verticalAlign: "top",
    autoResize: "none",
    paragraphSpacing: 0
  };
}

export interface CreateDesignNodeInput {
  nodeId: string;
  sourcePath: string;
  name: string;
  kind: DesignNodeKind;
  sourceNodeId?: string;
  transform?: Matrix2D;
  size?: Size;
}

/** Builds a node with broadcast-safe defaults, then lets the importer override. */
export function createDesignNode(
  input: CreateDesignNodeInput,
  overrides: Partial<DesignNode> = {}
): DesignNode {
  const tokens = parseDesignTokens(input.name);

  return {
    nodeId: input.nodeId,
    sourceNodeId: input.sourceNodeId,
    sourcePath: input.sourcePath,
    name: input.name,
    displayName: stripDesignTokens(input.name),
    kind: input.kind,
    transform: input.transform ?? IDENTITY_MATRIX,
    size: input.size ?? { width: 0, height: 0 },
    clipsContent: false,
    blendMode: "normal",
    opacity: 1,
    visible: true,
    locked: false,
    isMask: false,
    effects: [],
    fills: [],
    strokes: [],
    tokens,
    children: [],
    ...overrides
  };
}

export interface FontCollector {
  add: (family: string, style: string, weight: number, text: string) => void;
  list: () => FontRequirement[];
}

/** Accumulates font requirements while walking a source tree, de-duplicated by face. */
export function createFontCollector(): FontCollector {
  const faces = new Map<string, FontRequirement & { chars: Set<string> }>();

  return {
    add: (family, style, weight, text) => {
      const key = `${family}|${style}|${weight}`;
      const existing = faces.get(key);

      if (existing) {
        for (const char of text) {
          existing.chars.add(char);
        }

        return;
      }

      faces.set(key, {
        family,
        style,
        weight,
        sampleText: "",
        chars: new Set(text)
      });
    },
    list: () =>
      [...faces.values()].map((face) => ({
        family: face.family,
        style: face.style,
        weight: face.weight,
        sampleText: [...face.chars].sort().join("")
      }))
  };
}

export {
  diffNeedsReview,
  reconcileDesigns,
  STRATEGY_CONFIDENCE,
  type ChangeKind,
  type DesignDiff,
  type MatchedNode,
  type MatchStrategy,
  type UnmatchedNode
} from "./reconcile.js";

// ---------------------------------------------------------------------------
// Layout intent
//
// Design tools express *why* a box is where it is, not just where it ended up.
// Broadcast needs that intent: a lower third built with auto-layout has to reflow when a
// bound name is longer than the designer's placeholder, and a badge pinned to the right
// edge has to stay pinned when the raster changes. Dropping this on import is what makes
// imported artwork feel dead.
// ---------------------------------------------------------------------------

export type LayoutAxis = "none" | "horizontal" | "vertical";
export type LayoutAlign = "start" | "center" | "end" | "space-between" | "baseline";
export type LayoutSizing = "fixed" | "hug" | "fill";

export interface AutoLayout {
  axis: LayoutAxis;
  primaryAlign: LayoutAlign;
  counterAlign: LayoutAlign;
  itemSpacing: number;
  padding: { top: number; right: number; bottom: number; left: number };
  primarySizing: LayoutSizing;
  counterSizing: LayoutSizing;
  /** Children ignoring the layout, positioned absolutely inside it. */
  clipsContent: boolean;
}

export type ConstraintKind = "min" | "max" | "center" | "stretch" | "scale";

export interface NodeConstraints {
  horizontal: ConstraintKind;
  vertical: ConstraintKind;
}

/**
 * Component identity. Two instances of one component should rig once, so the compiler and
 * the re-link UI both need to know which nodes share a definition.
 */
export interface ComponentRef {
  componentId: string;
  componentName?: string;
  isInstance: boolean;
}
