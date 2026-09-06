import { getMaterialBindingId, type SceneObject } from "@grapix/shared-types";
import { collectContainerSubtreeIds, parentOfObject } from "../../../store/objectHierarchy";

/**
 * Which objects a search shows: the matches, the containers above them, and everything inside a
 * matched container.
 *
 * Filtering the flat list — which is what the panel used to do — broke the tree twice over: a matched
 * group appeared with no children, so it read as empty, and a matched child of a non-matching group
 * was promoted to a root, so the panel reported a parentage the scene did not have. That was merely
 * confusing while the list was read-only. With drag-and-drop it is a trap, because the author drops
 * against a structure that is not there.
 *
 * Ancestors come along to keep a match in its place. Descendants of a matched container come along
 * because searching for a group means "show me that group", and a group drawn without its contents is
 * a different object.
 */
export function expandSearchMatches(objects: readonly SceneObject[], search: string): Set<string> {
  const needle = search.trim().toLowerCase();
  if (!needle) return new Set(objects.map((object) => object.id));

  const known = new Set(objects.map((object) => object.id));
  const visible = new Set<string>();

  for (const object of objects) {
    if (!matchesSearch(object, needle)) continue;
    for (const id of collectContainerSubtreeIds(objects, object.id)) visible.add(id);

    // Walk up by scanning for the container that claims each id: objects carry no parent pointer.
    // The guard is not an optimisation — a legacy scene can hold a cyclic group, and without it this
    // never terminates on one.
    let ancestor = parentOfObject(objects, object.id);
    const seen = new Set<string>();
    while (ancestor && !seen.has(ancestor.id)) {
      seen.add(ancestor.id);
      visible.add(ancestor.id);
      ancestor = parentOfObject(objects, ancestor.id);
    }
  }

  // A malformed container can name a child that does not exist; keep only ids the scene really has.
  return new Set([...visible].filter((id) => known.has(id)));
}

/** The text a row is searched by: its name, its kind, its band, and its primary material. */
function matchesSearch(object: SceneObject, needle: string): boolean {
  return `${object.name} ${object.type} ${object.layerId} ${
    getMaterialBindingId(object.materialSlots.main) ?? ""
  }`.toLowerCase().includes(needle);
}
