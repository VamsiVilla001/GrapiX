// Surfacing clock state to the operator (ADR-002 action 3).
//
// "Unmissably" is a UI claim, and a UI claim needs a mechanism behind it or it
// is only an intention. The mechanism here is that every display field is
// *derived* from the engine's reported status, and the derivation refuses to
// produce a quiet presentation for a state that is not locked.
//
// Types come from @grapix/contracts, generated from Rust (invariant 22), so
// this file cannot drift from what the engine actually reports.

import type {
  ClockSummary,
  EngineStatus,
  Severity,
  TakeCommitted,
  RationalRate,
} from "@grapix/contracts";

/** How prominent the clock indicator must be. Not a colour: a requirement. */
export type Prominence = "quiet" | "persistent" | "blocking";

/** What the operator sees about the clock. Every field is mandatory — an
 *  optional warning is a warning that can be forgotten. */
export interface ClockIndicator {
  readonly label: string;
  readonly severity: Severity;
  readonly prominence: Prominence;
  /** Frame rate as a display string, from the exact rational. */
  readonly rate: string;
  /** True when Program cadence has no external reference. */
  readonly freeRunning: boolean;
  /** Whether the operator must acknowledge before configuring live output. */
  readonly requiresAcknowledgement: boolean;
}

/** Render an exact rational as an operator-facing rate.
 *
 *  29.97 and 59.94 are shown the way a broadcast engineer says them, but the
 *  value carried in the contract stays 30000/1001 (invariant 12). This is the
 *  only place a rate becomes lossy, and it is lossy only on screen. */
export function formatRate(rate: RationalRate): string {
  if (rate.den === 1) return `${rate.num}`;
  const decimal = rate.num / rate.den;
  // Two places covers every broadcast rate in use; more would be noise.
  return decimal.toFixed(2).replace(/\.00$/, "");
}

/** Map severity to how hard the UI must push.
 *
 *  Deliberately total over Severity: adding a severity forces a decision here
 *  rather than silently defaulting to "quiet". */
function prominenceFor(severity: Severity): Prominence {
  switch (severity) {
    case "Nominal":
      return "quiet";
    case "Warning":
      // Free-run is a Warning, and it stays on screen for the whole show. It
      // is never a toast that disappears.
      return "persistent";
    case "Critical":
      return "blocking";
  }
}

/** Build the operator indicator from the engine's summary.
 *
 *  Takes the engine's `ClockSummary` rather than recomputing severity from
 *  status: severity is decided once, on the engine side, so Playout and any
 *  other surface cannot disagree about how alarming a state is. */
export function clockIndicator(summary: ClockSummary): ClockIndicator {
  const prominence = prominenceFor(summary.severity);
  return {
    label: summary.label,
    severity: summary.severity,
    prominence,
    rate: formatRate(summary.timebase),
    freeRunning: summary.freeRunning,
    // Anything not locked to a reference has to be acknowledged before it can
    // reach an audience. The engine enforces this too; showing it here is what
    // lets the operator understand the refusal they are about to get.
    requiresAcknowledgement: summary.freeRunning,
  };
}

/** What the operator sees after asking for a take.
 *
 *  The committed frame is not optional. Intent-based control is only honest if
 *  the operator can see which frame the engine actually chose (ADR-002). */
export interface TakeFeedback {
  readonly committedFrame: string;
  readonly rate: string;
  readonly clock: string;
  /** True when the commitment was made on a clock with no reference, so the
   *  frame number is precise but its wall-clock timing is not guaranteed. */
  readonly onFreeRunningClock: boolean;
}

export function takeFeedback(committed: TakeCommitted): TakeFeedback {
  return {
    committedFrame: `${committed.frame}`,
    rate: formatRate(committed.timebase),
    clock: committed.clock,
    onFreeRunningClock: committed.clock === "FreeRun",
  };
}

/** Whether the live-output control may be enabled.
 *
 *  Mirrors the engine's gate rather than reimplementing it: the answer is
 *  taken from `status.liveAllowed` and the reported degradations, both of
 *  which the engine computed. Playout's job is to not offer a button whose
 *  press it knows will be refused. */
export function liveControlEnabled(status: EngineStatus): boolean {
  if (!status.liveAllowed) return false;
  return !status.degradations.some(
    (d) => d.degradation === "referenceLost" || d.degradation === "deviceBelowT0",
  );
}
