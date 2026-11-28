import { describe, expect, it } from "vitest";

import type { LayoutItem } from "../src/layout-switcher";
import { MANAGE_VALUE, actionsFor, dialogRows, selectOptions } from "../src/layout-switcher-view";

const design: LayoutItem = { id: "factory.editor.design", name: "Design", modified: false, shipped: true, active: true };
const mine: LayoutItem = { id: "user.mine", name: "Mine", modified: true, shipped: false, active: false };

describe("the dropdown", () => {
  it("lists every layout, a dot on a changed one, and ends with the line that opens the dialog", () => {
    const options = selectOptions([design, mine]);
    expect(options.map((o) => o.label)).toEqual(["Design", "Mine •", "Layouts…"]);
    expect(options.at(-1)!.value).toBe(MANAGE_VALUE);
    expect(options[1]!.title).toContain("changed since it was saved");
  });

  it("says a shipped layout changed since it shipped", () => {
    expect(selectOptions([{ ...design, modified: true }])[0]!.title).toContain("since it was shipped");
  });
});

describe("the dialog's rows", () => {
  it("say whose a layout is, which is in use and which is changed", () => {
    const rows = dialogRows([design, mine]);
    expect(rows[0]).toMatchObject({ name: "Design", detail: "shipped with GrapiX · in use", active: true });
    expect(rows[1]).toMatchObject({ name: "Mine", detail: "your layout · changed", active: false });
  });
});

describe("the actions a selected row allows", () => {
  it("a shipped layout cannot be renamed or deleted, and can always be put back as shipped", () => {
    const state = actionsFor(design);
    expect(state.rename).toContain("keeps its name");
    expect(state.remove).toContain("cannot be deleted");
    expect(state.reset).toBeUndefined();
  });

  it("the layout in use cannot be deleted; another of the author's can; reset needs a change", () => {
    expect(actionsFor({ ...mine, active: true }).remove).toContain("is in use");
    expect(actionsFor(mine)).toEqual({ rename: undefined, remove: undefined, reset: undefined });
    expect(actionsFor({ ...mine, modified: false }).reset).toContain("has not been changed");
  });

  it("with nothing selected every action says to choose first", () => {
    expect(actionsFor(undefined)).toEqual({ rename: "Choose a layout first", remove: "Choose a layout first", reset: "Choose a layout first" });
  });
});
