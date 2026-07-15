import type { SceneDocument } from "@grapix/shared-types";
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
 * Protocol v1 reference: services/render-daemon/README.md.
 */

const protocolVersion = 1;
const connectTimeoutMs = 2000;
const requestTimeoutMs = 5000;
const defaultAuthTokenPath = fileURLToPath(new URL("../../../data/render-daemon.token", import.meta.url));

export interface RenderDaemonOutputConfig {
  width: number;
  height: number;
  frameRateNumerator: number;
  frameRateDenominator: number;
  scanMode?: "p" | "i";
  alphaMode?: "premultiplied" | "straight";
  colorFormat?: "bgra8";
  colorSpace?: "srgb";
  ndiSourceName?: string;
  backend?: "ndi" | "null";
}

export interface RenderDaemonReply {
  type: "ack" | "status";
  [key: string]: unknown;
}

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

  async configureOutput(config: RenderDaemonOutputConfig): Promise<RenderDaemonReply> {
    return this.request({ type: "output.configure", ...config });
  }

  async startOutput(): Promise<RenderDaemonReply> {
    return this.request({ type: "output.start" });
  }

  async stopOutput(): Promise<RenderDaemonReply> {
    return this.request({ type: "output.stop" });
  }

  async getStatus(): Promise<RenderDaemonReply> {
    return this.request({ type: "status" });
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

  private async request(message: Record<string, unknown>): Promise<RenderDaemonReply> {
    const socket = await this.ensureSocket();
    const requestId = `req_${++this.requestCounter}`;

    return new Promise<RenderDaemonReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new RenderDaemonUnavailableError(`render daemon did not reply within ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify({ ...message, protocolVersion, requestId }));
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
    let parsed: Record<string, unknown>;

    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const requestId = typeof parsed.requestId === "string" ? parsed.requestId : undefined;
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
          typeof parsed.code === "string" ? parsed.code : "UNKNOWN",
          typeof parsed.message === "string" ? parsed.message : "render daemon reported an error"
        )
      );
      return;
    }

    pending.resolve(parsed as RenderDaemonReply);
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
