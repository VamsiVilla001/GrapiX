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

import type { ObjectField, SceneDocument, SceneEdit, SceneObject } from "@grapix/contracts";

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
      input: {
        type: spec.input === "number" ? "number" : spec.input === "boolean" ? "checkbox" : "text",
        value: value === undefined || isMixed(value) ? "" : spec.input === "unit" ? displayValue(value, spec) : String(value),
        ...(isMixed(value) ? { mixed: true } : {}),
      },
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
    children: [...containerPaintNotices(document, selectedIds), ...fields],
  };
}

/// Containers carry no paint. This is presentation of the contract's
/// ScenePropertyNotDrawable rule, not an edit: stored values stay intact.
/// Paint controls remain absent, while invalid imported/older content is
/// visible to the person and the agent inspecting the same panel.
function containerPaintNotices(document: SceneDocument, selectedIds: readonly string[]): UiNode[] {
  return document.objects.flatMap((object, index) => {
    if (!selectedIds.includes(object.id) || (object.type !== "group" && object.type !== "layer")) return [];
    return (["fill", "stroke"] as const).flatMap((property): UiNode[] => {
      const paint = object[property];
      if (paint === undefined || paint.type === "none") return [];
      const path = `objects[${index}].${property}`;
      return [{
        id: `inspector/refused-paint/${object.id}/${property}`,
        role: "alert",
        label: `Unsupported ${property} on ${object.name}`,
        value: `Refused [scenePropertyNotDrawable]: ${object.type} ${object.name} (${object.id}), ${path}. Containers do not paint; the stored value is preserved.`,
        description: `Stored ${property}: ${JSON.stringify(paint)}`,
      }];
    });
  });
}

// ---------------------------------------------------------------------------
// Properties sections (11.63). The Editor presents the inspector the way After
// Effects' Properties panel does: a Layer section, a Transform section, then
// the kind's own sections. Sections are presentation over the same field
// nodes — the node tree, the agent view and the edit path are unchanged — and
// a field no section claims is shown under "Other", never dropped.
// ---------------------------------------------------------------------------

export interface InspectorSection {
  readonly id: string;
  readonly title: string;
  readonly fields: readonly UiNode[];
}

const SECTIONS: readonly { readonly id: string; readonly title: string; readonly keys: readonly string[] }[] = [
  { id: "layer", title: "Layer", keys: ["name", "visible", "locked"] },
  // After Effects' order: position, scale, rotation, opacity.
  { id: "transform", title: "Transform", keys: ["x", "y", "scaleX", "scaleY", "rotation", "opacity"] },
  { id: "text", title: "Text", keys: ["text", "fontId", "size"] },
  { id: "shape", title: "Shape", keys: ["radius"] },
];

/// The field key an inspector node carries, from its id.
export function inspectorFieldKey(node: UiNode): string | undefined {
  return node.id.startsWith("inspector/") ? node.id.slice("inspector/".length) : undefined;
}

/// Group an inspector panel's fields into sections, in display order.
export function inspectorSections(panel: UiNode): InspectorSection[] {
  const fields = panel.children ?? [];
  const byKey = new Map<string, UiNode>();
  for (const field of fields) {
    const key = inspectorFieldKey(field);
    if (key !== undefined) byKey.set(key, field);
  }
  const placed = new Set<UiNode>();
  const sections: InspectorSection[] = [];
  const paintNotices = fields.filter((field) => field.id.startsWith("inspector/refused-paint/"));
  if (paintNotices.length > 0) {
    sections.push({ id: "refused-paint", title: "Unsupported container paint", fields: paintNotices });
    for (const notice of paintNotices) placed.add(notice);
  }
  for (const section of SECTIONS) {
    const members = section.keys.flatMap((key) => {
      const field = byKey.get(key);
      return field ? [field] : [];
    });
    for (const member of members) placed.add(member);
    if (members.length > 0) sections.push({ id: section.id, title: section.title, fields: members });
  }
  const rest = fields.filter((field) => !placed.has(field));
  if (rest.length > 0) sections.push({ id: "other", title: "Other", fields: rest });
  return sections;
}

// ---------------------------------------------------------------------------
// Command construction. The inspector decides what the author asked for; the
// Rust edit rules (`gx_contracts::object_edit`, `authoring`) decide whether it
// may happen, and refuse by name if not. One gesture is one `SceneEdit` batch,
// which Rust applies atomically as one history entry.
// ---------------------------------------------------------------------------

/// Why an edit could not be built.
export interface EditRefused {
  readonly refused: string;
}

export function isRefused<T extends object>(outcome: T | EditRefused): outcome is EditRefused {
  return "refused" in outcome;
}

/// The history label for a field edit that changed `count` objects.
export function fieldEditLabel(field: string, count: number): string {
  const label = FIELDS.find((candidate) => candidate.key === field)?.label ?? field;
  return count > 1 ? `Set ${label} on ${count} objects` : `Set ${label}`;
}

function objectFieldFor(field: string, value: unknown): ObjectField | undefined {
  switch (field) {
    case "opacity":
    case "x":
    case "y":
    case "rotation":
    case "scaleX":
    case "scaleY":
    case "size":
    case "radius":
      return typeof value === "number" ? { name: field, value } : undefined;
    case "text":
    case "fontId":
      return typeof value === "string" ? { name: field, value } : undefined;
    default:
      return undefined;
  }
}

/// How many containers claim an object, walking `childIds` upward. A cycle
/// stops the walk rather than looping.
function depthOf(parents: ReadonlyMap<string, string>, objectId: string): number {
  const seen = new Set([objectId]);
  let depth = 0;
  for (let at = parents.get(objectId); at !== undefined && !seen.has(at); at = parents.get(at)) {
    seen.add(at);
    depth += 1;
  }
  return depth;
}

/// Order a visibility or lock batch so it cannot refuse on its own members.
///
/// Rust refuses a change under a hidden or locked ancestor. Hiding or locking
/// therefore runs innermost first, and showing or unlocking outermost first,
/// so a group and its child selected together change in one gesture.
function inheritanceOrder(
  document: SceneDocument,
  objects: readonly SceneObject[],
  restricting: boolean,
): SceneObject[] {
  const parents = new Map<string, string>();
  for (const object of document.objects) {
    const children = object.type === "group" || object.type === "layer" ? object.childIds : [];
    for (const child of children) if (!parents.has(child)) parents.set(child, object.id);
  }
  const sign = restricting ? -1 : 1;
  return [...objects].sort(
    (left, right) => sign * (depthOf(parents, left.id) - depthOf(parents, right.id)),
  );
}

/// Turn one inspector edit across the selection into the batch Rust applies.
///
/// Shared transform and type-aware fields are one `setObjectField` over every
/// selected object, so a field missing from part of the selection is refused
/// for the selection as a whole. Name, visibility and lock are the same edits
/// the object manager sends, so they obey the same inherited-state refusals.
export function inspectorEdits(
  document: SceneDocument,
  selectedIds: readonly string[],
  field: string,
  value: unknown,
): readonly SceneEdit[] | EditRefused {
  const spec = FIELDS.find((candidate) => candidate.key === field);
  if (!spec) return { refused: `no inspector field named ${field}` };
  const selected = document.objects.filter((object) => selectedIds.includes(object.id));
  if (selected.length === 0) return { refused: "nothing is selected" };

  switch (field) {
    case "name":
      if (typeof value !== "string") break;
      return selected.map((object) => ({ edit: "renameObject", objectId: object.id, name: value }));
    case "visible":
      if (typeof value !== "boolean") break;
      return inheritanceOrder(document, selected, !value).map((object) => ({
        edit: "setObjectVisible",
        objectId: object.id,
        visible: value,
      }));
    case "locked":
      if (typeof value !== "boolean") break;
      return inheritanceOrder(document, selected, value).map((object) => ({
        edit: "setObjectLocked",
        objectId: object.id,
        locked: value,
      }));
    default: {
      const objectField = objectFieldFor(field, value);
      if (!objectField) break;
      return [
        { edit: "setObjectField", objectIds: selected.map((object) => object.id), field: objectField },
      ];
    }
  }
  return { refused: `${spec.label} cannot be set to ${String(value)}` };
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
