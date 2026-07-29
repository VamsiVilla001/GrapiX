/**
 * Local IPC transport.
 *
 * For the embedded deployment mode: a Node host — the desktop shell or
 * playout-control — talking to an engine it supervises on the same machine. No TCP
 * socket, no WebSocket handshake, and nothing reachable from the network.
 *
 * Node only. A browser cannot open a named pipe or a Unix socket, so the Editor's web
 * build keeps using the WebSocket transport; `node:net` is imported lazily so merely
 * importing this module never breaks a browser bundle.
 *
 * **Framing** matches the engine's `ipc.rs` exactly: a four-byte big-endian length
 * followed by that many bytes of UTF-8 JSON. Length prefixes rather than newlines
 * because a scene's text content can contain a newline, and a line-based reader would
 * split one message into two.
 *
 * The reader is a state machine over a growing buffer rather than a per-chunk parser: a
 * stream socket splits and coalesces writes freely, so a single `data` event may carry
 * half a message, three messages, or the tail of one and the head of the next.
 */

import type { EngineTransport, EngineTransportKind } from "./client.js";

/** Minimal shape of a `node:net` socket, so this stays testable without one. */
export interface MinimalSocket {
  write(data: Uint8Array): boolean;
  end(): void;
  destroy(): void;
  on(event: "data", handler: (chunk: Uint8Array) => void): unknown;
  on(event: "close" | "end", handler: () => void): unknown;
  on(event: "error", handler: (error: Error) => void): unknown;
  on(event: "connect" | "ready", handler: () => void): unknown;
}

export type SocketFactory = (path: string) => Promise<MinimalSocket>;

export interface IpcTransportOptions {
  /**
   * Endpoint path. A named pipe on Windows (`\\.\pipe\grapix-render-engine`), a socket
   * file elsewhere (`/tmp/grapix-render-engine.sock`).
   */
  path: string;
  /** Largest frame this client will accept, matching the engine's own limit. */
  maxFrameBytes?: number;
  connectTimeoutMs?: number;
  /** Injected in tests, and anywhere `node:net` is unavailable. */
  factory?: SocketFactory;
  setTimer?: (handler: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

const LENGTH_PREFIX_BYTES = 4;
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Encode one frame: length prefix then UTF-8 body. */
export function encodeIpcFrame(payload: string): Uint8Array {
  const body = new TextEncoder().encode(payload);
  const framed = new Uint8Array(LENGTH_PREFIX_BYTES + body.length);
  new DataView(framed.buffer).setUint32(0, body.length, false);
  framed.set(body, LENGTH_PREFIX_BYTES);
  return framed;
}

/**
 * Incremental frame reader.
 *
 * Exported because the framing is a contract with the Rust engine and deserves its own
 * tests, independent of any socket.
 */
export class IpcFrameReader {
  private buffer = new Uint8Array(0);

  constructor(private readonly maxFrameBytes = DEFAULT_MAX_FRAME_BYTES) {}

  /**
   * Add bytes and return every complete frame they produced.
   *
   * Throws when a declared length exceeds the limit — before any buffer is reserved for
   * it, so a peer cannot force a large allocation by lying about a length it never sends.
   */
  push(chunk: Uint8Array): string[] {
    const combined = new Uint8Array(this.buffer.length + chunk.length);
    combined.set(this.buffer, 0);
    combined.set(chunk, this.buffer.length);
    this.buffer = combined;

    const frames: string[] = [];
    const decoder = new TextDecoder();

    for (;;) {
      if (this.buffer.length < LENGTH_PREFIX_BYTES) break;

      const length = new DataView(
        this.buffer.buffer,
        this.buffer.byteOffset,
        this.buffer.byteLength
      ).getUint32(0, false);

      if (length > this.maxFrameBytes) {
        throw new Error(
          `IPC frame declares ${length} bytes; this client accepts at most ${this.maxFrameBytes}`
        );
      }
      // Incomplete: keep it buffered until the rest arrives.
      if (this.buffer.length < LENGTH_PREFIX_BYTES + length) break;

      frames.push(
        decoder.decode(this.buffer.subarray(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length))
      );
      this.buffer = this.buffer.slice(LENGTH_PREFIX_BYTES + length);
    }

    return frames;
  }

  /** Bytes held pending more input. Useful for asserting nothing was left behind. */
  get pendingBytes(): number {
    return this.buffer.length;
  }
}

/**
 * `EngineTransport` over a local socket.
 *
 * There is deliberately no token in the connection itself: unlike the WebSocket
 * handshake, IPC has no header to carry one, so an engine that requires authentication
 * is authenticated with `connection.authenticate` like any other message. That is the
 * `EngineConnection`'s job, and it already does it.
 */
export class IpcEngineTransport implements EngineTransport {
  readonly kind: EngineTransportKind = "ipc";
  readonly address: string;

  private socket: MinimalSocket | null = null;
  private reader: IpcFrameReader;
  private frameHandler?: (frame: string) => void;
  private closeHandler?: (reason: string) => void;
  private errorHandler?: (error: Error) => void;
  private closed = false;
  private destroyTimer: unknown = null;

  private readonly options: IpcTransportOptions;
  private readonly factory: SocketFactory;
  private readonly setTimer: (handler: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(options: IpcTransportOptions) {
    this.options = options;
    this.address = options.path;
    this.reader = new IpcFrameReader(options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES);
    this.factory = options.factory ?? defaultSocketFactory;
    this.setTimer = options.setTimer ?? ((handler, delayMs) => setTimeout(handler, delayMs));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as never));
  }

  async open(): Promise<void> {
    if (this.socket) return;

    if (this.destroyTimer !== null) {
      this.clearTimer(this.destroyTimer);
      this.destroyTimer = null;
    }

    const socket = await this.factory(this.options.path);
    this.socket = socket;
    this.closed = false;
    this.reader = new IpcFrameReader(this.options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES);

    socket.on("data", (chunk) => {
      try {
        for (const frame of this.reader.push(chunk)) {
          this.frameHandler?.(frame);
        }
      } catch (error) {
        // A framing violation means the stream can no longer be trusted: there is no way
        // to find the next boundary. Report and close rather than guess.
        const message = error instanceof Error ? error.message : String(error);
        this.errorHandler?.(new Error(message));
        this.close(message);
      }
    });

    socket.on("close", () => {
      if (this.closed) return;
      this.closed = true;
      this.socket = null;
      this.closeHandler?.("ipc socket closed");
    });

    socket.on("error", (error) => {
      this.errorHandler?.(error instanceof Error ? error : new Error(String(error)));
    });
  }

  send(frame: string): void {
    if (!this.socket) {
      throw new Error(`ipc transport to ${this.address} is not open`);
    }
    this.socket.write(encodeIpcFrame(frame));
  }

  close(reason: string): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket || this.closed) return;
    this.closed = true;

    try {
      socket.end();
    } catch {
      // Already gone.
    }
    // `end()` is a graceful half-close and can hang if the peer never responds, so a
    // destroy follows shortly after. Without it a lingering handle keeps a Node process
    // alive after everything else has shut down.
    this.destroyTimer = this.setTimer(() => {
      this.destroyTimer = null;
      try {
        socket.destroy();
      } catch {
        // Already gone.
      }
    }, 250);

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
}

/**
 * Connect with `node:net`.
 *
 * Imported lazily and by a computed specifier so a browser bundler does not try to
 * resolve it. In a browser this rejects with a message that says what to use instead,
 * rather than failing with a module-not-found error nobody can act on.
 */
async function defaultSocketFactory(path: string): Promise<MinimalSocket> {
  let net: typeof import("node:net");
  try {
    net = (await import(/* @vite-ignore */ "node:net")) as typeof import("node:net");
  } catch {
    throw new Error(
      "local IPC needs Node's net module; a browser cannot open a named pipe or a Unix socket. Use the WebSocket transport there."
    );
  }

  return await new Promise<MinimalSocket>((resolve, reject) => {
    const socket = net.connect(path);
    const onError = (error: Error) => {
      socket.removeListener("connect", onConnect);
      reject(
        new Error(
          `could not connect to the engine at ${path}: ${error.message}. Is it running with an ipc-endpoint configured?`
        )
      );
    };
    const onConnect = () => {
      socket.removeListener("error", onError);
      resolve(socket as unknown as MinimalSocket);
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}

/**
 * The conventional endpoint for a locally supervised engine.
 *
 * Named per platform because the two namespaces are unrelated: a Windows pipe lives in
 * the pipe namespace, a Unix socket is a real file that has to go somewhere writable.
 */
export function defaultIpcEndpoint(platform: string = process.platform): string {
  return platform === "win32"
    ? "\\\\.\\pipe\\grapix-render-engine"
    : "/tmp/grapix-render-engine.sock";
}
