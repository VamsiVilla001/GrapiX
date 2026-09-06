import {
  createSceneId,
  type BezierPath,
  type ColorValue,
  type DesignImportReport,
  type NormalizedDesignAsset,
  type NormalizedDesignDocument,
  type NormalizedDesignEffect,
  type NormalizedDesignMask,
  type NormalizedDesignNode,
  type NormalizedDesignText,
  type NormalizedDesignNodeType,
  type NormalizedDesignPage
} from "@grapix/shared-types";
import { resolveSourceBlendMode } from "./blendModes.js";
import { addDesignImportIssue, reportImportWarning } from "./importReport.js";
import { parseSvgPathData, rectanglePath } from "./svgPath.js";

type Json = Record<string, any>;

export function importFigmaDocument(
  input: unknown,
  sourceName: string,
  report: DesignImportReport,
  sourceFormat: "figma-json",
  imageUrls: Record<string, string> = {},
  imageMapAvailable = true
): NormalizedDesignDocument {
  const root = asRecord(input);
  const documentNode = asRecord(root.document ?? root);
  if (documentNode.type !== "DOCUMENT" && !Array.isArray(documentNode.children)) {
    throw new Error("Figma import requires a REST file response or exported document JSON.");
  }
  const assets = new Map<string, NormalizedDesignAsset>();
  const components: NormalizedDesignDocument["components"] = {};
  for (const [key, value] of Object.entries(asRecord(root.components))) {
    const component = asRecord(value);
    components[key] = { name: String(component.name ?? key), nodeId: String(component.node_id ?? component.nodeId ?? key) };
  }
  for (const [key, value] of Object.entries(asRecord(root.componentSets))) {
    const component = asRecord(value);
    components[key] = { name: String(component.name ?? key), nodeId: String(component.node_id ?? component.nodeId ?? key) };
  }

  const pages: NormalizedDesignPage[] = (documentNode.children ?? [])
    .filter((child: Json) => child?.type === "CANVAS")
    .map((page: Json) => convertPage(page, report, assets, imageUrls, imageMapAvailable));
  if (!pages.length) {
    const synthetic = convertPage(
      { ...documentNode, id: documentNode.id ?? "0:0", name: root.name ?? sourceName, type: "CANVAS" },
      report,
      assets,
      imageUrls,
      imageMapAvailable
    );
    pages.push(synthetic);
  }

  return {
    schemaVersion: 1,
    sourceFormat,
    sourceName,
    sourceId: String(root.key ?? root.fileKey ?? ""),
    colorSpace: "sRGB",
    width: pages[0]?.width ?? 1920,
    height: pages[0]?.height ?? 1080,
    pages,
    assets: [...assets.values()],
    fonts: collectFonts(pages),
    components,
    variables: asRecord(root.variables ?? root.localVariables),
    sourceMetadata: {
      name: root.name,
      lastModified: root.lastModified,
      version: root.version,
      editorType: root.editorType,
      styles: root.styles ?? {}
    }
  };
}

/**
 * Convert one Figma canvas into a page whose origin is the imported content itself.
 *
 * Figma reports `absoluteBoundingBox` in **page** space, so a frame can sit at
 * y = 4875 on a busy page. Sizing the scene from those coordinates produced a
 * 4875 + 1080 = 5955-high canvas with the artwork pushed off the origin. The
 * selected root frame is the scene: its own width and height are the canvas, its
 * absolute position is the origin, and every node is expressed relative to it
 * (`localX = node.absoluteX - root.absoluteX`).
 *
 * With several roots (a whole-page import) there is no single selected frame, so the
 * origin is the top-left corner of their common bounds and the canvas is their
 * extent - never a coordinate plus a size.
 */
function convertPage(
  page: Json,
  report: DesignImportReport,
  assets: Map<string, NormalizedDesignAsset>,
  imageUrls: Record<string, string>,
  imageMapAvailable: boolean
): NormalizedDesignPage {
  const roots = array(page.children).filter((child) => child && typeof child === "object");
  const frame = pageFrame(roots);
  const children = convertChildren(roots, { pageOrigin: frame.origin }, report, assets, imageUrls, imageMapAvailable);
  const background = figmaPaintToColorValue((page.backgroundColor ? [{ type: "SOLID", color: page.backgroundColor }] : page.backgrounds)?.[0])
    ?? { type: "solid" as const, color: "#ffffff" };
  return {
    id: String(page.id ?? createSceneId("figma-page")),
    name: String(page.name ?? "Figma Page"),
    width: Math.max(1, frame.width || number(page.width, 1920)),
    height: Math.max(1, frame.height || number(page.height, 1080)),
    background,
    nodes: children,
    guides: layoutGridGuides(page.layoutGrids)
  };
}

/** The absolute rectangle a raw Figma node occupies, read the way `convertNode` reads it. */
function absoluteBox(node: Json): { x: number; y: number; width: number; height: number } {
  const box = asRecord(node.absoluteBoundingBox ?? node.absoluteRenderBounds ?? node.size);
  return {
    x: number(box.x, number(node.x)),
    y: number(box.y, number(node.y)),
    width: Math.max(0, number(box.width, number(node.width))),
    height: Math.max(0, number(box.height, number(node.height)))
  };
}

/** Scene origin and size for a canvas: the selected root frame, or the extent of several. */
function pageFrame(roots: Json[]): { origin: { x: number; y: number }; width: number; height: number } {
  const boxes = roots.map(absoluteBox).filter((box) => box.width > 0 && box.height > 0);
  if (!boxes.length) return { origin: { x: 0, y: 0 }, width: 0, height: 0 };
  if (boxes.length === 1) {
    const [only] = boxes;
    return { origin: { x: only.x, y: only.y }, width: only.width, height: only.height };
  }
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));
  return { origin: { x: minX, y: minY }, width: maxX - minX, height: maxY - minY };
}

/**
 * Convert one sibling run.
 *
 * Mask layers are *not* resolved here: `isMask` and the node's geometry travel into the normalized
 * document, and `clipResolution` turns them into masks for every importer at once. That is what
 * lets a mask group mask with the union of its children — the ad-hoc pass this replaced took the
 * group's own path, which a group does not have, so a masked logo became a masked rectangle.
 */
interface ConversionContext {
  /** Figma page-space origin that becomes the scene origin. */
  pageOrigin: { x: number; y: number };
  /** Parent-to-page affine matrix. Absent only for a page's direct children. */
  parentWorld?: Affine;
}

function convertChildren(
  children: Json[],
  context: ConversionContext,
  report: DesignImportReport,
  assets: Map<string, NormalizedDesignAsset>,
  imageUrls: Record<string, string>,
  imageMapAvailable: boolean
): NormalizedDesignNode[] {
  const result: NormalizedDesignNode[] = [];
  for (const child of children) {
    const converted = convertNode(child, context, report, assets, imageUrls, imageMapAvailable);
    if (converted) result.push(converted);
  }
  return result;
}

/**
 * One Figma node, with every layer under it.
 *
 * No depth limit and no type filter: recursion is driven by `children` alone, so a node type this
 * importer has never heard of still contributes its whole subtree. That is the rule the whole
 * importer is built on — a node may arrive approximated or rasterised, but never missing.
 */
function convertNode(
  node: Json,
  context: ConversionContext,
  report: DesignImportReport,
  assets: Map<string, NormalizedDesignAsset>,
  imageUrls: Record<string, string>,
  imageMapAvailable: boolean
): NormalizedDesignNode | null {
  if (!node || typeof node !== "object") return null;

  const sourceType = String(node.type ?? "UNKNOWN");
  const type = mapFigmaType(sourceType);
  const placement = placeNode(node, context);
  const { localX, localY, width, height, rotation, scaleX, scaleY, anchor, world } = placement;
  const fills = array(node.fills).map(figmaPaintToColorValue).filter((paint): paint is ColorValue => Boolean(paint));
  const strokes = array(node.strokes).map(figmaPaintToColorValue).filter((paint): paint is ColorValue => Boolean(paint));

  /*
   * Geometry from both lists. `geometry=paths` returns the fill outline and, separately, the
   * outline of the stroke as a filled region. Reading only `fillGeometry` lost every stroke-only
   * vector — a line drawn with no fill imported as an empty shape.
   */
  const fillGeometry = array(node.fillGeometry).flatMap((entry) => parseSvgPathData(String(entry?.path ?? "")));
  const strokeGeometry = array(node.strokeGeometry).flatMap((entry) => parseSvgPathData(String(entry?.path ?? "")));
  const geometry = fillGeometry.length > 0 ? fillGeometry : strokeGeometry;
  const localized = localizeGeometry(geometry);

  const images = collectImagePaints(
    node,
    String(node.name ?? sourceType),
    assets,
    imageUrls,
    imageMapAvailable,
    report,
    width,
    height
  );
  const children = convertChildren(
    array(node.children),
    { pageOrigin: context.pageOrigin, parentWorld: world },
    report,
    assets,
    imageUrls,
    imageMapAvailable
  );
  const effects = convertFigmaEffects(array(node.effects), report, String(node.name ?? node.id));
  const text = type === "text" ? convertFigmaText(node) : undefined;
  const componentId = String(node.componentId ?? node.id ?? "");

  if (type === "unsupported" || type === "annotation") {
    addDesignImportIssue(report, {
      kind: "converted",
      severity: "warning",
      message: `${node.name ?? sourceType} is a Figma ${sourceType}, which has no GrapiX equivalent. It was imported as a container so its ${array(node.children).length} child layer(s) survive, and it is marked for rendering as pixels.`,
      sourceNodeId: String(node.id ?? ""),
      sourceNodeName: String(node.name ?? sourceType),
      fallback: "Generic container plus a Figma render"
    });
  }

  if (hasMixedFigmaTextStyles(node)) {
    addDesignImportIssue(report, {
      kind: "visual-difference",
      severity: "warning",
      message: `${node.name ?? "Text"} has mixed Figma text styles. GrapiX currently has no per-run text model, so it uses the base style and preserves the run overrides in source metadata.`,
      sourceNodeId: String(node.id ?? ""),
      sourceNodeName: String(node.name ?? "Text"),
      fallback: "Base text style with preserved characterStyleOverrides"
    });
  }
  if (hasIndividualStrokeWeights(node)) {
    addDesignImportIssue(report, {
      kind: "visual-difference",
      severity: "warning",
      message: `${node.name ?? sourceType} has different per-side Figma stroke weights. GrapiX renders its single strokeWeight and preserves the individual values in source metadata.`,
      sourceNodeId: String(node.id ?? ""),
      sourceNodeName: String(node.name ?? sourceType),
      fallback: "Single editable stroke with preserved individualStrokeWeights"
    });
  }

  return {
    id: `figma-${String(node.id ?? createSceneId("node")).replace(/[^a-zA-Z0-9_-]/g, "-")}`,
    sourceId: String(node.id ?? ""),
    name: String(node.name ?? node.type ?? "Figma object"),
    type,
    x: localX,
    y: localY,
    width,
    height,
    rotation,
    scaleX,
    scaleY,
    anchor,
    opacity: number(node.opacity, 1),
    // Hidden layers are imported hidden, never skipped: a designer's hidden state is authored
    // information, and a layer that vanishes cannot be turned back on by an operator.
    visible: node.visible !== false,
    locked: Boolean(node.locked),
    blendMode: mapBlendMode(node.blendMode),
    fills,
    strokes,
    strokeWidth: number(node.strokeWeight),
    cornerRadius: number(node.cornerRadius),
    independentCorners: independentCorners(node),
    /*
     * No invented geometry. A vector or boolean operation whose outline Figma withheld used to get a
     * rectangle of its bounds, which is indistinguishable from a real rectangle: the layer looked
     * imported and was wrong. Leaving it undefined is what tells `figmaRestImporter` to ask Figma to
     * draw it instead.
     */
    path: localized[0],
    compoundPaths: localized.length > 1 ? localized.slice(1) : undefined,
    text,
    assetId: images.primaryAssetId,
    /*
     * The image paints this layer uses beyond the one it is drawn with. They are node fields rather
     * than provenance because they are asset *ids*: when the import stores the bytes every id is
     * rewritten, and an id hidden inside `sourceData` would be missed and left pointing at nothing.
     */
    ...(images.extraAssetIds.length ? { additionalImageAssetIds: images.extraAssetIds } : {}),
    ...(images.strokeAssetIds.length ? { strokeImageAssetIds: images.strokeAssetIds } : {}),
    masks: [],
    effects,
    children,
    layout: {
      mode: node.layoutMode === "HORIZONTAL" ? "horizontal" : node.layoutMode === "VERTICAL" ? "vertical" : "none",
      primaryAxisSizing: sizing(node.primaryAxisSizingMode),
      counterAxisSizing: sizing(node.counterAxisSizingMode),
      gap: number(node.itemSpacing),
      padding: {
        top: number(node.paddingTop),
        right: number(node.paddingRight),
        bottom: number(node.paddingBottom),
        left: number(node.paddingLeft)
      },
      constraints: asRecord(node.constraints),
      layoutGrids: array(node.layoutGrids)
    },
    componentId: type === "component" || type === "component-set" || type === "instance" ? componentId : undefined,
    componentProperties: asRecord(node.componentProperties),
    sourceType,
    /*
     * The clip group. Figma's `clipsContent` is what "Clip content" in the frame panel sets, and
     * the property that was read into `sourceData` and then ignored: children of a clipping frame
     * imported unclipped and drew outside it. `clipResolution` turns this into a mask on every
     * descendant.
     */
    clipsContent: node.clipsContent === true,
    clipCornerRadii: independentCorners(node),
    isMask: node.isMask === true,
    maskType: figmaMaskType(node.maskType),
    // Marked here, rendered later: `figmaRestImporter` asks Figma for pixels for every node
    // carrying this, because it is the set that has no faithful vector form.
    genericContainer: type === "unsupported" || type === "annotation",
    sourceData: {
      type: node.type,
      clipsContent: node.clipsContent,
      isMask: node.isMask,
      maskType: node.maskType,
      /*
       * Prototyping, verbatim.
       *
       * `interactions` is the current shape (trigger + actions, each action carrying its own
       * transition); `transitionNodeID`/`transitionDuration`/`transitionEasing` are the older
       * per-node fields Figma still returns for files authored before it. Both are kept raw
       * because `figmaPrototype.ts` reads them and because a transition type we do not
       * recognise has to reach the compatibility report by name rather than be dropped here.
       */
      interactions: node.interactions,
      transitionNodeID: node.transitionNodeID,
      transitionDuration: node.transitionDuration,
      transitionEasing: node.transitionEasing,
      relativeTransform: node.relativeTransform,
      size: node.size,
      preserveRatio: node.preserveRatio,
      layoutAlign: node.layoutAlign,
      layoutGrow: node.layoutGrow,
      layoutPositioning: node.layoutPositioning,
      minWidth: node.minWidth,
      maxWidth: node.maxWidth,
      minHeight: node.minHeight,
      maxHeight: node.maxHeight,
      strokeAlign: node.strokeAlign,
      strokeDashes: node.strokeDashes,
      strokeCap: node.strokeCap,
      strokeJoin: node.strokeJoin,
      ...(hasIndividualStrokeWeights(node) ? { individualStrokeWeights: node.individualStrokeWeights } : {}),
      ...(hasFigmaTextStyleOverrides(node)
        ? {
            characterStyleOverrides: node.characterStyleOverrides,
            styleOverrideTable: node.styleOverrideTable
          }
        : {}),
      booleanOperation: node.booleanOperation,
      characters: node.characters,
      styles: node.styles,
      boundVariables: node.boundVariables,
      exportSettings: node.exportSettings,
      /*
       * How the image is painted: scale mode, crop matrix, rotation, opacity, blend and filters.
       * A cropped photo that imports as the whole photo stretched to the box is as wrong as a
       * missing one, so the paint travels with the layer even where a renderer cannot yet apply
       * every part of it.
       */
      ...(images.primaryPaint ? { imagePaint: images.primaryPaint } : {})
    }
  };
}

type Affine = [[number, number, number], [number, number, number]];

interface NodePlacement {
  localX: number;
  localY: number;
  width: number;
  height: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  anchor: { x: number; y: number };
  world: Affine;
}

/**
 * Figma's `relativeTransform` maps a node's untransformed local space into its
 * immediate parent. Retaining that matrix avoids trying to infer local placement
 * from axis-aligned page bounds, which cannot represent a rotated/scaled parent.
 */
function placeNode(node: Json, context: ConversionContext): NodePlacement {
  const box = absoluteBox(node);
  const size = asRecord(node.size);
  const relative = affine(node.relativeTransform);
  const isPageChild = !context.parentWorld;

  if (relative) {
    const scaleX = Math.hypot(relative[0][0], relative[1][0]);
    const scaleY = Math.hypot(relative[0][1], relative[1][1]);
    const localX = relative[0][2] - (isPageChild ? context.pageOrigin.x : 0);
    const localY = relative[1][2] - (isPageChild ? context.pageOrigin.y : 0);
    return {
      localX,
      localY,
      width: Math.max(0.01, number(size.x, box.width || 1)),
      height: Math.max(0.01, number(size.y, box.height || 1)),
      rotation: Math.atan2(relative[1][0], relative[0][0]) * (180 / Math.PI),
      scaleX: scaleX || 1,
      scaleY: scaleY || 1,
      // The renderers apply T(x,y) · R · S · T(-anchor), and Figma's affine maps the
      // node's local origin through the rotation, so the translation is the rotated
      // top-left only when the pivot is the node's own centre. A zero anchor would
      // swing every rotated layer by half its extent.
      anchor: {
        x: Math.max(0.01, number(size.x, box.width || 1)) / 2,
        y: Math.max(0.01, number(size.y, box.height || 1)) / 2
      },
      world: context.parentWorld ? multiplyAffine(context.parentWorld, relative) : relative
    };
  }

  // Exported JSON occasionally omits relativeTransform. In that case, recover
  // the local top-left by applying the inverse parent matrix to page-space bounds.
  const point = context.parentWorld
    ? transformPoint(invertAffine(context.parentWorld), { x: box.x, y: box.y })
    : { x: box.x - context.pageOrigin.x, y: box.y - context.pageOrigin.y };
  const local: Affine = [[1, 0, point.x], [0, 1, point.y]];
  return {
    localX: point.x,
    localY: point.y,
    width: Math.max(0.01, box.width || 1),
    height: Math.max(0.01, box.height || 1),
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    anchor: { x: 0, y: 0 },
    world: context.parentWorld
      ? multiplyAffine(context.parentWorld, local)
      : [[1, 0, box.x], [0, 1, box.y]]
  };
}

function affine(value: unknown): Affine | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const first = value[0];
  const second = value[1];
  if (!Array.isArray(first) || !Array.isArray(second) || first.length !== 3 || second.length !== 3) return null;
  const values = [...first, ...second].map(Number);
  if (!values.every(Number.isFinite)) return null;
  return [[values[0], values[1], values[2]], [values[3], values[4], values[5]]];
}

function multiplyAffine(parent: Affine, local: Affine): Affine {
  return [
    [
      parent[0][0] * local[0][0] + parent[0][1] * local[1][0],
      parent[0][0] * local[0][1] + parent[0][1] * local[1][1],
      parent[0][0] * local[0][2] + parent[0][1] * local[1][2] + parent[0][2]
    ],
    [
      parent[1][0] * local[0][0] + parent[1][1] * local[1][0],
      parent[1][0] * local[0][1] + parent[1][1] * local[1][1],
      parent[1][0] * local[0][2] + parent[1][1] * local[1][2] + parent[1][2]
    ]
  ];
}

function invertAffine(matrix: Affine): Affine {
  const determinant = matrix[0][0] * matrix[1][1] - matrix[0][1] * matrix[1][0];
  if (Math.abs(determinant) < 1e-9) {
    // A singular Figma transform cannot be inverted; retaining its translation is
    // the only deterministic fallback and avoids producing NaN scene coordinates.
    return [[1, 0, -matrix[0][2]], [0, 1, -matrix[1][2]]];
  }
  const inverse = 1 / determinant;
  const a = matrix[1][1] * inverse;
  const b = -matrix[0][1] * inverse;
  const c = -matrix[1][0] * inverse;
  const d = matrix[0][0] * inverse;
  return [[a, b, -(a * matrix[0][2] + b * matrix[1][2])], [c, d, -(c * matrix[0][2] + d * matrix[1][2])]];
}

function transformPoint(matrix: Affine, point: { x: number; y: number }): { x: number; y: number } {
  return {
    x: matrix[0][0] * point.x + matrix[0][1] * point.y + matrix[0][2],
    y: matrix[1][0] * point.x + matrix[1][1] * point.y + matrix[1][2]
  };
}

interface CollectedImages {
  /** The fill image the object is drawn with. */
  primaryAssetId?: string;
  /** Further image fills, kept in the library and named in the layer's source metadata. */
  extraAssetIds: string[];
  /** Image strokes. GrapiX strokes are paint, not texture, so these are library-only. */
  strokeAssetIds: string[];
  /**
   * How the primary image fill is painted, verbatim from Figma.
   *
   * `scaleMode`, the crop matrix, rotation, opacity, blend mode and filters travel with the object.
   * Without them a cropped photo imports as the whole photo stretched to the box — the most common
   * complaint after "the image is missing", and just as wrong.
   */
  primaryPaint?: ImagePaintProperties;
}

export interface ImagePaintProperties {
  /** `FILL`, `FIT`, `CROP`, `TILE`. */
  scaleMode?: string;
  /** Figma's 2x3 crop matrix, present when `scaleMode` is `CROP`. */
  imageTransform?: number[][];
  /** Tile scale, present when `scaleMode` is `TILE`. */
  scalingFactor?: number;
  rotation?: number;
  opacity?: number;
  blendMode?: string;
  /** Exposure, contrast, saturation, temperature, tint, highlights, shadows. */
  filters?: Record<string, number>;
}

/**
 * Every image paint on a node, from fills **and** strokes.
 *
 * Only the first image fill was collected before, so a layer with two image fills lost one and an
 * image *stroke* was lost entirely — silently, because nothing recorded that the paint existed.
 * Each `imageRef` becomes one asset, deduplicated across the document: Figma reuses a ref wherever
 * the same bitmap is placed, and downloading it once per layer would fetch the same bytes ten times.
 */
function collectImagePaints(
  node: Json,
  nodeName: string,
  assets: Map<string, NormalizedDesignAsset>,
  imageUrls: Record<string, string>,
  imageMapAvailable: boolean,
  report: DesignImportReport,
  width: number,
  height: number
): CollectedImages {
  const collected: CollectedImages = { extraAssetIds: [], strokeAssetIds: [] };

  const register = (paint: Json, role: "fill" | "stroke"): string | undefined => {
    const ref = String(paint.imageRef ?? "");
    if (!ref) return undefined;
    const assetId = `figma-image-${ref}`;
    if (!assets.has(assetId)) {
      const sourceUrl = imageUrls[ref];
      assets.set(assetId, {
        id: assetId,
        name: `${nodeName}.png`,
        kind: "image",
        mimeType: "image/png",
        ...(sourceUrl ? { sourceUrl } : {}),
        linked: Boolean(sourceUrl),
        width,
        height
      });
      if (!sourceUrl) {
        // Not fatal: `figmaRestImporter` renders the node itself as a second chance before the
        // import gives up on the pixels.
        reportImportWarning(
          report,
          imageMapAvailable
            ? `The ${role} image on ${nodeName} (ref ${ref}) is not in this file's image map.`
            : `The ${role} image on ${nodeName} (ref ${ref}) could not be resolved because Figma's file image-map endpoint failed.`,
          "missing-asset",
          nodeName
        );
      }
    }
    return assetId;
  };

  for (const paint of array(node.fills)) {
    if (paint?.type !== "IMAGE") continue;
    const assetId = register(paint, "fill");
    if (!assetId) continue;
    if (!collected.primaryAssetId) {
      collected.primaryAssetId = assetId;
      // The topmost image fill is the one the object is drawn with, so its paint properties are the
      // ones that decide how it looks.
      collected.primaryPaint = imagePaintProperties(paint);
    } else if (!collected.extraAssetIds.includes(assetId)) {
      collected.extraAssetIds.push(assetId);
    }
  }

  for (const paint of array(node.strokes)) {
    if (paint?.type !== "IMAGE") continue;
    const assetId = register(paint, "stroke");
    if (!assetId || collected.strokeAssetIds.includes(assetId)) continue;
    collected.strokeAssetIds.push(assetId);
    reportImportWarning(
      report,
      `${nodeName} is stroked with an image. The image is in the asset library, but a GrapiX stroke is paint rather than a texture, so the stroke imports as its average colour.`,
      "visual-difference",
      nodeName,
      "Image kept in the asset library"
    );
  }

  if (collected.extraAssetIds.length > 0) {
    reportImportWarning(
      report,
      `${nodeName} has ${collected.extraAssetIds.length + 1} image fills stacked. GrapiX draws one image per object, so the topmost is used and the rest are in the asset library.`,
      "visual-difference",
      nodeName,
      "First image fill"
    );
  }

  return collected;
}

/**
 * The properties that decide how an image paint looks, kept verbatim.
 *
 * Figma's own names and shapes, not a translation: `imageTransform` is its 2x3 crop matrix and the
 * filter values are its -1..1 scale. Converting them here would bake in one interpretation; keeping
 * them lets the object carry the truth and each renderer apply what it can.
 */
function imagePaintProperties(paint: Json): ImagePaintProperties {
  const filters = asRecord(paint.filters);
  const kept: Record<string, number> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (Number.isFinite(Number(value)) && Number(value) !== 0) kept[key] = Number(value);
  }

  return {
    ...(paint.scaleMode ? { scaleMode: String(paint.scaleMode) } : {}),
    ...(Array.isArray(paint.imageTransform) ? { imageTransform: paint.imageTransform as number[][] } : {}),
    ...(Number.isFinite(Number(paint.scalingFactor)) ? { scalingFactor: Number(paint.scalingFactor) } : {}),
    ...(Number.isFinite(Number(paint.rotation)) && Number(paint.rotation) !== 0
      ? { rotation: Number(paint.rotation) }
      : {}),
    ...(Number.isFinite(Number(paint.opacity)) && Number(paint.opacity) !== 1
      ? { opacity: Number(paint.opacity) }
      : {}),
    ...(paint.blendMode && paint.blendMode !== "NORMAL" ? { blendMode: String(paint.blendMode) } : {}),
    ...(Object.keys(kept).length ? { filters: kept } : {})
  };
}

function convertFigmaText(node: Json): NormalizedDesignNode["text"] {
  const style = asRecord(node.style);
  const family = String(style.fontFamily ?? "Inter");
  return {
    characters: String(node.characters ?? ""),
    fontFamily: family,
    fontStyle: /italic/i.test(String(style.fontPostScriptName ?? "")) ? "italic" : "normal",
    fontWeight: fontWeight(style.fontWeight),
    fontSize: number(style.fontSize, 16),
    lineHeight: style.lineHeightPx ? number(style.lineHeightPx) : number(style.fontSize, 16) * 1.2,
    letterSpacing: number(style.letterSpacing),
    paragraphSpacing: number(style.paragraphSpacing),
    align: style.textAlignHorizontal === "CENTER" ? "center" : style.textAlignHorizontal === "RIGHT" ? "right" : "left",
    verticalAlign: style.textAlignVertical === "CENTER" ? "middle" : style.textAlignVertical === "BOTTOM" ? "bottom" : "top",
    writingMode: style.textDirection === "VERTICAL" ? "vertical-rl" : "horizontal-tb",
    textLayout: node.style?.textAutoResize === "WIDTH_AND_HEIGHT" ? "point" : "paragraph",
    direction: style.textDirection === "RTL" ? "rtl" : "ltr",
    textCase: figmaTextCase(style.textCase),
    ...figmaTextDecoration(style.textDecoration)
  };
}

/**
 * Figma's `textCase` as GrapiX's.
 *
 * A designer sets this and types nothing differently: the layer holds "mvp" and the canvas reads MVP.
 * Reading only `characters` therefore imports lower-case text for every upper-cased layer in the
 * file — which is what "text transforms are not applying" means — and once the case is dropped there
 * is nothing left in the document to recover it from.
 */
function figmaTextCase(value: unknown): NormalizedDesignText["textCase"] {
  switch (String(value ?? "ORIGINAL").toUpperCase()) {
    case "UPPER":
      return "upper";
    case "LOWER":
      return "lower";
    case "TITLE":
      return "title";
    case "SMALL_CAPS":
    case "SMALL_CAPS_FORCED":
      return "small-caps";
    default:
      return "original";
  }
}

/** Preserve every Figma text override even though the normalized model has one text style. */
function hasFigmaTextStyleOverrides(node: Json): boolean {
  return Array.isArray(node.characterStyleOverrides) || Object.keys(asRecord(node.styleOverrideTable)).length > 0;
}

/** More than one override id means a single base style cannot reproduce every character. */
function hasMixedFigmaTextStyles(node: Json): boolean {
  if (!Array.isArray(node.characterStyleOverrides)) return false;
  return new Set(node.characterStyleOverrides.map((value) => String(value))).size > 1;
}

function hasIndividualStrokeWeights(node: Json): boolean {
  const weights = node.individualStrokeWeights;
  const values = Array.isArray(weights)
    ? weights
    : Object.values(asRecord(weights));
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length > 1 && finite.some((value) => value !== finite[0]);
}

/** Figma's `textDecoration`. Absent when there is none, so it never adds noise to a scene. */
function figmaTextDecoration(
  value: unknown
): { textDecoration: { underline?: boolean; strikethrough?: boolean } } | undefined {
  switch (String(value ?? "NONE").toUpperCase()) {
    case "UNDERLINE":
      return { textDecoration: { underline: true } };
    case "STRIKETHROUGH":
      return { textDecoration: { strikethrough: true } };
    default:
      return undefined;
  }
}

function figmaPaintToColorValue(paint: Json | undefined): ColorValue | null {
  if (!paint || paint.visible === false) return null;
  if (paint.type === "SOLID") {
    return { type: "solid", color: rgbaHex(paint.color, number(paint.opacity, 1)) };
  }
  if (paint.type === "GRADIENT_LINEAR" || paint.type === "GRADIENT_RADIAL" || paint.type === "GRADIENT_ANGULAR" || paint.type === "GRADIENT_DIAMOND") {
    const paintOpacity = number(paint.opacity, 1);
    const stops = array(paint.gradientStops).map((stop, index) => {
      // GrapiX keeps gradient RGB and opacity separately. Figma's effective stop
      // alpha is `stop.color.a × paint.opacity`; keeping the product in `opacity`
      // avoids applying either factor twice in renderers.
      const alpha = Math.min(1, Math.max(0, number(stop.color?.a, 1) * paintOpacity));
      return {
        id: createSceneId(`figma-stop-${index}`),
        position: number(stop.position),
        color: rgbaHex({ ...asRecord(stop.color), a: 1 }, 1),
        opacity: alpha
      };
    });
    const handles = array(paint.gradientHandlePositions);
    if (paint.type === "GRADIENT_LINEAR") {
      return {
        type: "linear-gradient",
        angle: 0,
        startX: number(handles[0]?.x),
        startY: number(handles[0]?.y, 0.5),
        endX: number(handles[1]?.x, 1),
        endY: number(handles[1]?.y, 0.5),
        stops,
        spread: "pad",
        coordinateMode: "object"
      };
    }
    return {
      type: "radial-gradient",
      centerX: number(handles[0]?.x, 0.5),
      centerY: number(handles[0]?.y, 0.5),
      radiusX: distance(handles[0], handles[1], 0.5),
      radiusY: distance(handles[0], handles[2], 0.5),
      stops,
      spread: "pad",
      coordinateMode: "object"
    };
  }
  return null;
}

function convertFigmaEffects(effects: Json[], report: DesignImportReport, name: string): NormalizedDesignEffect[] {
  return effects.map((effect) => {
    const type = effect.type === "DROP_SHADOW" ? "drop-shadow"
      : effect.type === "INNER_SHADOW" ? "inner-shadow"
        : effect.type === "LAYER_BLUR" ? "layer-blur"
          : effect.type === "BACKGROUND_BLUR" ? "background-blur"
            : "unknown";
    reportImportWarning(
      report,
      type === "unknown"
        ? `Figma effect ${effect.type} on ${name} is preserved as source metadata but is not rendered yet.`
        : `Figma ${type} on ${name} remains editable after import, but current canvas and output renderers do not reproduce it yet.`,
      type === "unknown" ? "unsupported-effect" : "visual-difference",
      name,
      "Editable imported effect metadata"
    );
    return {
      type,
      enabled: effect.visible !== false,
      opacity: number(effect.color?.a, 1),
      color: effect.color ? rgbaHex(effect.color, 1) : undefined,
      offset: effect.offset ? { x: number(effect.offset.x), y: number(effect.offset.y) } : undefined,
      radius: number(effect.radius),
      spread: number(effect.spread),
      blendMode: mapBlendMode(effect.blendMode),
      sourceData: effect
    };
  });
}

/**
 * Every Figma node type, mapped explicitly.
 *
 * The table used to end in `return "group"`, which quietly turned a sticky note, a connector, a
 * table and anything Figma adds next into an empty group — no geometry, no report, nothing for an
 * author to notice. Each family now maps to the closest GrapiX shape, and `figmaTypeIsKnown` tells
 * the caller whether the mapping was a real match or the fallback.
 */
export function mapFigmaType(type: string): NormalizedDesignNodeType {
  switch (type) {
    case "TEXT":
      return "text";
    case "RECTANGLE":
      return "rectangle";
    case "ELLIPSE":
      return "ellipse";
    case "LINE":
      return "line";
    case "VECTOR":
    case "STAR":
    case "REGULAR_POLYGON":
    case "POLYGON":
      return "path";
    case "BOOLEAN_OPERATION":
      // Figma resolves the operation and publishes the result as `fillGeometry`, so the outcome is
      // a path. The operands stay as children for an author who wants to rebuild it.
      return "boolean-operation";
    case "FRAME":
      return "frame";
    case "SECTION":
      return "section";
    case "GROUP":
      return "group";
    case "COMPONENT":
      return "component";
    case "COMPONENT_SET":
      return "component-set";
    case "INSTANCE":
      return "instance";
    case "SLICE":
      return "slice";
    case "CANVAS":
    case "DOCUMENT":
      return "artboard";
    // FigJam and widgets. They have bounds and a name; GrapiX renders none of them natively.
    case "STICKY":
    case "SHAPE_WITH_TEXT":
    case "CONNECTOR":
    case "STAMP":
    case "WASHI_TAPE":
    case "TABLE":
    case "TABLE_CELL":
    case "CODE_BLOCK":
    case "WIDGET":
    case "EMBED":
    case "LINK_UNFURL":
    case "MEDIA":
    case "HIGHLIGHT":
      return "annotation";
    default:
      return "unsupported";
  }
}

/** Whether the mapping above was a real match rather than the `unsupported` fallback. */
export function figmaTypeIsKnown(type: string): boolean {
  return mapFigmaType(type) !== "unsupported";
}

function figmaMaskType(value: unknown): NormalizedDesignNode["maskType"] {
  const raw = String(value ?? "").toUpperCase();
  if (raw === "ALPHA") return "alpha";
  if (raw === "LUMINANCE") return "luminance";
  // Figma's default, and the only kind a vector mask reproduces exactly.
  return "vector";
}

function mapBlendMode(value: unknown): NormalizedDesignNode["blendMode"] {
  return resolveSourceBlendMode(String(value ?? "NORMAL").toLowerCase()).mode;
}

function offsetPath(path: BezierPath, x: number, y: number): BezierPath {
  return { ...path, vertices: path.vertices.map((point) => ({ x: point.x + x, y: point.y + y })) };
}

/**
 * Put a node's parsed geometry in the node's own space, by its own bounds.
 *
 * `geometry=paths` returns each outline in the node's *unrotated local* space — but with an origin
 * that is not the node's. In a real 1920x1080 board the outlines came back around x=14590 for every
 * layer regardless of where that layer sat, so subtracting the node's absolute position (which is
 * what this used to do) left a frame's clip outline ten thousand pixels off the canvas. Nothing drew,
 * and a clip built from that outline masked every layer beneath it away.
 *
 * The reliable fact is the *shape*: across that file the outline's extent matched the node's own
 * width and height on 40 of 42 vector layers, and matched `size` exactly on every rotated one — so
 * the outline is the node's, only translated. Re-originating it to its own bounding box is therefore
 * exact and cannot be off by an unbounded amount, whatever space the source chose.
 *
 * All of a node's subpaths move together: a compound path or a boolean operation is one shape, and
 * shifting each subpath to its own origin would collapse them onto each other.
 *
 * The one imprecision: geometry smaller than its box (a stroke-only icon) loses the inset between
 * the two, at most half a stroke width.
 */
function localizeGeometry(paths: BezierPath[]): BezierPath[] {
  if (paths.length === 0) return paths;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  for (const path of paths) {
    for (const point of path.vertices) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return paths;
  if (minX === 0 && minY === 0) return paths;

  return paths.map((path) => offsetPath(path, -minX, -minY));
}

function collectFonts(pages: NormalizedDesignPage[]) {
  const families = new Set<string>();
  const walk = (nodes: NormalizedDesignNode[]) => nodes.forEach((node) => {
    if (node.text?.fontFamily) families.add(node.text.fontFamily);
    walk(node.children);
  });
  pages.forEach((page) => walk(page.nodes));
  return [...families].map((family) => ({ family, sourceName: family }));
}

function layoutGridGuides(grids: unknown): NormalizedDesignPage["guides"] {
  return array(grids)
    .filter((grid) => grid?.pattern === "ROWS" || grid?.pattern === "COLUMNS")
    .map((grid) => ({
      orientation: grid.pattern === "ROWS" ? "horizontal" as const : "vertical" as const,
      position: number(grid.offset)
    }));
}

function independentCorners(node: Json): [number, number, number, number] | undefined {
  const values = [node.topLeftRadius, node.topRightRadius, node.bottomRightRadius, node.bottomLeftRadius];
  return values.some((value) => Number.isFinite(value))
    ? values.map((value) => number(value)) as [number, number, number, number]
    : undefined;
}

function sizing(value: unknown): "fixed" | "hug" | "fill" {
  return value === "AUTO" ? "hug" : value === "FILL" ? "fill" : "fixed";
}

function fontWeight(value: unknown): "400" | "500" | "600" | "700" | "800" {
  const weight = Math.round(number(value, 400) / 100) * 100;
  return String(Math.min(800, Math.max(400, weight))) as "400" | "500" | "600" | "700" | "800";
}

function rgbaHex(color: Json | undefined, opacity: number): string {
  const red = Math.round(number(color?.r) * 255);
  const green = Math.round(number(color?.g) * 255);
  const blue = Math.round(number(color?.b) * 255);
  const alpha = Math.round(number(color?.a, 1) * opacity * 255);
  return `#${hex(red)}${hex(green)}${hex(blue)}${alpha < 255 ? hex(alpha) : ""}`;
}

function hex(value: number): string {
  return Math.min(255, Math.max(0, value)).toString(16).padStart(2, "0");
}

function distance(left: Json | undefined, right: Json | undefined, fallback: number): number {
  if (!left || !right) return fallback;
  return Math.max(0.001, Math.hypot(number(right.x) - number(left.x), number(right.y) - number(left.y)));
}

function asRecord(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function array(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((item): item is Json => Boolean(item) && typeof item === "object") : [];
}

function number(value: unknown, fallback = 0): number {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}
