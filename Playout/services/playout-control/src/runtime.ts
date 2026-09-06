import type {
  PlayoutRuntimeStatus,
  PlayoutTakeList,
  PlayoutTakeState,
  PublishedSceneVersion
} from "@grapix/shared-types";
import type { EngineSupervisor } from "./engineSupervisor.js";
import type { PlayoutStore } from "./store.js";
import { PlayoutOperationError } from "./diagnostics.js";

/**
 * What an operator command acts on.
 *
 * Two ways to put a graphic on air, as in XPression: type a Scene Manager Take ID, or work
 * down a Take List. A discriminated union rather than an optional pair of ids, so an
 * ambiguous command — both, or neither — cannot be constructed.
 */
export type PlayoutTarget =
  | { kind: "scene"; takeId: number }
  | { kind: "entry"; takeListId: string; entryId: string };

/**
 * The state key a target is tracked under.
 *
 * A list entry is keyed by its own id. A direct recall has no entry, so it is keyed
 * `scene:<sceneId>` — inventing an entry id would make the UI highlight a take-list row that
 * is not what is on air.
 */
export function targetRef(target: PlayoutTarget): string {
  return target.kind === "entry" ? target.entryId : `scene:take-${target.takeId}`;
}

/**
 * Operator commands against the render engine.
 *
 * The engine is the only renderer: it owns Program, the frame clock and the outputs, so
 * taking a graphic online there is what starts the NDI/SDI and virtual outputs. There is no
 * second path. A retired protocol v2 daemon used to stand behind this as a fallback, and a
 * fallback that renders different pixels through a different output configuration is not a
 * safety net — it is a way to put something unverified on air (`docs/architecture.md`,
 * invariants 1 and 7).
 *
 * A missing engine is reported, never worked around.
 */
export class PlayoutRuntime {
  private status: PlayoutRuntimeStatus = {
    rendererConnection: "disconnected",
    previewRef: null,
    programRef: null,
    takeStates: {},
    lastError: null,
    updatedAt: new Date().toISOString()
  };

  constructor(
    private readonly store: PlayoutStore,
    private readonly engine: EngineSupervisor
  ) {}

  getStatus(): PlayoutRuntimeStatus {
    return structuredClone(this.status);
  }

  async checkConnection(): Promise<PlayoutRuntimeStatus> {
    const engine = this.engine.status();
    if (engine.connected) {
      this.patchStatus({ rendererConnection: "connected", lastError: null });
      return this.getStatus();
    }

    // The supervisor reconnects on its own schedule; asking it to try now is what an
    // operator pressing a status button expects.
    this.patchStatus({ rendererConnection: "connecting" });
    const connected = await this.engine.connect();
    this.patchStatus({
      rendererConnection: connected ? "connected" : "disconnected",
      lastError: connected ? null : this.engine.status().lastError
    });
    return this.getStatus();
  }

  /**
   * Cue a target to Preview.
   *
   * A target is either a take-list entry or a direct Scene Manager recall. Both end up
   * loading, preparing and cueing the same published scene; what differs is what the UI
   * highlights afterwards.
   */
  async cue(target: PlayoutTarget): Promise<PlayoutRuntimeStatus> {
    const ref = targetRef(target);
    this.setTakeState(ref, "LOADING");
    try {
      const published = await this.resolve(target);

      // Load, prepare, then cue. Preparation is kept separate from cueing so an
      // unprepared scene never reaches Preview looking ready.
      const controller = this.engine.requireConnected();
      const engineId = this.engine.id;
      await controller.load(engineId, published.scene);
      await controller.prepare(engineId, published.scene.id);
      await controller.cue(
        engineId,
        published.scene.id,
        published.scene.revision ?? 0,
        "preview"
      );
      this.setTakeState(ref, "LOADED");
      const previousPreview = this.status.previewRef;
      if (previousPreview && previousPreview !== ref) {
        this.setTakeState(previousPreview, "LOADED");
      }
      this.status.previewRef = ref;
      this.setTakeState(ref, "IN_PREVIEW");
      this.patchStatus({ rendererConnection: "connected", lastError: null });
      return this.getStatus();
    } catch (error) {
      this.setTakeState(ref, "ERROR");
      this.patchStatus({
        rendererConnection: "error",
        lastError: errorMessage(error)
      });
      throw error;
    }
  }

  /** Take In: put a target on Program. Cues first if it is not already in Preview. */
  async take(target: PlayoutTarget): Promise<PlayoutRuntimeStatus> {
    const ref = targetRef(target);
    try {
      const published = await this.resolve(target);
      if (this.status.previewRef !== ref) {
        await this.cue(target);
      }
      this.setTakeState(ref, "TAKING_ONLINE");

      // The engine starts every configured output on take, so this is the call that
      // actually puts the graphic out — live via NDI/SDI, or headlessly to a virtual
      // output. A refusal is the engine protecting Program and is reported as one.
      const result = await this.engine.requireConnected().takeOnline(
        this.engine.id,
        published.scene.id,
        published.scene.revision ?? 0
      );
      if (!result.accepted) {
        throw new PlayoutOperationError({
          code: "engine.take-refused",
          // The reason belongs in the summary as well as the cause: the banner shows only
          // the summary, and "the engine refused" without the reason is not actionable.
          summary: `The render engine refused to put "${published.name}" on Program${
            result.refusedReason ? `: ${result.refusedReason}` : ""
          }`,
          ...(result.refusedReason ? { cause: result.refusedReason } : {}),
          remedy:
            "A refusal protects Program: the engine will not air a scene it has not prepared or cannot render. Cue the scene first and read the engine's reason above.",
          context: {
            sceneId: published.scene.id,
            sceneName: published.name,
            sceneRevision: published.scene.revision ?? 0,
            takeId: published.takeId,
            overridden: result.overridden
          }
        });
      }
      const previousProgram = this.status.programRef;
      if (previousProgram && previousProgram !== ref) {
        this.setTakeState(previousProgram, "OFFLINE");
      }
      this.status.programRef = ref;
      this.setTakeState(ref, "ONLINE");
      this.patchStatus({ rendererConnection: "connected", lastError: null });
      return this.getStatus();
    } catch (error) {
      this.setTakeState(ref, "ERROR");
      this.patchStatus({
        rendererConnection: "error",
        lastError: errorMessage(error)
      });
      throw error;
    }
  }

  /**
   * Take Out: clear Program.
   *
   * The engine owns Program, so this asks it to clear and only then updates local state — the
   * opposite order would show an operator an empty Program while a graphic was still on air.
   */
  async takeOut(): Promise<PlayoutRuntimeStatus> {
    const onAir = this.status.programRef;
    if (!onAir) {
      return this.getStatus();
    }
    try {
      this.setTakeState(onAir, "TAKING_OFFLINE");
      await this.engine.requireConnected().clear(this.engine.id, "program");
      this.status.programRef = null;
      this.setTakeState(onAir, "OFFLINE");
      this.patchStatus({ rendererConnection: "connected", lastError: null });
      return this.getStatus();
    } catch (error) {
      this.setTakeState(onAir, "ERROR");
      this.patchStatus({ rendererConnection: "error", lastError: errorMessage(error) });
      throw error;
    }
  }

  /**
   * Advance the take-list cursor past what is currently on Program.
   *
   * Returns the entry the next Take In will operate on, or null at the end of the list. The
   * cursor is persisted, so reopening the operator window resumes where the show is.
   */
  async advanceCursor(takeListId: string): Promise<PlayoutTakeList | null> {
    const takeList = await this.store.readTakeList(takeListId);
    if (!takeList) {
      return null;
    }
    const current = takeList.cursorEntryId
      ? takeList.entries.findIndex((entry) => entry.entryId === takeList.cursorEntryId)
      : -1;
    const nextEntry = takeList.entries[current + 1];
    return this.store.saveTakeList({
      ...takeList,
      cursorEntryId: nextEntry?.entryId ?? null
    });
  }

  close(): void {
    this.engine.close();
  }

  /** Resolve a target to the published scene version it names. */
  private async resolve(target: PlayoutTarget): Promise<PublishedSceneVersion> {
    if (target.kind === "scene") {
      const scene = await this.store.readSceneByTakeId(target.takeId);
      if (!scene) {
        throw new PlayoutOperationError({
          code: "scene.take-id-unknown",
          summary: `No published scene has take ID ${target.takeId}`,
          remedy:
            "Check the Take ID in Scene Manager. If the scene was just published from the Editor, press Fetch to sync the library.",
          context: { takeId: target.takeId }
        });
      }
      return scene;
    }

    const takeList = await this.store.readTakeList(target.takeListId);
    if (!takeList) {
      throw new PlayoutOperationError({
        code: "take-list.unknown",
        summary: `Take list ${target.takeListId} does not exist`,
        remedy: "Reload the operator window; the list this command names is not in the Playout store.",
        context: { takeListId: target.takeListId }
      });
    }
    const entry = takeList.entries.find((candidate) => candidate.entryId === target.entryId);
    if (!entry) {
      throw new PlayoutOperationError({
        code: "take-list.entry-unknown",
        summary: `Take list "${takeList.name}" has no entry ${target.entryId}`,
        remedy: "The entry was removed after this window loaded. Reload the operator window and select it again.",
        context: { takeListId: target.takeListId, takeListName: takeList.name, entryId: target.entryId }
      });
    }
    const scene = await this.store.readScene(
      entry.sceneId,
      entry.versionPolicy === "pinned" ? entry.sceneVersion : undefined
    );
    if (!scene) {
      this.setTakeState(entry.entryId, "MISSING_ASSET");
      throw new PlayoutOperationError({
        code: "scene.version-unavailable",
        summary: `"${entry.name}" points at published scene ${entry.sceneId} v${entry.sceneVersion}, which is not in the Playout library`,
        remedy:
          entry.versionPolicy === "pinned"
            ? "This entry is pinned to one version, and that version has been removed. Re-publish it from the Editor, or set the entry to follow the latest version."
            : "Publish the scene from the Editor and press Fetch in Scene Manager, or remove the entry.",
        context: {
          entryId: entry.entryId,
          entryName: entry.name,
          sceneId: entry.sceneId,
          sceneVersion: entry.sceneVersion,
          versionPolicy: entry.versionPolicy
        }
      });
    }
    return scene;
  }

  private setTakeState(ref: string, state: PlayoutTakeState): void {
    this.status.takeStates[ref] = state;
    this.status.updatedAt = new Date().toISOString();
  }

  private patchStatus(
    patch: Partial<Omit<PlayoutRuntimeStatus, "takeStates">>
  ): void {
    this.status = {
      ...this.status,
      ...patch,
      updatedAt: new Date().toISOString()
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
