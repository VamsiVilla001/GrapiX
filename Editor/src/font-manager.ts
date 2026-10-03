// The font manager panel (build plan 11.13).
//
// The step says **"Ported, not redesigned"**, so this is deliberately plain:
// family, faces, fallbacks, embedding policy, licence, and which objects use
// it. The 1.x panel earned its shape; reinventing it here would cost the
// familiarity that is the only reason to port rather than rebuild. Like 1.x it
// can ingest font files and font links, and remove a font definition.
//
// **An unresolved font is a take blocker** (invariant 29 — the same rule as a
// missing asset). Both platforms will substitute a system face if allowed to,
// and the result is a graphic that goes to air in the wrong typeface while
// every check reports success. That is the silent visual substitution
// invariant 18 exists to prevent, so an unresolved font raises a blocking
// alert and anything that would publish says the font's name as its reason.
//
// **A font leaves the scene only through Remove, and never while in use.**
// Removing a font a text object or text style still names would put that text
// on air in a fallback face. The panel's Remove says who uses it, and
// `planFontRemoval` returns the same sentence as a refusal. Neither edits the
// document: removal is one Editor command (invariant 60), so its undo entry and
// its authoritative in-use check live with the command executor; this module
// reports the intent.

import type { FontDefinition, SceneDocument, SceneObject } from "@grapix/contracts";

import type { UiNode } from "./agent-surface";

/// File types the ingest picker offers — the four containers the font
/// subsystem verifies. The bytes' magic, not the extension, decides.
export const FONT_FILE_ACCEPT = ".otf,.ttf,.woff,.woff2";

export interface FontManagerState {
  /// Fonts the resolver has not produced a face for. Supplied by the caller,
  /// because resolution is the font subsystem's answer, not this panel's
  /// guess — inferring it from an empty `faces` array would be exactly the
  /// kind of inference invariant 18 forbids.
  readonly unresolvedFontIds?: readonly string[];
  readonly selectedFontId?: string;
  /// An ingest is in flight; a second one would race the first's batch.
  readonly ingesting?: boolean;
  /// The last ingest or removal outcome, shown as a status line.
  readonly notice?: string;
}

/// The object ids that reference a font, in document order.
export function fontUsers(document: SceneDocument, fontId: string): string[] {
  return document.objects.filter((object) => usesFont(object, fontId)).map((object) => object.id);
}

function usesFont(object: SceneObject, fontId: string): boolean {
  return object.type === "text" && object.fontId === fontId;
}

/// Everything in a scene that names a font: text objects and text styles.
export interface FontUsage {
  readonly objects: readonly { readonly id: string; readonly name: string }[];
  readonly textStyles: readonly { readonly styleId: string; readonly name: string }[];
}

export function fontUsage(document: SceneDocument, fontId: string): FontUsage {
  return {
    objects: document.objects
      .filter((object) => usesFont(object, fontId))
      .map((object) => ({ id: object.id, name: object.name })),
    textStyles: document.textStyles
      .filter((style) => style.fontId === fontId)
      .map((style) => ({ styleId: style.styleId, name: style.name })),
  };
}

/// The sentence that refuses removing a font in use, naming each user, or
/// `undefined` when nothing uses it.
export function fontInUseReason(document: SceneDocument, font: FontDefinition): string | undefined {
  const usage = fontUsage(document, font.fontId);
  const parts: string[] = [];
  if (usage.objects.length > 0) {
    parts.push(
      `text object(s) ${usage.objects.map((object) => `${object.name} (${object.id})`).join(", ")}`,
    );
  }
  if (usage.textStyles.length > 0) {
    parts.push(`text style(s) ${usage.textStyles.map((style) => style.name).join(", ")}`);
  }
  return parts.length === 0 ? undefined : `${font.displayName} is used by ${parts.join("; ")}`;
}

/// What an explicit Remove asks the command executor to do: drop this font
/// definition and the font asset entries no other font's faces reference.
export interface FontRemovalPlan {
  readonly fontId: string;
  readonly displayName: string;
  readonly assetIds: readonly string[];
}

/// Why a removal was not planned. `code` is stable for a caller to branch on;
/// `refused` is the sentence shown to the author — the panel's own reason.
export interface FontRemovalRefused {
  readonly code: "fontUnknown" | "fontInUse";
  readonly refused: string;
}

export function isFontRemovalRefused(
  outcome: FontRemovalPlan | FontRemovalRefused,
): outcome is FontRemovalRefused {
  return "refused" in outcome;
}

/// Plan the explicit removal of one font without changing the document.
export function planFontRemoval(
  document: SceneDocument,
  fontId: string,
): FontRemovalPlan | FontRemovalRefused {
  const font = document.fonts.find((candidate) => candidate.fontId === fontId);
  if (!font) {
    return { code: "fontUnknown", refused: `no font ${fontId} in ${document.name}` };
  }
  const inUse = fontInUseReason(document, font);
  if (inUse !== undefined) return { code: "fontInUse", refused: inUse };

  // A font's own assets, minus any another font's faces also stand on.
  const ownAssets = new Set<string>();
  for (const face of font.faces) {
    if (face.source.kind === "file") ownAssets.add(face.source.assetId);
  }
  for (const other of document.fonts) {
    if (other.fontId === fontId) continue;
    for (const face of other.faces) {
      if (face.source.kind === "file") ownAssets.delete(face.source.assetId);
    }
  }
  const assetIds = document.assets
    .filter((asset) => asset.kind === "font" && ownAssets.has(asset.assetId))
    .map((asset) => asset.assetId);
  return { fontId, displayName: font.displayName, assetIds };
}

export function fontManagerPanel(
  document: SceneDocument,
  state: FontManagerState = {},
): UiNode {
  const unresolved = new Set(state.unresolvedFontIds ?? []);
  const ingestBusy = state.ingesting ? { unavailable: "a font ingest is already running" } : {};

  const items: UiNode[] = document.fonts.map((font) => {
    const users = fontUsers(document, font.fontId);
    const blocked = unresolved.has(font.fontId);
    const inUse = fontInUseReason(document, font);

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
        {
          name: "remove",
          label: "Remove",
          ...(inUse === undefined ? {} : { unavailable: inUse }),
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
        {
          // p2-licensing-positions §5: the font manager surfaces the licence.
          id: `font/${font.fontId}/licence`,
          role: "gridcell",
          label: "Licence",
          value: font.license ?? "none recorded",
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
  if (state.notice !== undefined) {
    children.push({
      id: "font-manager/notice",
      role: "status",
      label: "Font manager",
      value: state.notice,
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
      { name: "ingestFiles", label: "Add font files", ...ingestBusy },
      { name: "ingestLink", label: "Add font link", ...ingestBusy },
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
