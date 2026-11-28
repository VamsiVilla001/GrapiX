// What the Layout dropdown and the Layouts dialog say (plan row 11.96). Plain data, so the words are tested; the page draws them.

import type { LayoutItem } from "./layout-switcher";

/** The dot that says a layout has been changed since it was saved (a shipped one: since it shipped). */
export const CHANGED_DOT = "•";

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly title: string;
}

/** The value of the dropdown's last line, which opens the dialog instead of choosing a layout. */
export const MANAGE_VALUE = "__layouts__";

/** The dropdown: every layout, with a dot on a changed one, then the line that opens the dialog. */
export function selectOptions(items: readonly LayoutItem[]): SelectOption[] {
  const options = items.map((item) => ({
    value: item.id,
    label: item.modified ? `${item.name} ${CHANGED_DOT}` : item.name,
    title: item.modified ? `${item.name}: changed since it was ${item.shipped ? "shipped" : "saved"}` : item.name,
  }));
  return [...options, { value: MANAGE_VALUE, label: "Layouts…", title: "Save, rename, reset or delete layouts" }];
}

export interface Row {
  readonly id: string;
  readonly name: string;
  /** What the right-hand side of the row says. */
  readonly detail: string;
  readonly active: boolean;
}

/** The dialog's rows: the name, and whether it ships with GrapiX or is the author's, and whether it has been changed. */
export function dialogRows(items: readonly LayoutItem[]): Row[] {
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    detail: [item.shipped ? "shipped with GrapiX" : "your layout", item.active ? "in use" : undefined, item.modified ? "changed" : undefined]
      .filter((part) => part !== undefined)
      .join(" · "),
    active: item.active,
  }));
}

/** Which actions the selected row allows, so the dialog dims the rest and says why in the button's title. */
export interface ActionState {
  readonly rename: string | undefined;
  readonly remove: string | undefined;
  readonly reset: string | undefined;
}

/** A string is the reason an action is not available; `undefined` means it is. */
export function actionsFor(item: LayoutItem | undefined): ActionState {
  if (item === undefined) {
    const none = "Choose a layout first";
    return { rename: none, remove: none, reset: none };
  }
  return {
    rename: item.shipped ? `${item.name} ships with GrapiX and keeps its name. Save a copy under another name instead.` : undefined,
    remove: item.shipped
      ? `${item.name} ships with GrapiX and cannot be deleted.`
      : item.active
        ? `${item.name} is in use. Switch to another layout first.`
        : undefined,
    reset: item.modified || item.shipped ? undefined : `${item.name} has not been changed.`,
  };
}
