/**
 * Figma payload -> DesignIR.
 *
 * Shared by both front-ends. Where the plugin supplies higher-fidelity fields
 * (`pluginVectorPaths`, `pluginTextSegments`) they win; otherwise the mapper falls back to
 * the REST fields and records a warning saying what it had to approximate. Fidelity loss is
 * never silent — see docs/middle-layer-arch.md section 3.1.
 */

import {
  createAssetId,
  createDesignId,
  createDesignNode,
  createFontCollector,
  defaultTextLayout,
  IDENTITY_MATRIX,
  hashString,
  type AutoLayout,
  type ImageFilters,
  type MaskType,
  type SharedStyle,
  type StyleRefs,
  type BlendMode,
  type ComponentRef,
  type ConstraintKind,
  type LayoutAlign,
  type LayoutSizing,
  type NodeConstraints,
  type DesignAsset,
  type DesignIR,
  type DesignNode,
  type DesignNodeKind,
  type Effect,
  type ImportWarning,
  type Matrix2D,
  type Paint,
  type RGBA,
  type Size,
  type Stroke,
  type TextContent,
  type TextRun
} from "@grapix/design-ir";
import type {
  FigmaColor,
  FigmaEffect,
  FigmaImportPayload,
  FigmaNodePayload,
  FigmaPaint,
  FigmaTypeStyle,
  FigmaVectorPath
} from "./figma-payload.js";

export const FIGMA_IMPORTER_VERSION = "figma/0.1.0";

const NODE_KIND_BY_TYPE: Record<string, DesignNodeKind> = {
  DOCUMENT: "frame",
  CANVAS: "frame",
  FRAME: "frame",
  SECTION: "frame",
  COMPONENT: "frame",
  COMPONENT_SET: "frame",
  INSTANCE: "frame",
  GROUP: "group",
  VECTOR: "vector",
  STAR: "vector",
  POLYGON: "vector",
  REGULAR_POLYGON: "vector",
  RECTANGLE: "rectangle",
  ROUNDED_RECTANGLE: "rectangle",
  ELLIPSE: "ellipse",
  LINE: "line",
  TEXT: "text",
  BOOLEAN_OPERATION: "boolean"
};

const BLEND_MODE_BY_FIGMA: Record<string, BlendMode> = {
  PASS_THROUGH: "normal",
  NORMAL: "normal",
  MULTIPLY: "multiply",
  SCREEN: "screen",
  OVERLAY: "overlay",
  DARKEN: "darken",
  LIGHTEN: "lighten",
  COLOR_DODGE: "color-dodge",
  COLOR_BURN: "color-burn",
  HARD_LIGHT: "hard-light",
  SOFT_LIGHT: "soft-light",
  DIFFERENCE: "difference",
  EXCLUSION: "exclusion",
  HUE: "hue",
  SATURATION: "saturation",
  COLOR: "color",
  LUMINOSITY: "luminosity"
};

const PAINT_KIND_BY_FIGMA: Record<string, Paint["kind"]> = {
  SOLID: "solid",
  GRADIENT_LINEAR: "linear",
  GRADIENT_RADIAL: "radial",
  GRADIENT_ANGULAR: "angular",
  GRADIENT_DIAMOND: "diamond",
  IMAGE: "image",
  VIDEO: "video"
};

interface MapperContext {
  designId: string;
  warnings: ImportWarning[];
  fonts: ReturnType<typeof createFontCollector>;
  images: Map<string, DesignAsset>;
  origin: FigmaImportPayload["origin"];
  seenNodeIds: Set<string>;
  referencedStyleIds: Set<string>;
}

export function mapFigmaPayloadToDesignIR(payload: FigmaImportPayload): DesignIR {
  const sourceRef = payload.nodes.length
    ? `${payload.fileKey}#${payload.nodes.map((node) => node.id).join(",")}`
    : payload.fileKey;
  const designId = createDesignId("figma", sourceRef, payload.version);

  const context: MapperContext = {
    designId,
    warnings: [],
    fonts: createFontCollector(),
    images: new Map(),
    origin: payload.origin,
    seenNodeIds: new Set(),
    referencedStyleIds: new Set()
  };

  for (const image of payload.images ?? []) {
    context.images.set(image.imageRef, {
      assetId: createAssetId(designId, image.imageRef),
      name: image.imageRef,
      kind: "image",
      mimeType: image.mimeType,
      source: image.source,
      width: image.width,
      height: image.height
    });
  }

  if (!payload.nodes.length) {
    context.warnings.push({
      severity: "error",
      code: "FIGMA_NO_NODES",
      message: "The import returned no nodes. Select a frame in Figma, or add node-id to the URL."
    });
  }

  const children = payload.nodes.map((node) => mapNode(node, "", context));
  const canvas = resolveCanvas(children);

  const root = createDesignNode(
    {
      nodeId: `fig:root:${hashString(sourceRef)}`,
      sourcePath: "",
      name: payload.fileName || "Figma import",
      kind: "frame"
    },
    {
      size: canvas,
      children,
      clipsContent: true
    }
  );

  if (payload.origin === "rest") {
    context.warnings.push({
      severity: "info",
      code: "FIGMA_REST_FALLBACK",
      message:
        "Imported through the REST API. Vector geometry is outlined rather than editable and text runs are reconstructed from character overrides. Use the GrapiX Figma plugin for full fidelity."
    });
  }

  return {
    designId,
    source: "figma",
    sourceRef,
    sourceRevision: payload.version,
    sourceFileName: payload.fileName,
    importedAt: new Date().toISOString(),
    importerVersion: payload.clientVersion
      ? `${FIGMA_IMPORTER_VERSION}+${payload.origin}/${payload.clientVersion}`
      : `${FIGMA_IMPORTER_VERSION}+${payload.origin}`,
    canvas,
    root,
    assets: [...context.images.values()],
    fonts: context.fonts.list(),
    sharedStyles: resolveSharedStyles(payload, context),
    warnings: context.warnings
  };
}

function resolveCanvas(children: DesignNode[]): Size {
  if (!children.length) {
    return { width: 1920, height: 1080 };
  }

  let width = 0;
  let height = 0;

  for (const child of children) {
    width = Math.max(width, child.transform[4] + child.size.width);
    height = Math.max(height, child.transform[5] + child.size.height);
  }

  return {
    width: Math.round(width) || 1920,
    height: Math.round(height) || 1080
  };
}

function mapNode(node: FigmaNodePayload, parentPath: string, context: MapperContext): DesignNode {
  const sourcePath = parentPath ? `${parentPath}/${node.name}` : node.name;
  const kind = NODE_KIND_BY_TYPE[node.type] ?? "unsupported";

  if (kind === "unsupported") {
    context.warnings.push({
      severity: "warning",
      code: "FIGMA_UNSUPPORTED_NODE",
      message: `${node.type} is not mapped yet and will render as an empty container.`,
      nodeId: `fig:${node.id}`,
      sourcePath
    });
  }

  // Figma node ids are stable across edits, which is why Figma is the reference source.
  const nodeId = `fig:${node.id}`;

  if (context.seenNodeIds.has(nodeId)) {
    context.warnings.push({
      severity: "warning",
      code: "FIGMA_DUPLICATE_NODE_ID",
      message: `Node id ${node.id} appeared twice; the second occurrence was given a derived id.`,
      nodeId,
      sourcePath
    });
  }

  const resolvedNodeId = context.seenNodeIds.has(nodeId)
    ? `${nodeId}:${hashString(sourcePath)}`
    : nodeId;
  context.seenNodeIds.add(resolvedNodeId);

  const size = resolveSize(node);
  const fills = (node.fills ?? []).map((paint) => mapPaint(paint, context, sourcePath, resolvedNodeId));
  const strokes = mapStrokes(node, context, sourcePath, resolvedNodeId);

  const mapped = createDesignNode(
    {
      nodeId: resolvedNodeId,
      sourceNodeId: node.id,
      sourcePath,
      name: node.name,
      kind,
      transform: resolveTransform(node),
      size
    },
    {
      visible: node.visible ?? true,
      locked: node.locked ?? false,
      opacity: node.opacity ?? 1,
      blendMode: BLEND_MODE_BY_FIGMA[node.blendMode ?? "NORMAL"] ?? "normal",
      clipsContent: node.clipsContent ?? false,
      isMask: node.isMask ?? false,
      fills,
      strokes,
      effects: (node.effects ?? []).map(mapEffect).filter((effect): effect is Effect => effect !== null),
      geometry: resolveGeometry(node, kind, context, sourcePath, resolvedNodeId),
      text: kind === "text" ? resolveText(node, context, sourcePath, resolvedNodeId) : undefined,
      imageAssetId: resolveImageAssetId(node, context),
      maskType: node.isMask ? mapMaskType(node.maskType, context, sourcePath, resolvedNodeId) : undefined,
      renderBounds: node.absoluteRenderBounds
        ? {
            x: node.absoluteRenderBounds.x,
            y: node.absoluteRenderBounds.y,
            width: node.absoluteRenderBounds.width,
            height: node.absoluteRenderBounds.height
          }
        : undefined,
      styleRefs: resolveStyleRefs(node, context),
      variableRefs: resolveVariableRefs(node),
      autoLayout: resolveAutoLayout(node),
      constraints: resolveConstraints(node),
      componentRef: resolveComponentRef(node),
      children: (node.children ?? []).map((child) => mapNode(child, sourcePath, context))
    }
  );

  return mapped;
}

/**
 * Auto-layout carries the designer's reflow intent, which broadcast needs: a bound name
 * longer than the placeholder has to push the rest of the lower third along.
 */
function resolveAutoLayout(node: FigmaNodePayload): AutoLayout | undefined {
  const axis = node.layoutMode === "HORIZONTAL" ? "horizontal" : node.layoutMode === "VERTICAL" ? "vertical" : "none";

  if (axis === "none") {
    return undefined;
  }

  return {
    axis,
    primaryAlign: mapLayoutAlign(node.primaryAxisAlignItems),
    counterAlign: mapLayoutAlign(node.counterAxisAlignItems),
    itemSpacing: node.itemSpacing ?? 0,
    padding: {
      top: node.paddingTop ?? 0,
      right: node.paddingRight ?? 0,
      bottom: node.paddingBottom ?? 0,
      left: node.paddingLeft ?? 0
    },
    primarySizing: mapLayoutSizing(node.primaryAxisSizingMode),
    counterSizing: mapLayoutSizing(node.counterAxisSizingMode),
    clipsContent: node.clipsContent ?? false
  };
}

function mapLayoutAlign(align: string | undefined): LayoutAlign {
  switch (align) {
    case "CENTER":
      return "center";
    case "MAX":
      return "end";
    case "SPACE_BETWEEN":
      return "space-between";
    case "BASELINE":
      return "baseline";
    default:
      return "start";
  }
}

function mapLayoutSizing(mode: string | undefined): LayoutSizing {
  switch (mode) {
    case "AUTO":
      return "hug";
    case "FIXED":
      return "fixed";
    default:
      return "fixed";
  }
}

/** Pinning intent, so a badge stays on the right edge when the raster changes. */
function resolveConstraints(node: FigmaNodePayload): NodeConstraints | undefined {
  if (!node.constraints) {
    return undefined;
  }

  return {
    horizontal: mapConstraint(node.constraints.horizontal),
    vertical: mapConstraint(node.constraints.vertical)
  };
}

function mapConstraint(constraint: string | undefined): ConstraintKind {
  switch (constraint) {
    case "MAX":
    case "RIGHT":
    case "BOTTOM":
      return "max";
    case "CENTER":
      return "center";
    case "STRETCH":
    case "TOP_BOTTOM":
    case "LEFT_RIGHT":
      return "stretch";
    case "SCALE":
      return "scale";
    default:
      return "min";
  }
}

function resolveComponentRef(node: FigmaNodePayload): ComponentRef | undefined {
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    return {
      componentId: node.id,
      componentName: node.name,
      isInstance: false
    };
  }

  if (node.type === "INSTANCE" && node.componentId) {
    return {
      componentId: node.componentId,
      componentName: node.pluginComponentName,
      isInstance: true
    };
  }

  return undefined;
}

function resolveSize(node: FigmaNodePayload): Size {
  if (node.size) {
    return { width: node.size.x, height: node.size.y };
  }

  if (typeof node.width === "number" && typeof node.height === "number") {
    return { width: node.width, height: node.height };
  }

  if (node.absoluteBoundingBox) {
    return { width: node.absoluteBoundingBox.width, height: node.absoluteBoundingBox.height };
  }

  return { width: 0, height: 0 };
}

function resolveTransform(node: FigmaNodePayload): Matrix2D {
  if (node.relativeTransform) {
    const [[a, c, e], [b, d, f]] = node.relativeTransform;

    return [a, b, c, d, e, f];
  }

  if (node.absoluteBoundingBox) {
    // Absolute coordinates are the best available anchor; the parent chain re-bases them
    // during compile. Recorded as identity-plus-translation so nothing is silently rotated.
    return [1, 0, 0, 1, node.absoluteBoundingBox.x, node.absoluteBoundingBox.y];
  }

  return IDENTITY_MATRIX;
}

function mapPaint(
  paint: FigmaPaint,
  context: MapperContext,
  sourcePath: string,
  nodeId: string
): Paint {
  const kind = PAINT_KIND_BY_FIGMA[paint.type ?? "SOLID"] ?? "solid";

  if (!PAINT_KIND_BY_FIGMA[paint.type ?? "SOLID"]) {
    context.warnings.push({
      severity: "warning",
      code: "FIGMA_UNKNOWN_PAINT",
      message: `Paint type ${paint.type ?? "unknown"} was imported as a solid fill.`,
      nodeId,
      sourcePath
    });
  }

  const mapped: Paint = {
    kind,
    visible: paint.visible ?? true,
    opacity: paint.opacity ?? 1,
    blendMode: BLEND_MODE_BY_FIGMA[paint.blendMode ?? "NORMAL"] ?? "normal",
    color: paint.color ? mapColor(paint.color) : undefined,
    stops: paint.gradientStops?.map((stop) => ({
      position: stop.position,
      color: mapColor(stop.color)
    })),
    imageTransform: paint.imageTransform ? rowsToMatrix(paint.imageTransform) : undefined,
    tileScale: paint.scalingFactor,
    rotation: paint.rotation,
    filters: mapImageFilters(paint.filters),
    gradientTransform: paint.pluginGradientTransform
      ? ([
          paint.pluginGradientTransform[0][0],
          paint.pluginGradientTransform[1][0],
          paint.pluginGradientTransform[0][1],
          paint.pluginGradientTransform[1][1],
          paint.pluginGradientTransform[0][2],
          paint.pluginGradientTransform[1][2]
        ] as Matrix2D)
      : mapGradientHandles(paint.gradientHandlePositions),
    scaleMode: mapScaleMode(paint.scaleMode)
  };

  if (paint.imageRef) {
    const asset = context.images.get(paint.imageRef);

    if (asset) {
      mapped.assetId = asset.assetId;
    } else {
      context.warnings.push({
        severity: "warning",
        code: "FIGMA_IMAGE_NOT_RESOLVED",
        message: `Image fill ${paint.imageRef} had no downloadable source and will render as a missing asset.`,
        nodeId,
        sourcePath
      });
    }
  }

  return mapped;
}

/**
 * Mask compositing mode. Luminance masks are how broadcast art usually builds a gradient
 * fade, so silently treating one as an alpha mask changes the look.
 */
function mapMaskType(
  maskType: string | undefined,
  context: MapperContext,
  sourcePath: string,
  nodeId: string
): MaskType {
  switch (maskType) {
    case "VECTOR":
      return "vector";
    case "LUMINANCE":
      context.warnings.push({
        severity: "info",
        code: "FIGMA_LUMINANCE_MASK",
        message:
          "This layer is a luminance mask. It is recorded, but the renderer must composite it by luminance rather than alpha or the fade will look wrong.",
        nodeId,
        sourcePath
      });

      return "luminance";
    default:
      // Figma defaults to ALPHA when the field is absent.
      return "alpha";
  }
}

/**
 * Shared style references — Figma's "layer styles". Recording the id (rather than only the
 * resolved values) is what lets two nodes on one style change together later.
 */
function resolveStyleRefs(
  node: FigmaNodePayload,
  context: MapperContext
): StyleRefs | undefined {
  if (!node.styles || !Object.keys(node.styles).length) {
    return undefined;
  }

  const refs: StyleRefs = {};

  for (const [slot, styleId] of Object.entries(node.styles)) {
    if (typeof styleId !== "string") {
      continue;
    }

    switch (slot) {
      case "fill":
      case "fills":
        refs.fill = styleId;
        break;
      case "stroke":
      case "strokes":
        refs.stroke = styleId;
        break;
      case "text":
        refs.text = styleId;
        break;
      case "effect":
      case "effects":
        refs.effect = styleId;
        break;
      case "grid":
      case "grids":
        refs.grid = styleId;
        break;
      default:
        break;
    }

    context.referencedStyleIds.add(styleId);
  }

  return Object.keys(refs).length ? refs : undefined;
}

/**
 * Figma variable bindings, flattened to property -> variable id. The variable's value is
 * not available from the file endpoint, so only the reference is kept.
 */
function resolveVariableRefs(node: FigmaNodePayload): Record<string, string> | undefined {
  if (!node.boundVariables) {
    return undefined;
  }

  const refs: Record<string, string> = {};

  for (const [property, binding] of Object.entries(node.boundVariables)) {
    const id = extractVariableId(binding);

    if (id) {
      refs[property] = id;
    }
  }

  return Object.keys(refs).length ? refs : undefined;
}

/** A binding is either {id} or an array of them, depending on the property. */
function extractVariableId(binding: unknown): string | null {
  if (!binding || typeof binding !== "object") {
    return null;
  }

  const direct = (binding as { id?: unknown }).id;

  if (typeof direct === "string") {
    return direct;
  }

  if (Array.isArray(binding)) {
    for (const entry of binding) {
      const id = extractVariableId(entry);

      if (id) {
        return id;
      }
    }
  }

  return null;
}

/** Figma's row-pair transform ([[a, c, e], [b, d, f]]) into DesignIR's flat matrix. */
function rowsToMatrix(rows: [[number, number, number], [number, number, number]]): Matrix2D {
  return [rows[0][0], rows[1][0], rows[0][1], rows[1][1], rows[0][2], rows[1][2]];
}

/** All-zero filters mean "untouched", so they are dropped rather than stored. */
function mapImageFilters(
  filters: FigmaPaint["filters"]
): ImageFilters | undefined {
  if (!filters) {
    return undefined;
  }

  const mapped: ImageFilters = {
    exposure: filters.exposure ?? 0,
    contrast: filters.contrast ?? 0,
    saturation: filters.saturation ?? 0,
    temperature: filters.temperature ?? 0,
    tint: filters.tint ?? 0,
    highlights: filters.highlights ?? 0,
    shadows: filters.shadows ?? 0
  };

  return Object.values(mapped).some((value) => value !== 0) ? mapped : undefined;
}

function mapScaleMode(scaleMode: string | undefined): Paint["scaleMode"] {
  switch (scaleMode) {
    case "FILL":
      return "fill";
    case "FIT":
      return "fit";
    case "STRETCH":
      return "stretch";
    case "TILE":
      return "tile";
    default:
      return undefined;
  }
}

/**
 * Figma expresses a gradient as three handle positions in normalised node space.
 * Converted into the affine transform that maps the unit gradient onto those handles.
 */
function mapGradientHandles(
  handles: Array<{ x: number; y: number }> | undefined
): Matrix2D | undefined {
  if (!handles || handles.length < 3) {
    return undefined;
  }

  const [origin, end, across] = handles;

  return [end.x - origin.x, end.y - origin.y, across.x - origin.x, across.y - origin.y, origin.x, origin.y];
}

function mapColor(color: FigmaColor): RGBA {
  return { r: color.r, g: color.g, b: color.b, a: color.a ?? 1 };
}

function mapStrokes(
  node: FigmaNodePayload,
  context: MapperContext,
  sourcePath: string,
  nodeId: string
): Stroke[] {
  const sides = node.individualStrokeWeights;
  // Only record per-side weights when they actually differ; otherwise `weight` says it all.
  const individualWeights =
    sides &&
    new Set([sides.top ?? 0, sides.right ?? 0, sides.bottom ?? 0, sides.left ?? 0]).size > 1
      ? {
          top: sides.top ?? 0,
          right: sides.right ?? 0,
          bottom: sides.bottom ?? 0,
          left: sides.left ?? 0
        }
      : undefined;

  return (node.strokes ?? []).map((paint) => ({
    paint: mapPaint(paint, context, sourcePath, nodeId),
    weight: node.strokeWeight ?? 1,
    align: mapStrokeAlign(node.strokeAlign),
    cap: mapStrokeCap(node.strokeCap),
    join: mapStrokeJoin(node.strokeJoin),
    dashPattern: node.strokeDashes ?? [],
    individualWeights,
    miterAngle: node.strokeMiterAngle
  }));
}

function mapStrokeAlign(align: string | undefined): Stroke["align"] {
  switch (align) {
    case "INSIDE":
      return "inside";
    case "OUTSIDE":
      return "outside";
    default:
      return "center";
  }
}

function mapStrokeCap(cap: string | undefined): Stroke["cap"] {
  switch (cap) {
    case "ROUND":
      return "round";
    case "SQUARE":
      return "square";
    default:
      return "none";
  }
}

function mapStrokeJoin(join: string | undefined): Stroke["join"] {
  switch (join) {
    case "BEVEL":
      return "bevel";
    case "ROUND":
      return "round";
    default:
      return "miter";
  }
}

function mapEffect(effect: FigmaEffect): Effect | null {
  const kindByType: Record<string, Effect["kind"]> = {
    DROP_SHADOW: "drop-shadow",
    INNER_SHADOW: "inner-shadow",
    LAYER_BLUR: "layer-blur",
    BACKGROUND_BLUR: "background-blur"
  };
  const kind = kindByType[effect.type ?? ""];

  if (!kind) {
    return null;
  }

  return {
    kind,
    visible: effect.visible ?? true,
    radius: effect.radius ?? 0,
    spread: effect.spread,
    offset: effect.offset,
    color: effect.color ? mapColor(effect.color) : undefined,
    blendMode: BLEND_MODE_BY_FIGMA[effect.blendMode ?? "NORMAL"] ?? "normal",
    showBehindNode: effect.showShadowBehindNode
  };
}

function resolveGeometry(
  node: FigmaNodePayload,
  kind: DesignNodeKind,
  context: MapperContext,
  sourcePath: string,
  nodeId: string
): DesignNode["geometry"] {
  const pluginPaths = node.pluginVectorPaths;
  const restPaths = node.fillGeometry;
  const source: FigmaVectorPath[] | undefined = pluginPaths?.length ? pluginPaths : restPaths;

  const cornerRadius = node.rectangleCornerRadii ?? node.cornerRadius;

  if (!source?.length) {
    if (kind === "vector" || kind === "boolean") {
      context.warnings.push({
        severity: "warning",
        code: "FIGMA_GEOMETRY_MISSING",
        message:
          context.origin === "rest"
            ? "Vector geometry was not returned. Request the node with geometry=paths, or import via the plugin."
            : "Vector geometry was empty for this node.",
        nodeId,
        sourcePath
      });
    }

    return cornerRadius === undefined
      ? undefined
      : {
          paths: [],
          fillRule: "nonzero",
          cornerRadius,
          cornerSmoothing: node.cornerSmoothing
        };
  }

  return {
    paths: source.map((path) => path.data),
    fillRule: source.some((path) => path.windingRule === "EVENODD") ? "evenodd" : "nonzero",
    cornerRadius,
    cornerSmoothing: node.cornerSmoothing
  };
}

function resolveImageAssetId(node: FigmaNodePayload, context: MapperContext): string | undefined {
  const imagePaint = (node.fills ?? []).find((paint) => paint.type === "IMAGE" && paint.imageRef);

  if (!imagePaint?.imageRef) {
    return undefined;
  }

  return context.images.get(imagePaint.imageRef)?.assetId;
}

function resolveText(
  node: FigmaNodePayload,
  context: MapperContext,
  sourcePath: string,
  nodeId: string
): TextContent | undefined {
  const plainText = node.characters ?? "";
  const layout = resolveTextLayout(node.style);

  if (node.pluginTextSegments?.length) {
    const runs = node.pluginTextSegments.map<TextRun>((segment) => {
      context.fonts.add(segment.fontFamily, segment.fontStyle, segment.fontWeight, segment.characters);

      return {
        text: segment.characters,
        fontFamily: segment.fontFamily,
        fontStyle: segment.fontStyle,
        fontWeight: segment.fontWeight,
        fontSize: segment.fontSize,
        letterSpacing: segment.letterSpacing,
        lineHeight: segment.lineHeight,
        textCase: mapTextCase(segment.textCase),
        textDecoration: mapTextDecoration(segment.textDecoration),
        baselineShift: 0,
        fills: segment.fills.map((paint) => mapPaint(paint, context, sourcePath, nodeId))
      };
    });

    return { plainText, runs, layout };
  }

  if (!node.style) {
    context.warnings.push({
      severity: "warning",
      code: "FIGMA_TEXT_STYLE_MISSING",
      message: "Text node had no style block; it was imported with fallback typography.",
      nodeId,
      sourcePath
    });
  }

  const runs = buildRestTextRuns(node, context, sourcePath, nodeId);

  return { plainText, runs, layout };
}

/**
 * Rebuilds a run list from the REST shape: a base `style` plus `characterStyleOverrides`
 * indexing into `styleOverrideTable`. Consecutive characters sharing an override id
 * collapse into one run.
 */
function buildRestTextRuns(
  node: FigmaNodePayload,
  context: MapperContext,
  sourcePath: string,
  nodeId: string
): TextRun[] {
  const characters = [...(node.characters ?? "")];

  if (!characters.length) {
    return [];
  }

  const overrides = node.characterStyleOverrides ?? [];
  const table = node.styleOverrideTable ?? {};
  const runs: TextRun[] = [];

  let runStart = 0;
  let currentOverride = overrides[0] ?? 0;

  const pushRun = (start: number, end: number, overrideId: number): void => {
    const text = characters.slice(start, end).join("");

    if (!text) {
      return;
    }

    const style: FigmaTypeStyle = {
      ...node.style,
      ...(overrideId ? table[String(overrideId)] : undefined)
    };

    runs.push(buildRun(text, style, context, sourcePath, nodeId));
  };

  for (let index = 1; index <= characters.length; index += 1) {
    const overrideAt = overrides[index] ?? 0;

    if (index === characters.length || overrideAt !== currentOverride) {
      pushRun(runStart, index, currentOverride);
      runStart = index;
      currentOverride = overrideAt;
    }
  }

  if (overrides.length && runs.length > 1) {
    context.warnings.push({
      severity: "info",
      code: "FIGMA_TEXT_RUNS_RECONSTRUCTED",
      message: `${runs.length} text runs were reconstructed from character overrides; verify tracking and baseline shifts.`,
      nodeId,
      sourcePath
    });
  }

  return runs;
}

function buildRun(
  text: string,
  style: FigmaTypeStyle,
  context: MapperContext,
  sourcePath: string,
  nodeId: string
): TextRun {
  const fontFamily = style.fontFamily ?? "Inter";
  const fontWeight = style.fontWeight ?? 400;
  const fontStyle = style.italic ? "Italic" : "Regular";

  context.fonts.add(fontFamily, fontStyle, fontWeight, text);

  return {
    text,
    fontFamily,
    fontStyle,
    fontWeight,
    fontSize: style.fontSize ?? 16,
    letterSpacing: style.letterSpacing ?? 0,
    lineHeight: style.lineHeightPx ?? "auto",
    textCase: mapTextCase(style.textCase),
    textDecoration: mapTextDecoration(style.textDecoration),
    baselineShift: 0,
    fontPostScriptName: style.fontPostScriptName ?? undefined,
    fills: (style.fills ?? []).map((paint) => mapPaint(paint, context, sourcePath, nodeId))
  };
}

function resolveTextLayout(style: FigmaTypeStyle | undefined): TextContent["layout"] {
  const layout = defaultTextLayout();

  if (!style) {
    return layout;
  }

  return {
    horizontalAlign: mapHorizontalAlign(style.textAlignHorizontal),
    verticalAlign: mapVerticalAlign(style.textAlignVertical),
    autoResize: mapAutoResize(style.textAutoResize),
    paragraphSpacing: style.paragraphSpacing ?? 0,
    maxLines: style.maxLines,
    truncation: style.textTruncation === "ENDING" ? "ending" : "none"
  };
}

function mapHorizontalAlign(align: string | undefined): TextContent["layout"]["horizontalAlign"] {
  switch (align) {
    case "CENTER":
      return "center";
    case "RIGHT":
      return "right";
    case "JUSTIFIED":
      return "justified";
    default:
      return "left";
  }
}

function mapVerticalAlign(align: string | undefined): TextContent["layout"]["verticalAlign"] {
  switch (align) {
    case "CENTER":
      return "middle";
    case "BOTTOM":
      return "bottom";
    default:
      return "top";
  }
}

function mapAutoResize(resize: string | undefined): TextContent["layout"]["autoResize"] {
  switch (resize) {
    case "WIDTH_AND_HEIGHT":
      return "width-and-height";
    case "HEIGHT":
      return "height";
    case "TRUNCATE":
      return "none";
    default:
      return "none";
  }
}

function mapTextCase(textCase: string | undefined): TextRun["textCase"] {
  switch (textCase) {
    case "UPPER":
      return "upper";
    case "LOWER":
      return "lower";
    case "TITLE":
      return "title";
    default:
      return "original";
  }
}

function mapTextDecoration(decoration: string | undefined): TextRun["textDecoration"] {
  switch (decoration) {
    case "UNDERLINE":
      return "underline";
    case "STRIKETHROUGH":
      return "strikethrough";
    default:
      return "none";
  }
}

/**
 * Builds the shared-style table, keeping only styles a node actually references.
 *
 * A style the importer cannot resolve is reported: the node keeps its resolved values, so
 * it still renders, but it is no longer linked to the style and will not follow a later
 * change to it.
 */
function resolveSharedStyles(
  payload: FigmaImportPayload,
  context: MapperContext
): Record<string, SharedStyle> {
  const table: Record<string, SharedStyle> = {};
  const supplied = payload.styles ?? {};

  for (const styleId of context.referencedStyleIds) {
    const definition = supplied[styleId];

    if (!definition) {
      context.warnings.push({
        severity: "warning",
        code: "FIGMA_STYLE_NOT_RESOLVED",
        message: `Shared style ${styleId} was referenced but not included in the import, so those layers are no longer linked to it.`
      });

      continue;
    }

    table[styleId] = {
      styleId,
      name: definition.name ?? styleId,
      styleType: mapStyleType(definition.styleType),
      key: definition.key,
      description: definition.description
    };
  }

  return table;
}

function mapStyleType(styleType: string | undefined): SharedStyle["styleType"] {
  switch (styleType) {
    case "TEXT":
      return "TEXT";
    case "EFFECT":
      return "EFFECT";
    case "GRID":
      return "GRID";
    case "STROKE":
      return "STROKE";
    default:
      return "FILL";
  }
}
