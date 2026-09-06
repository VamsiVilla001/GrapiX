/**
 * Durable data revisions for one runtime container.
 *
 * A revision is the unit GrapiX acknowledges: one complete, validated snapshot of every declared
 * control that carries a data binding. Nothing partial is ever accepted, and nothing advances the
 * accepted revision except a batch After Effects wrote in full.
 *
 * Modelled on `SceneRevisionTracker` in `@grapix/scene-model`, deliberately not overloaded onto it.
 * A scene patch is an ordered stream of small operations against a document GrapiX owns; a data
 * revision is one all-or-nothing write into a process GrapiX does not own, where the failure modes
 * are the adapter's rather than the link's. Sharing the class would force one of the two to lie
 * about what a "revision" costs.
 *
 * The verdict vocabulary is kept identical on purpose, so an operator reading two logs does not have
 * to learn two words for the same fact.
 */

/** Binds one declared control to a path in the container's data context. */
export interface AeControlBinding {
  /** Declared `AeDynamicControl.controlId`. A binding to an undeclared control is refused. */
  controlId: string;
  /** Dot/bracket path resolved with `resolveDataPath` from `@grapix/shared-types`. */
  dataPath: string;
}

/**
 * Every verdict here is reachable, which is why there is no separate "stale".
 *
 * Because a revision must be exactly `baseRevision + 1`, the base alone decides the rest: below the
 * accepted revision the sender branched from a superseded state (`conflict`), above it an earlier
 * batch never arrived (`gap`), equal to it the batch is next (`apply`). A resend of an accepted
 * number under a different key is indistinguishable from divergence, so it is refused as a conflict
 * rather than guessed at.
 */
export type AeDataRevisionVerdict =
  /** In sequence against the accepted revision. Validate, then apply. */
  | "apply"
  /** Already accepted under the same idempotency key. Acknowledge; do not write again. */
  | "duplicate"
  /** Not a single step forward, or not a usable integer pair. */
  | "not-monotonic"
  /** Builds on a later revision than the one accepted; an earlier batch never arrived. */
  | "gap"
  /** Branches from a revision the accepted state has already superseded. */
  | "conflict";

export interface AeDataRevisionEvaluation {
  verdict: AeDataRevisionVerdict;
  acceptedRevision: number;
  requestBaseRevision: number;
  requestRevision: number;
  message: string;
}

/** What one container has accepted. Persisted, so a restart cannot re-apply or skip a revision. */
export interface AeDataRevisionState {
  containerId: string;
  /** Zero before the first accepted revision. */
  acceptedRevision: number;
  /** Idempotency key of the accepted revision; null before the first. */
  acceptedIdempotencyKey: string | null;
  acceptedAt: string | null;
  /** Control ids the accepted revision wrote, in the order the adapter applied them. */
  acceptedControlIds: string[];
}

export interface AeDataRevisionRequest {
  /** Revision the caller believes is accepted. Must equal the persisted value to apply. */
  baseRevision: number;
  /** Revision this batch becomes. Must be exactly `baseRevision + 1`. */
  revision: number;
  /** Stable per attempt, so a retry is recognised rather than re-applied. */
  idempotencyKey: string;
  /**
   * The complete data context this revision resolves against. Partial contexts are refused:
   * a binding that resolves to `undefined` fails the batch instead of holding its old value.
   */
  dataContext: Record<string, unknown>;
}

export type AeDataRevisionRefusalCode =
  | "REVISION_GAP"
  | "REVISION_CONFLICT"
  | "REVISION_NOT_MONOTONIC"
  | "REVISION_MEMBER_INVALID"
  | "REVISION_NO_MEMBERS"
  | "REVISION_AUDIT_UNAVAILABLE"
  | "REVISION_ROLLED_BACK"
  | "REVISION_ROLLBACK_FAILED";

export class AeDataRevisionRefusal extends Error {
  constructor(
    readonly code: AeDataRevisionRefusalCode,
    message: string,
    /** The member that failed, when exactly one is to blame. */
    readonly controlId: string | null = null
  ) {
    super(message);
    this.name = "AeDataRevisionRefusal";
  }
}

export function emptyAeDataRevisionState(containerId: string): AeDataRevisionState {
  return {
    containerId,
    acceptedRevision: 0,
    acceptedIdempotencyKey: null,
    acceptedAt: null,
    acceptedControlIds: []
  };
}

/**
 * Classify a request against the accepted state.
 *
 * Pure, so the route, the tracker and the tests agree on the verdict without exchanging anything
 * but numbers and the idempotency key.
 */
export function evaluateAeDataRevision(
  state: AeDataRevisionState,
  request: AeDataRevisionRequest
): AeDataRevisionEvaluation {
  const base = {
    acceptedRevision: state.acceptedRevision,
    requestBaseRevision: request.baseRevision,
    requestRevision: request.revision
  };

  if (
    request.idempotencyKey === state.acceptedIdempotencyKey &&
    request.revision === state.acceptedRevision
  ) {
    return {
      ...base,
      verdict: "duplicate",
      message: `revision ${request.revision} was already accepted under this idempotency key`
    };
  }

  if (
    !Number.isSafeInteger(request.revision) ||
    !Number.isSafeInteger(request.baseRevision) ||
    request.baseRevision < 0 ||
    request.revision !== request.baseRevision + 1
  ) {
    return {
      ...base,
      verdict: "not-monotonic",
      message: `revision ${request.revision} must be a single step past a non-negative base, and base ${request.baseRevision} does not give that`
    };
  }

  if (request.baseRevision === state.acceptedRevision) {
    return { ...base, verdict: "apply", message: "in sequence" };
  }

  if (request.baseRevision > state.acceptedRevision) {
    return {
      ...base,
      verdict: "gap",
      message: `revision builds on ${request.baseRevision} but only ${state.acceptedRevision} is accepted`
    };
  }

  return {
    ...base,
    verdict: "conflict",
    message: `revision branches from ${request.baseRevision}, which revision ${state.acceptedRevision} has already superseded`
  };
}

export const REFUSAL_FOR_VERDICT: Readonly<
  Record<Exclude<AeDataRevisionVerdict, "apply" | "duplicate">, AeDataRevisionRefusalCode>
> = {
  "not-monotonic": "REVISION_NOT_MONOTONIC",
  gap: "REVISION_GAP",
  conflict: "REVISION_CONFLICT"
};
