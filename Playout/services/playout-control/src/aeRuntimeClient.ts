import {
  AE_RUNTIME_CAPABILITIES,
  AE_RUNTIME_MAX_FRAME_BYTES,
  AE_RUNTIME_PROTOCOL_MAJOR,
  AE_RUNTIME_PROTOCOL_MINOR,
  AeRuntimeProtocolError,
  assertAeRuntimeRequest,
  decodeAeRuntimeFrame,
  encodeAeRuntimeFrame,
  type AeRuntimeCapability,
  type AeRuntimeEnvelope,
  type AeRuntimeHello,
  type AeRuntimeHelloAck,
  type AeRuntimeOperation,
  type AeRuntimeRequest,
  type AeRuntimeResult,
  type AeRuntimeEvent
} from "@grapix/adobe-common-schema";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";

export interface AeRuntimeEventStats {
  buffered: number;
  bufferDropped: number;
  foreignSessionDropped: number;
  listenerFailures: number;
  lastSequence: number | null;
  sequenceGaps: number;
  sequenceRegressions: number;
}

export interface AeRuntimeClientOptions {
  sessionId: string;
  token: string;
  capabilities?: readonly AeRuntimeCapability[];
  connectTimeoutMs?: number;
  pipePath?: string;
  eventBufferLimit?: number;
}

export interface AeRuntimeCallOptions {
  deadlineMs?: number;
  idempotencyKey?: string;
  expectedProjectDigest?: string | null;
}

export class AeRuntimeClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private buffered = Buffer.alloc(0);
  private readonly frames: AeRuntimeEnvelope[] = [];
  private readonly frameWaiters: Array<{ resolve: (frame: AeRuntimeEnvelope) => void; reject: (error: Error) => void }> = [];
  private sequence = 0;
  private helloAck: AeRuntimeHelloAck | null = null;
  private readonly pipePath: string;
  private readonly capabilities: readonly AeRuntimeCapability[];
  private readonly connectTimeoutMs: number;
  private readonly eventBufferLimit: number;
  private readonly eventListeners = new Set<(event: AeRuntimeEvent) => void>();
  private readonly bufferedEvents: AeRuntimeEvent[] = [];
  private eventBufferDropped = 0;
  private foreignSessionEventsDropped = 0;
  private eventListenerFailures = 0;
  private lastEventSequence: number | null = null;
  private eventSequenceGaps = 0;
  private eventSequenceRegressions = 0;

  constructor(private readonly options: AeRuntimeClientOptions) {
    super();
    if (!/^[A-Za-z0-9-]{1,64}$/.test(options.sessionId)) {
      throw new AeRuntimeProtocolError("INVALID_PAYLOAD", "runtime session id is not safe for a pipe name");
    }
    if (options.token.length < 32) {
      throw new AeRuntimeProtocolError("AUTH_FAILED", "runtime launch token must contain at least 32 characters");
    }
    this.pipePath = options.pipePath ?? `\\\\.\\pipe\\grapix-ae-runtime-${options.sessionId}`;
    this.capabilities = options.capabilities ?? AE_RUNTIME_CAPABILITIES;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.eventBufferLimit = options.eventBufferLimit ?? 64;
    if (!Number.isSafeInteger(this.eventBufferLimit) || this.eventBufferLimit < 0) {
      throw new AeRuntimeProtocolError("INVALID_PAYLOAD", "runtime event buffer limit must be a non-negative safe integer");
    }
  }

  get negotiated(): AeRuntimeHelloAck | null {
    return this.helloAck;
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed && this.helloAck !== null;
  }

  get eventStats(): AeRuntimeEventStats {
    return {
      buffered: this.bufferedEvents.length,
      bufferDropped: this.eventBufferDropped,
      foreignSessionDropped: this.foreignSessionEventsDropped,
      listenerFailures: this.eventListenerFailures,
      lastSequence: this.lastEventSequence,
      sequenceGaps: this.eventSequenceGaps,
      sequenceRegressions: this.eventSequenceRegressions
    };
  }

  onEvent(listener: (event: AeRuntimeEvent) => void): () => void {
    this.eventListeners.add(listener);
    if (this.bufferedEvents.length > 0) {
      const buffered = this.bufferedEvents.splice(0);
      for (const event of buffered) this.deliverEvent(listener, event);
    }
    return () => this.eventListeners.delete(listener);
  }

  async connect(): Promise<AeRuntimeHelloAck> {
    if (this.connected && this.helloAck) return this.helloAck;
    await this.close();
    const socket = net.createConnection(this.pipePath);
    this.socket = socket;
    socket.on("data", (chunk) => this.acceptBytes(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => {
      this.helloAck = null;
      this.socket = null;
      this.fail(new AeRuntimeProtocolError("RUNTIME_UNAVAILABLE", "runtime pipe closed"));
      this.emit("close");
    });
    const connected = Promise.withResolvers<void>();
    socket.once("connect", connected.resolve);
    socket.once("error", connected.reject);
    await withTimeout(connected.promise, this.connectTimeoutMs, "runtime pipe did not accept a connection");

    const hello: AeRuntimeHello = {
      kind: "hello",
      protocolMajor: AE_RUNTIME_PROTOCOL_MAJOR,
      protocolMinor: AE_RUNTIME_PROTOCOL_MINOR,
      sessionId: this.options.sessionId,
      token: this.options.token,
      capabilities: [...this.capabilities]
    };
    await this.write(hello);
    const response = await withTimeout(this.readFrame(), this.connectTimeoutMs, "runtime HELLO did not complete");
    if (response.kind === "result" && !response.ok && response.error) {
      throw new AeRuntimeProtocolError(response.error.code, response.error.message);
    }
    if (response.kind !== "hello-ack" || response.protocolMajor !== AE_RUNTIME_PROTOCOL_MAJOR
      || response.sessionId !== this.options.sessionId) {
      throw new AeRuntimeProtocolError("PROTOCOL_INCOMPATIBLE", "runtime HELLO acknowledgement is incompatible");
    }
    const negotiated = new Set(response.capabilities);
    const missing = this.capabilities.filter((capability) => !negotiated.has(capability));
    if (missing.length > 0) {
      throw new AeRuntimeProtocolError("CAPABILITY_MISSING", `runtime omitted negotiated capabilities: ${missing.join(", ")}`);
    }
    this.helloAck = response;
    return response;
  }

  async call<TResult = unknown, TPayload = unknown>(
    operation: AeRuntimeOperation,
    payload: TPayload,
    options: AeRuntimeCallOptions = {}
  ): Promise<AeRuntimeResult<TResult>> {
    if (!this.connected) throw new AeRuntimeProtocolError("RUNTIME_UNAVAILABLE", "runtime pipe is not connected");
    const deadlineMs = options.deadlineMs ?? 5_000;
    const request: AeRuntimeRequest<TPayload> = {
      kind: "request",
      protocolMajor: AE_RUNTIME_PROTOCOL_MAJOR,
      protocolMinor: AE_RUNTIME_PROTOCOL_MINOR,
      sessionId: this.options.sessionId,
      requestId: randomUUID(),
      sequence: ++this.sequence,
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
      deadlineUnixMs: Date.now() + deadlineMs,
      expectedProjectDigest: options.expectedProjectDigest ?? null,
      operation,
      payload
    };
    assertAeRuntimeRequest(request);
    await this.write(request);
    const response = await withTimeout(this.readFrame(), deadlineMs + 250, `runtime ${operation} exceeded its deadline`);
    if (response.kind !== "result" || response.requestId !== request.requestId
      || response.sequence !== request.sequence || response.operation !== operation) {
      throw new AeRuntimeProtocolError("MALFORMED_FRAME", "runtime response does not identify the outstanding request");
    }
    return response as AeRuntimeResult<TResult>;
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.helloAck = null;
    if (!socket) return;
    socket.removeAllListeners();
    const closed = Promise.withResolvers<void>();
    socket.once("close", closed.resolve);
    socket.end();
    setTimeout(() => { if (!socket.destroyed) socket.destroy(); }, 100).unref();
    await closed.promise;
  }

  private async write(envelope: AeRuntimeEnvelope): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed) throw new AeRuntimeProtocolError("RUNTIME_UNAVAILABLE", "runtime pipe is closed");
    const frame = Buffer.from(encodeAeRuntimeFrame(envelope));
    const written = Promise.withResolvers<void>();
    socket.write(frame, (error) => error ? written.reject(error) : written.resolve());
    await written.promise;
  }

  private readFrame(): Promise<AeRuntimeEnvelope> {
    const frame = this.frames.shift();
    if (frame) return Promise.resolve(frame);
    const waiter = Promise.withResolvers<AeRuntimeEnvelope>();
    this.frameWaiters.push({ resolve: waiter.resolve, reject: waiter.reject });
    return waiter.promise;
  }

  private acceptBytes(chunk: Buffer): void {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    while (this.buffered.length >= 4) {
      const declared = this.buffered.readUInt32BE(0);
      if (declared > AE_RUNTIME_MAX_FRAME_BYTES) {
        const error = new AeRuntimeProtocolError("FRAME_TOO_LARGE", `runtime declared ${declared} bytes`);
        this.socket?.destroy(error);
        this.fail(error);
        return;
      }
      if (this.buffered.length < declared + 4) return;
      const frame = decodeAeRuntimeFrame(this.buffered.subarray(0, declared + 4));
      this.buffered = this.buffered.subarray(declared + 4);
      if (frame.kind === "event") {
        this.acceptEvent(frame);
        continue;
      }
      const waiter = this.frameWaiters.shift();
      if (waiter) waiter.resolve(frame);
      else this.frames.push(frame);
    }
  }


  private acceptEvent(event: AeRuntimeEvent): void {
    if (event.sessionId !== this.options.sessionId) {
      this.foreignSessionEventsDropped += 1;
      return;
    }
    if (this.lastEventSequence !== null) {
      if (event.sequence > this.lastEventSequence + 1) this.eventSequenceGaps += event.sequence - this.lastEventSequence - 1;
      else if (event.sequence <= this.lastEventSequence) this.eventSequenceRegressions += 1;
    }
    this.lastEventSequence = event.sequence;
    if (this.eventListeners.size === 0) {
      if (this.eventBufferLimit === 0) {
        this.eventBufferDropped += 1;
      } else {
        if (this.bufferedEvents.length === this.eventBufferLimit) {
          this.bufferedEvents.shift();
          this.eventBufferDropped += 1;
        }
        this.bufferedEvents.push(event);
      }
      return;
    }
    for (const listener of this.eventListeners) this.deliverEvent(listener, event);
  }

  private deliverEvent(listener: (event: AeRuntimeEvent) => void, event: AeRuntimeEvent): void {
    try {
      listener(event);
    } catch {
      this.eventListenerFailures += 1;
    }
  }

  private fail(error: Error): void {
    while (this.frameWaiters.length > 0) this.frameWaiters.shift()!.reject(error);
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  const timed = Promise.withResolvers<T>();
  const timer = setTimeout(() => timed.reject(new AeRuntimeProtocolError("RUNTIME_UNAVAILABLE", message)), timeoutMs);
  timer.unref();
  promise.then(
    (value) => { clearTimeout(timer); timed.resolve(value); },
    (error) => { clearTimeout(timer); timed.reject(error); }
  );
  return timed.promise;
}
