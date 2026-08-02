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
  imageUrls: Record<string, string> = {}
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
    .map((page: Json) => convertPage(page, report, assets, imageUrls));
  if (!pages.length) {
    const synthetic = convertPage({ ...documentNode, id: documentNode.id ?? "0:0", name: root.name ?? sourceName, type: "CANVAS" }, report, assets, imageUrls);
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
  imageUrls: Record<string, string>
): NormalizedDesignPage {
  const roots = array(page.children).filter((child) => child && typeof child === "object");
  const frame = pageFrame(roots);
  const children = convertChildren(roots, frame.origin, report, assets, imageUrls);
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

function convertChildren(
  children: Json[],
  parentOrigin: { x: number; y: number },
  report: DesignImportReport,
  assets: Map<string, NormalizedDesignAsset>,
  imageUrls: Record<string, string>
): NormalizedDesignNode[] {
  const result: NormalizedDesignNode[] = [];
  let activeMask: NormalizedDesignMask | null = null;
  for (const child of children) {
    const converted = convertNode(child, parentOrigin, report, assets, imageUrls);
    if (!converted) continue;
    if (child.isMask) {
      activeMask = nodeAsMask(converted);
      addDesignImportIssue(report, {
        kind: "converted",
        severity: "info",
        message: `Converted Figma mask ${converted.name} to an editable GrapiX mask.`,
        sourceNodeId: converted.sourceId,
        sourceNodeName: converted.name
      });
      continue;
    }
    if (activeMask) converted.masks = [structuredClone(activeMask), ...converted.masks];
    result.push(converted);
  }
  return result;
}

function convertNode(
  node: Json,
  parentOrigin: { x: number; y: number },
  report: DesignImportReport,
  assets: Map<string, NormalizedDesignAsset>,
  imageUrls: Record<string, string>
): NormalizedDesignNode | null {
  if (!node || typeof node !== "object") return null;
  const box = asRecord(node.absoluteBoundingBox ?? node.absoluteRenderBounds ?? node.size);
  const absoluteX = number(box.x, number(node.x));
  const absoluteY = number(box.y, number(node.y));
  const width = Math.max(0.01, number(box.width, number(node.width, 1)));
  const height = Math.max(0.01, number(box.height, number(node.height, 1)));
  const type = mapFigmaType(String(node.type ?? "UNSUPPORTED"));
  const fills = array(node.fills).map(figmaPaintToColorValue).filter((paint): paint is ColorValue => Boolean(paint));
  const strokes = array(node.strokes).map(figmaPaintToColorValue).filter((paint): paint is ColorValue => Boolean(paint));
  const geometry = array(node.fillGeometry).flatMap((entry) => parseSvgPathData(String(entry?.path ?? "")));
  const localized = geometry.map((path) => offsetPath(path, -absoluteX, -absoluteY));
  const imagePaint = array(node.fills).find((paint) => paint?.type === "IMAGE" && paint.imageRef);
  let assetId: string | undefined;
  if (imagePaint?.imageRef) {
    assetId = `figma-image-${imagePaint.imageRef}`;
    if (!assets.has(assetId)) {
      const sourceUrl = imageUrls[imagePaint.imageRef];
      assets.set(assetId, {
        id: assetId,
        name: `${node.name ?? "Figma image"}.png`,
        kind: "image",
        mimeType: "image/png",
        sourceUrl,
        linked: Boolean(sourceUrl),
        width,
        height
      });
      if (!sourceUrl) {
        reportImportWarning(report, `Image fill ${node.name ?? imagePaint.imageRef} has no exported data or API image URL.`, "missing-asset", String(node.name ?? imagePaint.imageRef));
      }
    }
  }
  const children = convertChildren(array(node.children), { x: absoluteX, y: absoluteY }, report, assets, imageUrls);
  const effects = convertFigmaEffects(array(node.effects), report, String(node.name ?? node.id));
  const text = type === "text" ? convertFigmaText(node) : undefined;
  const componentId = String(node.componentId ?? node.id ?? "");

  return {
    id: `figma-${String(node.id ?? createSceneId("node")).replace(/[^a-zA-Z0-9_-]/g, "-")}`,
    sourceId: String(node.id ?? ""),
    name: String(node.name ?? node.type ?? "Figma object"),
    type,
    x: absoluteX - parentOrigin.x,
    y: absoluteY - parentOrigin.y,
    width,
    height,
    rotation: number(node.rotation),
    scaleX: 1,
    scaleY: 1,
    anchor: { x: 0, y: 0 },
    opacity: number(node.opacity, 1),
    visible: node.visible !== false,
    locked: Boolean(node.locked),
    blendMode: mapBlendMode(node.blendMode),
    fills,
    strokes,
    strokeWidth: number(node.strokeWeight),
    cornerRadius: number(node.cornerRadius),
    independentCorners: independentCorners(node),
    path: localized[0] ?? (type === "path" ? rectanglePath(width, height) : undefined),
    compoundPaths: localized.length > 1 ? localized.slice(1) : undefined,
    text,
    assetId,
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
    sourceData: {
      type: node.type,
      clipsContent: node.clipsContent,
      preserveRatio: node.preserveRatio,
      layoutAlign: node.layoutAlign,
      layoutGrow: node.layoutGrow,
      layoutPositioning: node.layoutPositioning,
      minWidth: node.minWidth,
      maxWidth: node.maxWidth,
      minHeight: node.minHeight,
      maxHeight: node.maxHeight,
      boundVariables: node.boundVariables,
      exportSettings: node.exportSettings
    }
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
    direction: style.textDirection === "RTL" ? "rtl" : "ltr"
  };
}

function figmaPaintToColorValue(paint: Json | undefined): ColorValue | null {
  if (!paint || paint.visible === false) return null;
  if (paint.type === "SOLID") {
    return { type: "solid", color: rgbaHex(paint.color, number(paint.opacity, 1)) };
  }
  if (paint.type === "GRADIENT_LINEAR" || paint.type === "GRADIENT_RADIAL" || paint.type === "GRADIENT_ANGULAR" || paint.type === "GRADIENT_DIAMOND") {
    const stops = array(paint.gradientStops).map((stop, index) => ({
      id: createSceneId(`figma-stop-${index}`),
      position: number(stop.position),
      color: rgbaHex(stop.color, 1),
      opacity: number(stop.color?.a, 1)
    }));
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

function nodeAsMask(node: NormalizedDesignNode): NormalizedDesignMask {
  return {
    id: createSceneId("figma-mask"),
    name: node.name,
    path: node.path ?? rectanglePath(node.width, node.height),
    mode: "add",
    inverted: false,
    opacity: node.opacity,
    feather: { x: 0, y: 0 },
    expansion: 0
  };
}

function mapFigmaType(type: string): NormalizedDesignNodeType {
  if (type === "TEXT") return "text";
  if (type === "RECTANGLE") return "rectangle";
  if (type === "ELLIPSE") return "ellipse";
  if (type === "LINE") return "line";
  if (["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON"].includes(type)) return "path";
  if (type === "FRAME" || type === "SECTION") return "frame";
  if (type === "GROUP") return "group";
  if (type === "COMPONENT") return "component";
  if (type === "COMPONENT_SET") return "component-set";
  if (type === "INSTANCE") return "instance";
  if (type === "SLICE") return "unsupported";
  return "group";
}

function mapBlendMode(value: unknown): NormalizedDesignNode["blendMode"] {
  return resolveSourceBlendMode(String(value ?? "NORMAL").toLowerCase()).mode;
}

function offsetPath(path: BezierPath, x: number, y: number): BezierPath {
  return { ...path, vertices: path.vertices.map((point) => ({ x: point.x + x, y: point.y + y })) };
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
