import {
  boundsEdges,
  unionBounds,
  type Bounds,
  type SceneDocument,
  type SceneObject
} from "@grapix/shared-types";

/**
 * Align and distribute a selection.
 *
 * Everything here works on **bounds**, never on `x`/`y`. That distinction is the whole point: `x`
 * is the position of the object's anchor, so aligning `x` lines up pivots rather than edges, and
 * two objects with different anchors, rotations or scales end up visibly unaligned while their
 * numbers agree. The previous "Align left" did exactly that.
 *
 * The functions return **deltas**, which is what makes them exact under any transform: `objectBounds`
 * translates the object's transformed corners by `x`/`y`, so moving `x` by `dx` moves the bounds by
 * precisely `dx`. Nothing has to be re-derived or inverted, and a rotated object aligns by its
 * visible edge without special-casing.
 */

export type AlignEdge = "left" | "center-x" | "right" | "top" | "center-y" | "bottom";

export type DistributeMode =
  /** Space the chosen edge evenly between the outermost two. */
  | "left"
  | "center-x"
  | "right"
  | "top"
  | "center-y"
  | "bottom"
  /** Make the *gaps* equal, which is what "distribute spacing" means to a designer. */
  | "spacing-x"
  | "spacing-y";

/**
 * What the selection aligns against.
 *
 * `key-object` is the Photoshop/Illustrator "key object": one member of the selection holds still
 * and everything else comes to it. It is the reference an operator reaches for when one graphic is
 * already in the right place.
 */
export type AlignReference = "selection" | "canvas" | "key-object" | "parent";

export interface AlignTarget {
  id: string;
  bounds: Bounds;
  /** Excluded from every move. Locked objects are reference geometry, not cargo. */
  locked?: boolean;
}

export interface Move {
  id: string;
  dx: number;
  dy: number;
}

/** Moves that bring every movable target's chosen edge onto the frame's. */
export function alignMoves(
  targets: readonly AlignTarget[],
  edge: AlignEdge,
  frame: Bounds
): Move[] {
  const to = boundsEdges(frame);

  return movable(targets).map((target) => {
    const from = boundsEdges(target.bounds);
    switch (edge) {
      case "left":
        return { id: target.id, dx: to.left - from.left, dy: 0 };
      case "center-x":
        return { id: target.id, dx: to.centerX - from.centerX, dy: 0 };
      case "right":
        return { id: target.id, dx: to.right - from.right, dy: 0 };
      case "top":
        return { id: target.id, dx: 0, dy: to.top - from.top };
      case "center-y":
        return { id: target.id, dx: 0, dy: to.centerY - from.centerY };
      case "bottom":
        return { id: target.id, dx: 0, dy: to.bottom - from.bottom };
    }
  }).filter(isMove);
}

/**
 * Moves that spread a selection evenly.
 *
 * The outermost two never move — they define the span everything else is distributed within, and
 * an operator who has placed the first and last graphic does not expect either to shift. Fewer
 * than three objects therefore has no meaningful answer and returns nothing.
 */
export function distributeMoves(targets: readonly AlignTarget[], mode: DistributeMode): Move[] {
  const all = [...targets];
  if (all.length < 3) return [];

  const horizontal = mode === "left" || mode === "center-x" || mode === "right" || mode === "spacing-x";

  if (mode === "spacing-x" || mode === "spacing-y") {
    return equalSpacingMoves(all, horizontal);
  }

  const value = (target: AlignTarget) => {
    const edges = boundsEdges(target.bounds);
    switch (mode) {
      case "left": return edges.left;
      case "center-x": return edges.centerX;
      case "right": return edges.right;
      case "top": return edges.top;
      case "center-y": return edges.centerY;
      case "bottom": return edges.bottom;
    }
  };

  const ordered = [...all].sort((left, right) => value(left) - value(right));
  const first = value(ordered[0]);
  const last = value(ordered[ordered.length - 1]);
  const step = (last - first) / (ordered.length - 1);

  return ordered
    .map((target, index) => {
      // The ends hold the span; only the interior moves.
      if (index === 0 || index === ordered.length - 1 || target.locked) return null;
      const delta = first + step * index - value(target);
      return horizontal
        ? { id: target.id, dx: delta, dy: 0 }
        : { id: target.id, dx: 0, dy: delta };
    })
    .filter(isMove);
}

/**
 * Equal gaps rather than equal edge steps.
 *
 * Distributing centres leaves visibly uneven gaps as soon as the objects are different sizes,
 * which is the usual case for a lower third or a logo row. This packs them so the space *between*
 * them is identical, keeping the outermost two where they are.
 */
function equalSpacingMoves(targets: readonly AlignTarget[], horizontal: boolean): Move[] {
  const size = (target: AlignTarget) => (horizontal ? target.bounds.width : target.bounds.height);
  const start = (target: AlignTarget) => (horizontal ? target.bounds.x : target.bounds.y);

  const ordered = [...targets].sort((left, right) => start(left) - start(right));
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const span = start(last) + size(last) - start(first);
  const occupied = ordered.reduce((total, target) => total + size(target), 0);
  const gap = (span - occupied) / (ordered.length - 1);

  const moves: Move[] = [];
  let cursor = start(first) + size(first) + gap;

  for (let index = 1; index < ordered.length - 1; index += 1) {
    const target = ordered[index];
    const delta = cursor - start(target);
    if (!target.locked && delta !== 0) {
      moves.push(horizontal ? { id: target.id, dx: delta, dy: 0 } : { id: target.id, dx: 0, dy: delta });
    }
    cursor += size(target) + gap;
  }

  return moves;
}

/**
 * The box a selection aligns against.
 *
 * Falls back to the selection's own box whenever the requested reference cannot be resolved — a
 * key-object reference with no key object, or a parent reference on objects that have no
 * container. Falling back is right because the operator asked to align *something*; refusing
 * would leave a button that silently does nothing.
 */
export function resolveAlignFrame(
  reference: AlignReference,
  targets: readonly AlignTarget[],
  context: { canvas: Bounds; keyObjectId?: string | null; parentBounds?: Bounds | null }
): Bounds {
  if (reference === "canvas") return context.canvas;

  if (reference === "key-object" && context.keyObjectId) {
    const key = targets.find((target) => target.id === context.keyObjectId);
    if (key) return key.bounds;
  }

  if (reference === "parent" && context.parentBounds) return context.parentBounds;

  return selectionBoundsOf(targets);
}

export function selectionBoundsOf(targets: readonly AlignTarget[]): Bounds {
  return unionBounds(targets.map((target) => target.bounds));
}

/**
 * The alignment reference the *key object* implies.
 *
 * When one object is the key, it must not move even though it is part of the selection — so it is
 * filtered out of the movable set rather than given a zero delta, which keeps it out of undo and
 * out of the "objects changed" count.
 */
export function movableTargets(
  targets: readonly AlignTarget[],
  reference: AlignReference,
  keyObjectId?: string | null
): AlignTarget[] {
  const usable = movable(targets);
  if (reference !== "key-object" || !keyObjectId) return usable;
  return usable.filter((target) => target.id !== keyObjectId);
}

/** Whether an operation can do anything with this selection, for enabling the buttons. */
export function canAlign(targets: readonly AlignTarget[], reference: AlignReference): boolean {
  const movableCount = movableTargets(targets, reference).length;
  // Aligning one object to the canvas or to a key object is meaningful; aligning one object to
  // its own bounding box is not, because it is already there.
  if (reference === "selection" || reference === "parent") return movableCount >= 2;
  return movableCount >= 1;
}

export function canDistribute(targets: readonly AlignTarget[]): boolean {
  return movable(targets).length >= 3;
}

/** Bounds of every object in the document that contains these, for the `parent` reference. */
export function parentBoundsFor(
  scene: SceneDocument,
  objectIds: readonly string[],
  boundsOf: (object: SceneObject) => Bounds
): Bounds | null {
  const container = scene.objects.find(
    (candidate) =>
      (candidate.type === "layer" || candidate.type === "group")
      && objectIds.length > 0
      && objectIds.every((id) => candidate.childIds.includes(id))
  );
  return container ? boundsOf(container) : null;
}

function movable(targets: readonly AlignTarget[]): AlignTarget[] {
  return targets.filter((target) => !target.locked);
}

function isMove(move: Move | null): move is Move {
  return move !== null && (move.dx !== 0 || move.dy !== 0);
}

