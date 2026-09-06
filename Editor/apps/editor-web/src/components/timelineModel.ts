/**
 * What the timeline shows, and which of it is selected.
 *
 * Rows and keys are built here, together, because a marker is positioned by looking its row up
 * by id: two places generating those ids is the divergence that leaves a keyframe rendered on
 * the wrong track, or not rendered at all. `rowIdFor*` are the single definition, and both
 * `createTimelineRows` and `collectTimelineKeys` go through them.
 *
 * The selection maths is deliberately pure — no DOM, no store. A marquee is expressed in frames
 * and row indices rather than pixels, so the geometry conversion stays in the component and the
 * behaviour that actually matters (what a box catches, how far a group may move) is testable.
 */
import {
  ANIMATABLE_PROPERTIES,
  type AnimatableProperty,
  type SceneKeyframe,
  type SceneObject
} from "@grapix/shared-types";

export type MaskTimelineProperty = "path" | "opacity" | "feather" | "expansion";

export const MASK_TIMELINE_PROPERTIES: readonly MaskTimelineProperty[] = [
  "path",
  "opacity",
  "feather",
  "expansion"
];

export interface TimelineRow {
  id: string;
  object: SceneObject;
  property?: AnimatableProperty;
  maskId?: string;
  maskName?: string;
  maskProperty?: MaskTimelineProperty;
  isShapePath?: boolean;
  depth: number;
}

/** Which objects the timeline lists. */
export type TimelineRowFilter = "all" | "keyframed";

export type TimelineKeyRef =
  | { id: string; kind: "property"; rowId: string; frame: number; objectId: string; keyId: string; property: AnimatableProperty }
  | { id: string; kind: "legacy"; rowId: string; frame: number; objectId: string; keyId: string }
  | { id: string; kind: "mask"; rowId: string; frame: number; objectId: string; keyId: string; maskId: string; maskProperty: MaskTimelineProperty }
  | { id: string; kind: "shape-path"; rowId: string; frame: number; objectId: string; keyId: string };

/** A marquee, in the timeline's own units. Ends are inclusive and need not be ordered. */
export interface TimelineMarquee {
  frameFrom: number;
  frameTo: number;
  rowFrom: number;
  rowTo: number;
}

export const rowIdForObject = (objectId: string) => `object:${objectId}`;
export const rowIdForProperty = (objectId: string, property: AnimatableProperty) =>
  `property:${objectId}:${property}`;
export const rowIdForShapePath = (objectId: string) => `shape-path:${objectId}`;
export const rowIdForMask = (objectId: string, maskId: string) => `mask:${objectId}:${maskId}`;
export const rowIdForMaskProperty = (
  objectId: string,
  maskId: string,
  property: MaskTimelineProperty
) => `mask-property:${objectId}:${maskId}:${property}`;

/**
 * Does this object carry any animation at all?
 *
 * The question the "Keyframed only" filter asks. Masks and shape paths count: a shape morph is
 * animation an author is looking for, and hiding its object because no *numeric* channel exists
 * would make the filter lie.
 */
export function objectHasAnimation(object: SceneObject): boolean {
  if (ANIMATABLE_PROPERTIES.some((property) => object.animation?.[property]?.keys.length)) return true;
  if (object.type === "shape" && object.pathAnimation?.length) return true;
  return (object.masks ?? []).some((mask) =>
    MASK_TIMELINE_PROPERTIES.some((property) => mask.animation?.[property]?.length)
  );
}

export function createTimelineRows(
  objects: SceneObject[],
  filter: TimelineRowFilter = "all"
): TimelineRow[] {
  const rows: TimelineRow[] = [];

  for (const object of objects) {
    if (filter === "keyframed" && !objectHasAnimation(object)) continue;

    rows.push({ id: rowIdForObject(object.id), object, depth: 0 });

    for (const property of ANIMATABLE_PROPERTIES) {
      if (object.animation?.[property]) {
        rows.push({ id: rowIdForProperty(object.id, property), object, property, depth: 1 });
      }
    }

    if (object.type === "shape" && object.pathAnimation?.length) {
      rows.push({ id: rowIdForShapePath(object.id), object, isShapePath: true, depth: 1 });
    }

    for (const mask of object.masks ?? []) {
      rows.push({
        id: rowIdForMask(object.id, mask.id),
        object,
        maskId: mask.id,
        maskName: mask.name,
        depth: 1
      });
      for (const maskProperty of MASK_TIMELINE_PROPERTIES) {
        if (mask.animation?.[maskProperty]?.length) {
          rows.push({
            id: rowIdForMaskProperty(object.id, mask.id, maskProperty),
            object,
            maskId: mask.id,
            maskName: mask.name,
            maskProperty,
            depth: 2
          });
        }
      }
    }
  }

  return rows;
}

/**
 * Every keyframe the timeline can draw, in one list.
 *
 * One list rather than the four separate `flatMap` passes the panel used to render, because
 * selection, marquee hit-testing and group movement all have to treat a mask key and a property
 * key identically — four parallel implementations of "is this one selected" is how three of them
 * end up not supporting it.
 */
export function collectTimelineKeys(
  objects: SceneObject[],
  sceneKeyframes: readonly SceneKeyframe[]
): TimelineKeyRef[] {
  const keys: TimelineKeyRef[] = [];

  for (const keyframe of sceneKeyframes) {
    keys.push({
      id: `legacy:${keyframe.id}`,
      kind: "legacy",
      rowId: rowIdForObject(keyframe.objectId),
      frame: keyframe.frame,
      objectId: keyframe.objectId,
      keyId: keyframe.id
    });
  }

  for (const object of objects) {
    for (const property of ANIMATABLE_PROPERTIES) {
      const channel = object.animation?.[property];
      if (!channel) continue;
      for (const key of channel.keys) {
        keys.push({
          id: `property:${object.id}:${property}:${key.id}`,
          kind: "property",
          rowId: rowIdForProperty(object.id, property),
          frame: key.frame,
          objectId: object.id,
          keyId: key.id,
          property
        });
      }
    }

    if (object.type === "shape") {
      for (const key of object.pathAnimation ?? []) {
        keys.push({
          id: `shape-path:${object.id}:${key.id}`,
          kind: "shape-path",
          rowId: rowIdForShapePath(object.id),
          frame: key.frame,
          objectId: object.id,
          keyId: key.id
        });
      }
    }

    for (const mask of object.masks ?? []) {
      for (const maskProperty of MASK_TIMELINE_PROPERTIES) {
        for (const key of mask.animation?.[maskProperty] ?? []) {
          keys.push({
            id: `mask:${object.id}:${mask.id}:${maskProperty}:${key.id}`,
            kind: "mask",
            rowId: rowIdForMaskProperty(object.id, mask.id, maskProperty),
            frame: key.frame,
            objectId: object.id,
            keyId: key.id,
            maskId: mask.id,
            maskProperty
          });
        }
      }
    }
  }

  return keys;
}

/**
 * Keys a marquee catches.
 *
 * A key on a row that is filtered out has no row index and cannot be caught — dragging a box
 * over collapsed rows must not silently select what the author cannot see, because the next
 * drag would then move keyframes off screen.
 */
export function keysInMarquee(
  keys: readonly TimelineKeyRef[],
  marquee: TimelineMarquee,
  rowIndexById: ReadonlyMap<string, number>
): string[] {
  const frameLow = Math.min(marquee.frameFrom, marquee.frameTo);
  const frameHigh = Math.max(marquee.frameFrom, marquee.frameTo);
  const rowLow = Math.min(marquee.rowFrom, marquee.rowTo);
  const rowHigh = Math.max(marquee.rowFrom, marquee.rowTo);

  return keys
    .filter((key) => {
      const rowIndex = rowIndexById.get(key.rowId);
      if (rowIndex === undefined) return false;
      return (
        rowIndex >= rowLow
        && rowIndex <= rowHigh
        && key.frame >= frameLow
        && key.frame <= frameHigh
      );
    })
    .map((key) => key.id);
}

/**
 * How far a group of keys may actually move.
 *
 * Clamping each key on its own would collapse a selection: keys that hit frame 0 stop while the
 * rest keep going, so the shape of the animation is destroyed by a drag the author cannot undo
 * key by key. The whole selection moves by the same amount or not at all — the delta is reduced
 * until every key fits.
 */
export function clampFrameDelta(
  frames: readonly number[],
  delta: number,
  durationFrames: number
): number {
  if (!frames.length || !Number.isFinite(delta)) return 0;

  const lowest = Math.min(...frames);
  const highest = Math.max(...frames);
  const maximum = Math.max(0, durationFrames);

  return Math.round(Math.max(-lowest, Math.min(maximum - highest, delta)));
}
