// 11.117: masks and track mattes in the Editor (Masking spec v2, 1.2, 2.1, 2.2).
//
// The engine draws masks (3.19, 3.26, 3.27) and track mattes (3.19, 3.30); this is the Editor's side of them, as pure
// functions that turn what the author asked into scene edits. The page draws the controls and sends the edits; nothing here
// touches the DOM. The mask's path is edited by the path tools (11.107); a mask's mode, invert, opacity, feather, expansion
// and place in the stack are here, and a matte's source, mode and clear.
//
// **One change is one edit.** A number dragged or typed is one `setObjectMasks` (the whole list, so the order is part of it
// and reordering is one undo step); a matte set is one batch, so undo returns the matte and the source's eye together.
//
// **The source's eye.** After Effects turns a layer's eye off when it becomes a matte, and the engine now draws a matte
// source when it is visible (3.30), so setting a matte hides the source in the same batch, and clearing it does not bring
// the source back (the author may have hidden it for another reason).

import type { BezierPath, FeatherPoint, Mask, MaskFalloff, MaskMode, SceneDocument, SceneEdit, SceneObject, TrackMatteMode } from "@grapix/contracts";

import { effectivePlacement, toLocalDelta, toSceneDelta } from "./anchor-point";
import type { MaskSketch } from "./overlay";
import { cubicOf, effective, mapCubic, nearestOnPath, pointAt, segmentCount } from "./path-geometry";
import { MASKABLE, toCanvas, toObjectSpace } from "./path-edit";

export const MASK_MODES: readonly MaskMode[] = ["none", "add", "subtract", "intersect", "lighten", "darken", "difference"];
export const MATTE_MODES: readonly TrackMatteMode[] = ["alpha", "alphaInverted", "luma", "lumaInverted"];
export const MASK_FALLOFFS: readonly MaskFalloff[] = ["smooth", "linear"];

/** The engine's limits (`MOST_MASKS`, `MOST_MASK_FEATHER`, `MOST_MASK_EXPANSION` in the scene contract). */
export const MOST_MASKS = 16;
export const MOST_FEATHER = 250;
export const MOST_EXPANSION = 1000;
/** Most feather points one mask holds (`MOST_FEATHER_POINTS`). */
export const MOST_FEATHER_POINTS = 64;

export const MASK_MODE_LABEL: Readonly<Record<MaskMode, string>> = {
  none: "None",
  add: "Add",
  subtract: "Subtract",
  intersect: "Intersect",
  lighten: "Lighten",
  darken: "Darken",
  difference: "Difference",
};

export const MATTE_MODE_LABEL: Readonly<Record<TrackMatteMode, string>> = {
  alpha: "Alpha",
  alphaInverted: "Alpha inverted",
  luma: "Luma",
  lumaInverted: "Luma inverted",
};

export interface Refused {
  readonly refused: string;
}

export const isRefused = <T extends object>(outcome: T | Refused): outcome is Refused => "refused" in outcome;

export interface MaskTarget {
  readonly object: SceneObject;
  readonly masks: readonly Mask[];
}

/** The object whose masks and matte can be edited: exactly one selected, drawing pixels, and not locked. */
export function maskTarget(document: SceneDocument, selectedIds: readonly string[]): MaskTarget | Refused {
  if (selectedIds.length === 0) return { refused: "Select a layer to give it masks or a track matte." };
  if (selectedIds.length > 1) return { refused: "Select one layer to edit its masks." };
  const object = document.objects.find((candidate) => candidate.id === selectedIds[0]);
  if (object === undefined) return { refused: "That object is not in the scene." };
  if (!MASKABLE.includes(object.type)) return { refused: `${object.name} draws no pixels, so it takes no mask or matte.` };
  if (object.locked) return { refused: `${object.name} is locked. Unlock it first; nothing was changed.` };
  return { object, masks: object.masks ?? [] };
}

/** A closed rectangle path over `width` x `height` in the object's own space. */
function rectanglePath(width: number, height: number): BezierPath {
  const zero = { x: 0, y: 0 };
  return {
    closed: true,
    vertices: [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }],
    inTangents: [zero, zero, zero, zero],
    outTangents: [zero, zero, zero, zero],
  };
}

/** The lowest free `mask-N` among `masks`: the id an effect's mask reference keeps through reordering and renaming (3.28). */
export function freeMaskId(masks: readonly Mask[]): string {
  const taken = new Set(masks.map((mask) => mask.id));
  for (let n = 1; ; n += 1) {
    if (!taken.has(`mask-${n}`)) return `mask-${n}`;
  }
}

/** A new mask: an Add over the object's box (100 x 100 for one with no box), no feather, at full opacity, with an id that no
 *  mask of the layer has. */
export function defaultMask(object: SceneObject, masks: readonly Mask[] = object.masks ?? []): Mask {
  const width = object.width > 0 ? object.width : 100;
  const height = object.height > 0 ? object.height : 100;
  return { id: freeMaskId(masks), path: rectanglePath(width, height), mode: "add", feather: 0, expansion: 0, opacity: 1, inverted: false };
}

const setMasks = (objectId: string, masks: readonly Mask[]): SceneEdit => ({ edit: "setObjectMasks", objectId, masks: [...masks] }) as SceneEdit;

/** `Why` the list cannot take one more mask, or `undefined`. */
export function whyNoMoreMasks(target: MaskTarget): string | undefined {
  return target.masks.length >= MOST_MASKS ? `${target.object.name} already has ${MOST_MASKS} masks, the most one layer takes.` : undefined;
}

/** A mask added at the end of the stack: over the layer's box, or over `path` (a path in the layer's own space) when given. */
export function addMask(target: MaskTarget, path?: BezierPath): SceneEdit | Refused {
  const why = whyNoMoreMasks(target);
  if (why !== undefined) return { refused: why };
  const mask = defaultMask(target.object, target.masks);
  return setMasks(target.object.id, [...target.masks, path === undefined ? mask : { ...mask, path }]);
}

/** A mask taken out. An effect that referenced it goes back to the whole layer in the same batch, first, so the engine never
 *  sees a reference to a mask that is gone. */
export function removeMask(target: MaskTarget, index: number): SceneEdit | SceneEdit[] | Refused {
  const gone = target.masks[index];
  if (gone === undefined) return { refused: `There is no mask ${index + 1}.` };
  const remove = setMasks(target.object.id, target.masks.filter((_, at) => at !== index));
  const effects = target.object.effects ?? [];
  if (gone.id === undefined || !effects.some((effect) => effect.maskIds?.includes(gone.id!))) return remove;
  const cleared = effects.map((effect) => {
    if (!effect.maskIds?.includes(gone.id!)) return effect;
    const { maskIds, ...rest } = effect;
    const left = maskIds.filter((id) => id !== gone.id);
    return left.length === 0 ? rest : { ...rest, maskIds: left };
  });
  return [{ edit: "setEffects", objectId: target.object.id, effects: cleared } as SceneEdit, remove];
}

/** A mask moved up (`-1`) or down (`1`) the stack: one edit, so one undo step. The order decides the result. */
export function moveMask(target: MaskTarget, index: number, by: -1 | 1): SceneEdit | Refused {
  const to = index + by;
  if (index < 0 || index >= target.masks.length) return { refused: `There is no mask ${index + 1}.` };
  if (to < 0 || to >= target.masks.length) return { refused: by < 0 ? "That mask is already first." : "That mask is already last." };
  const next = [...target.masks];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return setMasks(target.object.id, next);
}

/** What the controls can change about one mask. `featherY: undefined` is "the same as feather". */
export interface MaskPatch {
  readonly mode?: MaskMode;
  readonly inverted?: boolean;
  readonly opacity?: number;
  readonly feather?: number;
  readonly featherY?: number | null;
  readonly falloff?: MaskFalloff;
  readonly expansion?: number;
  /** Variable feather (11.108): the whole list; an empty one goes back to the uniform feather. */
  readonly featherPoints?: readonly FeatherPoint[];
}

const inRange = (value: number, low: number, high: number): boolean => Number.isFinite(value) && value >= low && value <= high;

/** `Why` a patch is not allowed, in the author's words (the engine refuses the same values by name). */
export function whyNotPatch(patch: MaskPatch): string | undefined {
  if (patch.opacity !== undefined && !inRange(patch.opacity, 0, 1)) return "Opacity is from 0 to 100%.";
  if (patch.feather !== undefined && !inRange(patch.feather, 0, MOST_FEATHER)) return `Feather is from 0 to ${MOST_FEATHER} pixels.`;
  if (typeof patch.featherY === "number" && !inRange(patch.featherY, 0, MOST_FEATHER)) return `Feather is from 0 to ${MOST_FEATHER} pixels.`;
  if (patch.featherPoints !== undefined && patch.featherPoints.length > MOST_FEATHER_POINTS) return `A mask has at most ${MOST_FEATHER_POINTS} feather points.`;
  for (const point of patch.featherPoints ?? []) {
    if (!(Number.isInteger(point.segment) && point.segment >= 0)) return "A feather point is on a segment of the path: a whole number from 0.";
    if (!inRange(point.t, 0, 1)) return "A feather point is at a place from 0 to 1 along its segment.";
    if (!inRange(point.radius, -MOST_FEATHER, MOST_FEATHER)) return `A feather point has a radius from -${MOST_FEATHER} to ${MOST_FEATHER} pixels.`;
    if (!inRange(point.tension, 0, 1)) return "A feather point has a tension from 0 to 1.";
  }
  if (patch.expansion !== undefined && !inRange(patch.expansion, -MOST_EXPANSION, MOST_EXPANSION)) {
    return `Expansion is from -${MOST_EXPANSION} to ${MOST_EXPANSION} pixels.`;
  }
  return undefined;
}

export function patchMask(target: MaskTarget, index: number, patch: MaskPatch): SceneEdit | Refused {
  const mask = target.masks[index];
  if (mask === undefined) return { refused: `There is no mask ${index + 1}.` };
  const why = whyNotPatch(patch);
  if (why !== undefined) return { refused: why };
  const { featherY, falloff, featherPoints, ...rest } = patch;
  // `featherY` null clears it (the same as feather); a smooth falloff is the default, so it is left out.
  const merged: Record<string, unknown> = { ...mask, ...rest };
  if (featherY !== undefined) {
    if (featherY === null) delete merged.featherY;
    else merged.featherY = featherY;
  }
  if (falloff !== undefined) {
    if (falloff === "smooth") delete merged.falloff;
    else merged.falloff = falloff;
  }
  if (featherPoints !== undefined) {
    if (featherPoints.length === 0) delete merged.featherPoints;
    else merged.featherPoints = featherPoints.map((point) => ({ ...point }));
  }
  const kept = (merged.featherPoints as readonly FeatherPoint[] | undefined) ?? [];
  const segments = segmentCount(mask.path);
  if (kept.some((point) => point.segment >= segments)) return { refused: `The path has ${segments} segments: a feather point is on one of them.` };
  return setMasks(target.object.id, target.masks.map((existing, at) => (at === index ? (merged as unknown as Mask) : existing)));
}

/** The variable feather of mask `index` with a point added where the canvas point `at` is nearest its path (11.108): a new point takes half the
 *  mask's uniform feather outward, or 10 pixels. One edit. */
export function addFeatherPointAt(document: SceneDocument, target: MaskTarget, index: number, at: { readonly x: number; readonly y: number }): SceneEdit | Refused {
  const mask = target.masks[index];
  if (mask === undefined) return { refused: `There is no mask ${index + 1}.` };
  const placement = effectivePlacement(document, target.object);
  const local = toObjectSpace(placement, at);
  if (local === undefined) return { refused: `${target.object.name} is scaled to nothing.` };
  const hit = nearestOnPath(mask.path, local);
  if (hit === undefined) return { refused: `Mask ${index + 1} has no path to put a point on.` };
  const point: FeatherPoint = { segment: hit.segment, t: Math.round(hit.t * 1000) / 1000, radius: mask.feather > 0 ? mask.feather / 2 : 10, tension: 0.5 };
  return patchMask(target, index, { featherPoints: [...(mask.featherPoints ?? []), point] });
}

/** Where a mask's feather points are on the canvas, and how far each one's feather reaches there (scaled by the layer), for the viewport. */
export function featherPointMarks(document: SceneDocument, object: SceneObject, mask: Mask): { x: number; y: number; radius: number }[] {
  const points = mask.featherPoints ?? [];
  if (points.length === 0) return [];
  const placement = effectivePlacement(document, object);
  const scale = (Math.abs(object.scaleX) + Math.abs(object.scaleY)) / 2;
  const drawn = effective(mask.path);
  const marks: { x: number; y: number; radius: number }[] = [];
  for (const point of points) {
    if (point.segment >= segmentCount(drawn)) continue;
    const c = mapCubic(cubicOf(drawn, point.segment), (q) => toCanvas(placement, q));
    const p = pointAt(c, point.t);
    marks.push({ x: p.x, y: p.y, radius: point.radius * scale });
  }
  return marks;
}

/** Whether the mask clips: an open path is drawn and edited but does not clip until it is closed (spec 1.2, 12). */
export const clips = (mask: Mask): boolean => mask.path.closed && mask.mode !== "none";

/** One line for the mask row: what it does now, including why it does nothing. */
export function maskStatus(mask: Mask): string {
  if (!mask.path.closed) return "Open path: drawn, but it does not clip until it is closed.";
  if (mask.mode === "none") return "Mode None: the path shapes nothing.";
  return `${MASK_MODE_LABEL[mask.mode]}${mask.inverted ? ", inverted" : ""}.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Track mattes

/** The layers that can be a matte for `object`: they draw pixels, are not the object itself and have no matte of their own. */
export function matteSources(document: SceneDocument, objectId: string): SceneObject[] {
  return document.objects.filter(
    (candidate) => candidate.id !== objectId && MASKABLE.includes(candidate.type) && candidate.trackMatte === undefined,
  );
}

/** The matte inspection views (3.30, spec 6.5), in the words of the select, and what one says about the matte it shows. */
export const MATTE_VIEWS = ["off", "alpha", "luma", "applied", "before"] as const;
export type MatteViewChoice = (typeof MATTE_VIEWS)[number];
export const MATTE_VIEW_LABEL: Readonly<Record<MatteViewChoice, string>> = {
  off: "Normal view",
  alpha: "Matte alpha",
  luma: "Matte luma",
  applied: "Applied matte",
  before: "Target before matte",
};

/** One line saying what the matte view shows: the source, its size, the channel and whether it is inverted, and whether it is drawn too. */
export function matteViewInfo(document: SceneDocument, object: SceneObject): string | undefined {
  const matte = object.trackMatte;
  const source = matte === undefined ? undefined : document.objects.find((candidate) => candidate.id === matte.sourceId);
  if (matte === undefined || source === undefined) return undefined;
  return `Source ${source.name} (${source.id}), ${Math.round(source.width)} x ${Math.round(source.height)} px, ${MATTE_MODE_LABEL[matte.mode]}, ${source.visible ? "also drawn" : "not drawn"}, opacity ${Math.round(source.opacity * 100)}%.`;
}

/** The words for a layer whose track matte source is no longer in the scene (3.30): it is drawn without a matte, and says so. */
export function matteWarning(document: SceneDocument, object: SceneObject): string | undefined {
  const matte = object.trackMatte;
  if (matte === undefined || document.objects.some((candidate) => candidate.id === matte.sourceId)) return undefined;
  return `The matte source ${matte.sourceId} of ${object.name} is not in the scene, so the layer is drawn without a matte. Choose another source or clear it.`;
}

/** Make `sourceId` the object's matte in `mode`, and turn the source's eye off (as After Effects does). One batch. */
export function setMatte(document: SceneDocument, objectId: string, sourceId: string, mode: TrackMatteMode): SceneEdit[] | Refused {
  const object = document.objects.find((candidate) => candidate.id === objectId);
  const source = document.objects.find((candidate) => candidate.id === sourceId);
  if (object === undefined) return { refused: "That object is not in the scene." };
  if (source === undefined) return { refused: "That matte source is not in the scene." };
  if (sourceId === objectId) return { refused: `${object.name} cannot be its own matte.` };
  if (source.locked) return { refused: `${source.name} is locked. Unlock it first; nothing was changed.` };
  if (!MASKABLE.includes(source.type)) return { refused: `${source.name} draws no pixels, so it cannot be a matte.` };
  // A layer that is another layer's matte may take a matte of its own: a matte reads its source before the source's matte (3.30).
  const edits: SceneEdit[] = [{ edit: "setTrackMatte", objectId, trackMatte: { sourceId, mode } } as SceneEdit];
  if (source.visible) edits.push({ edit: "setObjectVisible", objectId: sourceId, visible: false } as SceneEdit);
  return edits;
}

/** Change only the mode of a matte that is set. */
export function setMatteMode(object: SceneObject, mode: TrackMatteMode): SceneEdit | Refused {
  if (object.trackMatte === undefined) return { refused: `${object.name} has no track matte.` };
  return { edit: "setTrackMatte", objectId: object.id, trackMatte: { sourceId: object.trackMatte.sourceId, mode } } as SceneEdit;
}

/** Take the matte off. The source's eye is left as it is. */
export function clearMatte(object: SceneObject): SceneEdit | Refused {
  if (object.trackMatte === undefined) return { refused: `${object.name} has no track matte.` };
  return { edit: "setTrackMatte", objectId: object.id } as SceneEdit;
}

// ---------------------------------------------------------------------------------------------------------------------
// A path copied between a shape and a mask (11.118, Pen spec v2, 12 and 23). The copy is independent, the spec's default:
// changing the shape afterwards does not change the mask. The two spaces are the objects' own, so a point goes through the
// canvas on its way.

type Pt = { x: number; y: number };

function mapPath(path: BezierPath, point: (p: Pt) => Pt | undefined, delta: (p: Pt) => Pt | undefined): BezierPath | undefined {
  const vertices = path.vertices.map(point);
  const inTangents = path.inTangents.map(delta);
  const outTangents = path.outTangents.map(delta);
  if ([...vertices, ...inTangents, ...outTangents].some((p) => p === undefined)) return undefined;
  return { closed: path.closed, vertices: vertices as Pt[], inTangents: inTangents as Pt[], outTangents: outTangents as Pt[] };
}

/** The shapes whose path can be copied to a mask: a closed path (an open one clips nothing). */
export function copyableShapes(document: SceneDocument, objectId: string): SceneObject[] {
  return document.objects.filter((candidate) => candidate.type === "shape" && candidate.id !== objectId && candidate.path.closed);
}

/** A new mask on the target, a copy of the shape's main path. One edit. */
export function copyShapeToMask(document: SceneDocument, target: MaskTarget, shapeId: string): SceneEdit | Refused {
  const shape = document.objects.find((candidate) => candidate.id === shapeId);
  if (shape === undefined || shape.type !== "shape") return { refused: "That shape is not in the scene." };
  if (!shape.path.closed) return { refused: `${shape.name} is an open path, which clips nothing. Close it first.` };
  const from = effectivePlacement(document, shape);
  const to = effectivePlacement(document, target.object);
  const path = mapPath(
    shape.path,
    (p) => toObjectSpace(to, toCanvas(from, p)),
    (p) => {
      const onCanvas = toSceneDelta(from, p.x, p.y);
      return toLocalDelta(to, onCanvas.x, onCanvas.y);
    },
  );
  if (path === undefined) return { refused: `${target.object.name} is scaled to nothing, so a path cannot be put on it.` };
  return addMask(target, path);
}

/** The mask's path made the same path as the shape's main path, in each one's own space (11.112): the numbers of the shape are copied in and
 *  the two are one path from then on, an edit of either changing both. One edit; the mask gets an id from the engine if it has none. */
export function linkMaskToShape(document: SceneDocument, object: SceneObject, index: number, shapeId: string): SceneEdit | Refused {
  const mask = object.masks?.[index];
  if (mask === undefined) return { refused: `There is no mask ${index + 1}.` };
  const shape = document.objects.find((candidate) => candidate.id === shapeId);
  if (shape === undefined || shape.type !== "shape") return { refused: "That shape is not in the scene." };
  if (!shape.path.closed) return { refused: `${shape.name} is an open path, which clips nothing. Close it first.` };
  return {
    edit: "linkPaths",
    source: { objectId: shape.id, target: { kind: "shape", subpath: 0 } },
    target: { objectId: object.id, target: { kind: "mask", index } },
  } as SceneEdit;
}

/** One path taken out of its link: it keeps what it has and is independent from then on. One edit. */
export function unlinkPath(objectId: string, target: { kind: "shape"; subpath: number } | { kind: "mask"; index: number }): SceneEdit {
  return { edit: "unlinkPath", path: { objectId, target } } as SceneEdit;
}

/** A new shape that is a copy of one mask's path, drawn where the mask is (its points on the canvas). One edit. */
export function copyMaskToShape(document: SceneDocument, object: SceneObject, index: number): SceneEdit | Refused {
  const mask = object.masks?.[index];
  if (mask === undefined) return { refused: `There is no mask ${index + 1}.` };
  const from = effectivePlacement(document, object);
  const path = mapPath(
    mask.path,
    (p) => toCanvas(from, p),
    (p) => toSceneDelta(from, p.x, p.y),
  );
  if (path === undefined) return { refused: `${object.name} is scaled to nothing.` };
  return { edit: "createShape", name: `${object.name} mask ${index + 1}`, path } as SceneEdit;
}

// ---------------------------------------------------------------------------------------------------------------------
// Effect mask references and Preserve Underlying Transparency (3.28)

/** An effect limited to one mask of the layer by id, or back to the whole layer (`null`): one `setEffects`. */
export function setEffectMask(object: SceneObject, effectIndex: number, maskId: string | null): SceneEdit | Refused {
  const effects = object.effects ?? [];
  const effect = effects[effectIndex];
  if (effect === undefined) return { refused: `${object.name} has no effect ${effectIndex + 1}.` };
  if (maskId !== null && !(object.masks ?? []).some((mask) => mask.id === maskId)) {
    return { refused: `${object.name} has no mask with the id ${maskId}.` };
  }
  const { maskIds: _was, ...rest } = effect;
  const next = maskId === null ? rest : { ...rest, maskIds: [maskId] };
  return { edit: "setEffects", objectId: object.id, effects: effects.map((existing, at) => (at === effectIndex ? next : existing)) } as SceneEdit;
}

/** Preserve Underlying Transparency on or off. Refused when it already is so. */
export function setPreserve(object: SceneObject, on: boolean): SceneEdit | Refused {
  if ((object.preserveUnderlyingTransparency === true) === on) {
    return { refused: `${object.name} already has Preserve Underlying Transparency ${on ? "on" : "off"}.` };
  }
  return { edit: "setPreserveTransparency", objectId: object.id, preserve: on } as SceneEdit;
}

// ---------------------------------------------------------------------------------------------------------------------
// The masks on the canvas (11.117)

const round2 = (n: number): string => String(Math.round(n * 100) / 100);

/** The boundary and feather band of every mask of `object`, in canvas coordinates, for the viewport. `active` is the mask the
 *  path tools are editing. A mask is drawn whatever its mode: a mode None path is still a path an effect may refer to. */
export function maskSketches(document: SceneDocument, object: SceneObject, active?: number): MaskSketch[] {
  const placement = effectivePlacement(document, object);
  const scale = (Math.abs(object.scaleX) + Math.abs(object.scaleY)) / 2;
  return (object.masks ?? []).map((mask, index) => {
    const path = effective(mask.path);
    let d = "";
    if (path.vertices.length > 0) {
      const at = (q: { x: number; y: number }) => toCanvas(placement, q);
      const start = at(path.vertices[0]!);
      d = `M ${round2(start.x)} ${round2(start.y)}`;
      for (let s = 0; s < segmentCount(path); s += 1) {
        const c = mapCubic(cubicOf(path, s), at);
        d += ` C ${round2(c.p1.x)} ${round2(c.p1.y)} ${round2(c.p2.x)} ${round2(c.p2.y)} ${round2(c.p3.x)} ${round2(c.p3.y)}`;
      }
      if (path.closed) d += " Z";
    }
    // A variable feather (11.108) replaces the uniform one, so the band is not drawn for it; its points are.
    const variable = (mask.featherPoints?.length ?? 0) > 0;
    const feather = variable ? 0 : ((mask.feather + (mask.featherY ?? mask.feather)) / 2) * scale;
    const marks = featherPointMarks(document, object, mask);
    return { d, feather, open: !path.closed, mode: mask.mode, index, active: index === active, ...(marks.length === 0 ? {} : { featherPoints: marks }) };
  });
}

