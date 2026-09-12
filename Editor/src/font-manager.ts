// The font manager panel (build plan 11.13).
//
// The step says **"Ported, not redesigned"**, so this is deliberately plain:
// family, faces, fallbacks, embedding policy, and which objects use it. The
// 1.x panel earned its shape; reinventing it here would cost the familiarity
// that is the only reason to port rather than rebuild.
//
// **An unresolved font is a take blocker** (invariant 29 — the same rule as a
// missing asset). Both platforms will substitute a system face if allowed to,
// and the result is a graphic that goes to air in the wrong typeface while
// every check reports success. That is the silent visual substitution
// invariant 18 exists to prevent, so an unresolved font raises a blocking
// alert and anything that would publish says the font's name as its reason.

import type { SceneDocument, SceneObject } from "@grapix/contracts";

import type { UiNode } from "./agent-surface";

export interface FontManagerState {
  /// Fonts the resolver has not produced a face for. Supplied by the caller,
  /// because resolution is the font subsystem's answer, not this panel's
  /// guess — inferring it from an empty `faces` array would be exactly the
  /// kind of inference invariant 18 forbids.
  readonly unresolvedFontIds?: readonly string[];
  readonly selectedFontId?: string;
}

/// The object ids that reference a font, in document order.
export function fontUsers(document: SceneDocument, fontId: string): string[] {
  return document.objects.filter((object) => usesFont(object, fontId)).map((object) => object.id);
}

function usesFont(object: SceneObject, fontId: string): boolean {
  return object.type === "text" && object.fontId === fontId;
}

export function fontManagerPanel(
  document: SceneDocument,
  state: FontManagerState = {},
): UiNode {
  const unresolved = new Set(state.unresolvedFontIds ?? []);

  const items: UiNode[] = document.fonts.map((font) => {
    const users = fontUsers(document, font.fontId);
    const blocked = unresolved.has(font.fontId);

    return {
      id: `font/${font.fontId}`,
      role: "listitem",
      label: font.displayName,
      description: blocked
        ? `${font.family} — not resolved`
        : `${font.family} · ${font.faces.length} face(s)`,
      selected: state.selectedFontId === font.fontId,
      value: font.embeddingPolicy,
      actions: [
        { name: "reveal", label: "Show usage" },
        {
          name: "replace",
          label: "Replace",
        },
      ],
      children: [
        {
          id: `font/${font.fontId}/usage`,
          role: "gridcell",
          label: "Used by",
          value: users.length === 0 ? "nothing" : users.join(", "),
        },
        {
          id: `font/${font.fontId}/fallbacks`,
          role: "gridcell",
          label: "Fallbacks",
          value: font.fallbackFamilies.join(", ") || "none",
        },
      ],
    };
  });

  const blocking = document.fonts.filter((font) => unresolved.has(font.fontId));

  const children: UiNode[] = [];
  if (blocking.length > 0) {
    // An alert, not a status. A take blocker must interrupt: the cost of
    // missing it is a graphic on air in the wrong typeface.
    children.push({
      id: "font-manager/blocked",
      role: "alert",
      label: "Unresolved fonts block the take",
      value: blocking.map((font) => font.displayName).join(", "),
    });
  }
  children.push({ id: "font-manager/list", role: "list", label: "Fonts", children: items });

  const blockedReason =
    blocking.length > 0
      ? `unresolved font(s): ${blocking.map((font) => font.displayName).join(", ")}`
      : undefined;

  return {
    id: "font-manager",
    role: "region",
    label: "Fonts",
    description: `${document.fonts.length} font(s) in ${document.name}`,
    actions: [
      {
        name: "publish",
        label: "Publish",
        // The name travels in the refusal so the author knows which font to
        // fix, rather than being told only that something is wrong.
        ...(blockedReason === undefined ? {} : { unavailable: blockedReason }),
      },
    ],
    children,
  };
}
