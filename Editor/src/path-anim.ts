// Animated paths in the Editor (plan row 11.112; Pen spec v2 section 11, Masking spec v2 section 8): the twin of the Rust
// `path_anim` module that the preview and the overlay read, so the path the author sees at the playhead is the path the engine draws.
//
// A path channel holds whole paths as keys, each vertex carrying a stable id. Between two keys of the same topology (open or closed
// alike, the same ids in the same order) every vertex and handle blends, by the easing the earlier key leaves by; between keys of
// different topology the earlier key HOLDS and `held` says why (nothing is ever blended by index across a changed topology); before
// the first key and after the last the path is held, never extrapolated.

import type { BezierPath, LinkedPath, PathChannel, PathKey, PathLink, PathTarget, SceneDocument, SceneObject } from "@grapix/contracts";
import { easeAt } from "./timeline/easing";
import { effective, sameTopology, type Pt } from "./path-geometry";

/** A channel's path at a frame. */
export interface PathValue {
  readonly path: BezierPath;
  /** Set when two neighbouring keys differ in topology and the earlier one is held: what differs, in words. */
  readonly held?: string;
}

/** The channel's name in words and refusals: `path`, `compoundPaths[i]` or `masks[i].path` (as the Rust `target_field`). */
export function targetField(target: PathTarget): string {
  if (target.kind === "mask") return `masks[${target.index}].path`;
  const subpath = target.subpath ?? 0;
  return subpath === 0 ? "path" : `compoundPaths[${subpath - 1}]`;
}

/** The target a track's property name stands for, or `undefined` when the name is not a path's. */
export function targetOfField(field: string): PathTarget | undefined {
  if (field === "path") return { kind: "shape", subpath: 0 };
  const compound = /^compoundPaths\[(\d+)\]$/.exec(field);
  if (compound) return { kind: "shape", subpath: Number(compound[1]) + 1 };
  const mask = /^masks\[(\d+)\]\.path$/.exec(field);
  if (mask) return { kind: "mask", index: Number(mask[1]) };
  return undefined;
}

export const sameTarget = (a: PathTarget, b: PathTarget): boolean =>
  a.kind === b.kind && (a.kind === "mask" ? a.index === (b as { index: number }).index : (a.subpath ?? 0) === ((b as { subpath?: number }).subpath ?? 0));

/** Two paths of the same topology blended: `t` of the way from `a` to `b`. Ids, kinds and tension stay `a`'s. */
export function lerpPaths(a: BezierPath, b: BezierPath, t: number): BezierPath | undefined {
  if (!sameTopology(a, b)) return undefined;
  const mix = (x: Pt, y: Pt): Pt => ({ x: x.x + (y.x - x.x) * t, y: x.y + (y.y - x.y) * t });
  const list = (p: readonly Pt[], q: readonly Pt[]): Pt[] => p.map((x, i) => mix(x, q[i]!));
  return {
    closed: a.closed,
    vertices: list(a.vertices, b.vertices),
    inTangents: list(a.inTangents, b.inTangents),
    outTangents: list(a.outTangents, b.outTangents),
    ...(a.vertexIds !== undefined ? { vertexIds: [...a.vertexIds] } : {}),
    ...(a.vertexKinds !== undefined ? { vertexKinds: [...a.vertexKinds] } : {}),
    ...(a.autoTension !== undefined ? { autoTension: a.autoTension } : {}),
  };
}

function mismatch(a: BezierPath, b: BezierPath): string {
  if (a.closed !== b.closed) return "one is open and the other closed";
  if (a.vertices.length !== b.vertices.length) return "they have different numbers of vertices";
  return "their vertices have different ids";
}

/** The path a channel holds at a frame; `undefined` when it has no key. */
export function evaluatePathChannel(channel: PathChannel, frame: number): PathValue | undefined {
  const keys = channel.keys;
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (first === undefined || last === undefined) return undefined;
  if (frame <= Number(first.frame)) return { path: first.path };
  if (frame >= Number(last.frame)) return { path: last.path };
  let low = 0;
  let high = keys.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (Number(keys[mid]!.frame) <= frame) low = mid + 1;
    else high = mid;
  }
  const from = keys[low - 1]!;
  const to = keys[low]!;
  const span = Number(to.frame) - Number(from.frame);
  if (span === 0) return { path: from.path };
  if (!sameTopology(from.path, to.path)) {
    return {
      path: from.path,
      held: `the keys at frames ${Number(from.frame)} and ${Number(to.frame)} of ${targetField(channel.target)} cannot be interpolated: ${mismatch(from.path, to.path)}; the earlier one holds`,
    };
  }
  const t = (frame - Number(from.frame)) / span;
  const path = lerpPaths(from.path, to.path, easeAt(from.easing, from.bezier, t));
  return path === undefined ? { path: from.path } : { path };
}

/** The channel of one target of one object, if it has one. */
export function pathChannelOf(document: SceneDocument, objectId: string, target: PathTarget): PathChannel | undefined {
  return (document.timeline?.pathChannels ?? []).find((c) => c.objectId === objectId && sameTarget(c.target, target));
}

/** Whether the object animates any of its paths. */
export const animatesPath = (document: SceneDocument, objectId: string): boolean =>
  (document.timeline?.pathChannels ?? []).some((c) => c.objectId === objectId && c.keys.length > 0);

/** The stored path a target names on `object` (the rest path when it is animated), or `undefined` when there is no such target. */
export function storedPath(object: SceneObject, target: PathTarget): BezierPath | undefined {
  if (target.kind === "mask") return object.masks?.[target.index]?.path;
  if (object.type !== "shape") return undefined;
  const subpath = target.subpath ?? 0;
  return subpath === 0 ? object.path : object.compoundPaths?.[subpath - 1];
}

/** The path of a target at `frame`: the channel's value when it has keys, the stored path otherwise. Auto handles are NOT yet
 *  derived here (`effective` does that); an edit starts from this path as it is stored. */
export function pathAtFrame(document: SceneDocument, object: SceneObject, target: PathTarget, frame: number): BezierPath | undefined {
  const channel = pathChannelOf(document, object.id, target);
  const value = channel === undefined ? undefined : evaluatePathChannel(channel, frame);
  return value?.path ?? storedPath(object, target);
}

/** `document` with every animated path put where its channel has it at `frame` (11.112): a shape's path or subpath, or a mask's path.
 *  The paths are as stored, auto handles not yet derived (`effective` does that where a path is drawn). `issues` lists the channels
 *  that held an earlier key because their neighbours differ in topology, in words. */
export function applyPathChannels(document: SceneDocument, frame: number): { readonly document: SceneDocument; readonly issues: readonly string[] } {
  const channels = (document.timeline?.pathChannels ?? []).filter((c) => c.keys.length > 0);
  if (channels.length === 0) return { document, issues: [] };
  const issues: string[] = [];
  const objects = document.objects.map((object) => {
    const mine = channels.filter((c) => c.objectId === object.id);
    if (mine.length === 0) return object;
    let next: SceneObject = object;
    for (const channel of mine) {
      const value = evaluatePathChannel(channel, frame);
      if (value === undefined) continue;
      if (value.held !== undefined) issues.push(`${object.name}: ${value.held}`);
      const target = channel.target;
      if (target.kind === "mask") {
        const masks = next.masks;
        if (masks === undefined || masks[target.index] === undefined) continue;
        next = { ...next, masks: masks.map((m, i) => (i === target.index ? { ...m, path: value.path } : m)) } as SceneObject;
      } else if (next.type === "shape") {
        const subpath = target.subpath ?? 0;
        if (subpath === 0) next = { ...next, path: value.path };
        else if (next.compoundPaths?.[subpath - 1] !== undefined) next = { ...next, compoundPaths: next.compoundPaths.map((p, i) => (i === subpath - 1 ? value.path : p)) };
      }
    }
    return next;
  });
  return { document: { ...document, objects }, issues };
}

/** Who a path of an object is, as a link names its users: a shape's subpath, or a mask by its id (a mask with no id is in no link). */
export function linkedPathOf(object: SceneObject, target: PathTarget): LinkedPath | undefined {
  if (target.kind === "mask") {
    const id = object.masks?.[target.index]?.id;
    return id === undefined ? undefined : { objectId: object.id, maskId: id };
  }
  return { objectId: object.id, subpath: target.subpath ?? 0 };
}

/** The link a path is a user of (11.112), if any. */
export function pathLinkOf(document: SceneDocument, object: SceneObject, target: PathTarget): PathLink | undefined {
  const user = linkedPathOf(object, target);
  if (user === undefined) return undefined;
  return (document.pathLinks ?? []).find((link) => link.users.some((u) => u.objectId === user.objectId && u.subpath === user.subpath && u.maskId === user.maskId));
}

/** The other users of a link in words: "Shape, Rect mask 2". */
export function linkUsersWords(document: SceneDocument, link: PathLink, except?: LinkedPath): string {
  return link.users
    .filter((u) => !(except !== undefined && u.objectId === except.objectId && u.subpath === except.subpath && u.maskId === except.maskId))
    .map((u) => {
      const name = document.objects.find((o) => o.id === u.objectId)?.name ?? u.objectId;
      if (u.maskId === undefined) return u.subpath === undefined || u.subpath === 0 ? name : `${name} path ${u.subpath + 1}`;
      const index = document.objects.find((o) => o.id === u.objectId)?.masks?.findIndex((m) => m.id === u.maskId) ?? -1;
      return index < 0 ? `${name} mask` : `${name} mask ${index + 1}`;
    })
    .join(", ");
}

/** The frames of a channel's keys. */
export const pathKeyFrames = (channel: PathChannel | undefined): number[] => (channel?.keys ?? []).map((k) => Number(k.frame));

/** The key at exactly `frame`, if any. */
export const pathKeyAt = (channel: PathChannel | undefined, frame: number): PathKey | undefined => channel?.keys.find((k) => Number(k.frame) === frame);

/** The path as it is drawn at `frame`: blended, then its auto handles derived. */
export function drawnPathAtFrame(document: SceneDocument, object: SceneObject, target: PathTarget, frame: number): BezierPath | undefined {
  const path = pathAtFrame(document, object, target, frame);
  return path === undefined ? undefined : effective(path);
}
