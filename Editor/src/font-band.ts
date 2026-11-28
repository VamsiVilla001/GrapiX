// The band over the viewport when a font cannot be used (the new Figma UI, S2; plan row 11.67).
//
// An unresolved font is a take blocker (invariant 29): the graphic would go to air in another typeface while every check reports success.
// So the band says which font cannot be used and that Publish is blocked, and offers the two ways out: choose another font, or find the
// file. The design's band also says "Manrope Bold is shown instead; widths may differ". That sentence is NOT used: the font manager's rule
// is that a missing font is never silently replaced, so the band does not claim a replacement is on screen (Figma conflict C-15).

import type { FontStatus } from "./font-manager";

export interface BandFont {
  readonly fontId: string;
  readonly displayName: string;
  readonly status: FontStatus;
}

export interface FontBand {
  readonly message: string;
  /** The font the Locate button looks for first. */
  readonly firstFontId: string;
}

/** The most font names the band spells out. */
export const MOST_NAMED = 3;

function names(fonts: readonly BandFont[]): string {
  const shown = fonts.slice(0, MOST_NAMED).map((font) => font.displayName);
  const rest = fonts.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

/** What the band says, or `undefined` when no font blocks. */
export function fontBand(blocking: readonly BandFont[]): FontBand | undefined {
  const first = blocking[0];
  if (first === undefined) return undefined;
  const allMissing = blocking.every((font) => font.status === "missing");
  const message =
    blocking.length === 1
      ? allMissing
        ? `Font "${first.displayName}" is missing on this computer.`
        : `Font "${first.displayName}" cannot be used on this computer (${first.status}).`
      : `${blocking.length} fonts ${allMissing ? "are missing" : "cannot be used"} on this computer: ${names(blocking)}.`;
  return { message: `${message} Publish is blocked.`, firstFontId: first.fontId };
}
