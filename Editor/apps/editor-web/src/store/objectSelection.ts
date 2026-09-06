/**
 * The Editor's object selection: the set, the active member, and the range anchor.
 *
 * One selection, in one place. Before this there were two — `editorStore.selectedObjectId` and
 * `uiStore.selectedPathObjectIds`, the marquee's set — reconciled ad hoc by the alignment tools.
 * Nothing cleared the second one, so a marquee of five objects stayed live in the alignment
 * toolbar after the author clicked a single object, and the canvas drew a gizmo for one of them.
 *
 * It lives beside the store rather than in `modules/object-manager/` because three surfaces read
 * it — the Object Manager, the canvas and the alignment tools — and because only `editorStore`
 * can prune it in the *same* `set` as the mutation that invalidated it. A copy in `uiStore` would
 * need a reconciling effect, which paints one frame in which the toolbar counts deleted ids.
 *
 * Everything here is pure: no store, no React, no DOM. The gesture table is the contract, and it
 * is asserted directly in `tests/object-selection.test.ts`.
 */

export interface ObjectSelection {
  /** The selection, in render order. Empty means nothing is selected. */
  selectedObjectIds: string[];
  /** The active member — the alignment key object. Non-null exactly when the set is non-empty. */
  activeObjectId: string | null;
  /** Where a Shift range measures from. */
  anchorId: string | null;
}

export const EMPTY_OBJECT_SELECTION: ObjectSelection = {
  selectedObjectIds: [],
  activeObjectId: null,
  anchorId: null
};

/**
 * What a gesture can see.
 *
 * `rows` is what is on screen, top to bottom: a Shift range spans what the author can point at,
 * and a removed member hands the active role to its nearest surviving neighbour *above*.
 *
 * `all` is the selectable universe — every object matching the current search, including the
 * descendants of a collapsed group. `selectAll` uses it so that Ctrl+A followed by Delete cannot
 * leave a collapsed child orphaned, which is the one place where "what you can see" is the wrong
 * answer. It defaults to `rows`.
 */
export interface ObjectSelectionContext {
  rows: readonly string[];
  all?: readonly string[];
}

export type ObjectSelectionGesture =
  /** Plain click. */
  | { kind: "replace"; id: string }
  /** Ctrl/Cmd-click: add, or remove when already a member. */
  | { kind: "toggle"; id: string }
  /** Shift-click: the inclusive run from the anchor, replacing the set. */
  | { kind: "range"; id: string }
  /** Ctrl+Shift-click: that run, unioned with the set. */
  | { kind: "rangeAdd"; id: string }
  | { kind: "selectAll" }
  | { kind: "clear" };

/**
 * Put a selection into its canonical form and enforce the invariant.
 *
 * Order follows the selectable universe, not click order, so the set reads the same however it was
 * built — the same reason the Object Manager re-sorts its chosen columns into catalogue order.
 * The active member is forced to *be* a member, because every consumer treats it as one: the
 * Inspector edits it, the alignment tools align to it, and the canvas draws its gizmo.
 */
export function normaliseObjectSelection(
  selection: ObjectSelection,
  context: ObjectSelectionContext
): ObjectSelection {
  const order = context.all ?? context.rows;
  const rank = new Map(order.map((id, index) => [id, index]));
  const unique = [...new Set(selection.selectedObjectIds)];
  // An id the context does not know about keeps its relative position at the end rather than
  // being dropped: the context is a view (a search, a collapse), not the scene.
  const selectedObjectIds = unique.sort(
    (left, right) => (rank.get(left) ?? order.length) - (rank.get(right) ?? order.length)
  );

  if (selectedObjectIds.length === 0) return EMPTY_OBJECT_SELECTION;

  const activeObjectId = selection.activeObjectId && selectedObjectIds.includes(selection.activeObjectId)
    ? selection.activeObjectId
    : selectedObjectIds[0];
  const anchorId = selection.anchorId && rank.has(selection.anchorId) ? selection.anchorId : activeObjectId;

  return { selectedObjectIds, activeObjectId, anchorId };
}

/** The inclusive run of visible rows between two ids, in row order. */
function runBetween(rows: readonly string[], from: string, to: string): string[] {
  const start = rows.indexOf(from);
  const end = rows.indexOf(to);
  if (start === -1 || end === -1) return end === -1 ? [] : [to];
  return rows.slice(Math.min(start, end), Math.max(start, end) + 1);
}

/**
 * The member that takes over as active when `removed` was it.
 *
 * Nearest survivor **above** in row order, else the first remaining member. Upwards because a list
 * shortens downwards: after deleting a run, the row above is the one still under the pointer.
 */
function successorAbove(
  rows: readonly string[],
  remaining: readonly string[],
  removed: string
): string | null {
  if (remaining.length === 0) return null;
  const index = rows.indexOf(removed);
  if (index !== -1) {
    for (let above = index - 1; above >= 0; above -= 1) {
      const candidate = rows[above];
      if (remaining.includes(candidate)) return candidate;
    }
  }
  return remaining[0];
}

/** Apply one gesture. Pure: same inputs, same output, no store. */
export function reduceObjectSelection(
  current: ObjectSelection,
  gesture: ObjectSelectionGesture,
  context: ObjectSelectionContext
): ObjectSelection {
  const finish = (next: ObjectSelection) => normaliseObjectSelection(next, context);

  switch (gesture.kind) {
    case "clear":
      return EMPTY_OBJECT_SELECTION;

    case "selectAll": {
      const all = context.all ?? context.rows;
      if (all.length === 0) return EMPTY_OBJECT_SELECTION;
      return finish({ selectedObjectIds: [...all], activeObjectId: all[0], anchorId: all[0] });
    }

    case "replace":
      return finish({
        selectedObjectIds: [gesture.id],
        activeObjectId: gesture.id,
        anchorId: gesture.id
      });

    case "toggle": {
      if (!current.selectedObjectIds.includes(gesture.id)) {
        return finish({
          selectedObjectIds: [...current.selectedObjectIds, gesture.id],
          activeObjectId: gesture.id,
          anchorId: gesture.id
        });
      }
      const remaining = current.selectedObjectIds.filter((id) => id !== gesture.id);
      if (remaining.length === 0) return EMPTY_OBJECT_SELECTION;
      const activeObjectId = current.activeObjectId === gesture.id
        ? successorAbove(context.rows, remaining, gesture.id)
        : current.activeObjectId;
      return finish({ selectedObjectIds: remaining, activeObjectId, anchorId: gesture.id });
    }

    case "range":
    case "rangeAdd": {
      // No anchor yet, so there is no run to take. Degrading to the single-object gesture is the
      // only answer that does something predictable, and it sets the anchor for the next Shift.
      if (!current.anchorId) {
        return reduceObjectSelection(
          current,
          { kind: gesture.kind === "range" ? "replace" : "toggle", id: gesture.id },
          context
        );
      }
      const run = runBetween(context.rows, current.anchorId, gesture.id);
      const selectedObjectIds = gesture.kind === "range"
        ? run
        : [...current.selectedObjectIds, ...run];
      // The anchor survives a range so a second Shift-click re-measures from the same end, which
      // is what makes "extend the range" repeatable rather than a walk.
      return finish({ selectedObjectIds, activeObjectId: gesture.id, anchorId: current.anchorId });
    }
  }
}

/**
 * Drop ids that no longer exist, and hand the active role on if it was one of them.
 *
 * Called from inside the store's own `set`, in the same update as the mutation — a delete, an
 * undo, a redo. `rows` is the order *before* the mutation, which is what makes "above" mean the
 * row the author was looking at.
 */
export function reconcileObjectSelection(
  current: ObjectSelection,
  existingIds: ReadonlySet<string>,
  rows: readonly string[]
): ObjectSelection {
  const remaining = current.selectedObjectIds.filter((id) => existingIds.has(id));
  if (remaining.length === 0) return EMPTY_OBJECT_SELECTION;

  const activeObjectId = current.activeObjectId && existingIds.has(current.activeObjectId)
    ? current.activeObjectId
    : successorAbove(rows, remaining, current.activeObjectId ?? "");
  const anchorId = current.anchorId && existingIds.has(current.anchorId) ? current.anchorId : activeObjectId;

  return normaliseObjectSelection({ selectedObjectIds: remaining, activeObjectId, anchorId }, { rows });
}

/** The gesture a pointer event asks for, from its modifier keys. */
export function gestureForPointer(
  id: string,
  modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }
): ObjectSelectionGesture {
  const additive = Boolean(modifiers.ctrlKey || modifiers.metaKey);
  if (additive && modifiers.shiftKey) return { kind: "rangeAdd", id };
  if (modifiers.shiftKey) return { kind: "range", id };
  if (additive) return { kind: "toggle", id };
  return { kind: "replace", id };
}
