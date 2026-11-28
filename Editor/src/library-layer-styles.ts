// The Library's Layer styles tab (the new Figma UI, B13; plan row 11.122): named effect stacks kept in the project.
//
// Asked of Jev and Laya before it was written (docs/evidence/11.122/jev-laya-layer-styles.json): a library layer style is a named stack of the
// effects the engine renders (drop shadow, glow and the rest of the catalogue), kept with their settings; applying one to an object is a COPY, so
// editing or deleting a style never changes a graphic; it is made from the effects of the selected object; applying has two actions, Add to
// effects and Replace effects; a style keeps the effects, their order, their switches and their static settings, but not keyframes and not the
// limits to an object's own masks; deleting removes the style only; and because nothing links a graphic to the library, the card says how many
// objects of the OPEN graphic have exactly this stack now, and says that is what it counts.
//
// Everything is a `UiNode`, so a person and an agent read the same description (invariant 27).

import type { EffectInstance, LibraryLayerStyle, SceneDocument, SceneObject } from "@grapix/contracts";

import type { UiAction, UiNode } from "./agent-surface";
import { freshEffectId } from "./effects-panel";

export const STYLES_NEED_PROJECT = "Layer styles belong to a project. This graphic is not in one yet: save it into a project first.";
export const STYLES_NOTE =
  "Applying a style copies its effects into the object: nothing links the object to the library, so changing or deleting a style here never changes a graphic. A style keeps settings only: not keyframes, and not the limits an effect has to an object's masks.";
export const MOST_STYLE_EFFECTS = 32;

/** The effect stack an object carries now. */
export function effectsOf(object: SceneObject): readonly EffectInstance[] {
  return (object as { effects?: readonly EffectInstance[] }).effects ?? [];
}

/** What an effect says for itself when the catalogue's listing is not at hand: its wire tag as words (`drop-shadow` → `Drop shadow`). */
export function effectWords(instance: EffectInstance): string {
  const words = instance.effect.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The effects as a style keeps them: each with its own id and switch and its settings, not limited to a mask (a mask belongs to one object). */
export function keepable(effects: readonly EffectInstance[]): EffectInstance[] {
  return effects.map((instance) => {
    const { maskIds: _dropped, ...rest } = structuredClone(instance);
    return rest as EffectInstance;
  });
}

/** How many of these effects are limited to a mask, which a style cannot keep. */
export function maskLimits(effects: readonly EffectInstance[]): number {
  return effects.filter((instance) => (instance.maskIds ?? []).length > 0).length;
}

/** The stack given fresh ids on an object that already has these ids in use, in order. */
export function withFreshIds(onObject: readonly EffectInstance[], style: readonly EffectInstance[]): EffectInstance[] {
  let next: EffectInstance[] = [...onObject];
  for (const instance of style) next = [...next, { ...structuredClone(instance), effectId: freshEffectId(next, instance.effectId) }];
  return next.slice(onObject.length);
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

/** A stack's identity: the effects, their order, their switches and their settings; not the ids an object gave them and not mask limits. */
export function stackKey(effects: readonly EffectInstance[]): string {
  return canonical(keepable(effects).map(({ effectId: _id, ...rest }) => rest));
}

/** How many objects of the open graphic have exactly this stack now. */
export function styleUse(document: SceneDocument, effects: readonly EffectInstance[]): number {
  const wanted = stackKey(effects);
  return document.objects.filter((object) => effectsOf(object).length > 0 && stackKey(effectsOf(object)) === wanted).length;
}

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`;

function chosen(document: SceneDocument, ids: readonly string[]): SceneObject[] {
  return document.objects.filter((object) => ids.includes(object.id));
}

/** Why a style cannot be made from (or updated from) the selection, or undefined when it can: one object with 1 to 32 effects. */
export function fromEffectsBlocker(document: SceneDocument, ids: readonly string[]): string | undefined {
  const objects = chosen(document, ids);
  if (objects.length !== 1) return objects.length === 0 ? "select an object whose effects to keep" : "select one object: a style is made from one object's effects";
  const effects = effectsOf(objects[0]!);
  if (effects.length === 0) return `${objects[0]!.name} has no effects`;
  if (effects.length > MOST_STYLE_EFFECTS) return `${objects[0]!.name} has ${effects.length} effects: a style holds at most ${MOST_STYLE_EFFECTS}`;
  return undefined;
}

/** Why a style cannot be added to the selection, or undefined when it can. */
export function addBlocker(document: SceneDocument, ids: readonly string[]): string | undefined {
  return chosen(document, ids).length === 0 ? "select an object first" : undefined;
}

/** Why a style cannot replace the selection's effects, or undefined when it can: replacing would orphan the keyframes of the old effects. */
export function replaceBlocker(document: SceneDocument, ids: readonly string[]): string | undefined {
  const objects = chosen(document, ids);
  if (objects.length === 0) return "select an object first";
  for (const object of objects) {
    const keyed = document.timeline.channels.some((channel) => channel.objectId === object.id && channel.property.startsWith("effects."));
    if (keyed) return `${object.name}'s effects are keyframed: replacing them would orphan the keys. Remove the keys first, or use Add to effects`;
  }
  return undefined;
}

export interface LayerStylesState {
  /** The project's styles; absent until the shell has answered (or when the graphic is not in a project). */
  readonly styles?: readonly LibraryLayerStyle[];
  /** Why the project's styles could not be read. */
  readonly stylesProblem?: string;
  readonly selectedStyleId?: string;
  /** The objects selected in the open graphic, which the apply actions act on and New from effects reads. */
  readonly selectedObjectIds?: readonly string[];
  readonly project: boolean;
  /** An effect's catalogue name; the wire tag as words when absent. */
  readonly effectName?: (instance: EffectInstance) => string;
}

/** The Layer styles tab: the style cards, what can be done to make one, and the selected style's card. */
export function layerStylesNodes(document: SceneDocument, state: LayerStylesState): UiNode[] {
  const ids = state.selectedObjectIds ?? [];
  const name = state.effectName ?? effectWords;
  const unreadable = !state.project ? STYLES_NEED_PROJECT : state.styles === undefined ? "the project's layer styles have not been read" : undefined;
  const blocked = fromEffectsBlocker(document, ids);
  const makeActions: UiAction[] = [
    {
      name: "newStyleFromEffects",
      label: "+ From selected effects",
      ...(unreadable !== undefined ? { unavailable: unreadable } : blocked !== undefined ? { unavailable: blocked } : {}),
    },
  ];
  if (state.styles === undefined) {
    return [
      {
        id: "library/layer-styles",
        role: "list",
        label: "Layer styles",
        description: state.project ? (state.stylesProblem ?? "reading the project's layer styles…") : STYLES_NEED_PROJECT,
        children: [],
        actions: makeActions,
      },
    ];
  }
  const cards: UiNode[] = state.styles.map(
    (style): UiNode => ({
      id: `style/${style.id}`,
      role: "listitem",
      label: style.name,
      value: style.effects.map((instance) => `${name(instance)}${instance.enabled ? "" : " (off)"}`).join(" · "),
      selected: style.id === state.selectedStyleId,
      actions: [{ name: "layerStyle", label: `${style.name} · ${style.effects.map((instance) => `${name(instance)}${instance.enabled ? "" : " (off)"}`).join(", ")}` }],
    }),
  );
  const list: UiNode = {
    id: "library/layer-styles",
    role: "list",
    label: "Layer styles",
    description: state.styles.length === 0 ? "no layer styles yet: select an object with effects and make one from them" : plural(state.styles.length, "layer style"),
    children: cards,
    actions: makeActions,
  };
  const selected = state.styles.find((style) => style.id === state.selectedStyleId);
  return [
    list,
    selected === undefined
      ? { id: "library/layer-style-detail", role: "region", label: "Selected layer style", description: "Select a layer style to apply it, rename it or update it." }
      : detail(document, selected, ids, name, blocked),
  ];
}

function detail(document: SceneDocument, style: LibraryLayerStyle, ids: readonly string[], name: (instance: EffectInstance) => string, fromBlocked: string | undefined): UiNode {
  const uses = styleUse(document, style.effects);
  const addWhy = addBlocker(document, ids);
  const replaceWhy = replaceBlocker(document, ids);
  return {
    id: "library/layer-style-detail",
    role: "region",
    label: style.name,
    description: plural(style.effects.length, "effect"),
    actions: [
      { name: "addStyle", label: "Add to effects", ...(addWhy === undefined ? {} : { unavailable: addWhy }) },
      { name: "replaceStyle", label: "Replace effects", ...(replaceWhy === undefined ? {} : { unavailable: replaceWhy }) },
      { name: "updateStyle", label: "Update from selection", ...(fromBlocked === undefined ? {} : { unavailable: fromBlocked }) },
      { name: "renameStyle", label: "Rename…" },
      { name: "deleteStyle", label: "Delete" },
    ],
    children: [
      ...style.effects.map(
        (instance, index): UiNode => ({
          id: `style/${style.id}/effect/${index}`,
          role: "gridcell",
          label: name(instance),
          value: instance.enabled ? "on" : "off",
          description: instance.effectId,
        }),
      ),
      { id: `style/${style.id}/kept`, role: "gridcell", label: "Kept", value: "settings only", description: "Keyframes and the limits an effect has to an object's masks are not kept." },
      {
        id: `style/${style.id}/use`,
        role: "gridcell",
        label: "In this graphic",
        value: uses === 0 ? "no object has exactly this stack" : `${plural(uses, "object")} ${uses === 1 ? "has" : "have"} exactly this stack`,
        description: "Counts exact matches in the open graphic only: an applied style is a copy, not a link.",
      },
    ],
  };
}
