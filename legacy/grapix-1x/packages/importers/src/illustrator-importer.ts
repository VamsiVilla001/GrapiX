/**
 * Illustrator -> DesignIR.
 *
 * Reads the PDF stream inside an .ai file (Illustrator's "Create PDF Compatible File",
 * which is on by default) and also plain .pdf exports. Vector geometry comes from the
 * content-stream operator list; layer names come from PDF optional content groups, which is
 * how Illustrator persists its layer panel. Text comes from the text layer rather than the
 * glyph ops, so its baseline placement is approximate and reported as such.
 *
 * Identity is name-based with an ordinal and content fingerprint fallback — AI carries no
 * stable node ids at all. See docs/middle-layer-arch.md section 5.3.
 */

import {
  createDesignId,
  createDesignNode,
  createFontCollector,
  createStableNodeId,
  defaultTextLayout,
  hashString,
  multiplyMatrix,
  rgba,
  solidPaint,
  type DesignIR,
  type DesignNode,
  type ImportWarning,
  type Matrix2D,
  type Paint,
  type Size,
  type Stroke
} from "@grapix/design-ir";
import path from "node:path";
import { createRequire } from "node:module";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

export const ILLUSTRATOR_IMPORTER_VERSION = "ai/0.1.0";

const OPS = pdfjs.OPS;

export interface IllustratorImportOptions {
  fileName: string;
  data: Uint8Array;
}

interface AiContext {
  warnings: ImportWarning[];
  fonts: ReturnType<typeof createFontCollector>;
  ordinal: number;
}

interface GraphicsState {
  ctm: Matrix2D;
  fill: Paint | null;
  stroke: { paint: Paint; weight: number } | null;
}

/** A text position recorded during the operator walk, used to attribute text to a layer. */
interface TextAnchor {
  x: number;
  y: number;
  layerKey: string;
}

export async function importIllustrator(options: IllustratorImportOptions): Promise<DesignIR> {
  const context: AiContext = {
    warnings: [],
    fonts: createFontCollector(),
    ordinal: 0
  };

  const document = await pdfjs.getDocument({
    // pdfjs mutates the buffer it is given, so hand it a copy.
    data: new Uint8Array(options.data),
    disableFontFace: true,
    isEvalSupported: false,
    standardFontDataUrl: resolveStandardFontDir()
  }).promise;

  const groupNames = await readOptionalContentGroups(document);
  const revision = hashString(`${options.data.byteLength}|${document.numPages}`);
  const designId = createDesignId("ai", options.fileName, revision);

  const artboards: DesignNode[] = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    artboards.push(await mapPage(document, pageNumber, groupNames, context));
  }

  const canvas: Size = artboards.length
    ? artboards[0].size
    : { width: 1920, height: 1080 };

  if (!artboards.length) {
    context.warnings.push({
      severity: "error",
      code: "AI_NO_PAGES",
      message: "The file has no pages. If this is an .ai file, re-save it with PDF compatibility enabled."
    });
  }

  if (document.numPages > 1) {
    context.warnings.push({
      severity: "info",
      code: "AI_MULTIPLE_ARTBOARDS",
      message: `${document.numPages} artboards were imported as sibling frames; the first one sets the design canvas.`
    });
  }

  const root = createDesignNode(
    {
      nodeId: createStableNodeId({
        source: "ai",
        sourcePath: "",
        name: options.fileName,
        kind: "frame",
        fingerprint: revision
      }),
      sourcePath: "",
      name: options.fileName,
      kind: "frame"
    },
    {
      size: canvas,
      clipsContent: true,
      children: artboards
    }
  );

  await document.destroy();

  return {
    designId,
    source: "ai",
    sourceRef: options.fileName,
    sourceRevision: revision,
    sourceFileName: options.fileName,
    importedAt: new Date().toISOString(),
    importerVersion: ILLUSTRATOR_IMPORTER_VERSION,
    canvas,
    root,
    assets: [],
    fonts: context.fonts.list(),
    // PDF carries no shared style library.
    sharedStyles: {},
    warnings: context.warnings
  };
}

/** pdfjs needs the standard font data on disk to parse base-14 fonts without warnings. */
function resolveStandardFontDir(): string {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve("pdfjs-dist/package.json");

    return `${path.join(path.dirname(entry), "standard_fonts")}${path.sep}`;
  } catch {
    return "";
  }
}

async function readOptionalContentGroups(
  document: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>
): Promise<Map<string, string>> {
  const names = new Map<string, string>();

  try {
    const config = await document.getOptionalContentConfig();
    const groups = config?.getGroups?.() as unknown;

    // pdfjs returns a null-prototype object here, not a Map, so accept both.
    const entries: Array<[string, unknown]> =
      groups instanceof Map
        ? [...groups.entries()].map(([key, value]) => [String(key), value])
        : groups && typeof groups === "object"
          ? Object.entries(groups as Record<string, unknown>)
          : [];

    for (const [id, group] of entries) {
      const name = (group as { name?: string } | null)?.name;

      if (typeof name === "string" && name.trim()) {
        names.set(id, name);
      }
    }
  } catch {
    // A file with no optional content is normal; the artboard becomes one flat layer.
  }

  return names;
}

async function mapPage(
  document: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>,
  pageNumber: number,
  groupNames: Map<string, string>,
  context: AiContext
): Promise<DesignNode> {
  const page = await document.getPage(pageNumber);
  const [x0, y0, x1, y1] = page.view;
  const size: Size = { width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
  const artboardPath = `Artboard ${pageNumber}`;

  // PDF space is y-up from the bottom-left; design space is y-down from the top-left.
  const flip: Matrix2D = [1, 0, 0, -1, -x0, y1];

  const operatorList = await page.getOperatorList();
  const { layers, textAnchors } = walkOperatorList(
    operatorList,
    flip,
    groupNames,
    artboardPath,
    context
  );

  const textContent = await page.getTextContent();
  attachTextNodes(textContent, layers, textAnchors, groupNames, artboardPath, flip, context);

  page.cleanup();

  for (const layer of layers.values()) {
    sizeGroupFromChildren(layer.node);
  }

  return createDesignNode(
    {
      nodeId: createStableNodeId({
        source: "ai",
        sourcePath: artboardPath,
        name: artboardPath,
        kind: "frame",
        fingerprint: hashString(`${size.width}x${size.height}`)
      }),
      sourcePath: artboardPath,
      name: artboardPath,
      kind: "frame",
      size
    },
    {
      clipsContent: true,
      children: [...layers.values()].map((layer) => layer.node)
    }
  );
}

interface LayerBucket {
  node: DesignNode;
  children: DesignNode[];
}

/**
 * A PDF content stream has no notion of a group box, so an Illustrator layer node gets its
 * size from the union of its children. Children keep their own absolute positions.
 */
function sizeGroupFromChildren(node: DesignNode): void {
  if (!node.children.length) {
    return;
  }

  let maxX = 0;
  let maxY = 0;

  for (const child of node.children) {
    maxX = Math.max(maxX, child.transform[4] + child.size.width);
    maxY = Math.max(maxY, child.transform[5] + child.size.height);
  }

  node.size = { width: Math.round(maxX * 100) / 100, height: Math.round(maxY * 100) / 100 };
}

function layerNameFor(key: string, groupNames: Map<string, string>): string {
  if (key === "__artboard__") {
    return "Artwork";
  }

  return groupNames.get(key) ?? `Layer ${key}`;
}

/**
 * Gets or creates the bucket for an Illustrator layer. Shared by the geometry walk and the
 * text pass, so a layer containing only text still lands under its own named group.
 */
function ensureLayerBucket(
  layers: Map<string, LayerBucket>,
  key: string,
  groupNames: Map<string, string>,
  artboardPath: string
): LayerBucket {
  const existing = layers.get(key);

  if (existing) {
    return existing;
  }

  const name = layerNameFor(key, groupNames);
  const sourcePath = `${artboardPath}/${name}`;
  const bucket: LayerBucket = {
    node: createDesignNode(
      {
        nodeId: createStableNodeId({
          source: "ai",
          sourcePath,
          name,
          kind: "group",
          fingerprint: key
        }),
        sourcePath,
        name,
        kind: "group"
      },
      { children: [] }
    ),
    children: []
  };

  // createDesignNode copies children by value, so keep the live array on the bucket and
  // re-point the node at it.
  bucket.node.children = bucket.children;
  layers.set(key, bucket);

  return bucket;
}

function walkOperatorList(
  operatorList: { fnArray: number[]; argsArray: unknown[] },
  flip: Matrix2D,
  groupNames: Map<string, string>,
  artboardPath: string,
  context: AiContext
): { layers: Map<string, LayerBucket>; textAnchors: TextAnchor[] } {
  const layers = new Map<string, LayerBucket>();
  const textAnchors: TextAnchor[] = [];

  const stack: GraphicsState[] = [];
  let state: GraphicsState = {
    ctm: [1, 0, 0, 1, 0, 0],
    fill: solidPaint(rgba(0, 0, 0, 1)),
    stroke: null
  };

  const layerStack: string[] = [];
  let pendingSubpaths: string[] = [];
  let pendingBounds: Bounds = emptyBounds();

  const currentLayerKey = (): string => layerStack[layerStack.length - 1] ?? "__artboard__";

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const fn = operatorList.fnArray[index];
    const args = operatorList.argsArray[index];

    switch (fn) {
      case OPS.save:
        stack.push({ ...state });
        break;

      case OPS.restore:
        state = stack.pop() ?? state;
        break;

      case OPS.transform: {
        const matrix = toMatrix(args);

        if (matrix) {
          state = { ...state, ctm: multiplyMatrix(state.ctm, matrix) };
        }

        break;
      }

      case OPS.setFillRGBColor: {
        const color = toColor(args);

        if (color) {
          state = { ...state, fill: solidPaint(color) };
        }

        break;
      }

      case OPS.setStrokeRGBColor: {
        const color = toColor(args);

        if (color) {
          state = {
            ...state,
            stroke: { paint: solidPaint(color), weight: state.stroke?.weight ?? 1 }
          };
        }

        break;
      }

      case OPS.setLineWidth: {
        const weight = Array.isArray(args) ? Number(args[0]) : Number(args);

        if (Number.isFinite(weight)) {
          state = {
            ...state,
            stroke: state.stroke
              ? { ...state.stroke, weight }
              : { paint: solidPaint(rgba(0, 0, 0, 1)), weight }
          };
        }

        break;
      }

      case OPS.constructPath: {
        const built = buildPath(args, multiplyMatrix(flip, state.ctm));

        if (built) {
          pendingSubpaths.push(...built.subpaths);
          pendingBounds = mergeBounds(pendingBounds, built.bounds);
        }

        break;
      }

      case OPS.fill:
      case OPS.eoFill:
      case OPS.stroke:
      case OPS.fillStroke:
      case OPS.eoFillStroke: {
        if (pendingSubpaths.length) {
          const paints = fn === OPS.stroke ? null : state.fill;
          const strokes: Stroke[] =
            fn === OPS.fill || fn === OPS.eoFill || !state.stroke
              ? []
              : [
                  {
                    paint: state.stroke.paint,
                    weight: state.stroke.weight,
                    align: "center",
                    cap: "none",
                    join: "miter",
                    dashPattern: []
                  }
                ];

          ensureLayerBucket(layers, currentLayerKey(), groupNames, artboardPath).children.push(
            createVectorNode({
              subpaths: pendingSubpaths,
              bounds: pendingBounds,
              fill: paints,
              strokes,
              evenOdd: fn === OPS.eoFill || fn === OPS.eoFillStroke,
              layerKey: currentLayerKey(),
              artboardPath,
              groupNames,
              context
            })
          );
        }

        pendingSubpaths = [];
        pendingBounds = emptyBounds();
        break;
      }

      case OPS.beginMarkedContentProps: {
        const list = Array.isArray(args) ? args : [];

        if (list[0] === "OC") {
          const reference = list[1] as { id?: string } | string | undefined;
          const id =
            typeof reference === "string" ? reference : reference?.id ? String(reference.id) : undefined;

          layerStack.push(id ?? currentLayerKey());
        } else {
          layerStack.push(currentLayerKey());
        }

        break;
      }

      case OPS.beginMarkedContent:
        layerStack.push(currentLayerKey());
        break;

      case OPS.endMarkedContent:
        layerStack.pop();
        break;

      case OPS.moveText:
      case OPS.setTextMatrix: {
        const anchor = toTextAnchor(fn, args, state.ctm, flip);

        if (anchor) {
          textAnchors.push({ ...anchor, layerKey: currentLayerKey() });
        }

        break;
      }

      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject: {
        context.warnings.push({
          severity: "warning",
          code: "AI_RASTER_NOT_IMPORTED",
          message: "A placed raster image was skipped; embedded image extraction is not implemented yet.",
          sourcePath: artboardPath
        });

        break;
      }

      default:
        break;
    }
  }

  return { layers, textAnchors };
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function emptyBounds(): Bounds {
  return {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY
  };
}

function mergeBounds(a: Bounds, b: Bounds): Bounds {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY)
  };
}

function boundsToSize(bounds: Bounds): { x: number; y: number; width: number; height: number } {
  if (!Number.isFinite(bounds.minX)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  return {
    x: bounds.minX,
    y: bounds.minY,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY
  };
}

/**
 * Converts one constructPath operator into SVG subpaths in design space.
 * pdfjs hands over `[subOps, coords, minMax]` where coords is a flat typed array consumed
 * in the order the sub-ops require.
 */
function buildPath(
  args: unknown,
  matrix: Matrix2D
): { subpaths: string[]; bounds: Bounds } | null {
  if (!Array.isArray(args) || args.length < 2) {
    return null;
  }

  const subOps = Array.from(args[0] as ArrayLike<number>);
  const coords = Array.from(args[1] as ArrayLike<number>).map(Number);

  const subpaths: string[] = [];
  let bounds = emptyBounds();
  let current = "";
  let cursor = 0;

  const point = (x: number, y: number): { x: number; y: number } => {
    const mapped = {
      x: matrix[0] * x + matrix[2] * y + matrix[4],
      y: matrix[1] * x + matrix[3] * y + matrix[5]
    };

    bounds = mergeBounds(bounds, {
      minX: mapped.x,
      minY: mapped.y,
      maxX: mapped.x,
      maxY: mapped.y
    });

    return mapped;
  };

  const round = (value: number): string => String(Math.round(value * 100) / 100);

  const flush = (): void => {
    if (current.trim()) {
      subpaths.push(current.trim());
    }

    current = "";
  };

  for (const subOp of subOps) {
    switch (subOp) {
      case OPS.moveTo: {
        flush();
        const p = point(coords[cursor], coords[cursor + 1]);
        cursor += 2;
        current = `M ${round(p.x)} ${round(p.y)}`;
        break;
      }

      case OPS.lineTo: {
        const p = point(coords[cursor], coords[cursor + 1]);
        cursor += 2;
        current += ` L ${round(p.x)} ${round(p.y)}`;
        break;
      }

      case OPS.curveTo: {
        const c1 = point(coords[cursor], coords[cursor + 1]);
        const c2 = point(coords[cursor + 2], coords[cursor + 3]);
        const end = point(coords[cursor + 4], coords[cursor + 5]);
        cursor += 6;
        current += ` C ${round(c1.x)} ${round(c1.y)} ${round(c2.x)} ${round(c2.y)} ${round(end.x)} ${round(end.y)}`;
        break;
      }

      case OPS.curveTo2: {
        const c2 = point(coords[cursor], coords[cursor + 1]);
        const end = point(coords[cursor + 2], coords[cursor + 3]);
        cursor += 4;
        current += ` S ${round(c2.x)} ${round(c2.y)} ${round(end.x)} ${round(end.y)}`;
        break;
      }

      case OPS.curveTo3: {
        const c1 = point(coords[cursor], coords[cursor + 1]);
        const end = point(coords[cursor + 2], coords[cursor + 3]);
        cursor += 4;
        current += ` Q ${round(c1.x)} ${round(c1.y)} ${round(end.x)} ${round(end.y)}`;
        break;
      }

      case OPS.closePath:
        current += " Z";
        break;

      case OPS.rectangle: {
        flush();
        const x = coords[cursor];
        const y = coords[cursor + 1];
        const width = coords[cursor + 2];
        const height = coords[cursor + 3];
        cursor += 4;

        const a = point(x, y);
        const b = point(x + width, y);
        const c = point(x + width, y + height);
        const d = point(x, y + height);

        subpaths.push(
          `M ${round(a.x)} ${round(a.y)} L ${round(b.x)} ${round(b.y)} L ${round(c.x)} ${round(c.y)} L ${round(d.x)} ${round(d.y)} Z`
        );
        break;
      }

      default:
        break;
    }
  }

  flush();

  if (!subpaths.length) {
    return null;
  }

  return { subpaths, bounds };
}

function createVectorNode(input: {
  subpaths: string[];
  bounds: Bounds;
  fill: Paint | null;
  strokes: Stroke[];
  evenOdd: boolean;
  layerKey: string;
  artboardPath: string;
  groupNames: Map<string, string>;
  context: AiContext;
}): DesignNode {
  const box = boundsToSize(input.bounds);
  const layerName = layerNameFor(input.layerKey, input.groupNames);
  input.context.ordinal += 1;
  const name = `${layerName} Shape ${input.context.ordinal}`;
  const sourcePath = `${input.artboardPath}/${layerName}/${name}`;

  // Geometry is stored local to the node, so the node transform stays the positioner.
  const localPaths = input.subpaths.map((subpath) => translatePath(subpath, -box.x, -box.y));

  return createDesignNode(
    {
      nodeId: createStableNodeId({
        source: "ai",
        sourcePath,
        name,
        kind: "vector",
        fingerprint: hashString(localPaths.join("|"))
      }),
      sourcePath,
      name,
      kind: "vector",
      transform: [1, 0, 0, 1, box.x, box.y],
      size: { width: box.width, height: box.height }
    },
    {
      fills: input.fill ? [input.fill] : [],
      strokes: input.strokes,
      geometry: {
        paths: localPaths,
        fillRule: input.evenOdd ? "evenodd" : "nonzero"
      }
    }
  );
}

/** Shifts an absolute subpath into node-local space. Only M/L/C/S/Q/Z are emitted above. */
function translatePath(subpath: string, dx: number, dy: number): string {
  const tokens = subpath.split(/\s+/);
  const output: string[] = [];
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];

    if (/^[MLCSQZ]$/.test(token)) {
      output.push(token);
      index += 1;
      continue;
    }

    const x = Number(token);
    const y = Number(tokens[index + 1]);

    if (Number.isFinite(x) && Number.isFinite(y)) {
      output.push(String(Math.round((x + dx) * 100) / 100));
      output.push(String(Math.round((y + dy) * 100) / 100));
      index += 2;
      continue;
    }

    index += 1;
  }

  return output.join(" ");
}

function attachTextNodes(
  textContent: { items: unknown[]; styles: Record<string, { fontFamily?: string; ascent?: number }> },
  layers: Map<string, LayerBucket>,
  textAnchors: TextAnchor[],
  groupNames: Map<string, string>,
  artboardPath: string,
  flip: Matrix2D,
  context: AiContext
): void {
  let approximated = 0;

  for (const raw of textContent.items) {
    const item = raw as {
      str?: string;
      width?: number;
      height?: number;
      transform?: number[];
      fontName?: string;
    };

    if (!item.str?.trim() || !item.transform) {
      continue;
    }

    const fontSize = Math.abs(item.transform[3] || item.transform[0] || 12);
    const style = item.fontName ? textContent.styles[item.fontName] : undefined;
    const fontFamily = style?.fontFamily ?? "Helvetica";
    const ascent = style?.ascent ?? 0.8;

    const baselineX = item.transform[4];
    const baselineY = item.transform[5];
    // Flip the baseline into design space, then lift by the ascent to get the box top.
    const designY = flip[3] * baselineY + flip[5] - ascent * fontSize;
    const designX = baselineX + flip[4];

    const anchor = textAnchors.find(
      (candidate) => Math.abs(candidate.x - baselineX) < 0.5 && Math.abs(candidate.y - baselineY) < 0.5
    );
    const layerKey = anchor?.layerKey ?? "__artboard__";

    if (!anchor) {
      approximated += 1;
    }

    const bucket = ensureLayerBucket(layers, layerKey, groupNames, artboardPath);
    const layerName = bucket.node.name;
    const name = item.str.trim();
    const sourcePath = `${artboardPath}/${layerName}/${name}`;

    context.fonts.add(fontFamily, "Regular", 400, item.str);

    const node = createDesignNode(
      {
        nodeId: createStableNodeId({
          source: "ai",
          sourcePath,
          name,
          kind: "text",
          fingerprint: hashString(`${Math.round(designX)}|${Math.round(designY)}|${item.str}`)
        }),
        sourcePath,
        name,
        kind: "text",
        transform: [1, 0, 0, 1, Math.round(designX * 100) / 100, Math.round(designY * 100) / 100],
        size: {
          width: item.width ?? 0,
          height: item.height ?? fontSize
        }
      },
      {
        text: {
          plainText: item.str,
          runs: [
            {
              text: item.str,
              fontFamily,
              fontStyle: "Regular",
              fontWeight: 400,
              fontSize,
              letterSpacing: 0,
              lineHeight: "auto",
              textCase: "original",
              textDecoration: "none",
              baselineShift: 0,
              fills: [solidPaint(rgba(0, 0, 0, 1))]
            }
          ],
          layout: defaultTextLayout()
        }
      }
    );

    bucket.children.push(node);
  }

  context.warnings.push({
    severity: "info",
    code: "AI_TEXT_BASELINE_APPROXIMATED",
    message:
      "Text boxes are derived from PDF baselines and font ascent, so vertical placement is approximate. Re-check text positions before rigging.",
    sourcePath: artboardPath
  });

  if (approximated) {
    context.warnings.push({
      severity: "warning",
      code: "AI_TEXT_LAYER_UNRESOLVED",
      message: `${approximated} text item(s) could not be matched to an Illustrator layer and were placed on the artboard root.`,
      sourcePath: artboardPath
    });
  }
}

function toMatrix(args: unknown): Matrix2D | null {
  const list = Array.isArray(args) ? args.map(Number) : null;

  if (!list || list.length < 6 || list.some((value) => !Number.isFinite(value))) {
    return null;
  }

  return [list[0], list[1], list[2], list[3], list[4], list[5]];
}

/** pdfjs passes colour components as a 0-255 typed-array view. */
function toColor(args: unknown): ReturnType<typeof rgba> | null {
  const values = args && typeof args === "object" ? Array.from(args as ArrayLike<number>) : null;

  if (!values || values.length < 3) {
    return null;
  }

  return rgba(values[0] / 255, values[1] / 255, values[2] / 255, 1);
}

function toTextAnchor(
  fn: number,
  args: unknown,
  ctm: Matrix2D,
  flip: Matrix2D
): { x: number; y: number } | null {
  const list = Array.isArray(args) ? args.map(Number) : null;

  if (!list) {
    return null;
  }

  if (fn === OPS.moveText && list.length >= 2) {
    return { x: list[0], y: list[1] };
  }

  if (fn === OPS.setTextMatrix && list.length >= 6) {
    return { x: list[4], y: list[5] };
  }

  void ctm;
  void flip;

  return null;
}
