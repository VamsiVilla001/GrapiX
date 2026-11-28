// The Elements list (the new Figma UI, B2; plan row 11.67). What the left panel says about each element of the graphic, and the three
// buttons that make one.
//
// The design's word for a shape, a text or an image in a graphic is Element (terms table, `Shared/web-panels/terms.js`). The list is a
// line per element: its name, and what it is: "box", "text · field", "image · field". A field is an element an operator can fill in:
// a template control points at it, or a data binding drives one of its properties.

import type { SceneDocument, SceneObject } from "../../Shared/generated-ts/src";

/** What a person calls each kind of scene object. A rect is a box. */
export const KIND_WORD: Readonly<Record<string, string>> = {
  rect: "box",
  ellipse: "ellipse",
  text: "text",
  image: "image",
  shape: "shape",
  line: "line",
  group: "group",
  layer: "layer",
  paint: "colour",
  mesh: "3D shape",
  light: "light",
  camera: "camera",
  marker: "marker",
};

export function kindWord(type: string): string {
  return KIND_WORD[type] ?? type;
}

/** The ids of the elements an operator can fill in: those a template control points at. */
export function controlledIds(document: Pick<SceneDocument, "controls">): ReadonlySet<string> {
  return new Set((document.controls ?? []).map((control) => control.objectId));
}

/** Whether the element is a field: controlled, or driven by at least one data binding. */
export function isField(object: Pick<SceneObject, "id" | "bindings">, controlled: ReadonlySet<string>): boolean {
  return controlled.has(object.id) || Object.keys(object.bindings ?? {}).length > 0;
}

/** The line's right-hand side: what it is, and "field" when an operator can fill it in. */
export function elementTag(object: Pick<SceneObject, "id" | "type" | "bindings">, controlled: ReadonlySet<string>): string {
  const kind = kindWord(object.type);
  return isField(object, controlled) ? `${kind} · field` : kind;
}

export interface AddButton {
  readonly kind: string;
  readonly label: string;
}

/** The three buttons at the top of the list. */
export const ADD_BUTTONS: readonly AddButton[] = [
  { kind: "rect", label: "+ Box" },
  { kind: "text", label: "+ Text" },
  { kind: "image", label: "+ Image" },
];

const capital = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

/** A name for a new element of `kind` that the scene does not already use: "Box", then "Box 2", "Box 3". */
export function newElementName(kind: string, objects: readonly Pick<SceneObject, "name">[]): string {
  const base = capital(kindWord(kind));
  const taken = new Set(objects.map((object) => object.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const name = `${base} ${n}`;
    if (!taken.has(name)) return name;
  }
}

/** What the list says when the graphic has no element yet. */
export const EMPTY_WORDS = "No elements yet. Add a box, some text or an image above, or bring in a drawing.";

/** What the stage says over an empty graphic (the new Figma UI, S1). Nothing is preset: the layout is the designer's. */
export const EMPTY_GRAPHIC = {
  title: "This graphic is empty",
  body: "Add a box, text or an image, or bring in a drawing. Nothing is preset: you design the layout.",
  add: "Add a box",
  bringIn: "Bring in a drawing…",
} as const;
