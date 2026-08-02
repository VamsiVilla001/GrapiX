import type { LogMessage } from "@grapix/adobe-common-schema";

/**
 * Bounded log ring. The Adobe panel's "View logs" button reads this, and a bridge
 * that reconnects in a loop must not be able to grow the gateway's heap without limit.
 */
export class LogRing {
  private readonly entries: LogMessage[] = [];

  constructor(private readonly capacity = 500) {}

  push(level: LogMessage["level"], source: string, message: string): LogMessage {
    const entry: LogMessage = { type: "log", level, source, message, timestamp: Date.now() };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
    return entry;
  }

  /** Newest last, so a panel can append without reversing. */
  recent(limit = 100): LogMessage[] {
    return this.entries.slice(-limit);
  }

  get size(): number {
    return this.entries.length;
  }
}
