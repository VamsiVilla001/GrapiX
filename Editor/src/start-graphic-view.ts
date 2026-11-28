// Draws the Start card (start-graphic.ts) with plain DOM, using the document it is given so the page and a test can both call it.
// Nothing here calls the shell: a tile or a row reports what was chosen and the page does it.

import type { StartView, TileAction } from "./start-graphic";

export interface StartHandlers {
  /** A working tile was chosen. */
  readonly tile: (action: TileAction) => void;
  /** A listed graphic was chosen. */
  readonly open: (sceneId: string) => void;
}

function node(document: Document, tag: string, className: string, text?: string): HTMLElement {
  const created = document.createElement(tag);
  created.className = className;
  if (text !== undefined) created.textContent = text;
  return created;
}

function field(document: Document, label: string, value: string): HTMLElement {
  const line = node(document, "div", "card-row start-field");
  line.append(node(document, "span", "card-label", label), node(document, "span", "key-card-value", value));
  return line;
}

/** The two panels of the Start screen, as DOM. */
export function renderStartCard(document: Document, view: StartView, handlers: StartHandlers): HTMLElement {
  const root = node(document, "div", "start-card");

  const start = node(document, "section", "start-panel");
  start.append(node(document, "h3", "start-heading", view.title));
  const tiles = node(document, "div", "start-tiles");
  for (const tile of view.tiles) {
    const button = document.createElement("button") as HTMLButtonElement;
    button.type = "button";
    button.className = tile.id === "blank" ? "start-tile start-tile-current" : "start-tile";
    button.dataset.tile = tile.id;
    button.append(node(document, "span", "start-tile-title", tile.title), node(document, "span", "start-tile-body", tile.body));
    if (tile.action === undefined) {
      // Waits for a row: shown, not offered, and says which row and why.
      button.disabled = true;
      button.setAttribute("aria-disabled", "true");
      button.title = tile.waitsOn?.words ?? "";
      button.dataset.waitsOn = tile.waitsOn?.row ?? "";
    } else {
      const action = tile.action;
      button.title = tile.hint ?? "";
      button.addEventListener("click", () => handlers.tile(action));
    }
    tiles.append(button);
  }
  start.append(tiles, field(document, "Format", view.format), node(document, "p", "panel-note start-note", view.note));

  const list = node(document, "section", "start-panel");
  list.append(node(document, "h3", "start-heading", view.listTitle));
  if (view.empty !== undefined) list.append(node(document, "p", "panel-note start-empty", view.empty));
  const rows = node(document, "div", "start-rows");
  for (const row of view.rows) {
    const line = document.createElement("button") as HTMLButtonElement;
    line.type = "button";
    line.className = "start-row-graphic";
    line.dataset.scene = row.sceneId;
    line.append(node(document, "span", "start-row-name", row.name));
    const chip = node(document, "span", "chip", row.chip.text);
    chip.dataset.tone = row.chip.tone;
    line.append(chip);
    if (row.openable) {
      line.addEventListener("click", () => handlers.open(row.sceneId));
    } else {
      line.disabled = true;
      line.setAttribute("aria-disabled", "true");
      line.title = row.detail;
    }
    rows.append(line);
  }
  list.append(rows);
  if (view.rows.length > 0) list.append(node(document, "p", "panel-note start-note", view.listNote));

  root.append(start, list);
  return root;
}
