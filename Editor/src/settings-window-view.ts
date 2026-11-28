// The Settings window's body as DOM (plan row 11.81, Figma E4): a left nav of pages and the page beside it. It uses the document it is
// given, so the page, a test and a harness can all call it, and it calls no shell.
//
// General is not drawn here: it is the Editor's own twenty settings in their two sections (main.ts), and this file only gives it an
// element to draw into (`general`), so the settings behave exactly as they did before the nav existed. Shortcuts is drawn from the
// command registry, and with a `keys` host (plan row 11.84) a key can be changed, added, taken off and put back. A page that is not built
// is listed, dimmed, and when chosen says what it waits for and which row builds it.

import type { Shortcut } from "./command-registry";
import { MOST_KEYS_PER_COMMAND, recordKey, type EffectiveKeys } from "./keymap";
import { DEFAULT_SETTINGS_PAGE, SETTINGS_PAGES, resolvePage, waitingLine, type SettingsPage, type SettingsPageId } from "./settings-pages";
import { SHOW_FILTERS, filterShortcuts, shortcutRows, shortcutSummary, showRows, type ShortcutRow, type ShowFilter } from "./settings-shortcuts";

/** What asking for a key came to, as the page tells the person. */
export type KeyOutcome =
  | { readonly kind: "done" }
  | { readonly kind: "clash"; readonly key: string; readonly holder: string }
  | { readonly kind: "refused"; readonly reason: string };

/** What changes a key: the Editor's own code (main.ts) keeps the setting, so the page only asks. Each call resolves when the setting is saved and the
 *  keys in force have been updated. */
export interface KeysHost {
  /** Every command that can be given a key, in the menus' order. */
  readonly commands: readonly string[];
  /** The keys in force now. */
  state(): EffectiveKeys;
  assign(command: string, key: string, mode: "replace" | "add", take: boolean): Promise<KeyOutcome>;
  remove(command: string, key: string): Promise<void>;
  reset(command: string): Promise<void>;
  resetAll(): Promise<void>;
}

export interface SettingsWindowOptions {
  /** The Editor's key table (`SHORTCUTS`), used when there is no `keys` host (a read-only page). */
  readonly shortcuts: readonly Shortcut[];
  /** What the menu calls a command (`commandById(id)?.label`). */
  readonly labelOf: (command: string) => string | undefined;
  /** What changes a key. Without it the Shortcuts page only lists them. */
  readonly keys?: KeysHost;
  /** The page shown first; General when absent. */
  readonly initial?: SettingsPageId;
  /** Called each time a page is shown (and once at the start), so what belongs to one page only, such as General's two reset buttons,
   *  can be shown with it and hidden with the others. */
  readonly onShow?: (id: SettingsPageId) => void;
}

export interface SettingsWindow {
  /** The element the General page's settings are drawn into. It is the same element for the life of the window. */
  readonly general: HTMLElement;
  /** Show a page. An id that is not a page shows General. Returns the id shown. */
  show(id: string): SettingsPageId;
  /** The page shown now. */
  readonly current: SettingsPageId;
  /** The keys in force changed (a setting was saved, or reread): draw the Shortcuts page again. */
  keysChanged(): void;
  /** Stop waiting for a key to be pressed, if the page is (the window was closed, or another page was chosen). */
  cancelRecording(): void;
}

function node(document: Document, tag: string, className: string, text?: string): HTMLElement {
  const created = document.createElement(tag);
  created.className = className;
  if (text !== undefined) created.textContent = text;
  return created;
}

function button(document: Document, className: string, text: string, onClick: () => void, options: { readonly label?: string; readonly disabled?: string } = {}): HTMLElement {
  const created = node(document, "button", className, text);
  (created as HTMLButtonElement).type = "button";
  if (options.label !== undefined) created.setAttribute("aria-label", options.label);
  if (options.disabled !== undefined) {
    (created as HTMLButtonElement).disabled = true;
    created.setAttribute("title", options.disabled);
  } else {
    created.addEventListener("click", onClick);
  }
  return created;
}

/** The Shortcuts page's moving parts: what is being recorded, and what the page has to say about it. */
interface KeyState {
  recording?: { readonly command: string; readonly mode: "replace" | "add" };
  notice?: { readonly command: string; readonly text: string; readonly clash?: { readonly key: string; readonly holder: string; readonly mode: "replace" | "add" } };
}

interface ShortcutsPage {
  readonly element: HTMLElement;
  readonly redraw: () => void;
  readonly cancel: () => void;
}

/** The Shortcuts page: a note, a search box, the table and a line under it; with a `keys` host, buttons to change them. */
function shortcutsPage(document: Document, options: SettingsWindowOptions): ShortcutsPage {
  const host = options.keys;
  const page = node(document, "div", "settings-shortcuts");
  page.append(
    node(
      document,
      "p",
      "settings-page-note",
      host === undefined
        ? "Every key the Editor handles, read from the table the Editor itself uses. Keys cannot be changed from here."
        : "Change a key, add one, or take one away. A change applies at once and is saved with your settings, which follow you to another computer. A key belongs to one command: if another has it you are told which, and can take it. Reset puts a command back to its own keys.",
    ),
  );

  const search = document.createElement("input") as HTMLInputElement;
  search.type = "search";
  search.className = "settings-search";
  search.id = "settings-shortcut-search";
  search.placeholder = "Search commands or keys";
  search.setAttribute("aria-label", "Search shortcuts");
  search.setAttribute("autocomplete", "off");

  const table = node(document, "table", "settings-keys");
  table.setAttribute("aria-label", "Shortcuts");
  const head = node(document, "thead", "");
  const headRow = node(document, "tr", "");
  for (const text of ["COMMAND", "KEYS", ""]) {
    const cell = node(document, "th", "", text);
    cell.setAttribute("scope", "col");
    headRow.append(cell);
  }
  head.append(headRow);
  const body = node(document, "tbody", "");
  table.append(head, body);

  const summary = node(document, "p", "settings-page-note settings-keys-summary");
  summary.setAttribute("role", "status");
  const stale = node(document, "div", "settings-keys-stale");

  const state: KeyState = {};
  let show: ShowFilter = "all";
  const toolbar = node(document, "div", "settings-keys-tools");
  const filter = document.createElement("select") as HTMLSelectElement;
  filter.className = "settings-keys-show";
  filter.setAttribute("aria-label", "Which commands to list");
  for (const choice of SHOW_FILTERS) {
    const option = document.createElement("option") as HTMLOptionElement;
    option.value = choice.id;
    option.textContent = choice.label;
    filter.append(option);
  }
  filter.addEventListener("change", () => {
    show = filter.value as ShowFilter;
    draw();
  });
  const resetAllSlot = node(document, "span", "settings-keys-reset-all");
  toolbar.append(search);
  if (host !== undefined) toolbar.append(filter, resetAllSlot);

  const onKey = (event: KeyboardEvent): void => {
    const recording = state.recording;
    if (recording === undefined || host === undefined) return;
    // The key is for the page: nothing else in the Editor may act on it while it is being recorded.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    const read = recordKey(event);
    if (read.kind === "wait") return;
    if (read.kind === "cancel") return finish();
    if (read.kind === "refused") {
      state.notice = { command: recording.command, text: read.reason };
      return draw();
    }
    void submit(recording.command, read.label, recording.mode, false);
  };

  const stopListening = (): void => {
    document.removeEventListener?.("keydown", onKey as EventListener, true);
  };
  const finish = (): void => {
    stopListening();
    delete state.recording;
    delete state.notice;
    draw();
  };
  const startRecording = (command: string, mode: "replace" | "add"): void => {
    stopListening();
    state.recording = { command, mode };
    delete state.notice;
    document.addEventListener?.("keydown", onKey as EventListener, true);
    draw();
  };
  const submit = async (command: string, key: string, mode: "replace" | "add", take: boolean): Promise<void> => {
    if (host === undefined) return;
    const outcome = await host.assign(command, key, mode, take);
    if (outcome.kind === "done") return finish();
    stopListening();
    delete state.recording;
    state.notice =
      outcome.kind === "clash"
        ? { command, text: `${outcome.key} is the key of ${options.labelOf(outcome.holder) ?? outcome.holder}.`, clash: { key: outcome.key, holder: outcome.holder, mode } }
        : { command, text: outcome.reason };
    draw();
  };

  const draw = (): void => {
    const now = host?.state();
    const rows = shortcutRows(now?.shortcuts ?? options.shortcuts, options.labelOf, now === undefined || host === undefined ? {} : { commands: host.commands, changed: now.changed });
    const shown = showRows(filterShortcuts(rows, search.value), show);
    const lines: HTMLElement[] = [];
    for (const row of shown) {
      lines.push(keyRow(document, row, host === undefined ? undefined : { startRecording, state, finish, submit, host, labelOf: options.labelOf }));
      if (host !== undefined && (state.recording?.command === row.command || state.notice?.command === row.command)) lines.push(statusRow(document, row, state, { finish, submit }));
    }
    if (shown.length === 0) {
      const empty = node(document, "tr", "settings-keys-empty");
      const cell = node(document, "td", "", search.value.trim() === "" ? "No command to list." : `No command or key matches "${search.value.trim()}".`);
      cell.setAttribute("colspan", "3");
      empty.append(cell);
      lines.push(empty);
    }
    body.replaceChildren(...lines);
    summary.textContent = shortcutSummary(rows, shown.length);
    if (host !== undefined && now !== undefined) {
      const nothing = now.changed.size === 0 && now.unknown.length === 0;
      resetAllSlot.replaceChildren(
        button(document, "settings-keys-reset-all-button", "Reset all shortcuts", () => void host.resetAll().then(finish), nothing ? { disabled: "No key has been changed." } : {}),
      );
      stale.replaceChildren(...staleLines(document, now, host, options.labelOf, draw));
    }
  };
  search.addEventListener("input", draw);
  draw();

  page.append(toolbar, table, summary, stale);
  return {
    element: page,
    redraw: draw,
    cancel: () => {
      if (state.recording !== undefined || state.notice !== undefined) finish();
    },
  };
}

interface RowEditing {
  readonly startRecording: (command: string, mode: "replace" | "add") => void;
  readonly state: KeyState;
  readonly finish: () => void;
  readonly submit: (command: string, key: string, mode: "replace" | "add", take: boolean) => Promise<void>;
  readonly host: KeysHost;
  readonly labelOf: (command: string) => string | undefined;
}

function keyRow(document: Document, row: ShortcutRow, editing?: RowEditing): HTMLElement {
  const line = node(document, "tr", "settings-keys-row");
  line.dataset.command = row.command;
  const command = node(document, "td", "settings-keys-command");
  command.append(node(document, "span", "settings-keys-label", row.label), node(document, "span", "settings-keys-id", row.command));
  const keys = node(document, "td", "settings-keys-keys");
  if (row.keys.length === 0 && editing !== undefined) keys.append(node(document, "span", "settings-keys-none", "no key"));
  for (const key of row.keys) {
    const cap = node(document, "span", "settings-keycap");
    cap.append(node(document, "kbd", "settings-key", key));
    if (editing !== undefined) {
      cap.append(button(document, "settings-key-remove", "×", () => void editing.host.remove(row.command, key).then(editing.finish), { label: `Remove ${key} from ${row.label}` }));
    }
    keys.append(cap);
  }
  const state = node(document, "td", "settings-keys-state");
  if (row.clashesWith.length > 0) {
    const chip = node(document, "span", "chip settings-clash", "CLASH");
    chip.dataset.tone = "bad";
    chip.setAttribute("title", `Also the key of ${row.clashesWith.join(", ")}. The Editor runs the first and ignores the rest.`);
    state.append(chip);
  }
  if (editing !== undefined) {
    if (row.changed) {
      const chip = node(document, "span", "chip settings-changed", "CHANGED");
      chip.dataset.tone = "neutral";
      chip.setAttribute("title", "These keys are yours, not the Editor's own. Reset puts them back.");
      state.append(chip);
    }
    state.append(
      button(document, "settings-key-change", "Change…", () => editing.startRecording(row.command, "replace"), { label: `Change the key of ${row.label}` }),
      button(
        document,
        "settings-key-add",
        "Add key…",
        () => editing.startRecording(row.command, "add"),
        row.keys.length >= MOST_KEYS_PER_COMMAND
          ? { label: `Add a key to ${row.label}`, disabled: `A command has at most ${MOST_KEYS_PER_COMMAND} keys: remove one first.` }
          : { label: `Add a key to ${row.label}` },
      ),
    );
    if (row.changed) {
      state.append(button(document, "settings-key-reset", "Reset", () => void editing.host.reset(row.command).then(editing.finish), { label: `Put ${row.label} back to its own keys` }));
    }
    if (editing.state.recording?.command === row.command) line.className += " is-recording";
  }
  line.append(command, keys, state);
  return line;
}

/** The line under a row that is waiting for a key or has something to say: press a key, why it was refused, or whose key it is and Take it. */
function statusRow(document: Document, row: ShortcutRow, state: KeyState, handlers: Pick<RowEditing, "finish" | "submit">): HTMLElement {
  const line = node(document, "tr", "settings-keys-status");
  line.dataset.command = row.command;
  const cell = node(document, "td", "settings-keys-status-cell");
  cell.setAttribute("colspan", "3");
  cell.setAttribute("role", "status");
  if (state.recording?.command === row.command) {
    cell.append(node(document, "span", "settings-keys-prompt", `Press the ${state.recording.mode === "add" ? "key to add to" : "new key for"} ${row.label}… Escape cancels.`));
  }
  if (state.notice?.command === row.command) {
    const clash = state.notice.clash;
    const text = node(document, "span", "settings-keys-notice", state.notice.text);
    text.dataset.tone = "bad";
    cell.append(text);
    if (clash !== undefined) {
      cell.append(button(document, "settings-key-take", "Take it", () => void handlers.submit(row.command, clash.key, clash.mode, true), { label: `Take ${clash.key} for ${row.label}` }));
    }
  }
  if (state.recording?.command === row.command || state.notice?.command === row.command) {
    cell.append(button(document, "settings-key-cancel", "Cancel", handlers.finish));
  }
  line.append(cell);
  return line;
}

/** What is saved for commands this build does not have, and keys it could not read: named, with a way to remove them. */
function staleLines(document: Document, now: EffectiveKeys, host: KeysHost, labelOf: (command: string) => string | undefined, redraw: () => void): HTMLElement[] {
  const lines: HTMLElement[] = [];
  for (const entry of now.unknown) {
    const line = node(document, "p", "settings-page-note settings-keys-unknown");
    line.dataset.command = entry.command;
    line.append(
      node(document, "span", "", `Saved keys for a command this build does not have, ignored: ${entry.command}${entry.keys.length === 0 ? " (no key)" : ` (${entry.keys.join(", ")})`}. `),
      button(document, "settings-key-reset", "Remove", () => void host.reset(entry.command).then(redraw), { label: `Remove the saved keys for ${entry.command}` }),
    );
    lines.push(line);
  }
  for (const entry of now.unreadable) {
    lines.push(node(document, "p", "settings-page-note settings-keys-unreadable", `A saved key for ${labelOf(entry.command) ?? entry.command} could not be read, and is ignored: ${entry.key}.`));
  }
  return lines;
}

/** A page that is listed and not built: what it waits for and which row builds it, in words. */
function waitingPage(document: Document, page: SettingsPage): HTMLElement {
  const box = node(document, "div", "settings-waiting");
  box.append(
    node(document, "p", "settings-page-note settings-waiting-line", waitingLine(page)),
    node(document, "p", "settings-page-note", page.waitsFor ?? ""),
  );
  return box;
}

export function createSettingsWindow(document: Document, root: HTMLElement, options: SettingsWindowOptions): SettingsWindow {
  const nav = node(document, "div", "settings-nav");
  nav.setAttribute("role", "tablist");
  nav.setAttribute("aria-label", "Settings sections");
  nav.setAttribute("aria-orientation", "vertical");
  const pages = node(document, "div", "settings-pages");

  const general = node(document, "div", "settings-general");
  const shortcuts = shortcutsPage(document, options);
  const tabs = new Map<SettingsPageId, HTMLElement>();
  const panels = new Map<SettingsPageId, HTMLElement>();
  let current: SettingsPageId = DEFAULT_SETTINGS_PAGE;

  for (const page of SETTINGS_PAGES) {
    const tab = node(document, "button", `settings-tab${page.live ? "" : " is-soon"}`, page.label);
    (tab as HTMLButtonElement).type = "button";
    tab.id = `settings-tab-${page.id}`;
    tab.dataset.page = page.id;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", `settings-page-${page.id}`);
    if (!page.live) tab.setAttribute("title", waitingLine(page));

    const panel = node(document, "div", "settings-page");
    panel.id = `settings-page-${page.id}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tab.id);
    panel.append(page.id === "general" ? general : page.id === "shortcuts" ? shortcuts.element : waitingPage(document, page));

    tabs.set(page.id, tab);
    panels.set(page.id, panel);
    nav.append(tab);
    pages.append(panel);
  }

  const show = (id: string): SettingsPageId => {
    const page = resolvePage(id);
    // A key being waited for is not waited for on another page.
    if (page.id !== "shortcuts") shortcuts.cancel();
    current = page.id;
    for (const [pageId, tab] of tabs) {
      const selected = pageId === current;
      tab.setAttribute("aria-selected", String(selected));
      tab.setAttribute("tabindex", selected ? "0" : "-1");
      tab.classList.toggle("is-selected", selected);
    }
    for (const [pageId, panel] of panels) panel.hidden = pageId !== current;
    options.onShow?.(current);
    return current;
  };

  const order = SETTINGS_PAGES.map((page) => page.id);
  for (const [pageId, tab] of tabs) {
    tab.addEventListener("click", () => show(pageId));
    tab.addEventListener("keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      const at = order.indexOf(pageId);
      const target = key === "ArrowDown" ? order[(at + 1) % order.length] : key === "ArrowUp" ? order[(at + order.length - 1) % order.length] : key === "Home" ? order[0] : key === "End" ? order[order.length - 1] : undefined;
      if (target === undefined) return;
      event.preventDefault();
      show(target);
      tabs.get(target)?.focus();
    });
  }

  // The host is the nav's and the page's grid (settings-window.css): the class goes on it here, so the page cannot forget it.
  root.classList.add("settings-window");
  root.replaceChildren(nav, pages);
  show(options.initial ?? DEFAULT_SETTINGS_PAGE);
  return {
    general,
    show,
    get current() {
      return current;
    },
    keysChanged: shortcuts.redraw,
    cancelRecording: shortcuts.cancel,
  };
}
