import {
  emptyAeDataRevisionState,
  evaluateAeDataRevision,
  type AeDataRevisionEvaluation,
  type AeDataRevisionRequest,
  type AeDataRevisionState
} from "@grapix/ae-runtime-contract";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Durable accepted-revision state, one file per container.
 *
 * The state is written only after After Effects reports the whole batch applied, so the failure
 * order is deliberate: a crash between the adapter write and this write re-offers the same revision
 * (which the idempotency key then recognises as a retry), while a crash the other way round would
 * skip a revision nothing had applied. One of the two has to be possible; this is the safe one.
 *
 * Writes are serialised per container and land through a temporary file and a rename, matching
 * `AeContainerStore`, so a torn file cannot be read back as a lower accepted revision.
 */
export class AeDataRevisionTracker {
  private readonly root: string;
  private readonly writes = new Map<string, Promise<void>>();
  private readonly cache = new Map<string, AeDataRevisionState>();

  constructor(dataRoot: string) {
    this.root = path.join(dataRoot, "ae-data-revisions");
  }

  async read(containerId: string): Promise<AeDataRevisionState> {
    const cached = this.cache.get(containerId);
    if (cached) return { ...cached, acceptedControlIds: [...cached.acceptedControlIds] };
    try {
      const state = JSON.parse(await readFile(this.pathFor(containerId), "utf8")) as AeDataRevisionState;
      if (
        state.containerId === containerId &&
        Number.isSafeInteger(state.acceptedRevision) &&
        state.acceptedRevision >= 0 &&
        Array.isArray(state.acceptedControlIds)
      ) {
        this.cache.set(containerId, state);
        return { ...state, acceptedControlIds: [...state.acceptedControlIds] };
      }
    } catch {
      // An absent or unreadable file means nothing has been accepted; it never means "accept anyway".
    }
    return emptyAeDataRevisionState(containerId);
  }

  async evaluate(containerId: string, request: AeDataRevisionRequest): Promise<AeDataRevisionEvaluation> {
    return evaluateAeDataRevision(await this.read(containerId), request);
  }

  /** Persist an accepted revision. Called only after the adapter applied every member. */
  async commit(
    containerId: string,
    request: AeDataRevisionRequest,
    acceptedControlIds: readonly string[]
  ): Promise<AeDataRevisionState> {
    const next: AeDataRevisionState = {
      containerId,
      acceptedRevision: request.revision,
      acceptedIdempotencyKey: request.idempotencyKey,
      acceptedAt: new Date().toISOString(),
      acceptedControlIds: [...acceptedControlIds]
    };
    await this.persist(next);
    this.cache.set(containerId, next);
    return { ...next, acceptedControlIds: [...next.acceptedControlIds] };
  }

  private pathFor(containerId: string): string {
    return path.join(this.root, `${containerId}.json`);
  }

  private async persist(state: AeDataRevisionState): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const target = this.pathFor(state.containerId);
    const previous = this.writes.get(target) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(async () => {
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
      await rename(temporary, target);
    });
    this.writes.set(target, pending);
    try { await pending; } finally { if (this.writes.get(target) === pending) this.writes.delete(target); }
  }
}
