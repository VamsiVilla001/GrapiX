// Named text-style panel (build plan 11.28).
//
// Styles are reusable bundles, not a second design-system store. This panel
// only describes available actions; the Rust contract resolves token values at
// apply time, when the project design system is actually in scope.

import type { SceneDocument, SceneObject, TextStyle } from "@grapix/contracts";

import type { UiNode } from "./agent-surface";

export interface TextStyleState {
  readonly selectedStyleId?: string;
  /// The document selection is supplied by the workspace owner. A style can
  /// apply to every selected object, and Rust names any non-text refusal.
  readonly selectedObjectIds?: readonly string[];
}

/** Object ids whose current properties equal every literal property declared
 * by the style. Token references deliberately do not reverse-match a concrete
 * value: that would guess which brand token produced it and create a second
 * token resolver in the web layer. */
export function textStyleUsers(document: SceneDocument, styleId: string): string[] {
  const style = document.textStyles.find((candidate) => candidate.styleId === styleId);
  if (!style) return [];
  return document.objects
    .filter((object): object is Extract<SceneObject, { type: "text" }> => object.type === "text")
    .filter((object) => matchesStyle(object, style))
    .map((object) => object.id);
}

function matchesStyle(object: Extract<SceneObject, { type: "text" }>, style: TextStyle): boolean {
  if (object.fontId !== style.fontId || object.size !== literalNumber(style.size)) return false;
  if (object.textCase !== style.textCase) return false;
  if (style.lineHeight !== null && style.lineHeight !== undefined) {
    if (object.lineHeight !== literalNumber(style.lineHeight)) return false;
  }
  if (style.letterSpacing !== null && style.letterSpacing !== undefined) {
    if (object.letterSpacing !== literalNumber(style.letterSpacing)) return false;
  }
  if (style.strokeWidth !== null && style.strokeWidth !== undefined) {
    if (object.strokeWidth !== literalNumber(style.strokeWidth)) return false;
  }
  if (style.fill !== null && style.fill !== undefined && !sameLiteralColor(object.fill, style.fill)) {
    return false;
  }
  if (style.stroke !== null && style.stroke !== undefined && !sameLiteralColor(object.stroke, style.stroke)) {
    return false;
  }
  return true;
}

function literalNumber(value: TextStyle["size"]): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function sameLiteralColor(
  current: Extract<SceneObject, { type: "text" }>["fill"],
  style: NonNullable<TextStyle["fill"]>,
): boolean {
  // A string is a TokenRef. It has no value without the active project system,
  // which belongs to Rust, so it never claims a reverse match here.
  return typeof style !== "string" && JSON.stringify(current) === JSON.stringify(style);
}


/** The accessible text-style panel, used by the DOM and agent surface alike. */
export function textStylePanel(
  document: SceneDocument,
  state: TextStyleState = {},
): UiNode {
  const selection = state.selectedObjectIds ?? [];
  const selectedTextCount = document.objects.filter(
    (object) => selection.includes(object.id) && object.type === "text",
  ).length;
  const applyUnavailable =
    selection.length === 0
      ? "select one or more objects to apply a style"
      : selectedTextCount !== selection.length
        ? "the selection includes a non-text object; applying would be refused"
        : undefined;
  const saveUnavailable =
    selection.length !== 1
      ? "select exactly one text object to save its current properties"
      : selectedTextCount !== 1
        ? "the selected object is not text"
        : undefined;

  const styles: UiNode[] = document.textStyles.map((style) => {
    const users = textStyleUsers(document, style.styleId);
    const size = typeof style.size === "number" ? `${style.size}` : `{${style.size}}`;
    return {
      id: `text-style/${style.styleId}`,
      role: "listitem",
      label: style.name,
      description: `${style.fontId} · ${size} · ${style.textCase}`,
      selected: state.selectedStyleId === style.styleId,
      actions: [
        { name: "apply", label: "Apply to selection", ...(applyUnavailable ? { unavailable: applyUnavailable } : {}) },
        { name: "reveal", label: "Show usage" },
      ],
      children: [
        {
          id: `text-style/${style.styleId}/usage`,
          role: "gridcell",
          label: "Used by",
          value: users.length === 0 ? "nothing" : users.join(", "),
        },
      ],
    };
  });

  return {
    id: "text-styles",
    role: "region",
    label: "Text styles",
    description: `${document.textStyles.length} style(s) in ${document.name}`,
    actions: [
      {
        name: "save",
        label: "Save selected text as style",
        ...(saveUnavailable ? { unavailable: saveUnavailable } : {}),
      },
    ],
    children: [{ id: "text-styles/list", role: "list", label: "Styles", children: styles }],
  };
}
