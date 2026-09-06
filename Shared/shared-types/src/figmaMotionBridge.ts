/**
 * The Figma Motion plugin API → `FigmaMotionManifest`.
 *
 * This is the export bridge's whole conversion, kept here rather than in the plugin so it is
 * typechecked and unit-tested by a workspace that already runs in CI. `tools/figma-motion-bridge`
 * bundles it and supplies the four things only a plugin can: the document, the selection, the
 * frame picker and the file download.
 *
 * ## Why this layer exists at all
 *
 * The REST API cannot see a Motion timeline — it returns prototype *interactions*, which say two
 * frames are related and take 300 ms and never say a layer's x went 0 → 120. Per-property tracks
 * exist only inside Figma, on `node.animations`. So the manifest is the only way that data can
 * reach GrapiX, and this module is the only place that knows Figma's vocabulary for it.
 *
 * ## The three renamings, and why each is a correctness matter rather than cosmetics
 *
 * 1. **Seconds → milliseconds.** `ManualKeyframe.timelinePosition` and `Timeline.duration` are
 *    seconds; the manifest is milliseconds throughout. This is rule 124's trap arriving by a
 *    second road: read a 0.3 as 0.3 ms and the whole import is a thousand times too fast.
 * 2. **`TRANSLATION_XY` → two tracks.** Figma can carry x and y on one track as a `VECTOR`
 *    value. GrapiX has no combined channel, so one Figma track becomes two manifest tracks; a
 *    converter that only understood the single-axis fields would silently drop the combined ones,
 *    which are what Figma writes by default when a layer is dragged.
 * 3. **`TRANSLATION_*` is an offset, not a coordinate.** See `FigmaMotionTrack.valueSpace`.
 *
 * ## What is deliberately not attempted
 *
 * Every field in `FIGMA_MOTION_FIELDS` that maps to `undefined` is carried through under a
 * readable name and left for the importer to classify `unsupported`. That includes
 * `PATH_TRIM_START`/`PATH_TRIM_END`, which look mappable — GrapiX does have trim paths — but
 * `ANIMATABLE_PROPERTIES` has no channel for them and `animation.rs` excludes path geometry
 * deliberately (rule 123), so a trim track can only be reported, never played.
 */
import type {
  FigmaMotionEasing,
  FigmaMotionKeyframe,
  FigmaMotionManifest,
  FigmaMotionNode,
  FigmaMotionTimeline,
  FigmaMotionTrack
} from "./figmaMotion.js";

/* ────────────────────────────────────────────────────────────────────────────
 * The subset of the Figma Motion plugin API this bridge depends on.
 *
 * Declared structurally instead of importing `@figma/plugin-typings`, for two reasons: the
 * package is a plugin-only dependency that nothing else in the monorepo wants, and writing the
 * shapes out makes the surface we are coupled to explicit. The Motion API is beta and will move;
 * when it does, the compile error lands here rather than somewhere in the middle of a converter.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Figma's `KeyframePropertyFieldName`. */
export type FigmaKeyframeFieldName =
  | "TRANSLATION_X" | "TRANSLATION_Y" | "TRANSLATION_XY"
  | "ROTATION" | "SCALE_X" | "SCALE_Y" | "SCALE_XY" | "OPACITY"
  | "WIDTH" | "HEIGHT" | "CORNER_RADIUS" | "STROKE_WEIGHT"
  | "RECTANGLE_TOP_LEFT_CORNER_RADIUS" | "RECTANGLE_TOP_RIGHT_CORNER_RADIUS"
  | "RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS" | "RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS"
  | "BORDER_TOP_WEIGHT" | "BORDER_BOTTOM_WEIGHT" | "BORDER_LEFT_WEIGHT" | "BORDER_RIGHT_WEIGHT"
  | "STACK_SPACING" | "STACK_COUNTER_SPACING"
  | "STACK_PADDING_LEFT" | "STACK_PADDING_TOP" | "STACK_PADDING_RIGHT" | "STACK_PADDING_BOTTOM"
  | "GRID_ROW_GAP" | "GRID_COLUMN_GAP"
  | "PATH_TRIM_START" | "PATH_TRIM_END";

export interface FigmaEasingFunctionBezier {
  x1: number; y1: number; x2: number; y2: number;
}

/** Figma Motion's spring control: one normalized bounce, 0 to 1. */
export interface FigmaNormalizedSpring {
  bounce: number;
}

export interface FigmaMotionEasingInput {
  type:
    | "LINEAR" | "HOLD"
    | "EASE_IN" | "EASE_OUT" | "EASE_IN_AND_OUT"
    | "EASE_IN_BACK" | "EASE_OUT_BACK" | "EASE_IN_AND_OUT_BACK"
    | "CUSTOM_CUBIC_BEZIER" | "CUSTOM_SPRING"
    | "GENTLE" | "QUICK" | "BOUNCY" | "SLOW";
  easingFunctionCubicBezier?: FigmaEasingFunctionBezier;
  easingFunctionSpring?: FigmaNormalizedSpring;
}

/** `VariableAlias` — an easing bound to a variable, which cannot be resolved statically. */
export interface FigmaVariableAliasInput {
  type: "VARIABLE_ALIAS";
  id: string;
}

export type FigmaKeyframeValueInput =
  | { type: "FLOAT"; value: number }
  | { type: "VECTOR"; value: { x: number; y: number } }
  | { type: "COLOR"; value: { r: number; g: number; b: number; a: number } }
  | { type: "TEXT_DATA"; value: string }
  | { type: "BOOL"; value: boolean }
  | { type: string; value: unknown };

export interface FigmaManualKeyframeInput {
  id?: string;
  /** Seconds from the start of the timeline. */
  timelinePosition: number;
  easing?: FigmaMotionEasingInput | FigmaVariableAliasInput;
  value: FigmaKeyframeValueInput;
}

export interface FigmaKeyframeTrackInput {
  id?: string;
  keyframeOperation?: "SET" | "OFFSET" | "SCALE";
  keyframes: readonly FigmaManualKeyframeInput[];
  /** Present when the track came from an applied animation style rather than manual authoring. */
  animationStyleName?: string;
}

export interface FigmaPropertyAnimationInput {
  /** Seconds. */
  timelineDuration?: number;
  tracks: readonly FigmaKeyframeTrackInput[];
}

/** `node.animations`: a `PropertyAnimation` per animated field. */
export type FigmaNodeAnimationsInput = Partial<Record<FigmaKeyframeFieldName, FigmaPropertyAnimationInput>>
  & Record<string, FigmaPropertyAnimationInput | undefined>;

export interface FigmaBridgeNodeInput {
  id: string;
  name?: string;
  animations?: FigmaNodeAnimationsInput;
  /** `node.timelines` — the Motion timelines containing this node. Durations in seconds. */
  timelines?: readonly { id: string; duration?: number; name?: string }[];
}

export interface FigmaBridgeFrameInput {
  id: string;
  name: string;
  type?: string;
  nodes: readonly FigmaBridgeNodeInput[];
}

/* ────────────────────────────────────────────────────────────────────────────
 * Field mapping
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * How one Figma field becomes manifest track(s).
 *
 * `channels` is a list because `TRANSLATION_XY` and `SCALE_XY` carry two. `undefined` in the
 * `channels` position means "no GrapiX channel" — the field still travels, under `reportAs`, so
 * the importer can classify it and the author can read what their design contained.
 */
interface FigmaFieldMapping {
  /** Manifest property names to emit, in `VECTOR` component order (x then y). */
  channels?: readonly string[];
  /** The name an unsupported field is reported under. */
  reportAs: string;
  valueSpace: "absolute" | "offset";
}

export const FIGMA_MOTION_FIELDS: Readonly<Record<string, FigmaFieldMapping>> = {
  /*
   * A Motion transform track displaces the layer from where its frame puts it, so these are
   * offsets. Rotation is the same kind of quantity and the same unit GrapiX uses (degrees about
   * Z), and it is passed through exactly as the static importer passes `node.rotation` — one
   * convention for a design and its motion, or a layer's animation disagrees with its own
   * resting angle.
   */
  TRANSLATION_X: { channels: ["x"], reportAs: "x", valueSpace: "offset" },
  TRANSLATION_Y: { channels: ["y"], reportAs: "y", valueSpace: "offset" },
  TRANSLATION_XY: { channels: ["x", "y"], reportAs: "x/y", valueSpace: "offset" },
  ROTATION: { channels: ["rotation"], reportAs: "rotation", valueSpace: "offset" },

  /*
   * Scale is a multiplier in both models, with 1 meaning "as designed", so it is absolute rather
   * than an offset: adding it to a base of 1 would double every animation.
   */
  SCALE_X: { channels: ["scaleX"], reportAs: "scaleX", valueSpace: "absolute" },
  SCALE_Y: { channels: ["scaleY"], reportAs: "scaleY", valueSpace: "absolute" },
  SCALE_XY: { channels: ["scaleX", "scaleY"], reportAs: "scaleX/scaleY", valueSpace: "absolute" },

  /* Both are 0→1. The 0-100 Alpha in the object table is a display convention, not the stored value. */
  OPACITY: { channels: ["opacity"], reportAs: "opacity", valueSpace: "absolute" },

  /* Everything below has no GrapiX animation channel. Named, carried, never authored. */
  WIDTH: { reportAs: "width", valueSpace: "absolute" },
  HEIGHT: { reportAs: "height", valueSpace: "absolute" },
  CORNER_RADIUS: { reportAs: "cornerRadius", valueSpace: "absolute" },
  STROKE_WEIGHT: { reportAs: "strokeWeight", valueSpace: "absolute" },
  RECTANGLE_TOP_LEFT_CORNER_RADIUS: { reportAs: "cornerRadiusTopLeft", valueSpace: "absolute" },
  RECTANGLE_TOP_RIGHT_CORNER_RADIUS: { reportAs: "cornerRadiusTopRight", valueSpace: "absolute" },
  RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS: { reportAs: "cornerRadiusBottomLeft", valueSpace: "absolute" },
  RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS: { reportAs: "cornerRadiusBottomRight", valueSpace: "absolute" },
  BORDER_TOP_WEIGHT: { reportAs: "borderTopWeight", valueSpace: "absolute" },
  BORDER_BOTTOM_WEIGHT: { reportAs: "borderBottomWeight", valueSpace: "absolute" },
  BORDER_LEFT_WEIGHT: { reportAs: "borderLeftWeight", valueSpace: "absolute" },
  BORDER_RIGHT_WEIGHT: { reportAs: "borderRightWeight", valueSpace: "absolute" },
  STACK_SPACING: { reportAs: "stackSpacing", valueSpace: "absolute" },
  STACK_COUNTER_SPACING: { reportAs: "stackCounterSpacing", valueSpace: "absolute" },
  STACK_PADDING_LEFT: { reportAs: "stackPaddingLeft", valueSpace: "absolute" },
  STACK_PADDING_TOP: { reportAs: "stackPaddingTop", valueSpace: "absolute" },
  STACK_PADDING_RIGHT: { reportAs: "stackPaddingRight", valueSpace: "absolute" },
  STACK_PADDING_BOTTOM: { reportAs: "stackPaddingBottom", valueSpace: "absolute" },
  GRID_ROW_GAP: { reportAs: "gridRowGap", valueSpace: "absolute" },
  GRID_COLUMN_GAP: { reportAs: "gridColumnGap", valueSpace: "absolute" },
  PATH_TRIM_START: { reportAs: "pathTrimStart", valueSpace: "absolute" },
  PATH_TRIM_END: { reportAs: "pathTrimEnd", valueSpace: "absolute" }
};

/** Seconds → milliseconds, the manifest's unit throughout. */
export function secondsToMs(seconds: number): number {
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

/**
 * A Figma Motion easing → the manifest's easing.
 *
 * The seven polynomial presets share their shape with a GrapiX curve and pass through as
 * `preset`, where `figmaEasingToSceneEasing` resolves them by name. The four *named springs*
 * (`GENTLE`, `QUICK`, `BOUNCY`, `SLOW`) deliberately do not: they are physical simulations, and
 * mapping `BOUNCY` to `ease-out-back` would be the fallback that renders different pixels. Each
 * becomes a normalized spring with the bounce Figma's own UI shows for it, so the importer
 * samples it and says so.
 *
 * A variable-bound easing resolves to nothing: its value lives in a mode the export cannot pick.
 * Returning `undefined` lets the caller record the track without inventing a curve for it.
 */
export function figmaMotionEasingToManifest(
  easing: FigmaMotionEasingInput | FigmaVariableAliasInput | undefined
): FigmaMotionEasing | undefined {
  if (!easing) return undefined;
  if (easing.type === "VARIABLE_ALIAS") return undefined;

  const motion = easing as FigmaMotionEasingInput;
  switch (motion.type) {
    case "LINEAR": return { kind: "linear" };
    case "HOLD": return { kind: "hold" };
    case "EASE_IN":
    case "EASE_OUT":
    case "EASE_IN_AND_OUT":
    case "EASE_IN_BACK":
    case "EASE_OUT_BACK":
    case "EASE_IN_AND_OUT_BACK":
      return { kind: "preset", name: motion.type };
    case "CUSTOM_CUBIC_BEZIER": {
      const bezier = motion.easingFunctionCubicBezier;
      // A CUSTOM_CUBIC_BEZIER with no control points is not a curve we can reproduce, and
      // defaulting it to a straight line would quietly flatten the designer's easing.
      if (!bezier) return undefined;
      return { kind: "cubic-bezier", points: [bezier.x1, bezier.y1, bezier.x2, bezier.y2] };
    }
    case "CUSTOM_SPRING":
      return { kind: "normalized-spring", bounce: motion.easingFunctionSpring?.bounce ?? 0 };
    case "GENTLE": return { kind: "normalized-spring", bounce: FIGMA_SPRING_PRESET_BOUNCE.GENTLE };
    case "QUICK": return { kind: "normalized-spring", bounce: FIGMA_SPRING_PRESET_BOUNCE.QUICK };
    case "BOUNCY": return { kind: "normalized-spring", bounce: FIGMA_SPRING_PRESET_BOUNCE.BOUNCY };
    case "SLOW": return { kind: "normalized-spring", bounce: FIGMA_SPRING_PRESET_BOUNCE.SLOW };
    default: return undefined;
  }
}

/**
 * The bounce each named Figma spring corresponds to.
 *
 * Figma publishes the presets as names, not numbers, so these are read off the bounce its own
 * spring control shows when a preset is selected. They are approximations of a preset that is
 * itself a preset — which is why anything built from them is classified `sampled` and reported,
 * exactly like a hand-tuned `CUSTOM_SPRING`. `GENTLE` and `SLOW` differ in duration rather than
 * bounce, and duration comes from the keyframe times, not from here.
 */
export const FIGMA_SPRING_PRESET_BOUNCE = {
  GENTLE: 0.2,
  QUICK: 0.15,
  BOUNCY: 0.55,
  SLOW: 0.2
} as const;

/**
 * One Figma track → one manifest track per channel it carries.
 *
 * `component` selects which half of a `VECTOR` value each emitted track reads, which is what
 * splits `TRANSLATION_XY` into an x track and a y track carrying the same times and curves.
 */
function convertTrack(
  field: string,
  mapping: FigmaFieldMapping,
  track: FigmaKeyframeTrackInput
): FigmaMotionTrack[] {
  const names = mapping.channels ?? [mapping.reportAs];

  return names.map((name, component) => ({
    property: name,
    sourceField: field,
    valueSpace: mapping.valueSpace,
    animationStyle: track.animationStyleName,
    keyframes: track.keyframes.map((keyframe) => {
      const converted: FigmaMotionKeyframe = {
        timeMs: secondsToMs(keyframe.timelinePosition),
        value: readKeyframeValue(keyframe.value, mapping.channels ? component : undefined)
      };
      const easing = figmaMotionEasingToManifest(keyframe.easing);
      if (easing) converted.easing = easing;
      return converted;
    })
  }));
}

/**
 * A `KeyframeValue` → the manifest's value.
 *
 * `component` is set only for a channel-backed field, so an unsupported field keeps its whole
 * value — a COLOR track's RGBA is what makes its report entry worth reading, and taking the `x`
 * of it would be nonsense. A non-numeric value on a channel-backed field is passed through
 * unchanged rather than coerced; the importer's own numeric filter then reports it as carrying
 * nothing interpolable, which is the truthful outcome.
 */
function readKeyframeValue(
  value: FigmaKeyframeValueInput,
  component: number | undefined
): FigmaMotionKeyframe["value"] {
  if (value.type === "FLOAT" && typeof value.value === "number") return value.value;

  if (value.type === "VECTOR" && component !== undefined) {
    const vector = value.value as { x?: number; y?: number } | null;
    const axis = component === 0 ? vector?.x : vector?.y;
    if (typeof axis === "number") return axis;
  }

  return value.value as FigmaMotionKeyframe["value"];
}

/**
 * A node's `animations` → manifest tracks.
 *
 * Unknown field names are kept rather than skipped: the Motion API is beta and will add fields,
 * and a converter that ignored what it did not recognise would turn a future Figma release into
 * silent data loss (rule 132's argument, applied to motion). An unmapped field passes through
 * under its own name, has no channel, and lands in the report.
 */
export function convertNodeAnimations(node: FigmaBridgeNodeInput): FigmaMotionNode | undefined {
  if (!node.animations) return undefined;
  const tracks: FigmaMotionTrack[] = [];

  for (const [field, animation] of Object.entries(node.animations)) {
    if (!animation?.tracks?.length) continue;
    const mapping = FIGMA_MOTION_FIELDS[field] ?? { reportAs: field, valueSpace: "absolute" as const };
    for (const track of animation.tracks) {
      if (!track.keyframes?.length) continue;
      tracks.push(...convertTrack(field, mapping, track));
    }
  }

  if (!tracks.length) return undefined;
  return { nodeId: node.id, name: node.name, tracks };
}

/** The longest timeline the frame's nodes report, in milliseconds. */
function frameDurationMs(frame: FigmaBridgeFrameInput, nodes: readonly FigmaMotionNode[]): number {
  const declared = frame.nodes.flatMap((node) => (node.timelines ?? []).map((timeline) => timeline.duration ?? 0));
  const fromTimelines = secondsToMs(Math.max(0, ...declared, 0));
  // A node can hold keys past the timeline's declared duration; taking the later of the two
  // means the manifest never claims a duration that cuts its own last keyframe off.
  const fromKeys = Math.max(
    0,
    ...nodes.flatMap((node) => node.tracks.flatMap((track) => track.keyframes.map((key) => key.timeMs))),
    0
  );
  return Math.max(fromTimelines, fromKeys);
}

export interface BuildMotionManifestOptions {
  /** Who wrote it, so a manifest from a mismatched bridge build is identifiable. */
  generator: string;
  fileKey?: string;
  fileName?: string;
  /** ISO timestamp. Passed in rather than read from the clock so the output is reproducible. */
  exportedAt: string;
}

/**
 * Frames → a `FigmaMotionManifest`.
 *
 * One timeline per frame, because that is the unit the importer matches against a scene and the
 * unit an author recognises. `origin: "bridge-export"` is what makes the importer classify these
 * as `native-editable` rather than `prototype-transition` — they are real per-property tracks,
 * not a transition's implied motion.
 *
 * A frame whose nodes animate nothing is omitted rather than emitted empty: the report counts
 * timelines that produced keyframes against timelines offered, and padding the denominator with
 * frames that never had motion would make a complete import look partial.
 */
export function buildMotionManifest(
  frames: readonly FigmaBridgeFrameInput[],
  options: BuildMotionManifestOptions
): FigmaMotionManifest {
  const timelines: FigmaMotionTimeline[] = [];

  for (const frame of frames) {
    const nodes = frame.nodes
      .map((node) => convertNodeAnimations(node))
      .filter((node): node is FigmaMotionNode => Boolean(node));
    if (!nodes.length) continue;

    timelines.push({
      id: `frame_${frame.id}`,
      name: frame.name,
      durationMs: frameDurationMs(frame, nodes),
      sourceFrameId: frame.id,
      nodes,
      origin: "bridge-export"
    });
  }

  return {
    version: 1,
    generator: options.generator,
    fileKey: options.fileKey,
    fileName: options.fileName,
    exportedAt: options.exportedAt,
    frames: frames.map((frame) => ({ id: frame.id, name: frame.name, type: frame.type })),
    timelines
  };
}
