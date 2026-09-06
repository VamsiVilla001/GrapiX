import type { GroupSceneObject, LayerSceneObject, SceneObject } from "@grapix/shared-types";

/**
 * What may contain what, and what already contains what.
 *
 * These four rules decide every hierarchy question in the Editor: whether a row can accept a child,
 * whether an adoption would make a cycle, and which objects travel with a container when it moves.
 * They live in their own pure module because two callers need them — `editorStore`, which enforces
 * them at the point of mutation, and the Object Manager's drop resolver, which must refuse an illegal
 * drop *while the pointer is over it* rather than after the fact.
 *
 * A private copy in the panel is the failure this file prevents. The Editor has already shipped that
 * defect once with per-type property support: two copies drifted, and the panel offered controls the
 * renderer ignored. A drop indicator that says "yes" where the store says "no" is the same bug with a
 * worse symptom — the author drags, releases, and nothing happens.
 */

export type ContainerSceneObject = LayerSceneObject | GroupSceneObject;

export function isContainerObject(object: SceneObject): object is ContainerSceneObject {
  return object.type === "layer" || object.type === "group";
}

/**
 * Whether this container accepts this child.
 *
 * A group takes anything. A layer object is typed: a camera layer holds cameras and only cameras, and
 * an object layer holds everything except cameras — mixing them would put a camera in a compositing
 * band that never renders it.
 */
export function isAllowedContainerChild(container: ContainerSceneObject, child: SceneObject): boolean {
  if (container.type === "group") {
    return true;
  }
  return container.layerKind === "camera" ? child.type === "camera" : child.type !== "camera";
}

/**
 * Whether `soughtId` is `containerId` or lives somewhere beneath it.
 *
 * The cycle guard: adopting an object into its own descendant would detach the subtree from the
 * scene. `visited` is not an optimisation — a legacy scene can carry a malformed cyclic group, and
 * without it this recurses forever on one.
 */
export function containerContains(objects: readonly SceneObject[], containerId: string, soughtId: string): boolean {
  const byId = new Map(objects.map((object) => [object.id, object]));
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (id === soughtId) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    const object = byId.get(id);
    if (!object || !isContainerObject(object)) return false;
    return object.childIds.some(visit);
  };
  return visit(containerId);
}

/** Every id in a container's subtree, including its own. What travels when the container moves. */
export function collectContainerSubtreeIds(objects: readonly SceneObject[], rootId: string): Set<string> {
  const byId = new Map(objects.map((object) => [object.id, object]));
  const collected = new Set<string>();
  const visit = (id: string): void => {
    if (collected.has(id)) return;
    collected.add(id);
    const object = byId.get(id);
    if (!object || !isContainerObject(object)) return;
    object.childIds.forEach(visit);
  };
  visit(rootId);
  return collected;
}

/**
 * The container that holds this object, if any.
 *
 * Parentage is expressed by `childIds` alone — an object carries no parent pointer — so finding a
 * parent is a scan. The first container claiming the id wins; a legacy scene with two parents for one
 * child is malformed, and picking one keeps the tree walkable instead of throwing.
 */
export function parentOfObject(objects: readonly SceneObject[], objectId: string): ContainerSceneObject | undefined {
  return objects.find(
    (object): object is ContainerSceneObject => isContainerObject(object) && object.childIds.includes(objectId)
  );
}
