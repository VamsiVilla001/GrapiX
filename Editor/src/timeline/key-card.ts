// The keyframe card: what the Properties area shows while keys are selected (the new Figma UI, B3; plan row 11.131).
//
// The design titles it "Keyframe · Name plate · Position · frame 20" and lists TIME, VALUE, INTERPOLATION and ELEMENT · NAME.
// In the contract each property is its own channel with its own keys, so a selected key belongs to one channel and a Position
// change is two keys (x and y) on one frame. The card therefore has two shapes:
//
//   - **a moment**: the selected keys are all on one element at one frame (a click on one key, or on x and y together). It
//     lists each selected channel's value, the frame, the easing of the segment that leaves the key and how strongly it eases
//     in and out, and the element's Parent, Blend and Matte;
//   - **a spread**: keys on several frames or elements, or a path key. It says how many and over which frames, and offers
//     only the easing buttons, because a single frame or value would be a lie.
//
// What the contract does not have is not drawn: the design's `Path` row (spatial interpolation, row 11.133) has nothing to
// read or write. Ease in and Ease out are read from the curve and shown, not edited here (the graph edits them).
//
// This module is pure: it reads the scene and builds the edits a field change sends. The view draws it.

import type { CubicBezier, SceneDocument, SceneEasing, SceneEdit, SceneKeyframe, SceneObject } from "@grapix/contracts";

import { wireFrame } from "../command-client";
import { propertyLabel } from "../keyframe-editor";
import { segmentControlPoints, EASY_EASE_INFLUENCE } from "./easing";
import { layerColumns, type LayerColumns } from "./layer-columns";
import { parseKeyId, type TimelineModel } from "./model";
import { planMove, type EditPlan } from "./key-edit";

/** The design's names for the properties that come as a pair or a trio of channels. */
const GROUPS: Readonly<Record<string, string>> = {
  x: "Position",
  y: "Position",
  zDepth: "Position",
  scaleX: "Scale",
  scaleY: "Scale",
  scaleZ: "Scale",
  rotation: "Rotation",
  rotationX: "Rotation",
  rotationY: "Rotation",
};

/** How a property's stored number is shown: a unit, and the factor from the stored number to the shown one. */
interface Unit {
  readonly suffix: string;
  readonly factor: number;
}
const UNITS: Readonly<Record<string, Unit>> = {
  x: { suffix: "px", factor: 1 },
  y: { suffix: "px", factor: 1 },
  zDepth: { suffix: "px", factor: 1 },
  width: { suffix: "px", factor: 1 },
  height: { suffix: "px", factor: 1 },
  opacity: { suffix: "%", factor: 100 },
  scaleX: { suffix: "%", factor: 100 },
  scaleY: { suffix: "%", factor: 100 },
  scaleZ: { suffix: "%", factor: 100 },
  rotation: { suffix: "°", factor: 1 },
  rotationX: { suffix: "°", factor: 1 },
  rotationY: { suffix: "°", factor: 1 },
};
const PLAIN: Unit = { suffix: "", factor: 1 };
const unitOf = (property: string): Unit => UNITS[property] ?? PLAIN;

const round = (value: number, places = 2): number => Math.round(value * 10 ** places) / 10 ** places;

/** A stored value as the field shows it, without its unit: `0.5` opacity is `50`. */
export const shownValue = (property: string, stored: number): number => round(stored * unitOf(property).factor);
/** What a typed number stores. */
export const storedValue = (property: string, shown: number): number => shown / unitOf(property).factor;
export const unitSuffix = (property: string): string => unitOf(property).suffix;

export const EASING_LABEL: Readonly<Record<string, string>> = {
  linear: "Linear",
  hold: "Hold",
  "ease-in": "Ease in",
  "ease-out": "Ease out",
  "ease-in-out": "Ease in-out",
  bounce: "Bounce",
  elastic: "Elastic",
  "custom-bezier": "Custom curve",
};

const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;
/** Whether a segment's easing is a cubic bezier whose handles can be read and typed: Hold, Bounce and Elastic are not. */
const hasHandles = (easing: string): boolean => easing !== "hold" && easing !== "bounce" && easing !== "elastic";
/** Eases that are a single cubic bezier and so need no easing of their own in the contract: Back overshoots its target and settles. */
export const BEZIER_PRESETS: Readonly<Record<string, { readonly label: string; readonly bezier: CubicBezier }>> = {
  "back-out": { label: "Back out", bezier: { x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 } },
  "back-in": { label: "Back in", bezier: { x1: 0.36, y1: 0, x2: 0.66, y2: -0.56 } },
};
const sameCurve = (a: CubicBezier, b: CubicBezier): boolean => near(a.x1, b.x1) && near(a.y1, b.y1) && near(a.x2, b.x2) && near(a.y2, b.y2);
/** Easy Ease on both sides, the bezier F9 writes. */
const isEasyEase = (curve: CubicBezier): boolean =>
  near(curve.x1, EASY_EASE_INFLUENCE) && near(curve.y1, 0) && near(curve.x2, 1 - EASY_EASE_INFLUENCE) && near(curve.y2, 1);

/** The word for a key's outgoing segment: Ease for the F9 curve, else the stored easing's name. */
export function overTimeLabel(key: SceneKeyframe): string {
  if (key.easing === "custom-bezier") {
    const curve = segmentControlPoints(key);
    if (isEasyEase(curve)) return "Ease";
    const preset = Object.values(BEZIER_PRESETS).find((candidate) => sameCurve(candidate.bezier, curve));
    return preset === undefined ? "Custom curve" : preset.label;
  }
  return EASING_LABEL[key.easing] ?? key.easing;
}

export type ActiveEase = "linear" | "ease" | "hold";

export interface KeyCardValue {
  readonly property: string;
  readonly label: string;
  /** The number the field shows, in the shown unit. */
  readonly shown: number;
  readonly suffix: string;
}

export interface KeyCard {
  readonly title: string;
  /** One element at one frame, so there is a frame and values to show and edit. */
  readonly moment?: {
    readonly objectId: string;
    readonly frame: number;
    readonly frameText: string;
    readonly values: readonly KeyCardValue[];
    readonly overTime: string;
    /** The stored easing of the first selected key, for the select; "mixed" when the keys differ. */
    readonly easing: SceneEasing | "mixed";
    readonly easeIn: string;
    readonly easeOut: string;
    /** What the Ease in and Ease out fields hold, in percent; `undefined` when that side has no curve to edit (no neighbour, or Hold). */
    readonly influence: { readonly in?: number; readonly out?: number };
    readonly element: LayerColumns;
  };
  /** A spread of keys: how many and over which frames. */
  readonly summary?: string;
  readonly active?: ActiveEase;
}

interface Found {
  readonly objectId: string;
  readonly property: string;
  readonly frame: number;
  readonly key: SceneKeyframe;
  readonly index: number;
  readonly keys: readonly SceneKeyframe[];
}

function find(document: SceneDocument, keyId: string): Found | undefined {
  const parsed = parseKeyId(keyId);
  if (parsed === undefined) return undefined;
  const channel = (document.timeline.channels ?? []).find((c) => c.objectId === parsed.objectId && c.property === parsed.property);
  if (channel === undefined) return undefined;
  const index = channel.keys.findIndex((k) => Number(k.frame) === parsed.frame);
  const key = channel.keys[index];
  return key === undefined ? undefined : { ...parsed, key, index, keys: channel.keys };
}

const percent = (influence: number): string => `${round(influence * 100, 1)} %`;

/** `20 · 400 ms` */
export function frameText(frame: number, rate: { readonly num: number; readonly den: number }): string {
  const ms = rate.num > 0 ? Math.round((frame * 1000 * rate.den) / rate.num) : 0;
  return `${frame} · ${ms} ms`;
}

function activeOf(keys: readonly SceneKeyframe[]): ActiveEase | undefined {
  const words = new Set(keys.map((k) => (k.easing === "linear" ? "linear" : k.easing === "hold" ? "hold" : k.easing === "custom-bezier" && isEasyEase(segmentControlPoints(k)) ? "ease" : "other")));
  const only = words.size === 1 ? [...words][0] : undefined;
  return only === "linear" || only === "hold" || only === "ease" ? only : undefined;
}

/** The card for the selected keys, or `undefined` when none of them is in the scene any more. */
export function keyCard(
  document: SceneDocument,
  keyIds: readonly string[],
  rate: { readonly num: number; readonly den: number },
): KeyCard | undefined {
  const parsed = keyIds.map((id) => parseKeyId(id));
  const found = keyIds.map((id) => find(document, id)).filter((f): f is Found => f !== undefined);
  // A path key has no plain channel here; it still belongs to the selection, so the card says "a spread".
  const known = parsed.filter((p) => p !== undefined);
  if (known.length === 0) return undefined;
  if (found.length === 0 && !known.some((p) => document.objects.some((o) => o.id === p!.objectId))) return undefined;

  const active = activeOf(found.map((f) => f.key));
  const objectIds = new Set(known.map((p) => p!.objectId));
  const frames = [...new Set(known.map((p) => p!.frame))].sort((a, b) => a - b);

  if (found.length === known.length && objectIds.size === 1 && frames.length === 1) {
    const object = document.objects.find((o) => o.id === found[0]!.objectId) as SceneObject | undefined;
    if (object !== undefined) {
      const first = found[0]!;
      const properties = found.map((f) => f.property);
      const group = properties.every((p) => GROUPS[p] === GROUPS[properties[0]!] && GROUPS[p] !== undefined) ? GROUPS[properties[0]!]! : undefined;
      const what = group ?? (properties.length === 1 ? propertyLabel(properties[0]!) : `${properties.length} properties`);
      const easings = new Set(found.map((f) => f.key.easing));
      const out = first.key;
      const next = first.keys[first.index + 1];
      const before = first.keys[first.index - 1];
      const curved = (k: SceneKeyframe) => k.easing !== "linear" && hasHandles(k.easing);
      return {
        title: `Keyframe · ${object.name} · ${what} · frame ${first.frame}`,
        moment: {
          objectId: object.id,
          frame: first.frame,
          frameText: frameText(first.frame, rate),
          values: found.map((f) => ({ property: f.property, label: propertyLabel(f.property), shown: shownValue(f.property, f.key.value), suffix: unitSuffix(f.property) })),
          overTime: easings.size === 1 ? overTimeLabel(out) : "Mixed",
          easing: easings.size === 1 ? out.easing : "mixed",
          // The leaving side is this key's own curve; the arriving side is the previous key's, seen from its far end.
          easeOut: next !== undefined && curved(out) ? percent(segmentControlPoints(out).x1) : "—",
          easeIn: before !== undefined && curved(before) ? percent(1 - segmentControlPoints(before).x2) : "—",
          influence: {
            ...(next !== undefined && hasHandles(out.easing) ? { out: round(segmentControlPoints(out).x1 * 100, 1) } : {}),
            ...(before !== undefined && hasHandles(before.easing) ? { in: round((1 - segmentControlPoints(before).x2) * 100, 1) } : {}),
          },
          element: layerColumns(document, object),
        },
        ...(active === undefined ? {} : { active }),
      };
    }
  }

  const count = known.length;
  const span = frames.length === 1 ? `frame ${frames[0]}` : `frames ${frames[0]} to ${frames[frames.length - 1]}`;
  const where = objectIds.size === 1 ? ` on ${document.objects.find((o) => o.id === [...objectIds][0])?.name ?? [...objectIds][0]}` : ` on ${objectIds.size} elements`;
  return { title: `${count} keyframes selected`, summary: `${count} keys, ${span}${where}. Choose an ease below, or select one key to edit its time and value.`, ...(active === undefined ? {} : { active }) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The edits a field change sends.

/** The key's value changed; its frame, easing and curve stay. */
export function planSetKeyValue(document: SceneDocument, keyId: string, shown: number): EditPlan {
  if (!Number.isFinite(shown)) return { refused: "A value must be a number." };
  const at = find(document, keyId);
  if (at === undefined) return { refused: "That key is not in the scene." };
  return {
    edits: [
      {
        edit: "updateKeyframe",
        objectId: at.objectId,
        property: at.property,
        keyframe: { frame: wireFrame(at.frame), value: storedValue(at.property, shown), easing: at.key.easing, ...(at.key.bezier === undefined ? {} : { bezier: at.key.bezier }) },
      } as SceneEdit,
    ],
    label: `Set ${propertyLabel(at.property)} at frame ${at.frame}`,
  };
}

/** The selected moment moved to another frame; every selected key goes together, by the same distance. */
export function planSetKeyFrame(model: TimelineModel, keyIds: readonly string[], frame: number): EditPlan {
  if (!Number.isInteger(frame)) return { refused: "A frame must be a whole number." };
  const first = parseKeyId(keyIds[0] ?? "");
  if (first === undefined) return { refused: "That key is not in the scene." };
  return planMove(model, keyIds, frame - first.frame);
}

/** The least a typed influence may be: a handle of no length is the same as no handle, and the contract keeps x inside 0 to 1. */
export const MIN_INFLUENCE_PERCENT = 0.1;
export const MAX_INFLUENCE_PERCENT = 100;

/**
 * A typed Ease in or Ease out percentage, written as the segment's bezier.
 *
 * Ease out is the handle leaving the selected key (x1 of its own segment); Ease in is the handle arriving at it, which is x2 of
 * the PREVIOUS key's segment, seen from the far end. Either way the segment is stored as a custom bezier on the key that owns it.
 * A curved segment keeps the handle's height; a Linear one keeps it on the straight line, so typing a number does not bend a
 * straight segment until the other handle is moved. A Hold segment has no curve and is left alone. Every selected channel is
 * edited together (a Position moment holds x and y).
 */
export function planSetInfluence(document: SceneDocument, keyIds: readonly string[], side: "in" | "out", percent: number): EditPlan {
  if (!Number.isFinite(percent)) return { refused: "An influence must be a number." };
  const x = Math.min(MAX_INFLUENCE_PERCENT, Math.max(MIN_INFLUENCE_PERCENT, percent)) / 100;
  const edits: SceneEdit[] = [];
  for (const id of keyIds) {
    const at = find(document, id);
    if (at === undefined) continue;
    const owner = side === "out" ? at.key : at.keys[at.index - 1];
    // The segment must exist: leaving needs a next key, arriving needs a previous one.
    if (owner === undefined || (side === "out" && at.keys[at.index + 1] === undefined)) continue;
    if (!hasHandles(owner.easing)) continue;
    const c = segmentControlPoints(owner);
    const linear = owner.easing === "linear";
    const bezier: CubicBezier =
      side === "out" ? { x1: x, y1: linear ? x : c.y1, x2: c.x2, y2: c.y2 } : { x1: c.x1, y1: c.y1, x2: 1 - x, y2: linear ? 1 - x : c.y2 };
    edits.push({
      edit: "updateKeyframe",
      objectId: at.objectId,
      property: at.property,
      keyframe: { frame: wireFrame(Number(owner.frame)), value: owner.value, easing: "custom-bezier", bezier },
    } as SceneEdit);
  }
  if (edits.length === 0) return { refused: side === "out" ? "There is no curve leaving this key to change." : "There is no curve arriving at this key to change." };
  return { edits, label: side === "out" ? "Set Ease out" : "Set Ease in" };
}

/** The range a property's value must stay in while a curve overshoots, or `undefined` when it has none. */
function overshootRange(property: string): { readonly min: number; readonly max: number } | undefined {
  if (property === "opacity") return { min: 0, max: 1 };
  if (property === "width" || property === "height") return { min: 0, max: Number.POSITIVE_INFINITY };
  return undefined;
}

/** The value a bezier segment between `from` and `to` takes at its extremes (the curve's y runs outside 0..1 when it overshoots). */
function segmentExtremes(from: number, to: number, c: CubicBezier): { readonly low: number; readonly high: number } {
  let low = Math.min(from, to);
  let high = Math.max(from, to);
  // The segment's y is a cubic in t with end points 0 and 1; sampling it finely is exact enough for a range check.
  for (let step = 0; step <= 200; step += 1) {
    const t = step / 200;
    const inv = 1 - t;
    const y = 3 * inv * inv * t * c.y1 + 3 * inv * t * t * c.y2 + t * t * t;
    const value = from + (to - from) * y;
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  return { low, high };
}

/**
 * A single-bezier preset (Back out, Back in) written on every selected key that has a segment leaving it. A property that must
 * stay inside a range (opacity, width, height) refuses a curve that would leave it, naming the property: the contract would
 * refuse it anyway, and the author should hear which key and why.
 */
export function planSetPreset(document: SceneDocument, keyIds: readonly string[], presetId: string): EditPlan {
  const preset = BEZIER_PRESETS[presetId];
  if (preset === undefined) return { refused: "That ease is not one this card can write." };
  const edits: SceneEdit[] = [];
  for (const id of keyIds) {
    const at = find(document, id);
    const next = at?.keys[(at?.index ?? -1) + 1];
    if (at === undefined || next === undefined) continue;
    const range = overshootRange(at.property);
    if (range !== undefined) {
      const { low, high } = segmentExtremes(at.key.value, next.value, preset.bezier);
      if (low < range.min - 1e-9 || high > range.max + 1e-9) {
        return { refused: `${preset.label} overshoots ${propertyLabel(at.property)} past its limits between frames ${at.frame} and ${Number(next.frame)}; use a keyframe pair with room to overshoot, or another ease.` };
      }
    }
    edits.push({
      edit: "updateKeyframe",
      objectId: at.objectId,
      property: at.property,
      keyframe: { frame: wireFrame(at.frame), value: at.key.value, easing: "custom-bezier", bezier: preset.bezier },
    } as SceneEdit);
  }
  if (edits.length === 0) return { refused: "There is no curve leaving these keys to change." };
  return { edits, label: `Set ${preset.label}` };
}
