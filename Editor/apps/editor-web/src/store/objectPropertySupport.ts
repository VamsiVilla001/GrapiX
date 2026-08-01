import type { SceneObject, SceneProperty } from "@grapix/shared-types";

/**
 * Which properties are bindable on which kind of object — one definition.
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
 */
export const BINDABLE_PROPERTIES: readonly SceneProperty[] = [
  "text",
  "src",
  "fill",
  "stroke",
  "visible",
  "x",
  "y",
  "zDepth",
  "width",
  "height",
  "rotation",
  "rotationX",
  "rotationY",
  "rotationZ",
  "scaleX",
  "scaleY",
  "scaleZ",
  "opacity"
];

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

    // Depth scale reaches a mesh either directly or through a container that inherits it.
    case "scaleZ":
      return object.type === "mesh" || object.type === "layer" || object.type === "group";

    default:
      return true;
  }
}

/** The bindable properties that apply to one object, in declaration order. */
export function bindablePropertiesFor(object: SceneObject): SceneProperty[] {
  return BINDABLE_PROPERTIES.filter((property) => isPropertySupported(object, property));
}
