// The type-aware inspector (build plan 11.9).
//
// Done when: multi-select Mixed state, one undo transaction.
//
// **Mixed is a state, not an absence.** Two objects with different opacities
// have a defined answer to "what is the opacity" — they differ. Showing the
// first object's value instead is how an edit silently flattens a property the
// author never touched: they nudge one field, and eleven other objects quietly
// acquire a value nobody chose. That is invariant 18 wearing a different hat.
//
// **A field absent from some of the selection is shown, not hidden.** If a
// rect and a text are selected together, the text-only fields stay on screen
// and say which kind lacks them. A silently missing field reads as "this
// object has no such property", which is a different and wrong statement.
//
// **One gesture is one undo.** Editing a field across twelve selected objects
// produces one transaction carrying twelve changes, never twelve transactions.
// Twelve undo steps for one gesture is the bug this shape exists to prevent:
// the author presses undo once, sees eleven objects still changed, and no
// longer trusts undo at all.

import type { SceneDocument, SceneObject } from "@grapix/contracts";

import { isMixed, unify, type MaybeMixed, type UiNode } from "./agent-surface";

/// The object kinds a field applies to. `undefined` means every kind, which is
/// what the shared `ObjectBase` fields are.
type AppliesTo = readonly SceneObject["type"][] | undefined;

interface FieldSpec {
  readonly key: string;
  readonly label: string;
  readonly appliesTo: AppliesTo;
  readonly read: (object: SceneObject) => unknown;
  readonly format?: (value: unknown) => string;
}

const percent = (value: unknown): string => `${Math.round(Number(value) * 100)}%`;

/// The fields the inspector knows, shared ones first.
///
/// A table rather than a switch: the panel, the Mixed computation and the edit
/// path all read it, so a field added in one place cannot be missing from
/// another.
const FIELDS: readonly FieldSpec[] = [
  { key: "name", label: "Name", appliesTo: undefined, read: (o) => o.name },
  { key: "visible", label: "Visible", appliesTo: undefined, read: (o) => o.visible },
  { key: "locked", label: "Locked", appliesTo: undefined, read: (o) => o.locked },
  { key: "opacity", label: "Opacity", appliesTo: undefined, read: (o) => o.opacity, format: percent },
  { key: "x", label: "X", appliesTo: undefined, read: (o) => o.x },
  { key: "y", label: "Y", appliesTo: undefined, read: (o) => o.y },
  { key: "rotation", label: "Rotation", appliesTo: undefined, read: (o) => o.rotation },
  { key: "scaleX", label: "Scale X", appliesTo: undefined, read: (o) => o.scaleX },
  { key: "scaleY", label: "Scale Y", appliesTo: undefined, read: (o) => o.scaleY },
  // Type-aware fields.
  {
    key: "text",
    label: "Text",
    appliesTo: ["text"],
    read: (o) => (o.type === "text" ? o.text : undefined),
  },
  {
    key: "fontId",
    label: "Font",
    appliesTo: ["text"],
    read: (o) => (o.type === "text" ? o.fontId : undefined),
  },
  {
    key: "size",
    label: "Size",
    appliesTo: ["text"],
    read: (o) => (o.type === "text" ? o.size : undefined),
  },
  {
    key: "radius",
    label: "Corner radius",
    appliesTo: ["rect"],
    read: (o) => (o.type === "rect" ? o.radius : undefined),
  },
];

function applies(spec: FieldSpec, kind: SceneObject["type"]): boolean {
  return spec.appliesTo === undefined || spec.appliesTo.includes(kind);
}

/// Render a value for display, with Mixed as its own readable word.
export function displayValue(
  value: MaybeMixed<unknown> | undefined,
  spec: FieldSpec,
): string {
  if (value === undefined) return "";
  if (isMixed(value)) return "Mixed";
  return spec.format ? spec.format(value) : String(value);
}

/// Build the inspector for the current selection.
export function inspectorPanel(
  document: SceneDocument,
  selectedIds: readonly string[],
): UiNode {
  const selected = document.objects.filter((object) => selectedIds.includes(object.id));

  if (selected.length === 0) {
    return {
      id: "inspector",
      role: "region",
      label: "Inspector",
      description: "Nothing selected",
      children: [],
    };
  }

  const kinds = [...new Set(selected.map((object) => object.type))];

  const fields: UiNode[] = FIELDS.filter((spec) =>
    // A field is shown when it applies to at least one selected kind. One that
    // applies to none is genuinely irrelevant and is the only case that is
    // omitted rather than explained.
    kinds.some((kind) => applies(spec, kind)),
  ).map((spec) => {
    const applicable = selected.filter((object) => applies(spec, object.type));
    const missing = kinds.filter((kind) => !applies(spec, kind));
    const value = unify(applicable.map((object) => spec.read(object)));

    return {
      id: `inspector/${spec.key}`,
      role: "gridcell",
      label: spec.label,
      value: displayValue(value, spec),
      ...(missing.length === 0
        ? {}
        : {
            description: `not on ${missing.join(", ")}`,
          }),
      actions: [
        {
          name: "edit",
          label: `Edit ${spec.label}`,
          // Present but refused, with the kinds named. Hiding it would say
          // "no such property"; this says "not on these of the things you
          // have selected", which is the true statement.
          ...(missing.length === 0
            ? {}
            : { unavailable: `${spec.label} is not a property of ${missing.join(", ")}` }),
        },
      ],
    };
  });

  const only = selected.length === 1 ? selected[0] : undefined;
  return {
    id: "inspector",
    role: "region",
    label: "Inspector",
    description: only
      ? `${only.name} (${only.type})`
      : `${selected.length} objects selected (${kinds.join(", ")})`,
    children: fields,
  };
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

/// One object's field changing, with the value it had.
///
/// The previous value travels with the change so undo is a fact rather than a
/// recomputation: replaying an inverse derived later would depend on the
/// document not having moved underneath it.
export interface ObjectChange {
  readonly objectId: string;
  readonly field: string;
  readonly from: unknown;
  readonly to: unknown;
}

/// One author gesture. Undo operates on this, never on its parts.
export interface EditTransaction {
  readonly label: string;
  readonly changes: readonly ObjectChange[];
}

/// Why an edit could not be made.
export interface EditRefused {
  readonly refused: string;
}

export type EditOutcome = EditTransaction | EditRefused;

export function isRefused(outcome: EditOutcome): outcome is EditRefused {
  return "refused" in outcome;
}

/// Apply one field edit across the whole selection as a single transaction.
///
/// Objects the field does not apply to are skipped rather than refused: with a
/// mixed-kind selection, setting opacity should still set opacity everywhere it
/// means something. What is refused is an edit that would apply to *nothing*,
/// because silently succeeding at doing nothing is the failure this whole
/// module is arranged against.
export function applyEdit(
  document: SceneDocument,
  selectedIds: readonly string[],
  field: string,
  value: unknown,
): EditOutcome {
  const spec = FIELDS.find((candidate) => candidate.key === field);
  if (!spec) {
    return { refused: `no inspector field named ${field}` };
  }

  const selected = document.objects.filter((object) => selectedIds.includes(object.id));
  if (selected.length === 0) {
    return { refused: "nothing is selected" };
  }

  const applicable = selected.filter((object) => applies(spec, object.type));
  if (applicable.length === 0) {
    const kinds = [...new Set(selected.map((object) => object.type))].join(", ");
    return { refused: `${spec.label} is not a property of ${kinds}` };
  }

  const changes: ObjectChange[] = applicable
    .map((object) => ({
      objectId: object.id,
      field,
      from: spec.read(object),
      to: value,
    }))
    // An object already holding the value contributes nothing. Recording it
    // would make undo step over objects it never changed.
    .filter((change) => !Object.is(change.from, change.to));

  if (changes.length === 0) {
    return { refused: `every selected object already has ${spec.label} set to ${String(value)}` };
  }

  return {
    // The count is in the label because that is what the author needs to see
    // in the undo menu: "Set Opacity on 12 objects" is a different thing to
    // undo than "Set Opacity".
    label:
      changes.length === 1
        ? `Set ${spec.label}`
        : `Set ${spec.label} on ${changes.length} objects`,
    changes,
  };
}
