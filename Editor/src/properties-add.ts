// The Add row at the foot of Properties (Figma B3d v2, "Properties, one list"; Jev, 26 Nov 2026,
// docs/evidence/figma-ui/jev-laya-properties-sections.json). Pivot, Masks and Effect Controls are sections of Properties that appear
// when the element has them; this row is how the person gives it one. Each button takes an existing path: + Effect opens Effects &
// Presets, + Mask puts the Pen in mask mode, Pivot picks the Pivot tool. Each is dimmed with its reason when nothing is selected.

export type AddKind = "effect" | "mask" | "pivot";

export interface AddButton {
  readonly kind: AddKind;
  readonly label: string;
  readonly hint: string;
}

export const ADD_ROW: readonly AddButton[] = [
  { kind: "effect", label: "+ Effect", hint: "Open Effects & Presets to add an effect to the selected elements" },
  { kind: "mask", label: "+ Mask", hint: "Draw a mask on the selected layer: the Pen in mask mode" },
  { kind: "pivot", label: "Pivot", hint: "Move the selected element's pivot: the Pivot tool" },
];

/** Why the row cannot be used now, or undefined. */
export function addRowBlocker(selectedCount: number): string | undefined {
  return selectedCount === 0 ? "Select an element first" : undefined;
}
