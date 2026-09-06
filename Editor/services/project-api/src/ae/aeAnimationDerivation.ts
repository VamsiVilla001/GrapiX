/**
 * Turn a composition's declared `GRAPIX:` markers into the broadcast actions a package carries.
 *
 * This is where the cue map stops being decoration on the timeline and becomes the thing Playout
 * can play. The markers already exist in the parsed project; what they have never had is a path
 * into `animations.json`. The mapping is fixed by the broadcast grammar:
 *
 *   CUE …… the parked frame before anything moves (not an action — where TAKE starts)
 *   IN   → HOLD    …… the entrance; plays once, then holds
 *   HOLD → OUT     …… the sustain; `holds: true`, Playout parks here until told otherwise
 *   OUT  → END     …… the exit
 *
 * CONTINUE and UPDATE are operator interruptions, not regions, so they become cues, not actions.
 *
 * Everything is derived from the composition's own clock — never from the float frame rate the
 * project reports — so an action's frames are the frames After Effects will actually render. A
 * composition with no markers produces no cue map and no actions: marker-free playback is not
 * guessed at, it is simply absent, exactly as the cue-map resolver refuses to infer it.
 */
import { resolveAeCueMap, type AeCueMarker, type AeResolvedCue } from "@grapix/animation-engine";
import type { AePackageAnimationAction } from "@grapix/ae-runtime-contract";
import {
  aeCompositionClockRate,
  aeExactTime,
  type AeCompositionClock,
  type AeExactRate
} from "@grapix/shared-types";
import type { AeComposition } from "@grapix/shared-types";

/** A cue map proven against a composition clock, ready to record on a container. */
export interface DerivedAeCueMap {
  /** The composition this map belongs to, by stable item id. */
  compositionItemId: number;
  markers: AeCueMarker[];
  rate: AeExactRate;
  clock: AeCompositionClock;
  cueMapDigest: string;
  cues: { role: AeResolvedCue["role"]; id: string | null; frame: number }[];
}

/**
 * The animation half of a publish, derived from the composition's markers.
 *
 * `actions` is empty when the composition declares no markers; `cueMap` is present exactly when the
 * markers resolve into a complete, frame-exact map. The two travel together: an action list without
 * the cue map it came from could not be re-proven on the playout machine.
 */
export interface DerivedAeAnimation {
  actions: AePackageAnimationAction[];
  cueMap: DerivedAeCueMap | null;
}

/** Parse a container profile's rational frame rate (`30000/1001`) into an exact rate. */
function rateOf(frameRate: string): AeExactRate | null {
  const [numerator, denominator] = frameRate.split("/").map(Number);
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator) || denominator === 0) return null;
  return { numerator, denominator };
}

/**
 * Derive the actions and cue map for one composition.
 *
 * Marker times arrive as float seconds (`AeMarker.time`); they are restated as exact times in the
 * declared rate's scale before resolution, because the resolver works in rationals and a float
 * second is the thing that was never exact. The composition clock comes from the caller — the
 * container's declared composition — so the digest the resolver produces is the same digest the
 * playout side pins against.
 */
export function deriveAeAnimation(
  composition: AeComposition,
  frameRate: string,
  clock: AeCompositionClock
): DerivedAeAnimation {
  const declared = rateOf(frameRate);
  const cueMarkers = composition.markers.filter((marker) => marker.comment?.startsWith("GRAPIX:"));
  if (!declared || cueMarkers.length === 0) return { actions: [], cueMap: null };

  // Resolve against the composition's *reduced* rate. The declared profile rate and the clock's
  // reduced rate are the same rational, but the reduced one is the frame grid: it is what makes a
  // marker land on a whole frame rather than 625ths of one. A clock that cannot state its own rate
  // has no frame grid to work in, so the map stays absent.
  const rate = aeCompositionClockRate(clock);
  if (!rate) return { actions: [], cueMap: null };

  // Restate each marker as an exact time on the frame grid. A marker at `time` seconds sits on
  // frame `time·numerator/denominator`. The resolver maps an exact time back to a frame via
  // `value·numerator / (scale·denominator)`, so the spelling that returns that exact frame is
  // `value = frame·denominator, scale = numerator` — the frame, re-expressed as an instant.
  const markers: AeCueMarker[] = cueMarkers.map((marker) => {
    const frame = Math.round((marker.time * rate.numerator) / rate.denominator);
    return {
      text: marker.comment as string,
      time: aeExactTime(frame * rate.denominator, rate.numerator)
    };
  });

  const resolved = resolveAeCueMap(markers, rate, clock);
  if (!resolved.ok) return { actions: [], cueMap: null };

  const cueMap: DerivedAeCueMap = {
    compositionItemId: 0, // stamped by the caller, which knows the item id
    markers,
    rate,
    clock,
    cueMapDigest: resolved.digest,
    cues: resolved.cues.map((cue) => ({ role: cue.role, id: cue.id, frame: cue.frame }))
  };

  return { actions: actionsFromCues(resolved.cues), cueMap };
}

/**
 * Regions between the fixed cues become actions, in timeline order.
 *
 * Only the three regions a broadcast operator drives are emitted; CUE is the pre-roll park and
 * CONTINUE/UPDATE are interruptions, so none of them is a region. A map missing one of the fixed
 * points has already been refused by the resolver, so by the time cues reach here the regions are
 * well-formed.
 */
function actionsFromCues(cues: readonly AeResolvedCue[]): AePackageAnimationAction[] {
  const frame = (role: AeResolvedCue["role"]): number | null =>
    cues.find((cue) => cue.role === role)?.frame ?? null;

  const inFrame = frame("IN");
  const holdFrame = frame("HOLD");
  const outFrame = frame("OUT");
  const endFrame = frame("END");
  if (inFrame === null || holdFrame === null || outFrame === null || endFrame === null) return [];

  return [
    { role: "IN", startFrame: inFrame, endFrame: holdFrame },
    { role: "HOLD", startFrame: holdFrame, endFrame: outFrame, holds: true },
    { role: "OUT", startFrame: outFrame, endFrame: endFrame }
  ];
}
