// The material manager (build plan 11.12).
//
// Done when: shared instances, relink, usage lookup.
//
// **Usage is computed, never stored.** A stored index is a second
// representation of the same fact, and it drifts the moment an object is
// edited by anything that forgets to update it — the same reasoning the MCP
// `materials.usage` handler gives. The document is the truth; this reads it.
//
// **A shared material is marked as shared, with its count.** Editing one is
// not a local act: it changes every object bound to it. An author who thinks
// they are adjusting one lower-third and is in fact restyling the whole
// rundown has been failed by the interface, not by their own carelessness.
//
// **Relink previews before it commits.** `relinkMaterial` returns the object
// ids that would change, so the author is shown the blast radius first. A
// blind repoint across an unknown number of objects is the operation nobody
// can safely confirm.

import type { SceneDocument, SceneObject } from "@grapix/contracts";

import type { UiNode } from "./agent-surface";

export interface MaterialManagerState {
  readonly selectedMaterialId?: string;
}

/// The object ids bound to a material, in document order.
///
/// A material reaches an object through a named slot, so an object may use
/// several and is counted once per material.
export function usersOf(document: SceneDocument, materialId: string): string[] {
  return document.objects
    .filter((object) => boundMaterials(object).includes(materialId))
    .map((object) => object.id);
}

function boundMaterials(object: SceneObject): string[] {
  const slots = object.materialSlots;
  if (!slots) return [];
  return Object.values(slots)
    .filter((binding): binding is { materialId: string } => Boolean(binding))
    .map((binding) => binding.materialId);
}

/// The object ids a relink would change, without changing anything.
///
/// Returns them rather than performing the edit so a caller can show the
/// consequence and let the author decide. Empty means the relink would be a
/// no-op, which is worth saying out loud rather than reporting as success.
export function relinkMaterial(
  document: SceneDocument,
  fromMaterialId: string,
  toMaterialId: string,
): string[] {
  if (fromMaterialId === toMaterialId) return [];
  return usersOf(document, fromMaterialId);
}

export function materialManagerPanel(
  document: SceneDocument,
  state: MaterialManagerState = {},
): UiNode {
  const items: UiNode[] = document.materials.map((material) => {
    const users = usersOf(document, material.materialId);
    const shared = users.length > 1;

    return {
      id: `material/${material.materialId}`,
      role: "listitem",
      label: material.name,
      // The count is the warning. "Shared by 7 objects" is the sentence that
      // stops an author editing the wrong thing.
      description: shared
        ? `shared by ${users.length} objects`
        : users.length === 1
          ? "used by 1 object"
          : "unused",
      selected: state.selectedMaterialId === material.materialId,
      value: material.kind,
      actions: [
        {
          name: "edit",
          label: "Edit",
          // Not blocked — editing a shared material is legitimate and common.
          // The panel's job is to make sure it is never a surprise.
        },
        { name: "relink", label: "Relink" },
        {
          name: "delete",
          label: "Delete",
          ...(users.length === 0
            ? {}
            : {
                unavailable: `${material.name} is used by ${users.length} object(s)`,
              }),
        },
      ],
      children: [
        {
          id: `material/${material.materialId}/usage`,
          role: "gridcell",
          label: "Used by",
          value: users.length === 0 ? "nothing" : users.join(", "),
        },
      ],
    };
  });

  return {
    id: "material-manager",
    role: "region",
    label: "Materials",
    description: `${document.materials.length} material(s) in ${document.name}`,
    children: [
      { id: "material-manager/list", role: "list", label: "Materials", children: items },
    ],
  };
}
