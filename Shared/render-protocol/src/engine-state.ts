/**
 * Engine connection state machine.
 *
 * The eleven states from requirement 8, with an explicit transition table. An
 * explicit table matters more than it looks: without one, "reconnecting" quietly
 * becomes a boolean flag somewhere and an engine ends up believed Ready while its
 * socket is closed, which is exactly the failure that puts black on air.
 */

export const ENGINE_STATES = [
  /** No connection and none attempted. */
  "offline",
  /** Looking for local engines. */
  "discovering",
  /** Transport connecting. */
  "connecting",
  /** Transport open, credentials being exchanged. */
  "authenticating",
  /** Authenticated, reconciling scene revisions and assets. */
  "synchronising",
  /** Synchronised, building GPU resources. */
  "preparing",
  /** Prepared and idle. Can accept a Take. */
  "ready",
  /** Rendering Program. */
  "on-air",
  /** Functioning with a degradation the operator must know about. */
  "warning",
  /** Not functioning. */
  "error",
  /** Attempting automatic recovery from error or device loss. */
  "recovering"
] as const;

export type EngineState = (typeof ENGINE_STATES)[number];

/**
 * Permitted transitions.
 *
 * `warning` is reachable from any working state and returns to it, because a
 * warning is a decoration on an operational state rather than a stage of its own.
 * `error` is reachable from everywhere, because anything can fail.
 *
 * `recovering` is reachable from every state that owns GPU resources, including
 * `on-air`: a device loss does not wait for a convenient moment, and an engine
 * that cannot leave `on-air` to recover would report itself healthy while
 * rendering nothing.
 */
export const ENGINE_STATE_TRANSITIONS: Readonly<Record<EngineState, readonly EngineState[]>> =
  Object.freeze({
    offline: ["discovering", "connecting", "error"],
    discovering: ["connecting", "offline", "error"],
    connecting: ["authenticating", "synchronising", "offline", "error"],
    authenticating: ["synchronising", "offline", "error"],
    synchronising: ["preparing", "ready", "offline", "error", "warning", "recovering"],
    preparing: ["ready", "offline", "error", "warning", "recovering"],
    ready: ["on-air", "synchronising", "preparing", "warning", "error", "recovering", "offline"],
    "on-air": ["ready", "warning", "error", "recovering", "offline"],
    warning: ["ready", "on-air", "synchronising", "preparing", "recovering", "error", "offline"],
    error: ["recovering", "offline", "connecting"],
    recovering: ["connecting", "synchronising", "preparing", "ready", "error", "offline"]
  });

export function canTransition(from: EngineState, to: EngineState): boolean {
  if (from === to) return true;
  return ENGINE_STATE_TRANSITIONS[from].includes(to);
}

/** States in which the engine is usable for rendering. */
export function isEngineOperational(state: EngineState): boolean {
  return state === "ready" || state === "on-air" || state === "warning";
}

/**
 * Whether the engine can be sent a message.
 *
 * Deliberately wider than `isEngineOperational`. An engine that is `preparing` or
 * `synchronising` is a healthy engine doing normal work on a live link, and a host
 * that treats those states as a lost connection tears down a socket that was fine —
 * then reconnects, sees `preparing` again, and never settles. `isEngineOperational`
 * answers a different question: whether the engine is ready to render.
 *
 * Excluded: `offline` and `error`, where there is nothing to send to, and the
 * pre-authentication states, where the handshake owns the socket.
 */
export function isEngineReachable(state: EngineState): boolean {
  return (
    state === "synchronising"
    || state === "preparing"
    || state === "ready"
    || state === "on-air"
    || state === "warning"
    || state === "recovering"
  );
}

/**
 * Whether a host should start reconnecting.
 *
 * Only the two states that mean the link is gone. Anything else is either normal
 * operation or a handshake already in progress.
 */
export function requiresReconnect(state: EngineState): boolean {
  return state === "offline" || state === "error";
}

/** States in which the engine is actively trying to become usable. */
export function isEngineTransitional(state: EngineState): boolean {
  return (
    state === "discovering"
    || state === "connecting"
    || state === "authenticating"
    || state === "synchronising"
    || state === "preparing"
    || state === "recovering"
  );
}

/** Whether a Take should be permitted. Program safety gate. */
export function canAcceptTake(state: EngineState): boolean {
  return state === "ready" || state === "on-air" || state === "warning";
}

export interface EngineStateChange {
  from: EngineState;
  to: EngineState;
  reason: string;
  atMs: number;
  /** True when the transition was refused and the state did not change. */
  rejected: boolean;
}

/**
 * Guarded state holder with a bounded history.
 *
 * Refuses illegal transitions rather than throwing: an engine client receiving a
 * nonsensical state from the wire must keep working, and the rejection is a
 * diagnostic rather than a crash.
 */
export class EngineStateMachine {
  private current: EngineState;
  private readonly history: EngineStateChange[] = [];
  private readonly historyLimit: number;

  constructor(initial: EngineState = "offline", historyLimit = 64) {
    this.current = initial;
    this.historyLimit = Math.max(1, historyLimit);
  }

  get state(): EngineState {
    return this.current;
  }

  get operational(): boolean {
    return isEngineOperational(this.current);
  }

  transition(to: EngineState, reason: string, atMs = 0): EngineStateChange {
    const from = this.current;
    const allowed = canTransition(from, to);

    const change: EngineStateChange = { from, to, reason, atMs, rejected: !allowed };
    if (allowed) {
      this.current = to;
    }

    this.history.push(change);
    if (this.history.length > this.historyLimit) {
      this.history.shift();
    }

    return change;
  }

  /**
   * Force a state regardless of the table.
   *
   * For the one legitimate case: the transport reporting a hard close, where the
   * previous state is simply no longer true whatever the table says.
   */
  force(to: EngineState, reason: string, atMs = 0): EngineStateChange {
    const change: EngineStateChange = { from: this.current, to, reason, atMs, rejected: false };
    this.current = to;
    this.history.push(change);
    if (this.history.length > this.historyLimit) {
      this.history.shift();
    }
    return change;
  }

  recentHistory(limit = 16): EngineStateChange[] {
    return this.history.slice(-Math.max(1, limit));
  }
}
