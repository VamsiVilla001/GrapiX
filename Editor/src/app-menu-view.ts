// Draws the application menu bar from the model in `app-menu.ts`. It only makes elements: every
// click is handled by the Editor's one document-level handler through the `data-*` attributes set
// here (`data-invoke`, `data-create-kind`, `data-focus-panel`, `data-native`), so a menu item runs
// the same path as the control it names and there is no second copy of any command.

import { actionOf, menuTitle, type Menu, type MenuCommand, type MenuNode } from "./app-menu";

export interface PanelEntry {
  readonly id: string;
  readonly label: string;
}

export interface RecentEntry {
  readonly gpx: string;
  readonly label: string;
  readonly detail: string;
  readonly missing: boolean;
}

export interface MenuViewOptions {
  /** The key in force for a command (the person's changes on top of the Editor's own); the menu model's own label when absent. */
  readonly shortcutLabel?: (command: string) => string | undefined;
  /** The Editor's dockable panels, for the Display menu's list of the ones the menu does not name. */
  readonly panels: readonly PanelEntry[];
  readonly loadRecent: () => Promise<readonly RecentEntry[]>;
  readonly openRecent: (gpx: string) => void;
}

/** The key a command shows beside it. The menu model's own label is the Editor's default; the page gives the key in force once the person has changed any (11.84). */
let shortcutLabelOf: ((command: string) => string | undefined) | undefined;

/** Set where the menu gets the key shown beside a command (`renderAppMenus` does it from its options); undefined is the menu model's own label. */
export function useShortcutLabels(labelOf: ((command: string) => string | undefined) | undefined): void {
  shortcutLabelOf = labelOf;
}

export function commandButton(command: MenuCommand): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.menuItem = command.id;
  button.dataset.evidence = command.evidence;
  button.title = menuTitle(command);
  const label = document.createElement("span");
  label.textContent = command.label;
  button.append(label);
  const shown = shortcutLabelOf === undefined ? command.shortcut : shortcutLabelOf(command.id);
  if (shown !== undefined) {
    const key = document.createElement("kbd");
    key.textContent = shown;
    button.append(key);
  }
  switch (actionOf(command)) {
    case "invoke":
      button.dataset.invoke = command.invoke;
      break;
    case "createKind":
      button.dataset.createKind = command.createKind;
      break;
    case "focusPanel":
      button.dataset.focusPanel = command.focusPanel;
      break;
    case "native":
      button.dataset.native = command.native;
      break;
    case "unbuilt":
      // Never a dead click: it says it is not built and which row builds it.
      button.disabled = true;
      button.dataset.row = command.row;
      break;
  }
  return button;
}

/** A group that opens in place under its parent, so it is never clipped by a scrolling menu. */
function group(label: string, title: string): { root: HTMLElement; body: HTMLElement; toggle: HTMLButtonElement } {
  const root = document.createElement("div");
  root.className = "menu-sub";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "menu-sub-toggle";
  toggle.setAttribute("aria-expanded", "false");
  toggle.title = title;
  const text = document.createElement("span");
  text.textContent = label;
  const arrow = document.createElement("span");
  arrow.className = "menu-sub-arrow";
  arrow.textContent = "▸";
  toggle.append(text, arrow);
  const body = document.createElement("div");
  body.className = "menu-sub-items";
  body.hidden = true;
  toggle.addEventListener("click", () => {
    const open = body.hidden;
    body.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    arrow.textContent = open ? "▾" : "▸";
  });
  root.append(toggle, body);
  return { root, body, toggle };
}

function nodes(items: readonly MenuNode[], options: MenuViewOptions, into: HTMLElement): void {
  for (const node of items) {
    switch (node.kind) {
      case "command":
        into.append(commandButton(node));
        break;
      case "separator": {
        const rule = document.createElement("div");
        rule.className = "menu-sep";
        rule.setAttribute("role", "separator");
        into.append(rule);
        break;
      }
      case "submenu": {
        const parts = group(node.label, "Opens in place");
        parts.root.dataset.menuItem = node.id;
        nodes(node.items, options, parts.body);
        into.append(parts.root);
        break;
      }
      case "recent": {
        const parts = group("Recent projects", "The projects opened lately.");
        parts.root.dataset.menuItem = "file.open-recent";
        let loaded = false;
        parts.toggle.addEventListener("click", () => {
          if (loaded || parts.body.hidden) return;
          loaded = true;
          void options.loadRecent().then(
            (recent) => {
              parts.body.replaceChildren();
              if (recent.length === 0) {
                const none = document.createElement("div");
                none.className = "menu-empty";
                none.textContent = "No project has been opened yet";
                parts.body.append(none);
              }
              for (const entry of recent) {
                const item = document.createElement("button");
                item.type = "button";
                item.className = "menu-recent";
                item.disabled = entry.missing;
                item.title = entry.missing ? `${entry.detail} (its .gpx is no longer there)` : entry.detail;
                item.textContent = entry.label;
                item.addEventListener("click", () => {
                  options.openRecent(entry.gpx);
                  for (const menu of document.querySelectorAll<HTMLDetailsElement>(".app-menu")) menu.open = false;
                });
                parts.body.append(item);
              }
            },
            () => {
              loaded = false;
              parts.body.replaceChildren();
              const failed = document.createElement("div");
              failed.className = "menu-empty";
              failed.textContent = "The recent list could not be read";
              parts.body.append(failed);
            },
          );
        });
        into.append(parts.root);
        break;
      }
      case "panels":
        for (const panel of options.panels) {
          if (node.except.includes(panel.id)) continue;
          const button = document.createElement("button");
          button.type = "button";
          button.dataset.focusPanel = panel.id;
          button.dataset.menuItem = `display.panel.${panel.id}`;
          button.dataset.evidence = "grapix";
          button.title = "GrapiX addition.";
          button.textContent = panel.label;
          into.append(button);
        }
        break;
    }
  }
}

/** Replace the bar's menus with the model's, before the workspace title. */
export function renderAppMenus(bar: HTMLElement, menus: readonly Menu[], options: MenuViewOptions): void {
  useShortcutLabels(options.shortcutLabel);
  for (const old of bar.querySelectorAll(".app-menu")) old.remove();
  const before = bar.querySelector(".workspace-title");
  for (const menu of menus) {
    const details = document.createElement("details");
    details.className = "app-menu";
    details.dataset.menu = menu.id;
    const summary = document.createElement("summary");
    summary.textContent = menu.label;
    const items = document.createElement("div");
    items.className = "menu-items";
    items.setAttribute("role", "menu");
    nodes(menu.items, options, items);
    details.append(summary, items);
    bar.insertBefore(details, before);
  }
}
