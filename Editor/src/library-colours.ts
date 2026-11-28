// The Library's Colours tab (the new Figma UI, B13; plan row 11.122): named solid colours kept in the project.
//
// Asked of Jev and Laya before it was written (docs/evidence/11.122/jev-laya-colours.json): a library colour is applied to an object by COPY, so
// editing or deleting one never changes a graphic; a colour is made from the selected object's fill (its colour space kept) or typed as hex (read as
// sRGB); deleting removes the swatch only; and because nothing links a graphic to the library, a swatch says how many objects of the OPEN graphic have
// exactly this colour now, and says that is what it counts.
//
// Everything is a `UiNode`, so a person and an agent read the same description (invariant 27).

import type { LibraryColour, Rgba, SceneDocument, SceneObject } from "@grapix/contracts";

import type { UiAction, UiNode } from "./agent-surface";

export const COLOURS_NEED_PROJECT = "Colours belong to a project. This graphic is not in one yet: save it into a project first.";
export const COLOURS_NOTE =
  "Applying a colour copies it into the object: nothing links the object to the library, so changing or deleting a colour here never changes a graphic.";

/** Read `#RGB`, `#RRGGBB` or `#RRGGBBAA` as an sRGB colour, or say why not. */
export function parseHex(text: string): { readonly colour: Rgba } | { readonly refused: string } {
  const trimmed = text.trim();
  const digits = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  if (!/^[0-9a-fA-F]+$/.test(digits) || ![3, 6, 8].includes(digits.length)) {
    return { refused: `${JSON.stringify(trimmed)} is not a hex colour: write #RGB, #RRGGBB or #RRGGBBAA` };
  }
  const full = digits.length === 3 ? [...digits].map((digit) => digit + digit).join("") : digits;
  const part = (at: number): number => Number.parseInt(full.slice(at, at + 2), 16) / 255;
  return { colour: { r: part(0), g: part(2), b: part(4), a: full.length === 8 ? part(6) : 1, space: "srgb" } };
}

const channel = (value: number): string => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, "0").toUpperCase();

/** What a colour says for itself: `#E02020` for an sRGB colour inside the display range (`#E0202080` with an alpha below 1), the numbers and the space otherwise. */
export function colourWords(colour: Rgba): string {
  const inRange = [colour.r, colour.g, colour.b].every((value) => value >= 0 && value <= 1);
  if (colour.space === "srgb" && inRange) {
    return `#${channel(colour.r)}${channel(colour.g)}${channel(colour.b)}${colour.a < 1 ? channel(colour.a) : ""}`;
  }
  const number = (value: number): string => String(Math.round(value * 1000) / 1000);
  return `${number(colour.r)} ${number(colour.g)} ${number(colour.b)}${colour.a < 1 ? ` · alpha ${number(colour.a)}` : ""} · ${colour.space}`;
}

/** The colour a CSS swatch shows: only an sRGB colour is shown as itself; another space is not guessed at. */
export function swatchCss(colour: Rgba): string | undefined {
  if (colour.space !== "srgb") return undefined;
  const clamp = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 255);
  return `rgba(${clamp(colour.r)}, ${clamp(colour.g)}, ${clamp(colour.b)}, ${Math.min(1, Math.max(0, colour.a))})`;
}

const sameColour = (left: Rgba, right: Rgba): boolean =>
  left.space === right.space && left.r === right.r && left.g === right.g && left.b === right.b && left.a === right.a;

/** The solid colour an object's paint is, if it is one. */
function solid(paint: SceneObject["fill"]): Rgba | undefined {
  return paint !== undefined && paint !== null && paint.type === "solid" ? paint.color : undefined;
}

/** How many objects of the open graphic have exactly this colour as a fill and as a stroke now. */
export function colourUse(document: SceneDocument, colour: Rgba): { readonly fills: number; readonly strokes: number } {
  let fills = 0;
  let strokes = 0;
  for (const object of document.objects) {
    const fill = solid(object.fill);
    const stroke = solid(object.stroke);
    if (fill !== undefined && sameColour(fill, colour)) fills += 1;
    if (stroke !== undefined && sameColour(stroke, colour)) strokes += 1;
  }
  return { fills, strokes };
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The selected objects, as the actions need them. */
function chosen(document: SceneDocument, ids: readonly string[]): SceneObject[] {
  return document.objects.filter((object) => ids.includes(object.id));
}

/** Why a colour cannot be applied to the selection as `slot`, or undefined when it can. */
export function applyBlocker(document: SceneDocument, ids: readonly string[], slot: "fill" | "stroke"): string | undefined {
  const objects = chosen(document, ids);
  if (objects.length === 0) return "select an object first";
  const kinds = new Set(["rect", "ellipse", "text", "shape", "line"]);
  const wrong = objects.filter((object) => !kinds.has(object.type) || (slot === "fill" && object.type === "line"));
  if (wrong.length > 0) return `${slot === "fill" ? "a fill" : "a stroke"} is not drawn by ${[...new Set(wrong.map((object) => object.type))].join(", ")}`;
  return undefined;
}

/** Why a colour cannot be made from the selection's fill, or undefined when it can: one object with a solid fill. */
export function fillBlocker(document: SceneDocument, ids: readonly string[]): string | undefined {
  const objects = chosen(document, ids);
  if (objects.length !== 1) return objects.length === 0 ? "select an object whose fill to keep" : "select one object: a colour is made from one fill";
  const paint = objects[0]!.fill;
  if (paint === undefined || paint === null || paint.type === "none") return `${objects[0]!.name} has no fill`;
  if (paint.type !== "solid") return `${objects[0]!.name} has a gradient fill: only a solid colour can be kept`;
  return undefined;
}

export interface ColoursState {
  /** The project's colours; absent until the shell has answered (or when the graphic is not in a project). */
  readonly colours?: readonly LibraryColour[];
  /** Why the project's colours could not be read. */
  readonly coloursProblem?: string;
  readonly selectedColourId?: string;
  /** The objects selected in the open graphic, which Apply acts on and New from fill reads. */
  readonly selectedObjectIds?: readonly string[];
  readonly project: boolean;
}

/** The Colours tab: the swatches, what can be done to make one, and the selected colour's card. */
export function coloursNodes(document: SceneDocument, state: ColoursState): UiNode[] {
  const ids = state.selectedObjectIds ?? [];
  const fromFill: UiAction = {
    name: "newColourFromFill",
    label: "+ From selected fill",
    ...(!state.project ? { unavailable: COLOURS_NEED_PROJECT } : state.colours === undefined ? { unavailable: "the project's colours have not been read" } : {}),
  };
  const blocked = fillBlocker(document, ids);
  const makeActions: UiAction[] = [
    { ...fromFill, ...(fromFill.unavailable === undefined && blocked !== undefined ? { unavailable: blocked } : {}) },
    {
      name: "newColourHex",
      label: "+ New colour…",
      ...(!state.project ? { unavailable: COLOURS_NEED_PROJECT } : state.colours === undefined ? { unavailable: "the project's colours have not been read" } : {}),
    },
  ];
  if (state.colours === undefined) {
    return [
      {
        id: "library/colours",
        role: "list",
        label: "Colours",
        description: state.project ? (state.coloursProblem ?? "reading the project's colours…") : COLOURS_NEED_PROJECT,
        children: [],
        actions: makeActions,
      },
    ];
  }
  const swatches: UiNode[] = state.colours.map((colour): UiNode => {
    const css = swatchCss(colour.color);
    return {
      id: `colour/${colour.id}`,
      role: "listitem",
      label: colour.name,
      value: colourWords(colour.color),
      selected: colour.id === state.selectedColourId,
      ...(css === undefined ? {} : { swatch: css }),
      actions: [{ name: "colour", label: `${colour.name} · ${colourWords(colour.color)}` }],
    };
  });
  const list: UiNode = {
    id: "library/colours",
    role: "list",
    label: "Colours",
    description: state.colours.length === 0 ? "no colours yet: make one from a fill, or type a hex value" : plural(state.colours.length, "colour"),
    children: swatches,
    actions: makeActions,
  };
  const selected = state.colours.find((colour) => colour.id === state.selectedColourId);
  return [list, selected === undefined ? { id: "library/colour-detail", role: "region", label: "Selected colour", description: "Select a colour to apply it, rename it or change it." } : detail(document, selected, ids)];
}

function detail(document: SceneDocument, colour: LibraryColour, ids: readonly string[]): UiNode {
  const use = colourUse(document, colour.color);
  const apply = (slot: "fill" | "stroke"): UiAction => {
    const why = applyBlocker(document, ids, slot);
    return { name: slot === "fill" ? "applyFill" : "applyStroke", label: slot === "fill" ? "Apply as fill" : "Apply as stroke", ...(why === undefined ? {} : { unavailable: why }) };
  };
  const css = swatchCss(colour.color);
  return {
    id: "library/colour-detail",
    role: "region",
    label: colour.name,
    description: colourWords(colour.color),
    ...(css === undefined ? {} : { swatch: css }),
    actions: [apply("fill"), apply("stroke"), { name: "renameColour", label: "Rename…" }, { name: "editColour", label: "Change colour…" }, { name: "deleteColour", label: "Delete" }],
    children: [
      { id: `colour/${colour.id}/value`, role: "gridcell", label: "Value", value: colourWords(colour.color) },
      { id: `colour/${colour.id}/space`, role: "gridcell", label: "Colour space", value: colour.color.space },
      {
        id: `colour/${colour.id}/use`,
        role: "gridcell",
        label: "In this graphic",
        value: use.fills + use.strokes === 0 ? "no object has exactly this colour" : `${plural(use.fills, "fill")} and ${plural(use.strokes, "stroke")} have exactly this colour`,
        description: "Counts exact matches in the open graphic only: an applied colour is a copy, not a link.",
      },
    ],
  };
}
