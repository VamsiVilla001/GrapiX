/**
 * Server-sent events from the assistant broker to the Editor UI.
 *
 * Two uses: a broadcast `status` stream (which model is connected) and a per-session chat
 * stream (tokens, tool events, staged tool calls, done). SSE rather than a WebSocket for the
 * same reasons the Playout control service chose it: one-directional server→client, survives a
 * proxy, reconnects on its own. Mirrors `Playout/services/playout-control/src/events.ts`.
 */

import type { FastifyReply } from "fastify";

interface Subscriber {
  id: number;
  topic: string;
  reply: FastifyReply;
}

/** A named event written to a stream. `data` is JSON-serialised. */
export interface SseMessage {
  event: string;
  data: unknown;
}

export class SseBus {
  private subscribers: Subscriber[] = [];
  private nextId = 1;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  private static readonly HEARTBEAT_MS = 25_000;

  /** Attach a reply as an SSE stream scoped to `topic`. The route must not also send a body. */
  subscribe(topic: string, reply: FastifyReply): void {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    reply.raw.write(": connected\n\n");

    const id = this.nextId++;
    this.subscribers.push({ id, topic, reply });
    this.ensureHeartbeat();

    reply.raw.on("close", () => this.unsubscribe(id));
  }

  private unsubscribe(id: number): void {
    this.subscribers = this.subscribers.filter((subscriber) => subscriber.id !== id);
  }

  count(topic?: string): number {
    return topic === undefined
      ? this.subscribers.length
      : this.subscribers.filter((subscriber) => subscriber.topic === topic).length;
  }

  /** Publish to every subscriber of a topic. Never throws: a dead socket is dropped. */
  emit(topic: string, message: SseMessage): void {
    const frame = `event: ${message.event}\ndata: ${JSON.stringify(message.data)}\n\n`;
    for (const subscriber of this.subscribers) {
      if (subscriber.topic !== topic) continue;
      try {
        subscriber.reply.raw.write(frame);
      } catch {
        this.unsubscribe(subscriber.id);
      }
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      for (const subscriber of this.subscribers) {
        try {
          subscriber.reply.raw.write(": ping\n\n");
        } catch {
          this.unsubscribe(subscriber.id);
        }
      }
    }, SseBus.HEARTBEAT_MS);
    // Do not keep the event loop alive for heartbeats alone.
    this.heartbeat.unref?.();
  }

  close(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    for (const subscriber of this.subscribers) {
      try {
        subscriber.reply.raw.end();
      } catch {
        // already gone
      }
    }
    this.subscribers = [];
  }
}
