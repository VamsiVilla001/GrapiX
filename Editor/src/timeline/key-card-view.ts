// Draws the keyframe card (key-card.ts) with plain DOM, using the document it is given so the page, a test and a harness can all call it.
// Every change a person makes is handed to a handler; nothing here sends an edit.

import { BEZIER_PRESETS, EASING_LABEL, unitSuffix, type ActiveEase, type KeyCard } from "./key-card";

export interface KeyCardHandlers {
  /** The Frame field was changed to this whole number. */
  readonly frame: (frame: number) => void;
  /** A Value field was changed; `shown` is in the field's unit. */
  readonly value: (property: string, shown: number) => void;
  /** Ease in or Ease out was typed, in percent. */
  readonly influence: (side: "in" | "out", percent: number) => void;
  /** The Over time select chose one of the contract's named easings. */
  readonly easing: (easing: string) => void;
  readonly action: (action: ActiveEase | "graph") => void;
}

/** The named easings the select offers. A custom curve is made by the graph or by the Ease buttons, not chosen by name. */
export const NAMED_EASINGS: readonly string[] = ["linear", "hold", "ease-in", "ease-out", "ease-in-out", "bounce", "elastic"];

export const HINT =
  "Every property has a keyframe diamond. Click it to start keyframing that property; with Auto-key on, changing a value at the playhead adds a keyframe. Select keyframes and press F9 for Ease, or use the buttons above the timeline.";

function node(document: Document, tag: string, className: string, text?: string): HTMLElement {
  const created = document.createElement(tag);
  created.className = className;
  if (text !== undefined) created.textContent = text;
  return created;
}

const heading = (document: Document, text: string): HTMLElement => node(document, "h3", "card-title", text);

function row(document: Document, label: string, field: HTMLElement): HTMLElement {
  const line = node(document, "div", "card-row key-card-row");
  line.append(node(document, "span", "card-label", label), field);
  return line;
}

function numberField(document: Document, label: string, value: number, suffix: string, integer: boolean, commit: (value: number) => void): HTMLElement {
  const wrap = node(document, "span", "key-card-field");
  const input = document.createElement("input") as HTMLInputElement;
  input.type = "number";
  input.className = "key-card-input";
  input.value = String(value);
  input.step = integer ? "1" : "any";
  input.setAttribute("aria-label", suffix === "" ? label : `${label} (${suffix})`);
  input.addEventListener("change", () => {
    const typed = input.value.trim() === "" ? Number.NaN : Number(input.value);
    if (Number.isFinite(typed)) commit(typed);
    // A value that is not a number puts the old one back rather than leaving the field lying.
    else input.value = String(value);
  });
  wrap.append(input);
  if (suffix !== "") wrap.append(node(document, "span", "key-card-suffix", suffix));
  return wrap;
}

/** An influence field: a number in percent, or a dash when that side has no curve to edit (nothing to type into). */
function influenceField(document: Document, label: string, percent: number | undefined, commit: (percent: number) => void): HTMLElement {
  if (percent === undefined) return node(document, "span", "key-card-value", "—");
  return numberField(document, label, percent, "%", false, commit);
}

/** The card as DOM. */
export function renderKeyCard(document: Document, card: KeyCard, handlers: KeyCardHandlers): HTMLElement {
  const root = node(document, "div", "card key-card");
  root.append(node(document, "div", "card-head", card.title));

  const moment = card.moment;
  if (moment === undefined) {
    const block = node(document, "section", "card-section");
    if (card.summary !== undefined) block.append(node(document, "p", "card-empty", card.summary));
    root.append(block, easeButtons(document, card.active, handlers));
    return root;
  }

  const time = node(document, "section", "card-section key-section-time");
  time.append(heading(document, "Time"), row(document, "Frame", numberField(document, "Frame", moment.frame, "", true, handlers.frame)));
  const frameLine = node(document, "span", "key-card-note", moment.frameText);
  time.append(frameLine);

  const values = node(document, "section", "card-section key-section-value");
  values.append(heading(document, "Value"));
  for (const value of moment.values) {
    values.append(row(document, value.label, numberField(document, value.label, value.shown, unitSuffix(value.property), false, (typed) => handlers.value(value.property, typed))));
  }

  const interpolation = node(document, "section", "card-section key-section-interpolation");
  interpolation.append(heading(document, "Interpolation"));
  const select = document.createElement("select") as HTMLSelectElement;
  select.className = "key-card-select";
  select.setAttribute("aria-label", "Over time");
  // The current curve is shown even when it is not one to choose by name (Ease from F9, a custom curve, a mix).
  const named = NAMED_EASINGS.includes(moment.easing);
  const current = document.createElement("option") as HTMLOptionElement;
  current.value = "";
  current.textContent = moment.overTime;
  current.disabled = true;
  if (!named && !Object.values(BEZIER_PRESETS).some((preset) => preset.label === moment.overTime)) select.append(current);
  for (const easing of NAMED_EASINGS) {
    const option = document.createElement("option") as HTMLOptionElement;
    option.value = easing;
    option.textContent = EASING_LABEL[easing] ?? easing;
    select.append(option);
  }
  // Presets that are one bezier (Back): chosen from the same list, written as a custom curve.
  const presetOf = Object.entries(BEZIER_PRESETS).find(([, preset]) => preset.label === moment.overTime)?.[0];
  for (const [id, preset] of Object.entries(BEZIER_PRESETS)) {
    const option = document.createElement("option") as HTMLOptionElement;
    option.value = `preset:${id}`;
    option.textContent = preset.label;
    select.append(option);
  }
  select.value = named ? moment.easing : presetOf === undefined ? "" : `preset:${presetOf}`;
  select.addEventListener("change", () => {
    if (select.value !== "") handlers.easing(select.value);
  });
  interpolation.append(
    row(document, "Over time", select),
    row(document, "Ease in", influenceField(document, "Ease in", moment.influence.in, (typed) => handlers.influence("in", typed))),
    row(document, "Ease out", influenceField(document, "Ease out", moment.influence.out, (typed) => handlers.influence("out", typed))),
    easeButtons(document, card.active, handlers),
  );

  const element = node(document, "section", "card-section key-section-element");
  element.append(heading(document, "Element · Name"));
  for (const [column, label, text] of [
    ["parent", "Parent", moment.element.parent.label],
    ["blend", "Blend", moment.element.blend.label],
    ["matte", "Matte", moment.element.matte.label],
  ] as const) {
    const cell = document.createElement("button") as HTMLButtonElement;
    cell.type = "button";
    cell.className = "key-card-cell";
    cell.dataset.layerColumn = column;
    cell.dataset.objectId = moment.objectId;
    cell.textContent = text;
    cell.setAttribute("aria-label", `${label}: ${text}`);
    cell.setAttribute("aria-haspopup", "menu");
    element.append(row(document, label, cell));
  }

  root.append(time, values, interpolation, element, node(document, "p", "key-card-hint", HINT));
  return root;
}

function easeButtons(document: Document, active: ActiveEase | undefined, handlers: KeyCardHandlers): HTMLElement {
  const group = node(document, "div", "key-card-buttons");
  for (const [action, label] of [["linear", "Linear"], ["ease", "Ease"], ["hold", "Hold"], ["graph", "Open graph"]] as const) {
    const button = document.createElement("button") as HTMLButtonElement;
    button.type = "button";
    button.className = action === "graph" ? "ghost" : action === active ? "primary" : "";
    button.textContent = label;
    button.dataset.keyAction = action;
    if (action !== "graph") button.setAttribute("aria-pressed", String(action === active));
    button.addEventListener("click", () => handlers.action(action));
    group.append(button);
  }
  return group;
}
