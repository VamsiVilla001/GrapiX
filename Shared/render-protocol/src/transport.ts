/**
 * WebSocket transport.
 *
 * Deliberately written against the *standard* `WebSocket` interface rather than
 * against `ws` or the browser global, so the same file works in the Editor
 * (browser), in Playout (Node 22, which has a global `WebSocket`), and in tests.
 * The constructor is injectable for the same reason.
 *
 * The transport's only job is moving frames. It knows nothing about the protocol,
 * which is what lets an engine move from loopback to a GPU workstation without the
 * Editor changing.
 */

import type { EngineTransport, EngineTransportKind } from "./client.js";

/** The subset of the WebSocket API this transport actually uses. */
export interface MinimalWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type WebSocketFactory = (url: string, protocols?: string[]) => MinimalWebSocket;

const OPEN = 1;

export interface WebSocketTransportOptions {
  url: string;
  /** Bearer token, sent as a subprotocol so it never appears in a query string. */
  authToken?: string;
  /** Injected for tests and for environments with no global. */
  factory?: WebSocketFactory;
  /** How long to wait for the socket to open. */
  connectTimeoutMs?: number;
  setTimer?: (handler: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * `EngineTransport` over a WebSocket.
 *
 * The token travels as a subprotocol rather than a query parameter: query strings
 * end up in proxy logs and browser history, and a renderer token in either is a
 * credential leak.
 */
export class WebSocketEngineTransport implements EngineTransport {
  readonly kind: EngineTransportKind = "websocket";
  readonly address: string;

  private socket: MinimalWebSocket | null = null;
  private frameHandler?: (frame: string) => void;
  private closeHandler?: (reason: string) => void;
  private errorHandler?: (error: Error) => void;

  private readonly options: WebSocketTransportOptions;
  private readonly factory: WebSocketFactory;
  private readonly setTimer: (handler: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(options: WebSocketTransportOptions) {
    this.options = options;
    this.address = options.url;

    const resolved =
      options.factory
      ?? resolveGlobalWebSocketFactory()
      ?? (() => {
        throw new Error(
          "no WebSocket implementation available; pass a factory to WebSocketEngineTransport"
        );
      })();
    this.factory = resolved;

    this.setTimer =
      options.setTimer ?? ((handler, delayMs) => setTimeout(handler, delayMs));
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  async open(): Promise<void> {
    if (this.socket && this.socket.readyState === OPEN) return;

    const protocols = this.options.authToken
      ? [`grapix-engine-v3`, `bearer.${this.options.authToken}`]
      : ["grapix-engine-v3"];

    const socket = this.factory(this.options.url, protocols);
    this.socket = socket;

    socket.onmessage = (event) => {
      // Binary frames are not part of protocol v3; ignoring them is safer than
      // guessing at an encoding.
      if (typeof event.data === "string") {
        this.frameHandler?.(event.data);
      }
    };

    socket.onclose = (event) => {
      this.socket = null;
      const reason = event?.reason?.trim();
      this.closeHandler?.(
        reason && reason.length > 0
          ? reason
          : `socket closed${event?.code !== undefined ? ` (code ${event.code})` : ""}`
      );
    };

    socket.onerror = () => {
      // The WebSocket error event carries no detail by design, so there is nothing
      // more specific to report than the address.
      this.errorHandler?.(new Error(`websocket error on ${this.options.url}`));
    };

    await new Promise<void>((resolve, reject) => {
      const timeoutMs = this.options.connectTimeoutMs ?? 10_000;
      let settled = false;

      const timer = this.setTimer(() => {
        if (settled) return;
        settled = true;
        // Close the half-open socket, or it leaks and may connect later.
        try {
          socket.close(1000, "connect timeout");
        } catch {
          // Already dead.
        }
        reject(new Error(`timed out connecting to ${this.options.url} after ${timeoutMs}ms`));
      }, timeoutMs);

      socket.onopen = () => {
        if (settled) return;
        settled = true;
        this.clearTimer(timer);
        resolve();
      };

      const previousError = socket.onerror;
      socket.onerror = (event) => {
        previousError?.(event);
        if (settled) return;
        settled = true;
        this.clearTimer(timer);
        reject(new Error(`could not connect to ${this.options.url}`));
      };

      // A socket that is already open (a reused instance) resolves immediately.
      if (socket.readyState === OPEN) {
        settled = true;
        this.clearTimer(timer);
        resolve();
      }
    });
  }

  send(frame: string): void {
    if (!this.socket || this.socket.readyState !== OPEN) {
      throw new Error(`cannot send to ${this.options.url}: socket is not open`);
    }
    this.socket.send(frame);
  }

  close(reason: string): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      socket.close(1000, reason.slice(0, 120));
    } catch {
      // Already closed; nothing to do.
    }
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

function resolveGlobalWebSocket(): unknown {
  return (globalThis as { WebSocket?: unknown }).WebSocket;
}

function resolveGlobalWebSocketFactory(): WebSocketFactory | undefined {
  const Implementation = resolveGlobalWebSocket();
  if (typeof Implementation !== "function") return undefined;

  return (url, protocols) =>
    new (Implementation as new (url: string, protocols?: string[]) => MinimalWebSocket)(
      url,
      protocols
    );
}

/** Is a global WebSocket available? Lets a caller choose a transport up front. */
export function isWebSocketAvailable(): boolean {
  return typeof resolveGlobalWebSocket() === "function";
}

/**
 * Build an engine URL from its parts.
 *
 * Chooses `wss` for anything that is not loopback: an unencrypted renderer
 * connection across a venue network carries a bearer token in the clear.
 */
export function engineUrl(
  host: string,
  port: number,
  options: { secure?: boolean; path?: string } = {}
): string {
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  const secure = options.secure ?? !loopback;
  const scheme = secure ? "wss" : "ws";
  const bracketed = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const path = options.path ?? "";
  return `${scheme}://${bracketed}:${port}${path}`;
}
