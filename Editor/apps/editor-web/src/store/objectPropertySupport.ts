import { BINDABLE_SCENE_PROPERTIES, isBindingAssignable } from "@grapix/shared-types";
import type { SceneObject, SceneProperty } from "@grapix/shared-types";

/**
 * Which properties a renderer consumes on which kind of object — one definition.
 *
 * The Inspector and the Data Binding tab each carried a private copy of this rule and they had
 * already drifted: the Inspector offered `rotationX`/`rotationY`/`rotationZ` on layers and
 * groups, the Data Binding tab offered them on meshes only. Both were partly wrong.
 *
 * The rule is what a renderer actually consumes, not what the contract declares.
 * `resolveSceneObjectHierarchy` inherits `scaleZ` but never `rotationX`/`rotationY`, and it reads
 * `rotationZ` from meshes alone (`object.type === "mesh" ? object.rotationZ ?? object.rotation :
 * object.rotation`). So a binding on a layer's `rotationX` moved nothing at all — an authored
 * option nothing honours, which is the defect rule 82 exists to prevent.
 *
 * The **list** of bindable properties is no longer here: it is `BINDABLE_SCENE_PROPERTIES` in
 * `@grapix/shared-types`, next to the applier that honours it. A local copy is how the panel came to
 * advertise a binding the applier refuses.
 */
export function isPropertySupported(object: SceneObject, property: SceneProperty): boolean {
  switch (property) {
    case "text":
      return object.type === "text";

    case "src":
      return object.type === "image";

    // Three-axis rotation is mesh-only. Containers pass their Z rotation down through
    // `rotation`; they have no X/Y axes to inherit and no geometry of their own to turn.
    case "rotationX":
    case "rotationY":
    case "rotationZ":
      return object.type === "mesh";

    // A mesh's Z rotation lives on `rotationZ`, so offering `rotation` beside it would be two
    // controls for one angle.
    case "rotation":
      return object.type !== "mesh";

    // Depth scale reaches a mesh either directly or through a container that inherits it. Measured:
    // setting a layer's `scaleZ` to 5 and resolving the hierarchy gives its mesh child `scaleZ` 5, so
    // the *column* is right to offer it.
    case "scaleZ":
      return object.type === "mesh" || object.type === "layer" || object.type === "group";

    default:
      return true;
  }
}

/**
 * The bindable properties that apply to one object, in declaration order.
 *
 * Two questions, not one. `isPropertySupported` answers "does a renderer consume this property on this
 * type", which is what the Object Manager's columns need. A binding needs a second answer as well:
 * **can the binding applier write it at all.** `assignBoundValue` guards `rotationX`/`rotationY`/
 * `rotationZ`/`scaleZ` behind `object.type === "mesh"`, so a layer's `scaleZ` binding resolved, passed
 * its type check, and was dropped — while the same property edited by hand worked, because hierarchy
 * inheritance is a different mechanism from binding assignment. One predicate for both questions is
 * how the panel came to advertise an option nothing honours.
 *
 * Reordering the pipeline would not have fixed it: with bindings applied before hierarchy the layer's
 * `scaleZ` is *still* never written, so the child still does not move. Both halves would have to
 * change, and the native renderer resolves no bindings at all, so the pair could not agree. The row
 * goes, which is what `docs/object-inspector-plan.md` names as the outcome when it cannot.
 */
export function bindablePropertiesFor(object: SceneObject): SceneProperty[] {
  return BINDABLE_SCENE_PROPERTIES.filter((property) =>
    isPropertySupported(object, property) && isBindingAssignable(object, property)
  );
}
