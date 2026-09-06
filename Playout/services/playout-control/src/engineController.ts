/**
 * Playout-side render engine controller.
 *
 * Playout's authority is *operations*. It sends Load, Prepare, Cue, Take,
 * Continue, Update, Stop, Clear, Replace, Transition, and Unload — and nothing
 * else. It never edits scene content, and it never touches a renderer object.
 *
 * This wrapper is the enforcement point. There is no method here that mutates a
 * scene, so an accidental edit from playout code cannot be written.
 *
 * Monitoring sits here for the same reason it is safe to: a preview stream renders what a
 * channel already shows and cannot change it.
 *
 * The protocol v2 `NativeRendererClient` this once ran beside has been retired. This is
 * the only renderer path, which is why a missing engine is reported rather than worked
 * around — there is no second renderer to fall back to.
 */

import {
  EngineConnection,
  EngineRegistry,
  engineUrl,
  isEngineOperational,
  normalizeEngineProfile,
  WebSocketEngineTransport,
  type AeContainerLoadPayload,
  type EngineCapabilities,
  type EngineChannel,
  type EngineConnectionEvent,
  type EngineOutputFormat,
  type EngineProfile,
  type EngineRecord,
  type EngineState,
  type EngineStatus,
  type OutputsReplyPayload,
  type PreviewView,
  type ResyncRequiredEventPayload,
  type SceneRef
} from "@grapix/render-protocol";
import type { AssetLibraryItem, SceneDocument } from "@grapix/shared-types";
import { PlayoutOperationError } from "./diagnostics.js";
import { assetContext, readAssetBytes } from "./sceneAssets.js";

/**
 * Reply budget for the scene lifecycle: load, prepare, take.
 *
 * The protocol client defaults to 15 s because it also serves the Editor's UI, where a
 * wedged engine must not wedge the interface. Taking a freshly imported scene is not a
 * UI click: the engine decodes and uploads every texture it needs first - 83 assets and
 * ~49 MB for a real PSD - and a cold Take that legitimately takes 20 s must not be
 * reported as a dead engine.
 */

/**
 * The same scene, with inline asset bytes removed.
 *
 * A scene document is a control message: it names what to draw. The bytes reach the engine through
 * `asset.register` + `asset.upload`, chunked to a size the engine chose, and the engine declares a
 * scene's assets from `assets[].assetId` — it never reads `source`. Leaving a data URL in place
 * therefore sends every image twice and, past the engine's message limit, not at all.
 *
 * The reference that survives is the asset id, which is what both sides already agree on. Playout's
 * own stored copy keeps the bytes, so nothing is lost here: this is only what goes on the wire.
 */
export function withoutInlineAssetBytes(scene: SceneDocument): SceneDocument {
  /** Every inlined source, mapped to the reference that replaces it. */
  const references = new Map<string, string>();

  const assets = scene.assets.map((asset) => {
    if (!asset.source?.startsWith("data:")) return asset;
    const reference = `asset:${asset.assetId}`;
    references.set(asset.source, reference);
    return { ...asset, source: reference };
  });

  if (references.size === 0) return scene;

  // A scene published by an older Editor carries the same bytes on the object too.
  const objects = scene.objects.map((object) => {
    if (object.type !== "image" || !object.src) return object;
    const reference = references.get(object.src);
    return reference ? { ...object, src: reference } : object;
  });

  return { ...scene, assets, objects };
}

function publishedSceneRef(sceneId: string, revision = 0, projectId = "default"): SceneRef {
  return { projectId, domain: "published", sceneId, revision };
}
const SCENE_LIFECYCLE_TIMEOUT_MS = 120_000;

/** What the engine reports when a preview stream starts. */
export interface PreviewStreamAck {
  streamId: string;
  targetFps: number;
  intervalMs: number;
  width: number;
  height: number;
  warnings?: string[];
}

export const PLAYOUT_CLIENT_VERSION = "0.2.0";

export interface EngineControllerOptions {
  clientId?: string;
  projectId?: string;
  /** Injected in tests; defaults to a real WebSocket transport. */
  createTransport?: (profile: EngineProfile) => WebSocketEngineTransport;
  /** Called when the engine says its scene state can no longer be trusted. */
  onResyncRequired?: (payload: ResyncRequiredEventPayload) => void;
  /** Called on any engine state change, for the operator UI. */
  onStateChange?: (profileId: string, state: EngineState) => void;
}

export interface EngineHealth {
  profileId: string;
  label: string;
  url: string;
  engineId: string | null;
  state: EngineState;
  authenticated: boolean;
  /** True when the engine will accept a Take. */
  takeReady: boolean;
  lastLatencyMs: number;
  lastError: string | null;
  failureCount: number;
  /** Seconds since the engine was last heard from. */
  ageSeconds: number;
}

export interface TakeResult {
  accepted: boolean;
  /** Present when the Take was refused, naming why. */
  refusedReason?: string;
  /** True when an operator override was used, for the audit trail. */
  overridden: boolean;
}

/**
 * Persistent engine connection for the Playout runtime.
 *
 * Long-lived by design: Program must keep rendering when the Editor closes, so the
 * connection belongs to Playout rather than to an editing session.
 */
export class PlayoutEngineController {
  private readonly registry = new EngineRegistry();
  /**
   * The profiles as registered.
   *
   * The registry deliberately does not keep `authToken` or `secure` — its records are
   * reported to operator UIs, and a bearer token has no business in one. So `connect` used to
   * rebuild a profile from the record and lost both, which meant Playout could never reach an
   * engine that requires auth: the socket was opened with no `bearer.` subprotocol and the
   * engine rejected the upgrade, reported only as "could not connect".
   */
  private readonly profiles = new Map<string, EngineProfile>();
  private readonly connections = new Map<string, EngineConnection>();
  /**
   * Event subscribers that outlive any single connection.
   *
   * Held here rather than on the `EngineConnection` because that object is replaced on
   * every reconnect (`autoReconnect: false` — the supervisor owns retries).
   */
  private readonly eventListeners = new Set<(event: EngineConnectionEvent) => void>();
  private readonly options: EngineControllerOptions;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: EngineControllerOptions = {}) {
    this.options = options;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  register(profile: EngineProfile): EngineRecord {
    const normalized = normalizeEngineProfile(profile);
    this.profiles.set(normalized.profileId, normalized);
    return this.registry.register(normalized, "profile", Date.now());
  }

  async connect(profileId: string): Promise<EngineCapabilities> {
    const profile = this.profiles.get(profileId);
    if (!profile) {
      throw new Error(`no engine profile ${profileId}`);
    }

    // Close any previous connection for this profile first. Without this a
    // reconnect leaks the old `EngineConnection`, which keeps its own socket and
    // its own retry loop alive — the engine then accumulates phantom clients that
    // never go away.
    this.disconnect(profileId, "reconnecting");

    const transport =
      this.options.createTransport?.(profile)
      ?? new WebSocketEngineTransport({
        url: engineUrl(profile.host, profile.port, { secure: profile.secure }),
        ...(profile.authToken ? { authToken: profile.authToken } : {})
      });

    const connection = new EngineConnection({
      clientId: this.options.clientId ?? "grapix-playout",
      clientName: "GrapiX Playout",
      clientRole: "playout",
      clientVersion: PLAYOUT_CLIENT_VERSION,
      transport,
      ...(this.options.projectId ? { projectId: this.options.projectId } : {}),
      ...(profile.authToken ? { authToken: profile.authToken } : {}),
      // Reconnection is the supervisor's job, not the connection's. Only the
      // supervisor knows how to re-run hello, authenticate and capability
      // negotiation, and two independent retry loops fight each other: the
      // connection reopens a socket the supervisor has already replaced.
      autoReconnect: false
    });

    connection.on((event) => {
      switch (event.type) {
        case "state":
          this.registry.observe(profileId, { state: event.state, atMs: Date.now() });
          this.options.onStateChange?.(profileId, event.state);
          break;
        case "capabilities":
          this.registry.observe(profileId, {
            capabilities: event.capabilities,
            authenticated: true,
            atMs: Date.now()
          });
          break;
        case "latency":
          this.registry.observe(profileId, { lastLatencyMs: event.latencyMs });
          break;
        case "resync-required":
          // The engine's scene state cannot be trusted. Playout owns the recovery,
          // because only it knows which scenes matter to the current rundown.
          this.options.onResyncRequired?.(event.payload);
          break;
        case "closed":
          this.registry.observe(profileId, {
            state: "offline",
            authenticated: false,
            lastError: event.reason,
            atMs: Date.now()
          });
          break;
        case "protocol-error":
          this.registry.observe(profileId, {
            lastError: `${event.code}: ${event.errors.join("; ")}`
          });
          break;
        default:
          break;
      }

      // Fan out to subscribers that outlive this socket. `connect` builds a fresh
      // `EngineConnection` on every reconnect, so a listener attached straight to the
      // connection would silently stop firing the first time the engine restarted.
      // Monitors must not have to know about connection churn.
      for (const listener of this.eventListeners) listener(event);
    });

    this.connections.set(profileId, connection);

    try {
      const capabilities = await connection.connect();
      this.registry.observe(profileId, {
        capabilities,
        authenticated: true,
        state: connection.state,
        atMs: Date.now()
      });
      return capabilities;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.registry.recordFailure(profileId, message, Date.now());
      this.connections.delete(profileId);
      throw error;
    }
  }

  /**
   * Declare scene reconciliation finished.
   *
   * `connect` deliberately leaves the connection in `synchronising`: capabilities
   * are known but scene revisions have not been compared, and only the caller knows
   * which scenes matter. Calling this once the comparison is done — including the
   * trivial case of holding no scenes — is what makes the engine take-ready.
   */
  markSynchronised(profileId: string, reason = "no scenes to reconcile"): void {
    this.connections.get(profileId)?.markReady(reason);
  }

  /**
   * Start heartbeat and timeout monitoring.
   *
   * Application-level rather than socket-level: a TCP connection can stay open
   * while the render thread is wedged, and only an application heartbeat detects
   * that.
   */
  startHealthMonitoring(intervalMs = 2_000): void {
    this.stopHealthMonitoring();
    this.heartbeatTimer = setInterval(() => {
      for (const connection of this.connections.values()) {
        try {
          connection.tick();
        } catch (error) {
          // Defence in depth. `tick` is documented not to throw, but this interval
          // runs in the process that owns Program: an unhandled exception here
          // would take Playout down, which is far worse than a missed heartbeat.
          // eslint-disable-next-line no-console
          console.warn(
            `[playout] engine heartbeat failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }, intervalMs);
    // Never hold the process open for a heartbeat.
    this.heartbeatTimer.unref?.();
  }

  stopHealthMonitoring(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  disconnect(profileId: string, reason = "playout disconnected"): void {
    const connection = this.connections.get(profileId);
    if (!connection) return;
    connection.disconnect(reason);
    this.connections.delete(profileId);
    this.registry.observe(profileId, {
      state: "offline",
      authenticated: false,
      atMs: Date.now()
    });
  }

  close(): void {
    this.stopHealthMonitoring();
    for (const profileId of [...this.connections.keys()]) {
      this.disconnect(profileId, "playout shutting down");
    }
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  health(): EngineHealth[] {
    const now = Date.now();
    return this.registry.all().map((record) => ({
      profileId: record.profileId,
      label: record.label,
      url: record.url,
      engineId: record.engineId,
      state: record.state,
      authenticated: record.authenticated,
      takeReady: isEngineOperational(record.state) && record.authenticated,
      lastLatencyMs: record.lastLatencyMs,
      lastError: record.lastError,
      failureCount: record.failureCount,
      ageSeconds: record.lastSeenMs > 0 ? Math.round((now - record.lastSeenMs) / 1000) : 0
    }));
  }

  /** The engine currently fit to carry Program, if any. */
  programEngine(): EngineHealth | undefined {
    return this.health().find((entry) => entry.takeReady);
  }

  async status(profileId: string): Promise<EngineStatus> {
    const connection = this.requireConnection(profileId);
    const reply = await connection.request("engine.getStatus", {});
    return reply.payload as EngineStatus;
  }

  /**
   * Full diagnostics for the operator panel.
   *
   * `includeTiles` is opt-in because the per-tile table can be thousands of rows
   * on a large stage.
   */
  async diagnostics(profileId: string, includeTiles = false): Promise<unknown> {
    const connection = this.requireConnection(profileId);
    const reply = await connection.request("engine.getDiagnostics", {
      includeTiles
    });
    return reply.payload;
  }

  // -------------------------------------------------------------------------
  // Operational commands — the complete set, and nothing else
  // -------------------------------------------------------------------------

  /**
   * Load a published scene. Playout supplies it; it never authors it.
   *
   * The document that goes over the wire carries no asset bytes. `ensureSceneAssets` has already
   * uploaded them by checksum, in chunks the engine sized itself, and the engine declares a scene's
   * assets from `assets[].assetId` — so an embedded copy is both redundant and fatal: a published
   * scene with eight inlined images was 13 MiB against an 8 MiB message limit, and the engine
   * rejected the frame with `MESSAGE_TOO_LARGE`. An operator saw "connection closed: reconnecting"
   * on Take.
   */
  async load(profileId: string, scene: SceneDocument, stageId?: string): Promise<void> {
    const connection = this.requireConnection(profileId);
    await this.ensureSceneAssets(connection, scene);
    await connection.request(
      "scene.load",
      { scene: withoutInlineAssetBytes(scene), ...(stageId ? { stageId } : {}), prepare: false },
      { sceneRef: publishedSceneRef(scene.id, scene.revision ?? 0), timeoutMs: SCENE_LIFECYCLE_TIMEOUT_MS }
    );
  }

  /**
   * Attach the AE runtime Playout launched to Program.
   *
   * The adapter cannot render until its pipe creates and warms a shared-memory mapping,
   * so it receives the same lifecycle reply budget as a cold scene load.
   */
  async attachAeContainer(profileId: string, payload: AeContainerLoadPayload): Promise<void> {
    const connection = this.requireConnection(profileId);
    await connection.request("ae.container.load", payload, { timeoutMs: SCENE_LIFECYCLE_TIMEOUT_MS });
  }

  /**
   * Register and upload every published asset before scene preparation.
   *
   * The engine deliberately refuses undeclared bytes. Previously Playout skipped
   * this protocol entirely, so a scene containing a project font was guaranteed
   * to fail preparation even though the font was present in the scene library.
   *
   * An asset the scene itself marks `MISSING` is an acknowledged authoring gap, not a
   * surprise: it is skipped so the rest of the scene still reaches air, and the
   * renderer shows its missing-texture state for the objects that used it. An asset
   * claiming `READY` with no checksum is a different thing - a producer wrote a scene
   * that cannot be verified - and that still refuses the load.
   *
   * Takes the whole scene rather than `scene.assets`: every failure here is only
   * actionable if the operator is told which scene was being loaded, and this is the last
   * frame that still knows.
   */
  private async ensureSceneAssets(
    connection: EngineConnection,
    scene: SceneDocument
  ): Promise<void> {
    const sceneContext = {
      sceneId: scene.id,
      sceneName: scene.name,
      sceneRevision: scene.revision ?? 0
    };

    for (const asset of scene.assets) {
      if (!asset.checksum) {
        if (asset.status === "MISSING" || !asset.source) continue;
        throw new PlayoutOperationError({
          code: "asset.checksum-missing",
          summary: `"${asset.name}" in scene "${scene.name}" is marked ready but has no checksum, so the render engine cannot verify it`,
          remedy:
            "Re-import the asset in the Editor (which records a SHA-256) and publish the scene again, or mark the asset missing to air the scene without it.",
          context: { ...sceneContext, ...assetContext(asset) }
        });
      }
      const registered = await connection.request("asset.register", {
        assetId: asset.assetId,
        /*
         * A reference, never the bytes. `transport: "upload"` tells the engine the content arrives
         * through `asset.upload`, so `uri` is provenance only — and an inlined image put its whole
         * base64 payload in this one field, which is the same message-limit failure one step earlier.
         */
        uri: asset.source?.startsWith("data:") ? `asset:${asset.assetId}` : asset.source,
        transport: "upload",
        mimeType: asset.mimeType ?? "application/octet-stream",
        sizeBytes: asset.sizeBytes ?? 0,
        sha256: asset.checksum
      });
      const registration = registered.payload as {
        alreadyCached?: boolean;
        maxChunkBytes?: number;
      };
      if (registration.alreadyCached) continue;

      const bytes = await readAssetBytes(asset, sceneContext);
      const chunkBytes = Math.max(1, registration.maxChunkBytes ?? 256 * 1024);
      const chunkCount = Math.max(1, Math.ceil(bytes.byteLength / chunkBytes));
      for (let chunkIndex = 0; chunkIndex < chunkCount; chunkIndex += 1) {
        const start = chunkIndex * chunkBytes;
        const end = Math.min(bytes.byteLength, start + chunkBytes);
        const chunk = bytes.subarray(start, end);
        await connection.request("asset.upload", {
          assetId: asset.assetId,
          sha256: asset.checksum,
          chunkIndex,
          chunkCount,
          data: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("base64"),
          totalBytes: bytes.byteLength
        });
      }
    }
  }

  async prepare(profileId: string, sceneId: string, viewportIds?: string[]): Promise<void> {
    const connection = this.requireConnection(profileId);
    await connection.request(
      "scene.prepare",
      { sceneId, ...(viewportIds ? { viewportIds } : {}) },
      { sceneRef: publishedSceneRef(sceneId), timeoutMs: SCENE_LIFECYCLE_TIMEOUT_MS }
    );
  }

  async cue(
    profileId: string,
    sceneId: string,
    sceneRevision: number,
    channel: EngineChannel = "preview",
    startFrame?: number
  ): Promise<void> {
    const connection = this.requireConnection(profileId);
    await connection.request(
      "playout.cue",
      { sceneId, sceneRevision, channel, ...(startFrame !== undefined ? { startFrame } : {}) },
      { sceneRef: publishedSceneRef(sceneId, sceneRevision) }
    );
  }

  /**
   * Take a scene to Program.
   *
   * Refuses when the engine is not in a state that permits it, rather than sending
   * a command that will be rejected. `overrideUnprepared` is the explicit operator
   * override required by requirement 14, and the engine records it in its audit log.
   */
  async takeOnline(
    profileId: string,
    sceneId: string,
    sceneRevision: number,
    options: { transitionId?: string; overrideUnprepared?: boolean } = {}
  ): Promise<TakeResult> {
    const record = this.registry.get(profileId);
    if (!record) {
      return {
        accepted: false,
        refusedReason: `no engine profile ${profileId}`,
        overridden: false
      };
    }
    if (!isEngineOperational(record.state)) {
      return {
        accepted: false,
        refusedReason: `engine "${record.label}" is ${record.state}${record.lastError ? ` — ${record.lastError}` : ""}`,
        overridden: false
      };
    }

    const connection = this.requireConnection(profileId);

    try {
      await connection.request(
        "playout.takeOnline",
        {
          sceneId,
          sceneRevision,
          ...(options.transitionId ? { transitionId: options.transitionId } : {}),
          ...(options.overrideUnprepared ? { overrideUnprepared: true } : {})
        },
        { sceneRef: publishedSceneRef(sceneId, sceneRevision), timeoutMs: SCENE_LIFECYCLE_TIMEOUT_MS }
      );
      connection.markOnAir(`took ${sceneId} to program`);
      return { accepted: true, overridden: options.overrideUnprepared === true };
    } catch (error) {
      return {
        accepted: false,
        refusedReason: error instanceof Error ? error.message : String(error),
        overridden: false
      };
    }
  }

  async takeOffline(profileId: string, sceneId: string, transitionId?: string): Promise<void> {
    const connection = this.requireConnection(profileId);
    await connection.request(
      "playout.takeOffline",
      { sceneId, ...(transitionId ? { transitionId } : {}) },
      { sceneRef: publishedSceneRef(sceneId) }
    );
  }

  /** Release a hold at a continue point, or jump to a named marker. */
  async continueScene(
    profileId: string,
    sceneId: string,
    channel: EngineChannel = "program",
    markerName?: string
  ): Promise<void> {
    const connection = this.requireConnection(profileId);
    await connection.request(
      "playout.continue",
      { sceneId, channel, ...(markerName ? { markerName } : {}) },
      { sceneRef: publishedSceneRef(sceneId) }
    );
  }

  /** Data-only update: values for bound fields, no geometry change. */
  async update(
    profileId: string,
    sceneId: string,
    sceneRevision: number,
    data: Record<string, unknown>
  ): Promise<void> {
    const connection = this.requireConnection(profileId);
    await connection.request(
      "playout.update",
      { sceneId, sceneRevision, data },
      { sceneRef: publishedSceneRef(sceneId, sceneRevision) }
    );
  }

  async stop(
    profileId: string,
    sceneId: string,
    channel: EngineChannel = "program"
  ): Promise<void> {
    const connection = this.requireConnection(profileId);
    await connection.request("playout.stop", { sceneId, channel }, { sceneRef: publishedSceneRef(sceneId) });
  }

  async clear(
    profileId: string,
    channel: EngineChannel = "program",
    transitionId?: string
  ): Promise<void> {
    const connection = this.requireConnection(profileId);
    await connection.request("playout.clear", {
      channel,
      ...(transitionId ? { transitionId } : {})
    });
    if (channel === "program") {
      connection.markReady("program cleared");
    }
  }

  async replace(
    profileId: string,
    outgoingSceneId: string,
    incomingSceneId: string,
    incomingSceneRevision: number,
    options: { channel?: EngineChannel; transitionId?: string } = {}
  ): Promise<void> {
    const connection = this.requireConnection(profileId);
    await connection.request("playout.replace", {
      channel: options.channel ?? "program",
      outgoingSceneId,
      incomingSceneId,
      incomingSceneRevision,
      ...(options.transitionId ? { transitionId: options.transitionId } : {})
    });
  }

  /**
   * Run a transition.
   *
   * `durationFrames`, never milliseconds. On a 25 fps timeline 25 frames is exactly
   * one second whether the renderer is keeping up or not, which is what
   * frame-accurate has to mean.
   */
  async transition(
    profileId: string,
    sceneId: string,
    transitionId: string,
    durationFrames: number,
    options: {
      channel?: EngineChannel;
      direction?: "in" | "out" | "reverse";
      interrupt?: boolean;
      scope?:
        | { type: "scene" }
        | { type: "region"; regionId: string }
        | { type: "surface"; surfaceId: string };
    } = {}
  ): Promise<void> {
    const connection = this.requireConnection(profileId);
    await connection.request(
      "playout.transition",
      {
        sceneId,
        channel: options.channel ?? "program",
        transitionId,
        direction: options.direction ?? "in",
        durationFrames,
        ...(options.interrupt ? { interrupt: true } : {}),
        ...(options.scope ? { scope: options.scope } : {})
      },
      { sceneRef: publishedSceneRef(sceneId) }
    );
  }

  /**
   * Unload a scene.
   *
   * Refuses an on-air scene unless forced, because unloading what is on Program
   * puts black on air.
   */
  async unload(profileId: string, sceneId: string, force = false): Promise<void> {
    const connection = this.requireConnection(profileId);
    await connection.request(
      "scene.unload",
      { sceneId, ...(force ? { force: true } : {}) },
      { sceneRef: publishedSceneRef(sceneId) }
    );
  }

  /**
   * Resend a scene in full.
   *
   * The only recovery from a revision gap or a conflict. Never guess: an engine
   * rendering a document nobody else holds is undetectable from the output.
   */
  async fullSync(
    profileId: string,
    scene: SceneDocument,
    reason: "requested" | "revision-gap" | "conflict" | "reconnect" | "initial"
  ): Promise<void> {
    const connection = this.requireConnection(profileId);
    await connection.request(
      "scene.fullSync",
      { scene, reason },
      { sceneRef: publishedSceneRef(scene.id, scene.revision ?? 0) }
    );
  }

  // -------------------------------------------------------------------------
  // Outputs
  // -------------------------------------------------------------------------

  /**
   * Every output instance plus every adapter the engine could instantiate.
   *
   * The adapter list is as important as the instance list: an operator needs to see
   * that NDI exists and why it is unavailable, not merely that it is absent.
   */
  async outputs(profileId: string): Promise<OutputsReplyPayload> {
    const connection = this.requireConnection(profileId);
    const reply = await connection.request("output.list", {});
    return reply.payload as OutputsReplyPayload;
  }

  /**
   * Configure an output.
   *
   * Playout chooses the adapter; the engine decides whether the deployment allows it.
   * A live adapter that has not been certified against hardware comes back with a
   * warning rather than silently pretending to work.
   */
  async configureOutput(
    profileId: string,
    outputId: string,
    adapterId: string,
    format: EngineOutputFormat,
    options?: Record<string, string | number | boolean>
  ): Promise<string[]> {
    const connection = this.requireConnection(profileId);
    const reply = await connection.request("output.configure", {
      outputId,
      adapterId,
      format,
      ...(options ? { options } : {})
    });
    const payload = reply.payload as { warnings?: string[] };
    return payload.warnings ?? [];
  }

  /** Start an output. Returns any warning the engine attached — notably "this is live". */
  async startOutput(profileId: string, outputId: string): Promise<string[]> {
    const connection = this.requireConnection(profileId);
    const reply = await connection.request("output.start", { outputId });
    const payload = reply.payload as { warnings?: string[] };
    return payload.warnings ?? [];
  }

  async stopOutput(profileId: string, outputId: string): Promise<void> {
    const connection = this.requireConnection(profileId);
    await connection.request("output.stop", { outputId });
  }

  /**
   * Remove an output.
   *
   * The engine refuses while a live output is running, because removing it would
   * drop air without saying so. Playout does not second-guess that.
   */
  async removeOutput(profileId: string, outputId: string): Promise<void> {
    const connection = this.requireConnection(profileId);
    await connection.request("output.remove", { outputId });
  }

  // -------------------------------------------------------------------------
  // Monitoring
  // -------------------------------------------------------------------------

  /**
   * Watch a channel as a stream of JPEG frames.
   *
   * This is what turns the operator's Preview and Program panels from a slate into a
   * picture. It is an *observation*, which is why it belongs in a controller whose rule
   * is that nothing here mutates a scene: a preview stream renders what the channel is
   * already showing and cannot change it.
   *
   * `view` selects fill or key. The key is the greyscale matte a downstream keyer cuts —
   * the broadcast way to check transparency, and the reason no alpha-capable codec is
   * involved.
   *
   * The engine bounds the cadence itself and drops a tick it cannot serve rather than
   * queueing, so a monitor can never push Program past its deadline.
   */
  async startPreviewStream(
    profileId: string,
    request: {
      streamId: string;
      channel: EngineChannel;
      view?: PreviewView;
      maxWidth: number;
      maxHeight: number;
      targetFps: number;
      quality?: number;
    }
  ): Promise<PreviewStreamAck> {
    const connection = this.requireConnection(profileId);
    const reply = await connection.request("preview.streamStart", {
      streamId: request.streamId,
      channel: request.channel,
      source: {
        type: "scaled-stage",
        maxWidth: request.maxWidth,
        maxHeight: request.maxHeight
      },
      encoding: "jpeg",
      ...(request.view ? { view: request.view } : {}),
      targetFps: request.targetFps,
      ...(request.quality !== undefined ? { quality: request.quality } : {})
    });
    return reply.payload as PreviewStreamAck;
  }

  /**
   * Stop watching.
   *
   * Tolerant by design: the engine drops every stream belonging to a client when the
   * socket closes, so after a reconnect the stream this is stopping may legitimately no
   * longer exist. Failing here would turn routine teardown into a logged error.
   */
  async stopPreviewStream(profileId: string, streamId: string): Promise<void> {
    try {
      const connection = this.requireConnection(profileId);
      await connection.request("preview.streamStop", { streamId });
    } catch {
      // Already gone. Nothing to release.
    }
  }

  /**
   * Subscribe to engine events across reconnects.
   *
   * Not scoped to a profile or a socket: the subscription is registered on the
   * controller, so it keeps firing after the supervisor replaces the connection. A
   * monitor attaches once at startup, before any engine exists, and still receives
   * frames once one appears.
   */
  onEngineEvent(listener: (event: EngineConnectionEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }


  private requireConnection(profileId: string): EngineConnection {
    const connection = this.connections.get(profileId);
    if (!connection) {
      throw new Error(`engine ${profileId} is not connected`);
    }
    return connection;
  }
}

/** The narrow engine boundary needed by AE attach orchestration. */
export type EngineController = Pick<PlayoutEngineController, "attachAeContainer">;
