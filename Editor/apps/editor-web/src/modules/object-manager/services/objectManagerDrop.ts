import type { SceneObject } from "@grapix/shared-types";
import {
  collectContainerSubtreeIds,
  containerContains,
  isAllowedContainerChild,
  isContainerObject,
  parentOfObject
} from "../../../store/objectHierarchy";

/**
 * Where a dragged row would land, decided while the pointer is still over the target.
 *
 * Every refusal is resolved on hover, not after the drop. A gesture that lets you release and then
 * quietly does nothing teaches an author that the panel is broken — which is exactly what the
 * Inspector's parent checkbox does today: it lists every object as a candidate parent, ignores
 * `setContainerChild` returning `false`, and says nothing.
 *
 * The legality rules are imported, never restated. `store/objectHierarchy.ts` is the one definition
 * the store enforces at the point of mutation, so an indicator can never promise a drop the store
 * will refuse.
 */

export type DropKind = "before" | "after" | "into" | "into-layer" | "noop" | "invalid";

export interface DropTarget {
  /** An object row, a layer band row, or the scene row / the space below the last row. */
  kind: "object" | "layer" | "scene";
  /** Object id for an object row, `layerId` for a band, the band's id for the scene row. */
  id: string;
}

export interface DropResolution {
  kind: DropKind;
  /**
   * The row the result is measured against: the sibling for `before`/`after`, the container for
   * `into`, the band for `into-layer`. Absent for `noop` and `invalid`.
   */
  targetId?: string;
  /**
   * Tree depth the dragged objects will land at, so the insertion line can be indented to it. The
   * line's left edge is then the answer to "which parent", which is the only unambiguous way to show
   * a reparent in a list.
   */
  depth: number;
  /** Why a drop is refused, in the words the author sees. */
  reason?: string;
}

/** The zone boundaries, as fractions of the row's measured height. */
const EDGE_FRACTION = 0.25;

/** Depth of an object in the tree, counting containers above it. */
export function depthOfObject(objects: readonly SceneObject[], objectId: string): number {
  let depth = 0;
  const guard = new Set<string>();
  let parent = parentOfObject(objects, objectId);
  while (parent && !guard.has(parent.id)) {
    guard.add(parent.id);
    depth += 1;
    parent = parentOfObject(objects, parent.id);
  }
  return depth;
}

/**
 * Everything that travels with the dragged ids: the ids themselves and every descendant.
 *
 * Used for both refusals. A target inside this set would make a cycle, and a **locked descendant**
 * makes the whole drop illegal — `setContainerChild` rewrites every descendant's `layerId` with no
 * lock check of its own, so dragging an unlocked group would quietly move a locked child with it.
 */
export function draggedSubtree(objects: readonly SceneObject[], draggedIds: readonly string[]): Set<string> {
  const all = new Set<string>();
  for (const id of draggedIds) {
    for (const member of collectContainerSubtreeIds(objects, id)) all.add(member);
  }
  return all;
}

/**
 * Resolve a hover into a drop.
 *
 * `pointerFraction` is the pointer's position down the target row, 0 at its top edge and 1 at its
 * bottom. The top and bottom quarters are always `before`/`after`; the middle half is `into` for a
 * container and, for a leaf, the nearer of the two — a leaf has no dead zone, because a gesture that
 * does nothing in the middle of a row feels like a broken target rather than a considered refusal.
 */
export function resolveDrop(
  objects: readonly SceneObject[],
  draggedIds: readonly string[],
  target: DropTarget,
  pointerFraction: number
): DropResolution {
  if (draggedIds.length === 0) return { kind: "noop", depth: 0 };

  const moving = draggedSubtree(objects, draggedIds);
  const dragged = draggedIds
    .map((id) => objects.find((object) => object.id === id))
    .filter((object): object is SceneObject => Boolean(object));
  if (dragged.length === 0) return { kind: "invalid", depth: 0, reason: "The dragged objects are no longer in the scene" };

  const locked = [...moving]
    .map((id) => objects.find((object) => object.id === id))
    .find((object) => object?.locked);
  if (locked) {
    return {
      kind: "invalid",
      depth: 0,
      reason: draggedIds.includes(locked.id)
        ? `${locked.name} is locked`
        : `${locked.name} is locked, inside what you are moving`
    };
  }

  if (target.kind === "layer") return resolveLayerDrop(objects, dragged, target.id);
  if (target.kind === "scene") return resolveSceneRowDrop(objects, dragged, target.id);

  const targetObject = objects.find((object) => object.id === target.id);
  if (!targetObject) return { kind: "invalid", depth: 0, reason: "That row is no longer in the scene" };

  // A target inside the moving set has nowhere to go: `into` would detach the subtree from the scene,
  // and a sibling placement would need a parent that is itself moving.
  if (moving.has(targetObject.id)) {
    return draggedIds.includes(targetObject.id)
      ? { kind: "noop", depth: 0 }
      : { kind: "invalid", depth: 0, reason: `${targetObject.name} is inside what you are moving` };
  }

  const targetDepth = depthOfObject(objects, targetObject.id);
  const wantsInto = pointerFraction > EDGE_FRACTION
    && pointerFraction < 1 - EDGE_FRACTION
    && isContainerObject(targetObject);

  if (wantsInto) {
    if (targetObject.locked) {
      return { kind: "invalid", depth: targetDepth + 1, reason: `${targetObject.name} is locked` };
    }
    const rejected = dragged.find((object) => !isAllowedContainerChild(targetObject, object));
    if (rejected) {
      return {
        kind: "invalid",
        depth: targetDepth + 1,
        reason: targetObject.type === "layer" && targetObject.layerKind === "camera"
          ? "A camera layer holds cameras only"
          : `${targetObject.name} cannot hold ${rejected.name}`
      };
    }
    for (const object of dragged) {
      if (isContainerObject(object) && containerContains(objects, object.id, targetObject.id)) {
        return { kind: "invalid", depth: targetDepth + 1, reason: "A group cannot be moved inside itself" };
      }
    }
    // Already its children, in a container that is already their parent: nothing to do. Calm, not an
    // error — an author who put something back has not made a mistake.
    if (dragged.every((object) => targetObject.childIds.includes(object.id))) {
      return { kind: "noop", depth: targetDepth + 1 };
    }
    return { kind: "into", targetId: targetObject.id, depth: targetDepth + 1 };
  }

  const placement = pointerFraction < 0.5 ? "before" : "after";
  const parent = parentOfObject(objects, targetObject.id);
  if (parent) {
    if (moving.has(parent.id)) {
      return { kind: "invalid", depth: targetDepth, reason: `${parent.name} is inside what you are moving` };
    }
    const rejected = dragged.find((object) => !isAllowedContainerChild(parent, object));
    if (rejected) {
      return {
        kind: "invalid",
        depth: targetDepth,
        reason: parent.type === "layer" && parent.layerKind === "camera"
          ? "A camera layer holds cameras only"
          : `${parent.name} cannot hold ${rejected.name}`
      };
    }
  }

  return { kind: placement, targetId: targetObject.id, depth: targetDepth };
}

/** A band row: detach from any parent and move to the top of that compositing layer. */
function resolveLayerDrop(
  objects: readonly SceneObject[],
  dragged: readonly SceneObject[],
  layerId: string
): DropResolution {
  const rejected = dragged.find((object) => {
    const band = objects.find(
      (candidate) => candidate.type === "layer" && candidate.layerId === layerId && candidate.id === layerId
    );
    return band && isContainerObject(band) ? !isAllowedContainerChild(band, object) : false;
  });
  if (rejected) {
    return { kind: "invalid", depth: 0, reason: `That layer cannot hold ${rejected.name}` };
  }
  // Already loose in this band: the drop would change nothing.
  if (dragged.every((object) => object.layerId === layerId && !parentOfObject(objects, object.id))) {
    return { kind: "noop", depth: 0 };
  }
  return { kind: "into-layer", targetId: layerId, depth: 0 };
}

/** The scene row, or the space under the last row of a band: place after that band's last root. */
function resolveSceneRowDrop(
  objects: readonly SceneObject[],
  dragged: readonly SceneObject[],
  layerId: string
): DropResolution {
  const roots = objects.filter(
    (object) => object.layerId === layerId && !parentOfObject(objects, object.id)
  );
  const last = roots.at(-1);
  if (!last || dragged.some((object) => object.id === last.id)) {
    return resolveLayerDrop(objects, dragged, layerId);
  }
  return { kind: "after", targetId: last.id, depth: 0 };
}
