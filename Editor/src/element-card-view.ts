// Draws the selected element's card (element-card.ts) with plain DOM, using the document it is given so the page and a test or a harness
// can all call it.

import type { ElementCard } from "./element-card";

/** What the card area shows when there is no single element: nothing, or several. */
export function cardPlaceholder(selectedCount: number): string {
  return selectedCount === 0 ? "Select an element to see its style, motion and data." : `${selectedCount} elements are selected. Select one to see its card.`;
}

/** How many warnings the card draws before it points at the Data screen for the rest. */
export const MOST_NOTES = 3;

export interface CardHandlers {
  /** The Motion block's "Open Timeline" button. */
  readonly openTimeline: () => void;
  /** The Data block's "Open Data" button: the Data screen. */
  readonly openData: () => void;
  /** A Data block button: Auto-fit or Hide when empty, to the value it is not now. */
  readonly setAction: (action: "auto-fit" | "hide-when-empty", on: boolean) => void;
}

function element(document: Document, tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The card as DOM: a heading, then Style, Motion and Data, each a short list of label and value. */
export function renderCard(document: Document, card: ElementCard, handlers: CardHandlers): HTMLElement {
  const root = element(document, "div", "card");
  root.append(element(document, "div", "card-head", `Selected element · ${card.name}`));
  for (const section of card.sections) {
    const block = element(document, "section", `card-section card-${section.id}`);
    block.append(element(document, "h3", "card-title", section.title));
    for (const row of section.rows) {
      const line = element(document, "div", "card-row");
      line.append(element(document, "span", "card-label", row.label), element(document, "span", "card-value", row.value));
      if (section.id === "motion" && row.label === "Keyframes" && row.value !== "0") {
        const open = element(document, "button", "card-link", "Open Timeline") as HTMLButtonElement;
        open.type = "button";
        open.addEventListener("click", handlers.openTimeline);
        line.append(open);
      }
      block.append(line);
    }
    if (section.rows.length === 0 && section.empty !== undefined) block.append(element(document, "p", "card-empty", section.empty));
    for (const note of section.notes?.slice(0, MOST_NOTES) ?? []) block.append(element(document, "p", "card-warning", note));
    if ((section.notes?.length ?? 0) > MOST_NOTES) block.append(element(document, "p", "card-warning", `${section.notes!.length - MOST_NOTES} more in the Data screen`));
    if (section.actions !== undefined && section.actions.length > 0) {
      const row = element(document, "div", "card-actions");
      for (const action of section.actions) {
        const button = element(document, "button", action.pressed ? "card-toggle on" : "card-toggle", action.label) as HTMLButtonElement;
        button.type = "button";
        button.setAttribute("aria-pressed", String(action.pressed));
        if (action.unavailable !== undefined) {
          button.disabled = true;
          button.title = action.unavailable;
          button.setAttribute("data-unavailable", action.unavailable);
        }
        button.addEventListener("click", () => handlers.setAction(action.id, !action.pressed));
        row.append(button);
      }
      block.append(row);
    }
    if (section.id === "data") {
      const open = element(document, "button", "card-link", "Open Data") as HTMLButtonElement;
      open.type = "button";
      open.addEventListener("click", handlers.openData);
      block.append(open);
    }
    root.append(block);
  }
  return root;
}

/** A card area with nothing to show. */
export function renderPlaceholder(document: Document, selectedCount: number): HTMLElement {
  return element(document, "p", "card-empty", cardPlaceholder(selectedCount));
}
