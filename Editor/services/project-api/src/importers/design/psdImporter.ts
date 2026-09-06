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
  type NormalizedDesignBlendingOptions,
  type NormalizedDesignDocument,
  type NormalizedDesignEffect,
  type NormalizedDesignMask,
  type NormalizedDesignNode,
  type NormalizedDesignPage
} from "@grapix/shared-types";
import { resolveSourceBlendMode } from "./blendModes.js";
import { addDesignImportIssue, reportImportWarning } from "./importReport.js";
import { rectanglePath } from "./svgPath.js";

/** Axis-aligned rectangle path in object-local space, offset from the object origin. */
function offsetRectanglePath(x: number, y: number, width: number, height: number): BezierPath {
  const base = rectanglePath(width, height);
  return {
    ...base,
    vertices: base.vertices.map((point) => ({ x: point.x + x, y: point.y + y }))
  };
}

initializeCanvas(
  (width, height) => createCanvas(width, height) as any,
  undefined,
  (width, height) => new ImageData(width, height) as any
);

const BEVEL_STYLE_BY_PSD: Record<string, NonNullable<NormalizedDesignEffect["style"]>> = {
  "outer bevel": "outer-bevel",
  "inner bevel": "inner-bevel",
  emboss: "emboss",
  "pillow emboss": "pillow-emboss",
  "stroke emboss": "stroke-emboss"
};

const BEVEL_TECHNIQUE_BY_PSD: Record<string, NonNullable<NormalizedDesignEffect["bevelTechnique"]>> = {
  smooth: "smooth",
  "chisel hard": "chisel-hard",
  "chisel soft": "chisel-soft"
};

export function importPsdDocument(
  bytes: Buffer,
  sourceName: string,
  report: DesignImportReport
): NormalizedDesignDocument {
  const psd = readPsd(Uint8Array.from(bytes).buffer, {
    useImageData: true,
    skipThumbnail: true,
    throwForMissingFeatures: false,
    logMissingFeatures: true
  });
  reportImportWarning(
    report,
    "PSD feature checking was enabled while parsing. ag-psd reports unsupported constructs to its parser log but does not expose an enumerable callback, so unsupported constructs may have been omitted.",
    "warning",
    sourceName,
    "Parser feature-check notice"
  );
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
        // A layered PSD has no canvas colour of its own: whatever fills the frame is
        // a layer, and that layer is imported. Declaring white here paints an opaque
        // plate under a broadcast scene that is supposed to key.
        background: { type: "none" },
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

/**
 * Convert one sibling run, resolving Photoshop clipping masks.
 *
 * A layer with `clipping` is clipped to the alpha of the nearest layer below it in
 * the same group that is not itself clipped. Left unclipped, those layers draw at
 * full size: this file's heading gradient is a 1918x927 plate clipped to a 727x205
 * text layer, and importing it unclipped painted it over the whole canvas.
 */
function convertLayers(
  layers: Layer[],
  parentOrigin: { x: number; y: number },
  psd: Psd,
  report: DesignImportReport,
  assets: Map<string, NormalizedDesignAsset>
): NormalizedDesignNode[] {
  let clipBase: Layer | undefined;
  return layers.map((layer, index) => {
    const base = layer.clipping ? clipBase : undefined;
    if (!layer.clipping) clipBase = layer;
    return convertLayer(layer, index, parentOrigin, psd, report, assets, base);
  });
}

function convertLayer(
  layer: Layer,
  index: number,
  parentOrigin: { x: number; y: number },
  psd: Psd,
  report: DesignImportReport,
  assets: Map<string, NormalizedDesignAsset>,
  clipBase?: Layer
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
      // A bitmap mask's shape lives in its alpha channel, not in a path. Neither
      // renderer samples a mask alpha asset yet, and the layer bounds are the only
      // path available — authoring that as an `add` region silently hid or revealed
      // the whole layer depending on the mask's default colour (invariant 7). The
      // mask is carried as an inert record with its alpha asset until both
      // renderers can sample it, so the layer renders unmasked and says so.
      mode: "none",
      inverted: layer.mask.defaultColor === 0,
      opacity: layer.mask.userMaskDensity ?? 1,
      feather: { x: layer.mask.userMaskFeather ?? 0, y: layer.mask.userMaskFeather ?? 0 },
      expansion: 0,
      alphaAssetId: maskAssetId
    });
    reportImportWarning(
      report,
      `Bitmap mask on ${layer.name ?? id} is preserved with its alpha asset, but the layer renders unmasked: neither renderer samples mask alpha yet.`,
      "visual-difference",
      layer.name,
      "Inert mask with its alpha asset",
      id
    );
  }
  if (clipBase) {
    const baseLeft = clipBase.left ?? left;
    const baseTop = clipBase.top ?? top;
    const baseWidth = Math.max(0.01, (clipBase.right ?? baseLeft + 1) - baseLeft);
    const baseHeight = Math.max(0.01, (clipBase.bottom ?? baseTop + 1) - baseTop);
    masks.push({
      id: createSceneId("psd-clip-mask"),
      name: `${layer.name ?? "Layer"} clipped to ${clipBase.name ?? "base layer"}`,
      // Mask paths are object-local, so the base rectangle is expressed relative to
      // this layer's own origin.
      path: offsetRectanglePath(baseLeft - left, baseTop - top, baseWidth, baseHeight),
      mode: "add",
      inverted: false,
      opacity: 1,
      feather: { x: 0, y: 0 },
      expansion: 0
    });
    reportImportWarning(
      report,
      `${layer.name ?? id} is a clipping mask over ${clipBase.name ?? "the layer below"} and is clipped to that layer's bounds; clipping to its alpha needs mask-alpha sampling.`,
      "visual-difference",
      layer.name,
      "Clipped to the base layer's bounds",
      id
    );
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
  const effects = convertPsdEffects(layer.effects, psd.patterns, assets, report, layer.name ?? id, id);
  if (layer.adjustment) {
    reportImportWarning(report, `Adjustment layer ${layer.name ?? id} is preserved as an editable imported layer with source parameters.`, "visual-difference", layer.name, "Nested composition metadata", id);
  }

  const blend = resolveSourceBlendMode(layer.blendMode);
  if (!blend.exact) {
    reportImportWarning(
      report,
      `Photoshop blend mode "${layer.blendMode}" on ${layer.name ?? id} has no GrapiX equivalent and was imported as "${blend.mode}".`,
      "visual-difference",
      layer.name,
      `Nearest rendered blend mode: ${blend.mode}`,
      id
    );
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
    // NOT `layer.referencePoint`: that is Photoshop's free-transform reference in
    // DOCUMENT space, while `anchor` is the object-local pivot both renderers apply as
    // `T(x,y) · R · S · T(-anchor)`. Importing it moved every layer by its own
    // reference point - a full-canvas layer with `referencePoint.y = 1080` was drawn
    // one canvas height above the frame and simply disappeared. The source value is
    // kept in `sourceData` for round-tripping.
    anchor: { x: 0, y: 0 },
    opacity: layer.opacity ?? 1,
    fillOpacity: layer.fillOpacity ?? 1,
    visible: !layer.hidden,
    locked: Boolean(layer.protected?.position || layer.protected?.composite),
    blendMode: blend.mode,
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
    blendingOptions: convertPsdBlendingOptions(layer, report, layer.name ?? id, id),
    children: convertLayers(layer.children ?? [], { x: left, y: top }, psd, report, assets),
    componentId: layer.placedLayer?.id,
    componentProperties: layer.placedLayer ? { ...layer.placedLayer } : undefined,
    sourceData: {
      clipping: layer.clipping,
      clipBaseName: clipBase?.name,
      referencePoint: layer.referencePoint,
      transparencyProtected: layer.transparencyProtected,
      fillOpacity: layer.fillOpacity,
      adjustment: layer.adjustment,
      artboard: layer.artboard,
      vectorStroke: layer.vectorStroke,
      placedLayer: layer.placedLayer,
      animationFrames: layer.animationFrames,
      blendMode: layer.blendMode
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
export function convertPsdEffects(
  effects: LayerEffectsInfo | undefined,
  patterns: Psd["patterns"],
  assets: Map<string, NormalizedDesignAsset>,
  report: DesignImportReport,
  name: string,
  sourceNodeId: string
): NormalizedDesignEffect[] {
  if (!effects || effects.disabled) return [];
  const result: NormalizedDesignEffect[] = [];

  for (const effect of effects.dropShadow ?? []) {
    const enabled = effect.enabled !== false;
    const angle = effect.angle ?? 120;
    const distance = unitValue(effect.distance);
    result.push({
      type: "drop-shadow",
      enabled,
      opacity: effect.opacity,
      color: colorHex(effect.color),
      angle,
      useGlobalLight: effect.useGlobalLight,
      distance,
      offset: shadowOffset(angle, distance),
      spread: unitValue(effect.choke),
      size: unitValue(effect.size),
      radius: unitValue(effect.size),
      antialiased: effect.antialiased,
      contour: effect.contour,
      layerConceals: effect.layerConceals,
      blendMode: mapBlendMode(effect.blendMode),
      sourceBlendMode: effect.blendMode,
      sourceData: effect as unknown as Record<string, unknown>
    });
  }
  for (const effect of effects.innerShadow ?? []) {
    const enabled = effect.enabled !== false;
    const angle = effect.angle ?? 120;
    const distance = unitValue(effect.distance);
    result.push({
      type: "inner-shadow",
      enabled,
      opacity: effect.opacity,
      color: colorHex(effect.color),
      angle,
      useGlobalLight: effect.useGlobalLight,
      distance,
      offset: shadowOffset(angle, distance),
      choke: unitValue(effect.choke),
      spread: unitValue(effect.choke),
      size: unitValue(effect.size),
      radius: unitValue(effect.size),
      antialiased: effect.antialiased,
      contour: effect.contour,
      blendMode: mapBlendMode(effect.blendMode),
      sourceBlendMode: effect.blendMode,
      sourceData: effect as unknown as Record<string, unknown>
    });
  }
  if (effects.outerGlow) {
    const effect = effects.outerGlow;
    result.push({
      type: "outer-glow",
      enabled: effect.enabled !== false,
      opacity: effect.opacity,
      color: colorHex(effect.color),
      spread: unitValue(effect.choke),
      choke: unitValue(effect.choke),
      size: unitValue(effect.size),
      radius: unitValue(effect.size),
      noise: effect.noise,
      range: effect.range,
      jitter: effect.jitter,
      antialiased: effect.antialiased,
      contour: effect.contour,
      blendMode: mapBlendMode(effect.blendMode),
      sourceBlendMode: effect.blendMode,
      sourceData: effect as unknown as Record<string, unknown>
    });
  }
  if (effects.innerGlow) {
    const effect = effects.innerGlow;
    result.push({
      type: "inner-glow",
      enabled: effect.enabled !== false,
      opacity: effect.opacity,
      color: colorHex(effect.color),
      technique: effect.technique,
      source: effect.source,
      choke: unitValue(effect.choke),
      spread: unitValue(effect.choke),
      size: unitValue(effect.size),
      radius: unitValue(effect.size),
      noise: effect.noise,
      range: effect.range,
      jitter: effect.jitter,
      antialiased: effect.antialiased,
      contour: effect.contour,
      blendMode: mapBlendMode(effect.blendMode),
      sourceBlendMode: effect.blendMode,
      sourceData: effect as unknown as Record<string, unknown>
    });
  }
  if (effects.bevel) {
    const effect = effects.bevel;
    result.push({
      type: "bevel-emboss",
      enabled: effect.enabled !== false,
      style: effect.style ? BEVEL_STYLE_BY_PSD[effect.style] : undefined,
      bevelTechnique: effect.technique ? BEVEL_TECHNIQUE_BY_PSD[effect.technique] : undefined,
      depth: effect.strength,
      direction: effect.direction,
      size: unitValue(effect.size),
      radius: unitValue(effect.size),
      soften: unitValue(effect.soften),
      angle: effect.angle,
      altitude: effect.altitude,
      useGlobalLight: effect.useGlobalLight,
      highlightColor: colorHex(effect.highlightColor),
      highlightBlendMode: mapBlendMode(effect.highlightBlendMode),
      highlightSourceBlendMode: effect.highlightBlendMode,
      highlightOpacity: effect.highlightOpacity,
      shadowColor: colorHex(effect.shadowColor),
      shadowBlendMode: mapBlendMode(effect.shadowBlendMode),
      shadowSourceBlendMode: effect.shadowBlendMode,
      shadowOpacity: effect.shadowOpacity,
      glossContour: effect.contour,
      antialiasGloss: effect.antialiasGloss,
      contourEnabled: effect.useShape,
      contour: effect.useShape ? effect.contour : undefined,
      textureEnabled: effect.useTexture,
      sourceData: effect as unknown as Record<string, unknown>
    });
  }
  if (effects.satin) {
    const effect = effects.satin;
    result.push({
      type: "satin",
      enabled: effect.enabled !== false,
      opacity: effect.opacity,
      color: colorHex(effect.color),
      angle: effect.angle,
      distance: unitValue(effect.distance),
      size: unitValue(effect.size),
      radius: unitValue(effect.size),
      invert: effect.invert,
      antialiased: effect.antialiased,
      contour: effect.contour,
      blendMode: mapBlendMode(effect.blendMode),
      sourceBlendMode: effect.blendMode,
      sourceData: effect as unknown as Record<string, unknown>
    });
  }
  for (const effect of effects.solidFill ?? []) {
    result.push({
      type: "color-overlay",
      enabled: effect.enabled !== false,
      color: colorHex(effect.color),
      paint: { type: "solid", color: colorHex(effect.color) },
      opacity: effect.opacity,
      blendMode: mapBlendMode(effect.blendMode),
      sourceBlendMode: effect.blendMode,
      sourceData: effect as unknown as Record<string, unknown>
    });
  }
  for (const effect of effects.gradientOverlay ?? []) {
    result.push({
      type: "gradient-overlay",
      enabled: effect.enabled !== false,
      opacity: effect.opacity,
      paint: effect.gradient?.type === "solid"
        ? vectorContentPaint({ ...effect.gradient, style: effect.type, angle: effect.angle, offset: effect.offset, scale: effect.scale })
        : undefined,
      gradientStyle: effect.type,
      angle: effect.angle,
      scale: effect.scale,
      offset: effect.offset,
      reverse: effect.reverse,
      dither: effect.dither,
      alignWithLayer: effect.align,
      blendMode: mapBlendMode(effect.blendMode),
      sourceBlendMode: effect.blendMode,
      sourceData: effect as unknown as Record<string, unknown>
    });
  }
  if (effects.patternOverlay) {
    const effect = effects.patternOverlay;
    const enabled = effect.enabled !== false;
    const pattern = resolvePsdPattern(effect.pattern, patterns, assets, report, name, sourceNodeId, enabled);
    result.push({
      type: "pattern-overlay",
      enabled,
      opacity: effect.opacity,
      patternName: pattern.name,
      patternAssetId: pattern.assetId,
      scale: effect.scale,
      offset: effect.phase,
      linked: effect.align,
      blendMode: mapBlendMode(effect.blendMode),
      sourceBlendMode: effect.blendMode,
      sourceData: effect as unknown as Record<string, unknown>
    });
  }
  for (const effect of effects.stroke ?? []) {
    const enabled = effect.enabled !== false;
    const pattern = effect.fillType === "pattern"
      ? resolvePsdPattern(effect.pattern, patterns, assets, report, name, sourceNodeId, enabled)
      : {};
    result.push({
      type: "stroke",
      enabled,
      opacity: effect.opacity,
      size: unitValue(effect.size),
      radius: unitValue(effect.size),
      position: effect.position,
      fillType: effect.fillType,
      color: effect.color ? colorHex(effect.color) : undefined,
      paint: effect.gradient?.type === "solid"
        ? vectorContentPaint({
            ...effect.gradient,
            style: effect.gradient.style ?? "linear",
            angle: effect.gradient.angle,
            offset: effect.gradient.offset,
            scale: effect.gradient.scale
          })
        : undefined,
      patternName: pattern.name,
      patternAssetId: pattern.assetId,
      overprint: effect.overprint,
      blendMode: mapBlendMode(effect.blendMode),
      sourceBlendMode: effect.blendMode,
      sourceData: effect as unknown as Record<string, unknown>
    });
  }
  if (result.some((effect) => effect.enabled)) {
    reportImportWarning(
      report,
      `Photoshop layer effects on ${name} are unsupported by the current GrapiX renderers.`,
      "unsupported-effect",
      name,
      "Editable imported effect metadata",
      sourceNodeId
    );
    reportImportWarning(
      report,
      `Photoshop layer effects on ${name} remain editable after import, but current canvas and output renderers do not reproduce them yet.`,
      "visual-difference",
      name,
      "Editable imported effect metadata",
      sourceNodeId
    );
  }
  return result;
}

function resolvePsdPattern(
  reference: { id: string; name: string } | undefined,
  patterns: Psd["patterns"],
  assets: Map<string, NormalizedDesignAsset>,
  report: DesignImportReport,
  layerName: string,
  sourceNodeId: string,
  enabled: boolean
): { name?: string; assetId?: string } {
  if (!reference) return {};
  const pattern = patterns?.find((candidate) => candidate.id === reference.id);
  const name = pattern?.name ?? reference.name;
  if (pattern && pattern.bounds.w > 0 && pattern.bounds.h > 0 && pattern.data.length === pattern.bounds.w * pattern.bounds.h * 4) {
    const assetId = `psd-pattern-${safeId(pattern.id)}`;
    if (!assets.has(assetId)) {
      assets.set(assetId, {
        id: assetId,
        name: `${pattern.name}.png`,
        kind: "image",
        mimeType: "image/png",
        dataBase64: encodePixelData({ data: pattern.data, width: pattern.bounds.w, height: pattern.bounds.h }),
        width: pattern.bounds.w,
        height: pattern.bounds.h
      });
    }
    return { name, assetId };
  }
  if (enabled) {
    reportImportWarning(
      report,
      `Photoshop pattern "${name}" on ${layerName} could not be resolved to pixels, so no pattern asset was imported.`,
      "missing-asset",
      layerName,
      "Pattern name retained without an invented asset",
      sourceNodeId
    );
  }
  return { name };
}

function convertPsdBlendingOptions(
  layer: Layer,
  report: DesignImportReport,
  name: string,
  sourceNodeId: string
): NormalizedDesignBlendingOptions | undefined {
  const blendIf = decodeBlendIf(layer.channelBlendingRestrictions);
  const options: NormalizedDesignBlendingOptions = {
    fillOpacity: layer.fillOpacity,
    knockout: layer.knockout === false ? "none" : undefined,
    blendInteriorEffectsAsGroup: layer.blendInteriorElements,
    blendClippedLayersAsGroup: layer.blendClippendElements,
    transparencyShapesLayer: layer.transparencyShapesLayer,
    layerMaskHidesEffects: layer.layerMaskAsGlobalMask,
    blendIf
  };
  if (layer.knockout) {
    reportImportWarning(
      report,
      `Photoshop knockout on ${name} is retained in source metadata, but ag-psd collapses its shallow/deep value to a boolean.`,
      "visual-difference",
      name,
      "Typed knockout omitted because its depth is unavailable",
      sourceNodeId
    );
  }
  return Object.values(options).some((value) => value !== undefined) ? options : undefined;
}

function decodeBlendIf(values: number[] | undefined): NormalizedDesignBlendingOptions["blendIf"] {
  if (!values?.length) return undefined;
  const channels = ["gray", "red", "green", "blue"] as const;
  return values.slice(0, channels.length).map((value, index) => {
    const packed = value >>> 0;
    return {
      channel: channels[index],
      sourceBlackPoint: packed >>> 24,
      sourceWhitePoint: (packed >>> 16) & 0xff,
      targetBlackPoint: (packed >>> 8) & 0xff,
      targetWhitePoint: packed & 0xff
    };
  });
}

function unitValue(value: { value: number } | undefined): number {
  return value?.value ?? 0;
}

function shadowOffset(angle: number, distance: number): { x: number; y: number } {
  const radians = angle * Math.PI / 180;
  return { x: Math.cos(radians) * distance, y: Math.sin(radians) * distance };
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
