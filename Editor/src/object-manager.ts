// The object manager treegrid (build plan 11.8).
//
// Done when: hierarchy, visibility, lock, alpha, transforms.
//
// **Nesting here is presentation, not resolution.** The hierarchy resolver is
// Rust's (`resolve_hierarchy` in `Shared/contracts/src/scene.rs`), and it owns
// the hard parts: cycles, multiple parents, later-parent edges, and the
// effective transform composition. This module reads `childIds` to lay rows
// out and nothing more. A second resolver here would be the parallel
// implementation invariant 27 forbids, and it would drift on exactly the cases
// the Rust one exists to get right.
//
// **The refusals are the interesting part.** Toggling the visibility of an
// object whose parent is hidden does nothing observable — the object stays
// invisible either way. An interface that offers that toggle and then appears
// to do nothing is the silent failure invariant 18 forbids, so the action is
// unavailable and says which parent is hiding it.

import type { SceneDocument, SceneObject } from "@grapix/contracts";

import type { UiAction, UiNode } from "./agent-surface";

/// What the panel needs to know that the document does not carry: which rows
/// the author has selected, and which containers they have collapsed. Both are
/// view state, deliberately not stored on the document — a collapsed group is
/// not a property of the scene, and saving it would make two authors' files
/// differ for no reason anyone would call an edit.
export interface ObjectManagerState {
  readonly selectedIds: readonly string[];
  readonly collapsedIds: readonly string[];
}

/// The ids a container claims, or `undefined` for a leaf.
///
/// `undefined` and `[]` are different answers: a leaf cannot be expanded at
/// all, while an empty group can be (and shows nothing). Rendering a leaf with
/// `expanded: false` would tell a screen reader it is a collapsed container.
function childIdsOf(object: SceneObject): readonly string[] | undefined {
  return object.type === "group" || object.type === "layer" ? object.childIds : undefined;
}

/// Format a transform for the row's summary cell.
///
/// Scale and rotation are omitted when they are identity, because a column of
/// `1×1 0°` on every row is noise that hides the one row where it matters.
export function transformSummary(object: SceneObject): string {
  const parts = [`x ${trim(object.x)}`, `y ${trim(object.y)}`];
  if (object.scaleX !== 1 || object.scaleY !== 1) {
    parts.push(`scale ${trim(object.scaleX)}×${trim(object.scaleY)}`);
  }
  if (object.rotation !== 0) {
    parts.push(`rot ${trim(object.rotation)}°`);
  }
  return parts.join(", ");
}

function trim(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(3)));
}

/// Opacity as a percentage, which is how an author thinks about alpha.
export function alphaLabel(opacity: number): string {
  return `${Math.round(opacity * 100)}%`;
}

interface Placement {
  readonly object: SceneObject;
  readonly level: number;
  /// The nearest ancestor that is hidden, if any. Carried down the walk so a
  /// row can name the cause rather than merely reporting that it is stuck.
  readonly hiddenBy?: string;
  /// The nearest ancestor that is locked, if any.
  readonly lockedBy?: string;
}

/// Walk the document into the rows that are actually shown, depth-first, in
/// document order.
///
/// An object claimed by a container is emitted inside it and nowhere else; the
/// remainder are roots. Objects claimed by a container that does not exist stay
/// roots rather than disappearing, because an object the author can no longer
/// see is worse than one in the wrong place.
///
/// A collapsed container's descendants are not emitted at all. In a flat
/// treegrid a hidden row is absent rather than present-and-styled, so what is
/// walked by a keyboard, announced by a screen reader and reported to an agent
/// is the same set a person can see.
function place(document: SceneDocument, collapsed: ReadonlySet<string>): Placement[] {
  const byId = new Map(document.objects.map((object) => [object.id, object]));
  const claimed = new Set<string>();
  for (const object of document.objects) {
    for (const child of childIdsOf(object) ?? []) {
      if (byId.has(child)) claimed.add(child);
    }
  }

  const placements: Placement[] = [];
  const seen = new Set<string>();

  const walk = (object: SceneObject, level: number, hiddenBy?: string, lockedBy?: string): void => {
    // A cycle would otherwise recurse forever. The Rust resolver reports one
    // as a diagnostic; here it is enough to stop, because the row has already
    // been drawn once and drawing it again would be the bug.
    if (seen.has(object.id)) return;
    seen.add(object.id);

    placements.push({
      object,
      level,
      ...(hiddenBy === undefined ? {} : { hiddenBy }),
      ...(lockedBy === undefined ? {} : { lockedBy }),
    });

    if (collapsed.has(object.id)) return;

    const nextHiddenBy = hiddenBy ?? (object.visible ? undefined : object.name);
    const nextLockedBy = lockedBy ?? (object.locked ? object.name : undefined);
    for (const childId of childIdsOf(object) ?? []) {
      const child = byId.get(childId);
      if (child) walk(child, level + 1, nextHiddenBy, nextLockedBy);
    }
  };

  for (const object of document.objects) {
    if (!claimed.has(object.id)) walk(object, 1);
  }
  // Anything only reachable through a broken or cyclic edge still gets a row,
  // unless a collapsed ancestor is deliberately hiding it.
  for (const object of document.objects) {
    if (!seen.has(object.id) && !hasCollapsedAncestor(object.id, document, collapsed)) {
      walk(object, 1);
    }
  }
  return placements;
}

/// Whether a collapsed container claims this object, directly or transitively.
function hasCollapsedAncestor(
  id: string,
  document: SceneDocument,
  collapsed: ReadonlySet<string>,
): boolean {
  const parentOf = new Map<string, string>();
  for (const object of document.objects) {
    for (const child of childIdsOf(object) ?? []) {
      if (!parentOf.has(child)) parentOf.set(child, object.id);
    }
  }
  const visited = new Set<string>();
  let current = parentOf.get(id);
  while (current !== undefined && !visited.has(current)) {
    if (collapsed.has(current)) return true;
    visited.add(current);
    current = parentOf.get(current);
  }
  return false;
}

function cell(rowId: string, key: string, label: string, value: string): UiNode {
  return { id: `${rowId}/${key}`, role: "gridcell", label, value };
}

function rowActions(placement: Placement, isContainer: boolean, collapsed: boolean): UiAction[] {
  const { object, hiddenBy, lockedBy } = placement;

  // A locked object refuses edits by name. The lock is the author's own
  // instruction, so the refusal quotes which object carries it — the lock may
  // be on an ancestor, and hunting for it is the tedious part.
  const lockReason =
    object.locked
      ? `${object.name} is locked`
      : lockedBy !== undefined
        ? `locked by parent '${lockedBy}'`
        : undefined;

  const visibilityReason =
    hiddenBy !== undefined
      ? `hidden by parent '${hiddenBy}'`
      : lockReason;

  const actions: UiAction[] = [
    { name: "select", label: "Select" },
    {
      name: "toggleVisibility",
      label: object.visible ? "Hide" : "Show",
      ...(visibilityReason === undefined ? {} : { unavailable: visibilityReason }),
    },
    {
      name: "toggleLock",
      label: object.locked ? "Unlock" : "Lock",
      // A lock inherited from a parent cannot be released from the child: the
      // instruction lives on the ancestor, and pretending otherwise would let
      // an author think they had unlocked something they had not.
      ...(lockedBy === undefined ? {} : { unavailable: `locked by parent '${lockedBy}'` }),
    },
  ];

  actions.push(
    isContainer
      ? collapsed
        ? { name: "expand", label: "Expand" }
        : { name: "collapse", label: "Collapse" }
      : {
          name: "expand",
          label: "Expand",
          unavailable: `${object.name} has no children`,
        },
  );
  return actions;
}

/// Build the object manager panel for one scene.
export function objectManagerPanel(
  document: SceneDocument,
  state: ObjectManagerState,
): UiNode {
  const selected = new Set(state.selectedIds);
  const collapsed = new Set(state.collapsedIds);

  const rows: UiNode[] = place(document, collapsed).map((placement) => {
    const { object, level } = placement;
    const children = childIdsOf(object);
    const isContainer = children !== undefined;
    const isCollapsed = isContainer && collapsed.has(object.id);

    return {
      id: object.id,
      role: "row",
      label: object.name,
      level,
      selected: selected.has(object.id),
      // A leaf reports no expanded state at all: it is not a collapsed
      // container, and saying `false` would announce it as one.
      ...(isContainer ? { expanded: !isCollapsed } : {}),
      ...(placement.hiddenBy === undefined
        ? {}
        : { description: `hidden by parent '${placement.hiddenBy}'` }),
      actions: rowActions(placement, isContainer, isCollapsed),
      children: [
        cell(object.id, "name", "Name", object.name),
        cell(object.id, "kind", "Kind", object.type),
        cell(object.id, "visible", "Visible", object.visible ? "shown" : "hidden"),
        cell(object.id, "locked", "Locked", object.locked ? "locked" : "unlocked"),
        cell(object.id, "alpha", "Alpha", alphaLabel(object.opacity)),
        cell(object.id, "transform", "Transform", transformSummary(object)),
      ],
    };
  });

  // Rows nest by `aria-level` rather than by DOM containment: that is what a
  // treegrid is, and it keeps a row's cells as its only element children.
  return {
    id: "object-manager",
    role: "treegrid",
    label: "Objects",
    description: `${rows.length} object(s) in ${document.name}`,
    children: rows,
  };
}
