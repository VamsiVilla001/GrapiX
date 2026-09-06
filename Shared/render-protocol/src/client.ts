/**
 * `EngineConnection` — the one client both Editor and Playout use.
 *
 * There is deliberately a single implementation. Two clients would drift, and the
 * moment they drift the Editor and Playout disagree about which engine holds
 * which revision, which is unrecoverable at air time.
 *
 * Everything time-dependent is injected: `now`, `setTimer`, `clearTimer`, and
 * `random`. That is what makes reconnect backoff, heartbeat timeout, and retry
 * behaviour testable without waiting, and therefore actually tested.
 */

import type { EngineCapabilities } from "./capabilities.js";
import type { EngineState } from "./engine-state.js";
import { EngineStateMachine } from "./engine-state.js";
import {
  createEngineMessage,
  decodeEngineMessage,
  encodeEngineMessage,
  ENGINE_PROTOCOL_VERSION,
  isEngineEventType,
  messageRequiresAck,
  type EngineErrorPayload,
  type EngineEventType,
  type EngineMessage,
  type EngineRequestType
} from "./envelope.js";
import type {
  AckPayload,
  EnginePayloadMap,
  HelloReplyPayload,
  ResyncRequiredEventPayload,
  SceneRef
} from "./messages.js";
import {
  DEFAULT_HEARTBEAT,
  DEFAULT_RECONNECT_POLICY,
  DEFAULT_RETRY_POLICY,
  HeartbeatMonitor,
  MessageDeduplicator,
  MessageIdGenerator,
  retryDelayMs,
  SequenceGenerator,
  SequenceTracker,
  shouldRetry,
  type HeartbeatMonitorOptions,
  type RetryPolicy
} from "./reliability.js";

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type EngineTransportKind = "websocket" | "ipc" | "grpc" | "memory";

/**
 * Transport abstraction.
 *
 * WebSocket for remote engines, IPC for local ones, gRPC reserved. The client
 * knows none of the difference, which is what lets an engine move from the same
 * machine to a GPU workstation without touching the Editor.
 */
export interface EngineTransport {
  readonly kind: EngineTransportKind;
  /** Human-readable target, for diagnostics. */
  readonly address: string;
  open(): Promise<void>;
  send(frame: string): void;
  close(reason: string): void;
  onFrame(handler: (frame: string) => void): void;
  /** Optional raw binary side-channel for private native Editor frames. */
  onBinaryFrame?(handler: (frame: Uint8Array) => void): void;
  onClose(handler: (reason: string) => void): void;
  onError(handler: (error: Error) => void): void;
}

export type TimerHandle = unknown;

export interface EngineConnectionOptions {
  clientId: string;
  clientName: string;
  clientRole: "editor" | "playout" | "automation" | "diagnostic";
  clientVersion: string;
  transport: EngineTransport;
  projectId?: string;
  /** Bearer token. Required by any engine not on loopback. */
  authToken?: string;
  retryPolicy?: RetryPolicy;
  reconnectPolicy?: RetryPolicy;
  heartbeat?: HeartbeatMonitorOptions;
  maxMessageBytes?: number;
  /** Automatically reconnect when the transport closes unexpectedly. */
  autoReconnect?: boolean;

  // Injected environment, so behaviour is deterministic under test.
  now?: () => number;
  setTimer?: (handler: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  random?: () => number;
}

export interface PendingRequest {
  requestId: string;
  type: EngineRequestType;
  messageId: string;
  sceneRef: SceneRef | null;
  sentAtMs: number;
  attempts: number;
  requiresAck: boolean;
}

export type EngineConnectionEvent =
  | { type: "state"; state: EngineState; previous: EngineState; reason: string }
  | { type: "hello"; payload: HelloReplyPayload }
  | { type: "capabilities"; capabilities: EngineCapabilities }
  | { type: "message"; message: EngineMessage<unknown> }
  | { type: "binary-frame"; data: Uint8Array }
  | { type: "engine-event"; eventType: EngineEventType; message: EngineMessage<unknown> }
  | { type: "resync-required"; payload: ResyncRequiredEventPayload }
  | { type: "protocol-error"; code: string; errors: string[] }
  | { type: "closed"; reason: string }
  | { type: "latency"; latencyMs: number };

export type EngineConnectionListener = (event: EngineConnectionEvent) => void;

export interface RequestOptions {
  sceneRef?: SceneRef | null;
  /** Override the per-type default. */
  requiresAck?: boolean;
  /** Wait for a correlated reply rather than fire-and-forget. */
  awaitReply?: boolean;
  timeoutMs?: number;
}

export interface EngineConnectionStats {
  state: EngineState;
  engineId: string | null;
  address: string;
  transport: EngineTransportKind;
  messagesSent: number;
  messagesReceived: number;
  duplicatesDropped: number;
  sequenceGaps: number;
  pendingRequests: number;
  reconnectAttempts: number;
  lastLatencyMs: number;
  averageLatencyMs: number;
  authenticated: boolean;
}

const REPLY_TIMEOUT_MS = 15_000;

/** How many times a `RATE_LIMITED` refusal is waited out before it reaches the caller. */
const RATE_LIMIT_ATTEMPTS = 5;

/**
 * Milliseconds the engine asked us to wait, or `null` when this is not a rate limit.
 *
 * The engine answers `RATE_LIMITED: rate limit exceeded; retry in <n>ms`, which is
 * `ErrorCode::RateLimited` plus `limiter.retry_after_ms` from
 * `services/render-engine/src/transport.rs`.
 */
function rateLimitRetryAfterMs(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.startsWith("RATE_LIMITED")) return null;
  const stated = /retry in (\d+)ms/.exec(message);
  return Math.min(2_000, Math.max(1, Number(stated?.[1] ?? 50)));
}

export class EngineConnection {
  private readonly options: EngineConnectionOptions;
  private readonly transport: EngineTransport;
  private readonly stateMachine = new EngineStateMachine("offline");
  private readonly outboundSequence = new SequenceGenerator();
  private readonly inboundSequence = new SequenceTracker();
  private readonly deduplicator = new MessageDeduplicator();
  private readonly messageIds: MessageIdGenerator;
  private readonly heartbeat: HeartbeatMonitor;
  private readonly listeners = new Set<EngineConnectionListener>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly replyWaiters = new Map<
    string,
    { resolve: (message: EngineMessage<unknown>) => void; reject: (error: Error) => void; timer: TimerHandle }
  >();

  private readonly now: () => number;
  private readonly setTimer: (handler: () => void, delayMs: number) => TimerHandle;
  private readonly clearTimer: (handle: TimerHandle) => void;
  private readonly random: () => number;

  private engineId: string | null = null;
  private capabilities: EngineCapabilities | null = null;
  private authenticated = false;
  private requestCounter = 0;
  private messagesSent = 0;
  private messagesReceived = 0;
  private duplicatesDropped = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: TimerHandle | undefined;
  private closingIntentionally = false;

  constructor(options: EngineConnectionOptions) {
    this.options = options;
    this.transport = options.transport;
    this.now = options.now ?? (() => Date.now());
    this.setTimer =
      options.setTimer
      ?? ((handler, delayMs) => setTimeout(handler, delayMs) as unknown as TimerHandle);
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.random = options.random ?? Math.random;

    this.messageIds = new MessageIdGenerator(options.clientId);
    this.heartbeat = new HeartbeatMonitor(options.heartbeat ?? DEFAULT_HEARTBEAT, this.now());

    this.transport.onFrame((frame) => this.handleFrame(frame));
    this.transport.onBinaryFrame?.((frame) => this.emit({ type: "binary-frame", data: frame }));
    this.transport.onClose((reason) => this.handleClose(reason));
    this.transport.onError((error) => this.handleError(error));
  }

  get state(): EngineState {
    return this.stateMachine.state;
  }

  get engineCapabilities(): EngineCapabilities | null {
    return this.capabilities;
  }

  get isAuthenticated(): boolean {
    return this.authenticated;
  }

  on(listener: EngineConnectionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  stats(): EngineConnectionStats {
    return {
      state: this.stateMachine.state,
      engineId: this.engineId,
      address: this.transport.address,
      transport: this.transport.kind,
      messagesSent: this.messagesSent,
      messagesReceived: this.messagesReceived,
      duplicatesDropped: this.duplicatesDropped,
      sequenceGaps: this.inboundSequence.gaps,
      pendingRequests: this.pending.size,
      reconnectAttempts: this.reconnectAttempts,
      lastLatencyMs: this.heartbeat.lastLatencyMs,
      averageLatencyMs: this.heartbeat.averageLatencyMs,
      authenticated: this.authenticated
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Open the transport, say hello, authenticate if asked, and fetch capabilities.
   *
   * Leaves the connection in `synchronising`: capabilities are known but scene
   * revisions have not been reconciled yet. The caller decides what to sync,
   * because only it knows which scenes it cares about.
   */
  async connect(): Promise<EngineCapabilities> {
    this.closingIntentionally = false;
    this.transition("connecting", `opening ${this.transport.kind} transport`);

    try {
      await this.transport.open();
    } catch (error) {
      this.transition("error", error instanceof Error ? error.message : "transport open failed");
      this.scheduleReconnect();
      throw error;
    }

    try {
      const hello = await this.request("connection.hello", {
      clientId: this.options.clientId,
      clientName: this.options.clientName,
      clientRole: this.options.clientRole,
      clientVersion: this.options.clientVersion,
      supportedProtocolVersions: [ENGINE_PROTOCOL_VERSION],
      ...(this.options.projectId ? { projectId: this.options.projectId } : {})
    });

    const helloPayload = hello.payload as HelloReplyPayload;
    this.engineId = helloPayload.engineId;
    this.emit({ type: "hello", payload: helloPayload });

    // `authenticationRequired` says this engine grants operator authority only to a bearer.
    // It does not say *this* connection lacks authority: a local IPC session is already an
    // Editor session, and demanding a token there would refuse the very transport the Editor
    // is designed to use ("an engine can serve a local Editor without ever opening a port").
    // So authenticate when a credential is available, and fail early only when the authority
    // actually granted cannot serve the role this client declared.
    const granted = helloPayload.connectionRole;
    if (helloPayload.authenticationRequired && this.options.authToken) {
      this.transition("authenticating", "engine requires authentication");
      await this.request("connection.authenticate", {
        token: this.options.authToken,
        ...(this.options.projectId ? { projectId: this.options.projectId } : {})
      });
    } else if (this.options.clientRole === "playout" && granted !== undefined && granted !== "playout") {
      const reason =
        `this connection was granted ${granted} authority, which cannot drive operator verbs; ` +
        "supply the engine bearer token";
      this.transition("error", reason);
      throw new Error(reason);
    }
    this.authenticated = true;

    const capabilitiesReply = await this.request("engine.getCapabilities", {});
    this.capabilities = capabilitiesReply.payload as EngineCapabilities;
    this.emit({ type: "capabilities", capabilities: this.capabilities });

    this.transition("synchronising", "connected; reconciling scene state");
    this.heartbeat.reset(this.now());
    this.reconnectAttempts = 0;

      return this.capabilities;
    } catch (error) {
      // Opening the socket is only half of connecting. A refused role, failed
      // authentication, bad Hello, or capability timeout must close the transport as well.
      // Leaving it established consumes one of the engine's bounded client slots; repeated
      // retries used to fill all eight slots and make every later handshake hang.
      const reason = error instanceof Error ? error.message : "connection setup failed";
      this.closingIntentionally = true;
      this.transport.close(`connection setup failed: ${reason}`);
      this.closingIntentionally = false;
      this.failAllWaiters(error instanceof Error ? error : new Error(reason));
      this.authenticated = false;
      this.stateMachine.force("error", reason, this.now());
      this.emit({ type: "state", state: "error", previous: "connecting", reason });
      this.scheduleReconnect();
      throw error;
    }
  }

  /** Close deliberately. Does not reconnect. */
  disconnect(reason = "client requested disconnect"): void {
    this.closingIntentionally = true;
    this.cancelReconnect();

    if (this.stateMachine.state !== "offline") {
      try {
        this.send("connection.disconnect", { reason, reconnecting: false });
      } catch {
        // Best effort: the socket may already be gone, which is fine.
      }
    }

    this.transport.close(reason);
    this.failAllWaiters(new Error(`connection closed: ${reason}`));
    this.stateMachine.force("offline", reason, this.now());
    this.authenticated = false;
  }

  /** Report that the engine is now rendering Program. */
  markOnAir(reason = "program take"): void {
    this.transition("on-air", reason);
  }

  /** Report that Program has been cleared. */
  markReady(reason = "program cleared"): void {
    this.transition("ready", reason);
  }

  markPreparing(reason = "preparing scene resources"): void {
    this.transition("preparing", reason);
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /**
   * Refuse a frame the engine has told us it will not accept.
   *
   * The engine enforces `limits.maxMessageBytes` before it parses, so an oversized frame is rejected
   * with no request id to correlate — the caller's request never gets an answer and dies on its
   * timeout. A 13 MiB scene against an 8 MiB limit reached an operator as "connection closed:
   * reconnecting" a minute after Take, which names neither the cause nor the remedy.
   *
   * Failing here costs one comparison and produces the two numbers that explain it.
   */
  private assertSendable(type: EngineRequestType, frame: string): void {
    const limit = this.capabilities?.limits.maxMessageBytes ?? this.options.maxMessageBytes;
    if (!limit) return;

    // The wire is UTF-8, and the engine counts bytes: a scene full of base64 is one byte per
    // character, a scene full of typography is not.
    const bytes = utf8Length(frame);
    if (bytes <= limit) return;

    throw new Error(
      `${type} is ${bytes} bytes; this engine accepts at most ${limit}. `
        + "Asset bytes belong in asset.upload, which the engine chunks; a scene document carries references."
    );
  }

  /** Fire-and-forget send. Returns the message that went out. */
  send<T extends EngineRequestType>(
    type: T,
    payload: EnginePayloadMap[T],
    options: RequestOptions = {}
  ): EngineMessage<EnginePayloadMap[T]> {
    const requiresAck = options.requiresAck ?? messageRequiresAck(type);
    const requestId = this.nextRequestId();

    const message = createEngineMessage(type, payload, {
      messageId: this.messageIds.next(),
      sequence: this.outboundSequence.next(),
      timestampMs: this.now(),
      direction: "client-to-engine",
      requestId,
      engineId: this.engineId,
      sceneRef: options.sceneRef ?? null,
      requiresAck
    });

    const frame = encodeEngineMessage(message);
    try {
      this.assertSendable(type, frame);
    } catch (error) {
      // Nothing went out, so this sequence number must not be spent: the engine parks a message that
      // arrives with a gap ahead of it, and the next real frame would sit in that hole unanswered.
      this.outboundSequence.release(message.sequence);
      throw error;
    }
    this.transport.send(frame);
    this.messagesSent += 1;

    if (requiresAck) {
      this.pending.set(requestId, {
        requestId,
        type,
        messageId: message.messageId,
        sceneRef: message.sceneRef,
        sentAtMs: message.timestampMs,
        attempts: 1,
        requiresAck
      });
    }

    return message;
  }

  /**
   * Send and await the correlated reply.
   *
   * Rejects on `reply.error` so callers get an exception rather than having to
   * inspect every reply. Times out rather than hanging: a wedged engine must not
   * wedge the Editor's UI.
   *
   * `RATE_LIMITED` is the one refusal handled here. The engine's token bucket is shared
   * by every request on the connection, so a burst - registering and uploading the
   * assets of a freshly imported scene - throttles the very next request by a few
   * milliseconds, and turning that into an operator-visible Take failure invents an
   * outage out of backpressure.
   *
   * The **same frame** is retransmitted, sequence and message id included. The limiter
   * runs before the sequence tracker in `services/render-engine/src/transport.rs`, so a
   * throttled frame is never consumed: sending a fresh one instead leaves a hole in the
   * inbound sequence, which the engine answers with a resync demand and, after enough
   * of them, a dropped connection.
   */
  async request<T extends EngineRequestType>(
    type: T,
    payload: EnginePayloadMap[T],
    options: RequestOptions = {}
  ): Promise<EngineMessage<unknown>> {
    const message = this.send(type, payload, options);

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.awaitReply(message, type, options);
      } catch (error) {
        const retryAfterMs = rateLimitRetryAfterMs(error);
        if (retryAfterMs === null || attempt >= RATE_LIMIT_ATTEMPTS) throw error;
        await new Promise((resolve) => this.setTimer(() => resolve(undefined), retryAfterMs + 5));
        this.transport.send(encodeEngineMessage(message));
        this.messagesSent += 1;
      }
    }
  }

  private awaitReply(
    message: EngineMessage<unknown>,
    type: EngineRequestType,
    options: RequestOptions
  ): Promise<EngineMessage<unknown>> {
    const timeoutMs = options.timeoutMs ?? REPLY_TIMEOUT_MS;

    return new Promise<EngineMessage<unknown>>((resolve, reject) => {
      const requestId = message.requestId as string;
      const timer = this.setTimer(() => {
        this.replyWaiters.delete(requestId);
        this.pending.delete(requestId);
        reject(new Error(`engine did not reply to ${type} within ${timeoutMs}ms`));
      }, timeoutMs);

      this.replyWaiters.set(requestId, { resolve, reject, timer });
    });
  }

  /**
   * Retransmit an unacknowledged message.
   *
   * The `messageId` is reused deliberately: that is what lets the engine's
   * deduplicator recognise the retransmit and acknowledge without re-applying.
   */
  retryPending(requestId: string, payload: unknown, type: EngineRequestType): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;

    const policy = this.options.retryPolicy ?? DEFAULT_RETRY_POLICY;
    if (!shouldRetry(policy, entry.attempts)) {
      this.pending.delete(requestId);
      return false;
    }

    const message = createEngineMessage(type, payload, {
      messageId: entry.messageId, // same id: the engine will dedupe it
      sequence: this.outboundSequence.next(),
      timestampMs: this.now(),
      direction: "client-to-engine",
      requestId,
      engineId: this.engineId,
      sceneRef: entry.sceneRef,
      requiresAck: true
    });

    this.transport.send(encodeEngineMessage(message));
    this.messagesSent += 1;
    entry.attempts += 1;
    return true;
  }

  /** Delay before the given retry attempt, per the configured policy. */
  retryDelay(attempt: number): number {
    return retryDelayMs(this.options.retryPolicy ?? DEFAULT_RETRY_POLICY, attempt, this.random);
  }

  /**
   * Send a heartbeat if one is due. Call from the host's tick.
   *
   * Never throws. A heartbeat runs from an interval, so an exception here would be
   * an unhandled rejection in the host process — and the host of the Playout
   * connection is the process that owns Program. A failed send means the transport
   * has gone, which is a state change, not a crash.
   */
  tick(): void {
    const nowMs = this.now();

    if (this.heartbeat.isTimedOut(nowMs)) {
      const missed = this.heartbeat.recordMissed();
      this.transition("error", `engine unreachable; ${missed} heartbeat timeout(s)`);
      this.scheduleReconnect();
      return;
    }

    if (this.heartbeat.shouldSend(nowMs) && this.stateMachine.state !== "offline") {
      this.heartbeat.recordSent(nowMs);
      try {
        this.send("connection.heartbeat", { sentAtMs: nowMs }, { requiresAck: false });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.stateMachine.force("error", `heartbeat could not be sent: ${reason}`, nowMs);
        this.emit({ type: "state", state: "error", previous: "ready", reason });
        this.failAllWaiters(new Error(`connection lost: ${reason}`));
        this.scheduleReconnect();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Receiving
  // -------------------------------------------------------------------------

  private handleFrame(frame: string): void {
    const decoded = decodeEngineMessage(frame, { maxBytes: this.options.maxMessageBytes });

    if (!decoded.ok) {
      this.emit({ type: "protocol-error", code: decoded.code, errors: decoded.errors });
      return;
    }

    const message = decoded.message;
    const nowMs = this.now();
    this.messagesReceived += 1;

    // Any frame at all proves the engine is answering, so the liveness timeout is
    // reset here rather than only on a heartbeat reply. Without this the monitor
    // times out a perfectly healthy connection after `timeoutMs` and reconnects
    // forever, which looks like an unstable engine and is not.
    this.heartbeat.noteActivity(nowMs);

    // Duplicate suppression before anything else: a retransmitted preview frame
    // must not be counted twice, and a retransmitted resync must not re-trigger.
    if (this.deduplicator.check(message.messageId, nowMs)) {
      this.duplicatesDropped += 1;
      return;
    }

    // Ordered delivery. A gap means the stream cannot be trusted.
    const { verdict, released } = this.inboundSequence.offer(message.sequence, message);
    if (verdict === "duplicate") {
      this.duplicatesDropped += 1;
      return;
    }
    if (verdict === "gap") {
      this.emit({
        type: "protocol-error",
        code: "SEQUENCE_GAP",
        errors: [`inbound sequence gap at ${message.sequence}; expected ${this.inboundSequence.expected}`]
      });
      this.transition("synchronising", "inbound sequence gap; resynchronising");
      return;
    }
    if (verdict === "future") {
      return; // parked; will be released when the gap closes
    }

    for (const parked of released) {
      this.dispatch(parked as EngineMessage<unknown>, nowMs);
    }
  }

  private dispatch(message: EngineMessage<unknown>, nowMs: number): void {
    this.emit({ type: "message", message });

    if (message.engineId && !this.engineId) {
      this.engineId = message.engineId;
    }

    switch (message.type) {
      case "reply.error": {
        const payload = message.payload as EngineErrorPayload;
        if (message.requestId) this.pending.delete(message.requestId);
        this.settle(message.requestId, new Error(`${payload.code}: ${payload.message}`));
        if (payload.requiresFullSync) {
          this.transition("synchronising", `engine requested resync: ${payload.message}`);
        }
        return;
      }

      case "reply.ack": {
        const payload = message.payload as AckPayload;

        // A heartbeat acknowledgement is the one message whose round trip is a
        // meaningful latency measurement: the engine does nothing but echo the clock.
        if (payload.requestType === "connection.heartbeat") {
          const latencyMs = this.heartbeat.recordReceived(nowMs, payload.sentAtMs ?? nowMs);
          this.emit({ type: "latency", latencyMs });
        }

        if (message.requestId) this.pending.delete(message.requestId);
        this.settle(message.requestId, undefined, message);
        return;
      }

      default:
        break;
    }

    // Every other `reply.*` settles its waiter.
    //
    // Matched by prefix rather than by an enumerated list on purpose: the list was
    // missing `reply.outputs`, so every `output.list` request hung until it timed out
    // even though the engine had answered immediately. A reply type added on the
    // engine side must not be able to strand a caller because a switch case was
    // forgotten here.
    if (message.type.startsWith("reply.")) {
      if (message.requestId) this.pending.delete(message.requestId);
      this.settle(message.requestId, undefined, message);
      return;
    }

    switch (message.type) {
      case "event.resyncRequired": {
        const payload = message.payload as ResyncRequiredEventPayload;
        this.emit({ type: "resync-required", payload });
        this.transition("synchronising", `engine requested resync: ${payload.reason}`);
        return;
      }

      case "event.engineState": {
        const payload = message.payload as { state: EngineState; reason: string };
        // The engine is authoritative about itself, so force rather than guard.
        const change = this.stateMachine.force(payload.state, payload.reason, nowMs);
        this.emit({
          type: "state",
          state: change.to,
          previous: change.from,
          reason: change.reason
        });
        return;
      }

      case "event.deviceLost":
        this.transition("recovering", "engine reported device loss");
        this.emit({ type: "engine-event", eventType: "event.deviceLost", message });
        return;

      default:
        break;
    }

    // Heartbeat replies arrive as acks or events depending on the engine; either
    // way the round trip is what matters.
    if (message.type === "event.warning" || isEngineEventType(message.type)) {
      this.emit({
        type: "engine-event",
        eventType: message.type as EngineEventType,
        message
      });
    }
  }

  private settle(
    requestId: string | null,
    error?: Error,
    message?: EngineMessage<unknown>
  ): void {
    if (!requestId) return;
    const waiter = this.replyWaiters.get(requestId);
    if (!waiter) return;

    this.replyWaiters.delete(requestId);
    this.clearTimer(waiter.timer);

    if (error) {
      waiter.reject(error);
      return;
    }
    if (message) {
      waiter.resolve(message);
    }
  }

  private failAllWaiters(error: Error): void {
    for (const [requestId, waiter] of this.replyWaiters) {
      this.clearTimer(waiter.timer);
      waiter.reject(error);
      this.replyWaiters.delete(requestId);
    }
    this.pending.clear();
  }

  // -------------------------------------------------------------------------
  // Failure handling
  // -------------------------------------------------------------------------

  private handleClose(reason: string): void {
    this.authenticated = false;
    this.failAllWaiters(new Error(`connection closed: ${reason}`));
    this.emit({ type: "closed", reason });

    if (this.closingIntentionally) {
      this.stateMachine.force("offline", reason, this.now());
      return;
    }

    this.stateMachine.force("error", `transport closed: ${reason}`, this.now());
    this.emit({ type: "state", state: "error", previous: "on-air", reason });
    this.scheduleReconnect();
  }

  private handleError(error: Error): void {
    this.transition("warning", `transport error: ${error.message}`);
  }

  /**
   * Reconnect with exponential backoff and jitter.
   *
   * The sequence trackers reset because the peer restarts its numbering, and the
   * caller is pushed to `synchronising` rather than `ready` — after a reconnect,
   * revisions cannot be trusted until they have been compared.
   */
  private scheduleReconnect(): void {
    if (this.options.autoReconnect === false || this.closingIntentionally) return;
    if (this.reconnectTimer !== undefined) return;

    const policy = this.options.reconnectPolicy ?? DEFAULT_RECONNECT_POLICY;
    this.reconnectAttempts += 1;

    if (!shouldRetry(policy, this.reconnectAttempts)) {
      this.stateMachine.force("offline", "reconnect attempts exhausted", this.now());
      return;
    }

    const delay = retryDelayMs(policy, this.reconnectAttempts, this.random);
    this.transition("recovering", `reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = undefined;
      this.outboundSequence.reset();
      this.inboundSequence.reset();
      this.deduplicator.clear();
      void this.connect().catch(() => {
        // connect() already transitioned to error and rescheduled.
      });
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer === undefined) return;
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private transition(to: EngineState, reason: string): void {
    const change = this.stateMachine.transition(to, reason, this.now());
    if (change.rejected) return;
    this.emit({ type: "state", state: change.to, previous: change.from, reason });
  }

  private nextRequestId(): string {
    this.requestCounter += 1;
    return `${this.options.clientId}-req-${this.requestCounter}`;
  }

  private emit(event: EngineConnectionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A misbehaving listener must not break the connection.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// In-memory transport, for tests and for a local embedded engine
// ---------------------------------------------------------------------------

/**
 * Loopback transport.
 *
 * Used by the protocol tests and usable for an in-process engine where there is
 * no socket at all. Nothing about `EngineConnection` changes.
 */
export class MemoryEngineTransport implements EngineTransport {
  readonly kind = "memory" as const;
  readonly address: string;

  private frameHandler?: (frame: string) => void;
  private closeHandler?: (reason: string) => void;
  private errorHandler?: (error: Error) => void;
  private opened = false;

  /** Frames the client sent, in order. */
  readonly sent: string[] = [];

  constructor(address = "memory://engine") {
    this.address = address;
  }

  async open(): Promise<void> {
    this.opened = true;
  }

  send(frame: string): void {
    if (!this.opened) throw new Error("transport is not open");
    this.sent.push(frame);
  }

  close(reason: string): void {
    this.opened = false;
    this.closeHandler?.(reason);
  }

  onFrame(handler: (frame: string) => void): void {
    this.frameHandler = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.closeHandler = handler;
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandler = handler;
  }

  /** Deliver a frame as if the engine sent it. */
  deliver(frame: string): void {
    this.frameHandler?.(frame);
  }

  /** Raise a transport error as if the socket reported one. */
  raise(error: Error): void {
    this.errorHandler?.(error);
  }

  /** Simulate an unexpected drop. */
  drop(reason = "connection reset"): void {
    this.opened = false;
    this.closeHandler?.(reason);
  }

  /**
   * Simulate the socket dying *without* a close event.
   *
   * The client still believes it is connected, so the next send throws. That race
   * is real — a half-open TCP connection behaves exactly this way — and it is what
   * made an unguarded heartbeat crash its host process.
   */
  simulateSocketLoss(): void {
    this.opened = false;
  }

  lastSent(): EngineMessage<unknown> | undefined {
    const frame = this.sent[this.sent.length - 1];
    return frame ? (JSON.parse(frame) as EngineMessage<unknown>) : undefined;
  }

  sentMessages(): EngineMessage<unknown>[] {
    return this.sent.map((frame) => JSON.parse(frame) as EngineMessage<unknown>);
  }
}

/** Byte length of a string as UTF-8, without allocating a copy of it. */
function utf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      // A surrogate pair is one 4-byte code point; skip its low half.
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}
