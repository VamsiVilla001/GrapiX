import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

import { LogRing } from "./logs.js";
import { BridgeRegistry } from "./registry.js";
import { PhotoshopApiBridge, PHOTOSHOP_CLOUD_TOOLS, type PhotoshopApiClientFactory } from "./photoshopApi.js";
import {
  GATEWAY_PROTOCOL,
  GATEWAY_VERSION,
  MUTATING_TOOLS,
  TOOL_APP,
  type AdobeApp,
  type AdobeTransport,
  type GatewayInbound,
  type PeerRole
} from "@grapix/adobe-common-schema";
import { describeMissingPhotoshopApiConfig, type GatewayConfig } from "./config.js";

interface Peer {
  id: string;
  role: PeerRole;
  socket: WebSocket;
}

interface PendingCall {
  clientId: string;
  clientRequestId: string;
  tool: string;
  app: AdobeApp;
  transport: AdobeTransport;
  timer: NodeJS.Timeout;
}

/** How long a bridge has to answer before the caller gets an explicit timeout error. */
const CALL_TIMEOUT_MS = 60_000;
/** A single frame ceiling: an exported PSD preview is base64, and base64 grows fast. */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;

function tokenMatches(supplied: unknown, expected: string): boolean {
  if (typeof supplied !== "string") return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would itself leak length.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class AdobeGateway {
  private readonly http: Server;
  private readonly wss: WebSocketServer;
  private readonly peers = new Map<string, Peer>();
  private readonly pending = new Map<string, PendingCall>();
  /** Client sessions the operator has approved for document mutation. */
  private readonly approved = new Set<string>();

  readonly registry = new BridgeRegistry();
  readonly logs = new LogRing();

  /** In-process, so it is not a socket peer and never appears in `peers`. */
  private readonly photoshopCloud?: PhotoshopApiBridge;

  constructor(
    private readonly config: GatewayConfig,
    photoshopApiFactory?: PhotoshopApiClientFactory
  ) {
    this.http = createServer((request, response) => this.handleHttp(request, response));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });
    this.http.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));

    if (config.photoshopApi) {
      this.photoshopCloud = new PhotoshopApiBridge(config.photoshopApi, photoshopApiFactory);
      this.registry.register({
        peerId: "photoshop-cloud",
        app: "photoshop",
        transport: "cloud",
        bridgeVersion: GATEWAY_VERSION,
        tools: [...PHOTOSHOP_CLOUD_TOOLS],
        connectedAt: Date.now(),
        // The cloud bridge is called directly, never sent a frame.
        send: () => undefined
      });
      this.registry.setCloudDetail("photoshop", "Adobe Photoshop API configured");
    } else {
      this.registry.setCloudDetail("photoshop", describeMissingPhotoshopApiConfig());
    }
    this.registry.setCloudDetail("after-effects", "After Effects has no cloud API; a local bridge is the only transport.");
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.config.port, this.config.host, () => {
        this.http.off("error", reject);
        resolve();
      });
    });
    const address = this.http.address();
    const port = typeof address === "object" && address ? address.port : this.config.port;
    this.logs.push("info", "gateway", `listening on ws://${this.config.host}:${port}`);
    return port;
  }

  async close(): Promise<void> {
    for (const call of this.pending.values()) clearTimeout(call.timer);
    this.pending.clear();
    for (const peer of this.peers.values()) peer.socket.close(1001, "gateway shutting down");
    this.peers.clear();
    this.wss.close();
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
  }

  /**
   * The operator approving a session is what separates "a model suggested an edit" from
   * "a model rewrote the open document". Approval is per client session and dies with it.
   */
  approveSession(clientId: string): boolean {
    if (!this.peers.has(clientId)) return false;
    this.approved.add(clientId);
    this.logs.push("info", "gateway", `session ${clientId} approved for document mutation`);
    return true;
  }

  revokeSession(clientId: string): void {
    this.approved.delete(clientId);
  }

  get clientCount(): number {
    let count = 0;
    for (const peer of this.peers.values()) if (peer.role === "client") count += 1;
    return count;
  }

  // ---------------------------------------------------------------- HTTP

  private handleHttp(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);

    if (!this.isOriginAllowed(request)) {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "origin not allowed" }));
      return;
    }

    if (url.pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, gatewayVersion: GATEWAY_VERSION, protocol: GATEWAY_PROTOCOL }));
      return;
    }

    // Everything below reports connection state, which names open documents.
    if (!tokenMatches(url.searchParams.get("token"), this.config.token)) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "invalid token" }));
      return;
    }

    if (url.pathname === "/status") {
      const status = this.registry.snapshot(this.config.port, GATEWAY_PROTOCOL, this.clientCount);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(status));
      return;
    }

    if (url.pathname === "/logs") {
      const limit = Number.parseInt(url.searchParams.get("limit") || "100", 10);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ entries: this.logs.recent(Number.isFinite(limit) ? limit : 100) }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  }

  /**
   * Loopback by default. A UXP plugin and the Editor both run on this machine; anything
   * arriving from elsewhere is either a misconfiguration or a browser on the venue network.
   */
  private isOriginAllowed(request: IncomingMessage): boolean {
    if (this.config.allowPublic) return true;
    const origin = request.headers.origin;
    if (!origin) return true; // UXP and ExtendScript sockets send no Origin.
    try {
      const host = new URL(origin).hostname;
      return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- WebSocket

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.isOriginAllowed(request)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => this.acceptSocket(ws));
  }

  private acceptSocket(socket: WebSocket): void {
    // Unauthenticated until hello succeeds; an unidentified socket may send nothing else.
    let peer: Peer | undefined;
    const helloDeadline = setTimeout(() => {
      if (!peer) socket.close(4001, "hello timeout");
    }, 10_000);

    socket.on("message", (raw) => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw.toString());
      } catch {
        this.logs.push("warn", "gateway", "discarded a frame that was not JSON");
        socket.close(4002, "malformed frame");
        return;
      }
      if (!isMessageObject(decoded)) {
        this.logs.push("warn", "gateway", "discarded a frame that was not an object");
        socket.close(4002, "malformed frame");
        return;
      }
      const message = decoded as unknown as GatewayInbound;

      if (!peer) {
        peer = this.completeHello(socket, message);
        if (peer) clearTimeout(helloDeadline);
        return;
      }

      this.routeMessage(peer, message);
    });

    socket.on("close", () => {
      clearTimeout(helloDeadline);
      if (!peer) return;
      this.peers.delete(peer.id);
      this.approved.delete(peer.id);
      if (peer.role === "bridge") {
        const gone = this.registry.unregister(peer.id);
        if (gone) this.logs.push("warn", gone.app, `${gone.transport} bridge disconnected (${peer.id})`);
        this.failPendingForPeer(peer.id, "bridge_disconnected", "the Adobe bridge disconnected");
      } else {
        this.failPendingForClient(peer.id);
      }
    });

    socket.on("error", (error) => {
      this.logs.push("error", "gateway", `socket error: ${error.message}`);
    });
  }

  private completeHello(socket: WebSocket, message: GatewayInbound): Peer | undefined {
    if (message.type !== "hello") {
      socket.close(4003, "expected hello");
      return undefined;
    }
    if (!tokenMatches(message.token, this.config.token)) {
      this.logs.push("warn", "gateway", "rejected a connection with an invalid token");
      socket.close(4004, "invalid token");
      return undefined;
    }
    if (message.role !== "bridge" && message.role !== "client") {
      socket.close(4005, "unknown role");
      return undefined;
    }
    if (message.role === "bridge" && message.app !== "photoshop" && message.app !== "after-effects") {
      socket.close(4006, "a bridge must declare photoshop or after-effects");
      return undefined;
    }

    const peer: Peer = { id: randomUUID(), role: message.role, socket };
    this.peers.set(peer.id, peer);

    if (peer.role === "bridge") {
      const app = message.app as AdobeApp;
      // A socket bridge is always the local plugin: the cloud transport is in-process.
      const displaced = this.registry.register({
        peerId: peer.id,
        app,
        transport: "local",
        appVersion: message.appVersion,
        bridgeVersion: message.bridgeVersion,
        tools: Array.isArray(message.tools) ? message.tools : [],
        connectedAt: Date.now(),
        send: (payload) => socket.send(JSON.stringify(payload))
      });
      if (displaced) {
        this.peers.delete(displaced.peerId);
        displaced.send({ type: "log", level: "warn", source: "gateway", message: "replaced by a newer bridge", timestamp: Date.now() });
        this.logs.push("warn", app, "replaced an existing local bridge for this application");
      }
      this.logs.push("info", app, `local bridge connected (${message.appVersion || "unknown version"})`);
    } else {
      this.logs.push("info", "gateway", `client connected (${peer.id})`);
    }

    socket.send(
      JSON.stringify({
        type: "hello.ack",
        role: peer.role,
        gatewayVersion: GATEWAY_VERSION,
        peerId: peer.id
      })
    );
    this.broadcastStatus();
    return peer;
  }

  private routeMessage(peer: Peer, message: GatewayInbound): void {
    switch (message.type) {
      case "status.request":
        peer.socket.send(
          JSON.stringify({
            type: "status",
            requestId: message.requestId,
            status: this.registry.snapshot(this.config.port, GATEWAY_PROTOCOL, this.clientCount)
          })
        );
        return;

      case "tool.call":
        if (peer.role !== "client") {
          this.sendError(peer, message.requestId, "role_denied", "only a client may call tools");
          return;
        }
        this.dispatchToolCall(peer, message);
        return;

      case "tool.result":
      case "tool.error":
      case "tool.progress":
        if (peer.role !== "bridge") {
          this.logs.push("warn", "gateway", "a client tried to answer a tool call");
          return;
        }
        this.completeToolCall(message);
        return;

      case "logs.request": {
        const limit = Number.isFinite(message.limit) ? Number(message.limit) : 100;
        peer.socket.send(
          JSON.stringify({
            type: "logs",
            requestId: message.requestId,
            entries: this.logs.recent(Math.min(Math.max(limit, 1), 500))
          })
        );
        return;
      }

      case "session.approve": {
        if (peer.role !== "client") return;
        const approved = message.approved === true;
        if (approved) this.approveSession(peer.id);
        else this.revokeSession(peer.id);
        peer.socket.send(
          JSON.stringify({ type: "session.approval", requestId: message.requestId, approved })
        );
        return;
      }

      case "bridge.restart": {
        if (peer.role !== "client") return;
        // Only a local plugin has a socket; the cloud transport has nothing to restart.
        const bridge = this.registry.get(message.app, "local");
        if (bridge) {
          this.peers.get(bridge.peerId)?.socket.close(4100, "restart requested by the operator");
          this.logs.push("info", message.app, "operator asked the bridge to reconnect");
        }
        peer.socket.send(
          JSON.stringify({
            type: "bridge.restarted",
            requestId: message.requestId,
            app: message.app,
            dropped: Boolean(bridge)
          })
        );
        return;
      }

      default:
        this.logs.push("warn", "gateway", "ignored an unknown message type");
    }
  }

  private dispatchToolCall(peer: Peer, message: Extract<GatewayInbound, { type: "tool.call" }>): void {
    const { requestId, tool } = message;
    if (typeof requestId !== "string" || !requestId) {
      this.sendError(peer, "unknown", "invalid_request", "tool.call requires a requestId");
      return;
    }

    const app = message.app ?? TOOL_APP[tool];
    if (!app) {
      this.sendError(peer, requestId, "unknown_tool", `${tool} is not a tool this gateway routes`);
      return;
    }

    if (message.transport === "cloud" && app === "after-effects") {
      this.sendError(
        peer,
        requestId,
        "transport_unavailable",
        "After Effects has no cloud API; only a local bridge can serve it"
      );
      return;
    }

    const bridge = this.registry.resolve(app, message.transport);
    if (!bridge) {
      const wanted = message.transport ? `${app} over the ${message.transport} transport` : app;
      this.sendError(peer, requestId, "bridge_unavailable", `${wanted} is not connected`);
      return;
    }

    if (MUTATING_TOOLS[tool] === true && !this.approved.has(peer.id)) {
      this.sendError(
        peer,
        requestId,
        "approval_required",
        `${tool} modifies the ${app} document and needs operator approval first`
      );
      return;
    }

    if (bridge.transport === "cloud") {
      void this.dispatchCloudCall(peer, requestId, tool, message.arguments ?? {});
      return;
    }

    // The bridge sees a gateway-scoped id: two clients may both call their request "1".
    const bridgeRequestId = randomUUID();
    const timer = setTimeout(() => {
      this.pending.delete(bridgeRequestId);
      this.sendError(peer, requestId, "timeout", `${tool} did not answer within ${CALL_TIMEOUT_MS} ms`);
      this.logs.push("error", app, `${tool} timed out`);
    }, CALL_TIMEOUT_MS);

    this.pending.set(bridgeRequestId, {
      clientId: peer.id,
      clientRequestId: requestId,
      tool,
      app,
      transport: "local",
      timer
    });

    bridge.send({
      type: "tool.call",
      requestId: bridgeRequestId,
      tool,
      arguments: message.arguments ?? {}
    });
    this.logs.push("debug", app, `dispatched ${tool} to the local bridge`);
  }

  /**
   * The cloud transport is an in-process promise, not a socket, so it never enters
   * `pending`: there is no bridge that can vanish mid-call and no id to correlate.
   * The caller may still be gone by the time Adobe answers, which is the only check needed.
   */
  private async dispatchCloudCall(
    peer: Peer,
    requestId: string,
    tool: string,
    args: Record<string, unknown>
  ): Promise<void> {
    if (!this.photoshopCloud) {
      this.sendError(peer, requestId, "bridge_unavailable", describeMissingPhotoshopApiConfig());
      return;
    }

    this.logs.push("debug", "photoshop", `dispatched ${tool} to the Photoshop API`);
    try {
      const result = await this.photoshopCloud.call(tool, args);
      if (!this.peers.has(peer.id)) return;
      peer.socket.send(JSON.stringify({ type: "tool.result", requestId, ok: true, result }));
      this.logs.push("debug", "photoshop", `${tool} completed over the Photoshop API`);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      if (!this.peers.has(peer.id)) return;
      this.sendError(peer, requestId, "cloud_error", detail);
      this.logs.push("error", "photoshop", `${tool} failed over the Photoshop API: ${detail}`);
    }
  }

  private completeToolCall(
    message: Extract<GatewayInbound, { type: "tool.result" | "tool.error" | "tool.progress" }>
  ): void {
    const call = this.pending.get(message.requestId);
    if (!call) return; // Timed out or the client left; nothing to deliver it to.

    const client = this.peers.get(call.clientId);
    if (!client) {
      clearTimeout(call.timer);
      this.pending.delete(message.requestId);
      return;
    }

    if (message.type === "tool.progress") {
      // Progress does not settle the call, so the timeout keeps running.
      const progress = Number.isFinite(message.progress) ? Math.min(1, Math.max(0, message.progress)) : 0;
      client.socket.send(
        JSON.stringify({
          type: "tool.progress",
          requestId: call.clientRequestId,
          progress,
          message: message.message
        })
      );
      return;
    }

    clearTimeout(call.timer);
    this.pending.delete(message.requestId);

    if (message.type === "tool.result") {
      client.socket.send(
        JSON.stringify({ type: "tool.result", requestId: call.clientRequestId, ok: true, result: message.result })
      );
      this.logs.push("debug", call.app, `${call.tool} completed`);
      return;
    }

    client.socket.send(
      JSON.stringify({
        type: "tool.error",
        requestId: call.clientRequestId,
        ok: false,
        code: message.code || "bridge_error",
        message: message.message || "the bridge reported an error"
      })
    );
    this.logs.push("error", call.app, `${call.tool} failed: ${message.message}`);
  }

  private sendError(peer: Peer, requestId: string, code: string, text: string): void {
    peer.socket.send(JSON.stringify({ type: "tool.error", requestId, ok: false, code, message: text }));
  }

  /** A bridge died mid-call: every caller waiting on it is told, rather than left to time out. */
  private failPendingForPeer(bridgePeerId: string, code: string, text: string): void {
    for (const [bridgeRequestId, call] of this.pending) {
      // Only local calls are in `pending`, so only the local bridge can strand one.
      const bridge = this.registry.get(call.app, call.transport);
      if (bridge && bridge.peerId !== bridgePeerId) continue;
      clearTimeout(call.timer);
      this.pending.delete(bridgeRequestId);
      const client = this.peers.get(call.clientId);
      if (client) this.sendError(client, call.clientRequestId, code, text);
    }
    this.broadcastStatus();
  }

  private failPendingForClient(clientId: string): void {
    for (const [bridgeRequestId, call] of this.pending) {
      if (call.clientId !== clientId) continue;
      clearTimeout(call.timer);
      this.pending.delete(bridgeRequestId);
    }
    this.broadcastStatus();
  }

  private broadcastStatus(): void {
    const status = this.registry.snapshot(this.config.port, GATEWAY_PROTOCOL, this.clientCount);
    const frame = JSON.stringify({ type: "status", status });
    for (const peer of this.peers.values()) {
      if (peer.role === "client") peer.socket.send(frame);
    }
  }
}

function isMessageObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
