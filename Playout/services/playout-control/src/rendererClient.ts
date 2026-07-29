import {
  createRendererCommand,
  isRendererReply,
  type RendererCommandPayload,
  type RendererChannel,
  type RendererSuccessReply
} from "@grapix/renderer-protocol";
import type { SceneDocument } from "@grapix/shared-types";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const defaultTokenPath = fileURLToPath(
  new URL("../../../../data/render-daemon.token", import.meta.url)
);

interface PendingRequest {
  resolve: (reply: RendererSuccessReply) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RendererController {
  loadScene(scene: SceneDocument): Promise<RendererSuccessReply>;
  setPreview(sceneId: string, revision: string): Promise<RendererSuccessReply>;
  take(sceneId: string, revision: string): Promise<RendererSuccessReply>;
  heartbeat(): Promise<RendererSuccessReply>;
  close(): void;
}

export class NativeRendererClient implements RendererController {
  private socket: WebSocket | null = null;
  private opening: Promise<WebSocket> | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private sequence = 0;

  constructor(
    private readonly url =
      process.env.GRAPIX_RENDER_DAEMON_URL ?? "ws://127.0.0.1:4200",
    private readonly requestTimeoutMs = 5000
  ) {}

  loadScene(scene: SceneDocument): Promise<RendererSuccessReply> {
    return this.request({ type: "scene.load", scene });
  }

  setPreview(sceneId: string, revision: string): Promise<RendererSuccessReply> {
    return this.request(
      { type: "channel.preview.set" },
      { sceneId, sceneRevision: revision, channel: "preview" }
    );
  }

  take(sceneId: string, revision: string): Promise<RendererSuccessReply> {
    return this.request(
      { type: "channel.take", transition: "cut" },
      { sceneId, sceneRevision: revision, channel: "program" }
    );
  }

  heartbeat(): Promise<RendererSuccessReply> {
    return this.request({ type: "heartbeat" });
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.opening = null;
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("renderer client closed"));
      this.pending.delete(requestId);
    }
  }

  private async request(
    payload: RendererCommandPayload,
    context: {
      sceneId?: string | null;
      sceneRevision?: string | null;
      channel?: RendererChannel | null;
    } = {}
  ): Promise<RendererSuccessReply> {
    const socket = await this.ensureSocket();
    const requestId = `playout_${++this.sequence}_${Date.now()}`;
    const command = createRendererCommand(payload, {
      requestId,
      sequence: this.sequence,
      expectedRendererState: "any",
      ...context
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`native renderer request timed out: ${payload.type}`));
      }, this.requestTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      socket.send(JSON.stringify(command));
    });
  }

  private async ensureSocket(): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return this.socket;
    }
    if (this.opening) {
      return this.opening;
    }

    this.opening = new Promise<WebSocket>(async (resolve, reject) => {
      let authenticatedUrl: string;
      try {
        authenticatedUrl = await this.authenticatedUrl();
      } catch (error) {
        reject(error);
        return;
      }
      const socket = new WebSocket(authenticatedUrl);
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error(`native renderer is not reachable at ${this.url}`));
      }, 2500);

      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        this.socket = socket;
        resolve(socket);
      });
      socket.addEventListener("message", (event) => {
        this.handleMessage(typeof event.data === "string" ? event.data : "");
      });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error(`native renderer is not reachable at ${this.url}`));
      });
      socket.addEventListener("close", () => {
        this.socket = null;
        this.opening = null;
        for (const [requestId, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error("native renderer connection closed"));
          this.pending.delete(requestId);
        }
      });
    });
    this.opening.catch(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private handleMessage(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (!isRendererReply(message) || !message.requestId) {
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) {
      return;
    }
    this.pending.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.type === "error") {
      pending.reject(new Error(`${message.code}: ${message.message}`));
    } else {
      pending.resolve(message);
    }
  }

  private async authenticatedUrl(): Promise<string> {
    const url = new URL(this.url);
    const environmentToken = process.env.GRAPIX_RENDER_DAEMON_TOKEN?.trim();
    const token =
      environmentToken ??
      (
        await readFile(
          process.env.GRAPIX_RENDER_DAEMON_TOKEN_FILE ??
            defaultTokenPath,
          "utf8"
        )
      ).trim();
    if (!token) {
      throw new Error("native renderer authentication token is unavailable");
    }
    url.searchParams.set("token", token);
    return url.toString();
  }
}
