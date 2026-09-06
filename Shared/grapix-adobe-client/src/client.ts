import {
  AFTER_EFFECTS_TOOLS,
  PHOTOSHOP_TOOLS,
  TOOL_APP,
  type AdobeApp,
  type AdobeTransport,
  type AdobeGatewayStatus,
  type GatewayOutbound,
  type LogMessage
} from "@grapix/adobe-common-schema";

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export interface AdobeClientOptions {
  url?: string;
  token: string;
  /** Reconnect with backoff when the socket drops. Off in tests. */
  autoReconnect?: boolean;
  /** Per-call ceiling. The gateway enforces its own; this one covers a dead gateway. */
  callTimeoutMs?: number;
  /** Injected in Node tests; browsers and Node 22 both provide a global otherwise. */
  webSocketImpl?: typeof WebSocket;
}

export interface CallOptions {
  app?: AdobeApp;
  /**
   * Force a transport. Omitted means "the local plugin if it is running, otherwise
   * Adobe's Photoshop API" — so a machine without Photoshop still works.
   */
  transport?: AdobeTransport;
  onProgress?(progress: number, message?: string): void;
  signal?: AbortSignal;
}

export interface AdobeClientEvents {
  state(state: ConnectionState, detail?: string): void;
  status(status: AdobeGatewayStatus): void;
}

/** `setTimeout` returns a number in browsers and a `Timeout` object in Node. */
export type TimerHandle = ReturnType<typeof setTimeout>;

interface InFlight {
  resolve(value: unknown): void;
  reject(error: Error): void;
  onProgress?(progress: number, message?: string): void;
  timer: TimerHandle;
}

/**
 * A gateway reply that is not a tool result: status, logs, approval, bridge restart.
 * One waiter map serves all four, and each caller narrows on `type` rather than casting.
 */
type ControlReply = Extract<
  GatewayOutbound,
  { type: "status" | "logs" | "session.approval" | "bridge.restarted" }
>;

interface ControlWaiter {
  resolve(reply: ControlReply): void;
  reject(error: Error): void;
  timer: TimerHandle;
}

export class AdobeToolError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AdobeToolError";
  }
}

const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000];

/**
 * The Editor's half of the Adobe bridge.
 *
 * Isomorphic on purpose: the Adobe panel runs it in the WebView and the integration
 * tests run it in Node, so one implementation is what both prove.
 */
export class AdobeClient {
  private socket?: WebSocket;
  private readonly inFlight = new Map<string, InFlight>();
  private readonly controlWaiters = new Map<string, ControlWaiter>();
  private readonly listeners: { [K in keyof AdobeClientEvents]: Set<AdobeClientEvents[K]> } = {
    state: new Set(),
    status: new Set()
  };
  private nextRequestId = 1;
  private reconnectAttempt = 0;
  private reconnectTimer?: TimerHandle;
  private closedByCaller = false;

  state: ConnectionState = "disconnected";
  peerId?: string;
  lastStatus?: AdobeGatewayStatus;

  private readonly url: string;
  private readonly token: string;
  private readonly autoReconnect: boolean;
  private readonly callTimeoutMs: number;
  private readonly WebSocketImpl: typeof WebSocket;

  constructor(options: AdobeClientOptions) {
    this.url = options.url ?? "ws://127.0.0.1:4784";
    this.token = options.token;
    this.autoReconnect = options.autoReconnect ?? true;
    this.callTimeoutMs = options.callTimeoutMs ?? 65_000;
    const ambient = "WebSocket" in globalThis ? globalThis.WebSocket : undefined;
    const impl = options.webSocketImpl ?? ambient;
    if (!impl) throw new Error("no WebSocket implementation available; pass webSocketImpl");
    this.WebSocketImpl = impl;
  }

  on<K extends keyof AdobeClientEvents>(event: K, handler: AdobeClientEvents[K]): () => void {
    this.listeners[event].add(handler);
    return () => {
      this.listeners[event].delete(handler);
    };
  }

  async connect(): Promise<void> {
    if (this.state === "connected" || this.state === "connecting") return;
    this.closedByCaller = false;
    await this.openSocket();
  }

  disconnect(): void {
    this.closedByCaller = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.failAllInFlight(new Error("client disconnected"));
    this.socket?.close(1000, "client disconnect");
    this.socket = undefined;
    this.setState("disconnected");
  }

  /** Which applications the gateway can currently reach, refreshed from the gateway. */
  async discover(): Promise<AdobeGatewayStatus> {
    const reply = await this.control({ type: "status.request" }, "status-");
    if (reply.type !== "status") throw new Error(`expected a status reply, got ${reply.type}`);
    this.lastStatus = reply.status;
    return reply.status;
  }

  /** Recent gateway activity, for the panel's "View logs". */
  async readLogs(limit = 100): Promise<LogMessage[]> {
    const reply = await this.control({ type: "logs.request", limit }, "logs-");
    if (reply.type !== "logs") throw new Error(`expected a logs reply, got ${reply.type}`);
    return reply.entries;
  }

  /**
   * Ask the gateway for this session's permission to modify open Adobe documents.
   * The gateway grants approval only through the operator/bridge path: a regular
   * client cannot approve itself, so this resolves `false` unless an operator has
   * approved the session out of band. Call it from an operator action; a tool result
   * must never trigger it.
   */
  async setApproval(approved: boolean): Promise<boolean> {
    const reply = await this.control({ type: "session.approve", approved }, "approve-");
    if (reply.type !== "session.approval") throw new Error(`expected an approval reply, got ${reply.type}`);
    return reply.approved;
  }

  /** Drop the application's bridge socket so its plugin reconnects. */
  async restartBridge(app: AdobeApp): Promise<boolean> {
    const reply = await this.control({ type: "bridge.restart", app }, "restart-");
    if (reply.type !== "bridge.restarted") throw new Error(`expected a restart reply, got ${reply.type}`);
    return reply.dropped;
  }

  /** Tools this client may call for an application, whether or not its bridge is up. */
  listTools(app: AdobeApp): readonly string[] {
    return app === "photoshop" ? PHOTOSHOP_TOOLS : AFTER_EFFECTS_TOOLS;
  }

  async call<T = unknown>(tool: string, args: Record<string, unknown> = {}, options: CallOptions = {}): Promise<T> {
    if (this.state !== "connected") {
      throw new AdobeToolError("not_connected", "the Adobe gateway is not connected");
    }
    const app = options.app ?? TOOL_APP[tool];
    if (!app) {
      throw new AdobeToolError("unknown_tool", `${tool} is not an Adobe tool this client routes`);
    }

    if (options.signal?.aborted) {
      throw new AdobeToolError("cancelled", `${tool} was cancelled`);
    }

    const requestId = `call-${this.nextRequestId++}`;
    return new Promise<T>((resolve, reject) => {
      let timer: TimerHandle;
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        this.inFlight.delete(requestId);
      };
      const abort = () => {
        cleanup();
        reject(new AdobeToolError("cancelled", `${tool} was cancelled`));
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new AdobeToolError("timeout", `${tool} did not answer within ${this.callTimeoutMs} ms`));
      }, this.callTimeoutMs);
      options.signal?.addEventListener("abort", abort, { once: true });

      this.inFlight.set(requestId, {
        resolve: (value) => {
          cleanup();
          resolve(value as T);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        onProgress: options.onProgress,
        timer
      });

      try {
        this.send({ type: "tool.call", requestId, tool, arguments: args, app, transport: options.transport });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  // ---------------------------------------------------------------- internals

  /** One request/reply round trip for the non-tool gateway operations. */
  private control(payload: Record<string, unknown>, idPrefix: string): Promise<ControlReply> {
    const requestId = `${idPrefix}${this.nextRequestId++}`;
    return new Promise<ControlReply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controlWaiters.delete(requestId);
        reject(new Error(`${payload.type} timed out`));
      }, 10_000);
      this.controlWaiters.set(requestId, { resolve, reject, timer });
      try {
        this.send({ ...payload, requestId });
      } catch (error) {
        clearTimeout(timer);
        this.controlWaiters.delete(requestId);
        reject(error);
      }
    });
  }

  private openSocket(): Promise<void> {
    this.setState("connecting");
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = new this.WebSocketImpl(this.url);
      this.socket = socket;

      socket.addEventListener("open", () => {
        try {
          socket.send(JSON.stringify({ type: "hello", role: "client", token: this.token }));
        } catch (error) {
          if (!settled) {
            settled = true;
            this.setState("error", "the gateway could not be reached");
            reject(error instanceof Error ? error : new Error(String(error)));
          }
          socket.close();
        }
      });

      socket.addEventListener("message", (event: MessageEvent) => {
        let message: GatewayOutbound;
        try {
          message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
        } catch {
          return;
        }

        if (message.type === "hello.ack") {
          this.peerId = message.peerId;
          this.reconnectAttempt = 0;
          this.setState("connected");
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }

        this.handleMessage(message);
      });

      socket.addEventListener("close", (event: CloseEvent) => {
        const wasConnected = this.state === "connected";
        this.socket = undefined;
        this.failAllInFlight(new AdobeToolError("disconnected", "the gateway connection closed"));
        // A close before hello.ack is a rejection: bad token, bad role, wrong port.
        if (!settled) {
          settled = true;
          this.setState("error", event.reason || "connection refused");
          reject(new Error(event.reason || "the gateway refused the connection"));
          return;
        }
        this.setState("disconnected", event.reason || undefined);
        if (wasConnected && this.autoReconnect && !this.closedByCaller) this.scheduleReconnect();
      });

      socket.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        this.setState("error", "the gateway could not be reached");
        reject(new Error("the gateway could not be reached"));
      });
    });
  }

  private handleMessage(message: GatewayOutbound): void {
    switch (message.type) {
      case "status": {
        for (const handler of this.listeners.status) {
          try {
            handler(message.status);
          } catch {
            // Consumer callbacks must not destabilise the gateway connection.
          }
        }
        this.settleControl(message);
        return;
      }
      case "logs":
      case "session.approval":
      case "bridge.restarted": {
        this.settleControl(message);
        return;
      }
      case "tool.progress": {
        // Progress does not settle the call, so the timeout stays armed.
        this.inFlight.get(message.requestId)?.onProgress?.(message.progress, message.message);
        return;
      }
      case "tool.result": {
        const pending = this.inFlight.get(message.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.inFlight.delete(message.requestId);
        pending.resolve(message.result);
        return;
      }
      case "tool.error": {
        const pending = this.inFlight.get(message.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.inFlight.delete(message.requestId);
        pending.reject(new AdobeToolError(message.code, message.message));
        return;
      }
      default:
        return;
    }
  }

  private settleControl(reply: ControlReply): void {
    if (!reply.requestId) return;
    const waiter = this.controlWaiters.get(reply.requestId);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.controlWaiters.delete(reply.requestId);
    waiter.resolve(reply);
  }

  private send(payload: unknown): void {
    if (!this.socket) throw new AdobeToolError("not_connected", "the Adobe gateway is not connected");
    this.socket.send(JSON.stringify(payload));
  }

  private scheduleReconnect(): void {
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.openSocket().catch(() => {
        if (!this.closedByCaller) this.scheduleReconnect();
      });
    }, delay);
  }

  private failAllInFlight(error: Error): void {
    for (const pending of this.inFlight.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.inFlight.clear();
    for (const waiter of this.controlWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.controlWaiters.clear();
  }

  private setState(state: ConnectionState, detail?: string): void {
    if (this.state === state) return;
    this.state = state;
    for (const handler of this.listeners.state) {
      try {
        handler(state, detail);
      } catch {
        // Consumer callbacks must not destabilise the gateway connection.
      }
    }
  }
}
