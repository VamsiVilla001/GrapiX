import { createCanvas, ImageData } from "@napi-rs/canvas";
import { initializeCanvas, readPsd, type BezierPath as PsdBezierPath, type Color, type Layer, type LayerEffectsInfo, type Psd, type VectorContent } from "ag-psd";
import { PNG } from "pngjs";
import {
  createSceneId,
  type BezierPath,
  type ColorValue,
  type DesignImportReport,
  type MaterialBlendMode,
  type NormalizedDesignAsset,
  type NormalizedDesignDocument,
  type NormalizedDesignEffect,
  type NormalizedDesignMask,
  type NormalizedDesignNode,
  type NormalizedDesignPage
} from "@grapix/shared-types";
import { addDesignImportIssue, reportImportWarning } from "./importReport.js";
import { rectanglePath } from "./svgPath.js";

initializeCanvas(
  (width, height) => createCanvas(width, height) as any,
  undefined,
  (width, height) => new ImageData(width, height) as any
);

export function importPsdDocument(
  bytes: Buffer,
  sourceName: string,
  report: DesignImportReport
): NormalizedDesignDocument {
  const psd = readPsd(Uint8Array.from(bytes).buffer, {
    useImageData: true,
    skipThumbnail: true,
    throwForMissingFeatures: false,
    logMissingFeatures: false
  });
  const assets = new Map<string, NormalizedDesignAsset>();
  for (const linked of psd.linkedFiles ?? []) {
    const assetId = `psd-linked-${safeId(linked.id || linked.name)}`;
    assets.set(assetId, {
      id: assetId,
      name: linked.name,
      kind: assetKind(linked.name),
      mimeType: mimeForName(linked.name),
      dataBase64: linked.data ? Buffer.from(linked.data).toString("base64") : undefined,
      linked: !linked.data
    });
    if (!linked.data) {
      reportImportWarning(report, `Linked Smart Object asset ${linked.name} is unavailable.`, "missing-asset", linked.name, "Source reference preserved");
    }
  }

  const topLayers = psd.children ?? [];
  const artboards = topLayers.filter((layer) => Boolean(layer.artboard));
  const pages: NormalizedDesignPage[] = artboards.length
    ? artboards.map((layer) => convertArtboard(layer, psd, report, assets))
    : [{
        id: "psd-document",
        name: sourceName.replace(/\.[^.]+$/, ""),
        width: psd.width,
        height: psd.height,
        background: { type: "solid", color: "#ffffff" },
        nodes: convertLayers(topLayers, { x: 0, y: 0 }, psd, report, assets),
        guides: psd.imageResources?.gridAndGuidesInformation?.guides?.map((guide) => ({
          orientation: guide.direction,
          position: guide.location
        }))
      }];

  return {
    schemaVersion: 1,
    sourceFormat: "psd",
    sourceName,
    colorSpace: String(psd.colorMode ?? "RGB"),
    width: psd.width,
    height: psd.height,
    pages,
    assets: [...assets.values()],
    fonts: collectPsdFonts(pages),
    components: {},
    variables: {},
    sourceMetadata: {
      channels: psd.channels,
      bitsPerChannel: psd.bitsPerChannel,
      colorMode: psd.colorMode,
      resolution: psd.imageResources?.resolutionInfo,
      alphaChannels: psd.imageResources?.alphaChannelNames ?? [],
      artboardCount: psd.artboards?.count ?? artboards.length
    }
  };
}

function convertArtboard(
  layer: Layer,
  psd: Psd,
  report: DesignImportReport,
  assets: Map<string, NormalizedDesignAsset>
): NormalizedDesignPage {
  const rect = layer.artboard!.rect;
  const width = Math.max(1, rect.right - rect.left);
  const height = Math.max(1, rect.bottom - rect.top);
  return {
    id: `psd-artboard-${safeId(String(layer.id ?? layer.name ?? createSceneId("artboard")))}`,
    name: layer.name ?? layer.artboard?.presetName ?? "PSD Artboard",
    width,
    height,
    background: { type: "solid", color: colorHex(layer.artboard?.color) },
    nodes: convertLayers(layer.children ?? [], { x: rect.left, y: rect.top }, psd, report, assets),
    guides: []
  };
}

function convertLayers(
  layers: Layer[],
  parentOrigin: { x: number; y: number },
  psd: Psd,
  report: DesignImportReport,
  assets: Map<string, NormalizedDesignAsset>
): NormalizedDesignNode[] {
  return layers.map((layer, index) => convertLayer(layer, index, parentOrigin, psd, report, assets));
}

function convertLayer(
  layer: Layer,
  index: number,
  parentOrigin: { x: number; y: number },
  psd: Psd,
  report: DesignImportReport,
  assets: Map<string, NormalizedDesignAsset>
): NormalizedDesignNode {
  const left = layer.left ?? layer.artboard?.rect.left ?? parentOrigin.x;
  const top = layer.top ?? layer.artboard?.rect.top ?? parentOrigin.y;
  const right = layer.right ?? layer.artboard?.rect.right ?? left + 1;
  const bottom = layer.bottom ?? layer.artboard?.rect.bottom ?? top + 1;
  const width = Math.max(0.01, right - left);
  const height = Math.max(0.01, bottom - top);
  const id = `psd-${safeId(String(layer.id ?? `${layer.name}-${index}`))}`;
  const text = layer.text;
  const shapePaths = layer.vectorFill && layer.vectorMask
    ? layer.vectorMask.paths.map((path) => convertPsdPath(path, left, top))
    : [];
  let assetId: string | undefined;
  if (layer.imageData && !shapePaths.length) {
    assetId = `${id}-pixels`;
    assets.set(assetId, {
      id: assetId,
      name: `${layer.name ?? "Layer"}.png`,
      kind: "image",
      mimeType: "image/png",
      dataBase64: encodePixelData(layer.imageData),
      width: layer.imageData.width,
      height: layer.imageData.height
    });
  }
  if (layer.placedLayer?.placed) {
    const linkedId = `psd-linked-${safeId(layer.placedLayer.placed)}`;
    if (assets.has(linkedId)) assetId = linkedId;
  }
  const masks: NormalizedDesignMask[] = [];
  if (layer.vectorMask && !layer.vectorFill) {
    layer.vectorMask.paths.forEach((path, maskIndex) => {
      masks.push({
        id: createSceneId("psd-vector-mask"),
        name: `${layer.name ?? "Layer"} Vector Mask ${maskIndex + 1}`,
        path: convertPsdPath(path, left, top),
        mode: mapMaskMode(path.operation),
        inverted: Boolean(layer.vectorMask?.invert),
        opacity: layer.mask?.vectorMaskDensity ?? 1,
        feather: {
          x: layer.mask?.vectorMaskFeather ?? 0,
          y: layer.mask?.vectorMaskFeather ?? 0
        },
        expansion: 0
      });
    });
  }
  if (layer.mask?.imageData) {
    const maskAssetId = `${id}-alpha-mask`;
    assets.set(maskAssetId, {
      id: maskAssetId,
      name: `${layer.name ?? "Layer"} mask.png`,
      kind: "image",
      mimeType: "image/png",
      dataBase64: encodePixelData(layer.mask.imageData),
      width: layer.mask.imageData.width,
      height: layer.mask.imageData.height
    });
    masks.push({
      id: createSceneId("psd-alpha-mask"),
      name: `${layer.name ?? "Layer"} Alpha Mask`,
      path: rectanglePath(width, height),
      mode: "add",
      inverted: layer.mask.defaultColor === 0,
      opacity: layer.mask.userMaskDensity ?? 1,
      feather: { x: layer.mask.userMaskFeather ?? 0, y: layer.mask.userMaskFeather ?? 0 },
      expansion: 0,
      alphaAssetId: maskAssetId
    });
    reportImportWarning(report, `Bitmap mask on ${layer.name ?? id} is preserved with its alpha asset; native alpha-mask sampling is pending.`, "visual-difference", layer.name);
  }
  const fills = layer.vectorFill ? [vectorContentPaint(layer.vectorFill)] : text?.style?.fillColor ? [{ type: "solid" as const, color: colorHex(text.style.fillColor) }] : [];
  const strokes = layer.vectorStroke?.content ? [vectorContentPaint(layer.vectorStroke.content)] : text?.style?.strokeColor ? [{ type: "solid" as const, color: colorHex(text.style.strokeColor) }] : [];
  const type = layer.children ? "group"
    : layer.artboard ? "artboard"
      : text ? "text"
        : shapePaths.length ? "path"
          : layer.adjustment ? "adjustment"
            : layer.placedLayer ? "smart-object"
              : "image";
  const effects = convertPsdEffects(layer.effects, report, layer.name ?? id);
  if (layer.adjustment) {
    reportImportWarning(report, `Adjustment layer ${layer.name ?? id} is preserved as an editable imported layer with source parameters.`, "visual-difference", layer.name, "Nested composition metadata");
  }

  return {
    id,
    sourceId: String(layer.id ?? ""),
    name: layer.name ?? `PSD Layer ${index + 1}`,
    type,
    x: left - parentOrigin.x,
    y: top - parentOrigin.y,
    width,
    height,
    rotation: placedRotation(layer),
    scaleX: 1,
    scaleY: 1,
    anchor: layer.referencePoint ?? { x: 0, y: 0 },
    opacity: layer.opacity ?? 1,
    fillOpacity: layer.fillOpacity ?? 1,
    visible: !layer.hidden,
    locked: Boolean(layer.protected?.position || layer.protected?.composite),
    blendMode: mapBlendMode(layer.blendMode),
    fills,
    strokes,
    strokeWidth: layer.vectorStroke?.lineWidth?.value ?? text?.style?.outlineWidth ?? 0,
    path: shapePaths[0],
    compoundPaths: shapePaths.length > 1 ? shapePaths.slice(1) : undefined,
    text: text ? {
      characters: text.text,
      fontFamily: text.style?.font?.name ?? "Arial",
      fontStyle: text.style?.fauxItalic ? "italic" : "normal",
      fontWeight: text.style?.fauxBold ? "700" : "400",
      fontSize: text.style?.fontSize ?? 16,
      lineHeight: text.style?.leading ?? (text.style?.fontSize ?? 16) * 1.2,
      letterSpacing: text.style?.tracking ?? 0,
      paragraphSpacing: text.paragraphStyle?.spaceAfter ?? 0,
      align: mapParagraphAlign(text.paragraphStyle?.justification),
      writingMode: text.orientation === "vertical" ? "vertical-rl" : "horizontal-tb",
      textLayout: text.shapeType === "box" ? "paragraph" : "point",
      direction: "ltr"
    } : undefined,
    assetId,
    masks,
    effects,
    children: convertLayers(layer.children ?? [], { x: left, y: top }, psd, report, assets),
    componentId: layer.placedLayer?.id,
    componentProperties: layer.placedLayer ? { ...layer.placedLayer } : undefined,
    sourceData: {
      clipping: layer.clipping,
      transparencyProtected: layer.transparencyProtected,
      fillOpacity: layer.fillOpacity,
      adjustment: layer.adjustment,
      artboard: layer.artboard,
      vectorStroke: layer.vectorStroke,
      placedLayer: layer.placedLayer,
      animationFrames: layer.animationFrames
    }
  };
}

function convertPsdPath(path: PsdBezierPath, originX: number, originY: number): BezierPath {
  return {
    closed: !path.open,
    vertices: path.knots.map((knot) => ({ x: knot.points[2] - originX, y: knot.points[3] - originY })),
    inTangents: path.knots.map((knot) => ({ x: knot.points[0] - knot.points[2], y: knot.points[1] - knot.points[3] })),
    outTangents: path.knots.map((knot) => ({ x: knot.points[4] - knot.points[2], y: knot.points[5] - knot.points[3] }))
  };
}

function vectorContentPaint(content: VectorContent): ColorValue {
  if (content.type === "color") return { type: "solid", color: colorHex(content.color) };
  if (content.type === "solid") {
    const stops = content.colorStops.map((stop, index) => ({
      id: createSceneId(`psd-stop-${index}`),
      position: stop.location,
      color: colorHex(stop.color),
      opacity: nearestOpacity(content.opacityStops, stop.location)
    }));
    if (content.style === "radial") {
      return {
        type: "radial-gradient",
        centerX: 0.5 + (content.offset?.x ?? 0) / 100,
        centerY: 0.5 + (content.offset?.y ?? 0) / 100,
        radiusX: (content.scale ?? 100) / 200,
        radiusY: (content.scale ?? 100) / 200,
        stops,
        spread: "pad",
        coordinateMode: "object"
      };
    }
    const angle = content.angle ?? 0;
    const radians = angle * Math.PI / 180;
    return {
      type: "linear-gradient",
      angle,
      startX: 0.5 - Math.cos(radians) / 2,
      startY: 0.5 - Math.sin(radians) / 2,
      endX: 0.5 + Math.cos(radians) / 2,
      endY: 0.5 + Math.sin(radians) / 2,
      stops,
      spread: "pad",
      coordinateMode: "object"
    };
  }
  return { type: "solid", color: "#808080" };
}

function convertPsdEffects(effects: LayerEffectsInfo | undefined, report: DesignImportReport, name: string): NormalizedDesignEffect[] {
  if (!effects || effects.disabled) return [];
  const result: NormalizedDesignEffect[] = [];
  const shadows = [
    ...(effects.dropShadow ?? []).map((effect) => ({ effect, type: "drop-shadow" as const })),
    ...(effects.innerShadow ?? []).map((effect) => ({ effect, type: "inner-shadow" as const }))
  ];
  for (const { effect, type } of shadows) {
    const angle = effect.angle ?? 120;
    const distance = effect.distance?.value ?? 0;
    result.push({
      type,
      enabled: effect.enabled !== false,
      opacity: effect.opacity ?? 1,
      color: colorHex(effect.color),
      radius: effect.size?.value ?? 0,
      spread: effect.choke?.value ?? 0,
      angle,
      offset: { x: Math.cos(angle * Math.PI / 180) * distance, y: Math.sin(angle * Math.PI / 180) * distance },
      blendMode: mapBlendMode(effect.blendMode),
      sourceData: effect as unknown as Record<string, unknown>
    });
  }
  const simple: Array<[unknown, NormalizedDesignEffect["type"]]> = [
    [effects.outerGlow, "outer-glow"],
    [effects.innerGlow, "inner-glow"],
    [effects.bevel, "bevel-emboss"],
    [effects.satin, "satin"],
    [effects.patternOverlay, "pattern-overlay"]
  ];
  for (const [effect, type] of simple) {
    if (!effect) continue;
    result.push({ type, enabled: (effect as { enabled?: boolean }).enabled !== false, sourceData: effect as Record<string, unknown> });
    if (type !== "outer-glow" && type !== "inner-glow") {
      reportImportWarning(report, `Photoshop ${type} on ${name} is retained as editable source effect metadata.`, "unsupported-effect", name);
    }
  }
  for (const effect of effects.solidFill ?? []) {
    result.push({ type: "color-overlay", enabled: effect.enabled !== false, color: colorHex(effect.color), opacity: effect.opacity, blendMode: mapBlendMode(effect.blendMode), sourceData: effect as unknown as Record<string, unknown> });
  }
  for (const effect of effects.gradientOverlay ?? []) {
    result.push({ type: "gradient-overlay", enabled: effect.enabled !== false, opacity: effect.opacity, paint: effect.gradient?.type === "solid" ? vectorContentPaint({ ...effect.gradient, style: effect.type, angle: effect.angle, offset: effect.offset, scale: effect.scale }) : undefined, sourceData: effect as unknown as Record<string, unknown> });
  }
  for (const effect of effects.stroke ?? []) {
    result.push({ type: "stroke", enabled: effect.enabled !== false, opacity: effect.opacity, color: colorHex(effect.color), radius: effect.size?.value, blendMode: mapBlendMode(effect.blendMode), sourceData: effect as unknown as Record<string, unknown> });
  }
  if (result.length > 0) {
    reportImportWarning(
      report,
      `Photoshop layer effects on ${name} remain editable after import, but current canvas and output renderers do not reproduce them yet.`,
      "visual-difference",
      name,
      "Editable imported effect metadata"
    );
  }
  return result;
}

function encodePixelData(imageData: { data: ArrayLike<number>; width: number; height: number }): string {
  const png = new PNG({ width: imageData.width, height: imageData.height });
  const source = imageData.data;
  const factor = source.length === imageData.width * imageData.height * 4 ? 1 : Math.max(1, Math.floor(source.length / (imageData.width * imageData.height * 4)));
  for (let index = 0; index < png.data.length; index += 1) {
    const value = Number(source[index * factor] ?? 0);
    png.data[index] = value <= 1 && !Number.isInteger(value) ? Math.round(value * 255) : value > 255 ? Math.round(value / 257) : Math.round(value);
  }
  return PNG.sync.write(png).toString("base64");
}

function colorHex(color: Color | undefined): string {
  if (!color) return "#000000";
  if ("r" in color) return rgbHex(color.r, color.g, color.b, "a" in color ? color.a : 255);
  if ("fr" in color) return rgbHex(color.fr * 255, color.fg * 255, color.fb * 255, 255);
  if ("k" in color) return rgbHex(255 - color.k, 255 - color.k, 255 - color.k, 255);
  if ("c" in color) {
    const cmyk = color as unknown as { c: number; m: number; y: number; k: number };
    const c = cmyk.c / 255, m = cmyk.m / 255, y = cmyk.y / 255, k = cmyk.k / 255;
    return rgbHex(255 * (1 - c) * (1 - k), 255 * (1 - m) * (1 - k), 255 * (1 - y) * (1 - k), 255);
  }
  if ("h" in color) {
    const hue = color.h * 360, saturation = color.s, light = color.b;
    const chroma = light * saturation;
    const x = chroma * (1 - Math.abs((hue / 60) % 2 - 1));
    const [r, g, b] = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x] : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
    const match = light - chroma;
    return rgbHex((r + match) * 255, (g + match) * 255, (b + match) * 255, 255);
  }
  return "#808080";
}

function rgbHex(red: number, green: number, blue: number, alpha: number): string {
  const hex = (value: number) => Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, "0");
  const base = `#${hex(red)}${hex(green)}${hex(blue)}`;
  return alpha < 255 ? `${base}${hex(alpha)}` : base;
}

function mapBlendMode(value: string | undefined): MaterialBlendMode {
  if (value === "multiply") return "multiply";
  if (value === "screen") return "screen";
  if (value === "overlay") return "overlay";
  if (value === "darken" || value === "darker color") return "darken";
  if (value === "lighten" || value === "lighter color") return "lighten";
  if (value === "linear dodge" || value === "color dodge") return "add";
  if (value === "subtract") return "subtract";
  return "normal";
}

function mapMaskMode(operation: PsdBezierPath["operation"]): NormalizedDesignMask["mode"] {
  return operation === "subtract" ? "subtract" : operation === "intersect" ? "intersect" : "add";
}

function placedRotation(layer: Layer): number {
  const transform = layer.placedLayer?.transform;
  if (!transform || transform.length < 4) return 0;
  return Math.atan2(transform[3] - transform[1], transform[2] - transform[0]) * 180 / Math.PI;
}

function nearestOpacity(stops: Array<{ location: number; opacity: number }>, position: number): number {
  return [...stops].sort((left, right) => Math.abs(left.location - position) - Math.abs(right.location - position))[0]?.opacity ?? 1;
}

function mapParagraphAlign(value: unknown): "left" | "center" | "right" {
  const text = String(value ?? "").toLowerCase();
  return text.includes("center") ? "center" : text.includes("right") ? "right" : "left";
}

function collectPsdFonts(pages: NormalizedDesignPage[]) {
  const fonts = new Set<string>();
  const walk = (nodes: NormalizedDesignNode[]) => nodes.forEach((node) => {
    if (node.text?.fontFamily) fonts.add(node.text.fontFamily);
    walk(node.children);
  });
  pages.forEach((page) => walk(page.nodes));
  return [...fonts].map((family) => ({ family, sourceName: family }));
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function assetKind(name: string): NormalizedDesignAsset["kind"] {
  return /\.(png|jpe?g|webp|gif|tiff?)$/i.test(name) ? "image" : /\.(svg|pdf|ai)$/i.test(name) ? "svg" : "source";
}

function mimeForName(name: string): string {
  if (/\.png$/i.test(name)) return "image/png";
  if (/\.jpe?g$/i.test(name)) return "image/jpeg";
  if (/\.svg$/i.test(name)) return "image/svg+xml";
  if (/\.pdf$/i.test(name)) return "application/pdf";
  return "application/octet-stream";
}
