/**
 * Figma motion → GrapiX keyframes.
 *
 * The rule this module exists to hold: **a track becomes a keyframe only when GrapiX has a
 * channel that plays it.** Six properties do — x, y, rotation, scaleX, scaleY, opacity — because
 * those are what `animation.rs` samples every Program frame. Width, height, corner radius, fill,
 * stroke and effects do not, and writing them somewhere plausible would author a scene that
 * previews one way and airs another. They are classified `unsupported`, carried through with
 * their original data, and named in the report (invariant 7; rules 82 and 105).
 *
 * Easing is the same argument at a smaller scale. A Figma curve is reproduced exactly or it is
 * sampled and *said* to be sampled — never substituted for the nearest preset, because a curve
 * that is nearly right is a graphic that moves differently on air with nothing to show for it.
 */
import {
  figmaEasingToSceneEasing,
  isChannelBackedMotionProperty,
  normalizedSpringToPhysical,
  type AnimatableProperty,
  type FigmaMotionCompatibilityEntry,
  type FigmaMotionEasing,
  type FigmaMotionImportReport,
  type FigmaMotionKeyframe,
  type FigmaMotionManifest,
  type FigmaMotionTimeline,
  type FigmaMotionTrack,
  type PropertyKeyframe,
  type SceneDocument,
  type SceneObject
} from "@grapix/shared-types";

export interface FigmaMotionConversionOptions {
  fps: number;
  /**
   * Keys per second when baking a curve GrapiX has no closed form for.
   *
   * Bounded rather than "one per frame": a 2-second spring at 50fps would otherwise deposit a
   * hundred keys on one channel, which is unreadable in the Timeline and unusable to edit — the
   * opposite of what converting to native keyframes is for.
   */
  springSamplesPerSecond?: number;
  maxSpringSamples?: number;
}

const DEFAULT_SPRING_SAMPLES_PER_SECOND = 12;
const DEFAULT_MAX_SPRING_SAMPLES = 48;

/**
 * Apply a motion manifest to an imported scene.
 *
 * Pure: it returns a new scene and never mutates the one passed in, so a caller can roll back by
 * discarding the result. That is what makes "rollback on failure" honest rather than a promise
 * to undo writes that already happened.
 */
export function applyFigmaMotion(
  scene: SceneDocument,
  manifest: FigmaMotionManifest,
  options: FigmaMotionConversionOptions
): { scene: SceneDocument; report: FigmaMotionImportReport } {
  const fps = Number.isFinite(options.fps) && options.fps > 0 ? options.fps : 50;
  const entries: FigmaMotionCompatibilityEntry[] = [];
  const missingNodes = new Set<string>();
  const objectsByNodeId = indexObjectsByFigmaNodeId(scene.objects);
  /**
   * Resting values, read before anything is written.
   *
   * An `offset` track is a displacement from where the design puts the layer, so resolving it
   * needs the layer's own position — and needs it from the *unmodified* scene, or a second
   * timeline writing the same channel would offset from the first timeline's keyframes instead of
   * from the layout.
   */
  const baseValues = new Map(scene.objects.map((object) => [object.id, objectBaseValues(object)]));
  /** Channels accumulate per object across every timeline before one rewrite of the scene. */
  const pending = new Map<string, Map<AnimatableProperty, PropertyKeyframe[]>>();
  const convertedTimelines = new Set<string>();

  for (const timeline of manifest.timelines) {
    const delayFrames = msToFrames(timeline.delayMs ?? timeline.trigger?.delayMs ?? 0, fps);

    for (const node of timeline.nodes) {
      const objectId = objectsByNodeId.get(node.nodeId);
      if (!objectId) {
        missingNodes.add(node.nodeId);
        entries.push({
          compatibility: "unsupported",
          nodeId: node.nodeId,
          nodeName: node.name,
          property: "*",
          timelineId: timeline.id,
          timelineName: timeline.name,
          detail: "No imported object carries this Figma node id — the frame holding it was probably not selected for import.",
          keyframesCreated: 0,
          original: { node: node as unknown as Record<string, unknown> }
        });
        continue;
      }

      for (const track of node.tracks) {
        const converted = convertTrack(track, timeline, delayFrames, fps, options, baseValues.get(objectId));
        entries.push({
          ...converted.entry,
          nodeId: node.nodeId,
          nodeName: node.name,
          objectId,
          timelineId: timeline.id,
          timelineName: timeline.name
        });

        if (!converted.keys.length || !converted.property) continue;
        convertedTimelines.add(timeline.id);
        const channels = pending.get(objectId) ?? new Map<AnimatableProperty, PropertyKeyframe[]>();
        // Overlapping timelines write to the same channel; merging by frame keeps both rather
        // than letting the last timeline in the manifest silently win.
        channels.set(
          converted.property,
          mergeKeys(channels.get(converted.property) ?? [], converted.keys)
        );
        pending.set(objectId, channels);
      }
    }
  }

  const nextScene = pending.size ? writeChannels(scene, pending) : scene;
  const keyframesCreated = entries.reduce((total, entry) => total + entry.keyframesCreated, 0);

  return {
    scene: nextScene,
    report: {
      timelines: manifest.timelines.length,
      timelinesConverted: convertedTimelines.size,
      matchedNodes: new Set(entries.filter((entry) => entry.objectId).map((entry) => entry.nodeId)).size,
      missingNodes: [...missingNodes],
      channelsCreated: [...pending.values()].reduce((total, channels) => total + channels.size, 0),
      keyframesCreated,
      entries
    }
  };
}

interface ConvertedTrack {
  property?: AnimatableProperty;
  keys: PropertyKeyframe[];
  entry: Omit<FigmaMotionCompatibilityEntry, "nodeId" | "timelineId" | "timelineName">;
}

function convertTrack(
  track: FigmaMotionTrack,
  timeline: FigmaMotionTimeline,
  delayFrames: number,
  fps: number,
  options: FigmaMotionConversionOptions,
  baseValues: Partial<Record<AnimatableProperty, number>> | undefined
): ConvertedTrack {
  if (!isChannelBackedMotionProperty(track.property)) {
    return {
      keys: [],
      entry: {
        compatibility: "unsupported",
        property: track.property,
        detail: `GrapiX has no animation channel for ${track.property}, so no keyframes were written. The original track is kept here.`,
        keyframesCreated: 0,
        original: { track: track as unknown as Record<string, unknown> }
      }
    };
  }

  const property = track.property as AnimatableProperty;
  const numeric = track.keyframes.filter((key) => typeof key.value === "number");
  if (numeric.length < 1) {
    return {
      keys: [],
      entry: {
        compatibility: "unsupported",
        property: track.property,
        detail: "The track carries no numeric values, so nothing could be interpolated.",
        keyframesCreated: 0,
        original: { track: track as unknown as Record<string, unknown> }
      }
    };
  }

  /*
   * A Motion transform track is a displacement, not a coordinate: a 0 key means "where the frame
   * put it". Resolving it against the object's resting value is what keeps an animated layer on
   * its design position instead of flinging it to the canvas origin.
   */
  const base = track.valueSpace === "offset" ? baseValues?.[property] ?? DEFAULT_BASE_VALUES[property] ?? 0 : 0;
  const resolved = base === 0
    ? numeric
    : numeric.map((key) => ({ ...key, value: (key.value as number) + base }));

  const { keys, sampled } = buildKeys(resolved, delayFrames, fps, options);
  const compatibility = sampled
    ? "sampled"
    : timeline.transition?.type === "SMART_ANIMATE"
      ? "smart-animate-converted"
      : timeline.origin === "rest-prototype"
        ? "prototype-transition"
        : "native-editable";

  const from = track.sourceField && track.sourceField !== property ? ` from Figma's ${track.sourceField}` : "";
  const against = base === 0 ? "" : ` Offsets were resolved against the layer's design position (${round(base)}).`;

  return {
    property,
    keys,
    entry: {
      compatibility,
      property: track.property,
      detail: sampled
        ? `Figma's spring has no GrapiX curve, so it was baked into ${keys.length} keyframes that trace it${from}. Editable, and an approximation.${against}`
        : `Converted to ${keys.length} editable keyframes on ${property}${from}.${against}`,
      keyframesCreated: keys.length
    }
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * What an absent property rests at.
 *
 * Only consulted for an `offset` track whose object left the property unset. Scale defaults to 1
 * because a missing `scaleX` means "unscaled", and adding a displacement to 0 there would
 * collapse the layer to nothing.
 */
const DEFAULT_BASE_VALUES: Partial<Record<AnimatableProperty, number>> = {
  x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1
};

/** The resting value of every channel a Figma track can target. */
function objectBaseValues(object: SceneObject): Partial<Record<AnimatableProperty, number>> {
  return {
    x: object.x,
    y: object.y,
    rotation: object.rotation,
    scaleX: object.scaleX,
    scaleY: object.scaleY,
    opacity: object.opacity
  };
}

/**
 * Figma keyframes → GrapiX keyframes.
 *
 * The segment, not the key, owns the curve in both models, so easing is read from the *outgoing*
 * key. A cubic bezier is expressed exactly through the tangent handles `sampleChannel` already
 * solves; a spring has no such expression and is baked instead.
 */
function buildKeys(
  source: FigmaMotionKeyframe[],
  delayFrames: number,
  fps: number,
  options: FigmaMotionConversionOptions
): { keys: PropertyKeyframe[]; sampled: boolean } {
  const ordered = [...source].sort((left, right) => left.timeMs - right.timeMs);
  const keys: PropertyKeyframe[] = [];
  /**
   * In-tangents belong to the key a segment arrives at, but are read from the key it leaves.
   * Queued here by target index rather than stashed on the previous key, so nothing carries a
   * field that is not part of `PropertyKeyframe`.
   */
  const arrivingTangents = new Map<number, { x: number; y: number }>();
  let sampled = false;

  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index];
    const next = ordered[index + 1];
    const frame = delayFrames + msToFrames(current.timeMs, fps);
    const value = current.value as number;

    /*
     * Both spring flavours bake. A prototype `Transition` states physical parameters; a Motion
     * keyframe states a normalized bounce, and Figma publishes no inverse of
     * `physicalSpringToNormalized` — so the normalized one is converted under the single stated
     * assumption in `normalizedSpringToPhysical`, using this segment's own length as the period.
     * Either way the result is classified `sampled`, which is the honest label for a curve that
     * traces the source rather than reproducing it.
     */
    if (next && (current.easing?.kind === "spring" || current.easing?.kind === "normalized-spring")) {
      sampled = true;
      const spring = current.easing.kind === "spring"
        ? current.easing
        : {
          kind: "spring" as const,
          ...normalizedSpringToPhysical(current.easing.bounce, (next.timeMs - current.timeMs) / 1000)
        };
      keys.push(...sampleSpring(
        spring,
        frame,
        delayFrames + msToFrames(next.timeMs, fps),
        value,
        next.value as number,
        options
      ));
      continue;
    }

    const named = figmaEasingToSceneEasing(current.easing);
    const key: PropertyKeyframe = {
      id: `figma_${Math.round(current.timeMs)}_${keys.length}`,
      frame,
      value,
      easing: named ?? "linear"
    };

    if (!named && current.easing?.kind === "cubic-bezier" && next) {
      // `bezierEase` reads x1 = out.x / span and x2 = 1 - |in.x| / span, so these offsets
      // reproduce the designer's curve rather than approximating it with a preset.
      const span = Math.max(1, msToFrames(next.timeMs - current.timeMs, fps));
      const [p1x, p1y, p2x, p2y] = current.easing.points;
      key.outTangent = { x: p1x * span, y: p1y };
      arrivingTangents.set(keys.length + 1, { x: -(1 - p2x) * span, y: p2y - 1 });
    }

    keys.push(key);
  }

  for (const [index, tangent] of arrivingTangents) {
    if (keys[index]) keys[index].inTangent = tangent;
  }

  return { keys, sampled };
}

/**
 * Bake a Figma spring into keyframes.
 *
 * The closed form of a damped harmonic oscillator, in the three regimes Figma's parameters can
 * produce. Sampling rather than approximating with `ease-out-back` is deliberate: a spring
 * overshoots by an amount its stiffness and damping decide, and no fixed polynomial matches
 * more than one spring.
 */
function sampleSpring(
  spring: Extract<FigmaMotionEasing, { kind: "spring" }>,
  fromFrame: number,
  toFrame: number,
  fromValue: number,
  toValue: number,
  options: FigmaMotionConversionOptions
): PropertyKeyframe[] {
  const spanFrames = Math.max(1, toFrame - fromFrame);
  const perSecond = options.springSamplesPerSecond ?? DEFAULT_SPRING_SAMPLES_PER_SECOND;
  const maximum = options.maxSpringSamples ?? DEFAULT_MAX_SPRING_SAMPLES;
  const count = Math.max(2, Math.min(maximum, Math.round((spanFrames / Math.max(1, options.fps)) * perSecond) + 1));

  return Array.from({ length: count }, (_, index) => {
    const t = index / (count - 1);
    const progress = springProgress(spring, t);
    return {
      id: `figma_spring_${fromFrame}_${index}`,
      frame: Math.round(fromFrame + t * spanFrames),
      value: fromValue + (toValue - fromValue) * progress,
      easing: "linear" as const
    };
  });
}

/** Normalised 0→1 spring position at normalised time `t`. */
export function springProgress(
  spring: Extract<FigmaMotionEasing, { kind: "spring" }>,
  t: number
): number {
  const mass = spring.mass > 0 ? spring.mass : 1;
  const stiffness = spring.stiffness > 0 ? spring.stiffness : 100;
  const damping = spring.damping >= 0 ? spring.damping : 10;
  const velocity = spring.initialVelocity ?? 0;

  const omega0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));

  if (zeta < 1) {
    const omegaD = omega0 * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * omega0 * t) * (
      Math.cos(omegaD * t) + ((zeta * omega0 + velocity) / omegaD) * Math.sin(omegaD * t)
    );
  }

  if (zeta === 1) {
    return 1 - Math.exp(-omega0 * t) * (1 + (omega0 + velocity) * t);
  }

  const root = omega0 * Math.sqrt(zeta * zeta - 1);
  const a = (velocity + omega0 * (zeta - Math.sqrt(zeta * zeta - 1))) / (2 * root);
  const b = 1 - a;
  return 1 - Math.exp(-zeta * omega0 * t) * (a * Math.exp(root * t) + b * Math.exp(-root * t));
}

/** Milliseconds → whole frames. Frames are the scene's unit; sub-frame timing cannot survive. */
export function msToFrames(ms: number, fps: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.round((ms / 1000) * fps));
}

/**
 * Merge two key lists on one channel.
 *
 * Overlapping timelines are explicitly in scope, so the later list adds to the earlier rather
 * than replacing it; a collision on the same frame keeps the later value, which is what the
 * last-writer-wins of a real prototype does.
 */
function mergeKeys(existing: PropertyKeyframe[], incoming: PropertyKeyframe[]): PropertyKeyframe[] {
  const byFrame = new Map(existing.map((key) => [key.frame, key]));
  for (const key of incoming) byFrame.set(key.frame, key);
  return [...byFrame.values()].sort((left, right) => left.frame - right.frame);
}

function indexObjectsByFigmaNodeId(objects: readonly SceneObject[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const object of objects) {
    const nodeId = object.importedDesign?.sourceNodeId;
    // First writer wins: a component instance and its main component can carry one id, and the
    // first object in document order is the one the author sees on the canvas.
    if (typeof nodeId === "string" && nodeId && !index.has(nodeId)) index.set(nodeId, object.id);
  }
  return index;
}

function writeChannels(
  scene: SceneDocument,
  pending: Map<string, Map<AnimatableProperty, PropertyKeyframe[]>>
): SceneDocument {
  return {
    ...scene,
    objects: scene.objects.map((object) => {
      const channels = pending.get(object.id);
      if (!channels) return object;
      const animation = { ...(object.animation ?? {}) };
      for (const [property, keys] of channels) {
        animation[property] = { keys: mergeKeys(animation[property]?.keys ?? [], keys) };
      }
      return { ...object, animation };
    })
  };
}
