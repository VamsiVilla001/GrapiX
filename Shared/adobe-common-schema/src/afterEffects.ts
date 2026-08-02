/**
 * The After Effects object model, transcribed from the After Effects SDK 25.6 headers.
 *
 * Source of truth (SDK 25.6.61, `Examples/Headers/`):
 * - `AE_GeneralPlug.h:982`  `AEGP_ObjectType`
 * - `AE_GeneralPlug.h:1266` `AEGP_LayerStream`
 * - `AE_GeneralPlug.h:1390` `AEGP_KeyInterp`
 * - `AE_GeneralPlug.h:1438` `AEGP_StreamType`
 * - `AE_GeneralPlug.h:920`  `AEGP_TrackMatte`
 * - `AE_GeneralPlug.h:952`  `AEGP_LayerFlags`
 * - `AE_Effect.h:1917`      `PF_MaskMode`
 *
 * These are transcribed rather than imported because the SDK is a C++ header set under
 * Adobe's licence and is not redistributable in this repository. The numeric values are
 * the wire contract an ExtendScript or AEGP bridge reports, so they must match the header
 * exactly: a bridge that sends `3` for a stream index and a schema that reads `3` as a
 * different property produces a scene that imports cleanly and animates the wrong thing.
 *
 * `AEGP_LayerStream` is append-only by Adobe's own rule ("only ever add to the end of the
 * list, right before AEGP_LayerStream_NUMTYPES", `AE_GeneralPlug.h:1263`), so the indices
 * below are stable across AE versions.
 */

import type { MaskMode } from "@grapix/shared-types";

/** `AEGP_ObjectType` — what kind of layer this is. `AE_GeneralPlug.h:982`. */
export const AE_OBJECT_TYPE: Record<string, number> = {
  none: -1,
  av: 0,
  light: 1,
  camera: 2,
  text: 3,
  vector: 4,
  threeDModel: 5
};

/** The GrapiX layer type each `AEGP_ObjectType` imports as. */
export const AE_OBJECT_TYPE_TO_LAYER: Record<number, string> = {
  [-1]: "null",
  0: "image",
  1: "light",
  2: "camera",
  3: "text",
  4: "shape",
  5: "model"
};

/**
 * `AEGP_LayerStream` — the animatable transform streams. `AE_GeneralPlug.h:1266`.
 *
 * Only the transform block is listed: camera, light, material and extrusion streams exist
 * in the header but have no GrapiX equivalent in v0.4 and are reported rather than mapped.
 */
export const AE_LAYER_STREAM: Record<string, number> = {
  none: -1,
  anchorPoint: 0,
  position: 1,
  scale: 2,
  /** `AEGP_LayerStream_ROTATION` and `_ROTATE_Z` are the same index (`:1271`). */
  rotation: 3,
  rotateZ: 3,
  opacity: 4,
  audio: 5,
  marker: 6,
  timeRemap: 7,
  rotateX: 8,
  rotateY: 9,
  orientation: 10,
  sourceText: 33
};

/**
 * `AEGP_StreamType` — the value shape a stream carries. `AE_GeneralPlug.h:1438`.
 *
 * This is what tells a bridge how many components a keyframe value has: importing a
 * `ThreeD_SPATIAL` position as a scalar silently drops Y and Z.
 */
export const AE_STREAM_TYPE: Record<string, number> = {
  noData: 0,
  threeDSpatial: 1,
  threeD: 2,
  twoDSpatial: 3,
  twoD: 4,
  oneD: 5,
  color: 6,
  arb: 7,
  marker: 8,
  layerId: 9,
  maskId: 10,
  mask: 11,
  textDocument: 12
};

/** How many numeric components a stream value carries, by `AEGP_StreamType`. */
export const AE_STREAM_COMPONENTS: Record<number, number> = {
  0: 0,
  1: 3,
  2: 3,
  3: 2,
  4: 2,
  5: 1,
  6: 4
};

/** `AEGP_KeyInterp` — keyframe interpolation. `AE_GeneralPlug.h:1390`. */
export const AE_KEY_INTERP: Record<string, number> = {
  none: 0,
  linear: 1,
  bezier: 2,
  hold: 3
};

/**
 * The GrapiX easing each AE interpolation imports as.
 *
 * `bezier` becomes `ease-in-out` only as the *default* shape: an AE bezier key carries
 * temporal handles, and a bridge that reports them should send them through
 * `KeyframeData.inHandle`/`outHandle` rather than rely on this fallback.
 */
export const AE_KEY_INTERP_TO_EASING: Record<number, string> = {
  0: "linear",
  1: "linear",
  2: "ease-in-out",
  3: "hold"
};

/** `AEGP_TrackMatte`. `AE_GeneralPlug.h:920`. */
export const AE_TRACK_MATTE: Record<string, number> = {
  none: 0,
  alpha: 1,
  notAlpha: 2,
  luma: 3,
  notLuma: 4
};

/** `PF_MaskMode`. `AE_Effect.h:1917`. */
export const AE_MASK_MODE: Record<string, number> = {
  none: 0,
  add: 1,
  subtract: 2,
  intersect: 3,
  lighten: 4,
  darken: 5,
  difference: 6,
  /** `PF_MaskMode_ACCUM` — a real add rather than a screen, and not exposed in AE's UI. */
  accum: 7
};

/**
 * `PF_MaskMode` to GrapiX `MaskMode`.
 *
 * Every AE mode the UI can produce (0–6) has an exact GrapiX equivalent. `accum` (7) is
 * not reachable from AE's UI and has no GrapiX equivalent, so it is deliberately absent:
 * a bridge that somehow reports it gets an explicit warning rather than a silent `add`.
 */
export const AE_MASK_MODE_TO_GRAPIX: Record<number, MaskMode> = {
  0: "none",
  1: "add",
  2: "subtract",
  3: "intersect",
  4: "lighten",
  5: "darken",
  6: "difference"
};

/** `AEGP_LayerFlags` bits this importer reads. `AE_GeneralPlug.h:952`. */
export const AE_LAYER_FLAG: Record<string, number> = {
  none: 0x00000000,
  videoActive: 0x00000001,
  audioActive: 0x00000002,
  effectsActive: 0x00000004,
  motionBlur: 0x00000008,
  frameBlending: 0x00000010,
  locked: 0x00000020,
  shy: 0x00000040,
  collapse: 0x00000080,
  adjustmentLayer: 0x00000200,
  timeRemapping: 0x00000400,
  layerIs3d: 0x00000800,
  solo: 0x00004000,
  nullLayer: 0x00010000,
  guideLayer: 0x00040000,
  environmentLayer: 0x00200000
};

export interface AeLayerFlagsView {
  visible: boolean;
  locked: boolean;
  shy: boolean;
  solo: boolean;
  is3d: boolean;
  isNull: boolean;
  isAdjustment: boolean;
  isGuide: boolean;
}

/**
 * Read an `AEGP_LayerFlags` bitfield.
 *
 * `VIDEO_ACTIVE` is AE's eyeball, and it is the only flag that decides whether the layer
 * renders — a guide layer is visible in the comp and excluded from render, which is why
 * the two are reported separately instead of folded into one boolean.
 */
export function readAeLayerFlags(flags: number): AeLayerFlagsView {
  return {
    visible: (flags & AE_LAYER_FLAG.videoActive) !== 0,
    locked: (flags & AE_LAYER_FLAG.locked) !== 0,
    shy: (flags & AE_LAYER_FLAG.shy) !== 0,
    solo: (flags & AE_LAYER_FLAG.solo) !== 0,
    is3d: (flags & AE_LAYER_FLAG.layerIs3d) !== 0,
    isNull: (flags & AE_LAYER_FLAG.nullLayer) !== 0,
    isAdjustment: (flags & AE_LAYER_FLAG.adjustmentLayer) !== 0,
    isGuide: (flags & AE_LAYER_FLAG.guideLayer) !== 0
  };
}

/**
 * The GrapiX animatable property each transform stream maps to, or `undefined` when the
 * stream has no GrapiX equivalent and must be reported instead of dropped.
 *
 * Multi-component streams expand: AE's `position` is one 2D/3D stream, GrapiX animates
 * `x`, `y` and `zDepth` as independent channels.
 */
export const AE_STREAM_TO_GRAPIX_PROPERTIES: Record<number, readonly string[]> = {
  0: ["anchorX", "anchorY", "anchorZ"],
  1: ["x", "y", "zDepth"],
  2: ["scaleX", "scaleY", "scaleZ"],
  3: ["rotationZ"],
  4: ["opacity"],
  8: ["rotationX"],
  9: ["rotationY"]
};
