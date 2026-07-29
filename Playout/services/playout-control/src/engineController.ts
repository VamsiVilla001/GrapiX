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
 * It runs alongside the existing protocol v2 `NativeRendererClient` rather than
 * replacing it: the v2 path is what Playout uses today and is verified, so the v3
 * engine path is added beside it and switched over deliberately.
 */

import {
  EngineConnection,
  EngineRegistry,
  engineUrl,
  isEngineOperational,
  normalizeEngineProfile,
  WebSocketEngineTransport,
  type EngineCapabilities,
  type EngineChannel,
  type EngineOutputFormat,
  type EngineProfile,
  type EngineRecord,
  type EngineState,
  type EngineStatus,
  type OutputsReplyPayload,
  type ResyncRequiredEventPayload
} from "@grapix/render-protocol";
import type { SceneDocument } from "@grapix/shared-types";

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
  private readonly connections = new Map<string, EngineConnection>();
  private readonly options: EngineControllerOptions;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: EngineControllerOptions = {}) {
    this.options = options;
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  register(profile: EngineProfile): EngineRecord {
    const record = this.registry.register(
      normalizeEngineProfile(profile),
      "profile",
      Date.now()
    );
    return record;
  }

  async connect(profileId: string): Promise<EngineCapabilities> {
    const record = this.registry.get(profileId);
    if (!record) {
      throw new Error(`no engine profile ${profileId}`);
    }

    // Close any previous connection for this profile first. Without this a
    // reconnect leaks the old `EngineConnection`, which keeps its own socket and
    // its own retry loop alive — the engine then accumulates phantom clients that
    // never go away.
    this.disconnect(profileId, "reconnecting");

    const profile = normalizeEngineProfile({
      profileId,
      host: record.host,
      port: record.port,
      label: record.label,
      role: record.role
    });

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

  /** Load a published scene. Playout supplies it; it never authors it. */
  async load(profileId: string, scene: SceneDocument, stageId?: string): Promise<void> {
    const connection = this.requireConnection(profileId);
    await connection.request(
      "scene.load",
      { scene, ...(stageId ? { stageId } : {}), prepare: false },
      { sceneId: scene.id, sceneRevision: scene.revision ?? 0 }
    );
  }

  async prepare(profileId: string, sceneId: string, viewportIds?: string[]): Promise<void> {
    const connection = this.requireConnection(profileId);
    await connection.request(
      "scene.prepare",
      { sceneId, ...(viewportIds ? { viewportIds } : {}) },
      { sceneId }
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
      { sceneId, sceneRevision }
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
        { sceneId, sceneRevision }
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
      { sceneId }
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
      { sceneId }
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
      { sceneId, sceneRevision }
    );
  }

  async stop(
    profileId: string,
    sceneId: string,
    channel: EngineChannel = "program"
  ): Promise<void> {
    const connection = this.requireConnection(profileId);
    await connection.request("playout.stop", { sceneId, channel }, { sceneId });
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
      { sceneId }
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
      { sceneId }
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
      { sceneId: scene.id, sceneRevision: scene.revision ?? 0 }
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

  private requireConnection(profileId: string): EngineConnection {
    const connection = this.connections.get(profileId);
    if (!connection) {
      throw new Error(`engine ${profileId} is not connected`);
    }
    return connection;
  }
}
