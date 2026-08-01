/**
 * Server-sent events from the control service to the operator UI.
 *
 * The library used to be a pull: the UI fetched it on mount and then only when someone
 * pressed the refresh button. So an Editor could publish a scene and the operator would sit
 * looking at a library that did not contain it, with nothing on screen suggesting it was
 * stale. "Publish worked but Playout cannot see it" is the same class of failure as a silently
 * dropped message, and it is not fixed by polling harder.
 *
 * SSE rather than a WebSocket: this is one-directional server-to-client notification, it
 * survives a proxy, it reconnects on its own, and the operator UI already has a WebSocket
 * budget spent on the engine. Rather than pushing the payload, an event says *what changed*
 * and the UI refetches — so a missed event costs one stale render, not a divergent cache.
 */

import type { FastifyReply } from "fastify";

/** What the UI is told about. Each name maps to one thing the UI should refetch. */
export type PlayoutEventKind = "library.changed" | "sequence.changed" | "runtime.changed";

export interface PlayoutEvent {
  kind: PlayoutEventKind;
  /** Free-form detail for logs and debugging. Never load-bearing for the UI. */
  detail?: Record<string, unknown>;
}

interface Subscriber {
  id: number;
  reply: FastifyReply;
}

/**
 * Fan-out to every connected operator UI.
 *
 * Deliberately has no buffer and no replay. A client that reconnects refetches everything it
 * needs, which is cheaper and more honest than replaying a queue that may itself be stale.
 */
export class PlayoutEventBus {
  private subscribers: Subscriber[] = [];
  private nextId = 1;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  /** How often a comment frame is sent so an idle connection is not reaped. */
  private static readonly HEARTBEAT_MS = 25_000;

  subscriberCount(): number {
    return this.subscribers.length;
  }

  /**
   * Attach a reply as an SSE stream.
   *
   * Takes over the raw socket, so the route must not also send a body.
   */
  subscribe(reply: FastifyReply): void {
    const id = this.nextId++;

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // The operator UI is served from a different origin than this service in every
      // configuration; without this the EventSource never opens.
      "access-control-allow-origin": reply.request.headers.origin ?? "*"
    });
    // Tell the browser not to reconnect faster than this, and open the stream.
    reply.raw.write("retry: 2000\n\n");

    const subscriber: Subscriber = { id, reply };
    this.subscribers.push(subscriber);

    const drop = () => this.unsubscribe(id);
    reply.raw.on("close", drop);
    reply.raw.on("error", drop);

    this.ensureHeartbeat();
  }

  private unsubscribe(id: number): void {
    this.subscribers = this.subscribers.filter((subscriber) => subscriber.id !== id);
    if (this.subscribers.length === 0 && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  /** Publish an event to every subscriber. Never throws: a dead socket is dropped, not fatal. */
  emit(event: PlayoutEvent): void {
    if (this.subscribers.length === 0) {
      return;
    }
    const frame = `event: ${event.kind}\ndata: ${JSON.stringify(event.detail ?? {})}\n\n`;
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber.reply.raw.write(frame);
      } catch {
        this.unsubscribe(subscriber.id);
      }
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) {
      return;
    }
    this.heartbeat = setInterval(() => {
      for (const subscriber of [...this.subscribers]) {
        try {
          // A comment frame: ignored by EventSource, enough to keep the socket alive.
          subscriber.reply.raw.write(": keep-alive\n\n");
        } catch {
          this.unsubscribe(subscriber.id);
        }
      }
    }, PlayoutEventBus.HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  /** Close every stream. Called on shutdown so node can exit. */
  close(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    for (const subscriber of this.subscribers) {
      try {
        subscriber.reply.raw.end();
      } catch {
        // Already gone.
      }
    }
    this.subscribers = [];
  }
}
