import { createCanvas } from "@napi-rs/canvas";
import { XMLParser } from "fast-xml-parser";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  bezierPathBounds,
  createSceneId,
  type BezierPath,
  type ColorValue,
  type DesignImportReport,
  type NormalizedDesignAsset,
  type NormalizedDesignDocument,
  type NormalizedDesignMask,
  type NormalizedDesignNode,
  type NormalizedDesignNodeType,
  type NormalizedDesignPage
} from "@grapix/shared-types";
import { addDesignImportIssue, reportImportWarning } from "./importReport.js";
import { parseSvgPathData, rectanglePath } from "./svgPath.js";

type XmlNode = Record<string, any>;
type Attributes = Record<string, string>;

export async function importIllustratorDocument(
  bytes: Buffer,
  sourceName: string,
  report: DesignImportReport
): Promise<NormalizedDesignDocument> {
  const source = bytes.toString("utf8", 0, Math.min(bytes.length, 4096));
  if (/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(source) || /\.svg$/i.test(sourceName)) {
    return importSvgDocument(bytes.toString("utf8"), sourceName, report, /\.ai$/i.test(sourceName) ? "ai" : "svg");
  }
  if (source.startsWith("%PDF-") || /\.ai$/i.test(sourceName) || /\.pdf$/i.test(sourceName)) {
    return importPdfCompatibleAi(bytes, sourceName, report);
  }
  throw new Error("Illustrator import requires PDF-compatible AI data or an SVG export.");
}

export function importSvgDocument(
  xml: string,
  sourceName: string,
  report: DesignImportReport,
  sourceFormat: "svg" | "ai" = "svg"
): NormalizedDesignDocument {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    preserveOrder: true,
    trimValues: false,
    parseTagValue: false,
    processEntities: false
  });
  const parsed = parser.parse(xml) as XmlNode[];
  const svg = findTag(parsed, "svg");
  if (!svg) throw new Error("The selected SVG/AI export has no SVG document root.");
  const attrs = attributes(svg);
  const width = dimension(attrs.width, viewBox(attrs)[2] || 1920);
  const height = dimension(attrs.height, viewBox(attrs)[3] || 1080);
  const gradients = collectGradients(svg.svg ?? []);
  const clipPaths = collectClipPaths(svg.svg ?? []);
  const assets = new Map<string, NormalizedDesignAsset>();
  const nodes = convertSvgChildren(svg.svg ?? [], { x: 0, y: 0 }, gradients, clipPaths, assets, report);
  const artboards = nodes.filter((node) => node.type === "artboard" || node.sourceData?.tag === "artboard");
  const pages: NormalizedDesignPage[] = artboards.length
    ? artboards.map((artboard) => ({
        id: artboard.id,
        name: artboard.name,
        width: artboard.width,
        height: artboard.height,
        background: artboard.fills[0] ?? { type: "none" },
        nodes: artboard.children
      }))
    : [{
        id: "svg-artboard-1",
        name: sourceName.replace(/\.[^.]+$/, ""),
        width,
        height,
        background: parsePaint(attrs.style ? parseStyle(attrs.style).background : attrs.fill, gradients) ?? { type: "none" },
        nodes
      }];

  return {
    schemaVersion: 1,
    sourceFormat,
    sourceName,
    colorSpace: attrs["color-interpolation"] ?? "sRGB",
    width,
    height,
    pages,
    assets: [...assets.values()],
    fonts: collectFonts(pages),
    components: collectComponents(nodes),
    variables: {},
    sourceMetadata: {
      viewBox: attrs.viewBox,
      preserveAspectRatio: attrs.preserveAspectRatio,
      generator: attrs["data-name"] ?? attrs.id
    }
  };
}

async function importPdfCompatibleAi(
  bytes: Buffer,
  sourceName: string,
  report: DesignImportReport
): Promise<NormalizedDesignDocument> {
  const pdf = await getDocument({ data: new Uint8Array(bytes) }).promise;
  const assets: NormalizedDesignAsset[] = [];
  const pages: NormalizedDesignPage[] = [];
  for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex += 1) {
    const page = await pdf.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    await page.render({ canvas: canvas as any, canvasContext: context as any, viewport }).promise;
    const assetId = `ai-artboard-${pageIndex + 1}-reference`;
    assets.push({
      id: assetId,
      name: `${sourceName.replace(/\.[^.]+$/, "")}-artboard-${pageIndex + 1}.png`,
      kind: "image",
      mimeType: "image/png",
      dataBase64: canvas.toBuffer("image/png").toString("base64"),
      width: viewport.width,
      height: viewport.height
    });
    const textContent = await page.getTextContent();
    const editableText: NormalizedDesignNode[] = textContent.items
      .filter((item): item is typeof item & { str: string; transform: number[]; width: number; height: number; fontName: string } => "str" in item)
      .map((item, index) => ({
        ...baseNode(`ai-text-${pageIndex + 1}-${index}`, item.str || `Text ${index + 1}`, "text"),
        x: item.transform[4],
        y: viewport.height - item.transform[5] - Math.max(1, item.height),
        width: Math.max(1, item.width),
        height: Math.max(1, item.height),
        opacity: 0,
        fills: [{ type: "solid", color: "#000000" }],
        text: {
          characters: item.str,
          fontFamily: item.fontName || "Arial",
          fontWeight: "400",
          fontSize: Math.max(1, Math.hypot(item.transform[0], item.transform[1])),
          lineHeight: Math.max(1, item.height),
          letterSpacing: 0,
          paragraphSpacing: 0,
          align: "left",
          textLayout: "point",
          writingMode: "horizontal-tb",
          direction: "ltr"
        },
        sourceData: { pdfTextTransform: item.transform, hiddenEditableReference: true }
      }));
    pages.push({
      id: `ai-artboard-${pageIndex + 1}`,
      name: `Artboard ${pageIndex + 1}`,
      width: viewport.width,
      height: viewport.height,
      background: { type: "solid", color: "#ffffff" },
      nodes: [
        {
          ...baseNode(`ai-reference-${pageIndex + 1}`, `Artboard ${pageIndex + 1} Reference`, "image"),
          width: viewport.width,
          height: viewport.height,
          assetId,
          sourceData: { rasterFallback: true, pdfPage: pageIndex + 1 }
        },
        ...editableText
      ]
    });
    addDesignImportIssue(report, {
      kind: "rasterized",
      severity: "warning",
      message: `AI artboard ${pageIndex + 1} uses a reference raster because its PDF operators cannot all be represented exactly yet; extracted text is retained as hidden editable objects.`,
      sourceNodeName: `Artboard ${pageIndex + 1}`,
      fallback: "Per-artboard reference raster plus editable text metadata"
    });
  }
  reportImportWarning(report, "For fully editable Illustrator vectors, save the AI file with compatible SVG data or import an SVG export.", "visual-difference", sourceName);
  return {
    schemaVersion: 1,
    sourceFormat: "ai",
    sourceName,
    colorSpace: "Unknown PDF profile",
    width: pages[0]?.width ?? 1920,
    height: pages[0]?.height ?? 1080,
    pages,
    assets,
    fonts: collectFonts(pages),
    components: {},
    variables: {},
    sourceMetadata: { pdfPages: pdf.numPages, pdfCompatible: true }
  };
}

function convertSvgChildren(
  nodes: XmlNode[],
  parentOrigin: { x: number; y: number },
  gradients: Map<string, ColorValue>,
  clipPaths: Map<string, BezierPath>,
  assets: Map<string, NormalizedDesignAsset>,
  report: DesignImportReport
): NormalizedDesignNode[] {
  const result: NormalizedDesignNode[] = [];
  for (const raw of nodes) {
    const tag = tagName(raw);
    if (!tag || ["defs", "linearGradient", "radialGradient", "clipPath", "style", "metadata", "title", "desc"].includes(tag)) continue;
    const attrs = attributes(raw);
    const style = { ...parseStyle(attrs.style), ...attrs };
    const transform = parseTransform(style.transform);
    const id = `svg-${safeId(style.id ?? createSceneId(tag))}`;
    const type = svgType(tag, style);
    const x = dimension(style.x, transform.x);
    const y = dimension(style.y, transform.y);
    const width = Math.max(0.01, dimension(style.width, tag === "line" ? Math.abs(dimension(style.x2) - dimension(style.x1)) : 1));
    const height = Math.max(0.01, dimension(style.height, tag === "line" ? Math.abs(dimension(style.y2) - dimension(style.y1)) : 1));
    let paths = tag === "path" ? parseSvgPathData(style.d ?? "")
      : tag === "polygon" || tag === "polyline" ? [pointsPath(style.points ?? "", tag === "polygon")]
        : [];
    let bounds = paths.length ? bezierPathBounds(paths[0]) : { x: 0, y: 0, width, height };
    paths = paths.map((path) => offsetPath(path, -bounds.x, -bounds.y));
    const fill = parsePaint(style.fill, gradients);
    const stroke = parsePaint(style.stroke, gradients);
    const href = style.href ?? style["xlink:href"];
    let assetId: string | undefined;
    if (tag === "image" && href) {
      assetId = `${id}-image`;
      const data = parseDataUrl(href);
      assets.set(assetId, {
        id: assetId,
        name: `${style.id ?? "SVG image"}.${extensionForMime(data?.mimeType ?? "image/png")}`,
        kind: "image",
        mimeType: data?.mimeType ?? "image/png",
        dataBase64: data?.base64,
        sourceUrl: data ? undefined : href,
        linked: !data,
        width,
        height
      });
      if (!data && !/^https?:/i.test(href)) {
        reportImportWarning(report, `Linked SVG image ${href} is not embedded.`, "missing-asset", href);
      }
    }
    const clipId = /^url\(#(.+)\)$/.exec(style["clip-path"] ?? "")?.[1];
    const masks: NormalizedDesignMask[] = clipId && clipPaths.has(clipId) ? [{
      id: createSceneId("svg-clip"),
      name: `Clip ${clipId}`,
      path: clipPaths.get(clipId)!,
      mode: "add",
      inverted: false,
      opacity: 1,
      feather: { x: 0, y: 0 },
      expansion: 0
    }] : [];
    const childArray = raw[tag] ?? [];
    const text = tag === "text" ? textContent(childArray) : "";
    const node: NormalizedDesignNode = {
      ...baseNode(id, style["data-name"] ?? style.id ?? tag, type),
      x: x + bounds.x + parentOrigin.x,
      y: y + bounds.y + parentOrigin.y,
      width: paths.length ? Math.max(0.01, bounds.width) : width,
      height: paths.length ? Math.max(0.01, bounds.height) : height,
      rotation: transform.rotation,
      scaleX: transform.scaleX,
      scaleY: transform.scaleY,
      opacity: dimension(style.opacity, 1),
      visible: style.display !== "none" && style.visibility !== "hidden",
      locked: style["data-locked"] === "true",
      blendMode: mapSvgBlend(style["mix-blend-mode"]),
      fills: fill ? [fill] : [],
      strokes: stroke ? [stroke] : [],
      strokeWidth: dimension(style["stroke-width"]),
      cornerRadius: dimension(style.rx || style.ry),
      path: paths[0],
      compoundPaths: paths.length > 1 ? paths.slice(1) : undefined,
      text: tag === "text" ? {
        characters: text,
        fontFamily: style["font-family"] ?? "Arial",
        fontStyle: /italic|oblique/i.test(style["font-style"] ?? "") ? "italic" : "normal",
        fontWeight: svgFontWeight(style["font-weight"]),
        fontSize: dimension(style["font-size"], 16),
        lineHeight: dimension(style["line-height"], dimension(style["font-size"], 16) * 1.2),
        letterSpacing: dimension(style["letter-spacing"]),
        paragraphSpacing: 0,
        align: style["text-anchor"] === "middle" ? "center" : style["text-anchor"] === "end" ? "right" : "left",
        textLayout: "point",
        writingMode: /^vertical/.test(style["writing-mode"] ?? "") ? "vertical-rl" : "horizontal-tb",
        direction: style.direction === "rtl" ? "rtl" : "ltr"
      } : undefined,
      assetId,
      masks,
      effects: svgEffects(style, report, style.id ?? tag),
      children: convertSvgChildren(childArray, { x: 0, y: 0 }, gradients, clipPaths, assets, report),
      componentId: tag === "symbol" || tag === "use" ? String(style.href ?? style.id ?? id) : undefined,
      sourceData: {
        tag,
        attributes: attrs,
        dashArray: style["stroke-dasharray"],
        lineCap: style["stroke-linecap"],
        lineJoin: style["stroke-linejoin"],
        markerStart: style["marker-start"],
        markerEnd: style["marker-end"]
      }
    };
    result.push(node);
  }
  return result;
}

function collectGradients(nodes: XmlNode[]): Map<string, ColorValue> {
  const result = new Map<string, ColorValue>();
  walkXml(nodes, (tag, node) => {
    if (tag !== "linearGradient" && tag !== "radialGradient") return;
    const attrs = attributes(node);
    if (!attrs.id) return;
    const stops = (node[tag] ?? []).filter((child: XmlNode) => tagName(child) === "stop").map((child: XmlNode, index: number) => {
      const stop = { ...parseStyle(attributes(child).style), ...attributes(child) };
      return {
        id: createSceneId(`svg-stop-${index}`),
        position: percent(stop.offset, index),
        color: stop["stop-color"] ?? "#000000",
        opacity: dimension(stop["stop-opacity"], 1)
      };
    });
    if (tag === "linearGradient") {
      result.set(attrs.id, {
        type: "linear-gradient",
        angle: 0,
        startX: percent(attrs.x1, 0),
        startY: percent(attrs.y1, 0.5),
        endX: percent(attrs.x2, 1),
        endY: percent(attrs.y2, 0.5),
        stops,
        spread: spread(attrs.spreadMethod),
        coordinateMode: attrs.gradientUnits === "userSpaceOnUse" ? "scene" : "object"
      });
    } else {
      result.set(attrs.id, {
        type: "radial-gradient",
        centerX: percent(attrs.cx, 0.5),
        centerY: percent(attrs.cy, 0.5),
        radiusX: percent(attrs.r, 0.5),
        radiusY: percent(attrs.r, 0.5),
        focalX: percent(attrs.fx, percent(attrs.cx, 0.5)),
        focalY: percent(attrs.fy, percent(attrs.cy, 0.5)),
        stops,
        spread: spread(attrs.spreadMethod),
        coordinateMode: attrs.gradientUnits === "userSpaceOnUse" ? "scene" : "object"
      });
    }
  });
  return result;
}

function collectClipPaths(nodes: XmlNode[]): Map<string, BezierPath> {
  const result = new Map<string, BezierPath>();
  walkXml(nodes, (tag, node) => {
    if (tag !== "clipPath") return;
    const attrs = attributes(node);
    const paths: BezierPath[] = [];
    walkXml(node[tag] ?? [], (childTag, child) => {
      const childAttrs = attributes(child);
      if (childTag === "path") paths.push(...parseSvgPathData(childAttrs.d ?? ""));
      if (childTag === "rect") paths.push(rectanglePath(dimension(childAttrs.width, 1), dimension(childAttrs.height, 1)));
    });
    if (attrs.id && paths[0]) result.set(attrs.id, paths[0]);
  });
  return result;
}

function svgEffects(style: Attributes, report: DesignImportReport, name: string): NormalizedDesignNode["effects"] {
  const result: NormalizedDesignNode["effects"] = [];
  if (style.filter) {
    result.push({ type: "unknown", enabled: true, sourceData: { filter: style.filter } });
    reportImportWarning(report, `SVG appearance filter on ${name} is preserved as source metadata.`, "unsupported-effect", name);
  }
  return result;
}

function baseNode(id: string, name: string, type: NormalizedDesignNodeType): NormalizedDesignNode {
  return {
    id,
    name,
    type,
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    anchor: { x: 0, y: 0 },
    opacity: 1,
    visible: true,
    locked: false,
    blendMode: "normal",
    fills: [],
    strokes: [],
    strokeWidth: 0,
    masks: [],
    effects: [],
    children: []
  };
}

function svgType(tag: string, attrs: Attributes): NormalizedDesignNodeType {
  if (tag === "text") return "text";
  if (tag === "rect") return attrs["data-artboard"] === "true" ? "artboard" : "rectangle";
  if (tag === "ellipse" || tag === "circle") return "ellipse";
  if (tag === "line") return "line";
  if (["path", "polygon", "polyline"].includes(tag)) return "path";
  if (tag === "image") return "image";
  if (tag === "symbol") return "component";
  if (tag === "use") return "instance";
  return "group";
}

function findTag(nodes: XmlNode[], wanted: string): XmlNode | null {
  for (const node of nodes) {
    const tag = tagName(node);
    if (tag === wanted) return node;
    const found = tag ? findTag(node[tag] ?? [], wanted) : null;
    if (found) return found;
  }
  return null;
}

function walkXml(nodes: XmlNode[], visit: (tag: string, node: XmlNode) => void): void {
  for (const node of nodes) {
    const tag = tagName(node);
    if (!tag) continue;
    visit(tag, node);
    walkXml(node[tag] ?? [], visit);
  }
}

function tagName(node: XmlNode): string {
  return Object.keys(node).find((key) => key !== ":@" && key !== "#text" && key !== "#comment") ?? "";
}

function attributes(node: XmlNode): Attributes {
  return (node[":@"] ?? {}) as Attributes;
}

function textContent(nodes: XmlNode[]): string {
  return nodes.map((node) => typeof node["#text"] === "string"
    ? node["#text"]
    : tagName(node) ? textContent(node[tagName(node)] ?? []) : "").join("");
}

function parseStyle(value: string | undefined): Attributes {
  return Object.fromEntries(String(value ?? "").split(";").map((entry) => entry.split(":")).filter((entry) => entry.length === 2).map(([key, val]) => [key.trim(), val.trim()]));
}

function parsePaint(value: string | undefined, gradients: Map<string, ColorValue>): ColorValue | null {
  if (!value || value === "none") return value === "none" ? { type: "none" } : null;
  const gradientId = /^url\(#(.+)\)$/.exec(value)?.[1];
  if (gradientId && gradients.has(gradientId)) return structuredClone(gradients.get(gradientId)!);
  return { type: "solid", color: value };
}

function parseTransform(value: string | undefined) {
  const result = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 };
  const translate = /translate\(\s*([^,\s)]+)[,\s]+([^)\s]+)\s*\)/.exec(value ?? "");
  if (translate) { result.x = dimension(translate[1]); result.y = dimension(translate[2]); }
  const rotate = /rotate\(\s*([^)\s]+)/.exec(value ?? "");
  if (rotate) result.rotation = dimension(rotate[1]);
  const scale = /scale\(\s*([^,\s)]+)(?:[,\s]+([^)\s]+))?/.exec(value ?? "");
  if (scale) { result.scaleX = dimension(scale[1], 1); result.scaleY = dimension(scale[2], result.scaleX); }
  const matrix = /matrix\(\s*([^,\s]+)[,\s]+([^,\s]+)[,\s]+([^,\s]+)[,\s]+([^,\s]+)[,\s]+([^,\s]+)[,\s]+([^)\s]+)/.exec(value ?? "");
  if (matrix) {
    const [a, b, , d, tx, ty] = matrix.slice(1).map(Number);
    result.x = tx; result.y = ty; result.scaleX = Math.hypot(a, b); result.scaleY = Math.hypot(Number(matrix[3]), d); result.rotation = Math.atan2(b, a) * 180 / Math.PI;
  }
  return result;
}

function pointsPath(value: string, closed: boolean): BezierPath {
  const values = value.trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
  const vertices = Array.from({ length: Math.floor(values.length / 2) }, (_, index) => ({ x: values[index * 2], y: values[index * 2 + 1] }));
  return { closed, vertices, inTangents: vertices.map(() => ({ x: 0, y: 0 })), outTangents: vertices.map(() => ({ x: 0, y: 0 })) };
}

function offsetPath(path: BezierPath, x: number, y: number): BezierPath {
  return { ...path, vertices: path.vertices.map((point) => ({ x: point.x + x, y: point.y + y })) };
}

function collectFonts(pages: NormalizedDesignPage[]) {
  const families = new Set<string>();
  const walk = (nodes: NormalizedDesignNode[]) => nodes.forEach((node) => { if (node.text?.fontFamily) families.add(node.text.fontFamily); walk(node.children); });
  pages.forEach((page) => walk(page.nodes));
  return [...families].map((family) => ({ family, sourceName: family }));
}

function collectComponents(nodes: NormalizedDesignNode[]) {
  const result: Record<string, { name: string; nodeId: string }> = {};
  const walk = (items: NormalizedDesignNode[]) => items.forEach((node) => {
    if (node.type === "component" && node.componentId) result[node.componentId] = { name: node.name, nodeId: node.id };
    walk(node.children);
  });
  walk(nodes);
  return result;
}

function mapSvgBlend(value: string | undefined): NormalizedDesignNode["blendMode"] {
  return value === "multiply" ? "multiply" : value === "screen" ? "screen" : value === "overlay" ? "overlay" : value === "darken" ? "darken" : value === "lighten" ? "lighten" : "normal";
}

function viewBox(attrs: Attributes): number[] {
  return String(attrs.viewBox ?? "").split(/[\s,]+/).map(Number).filter(Number.isFinite);
}

function dimension(value: unknown, fallback = 0): number {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function percent(value: unknown, fallback = 0): number {
  const text = String(value ?? "");
  return text.endsWith("%") ? dimension(text, fallback * 100) / 100 : dimension(text, fallback);
}

function spread(value: string | undefined): "pad" | "repeat" | "reflect" {
  return value === "repeat" ? "repeat" : value === "reflect" ? "reflect" : "pad";
}

function svgFontWeight(value: string | undefined): "400" | "500" | "600" | "700" | "800" {
  const numeric = /bold/i.test(value ?? "") ? 700 : Math.round(dimension(value, 400) / 100) * 100;
  return String(Math.min(800, Math.max(400, numeric))) as "400" | "500" | "600" | "700" | "800";
}

function parseDataUrl(value: string): { mimeType: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(value);
  return match ? { mimeType: match[1], base64: match[2] } : null;
}

function extensionForMime(mime: string): string {
  return mime.includes("jpeg") ? "jpg" : mime.includes("svg") ? "svg" : "png";
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
