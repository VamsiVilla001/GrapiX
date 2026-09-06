import type { SceneObjectType } from "./index.js";

/**
 * The range and unit of every numeric property an author can type into — one definition.
 *
 * The defect this closes: the Inspector's number fields passed `Number(event.target.value)` straight
 * through, while the renderers clamped on read. Type `500` into a spot light's cone angle and the scene
 * **saved 500**, the field **showed 500**, and Preview drew 179 — three numbers for one property, with
 * nothing to tell the author which one was real. `min`/`max` attributes on the input were decoration: a
 * browser hint that blocks the spinner and not a paste, and that the store never consulted.
 *
 * So the clamp moves to the mutation boundary and the values come from here. They are transcribed from
 * what the renderers actually do — `ThreeSceneLayer.ts` for camera and light, `slabGeometry.ts` for the
 * slab — and `Shared/shared-types/tests/property-constraints.test.mjs` holds them to it.
 *
 * **`unit` is not decoration either.** "Cone 45" says nothing; "Cone 45°" says which 45. Every field
 * that has a unit states it, which is how an author knows `scaleX` is a multiplier and `zDepth` is
 * pixels without opening the documentation.
 */

export interface PropertyConstraint {
  min?: number;
  max?: number;
  /** How much one step of a scrub or a spinner is worth. */
  step: number;
  /** Shown after the label. Absent means the number is unitless — a count, a multiplier. */
  unit?: string;
  /** Used when the authored value is not a finite number. */
  fallback: number;
}

/** Applies to every object type unless a type-specific entry overrides it. */
const ANY_TYPE: Readonly<Record<string, PropertyConstraint>> = {
  x: { step: 0.1, unit: "px", fallback: 0 },
  y: { step: 0.1, unit: "px", fallback: 0 },
  zDepth: { step: 0.1, unit: "px", fallback: 0 },
  width: { min: 0, step: 0.1, unit: "px", fallback: 0 },
  height: { min: 0, step: 0.1, unit: "px", fallback: 0 },
  rotation: { step: 0.1, unit: "°", fallback: 0 },
  rotationX: { step: 0.1, unit: "°", fallback: 0 },
  rotationY: { step: 0.1, unit: "°", fallback: 0 },
  rotationZ: { step: 0.1, unit: "°", fallback: 0 },
  scaleX: { step: 0.01, unit: "×", fallback: 1 },
  scaleY: { step: 0.01, unit: "×", fallback: 1 },
  scaleZ: { step: 0.01, unit: "×", fallback: 1 },
  // Stored 0..1; the Object Manager's Alpha column displays it as a percentage.
  opacity: { min: 0, max: 1, step: 0.01, fallback: 1 },
  strokeWidth: { min: 0, step: 0.1, unit: "px", fallback: 0 }
};

const BY_TYPE: Readonly<Partial<Record<SceneObjectType, Readonly<Record<string, PropertyConstraint>>>>> = {
  camera: {
    // `ThreeSceneLayer.ts:359` — a perspective camera's field of view.
    fov: { min: 1, max: 179, step: 1, unit: "°", fallback: 50 },
    // `:355` — the zoom the renderer will accept.
    zoom: { min: 0.01, max: 100, step: 0.01, unit: "×", fallback: 1 },
    /*
     * `:353-354`. The renderer keeps `far` at least `MIN_CAMERA_FAR_SPAN` beyond `near`, which is a
     * *relationship* between two properties and therefore cannot live in a per-property row. The store
     * enforces the ordering after clamping each; see `normalizeCameraPlanes`.
     */
    near: { min: 0.001, step: 1, unit: "px", fallback: 1 },
    far: { min: 0.002, step: 10, unit: "px", fallback: 20000 }
  },
  light: {
    // `:413` — intensity and range are floored, not capped: a brighter light is legitimate.
    intensity: { min: 0, step: 0.1, fallback: 1 },
    range: { min: 0, step: 1, unit: "px", fallback: 0 },
    decay: { min: 0, step: 0.1, fallback: 2 },
    // `:446` — a cone wider than 179° is not a cone.
    coneAngleDeg: { min: 1, max: 179, step: 1, unit: "°", fallback: 45 },
    // `:450` — penumbra is a 0..1 fraction of the cone.
    penumbra: { min: 0, max: 1, step: 0.05, fallback: 0.25 }
  },
  mesh: {
    // A mesh with no extrusion is a plane, which is a different object; `slabGeometry.ts` floors it.
    depth: { min: 0.01, step: 1, unit: "px", fallback: 100 }
  },
  text: {
    fontSize: { min: 1, step: 1, unit: "px", fallback: 48 },
    lineHeight: { min: 0, step: 0.1, unit: "px", fallback: 0 },
    letterSpacing: { step: 0.1, unit: "px", fallback: 0 },
    wordSpacing: { step: 0.1, unit: "px", fallback: 0 },
    paragraphSpacing: { min: 0, step: 1, unit: "px", fallback: 0 },
    textIndent: { step: 1, unit: "px", fallback: 0 }
  },
  rect: {
    radius: { min: 0, step: 1, unit: "px", fallback: 0 }
  }
};

/** The constraint for one property of one object type, or undefined when it is unconstrained. */
export function propertyConstraint(
  objectType: SceneObjectType,
  property: string
): PropertyConstraint | undefined {
  return BY_TYPE[objectType]?.[property] ?? ANY_TYPE[property];
}

/**
 * How much one pixel of a scrub, or one press of a spinner, is worth for this property.
 *
 * The defect this closes: both panels edit `x`, and both decided the step themselves — the Object
 * Manager's grid with an inline `column.startsWith("scale") ? 0.01 : 0.1`, the Inspector's animated
 * field with `props.step ?? 1`. So the same 27-pixel drag on the same property moved the object 2.7px
 * in one panel and 27px in the other. A step is a property of the property, not of the widget.
 *
 * Unconstrained properties step by 1, which is what an integer count wants.
 */
export function propertyStep(objectType: SceneObjectType, property: string): number {
  return propertyConstraint(objectType, property)?.step ?? 1;
}

/**
 * Bring an authored number inside what the renderers will accept.
 *
 * A non-finite value becomes the fallback rather than being stored: `NaN` in a transform propagates
 * through every matrix that touches it and the object disappears with no error anywhere.
 */
export function normalizePropertyValue(
  objectType: SceneObjectType,
  property: string,
  value: unknown
): number | undefined {
  const constraint = propertyConstraint(objectType, property);
  if (!constraint) return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) return constraint.fallback;
  const floored = constraint.min === undefined ? value : Math.max(constraint.min, value);
  return constraint.max === undefined ? floored : Math.min(constraint.max, floored);
}

/**
 * Keep a camera's clipping planes in order.
 *
 * The one cross-property rule in this file, and it cannot be expressed as a per-property range: the
 * renderer pushes `far` beyond `near` on read (`ThreeSceneLayer.ts:354`), so an authored pair with
 * `far <= near` saves one thing and draws another. Enforced after each plane is clamped.
 */
export const MIN_CAMERA_FAR_SPAN = 0.001;

export function normalizeCameraPlanes(near: number, far: number): { near: number; far: number } {
  const safeNear = normalizePropertyValue("camera", "near", near) ?? 1;
  const safeFar = normalizePropertyValue("camera", "far", far) ?? 20000;
  return safeNear + MIN_CAMERA_FAR_SPAN > safeFar
    ? { near: safeNear, far: safeNear + MIN_CAMERA_FAR_SPAN }
    : { near: safeNear, far: safeFar };
}

/**
 * Keep a slab's bevels inside the box they are cut from.
 *
 * The second cross-property rule, and the same shape of defect as the clipping planes. Both renderers
 * clamp a bevel on read — `slabGeometry.ts:50-66` limits each `size` to half the smaller face dimension
 * and each `depth` to the extrusion, then scales **both** depths down proportionally when their sum
 * exceeds it — so a 500-unit bevel depth on a 100-deep slab saved 500, showed 500, and drew 50. The
 * proportional scale is what makes this a relationship: neither depth can be judged without the other.
 *
 * Transcribed from the renderer, and `property-constraints.test.mjs` holds this to it.
 */
export function normalizeSlabBevels(
  geometry: { width: number; height: number; depth: number },
  front: { enabled: boolean; size: number; depth: number },
  back: { enabled: boolean; size: number; depth: number }
): {
  front: { enabled: boolean; size: number; depth: number };
  back: { enabled: boolean; size: number; depth: number };
} {
  const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);
  // `slabGeometry.ts:43` — a slab with no extrusion is a plane, so the floor is the same one there.
  const extrusion = Math.max(0.01, finite(geometry.depth, 0.01));
  const maxSize = Math.min(finite(geometry.width, 0), finite(geometry.height, 0)) / 2 - 0.001;
  const sizeOf = (bevel: { enabled: boolean; size: number }) =>
    bevel.enabled ? Math.min(Math.max(0, finite(bevel.size, 0)), Math.max(0, maxSize)) : 0;
  const depthOf = (bevel: { enabled: boolean; depth: number }) =>
    bevel.enabled ? Math.min(Math.max(0, finite(bevel.depth, 0)), extrusion) : 0;
  const frontDepth = depthOf(front);
  const backDepth = depthOf(back);
  const total = frontDepth + backDepth;
  const scale = total > extrusion ? extrusion / total : 1;
  return {
    front: { enabled: front.enabled, size: sizeOf(front), depth: frontDepth * scale },
    back: { enabled: back.enabled, size: sizeOf(back), depth: backDepth * scale }
  };
}

/** A label with its unit, so a bare number cannot be misread. */
export function labelWithUnit(label: string, objectType: SceneObjectType, property: string): string {
  const unit = propertyConstraint(objectType, property)?.unit;
  return unit ? `${label} (${unit})` : label;
}
