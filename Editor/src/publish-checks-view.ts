// Draws the Publish checks (publish-checks.ts) with plain DOM, using the document it is given so the page, a test and a
// harness can all call it. Nothing here calls the shell.

import { PUBLISH_NOTE, WHO_CAN_DO_WHAT, type CheckState, type PublishView } from "./publish-checks";

const STATE_WORD: Readonly<Record<CheckState, string>> = { ok: "OK", fix: "FIX", wait: "…", idle: "—" };

function node(document: Document, tag: string, className: string, text?: string): HTMLElement {
  const created = document.createElement(tag);
  created.className = className;
  if (text !== undefined) created.textContent = text;
  return created;
}

function field(document: Document, label: string, value: string): HTMLElement {
  const line = node(document, "div", "card-row publish-field");
  line.append(node(document, "span", "card-label", label), node(document, "span", "key-card-value", value));
  return line;
}

/** The checks, the chips and the package card, as DOM. */
export function renderPublishChecks(document: Document, view: PublishView): HTMLElement {
  const root = node(document, "div", "publish-checks");

  const chips = node(document, "div", "publish-chips");
  for (const chip of view.chips) {
    const element = node(document, "span", "chip", chip.text);
    element.dataset.tone = chip.tone;
    chips.append(element);
  }

  const heading = node(document, "h3", "card-title", "Checks for Playout");
  root.append(node(document, "div", "card-head", view.title), chips, heading);

  const list = node(document, "div", "publish-check-list");
  for (const row of view.rows) {
    const line = node(document, "div", "publish-check");
    line.dataset.check = row.id;
    line.dataset.state = row.state;
    const state = node(document, "span", "chip", STATE_WORD[row.state]);
    state.dataset.tone = row.state === "ok" ? "ok" : row.state === "fix" ? "warn" : "neutral";
    line.append(state, node(document, "span", "publish-check-label", row.label), node(document, "span", "publish-check-text", row.text));
    list.append(line);
    // The Test row is the one a designer runs: its button is the Data screen's (`checkRecords`), and the report is shared.
    if (row.id === "test" && row.state !== "wait") {
      const button = node(document, "button", "publish-check-run", "Check records") as HTMLButtonElement;
      button.type = "button";
      button.dataset.action = "checkRecords";
      button.dataset.for = "data/records";
      list.append(button);
    }
    if (row.details.length > 0) {
      const details = node(document, "ul", "publish-check-details");
      for (const detail of row.details) details.append(node(document, "li", "publish-check-detail", detail));
      list.append(details);
    }
  }
  root.append(list, node(document, "p", "panel-note publish-note", PUBLISH_NOTE));

  const contains = node(document, "section", "card-section publish-contains");
  contains.append(node(document, "h3", "card-title", "Contains"));
  for (const item of view.contents) contains.append(field(document, item.label, item.value));
  const who = node(document, "section", "card-section publish-who");
  who.append(node(document, "h3", "card-title", "Who can do what"));
  for (const item of WHO_CAN_DO_WHAT) who.append(field(document, item.label, item.value));
  root.append(contains, who);
  return root;
}
