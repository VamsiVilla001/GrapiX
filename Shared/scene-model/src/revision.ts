/**
 * Revision tracking, ordering, and resynchronisation.
 *
 * A patch stream over an unreliable link produces four hazards, and each has a
 * different correct response:
 *
 *   duplicate  the same patch twice   → acknowledge, apply nothing
 *   out-of-order  a later patch first → park it briefly, then resync
 *   gap        a patch went missing   → resync immediately, never guess
 *   conflict   two editors diverged   → resync, and report who lost
 *
 * "Guess" is never an option. An engine that silently applies a patch across a
 * revision gap is rendering a document nobody else holds, and no operator can
 * tell from looking at the output.
 */

import type { SceneDocument } from "@grapix/shared-types";

import { applyScenePatch, sceneRevision, type PatchResult, type ScenePatch } from "./patch.js";

export type RevisionVerdict =
  /** In sequence. Apply it. */
  | "apply"
  /** Already applied. Acknowledge and discard. */
  | "duplicate"
  /** Arrived early; one or more earlier patches are outstanding. */
  | "out-of-order"
  /** An earlier patch will never arrive. Full sync required. */
  | "gap"
  /** Base revision does not match; another producer got there first. */
  | "conflict";

export interface RevisionEvaluation {
  verdict: RevisionVerdict;
  currentRevision: number;
  patchBaseRevision: number;
  patchRevision: number;
  requiresFullSync: boolean;
  message: string;
}

/**
 * Classify a patch against the currently held revision.
 *
 * Pure, so both ends of the link agree on the classification without needing to
 * exchange anything but revision numbers.
 */
export function evaluateRevision(currentRevision: number, patch: ScenePatch): RevisionEvaluation {
  const base = {
    currentRevision,
    patchBaseRevision: patch.baseRevision,
    patchRevision: patch.revision
  };

  if (patch.revision <= currentRevision) {
    return {
      ...base,
      verdict: "duplicate",
      requiresFullSync: false,
      message: `patch revision ${patch.revision} is at or behind the held revision ${currentRevision}`
    };
  }

  if (patch.baseRevision === currentRevision) {
    return { ...base, verdict: "apply", requiresFullSync: false, message: "in sequence" };
  }

  if (patch.baseRevision > currentRevision) {
    return {
      ...base,
      verdict: "out-of-order",
      requiresFullSync: false,
      message: `patch builds on revision ${patch.baseRevision} but only ${currentRevision} is held; ${patch.baseRevision - currentRevision} patch(es) outstanding`
    };
  }

  // baseRevision < currentRevision and revision > currentRevision: the sender
  // branched from an older state than we hold. Two producers diverged.
  return {
    ...base,
    verdict: "conflict",
    requiresFullSync: true,
    message: `patch branches from revision ${patch.baseRevision} but ${currentRevision} is already held`
  };
}

export interface RevisionTrackerOptions {
  /**
   * How many out-of-order patches to hold before giving up and resyncing.
   *
   * Small on purpose. Parking is a courtesy for brief reordering, not a
   * reassembly buffer: past a couple of frames a resync is cheaper and safer
   * than waiting.
   */
  parkLimit?: number;
  /** Producer identity, so conflicts can name a loser. */
  origin?: string;
}

export type RevisionEventType =
  | "applied"
  | "duplicate-dropped"
  | "parked"
  | "unparked"
  | "gap-detected"
  | "conflict-detected"
  | "full-sync-required"
  | "full-sync-applied";

export interface RevisionEvent {
  type: RevisionEventType;
  revision: number;
  message: string;
}

export interface IngestResult {
  /** Patches actually applied, in order, including unparked ones. */
  applied: ScenePatch[];
  /** The document after applying everything that could be applied. */
  scene: SceneDocument;
  revision: number;
  /** True when the caller must request a `FullSceneSync`. */
  requiresFullSync: boolean;
  events: RevisionEvent[];
}

/**
 * Ordered, gap-aware patch ingestion for one scene.
 *
 * Holds the authoritative document and decides, for each arriving patch, whether
 * to apply, discard, park, or demand a full sync.
 */
export class SceneRevisionTracker {
  private scene: SceneDocument;
  private readonly parkLimit: number;
  private readonly origin?: string;
  private readonly parked = new Map<number, ScenePatch>();
  private fullSyncPending = false;

  constructor(scene: SceneDocument, options: RevisionTrackerOptions = {}) {
    this.scene = scene;
    this.parkLimit = Math.max(0, options.parkLimit ?? 4);
    if (options.origin) this.origin = options.origin;
  }

  get revision(): number {
    return sceneRevision(this.scene);
  }

  get document(): SceneDocument {
    return this.scene;
  }

  get parkedCount(): number {
    return this.parked.size;
  }

  get needsFullSync(): boolean {
    return this.fullSyncPending;
  }

  /**
   * Ingest one patch, then drain anything parked that has become applicable.
   *
   * Draining matters: patches 3 and 4 arriving before 2 must both apply as soon
   * as 2 arrives, in one pass, rather than requiring two more round trips.
   */
  ingest(patch: ScenePatch): IngestResult {
    const events: RevisionEvent[] = [];
    const applied: ScenePatch[] = [];

    if (this.fullSyncPending) {
      events.push({
        type: "full-sync-required",
        revision: this.revision,
        message: "patch ignored while a full sync is outstanding"
      });
      return this.result(applied, events, true);
    }

    const evaluation = evaluateRevision(this.revision, patch);

    switch (evaluation.verdict) {
      case "duplicate":
        events.push({
          type: "duplicate-dropped",
          revision: this.revision,
          message: evaluation.message
        });
        return this.result(applied, events, false);

      case "conflict":
        this.fullSyncPending = true;
        this.parked.clear();
        events.push({
          type: "conflict-detected",
          revision: this.revision,
          message:
            this.origin && patch.origin && patch.origin !== this.origin
              ? `${evaluation.message} (producer ${patch.origin} conflicts with ${this.origin})`
              : evaluation.message
        });
        return this.result(applied, events, true);

      case "out-of-order": {
        if (this.parked.size >= this.parkLimit) {
          this.fullSyncPending = true;
          this.parked.clear();
          events.push({
            type: "gap-detected",
            revision: this.revision,
            message: `${this.parkLimit} patches parked without closing the gap; full sync required`
          });
          return this.result(applied, events, true);
        }
        this.parked.set(patch.baseRevision, patch);
        events.push({ type: "parked", revision: patch.revision, message: evaluation.message });
        return this.result(applied, events, false);
      }

      case "apply":
      default:
        break;
    }

    const first = this.tryApply(patch, events);
    if (!first) return this.result(applied, events, this.fullSyncPending);
    applied.push(patch);

    // Drain the parked set now that the revision advanced.
    for (;;) {
      const next = this.parked.get(this.revision);
      if (!next) break;
      this.parked.delete(this.revision);
      events.push({
        type: "unparked",
        revision: next.revision,
        message: `applying previously parked patch ${next.revision}`
      });
      if (!this.tryApply(next, events)) break;
      applied.push(next);
    }

    return this.result(applied, events, this.fullSyncPending);
  }

  /**
   * Replace the document wholesale.
   *
   * The only recovery from a gap or conflict, and the only thing that clears the
   * pending flag.
   */
  applyFullSync(scene: SceneDocument): IngestResult {
    this.scene = scene;
    this.parked.clear();
    this.fullSyncPending = false;

    return this.result(
      [],
      [
        {
          type: "full-sync-applied",
          revision: this.revision,
          message: `full sync applied at revision ${this.revision}`
        }
      ],
      false
    );
  }

  /** Force a resync, e.g. after a reconnect where revisions cannot be trusted. */
  requestFullSync(reason: string): RevisionEvent {
    this.fullSyncPending = true;
    this.parked.clear();
    return { type: "full-sync-required", revision: this.revision, message: reason };
  }

  private tryApply(patch: ScenePatch, events: RevisionEvent[]): boolean {
    const result: PatchResult = applyScenePatch(this.scene, patch);

    if (!result.applied) {
      if (result.requiresFullSync) {
        this.fullSyncPending = true;
        this.parked.clear();
      }
      events.push({
        type: result.requiresFullSync ? "full-sync-required" : "gap-detected",
        revision: this.revision,
        message: `${result.failure.code}: ${result.failure.message}`
      });
      return false;
    }

    this.scene = result.scene;
    events.push({
      type: "applied",
      revision: result.revision,
      message: `applied ${patch.operations.length} operation(s) to reach revision ${result.revision}`
    });
    for (const warning of result.warnings) {
      events.push({ type: "applied", revision: result.revision, message: `warning: ${warning}` });
    }
    return true;
  }

  private result(
    applied: ScenePatch[],
    events: RevisionEvent[],
    requiresFullSync: boolean
  ): IngestResult {
    return {
      applied,
      scene: this.scene,
      revision: this.revision,
      requiresFullSync,
      events
    };
  }
}

/**
 * Compare two revision maps after a reconnect.
 *
 * The client sends what it believes each scene's revision is; the engine reports
 * what it actually holds. Any disagreement, in either direction, is a resync
 * candidate — the client being *ahead* is just as broken as being behind.
 */
export interface RevisionComparison {
  /** Scenes the engine holds at a different revision. */
  mismatched: { sceneId: string; clientRevision: number; engineRevision: number }[];
  /** Scenes the client knows about and the engine does not. */
  missingOnEngine: string[];
  /** Scenes the engine holds that the client no longer tracks. */
  staleOnEngine: string[];
  /** Scene ids needing a full sync. */
  resyncSceneIds: string[];
}

export function compareRevisions(
  clientRevisions: ReadonlyMap<string, number>,
  engineRevisions: ReadonlyMap<string, number>
): RevisionComparison {
  const mismatched: RevisionComparison["mismatched"] = [];
  const missingOnEngine: string[] = [];
  const staleOnEngine: string[] = [];

  for (const [sceneId, clientRevision] of clientRevisions) {
    const engineRevision = engineRevisions.get(sceneId);
    if (engineRevision === undefined) {
      missingOnEngine.push(sceneId);
      continue;
    }
    if (engineRevision !== clientRevision) {
      mismatched.push({ sceneId, clientRevision, engineRevision });
    }
  }

  for (const sceneId of engineRevisions.keys()) {
    if (!clientRevisions.has(sceneId)) staleOnEngine.push(sceneId);
  }

  return {
    mismatched: mismatched.sort((a, b) => a.sceneId.localeCompare(b.sceneId)),
    missingOnEngine: missingOnEngine.sort(),
    staleOnEngine: staleOnEngine.sort(),
    resyncSceneIds: [...missingOnEngine, ...mismatched.map((entry) => entry.sceneId)].sort()
  };
}
