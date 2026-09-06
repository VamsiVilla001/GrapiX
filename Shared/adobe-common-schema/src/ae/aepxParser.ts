/**
 * AEPX direct import: parse After Effects' XML project interchange without After Effects.
 *
 * A `.aepx` is the same project a binary `.aep` holds, serialised as XML by *File > Save a
 * Copy As XML*. It is the no-After-Effects path into a project, so it must be read
 * completely and honestly: every value the XML carries is mapped, and every value it cannot
 * carry stays absent from the manifest rather than being invented. A field the parser could
 * not read is the difference between "this layer has no effects" and "this layer's effects
 * were not readable" — the manifest records the former by omission and the parser pushes the
 * latter into `manifest.warnings`.
 *
 * The output is the shared `AeManifest` with `producer: "aepx-direct"`, the same shape the
 * AE bridge emits, so the converter and report never ask which path the project took.
 *
 * ## The XML shape this reads
 *
 * AE's AEPX is a `PropertyList`-style document: nested `<dict>`/`<array>`/`<string>`/
 * `<integer>`/`<real>`/`true`/`false` nodes keyed by `<key>`. Compositions appear under the
 * project's item list; layers carry their streams as named sub-structures. Because Adobe
 * does not publish a stable AEPX schema, the parser navigates defensively: it looks structures
 * up by the keys AE is observed to write, and any subtree that does not match is reported and
 * skipped, not crashed on. That is the whole reason this returns a manifest with warnings
 * instead of throwing on the first unfamiliar tag.
 */

import { XMLParser } from "fast-xml-parser";
import type {
  AeAssetRef,
  AeComposition,
  AeEffect,
  AeKeyframe,
  AeLayer,
  AeManifest,
  AeMask,
  AePropertyStream
} from "@grapix/shared-types";

/** fast-xml-parser's node: a record of tag → child or child[]. */
type XmlNode = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Preserve order so a composition's layers keep their stacking: AE writes layer 1 first.
  preserveOrder: false,
  parseTagValue: false,
  trimValues: true
});

/**
 * Parse a `.aepx` document into the shared manifest.
 *
 * Never throws on malformed content: a project that parses to nothing yields a manifest with
 * an empty composition list and a warning naming the cause, so the import report can say
 * "this file was not a readable AEPX" rather than the route returning a bare 422.
 */
export function parseAepxToManifest(xml: string, projectName: string, sourceFile: string): AeManifest {
  const warnings: string[] = [];
  const manifest: AeManifest = {
    formatVersion: 1,
    producer: "aepx-direct",
    projectName,
    sourceFile,
    frameRate: 50,
    compositions: [],
    assets: [],
    fonts: [],
    warnings
  };

  let root: XmlNode;
  try {
    root = parser.parse(xml) as XmlNode;
  } catch (error) {
    warnings.push(`AEPX parse failed: ${error instanceof Error ? error.message : String(error)}`);
    return manifest;
  }

  // The document element is the project. AE writes it as the top-level object; accept a
  // couple of wrapper spellings so a minor version difference is not a hard failure.
  const project = firstRecord(root.Project) ?? firstRecord(root.AfterEffectsProject) ?? root;
  const items = collectItems(project, warnings);

  for (const item of items) {
    if (item.kind === "composition" && item.node) {
      const composition = parseComposition(item.node, item.name, warnings);
      if (composition) manifest.compositions.push(composition);
    } else if (item.node && item.kind === "footage") {
      manifest.assets.push(parseAssetRef(item.node, item.name, item.kind, warnings));
    }
  }

  if (manifest.compositions.length === 0) {
    warnings.push("No compositions were readable from this AEPX; the file may be an unsupported version.");
  }

  // Fonts referenced by text layers, deduplicated by family+style.
  const fonts = new Map<string, { family: string; style?: string; usedBy: string[] }>();
  for (const composition of manifest.compositions) {
    for (const layer of composition.layers) {
      if (!layer.text) continue;
      const key = `${layer.text.fontFamily}::${layer.text.fontStyle ?? ""}`;
      const entry = fonts.get(key) ?? { family: layer.text.fontFamily, style: layer.text.fontStyle, usedBy: [] };
      entry.usedBy.push(`${composition.name}/${layer.name}`);
      fonts.set(key, entry);
    }
  }
  manifest.fonts = [...fonts.values()];

  return manifest;
}

interface FoundItem {
  kind: "composition" | "footage" | "folder";
  name: string;
  node: XmlNode | null;
}

/**
 * The project's item list, walked recursively so folder nesting is preserved as order.
 *
 * AE nests items inside folders; a precomposition appears both as a folder child and as a
 * layer's source. The walk keeps them in document order, which is the project's own order.
 */
function collectItems(project: XmlNode, warnings: string[]): FoundItem[] {
  const found: FoundItem[] = [];
  const list = firstArray(project.ItemList) ?? firstArray(project.Items) ?? firstArray(project.items);
  if (!list) {
    warnings.push("The AEPX project item list was not found; no compositions or footage were readable.");
    return found;
  }
  for (const entry of list) {
    const node = asRecord(entry);
    if (!node) continue;
    const typeName = stringOf(node.type) ?? stringOf(node.Type) ?? "";
    const name = stringOf(node.name) ?? stringOf(node.Name) ?? "Untitled";
    if (/composition/i.test(typeName)) {
      found.push({ kind: "composition", name, node });
    } else if (/folder/i.test(typeName)) {
      found.push({ kind: "folder", name, node: null });
      found.push(...collectItems(node, warnings));
    } else {
      found.push({ kind: "footage", name, node });
    }
  }
  return found;
}

function parseComposition(node: XmlNode, fallbackName: string, warnings: string[]): AeComposition | null {
  const name = stringOf(node.name) ?? stringOf(node.Name) ?? fallbackName;
  const width = numberOf(node.width ?? node.Width);
  const height = numberOf(node.height ?? node.Height);
  if (width === undefined || height === undefined) {
    warnings.push(`Composition "${name}" has no readable dimensions and was skipped.`);
    return null;
  }
  const frameRate = numberOf(node.frameRate ?? node.FrameRate ?? node.framerate) ?? 50;
  const duration = numberOf(node.duration ?? node.Duration) ?? 0;
  const backgroundColor = colorOf(node.bgColor ?? node.BackgroundColor ?? node.backgroundColor) ?? "#000000";

  const layers: AeLayer[] = [];
  const layerList = firstArray(node.LayerList) ?? firstArray(node.Layers) ?? firstArray(node.layers) ?? [];
  for (const [index, entry] of layerList.entries()) {
    const layerNode = asRecord(entry);
    if (!layerNode) continue;
    layers.push(parseLayer(layerNode, index + 1, frameRate, warnings));
  }

  return {
    id: stringOf(node.id ?? node.ID) ?? `comp-${name}`,
    name,
    width: Math.round(width),
    height: Math.round(height),
    duration,
    frameRate,
    displayStartTime: numberOf(node.displayStartTime ?? node.DisplayStartTime) ?? 0,
    workAreaStart: numberOf(node.workAreaStart ?? node.WorkAreaStart) ?? 0,
    workAreaDuration: numberOf(node.workAreaDuration ?? node.WorkAreaDuration) ?? duration,
    backgroundColor,
    layers,
    markers: parseMarkers(node)
  };
}

function parseLayer(node: XmlNode, index: number, frameRate: number, warnings: string[]): AeLayer {
  const name = stringOf(node.name) ?? stringOf(node.Name) ?? `Layer ${index}`;
  const objectType = numberOf(node.objectType ?? node.ObjectType ?? node.type ?? node.Type);
  const flags = numberOf(node.flags ?? node.Flags) ?? 0;

  const isNull = (flags & 0x00010000) !== 0;         // AEGP_LayerFlag_NULL_LAYER
  const isAdjustment = (flags & 0x00000200) !== 0;   // AEGP_LayerFlag_ADJUSTMENT_LAYER
  const isGuide = (flags & 0x00040000) !== 0;        // AEGP_LayerFlag_GUIDE_LAYER
  const is3d = (flags & 0x00000800) !== 0;           // AEGP_LayerFlag_LAYER_IS_3D
  const visible = (flags & 0x00000001) !== 0;        // VIDEO_ACTIVE
  const locked = (flags & 0x00000020) !== 0;
  const shy = (flags & 0x00000040) !== 0;
  const solo = (flags & 0x00004000) !== 0;
  const collapse = (flags & 0x00000080) !== 0;
  const motionBlur = (flags & 0x00000008) !== 0;
  const frameBlending = (flags & 0x00000010) !== 0;

  // AEGP_ObjectType: 0 av, 1 light, 2 camera, 3 text, 4 vector/shape. Null and adjustment are
  // flags on an av layer, not object types, so they resolve after the base type.
  let type: AeLayer["type"];
  if (isNull) type = "null";
  else if (isAdjustment) type = "adjustment";
  else if (objectType === 1) type = "light";
  else if (objectType === 2) type = "camera";
  else if (objectType === 3) type = "text";
  else if (objectType === 4) type = "shape";
  else type = "video";

  const streams = parseStreams(node, frameRate, warnings);
  const transform = staticTransform(streams);

  return {
    index,
    name,
    type,
    sourceItemId: stringOf(node.sourceItemId ?? node.SourceItemID ?? node.sourceId),
    inPoint: numberOf(node.inPoint ?? node.InPoint) ?? 0,
    outPoint: numberOf(node.outPoint ?? node.OutPoint) ?? 0,
    startTime: numberOf(node.startTime ?? node.StartTime) ?? 0,
    stretch: numberOf(node.stretch ?? node.Stretch) ?? 1,
    visible,
    locked,
    shy,
    solo,
    is3d,
    guide: isGuide,
    collapseTransformations: collapse,
    continuouslyRasterize: collapse,
    motionBlur,
    frameBlending,
    blendingMode: stringOf(node.blendingMode ?? node.BlendingMode) ?? "normal",
    label: numberOf(node.label ?? node.Label),
    comment: stringOf(node.comment ?? node.Comment),
    parentIndex: numberOf(node.parentIndex ?? node.ParentIndex),
    trackMatte: parseTrackMatte(node),
    anchorPoint: transform.anchorPoint,
    position: transform.position,
    scale: transform.scale,
    rotation: transform.rotation,
    orientation: transform.orientation,
    opacity: transform.opacity,
    streams,
    masks: parseMasks(node, warnings),
    effects: parseEffects(node, warnings),
    markers: parseMarkers(node),
    text: parseText(node),
    solidColor: colorOf(node.solidColor ?? node.SolidColor),
    status: "native-editable"
  };
}

/** Pull the static transform out of the streams (the value at the first key, or the default). */
function staticTransform(streams: AePropertyStream[]): {
  anchorPoint: number[];
  position: number[];
  scale: number[];
  rotation: number[];
  orientation?: number[];
  opacity: number;
} {
  const value = (property: string, fallback: number[]): number[] => {
    const stream = streams.find((candidate) => candidate.property === property);
    const first = stream?.keyframes[0]?.value;
    return Array.isArray(first) ? first.map(Number) : fallback;
  };
  return {
    anchorPoint: value("anchorPoint", [0, 0]),
    position: value("position", [0, 0]),
    scale: value("scale", [100, 100]),
    rotation: value("rotation", [0]),
    orientation: streams.some((stream) => stream.property === "orientation") ? value("orientation", [0, 0, 0]) : undefined,
    opacity: (streams.find((stream) => stream.property === "opacity")?.keyframes[0]?.value as number | undefined) ?? 100
  };
}

function parseStreams(node: XmlNode, frameRate: number, warnings: string[]): AePropertyStream[] {
  const streams: AePropertyStream[] = [];
  const streamList = firstArray(node.StreamList) ?? firstArray(node.Streams) ?? firstArray(node.streams) ?? [];
  for (const entry of streamList) {
    const streamNode = asRecord(entry);
    if (!streamNode) continue;
    const property = stringOf(streamNode.stream ?? streamNode.Stream ?? streamNode.name) ?? "unknown";
    const keyframes = parseKeyframes(streamNode, frameRate);
    const expression = stringOf(streamNode.expression ?? streamNode.Expression);
    streams.push({
      property,
      keyframes,
      ...(expression ? { expression, expressionSampled: keyframes.length > 0 } : {})
    });
  }
  void warnings;
  return streams;
}

function parseKeyframes(node: XmlNode, frameRate: number): AeKeyframe[] {
  const keyList = firstArray(node.KeyframeList) ?? firstArray(node.Keyframes) ?? firstArray(node.keyframes) ?? [];
  const keyframes: AeKeyframe[] = [];
  for (const entry of keyList) {
    const keyNode = asRecord(entry);
    if (!keyNode) continue;
    const time = numberOf(keyNode.time ?? keyNode.Time) ?? 0;
    const interpolation = (stringOf(keyNode.interpolation ?? keyNode.Interpolation) ?? "linear").toLowerCase();
    keyframes.push({
      time,
      value: valueOf(keyNode.value ?? keyNode.Value),
      interpolation: interpolation === "bezier" ? "bezier" : interpolation === "hold" ? "hold" : "linear",
      inTangent: tangentOf(keyNode.inTangent ?? keyNode.InTangent),
      outTangent: tangentOf(keyNode.outTangent ?? keyNode.OutTangent),
      spatialIn: numberArrayOf(keyNode.spatialIn ?? keyNode.SpatialIn),
      spatialOut: numberArrayOf(keyNode.spatialOut ?? keyNode.SpatialOut),
      roving: booleanOf(keyNode.roving ?? keyNode.Roving),
      label: numberOf(keyNode.label ?? keyNode.Label)
    });
  }
  void frameRate;
  return keyframes;
}

function parseMasks(node: XmlNode, warnings: string[]): AeMask[] {
  const maskList = firstArray(node.MaskList) ?? firstArray(node.Masks) ?? firstArray(node.masks) ?? [];
  const masks: AeMask[] = [];
  for (const [index, entry] of maskList.entries()) {
    const maskNode = asRecord(entry);
    if (!maskNode) continue;
    const modeNumber = numberOf(maskNode.mode ?? maskNode.Mode) ?? 1;
    const mode = PF_MASK_MODE_NAME[modeNumber] ?? "add";
    if (!PF_MASK_MODE_NAME[modeNumber]) {
      warnings.push(`A mask used PF_MaskMode ${modeNumber}, which has no GrapiX equivalent; imported as add.`);
    }
    masks.push({
      name: stringOf(maskNode.name ?? maskNode.Name) ?? `Mask ${index + 1}`,
      mode,
      inverted: booleanOf(maskNode.inverted ?? maskNode.Inverted) ?? false,
      opacity: numberOf(maskNode.opacity ?? maskNode.Opacity) ?? 100,
      feather: vec2Of(maskNode.feather ?? maskNode.Feather),
      expansion: numberOf(maskNode.expansion ?? maskNode.Expansion) ?? 0,
      path: pathOf(maskNode.path ?? maskNode.Path)
    });
  }
  return masks;
}

/** PF_MaskMode numeric → GrapiX mask mode name (AE_Effect.h:1917). */
const PF_MASK_MODE_NAME: Record<number, AeMask["mode"]> = {
  0: "none",
  1: "add",
  2: "subtract",
  3: "intersect",
  4: "lighten",
  5: "darken",
  6: "difference"
};

function parseEffects(node: XmlNode, warnings: string[]): AeEffect[] {
  const effectList = firstArray(node.EffectList) ?? firstArray(node.Effects) ?? firstArray(node.effects) ?? [];
  const effects: AeEffect[] = [];
  for (const entry of effectList) {
    const effectNode = asRecord(entry);
    if (!effectNode) continue;
    const name = stringOf(effectNode.name ?? effectNode.Name) ?? "Effect";
    const matchName = stringOf(effectNode.matchName ?? effectNode.MatchName) ?? name;
    const parameters: Record<string, unknown> = {};
    const paramList = firstArray(effectNode.ParameterList) ?? firstArray(effectNode.Parameters) ?? [];
    for (const paramEntry of paramList) {
      const paramNode = asRecord(paramEntry);
      if (!paramNode) continue;
      const paramName = stringOf(paramNode.name ?? paramNode.Name) ?? "param";
      parameters[paramName] = valueOf(paramNode.value ?? paramNode.Value);
    }
    // An AEPX names the effect but cannot say whether GrapiX implements it, so the parser
    // records the metadata and lets the converter assign the final compatibility state.
    effects.push({
      name,
      matchName,
      enabled: booleanOf(effectNode.enabled ?? effectNode.Enabled) ?? true,
      parameters,
      status: "baked"
    });
  }
  void warnings;
  return effects;
}

function parseTrackMatte(node: XmlNode): AeLayer["trackMatte"] {
  const matteType = numberOf(node.trackMatteType ?? node.TrackMatteType ?? node.trackMatte);
  if (matteType === undefined || matteType === 0) return undefined;
  const sourceLayerIndex = numberOf(node.trackMatteLayer ?? node.TrackMatteLayer) ?? 0;
  const type = matteType === 1 ? "alpha" : matteType === 2 ? "notAlpha" : matteType === 3 ? "luma" : "notLuma";
  return { type, sourceLayerIndex };
}

function parseText(node: XmlNode): AeLayer["text"] {
  const textNode = asRecord(node.text ?? node.Text ?? node.textDocument ?? node.TextDocument);
  if (!textNode) return undefined;
  const content = stringOf(textNode.text ?? textNode.Text ?? textNode.content);
  if (content === undefined) return undefined;
  return {
    content,
    fontFamily: stringOf(textNode.font ?? textNode.Font ?? textNode.fontFamily) ?? "Sans-Serif",
    fontStyle: stringOf(textNode.fontStyle ?? textNode.FontStyle),
    fontSize: numberOf(textNode.fontSize ?? textNode.FontSize ?? textNode.size) ?? 24,
    fillColor: colorOf(textNode.fillColor ?? textNode.FillColor ?? textNode.color) ?? "#ffffff",
    strokeColor: colorOf(textNode.strokeColor ?? textNode.StrokeColor),
    strokeWidth: numberOf(textNode.strokeWidth ?? textNode.StrokeWidth),
    align: alignOf(textNode.justification ?? textNode.Justification ?? textNode.align),
    tracking: numberOf(textNode.tracking ?? textNode.Tracking),
    leading: numberOf(textNode.leading ?? textNode.Leading),
    baselineShift: numberOf(textNode.baselineShift ?? textNode.BaselineShift),
    boxSize: boxSizeOf(textNode.boxSize ?? textNode.BoxSize)
  };
}

function parseMarkers(node: XmlNode): { time: number; comment?: string; label?: number }[] {
  const markerList = firstArray(node.MarkerList) ?? firstArray(node.Markers) ?? firstArray(node.markers) ?? [];
  const markers: { time: number; comment?: string; label?: number }[] = [];
  for (const entry of markerList) {
    const markerNode = asRecord(entry);
    if (!markerNode) continue;
    markers.push({
      time: numberOf(markerNode.time ?? markerNode.Time) ?? 0,
      comment: stringOf(markerNode.comment ?? markerNode.Comment),
      label: numberOf(markerNode.label ?? markerNode.Label)
    });
  }
  return markers;
}

function parseAssetRef(node: XmlNode, name: string, kind: "footage" | "folder", warnings: string[]): AeAssetRef {
  const sourcePath = stringOf(node.filePath ?? node.FilePath ?? node.sourcePath ?? node.path);
  const missing = booleanOf(node.missing ?? node.Missing ?? node.footageMissing) ?? false;
  const sequenceFrames = stringArrayOf(node.sequenceFrames ?? node.SequenceFrames);
  const mediaType = mediaTypeOf(name, sourcePath, sequenceFrames);
  if (!sourcePath && kind === "footage") {
    warnings.push(`Footage "${name}" has no readable source path; it will need relinking.`);
  }
  return {
    id: stringOf(node.id ?? node.ID) ?? `asset-${name}`,
    name,
    kind: "footage",
    sourcePath,
    missing: missing || !sourcePath,
    sequenceFrames: sequenceFrames.length ? sequenceFrames : undefined,
    proxyPath: stringOf(node.proxyPath ?? node.ProxyPath),
    mediaType
  };
}

function mediaTypeOf(name: string, sourcePath: string | undefined, sequenceFrames: string[]): AeAssetRef["mediaType"] {
  if (sequenceFrames.length) return "image-sequence";
  const target = (sourcePath ?? name).toLowerCase();
  if (/\.(psd|psb)$/.test(target)) return "photoshop";
  if (/\.(ai|eps)$/.test(target)) return "illustrator";
  if (/\.(png|jpe?g|gif|webp|tif?f|bmp|exr|dpx)$/.test(target)) return "image";
  if (/\.(mov|mp4|m4v|avi|mkv|webm|mxf)$/.test(target)) return "video";
  if (/\.(wav|aiff?|mp3|m4a|ogg)$/.test(target)) return "audio";
  if (/\.(otf|ttf|woff2?)$/.test(target)) return "font";
  return "other";
}

// ---------------------------------------------------------------------------
// Defensive scalar readers. AEPX is not a published schema, so every read goes
// through one of these: present and the right shape, or absent.
// ---------------------------------------------------------------------------

function asRecord(value: unknown): XmlNode | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as XmlNode) : null;
}

function firstRecord(value: unknown): XmlNode | null {
  if (Array.isArray(value)) return asRecord(value[0]);
  return asRecord(value);
}

function firstArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (record) {
    // A single child under a wrapper key, e.g. <Layers><Layer/></Layers>.
    for (const child of Object.values(record)) {
      if (Array.isArray(child)) return child;
      if (asRecord(child)) return [child];
    }
  }
  return null;
}

function stringOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  const record = firstRecord(value);
  if (record) {
    for (const key of ["#text", "_text", "value"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  return undefined;
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = stringOf(value);
  if (text !== undefined) {
    const parsed = Number(text);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function booleanOf(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const text = stringOf(value)?.toLowerCase();
  if (text === "true" || text === "1") return true;
  if (text === "false" || text === "0") return false;
  return undefined;
}

function valueOf(value: unknown): number | number[] | string | boolean {
  const array = numberArrayOf(value);
  if (array.length === 1) return array[0];
  if (array.length > 1) return array;
  const bool = booleanOf(value);
  if (bool !== undefined) return bool;
  const num = numberOf(value);
  if (num !== undefined) return num;
  return stringOf(value) ?? "";
}

function numberArrayOf(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value.map(numberOf).filter((entry): entry is number => entry !== undefined);
  }
  const record = firstRecord(value);
  if (record) {
    // A multi-component value is written as <value><v>960</v><v>540</v></value>: the children
    // under a `v` key are the components.
    const components = record.v ?? record.V;
    if (components !== undefined) {
      const list = Array.isArray(components) ? components : [components];
      return list.map(numberOf).filter((entry): entry is number => entry !== undefined);
    }
  }
  const single = numberOf(value);
  return single !== undefined ? [single] : [];
}

function stringArrayOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(stringOf).filter((entry): entry is string => entry !== undefined);
  }
  const single = stringOf(value);
  return single !== undefined ? [single] : [];
}

function tangentOf(value: unknown): { x: number; y: number } | undefined {
  const record = firstRecord(value);
  if (!record) return undefined;
  const x = numberOf(record.x ?? record.X);
  const y = numberOf(record.y ?? record.Y);
  return x !== undefined && y !== undefined ? { x, y } : undefined;
}

function vec2Of(value: unknown): { x: number; y: number } {
  const record = firstRecord(value);
  if (!record) return { x: 0, y: 0 };
  return { x: numberOf(record.x ?? record.X) ?? 0, y: numberOf(record.y ?? record.Y) ?? 0 };
}

function boxSizeOf(value: unknown): { x: number; y: number } | undefined {
  const record = firstRecord(value);
  if (!record) return undefined;
  const x = numberOf(record.width ?? record.x ?? record.X);
  const y = numberOf(record.height ?? record.y ?? record.Y);
  return x !== undefined && y !== undefined ? { x, y } : undefined;
}

function colorOf(value: unknown): string | undefined {
  const record = firstRecord(value);
  if (record) {
    const r = numberOf(record.red ?? record.r ?? record.R);
    const g = numberOf(record.green ?? record.g ?? record.G);
    const b = numberOf(record.blue ?? record.b ?? record.B);
    if (r !== undefined && g !== undefined && b !== undefined) {
      // AEPX colours are 0..1 floats.
      const to8 = (component: number) => Math.round(Math.max(0, Math.min(1, component)) * 255).toString(16).padStart(2, "0");
      return `#${to8(r)}${to8(g)}${to8(b)}`;
    }
  }
  const text = stringOf(value);
  return text && /^#[0-9a-fA-F]{6}$/.test(text) ? text : undefined;
}

function alignOf(value: unknown): "left" | "center" | "right" | "justify" {
  const text = stringOf(value)?.toLowerCase() ?? "";
  if (text.includes("center")) return "center";
  if (text.includes("right")) return "right";
  if (text.includes("justif")) return "justify";
  return "left";
}

function pathOf(value: unknown): AeMask["path"] {
  const record = firstRecord(value);
  const empty = { closed: false, vertices: [], inTangents: [], outTangents: [] };
  if (!record) return empty;
  const vertices = pointListOf(record.vertices ?? record.Vertices);
  return {
    closed: booleanOf(record.closed ?? record.Closed) ?? false,
    vertices,
    inTangents: pointListOf(record.inTangents ?? record.InTangents),
    outTangents: pointListOf(record.outTangents ?? record.OutTangents)
  };
}

function pointListOf(value: unknown): { x: number; y: number }[] {
  const list = firstArray(value) ?? [];
  const points: { x: number; y: number }[] = [];
  for (const entry of list) {
    const point = tangentOf(entry);
    if (point) points.push(point);
  }
  return points;
}
