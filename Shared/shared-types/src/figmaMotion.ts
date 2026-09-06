/**
 * Figma motion — the contract between the export bridge and the importer.
 *
 * Two sources feed it, and they are not equivalent:
 *
 * 1. **The REST API**, which returns a node's prototype *interactions*: what happens on a
 *    trigger, over how long, with what easing, to which destination. That is a transition, not
 *    a timeline — it says "these two frames are related and take 300 ms", never "this layer's
 *    x went 0 → 120 with these keys".
 * 2. **The export bridge plugin**, which runs inside Figma where the document model is
 *    available, and writes `grapix-figma-motion.json`. That is where per-property tracks come
 *    from, because the REST API does not expose them.
 *
 * Both normalise into `FigmaMotionManifest` so the importer has one shape to consume and the
 * report can say which route produced each piece of motion.
 *
 * ## What "supported" means here, and why the honesty matters
 *
 * GrapiX animates a fixed set of numeric channels — the ones in `ANIMATABLE_PROPERTIES`, which
 * the render engine's `animation.rs` plays. There is no channel for width, height, corner
 * radius, fill, stroke or effects, so a Figma track for any of those **cannot** become a
 * keyframe that renders. Converting it anyway would author a scene that previews one way and
 * goes to air another, which is the defect invariant 7 and rule 82 exist to prevent.
 *
 * So such a track is not dropped and not faked: it is carried through verbatim in
 * `FigmaMotionCompatibilityEntry.original` and reported as `unsupported`. The author sees what
 * their design contained and what GrapiX did with it.
 */
import type { SceneKeyframeEasing } from "./easing.js";

/**
 * What GrapiX managed to do with one piece of Figma motion.
 *
 * - `native-editable` — became real GrapiX keyframes on a real channel, editable in the
 *   Timeline, and played identically by the browser preview and the render engine.
 * - `smart-animate-converted` — derived by comparing a node between the source and destination
 *   frames of a Smart Animate transition, then written as start/end keyframes.
 * - `prototype-transition` — came from a frame-level prototype transition (Dissolve, Move,
 *   Push, Slide) rather than a per-property timeline. Converted where the transition implies a
 *   channel GrapiX has; otherwise retained as navigation metadata.
 * - `sampled` — the source curve has no closed form GrapiX shares (a Figma spring), so it was
 *   baked into several keyframes that trace it. Editable, and honest about being an
 *   approximation rather than the same curve.
 * - `unsupported` — no GrapiX channel exists for the property. Nothing was authored; the
 *   original data is kept on the entry.
 */
export type FigmaMotionCompatibility =
  | "native-editable"
  | "smart-animate-converted"
  | "prototype-transition"
  | "sampled"
  | "unsupported";

/**
 * A property a Figma timeline can animate.
 *
 * The first six map onto GrapiX channels. The rest are captured deliberately even though
 * nothing can be authored from them — an import report that cannot name what it could not
 * bring across is a report that reads as "your design had no motion".
 */
export type FigmaMotionProperty =
  | "x"
  | "y"
  | "rotation"
  | "scaleX"
  | "scaleY"
  | "opacity"
  | "width"
  | "height"
  | "cornerRadius"
  | "fill"
  | "stroke"
  | "effects";

export const FIGMA_MOTION_PROPERTIES: readonly FigmaMotionProperty[] = [
  "x", "y", "rotation", "scaleX", "scaleY", "opacity",
  "width", "height", "cornerRadius", "fill", "stroke", "effects"
];

/**
 * How a segment interpolates.
 *
 * A discriminated union rather than a name, because Figma's custom curves carry data: a cubic
 * bezier has four control values and a spring has physical parameters. Flattening either to a
 * preset name loses the curve the designer actually drew.
 */
export type FigmaMotionEasing =
  | { kind: "linear" }
  /** No interpolation: the value holds until the next key. */
  | { kind: "hold" }
  /** A Figma preset — `EASE_IN`, `EASE_OUT_BACK`, `GENTLE`… mapped by name. */
  | { kind: "preset"; name: string }
  | { kind: "cubic-bezier"; points: [number, number, number, number] }
  /**
   * A Figma spring. GrapiX has no spring curve in `SceneKeyframeEasing`, and adding one would
   * mean implementing it identically in TypeScript and Rust; until then a spring is sampled.
   */
  | { kind: "spring"; mass: number; stiffness: number; damping: number; initialVelocity?: number }
  /**
   * A Figma **Motion** spring, which is not the same thing as the one above.
   *
   * The prototype `Transition` carries physical parameters. The Motion timeline carries a
   * `NormalizedSpring` — a single `bounce` from 0 to 1 — and the plugin API exposes only
   * `figma.motion.physicalSpringToNormalized`, never its inverse. So the physical triple the
   * other variant needs genuinely cannot be recovered from a Motion keyframe, and inventing one
   * would be a curve that is nearly right, which invariant 7 forbids.
   *
   * It is therefore kept as what Figma gave — `bounce`, verbatim — and sampled. See
   * `normalizedSpringToPhysical` for the one assumption the sampler makes and why it is
   * labelled `sampled` rather than reproduced.
   */
  | { kind: "normalized-spring"; bounce: number };

export interface FigmaMotionKeyframe {
  /** Milliseconds from the start of the timeline. */
  timeMs: number;
  /**
   * The value at this time.
   *
   * A number for the six channel-backed properties. Anything else — a paint, an effect list —
   * arrives as whatever the bridge exported, and travels only as far as the report.
   */
  value: number | string | Record<string, unknown> | unknown[];
  /** Interpolation from this key to the next. Absent means linear. */
  easing?: FigmaMotionEasing;
}

export interface FigmaMotionTrack {
  property: FigmaMotionProperty | string;
  keyframes: FigmaMotionKeyframe[];
  /** Figma's named animation style, when the track came from one. Reported, never inferred from. */
  animationStyle?: string;
  /**
   * What the numbers mean, which is not the same for the two routes.
   *
   * - `absolute` — the value *is* the property. Smart Animate produces these, because it is
   *   comparing two real layout positions.
   * - `offset` — the value is a delta on top of the node's static layout, which is what a Motion
   *   `TRANSLATION_X` track is: the layer sits where the frame puts it and the timeline moves it
   *   from there. Importing such a track as an absolute coordinate would fling every animated
   *   layer to the top-left of the canvas, because a 0 key means "no displacement", not "x = 0".
   *
   * Absent means `absolute`, so a manifest written before this field existed keeps its meaning.
   */
  valueSpace?: "absolute" | "offset";
  /**
   * Figma's field name, verbatim, when the bridge renamed it.
   *
   * `TRANSLATION_XY` becomes two tracks called `x` and `y`; without this the report could not
   * tell the author which of their tracks it was talking about.
   */
  sourceField?: string;
}

export interface FigmaMotionNode {
  /** The Figma node id, in API form (`123:456`). The only key that matches an imported object. */
  nodeId: string;
  name?: string;
  tracks: FigmaMotionTrack[];
}

export type FigmaPrototypeTransitionType =
  | "SMART_ANIMATE"
  | "DISSOLVE"
  | "MOVE_IN"
  | "MOVE_OUT"
  | "PUSH"
  | "SLIDE_IN"
  | "SLIDE_OUT"
  | "INSTANT"
  | "SCROLL_ANIMATE";

export interface FigmaPrototypeTransition {
  /** Figma's own name, kept verbatim so an unrecognised one is reported rather than guessed at. */
  type: FigmaPrototypeTransitionType | string;
  durationMs: number;
  /** `LEFT`/`RIGHT`/`TOP`/`BOTTOM` for the directional transitions. */
  direction?: string;
  easing: FigmaMotionEasing;
  /** Smart Animate matches layers by name between the two frames. */
  matchLayers?: boolean;
}

export interface FigmaMotionTrigger {
  /** `ON_CLICK`, `AFTER_DELAY`, `ON_HOVER`, `MOUSE_ENTER`… verbatim. */
  type: string;
  delayMs?: number;
}

/**
 * One transition or exported timeline.
 *
 * A timeline is the unit an author recognises: "this frame goes to that frame over 300 ms".
 * Nodes hang off it, because Smart Animate's whole meaning is per-node change *within* one
 * transition.
 */
export interface FigmaMotionTimeline {
  id: string;
  name: string;
  durationMs: number;
  /** `AFTER_DELAY` and trigger delays: the offset before this timeline starts. */
  delayMs?: number;
  trigger?: FigmaMotionTrigger;
  transition?: FigmaPrototypeTransition;
  /** The frame the interaction lives on. */
  sourceFrameId?: string;
  /** Where it navigates. Absent for a timeline the bridge exported without navigation. */
  destinationFrameId?: string;
  /** Component-set variants, when the transition is a variant swap rather than a frame change. */
  sourceVariantId?: string;
  destinationVariantId?: string;
  nodes: FigmaMotionNode[];
  /** Which route produced this timeline, for the report. */
  origin: "rest-prototype" | "bridge-export";
}

export interface FigmaMotionManifest {
  version: 1;
  /** Who wrote it, so a manifest from a mismatched bridge build is identifiable. */
  generator: string;
  fileKey?: string;
  fileName?: string;
  exportedAt: string;
  /** Frames and components the export covered — what the picker offered and the author chose. */
  frames?: Array<{ id: string; name: string; type?: string }>;
  timelines: FigmaMotionTimeline[];
}

/** One line of the compatibility report: what happened to one property of one node. */
export interface FigmaMotionCompatibilityEntry {
  compatibility: FigmaMotionCompatibility;
  nodeId: string;
  /** The GrapiX object the node matched, when it matched one. */
  objectId?: string;
  nodeName?: string;
  property: string;
  timelineId?: string;
  timelineName?: string;
  /** Plain sentence for the report. Says what was done, or why nothing could be. */
  detail: string;
  /** Keyframes written onto the scene by this entry. Zero for `unsupported`. */
  keyframesCreated: number;
  /**
   * The source data, verbatim, when nothing native could be produced.
   *
   * The point of the whole taxonomy: an unsupported track is preserved here and reported, never
   * silently discarded, so an author can see the motion their design carried.
   */
  original?: Record<string, unknown>;
}

export interface FigmaMotionImportReport {
  /** Timelines the manifest offered. */
  timelines: number;
  /** Timelines that produced at least one keyframe. */
  timelinesConverted: number;
  /** Figma nodes matched to a GrapiX object by id. */
  matchedNodes: number;
  /**
   * Motion referring to nodes no imported object carries.
   *
   * Usually a frame that was not selected for import. Named rather than counted, because the
   * fix is to import that frame and the author needs to know which one.
   */
  missingNodes: string[];
  channelsCreated: number;
  keyframesCreated: number;
  entries: FigmaMotionCompatibilityEntry[];
}

/** How much of a Figma import brings motion across. */
export type FigmaMotionImportMode =
  /** Layers, hierarchy, text, images, masks, effects and assets. No motion. */
  | "design-only"
  /** Design, plus prototype transitions the REST API exposes. */
  | "design-and-prototype-motion"
  /** Design, prototype transitions, and a `grapix-figma-motion.json` from the export bridge. */
  | "full-motion-manifest";

/**
 * Properties GrapiX can actually animate, mapped to the channel they land on.
 *
 * `rotation` deliberately targets `rotation` rather than `rotationZ`: an imported Figma node is
 * never a mesh, and `rotationZ` is mesh-only (`objectPropertySupport`). The absent entries are
 * the point of this table — width, height, corner radius, fill, stroke and effects have no
 * channel, so they classify as `unsupported` rather than being written somewhere plausible.
 */
export const FIGMA_MOTION_CHANNELS: Readonly<Partial<Record<FigmaMotionProperty, string>>> = {
  x: "x",
  y: "y",
  rotation: "rotation",
  scaleX: "scaleX",
  scaleY: "scaleY",
  opacity: "opacity"
};

export function isChannelBackedMotionProperty(property: string): boolean {
  return Object.hasOwn(FIGMA_MOTION_CHANNELS, property);
}

/**
 * Figma easing → a GrapiX easing name, where one has the same shape.
 *
 * Returns `undefined` when no GrapiX curve matches, which is the caller's signal to sample
 * rather than to substitute something close. A curve that is nearly right is the fallback
 * invariant 7 forbids: it renders different pixels and says nothing about it.
 */
export function figmaEasingToSceneEasing(easing: FigmaMotionEasing | undefined): SceneKeyframeEasing | undefined {
  if (!easing) return "linear";
  switch (easing.kind) {
    case "linear": return "linear";
    case "hold": return "hold";
    case "cubic-bezier": return undefined;
    case "spring": return undefined;
    case "normalized-spring": return undefined;
    case "preset": return FIGMA_EASING_PRESETS[easing.name.toUpperCase()];
  }
}

/**
 * A Motion `bounce` → the physical spring the sampler can integrate.
 *
 * This is the one place the importer assumes something Figma does not document, so it is stated
 * rather than buried: **damping ratio = 1 - bounce**, and the segment's own length is the
 * spring's period. That is the relation Apple's `Spring(duration:bounce:)` uses, which Figma's
 * single normalized control mirrors — `bounce: 0` is critically damped and settles without
 * overshoot, `bounce: 1` is undamped and rings.
 *
 * Because the relation is inferred and not published, every curve built from it is classified
 * `sampled`, never `native-editable`: the author is told the shape is an approximation. Mass is
 * fixed at 1 because only the ratio `stiffness/mass` and the damping ratio affect the normalised
 * 0→1 progress the sampler needs.
 *
 * `zeta` is floored rather than allowed to reach 0: a truly undamped spring never settles, so a
 * `bounce` of 1 would trace a curve that has not arrived by the last keyframe, and the imported
 * motion would end somewhere other than where the design ends.
 */
export function normalizedSpringToPhysical(
  bounce: number,
  durationSeconds: number
): { mass: number; stiffness: number; damping: number } {
  const clampedBounce = Math.min(1, Math.max(0, Number.isFinite(bounce) ? bounce : 0));
  const zeta = Math.max(0.08, 1 - clampedBounce);
  const seconds = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0.3;
  const mass = 1;
  const omega0 = (2 * Math.PI) / seconds;
  return { mass, stiffness: omega0 * omega0 * mass, damping: 2 * zeta * omega0 * mass };
}

/**
 * Figma's named easings, mapped to the GrapiX curve of the same shape.
 *
 * The spring presets (`GENTLE`, `QUICK`, `BOUNCY`, `SLOW`) are absent on purpose: they are
 * physical simulations, not the polynomial curves GrapiX names, so they sample.
 */
const FIGMA_EASING_PRESETS: Readonly<Record<string, SceneKeyframeEasing>> = {
  LINEAR: "linear",
  EASE_IN: "ease-in",
  EASE_OUT: "ease-out",
  EASE_IN_AND_OUT: "ease-in-out",
  EASE_IN_BACK: "ease-in-back",
  EASE_OUT_BACK: "ease-out-back",
  EASE_IN_AND_OUT_BACK: "ease-in-out-back"
};
