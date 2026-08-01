import type {
  PlayoutRuntimeStatus,
  PlayoutTakeList,
  PlayoutTakeState,
  PublishedSceneVersion
} from "@grapix/shared-types";
import type { EngineSupervisor } from "./engineSupervisor.js";
import type { PlayoutStore } from "./store.js";

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
        throw new Error(result.refusedReason ?? "the engine refused the take");
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
        throw new Error(`no published scene has take ID ${target.takeId}`);
      }
      return scene;
    }

    const takeList = await this.store.readTakeList(target.takeListId);
    if (!takeList) {
      throw new Error(`take list ${target.takeListId} does not exist`);
    }
    const entry = takeList.entries.find((candidate) => candidate.entryId === target.entryId);
    if (!entry) {
      throw new Error(`take list entry ${target.entryId} does not exist`);
    }
    const scene = await this.store.readScene(
      entry.sceneId,
      entry.versionPolicy === "pinned" ? entry.sceneVersion : undefined
    );
    if (!scene) {
      this.setTakeState(entry.entryId, "MISSING_ASSET");
      throw new Error(
        `published scene ${entry.sceneId} v${entry.sceneVersion} is unavailable`
      );
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
