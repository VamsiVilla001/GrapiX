// Local Editor animation preview (build plan 11.24).
//
// **One clock calculation, no accumulated interval.** Every displayed frame is
// derived from the playback start time and the scene's exact rational rate.
// A delayed animation callback may skip a preview frame, but it can never make
// the playhead drift away from scene time by repeatedly adding a rounded
// interval (invariant 12).
//
// **Rust still owns easing.** `evaluateChannel` is the browser mirror already
// pinned against Rust-generated references by `timeline/easing.test.ts`. This
// module composes that proven evaluator over a document; it does not introduce
// another easing implementation.

import type {
  AnimationSurface,
  RationalRate,
  SceneDocument,
  SceneObject,
  StrokeStyle,
} from "@grapix/contracts";

import { supportsScalarProperty } from "./keyframe-editor";
import { applyPathChannels } from "./path-anim";
import { evaluateChannel } from "./timeline/easing";
import { evaluateColour } from "./colour-anim";

export interface PreviewFrame {
  readonly frame: number;
  readonly ended: boolean;
}

/// Resolve an absolute elapsed time to a whole scene frame.
///
/// `elapsedMs * num / (1000 * den)` preserves the rational rate until the one
/// final division. The caller passes time since playback began, never a delta
/// from the previous callback, so a slow render cannot compound clock error.
export function previewFrameAtElapsed(
  startFrame: number,
  elapsedMs: number,
  rate: RationalRate,
  durationFrames: number,
): PreviewFrame {
  const duration = Math.max(0, Math.floor(durationFrames));
  const start = Math.min(duration, Math.max(0, Math.floor(startFrame)));
  const elapsed = Math.max(0, Number.isFinite(elapsedMs) ? elapsedMs : 0);
  const advanced = Math.floor((elapsed * rate.num) / (1000 * rate.den));
  const requested = start + advanced;
  return {
    frame: Math.min(duration, requested),
    ended: requested >= duration,
  };
}

export interface PreviewEvaluation {
  readonly document: SceneDocument;
  /// Invalid channel conditions that prevented a value from being previewed.
  /// They are surfaced by the Editor; never silently ignored.
  readonly issues: readonly string[];
}

/// Evaluate every authored channel at one whole scene frame.
///
/// Scalar channels use the stored JSON names of their object or base fields.
export function previewSceneAt(
  document: SceneDocument,
  requestedFrame: number,
  surface: AnimationSurface | null,
): PreviewEvaluation {
  const numeric = previewNumericAt(document, requestedFrame, surface);
  // 11.112: animated paths, by vertex id, then put where the channels have them at this frame.
  const duration = Number(document.timeline.durationFrames);
  const paths = applyPathChannels(numeric.document, Math.min(duration, Math.max(0, Math.round(requestedFrame))));
  // 11.132: solid fill and stroke colours, worked out as the contract does, put on the paint.
  const coloured = applyColourChannels(paths.document, Math.min(duration, Math.max(0, Math.round(requestedFrame))));
  return paths.issues.length === 0 && coloured === numeric.document
    ? numeric
    : { document: coloured, issues: [...numeric.issues, ...paths.issues] };
}

/// The colour channels' values at a frame, as each object's solid paint. A channel with no keys leaves the paint as authored.
export function applyColourChannels(document: SceneDocument, frame: number): SceneDocument {
  const channels = (document.timeline.colourChannels ?? []).filter((channel) => channel.keys.length > 0);
  if (channels.length === 0) return document;
  const patches = new Map<string, Record<string, unknown>>();
  for (const channel of channels) {
    const value = evaluateColour(channel, frame);
    if (value === undefined) continue;
    const patch = patches.get(channel.objectId) ?? {};
    // The text animator's colour is the animator's own field, not a paint; the Draft view keeps the animator whole.
    if (channel.property === "textAnimatorFill") {
      const object = document.objects.find((candidate) => candidate.id === channel.objectId) as { textAnimator?: Record<string, unknown> } | undefined;
      if (object?.textAnimator === undefined) continue;
      patch.textAnimator = { ...((patch.textAnimator as Record<string, unknown> | undefined) ?? object.textAnimator), fill: value };
    } else {
      patch[channel.property] = { type: "solid", color: value };
    }
    patches.set(channel.objectId, patch);
  }
  if (patches.size === 0) return document;
  return {
    ...document,
    objects: document.objects.map((object) => {
      const patch = patches.get(object.id);
      return patch === undefined ? object : ({ ...object, ...patch } as SceneObject);
    }),
  };
}

/// The stroke style an object draws with when it stores none: what the contract's `StrokeStyle::default` gives.
const DEFAULT_STROKE_STYLE: StrokeStyle = { join: "miter", cap: "butt", miterLimit: 4, dash: [], dashOffset: 0 };

/// Put evaluated scalars on a copy of the object. Most are top-level fields under their stored names; `strokeStyle.dashOffset` is nested, so it is
/// merged into the object's own stroke style and the dash pattern, join, cap and miter limit stay as authored.
function applyScalarPatch(object: SceneObject, patch: Record<string, number>): SceneObject {
  const { ["strokeStyle.dashOffset"]: dashOffset, ...rest } = patch;
  // The dash pattern's entries (`strokeStyle.dash.N`, the contract's `dash::index`) are nested in the same stroke style.
  const dashEntries: [number, number][] = [];
  const flat: Record<string, number> = {};
  for (const [name, value] of Object.entries(rest)) {
    const match = /^strokeStyle\.dash\.(0|[1-9][0-9]*)$/.exec(name);
    if (match === null) flat[name] = value;
    else dashEntries.push([Number(match[1]), value]);
  }
  // The text animator's scalars (11.61) are nested in `textAnimator`: `selector.start|end|offset`, `x`, `y`, `scale`, `rotation`, `opacity`.
  const animator = (object as { textAnimator?: { selector: Record<string, unknown> } & Record<string, unknown> }).textAnimator;
  let animated: Record<string, unknown> | undefined;
  for (const name of Object.keys(flat)) {
    if (!name.startsWith("textAnimator.")) continue;
    const value = flat[name]!;
    delete flat[name];
    if (animator === undefined) continue;
    animated ??= { ...animator, selector: { ...animator.selector } };
    const path = name.slice("textAnimator.".length);
    if (path.startsWith("selector.")) (animated.selector as Record<string, unknown>)[path.slice("selector.".length)] = value;
    else animated[path] = value;
  }
  const next = { ...object, ...flat, ...(animated === undefined ? {} : { textAnimator: animated }) } as SceneObject;
  if (dashOffset === undefined && dashEntries.length === 0) return next;
  const own = (object as { strokeStyle?: StrokeStyle }).strokeStyle ?? DEFAULT_STROKE_STYLE;
  const dash = [...own.dash];
  // An entry past the authored pattern is not drawn: the contract refuses such a channel, so it is left out here.
  for (const [index, value] of dashEntries) if (index < dash.length) dash[index] = value;
  return { ...next, strokeStyle: { ...own, dash, dashOffset: dashOffset ?? own.dashOffset } } as SceneObject;
}

function previewNumericAt(
  document: SceneDocument,
  requestedFrame: number,
  surface: AnimationSurface | null,
): PreviewEvaluation {
  const duration = Number(document.timeline.durationFrames);
  const frame = Math.min(duration, Math.max(0, Math.round(requestedFrame)));
  if (document.timeline.channels.length === 0) return { document, issues: [] };
  if (surface === null) {
    return {
      document,
      issues: ["animation preview unavailable: the Rust animation surface was not loaded"],
    };
  }

  const objects = new Map(document.objects.map((object) => [object.id, object] as const));
  const kinds = new Set(surface.objectKinds);
  const patches = new Map<string, Record<string, number>>();
  const evaluated = new Set<string>();
  const issues: string[] = [];

  for (const channel of document.timeline.channels) {
    const address = `${channel.objectId}.${channel.property}`;
    if (evaluated.has(address)) {
      issues.push(`animation preview refused duplicate channel ${address}`);
      continue;
    }
    evaluated.add(address);

    const object = objects.get(channel.objectId);
    if (!object) {
      issues.push(`animation preview cannot find object ${channel.objectId}`);
      continue;
    }
    if (!kinds.has(object.type)) {
      issues.push(`animation preview does not support ${object.type} object ${object.id}`);
      continue;
    }
    if (!supportsScalarProperty(surface, object.type, channel.property)) {
      issues.push(`animation preview does not support property ${channel.property} on ${object.id}`);
      continue;
    }
    const value = evaluateChannel(channel, frame);
    if (value === undefined) continue;
    if (!Number.isFinite(value)) {
      issues.push(`animation preview produced a non-finite value for ${address}`);
      continue;
    }
    const patch = patches.get(object.id) ?? {};
    patch[channel.property] = value;
    patches.set(object.id, patch);
  }

  if (patches.size === 0) return { document, issues };
  const nextObjects = document.objects.map((object) => {
    const patch = patches.get(object.id);
    return patch === undefined ? object : applyScalarPatch(object, patch);
  });
  return { document: { ...document, objects: nextObjects }, issues };
}
