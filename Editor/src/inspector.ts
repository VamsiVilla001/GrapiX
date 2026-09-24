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

/// How a typed entry becomes a field value. `unit` is 0–1 and also accepts a
/// percentage, because that is how the panel displays it.
type InputKind = "string" | "nonEmptyString" | "number" | "unit" | "boolean";

interface FieldSpec {
  readonly key: string;
  readonly label: string;
  readonly appliesTo: AppliesTo;
  readonly input: InputKind;
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
  { key: "name", label: "Name", appliesTo: undefined, input: "nonEmptyString", read: (o) => o.name },
  { key: "visible", label: "Visible", appliesTo: undefined, input: "boolean", read: (o) => o.visible },
  { key: "locked", label: "Locked", appliesTo: undefined, input: "boolean", read: (o) => o.locked },
  {
    key: "opacity",
    label: "Opacity",
    appliesTo: undefined,
    input: "unit",
    read: (o) => o.opacity,
    format: percent,
  },
  { key: "x", label: "X", appliesTo: undefined, input: "number", read: (o) => o.x },
  { key: "y", label: "Y", appliesTo: undefined, input: "number", read: (o) => o.y },
  { key: "rotation", label: "Rotation", appliesTo: undefined, input: "number", read: (o) => o.rotation },
  { key: "scaleX", label: "Scale X", appliesTo: undefined, input: "number", read: (o) => o.scaleX },
  { key: "scaleY", label: "Scale Y", appliesTo: undefined, input: "number", read: (o) => o.scaleY },
  // Type-aware fields.
  {
    key: "text",
    label: "Text",
    appliesTo: ["text"],
    input: "string",
    read: (o) => (o.type === "text" ? o.text : undefined),
  },
  {
    key: "fontId",
    label: "Font",
    appliesTo: ["text"],
    input: "nonEmptyString",
    read: (o) => (o.type === "text" ? o.fontId : undefined),
  },
  {
    key: "size",
    label: "Size",
    appliesTo: ["text"],
    input: "number",
    read: (o) => (o.type === "text" ? o.size : undefined),
  },
  {
    key: "radius",
    label: "Corner radius",
    appliesTo: ["rect"],
    input: "number",
    read: (o) => (o.type === "rect" ? o.radius : undefined),
  },
];

function applies(spec: FieldSpec, kind: SceneObject["type"]): boolean {
  return spec.appliesTo === undefined || spec.appliesTo.includes(kind);
}

/// The one sentence for "this field is not on some of what you selected".
/// The panel's disabled Edit button and the edit path both use it, so the
/// refusal an author gets is the reason the button already showed.
function notAPropertyOf(spec: FieldSpec, kinds: readonly SceneObject["type"][]): string {
  return `${spec.label} is not a property of ${kinds.join(", ")}`;
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
            : { unavailable: notAPropertyOf(spec, missing) }),
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

export function isRefused<T extends object>(outcome: T | EditRefused): outcome is EditRefused {
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
    const kinds = [...new Set(selected.map((object) => object.type))];
    return { refused: notAPropertyOf(spec, kinds) };
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

// ---------------------------------------------------------------------------
// Applying a transaction
// ---------------------------------------------------------------------------

/// A transaction applied, or the reason it could not be.
export type ApplyOutcome = { readonly document: SceneDocument } | EditRefused;

/// Produce the document a transaction describes, without touching the input.
///
/// Every change is checked against the value it says it replaces. A change
/// whose `from` no longer matches was computed against a document that has
/// since moved, and writing it anyway would overwrite an edit nobody undid.
/// The whole transaction is refused in that case: half of one gesture applied
/// is exactly the state one-gesture-one-undo exists to rule out.
export function applyTransaction(
  document: SceneDocument,
  transaction: EditTransaction,
): ApplyOutcome {
  let objects: SceneObject[] = [...document.objects];
  for (const change of transaction.changes) {
    const index = objects.findIndex((object) => object.id === change.objectId);
    const object = objects[index];
    if (index < 0 || object === undefined) {
      return { refused: `object ${change.objectId} is not in ${document.name}` };
    }
    const current = (object as unknown as Record<string, unknown>)[change.field];
    if (!Object.is(current, change.from)) {
      return {
        refused: `${change.objectId}.${change.field} is ${String(current)}, not ${String(change.from)}; the edit is stale`,
      };
    }
    objects = objects.map((candidate, at) =>
      at === index ? ({ ...candidate, [change.field]: change.to } as SceneObject) : candidate,
    );
  }
  return { document: { ...document, objects } };
}

/// The transaction that undoes `transaction`: every change reversed, in
/// reverse order. Undo in the Editor restores the pre-gesture snapshot; this
/// is the same fact stated from the change list, which is what lets a test
/// prove the change list and the snapshot agree.
export function invertTransaction(transaction: EditTransaction): EditTransaction {
  return {
    label: `Undo ${transaction.label}`,
    changes: [...transaction.changes]
      .reverse()
      .map((change) => ({ ...change, from: change.to, to: change.from })),
  };
}

/// Turn what the author typed into a value for `field`, or say why not.
///
/// Out-of-range and malformed entries are refused, never clamped or coerced:
/// clamping answers a question the author did not ask.
export function parseFieldInput(
  field: string,
  raw: string,
): { readonly value: unknown } | EditRefused {
  const spec = FIELDS.find((candidate) => candidate.key === field);
  if (!spec) return { refused: `no inspector field named ${field}` };
  const trimmed = raw.trim();
  switch (spec.input) {
    case "string":
      return { value: raw };
    case "nonEmptyString":
      return trimmed === "" ? { refused: `${spec.label} cannot be empty` } : { value: trimmed };
    case "boolean":
      if (trimmed === "true") return { value: true };
      if (trimmed === "false") return { value: false };
      return { refused: `${spec.label} needs true or false, not "${raw}"` };
    case "number":
    case "unit": {
      const isPercent = spec.input === "unit" && trimmed.endsWith("%");
      const number = Number(isPercent ? trimmed.slice(0, -1) : trimmed);
      if (trimmed === "" || !Number.isFinite(number)) {
        return { refused: `${spec.label} needs a finite number, not "${raw}"` };
      }
      const value = isPercent ? number / 100 : number;
      if (spec.input === "unit" && (value < 0 || value > 1)) {
        return { refused: `${spec.label} must be between 0 and 1 (0% to 100%), not ${trimmed}` };
      }
      return { value };
    }
  }
}

/// What the edit prompt should start from: the shared value, or empty when the
/// selection is Mixed, so the author types a value rather than editing one
/// object's.
export function fieldEditStart(
  document: SceneDocument,
  selectedIds: readonly string[],
  field: string,
): { readonly label: string; readonly initial: string; readonly mixed: boolean } | undefined {
  const spec = FIELDS.find((candidate) => candidate.key === field);
  if (!spec) return undefined;
  const values = document.objects
    .filter((object) => selectedIds.includes(object.id) && applies(spec, object.type))
    .map((object) => spec.read(object));
  const value = unify(values);
  if (value === undefined) return undefined;
  if (isMixed(value)) return { label: spec.label, initial: "", mixed: true };
  return { label: spec.label, initial: String(value), mixed: false };
}

/// One inspector gesture from start to finish: the transaction and the
/// document it produces.
///
/// This is the path the panel's Edit control takes, so it holds the panel's
/// rule: a field missing from part of the selection is refused with the same
/// sentence the disabled button shows. Writing it to only the objects that
/// have it would be an edit the panel told the author it would not make.
export function editSelection(
  document: SceneDocument,
  selectedIds: readonly string[],
  field: string,
  value: unknown,
): { readonly document: SceneDocument; readonly transaction: EditTransaction } | EditRefused {
  const spec = FIELDS.find((candidate) => candidate.key === field);
  if (spec) {
    const kinds = [
      ...new Set(
        document.objects
          .filter((object) => selectedIds.includes(object.id))
          .map((object) => object.type),
      ),
    ];
    const missing = kinds.filter((kind) => !applies(spec, kind));
    if (missing.length > 0 && missing.length < kinds.length) {
      return { refused: notAPropertyOf(spec, missing) };
    }
  }
  const outcome = applyEdit(document, selectedIds, field, value);
  if (isRefused(outcome)) return outcome;
  const applied = applyTransaction(document, outcome);
  if ("refused" in applied) return applied;
  return { document: applied.document, transaction: outcome };
}
