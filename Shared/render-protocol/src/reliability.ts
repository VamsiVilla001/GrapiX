/**
 * Reliability primitives: deduplication, ordering, retry, and rate limiting.
 *
 * All of this is deterministic and clock-injected. A retry policy tested with a
 * real timer is a retry policy nobody tests, so every function here takes the
 * current time as an argument.
 */

export interface DeduplicatorOptions {
  /** Maximum ids remembered. Oldest are forgotten first. */
  capacity?: number;
  /** How long an id is remembered. Zero means capacity-only. */
  ttlMs?: number;
}

/**
 * Bounded message-id memory.
 *
 * Retransmits must be recognised and discarded, but remembering every id an
 * engine has ever seen is a leak on a service meant to run for weeks. Both a
 * capacity and a TTL bound it, and the capacity is a hard ceiling so memory is
 * predictable regardless of traffic.
 */
export class MessageDeduplicator {
  private readonly capacity: number;
  private readonly ttlMs: number;
  private readonly seenAt = new Map<string, number>();

  constructor(options: DeduplicatorOptions = {}) {
    this.capacity = Math.max(1, options.capacity ?? 4096);
    this.ttlMs = Math.max(0, options.ttlMs ?? 60_000);
  }

  get size(): number {
    return this.seenAt.size;
  }

  /**
   * Record an id and report whether it had already been seen.
   *
   * True means "duplicate — acknowledge it and do nothing else".
   */
  check(messageId: string, nowMs: number): boolean {
    this.expire(nowMs);

    if (this.seenAt.has(messageId)) {
      // Refresh so a repeatedly retransmitted id stays remembered.
      this.seenAt.delete(messageId);
      this.seenAt.set(messageId, nowMs);
      return true;
    }

    this.seenAt.set(messageId, nowMs);
    while (this.seenAt.size > this.capacity) {
      const oldest = this.seenAt.keys().next();
      if (oldest.done) break;
      this.seenAt.delete(oldest.value);
    }
    return false;
  }

  has(messageId: string): boolean {
    return this.seenAt.has(messageId);
  }

  clear(): void {
    this.seenAt.clear();
  }

  private expire(nowMs: number): void {
    if (this.ttlMs === 0) return;
    const cutoff = nowMs - this.ttlMs;
    for (const [messageId, at] of this.seenAt) {
      // Insertion-ordered, so the first non-expired entry ends the sweep.
      if (at > cutoff) break;
      this.seenAt.delete(messageId);
    }
  }
}

export type SequenceVerdict =
  /** Next in sequence. Process it. */
  | "accept"
  /** Already processed. Discard. */
  | "duplicate"
  /** Arrived early; earlier messages are outstanding. Park it. */
  | "future"
  /** Too far ahead to park. The stream is broken; resync. */
  | "gap";

export interface SequenceTrackerOptions {
  /** How many future messages to hold before declaring a gap. */
  parkLimit?: number;
  /** First sequence expected. Connections start at 1. */
  startSequence?: number;
}

/**
 * Per-connection, per-direction sequence ordering.
 *
 * Ordered command handling is not optional for a renderer: applying `Take` before
 * the `Cue` it depends on puts the wrong thing on air. When ordering cannot be
 * guaranteed, the correct answer is to resync, never to proceed.
 */
export class SequenceTracker {
  private nextExpected: number;
  private readonly parkLimit: number;
  private readonly parked = new Map<number, unknown>();
  private highestSeen = 0;
  private gapCount = 0;

  constructor(options: SequenceTrackerOptions = {}) {
    this.nextExpected = Math.max(1, options.startSequence ?? 1);
    this.parkLimit = Math.max(0, options.parkLimit ?? 32);
  }

  get expected(): number {
    return this.nextExpected;
  }

  get parkedCount(): number {
    return this.parked.size;
  }

  get gaps(): number {
    return this.gapCount;
  }

  classify(sequence: number): SequenceVerdict {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) return "gap";
    if (sequence < this.nextExpected) return "duplicate";
    if (sequence === this.nextExpected) return "accept";
    if (this.parked.size >= this.parkLimit) return "gap";
    return "future";
  }

  /**
   * Offer a message. Accepted messages are returned in order, draining anything
   * parked that has become next.
   */
  offer<T>(sequence: number, value: T): { verdict: SequenceVerdict; released: T[] } {
    const verdict = this.classify(sequence);
    this.highestSeen = Math.max(this.highestSeen, sequence);

    if (verdict === "duplicate") return { verdict, released: [] };

    if (verdict === "gap") {
      this.gapCount += 1;
      this.parked.clear();
      return { verdict, released: [] };
    }

    if (verdict === "future") {
      this.parked.set(sequence, value);
      return { verdict, released: [] };
    }

    const released: T[] = [value];
    this.nextExpected = sequence + 1;

    for (;;) {
      if (!this.parked.has(this.nextExpected)) break;
      released.push(this.parked.get(this.nextExpected) as T);
      this.parked.delete(this.nextExpected);
      this.nextExpected += 1;
    }

    return { verdict, released };
  }

  /** Reset after a reconnect, where the peer restarts its sequence. */
  reset(startSequence = 1): void {
    this.nextExpected = Math.max(1, startSequence);
    this.parked.clear();
    this.highestSeen = 0;
  }
}

/** Monotonic outbound sequence generator. */
export class SequenceGenerator {
  private value: number;

  constructor(start = 0) {
    this.value = Math.max(0, start);
  }

  next(): number {
    this.value += 1;
    return this.value;
  }

  /**
   * Give back a number that never went out.
   *
   * The receiver tracks sequences to detect loss and reordering, and it *parks* a message that
   * arrives with a gap ahead of it — waiting for one that will never come. So a frame the sender
   * builds and then refuses to send must not consume a number: the next real frame would land in the
   * hole's place and be held rather than answered, which reads to an operator as a dead connection.
   *
   * Only the number just issued can be released, so nothing can rewind history.
   */
  release(sequence: number): void {
    if (sequence === this.value && this.value > 0) this.value -= 1;
  }

  get current(): number {
    return this.value;
  }

  reset(): void {
    this.value = 0;
  }
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /**
   * 0..1. Maximum fraction the delay may be *reduced* by, to break up reconnect
   * stampedes.
   *
   * Subtractive rather than centred so `maxDelayMs` is a true ceiling: a policy
   * that can overshoot its own cap is a policy nobody can reason about.
   */
  jitterRatio: number;
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  maxAttempts: 6,
  baseDelayMs: 250,
  maxDelayMs: 10_000,
  jitterRatio: 0.2
});

export const DEFAULT_RECONNECT_POLICY: Readonly<RetryPolicy> = Object.freeze({
  // Effectively unlimited: an engine that comes back after an hour must be
  // reconnected to, not given up on.
  maxAttempts: Number.MAX_SAFE_INTEGER,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitterRatio: 0.3
});

/**
 * Exponential backoff with subtractive jitter.
 *
 * The delay lands in `[capped * (1 - jitterRatio), capped]`, so it can never
 * exceed `maxDelayMs` and can never be negative. `random` is injectable so tests
 * are deterministic. Attempt numbers are one-based: attempt 1 is the first retry.
 */
export function retryDelayMs(
  policy: RetryPolicy,
  attempt: number,
  random: () => number = Math.random
): number {
  if (attempt < 1) return 0;

  const exponential = policy.baseDelayMs * Math.pow(2, attempt - 1);
  const capped = Math.min(policy.maxDelayMs, exponential);
  const ratio = Math.max(0, Math.min(1, policy.jitterRatio));
  const floor = capped * (1 - ratio);

  return Math.round(floor + random() * (capped - floor));
}

export function shouldRetry(policy: RetryPolicy, attempt: number): boolean {
  return attempt < policy.maxAttempts;
}

export interface RateLimiterOptions {
  /** Tokens available in a full bucket. */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

/**
 * Token-bucket rate limiter.
 *
 * Protects a live renderer from a client that loops on `preview.request`. Bursty
 * by design — an operator cueing several scenes at once is legitimate, a thousand
 * previews a second is not.
 */
export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private tokens: number;
  private lastRefillMs: number;

  constructor(options: RateLimiterOptions, nowMs = 0) {
    this.capacity = Math.max(1, options.capacity);
    this.refillPerSecond = Math.max(0, options.refillPerSecond);
    this.tokens = this.capacity;
    this.lastRefillMs = nowMs;
  }

  get available(): number {
    return this.tokens;
  }

  /** Consume one token. False means the caller must be rejected. */
  tryConsume(nowMs: number, cost = 1): boolean {
    this.refill(nowMs);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** Milliseconds until `cost` tokens are available. */
  retryAfterMs(nowMs: number, cost = 1): number {
    this.refill(nowMs);
    if (this.tokens >= cost) return 0;
    if (this.refillPerSecond === 0) return Number.POSITIVE_INFINITY;
    return Math.ceil(((cost - this.tokens) / this.refillPerSecond) * 1000);
  }

  private refill(nowMs: number): void {
    if (nowMs <= this.lastRefillMs) return;
    const elapsedSeconds = (nowMs - this.lastRefillMs) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefillMs = nowMs;
  }
}

export interface HeartbeatMonitorOptions {
  /** How often to send. */
  intervalMs: number;
  /** Silence after which the peer is declared unreachable. */
  timeoutMs: number;
}

export const DEFAULT_HEARTBEAT: Readonly<HeartbeatMonitorOptions> = Object.freeze({
  intervalMs: 2_000,
  timeoutMs: 8_000
});

/**
 * Liveness tracking with latency measurement.
 *
 * Separate from the transport's own keepalive because a TCP connection can stay
 * open while the engine's render thread is wedged. Application-level heartbeats
 * detect that; a socket-level one does not.
 */
export class HeartbeatMonitor {
  private readonly options: HeartbeatMonitorOptions;
  private lastSentMs = 0;
  private lastReceivedMs = 0;
  private latencySamples: number[] = [];
  private missed = 0;

  constructor(options: HeartbeatMonitorOptions = DEFAULT_HEARTBEAT, nowMs = 0) {
    this.options = options;
    this.lastReceivedMs = nowMs;
  }

  get missedCount(): number {
    return this.missed;
  }

  get lastLatencyMs(): number {
    return this.latencySamples.length > 0 ? this.latencySamples[this.latencySamples.length - 1] : 0;
  }

  get averageLatencyMs(): number {
    if (this.latencySamples.length === 0) return 0;
    const total = this.latencySamples.reduce((sum, sample) => sum + sample, 0);
    return total / this.latencySamples.length;
  }

  recordSent(nowMs: number): void {
    this.lastSentMs = nowMs;
  }

  /**
   * Note that the peer is alive.
   *
   * Any inbound frame proves the engine is answering, so it resets the timeout. Kept
   * separate from `recordReceived` because a scene reply is not a latency sample:
   * mixing them in would report the render time of whatever the engine was doing as
   * network latency.
   */
  noteActivity(nowMs: number): void {
    this.lastReceivedMs = nowMs;
    this.missed = 0;
  }

  /** Record a reply. `sentAtMs` is echoed from the request. */
  recordReceived(nowMs: number, sentAtMs: number): number {
    this.lastReceivedMs = nowMs;
    this.missed = 0;

    const latency = Math.max(0, nowMs - sentAtMs);
    this.latencySamples.push(latency);
    if (this.latencySamples.length > 32) this.latencySamples.shift();
    return latency;
  }

  shouldSend(nowMs: number): boolean {
    return nowMs - this.lastSentMs >= this.options.intervalMs;
  }

  /** True when the peer has been silent past the timeout. */
  isTimedOut(nowMs: number): boolean {
    return nowMs - this.lastReceivedMs > this.options.timeoutMs;
  }

  recordMissed(): number {
    this.missed += 1;
    return this.missed;
  }

  reset(nowMs: number): void {
    this.lastSentMs = nowMs;
    this.lastReceivedMs = nowMs;
    this.latencySamples = [];
    this.missed = 0;
  }
}

/**
 * Deterministic message-id generator.
 *
 * `crypto.randomUUID` is not available everywhere this runs, and tests need
 * reproducible ids. Prefix plus counter is enough: uniqueness is only required
 * within one connection's dedupe window.
 */
export class MessageIdGenerator {
  private counter = 0;

  constructor(private readonly prefix: string) {}

  next(): string {
    this.counter += 1;
    return `${this.prefix}-${this.counter}`;
  }

  get issued(): number {
    return this.counter;
  }
}
