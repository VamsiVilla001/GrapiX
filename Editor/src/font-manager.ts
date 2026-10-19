// The font manager panel (build plan 11.13).
//
// The step says **"Ported, not redesigned"**: this follows the 1.x
// `FontManagerPanel` on the archive branch. Each font shows its load status,
// a sample line in its own face, its faces, source, fallbacks, licence and
// users; the list can be searched and filtered by status; a font is assigned
// to the selected text, replaced or removed; files and links (Google Fonts,
// CSS, Adobe Fonts, a direct file URL) are ingested with an optional family,
// display name and licence. The 1.x panel earned its shape; reinventing it here
// would cost the familiarity that is the only reason to port rather than
// rebuild.
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

import type { FontDefinition, FontLoadStatus, SceneDocument, SceneObject } from "@grapix/contracts";

import type { UiNode } from "./agent-surface";

/// File types the ingest picker offers — the four containers the font
/// subsystem verifies. The bytes' magic, not the extension, decides.
export const FONT_FILE_ACCEPT = ".otf,.ttf,.woff,.woff2";

/// The line 1.x previewed every family with: Latin, Arabic, Devanagari and
/// figures, so a face without one of those scripts shows it at a glance.
export const FONT_SAMPLE = "Ag مرحبا नमस्ते 0123";

/// A font's load state as the panel shows it (1.x's status badge). `loading`
/// until the registry has answered for it; `disabled` for a font switched off.
export type FontStatus =
  | "ready"
  | "loading"
  | "missing"
  | "invalid"
  | "unsupported"
  | "unverified"
  | "error"
  | "disabled";

export type FontStatusFilter = "all" | FontStatus;

/// The status filter's choices, in 1.x's order.
export const FONT_STATUS_FILTERS: readonly FontStatusFilter[] = [
  "all",
  "loading",
  "ready",
  "missing",
  "invalid",
  "unsupported",
  "unverified",
  "error",
  "disabled",
];

/// One face the registry could not load, and why.
export interface FontProblem {
  readonly fontId: string;
  readonly faceId: string;
  readonly status: FontLoadStatus;
  readonly reason: string;
}

export interface FontManagerState {
  /// Fonts the resolver has not produced a face for. Supplied by the caller,
  /// because resolution is the font subsystem's answer, not this panel's
  /// guess — inferring it from an empty `faces` array would be exactly the
  /// kind of inference invariant 18 forbids.
  readonly unresolvedFontIds?: readonly string[];
  /// The registry's last answer: fonts whose every face loaded, and each
  /// face that did not. Absent until the first registration has finished.
  readonly readyFontIds?: readonly string[];
  readonly problems?: readonly FontProblem[];
  readonly selectedFontId?: string;
  /// The objects Assign would give the font to.
  readonly selectedObjectIds?: readonly string[];
  /// Narrow the list by name, family or source, and by status (1.x filters).
  readonly search?: string;
  readonly statusFilter?: FontStatusFilter;
  /// An ingest is in flight; a second one would race the first's batch.
  readonly ingesting?: boolean;
  /// The last ingest or removal outcome, shown as a status line.
  readonly notice?: string;
}

/// The most fallback families a font may list (the 1.x cap; Rust's
/// `MAX_FALLBACK_FAMILIES` holds the same number).
export const MAX_FALLBACK_FAMILIES = 12;

/// The fields the panel edits on a font, as one `updateFont` edit carries them.
export interface FontPatch {
  readonly displayName?: string;
  readonly fallbackFamilies?: readonly string[];
  readonly enabled?: boolean;
}

/// The families typed into the fallbacks box. Commas separate; an empty slot
/// between commas is not a family. Repeats are kept, for the edit to refuse.
export function parseFallbackFamilies(text: string): string[] {
  return text
    .split(",")
    .map((family) => family.trim())
    .filter((family) => family !== "");
}

/// Why a font update was not sent. `code` names the refusal Rust would give
/// (`unchanged` is its "changes nothing"); `refused` is the panel's sentence.
export interface FontUpdateRefused {
  readonly code: "fontUnknown" | "fontInUse" | "invalidFontData" | "unchanged";
  readonly refused: string;
}

/// Check a font update the way Rust's `update_font` will (invariant 27), so
/// the panel refuses with the same reason before asking. `undefined` means
/// the edit may be sent.
export function fontUpdateRefused(
  document: SceneDocument,
  fontId: string,
  patch: FontPatch,
): FontUpdateRefused | undefined {
  const font = document.fonts.find((candidate) => candidate.fontId === fontId);
  if (!font) return { code: "fontUnknown", refused: `no font ${fontId} in ${document.name}` };
  const invalid = (refused: string): FontUpdateRefused => ({ code: "invalidFontData", refused });
  if (patch.displayName !== undefined && patch.displayName.trim() === "") {
    return invalid(`${font.displayName} needs a display name`);
  }
  if (patch.fallbackFamilies !== undefined) {
    if (patch.fallbackFamilies.length > MAX_FALLBACK_FAMILIES) {
      return invalid(
        `${font.displayName} lists ${patch.fallbackFamilies.length} fallback families; at most ${MAX_FALLBACK_FAMILIES}`,
      );
    }
    const seen = new Set<string>();
    for (const family of patch.fallbackFamilies) {
      const key = family.trim().toLowerCase();
      if (key === "") return invalid(`${font.displayName} lists a blank fallback family`);
      if (seen.has(key)) return invalid(`${font.displayName} lists fallback ${family.trim()} twice`);
      seen.add(key);
    }
  }
  if (patch.enabled === false) {
    const inUse = fontInUseReason(document, font);
    if (inUse !== undefined) return { code: "fontInUse", refused: `${inUse}, so it cannot be disabled` };
  }
  const unchanged =
    (patch.displayName === undefined || patch.displayName.trim() === font.displayName) &&
    (patch.fallbackFamilies === undefined ||
      patch.fallbackFamilies.map((family) => family.trim()).join("\u0000") === font.fallbackFamilies.join("\u0000")) &&
    (patch.enabled === undefined || patch.enabled === font.enabled);
  return unchanged ? { code: "unchanged", refused: `nothing about ${font.displayName} would change` } : undefined;
}

/// A font's status and, when it failed, every failed face's reason.
export function fontStatus(
  font: FontDefinition,
  state: FontManagerState,
): { readonly status: FontStatus; readonly problem?: string } {
  if (!font.enabled) return { status: "disabled" };
  const failed = (state.problems ?? []).filter((problem) => problem.fontId === font.fontId);
  if (failed.length > 0) {
    return {
      status: failed[0]!.status.toLowerCase() as FontStatus,
      problem: failed.map((problem) => problem.reason).join("; "),
    };
  }
  if ((state.unresolvedFontIds ?? []).includes(font.fontId)) {
    return { status: "missing", problem: "the font did not resolve" };
  }
  return { status: (state.readyFontIds ?? []).includes(font.fontId) ? "ready" : "loading" };
}

function matchesFilter(font: FontDefinition, status: FontStatus, state: FontManagerState): boolean {
  const filter = state.statusFilter ?? "all";
  if (filter !== "all" && filter !== status) return false;
  const search = (state.search ?? "").trim().toLowerCase();
  return `${font.displayName} ${font.family} ${font.sourceLabel ?? ""}`.toLowerCase().includes(search);
}

/// The text objects Assign would change: the selected ones not already on
/// this font. Empty when Assign is unavailable.
export function fontAssignTargets(
  document: SceneDocument,
  font: FontDefinition,
  state: FontManagerState,
): string[] {
  return fontAssignUnavailable(document, font, state) === undefined
    ? selectedObjects(document, state)
        .filter((object) => object.type === "text" && object.fontId !== font.fontId)
        .map((object) => object.id)
    : [];
}

function selectedObjects(document: SceneDocument, state: FontManagerState): SceneObject[] {
  const ids = new Set(state.selectedObjectIds ?? []);
  return document.objects.filter((object) => ids.has(object.id));
}

/// Why the font cannot be assigned to the selection now, or `undefined`.
export function fontAssignUnavailable(
  document: SceneDocument,
  font: FontDefinition,
  state: FontManagerState,
): string | undefined {
  const objects = selectedObjects(document, state);
  if (objects.length === 0) return "select a text object to assign this font to";
  const notText = objects.filter((object) => object.type !== "text");
  if (notText.length > 0) {
    return `only text takes a font; the selection also holds ${notText
      .map((object) => `${object.name} (${object.id})`)
      .join(", ")}`;
  }
  const { status } = fontStatus(font, state);
  if (status === "disabled") return `${font.displayName} is disabled`;
  if (status !== "ready") return `${font.displayName} is not ready (${status})`;
  if (objects.every((object) => object.type === "text" && object.fontId === font.fontId)) {
    return `the selected text already uses ${font.displayName}`;
  }
  return undefined;
}

/// Where a font link comes from (1.x's source tabs, files aside).
export type FontLinkSource = "google" | "css" | "adobe" | "direct";

export const FONT_LINK_SOURCES: readonly {
  readonly source: FontLinkSource;
  readonly label: string;
  readonly placeholder: string;
}[] = [
  { source: "google", label: "Google Fonts", placeholder: "Family name or Google Fonts CSS URL" },
  { source: "css", label: "CSS / @import", placeholder: "Stylesheet URL, <link href=…>, or @import url(…)" },
  { source: "adobe", label: "Adobe Fonts", placeholder: "Adobe project ID or https://use.typekit.net/…" },
  { source: "direct", label: "Direct URL", placeholder: "https://example.com/font.woff2" },
];

/// Turn what the author typed under a chosen source into the one link the
/// shell resolves, or say why it is not that source. The shell reads any
/// input without a scheme as an Adobe kit id, so a Google family name must
/// become its stylesheet URL here, and a URL is passed on unchanged for the
/// shell's policy to judge (a credential in an Adobe URL is refused there,
/// never stripped here).
export function fontLinkFor(
  source: FontLinkSource,
  typed: string,
): { readonly link: string } | { readonly refused: string } {
  const value = typed.trim();
  if (value === "") return { refused: "enter a font link first" };
  const url = extractCssUrl(value);
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(url);
  switch (source) {
    case "google":
      if (!isUrl) {
        return {
          link: `https://fonts.googleapis.com/css2?family=${encodeURIComponent(value).replace(/%20/g, "+")}&display=swap`,
        };
      }
      return hostOf(url) === "fonts.googleapis.com"
        ? { link: url }
        : { refused: `${url} is not a Google Fonts stylesheet; choose CSS / @import or Direct URL for it` };
    case "css":
      return isUrl ? { link: url } : { refused: `${value} is not a stylesheet URL` };
    case "adobe":
      if (isUrl) {
        return hostOf(url) === "use.typekit.net"
          ? { link: url }
          : { refused: `${url} is not an Adobe Fonts kit; Adobe serves kits from use.typekit.net` };
      }
      return /^[a-z0-9]+$/i.test(value)
        ? { link: value }
        : { refused: `${value} is not an Adobe Fonts project id` };
    case "direct":
      return isUrl && /\.(?:ttf|otf|woff2?)$/i.test(pathOf(url))
        ? { link: url }
        : { refused: `${value} is not the URL of a .ttf, .otf, .woff or .woff2 file` };
  }
}

/// The URL inside `<link href=…>` or `@import url(…)`, or the input itself.
function extractCssUrl(value: string): string {
  return value.match(/(?:href\s*=\s*|url\(\s*)["']?([^"')\s>]+)["']?/i)?.[1] ?? value;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

/// The author's optional names for an ingest (1.x's family override and
/// display name), applied to every font the batch prepared. The family is the
/// face's CSS family too, since that is the name the browser registers.
export function withIngestNames(
  fonts: readonly FontDefinition[],
  names: { readonly family?: string; readonly displayName?: string },
): FontDefinition[] {
  const family = names.family?.trim() ?? "";
  const displayName = names.displayName?.trim() ?? "";
  return fonts.map((font) => ({
    ...font,
    ...(family === ""
      ? {}
      : { family, faces: font.faces.map((face) => ({ ...face, family })) }),
    ...(displayName === "" ? {} : { displayName }),
  }));
}

function facesSummary(font: FontDefinition): string {
  return font.faces
    .map((face) => `${face.weight} ${face.style}${face.stretch && face.stretch !== "normal" ? ` ${face.stretch}` : ""}`)
    .join(" · ");
}

function sourceSummary(font: FontDefinition): string {
  const kinds = [...new Set(font.faces.map((face) => face.source.kind))];
  return font.sourceLabel ?? `${kinds.join(", ")} · ${font.embeddingPolicy}`;
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

  const shown = document.fonts.flatMap((font) => {
    const status = fontStatus(font, state);
    return matchesFilter(font, status.status, state) ? [{ font, ...status }] : [];
  });
  const items: UiNode[] = shown.map(({ font, status, problem }) => {
    const users = fontUsers(document, font.fontId);
    const inUse = fontInUseReason(document, font);
    const assign = fontAssignUnavailable(document, font, state);

    return {
      id: `font/${font.fontId}`,
      role: "listitem",
      label: font.displayName,
      description:
        problem === undefined
          ? `${font.family} · ${font.faces.length} face(s) · ${status}`
          : `${font.family} — not resolved (${status})`,
      selected: state.selectedFontId === font.fontId,
      value: font.embeddingPolicy,
      actions: [
        { name: "assign", label: "Assign", ...(assign === undefined ? {} : { unavailable: assign }) },
        { name: "reveal", label: "Show usage" },
        // Replace keeps the id, so text and styles stay on the font.
        { name: "replace", label: "Replace", ...ingestBusy },
        {
          name: "remove",
          label: "Remove",
          ...(inUse === undefined ? {} : { unavailable: inUse }),
        },
      ],
      children: [
        {
          // A font in use cannot be switched off: its text would go to air
          // in a fallback face. Switching it back on is always allowed.
          id: `font/${font.fontId}/enabled`,
          role: "gridcell",
          label: "Enabled",
          value: font.enabled ? "on" : "off",
          input: { type: "checkbox", value: String(font.enabled) },
          actions: [
            {
              name: "edit",
              label: "Enabled",
              ...(font.enabled && inUse !== undefined ? { unavailable: `${inUse}, so it cannot be disabled` } : {}),
            },
          ],
        },
        {
          id: `font/${font.fontId}/displayName`,
          role: "gridcell",
          label: "Display name",
          value: font.displayName,
          input: { type: "text", value: font.displayName },
          actions: [{ name: "edit", label: "Display name" }],
        },
        { id: `font/${font.fontId}/status`, role: "gridcell", label: "Status", value: status },
        // Drawn in the font's own face once it is ready (see main.ts).
        { id: `font/${font.fontId}/sample`, role: "gridcell", label: "Sample", value: FONT_SAMPLE },
        ...(problem === undefined
          ? []
          : [{ id: `font/${font.fontId}/problem`, role: "gridcell" as const, label: "Problem", value: problem }]),
        { id: `font/${font.fontId}/faces`, role: "gridcell", label: "Faces", value: facesSummary(font) },
        { id: `font/${font.fontId}/source`, role: "gridcell", label: "Source", value: sourceSummary(font) },
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
          input: { type: "text", value: font.fallbackFamilies.join(", ") },
          actions: [{ name: "edit", label: "Fallbacks" }],
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
  if (document.fonts.length > 0 && shown.length === 0) {
    children.push({ id: "font-manager/no-match", role: "status", label: "Font filter", value: "No fonts match this filter" });
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
    description:
      shown.length === document.fonts.length
        ? `${document.fonts.length} font(s) in ${document.name}`
        : `${document.fonts.length} font(s) in ${document.name}, ${shown.length} shown`,
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
