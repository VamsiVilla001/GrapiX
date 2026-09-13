// Operator take-page authoring (build plan 11.27).
//
// A take page is intentionally a filled instance, not a second scene editor.
// The template declares its control surface in Rust; this module projects that
// declaration into one accessible panel so adding a field adds exactly one row.

import type { ControlField, ControlFieldKind, ControlValue, SceneDocument } from "@grapix/contracts";

import type { UiNode } from "./agent-surface";

export interface TakePageState {
  /** Values currently entered by the operator, addressed only by declared ids. */
  readonly values: Readonly<Record<string, ControlValue>>;
  /** The name and id are instance metadata, never template properties. */
  readonly pageId: string;
  readonly name: string;
  /** A Rust refusal remains visible until the operator changes the input. */
  readonly refusal?: string;
}

export const EMPTY_TAKE_PAGE_STATE: TakePageState = {
  values: {},
  pageId: "",
  name: "",
};

/** The native input kind the declared control contract calls for. */
export function inputTypeFor(kind: ControlFieldKind): "text" | "number" | "color" | "checkbox" {
  switch (kind) {
    case "text":
    case "asset":
      return "text";
    case "number":
      return "number";
    case "color":
      return "color";
    case "boolean":
      return "checkbox";
  }
}

/**
 * The value an untouched form row displays.
 *
 * Defaults are authored on the declaration, so using one is deliberate rather
 * than a UI fallback. An absent default stays absent; Rust decides whether that
 * field can be applied when preview is requested.
 */
export function valueForField(field: ControlField, state: TakePageState): ControlValue | undefined {
  return state.values[field.fieldId] ?? field.default;
}

function describeValue(value: ControlValue | undefined): string {
  if (value === undefined) return "Unset";
  switch (value.type) {
    case "text":
    case "asset":
      return value.value;
    case "number":
      return String(value.value);
    case "boolean":
      return value.value ? "On" : "Off";
    case "color":
      return "Colour selected";
  }
}

/**
 * Build the complete operator form from the template's declared controls.
 *
 * No object property appears here unless the template declared it. The browser
 * only owns presentation; values are applied by Rust's `apply_control_values`.
 */
export function takePagePanel(document: SceneDocument, state: TakePageState): UiNode {
  const fields = document.controls.map((field) => ({
    id: `take-page/field/${field.fieldId}`,
    role: "gridcell" as const,
    label: field.label,
    description: `${field.kind} value for ${field.objectId}.${field.property}`,
    value: describeValue(valueForField(field, state)),
  }));

  return {
    id: "take-page",
    role: "region",
    label: "Take page",
    description:
      fields.length === 0
        ? "This template declares no operator fields"
        : `${fields.length} declared operator field${fields.length === 1 ? "" : "s"}`,
    children: [
      {
        id: "take-page/fields",
        role: "group",
        label: "Declared fields",
        children: fields,
      },
      ...(state.refusal === undefined
        ? []
        : [
            {
              id: "take-page/refusal",
              role: "alert" as const,
              label: "Take-page value refused",
              value: state.refusal,
            },
          ]),
    ],
  };
}
