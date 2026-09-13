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
} from "@grapix/contracts";

import { evaluateChannel } from "./timeline/easing";

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
/// Animation properties are flattened ObjectBase fields on every SceneObject,
/// so applying a property by its Rust-advertised name keeps this composition
/// open to the generated contract without a second hand-maintained switch.
export function previewSceneAt(
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
  const properties = new Set(surface.properties);
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
    if (!properties.has(channel.property)) {
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
    return patch === undefined ? object : ({ ...object, ...patch } as SceneObject);
  });
  return { document: { ...document, objects: nextObjects }, issues };
}
