// Editing a path in the viewport (plan row 11.107; the Pen spec's sections 3.3, 6 and 7): the Direct Selection tool and the
// Add, Delete and Convert Vertex tools.
//
//   click a vertex          selects it (Shift adds or takes it away); a click on nothing clears the selection
//   drag a vertex           moves every selected vertex (Shift holds the move to a multiple of 45 degrees)
//   drag a handle           moves that handle; a smooth vertex keeps its other handle in line; Alt breaks them apart;
//                           Shift holds the handle to a multiple of 15 degrees from its vertex
//   drag a curve            reshapes the segment: the grabbed point follows the pointer, its two vertices stay
//   drag on empty space     a marquee selects the vertices inside it
//   Delete / Backspace      takes the selected vertices out
//   double click            a vertex: corner and smooth swap; a curve: a vertex is put there (the Smart Pen's shortcuts)
//   Add / Delete / Convert  tools: one click does it
//
// Hit precedence on the pointer-down (spec 6): a handle of a selected vertex, then a vertex, then a curve, then nothing.
// Pure: it reads the document and the pointer and makes a `PathOp`; the page sends ONE `editPath` edit when a drag ends, so a
// drag is one undo step, and draws the result of the op meanwhile. The backend (`path_geometry.rs`) does the same maths and
// has the last word.

import type { BezierPath, PathOp, PathTarget, SceneDocument, SceneEdit, SceneObject, VertexKind } from "@grapix/contracts";
import { parentsOf } from "./arrange";
import { isRefused, type EditRefused } from "./inspector";
import { effectivePlacement, placementOf, toLocalDelta, toSceneDelta, type Placement } from "./anchor-point";
import { wireFrame } from "./command-client";
import { animatesPath, evaluatePathChannel, pathChannelOf, pathLinkOf } from "./path-anim";
import { segmentsNear } from "./path-grid";
import {
  convertVertex,
  cubicOf,
  effective,
  kindsOf,
  setAutoTension,
  setVertexKind,
  deleteVertices,
  hasHandles,
  insertVertex,
  isSmooth,
  mapCubic,
  moveVertices,
  nearestOnCubic,
  reshapeSegment,
  deleteKeepShape,
  fitDeleteVertex,
  joinPaths,
  reversePath,
  segmentCount,
  setClosed,
  setFirstVertex,
  setHandle,
  snapAngle,
  whyNot,
  type Pt,
} from "./path-geometry";

/** The step a Shift-dragged handle is held to, in degrees (the Pen's, so After Effects' 15). */
export const HANDLE_ANGLE = 15;
/** The step a Shift-dragged vertex move is held to. */
export const MOVE_ANGLE = 45;
/** A drag shorter than this, in screen pixels, is a click. */
export const CLICK_SLOP = 3;
/** How near, in screen pixels, the pointer must be to a vertex, handle or curve to take it. */
export const PICK_RADIUS = 8;

// ---------------------------------------------------------------------------------------------------------------------
// What can be edited

/** One path of a shape: its place (0 is the main path, 1 and on its compound subpaths) and the path. */
export interface EditablePath {
  readonly subpath: number;
  readonly path: BezierPath;
}

export interface EditTarget {
  readonly object: SceneObject;
  /** Where the object's own space stands on the canvas, through its groups and layers (`effectivePlacement`). */
  readonly placement: Placement;
  readonly paths: readonly EditablePath[];
  /** Set when the path edited is one of the object's masks (its index), not the shape's own path. */
  readonly mask?: number;
  /** The frame the paths are shown and edited at (the playhead): an animated path is what its channel gives there (11.112). */
  readonly frame?: number;
  /** The subpaths whose path is animated: the edits of those carry the frame. */
  readonly animated?: readonly number[];
  /** The revision of the link each linked subpath is in (11.112): an edit of it names the revision it was made on. */
  readonly revisions?: readonly { readonly subpath: number; readonly revision: number }[];
}

/** The kinds that can carry a mask: whatever draws pixels. */
export const MASKABLE: readonly SceneObject["type"][] = ["rect", "ellipse", "line", "shape", "text", "image"];

/** The shape whose path can be edited: exactly one selected, a shape (or any layer that can carry the mask asked for), not locked
 *  and in no locked group. Its place on the canvas is taken through its groups and layers. Refused by name otherwise. */
export function editTarget(document: SceneDocument, selectedIds: readonly string[], mask?: number, frame?: number): EditTarget | EditRefused {
  if (selectedIds.length === 0) return { refused: "Select a shape first, then edit its path." };
  if (selectedIds.length > 1) return { refused: "Select one shape to edit its path." };
  const object = document.objects.find((candidate) => candidate.id === selectedIds[0]);
  if (object === undefined) return { refused: "That object is not in the scene." };
  const found = mask === undefined ? undefined : object.masks?.[mask];
  if (mask !== undefined && found === undefined) return { refused: `${object.name} has no mask ${mask + 1}.` };
  if (mask === undefined && object.type !== "shape") return { refused: `${object.name} is not a shape, so it has no path to edit. Draw one with the Pen.` };
  if (object.locked) return { refused: `${object.name} is locked. Unlock it first; nothing was changed.` };
  const parents = parentsOf(document);
  const byId = new Map(document.objects.map((candidate) => [candidate.id, candidate]));
  for (let at = parents.get(object.id); at !== undefined; at = parents.get(at)) {
    const group = byId.get(at);
    if (group?.locked === true) return { refused: `${object.name} is in ${group.name}, which is locked. Unlock it first; nothing was changed.` };
  }
  const placement = effectivePlacement(document, object);
  // 11.112: an animated path is what its channel holds at the frame; the rest path is only what shows with no keys.
  const at = (target: PathTarget, stored: BezierPath): BezierPath => {
    if (frame === undefined) return stored;
    const channel = pathChannelOf(document, object.id, target);
    return (channel === undefined ? undefined : evaluatePathChannel(channel, frame)?.path) ?? stored;
  };
  const stamp = frame === undefined ? {} : { frame };
  if (mask !== undefined && found !== undefined) {
    const target: PathTarget = { kind: "mask", index: mask };
    const animated = pathChannelOf(document, object.id, target) !== undefined ? [0] : [];
    const link = pathLinkOf(document, object, target);
    const revisions = link === undefined ? [] : [{ subpath: 0, revision: Number(link.revision) }];
    return { object, placement, paths: [{ subpath: 0, path: at(target, found.path) }], mask, ...stamp, animated, revisions };
  }
  if (object.type !== "shape") return { refused: `${object.name} is not a shape, so it has no path to edit. Draw one with the Pen.` };
  const stored: BezierPath[] = [object.path, ...(object.compoundPaths ?? [])];
  const paths: EditablePath[] = stored.map((path, subpath) => ({ subpath, path: at({ kind: "shape", subpath }, path) }));
  const animated = stored.flatMap((_, subpath) => (pathChannelOf(document, object.id, { kind: "shape", subpath }) !== undefined ? [subpath] : []));
  const revisions = stored.flatMap((_, subpath) => {
    const link = pathLinkOf(document, object, { kind: "shape", subpath });
    return link === undefined ? [] : [{ subpath, revision: Number(link.revision) }];
  });
  return { object, placement, paths, ...stamp, animated, revisions };
}

// ---------------------------------------------------------------------------------------------------------------------
// The object's own space and the canvas: canvas = position + R S (q - anchor)

export const toCanvas = (placement: Placement, q: Pt): Pt => {
  const moved = toSceneDelta(placement, q.x - placement.anchorX, q.y - placement.anchorY);
  return { x: placement.x + moved.x, y: placement.y + moved.y };
};

export const toObjectSpace = (placement: Placement, p: Pt): Pt | undefined => {
  const delta = toLocalDelta(placement, p.x - placement.x, p.y - placement.y);
  return delta === undefined ? undefined : { x: placement.anchorX + delta.x, y: placement.anchorY + delta.y };
};

// ---------------------------------------------------------------------------------------------------------------------
// Picking

export type PathHit =
  | { readonly kind: "handle"; readonly subpath: number; readonly index: number; readonly side: "in" | "out" }
  | { readonly kind: "vertex"; readonly subpath: number; readonly index: number }
  | { readonly kind: "segment"; readonly subpath: number; readonly segment: number; readonly t: number; readonly point: Pt };

/** A vertex that is selected: its place in a subpath. */
export interface Selected {
  readonly subpath: number;
  readonly index: number;
}

export const isSelected = (selected: readonly Selected[], subpath: number, index: number): boolean =>
  selected.some((s) => s.subpath === subpath && s.index === index);

/** Whether `at` is further than `radius` from the box of the cubic's control points, which holds the whole curve. */
export function outsideHull(c: { readonly p0: Pt; readonly p1: Pt; readonly p2: Pt; readonly p3: Pt }, at: Pt, radius: number): boolean {
  const minX = Math.min(c.p0.x, c.p1.x, c.p2.x, c.p3.x) - radius;
  const maxX = Math.max(c.p0.x, c.p1.x, c.p2.x, c.p3.x) + radius;
  const minY = Math.min(c.p0.y, c.p1.y, c.p2.y, c.p3.y) - radius;
  const maxY = Math.max(c.p0.y, c.p1.y, c.p2.y, c.p3.y) + radius;
  return at.x < minX || at.x > maxX || at.y < minY || at.y > maxY;
}

/** What the pointer is on. `radius` is in canvas pixels (the page converts ten screen pixels or so with the zoom). */
export function pickPath(target: EditTarget, selected: readonly Selected[], at: Pt, radius: number): PathHit | undefined {
  const placement = target.placement;
  const canvasOf = (q: Pt) => toCanvas(placement, q);
  // Handles of selected vertices come first, the last drawn on top.
  for (const entry of target.paths) {
    const subpath = entry.subpath;
    const path = effective(entry.path);
    for (let index = 0; index < path.vertices.length; index += 1) {
      if (!isSelected(selected, subpath, index)) continue;
      const vertex = path.vertices[index]!;
      for (const side of ["out", "in"] as const) {
        const offset = side === "out" ? path.outTangents[index]! : path.inTangents[index]!;
        if (Math.abs(offset.x) + Math.abs(offset.y) < 1e-6) continue;
        const end = canvasOf({ x: vertex.x + offset.x, y: vertex.y + offset.y });
        if (Math.hypot(end.x - at.x, end.y - at.y) <= radius) return { kind: "handle", subpath, index, side };
      }
    }
  }
  let best: { hit: PathHit; distance: number } | undefined;
  // Spatial index (11.115): in the object's own space, the segments a point within the pick radius could be on. A path with few
  // segments, or an object scaled to nothing, is scanned whole; the answer is the same either way.
  const local = toObjectSpace(placement, at);
  const reach = Math.min(Math.abs(placement.scaleX), Math.abs(placement.scaleY));
  const near = (path: BezierPath): number[] | undefined =>
    local === undefined || !(reach > 1e-9) ? undefined : segmentsNear(path, local.x, local.y, radius / reach + 1e-6);
  const candidates = target.paths.map((entry) => near(entry.path));
  target.paths.forEach(({ subpath, path }, k) => {
    const list = candidates[k];
    const vertices = list === undefined ? undefined : [...new Set(list.flatMap((s) => [s, (s + 1) % path.vertices.length]))].sort((a, b) => a - b);
    const count = vertices === undefined ? path.vertices.length : vertices.length;
    for (let j = 0; j < count; j += 1) {
      const index = vertices === undefined ? j : vertices[j]!;
      const p = canvasOf(path.vertices[index]!);
      const distance = Math.hypot(p.x - at.x, p.y - at.y);
      if (distance <= radius && (best === undefined || distance < best.distance)) best = { hit: { kind: "vertex", subpath, index }, distance };
    }
  });
  if (best !== undefined) return (best as { hit: PathHit }).hit;
  target.paths.forEach((entry, k) => {
    const subpath = entry.subpath;
    const path = effective(entry.path);
    const list = candidates[k];
    const count = list === undefined ? segmentCount(path) : list.length;
    for (let j = 0; j < count; j += 1) {
      const segment = list === undefined ? j : list[j]!;
      const cubic = mapCubic(cubicOf(path, segment), canvasOf);
      // Broad phase: a curve lies inside the box of its four control points, so one whose box (grown by the pick radius) does not
      // hold the pointer cannot be hit, and the roots of its nearest-point polynomial need not be found (Pen spec 5.4 and 16).
      if (outsideHull(cubic, at, radius)) continue;
      const found = nearestOnCubic(cubic, at);
      if (found.distance <= radius && (best === undefined || found.distance < best.distance)) {
        best = { hit: { kind: "segment", subpath, segment, t: found.t, point: found.point }, distance: found.distance };
      }
    }
  });
  return (best as { hit: PathHit } | undefined)?.hit;
}

/** The vertices whose canvas position is inside the box (a marquee). */
export function verticesInBox(target: EditTarget, box: { x: number; y: number; width: number; height: number }): Selected[] {
  const placement = target.placement;
  const out: Selected[] = [];
  for (const { subpath, path } of target.paths) {
    path.vertices.forEach((vertex, index) => {
      const p = toCanvas(placement, vertex);
      if (p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height) out.push({ subpath, index });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Applying a PathOp on the page (the same maths as the backend, for the preview while dragging)

/** The path after `op`, or `undefined` with `whyNot` set. */
export function applyOp(path: BezierPath, op: PathOp): BezierPath | undefined {
  switch (op.op) {
    case "insertVertex":
      return insertVertex(path, op.segment, op.t);
    case "deleteVertices":
      return deleteVertices(path, op.indices);
    case "convertVertex":
      return convertVertex(path, op.index);
    case "deleteKeepShape":
      return deleteKeepShape(path, op.index, op.tolerance);
    case "setHandle":
      return setHandle(path, op.index, op.side, op.vector, op.coupling);
    case "moveVertices":
      return moveVertices(path, op.indices, op.delta);
    case "reshapeSegment":
      return reshapeSegment(path, op.segment, op.t, op.delta);
    case "reverse":
      return reversePath(path);
    case "setFirstVertex":
      return setFirstVertex(path, op.index);
    case "setClosed":
      return setClosed(path, op.closed);
    case "setVertexKind":
      return setVertexKind(path, op.index, op.kind);
    case "setAutoTension":
      return setAutoTension(path, op.tension);
  }
}

/** The one edit that makes `op` happen to a subpath of a shape. */
export function editPathEdit(objectId: string, subpath: number, op: PathOp, mask?: number, frame?: number, baseRevision?: number): SceneEdit {
  const target = mask === undefined ? { kind: "shape", subpath } : { kind: "mask", index: mask };
  // The frame is sent when the path is animated or being keyed: a geometry edit then sets the key there, and an edit of which
  // vertices there are lands in every key (11.112). The revision is sent when the path is linked: a stale edit is refused by name.
  return {
    edit: "editPath",
    objectId,
    target,
    op,
    ...(frame === undefined ? {} : { frame: wireFrame(frame) }),
    ...(baseRevision === undefined ? {} : { baseRevision: wireFrame(baseRevision) }),
  } as SceneEdit;
}

/** The revision an edit of `subpath` should name: that of its link, when it is linked. */
export const pathEditRevision = (target: EditTarget, subpath: number): number | undefined =>
  (target.revisions ?? []).find((r) => r.subpath === subpath)?.revision;

/** Whether an edit of `subpath` of `target` should carry the frame: its path is animated already, or the author is keying paths. */
export const pathEditFrame = (target: EditTarget, subpath: number, keying: boolean): number | undefined =>
  target.frame !== undefined && (keying || (target.animated ?? []).includes(subpath)) ? target.frame : undefined;

/** The frame-aware edits that give every selected vertex of one subpath a kind (one gesture, so one undo step). */
export function kindEdits(target: EditTarget, selected: readonly Selected[], kind: VertexKind, keying: boolean): { edits: SceneEdit[]; label: string } | EditRefused {
  if (selected.length === 0) return { refused: "Select the vertices to change first." };
  const subpath = selected[0]!.subpath;
  const entry = target.paths.find((p) => p.subpath === subpath);
  if (entry === undefined) return { refused: "That path is not there." };
  const kinds = kindsOf(entry.path);
  const indices = selected.filter((s) => s.subpath === subpath && kinds[s.index] !== kind).map((s) => s.index);
  if (indices.length === 0) return { refused: `Those vertices are ${kind} already.` };
  const frame = pathEditFrame(target, subpath, keying);
  return {
    edits: indices.map((index) => editPathEdit(target.object.id, subpath, { op: "setVertexKind", index, kind }, target.mask, frame, pathEditRevision(target, subpath))),
    label: indices.length === 1 ? `Made a vertex ${kind}` : `Made ${indices.length} vertices ${kind}`,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// A drag

export interface PathGesture {
  readonly hit: PathHit;
  /** Where the pointer went down, on the canvas. */
  readonly start: Pt;
  /** The vertices a vertex drag moves: the selection, with the one grabbed. */
  readonly moving: readonly Selected[];
}

/** Start a drag on `hit`. A vertex that is not selected becomes the selection (Shift adds it). */
export function beginGesture(hit: PathHit, start: Pt, selected: readonly Selected[], shift: boolean): { gesture: PathGesture; selected: readonly Selected[] } {
  if (hit.kind !== "vertex") return { gesture: { hit, start, moving: [] }, selected };
  const here: Selected = { subpath: hit.subpath, index: hit.index };
  const next = isSelected(selected, hit.subpath, hit.index) ? selected : shift ? [...selected, here] : [here];
  return { gesture: { hit, start, moving: next.filter((s) => s.subpath === hit.subpath) }, selected: next };
}

export interface Modifiers {
  readonly shift: boolean;
  readonly alt: boolean;
  /** The step a Shift-dragged handle is held to, in degrees (the Pen angle setting); `HANDLE_ANGLE` when absent. */
  readonly step?: number;
}

/** The op a drag to `now` stands for, or nothing when it is not a move yet (or the object is scaled to nothing). */
export function gestureOp(target: EditTarget, gesture: PathGesture, now: Pt, modifiers: Modifiers): { subpath: number; op: PathOp } | undefined {
  const placement = target.placement;
  const here = target.paths.find((p) => p.subpath === gesture.hit.subpath);
  if (here === undefined) return undefined;
  const path = here.path;
  const local = toObjectSpace(placement, now);
  const origin = toObjectSpace(placement, gesture.start);
  if (local === undefined || origin === undefined) return undefined;
  const delta = { x: local.x - origin.x, y: local.y - origin.y };
  const hit = gesture.hit;
  if (hit.kind === "vertex") {
    const moved = modifiers.shift ? snapAngle({ x: 0, y: 0 }, delta, MOVE_ANGLE) : delta;
    return { subpath: hit.subpath, op: { op: "moveVertices", indices: gesture.moving.map((s) => s.index), delta: round(moved) } };
  }
  if (hit.kind === "handle") {
    const vertex = path.vertices[hit.index]!;
    const aim = modifiers.shift ? snapAngle(vertex, local, modifiers.step ?? HANDLE_ANGLE) : local;
    const vector = round({ x: aim.x - vertex.x, y: aim.y - vertex.y });
    const kind = kindsOf(path)[hit.index];
    const coupling = modifiers.alt ? "none" : kind === "symmetric" ? "mirror" : kind === "smooth" || kind === "auto" ? "smooth" : "none";
    return { subpath: hit.subpath, op: { op: "setHandle", index: hit.index, side: hit.side, vector, coupling } };
  }
  return { subpath: hit.subpath, op: { op: "reshapeSegment", segment: hit.segment, t: hit.t, delta: round(delta) } };
}

const round = (p: Pt): Pt => ({ x: Math.round(p.x * 1e4) / 1e4, y: Math.round(p.y * 1e4) / 1e4 });

/** The distance, in screen pixels, a drag has gone: under `CLICK_SLOP` it is a click. */
export const isClick = (down: { clientX: number; clientY: number }, up: { clientX: number; clientY: number }): boolean =>
  Math.hypot(up.clientX - down.clientX, up.clientY - down.clientY) < CLICK_SLOP;

// ---------------------------------------------------------------------------------------------------------------------
// The one-click tools and the keys

export type ClickTool = "add" | "delete" | "convert";

/** What a click does with the Add, Delete or Convert Vertex tool, or a refusal in words. */
export function clickOp(tool: ClickTool, hit: PathHit | undefined, target: EditTarget, keepShapeWithin?: number): { subpath: number; op: PathOp; label: string } | EditRefused {
  if (tool === "add") {
    if (hit?.kind !== "segment") return { refused: "Click on the curve where the vertex should go." };
    return { subpath: hit.subpath, op: { op: "insertVertex", segment: hit.segment, t: hit.t }, label: "Added a vertex" };
  }
  if (hit === undefined || hit.kind === "segment") return { refused: tool === "delete" ? "Click on a vertex to take it out." : "Click on a vertex to change it." };
  if (tool === "delete" && keepShapeWithin !== undefined) {
    // Remove Point, Keep Shape (11.113): one curve over the two beside the vertex, if the shape stays within the tolerance.
    const path = target.paths.find((p) => p.subpath === hit.subpath)!.path;
    const fit = fitDeleteVertex(path, hit.index);
    if (fit === undefined) return { refused: capital(whyNot) };
    if (fit.deviation > keepShapeWithin) {
      return { refused: `Taking that vertex out would move the shape by ${fit.deviation.toFixed(2)} pixels, more than the ${keepShapeWithin} allowed. It was kept; click without Alt to delete it anyway.` };
    }
    return { subpath: hit.subpath, op: { op: "deleteKeepShape", index: hit.index, tolerance: keepShapeWithin }, label: `Removed a vertex, keeping the shape (${fit.deviation.toFixed(2)} px)` };
  }
  if (tool === "delete") {
    const path = target.paths.find((p) => p.subpath === hit.subpath)!.path;
    if (applyOp(path, { op: "deleteVertices", indices: [hit.index] }) === undefined) return { refused: capital(whyNot) };
    return { subpath: hit.subpath, op: { op: "deleteVertices", indices: [hit.index] }, label: "Deleted a vertex" };
  }
  const path = target.paths.find((p) => p.subpath === hit.subpath)!.path;
  if (applyOp(path, { op: "convertVertex", index: hit.index }) === undefined) return { refused: capital(whyNot) };
  const smooth = !hasHandles(path, hit.index);
  return { subpath: hit.subpath, op: { op: "convertVertex", index: hit.index }, label: smooth ? "Made a vertex smooth" : "Made a vertex a corner" };
}

/** What Delete does to the selected vertices of one subpath, or a refusal. Vertices of other subpaths are left. */
export function deleteSelected(target: EditTarget, selected: readonly Selected[]): { subpath: number; op: PathOp; label: string } | EditRefused {
  if (selected.length === 0) return { refused: "Select the vertices to delete first." };
  const subpath = selected[0]!.subpath;
  const indices = selected.filter((s) => s.subpath === subpath).map((s) => s.index);
  const path = target.paths.find((p) => p.subpath === subpath)!.path;
  const op: PathOp = { op: "deleteVertices", indices };
  if (applyOp(path, op) === undefined) return { refused: capital(whyNot) };
  return { subpath, op, label: indices.length === 1 ? "Deleted a vertex" : `Deleted ${indices.length} vertices` };
}

const capital = (text: string): string => (text === "" ? "That cannot be done." : `${text.charAt(0).toUpperCase()}${text.slice(1)}.`);

/** Selected vertices that are still there after an edit that changed the vertex count or order: nothing, so the author sees
 *  the result without a stale selection. */
export const afterEdit = (): readonly Selected[] => [];

export { isRefused };

// ---------------------------------------------------------------------------------------------------------------------
// What the viewport shows

export interface PathEditSketch {
  /** The SVG path data of every subpath, in canvas coordinates. */
  readonly d: string;
  readonly vertices: readonly { readonly x: number; readonly y: number; readonly selected: boolean }[];
  /** The handles of the selected vertices, from the vertex to the handle's end. */
  readonly handles: readonly { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }[];
  /** The marquee being dragged. */
  readonly hover?: { readonly x: number; readonly y: number };
}

const num = (n: number): string => String(Math.round(n * 100) / 100);

/** The path as the viewport draws it while it is edited, with `override` standing in for a subpath that is being dragged. */
export function pathEditSketch(target: EditTarget, selected: readonly Selected[], override?: { readonly subpath: number; readonly path: BezierPath }): PathEditSketch {
  const placement = target.placement;
  const point = (q: Pt) => toCanvas(placement, q);
  let d = "";
  const vertices: { x: number; y: number; selected: boolean }[] = [];
  const handles: { x1: number; y1: number; x2: number; y2: number }[] = [];
  for (const entry of target.paths) {
    const path = effective(override !== undefined && override.subpath === entry.subpath ? override.path : entry.path);
    if (path.vertices.length === 0) continue;
    const start = point(path.vertices[0]!);
    d += `${d === "" ? "" : " "}M ${num(start.x)} ${num(start.y)}`;
    for (let s = 0; s < segmentCount(path); s += 1) {
      const c = mapCubic(cubicOf(path, s), point);
      d += ` C ${num(c.p1.x)} ${num(c.p1.y)} ${num(c.p2.x)} ${num(c.p2.y)} ${num(c.p3.x)} ${num(c.p3.y)}`;
    }
    if (path.closed) d += " Z";
    path.vertices.forEach((vertex, index) => {
      const p = point(vertex);
      const chosen = isSelected(selected, entry.subpath, index);
      vertices.push({ x: p.x, y: p.y, selected: chosen });
      if (!chosen) return;
      for (const offset of [path.outTangents[index]!, path.inTangents[index]!]) {
        if (Math.abs(offset.x) + Math.abs(offset.y) < 1e-6) continue;
        const end = point({ x: vertex.x + offset.x, y: vertex.y + offset.y });
        handles.push({ x1: p.x, y1: p.y, x2: end.x, y2: end.y });
      }
    });
  }
  return { d, vertices, handles };
}

/** Where a point of a path is on the canvas (for tests and the page). */
export const canvasPointOf = (target: EditTarget | SceneObject, q: Pt): Pt => toCanvas("placement" in target ? target.placement : placementOf(target), q);

// ---------------------------------------------------------------------------------------------------------------------
// Join (11.110): two open shapes made one, end to end.

/** The two selected open shapes joined at the pair of their ends that are nearest on the canvas: the second is taken into the
 *  first's space, turned round when its far end is the one that meets, and the first shape keeps its look and its place. One
 *  `setShapePath` on the first and one `deleteObject` of the second, so one undo step returns both. */
export function joinEdits(document: SceneDocument, selectedIds: readonly string[]): SceneEdit[] | EditRefused {
  if (selectedIds.length !== 2) return { refused: "Select two open shapes to join them." };
  const found = selectedIds.map((id) => document.objects.find((candidate) => candidate.id === id));
  const [first, second] = found;
  if (first === undefined || second === undefined) return { refused: "That object is not in the scene." };
  for (const shape of [first, second]) {
    if (shape.type !== "shape") return { refused: `${shape.name} is not a shape, so it has no path to join.` };
    if (shape.locked) return { refused: `${shape.name} is locked. Unlock it first; nothing was changed.` };
    if (shape.path.closed) return { refused: `${shape.name} is closed. Only open paths can be joined.` };
    if ((shape.compoundPaths ?? []).length > 0) return { refused: `${shape.name} has more than one path, which cannot be joined yet.` };
    if (shape.path.vertices.length < 2) return { refused: `${shape.name} has fewer than two vertices.` };
    if (animatesPath(document, shape.id)) return { refused: `${shape.name} has an animated path. Joining would add vertices to one key only; remove its path keys first.` };
  }
  if (first.type !== "shape" || second.type !== "shape") return { refused: "Select two open shapes to join them." };
  const from = effectivePlacement(document, second);
  const to = effectivePlacement(document, first);
  const mapped = (path: BezierPath): BezierPath | undefined => {
    const vertices: Pt[] = [];
    const inTangents: Pt[] = [];
    const outTangents: Pt[] = [];
    for (let i = 0; i < path.vertices.length; i += 1) {
      const at = toObjectSpace(to, toCanvas(from, path.vertices[i]!));
      const into = toLocalDelta(to, ...pair(toSceneDelta(from, path.inTangents[i]!.x, path.inTangents[i]!.y)));
      const out = toLocalDelta(to, ...pair(toSceneDelta(from, path.outTangents[i]!.x, path.outTangents[i]!.y)));
      if (at === undefined || into === undefined || out === undefined) return undefined;
      vertices.push(at);
      inTangents.push(into);
      outTangents.push(out);
    }
    return { closed: false, vertices, inTangents, outTangents };
  };
  const other = mapped(second.path);
  if (other === undefined) return { refused: `${first.name} is scaled to nothing, so ${second.name} cannot be brought into it.` };
  const a = first.path;
  const end = (path: BezierPath, last: boolean): Pt => path.vertices[last ? path.vertices.length - 1 : 0]!;
  const gap = (p: Pt, q: Pt): number => Math.hypot(p.x - q.x, p.y - q.y);
  // Each way two ends can meet, and the path it makes.
  const ways: { readonly distance: number; readonly path: () => BezierPath | undefined }[] = [
    { distance: gap(end(a, true), end(other, false)), path: () => joinPaths(a, other, false) },
    { distance: gap(end(a, true), end(other, true)), path: () => joinPaths(a, other, true) },
    { distance: gap(end(a, false), end(other, true)), path: () => joinPaths(other, a, false) },
    { distance: gap(end(a, false), end(other, false)), path: () => joinPaths(reversePath(a), other, false) },
  ];
  const best = ways.reduce((nearest, way) => (way.distance < nearest.distance ? way : nearest));
  const joined = best.path();
  if (joined === undefined) return { refused: "Those two paths cannot be joined." };
  return [
    { edit: "setShapePath", shapeId: first.id, path: joined, compoundPaths: [] } as SceneEdit,
    { edit: "deleteObject", objectId: second.id } as SceneEdit,
  ];
}

const pair = (p: Pt): [number, number] => [p.x, p.y];

