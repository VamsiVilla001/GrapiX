import type { ColorValue } from "@grapix/shared-types";

/**
 * Keep an object's two colour representations in step when it is created.
 *
 * Every object carries both the legacy `fill`/`stroke` strings and the rich `fillStyle`/
 * `strokeStyle` values, and the renderers read the rich one first (`pixiColorValue(fillStyle,
 * fill)`). A factory that sets only the string therefore paints whatever the *base* object's style
 * happened to be, not the colour it asked for.
 *
 * That is how the pen tool drew nothing: `createPenShape` asked for a `#7c5cff` fill and a white
 * stroke, inherited the unassigned base styles (`#00000000` and `#8fa6b6`), and produced a path
 * filled with fully transparent black and outlined in grey. The colour was in the saved scene the
 * whole time — it just was not the field anyone drew from.
 *
 * A style passed explicitly always wins: a caller that supplies a gradient means the gradient.
 */
export interface ObjectColorLayer {
  fill?: string;
  stroke?: string;
  fillStyle?: ColorValue;
  strokeStyle?: ColorValue;
}

export function withColorStyles<T extends ObjectColorLayer>(layer: T): T {
  const next = { ...layer };

  if (layer.fill !== undefined && layer.fillStyle === undefined) {
    next.fillStyle = solid(layer.fill);
  }
  if (layer.stroke !== undefined && layer.strokeStyle === undefined) {
    next.strokeStyle = solid(layer.stroke);
  }

  return next;
}

/**
 * `transparent` is a colour a renderer understands, but it is not a *paint*, and the difference
 * matters for authoring: `none` means the object has no fill, which is what the Inspector's fill
 * mode buttons and the readiness checks look for.
 */
function solid(color: string): ColorValue {
  return color.toLowerCase() === "transparent" ? { type: "none" } : { type: "solid", color };
}
