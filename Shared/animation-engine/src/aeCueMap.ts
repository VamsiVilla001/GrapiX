import { createHash } from "node:crypto";
import {
  aeExactTimeToProgramFrame,
  compareAeExactTimes,
  programFrameToAeCompositionTime,
  reconcileAeCompositionClock,
  type AeCompositionClock,
  type AeExactRate,
  type AeExactTime
} from "@grapix/shared-types";

export type AeCueRole = "CUE" | "IN" | "HOLD" | "CONTINUE" | "UPDATE" | "OUT" | "END";

/** A raw After Effects marker. Only `GRAPIX:` markers participate in the declared cue map. */
export interface AeCueMarker {
  text: string;
  time: AeExactTime;
}

export interface AeResolvedCue {
  role: AeCueRole;
  id: string | null;
  time: AeExactTime;
  frame: number;
  deadlineNanos: number;
  /**
   * The same instant restated in the composition's own scale — the only form After Effects accepts.
   *
   * Present exactly when the map was resolved against a composition clock. Absent means the map has
   * been proven against the declared rate alone, which is not enough to drive `SET_TIME`: the
   * declared rate and the composition's scale are two clocks until proven equal.
   */
  compositionTime?: AeExactTime;
}

export type AeCueRefusalCode =
  | "CUE_ROLE_DUPLICATED"
  | "CUE_ROLE_MISSING"
  | "CUE_ORDER_NON_MONOTONIC"
  | "CUE_END_NOT_AFTER_OUT"
  | "CUE_ID_DUPLICATED"
  | "CUE_ID_INVALID"
  | "CUE_MARKER_MALFORMED"
  | "CUE_OFF_FRAME"
  /**
   * The composition's own scale cannot carry the declared rate, so no cue on it is representable.
   *
   * This is structural rather than per-cue: once the two clocks are the same rational, every cue that
   * lands on a Program frame lands on a composition frame, so there is no separate per-cue refusal.
   */
  | "CUE_RATE_NOT_IN_COMPOSITION_SCALE";

export type AeCueMapResolution =
  | { ok: true; cues: AeResolvedCue[]; digest: string }
  | { ok: false; code: AeCueRefusalCode; message: string; marker: string | null };

const ROLE_ORDER: Record<AeCueRole, number> = {
  CUE: 0,
  IN: 1,
  HOLD: 2,
  CONTINUE: 3,
  UPDATE: 4,
  OUT: 5,
  END: 6
};
const CONTINUE_ID = /^[A-Za-z0-9_-]{1,32}$/;
const REQUIRED_ROLES: readonly Exclude<AeCueRole, "CONTINUE" | "UPDATE">[] = ["CUE", "IN", "HOLD", "OUT", "END"];

/**
 * Resolve a complete declared cue map. This accepts no inferred or marker-free playback state:
 * every participating marker is frame-exact, every required role is present exactly once, and
 * the declared order is proven before the map can be used.
 *
 * Supplying `clock` additionally reconciles the declared rate with the composition's own time scale
 * and restates every cue in that scale. Without it the map is only proven against the rate, which is
 * how a cue declared at `30000/1001` was silently quantised onto a neighbouring frame by a
 * composition whose scale was `23976`. The resulting digest covers the composition clock too, so a
 * composition re-authored at another scale invalidates every recorded cue-map pin rather than
 * resolving to the same digest against a different clock.
 */
export function resolveAeCueMap(
  markers: readonly AeCueMarker[],
  rate: AeExactRate,
  clock?: AeCompositionClock
): AeCueMapResolution {
  if (clock !== undefined) {
    const reconciled = reconcileAeCompositionClock(clock, rate);
    if (typeof reconciled === "string") {
      return refusal(
        "CUE_RATE_NOT_IN_COMPOSITION_SCALE",
        `declared rate ${rate.numerator}/${rate.denominator} is not the composition's own clock ` +
          `(frame duration ${clock.frameDuration} in scale ${clock.timeScale}): ${reconciled}`,
        null
      );
    }
  }

  const cues: AeResolvedCue[] = [];
  const fixedRoles = new Map<Exclude<AeCueRole, "CONTINUE" | "UPDATE">, AeResolvedCue>();
  const continueIds = new Set<string>();

  for (const marker of markers) {
    const parsed = parseMarker(marker.text);
    if (parsed === null) continue;
    if (parsed.kind !== "valid") {
      return parsed.kind === "malformed"
        ? refusal("CUE_MARKER_MALFORMED", `malformed GrapiX marker ${marker.text}`, marker.text)
        : refusal("CUE_ID_INVALID", `invalid CONTINUE id in ${marker.text}`, marker.text);
    }

    const mapped = aeExactTimeToProgramFrame(marker.time, rate);
    if (typeof mapped === "string") {
      return refusal("CUE_OFF_FRAME", `cue ${marker.text} cannot map exactly to a Program frame (${mapped})`, marker.text);
    }

    const cue: AeResolvedCue = {
      role: parsed.role,
      id: parsed.id,
      time: { value: marker.time.value, scale: marker.time.scale },
      frame: mapped.frame,
      deadlineNanos: mapped.deadlineNanos
    };

    if (clock !== undefined) {
      // The rate is already proven to be this composition's own clock, and that proof is what makes
      // this a plain multiplication: `timeScale = k·numerator` and `frameDuration = k·denominator`,
      // so a Program frame is always exactly a composition frame and cue `F` sits at `F·frameDuration`.
      // There is deliberately no second divisibility test here — it could not fail, and a refusal
      // branch that cannot fire is a claim the code does not honour. An authored instant that is
      // *not* on a composition frame is refused by `CUE_OFF_FRAME` above, because with the clocks
      // reconciled that is the same condition.
      const compositionTime = programFrameToAeCompositionTime(mapped.frame, clock);
      if (typeof compositionTime === "string") {
        return refusal("CUE_RATE_NOT_IN_COMPOSITION_SCALE", `cue ${marker.text}: ${compositionTime}`, marker.text);
      }
      cue.compositionTime = compositionTime;
    }

    if (cue.role === "CONTINUE") {
      const id = cue.id!;
      if (continueIds.has(id)) return refusal("CUE_ID_DUPLICATED", `CONTINUE id ${id} is declared more than once`, marker.text);
      continueIds.add(id);
    } else if (cue.role !== "UPDATE") {
      if (fixedRoles.has(cue.role)) return refusal("CUE_ROLE_DUPLICATED", `role ${cue.role} is declared more than once`, marker.text);
      fixedRoles.set(cue.role, cue);
    }
    cues.push(cue);
  }

  for (const role of REQUIRED_ROLES) {
    if (!fixedRoles.has(role)) return refusal("CUE_ROLE_MISSING", `required role ${role} is not declared`, null);
  }

  const cue = fixedRoles.get("CUE")!;
  const input = fixedRoles.get("IN")!;
  const hold = fixedRoles.get("HOLD")!;
  const out = fixedRoles.get("OUT")!;
  const end = fixedRoles.get("END")!;

  const allButCue = cues.filter((candidate) => candidate !== cue);
  const beforeCue = allButCue.find((candidate) => compare(candidate.time, cue.time) < 0);
  if (beforeCue) return refusal("CUE_ORDER_NON_MONOTONIC", `${beforeCue.role} precedes CUE`, markerFor(beforeCue));
  if (compare(input.time, cue.time) < 0) return refusal("CUE_ORDER_NON_MONOTONIC", "IN precedes CUE", markerFor(input));
  if (compare(hold.time, input.time) < 0) return refusal("CUE_ORDER_NON_MONOTONIC", "HOLD precedes IN", markerFor(hold));

  const postHold = cues.filter((candidate) => candidate.role === "CONTINUE" || candidate.role === "UPDATE");
  const beforeHold = postHold.find((candidate) => compare(candidate.time, hold.time) < 0);
  if (beforeHold) return refusal("CUE_ORDER_NON_MONOTONIC", `${markerFor(beforeHold)} precedes HOLD`, markerFor(beforeHold));

  const lastDynamic = postHold.reduce<AeResolvedCue | null>(
    (latest, candidate) => latest === null || compare(candidate.time, latest.time) > 0 ? candidate : latest,
    null
  );
  const outPredecessor = lastDynamic ?? hold;
  if (compare(out.time, outPredecessor.time) < 0) {
    return refusal("CUE_ORDER_NON_MONOTONIC", `OUT precedes ${markerFor(outPredecessor)}`, markerFor(out));
  }
  if (compare(end.time, out.time) <= 0) return refusal("CUE_END_NOT_AFTER_OUT", "END must be strictly after OUT", markerFor(end));

  cues.sort(compareResolvedCues);
  // The digest pins the declaration. When a composition clock took part in the proof it is part of
  // that declaration: the same markers reconciled against a different scale are a different cue map,
  // and a recorded pin must not survive the composition being re-authored at another scale.
  const canonical = clock === undefined
    ? cues.map(({ role, id, time, frame, deadlineNanos }) => ({ role, id, time, frame, deadlineNanos }))
    : {
        clock: { frameDuration: clock.frameDuration, timeScale: clock.timeScale },
        cues: cues.map(({ role, id, time, frame, deadlineNanos, compositionTime }) => ({
          role,
          id,
          time,
          frame,
          deadlineNanos,
          compositionTime
        }))
      };
  return { ok: true, cues, digest: createHash("sha256").update(JSON.stringify(canonical)).digest("hex") };
}

type ParsedMarker = { kind: "valid"; role: AeCueRole; id: string | null } | { kind: "malformed" | "invalid-id" };

function parseMarker(text: string): ParsedMarker | null {
  if (!text.startsWith("GRAPIX:")) return null;
  const content = text.slice("GRAPIX:".length);
  if (content === "CUE" || content === "IN" || content === "HOLD" || content === "UPDATE" || content === "OUT" || content === "END") {
    return { kind: "valid", role: content, id: null };
  }
  if (content.startsWith("CONTINUE:")) {
    const id = content.slice("CONTINUE:".length);
    return CONTINUE_ID.test(id) ? { kind: "valid", role: "CONTINUE", id } : { kind: "invalid-id" };
  }
  return { kind: "malformed" };
}

function compare(left: AeExactTime, right: AeExactTime): number {
  const result = compareAeExactTimes(left, right);
  // Invalid exact times are already refused by aeExactTimeToProgramFrame before any ordering check.
  return result;
}

function compareResolvedCues(left: AeResolvedCue, right: AeResolvedCue): number {
  const time = compare(left.time, right.time);
  if (time !== 0) return time;
  const role = ROLE_ORDER[left.role] - ROLE_ORDER[right.role];
  if (role !== 0) return role;
  return (left.id ?? "").localeCompare(right.id ?? "");
}

function markerFor(cue: AeResolvedCue): string {
  return cue.role === "CONTINUE" ? `GRAPIX:CONTINUE:${cue.id}` : `GRAPIX:${cue.role}`;
}

function refusal(code: AeCueRefusalCode, message: string, marker: string | null): AeCueMapResolution {
  return { ok: false, code, message, marker };
}
