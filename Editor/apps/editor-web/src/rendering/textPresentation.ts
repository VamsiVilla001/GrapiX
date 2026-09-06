/**
 * How text is drawn, as opposed to what it says.
 *
 * A design tool applies case at draw time and leaves the characters alone: a layer typed "mvp" with
 * Figma's `textCase: UPPER` reads MVP on the canvas and still holds "mvp". Keeping that separation is
 * what lets a data binding replace the string and keep the case, and lets an author switch the case
 * off and get their own capitalisation back.
 *
 * Pure string work, so it holds for both renderers and is testable without a canvas.
 */

import type { TextSceneObject } from "@grapix/shared-types";

/**
 * The string as it should appear.
 *
 * `small-caps` has no equivalent in a browser text engine without a font that carries the feature, so
 * it draws as upper case — an approximation the importer reports rather than one that pretends.
 */
export function applyTextCase(text: string, textCase: TextSceneObject["textCase"]): string {
  switch (textCase) {
    case "upper":
    case "small-caps":
      return text.toLocaleUpperCase();
    case "lower":
      return text.toLocaleLowerCase();
    case "title":
      // Word-initial letters only. The rest keeps the author's casing, so "GG vs T1" survives, and
      // the boundary set includes quotes and brackets because a title can start inside one.
      return text.replace(
        /(^|[\s\u00a0"'(\[{])(\p{L})/gu,
        (_match, lead: string, letter: string) => lead + letter.toLocaleUpperCase()
      );
    default:
      return text;
  }
}

/**
 * True when the text carries a rule that has to be drawn beside the glyphs.
 *
 * A type predicate, so a caller that has checked does not then have to re-check each field: the
 * decoration is known to be there once this is true.
 */
export function hasTextDecoration(
  decoration: TextSceneObject["textDecoration"]
): decoration is NonNullable<TextSceneObject["textDecoration"]> {
  return Boolean(decoration?.underline || decoration?.strikethrough);
}
