// The drag tools of the tool ribbon (plan row 11.102): Move, Rotate, Scale and Pivot.
//
// Pure: it reads the document and the pointer, and answers with the field changes one drag makes. The page sends them
// as ONE batch of `setObjectField` edits (one undo step) when the pointer is released, and until then shows the same
// changes on a copy of the document, so the object follows the pointer without the document being touched.
//
//   Move     the object follows the pointer; Shift keeps to the axis the pointer has gone furthest along.
//   Pivot    the pivot the object turns and grows about follows the pointer, and the position moves with it on the
//            canvas, so nothing drawn moves (After Effects' Pan Behind): one `setAnchor` and two position fields.
//   Rotate  turns about the middle of the selection by the angle the pointer sweeps, turn after turn; Shift snaps the
//            resulting rotation to 15 degrees.
//   Scale    grows or shrinks about the middle of the selection by the pointer's distance from it, the same on both axes.
//
// Rotate and Scale also move the objects' positions, so the group of them turns or grows as one block about the
// middle, as it looks on screen. A tool is refused by name, and nothing is sent, when a selected object is locked or
// sits in a locked group, is animated on a property the tool changes (its keys would be left behind), or sits inside a
// group, where the page cannot read the group's own space yet. The middle is taken from what is drawn at the current
// frame (`view`), the changes from the stored values.

import type { SceneDocument, SceneEdit, SceneObject } from "@grapix/contracts";
import { toLocalDelta } from "./anchor-point";
import { NO_BOX, parentsOf } from "./arrange";
import type { EditRefused } from "./inspector";
import { selectionRoots } from "./object-manager";
import { objectOverlayBounds, type OverlayBounds, type OverlayPoint } from "./overlay";

export type ToolId = "select" | "move" | "rotate" | "scale" | "pivot";
export type DragTool = Exclude<ToolId, "select">;
export const TOOL_IDS: readonly ToolId[] = ["select", "move", "rotate", "scale", "pivot"];

/** `anchorX` and `anchorY` are the two halves of the pivot, sent together as one `setAnchor`. */
export type DragField = "x" | "y" | "rotation" | "scaleX" | "scaleY" | "anchorX" | "anchorY";

/** The fields each tool may change that an animation could hold keys on (the pivot itself cannot be animated). */
export const TOOL_FIELDS: Readonly<Record<DragTool, readonly DragField[]>> = {
  move: ["x", "y"],
  rotate: ["rotation", "x", "y"],
  scale: ["scaleX", "scaleY", "x", "y"],
  pivot: ["x", "y"],
};

export interface DragItem {
  readonly id: string;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly scaleX: number;
  readonly scaleY: number;
  /** The pivot, in the object's own space (the origin when none is set). */
  readonly anchorX: number;
  readonly anchorY: number;
}

export interface ToolDrag {
  readonly tool: DragTool;
  /** Where the pointer went down, in scene pixels. */
  readonly start: OverlayPoint;
  /** The middle of the selection, in scene pixels: what Rotate and Scale turn and grow about. */
  readonly centre: OverlayPoint;
  readonly items: readonly DragItem[];
  /** Rotate only: where the pointer's angle was at the last sample and the turn so far, so a drag can go past a half
   *  turn. The one part of a drag that is not fixed at its start: each sample moves it on. */
  readonly turn: { angle: number; total: number };
}

export interface FieldChange {
  readonly id: string;
  readonly field: DragField;
  readonly value: number;
}

/** A drag that starts closer than this to the middle gives no angle and no scale worth taking, and is refused. */
export const MIN_RADIUS = 4;
/** The smallest factor a Scale drag goes to; below it the object would vanish. */
export const MIN_SCALE = 0.01;
export const SNAP_DEGREES = 15;
/** A change smaller than this is rounding noise and is not sent. */
const NOISE = 1e-6;

const tidy = (value: number): number => Math.round(value * 1e4) / 1e4;

const named = (items: readonly { name: string }[]): string =>
  items.length === 1 ? items[0]!.name : `${items.length} items`;

function isAnimated(document: SceneDocument, id: string, field: string): boolean {
  return document.timeline.channels.some((channel) => channel.objectId === id && channel.property === field && channel.keys.length > 0);
}

function boxOf(object: SceneObject): OverlayBounds {
  return NO_BOX.has(object.type) ? { x: object.x, y: object.y, width: 0, height: 0 } : objectOverlayBounds(object);
}

/** Start a drag of `tool` over the selected objects, or say by name why it cannot start. */
export function beginToolDrag(
  tool: DragTool,
  document: SceneDocument,
  selectedIds: readonly string[],
  start: OverlayPoint,
  /** The document as it is drawn at the current frame, where its middle is read from. The stored one by default. */
  view: SceneDocument = document,
): ToolDrag | EditRefused {
  const byId = new Map(document.objects.map((object) => [object.id, object]));
  const drawn = new Map(view.objects.map((object) => [object.id, object]));
  const objects = selectionRoots(document, selectedIds).flatMap((id) => {
    const object = byId.get(id);
    return object === undefined ? [] : [object];
  });
  if (objects.length === 0) return { refused: "Select an object first." };

  const locked = objects.filter((object) => object.locked);
  if (locked.length > 0) {
    return { refused: `${named(locked)} ${locked.length === 1 ? "is" : "are"} locked. Unlock ${locked.length === 1 ? "it" : "them"} first; nothing was changed.` };
  }

  const parents = parentsOf(document);
  for (const object of objects) {
    for (let at = parents.get(object.id), seen = new Set<string>(); at !== undefined && !seen.has(at); at = parents.get(at)) {
      seen.add(at);
      const group = byId.get(at);
      if (group?.locked === true) {
        return { refused: `${object.name} is in ${group.name}, which is locked. Unlock it first; nothing was changed.` };
      }
    }
  }
  const inGroup = objects.filter((object) => parents.has(object.id));
  if (inGroup.length > 0) {
    // Inside a group the position is in the group's own space. A plain move can follow it while every group above is
    // neither turned nor scaled; a turn or a scale about a point on the canvas cannot.
    const turned = (object: SceneObject): boolean => {
      for (let at = parents.get(object.id), seen = new Set<string>(); at !== undefined && !seen.has(at); at = parents.get(at)) {
        seen.add(at);
        const group = byId.get(at);
        if (group !== undefined && (group.rotation !== 0 || group.scaleX !== 1 || group.scaleY !== 1)) return true;
      }
      return false;
    };
    const plain = tool === "move" || tool === "pivot";
    const blocked = plain ? inGroup.filter(turned) : inGroup;
    if (blocked.length > 0) {
      return {
        refused:
          plain
            ? `${named(blocked)} ${blocked.length === 1 ? "is" : "are"} inside a rotated or scaled group, so a ${tool === "move" ? "move" : "pivot move"} would go the wrong way. Select the group instead.`
            : `${named(blocked)} ${blocked.length === 1 ? "is" : "are"} inside a group, which ${tool === "rotate" ? "Rotate" : "Scale"} cannot follow yet. Select the group, or items outside every group.`,
      };
    }
  }

  if (tool === "pivot") {
    const nothing = objects.filter((object) => NO_BOX.has(object.type) || object.type === "mesh");
    if (nothing.length > 0) {
      return {
        refused: NO_BOX.has(nothing[0]!.type)
          ? `${named(nothing)} draws nothing of its own, so it has no pivot to move. Select the items inside it.`
          : `${named(nothing)} keeps its pivot in 3D, which the Pivot tool does not move yet.`,
      };
    }
    const flat = objects.filter((object) => object.scaleX === 0 || object.scaleY === 0);
    if (flat.length > 0) return { refused: `${named(flat)} ${flat.length === 1 ? "has" : "have"} a scale of 0, so its pivot cannot be placed without moving what is drawn.` };
  }

  for (const object of objects) {
    const animated = TOOL_FIELDS[tool].find((field) => isAnimated(document, object.id, field));
    if (animated !== undefined) {
      return {
        refused:
          tool === "pivot"
            ? `${object.name} has keys on ${animated}. Use the Pivot panel, which can add a key at the playhead or move the keys.`
            : `${object.name} has keys on ${animated}. Change it with its keys in the timeline, so the animation is not left behind.`,
      };
    }
  }

  const boxes = objects.map((object) => boxOf(drawn.get(object.id) ?? object));
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  const centre = { x: (left + right) / 2, y: (top + bottom) / 2 };
  if ((tool === "rotate" || tool === "scale") && Math.hypot(start.x - centre.x, start.y - centre.y) < MIN_RADIUS) {
    return { refused: `Start the drag away from the middle of the selection, which it ${tool === "rotate" ? "turns" : "grows"} about.` };
  }
  return {
    tool,
    start,
    centre,
    turn: { angle: angleTo(centre, start), total: 0 },
    items: objects.map((object) => ({
      id: object.id,
      name: object.name,
      x: object.x,
      y: object.y,
      rotation: object.rotation,
      scaleX: object.scaleX,
      scaleY: object.scaleY,
      anchorX: object.anchor?.x ?? 0,
      anchorY: object.anchor?.y ?? 0,
    })),
  };
}

export interface ToolModifiers {
  readonly shift: boolean;
}

/** The angle in degrees from the middle to a point, clockwise on screen (y runs down). */
function angleTo(centre: OverlayPoint, point: OverlayPoint): number {
  return (Math.atan2(point.y - centre.y, point.x - centre.x) * 180) / Math.PI;
}

/** `degrees` brought into (-180, 180], so a sweep across the half-turn does not jump a whole turn. */
function wrapDegrees(degrees: number): number {
  const wrapped = ((((degrees + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 ? 180 : wrapped;
}

/** The field changes a drag makes with the pointer at `current`: only fields that really change. */
export function toolDragChanges(drag: ToolDrag, current: OverlayPoint, modifiers: ToolModifiers): readonly FieldChange[] {
  const out: FieldChange[] = [];
  const push = (item: DragItem, field: DragField, value: number): void => {
    // Rounded first: a value that rounds back to the stored one is not a change, and Rust refuses an edit that changes nothing.
    const rounded = tidy(value);
    if (Math.abs(rounded - item[field]) > NOISE) out.push({ id: item.id, field, value: rounded });
  };

  if (drag.tool === "move" || drag.tool === "pivot") {
    let dx = current.x - drag.start.x;
    let dy = current.y - drag.start.y;
    if (modifiers.shift) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    for (const item of drag.items) {
      push(item, "x", item.x + dx);
      push(item, "y", item.y + dy);
      if (drag.tool === "pivot") {
        // The pivot goes where the pointer went, in the object's own space; the position moved by the same distance on
        // the canvas, so the picture stays. Both halves are sent together, as one setAnchor.
        const local = toLocalDelta(item, dx, dy);
        if (local === undefined) continue;
        const ax = tidy(item.anchorX + local.x);
        const ay = tidy(item.anchorY + local.y);
        if (Math.abs(ax - item.anchorX) > NOISE || Math.abs(ay - item.anchorY) > NOISE) {
          out.push({ id: item.id, field: "anchorX", value: ax }, { id: item.id, field: "anchorY", value: ay });
        }
      }
    }
    return out;
  }

  const startRadius = Math.hypot(drag.start.x - drag.centre.x, drag.start.y - drag.centre.y);
  const radius = Math.hypot(current.x - drag.centre.x, current.y - drag.centre.y);
  if (startRadius < MIN_RADIUS) return out;

  if (drag.tool === "rotate") {
    // The turn is added up from sample to sample, so the pointer can go round more than half a turn; exactly on the
    // middle it has no direction and the turn stays where it was.
    if (radius > NOISE) {
      const angle = angleTo(drag.centre, current);
      drag.turn.total += wrapDegrees(angle - drag.turn.angle);
      drag.turn.angle = angle;
    }
    let sweep = drag.turn.total;
    if (modifiers.shift) {
      // The first item ends on the 15 degree grid, and the rest turn the same amount.
      const first = drag.items[0]!;
      sweep = Math.round((first.rotation + sweep) / SNAP_DEGREES) * SNAP_DEGREES - first.rotation;
    }
    const radians = (sweep * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    for (const item of drag.items) {
      const relX = item.x - drag.centre.x;
      const relY = item.y - drag.centre.y;
      push(item, "rotation", item.rotation + sweep);
      push(item, "x", drag.centre.x + relX * cos - relY * sin);
      push(item, "y", drag.centre.y + relX * sin + relY * cos);
    }
    return out;
  }

  const factor = Math.max(MIN_SCALE, radius / startRadius);
  for (const item of drag.items) {
    push(item, "scaleX", item.scaleX * factor);
    push(item, "scaleY", item.scaleY * factor);
    push(item, "x", drag.centre.x + (item.x - drag.centre.x) * factor);
    push(item, "y", drag.centre.y + (item.y - drag.centre.y) * factor);
  }
  return out;
}

/** The changes as the one batch of edits that carries them: one `setObjectField` per changed field of each object, and
 *  one `setAnchor` for the two halves of a pivot. */
export function toolDragEdits(changes: readonly FieldChange[]): readonly SceneEdit[] {
  const anchors = new Map<string, { x?: number; y?: number }>();
  const fields: SceneEdit[] = [];
  for (const change of changes) {
    if (change.field === "anchorX" || change.field === "anchorY") {
      const own = anchors.get(change.id) ?? {};
      own[change.field === "anchorX" ? "x" : "y"] = change.value;
      anchors.set(change.id, own);
    } else {
      fields.push({ edit: "setObjectField", objectIds: [change.id], field: { name: change.field, value: change.value } } as SceneEdit);
    }
  }
  const pivots = [...anchors].map(([id, own]) => ({ edit: "setAnchor", objectIds: [id], anchor: { x: own.x ?? 0, y: own.y ?? 0 } }) as SceneEdit);
  return [...pivots, ...fields];
}

/** The document as it would be with the changes applied. Nothing is written; the page draws it while the pointer is down. */
export function previewDocument(document: SceneDocument, changes: readonly FieldChange[]): SceneDocument {
  if (changes.length === 0) return document;
  const byObject = new Map<string, FieldChange[]>();
  for (const change of changes) byObject.set(change.id, [...(byObject.get(change.id) ?? []), change]);
  return {
    ...document,
    objects: document.objects.map((object) => {
      const own = byObject.get(object.id);
      if (own === undefined) return object;
      const plain = own.filter((c) => c.field !== "anchorX" && c.field !== "anchorY");
      const ax = own.find((c) => c.field === "anchorX")?.value;
      const ay = own.find((c) => c.field === "anchorY")?.value;
      return {
        ...object,
        ...Object.fromEntries(plain.map((c) => [c.field, c.value])),
        ...(ax === undefined && ay === undefined ? {} : { anchor: { x: ax ?? object.anchor?.x ?? 0, y: ay ?? object.anchor?.y ?? 0 } }),
      } as SceneObject;
    }),
  };
}

/** The words for the Activity line and the undo entry of a finished drag. */
export function toolDragLabel(drag: ToolDrag, changes: readonly FieldChange[]): string {
  const who = named(drag.items);
  const first = drag.items[0]!;
  const valueOf = (field: DragField): number | undefined => changes.find((c) => c.id === first.id && c.field === field)?.value;
  if (drag.tool === "move" || drag.tool === "pivot") {
    const dx = (valueOf("x") ?? first.x) - first.x;
    const dy = (valueOf("y") ?? first.y) - first.y;
    return `${drag.tool === "move" ? "Moved" : "Moved the pivot of"} ${who} by ${tidy(dx)}, ${tidy(dy)}`;
  }
  if (drag.tool === "rotate") {
    const turned = (valueOf("rotation") ?? first.rotation) - first.rotation;
    return `Rotated ${who} by ${tidy(turned)}°`;
  }
  const grown = first.scaleX === 0 ? 1 : (valueOf("scaleX") ?? first.scaleX) / first.scaleX;
  return `Scaled ${who} to ${Math.round(grown * 100)}%`;
}
