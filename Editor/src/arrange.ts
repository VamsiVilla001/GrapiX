// Line up and spread (plan row 11.83, first slice): move the selected items so their edges or centres
// meet, or so the gaps between them are equal, as one batch of position edits (one undo step).
//
// The page measures each item's box on the canvas (`objectOverlayBounds`, after scale and rotation) and
// sends only `x` and `y`; Rust owns the document and still refuses what it must. An item inside a group
// lives in the group's own space, which the page cannot read as a whole yet, so items from different
// groups are refused by name instead of being lined up wrongly.

import type { SceneDocument, SceneEdit, SceneObject } from "@grapix/contracts";
import type { EditRefused } from "./inspector";
import { objectOverlayBounds, type OverlayBounds } from "./overlay";

export type Edge = "left" | "centre" | "right" | "top" | "middle" | "bottom";

/** One thing the Line up and spread menu can do. `line-*` goes to the outer box of the selection, and a
 *  spread makes the gaps between the items equal. */
export type ArrangeCommand = `line-${Edge}` | "spread-across" | "spread-down";

const EDGES: readonly Edge[] = ["left", "centre", "right", "top", "middle", "bottom"];

export const ARRANGE_COMMANDS: readonly ArrangeCommand[] = [
  ...EDGES.map((edge) => `line-${edge}` as const),
  "spread-across",
  "spread-down",
];

export function isArrangeCommand(value: string): value is ArrangeCommand {
  return (ARRANGE_COMMANDS as readonly string[]).includes(value);
}

const EDGE_WORDS: Readonly<Record<Edge, string>> = {
  left: "left edges",
  centre: "centres across",
  right: "right edges",
  top: "top edges",
  middle: "middles down",
  bottom: "bottom edges",
};

/** What the command is called in Activity and in a refusal. */
export function arrangeWords(command: ArrangeCommand): string {
  if (command === "spread-across") return "Spread evenly across";
  if (command === "spread-down") return "Spread evenly down";
  return `Line up ${EDGE_WORDS[command.slice("line-".length) as Edge]}`;
}

/** The Activity line for a command that moved `moved` items. */
export function arrangeLabel(command: ArrangeCommand, moved: number): string {
  return `${arrangeWords(command)}: ${moved} ${moved === 1 ? "item" : "items"} moved`;
}

/** Kinds with no box of their own to line up. */
export const NO_BOX = new Set(["layer", "group", "light", "camera", "marker"]);

/** Smaller than this, a move is rounding noise and is not sent. */
const NOISE = 1e-6;

function tidy(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function parentsOf(document: SceneDocument): Map<string, string> {
  const parents = new Map<string, string>();
  for (const object of document.objects) {
    const children = object.type === "group" || object.type === "layer" ? object.childIds : [];
    for (const child of children) if (!parents.has(child)) parents.set(child, object.id);
  }
  return parents;
}

function named(objects: readonly SceneObject[]): string {
  const names = objects.slice(0, 3).map((object) => `"${object.name}"`);
  const more = objects.length - names.length;
  return more > 0 ? `${names.join(", ")} and ${more} more` : names.join(", ");
}

interface Placed {
  readonly object: SceneObject;
  readonly box: OverlayBounds;
}

function move(placed: Placed, dx: number, dy: number): SceneEdit[] {
  const edits: SceneEdit[] = [];
  if (Math.abs(dx) > NOISE) {
    edits.push({ edit: "setObjectField", objectIds: [placed.object.id], field: { name: "x", value: tidy(placed.object.x + dx) } });
  }
  if (Math.abs(dy) > NOISE) {
    edits.push({ edit: "setObjectField", objectIds: [placed.object.id], field: { name: "y", value: tidy(placed.object.y + dy) } });
  }
  return edits;
}

function outer(boxes: readonly OverlayBounds[]): OverlayBounds {
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  return {
    x: left,
    y: top,
    width: Math.max(...boxes.map((box) => box.x + box.width)) - left,
    height: Math.max(...boxes.map((box) => box.y + box.height)) - top,
  };
}

/** How far the item must move along the axis of `edge` for that edge or centre to meet the reference's. */
function shift(edge: Edge, box: OverlayBounds, reference: OverlayBounds): { readonly dx: number; readonly dy: number } {
  switch (edge) {
    case "left":
      return { dx: reference.x - box.x, dy: 0 };
    case "centre":
      return { dx: reference.x + reference.width / 2 - (box.x + box.width / 2), dy: 0 };
    case "right":
      return { dx: reference.x + reference.width - (box.x + box.width), dy: 0 };
    case "top":
      return { dx: 0, dy: reference.y - box.y };
    case "middle":
      return { dx: 0, dy: reference.y + reference.height / 2 - (box.y + box.height / 2) };
    case "bottom":
      return { dx: 0, dy: reference.y + reference.height - (box.y + box.height) };
  }
}

/** Turn a Line up and spread command over the selection into the one batch Rust applies, or say why not.
 *
 *  Refused, in words and with nothing sent: too few items, an item with no box (a group, a layer, a camera),
 *  a locked item, and items from different groups. */
export function arrangeEdits(
  document: SceneDocument,
  selectedIds: readonly string[],
  command: ArrangeCommand,
): readonly SceneEdit[] | EditRefused {
  const selected = document.objects.filter((object) => selectedIds.includes(object.id));
  const spread = command === "spread-across" || command === "spread-down";
  if (selected.length < (spread ? 3 : 2)) {
    return { refused: spread ? "Select three or more items to spread." : "Select two or more items to line up." };
  }
  const boxless = selected.filter((object) => NO_BOX.has(object.type));
  if (boxless.length > 0) {
    return { refused: `${named(boxless)} has no box of its own to line up. Select the items inside it instead.` };
  }
  const locked = selected.filter((object) => object.locked);
  if (locked.length > 0) {
    return { refused: `${named(locked)} ${locked.length === 1 ? "is" : "are"} locked. Unlock ${locked.length === 1 ? "it" : "them"} first; nothing was moved.` };
  }
  const parents = parentsOf(document);
  if (new Set(selected.map((object) => parents.get(object.id) ?? "")).size > 1) {
    return { refused: "These items are in different groups. Select items from one group, or items outside every group." };
  }

  const placed: Placed[] = selected.map((object) => ({ object, box: objectOverlayBounds(object) }));
  const edits: SceneEdit[] = [];

  if (spread) {
    const across = command === "spread-across";
    const start = (item: Placed) => (across ? item.box.x : item.box.y);
    const size = (item: Placed) => (across ? item.box.width : item.box.height);
    // The outermost two stay where they are; the ones between take equal gaps.
    const ordered = [...placed].sort((a, b) => start(a) + size(a) / 2 - (start(b) + size(b) / 2));
    const first = ordered[0]!;
    const last = ordered[ordered.length - 1]!;
    const gap = (start(last) + size(last) - start(first) - ordered.reduce((sum, item) => sum + size(item), 0)) / (ordered.length - 1);
    let at = start(first);
    for (const item of ordered) {
      const delta = at - start(item);
      edits.push(...(across ? move(item, delta, 0) : move(item, 0, delta)));
      at += size(item) + gap;
    }
  } else {
    const edge = command.split("-")[1] as Edge;
    const reference = outer(placed.map((item) => item.box));
    for (const item of placed) {
      const { dx, dy } = shift(edge, item.box, reference);
      edits.push(...move(item, dx, dy));
    }
  }

  if (edits.length === 0) {
    return { refused: spread ? "Nothing to move: they are already evenly spaced." : "Nothing to move: they are already lined up." };
  }
  return edits;
}
