// The PARENT, BLEND and MATTE columns of a Timeline layer row (the new Figma UI, B3; plan row 11.131).
//
// All three are written with commands the scene contract already has, so no backend work waits behind them:
// a parent is a group's ordered children (`setGroupChildren`), a blend mode is `setBlendMode`, a matte is the
// `setTrackMatte` batch `mask-edit.ts` builds. This module is the pure part: what each cell says, what its menu
// offers, and the edits a choice sends. The panel draws the cells and sends the edits; nothing here touches the DOM.
//
// **The blend list is the contract's, in the design's groups.** The design shows 38 EffectCraft modes in seven groups;
// the contract has 38 variants. `BLEND_LABELS` is a `Record` over the contract's union, so a mode added to the contract
// fails to compile here until it has a word, and a test asserts every mode is in exactly one group.
//
// **A parent is a group.** `setGroupChildren` says a group is the only kind with children, so the parent menu offers
// groups only, never the object itself or anything inside it (a cycle), and moving an object takes it out of its old
// group in the same batch (a child another group already claims is refused). A group's clip child cannot be taken out
// from the column: say so, and let the clip setting change first.

import type { BlendMode, SceneDocument, SceneEdit, SceneObject } from "@grapix/contracts";

import { MATTE_MODE_LABEL, MATTE_MODES, clearMatte, isRefused, matteSources, matteWarning, setMatte, setMatteMode, type Refused } from "../mask-edit";

/** What an empty cell shows. */
export const NONE = "—";

/** The names the design gives each blend mode (After Effects and Photoshop words). */
export const BLEND_LABELS: Readonly<Record<BlendMode, string>> = {
  normal: "Normal",
  dissolve: "Dissolve",
  "dancing-dissolve": "Dancing Dissolve",
  darken: "Darken",
  multiply: "Multiply",
  "color-burn": "Color Burn",
  "classic-color-burn": "Classic Color Burn",
  "linear-burn": "Linear Burn",
  "darker-color": "Darker Color",
  add: "Add",
  lighten: "Lighten",
  screen: "Screen",
  "color-dodge": "Color Dodge",
  "classic-color-dodge": "Classic Color Dodge",
  "linear-dodge": "Linear Dodge",
  "lighter-color": "Lighter Color",
  overlay: "Overlay",
  "soft-light": "Soft Light",
  "hard-light": "Hard Light",
  "linear-light": "Linear Light",
  "vivid-light": "Vivid Light",
  "pin-light": "Pin Light",
  "hard-mix": "Hard Mix",
  difference: "Difference",
  "classic-difference": "Classic Difference",
  exclusion: "Exclusion",
  subtract: "Subtract",
  divide: "Divide",
  hue: "Hue",
  saturation: "Saturation",
  color: "Color",
  luminosity: "Luminosity",
  // After Effects' Stencil Alpha and Silhouette Alpha, under their 1.x names in the contract.
  "alpha-mask": "Stencil Alpha",
  "stencil-luma": "Stencil Luma",
  "inverse-alpha-mask": "Silhouette Alpha",
  "silhouette-luma": "Silhouette Luma",
  "alpha-add": "Alpha Add",
  "luminescent-premul": "Luminescent Premul",
};

export interface BlendGroup {
  readonly name: string;
  readonly modes: readonly BlendMode[];
}

/** The list the design shows, in its order. */
export const BLEND_GROUPS: readonly BlendGroup[] = [
  { name: "Normal", modes: ["normal", "dissolve", "dancing-dissolve"] },
  { name: "Darken", modes: ["darken", "multiply", "color-burn", "classic-color-burn", "linear-burn", "darker-color"] },
  { name: "Lighten", modes: ["add", "lighten", "screen", "color-dodge", "classic-color-dodge", "linear-dodge", "lighter-color"] },
  { name: "Contrast", modes: ["overlay", "soft-light", "hard-light", "linear-light", "vivid-light", "pin-light", "hard-mix"] },
  { name: "Difference", modes: ["difference", "classic-difference", "exclusion", "subtract", "divide"] },
  { name: "Colour", modes: ["hue", "saturation", "color", "luminosity"] },
  { name: "Alpha", modes: ["alpha-mask", "stencil-luma", "inverse-alpha-mask", "silhouette-luma", "alpha-add", "luminescent-premul"] },
];

/** The kinds that draw nothing themselves refuse a blend mode (`objectFieldNotApplicable`). */
const DRAWS_NOTHING: readonly string[] = ["group", "layer", "marker", "camera", "light"];

export const blendApplies = (object: SceneObject): boolean => !DRAWS_NOTHING.includes(object.type);

export interface BlendCell {
  readonly mode: BlendMode;
  readonly label: string;
  /** False when the kind draws nothing, so the cell shows the dash and offers no list. */
  readonly applies: boolean;
}

export function blendCell(object: SceneObject): BlendCell {
  const applies = blendApplies(object);
  const mode = applies ? (object.blendMode ?? "normal") : "normal";
  return { mode, label: applies ? BLEND_LABELS[mode] : NONE, applies };
}

/** One blend mode for every listed object. Refused, naming them, when one draws nothing. */
export function setBlend(document: SceneDocument, objectIds: readonly string[], mode: BlendMode): SceneEdit | Refused {
  const objects = objectIds.map((id) => document.objects.find((candidate) => candidate.id === id));
  if (objects.length === 0 || objects.some((object) => object === undefined)) return { refused: "That object is not in the scene." };
  const silent = (objects as SceneObject[]).filter((object) => !blendApplies(object));
  if (silent.length > 0) {
    return { refused: `${silent.map((object) => object.name).join(", ")} draws nothing itself, so it has no blend mode. Nothing was changed.` };
  }
  // Normal is "left out" in the contract, so a layer set back to Normal reads as never set.
  return (mode === "normal" ? { edit: "setBlendMode", objectIds: [...objectIds] } : { edit: "setBlendMode", objectIds: [...objectIds], blendMode: mode }) as SceneEdit;
}

// ---------------------------------------------------------------------------------------------------------------------

type Container = Extract<SceneObject, { type: "group" }>;

const isGroup = (object: SceneObject): object is Container => object.type === "group";

/** The group an object is inside, if any. */
export function parentOf(document: SceneDocument, objectId: string): Container | undefined {
  return document.objects.find((candidate): candidate is Container => isGroup(candidate) && candidate.childIds.includes(objectId));
}

function insideOf(document: SceneDocument, objectId: string): Set<string> {
  const found = new Set<string>();
  const walk = (id: string): void => {
    const object = document.objects.find((candidate) => candidate.id === id);
    if (object === undefined || !isGroup(object)) return;
    for (const child of object.childIds) {
      if (found.has(child)) continue;
      found.add(child);
      walk(child);
    }
  };
  walk(objectId);
  return found;
}

/** The groups an object may go into: not itself, and not anything inside it. */
export function parentChoices(document: SceneDocument, object: SceneObject): Container[] {
  const inside = insideOf(document, object.id);
  return document.objects.filter((candidate): candidate is Container => isGroup(candidate) && candidate.id !== object.id && !inside.has(candidate.id));
}

/** Put an object inside a group, or take it out (`parentId` undefined). One batch, so undo puts it back in one step. */
export function setParent(document: SceneDocument, objectId: string, parentId: string | undefined): SceneEdit[] | Refused {
  const object = document.objects.find((candidate) => candidate.id === objectId);
  if (object === undefined) return { refused: "That object is not in the scene." };
  const old = parentOf(document, objectId);
  if ((old?.id) === parentId) return { refused: parentId === undefined ? `${object.name} is not inside a group.` : `${object.name} is already inside ${old!.name}.` };
  const edits: SceneEdit[] = [];
  if (old !== undefined) {
    if (old.clipChildId === objectId) return { refused: `${object.name} is the clip child of ${old.name}. Change the clip child first; nothing was changed.` };
    edits.push({ edit: "setGroupChildren", groupId: old.id, childIds: old.childIds.filter((id) => id !== objectId) } as SceneEdit);
  }
  if (parentId !== undefined) {
    const target = document.objects.find((candidate) => candidate.id === parentId);
    if (target === undefined || !isGroup(target)) return { refused: "A parent must be a group in this scene." };
    if (!parentChoices(document, object).some((choice) => choice.id === parentId)) {
      return { refused: `${object.name} cannot go inside ${target.name}: ${target.name} is inside it.` };
    }
    edits.push({ edit: "setGroupChildren", groupId: target.id, childIds: [...target.childIds, objectId] } as SceneEdit);
  }
  return edits;
}

// ---------------------------------------------------------------------------------------------------------------------

export interface LayerColumns {
  readonly parent: { readonly label: string; readonly id?: string };
  readonly blend: BlendCell;
  readonly matte: { readonly label: string; readonly warning?: string };
}

/** What the three cells of a layer row say. */
export function layerColumns(document: SceneDocument, object: SceneObject): LayerColumns {
  const parent = parentOf(document, object.id);
  const matte = object.trackMatte;
  const source = matte === undefined ? undefined : document.objects.find((candidate) => candidate.id === matte.sourceId);
  const warning = matteWarning(document, object);
  return {
    parent: parent === undefined ? { label: NONE } : { label: parent.name, id: parent.id },
    blend: blendCell(object),
    matte: {
      label: matte === undefined ? NONE : `${source?.name ?? matte.sourceId} · ${MATTE_MODE_LABEL[matte.mode]}`,
      ...(warning === undefined ? {} : { warning }),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The menu a cell opens. Every choice carries the edits it sends, or the reason it cannot, so the page only draws them.

export type Column = "parent" | "blend" | "matte";

export interface MenuItem {
  readonly label: string;
  /** A group heading in the list; it is not a choice. */
  readonly heading?: boolean;
  readonly checked?: boolean;
  /** What choosing it sends (one batch), or why it cannot be chosen. */
  readonly edits?: readonly SceneEdit[];
  readonly refused?: string;
}

export interface ColumnMenu {
  readonly title: string;
  readonly items: readonly MenuItem[];
}

const choice = (label: string, checked: boolean, outcome: SceneEdit | readonly SceneEdit[] | Refused): MenuItem => {
  if ("refused" in outcome) return { label, checked, refused: outcome.refused };
  return { label, checked, edits: Array.isArray(outcome) ? (outcome as readonly SceneEdit[]) : [outcome as SceneEdit] };
};

/** The menu for one cell of one layer. */
export function columnMenu(document: SceneDocument, object: SceneObject, column: Column): ColumnMenu {
  if (column === "blend") {
    const cell = blendCell(object);
    if (!cell.applies) return { title: "Blend", items: [{ label: `${object.name} draws nothing itself, so it has no blend mode.`, refused: "no blend mode" }] };
    return {
      title: "Blend",
      items: BLEND_GROUPS.flatMap((group) => [
        { label: group.name, heading: true } as MenuItem,
        ...group.modes.map((mode) => choice(BLEND_LABELS[mode], mode === cell.mode, setBlend(document, [object.id], mode))),
      ]),
    };
  }
  if (column === "parent") {
    const current = parentOf(document, object.id);
    const items: MenuItem[] = [];
    if (current !== undefined) items.push(choice("None", false, setParent(document, object.id, undefined)));
    else items.push({ label: "None", checked: true, refused: `${object.name} is not inside a group.` });
    for (const group of parentChoices(document, object)) items.push(choice(group.name, group.id === current?.id, setParent(document, object.id, group.id)));
    if (items.length === 1 && current === undefined) items.push({ label: "No group in this scene yet.", refused: "no group" });
    return { title: "Parent", items };
  }
  // matte
  const matte = object.trackMatte;
  const items: MenuItem[] = [];
  items.push(matte === undefined ? { label: "None", checked: true, refused: `${object.name} has no track matte.` } : choice("None", false, clearMatte(object)));
  items.push({ label: "Source", heading: true });
  const sources = matteSources(document, object.id);
  for (const source of sources) {
    items.push(choice(source.name, source.id === matte?.sourceId, setMatte(document, object.id, source.id, matte?.mode ?? "alpha")));
  }
  if (sources.length === 0) items.push({ label: "No layer can be a matte yet.", refused: "no source" });
  if (matte !== undefined) {
    items.push({ label: "Mode", heading: true });
    for (const mode of MATTE_MODES) items.push(choice(MATTE_MODE_LABEL[mode], mode === matte.mode, setMatteMode(object, mode)));
  }
  return { title: "Matte", items };
}

export { isRefused };
