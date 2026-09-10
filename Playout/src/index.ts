// Playout. Status: Planned. Skeleton only.
//
// The only client allowed to Cue, Take, Continue, Clear Program or configure
// outputs (invariant 5). Its control surface is intent-based: it asks for a
// frame or the next opportunity and displays what the engine committed to.

import type { TakeAt, TakeCommitted, TakeId, Revision } from "@grapix/contracts";

/** Exactly what an operator action carries. Note the absence of a timestamp:
 *  Playout never sends a time (invariant 8). */
export interface OperatorTake {
  readonly takeId: TakeId;
  readonly revision: Revision;
  readonly at: TakeAt;
}

/** What the operator must be shown afterwards: the frame the engine chose,
 *  and which clock it was in. */
export type TakeOutcome = TakeCommitted;

export const status = "Planned" as const;
