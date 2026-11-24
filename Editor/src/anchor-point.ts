// The pivot (anchor point) of an object, and how to move it without moving what is drawn (plan rows 11.102 and 11.103).
//
// An object is drawn as T(x, y) · R · S · T(-anchor): its own space is turned by `rotation`, scaled, and set down so that
// the pivot sits at (x, y). A point q of the object's own space therefore lands on the canvas at
//     (x, y) + R · S · (q - anchor).
// Moving the pivot to q' without moving the picture means moving (x, y) to where q' lands under the old pivot:
//     (x, y)' = (x, y) + R · S · (q' - anchor)        anchor' = q'
// which keeps every point of the object where it was. This module is that arithmetic, the box a pivot is placed on, and
// the plan of edits the pivot panel and the Pivot tool send. Pure: Rust still owns the document and refuses what it must.
//
// Ideas only come from looking at how After Effects authors place a pivot (a grid of nine places on the layer's box, an
// offset, position moved to match). Nothing of those scripts is used; their licences differ and one forbids commercial
// reuse. The formula above follows from the transform the engine draws with (Shared/contracts/src/scene.rs, 3.13).

import type { SceneDocument, SceneEdit, SceneObject } from "@grapix/contracts";
import { NO_BOX, parentsOf } from "./arrange";
import { isRefused, type EditRefused } from "./inspector";
import { selectionRoots } from "./object-manager";
import { localBox, objectOverlayBounds, type OverlayPoint } from "./overlay";

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** What it takes to place a pivot: where the object is, how it is turned and scaled, and where its pivot is now. */
export interface Placement {
  readonly x: number;
  readonly y: number;
  readonly rotation: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly anchorX: number;
  readonly anchorY: number;
}

const tidy = (value: number): number => Math.round(value * 1e4) / 1e4;
/** A change smaller than this is rounding noise and is not sent. */
const NOISE = 1e-6;

/** A distance on the canvas as the same distance in the object's own space, or nothing when the object is scaled to 0. */
export function toLocalDelta(placement: Pick<Placement, "rotation" | "scaleX" | "scaleY">, dx: number, dy: number): Point | undefined {
  if (placement.scaleX === 0 || placement.scaleY === 0) return undefined;
  const radians = (placement.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: (dx * cos + dy * sin) / placement.scaleX, y: (-dx * sin + dy * cos) / placement.scaleY };
}

/** A distance in the object's own space as the same distance on the canvas (inside the object's parent). */
export function toSceneDelta(placement: Pick<Placement, "rotation" | "scaleX" | "scaleY">, lx: number, ly: number): Point {
  const radians = (placement.rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const sx = lx * placement.scaleX;
  const sy = ly * placement.scaleY;
  return { x: sx * cos - sy * sin, y: sx * sin + sy * cos };
}

export function placementOf(object: SceneObject): Placement {
  return {
    x: object.x,
    y: object.y,
    rotation: object.rotation,
    scaleX: object.scaleX,
    scaleY: object.scaleY,
    anchorX: object.anchor?.x ?? 0,
    anchorY: object.anchor?.y ?? 0,
  };
}

/** The 2D affine of the engine: [a c tx; b d ty], as `resolve_hierarchy` composes it (scene.rs `local_transform` and `multiply`). */
type Affine = readonly [a: number, b: number, c: number, d: number, tx: number, ty: number];
const IDENTITY_AFFINE: Affine = [1, 0, 0, 1, 0, 0];

function localAffine(object: SceneObject): Affine {
  const ax = object.anchor?.x ?? 0;
  const ay = object.anchor?.y ?? 0;
  const rad = (object.rotation * Math.PI) / 180;
  const sin = Math.sin(rad);
  const cos = Math.cos(rad);
  const a = cos * object.scaleX;
  const b = sin * object.scaleX;
  const c = -sin * object.scaleY;
  const d = cos * object.scaleY;
  return [a, b, c, d, object.x + a * -ax + c * -ay, object.y + b * -ax + d * -ay];
}

function multiplyAffine(p: Affine, l: Affine): Affine {
  return [
    p[0] * l[0] + p[2] * l[1],
    p[1] * l[0] + p[3] * l[1],
    p[0] * l[2] + p[2] * l[3],
    p[1] * l[2] + p[3] * l[3],
    p[0] * l[4] + p[2] * l[5] + p[4],
    p[1] * l[4] + p[3] * l[5] + p[5],
  ];
}

/** Where an object stands on the canvas once its groups and layers have acted on it, as the engine resolves it (`resolve_hierarchy`):
 *  its origin carried through every ancestor's transform, their rotations added, their scales multiplied, its own anchor kept.
 *  An object in no group is `placementOf`. */
export function effectivePlacement(document: SceneDocument, object: SceneObject): Placement {
  const parents = parentsOf(document);
  const byId = new Map(document.objects.map((candidate) => [candidate.id, candidate]));
  const chain: SceneObject[] = [];
  for (let at = parents.get(object.id), guard = 0; at !== undefined && guard < 64; at = parents.get(at), guard += 1) {
    const parent = byId.get(at);
    if (parent === undefined) break;
    chain.unshift(parent);
  }
  let affine = IDENTITY_AFFINE;
  let rotation = 0;
  let scaleX = 1;
  let scaleY = 1;
  for (const ancestor of chain) {
    affine = multiplyAffine(affine, localAffine(ancestor));
    rotation += ancestor.rotation;
    scaleX *= ancestor.scaleX;
    scaleY *= ancestor.scaleY;
  }
  return {
    x: affine[0] * object.x + affine[2] * object.y + affine[4],
    y: affine[1] * object.x + affine[3] * object.y + affine[5],
    rotation: rotation + object.rotation,
    scaleX: scaleX * object.scaleX,
    scaleY: scaleY * object.scaleY,
    anchorX: object.anchor?.x ?? 0,
    anchorY: object.anchor?.y ?? 0,
  };
}

/** The edits that put the pivot at `target` (a point of the object's own space). With `keepInPlace` the position moves with
 *  it, so nothing drawn moves; without, the picture moves with the pivot. Empty when the pivot is already there. */
export function pivotEdits(id: string, from: Placement, target: Point, keepInPlace: boolean): SceneEdit[] {
  const ax = tidy(target.x);
  const ay = tidy(target.y);
  const edits: SceneEdit[] = [];
  if (Math.abs(ax - from.anchorX) > NOISE || Math.abs(ay - from.anchorY) > NOISE) {
    edits.push({ edit: "setAnchor", objectIds: [id], anchor: { x: ax, y: ay } } as SceneEdit);
    if (keepInPlace) {
      const moved = toSceneDelta(from, ax - from.anchorX, ay - from.anchorY);
      const x = tidy(from.x + moved.x);
      const y = tidy(from.y + moved.y);
      if (Math.abs(x - from.x) > NOISE) edits.push({ edit: "setObjectField", objectIds: [id], field: { name: "x", value: x } } as SceneEdit);
      if (Math.abs(y - from.y) > NOISE) edits.push({ edit: "setObjectField", objectIds: [id], field: { name: "y", value: y } } as SceneEdit);
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// The pivot panel: nine places on the box, an offset, reset, a typed point, a nudge
// ---------------------------------------------------------------------------

/** The nine places on an object's box, as the fraction across (0 left, 1 right) and down (0 top, 1 bottom). */
export const GRID: readonly { readonly id: string; readonly label: string; readonly fx: number; readonly fy: number }[] = [
  { id: "top-left", label: "Top left", fx: 0, fy: 0 },
  { id: "top", label: "Top", fx: 0.5, fy: 0 },
  { id: "top-right", label: "Top right", fx: 1, fy: 0 },
  { id: "left", label: "Left", fx: 0, fy: 0.5 },
  { id: "centre", label: "Centre", fx: 0.5, fy: 0.5 },
  { id: "right", label: "Right", fx: 1, fy: 0.5 },
  { id: "bottom-left", label: "Bottom left", fx: 0, fy: 1 },
  { id: "bottom", label: "Bottom", fx: 0.5, fy: 1 },
  { id: "bottom-right", label: "Bottom right", fx: 1, fy: 1 },
];

export type PivotRequest =
  /** A place on each object's own box, plus an offset in its own pixels. */
  | { readonly kind: "grid"; readonly place: string; readonly offset?: Point }
  /** The same place on the box around the whole selection, for every object: pivots meet at one point on the canvas. */
  | { readonly kind: "selection"; readonly place: string; readonly offset?: Point }
  /** Back to the object's origin (the top left of its box). */
  | { readonly kind: "reset" }
  /** A typed point in each object's own space. Either number left out stays as it is. */
  | { readonly kind: "point"; readonly x?: number; readonly y?: number }
  /** Move the pivot by a distance in the object's own pixels. */
  | { readonly kind: "nudge"; readonly dx: number; readonly dy: number };

/** What to do when the position has keys, since moving the pivot has to move the position to keep the picture:
 *  `insert` adds a key at the playhead holding the picture there (other frames are left as they are, so they change);
 *  `modify` moves every existing key by the same distance, which keeps the picture at every frame as long as the object's
 *  turn and scale are not animated. */
export type KeyedMode = "insert" | "modify";

export interface PivotOptions {
  /** Move the position with the pivot so nothing drawn moves. On by default. */
  readonly keepInPlace?: boolean;
  /** What to do for a position that has keys. `insert` by default. */
  readonly keyed?: KeyedMode;
  /** The frame under the playhead, and the document as drawn at that frame (the animation evaluated), where an inserted
   *  key takes its values from. The stored document and frame 0 by default. */
  readonly frame?: number;
  readonly view?: SceneDocument;
}

const named = (objects: readonly { name: string }[]): string =>
  objects.length === 1 ? objects[0]!.name : `${objects.length} items`;

/** The keys an object has on a property, or none. */
function keysOf(document: SceneDocument, id: string, field: string): readonly { frame: unknown; value: number }[] {
  return document.timeline.channels.find((channel) => channel.objectId === id && channel.property === field)?.keys ?? [];
}

/** The edits that put one object's pivot at `target`, honouring keys on its position (see `KeyedMode`). Refuses by name
 *  when the position cannot be kept at every frame. */
function placeEdits(
  document: SceneDocument,
  object: SceneObject,
  target: Point,
  keepInPlace: boolean,
  options: PivotOptions,
): SceneEdit[] | EditRefused {
  const from = placementOf(object);
  const keyedFields = keepInPlace ? (["x", "y"] as const).filter((field) => keysOf(document, object.id, field).length > 0) : [];
  // Keys on the turn or the scale mean the object is not drawn as it is stored: the picture to hold is the one at the
  // playhead, so the distance is worked out from the object as drawn there, even when the position itself has no keys.
  const turnKeyed = keepInPlace && (["rotation", "scaleX", "scaleY"] as const).some((field) => keysOf(document, object.id, field).length > 0);
  if (keyedFields.length === 0 && !turnKeyed) return pivotEdits(object.id, from, target, keepInPlace);

  const ax = tidy(target.x);
  const ay = tidy(target.y);
  if (Math.abs(ax - from.anchorX) <= NOISE && Math.abs(ay - from.anchorY) <= NOISE) return [];
  const edits: SceneEdit[] = [{ edit: "setAnchor", objectIds: [object.id], anchor: { x: ax, y: ay } } as SceneEdit];
  const mode = options.keyed ?? "insert";
  const frame = options.frame ?? 0;
  if (!Number.isSafeInteger(frame) || frame < 0) return { refused: "The playhead is not on a whole frame." };

  if (mode === "modify" && keyedFields.length > 0) {
    const turned = (["rotation", "scaleX", "scaleY"] as const).find((field) => keysOf(document, object.id, field).length > 0);
    if (turned !== undefined) {
      return { refused: `${object.name} has keys on ${turned}, so one distance cannot keep its picture at every frame. Insert a keyframe at the playhead instead.` };
    }
    // The distance is the same at every frame, so every key moves by it and the picture stays where it was throughout.
    const moved = toSceneDelta(from, ax - from.anchorX, ay - from.anchorY);
    for (const [field, by, base] of [["x", moved.x, from.x], ["y", moved.y, from.y]] as const) {
      const keys = keysOf(document, object.id, field);
      if (keys.length === 0) {
        if (Math.abs(by) > NOISE) edits.push({ edit: "setObjectField", objectIds: [object.id], field: { name: field, value: tidy(base + by) } } as SceneEdit);
        continue;
      }
      for (const key of keys) {
        edits.push({ edit: "updateKeyframe", objectId: object.id, property: field, keyframe: { ...(key as object), value: tidy(key.value + by) } } as unknown as SceneEdit);
      }
    }
    return edits;
  }

  // Insert: hold the picture at the playhead, using the object as it is drawn there.
  const shown = (options.view ?? document).objects.find((candidate) => candidate.id === object.id) ?? object;
  const here = placementOf(shown);
  const moved = toSceneDelta(here, ax - from.anchorX, ay - from.anchorY);
  for (const [field, value] of [["x", here.x + moved.x], ["y", here.y + moved.y]] as const) {
    if (keysOf(document, object.id, field).length > 0) {
      edits.push({ edit: "editProperty", objectId: object.id, property: field, value: tidy(value), frame: frame as unknown as bigint, autoKey: true } as SceneEdit);
    } else if (Math.abs(value - (field === "x" ? from.x : from.y)) > NOISE) {
      edits.push({ edit: "setObjectField", objectIds: [object.id], field: { name: field, value: tidy(value) } } as SceneEdit);
    }
  }
  return edits;
}

/** The edits for a pivot request over the selected objects, or the reason by name that nothing can be sent. */
export function pivotPlan(
  document: SceneDocument,
  selectedIds: readonly string[],
  request: PivotRequest,
  options: PivotOptions = {},
): readonly SceneEdit[] | EditRefused {
  const keepInPlace = options.keepInPlace ?? true;
  const byId = new Map(document.objects.map((object) => [object.id, object]));
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
      if (group?.locked === true) return { refused: `${object.name} is in ${group.name}, which is locked. Unlock it first; nothing was changed.` };
    }
  }
  const nothing = objects.filter((object) => NO_BOX.has(object.type) || object.type === "mesh");
  if (nothing.length > 0) {
    return {
      refused: NO_BOX.has(nothing[0]!.type)
        ? `${named(nothing)} draws nothing of its own, so it has no pivot to place. Select the items inside it.`
        : `${named(nothing)} keeps its pivot in 3D, which the pivot tools do not place yet.`,
    };
  }
  if (keepInPlace) {
    const flat = objects.filter((object) => object.scaleX === 0 || object.scaleY === 0);
    if (flat.length > 0) return { refused: `${named(flat)} ${flat.length === 1 ? "has" : "have"} a scale of 0, so the pivot cannot be placed without moving what is drawn.` };
  }

  const edits: SceneEdit[] = [];
  if (request.kind === "selection") {
    const grouped = objects.filter((object) => parents.has(object.id));
    if (grouped.length > 0) {
      return { refused: `${named(grouped)} ${grouped.length === 1 ? "is" : "are"} inside a group, whose own space is not read yet. Place the pivots one object at a time, or select items outside every group.` };
    }
    const place = GRID.find((cell) => cell.id === request.place);
    if (place === undefined) return { refused: `${request.place} is not a place on the box.` };
    // The point is on the canvas as it is drawn at the playhead, so the boxes and the objects' places come from `view`.
    const drawn = new Map((options.view ?? document).objects.map((candidate) => [candidate.id, candidate]));
    const boxes = objects.map((object) => objectOverlayBounds(drawn.get(object.id) ?? object));
    const left = Math.min(...boxes.map((box) => box.x));
    const top = Math.min(...boxes.map((box) => box.y));
    const right = Math.max(...boxes.map((box) => box.x + box.width));
    const bottom = Math.max(...boxes.map((box) => box.y + box.height));
    const scene: OverlayPoint = {
      x: left + place.fx * (right - left) + (request.offset?.x ?? 0),
      y: top + place.fy * (bottom - top) + (request.offset?.y ?? 0),
    };
    for (const object of objects) {
      const from = placementOf(drawn.get(object.id) ?? object);
      const local = toLocalDelta(from, scene.x - from.x, scene.y - from.y);
      if (local === undefined) return { refused: `${object.name} has a scale of 0, so a point on the canvas cannot be found in it.` };
      const made = placeEdits(document, object, { x: from.anchorX + local.x, y: from.anchorY + local.y }, keepInPlace, options);
      if (isRefused(made)) return made;
      edits.push(...made);
    }
  } else {
    for (const object of objects) {
      const from = placementOf(object);
      const box = localBox(object);
      let target: Point;
      switch (request.kind) {
        case "grid": {
          const place = GRID.find((cell) => cell.id === request.place);
          if (place === undefined) return { refused: `${request.place} is not a place on the box.` };
          if (box === undefined) return { refused: `${object.name} has no box of its own to place a pivot on. Type a point, or use the Pivot tool.` };
          target = {
            x: box.left + place.fx * box.width + (request.offset?.x ?? 0),
            y: box.top + place.fy * box.height + (request.offset?.y ?? 0),
          };
          break;
        }
        case "reset":
          target = { x: 0, y: 0 };
          break;
        case "point":
          target = { x: request.x ?? from.anchorX, y: request.y ?? from.anchorY };
          break;
        case "nudge":
          target = { x: from.anchorX + request.dx, y: from.anchorY + request.dy };
          break;
      }
      if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return { refused: "The pivot must be a number." };
      const made = placeEdits(document, object, target, keepInPlace, options);
      if (isRefused(made)) return made;
      edits.push(...made);
    }
  }
  if (edits.length === 0) return { refused: "The pivot is already there; nothing was changed." };
  return edits;
}

/** The words for the Activity line and the undo entry of a pivot request. */
export function pivotLabel(objects: readonly { name: string }[], request: PivotRequest, keepInPlace: boolean): string {
  const who = named(objects);
  const how = keepInPlace ? "" : ", the picture moving with it";
  switch (request.kind) {
    case "grid":
    case "selection": {
      const place = GRID.find((cell) => cell.id === request.place)?.label.toLowerCase() ?? request.place;
      return `Put the pivot of ${who} at its ${place}${request.kind === "selection" ? " of the selection" : ""}${how}`;
    }
    case "reset":
      return `Put the pivot of ${who} back at its origin${how}`;
    case "point":
      return `Put the pivot of ${who} at ${request.x ?? "its x"}, ${request.y ?? "its y"}${how}`;
    case "nudge":
      return `Nudged the pivot of ${who} by ${tidy(request.dx)}, ${tidy(request.dy)}${how}`;
  }
}
