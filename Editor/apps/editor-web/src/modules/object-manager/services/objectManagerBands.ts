import type { SceneObject } from "@grapix/shared-types";

/**
 * What a band's header reports about the band.
 *
 * Read from the **whole** layer, never from the rows currently on screen. The panel used to reduce
 * these over its search-filtered list while `setLayerVisibility` and `setLayerLocked` write every
 * object in the layer — so under an active search the eye and the lock reported one thing and did
 * another, which is worse than either being wrong consistently.
 */
export interface BandAggregate {
  /** Objects in the band, filtered or not. */
  count: number;
  /** True when anything in the band is visible; the eye toggles the band toward the opposite. */
  visible: boolean;
  /** True only when everything in the band is locked, so a half-locked band reads as unlocked. */
  locked: boolean;
}

export function bandAggregate(objects: readonly SceneObject[], layerId: string): BandAggregate {
  const members = objects.filter((object) => (object.layerId || "main") === layerId);
  return {
    count: members.length,
    visible: members.some((object) => object.visible),
    // An empty band is not "all locked": `every` on an empty list is true, which would show a lock on
    // a band with nothing in it.
    locked: members.length > 0 && members.every((object) => object.locked)
  };
}
