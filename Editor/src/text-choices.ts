// The text choices of the Properties dock (plan row 11.132, Figma B3d Style card): Case, Align, Vertical align, Box, Writing mode, Fit and Overflow.
//
// Asked of Jev and Laya before it was written (docs/evidence/11.132/jev-laya-text-choices.json): each choice is one `setObjectField` over every
// selected TEXT object, one undoable command; a value the engine cannot draw yet stays in the list, dimmed with its reason and the plan row
// that will draw it; WHICH values the engine draws comes from Rust (`cmd_text_choices`, built by asking the drawability check itself), so
// nothing here names an engine fact; a selection whose objects differ shows Mixed and a choice sets every one; the choices are held values
// with no keyframe diamond.
//
// Alignment depends on the layout (centre and right are drawn for paragraph text only), so a value is offered only when, for every selected
// text object, every one of its choices would still be drawn under the layout it would then have. That rule reads only the surface.
//
// Each choice is a `UiNode` group whose options carry a `choose` action, so a person and an agent read the same options and the same
// reasons (invariant 27).

import type { SceneDocument, SceneEdit, SceneObject, TextChoiceField, TextChoices } from "@grapix/contracts";

import { isMixed, unify, type UiNode } from "./agent-surface";

export const CHOICES_NOT_READ = "the text choices have not been read from the engine";

type TextObject = Extract<SceneObject, { type: "text" }>;

/** A text object's current value of a choice, in the wire words. */
export function choiceValue(object: TextObject, field: string): string | undefined {
  switch (field) {
    case "textCase":
      return object.textCase;
    case "align":
      return object.align;
    case "verticalAlign":
      return object.verticalAlign;
    case "layout":
      return object.layout;
    case "writingMode":
      return object.writingMode;
    case "autoFit":
      return object.autoFit;
    case "overflow":
      return object.overflow;
    default:
      return undefined;
  }
}

const isText = (object: SceneObject): object is TextObject => object.type === "text";

/** The word a value is shown by. */
function labelOf(surface: TextChoices, field: string, value: string): string {
  return surface.fields.find((candidate) => candidate.field === field)?.values.find((candidate) => candidate.value === value)?.label ?? value;
}

/**
 * Why choosing `field = value` would leave a selected text object the engine cannot draw, or undefined when every one would be drawn.
 * The object's layout after the choice is `value` when the choice is the layout, else its own; every choice the object then has must be
 * drawn under that layout.
 */
export function choiceBlocker(surface: TextChoices, objects: readonly TextObject[], field: string, value: string): string | undefined {
  for (const object of objects) {
    const layout = field === "layout" ? value : object.layout;
    for (const choice of surface.fields) {
      const current = choice.field === field ? value : choiceValue(object, choice.field);
      const entry = choice.values.find((candidate) => candidate.value === current);
      if (entry === undefined || entry.drawnForLayouts.includes(layout)) continue;
      const row = entry.owner === undefined ? "" : `: row ${entry.owner} draws it`;
      const layoutWords = labelOf(surface, "layout", layout).toLowerCase();
      if (choice.field === field) {
        return entry.drawnForLayouts.length === 0
          ? `${entry.label} is not drawn by the engine yet${row}`
          : `${entry.label} is drawn for ${entry.drawnForLayouts.map((drawn) => labelOf(surface, "layout", drawn).toLowerCase()).join(" or ")} only, and ${object.name} would be ${layoutWords}${row}`;
      }
      return `${object.name} has ${choice.label} ${entry.label}, which is not drawn for ${layoutWords}${row}`;
    }
  }
  return undefined;
}

/** The kinds in the selection that are not text, for the reason a choice cannot be made. */
function otherKinds(selected: readonly SceneObject[]): string[] {
  return [...new Set(selected.filter((object) => !isText(object)).map((object) => object.type))];
}

/** One choice as a group of options. */
function choiceNode(surface: TextChoices | undefined, field: TextChoiceField, texts: readonly TextObject[], others: readonly string[]): UiNode {
  const shared = unify(texts.map((object) => choiceValue(object, field.field)));
  const current = shared === undefined || isMixed(shared) ? undefined : shared;
  const blockedForAll =
    surface === undefined
      ? CHOICES_NOT_READ
      : others.length > 0
        ? `${field.label} is a text choice: ${others.join(", ")} ${others.length === 1 ? "has" : "have"} none. Select only text`
        : undefined;
  return {
    id: `inspector/${field.field}`,
    role: "group",
    label: field.label,
    value: shared === undefined ? "" : isMixed(shared) ? "Mixed" : field.values.find((candidate) => candidate.value === current)?.label ?? String(current),
    ...(others.length > 0 ? { description: `not on ${others.join(", ")}` } : {}),
    children: field.values.map((option): UiNode => {
      const why =
        blockedForAll ??
        (option.value === current ? `already ${option.label}` : choiceBlocker(surface!, texts, field.field, option.value));
      return {
        id: `inspector/${field.field}/${option.value}`,
        role: "listitem",
        label: option.label,
        selected: option.value === current,
        actions: [{ name: "choose", label: option.label, ...(why === undefined ? {} : { unavailable: why }) }],
      };
    }),
  };
}

/** The text choices for the selection: none when it holds no text object. */
export function textChoiceNodes(document: SceneDocument, selectedIds: readonly string[], surface: TextChoices | undefined): UiNode[] {
  const selected = document.objects.filter((object) => selectedIds.includes(object.id));
  const texts = selected.filter(isText);
  if (texts.length === 0) return [];
  const others = otherKinds(selected);
  if (surface === undefined) {
    return [{ id: "inspector/text-choices", role: "status", label: "Text choices", value: CHOICES_NOT_READ }];
  }
  return surface.fields.map((field) => choiceNode(surface, field, texts, others));
}

/** The node id of an option, split into its choice and value: `inspector/align/center`. */
export function parseChoiceId(id: string): { readonly field: string; readonly value: string } | undefined {
  const match = /^inspector\/(textCase|align|verticalAlign|layout|writingMode|autoFit|overflow)\/([a-z-]+)$/.exec(id);
  if (match !== null) return { field: match[1]!, value: match[2]! };
  // A font is chosen by its id, which is the scene's own word (`inspector/fontId/font_a3c0...`).
  const font = /^inspector\/fontId\/([^/]+)$/.exec(id);
  return font === null ? undefined : { field: "fontId", value: font[1]! };
}

/** The one edit a choice sends: the field over every selected text object. */
export function choiceEdit(document: SceneDocument, selectedIds: readonly string[], field: string, value: string): SceneEdit {
  const objectIds = document.objects.filter((object) => selectedIds.includes(object.id) && isText(object)).map((object) => object.id);
  return { edit: "setObjectField", objectIds, field: { name: field, value } } as SceneEdit;
}


/** The choices drawn as dropdown fields (Figma B3d v2): the field shows the current value, the list opens on a click. */
export const CHOICE_FIELDS = ["fontId", "textCase", "align", "verticalAlign", "layout", "writingMode", "autoFit", "overflow"] as const;

/** Whether a Properties group is a text choice, by its node id. */
export function isChoiceGroup(id: string): boolean {
  // The text animator's Shape and Basis (11.61) are dropdowns drawn the same way.
  return id === "inspector/textAnimator/shape" || id === "inspector/textAnimator/basis" || (CHOICE_FIELDS as readonly string[]).some((field) => id === `inspector/${field}`);
}

/** The words the closed field shows: the value, Mixed, or a dash when nothing is set. */
export function choiceFieldWords(value: string): string {
  return value.trim() === "" ? "—" : value;
}

/**
 * The reason drawn under an option that cannot be chosen (Figma B3d: Small caps dimmed with its reason), or undefined. The option
 * already chosen says nothing more: it is the field's value.
 */
export function optionReason(unavailable: string | undefined, selected: boolean): string | undefined {
  if (unavailable === undefined || selected) return undefined;
  return unavailable;
}


/**
 * The Font row as a choice (Figma B3d v2: "Anybody", not an id): one option per font the scene holds, by its display name, the one in
 * use chosen. A font the scene cannot use now (switched off) is dimmed with that reason. Absent when the selection holds no text object.
 */
export function fontChoiceNode(document: SceneDocument, selectedIds: readonly string[]): UiNode[] {
  const selected = document.objects.filter((object) => selectedIds.includes(object.id));
  const texts = selected.filter(isText);
  if (texts.length === 0) return [];
  const others = otherKinds(selected);
  const shared = unify(texts.map((object) => object.fontId));
  const current = shared === undefined || isMixed(shared) ? undefined : shared;
  const nameOf = (fontId: string): string => document.fonts.find((font) => font.fontId === fontId)?.displayName ?? fontId;
  const blockedForAll = others.length > 0 ? `Font is a text choice: ${others.join(", ")} ${others.length === 1 ? "has" : "have"} none. Select only text` : undefined;
  return [
    {
      id: "inspector/fontId",
      role: "group",
      label: "Font",
      value: shared === undefined ? "" : isMixed(shared) ? "Mixed" : nameOf(String(current)),
      ...(others.length > 0 ? { description: `not on ${others.join(", ")}` } : {}),
      children: document.fonts.map((font): UiNode => {
        const why = blockedForAll ?? (font.fontId === current ? `already ${font.displayName}` : font.enabled ? undefined : `${font.displayName} is switched off in this scene`);
        return {
          id: `inspector/fontId/${font.fontId}`,
          role: "listitem",
          label: font.displayName,
          selected: font.fontId === current,
          actions: [{ name: "choose", label: font.displayName, ...(why === undefined ? {} : { unavailable: why }) }],
        };
      }),
    },
  ];
}
