// Solid fill and stroke colour animation in the Editor (plan row 11.132, frontend), on codex's contract: `timeline.colourChannels`,
// `createColourKey` / `updateColourKey` / `moveColourKey` / `removeColourKey`, and `colourPropertyKinds` from the animation surface.
//
// Asked of Jev and Laya first (docs/evidence/11.132/jev-laya-colour-ui.json, Jev A on all three at 0.97):
//   - Properties gets a Fill and a Stroke row: a swatch with its hex (a colour picker), and the keyframe diamond with previous and
//     next the number rows have. A row is offered only for the kinds the surface lists, and is dimmed with its reason when the paint
//     is a gradient or none.
//   - Changing the colour keys it at the playhead when the property is already keyed or Auto-key is on (create, or update the key
//     already there); otherwise it sets the static paint (`setPaint`). The same rule as the number rows.
//   - The timeline shows a track per keyed colour ("Fill colour", "Stroke colour") whose keys move, delete, stagger and ease with the
//     same gestures as the others.
//
// The text animator's glyph colour (row 11.61, codex's release 795/796) is a third colour property, `textAnimatorFill`: the colour the
// fully selected glyphs take, the stored field `textAnimator.fill` (optional) and its keys. It is drawn as "Animator fill" in the same
// Colour section, offered only when every selected element is a text with an animator. Until one is set the row says "Not set": the glyphs
// keep their own colour, and the first pick (or key) starts from the text's own fill.
//
// The value between keys is worked out here exactly as the contract does (`ColourChannel::evaluate`): eased progress clamped to 0..1,
// the mix in linear light, the result back in the first key's space. The Draft view and the rows read it; the engine draws from the
// contract's own.

import type { AnimationSurface, ColourChannel, ColourKeyframe, ColourProperty, Rgba, SceneDocument, SceneEasing, SceneEdit, SceneObject, TextAnimator } from "@grapix/contracts";

import type { UiNode } from "./agent-surface";
import { wireFrame } from "./command-client";
import { easeAt } from "./timeline/easing";

export type { ColourProperty };
export const COLOUR_PROPERTIES: readonly ColourProperty[] = ["fill", "stroke", "textAnimatorFill"];

/** The timeline's name for a colour track: kept apart from number properties so a key id says which edit it takes. */
export function colourField(property: ColourProperty): string {
  return `colour.${property}`;
}

/** The colour property a timeline field names, or undefined for any other field. */
export function colourOfField(field: string): ColourProperty | undefined {
  return field === "colour.fill" ? "fill" : field === "colour.stroke" ? "stroke" : field === "colour.textAnimatorFill" ? "textAnimatorFill" : undefined;
}

export function colourLabel(property: ColourProperty): string {
  return property === "fill" ? "Fill colour" : property === "stroke" ? "Stroke colour" : "Animator fill colour";
}

/** The row's short label in Properties. */
function rowLabel(property: ColourProperty): string {
  return property === "fill" ? "Fill" : property === "stroke" ? "Stroke" : "Animator fill";
}

const animatorOf = (object: SceneObject): TextAnimator | undefined => (object.type === "text" ? (object as { textAnimator?: TextAnimator }).textAnimator : undefined);

// --- Colour spaces: the contract's transfer functions ------------------------------------------------------------------------

const srgbDecode = (v: number): number => (v <= 0.04044993647446828 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const srgbEncode = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const rec709Decode = (v: number): number => (v < 0.081 ? v / 4.5 : ((v + 0.099) / 1.099) ** (1 / 0.45));
const rec709Encode = (v: number): number => (v < 0.018 ? 4.5 * v : 1.099 * v ** 0.45 - 0.099);

export function toLinear(colour: Rgba): [number, number, number] {
  const decode = colour.space === "linear" ? (v: number) => v : colour.space === "rec709" ? rec709Decode : srgbDecode;
  return [decode(colour.r), decode(colour.g), decode(colour.b)];
}

export function fromLinear(rgb: readonly [number, number, number], a: number, space: Rgba["space"]): Rgba {
  const encode = space === "linear" ? (v: number) => v : space === "rec709" ? rec709Encode : srgbEncode;
  return { r: encode(rgb[0]), g: encode(rgb[1]), b: encode(rgb[2]), a, space };
}

/** The colour in another space (the same light). */
export function toSpace(colour: Rgba, space: Rgba["space"]): Rgba {
  return colour.space === space ? colour : fromLinear(toLinear(colour), colour.a, space);
}

const byte = (v: number): string => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, "0");

/** The colour as sRGB hex for a person and a colour picker: `#rrggbb`. Alpha is said apart. */
export function hexOf(colour: Rgba): string {
  const srgb = toSpace(colour, "srgb");
  return `#${byte(srgb.r)}${byte(srgb.g)}${byte(srgb.b)}`;
}

/** A picked `#rrggbb` (sRGB, as CSS says a hex is) as a colour in `space`, keeping `alpha`. Undefined when it is not one. */
export function fromHex(hex: string, space: Rgba["space"], alpha: number): Rgba | undefined {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (match === null) return undefined;
  const srgb: Rgba = { r: parseInt(match[1]!, 16) / 255, g: parseInt(match[2]!, 16) / 255, b: parseInt(match[3]!, 16) / 255, a: alpha, space: "srgb" };
  return toSpace(srgb, space);
}

// --- Values --------------------------------------------------------------------------------------------------------------------

export function colourChannel(document: SceneDocument, objectId: string, property: ColourProperty): ColourChannel | undefined {
  return (document.timeline.colourChannels ?? []).find((channel) => channel.objectId === objectId && channel.property === property);
}

/** The value of a channel at a frame, as `ColourChannel::evaluate` gives it. Undefined for a channel with no keys. */
export function evaluateColour(channel: ColourChannel, frame: number): Rgba | undefined {
  const keys = channel.keys;
  if (keys.length === 0) return undefined;
  const upper = keys.findIndex((key) => Number(key.frame) > frame);
  const fromIndex = (upper === -1 ? keys.length : upper) - 1;
  if (fromIndex < 0) return keys[0]!.value;
  const from = keys[fromIndex]!;
  const to = keys[fromIndex + 1];
  if (to === undefined || Number(from.frame) === frame) return from.value;
  const position = (frame - Number(from.frame)) / (Number(to.frame) - Number(from.frame));
  const progress = Math.min(1, Math.max(0, easeAt(from.easing, from.bezier, position)));
  if (progress === 0) return from.value;
  if (progress === 1) return to.value;
  const a = toLinear(from.value);
  const b = toLinear(to.value);
  const mix = (x: number, y: number): number => x * (1 - progress) + y * progress;
  return fromLinear([mix(a[0], b[0]), mix(a[1], b[1]), mix(a[2], b[2])], mix(from.value.a, to.value.a), from.value.space);
}

type Painted = Extract<SceneObject, { fill?: unknown }>;

/** The object's static paint for a property: a solid colour, or why it is not one. */
export function staticColour(object: SceneObject, property: ColourProperty): Rgba | { readonly not: string } {
  if (property === "textAnimatorFill") {
    const animator = animatorOf(object);
    if (animator === undefined) return { not: `${object.name} has no text animator` };
    return animator.fill ?? { not: `${object.name}'s text animator has no colour yet` };
  }
  const paint = (object as Painted & { stroke?: unknown })[property] as { type?: string; color?: Rgba } | undefined;
  if (paint === undefined || paint.type === "none") return { not: `${object.name} has no ${property}` };
  if (paint.type !== "solid") return { not: `${object.name}'s ${property} is a gradient: only a solid colour is animated` };
  return paint.color!;
}

/** The colour shown at a frame: the track's value when it has keys, else the static paint. */
export function colourAt(document: SceneDocument, object: SceneObject, property: ColourProperty, frame: number): Rgba | { readonly not: string } {
  const channel = colourChannel(document, object.id, property);
  const keyed = channel === undefined ? undefined : evaluateColour(channel, frame);
  return keyed ?? staticColour(object, property);
}

/** Where an animator's colour starts when none is set: the text's own solid fill, else white. */
function seedColour(object: SceneObject): Rgba {
  const fill = (object as { fill?: { type?: string; color?: Rgba } }).fill;
  return fill?.type === "solid" && fill.color !== undefined ? fill.color : { r: 1, g: 1, b: 1, a: 1, space: "srgb" };
}

/** The colour to change from: what is shown, or, for an animator with no colour yet, the seed. */
function currentOrSeed(document: SceneDocument, object: SceneObject, property: ColourProperty, frame: number): Rgba | { readonly not: string } {
  const current = colourAt(document, object, property, frame);
  const animator = animatorOf(object);
  return property === "textAnimatorFill" && "not" in current && animator !== undefined ? seedColour(object) : current;
}

/** Whether the surface lets this kind animate this colour. */
export function animatable(surface: AnimationSurface | undefined, kind: string, property: ColourProperty): boolean {
  return surface?.colourPropertyKinds?.[property]?.includes(kind) ?? false;
}

// --- Edits ---------------------------------------------------------------------------------------------------------------------

export interface ColourPlan {
  readonly edits: readonly SceneEdit[];
  readonly label: string;
}
export type ColourOutcome = ColourPlan | { readonly refused: string };

const key = (frame: number, value: Rgba, easing: SceneEasing): ColourKeyframe => ({ frame: wireFrame(frame), value, easing }) as ColourKeyframe;

/**
 * Change the colour of every listed object. A property already keyed, or any property while Auto-key is on, gets a key at the
 * playhead (updated when one is there); otherwise the static paint is set. The new colour keeps each object's colour space (a track's
 * keys must share one) and its alpha.
 */
export function planColourChange(
  document: SceneDocument,
  objectIds: readonly string[],
  property: ColourProperty,
  hex: string,
  frame: number,
  autoKey: boolean,
  easing: SceneEasing,
): ColourOutcome {
  const objects = document.objects.filter((object) => objectIds.includes(object.id));
  if (objects.length === 0) return { refused: "Select an element first" };
  const edits: SceneEdit[] = [];
  let keyed = 0;
  for (const object of objects) {
    const current = currentOrSeed(document, object, property, frame);
    if ("not" in current) return { refused: current.not };
    const value = fromHex(hex, current.space, current.a);
    if (value === undefined) return { refused: `${hex} is not a colour: use #rrggbb` };
    const channel = colourChannel(document, object.id, property);
    const animated = (channel?.keys.length ?? 0) > 0;
    if (!animated && !autoKey) {
      // The animator's colour is a held field of the animator, set with the rest of it; the others are paints.
      const animator = animatorOf(object);
      edits.push(
        property === "textAnimatorFill" && animator !== undefined
          ? ({ edit: "setTextAnimator", objectIds: [object.id], animator: { ...animator, fill: value } } as unknown as SceneEdit)
          : ({ edit: "setPaint", objectIds: [object.id], slot: property, paint: { type: "solid", color: value } } as SceneEdit),
      );
      continue;
    }
    keyed += 1;
    const there = channel?.keys.find((candidate) => Number(candidate.frame) === frame);
    edits.push(
      there === undefined
        ? ({ edit: "createColourKey", objectId: object.id, property, keyframe: key(frame, value, easing) } as SceneEdit)
        : ({ edit: "updateColourKey", objectId: object.id, property, keyframe: { ...there, value } } as SceneEdit),
    );
  }
  const what = property === "fill" ? "fill" : property === "stroke" ? "stroke" : "animator fill";
  return { edits, label: keyed > 0 ? `Key ${what} colour at frame ${frame}` : `Change ${what} colour` };
}

/**
 * The diamond: a key at the playhead on every listed object at its current colour, or, when every one already has a key there,
 * those keys taken out. One gesture either way.
 */
export function planColourKeyToggle(
  document: SceneDocument,
  objectIds: readonly string[],
  property: ColourProperty,
  frame: number,
  easing: SceneEasing,
): ColourOutcome {
  const objects = document.objects.filter((object) => objectIds.includes(object.id));
  if (objects.length === 0) return { refused: "Select an element first" };
  const keyedHere = objects.every((object) => colourChannel(document, object.id, property)?.keys.some((k) => Number(k.frame) === frame) ?? false);
  if (keyedHere) {
    return {
      edits: objects.map((object) => ({ edit: "removeColourKey", objectId: object.id, property, frame: wireFrame(frame) }) as SceneEdit),
      label: `Remove ${property} colour key at frame ${frame}`,
    };
  }
  const edits: SceneEdit[] = [];
  for (const object of objects) {
    if (colourChannel(document, object.id, property)?.keys.some((k) => Number(k.frame) === frame)) continue;
    const current = currentOrSeed(document, object, property, frame);
    if ("not" in current) return { refused: current.not };
    edits.push({ edit: "createColourKey", objectId: object.id, property, keyframe: key(frame, current, easing) } as SceneEdit);
  }
  return { edits, label: `Add ${property} colour key at frame ${frame}` };
}

/** The frame of the nearest key before (or after) `frame` across the objects' tracks, for the row's arrows. */
export function neighbourKey(document: SceneDocument, objectIds: readonly string[], property: ColourProperty, frame: number, direction: -1 | 1): number | undefined {
  const frames = objectIds.flatMap((id) => colourChannel(document, id, property)?.keys.map((k) => Number(k.frame)) ?? []);
  const candidates = frames.filter((f) => (direction < 0 ? f < frame : f > frame));
  if (candidates.length === 0) return undefined;
  return direction < 0 ? Math.max(...candidates) : Math.min(...candidates);
}

// --- Properties rows -----------------------------------------------------------------------------------------------------------

/**
 * The Fill and Stroke rows for the selection: one per colour property every selected element can animate. Each says its colour in
 * words (hex, alpha, Mixed when they differ) and carries `edit` (the picker), `key`, `prev` and `next`, each with its reason when it
 * cannot act.
 */
export function colourRowNodes(document: SceneDocument, selectedIds: readonly string[], surface: AnimationSurface | undefined, frame: number): UiNode[] {
  const objects = document.objects.filter((object) => selectedIds.includes(object.id));
  if (objects.length === 0 || surface === undefined) return [];
  return COLOUR_PROPERTIES.flatMap((property): UiNode[] => {
    if (!objects.every((object) => animatable(surface, object.type, property))) return [];
    if (property === "textAnimatorFill" && !objects.every((object) => animatorOf(object) !== undefined)) return [];
    const unset = property === "textAnimatorFill" && objects.every((object) => "not" in colourAt(document, object, property, frame));
    const values = objects.map((object) => currentOrSeed(document, object, property, frame));
    const refusal = values.find((value): value is { not: string } => "not" in value);
    const colours = values.filter((value): value is Rgba => !("not" in value));
    const hexes = new Set(colours.map(hexOf));
    const mixed = hexes.size > 1;
    const first = colours[0];
    const words = refusal !== undefined ? refusal.not : unset ? "Not set · glyphs keep their colour" : mixed ? "Mixed" : `${hexOf(first!)} · ${Math.round(first!.a * 100)}%`;
    const keyedHere = objects.every((object) => colourChannel(document, object.id, property)?.keys.some((k) => Number(k.frame) === frame) ?? false);
    const animated = objects.some((object) => (colourChannel(document, object.id, property)?.keys.length ?? 0) > 0);
    const before = neighbourKey(document, selectedIds, property, frame, -1);
    const after = neighbourKey(document, selectedIds, property, frame, 1);
    return [
      {
        id: `colour/${property}`,
        role: "row",
        label: rowLabel(property),
        value: words,
        ...(first === undefined || refusal !== undefined ? {} : { swatch: hexOf(first) }),
        ...(refusal === undefined ? { input: { type: "color" as const, value: mixed ? "#000000" : hexOf(first!), ...(mixed ? { mixed: true } : {}) } } : {}),
        actions: [
          { name: "edit", label: `Change ${property} colour`, ...(refusal === undefined ? {} : { unavailable: refusal.not }) },
          { name: "prev", label: "‹", ...(before === undefined ? { unavailable: animated ? "No key before the playhead" : "Not animated yet" } : {}) },
          {
            name: "key",
            label: keyedHere ? "◆" : "◇",
            ...(refusal === undefined ? {} : { unavailable: refusal.not }),
          },
          { name: "next", label: "›", ...(after === undefined ? { unavailable: animated ? "No key after the playhead" : "Not animated yet" } : {}) },
        ],
      },
    ];
  });
}

/** The frame the row's arrow goes to. */
export function arrowFrame(document: SceneDocument, objectIds: readonly string[], property: ColourProperty, frame: number, arrow: "prev" | "next"): number | undefined {
  return neighbourKey(document, objectIds, property, frame, arrow === "prev" ? -1 : 1);
}
