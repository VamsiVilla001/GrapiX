// Effects & Presets and Effect Controls (build plan 11.69, 11.70).
//
// **The list is the contract's, not this file's.** The browser shows the effect
// surface Rust built (`gx_contracts::effect_catalog::effect_surface`):
// EffectCraft's whole catalogue in After Effects' categories, with the effects
// the GrapiX engine renders marked available. Nothing here names an effect, a
// parameter or a range; a catalogued effect that is not ported is offered as
// unavailable with its reason, never hidden and never pretended (invariant 18).
//
// **Effect Controls edits the stack as a value.** Every function below takes the
// object's effect stack and returns the next one (or a named refusal); the
// caller sends it as one `setEffects` edit, so each change is one undoable
// command and the validator that guards the engine guards the panel.
//
// A parameter's `path` is both the JSON path into the effect and the tail of
// its keyframe channel (`effects.<effectId>.<path>`); a Rust test pins that
// every path is the JSON path of its value.

import type {
  EffectInstance,
  EffectListing,
  EffectParameter,
  EffectSurface,
  PresetListing,
} from "@grapix/contracts";

import type { UiAction, UiNode } from "./agent-surface";

export type Refused = { readonly refused: string };
export function isRefused<T>(value: T | Refused): value is Refused {
  return typeof value === "object" && value !== null && "refused" in value;
}

/** The keyframe channel of an effect parameter. */
export function effectChannel(effectId: string, path: string): string {
  return `effects.${effectId}.${path}`;
}

// ---------------------------------------------------------------------------
// Reading and writing a parameter
// ---------------------------------------------------------------------------

type Json = Record<string, unknown> | unknown[];

function step(node: unknown, segment: string): unknown {
  if (Array.isArray(node)) return node[Number(segment)];
  if (typeof node === "object" && node !== null) return (node as Record<string, unknown>)[segment];
  return undefined;
}

/** The raw JSON value at a parameter's path, or `undefined` if the path names nothing. */
export function readParameter(instance: EffectInstance, path: string): unknown {
  return path.split(".").reduce<unknown>(step, instance);
}

/** The parameter as the table reads it: a number, a switch as 0 or 1, a choice as its index. */
export function parameterValue(instance: EffectInstance, parameter: EffectParameter): number | undefined {
  const raw = readParameter(instance, parameter.path);
  if (parameter.kind === "number") return typeof raw === "number" ? raw : undefined;
  if (parameter.kind === "switch") return typeof raw === "boolean" ? Number(raw) : undefined;
  const index = typeof raw === "string" ? parameter.options.indexOf(raw) : -1;
  return index < 0 ? undefined : index;
}

function writeAt(instance: EffectInstance, path: string, value: unknown): EffectInstance {
  const copy = structuredClone(instance) as unknown as Json;
  const segments = path.split(".");
  let node: unknown = copy;
  for (const segment of segments.slice(0, -1)) node = step(node, segment);
  const last = segments[segments.length - 1]!;
  if (Array.isArray(node)) node[Number(last)] = value;
  else (node as Record<string, unknown>)[last] = value;
  return copy as unknown as EffectInstance;
}

/** The listing whose template is this instance's effect, if the surface has one. */
export function listingFor(surface: EffectSurface, instance: EffectInstance): EffectListing | undefined {
  return surface.effects.find((listing) => listing.template?.effect === instance.effect);
}

// ---------------------------------------------------------------------------
// Stack edits: each returns the next stack or a named refusal
// ---------------------------------------------------------------------------

export type Stack = readonly EffectInstance[];

/** An id not yet used in the stack: the base, then `base-2`, `base-3`… */
export function freshEffectId(stack: Stack, base: string): string {
  const used = new Set(stack.map((instance) => instance.effectId));
  if (!used.has(base)) return base;
  for (let n = 2; ; n += 1) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Add a catalogued effect at its defaults, at the end of the stack. */
export function addEffect(stack: Stack, listing: EffectListing): Stack | Refused {
  if (!listing.available || listing.template === undefined) {
    return { refused: `${listing.name} is catalogued but not yet ported to the GrapiX engine` };
  }
  const instance = {
    effectId: freshEffectId(stack, listing.template.effect),
    enabled: true,
    ...structuredClone(listing.template),
  } as EffectInstance;
  return [...stack, instance];
}

/** The id prefix of EffectCraft's text animator presets (category "Text animators"): they are applied to a text, not added to a stack. */
export const TEXT_ANIMATOR_PRESET_PREFIX = "ec.textanimator.";

export function isTextAnimatorPreset(preset: PresetListing): boolean {
  return preset.id.startsWith(TEXT_ANIMATOR_PRESET_PREFIX);
}

/** The one scene edit that applies a text animator preset (11.61): the animator and its keys from `atFrame`, one undo. */
export interface TextAnimatorPresetEdit {
  readonly edit: "applyTextAnimatorPreset";
  readonly objectId: string;
  readonly presetId: string;
  readonly atFrame: number;
}

/**
 * The edit that applies a text animator preset to `object` at the playhead, or why not: a preset the engine cannot draw yet is refused by
 * the reason the listing gives, a target that is not a text by name, and a playhead that is not a whole frame from 0.
 */
export function textAnimatorPresetEdit(
  object: { readonly id: string; readonly name: string; readonly type: string },
  preset: PresetListing,
  atFrame: number,
): TextAnimatorPresetEdit | Refused {
  if (preset.unavailable !== undefined && preset.unavailable !== null) {
    return { refused: `${preset.name}: ${preset.unavailable}` };
  }
  if (object.type !== "text") {
    return { refused: `${preset.name} animates text: select a text object (${object.name} is ${object.type})` };
  }
  if (!Number.isInteger(atFrame) || atFrame < 0) {
    return { refused: `${preset.name} starts at a whole frame from 0, not ${atFrame}` };
  }
  return { edit: "applyTextAnimatorPreset", objectId: object.id, presetId: preset.id, atFrame };
}

/** Add a preset's effects, in order, each under a fresh id. */
export function addPreset(stack: Stack, preset: PresetListing): Stack | Refused {
  if (preset.unavailable !== undefined && preset.unavailable !== null) {
    return { refused: `${preset.name}: ${preset.unavailable}` };
  }
  if (isTextAnimatorPreset(preset)) {
    return { refused: `${preset.name} is a text animator: it is applied to a text, not added to the effect stack` };
  }
  if (preset.effects.length === 0) return { refused: `${preset.name} has no effects to add` };
  let next: Stack = stack;
  for (const effect of preset.effects) {
    next = [...next, { ...structuredClone(effect), effectId: freshEffectId(next, effect.effectId) }];
  }
  return next;
}

function indexOf(stack: Stack, effectId: string): number | Refused {
  const index = stack.findIndex((instance) => instance.effectId === effectId);
  return index < 0 ? { refused: `no effect ${effectId} on this object` } : index;
}

export function removeEffect(stack: Stack, effectId: string): Stack | Refused {
  const index = indexOf(stack, effectId);
  if (isRefused(index)) return index;
  return stack.filter((_, at) => at !== index);
}

/** Move an effect one place up (-1) or down (+1). The ends refuse by name. */
export function moveEffect(stack: Stack, effectId: string, by: -1 | 1): Stack | Refused {
  const index = indexOf(stack, effectId);
  if (isRefused(index)) return index;
  const to = index + by;
  if (to < 0) return { refused: `${effectId} is already first` };
  if (to >= stack.length) return { refused: `${effectId} is already last` };
  const next = [...stack];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

/** Copy an effect directly below itself, under a fresh id. */
export function duplicateEffect(stack: Stack, effectId: string): Stack | Refused {
  const index = indexOf(stack, effectId);
  if (isRefused(index)) return index;
  const copy = { ...structuredClone(stack[index]!), effectId: freshEffectId(stack, effectId) };
  return [...stack.slice(0, index + 1), copy, ...stack.slice(index + 1)];
}

export function setEnabled(stack: Stack, effectId: string, enabled: boolean): Stack | Refused {
  const index = indexOf(stack, effectId);
  if (isRefused(index)) return index;
  return stack.map((instance, at) => (at === index ? { ...instance, enabled } : instance));
}

/**
 * Set one parameter from what a control holds: a number field's text, a
 * checkbox's state, or a choice's option index. Out of range, not a number and
 * an unknown option are each refused by name, before anything is sent.
 */
export function setParameter(
  stack: Stack,
  effectId: string,
  parameter: EffectParameter,
  raw: string | number | boolean,
): Stack | Refused {
  const index = indexOf(stack, effectId);
  if (isRefused(index)) return index;
  let value: unknown;
  if (parameter.kind === "number") {
    const number = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
    if (!Number.isFinite(number)) return { refused: `${parameterLabel(parameter.path)} needs a number` };
    const { min, max } = parameter;
    if (min != null && max != null && (number < min || number > max)) {
      return { refused: `${parameterLabel(parameter.path)} must be between ${min} and ${max}` };
    }
    value = number;
  } else if (parameter.kind === "switch") {
    value = raw === true || raw === "true" || raw === 1;
  } else {
    const option = parameter.options[Number(raw)];
    if (option === undefined) return { refused: `${parameterLabel(parameter.path)} has no option ${String(raw)}` };
    value = option;
  }
  return stack.map((instance, at) => (at === index ? writeAt(instance, parameter.path, value) : instance));
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const UPPER = new Set(["rgb", "r", "g", "b", "a", "x", "y"]);

/** `rgb.inputBlack` reads "RGB · Input black"; `color.r` reads "Color · R". */
export function parameterLabel(path: string): string {
  return path
    .split(".")
    .map((segment) => {
      if (/^\d+$/.test(segment)) return `Point ${Number(segment) + 1}`;
      if (UPPER.has(segment)) return segment.toUpperCase();
      const words = segment.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
      return words.charAt(0).toUpperCase() + words.slice(1);
    })
    .join(" · ");
}

/** A wire value such as `horizontal-and-vertical` as a label. */
export function optionLabel(option: string): string {
  const words = option.replace(/-/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Effects & Presets: the browser
// ---------------------------------------------------------------------------

export interface BrowserInput {
  readonly surface: EffectSurface;
  readonly query: string;
  /** Why nothing can be applied right now (no object selected…), if so. */
  readonly targetBlocker?: string;
  /** The kind of the one selected object (`text`, `rect`…), so a text animator preset can say it needs a text. */
  readonly targetType?: string;
  /** Show effects that are catalogued but not yet ported. */
  readonly showUnported: boolean;
  /**
   * The category groups the author has opened, by group id. A category is shown
   * folded unless it is in this set, as After Effects' Effects & Presets tree is;
   * while a search is typed every category that has a match is open, so a result
   * is never hidden behind a fold.
   */
  readonly expanded?: ReadonlySet<string>;
}

/** The ids of a browser's category groups, in order: what Expand all opens. */
export function browserGroupIds(panel: UiNode): string[] {
  return (panel.children ?? []).filter((child) => child.role === "group").map((child) => child.id);
}

/** The open set with one category flipped. A new set: the caller's is never changed. */
export function toggleGroup(open: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(open);
  if (!next.delete(id)) next.add(id);
  return next;
}

function matches(query: string, ...fields: readonly string[]): boolean {
  const needle = query.trim().toLowerCase();
  return needle === "" || fields.some((field) => field.toLowerCase().includes(needle));
}

/** How many effects the engine renders, of how many are catalogued. */
export function availability(surface: EffectSurface): { readonly available: number; readonly total: number } {
  return { available: surface.effects.filter((effect) => effect.available).length, total: surface.effects.length };
}

export function effectsBrowserPanel(input: BrowserInput): UiNode {
  const { surface, query, targetBlocker, showUnported } = input;
  const { available, total } = availability(surface);

  const presetCategories = new Map<string, UiNode[]>();
  for (const preset of surface.presets) {
    if (!matches(query, preset.name, preset.category, preset.description, preset.source)) continue;
    const blocked = preset.unavailable ?? undefined;
    if (blocked !== undefined && !showUnported) continue;
    const needsText = isTextAnimatorPreset(preset) && input.targetType !== undefined && input.targetType !== "text";
    const action: UiAction = {
      name: "applyPreset",
      label: "Apply",
      ...(blocked !== undefined
        ? { unavailable: blocked }
        : targetBlocker !== undefined
          ? { unavailable: targetBlocker }
          : needsText
            ? { unavailable: "a text animator is applied to a text object: select one" }
            : {}),
    };
    const node: UiNode = {
      id: `preset/${preset.id}`,
      role: "listitem",
      label: preset.name,
      description: `${preset.description} (${preset.source})`,
      value: preset.name,
      actions: [action],
    };
    presetCategories.set(preset.category, [...(presetCategories.get(preset.category) ?? []), node]);
  }

  const effectCategories = new Map<string, { nodes: UiNode[]; usable: number; all: number }>();
  for (const effect of surface.effects) {
    const bucket = effectCategories.get(effect.category) ?? { nodes: [], usable: 0, all: 0 };
    effectCategories.set(effect.category, bucket);
    bucket.all += 1;
    if (effect.available) bucket.usable += 1;
    if (!matches(query, effect.name, effect.category, effect.id)) continue;
    if (!effect.available && !showUnported) continue;
    const action: UiAction = {
      name: "apply",
      label: "Apply",
      ...(!effect.available
        ? { unavailable: "catalogued from EffectCraft, not yet ported to the GrapiX engine (build plan 3.25)" }
        : targetBlocker !== undefined
          ? { unavailable: targetBlocker }
          : {}),
    };
    bucket.nodes.push({
      id: `effect/${effect.id}`,
      role: "listitem",
      label: effect.name,
      description: effect.available ? "renders on the GrapiX engine" : "not yet ported",
      value: effect.name,
      actions: [action],
    });
  }

  const searching = query.trim() !== "";
  const isOpen = (id: string): boolean => searching || (input.expanded?.has(id) ?? false);
  const groups: UiNode[] = [];
  for (const [category, nodes] of presetCategories) {
    groups.push({
      id: `effects-browser/presets/${slug(category)}`,
      role: "group",
      label: `Presets · ${category}`,
      description: `${nodes.length} preset(s)`,
      expanded: isOpen(`effects-browser/presets/${slug(category)}`),
      children: [{ id: `effects-browser/presets/${slug(category)}/list`, role: "list", label: `${category} presets`, children: nodes }],
    });
  }
  for (const [category, bucket] of effectCategories) {
    if (bucket.nodes.length === 0) continue;
    groups.push({
      id: `effects-browser/${slug(category)}`,
      role: "group",
      label: category,
      description: `${bucket.usable} of ${bucket.all} usable`,
      expanded: isOpen(`effects-browser/${slug(category)}`),
      children: [{ id: `effects-browser/${slug(category)}/list`, role: "list", label: `${category} effects`, children: bucket.nodes }],
    });
  }

  return {
    id: "effects-browser",
    role: "region",
    label: "Effects & Presets",
    description: `${available} of ${total} effects render on the GrapiX engine · ${surface.attribution}`,
    children:
      groups.length > 0
        ? groups
        : [{ id: "effects-browser/no-match", role: "status", label: "Effects & Presets", value: "No effects or presets match this search" }],
  };
}

// ---------------------------------------------------------------------------
// Effect Controls
// ---------------------------------------------------------------------------

export interface ControlsInput {
  readonly surface: EffectSurface;
  readonly objectName: string;
  readonly effects: Stack;
  /** Channels that already have keys, as `effects.<id>.<path>`. */
  readonly keyedChannels?: ReadonlySet<string>;
}

function parameterNode(instance: EffectInstance, parameter: EffectParameter, keyed: boolean): UiNode {
  const id = `fx/${instance.effectId}/${parameter.path}`;
  const label = parameterLabel(parameter.path);
  const key: UiAction = { name: "key", label: keyed ? "◆ Key" : "◇ Key" };
  const value = parameterValue(instance, parameter);
  if (parameter.kind === "choice") {
    const current = value ?? 0;
    return {
      id,
      role: "listitem",
      label,
      description: keyed ? "keyframed" : "not keyframed",
      value: `${label}: ${optionLabel(parameter.options[current] ?? "")}`,
      actions: [
        ...parameter.options.map((option, index): UiAction => ({
          name: `choose:${index}`,
          label: optionLabel(option),
          ...(index === current ? { unavailable: "the current option" } : {}),
        })),
        key,
      ],
    };
  }
  const range = parameter.min != null && parameter.max != null ? `${parameter.min} to ${parameter.max}` : undefined;
  return {
    id,
    role: "listitem",
    label,
    description: [range, keyed ? "keyframed" : undefined].filter((part) => part !== undefined).join(" · ") || "any number",
    value: label,
    input:
      parameter.kind === "switch"
        ? { type: "checkbox", value: String(value === 1) }
        : { type: "number", value: value === undefined ? "" : String(value) },
    actions: [{ name: "edit", label: "Edit" }, key],
  };
}

export function effectControlsPanel(input: ControlsInput): UiNode {
  const { surface, objectName, effects, keyedChannels } = input;
  const children: UiNode[] = effects.map((instance, index) => {
    const listing = listingFor(surface, instance);
    const name = listing?.name ?? instance.effect;
    const parameters = listing?.parameters ?? [];
    return {
      id: `fx/${instance.effectId}`,
      role: "group",
      label: name,
      description: `${instance.effectId} · ${instance.enabled ? "on" : "off"}`,
      expanded: true,
      actions: [
        { name: "toggle", label: instance.enabled ? "On" : "Off" },
        { name: "moveUp", label: "Up", ...(index === 0 ? { unavailable: "already first" } : {}) },
        { name: "moveDown", label: "Down", ...(index === effects.length - 1 ? { unavailable: "already last" } : {}) },
        { name: "duplicate", label: "Duplicate" },
        { name: "remove", label: "Remove" },
      ],
      children: [
        {
          id: `fx/${instance.effectId}/parameters`,
          role: "list",
          label: `${name} parameters`,
          children: parameters.map((parameter) =>
            parameterNode(instance, parameter, keyedChannels?.has(effectChannel(instance.effectId, parameter.path)) ?? false),
          ),
        },
      ],
    };
  });
  return {
    id: "effect-controls",
    role: "region",
    label: "Effect Controls",
    description: `${effects.length} effect(s) on ${objectName}`,
    children,
  };
}

/** Split a controls node id (`fx/<effectId>/<path>`) into its parts. */
export function parseControlId(id: string): { readonly effectId: string; readonly path?: string } | undefined {
  if (!id.startsWith("fx/")) return undefined;
  const rest = id.slice(3);
  const slash = rest.indexOf("/");
  if (slash < 0) return { effectId: rest };
  return { effectId: rest.slice(0, slash), path: rest.slice(slash + 1) };
}
