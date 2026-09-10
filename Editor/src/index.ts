// Editor. Status: Planned. Skeleton only.
//
// Owns mutable authoring content. Cannot change Program or outputs
// (invariant 4), and never imports renderer internals (invariant 3).

import type { TakeId, Revision } from "@grapix/contracts";

/** What the Editor hands to Playout when it publishes. Publishing is additive
 *  and all-or-nothing (invariant 30). */
export interface PublishResult {
  readonly takeId: TakeId;
  readonly revision: Revision;
}

export const status = "Planned" as const;
