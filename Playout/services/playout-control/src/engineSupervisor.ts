/**
 * Playout's engine supervisor.
 *
 * Owns the long-lived connection to the standalone render engine and keeps trying
 * to establish it. The connection belongs to Playout rather than to an editing
 * session because Program must keep rendering when the Editor closes — that is the
 * whole point of separating the engine out.
 *
 * This is the only renderer connection. The protocol v2 `NativeRendererClient` that once ran
 * alongside it is gone, and so is the daemon it spoke to, which is why a missing engine is
 * reported and retried rather than worked around: there is nothing to fall back to.
 */

import {
  isEngineReachable,
  normalizeEngineProfile,
  requiresReconnect,
  type EngineCapabilities,
  type EngineProfile,
  type ResyncRequiredEventPayload
} from "@grapix/render-protocol";
import type { SceneDocument } from "@grapix/shared-types";

import { PlayoutOperationError, type DiagnosticsLog } from "./diagnostics.js";
import { PlayoutEngineController, type EngineHealth } from "./engineController.js";

const DEFAULT_ENGINE_HOST = "127.0.0.1";
const DEFAULT_ENGINE_PORT = 4400;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;

export interface EngineSupervisorOptions {
  host?: string;
  port?: number;
  authToken?: string;
  /** Supplies a fresh short-lived service token for every connection/reconnection. */
  authTokenFactory?: () => string | undefined;
  projectId?: string;
  /** Attempt to connect on start. Off in tests. */
  autoConnect?: boolean;
  /** Where engine-link events are reported for the operator console. */
  diagnostics?: DiagnosticsLog;
}

export interface EngineSupervisorStatus {
  configured: boolean;
  profileId: string;
  url: string;
  connected: boolean;
  /** Null until the engine has reported its capabilities. */
  engineId: string | null;
  engineName: string | null;
  state: string;
  takeReady: boolean;
  lastError: string | null;
  reconnectAttempts: number;
  /** Operator-facing hardware summary from capability negotiation. */
  gpu: string | null;
  maxLogicalCanvas: { width: number; height: number } | null;
  maxTextureDimension: number | null;
  tileRendering: boolean | null;
  /** Scenes needing a resync, most recent request first. */
  pendingResyncSceneIds: string[];
}

/**
 * Keeps one engine connected.
 *
 * Reconnects indefinitely with backoff: an engine that comes back after an hour
 * has to be picked up again, not given up on.
 */
export class EngineSupervisor {
  private readonly controller: PlayoutEngineController;
  private profile: EngineProfile;
  private readonly authTokenFactory: (() => string | undefined) | undefined;
  private readonly profileId = "playout-engine";

  private capabilities: EngineCapabilities | null = null;
  private connected = false;
  private connecting = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingResync: string[] = [];
  private lastError: string | null = null;
  private stopped = false;
  private readonly diagnostics: DiagnosticsLog | undefined;

  constructor(options: EngineSupervisorOptions = {}) {
    const host = options.host ?? process.env.GRAPIX_ENGINE_HOST ?? DEFAULT_ENGINE_HOST;
    const port = Number(
      options.port ?? process.env.GRAPIX_ENGINE_PORT ?? DEFAULT_ENGINE_PORT
    );
    // A minted access token for Playout's service account, not a shared secret: the engine
    // verifies it like any other and attributes this link's commands to that account. The
    // supervisor's connection outlives any one operator session - it holds the engine link
    // for monitoring and delivery - so it carries its own identity rather than borrowing
    // whichever operator happened to sign in last.
    const authToken = options.authToken ?? process.env.GRAPIX_ENGINE_TOKEN;
    this.authTokenFactory = options.authTokenFactory;
    this.diagnostics = options.diagnostics;

    this.profile = normalizeEngineProfile({
      profileId: this.profileId,
      label: "Render engine",
      host,
      port,
      // Loopback in development; a remote engine needs its own explicit profile.
      secure: false,
      role: "primary",
      preferred: true,
      ...(authToken ? { authToken } : {}),
      ...(options.projectId ? { projectId: options.projectId } : {})
    });

    this.controller = new PlayoutEngineController({
      clientId: "grapix-playout",
      ...(options.projectId ? { projectId: options.projectId } : {}),
      onResyncRequired: (payload) => this.handleResyncRequired(payload),
      onStateChange: (_profileId, state) => {
        // "Connected" means the link is up and the engine will answer, not that it is
        // idle. An engine that is `preparing` is working normally; treating that as a
        // lost connection made every prepare tear down a healthy socket, and the
        // reconnect then saw `preparing` again — so commands failed with "not
        // connected" while the engine sat there answering.
        this.connected = isEngineReachable(state);

        // The connection does not retry on its own — the supervisor owns that,
        // because only it can re-run hello, authenticate and capabilities. So a
        // drop into a dead state has to schedule the next attempt here.
        if (requiresReconnect(state) && !this.connecting) {
          this.scheduleReconnect();
        }
      }
    });

    this.controller.register(this.profile);

    if (options.autoConnect !== false) {
      void this.connect();
    }
  }

  get engineController(): PlayoutEngineController {
    return this.controller;
  }

  /**
   * Connect, and schedule a retry on failure.
   *
   * Never throws: a missing engine is a normal state for Playout to be in, and it
   * must not stop the control service from starting.
   */
  async connect(): Promise<boolean> {
    if (this.connecting || this.stopped) return this.connected;
    this.connecting = true;

    try {
      const refreshedToken = this.authTokenFactory?.();
      if (refreshedToken) {
        this.profile = normalizeEngineProfile({
          ...this.profile,
          authToken: refreshedToken
        });
        this.controller.register(this.profile);
      }
      this.capabilities = await this.controller.connect(this.profileId);
      this.connected = true;
      this.reconnectAttempts = 0;
      this.lastError = null;
      this.controller.startHealthMonitoring();

      // `connect` leaves the connection in `synchronising` on purpose. Playout owns
      // the reconciliation, and on a fresh connection it holds no scenes, so there
      // is nothing to compare — declare it done rather than leaving the engine
      // reported as perpetually not-take-ready.
      this.controller.markSynchronised(this.profileId);

      // eslint-disable-next-line no-console
      console.log(
        `[playout] engine connected: ${this.capabilities.engineName} (${this.capabilities.engineId}) ` +
          `on ${this.profile.host}:${this.profile.port} — ${this.capabilities.gpu.adapter} ` +
          `[${this.capabilities.gpu.backend}], max logical canvas ` +
          `${this.capabilities.limits.maxLogicalCanvasWidth}x${this.capabilities.limits.maxLogicalCanvasHeight}, ` +
          `tiling ${this.capabilities.features.tileRendering ? "on" : "off"}`
      );
      this.diagnostics?.record({
        level: "info",
        source: "engine",
        message: `Engine connected: ${this.capabilities.engineName} on ${this.profile.host}:${this.profile.port}`,
        detail: {
          code: "engine.connected",
          summary: `Engine connected: ${this.capabilities.engineName} on ${this.profile.host}:${this.profile.port}`,
          context: {
            engineId: this.capabilities.engineId,
            gpu: `${this.capabilities.gpu.adapter} (${this.capabilities.gpu.backend})`,
            maxLogicalCanvas: `${this.capabilities.limits.maxLogicalCanvasWidth}x${this.capabilities.limits.maxLogicalCanvasHeight}`,
            tileRendering: this.capabilities.features.tileRendering
          }
        }
      });
      return true;
    } catch (error) {
      this.connected = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      // Only the first failure of a run is recorded as such; the retries that follow are
      // the same fact repeating, and a console filled by a reconnect loop hides the error
      // that actually needs reading.
      if (this.reconnectAttempts === 0) {
        this.diagnostics?.record({
          level: "warning",
          source: "engine",
          error: new PlayoutOperationError({
            code: "engine.connect-failed",
            summary: `Cannot reach the render engine at ${this.profile.host}:${this.profile.port}`,
            cause: error,
            remedy:
              "Start the engine (`npm run dev:engine`, or `npm run dev:playout` to start everything). Playout keeps retrying with backoff; nothing can be cued or taken until it answers.",
            context: { host: this.profile.host, port: this.profile.port }
          })
        });
      }
      this.scheduleReconnect();
      return false;
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;

    this.reconnectAttempts += 1;
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * Math.pow(2, Math.min(this.reconnectAttempts - 1, 5))
    );

    // Only mention the first few, so a missing engine does not fill the log.
    if (this.reconnectAttempts <= 3) {
      // eslint-disable-next-line no-console
      console.warn(
        `[playout] engine unavailable at ${this.profile.host}:${this.profile.port} ` +
          `(${this.lastError}); retrying in ${delay}ms`
      );
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /**
   * Record that the engine wants a resync.
   *
   * Playout owns the recovery because only it knows which scenes the current
   * rundown depends on.
   */
  private handleResyncRequired(payload: ResyncRequiredEventPayload): void {
    for (const sceneId of payload.sceneIds) {
      if (!this.pendingResync.includes(sceneId)) {
        this.pendingResync.unshift(sceneId);
      }
    }
    this.pendingResync = this.pendingResync.slice(0, 32);

    // eslint-disable-next-line no-console
    console.warn(
      `[playout] engine requested a resync (${payload.reason}) for: ${payload.sceneIds.join(", ")}`
    );
    this.diagnostics?.record({
      level: "warning",
      source: "engine",
      detail: {
        code: "engine.resync-required",
        summary: `The engine can no longer trust its copy of ${payload.sceneIds.length} scene(s) and asked for a resend`,
        cause: `reason: ${payload.reason}`,
        remedy:
          "Cue the affected scene again — that resends it in full. Anything on Program keeps rendering from the engine's own state in the meantime.",
        context: { reason: payload.reason, sceneIds: payload.sceneIds }
      }
    });
  }

  /** Resend a scene in full, clearing its resync flag. */
  async resync(scene: SceneDocument): Promise<void> {
    await this.controller.fullSync(this.profileId, scene, "revision-gap");
    this.pendingResync = this.pendingResync.filter((sceneId) => sceneId !== scene.id);
  }

  status(): EngineSupervisorStatus {
    const health: EngineHealth | undefined = this.controller
      .health()
      .find((entry) => entry.profileId === this.profileId);

    return {
      configured: true,
      profileId: this.profileId,
      url: `ws://${this.profile.host}:${this.profile.port}`,
      connected: this.connected,
      engineId: this.capabilities?.engineId ?? health?.engineId ?? null,
      engineName: this.capabilities?.engineName ?? null,
      state: health?.state ?? "offline",
      takeReady: health?.takeReady ?? false,
      lastError: this.lastError ?? health?.lastError ?? null,
      reconnectAttempts: this.reconnectAttempts,
      gpu: this.capabilities
        ? `${this.capabilities.gpu.adapter} (${this.capabilities.gpu.backend})`
        : null,
      maxLogicalCanvas: this.capabilities
        ? {
            width: this.capabilities.limits.maxLogicalCanvasWidth,
            height: this.capabilities.limits.maxLogicalCanvasHeight
          }
        : null,
      maxTextureDimension: this.capabilities?.limits.maxTextureDimension2d ?? null,
      tileRendering: this.capabilities?.features.tileRendering ?? null,
      pendingResyncSceneIds: [...this.pendingResync]
    };
  }

  engineCapabilities(): EngineCapabilities | null {
    return this.capabilities;
  }

  /** Require a live engine, with a message an operator can act on. */
  requireConnected(): PlayoutEngineController {
    if (!this.connected) {
      throw new PlayoutOperationError({
        code: "engine.not-connected",
        summary: `The render engine at ${this.profile.host}:${this.profile.port} is not connected, so nothing can be cued or taken`,
        ...(this.lastError ? { cause: this.lastError } : {}),
        remedy: "Start it with `npm run dev:engine`, or use `npm run dev:playout` to start the whole Playout stack.",
        context: {
          host: this.profile.host,
          port: this.profile.port,
          reconnectAttempts: this.reconnectAttempts,
          state: this.controller.health().find((entry) => entry.profileId === this.profileId)?.state ?? "offline"
        }
      });
    }
    return this.controller;
  }

  get id(): string {
    return this.profileId;
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.controller.close();
    this.connected = false;
  }
}
