// Playout. Status: Planned — no shell yet, but the control-surface logic for
// ADR-002 is real and typechecked.
//
// The only client allowed to Cue, Take, Continue, Clear Program or configure
// outputs (invariant 5). Its control surface is intent-based: it asks for a
// frame or the next opportunity and displays what the engine committed to.

import type { TakeAt, TakeId, Revision } from "@grapix/contracts";

export * from "./clock-display";

/** Exactly what an operator action carries. Note the absence of a timestamp:
 *  Playout never sends a time (invariant 8). */
export interface OperatorTake {
  readonly takeId: TakeId;
  readonly revision: Revision;
  readonly at: TakeAt;
}

/** Build a take request. There is no overload that accepts a time, because
 *  there is no such request to build. */
export function requestTake(
  takeId: TakeId,
  revision: Revision,
  at: TakeAt = { at: "nextOpportunity" },
): OperatorTake {
  return { takeId, revision, at };
}

export const status = "Planned" as const;
