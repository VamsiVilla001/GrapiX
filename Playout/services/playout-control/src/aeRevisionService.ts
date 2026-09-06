import {
  AeDataRevisionRefusal,
  REFUSAL_FOR_VERDICT,
  type AeDataRevisionRequest,
  type AeDataRevisionState,
  type AeDynamicControl,
  type AeRuntimeContainer
} from "@grapix/ae-runtime-contract";
import type { AeRuntimeRevisionMember, AeRuntimeRevisionResult, AeRuntimeResult } from "@grapix/adobe-common-schema";
import type { AuditReservation } from "@grapix/auth-contract";
import { resolveDataPath } from "@grapix/shared-types";
import { AeControlRefusal, type AeControlService } from "./aeControlService.js";
import type { AeDataRevisionTracker } from "./aeDataRevisionTracker.js";
import type { AeRuntimeSupervisor } from "./aeRuntimeSupervisor.js";

/**
 * The one service that applies a data revision.
 *
 * Order is the contract. Every binding is resolved and validated before After Effects is asked to
 * change anything; audit capacity is claimed before the adapter is called; the accepted revision is
 * persisted only after the adapter reports the whole batch written. A revision that fails anywhere
 * leaves the accepted revision where it was, so the next attempt carries the same number rather than
 * the next one.
 *
 * Update policy is recorded, not enforced here: `on-take` and `on-cue` gating needs the verb state
 * machine PL3 owns, and pretending to gate without it would be a claim this phase cannot back.
 */
export interface AeRevisionMemberPlan {
  control: AeDynamicControl;
  dataPath: string;
  value: unknown;
}

export interface AeRevisionApplication {
  state: AeDataRevisionState;
  /** Null when the request repeated an accepted revision: nothing was dispatched, so there is no envelope. */
  result: AeRuntimeResult<AeRuntimeRevisionResult> | null;
  members: AeRevisionMemberPlan[];
  duplicate: boolean;
}

/** Claims audit capacity for a whole revision. Returns null when the sink cannot promise the room. */
export interface AeAuditReserver {
  reserve(count: number): AuditReservation | null;
}

interface AeRevisionPayload {
  revision: number;
  members: AeRuntimeRevisionMember[];
}

export class AeRevisionService {
  private readonly applies = new Map<string, Promise<void>>();

  constructor(
    private readonly controls: AeControlService,
    private readonly tracker: AeDataRevisionTracker,
    private readonly runtime: Pick<AeRuntimeSupervisor, "call">
  ) {}

  /**
   * Resolve and validate every bound control without writing anything.
   *
   * Separate from `apply` because the exit gate has to prove a bad member costs the adapter no call
   * at all, and because a caller may want the validation verdict on its own.
   */
  async plan(container: AeRuntimeContainer, request: AeDataRevisionRequest): Promise<AeRevisionMemberPlan[]> {
    const bindings = container.dataBindings ?? [];
    if (bindings.length === 0) {
      throw new AeDataRevisionRefusal("REVISION_NO_MEMBERS", `container ${container.id} declares no data bindings`);
    }

    const seen = new Set<string>();
    const plans: AeRevisionMemberPlan[] = [];
    for (const binding of bindings) {
      if (seen.has(binding.controlId)) {
        throw new AeDataRevisionRefusal(
          "REVISION_MEMBER_INVALID",
          `control ${binding.controlId} is bound twice; one revision cannot hold two values for it`,
          binding.controlId
        );
      }
      seen.add(binding.controlId);

      const value = resolveDataPath(request.dataContext, binding.dataPath);
      if (value === undefined) {
        throw new AeDataRevisionRefusal(
          "REVISION_MEMBER_INVALID",
          `binding ${binding.dataPath} for control ${binding.controlId} resolved to nothing; a revision is never partial`,
          binding.controlId
        );
      }

      let control: AeDynamicControl;
      try {
        control = await this.controls.validate(container, binding.controlId);
        this.controls.assertValue(control, value);
      } catch (error) {
        if (error instanceof AeControlRefusal) {
          throw new AeDataRevisionRefusal(
            "REVISION_MEMBER_INVALID",
            `${binding.controlId}: ${error.message}`,
            binding.controlId
          );
        }
        throw error;
      }
      plans.push({ control, dataPath: binding.dataPath, value });
    }
    return plans;
  }

  /**
   * Apply one complete revision.
   *
   * `audit` is asked for `members + 1` records before dispatch and the revision is refused if it
   * cannot promise them: an applied revision nobody can reconstruct is not an acceptable outcome for
   * something that reaches air.
   *
   * The returned reservation belongs to the caller, which writes the records and releases it.
   */
  async apply(
    container: AeRuntimeContainer,
    request: AeDataRevisionRequest,
    audit: AeAuditReserver
  ): Promise<{ application: AeRevisionApplication; reservation: AuditReservation | null }> {
    const previous = this.applies.get(container.id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.applies.set(container.id, current);
    await previous.catch(() => undefined);
    try {
      return await this.applyUnlocked(container, request, audit);
    } finally {
      release();
      if (this.applies.get(container.id) === current) this.applies.delete(container.id);
    }
  }

  private async applyUnlocked(
    container: AeRuntimeContainer,
    request: AeDataRevisionRequest,
    audit: AeAuditReserver
  ): Promise<{ application: AeRevisionApplication; reservation: AuditReservation | null }> {
    const state = await this.tracker.read(container.id);
    const evaluation = await this.tracker.evaluate(container.id, request);

    if (evaluation.verdict === "duplicate") {
      return { reservation: null, application: { state, duplicate: true, members: [], result: null } };
    }
    if (evaluation.verdict !== "apply") {
      throw new AeDataRevisionRefusal(REFUSAL_FOR_VERDICT[evaluation.verdict], evaluation.message);
    }

    const members = await this.plan(container, request);

    const reservation = audit.reserve(members.length + 1);
    if (!reservation) {
      throw new AeDataRevisionRefusal(
        "REVISION_AUDIT_UNAVAILABLE",
        "the audit sink cannot accept this revision's records, so the revision is refused rather than applied unrecorded"
      );
    }

    try {
      const payload: AeRevisionPayload = {
        revision: request.revision,
        members: members.map((member) => ({
          target: {
            compositionItemId: member.control.target.compositionItemId,
            layerId: member.control.target.layerId,
            sourceItemId: member.control.target.sourceItemId,
            path: member.control.target.propertyPath.map((segment) => ({ ...segment }))
          },
          value: member.value
        }))
      };

      const result = await this.runtime.call<AeRuntimeRevisionResult, AeRevisionPayload>(
        "APPLY_DATA_REVISION",
        payload,
        {
          expectedProjectDigest: container.projectDigest,
          idempotencyKey: request.idempotencyKey,
          revision: request.revision
        }
      );

      if (!result.ok) {
        switch (result.error?.code) {
          case "REVISION_ROLLED_BACK":
            throw new AeDataRevisionRefusal(
              "REVISION_ROLLED_BACK",
              result.error.message ?? "the runtime restored every member after refusing the revision"
            );
          case "REVISION_ROLLBACK_FAILED":
            throw new AeDataRevisionRefusal(
              "REVISION_ROLLBACK_FAILED",
              "After Effects holds a mixed state: some members have the new value and some have the old value. No retry is safe until a human has inspected the project."
            );
          case "PROJECT_DIGEST_MISMATCH":
            throw new AeDataRevisionRefusal(
              "REVISION_CONFLICT",
              result.error.message ?? "the open project no longer matches this container's pinned digest"
            );
          default:
            throw new AeDataRevisionRefusal(
              "REVISION_MEMBER_INVALID",
              result.error?.message ?? "the runtime refused the revision"
            );
        }
      }

      // The per-container queue makes this a compare-and-swap against our own callers. Re-read at
      // commit as well so another process touching the durable tracker cannot be overwritten.
      const current = await this.tracker.read(container.id);
      if (current.acceptedRevision !== state.acceptedRevision) {
        throw new AeDataRevisionRefusal(
          "REVISION_CONFLICT",
          `revision ${request.revision} cannot commit: expected accepted revision ${state.acceptedRevision}, found ${current.acceptedRevision}`
        );
      }

      const committed = await this.tracker.commit(
        container.id,
        request,
        members.map((member) => member.control.controlId)
      );
      return { reservation, application: { state: committed, result, members, duplicate: false } };
    } catch (error) {
      // Return capacity for a mixed state as for a clean rollback: this service throws before it can
      // write audit records with the reservation, and retaining it would only leak capacity. Unlike
      // a normal retryable refusal, the mixed-state message directs a human inspection before retry.
      reservation.release();
      throw error;
    }
  }
}
