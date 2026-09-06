/**
 * Native `.aep` import: read a binary After Effects project without After Effects.
 *
 * This is the no-After-Effects path for the format authors actually hand over. The `.aep` is
 * undocumented by Adobe, so every field offset here is either validated byte-for-byte against
 * After-Effects-authored fixtures (`tests/fixtures/aep/`, whose expected values come from the
 * `boltframe/aftereffects-aep-parser` test suite) or taken from two independent open
 * implementations that agree: `forticheprod/py-aep` and the Lottie Docs AEP specification. The
 * provenance of each block is named in its comment, because in a reverse-engineered format the
 * difference between "verified" and "believed" is the only thing that makes a wrong number
 * debuggable.
 *
 * The output is the shared `AeManifest` with `producer: "aep-native"` — the same structure the
 * bridge and the AEPX parser emit — so the converter, the compatibility report and the footage
 * collector are unchanged by this path existing.
 *
 * ## What this reads, and what it refuses to invent
 *
 * Read: the item tree (folders, compositions, footage), composition geometry, frame rate,
 * duration and work area, layer identity, timing, flags, blend and matte modes, parenting, the
 * transform properties with their static values and keyframes (temporal ease and spatial
 * tangents included), masks, the effect stack with its parameter values, markers, text documents,
 * and footage paths.
 *
 * Not read, and therefore absent rather than defaulted: expression *results* (the source is
 * carried, unevaluated), effect rendering, shape-layer contents beyond their paths, and the text
 * fields whose COS keys are not established (leading, baseline shift, stroke). The manifest
 * contract reads an absent field as "not readable", never as "default", and the compatibility
 * report is what tells the author which is which. A value invented here would arrive in the
 * scene as a confident lie.
 */

import type {
  AeAssetRef,
  AeComposition,
  AeEffect,
  AeKeyframe,
  AeLayer,
  AeManifest,
  AeMarker,
  AeMask,
  AePropertyStream,
  AeTrackMatte
} from "@grapix/shared-types";
import { parseCos, readTextDocument, rgbToHex } from "./cos.js";
import {
  ChunkReader,
  chunkText,
  findChunk,
  findList,
  findLists,
  fixedString,
  mergeLists,
  parseRifx,
  RifxFormatError,
  type RifxList,
  type RifxNode
} from "./rifx.js";

export { RifxFormatError };

/**
 * Parse a binary `.aep` into the shared manifest.
 *
 * @throws RifxFormatError when the bytes are not a RIFX `Egg!` container — that is a wrong file,
 * not a degraded one, and the route turns it into a diagnostic naming the alternatives.
 */
export function parseAepToManifest(bytes: Uint8Array, projectName: string, sourceFile: string): AeManifest {
  const file = parseRifx(bytes);
  if (file.form !== "Egg!") {
    throw new RifxFormatError(
      `not an After Effects project: RIFX form type is ${JSON.stringify(file.form)}, expected "Egg!"`
    );
  }

  const warnings: string[] = [];
  if (file.truncated) {
    warnings.push(
      "The project's chunk tree ended early; a chunk declared more data than its container held. Everything readable before that point was imported."
    );
  }

  const root = findList(file.children, "Fold");
  if (!root) {
    warnings.push("The project has no root folder chunk (LIST Fold); no compositions or footage were readable.");
    return { formatVersion: 1, producer: "aep-native", projectName, sourceFile, frameRate: 25, compositions: [], assets: [], fonts: [], warnings };
  }

  const items = new Map<number, ItemRecord>();
  collectItems(root, items, warnings, true);

  const assets: AeAssetRef[] = [];
  for (const item of items.values()) {
    if (item.kind === "footage") assets.push(footageAsset(item));
  }

  const compositions: AeComposition[] = [];
  for (const item of items.values()) {
    if (item.kind !== "composition") continue;
    const composition = readComposition(item, items, warnings);
    if (composition) compositions.push(composition);
  }

  if (compositions.length === 0) {
    warnings.push("No compositions were readable from this project.");
  }

  const fonts = collectFonts(compositions);
  return {
    formatVersion: 1,
    producer: "aep-native",
    projectName,
    sourceFile,
    frameRate: compositions[0]?.frameRate ?? 25,
    compositions,
    assets,
    fonts,
    warnings
  };
}

// ---------------------------------------------------------------------------
// Items
//
// `idta` layout (verified against tests/fixtures/aep/Item-01.aep, whose ids and types are
// asserted by the reference parser's own suite): type uint16 at 0, id uint32 at 16.
// ---------------------------------------------------------------------------

const IDTA = { type: 0, id: 16, label: 54 } as const;
const ITEM_TYPE: Record<number, ItemRecord["kind"]> = { 1: "folder", 4: "composition", 7: "footage" };

interface FootageInfo {
  width: number;
  height: number;
  seconds: number;
  frameRate: number;
  /** `Soli` is a solid, a placeholder is missing media, `file` has a path. */
  source: "solid" | "placeholder" | "file";
  path?: string;
  solidColor?: string;
}

interface ItemRecord {
  id: number;
  name: string;
  kind: "folder" | "composition" | "footage";
  node: RifxList;
  footage?: FootageInfo;
}

function collectItems(list: RifxList, items: Map<number, ItemRecord>, warnings: string[], isRoot: boolean): void {
  if (!isRoot) {
    const idta = findChunk(list.children, "idta");
    if (!idta) {
      warnings.push("A project item carried no item-data chunk (idta) and was skipped.");
      return;
    }
    const reader = new ChunkReader(idta.data);
    const kind = ITEM_TYPE[reader.u16(IDTA.type)];
    const id = reader.u32(IDTA.id);
    if (!kind) {
      warnings.push(`Project item ${id} has an unrecognised item type (${reader.u16(IDTA.type)}) and was skipped.`);
      return;
    }
    const record: ItemRecord = { id, name: chunkText(findChunk(list.children, "Utf8")), kind, node: list };
    if (kind === "footage") {
      record.footage = readFootage(list, warnings, id);
      // A solid carries its name in `opti`, not in the item's `Utf8`, which AE leaves empty.
      if (!record.name && record.footage?.source !== "file") record.name = optionsName(list) || record.name;
    }
    items.set(id, record);
  }

  // Folder children appear both directly and inside a `Sfdr` sub-list depending on nesting depth.
  const children = [...findLists(list.children, "Item"), ...findLists(mergeLists(list.children, "Sfdr"), "Item")];
  for (const child of children) collectItems(child, items, warnings, false);
}

/**
 * `sspc` (source spec) and `opti` (source options) inside the footage item's `Pin ` list.
 *
 * Offsets verified against Item-01.aep: a 1234x5678 placeholder at 123.4567 fps for 127 seconds,
 * and the solids, read back exactly.
 */
const SSPC = { width: 30, height: 34, secondsDividend: 38, secondsDivisor: 42, frameRate: 56, frameRateFraction: 60 } as const;
const OPTI = { type: 0, subtype: 4, solidAlpha: 10, solidRed: 14, solidGreen: 18, solidBlue: 22, solidName: 26, placeholderName: 10, nameLength: 256 } as const;
const OPTI_PLACEHOLDER = 0x02;

function readFootage(item: RifxList, warnings: string[], id: number): FootageInfo | undefined {
  const pin = findList(item.children, "Pin ");
  if (!pin) {
    warnings.push(`Footage item ${id} carried no source chunk (LIST "Pin ") and has no readable size or path.`);
    return undefined;
  }
  const sspc = findChunk(pin.children, "sspc");
  const opti = findChunk(pin.children, "opti");
  const spec = sspc ? new ChunkReader(sspc.data) : undefined;
  const info: FootageInfo = {
    width: spec?.u32(SSPC.width) ?? 0,
    height: spec?.u32(SSPC.height) ?? 0,
    seconds: spec?.ratio(SSPC.secondsDividend, SSPC.secondsDivisor, false) ?? 0,
    // Frame rate is an integer plus a 16-bit fraction, not a rational like the times are.
    frameRate: spec ? spec.u32(SSPC.frameRate) + spec.u16(SSPC.frameRateFraction) / 65536 : 0,
    source: "file"
  };

  if (opti) {
    const options = new ChunkReader(opti.data);
    const type = fixedString(opti.data, OPTI.type, 4);
    if (type === "Soli") {
      info.source = "solid";
      info.solidColor = rgbToHex(
        options.f32(OPTI.solidRed),
        options.f32(OPTI.solidGreen),
        options.f32(OPTI.solidBlue)
      );
    } else if (options.u16(OPTI.subtype) === OPTI_PLACEHOLDER) {
      info.source = "placeholder";
    }
  }

  // A file's path lives in the `Als2` alias record as JSON with a `fullpath` member.
  const alias = findList(pin.children, "Als2");
  const alas = alias ? chunkText(findChunk(alias.children, "alas")) : "";
  if (alas) {
    try {
      const parsed = JSON.parse(alas) as { fullpath?: unknown };
      if (typeof parsed.fullpath === "string" && parsed.fullpath) info.path = parsed.fullpath;
    } catch {
      warnings.push(`Footage item ${id} has an unreadable file-alias record; its path could not be recovered.`);
    }
  }
  return info;
}

/**
 * The name a solid or placeholder carries in `opti` rather than in the item's `Utf8`.
 *
 * After Effects writes this into a fixed 256-byte field and — verified in Item-01.aep — stores
 * an interior NUL where the name has a space: `Red Solid` NUL `1` is the item AE shows as
 * "Red Solid 1". Cutting at the first NUL like every other string in the format would silently
 * truncate it, so the field is read whole, trailing padding dropped, and interior NULs restored
 * to spaces. The reference parser makes the same choice and its fixture asserts the same name.
 */
function optionsName(item: RifxList): string {
  const pin = findList(item.children, "Pin ");
  const opti = pin ? findChunk(pin.children, "opti") : undefined;
  if (!opti) return "";
  const isSolid = fixedString(opti.data, OPTI.type, 4) === "Soli";
  const offset = isSolid ? OPTI.solidName : OPTI.placeholderName;
  const field = opti.data.subarray(offset, Math.min(offset + OPTI.nameLength, opti.data.length));
  let end = field.length;
  while (end > 0 && field[end - 1] === 0) end -= 1;
  return new TextDecoder("utf-8").decode(field.subarray(0, end)).replace(/\u0000/g, " ").trim();
}

const MEDIA_TYPE_BY_EXTENSION: Record<string, NonNullable<AeAssetRef["mediaType"]>> = {
  mov: "video", mp4: "video", mxf: "video", avi: "video", m4v: "video", webm: "video", r3d: "video", braw: "video",
  wav: "audio", aif: "audio", aiff: "audio", mp3: "audio", aac: "audio",
  png: "image", jpg: "image", jpeg: "image", tif: "image", tiff: "image", tga: "image", exr: "image", dpx: "image", webp: "image", gif: "image",
  psd: "photoshop", psb: "photoshop",
  ai: "illustrator", eps: "illustrator", pdf: "illustrator",
  otf: "font", ttf: "font"
};

function footageAsset(item: ItemRecord): AeAssetRef {
  const asset: AeAssetRef = { id: String(item.id), name: item.name || `Footage ${item.id}`, kind: "footage" };
  const footage = item.footage;
  if (!footage) return asset;
  if (footage.path) {
    asset.sourcePath = footage.path;
    const extension = footage.path.split(/[\\/]/).pop()?.split(".").pop()?.toLowerCase() ?? "";
    asset.mediaType = MEDIA_TYPE_BY_EXTENSION[extension] ?? "other";
  }
  if (footage.source === "placeholder") asset.missing = true;
  return asset;
}

// ---------------------------------------------------------------------------
// Compositions
//
// `cdta` layout verified field by field against Item-01.aep: 351x856, 21 fps, 31 s, background
// #0f4b52, 180 degree shutter — every one read back exactly at these offsets.
// ---------------------------------------------------------------------------

const CDTA = {
  timeScaleInteger: 5,
  timeScaleFraction: 7,
  /** frame rate * 256 * time scale — the unit keyframe times are counted in. */
  internalTimebase: 8,
  workAreaStartDividend: 28,
  workAreaStartDivisor: 32,
  workAreaEndDividend: 36,
  workAreaEndDivisor: 40,
  durationDividend: 44,
  durationDivisor: 48,
  backgroundRed: 52,
  width: 140,
  height: 142,
  frameRateInteger: 156,
  frameRateFraction: 158,
  displayStartDividend: 164,
  displayStartDivisor: 168
} as const;
/** Work-area end sentinel: "runs to the end of the composition". */
const WORK_AREA_END_OPEN = 0xffffffff;

interface CompositionTiming {
  frameRate: number;
  /** Keyframe times are integer counts of this unit per second. */
  timebase: number;
}

/** What a layer needs to know about the composition it sits in to fill in AE's defaults. */
interface CompositionContext {
  name: string;
  width: number;
  height: number;
  timing: CompositionTiming;
}

function readComposition(item: ItemRecord, items: Map<number, ItemRecord>, warnings: string[]): AeComposition | null {
  const cdta = findChunk(item.node.children, "cdta");
  if (!cdta) {
    warnings.push(`Composition "${item.name}" carried no composition-data chunk (cdta) and was skipped.`);
    return null;
  }
  const reader = new ChunkReader(cdta.data);
  const frameRate = reader.u16(CDTA.frameRateInteger) + reader.u16(CDTA.frameRateFraction) / 65536;
  const timeScale = reader.u16(CDTA.timeScaleInteger) + reader.u8(CDTA.timeScaleFraction) / 256;
  // The timebase is stored, but a project written by a tool that left it zero would divide every
  // keyframe time by zero, so it is recomputed from the rate when absent.
  const timebase = reader.u32(CDTA.internalTimebase) || Math.round(frameRate * 256 * timeScale) || 1;
  const duration = reader.ratio(CDTA.durationDividend, CDTA.durationDivisor, false);
  const workAreaStart = reader.ratio(CDTA.workAreaStartDividend, CDTA.workAreaStartDivisor, false);
  const workAreaEnd =
    reader.u32(CDTA.workAreaEndDividend) === WORK_AREA_END_OPEN
      ? duration
      : reader.ratio(CDTA.workAreaEndDividend, CDTA.workAreaEndDivisor, false);

  const context: CompositionContext = {
    name: item.name,
    width: reader.u16(CDTA.width),
    height: reader.u16(CDTA.height),
    timing: { frameRate: frameRate || 25, timebase }
  };
  const read = findLists(item.node.children, "Layr").map((layerList, index) =>
    readLayer(layerList, index + 1, context, items, warnings)
  );
  // Parenting is stored as a layer id, but the manifest and the scene both address layers by
  // their stacking index, so the ids are resolved once the whole stack is known.
  const indexById = new Map(read.map((entry) => [entry.layerId, entry.layer.index]));
  const layers: AeLayer[] = read.map((entry) => {
    const parentIndex = entry.parentId ? indexById.get(entry.parentId) : undefined;
    if (parentIndex !== undefined) entry.layer.parentIndex = parentIndex;
    return entry.layer;
  });

  return {
    id: String(item.id),
    name: item.name || `Composition ${item.id}`,
    width: context.width,
    height: context.height,
    duration,
    frameRate: context.timing.frameRate,
    displayStartTime: reader.ratio(CDTA.displayStartDividend, CDTA.displayStartDivisor),
    workAreaStart,
    workAreaDuration: Math.max(0, workAreaEnd - workAreaStart),
    backgroundColor: rgbToHex(
      reader.u8(CDTA.backgroundRed) / 255,
      reader.u8(CDTA.backgroundRed + 1) / 255,
      reader.u8(CDTA.backgroundRed + 2) / 255
    ),
    layers,
    markers: readCompositionMarkers(item.node, context.timing)
  };
}

// ---------------------------------------------------------------------------
// Layers
//
// `ldta` layout: identity and timing verified against Layer-01.aep, whose seventeen layers each
// isolate one switch — the flag bit table below reproduces the reference suite's expectations
// (collapse, effects, motion blur, shy, adjustment, 3D, solo, guide, frame blending mode,
// quality and sampling) exactly.
// ---------------------------------------------------------------------------

const LDTA = {
  layerId: 0,
  quality: 4,
  stretchDividend: 8,
  startTimeDividend: 12,
  startTimeDivisor: 16,
  inPointDividend: 20,
  inPointDivisor: 24,
  outPointDividend: 28,
  outPointDivisor: 32,
  flags0: 37,
  flags1: 38,
  flags2: 39,
  sourceId: 40,
  label: 61,
  name: 64,
  nameLength: 32,
  blendingMode: 99,
  /** Transfer-mode flags: preserve-underlying-transparency and dancing dissolve. */
  transferFlags: 103,
  trackMatteType: 107,
  stretchDivisor: 108,
  layerType: 131,
  parentId: 132
} as const;

/** Bit positions within `ldta`'s three flag bytes. */
const LAYER_FLAG = {
  guide: [LDTA.flags0, 1],
  null: [LDTA.flags1, 7],
  solo: [LDTA.flags1, 3],
  threeD: [LDTA.flags1, 2],
  adjustment: [LDTA.flags1, 1],
  collapse: [LDTA.flags2, 7],
  shy: [LDTA.flags2, 6],
  locked: [LDTA.flags2, 5],
  frameBlending: [LDTA.flags2, 4],
  motionBlur: [LDTA.flags2, 3],
  visible: [LDTA.flags2, 0]
} as const satisfies Record<string, readonly [number, number]>;

/**
 * `ldta` layer types.
 *
 * 5 and 7 are the 3D model and parametric mesh layers After Effects 2024 added. GrapiX has no
 * import for either, so they are read as containers and marked unsupported rather than being
 * dropped: the layer's name, timing and transform still arrive, and the report says what is
 * missing.
 */
const LAYER_TYPE: Record<number, "asset" | "light" | "camera" | "text" | "shape" | "mesh"> = {
  0: "asset",
  1: "light",
  2: "camera",
  3: "text",
  4: "shape",
  5: "mesh",
  7: "mesh"
};

/** `ldta` track-matte values. */
const TRACK_MATTE: Record<number, AeTrackMatte["type"]> = { 1: "alpha", 2: "notAlpha", 3: "luma", 4: "notLuma" };

/**
 * `ldta` transfer-mode values.
 *
 * These are the SDK's `PF_Xfer` numbers, not the order of After Effects' own menu: Normal is 2
 * (0 on layers that cannot blend, such as cameras, lights and nulls), and the Photoshop 5.5-era
 * "classic" variants keep their own low values while the modern ones sit above 25. A mode with no
 * GrapiX equivalent still travels under its After Effects name so the report can say what was
 * asked for instead of quietly claiming normal.
 */
const BLEND_MODE: Record<number, string> = {
  0: "normal", 2: "normal", 3: "dissolve", 4: "add", 5: "multiply", 6: "screen", 7: "overlay",
  8: "softLight", 9: "hardLight", 10: "darken", 11: "lighten", 12: "classicDifference",
  13: "hue", 14: "saturation", 15: "color", 16: "luminosity",
  17: "stencilAlpha", 18: "stencilLuma", 19: "silhouetteAlpha", 20: "silhouetteLuma",
  21: "luminescentPremultiply", 22: "alphaAdd", 23: "classicColorDodge", 24: "classicColorBurn",
  25: "exclusion", 26: "difference", 27: "colorDodge", 28: "colorBurn", 29: "linearDodge",
  30: "linearBurn", 31: "linearLight", 32: "vividLight", 33: "pinLight", 34: "hardMix",
  35: "lighterColor", 36: "darkerColor", 37: "subtract", 38: "divide"
};
/** Dissolve plus this `ldta` flag is Dancing Dissolve; it has no transfer value of its own. */
const DANCING_DISSOLVE_BIT = 1;

const TRANSFORM_GROUP = "ADBE Transform Group";
const MATCH_NAME = {
  anchorPoint: "ADBE Anchor Point",
  position: "ADBE Position",
  positionX: "ADBE Position_0",
  positionY: "ADBE Position_1",
  positionZ: "ADBE Position_2",
  scale: "ADBE Scale",
  orientation: "ADBE Orientation",
  rotateX: "ADBE Rotate X",
  rotateY: "ADBE Rotate Y",
  rotateZ: "ADBE Rotate Z",
  opacity: "ADBE Opacity",
  effects: "ADBE Effect Parade",
  masks: "ADBE Mask Parade",
  maskAtom: "ADBE Mask Atom",
  maskShape: "ADBE Mask Shape",
  maskOpacity: "ADBE Mask Opacity",
  maskFeather: "ADBE Mask Feather",
  maskOffset: "ADBE Mask Offset",
  markers: "ADBE Marker",
  textProperties: "ADBE Text Properties",
  textDocument: "ADBE Text Document"
} as const;

/** A layer plus the raw ids the composition needs to resolve parenting. */
interface ReadLayer {
  layer: AeLayer;
  layerId: number;
  parentId: number;
}

function readLayer(
  list: RifxList,
  index: number,
  composition: CompositionContext,
  items: Map<number, ItemRecord>,
  warnings: string[]
): ReadLayer {
  const { timing } = composition;
  const ldta = findChunk(list.children, "ldta");
  const reader = new ChunkReader(ldta?.data ?? new Uint8Array(0));
  if (!ldta) {
    warnings.push(`Layer ${index} of "${composition.name}" carried no layer-data chunk (ldta); only its name was read.`);
  }
  const flag = (position: readonly [number, number]): boolean => reader.bit(position[0], position[1]);

  const sourceId = reader.u32(LDTA.sourceId);
  const source = sourceId ? items.get(sourceId) : undefined;
  // AE stores an explicit name; a layer that was never renamed shows its source item's name.
  const name =
    chunkText(findChunk(list.children, "Utf8")) ||
    fixedString(reader.data, LDTA.name, LDTA.nameLength) ||
    source?.name ||
    `Layer ${index}`;

  const groups = pairMatchNames(mergeLists(list.children, "tdgp"));
  const transform = groups[TRANSFORM_GROUP];
  const properties = transform ? pairMatchNames(transform.children) : {};
  const read = (matchName: string): PropertyValue | undefined =>
    properties[matchName] ? readProperty(properties[matchName], timing) : undefined;

  const anchorPoint = read(MATCH_NAME.anchorPoint);
  const position = readPosition(properties, timing);
  const scale = read(MATCH_NAME.scale);
  const rotateZ = read(MATCH_NAME.rotateZ);
  const rotateX = read(MATCH_NAME.rotateX);
  const rotateY = read(MATCH_NAME.rotateY);
  const orientation = read(MATCH_NAME.orientation);
  const opacity = read(MATCH_NAME.opacity);

  const streams: AePropertyStream[] = [];
  for (const [property, value] of [
    ["anchorPoint", anchorPoint],
    ["position", position],
    ["scale", scale],
    ["rotation", rotateZ],
    ["rotateX", rotateX],
    ["rotateY", rotateY],
    ["opacity", opacity]
  ] as const) {
    const stream = toStream(property, value);
    if (stream) streams.push(stream);
  }

  const layerType = LAYER_TYPE[reader.u8(LDTA.layerType)] ?? "asset";
  const text = layerType === "text" ? readText(groups, warnings, name) : undefined;
  const type = resolveLayerType(layerType, flag(LAYER_FLAG.null), flag(LAYER_FLAG.adjustment), source);
  // After Effects omits a transform property that still holds its default, so the defaults are
  // part of reading the file, not a fallback: position defaults to the centre of the composition
  // and the anchor to the centre of what the layer draws — zeros would pin every untouched layer
  // to the top-left corner.
  const defaultAnchor = defaultAnchorPoint(type, source, composition);
  const transferMode = reader.u8(LDTA.blendingMode);
  const blendingMode =
    BLEND_MODE[transferMode] === "dissolve" && reader.bit(LDTA.transferFlags, DANCING_DISSOLVE_BIT)
      ? "dancingDissolve"
      : BLEND_MODE[transferMode] ?? "normal";
  const layer: AeLayer = {
    index,
    name,
    type,
    inPoint: reader.ratio(LDTA.inPointDividend, LDTA.inPointDivisor),
    outPoint: reader.ratio(LDTA.outPointDividend, LDTA.outPointDivisor),
    startTime: reader.ratio(LDTA.startTimeDividend, LDTA.startTimeDivisor),
    stretch: reader.ratio(LDTA.stretchDividend, LDTA.stretchDivisor) * 100,
    visible: flag(LAYER_FLAG.visible),
    locked: flag(LAYER_FLAG.locked),
    shy: flag(LAYER_FLAG.shy),
    solo: flag(LAYER_FLAG.solo),
    is3d: flag(LAYER_FLAG.threeD),
    guide: flag(LAYER_FLAG.guide),
    collapseTransformations: layerType !== "shape" && flag(LAYER_FLAG.collapse),
    // One bit, two meanings: on a vector layer AE labels it "continuously rasterize".
    continuouslyRasterize: layerType === "shape" && flag(LAYER_FLAG.collapse),
    motionBlur: flag(LAYER_FLAG.motionBlur),
    frameBlending: flag(LAYER_FLAG.frameBlending),
    blendingMode,
    anchorPoint: anchorPoint?.value.length ? anchorPoint.value : defaultAnchor,
    position: position?.value.length ? position.value : [composition.width / 2, composition.height / 2, 0],
    scale: scale?.value.length ? scale.value : [100, 100, 100],
    rotation: [rotateZ?.value[0] ?? 0, rotateX?.value[0] ?? 0, rotateY?.value[0] ?? 0],
    opacity: opacity?.value[0] ?? 100,
    streams,
    masks: readMasks(groups, timing),
    effects: readEffects(groups, timing),
    markers: readMarkers(groups, timing),
    status: layerType === "mesh" ? "unsupported" : "native-editable"
  };

  const label = reader.u8(LDTA.label);
  if (label) layer.label = label;
  if (source) layer.sourceItemId = String(source.id);
  if (orientation && orientation.value.length > 0) layer.orientation = orientation.value;
  if (text) layer.text = text;
  if (layerType === "asset" && source?.footage?.source === "solid" && source.footage.solidColor) {
    layer.solidColor = source.footage.solidColor;
  }
  if (layerType === "mesh") {
    warnings.push(
      `Layer "${name}" is an After Effects 3D model or parametric mesh layer, which GrapiX cannot import; its transform and timing were kept and its geometry was not.`
    );
  }

  const matte = TRACK_MATTE[reader.u8(LDTA.trackMatteType)];
  // A track matte is always supplied by the layer directly above; layer 1 has nothing above it.
  if (matte && index > 1) layer.trackMatte = { type: matte, sourceLayerIndex: index - 1 };

  return { layer, layerId: reader.u32(LDTA.layerId), parentId: reader.u32(LDTA.parentId) };
}

/**
 * The GrapiX-facing layer type.
 *
 * An adjustment layer, a null and a solid are all the same thing to the file — an AV layer whose
 * source is a solid — separated only by flags, and the adjustment flag has to be tested before
 * the null one because After Effects sets both on an adjustment layer.
 */
function resolveLayerType(
  layerType: "asset" | "light" | "camera" | "text" | "shape" | "mesh",
  isNull: boolean,
  isAdjustment: boolean,
  source: ItemRecord | undefined
): AeLayer["type"] {
  if (layerType === "text") return "text";
  if (layerType === "shape") return "shape";
  if (layerType === "camera") return "camera";
  if (layerType === "light") return "light";
  if (isAdjustment) return "adjustment";
  if (isNull) return "null";
  if (source?.kind === "composition") return "precomp";
  const footage = source?.footage;
  // A mesh layer and a layer whose source vanished both become empty containers.
  if (!footage) return "null";
  if (footage.source === "solid") return "solid";
  const media = footage.path ? MEDIA_TYPE_BY_EXTENSION[footage.path.split(".").pop()?.toLowerCase() ?? ""] : undefined;
  if (media === "audio") return "audio";
  if (media === "video") return "video";
  // A still with a duration is a sequence in AE's model; a single frame is an image.
  return footage.seconds > 0 && footage.frameRate > 0 ? "image-sequence" : "image";
}

/**
 * The anchor point After Effects means when the property is absent.
 *
 * A layer that draws something anchors at the centre of what it draws — its source footage, or
 * the pre-composition's own frame. A layer with nothing to draw (shape, text, camera, light,
 * null) anchors at its own origin.
 */
function defaultAnchorPoint(
  type: AeLayer["type"],
  source: ItemRecord | undefined,
  composition: CompositionContext
): number[] {
  if (type === "precomp" && source?.kind === "composition") {
    const nested = source.node;
    const cdta = findChunk(nested.children, "cdta");
    if (cdta) {
      const reader = new ChunkReader(cdta.data);
      return [reader.u16(CDTA.width) / 2, reader.u16(CDTA.height) / 2, 0];
    }
    return [composition.width / 2, composition.height / 2, 0];
  }
  const footage = source?.footage;
  if (footage && (footage.width > 0 || footage.height > 0)) return [footage.width / 2, footage.height / 2, 0];
  return [0, 0, 0];
}

// ---------------------------------------------------------------------------
// Property groups
//
// A `tdgp` list is a flat sequence: a `tdmn` match-name chunk, then the chunks belonging to that
// property, then the next `tdmn`. `ADBE Group End` closes the group. Positional reads are wrong
// here because AE emits different property sets per layer type and version.
// ---------------------------------------------------------------------------

const GROUP_END = "ADBE Group End";
const BUILT_IN_PARAMS = "ADBE Effect Built In Params";

/** Match name → the first list that followed it. Later duplicates lose to the first. */
function pairMatchNames(nodes: RifxNode[]): Record<string, RifxList> {
  const paired: Record<string, RifxList> = {};
  let current: string | undefined;
  for (const node of nodes) {
    if (node.kind === "chunk" && node.type === "tdmn") {
      const matchName = fixedString(node.data, 0, node.data.length);
      current = matchName === GROUP_END || matchName === BUILT_IN_PARAMS ? undefined : matchName;
      continue;
    }
    if (current && node.kind === "list" && !paired[current]) paired[current] = node;
  }
  return paired;
}

/**
 * Match names in the order the group lists them, with every node that followed each one.
 *
 * A property is not always one list: a mask entry is a `mkif` chunk *and* a `tdgp` list, both
 * following the same match name, so an entry that kept only the first list would lose the mask's
 * mode and inversion.
 */
function orderedMatchNames(nodes: RifxNode[]): { matchName: string; nodes: RifxNode[] }[] {
  const entries: { matchName: string; nodes: RifxNode[] }[] = [];
  for (const node of nodes) {
    if (node.kind === "chunk" && node.type === "tdmn") {
      const matchName = fixedString(node.data, 0, node.data.length);
      if (matchName !== GROUP_END && matchName !== BUILT_IN_PARAMS) entries.push({ matchName, nodes: [] });
      continue;
    }
    entries[entries.length - 1]?.nodes.push(node);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Property values and keyframes
//
// `tdb4` (124 bytes) describes the property; `cdat` holds a static value as one float64 per
// component; an animated property adds a `LIST list` of `lhd3` (count and item size) plus `ldat`
// (the packed keyframes). Offsets follow py-aep's field table, which matches the Lottie Docs
// specification on every field used here.
// ---------------------------------------------------------------------------

const TDB4 = { dimensions: 2, spatialStaticFlags: 5, typeFlags: 59, animated: 68 } as const;
const TDB4_BIT = { spatial: 3, colorType: 0 } as const;
const LHD3 = { count: 10, itemSize: 18, itemTypeRaw: 23 } as const;
const KEYFRAME = { time: 0, inInterpolation: 4, outInterpolation: 5, label: 6, temporalFlags: 7, payload: 8 } as const;
const KEYFRAME_BIT = { roving: 5 } as const;

/** The `ldat` item kinds this reader decodes; `3d-spatial` is derived, never stored. */
type KeyframeKind = "color" | "3d" | "3d-spatial" | "2d-spatial" | "2d" | "orientation" | "1d";
/** Item kinds that appear in the size table but carry no keyframe value. */
type ValuelessKind = "no-value" | "marker" | "shape";

/** `ldat` item kinds, keyed by `lhd3`'s raw type and item size. */
const LDAT_ITEM: Record<string, Exclude<KeyframeKind, "3d-spatial"> | ValuelessKind> = {
  "4:152": "color",
  "4:128": "3d",
  "4:104": "2d-spatial",
  "4:88": "2d",
  "4:80": "orientation",
  "4:64": "no-value",
  "4:48": "1d",
  "4:16": "marker",
  "4:8": "shape"
};

const INTERPOLATION: Record<number, AeKeyframe["interpolation"]> = { 1: "linear", 2: "bezier", 3: "hold" };

interface PropertyValue {
  /** The static value, one entry per component. */
  value: number[];
  keyframes: AeKeyframe[];
  expression?: string;
  isColor: boolean;
}

function readProperty(node: RifxList, timing: CompositionTiming): PropertyValue | undefined {
  // A plain property is a `tdbs`; the special kinds (shape, orientation, gradient, text) wrap one.
  const tdbs = node.id === "tdbs" ? node : findList(node.children, "tdbs");
  if (!tdbs) return undefined;
  const tdb4 = findChunk(tdbs.children, "tdb4");
  const meta = new ChunkReader(tdb4?.data ?? new Uint8Array(0));
  const dimensions = Math.max(1, meta.u16(TDB4.dimensions));
  const isColor = meta.bit(TDB4.typeFlags, TDB4_BIT.colorType);
  const isSpatial = meta.bit(TDB4.spatialStaticFlags, TDB4_BIT.spatial);
  const cdat = findChunk(tdbs.children, "cdat");
  const value = cdat ? new ChunkReader(cdat.data).f64Array(0, dimensions) : [];

  // At `tdbs` level a bare `Utf8` is the expression source; the human-readable property name is
  // wrapped in `tdsn`, so the two never collide.
  const expression = chunkText(findChunk(tdbs.children, "Utf8"));

  const keyframes = meta.u8(TDB4.animated) ? readKeyframes(tdbs, dimensions, isSpatial, timing) : [];
  const property: PropertyValue = { value, keyframes, isColor };
  if (expression) property.expression = expression;
  return property;
}

function readKeyframes(tdbs: RifxList, dimensions: number, isSpatial: boolean, timing: CompositionTiming): AeKeyframe[] {
  const list = findList(tdbs.children, "list");
  if (!list) return [];
  const header = findChunk(list.children, "lhd3");
  const data = findChunk(list.children, "ldat");
  if (!header || !data) return [];
  const lhd3 = new ChunkReader(header.data);
  const count = lhd3.u16(LHD3.count);
  const itemSize = lhd3.u16(LHD3.itemSize);
  if (count === 0 || itemSize === 0) return [];

  const stored = LDAT_ITEM[`${lhd3.u8(LHD3.itemTypeRaw)}:${itemSize}`];
  if (!stored || stored === "marker" || stored === "shape" || stored === "no-value") return [];
  // A 3D spatial keyframe is the same size as a plain 3D one; only `tdb4` distinguishes them.
  const kind: KeyframeKind = stored === "3d" && isSpatial ? "3d-spatial" : stored;

  const keyframes: AeKeyframe[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = index * itemSize;
    if (start + itemSize > data.data.length) break;
    const item = new ChunkReader(data.data.subarray(start, start + itemSize));
    keyframes.push(readKeyframe(item, kind, dimensions, timing));
  }
  return keyframes;
}

function readKeyframe(
  item: ChunkReader,
  kind: KeyframeKind,
  dimensions: number,
  timing: CompositionTiming
): AeKeyframe {
  const inInterpolation = INTERPOLATION[item.u8(KEYFRAME.inInterpolation)] ?? "linear";
  const outInterpolation = INTERPOLATION[item.u8(KEYFRAME.outInterpolation)] ?? "linear";
  const key: AeKeyframe = {
    // Times count the composition's internal timebase units, so this is composition seconds.
    time: item.s32(KEYFRAME.time) / timing.timebase,
    value: 0,
    interpolation: outInterpolation === "hold" ? "hold" : inInterpolation === "bezier" || outInterpolation === "bezier" ? "bezier" : "linear"
  };
  const label = item.u8(KEYFRAME.label);
  if (label) key.label = label;
  if (item.bit(KEYFRAME.temporalFlags, KEYFRAME_BIT.roving)) key.roving = true;

  const payload = KEYFRAME.payload;
  if (kind === "color") {
    // 8 opaque bytes, one unused float64, then the eases, then RGBA in 0-255.
    const ease = payload + 16;
    key.value = item.f64Array(ease + 32, 4);
    applyEase(key, item.f64(ease), item.f64(ease + 8), item.f64(ease + 16), item.f64(ease + 24));
    return key;
  }
  if (kind === "2d-spatial" || kind === "3d-spatial") {
    // 8 bytes of flags and padding, one unused float64, four scalar ease values, then the value
    // followed by the incoming and outgoing spatial tangents.
    const ease = payload + 8 + 8;
    const values = payload + 8 + 8 + 32;
    key.value = item.f64Array(values, dimensions);
    applyEase(key, item.f64(ease), item.f64(ease + 8), item.f64(ease + 16), item.f64(ease + 24));
    const spatialIn = item.f64Array(values + dimensions * 8, dimensions);
    const spatialOut = item.f64Array(values + dimensions * 16, dimensions);
    if (spatialIn.some((component) => component !== 0)) key.spatialIn = spatialIn;
    if (spatialOut.some((component) => component !== 0)) key.spatialOut = spatialOut;
    return key;
  }
  // Plain multi-dimensional: value, then in-speed, in-influence, out-speed, out-influence, each
  // one entry per component. The manifest's tangent is scalar, so component 0 carries the ease —
  // After Effects keeps the components in lockstep unless they were separated.
  const components = kind === "orientation" ? 1 : dimensions;
  const value = item.f64Array(payload, components);
  key.value = components === 1 ? value[0] ?? 0 : value;
  const ease = payload + components * 8;
  applyEase(
    key,
    item.f64(ease),
    item.f64(ease + components * 8),
    item.f64(ease + components * 16),
    item.f64(ease + components * 24)
  );
  return key;
}

/**
 * Carry After Effects' temporal ease onto the keyframe.
 *
 * AE describes ease as a speed (value units per second) and an influence (percent). The manifest
 * stores it as the bridge does — `{ x: speed, y: influence / 100 }` — so a project imported
 * through either path produces the same tangents.
 */
function applyEase(key: AeKeyframe, inSpeed: number, inInfluence: number, outSpeed: number, outInfluence: number): void {
  if (inSpeed !== 0 || inInfluence !== 0) key.inTangent = { x: inSpeed, y: inInfluence / 100 };
  if (outSpeed !== 0 || outInfluence !== 0) key.outTangent = { x: outSpeed, y: outInfluence / 100 };
}

/**
 * Position, whether or not its dimensions are separated.
 *
 * Separating X and Y replaces `ADBE Position` with `ADBE Position_0/1/2`, but After Effects keeps
 * those per-axis properties in the file — holding zero — even when the position was never
 * separated. Verified in both layer fixtures: a default layer has no `ADBE Position` at all and
 * two zero-valued axes. Reading those zeros is how a layer centred in the frame ends up in the
 * top-left corner, so the axes are believed only when they actually say something: a keyframe, or
 * a non-zero value. Everything else means "position was left at its default" and the caller
 * substitutes the composition centre.
 *
 * `tdsb`'s second bit is *not* the signal — every property in an AE-authored transform group
 * carries `0x03` there, including ones that have no dimensions to separate.
 */
function readPosition(properties: Record<string, RifxList>, timing: CompositionTiming): PropertyValue | undefined {
  const combined = properties[MATCH_NAME.position] ? readProperty(properties[MATCH_NAME.position], timing) : undefined;
  if (combined && (combined.value.length > 0 || combined.keyframes.length > 0)) return combined;

  const axes = [MATCH_NAME.positionX, MATCH_NAME.positionY, MATCH_NAME.positionZ]
    .map((matchName) => (properties[matchName] ? readProperty(properties[matchName], timing) : undefined));
  const separated = axes.some((axis) => axis && (axis.keyframes.length > 0 || axis.value.some((component) => component !== 0)));
  if (!separated) return combined;

  const value = axes.map((axis) => axis?.value[0] ?? 0);
  // Separated axes keyframe independently; the manifest carries one stream per property, so the
  // axes are zipped on the union of their times and each axis holds its static value in between.
  const times = [...new Set(axes.flatMap((axis) => axis?.keyframes.map((key) => key.time) ?? []))].sort((a, b) => a - b);
  const keyframes: AeKeyframe[] = times.map((time) => {
    const at = axes.map((axis) => axis?.keyframes.find((key) => key.time === time));
    const first = at.find((key) => key);
    return {
      time,
      value: at.map((key, axis) => (typeof key?.value === "number" ? key.value : value[axis] ?? 0)),
      interpolation: first?.interpolation ?? "linear",
      ...(first?.inTangent ? { inTangent: first.inTangent } : {}),
      ...(first?.outTangent ? { outTangent: first.outTangent } : {})
    };
  });
  return { value, keyframes, isColor: false };
}

function toStream(property: string, value: PropertyValue | undefined): AePropertyStream | undefined {
  if (!value) return undefined;
  if (value.keyframes.length === 0 && !value.expression) return undefined;
  const stream: AePropertyStream = { property, keyframes: value.keyframes };
  if (value.expression) {
    stream.expression = value.expression;
    // An expression is carried, never evaluated: GrapiX has no AE expression engine, and the
    // report marks the property so the author knows the motion did not come across.
    stream.expressionSampled = false;
  }
  return stream;
}

// ---------------------------------------------------------------------------
// Masks
//
// `mkif` holds the mask's switches; the path is a normalised bezier inside `om-s` → `omks` →
// `shap`, whose points are relative to the `shph` bounding box and then to the layer size.
// No fixture in this repository contains a mask, so this layout is pinned by the synthetic
// chunk test in tests/ae-aep-native.test.mjs rather than by an AE-authored file.
// ---------------------------------------------------------------------------

const MKIF = { inverted: 0, locked: 1, mode: 6 } as const;
const SHPH = { flags: 3, topLeftX: 4, topLeftY: 8, bottomRightX: 12, bottomRightY: 16 } as const;
const SHPH_OPEN_BIT = 3;
const MASK_MODE: Record<number, AeMask["mode"]> = {
  0: "none",
  1: "add",
  2: "subtract",
  3: "intersect",
  4: "darken",
  5: "lighten",
  6: "difference"
};

function readMasks(groups: Record<string, RifxList>, timing: CompositionTiming): AeMask[] {
  const parade = groups[MATCH_NAME.masks];
  if (!parade) return [];
  const masks: AeMask[] = [];
  for (const [index, entry] of orderedMatchNames(parade.children).entries()) {
    if (entry.matchName !== MATCH_NAME.maskAtom) continue;
    const group = findList(entry.nodes, "tdgp");
    if (!group) continue;
    const properties = pairMatchNames(group.children);
    // The switches sit beside the property group, not inside it.
    const switches = new ChunkReader(findChunk(entry.nodes, "mkif")?.data ?? new Uint8Array(0));
    const property = (matchName: string): PropertyValue | undefined =>
      properties[matchName] ? readProperty(properties[matchName], timing) : undefined;
    const opacity = property(MATCH_NAME.maskOpacity);
    const feather = property(MATCH_NAME.maskFeather);
    const offset = property(MATCH_NAME.maskOffset);
    masks.push({
      name: chunkText(findChunk(group.children, "tdsn")) || `Mask ${index + 1}`,
      mode: MASK_MODE[switches.u16(MKIF.mode)] ?? "add",
      inverted: switches.u8(MKIF.inverted) === 1,
      opacity: opacity?.value[0] ?? 100,
      feather: { x: feather?.value[0] ?? 0, y: feather?.value[1] ?? feather?.value[0] ?? 0 },
      expansion: offset?.value[0] ?? 0,
      path: readMaskPath(properties[MATCH_NAME.maskShape])
    });
  }
  return masks;
}

function readMaskPath(shapeProperty: RifxList | undefined): AeMask["path"] {
  const empty = { closed: true, vertices: [], inTangents: [], outTangents: [] };
  if (!shapeProperty) return empty;
  const keys = findList(shapeProperty.children, "omks");
  const shape = keys ? findList(keys.children, "shap") : undefined;
  if (!shape) return empty;
  const shph = findChunk(shape.children, "shph");
  const box = new ChunkReader(shph?.data ?? new Uint8Array(0));
  const list = findList(shape.children, "list");
  const header = list ? findChunk(list.children, "lhd3") : undefined;
  const data = list ? findChunk(list.children, "ldat") : undefined;
  if (!header || !data) return empty;

  const count = new ChunkReader(header.data).u16(LHD3.count);
  const points = new ChunkReader(data.data);
  const left = box.f32(SHPH.topLeftX);
  const top = box.f32(SHPH.topLeftY);
  const right = box.f32(SHPH.bottomRightX);
  const bottom = box.f32(SHPH.bottomRightY);
  // Points are stored normalised into the bounding box: 0 is the box's leading edge, 1 the far one.
  const absolute: { x: number; y: number }[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = index * 8;
    if (!points.has(at, 8)) break;
    const x = points.f32(at);
    const y = points.f32(at + 4);
    absolute.push({ x: left * (1 - x) + right * x, y: top * (1 - y) + bottom * y });
  }

  // The list runs vertex, out-tangent, in-tangent-of-the-next-vertex, repeating.
  const vertices: { x: number; y: number }[] = [];
  const inTangents: { x: number; y: number }[] = [];
  const outTangents: { x: number; y: number }[] = [];
  const vertexCount = Math.floor(absolute.length / 3);
  for (let index = 0; index < vertexCount; index += 1) {
    const vertex = absolute[index * 3];
    const outTangent = absolute[index * 3 + 1];
    // The incoming tangent of vertex N is stored with vertex N-1; the first wraps from the last.
    const incoming = absolute[((index + vertexCount - 1) % vertexCount) * 3 + 2];
    vertices.push(vertex);
    outTangents.push({ x: outTangent.x - vertex.x, y: outTangent.y - vertex.y });
    inTangents.push({ x: incoming.x - vertex.x, y: incoming.y - vertex.y });
  }
  return { closed: !box.bit(SHPH.flags, SHPH_OPEN_BIT), vertices, inTangents, outTangents };
}

// ---------------------------------------------------------------------------
// Effects, markers, text
// ---------------------------------------------------------------------------

function readEffects(groups: Record<string, RifxList>, timing: CompositionTiming): AeEffect[] {
  const parade = groups[MATCH_NAME.effects];
  if (!parade) return [];
  const effects: AeEffect[] = [];
  for (const entry of orderedMatchNames(parade.children)) {
    // An instance is a `sspc` carrying the effect's display name and its parameter values.
    const instance = findList(entry.nodes, "sspc");
    if (!instance) continue;
    const values = findList(instance.children, "tdgp");
    const parameters: Record<string, unknown> = {};
    // The group's first entry (`<match name>-0000`) describes the effect itself, not a parameter,
    // and only the parameters the author moved off their default are stored at all.
    for (const parameter of (values ? orderedMatchNames(values.children) : []).slice(1)) {
      const list = findList(parameter.nodes, "tdbs") ?? parameter.nodes.find((node) => node.kind === "list");
      const value = list?.kind === "list" ? readProperty(list, timing) : undefined;
      if (!value) continue;
      parameters[parameter.matchName] = value.keyframes.length
        ? { keyframes: value.keyframes }
        : value.value.length === 1
          ? value.value[0]
          : value.value;
    }
    effects.push({
      name: chunkText(findChunk(instance.children, "fnam")) || entry.matchName,
      matchName: entry.matchName,
      // The file records which effects are applied, not which are switched off; AE writes no
      // verified per-effect enable flag that this reader could read instead of assuming.
      enabled: true,
      parameters,
      // GrapiX has no After Effects effect engine, so every effect is a baked appearance.
      status: "baked"
    });
  }
  return effects;
}

/** `NmHd` marker attributes: 3 opaque bytes, a flag byte, a frame duration, then the label. */
const NMHD = { label: 12 } as const;

/**
 * A property group's markers.
 *
 * A marker property is a keyframed list whose values live outside the keyframes: `mrky` holds
 * one `Nmrd` per marker, in the same order as the times in the property's own `ldat`.
 */
function readMarkers(groups: Record<string, RifxList>, timing: CompositionTiming): AeMarker[] {
  const property = groups[MATCH_NAME.markers];
  const keys = property ? findList(property.children, "mrky") : undefined;
  if (!property || !keys) return [];
  const times = markerTimes(property, timing);
  const markers: AeMarker[] = [];
  for (const [index, entry] of findLists(keys.children, "Nmrd").entries()) {
    const marker: AeMarker = { time: times[index] ?? 0 };
    const comment = chunkText(findChunk(entry.children, "Utf8"));
    if (comment) marker.comment = comment;
    const header = findChunk(entry.children, "NmHd");
    const label = header ? new ChunkReader(header.data).u8(NMHD.label) : 0;
    if (label) marker.label = label;
    markers.push(marker);
  }
  return markers;
}

function readCompositionMarkers(item: RifxList, timing: CompositionTiming): AeMarker[] {
  // Composition markers live on their own hidden layer (`SecL`).
  const layer = findList(item.children, "SecL");
  if (!layer) return [];
  return readMarkers(pairMatchNames(mergeLists(layer.children, "tdgp")), timing);
}

/** A marker's time is the keyframe time in the property's own `ldat`, in parallel with `mrky`. */
function markerTimes(property: RifxList, timing: CompositionTiming): number[] {
  const tdbs = findList(property.children, "tdbs");
  const list = tdbs ? findList(tdbs.children, "list") : undefined;
  const header = list ? findChunk(list.children, "lhd3") : undefined;
  const data = list ? findChunk(list.children, "ldat") : undefined;
  if (!header || !data) return [];
  const lhd3 = new ChunkReader(header.data);
  const count = lhd3.u16(LHD3.count);
  const itemSize = lhd3.u16(LHD3.itemSize);
  const times: number[] = [];
  for (let index = 0; index < count && itemSize > 0; index += 1) {
    const item = new ChunkReader(data.data.subarray(index * itemSize, (index + 1) * itemSize));
    times.push(item.s32(KEYFRAME.time) / timing.timebase);
  }
  return times;
}

function readText(
  groups: Record<string, RifxList>,
  warnings: string[],
  layerName: string
): AeLayer["text"] | undefined {
  const properties = groups[MATCH_NAME.textProperties];
  if (!properties) return undefined;
  const document = pairMatchNames(properties.children)[MATCH_NAME.textDocument];
  const btdk = document ? findList(document.children, "btdk") : undefined;
  if (!btdk?.raw) {
    warnings.push(`Text layer "${layerName}" carried no readable text document; its content was not imported.`);
    return undefined;
  }
  const parsed = readTextDocument(parseCos(btdk.raw));
  if (!parsed) {
    warnings.push(`Text layer "${layerName}" has a text document this importer could not read; its content was not imported.`);
    return undefined;
  }
  for (const warning of parsed.warnings) warnings.push(`Text layer "${layerName}": ${warning}`);

  const text: NonNullable<AeLayer["text"]> = {
    // After Effects separates lines with a carriage return; GrapiX text uses newlines.
    content: parsed.text.replace(/\r\n?/g, "\n"),
    fontFamily: parsed.fontPostScriptName ?? "",
    fontSize: parsed.fontSize ?? 0,
    fillColor: parsed.fillColor ?? "#ffffff",
    align: parsed.align ?? "left"
  };
  if (parsed.tracking !== undefined) text.tracking = parsed.tracking;
  if (parsed.fauxItalic) text.fontStyle = "italic";
  if (!parsed.fontPostScriptName) {
    warnings.push(`Text layer "${layerName}" has no readable font reference; the scene's default font is used.`);
  }
  if (parsed.fontSize === undefined) {
    warnings.push(`Text layer "${layerName}" has no readable font size.`);
  }
  return text;
}

function collectFonts(compositions: AeComposition[]): AeManifest["fonts"] {
  const fonts = new Map<string, { family: string; style?: string; usedBy: string[] }>();
  for (const composition of compositions) {
    for (const layer of composition.layers) {
      const family = layer.text?.fontFamily;
      if (!family) continue;
      const key = `${family}::${layer.text?.fontStyle ?? ""}`;
      const entry = fonts.get(key) ?? { family, style: layer.text?.fontStyle, usedBy: [] };
      entry.usedBy.push(`${composition.name}/${layer.name}`);
      fonts.set(key, entry);
    }
  }
  return [...fonts.values()];
}
