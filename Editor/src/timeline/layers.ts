// Timeline layer rows (11.63).
//
// The timeline lists every object as an After Effects-style layer row: a
// visibility switch, a lock switch, a label colour swatch, the object's
// position in the document and its name, with a bar across the scene's
// duration. This module describes those rows; the panel draws them.
//
// **The switches are the object manager's.** Their availability and the reason
// a switch cannot work (hidden by a parent, locked by a parent, locked itself)
// come from `objectManagerPanel`, and pressing one sends the same
// `setObjectVisible` / `setObjectLocked` edit the object manager sends. Two
// descriptions of "may this be hidden" would drift on exactly the inherited
// cases Rust refuses (invariant 27).
//
// **The label colour is derived from the object's kind**, the way After
// Effects assigns its default labels by layer type. The scene contract has no
// label field, so the colour is presentation only: it is never written to the
// document and never reaches Program.

import type { SceneDocument, SceneObject } from "@grapix/contracts";

import { objectManagerPanel } from "../object-manager";

// Adapted from EffectCraft, MIT OR Apache-2.0, Copyright (c) 2026 ArtCraft Team
// and the EffectCraft contributors: the label palette is `Label::rgb` in
// `crates/color/src/lib.rs`.
export const LABEL_COLOURS = {
  none: "#505050",
  red: "#b53838",
  yellow: "#e4d84c",
  aqua: "#a9cbc7",
  pink: "#e5bcc9",
  lavender: "#a9a9ca",
  peach: "#e7c19e",
  seaFoam: "#b3c7b3",
  blue: "#677de0",
  green: "#4aa44c",
  purple: "#8e2c9a",
  orange: "#e8920d",
  brown: "#7f452a",
  fuchsia: "#f46dd6",
  cyan: "#3da2a5",
  sandstone: "#a89677",
  darkGreen: "#1e401e",
} as const;

export type LabelName = keyof typeof LABEL_COLOURS;

/// The default label per kind. A `Record` over the contract's kind union, so a
/// kind added to the contract fails to compile here until it is given one.
const LABEL_BY_KIND: Readonly<Record<SceneObject["type"], LabelName>> = {
  text: "red",
  rect: "blue",
  ellipse: "blue",
  line: "blue",
  shape: "blue",
  paint: "green",
  image: "lavender",
  mesh: "aqua",
  light: "peach",
  camera: "pink",
  layer: "sandstone",
  group: "sandstone",
  marker: "yellow",
};

/// The timeline stage's background, which a layer bar is mixed toward so a
/// bar reads as a muted band rather than a solid block of label colour.
/// Mirrors `--tl-bg` in `web/style.css`.
export const TIMELINE_BACKGROUND = "#1b1b1b";

export function labelFor(kind: string): LabelName {
  return (LABEL_BY_KIND as Readonly<Record<string, LabelName>>)[kind] ?? "none";
}

export function labelColourFor(kind: string): string {
  return LABEL_COLOURS[labelFor(kind)];
}

function channels(hex: string): [number, number, number] | undefined {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return undefined;
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/// `amount` of `colour` over `base`, as `#rrggbb`. A colour that is not
/// `#rrggbb` is returned unchanged rather than mixed into something nobody
/// chose.
export function mixHex(colour: string, base: string, amount: number): string {
  const top = channels(colour);
  const bottom = channels(base);
  if (!top || !bottom) return colour;
  const share = Math.min(1, Math.max(0, amount));
  const mixed = top.map((value, index) =>
    Math.round(value * share + bottom[index]! * (1 - share)),
  );
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/// One of a row's two switches: what pressing it does, or why it cannot.
export interface LayerSwitch {
  /// "Hide rect", "Unlock Title".
  readonly label: string;
  readonly unavailable?: string;
}

export interface TimelineLayer {
  /// 1-based position in the document's object list.
  readonly index: number;
  readonly name: string;
  readonly kind: string;
  readonly labelColour: string;
  /// The bar drawn across the duration; dimmer for a hidden layer.
  readonly barColour: string;
  readonly visible: boolean;
  readonly locked: boolean;
  readonly visibility: LayerSwitch;
  readonly lock: LayerSwitch;
}

/// Every object's layer row, keyed by object id. Duplicate ids keep the first
/// object, which is the rule hierarchy resolution uses.
export function timelineLayers(document: SceneDocument): ReadonlyMap<string, TimelineLayer> {
  const manager = objectManagerPanel(document, { selectedIds: [], collapsedIds: [] });
  const actions = new Map((manager.children ?? []).map((row) => [row.id, row.actions ?? []]));

  const layers = new Map<string, TimelineLayer>();
  document.objects.forEach((object, position) => {
    if (layers.has(object.id)) return;
    const rowActions = actions.get(object.id);
    const switchFor = (name: "toggleVisibility" | "toggleLock"): LayerSwitch => {
      const action = rowActions?.find((candidate) => candidate.name === name);
      // An object the manager did not list has no switch to press, and says
      // so rather than offering one that would act on a row nobody can see.
      if (!action) {
        return { label: name, unavailable: `${object.name} is not listed by the object manager` };
      }
      return {
        label: `${action.label} ${object.name}`,
        ...(action.unavailable === undefined ? {} : { unavailable: action.unavailable }),
      };
    };
    const labelColour = labelColourFor(object.type);
    layers.set(object.id, {
      index: position + 1,
      name: object.name,
      kind: object.type,
      labelColour,
      barColour: mixHex(labelColour, TIMELINE_BACKGROUND, object.visible ? 0.55 : 0.2),
      visible: object.visible,
      locked: object.locked,
      visibility: switchFor("toggleVisibility"),
      lock: switchFor("toggleLock"),
    });
  });
  return layers;
}

/// A string that changes whenever anything a layer row shows changes, so the
/// panel can tell a row that must be rebuilt from one that only repaints.
export function layerSignature(layers: ReadonlyMap<string, TimelineLayer>): string {
  return [...layers]
    .map(
      ([id, layer]) =>
        `${id}:${layer.index}:${layer.name}:${layer.kind}:${layer.visible}:${layer.locked}:` +
        `${layer.visibility.label}:${layer.visibility.unavailable ?? ""}:` +
        `${layer.lock.label}:${layer.lock.unavailable ?? ""}`,
    )
    .join("|");
}
