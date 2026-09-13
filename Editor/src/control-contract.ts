// Declared template-control authoring (build plan 11.26).
//
// This is a projection, not a second property vocabulary. The shell supplies
// `fillableProperties` from Rust's `fillable_properties`, so the panel cannot
// advertise a field `declare_control_field` would reject.

import type { ControlFieldKind, SceneDocument, SceneObject } from "@grapix/contracts";

import type { UiNode } from "./agent-surface";

export interface ControlProperty {
  readonly property: string;
  readonly kind: ControlFieldKind;
}

export interface ControlContractState {
  readonly selectedIds?: readonly string[];
  /// Filled by `cmd_control_properties`; absent means the authoritative
  /// vocabulary is still loading, never that a kind has no available fields.
  readonly fillableProperties?: readonly ControlProperty[];
}

function selectedObject(document: SceneDocument, selectedIds: readonly string[]): SceneObject | undefined {
  if (selectedIds.length !== 1) return undefined;
  return document.objects.find((object) => object.id === selectedIds[0]);
}

/** The accessible, agent-readable declared-control authoring panel. */
export function controlContractPanel(
  document: SceneDocument,
  state: ControlContractState = {},
): UiNode {
  const selectedIds = state.selectedIds ?? [];
  const selected = selectedObject(document, selectedIds);
  const fields = document.controls ?? [];
  const declarationReason =
    selected === undefined
      ? selectedIds.length === 0
        ? "Select one object to declare an operator field"
        : "Select exactly one object to declare an operator field"
      : state.fillableProperties === undefined
        ? `Loading fillable properties for ${selected.type} from the Rust contract`
        : state.fillableProperties.length === 0
          ? `${selected.type} exposes no operator-fillable properties`
          : undefined;

  const declared: UiNode[] = fields.map((field) => ({
    id: `control/field/${field.fieldId}`,
    role: "listitem",
    label: field.label,
    description: `${field.objectId}.${field.property} · ${field.kind.slice(0, 1).toUpperCase()}${field.kind.slice(1)}`,
    value: field.default === undefined ? "No default" : `Default: ${field.default.type}`,
    actions: [
      { name: "setLabel", label: "Set label" },
      { name: "setDefault", label: "Set default" },
      { name: "remove", label: "Remove field" },
    ],
  }));

  const options: UiNode[] = (state.fillableProperties ?? []).map((candidate) => ({
    id: `control/property/${candidate.property}`,
    role: "listitem",
    label: candidate.property,
    value: `${candidate.kind.slice(0, 1).toUpperCase()}${candidate.kind.slice(1)}`,
    actions: [
      {
        name: "declare",
        label: `Declare ${candidate.property}`,
        ...(declarationReason === undefined ? {} : { unavailable: declarationReason }),
      },
    ],
  }));

  return {
    id: "control-contract",
    role: "region",
    label: "Template controls",
    description: `${fields.length} declared operator field(s) in ${document.name}`,
    children: [
      { id: "control/declared", role: "list", label: "Declared fields", children: declared },
      {
        id: "control/fillable",
        role: "list",
        label: selected === undefined ? "Fillable properties" : `Fillable properties for ${selected.name}`,
        ...(declarationReason === undefined ? {} : { description: declarationReason }),
        children: options,
      },
    ],
  };
}
