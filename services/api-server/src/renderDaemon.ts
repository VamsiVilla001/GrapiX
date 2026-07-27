import {
  createRendererCommand,
  isRendererReply,
  type RendererCommandPayload,
  type RendererChannel,
  type RendererExpectedState,
  type RendererOutputConfig,
  type RendererQualityProfile,
  type RendererSuccessReply
} from "@grapix/renderer-protocol";
import type { RendererPatch, SceneDocument } from "@grapix/shared-types";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Minimal client for the GrapiX render daemon (services/render-daemon).
 *
 * The daemon is an OPTIONAL service in this phase: the editor and API server
 * work fully without it. This client connects lazily over a local WebSocket
 * (Node 22's built-in WebSocket, no extra dependency), correlates replies via
 * requestId, and surfaces daemon errors distinctly from connectivity errors
 * so routes can answer 422 vs 503.
 *
 * Protocol v2 reference: services/render-daemon/README.md.
 */

const connectTimeoutMs = 2000;
const requestTimeoutMs = 5000;
const defaultAuthTokenPath = fileURLToPath(new URL("../../../data/render-daemon.token", import.meta.url));

/** Backwards-compatible API route names, now sourced from one wire contract. */
export type RenderDaemonOutputConfig = RendererOutputConfig;
export type RenderDaemonReply = RendererSuccessReply;

/** Error reported by the daemon itself (bad scene, bad config, state error). */
export class RenderDaemonRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "RenderDaemonRequestError";
  }
}

/** The daemon could not be reached (not running, wrong port, handshake timeout). */
export class RenderDaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderDaemonUnavailableError";
  }
}

interface PendingRequest {
  resolve: (reply: RenderDaemonReply) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class RenderDaemonClient {
  private socket: WebSocket | null = null;
  private openPromise: Promise<WebSocket> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private requestCounter = 0;

  constructor(
    private readonly url: string = process.env.GRAPIX_RENDER_DAEMON_URL ?? "ws://127.0.0.1:4200"
  ) {}

  async loadScene(scene: SceneDocument): Promise<RenderDaemonReply> {
    return this.request({ type: "scene.load", scene });
  }

  async warmScene(scene: SceneDocument): Promise<RenderDaemonReply> {
    return this.request({ type: "scene.warm", scene });
  }

  async patchScene(
    patch: RendererPatch,
    currentSceneRevision: string,
    nextSceneRevision: string
  ): Promise<RenderDaemonReply> {
    return this.request(
      { type: "scene.patch", patch, nextSceneRevision },
      "any",
      {
        sceneId: patch.sceneId,
        sceneRevision: currentSceneRevision,
        channel: null
      }
    );
  }

  async setPreview(sceneId: string, sceneRevision: string): Promise<RenderDaemonReply> {
    return this.request(
      { type: "channel.preview.set" },
      "any",
      { sceneId, sceneRevision, channel: "preview" }
    );
  }

  async take(sceneId: string, sceneRevision: string): Promise<RenderDaemonReply> {
    return this.request(
      { type: "channel.take", transition: "cut" },
      "any",
      { sceneId, sceneRevision, channel: "program" }
    );
  }

  async releaseScene(sceneId: string, sceneRevision: string): Promise<RenderDaemonReply> {
    return this.request(
      { type: "scene.release" },
      "any",
      { sceneId, sceneRevision, channel: null }
    );
  }

  async configureOutput(config: RenderDaemonOutputConfig): Promise<RenderDaemonReply> {
    return this.request({ type: "output.configure", ...config }, "any");
  }

  async startOutput(): Promise<RenderDaemonReply> {
    return this.request({ type: "output.start" }, "configured");
  }

  async stopOutput(): Promise<RenderDaemonReply> {
    return this.request({ type: "output.stop" }, "running");
  }

  async getStatus(): Promise<RenderDaemonReply> {
    return this.request({ type: "status" });
  }

  async getCapabilities(): Promise<RenderDaemonReply> {
    return this.request({ type: "capabilities.get" });
  }

  async heartbeat(): Promise<RenderDaemonReply> {
    return this.request({ type: "heartbeat" });
  }

  async setQualityProfile(profile: RendererQualityProfile): Promise<RenderDaemonReply> {
    return this.request({ type: "resource.profile.set", profile });
  }

  close(): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new RenderDaemonUnavailableError("render daemon client closed"));
      this.pending.delete(requestId);
    }

    this.socket?.close();
    this.socket = null;
    this.openPromise = null;
  }

  private async request(
    message: RendererCommandPayload,
    expectedRendererState: RendererExpectedState = "any",
    context: {
      sceneId?: string | null;
      sceneRevision?: string | null;
      channel?: RendererChannel | null;
    } = {}
  ): Promise<RenderDaemonReply> {
    const socket = await this.ensureSocket();
    const sequence = ++this.requestCounter;
    const requestId = `req_${sequence}`;

    return new Promise<RenderDaemonReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new RenderDaemonUnavailableError(`render daemon did not reply within ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify(createRendererCommand(message, {
        requestId,
        sequence,
        expectedRendererState,
        ...context
      })));
    });
  }

  private async ensureSocket(): Promise<WebSocket> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return this.socket;
    }

    if (!this.openPromise) {
      const authenticatedUrl = buildAuthenticatedUrl(this.url);

      this.openPromise = new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(authenticatedUrl);
        const timer = setTimeout(() => {
          socket.close();
          reject(new RenderDaemonUnavailableError(`render daemon not reachable at ${this.url}`));
        }, connectTimeoutMs);

        socket.addEventListener("open", () => {
          clearTimeout(timer);
          this.socket = socket;
          resolve(socket);
        });

        socket.addEventListener("message", (event) => {
          this.handleMessage(typeof event.data === "string" ? event.data : "");
        });

        socket.addEventListener("error", () => {
          clearTimeout(timer);
          reject(new RenderDaemonUnavailableError(`render daemon not reachable at ${this.url}`));
        });

        socket.addEventListener("close", () => {
          this.socket = null;
          this.openPromise = null;

          for (const [requestId, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new RenderDaemonUnavailableError("render daemon connection closed"));
            this.pending.delete(requestId);
          }
        });
      });

      this.openPromise.catch(() => {
        this.openPromise = null;
      });
    }

    return this.openPromise;
  }

  private handleMessage(raw: string): void {
    let parsed: unknown;

    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return;
    }

    if (!isRendererReply(parsed)) {
      return;
    }

    const requestId = parsed.requestId;
    if (!requestId) {
      return;
    }

    const pending = this.pending.get(requestId);
    if (!pending) {
      return;
    }

    this.pending.delete(requestId);
    clearTimeout(pending.timer);

    if (parsed.type === "error") {
      pending.reject(
        new RenderDaemonRequestError(
          parsed.code,
          parsed.message
        )
      );
      return;
    }

    pending.resolve(parsed);
  }
}

function buildAuthenticatedUrl(baseUrl: string): string {
  const token = readAuthToken();
  const url = new URL(baseUrl);

  url.searchParams.set("token", token);

  return url.toString();
}

function readAuthToken(): string {
  const environmentToken = process.env.GRAPIX_RENDER_DAEMON_TOKEN?.trim();
  if (environmentToken) {
    return environmentToken;
  }

  const tokenPath = process.env.GRAPIX_RENDER_DAEMON_TOKEN_FILE ?? defaultAuthTokenPath;

  try {
    const token = readFileSync(tokenPath, "utf8").trim();
    if (token) {
      return token;
    }
  } catch {
    // The daemon creates this file on first startup. The route translates this
    // connectivity failure into its normal optional-service 503 response.
  }

  throw new RenderDaemonUnavailableError(
    "render daemon authentication token is unavailable; start the daemon or set GRAPIX_RENDER_DAEMON_TOKEN"
  );
}
