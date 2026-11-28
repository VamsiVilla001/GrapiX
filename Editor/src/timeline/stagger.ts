// Stagger animations (plan row 11.77, ported from XPression's Stagger Animations): offset the selected keys of several elements by a step.
//
// Asked of Jev and Laya before it was written (docs/evidence/11.77/jev-laya-stagger.json): only the SELECTED keys move, grouped by element;
// the elements are put in layer order (the order of the timeline's layer rows, the top layer first) or in selection order (the order the
// first key of each element was selected), and the element at position i moves its keys by i steps, so the first one stays; Reverse makes
// the first one the last to move; From centre ranks each element by its distance from the middle of the list, so the middle one (or the
// middle pair) stays and each one further out moves one step later on both sides; the step is a whole number of frames, negative to
// stagger earlier, and 0 is refused by name; and a key that cannot land (a frame another key holds, or outside the timeline) refuses the
// WHOLE gesture, like every other key move.
//
// Nothing here is a new command: the result is the same batch of `moveKeyframe` / `movePathKey` edits a drag of the same keys sends, so one
// undo takes the whole stagger back and an agent can send the same batch. Everything is pure; the page reads the controls and sends it.

import type { SceneDocument } from "@grapix/contracts";

import { planShift, type EditPlan } from "./key-edit";
import { keyId, parseKeyId, type TimelineModel } from "./model";

export type StaggerOrder = "layer" | "selection";

export interface StaggerOptions {
  /** Whole frames between one element and the next; negative staggers earlier. */
  readonly step: number;
  readonly order: StaggerOrder;
  /** The first element moves last instead of not at all. */
  readonly reverse: boolean;
  /** Rank by distance from the middle instead of by position. */
  readonly fromCentre: boolean;
}

export const DEFAULT_STAGGER: StaggerOptions = { step: 5, order: "layer", reverse: false, fromCentre: false };
export const STAGGER_NEEDS_KEYS = "Select keys in the timeline first";
export const STAGGER_NEEDS_TWO = "Select keys on at least two elements to stagger them";

/** The elements that have selected keys, in the order asked for. An element this scene does not have is kept, last. */
export function staggerElements(document: SceneDocument, selected: readonly string[], order: StaggerOrder): string[] {
  const seen: string[] = [];
  for (const id of selected) {
    const key = parseKeyId(id);
    if (key !== undefined && !seen.includes(key.objectId)) seen.push(key.objectId);
  }
  if (order === "selection") return seen;
  const layers = document.objects.map((object) => object.id);
  const rank = (objectId: string): number => {
    const at = layers.indexOf(objectId);
    return at < 0 ? layers.length : at;
  };
  return [...seen].sort((left, right) => rank(left) - rank(right));
}

/** Why Stagger cannot be pressed for these keys, or undefined when it can. */
export function staggerBlocker(document: SceneDocument | null, selected: readonly string[]): string | undefined {
  if (selected.length === 0) return STAGGER_NEEDS_KEYS;
  const objects = new Set(selected.flatMap((id) => parseKeyId(id)?.objectId ?? []));
  if (objects.size < 2) return STAGGER_NEEDS_TWO;
  return document === null ? "Open a scene first" : undefined;
}

/** How many steps each position moves: 0, 1, 2… down the list; from the middle outward; and with Reverse the other way round. */
export function staggerSteps(count: number, options: Pick<StaggerOptions, "reverse" | "fromCentre">): number[] {
  const base = Array.from({ length: count }, (_, position) => (options.fromCentre ? Math.floor(Math.abs(position - (count - 1) / 2)) : position));
  if (!options.reverse) return base;
  const most = Math.max(...base);
  return base.map((steps) => most - steps);
}

/** The delta of every selected key, or why the stagger cannot be made. */
export function staggerDeltas(
  document: SceneDocument,
  selected: readonly string[],
  options: StaggerOptions,
): { readonly deltas: ReadonlyMap<string, number> } | { readonly refused: string } {
  if (selected.length === 0) return { refused: STAGGER_NEEDS_KEYS };
  if (selected.some((id) => parseKeyId(id) === undefined)) return { refused: "a selected key is unreadable" };
  if (!Number.isInteger(options.step)) return { refused: `the step is a whole number of frames, not ${options.step}` };
  if (options.step === 0) return { refused: "a step of 0 frames moves nothing: give a step of 1 frame or more, or -1 or less to stagger earlier" };
  const elements = staggerElements(document, selected, options.order);
  if (elements.length < 2) return { refused: STAGGER_NEEDS_TWO };
  const missing = elements.find((objectId) => !document.objects.some((object) => object.id === objectId));
  if (missing !== undefined) return { refused: `a selected key belongs to ${missing}, which this scene does not have` };
  if (options.fromCentre && elements.length < 3) return { refused: "From centre needs keys on at least three elements: with two there is no middle one" };
  const steps = staggerSteps(elements.length, options);
  const stepOf = new Map(elements.map((objectId, position) => [objectId, steps[position]! * options.step]));
  return { deltas: new Map(selected.map((id) => [id, stepOf.get(parseKeyId(id)!.objectId)!])) };
}

/** Where each selected key is after the stagger, as key ids, for the selection to follow the keys that moved. */
export function staggeredSelection(selected: readonly string[], deltas: ReadonlyMap<string, number>): string[] {
  return selected.map((id) => {
    const key = parseKeyId(id)!;
    return keyId(key.objectId, key.property, key.frame + (deltas.get(id) ?? 0));
  });
}

const plural = (count: number, word: string): string => `${count} ${word}${Math.abs(count) === 1 ? "" : "s"}`;

/** What the stagger says it did, for the history list. */
export function staggerLabel(elements: number, options: StaggerOptions): string {
  const how = [options.fromCentre ? "from the centre" : undefined, options.reverse ? "reversed" : undefined].filter(Boolean).join(", ");
  return `Stagger ${plural(elements, "element")} by ${options.step > 0 ? "+" : ""}${plural(options.step, "frame")}${how === "" ? "" : ` (${how})`}`;
}

/** The whole stagger as one gesture: the same batch of key moves a drag sends, refused whole if any key cannot land. */
export function planStagger(document: SceneDocument, model: TimelineModel, selected: readonly string[], options: StaggerOptions): EditPlan {
  const made = staggerDeltas(document, selected, options);
  if ("refused" in made) return made;
  const key = (parsed: { objectId: string; property: string; frame: number }): string => keyId(parsed.objectId, parsed.property, parsed.frame);
  const byKey = new Map([...made.deltas].map(([id, delta]) => [id, delta]));
  return planShift(model, selected, (parsed) => byKey.get(key(parsed)) ?? 0, staggerLabel(staggerElements(document, selected, options.order).length, options));
}
