// The selected element's card (the new Figma UI, B2; plan row 11.67): what the element looks like, how it moves and where its value comes
// from, in three short blocks, Style, Motion and Data.
//
// Every row is read from the scene; none is made up. What the contract does not hold yet is not shown as a row: the design's "Plate", and
// "If empty" (row 11.54), will appear when the scene can say them. The card says what is; the Properties below it are where it is edited.

import type { ColorValue, SceneDocument, SceneObject } from "../../Shared/generated-ts/src";
import { kindWord } from "./elements-list";
import { colourLabel } from "./colour-anim";

export interface CardRow {
  readonly label: string;
  readonly value: string;
}

/** A button a block carries (Figma B2v2: Auto-fit and Hide when empty in the Data block). */
export interface CardAction {
  readonly id: "auto-fit" | "hide-when-empty";
  readonly label: string;
  /** The held value is on. */
  readonly pressed: boolean;
  /** Why it cannot be pressed now. */
  readonly unavailable?: string;
}

export interface CardSection {
  readonly id: "style" | "motion" | "data";
  readonly title: string;
  readonly rows: readonly CardRow[];
  readonly actions?: readonly CardAction[];
  /** Lines the block warns with: what the record check found for this element (11.153). */
  readonly notes?: readonly string[];
  /** What the block says when it has no rows. */
  readonly empty?: string;
}

export interface ElementCard {
  readonly name: string;
  readonly sections: readonly CardSection[];
}

const hex = (unit: number): string => Math.round(Math.min(1, Math.max(0, unit)) * 255).toString(16).padStart(2, "0").toUpperCase();

/** A colour as a person reads it: `#F3EDE4 · 100%`, `Gradient`, or `None`. */
/** The card's colour: the authored fill, and that it is animated when its colour is keyed (the keys are in Properties). */
function fillWords(document: SceneDocument, object: SceneObject): string {
  const keyed = (document.timeline.colourChannels ?? []).some((channel) => channel.objectId === object.id && channel.property === "fill" && channel.keys.length > 0);
  return keyed ? "Animated: see Fill in Properties" : colourText((object as { fill?: ColorValue }).fill);
}

export function colourText(fill: ColorValue | undefined): string {
  if (fill === undefined || fill.type === "none") return "None";
  if (fill.type === "solid") return `#${hex(fill.color.r)}${hex(fill.color.g)}${hex(fill.color.b)} · ${Math.round(fill.color.a * 100)}%`;
  return "Gradient";
}

/** The property names of the channels, as words: x and y are Position, scaleX and scaleY are Scale. In the order a person thinks of them. */
export function animatedWords(properties: readonly string[]): string {
  const groups: [string, readonly string[]][] = [
    ["Position", ["x", "y"]],
    ["Scale", ["scaleX", "scaleY"]],
    ["Rotation", ["rotation"]],
    ["Opacity", ["opacity"]],
  ];
  const left = new Set(properties);
  const words: string[] = [];
  for (const [word, keys] of groups) {
    if (keys.some((key) => left.has(key))) words.push(word);
    for (const key of keys) left.delete(key);
  }
  for (const property of [...left].sort()) words.push(property.startsWith("effects.") ? "Effect" : property);
  return [...new Set(words)].join(", ");
}

const capital = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

const FIT_WORDS: Readonly<Record<string, string>> = { none: "fixed", shrink: "shrinks to fit", fit: "grows to fit" };

function styleRows(document: SceneDocument, object: SceneObject): CardRow[] {
  const rows: CardRow[] = [];
  switch (object.type) {
    case "text": {
      const font = document.fonts.find((candidate) => candidate.fontId === object.fontId);
      rows.push({ label: "Font", value: `${font?.displayName ?? object.fontId} · ${object.size}` });
      rows.push({ label: "Colour", value: fillWords(document, object) });
      rows.push({ label: "Align", value: `${capital(object.align)} · ${capital(object.verticalAlign)}` });
      rows.push({ label: "Box and fit", value: `${capital(object.layout)} · ${FIT_WORDS[object.autoFit] ?? object.autoFit}` });
      break;
    }
    case "image":
      rows.push({ label: "Fit", value: String(object.fit) });
      rows.push({ label: "Size", value: `${object.width} × ${object.height}` });
      break;
    case "group":
    case "layer":
      break;
    default:
      rows.push({ label: "Colour", value: fillWords(document, object) });
      if (object.strokeWidth > 0) rows.push({ label: "Stroke", value: `${object.strokeWidth} px · ${colourText(object.stroke)}` });
      rows.push({ label: "Size", value: `${object.width} × ${object.height}` });
      if (object.type === "rect" && object.radius > 0) rows.push({ label: "Corner radius", value: `${object.radius}` });
  }
  return rows;
}

function motionRows(document: SceneDocument, object: SceneObject): CardRow[] {
  // 11.132: a keyed fill or stroke colour is motion too.
  const colours = (document.timeline.colourChannels ?? []).filter((channel) => channel.objectId === object.id && channel.keys.length > 0);
  const channels = [...(document.timeline.channels ?? []), ...(document.timeline.pathChannels ?? []), ...colours].filter((channel) => channel.objectId === object.id);
  const properties = [
    ...(document.timeline.channels ?? []).filter((channel) => channel.objectId === object.id).map((channel) => channel.property),
    ...(document.timeline.pathChannels ?? []).filter((channel) => channel.objectId === object.id).map(() => "Path"),
    ...colours.map((channel) => colourLabel(channel.property)),
  ];
  if (channels.length === 0) return [{ label: "Animated", value: "Not animated" }];
  const keys = channels.reduce((total, channel) => total + channel.keys.length, 0);
  return [
    { label: "Animated", value: animatedWords(properties) },
    { label: "Keyframes", value: `${keys}` },
  ];
}

function dataRows(document: SceneDocument, object: SceneObject): CardRow[] {
  const rows: CardRow[] = [];
  for (const [property, path] of Object.entries(object.bindings ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    rows.push({ label: property === "text" ? "Value" : capital(property), value: typeof path === "string" ? path : JSON.stringify(path) });
  }
  for (const control of (document.controls ?? []).filter((candidate) => candidate.objectId === object.id)) {
    rows.push({ label: "Filled in by", value: `the operator, as “${control.label}”` });
  }
  return rows;
}

/**
 * The Data block's buttons for an element bound to data (11.153). Hide when empty is a held value any bound element can have; Auto-fit
 * is the text's `autoFit` set to shrink, dimmed with the engine's own reason while the engine does not draw it (`why`, from the text choices).
 */
export function dataActions(object: SceneObject, autoFitWhy?: string): CardAction[] {
  const bindings = object.bindings ?? {};
  const actions: CardAction[] = [];
  if (object.type === "text" && typeof bindings.text === "string") {
    actions.push({ id: "auto-fit", label: "Auto-fit", pressed: object.autoFit === "shrink", ...(autoFitWhy === undefined ? {} : { unavailable: autoFitWhy }) });
  }
  if (typeof bindings.text === "string" || typeof bindings.assetId === "string") {
    actions.push({ id: "hide-when-empty", label: "Hide when empty", pressed: object.hideWhenEmpty === true });
  }
  return actions;
}

/** The card for one element. `autoFitWhy` is why Auto-fit cannot be pressed, when it cannot (the text choices say). */
export function elementCard(document: SceneDocument, object: SceneObject, autoFitWhy?: string, notes: readonly string[] = []): ElementCard {
  const style = styleRows(document, object);
  return {
    name: object.name,
    sections: [
      {
        id: "style",
        title: "Style",
        rows: style,
        ...(style.length === 0 ? { empty: `A ${kindWord(object.type)} has no look of its own: the elements inside it do.` } : {}),
      },
      { id: "motion", title: "Motion", rows: motionRows(document, object) },
      { id: "data", title: "Data", rows: dataRows(document, object), empty: "Not linked to data.", actions: dataActions(object, autoFitWhy), ...(notes.length === 0 ? {} : { notes }) },
    ],
  };
}
