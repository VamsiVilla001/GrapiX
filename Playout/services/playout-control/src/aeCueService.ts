import { randomUUID } from "node:crypto";
import type { AeRuntimeContainer } from "@grapix/ae-runtime-contract";
import {
  resolveAeCueMap,
  type AeCueMarker,
  type AeCueRole
} from "@grapix/animation-engine";
import {
  reconcileAeCompositionClock,
  type AeCompositionClock,
  type AeExactRate,
  type AeExactTime
} from "@grapix/shared-types";
import type { AeRuntimeResult } from "@grapix/adobe-common-schema";
import type { AeRuntimeSupervisor } from "./aeRuntimeSupervisor.js";

export type AeCueServiceRefusalCode =
  | "CUE_MAP_INVALID"
  | "CUE_MAP_DIGEST_MISMATCH"
  | "CUE_UNDECLARED"
  | "COMPOSITION_UNDECLARED"
  | "COMPOSITION_CLOCK_MISMATCH"
  | "PROJECT_DIGEST_MISMATCH"
  | "RATE_INVALID"
  | "RATE_NOT_IN_COMPOSITION_SCALE";

export class AeCueServiceRefusal extends Error {
  constructor(readonly code: AeCueServiceRefusalCode, message: string) {
    super(message);
    this.name = "AeCueServiceRefusal";
  }
}

/** The persisted declaration associated with one container; no raw frame is accepted at this boundary. */
export interface AeRecordedCueMap {
  containerId: string;
  compositionItemId: number;
  projectDigest: string;
  cueMapDigest: string;
  markers: AeCueMarker[];
  rate: AeExactRate;
  /** Exact composition clock recorded with this digest-pinned cue declaration. */
  clock: AeCompositionClock;
}

export interface AeCueSetTimeRequest {
  /** The digest the caller selected from the container record. It must equal the recorded declaration. */
  cueMapDigest: string;
  role: AeCueRole;
  /** Required only for CONTINUE. Supplying it for another role is refused as undeclared. */
  id?: string | null;
}

export interface AeSetTimePayload {
  containerId: string;
  compositionItemId: number;
  projectDigest: string;
  cueMapDigest: string;
  /** Exact time in the composition's own AE scale; this is the SET_TIME value. */
  time: AeExactTime;
  /** Same instant in the declared Program rate's scale, retained for audit. */
  declaredTime: AeExactTime;
  /** Composition scale that makes `time` meaningful to AE. */
  clock: AeCompositionClock;
  frame: number;
  rate: AeExactRate;
  deadlineNanos: number;
}

/**
 * Resolves only a declared, digest-pinned cue to the adapter's exact SET_TIME operation.
 *
 * The recorded map is deliberately an explicit input: PL1 does not create another pipe or a second
 * container store. Its future persistence owner passes the same durable record it admitted.
 */
export class AeCueService {
  constructor(private readonly runtime: Pick<AeRuntimeSupervisor, "call">) {}

  async setTime(
    container: AeRuntimeContainer,
    recorded: AeRecordedCueMap,
    request: AeCueSetTimeRequest
  ): Promise<AeRuntimeResult> {
    if (recorded.containerId !== container.id || recorded.projectDigest !== container.projectDigest) {
      throw new AeCueServiceRefusal("PROJECT_DIGEST_MISMATCH", "recorded cue map does not belong to this pinned container project");
    }
    const composition = container.compositions.find(
      (candidate) => candidate.itemId === recorded.compositionItemId
    );
    if (!composition) {
      throw new AeCueServiceRefusal("COMPOSITION_UNDECLARED", `composition ${recorded.compositionItemId} is not declared by container ${container.id}`);
    }
    const clock = composition.clock;
    if (
      recorded.clock.frameDuration !== clock.frameDuration
      || recorded.clock.timeScale !== clock.timeScale
    ) {
      throw new AeCueServiceRefusal(
        "COMPOSITION_CLOCK_MISMATCH",
        `recorded composition clock ${recorded.clock.frameDuration}/${recorded.clock.timeScale} does not match container composition clock ${clock.frameDuration}/${clock.timeScale}`
      );
    }
    const profileRate = parseFrameRate(container.profile.frameRate);
    if (!profileRate || profileRate.numerator !== recorded.rate.numerator || profileRate.denominator !== recorded.rate.denominator) {
      throw new AeCueServiceRefusal("RATE_INVALID", "recorded cue-map rate does not match the container profile");
    }
    const reconciliation = reconcileAeCompositionClock(clock, recorded.rate);
    if (reconciliation === "RATE_NOT_IN_COMPOSITION_SCALE") {
      throw new AeCueServiceRefusal(
        "RATE_NOT_IN_COMPOSITION_SCALE",
        `declared rate ${recorded.rate.numerator}/${recorded.rate.denominator} is not representable by composition clock frameDuration=${clock.frameDuration}, timeScale=${clock.timeScale}`
      );
    }
    if (typeof reconciliation === "string") {
      throw new AeCueServiceRefusal("RATE_INVALID", `invalid composition clock or recorded rate: ${reconciliation}`);
    }

    const resolved = resolveAeCueMap(recorded.markers, recorded.rate, clock);
    if (!resolved.ok) {
      throw new AeCueServiceRefusal("CUE_MAP_INVALID", `${resolved.code}: ${resolved.message}`);
    }
    if (resolved.digest !== recorded.cueMapDigest || request.cueMapDigest !== recorded.cueMapDigest) {
      throw new AeCueServiceRefusal("CUE_MAP_DIGEST_MISMATCH", "selected cue map does not match the digest recorded for this container");
    }

    const cue = resolved.cues.find((candidate) => candidate.role === request.role && candidate.id === (request.id ?? null));
    if (!cue) {
      throw new AeCueServiceRefusal("CUE_UNDECLARED", request.role === "CONTINUE"
        ? `CONTINUE:${request.id ?? ""} is not declared by this cue map`
        : `${request.role} is not a declared cue`);
    }
    if (!cue.compositionTime) {
      throw new AeCueServiceRefusal("CUE_MAP_INVALID", "resolved cue is missing its composition-scale time");
    }
    const payload: AeSetTimePayload = {
      containerId: container.id,
      compositionItemId: recorded.compositionItemId,
      projectDigest: container.projectDigest,
      cueMapDigest: resolved.digest,
      time: { ...cue.compositionTime },
      declaredTime: { ...cue.time },
      clock: { ...clock },
      frame: cue.frame,
      rate: { ...recorded.rate },
      deadlineNanos: cue.deadlineNanos
    };
    return this.runtime.call("SET_TIME", payload, {
      expectedProjectDigest: container.projectDigest,
      idempotencyKey: randomUUID()
    });
  }
}

function parseFrameRate(value: string): AeExactRate | null {
  const match = /^(0|[1-9][0-9]*)\/(0|[1-9][0-9]*)$/.exec(value);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  return Number.isSafeInteger(numerator) && Number.isSafeInteger(denominator) && numerator > 0 && denominator > 0
    ? { numerator, denominator }
    : null;
}
