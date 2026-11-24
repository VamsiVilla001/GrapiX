// The change history list (11.82): the words of a step, which row is current, and that the page and the
// menu have the list. The compiler already checks that every kind of edit and every part of the app has
// words (`satisfies Record<...>`); these tests hold what that cannot.
import { describe, expect, it } from "vitest";
import type { HistoryStep, HistoryView } from "@grapix/contracts";
import { APP_MENUS, type MenuNode } from "../src/app-menu";
import { EDIT_WORDS, historyRows, historySummary, MODULE_WORDS, stepTitle } from "../src/history-list";
import page from "../web/index.html?raw";
import schemaText from "../../Shared/generated-ts/schemas/SceneEdit.schema.json?raw";

function step(id: number, edits: string[], applied = true, about?: string): HistoryStep {
  return { id, module: "inspector", edits, applied, ...(about === undefined ? {} : { about }) };
}

function view(steps: HistoryStep[], folded = 0): HistoryView {
  return { session: 1, steps, folded, limit: 200 };
}

describe("a step in words", () => {
  it("says what one edit did, and what it was about", () => {
    expect(stepTitle(step(1, ["createObject"], true, "Card"))).toBe("Add item: Card");
    expect(stepTitle(step(2, ["setObjectVisible"]))).toBe("Show or hide item");
  });

  it("counts a batch of the same edit, and names the first of a mixed one", () => {
    expect(stepTitle(step(1, ["moveKeyframe", "moveKeyframe", "moveKeyframe"], true, "x"))).toBe("Move key (3 times): x");
    expect(stepTitle(step(2, ["createObject", "setObjectField", "setPaint"], true, "Card"))).toBe("Add item and 2 more: Card");
    expect(stepTitle(step(3, ["createObject", "createObject", "setPaint"]))).toBe("Add item and 2 more");
  });

  it("shows an edit it has no word for by its own name, and never an empty line", () => {
    expect(stepTitle(step(1, ["somethingNewer"]))).toBe("somethingNewer");
    expect(stepTitle(step(2, []))).toBe("Change");
  });

  it("has words for exactly the edits of the contract, none of them a wire name", () => {
    const schema = JSON.parse(schemaText) as { oneOf: { properties: { edit: { const: string } } }[] };
    const kinds = schema.oneOf.map((one) => one.properties.edit.const);
    expect(kinds.length).toBeGreaterThan(40);
    expect(Object.keys(EDIT_WORDS).sort()).toEqual([...kinds].sort());
    for (const [kind, words] of Object.entries(EDIT_WORDS)) {
      expect(words, kind).toMatch(/^[A-Z][a-z]+( [a-z]+)*$/);
      expect(words, kind).not.toBe(kind);
    }
  });

  it("names each part of the app by its own panel heading", () => {
    for (const [module, words] of Object.entries(MODULE_WORDS)) {
      if (module === "scene") continue; // The scene itself has no panel.
      expect(page, module).toMatch(new RegExp(`<h2>${words}[ <]`));
    }
  });
});

describe("the rows of the list", () => {
  it("puts the scene as opened first and marks the last applied step as current", () => {
    const rows = historyRows(view([step(1, ["createObject"]), step(2, ["setPaint"]), step(3, ["setTrim"], false)]));
    expect(rows.map((row) => [row.step, row.applied, row.current])).toEqual([
      [undefined, true, false],
      [1, true, false],
      [2, true, true],
      [3, false, false],
    ]);
    expect(rows[0]).toMatchObject({ title: "Scene as opened", from: "" });
    expect(rows[1]).toMatchObject({ title: "Add item", from: "Properties" });
  });

  it("marks the scene as opened when every step is undone, and the last step when none is", () => {
    const undone = historyRows(view([step(1, ["createObject"], false), step(2, ["setPaint"], false)]));
    expect(undone.map((row) => row.current)).toEqual([true, false, false]);
    const applied = historyRows(view([step(1, ["createObject"]), step(2, ["setPaint"])]));
    expect(applied.map((row) => row.current)).toEqual([false, false, true]);
    expect(historyRows(view([])).map((row) => row.current)).toEqual([true]);
  });

  it("marks no row when an undone step sits under an applied one", () => {
    // A part of the app undid its own step; the scene is not the state just after any one row.
    const rows = historyRows(view([step(1, ["createObject"]), step(2, ["setPaint"], false), step(3, ["setTrim"])]));
    expect(rows.map((row) => row.current)).toEqual([false, false, false, false]);
    expect(rows.map((row) => row.applied)).toEqual([true, true, false, true]);
  });

  it("says how many older changes are part of the scene as opened", () => {
    expect(historyRows(view([step(4, ["setPaint"])], 3))[0]!.title).toBe("Scene as opened, and 3 older changes");
    expect(historyRows(view([step(2, ["setPaint"])], 1))[0]!.title).toBe("Scene as opened, and 1 older change");
  });
});

describe("the line above the list", () => {
  it("counts the changes and the undone ones, and names the limit only once it bites", () => {
    expect(historySummary(view([]))).toBe("No changes yet. Each change to this scene will be listed here.");
    expect(historySummary(view([step(1, ["setPaint"])]))).toBe("1 change. Click a line to take the scene there.");
    expect(historySummary(view([step(1, ["setPaint"]), step(2, ["setTrim"], false), step(3, ["setTrim"], false)]))).toBe(
      "3 changes, 2 undone. Click a line to take the scene there.",
    );
    expect(historySummary(view([step(4, ["setPaint"])], 3))).toBe("1 change. Click a line to take the scene there. Only the last 200 can be undone.");
    expect(historySummary(view([], 2))).toBe("0 changes. Click a line to take the scene there. Only the last 200 can be undone.");
  });
});

describe("the page and the menu have the list", () => {
  function find(nodes: readonly MenuNode[], id: string): MenuNode | undefined {
    for (const node of nodes) {
      if (node.kind === "command" && node.id === id) return node;
      if (node.kind === "submenu") {
        const inside = find(node.items, id);
        if (inside) return inside;
      }
    }
    return undefined;
  }

  it("opens from Edit > Change history, through the same button the toolbar has", () => {
    const item = find(APP_MENUS.flatMap((menu) => menu.items), "edit.history");
    expect(item).toMatchObject({ kind: "command", label: "Change history…", invoke: "history-open" });
    expect((item as { row?: string }).row).toBeUndefined();
    for (const id of ["history-open", "history-dialog", "history-list", "history-lead", "history-error", "history-close"]) {
      expect(page, id).toContain(`id="${id}"`);
    }
  });
});
