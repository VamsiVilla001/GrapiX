// The Text animator section of Properties (plan row 11.61, Figma B3d v2), on codex's contract: `textObject.textAnimator`, the edit
// `setTextAnimator`, and the keyable scalars `textAnimator.selector.start/end/offset` and `textAnimator.x/y/scale/rotation/opacity`.
//
// Asked of Jev and Laya first (docs/evidence/11.61/jev-laya-text-animator-ui.json): Jev A on all three (1.0, 0.97, 0.26: the third is
// close, Laya preferred showing every field at 0.15). So: the section is present for text elements; Add text animator makes a neutral
// animator (the whole text, no move, scale 1, no rotation, no opacity change: nothing changes on screen until a row does); the rows are
// Range (Start, End, Offset, Shape, Basis, Randomize order) and Change per character (Move X, Move Y, Scale, Rotation, Opacity, Tracking). Amount,
// Smoothness, Ease high and Ease low are held values like Shape (the contract lets none of them be keyed): four percent rows, set in one
// setTextAnimator, refused by name outside their range.
//
// The five scalars for Start, End, Offset and the change rows are ordinary number rows (`inspector.ts` reads them from here), so their
// diamonds, arrows and Auto-key are the existing ones. Shape, Basis and Randomize are held values and go in one `setTextAnimator`.

import type { SceneDocument, SceneEdit, SceneObject, TextAnimator, TextRangeBasis, TextRangeShape } from "@grapix/contracts";

import type { UiNode } from "./agent-surface";

type TextObject = Extract<SceneObject, { type: "text" }>;
const isText = (object: SceneObject): object is TextObject => object.type === "text";

/** The animator a text element gets from Add: the whole text, nothing moved. */
export function neutralAnimator(): TextAnimator {
  return {
    selector: { start: 0, end: 1, offset: 0, amount: 1, shape: "square", smoothness: 1, easeHigh: 0, easeLow: 0, randomizeOrder: false },
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
  } as TextAnimator;
}

export interface AnimatorRow {
  /** The scalar's wire name: also the field key in Properties and the property a diamond keys. */
  readonly property: string;
  readonly label: string;
  /** How the value is typed and shown: a percent of the text (0 to 100%) or a plain number. */
  readonly input: "unit" | "number";
  readonly group: "range" | "change";
  /** The value the animator holds for this row. */
  readonly read: (animator: TextAnimator) => number | undefined;
}

export const ANIMATOR_ROWS: readonly AnimatorRow[] = [
  { property: "textAnimator.selector.start", label: "Range start", input: "unit", group: "range", read: (a) => a.selector.start },
  { property: "textAnimator.selector.end", label: "Range end", input: "unit", group: "range", read: (a) => a.selector.end },
  { property: "textAnimator.selector.offset", label: "Range offset", input: "number", group: "range", read: (a) => a.selector.offset },
  { property: "textAnimator.x", label: "Move X", input: "number", group: "change", read: (a) => a.x },
  { property: "textAnimator.y", label: "Move Y", input: "number", group: "change", read: (a) => a.y },
  { property: "textAnimator.scale", label: "Scale", input: "number", group: "change", read: (a) => a.scale },
  { property: "textAnimator.rotation", label: "Rotation", input: "number", group: "change", read: (a) => a.rotation },
  { property: "textAnimator.opacity", label: "Opacity", input: "unit", group: "change", read: (a) => a.opacity ?? 1 },
  // Signed scene pixels added after each glyph the range selects; absent means none, and reads as 0.
  { property: "textAnimator.tracking", label: "Tracking", input: "number", group: "change", read: (a) => a.tracking ?? 0 },
];

/** The row for a property name, or undefined for any other. */
export function animatorRow(property: string): AnimatorRow | undefined {
  return ANIMATOR_ROWS.find((row) => row.property === property);
}

/** The value an object's animator holds for a scalar property: undefined when the object has no animator. */
export function animatorValue(object: SceneObject, property: string): number | undefined {
  const animator = isText(object) ? (object as { textAnimator?: TextAnimator }).textAnimator : undefined;
  const row = animatorRow(property);
  return animator === undefined || row === undefined ? undefined : row.read(animator);
}

export const SHAPES: readonly { readonly value: TextRangeShape; readonly label: string }[] = [
  { value: "square", label: "Square" },
  { value: "rampUp", label: "Ramp up" },
  { value: "rampDown", label: "Ramp down" },
  { value: "triangle", label: "Triangle" },
  { value: "round", label: "Round" },
  { value: "smooth", label: "Smooth" },
];

export const BASES: readonly { readonly value: TextRangeBasis | "default"; readonly label: string }[] = [
  { value: "default", label: "As authored" },
  { value: "characters", label: "Characters" },
  { value: "charactersExcludingSpaces", label: "Characters, no spaces" },
  { value: "words", label: "Words" },
  { value: "lines", label: "Lines" },
];

/** The selector's four held numbers, shown as a percent: what the contract holds (-1 to 1, smoothness 0 to 1) times 100. */
export const HELD_ROWS = [
  { key: "amount", label: "Amount", min: -100, max: 100 },
  { key: "smoothness", label: "Smoothness", min: 0, max: 100 },
  { key: "easeHigh", label: "Ease high", min: -100, max: 100 },
  { key: "easeLow", label: "Ease low", min: -100, max: 100 },
] as const;
export type HeldKey = (typeof HELD_ROWS)[number]["key"];
const heldRow = (key: string) => HELD_ROWS.find((row) => row.key === key);
const percentText = (fraction: number): string => `${Math.round(fraction * 100 * 1000) / 1000}%`;

/** A person's text for a held row: "50", "50%" or "-25 %" to a percent number, or the reason it is refused. */
export function parseHeld(key: HeldKey, raw: string): { readonly percent: number } | { readonly refused: string } {
  const row = heldRow(key)!;
  const trimmed = raw.trim().replace(/\s*%$/, "");
  const value = trimmed === "" ? Number.NaN : Number(trimmed);
  if (!Number.isFinite(value)) return { refused: `${row.label} needs a number, not "${raw.trim()}"` };
  if (value < row.min || value > row.max) return { refused: `${row.label} must be between ${row.min}% and ${row.max}%, not ${value}%` };
  return { percent: value };
}

const textsOf = (document: SceneDocument, selectedIds: readonly string[]): TextObject[] => document.objects.filter((object) => selectedIds.includes(object.id)).filter(isText);
const animatorOf = (object: TextObject): TextAnimator | undefined => (object as { textAnimator?: TextAnimator }).textAnimator;

/** The held value of a choice across the objects that have an animator: its value, or Mixed. */
function shared<T>(values: readonly T[]): T | "mixed" | undefined {
  if (values.length === 0) return undefined;
  return values.every((value) => value === values[0]) ? values[0] : "mixed";
}

function choiceGroup(id: string, label: string, options: readonly { value: string; label: string }[], current: string | "mixed" | undefined): UiNode {
  return {
    id: `inspector/textAnimator/${id}`,
    role: "group",
    label,
    value: current === undefined ? "" : current === "mixed" ? "Mixed" : (options.find((option) => option.value === current)?.label ?? current),
    children: options.map((option): UiNode => ({
      id: `inspector/textAnimator/${id}/${option.value}`,
      role: "listitem",
      label: option.label,
      selected: option.value === current,
      actions: [{ name: "choose", label: option.label, ...(option.value === current ? { unavailable: `already ${option.label}` } : {}) }],
    })),
  };
}

/**
 * The non-scalar nodes of the section for the selection: Add (when a selected text has no animator), Remove (when one has), and the
 * Shape and Basis choices and the Randomize checkbox for the ones that have. None when the selection holds no text.
 */
export function animatorNodes(document: SceneDocument, selectedIds: readonly string[]): UiNode[] {
  const selected = document.objects.filter((object) => selectedIds.includes(object.id));
  const texts = textsOf(document, selectedIds);
  if (texts.length === 0) return [];
  const others = selected.filter((object) => !isText(object)).map((object) => object.type);
  const withIt = texts.filter((text) => animatorOf(text) !== undefined);
  const without = texts.filter((text) => animatorOf(text) === undefined);
  const blocked = others.length > 0 ? `A text animator is a text choice: ${[...new Set(others)].join(", ")} ${new Set(others).size === 1 ? "has" : "have"} none. Select only text` : undefined;
  const nodes: UiNode[] = [];
  nodes.push({
    id: "inspector/textAnimator/add",
    role: "gridcell",
    label: "Text animator",
    value: withIt.length === 0 ? "None" : without.length === 0 ? "On" : `On for ${withIt.length} of ${texts.length}`,
    actions: [
      {
        name: "add",
        label: "Add text animator",
        ...(blocked !== undefined ? { unavailable: blocked } : without.length === 0 ? { unavailable: "Every selected text already has one" } : {}),
      },
      ...(withIt.length === 0
        ? []
        : [{ name: "remove", label: "Remove text animator", ...(blocked !== undefined ? { unavailable: blocked } : {}) }]),
    ],
  });
  if (withIt.length > 0) {
    const animators = withIt.map((text) => animatorOf(text)!);
    nodes.push(
      choiceGroup("shape", "Shape", SHAPES, shared(animators.map((a) => a.selector.shape))),
      choiceGroup("basis", "Basis", BASES, shared(animators.map((a) => a.selector.basis ?? "default"))),
    );
    const random = shared(animators.map((a) => a.selector.randomizeOrder));
    for (const row of HELD_ROWS) {
      const value = shared(animators.map((a) => a.selector[row.key]));
      nodes.push({
        id: `inspector/textAnimator/${row.key}`,
        role: "gridcell",
        label: row.label,
        value: value === "mixed" ? "Mixed" : percentText(value as number),
        input: { type: "text", value: value === "mixed" ? "" : percentText(value as number), ...(value === "mixed" ? { mixed: true } : {}) },
        actions: [{ name: "edit", label: `Edit ${row.label}` }],
      });
    }
    nodes.push({
      id: "inspector/textAnimator/randomize",
      role: "gridcell",
      label: "Randomize order",
      value: random === "mixed" ? "Mixed" : random ? "On" : "Off",
      input: { type: "checkbox", value: random === true ? "true" : "false", ...(random === "mixed" ? { mixed: true } : {}) },
      actions: [{ name: "edit", label: "Edit Randomize order" }],
    });
  }
  return nodes;
}

/** The ids of an animator action: `inspector/textAnimator/shape/triangle`, `.../add`, `.../randomize`. */
export function parseAnimatorId(id: string): { readonly part: "add" | "remove" | "shape" | "basis" | "randomize" | HeldKey; readonly value?: string } | undefined {
  const match = /^inspector\/textAnimator\/(add|remove|shape|basis|randomize|amount|smoothness|easeHigh|easeLow)(?:\/([A-Za-z]+))?$/.exec(id);
  if (match === null) return undefined;
  const part = match[1] as "add" | "remove" | "shape" | "basis" | "randomize" | HeldKey;
  if ((part === "shape" || part === "basis") && match[2] === undefined) return undefined;
  if (heldRow(part) !== undefined && match[2] !== undefined) return undefined;
  return match[2] === undefined ? { part } : { part, value: match[2] };
}

export type AnimatorOutcome = { readonly edits: readonly SceneEdit[]; readonly label: string } | { readonly refused: string };

const setAnimator = (objectIds: readonly string[], animator: TextAnimator | null): SceneEdit => ({ edit: "setTextAnimator", objectIds: [...objectIds], animator }) as unknown as SceneEdit;

/** The edit a click on the section makes, over every selected text it applies to. */
export function animatorEdit(document: SceneDocument, selectedIds: readonly string[], part: "add" | "remove" | "shape" | "basis" | "randomize" | HeldKey, value?: string | boolean | number): AnimatorOutcome {
  const texts = textsOf(document, selectedIds);
  if (texts.length === 0) return { refused: "Select a text element first" };
  const withIt = texts.filter((text) => animatorOf(text) !== undefined);
  const without = texts.filter((text) => animatorOf(text) === undefined);
  if (part === "add") {
    if (without.length === 0) return { refused: "Every selected text already has a text animator" };
    return { edits: [setAnimator(without.map((text) => text.id), neutralAnimator())], label: without.length > 1 ? `Add text animator to ${without.length} texts` : "Add text animator" };
  }
  if (part === "remove") {
    if (withIt.length === 0) return { refused: "No selected text has a text animator" };
    return { edits: [setAnimator(withIt.map((text) => text.id), null)], label: withIt.length > 1 ? `Remove text animator from ${withIt.length} texts` : "Remove text animator" };
  }
  if (withIt.length === 0) return { refused: "Add a text animator first" };
  const held = heldRow(part);
  if (held !== undefined) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < held.min || value > held.max) {
      return { refused: `${held.label} must be between ${held.min}% and ${held.max}%` };
    }
  }
  const patch = (animator: TextAnimator): TextAnimator => {
    if (held !== undefined) return { ...animator, selector: { ...animator.selector, [held.key]: (value as number) / 100 } };
    if (part === "shape") return { ...animator, selector: { ...animator.selector, shape: value as TextRangeShape } };
    if (part === "randomize") return { ...animator, selector: { ...animator.selector, randomizeOrder: value === true } };
    const { basis: _drop, ...selector } = animator.selector;
    return { ...animator, selector: value === "default" ? (selector as TextAnimator["selector"]) : { ...selector, basis: value as TextRangeBasis } };
  };
  // Texts with different animators get each its own edit, so each keeps what else it holds.
  const edits = withIt.map((text) => setAnimator([text.id], patch(animatorOf(text)!)));
  const what = held !== undefined ? held.label : part === "shape" ? "Range shape" : part === "basis" ? "Range basis" : "Randomize order";
  return { edits, label: `Set ${what}` };
}
