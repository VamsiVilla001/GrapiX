/**
 * PSD -> DesignIR.
 *
 * This first pass reads structure, not pixels: layer tree, names, bounds, blend modes,
 * opacity, clipping, masks, solid vector fills and the text engine data. Layer raster
 * extraction needs a canvas implementation in Node, so it is deliberately deferred and
 * reported as a per-layer warning rather than silently dropped.
 *
 * Identity is layer path + name, fingerprinted with bounds and text — PSD has no stable
 * layer ids. See docs/middle-layer-arch.md section 5.3.
 */

import {
  createDesignId,
  createDesignNode,
  createFontCollector,
  createStableNodeId,
  defaultTextLayout,
  hashString,
  rgba,
  solidPaint,
  type DesignIR,
  type DesignNode,
  type DesignNodeKind,
  type Effect,
  type ImportWarning,
  type Matrix2D,
  type Paint,
  type RGBA,
  type Size,
  type TextContent,
  type TextRun
} from "@grapix/design-ir";
import { readPsd, type Layer, type Psd } from "ag-psd";

export const PSD_IMPORTER_VERSION = "psd/0.1.0";

export interface PsdImportOptions {
  fileName: string;
  data: Uint8Array;
}

interface PsdContext {
  warnings: ImportWarning[];
  fonts: ReturnType<typeof createFontCollector>;
}

/** ag-psd's effect shapes vary by version; only what is read here is typed. */
interface PsdEffectLike {
  enabled?: boolean;
  size?: { value?: number };
  distance?: { value?: number };
  angle?: { value?: number };
  spread?: { value?: number };
  color?: unknown;
  opacity?: { value?: number };
}

interface PsdEffectsLike {
  dropShadow?: PsdEffectLike[] | PsdEffectLike;
  innerShadow?: PsdEffectLike[] | PsdEffectLike;
}

export function importPsd(options: PsdImportOptions): DesignIR {
  const context: PsdContext = {
    warnings: [],
    fonts: createFontCollector()
  };

  let psd: Psd;

  try {
    psd = readPsd(options.data, {
      skipLayerImageData: true,
      skipCompositeImageData: true,
      skipThumbnail: true,
      useImageData: false
    });
  } catch (error) {
    throw new Error(
      `Could not read ${options.fileName} as a PSD: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const canvas: Size = { width: psd.width, height: psd.height };
  // PSD carries no version marker, so identity is content-derived.
  const revision = hashString(`${options.data.byteLength}|${psd.width}x${psd.height}|${psd.children?.length ?? 0}`);
  const designId = createDesignId("psd", options.fileName, revision);

  const layers = psd.children ?? [];

  if (!layers.length) {
    context.warnings.push({
      severity: "error",
      code: "PSD_NO_LAYERS",
      message: "The PSD has no layers. A flattened file carries nothing to rig."
    });
  }

  // ag-psd walks the file's layer records top-down and unshifts, so `children` already
  // arrives bottom-first — the same paint order DesignIR uses. No reversing.
  const children = layers.map((layer) => mapLayer(layer, "", canvas, context));

  const root = createDesignNode(
    {
      nodeId: createStableNodeId({
        source: "psd",
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
      children
    }
  );

  return {
    designId,
    source: "psd",
    sourceRef: options.fileName,
    sourceRevision: revision,
    sourceFileName: options.fileName,
    importedAt: new Date().toISOString(),
    importerVersion: PSD_IMPORTER_VERSION,
    canvas,
    root,
    assets: [],
    fonts: context.fonts.list(),
    warnings: context.warnings
  };
}

function mapLayer(layer: Layer, parentPath: string, canvas: Size, context: PsdContext): DesignNode {
  const name = layer.name ?? "Layer";
  const sourcePath = parentPath ? `${parentPath}/${name}` : name;
  const bounds = resolveBounds(layer);
  const isGroup = Array.isArray(layer.children) && layer.children.length > 0;
  const kind = resolveKind(layer, isGroup);

  const fingerprint = hashString(
    [
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      layer.text?.text ?? "",
      layer.children?.length ?? 0
    ].join("|")
  );

  const nodeId = createStableNodeId({
    source: "psd",
    sourcePath,
    name,
    kind,
    fingerprint
  });

  const transform: Matrix2D = [1, 0, 0, 1, bounds.x, bounds.y];

  if (layer.clipping) {
    context.warnings.push({
      severity: "info",
      code: "PSD_CLIPPING_LAYER",
      message: `${name} is a clipping layer; the clip relationship is recorded as a mask flag and needs review.`,
      nodeId,
      sourcePath
    });
  }

  if (layer.mask) {
    context.warnings.push({
      severity: "warning",
      code: "PSD_LAYER_MASK",
      message: `${name} has a raster layer mask, which is not imported yet.`,
      nodeId,
      sourcePath
    });
  }

  const fills = resolveFills(layer, context, sourcePath, nodeId);

  if (!isGroup && !layer.text && !fills.length) {
    context.warnings.push({
      severity: "warning",
      code: "PSD_RASTER_NOT_IMPORTED",
      message: `${name} is a raster layer; pixel data is not extracted in this importer pass.`,
      nodeId,
      sourcePath
    });
  }

  return createDesignNode(
    {
      nodeId,
      sourcePath,
      name,
      kind,
      transform,
      size: { width: bounds.width, height: bounds.height }
    },
    {
      visible: !layer.hidden,
      opacity: layer.opacity ?? 1,
      blendMode: mapBlendMode(layer.blendMode),
      isMask: Boolean(layer.clipping),
      fills,
      strokes: [],
      effects: resolveEffects(layer),
      text: layer.text ? resolveText(layer, context, sourcePath, nodeId) : undefined,
      children: isGroup
        ? (layer.children ?? []).map((child) => mapLayer(child, sourcePath, canvas, context))
        : []
    }
  );
}

function resolveKind(layer: Layer, isGroup: boolean): DesignNodeKind {
  if (isGroup) {
    return "group";
  }

  if (layer.text) {
    return "text";
  }

  if (layer.vectorMask || layer.vectorFill) {
    return "vector";
  }

  return "image";
}

function resolveBounds(layer: Layer): { x: number; y: number; width: number; height: number } {
  const left = layer.left ?? 0;
  const top = layer.top ?? 0;
  const right = layer.right ?? left;
  const bottom = layer.bottom ?? top;

  if (right > left || bottom > top) {
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  // Group layers frequently carry no bounds; derive them from the children.
  const children = layer.children ?? [];

  if (!children.length) {
    return { x: left, y: top, width: 0, height: 0 };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const child of children) {
    const childBounds = resolveBounds(child);
    minX = Math.min(minX, childBounds.x);
    minY = Math.min(minY, childBounds.y);
    maxX = Math.max(maxX, childBounds.x + childBounds.width);
    maxY = Math.max(maxY, childBounds.y + childBounds.height);
  }

  if (!Number.isFinite(minX)) {
    return { x: left, y: top, width: 0, height: 0 };
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function resolveFills(
  layer: Layer,
  context: PsdContext,
  sourcePath: string,
  nodeId: string
): Paint[] {
  const vectorFill = layer.vectorFill as { type?: string; color?: unknown } | undefined;

  if (!vectorFill) {
    return [];
  }

  const color = toRgba(vectorFill.color);

  if (color) {
    return [solidPaint(color)];
  }

  context.warnings.push({
    severity: "warning",
    code: "PSD_FILL_NOT_SUPPORTED",
    message: `${layer.name ?? "Layer"} uses a ${vectorFill.type ?? "non-solid"} fill, which is not imported yet.`,
    nodeId,
    sourcePath
  });

  return [];
}

function resolveEffects(layer: Layer): Effect[] {
  const effects = layer.effects as PsdEffectsLike | undefined;

  if (!effects) {
    return [];
  }

  const mapped: Effect[] = [];
  const collect = (input: PsdEffectLike[] | PsdEffectLike | undefined, kind: Effect["kind"]): void => {
    const entries = Array.isArray(input) ? input : input ? [input] : [];

    for (const entry of entries) {
      if (entry.enabled === false) {
        continue;
      }

      const distance = entry.distance?.value ?? 0;
      const angle = ((entry.angle?.value ?? 0) * Math.PI) / 180;

      mapped.push({
        kind,
        visible: true,
        radius: entry.size?.value ?? 0,
        spread: entry.spread?.value,
        offset: {
          x: Math.round(Math.cos(angle) * distance * 100) / 100,
          y: Math.round(-Math.sin(angle) * distance * 100) / 100
        },
        color: toRgba(entry.color) ?? undefined
      });
    }
  };

  collect(effects.dropShadow, "drop-shadow");
  collect(effects.innerShadow, "inner-shadow");

  return mapped;
}

function resolveText(
  layer: Layer,
  context: PsdContext,
  sourcePath: string,
  nodeId: string
): TextContent | undefined {
  const text = layer.text;

  if (!text) {
    return undefined;
  }

  const plainText = text.text ?? "";
  const baseStyle = text.style ?? {};
  const runs: TextRun[] = [];

  const styleRuns = text.styleRuns ?? [];
  let offset = 0;

  const buildRun = (slice: string, style: typeof baseStyle): TextRun => {
    const fontFamily = style.font?.name ?? baseStyle.font?.name ?? "Helvetica";
    const fontSize = style.fontSize ?? baseStyle.fontSize ?? 16;
    const fontWeight = style.fauxBold || baseStyle.fauxBold ? 700 : 400;
    const fontStyle = style.fauxItalic || baseStyle.fauxItalic ? "Italic" : "Regular";
    const fillColor = toRgba(style.fillColor ?? baseStyle.fillColor);

    context.fonts.add(fontFamily, fontStyle, fontWeight, slice);

    return {
      text: slice,
      fontFamily,
      fontStyle,
      fontWeight,
      fontSize,
      letterSpacing: ((style.tracking ?? baseStyle.tracking ?? 0) / 1000) * fontSize,
      lineHeight: style.leading ?? baseStyle.leading ?? "auto",
      // ag-psd fontCaps: 0 none, 1 small caps, 2 all caps.
      textCase: (style.fontCaps ?? baseStyle.fontCaps) === 2 ? "upper" : "original",
      textDecoration: style.underline || baseStyle.underline ? "underline" : "none",
      baselineShift: style.baselineShift ?? baseStyle.baselineShift ?? 0,
      fills: fillColor ? [solidPaint(fillColor)] : []
    };
  };

  if (styleRuns.length) {
    for (const run of styleRuns) {
      const slice = plainText.slice(offset, offset + run.length);
      offset += run.length;

      if (slice) {
        runs.push(buildRun(slice, run.style ?? {}));
      }
    }
  }

  if (!runs.length && plainText) {
    runs.push(buildRun(plainText, baseStyle));
  }

  if (text.transform) {
    context.warnings.push({
      severity: "info",
      code: "PSD_TEXT_TRANSFORM",
      message: `${layer.name ?? "Text"} carries a text transform; verify its position and scale after import.`,
      nodeId,
      sourcePath
    });
  }

  const layout = defaultTextLayout();
  const justification = text.paragraphStyle?.justification;

  return {
    plainText,
    runs,
    layout: {
      ...layout,
      horizontalAlign:
        justification === "center" ? "center" : justification === "right" ? "right" : "left"
    }
  };
}

function mapBlendMode(blendMode: string | undefined): DesignNode["blendMode"] {
  switch (blendMode) {
    case "multiply":
      return "multiply";
    case "screen":
      return "screen";
    case "overlay":
      return "overlay";
    case "darken":
      return "darken";
    case "lighten":
      return "lighten";
    case "color dodge":
      return "color-dodge";
    case "color burn":
      return "color-burn";
    case "hard light":
      return "hard-light";
    case "soft light":
      return "soft-light";
    case "difference":
      return "difference";
    case "exclusion":
      return "exclusion";
    case "hue":
      return "hue";
    case "saturation":
      return "saturation";
    case "color":
      return "color";
    case "luminosity":
      return "luminosity";
    default:
      return "normal";
  }
}

/** ag-psd colours are a union of colour spaces; only RGB and greyscale are handled. */
function toRgba(input: unknown): RGBA | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const color = input as Record<string, number>;

  if (typeof color.r === "number" && typeof color.g === "number" && typeof color.b === "number") {
    return rgba(color.r / 255, color.g / 255, color.b / 255, 1);
  }

  if (typeof color.k === "number" && Object.keys(color).length === 1) {
    const level = 1 - color.k / 255;

    return rgba(level, level, level, 1);
  }

  return null;
}
