import type {
  PlayoutItemState,
  PlayoutRuntimeStatus,
  PublishedSceneVersion
} from "@grapix/shared-types";
import type { EngineSupervisor } from "./engineSupervisor.js";
import type { RendererController } from "./rendererClient.js";
import type { PlayoutStore } from "./store.js";

/**
 * Rundown operations, against whichever renderer is available.
 *
 * The standalone engine (protocol v3) is preferred when it is connected, because it
 * is the one that owns output configuration — taking a rundown item online there is
 * what starts the NDI/SDI and virtual outputs. The protocol v2 render daemon stays as
 * the fallback: it is the path that has been in use, and removing it would take away
 * something that works on machines with no engine running.
 *
 * Which one carried the operation is reported in `activeRenderer` rather than left to
 * be inferred.
 */
export class PlayoutRuntime {
  private status: PlayoutRuntimeStatus = {
    rendererConnection: "disconnected",
    previewItemId: null,
    programItemId: null,
    itemStates: {},
    lastError: null,
    activeRenderer: null,
    updatedAt: new Date().toISOString()
  };

  constructor(
    private readonly store: PlayoutStore,
    private readonly renderer: RendererController,
    /** Optional: Playout runs without an engine, on the v2 path. */
    private readonly engine?: EngineSupervisor
  ) {}

  /** True when the standalone engine is connected and should carry operations. */
  private engineAvailable(): boolean {
    return this.engine?.status().connected === true;
  }

  getStatus(): PlayoutRuntimeStatus {
    return structuredClone(this.status);
  }

  async checkConnection(): Promise<PlayoutRuntimeStatus> {
    this.patchStatus({ rendererConnection: "connecting" });
    try {
      await this.renderer.heartbeat();
      this.patchStatus({ rendererConnection: "connected", lastError: null });
    } catch (error) {
      this.patchStatus({
        rendererConnection: "disconnected",
        lastError: errorMessage(error)
      });
    }
    return this.getStatus();
  }

  async cue(rundownId: string, itemId: string): Promise<PlayoutRuntimeStatus> {
    this.setItemState(itemId, "LOADING");
    try {
      const published = await this.resolveItem(rundownId, itemId);

      if (this.engineAvailable()) {
        // Load, prepare, then cue. Preparation is kept separate from cueing so an
        // unprepared scene never reaches Preview looking ready.
        const controller = this.engine!.requireConnected();
        const engineId = this.engine!.id;
        await controller.load(engineId, published.scene);
        await controller.prepare(engineId, published.scene.id);
        await controller.cue(
          engineId,
          published.scene.id,
          published.scene.revision ?? 0,
          "preview"
        );
        this.patchStatus({ activeRenderer: "engine" });
      } else {
        await this.renderer.loadScene(published.scene);
        await this.renderer.setPreview(published.sceneId, published.sceneRevision);
        this.patchStatus({ activeRenderer: "renderer" });
      }
      this.setItemState(itemId, "LOADED");
      const previousPreview = this.status.previewItemId;
      if (previousPreview && previousPreview !== itemId) {
        this.setItemState(previousPreview, "LOADED");
      }
      this.status.previewItemId = itemId;
      this.setItemState(itemId, "IN_PREVIEW");
      this.patchStatus({ rendererConnection: "connected", lastError: null });
      return this.getStatus();
    } catch (error) {
      this.setItemState(itemId, "ERROR");
      this.patchStatus({
        rendererConnection: "error",
        lastError: errorMessage(error)
      });
      throw error;
    }
  }

  async take(rundownId: string, itemId: string): Promise<PlayoutRuntimeStatus> {
    try {
      const published = await this.resolveItem(rundownId, itemId);
      if (this.status.previewItemId !== itemId) {
        await this.cue(rundownId, itemId);
      }
      this.setItemState(itemId, "TAKING_ONLINE");

      if (this.engineAvailable()) {
        // The engine starts every configured output on take, so this is the call that
        // actually puts the graphic out — live via NDI/SDI, or headlessly to a virtual
        // output. A refusal is the engine protecting Program and is reported as one.
        const result = await this.engine!.requireConnected().takeOnline(
          this.engine!.id,
          published.scene.id,
          published.scene.revision ?? 0
        );
        if (!result.accepted) {
          throw new Error(result.refusedReason ?? "the engine refused the take");
        }
        this.patchStatus({ activeRenderer: "engine" });
      } else {
        await this.renderer.take(published.sceneId, published.sceneRevision);
        this.patchStatus({ activeRenderer: "renderer" });
      }
      const previousProgram = this.status.programItemId;
      if (previousProgram && previousProgram !== itemId) {
        this.setItemState(previousProgram, "OFFLINE");
      }
      this.status.programItemId = itemId;
      this.setItemState(itemId, "ONLINE");
      this.patchStatus({ rendererConnection: "connected", lastError: null });
      return this.getStatus();
    } catch (error) {
      this.setItemState(itemId, "ERROR");
      this.patchStatus({
        rendererConnection: "error",
        lastError: errorMessage(error)
      });
      throw error;
    }
  }

  close(): void {
    this.renderer.close();
  }

  private async resolveItem(
    rundownId: string,
    itemId: string
  ): Promise<PublishedSceneVersion> {
    const rundown = await this.store.readRundown(rundownId);
    if (!rundown) {
      throw new Error(`rundown ${rundownId} does not exist`);
    }
    const item = rundown.items.find((candidate) => candidate.itemId === itemId);
    if (!item) {
      throw new Error(`rundown item ${itemId} does not exist`);
    }
    const scene = await this.store.readScene(
      item.sceneId,
      item.versionPolicy === "pinned" ? item.sceneVersion : undefined
    );
    if (!scene) {
      this.setItemState(itemId, "MISSING_ASSET");
      throw new Error(
        `published scene ${item.sceneId} v${item.sceneVersion} is unavailable`
      );
    }
    return scene;
  }

  private setItemState(itemId: string, state: PlayoutItemState): void {
    this.status.itemStates[itemId] = state;
    this.status.updatedAt = new Date().toISOString();
  }

  private patchStatus(
    patch: Partial<Omit<PlayoutRuntimeStatus, "itemStates">>
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
