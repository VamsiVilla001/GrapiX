// The menu bar (11.32) is held to the jobs in the research reference, to the Editor page it drives and
// to the plan that says what is still to build. A menu that names a control the page does not have,
// or a plan row that does not exist, would be a dead click or a promise nobody tracks. And no menu,
// drop-down or item may carry XPression's own name: the names are GrapiX's, in plain words.
import { describe, expect, it } from "vitest";
import {
  actionOf,
  allCommands,
  APP_MENUS,
  commandsOf,
  EVIDENCE_LABEL,
  menuProblems,
  menuTitle,
  submenusOf,
  TOP_LEVEL,
  XPRESSION_NAMES,
} from "../src/app-menu";
import page from "../web/index.html?raw";
import plan from "../../GrapiX-Build-Plan.md?raw";
import reference from "../../docs/reference/xpression-menu-bar.md?raw";

/** Plain words every application uses; they are not XPression's own. */
const UNIVERSAL = new Set(["New", "Open Project", "Save", "Save As", "Undo", "Redo", "Move", "Rotate", "Effects"]);

describe("the menu bar has GrapiX's own names", () => {
  it("has eight top-level menus in plain words, in this order", () => {
    expect(APP_MENUS.map((m) => m.label)).toEqual([...TOP_LEVEL]);
  });

  it("uses none of XPression's names for a menu, a drop-down or an item", () => {
    const labels = [
      ...APP_MENUS.map((m) => m.label),
      ...APP_MENUS.flatMap((m) => submenusOf(m.items).map((s) => s.label)),
      ...allCommands().map((c) => c.label),
      "Recent projects",
    ];
    const taken = new Set(XPRESSION_NAMES.map((n) => n.toLowerCase()));
    for (const label of labels) {
      expect(taken.has(label.replace(/…$/, "").toLowerCase()), `${label} is one of XPression's names`).toBe(false);
    }
    // The page's own panel heading for the scene list is GrapiX's word too.
    expect(page).toContain("<h2>Scenes</h2>");
    expect(page).not.toContain("<h2>Scene Manager</h2>");
  });

  it("does not repeat XPression's names even in a tooltip", () => {
    for (const text of Object.values(EVIDENCE_LABEL)) {
      for (const name of XPRESSION_NAMES) expect(text.toLowerCase()).not.toContain(name.toLowerCase());
    }
  });

  it("still ties each borrowed job to the feature in the reference, privately", () => {
    const borrowed = allCommands().filter((c) => c.evidence !== "grapix");
    expect(borrowed.length).toBeGreaterThan(30);
    for (const command of borrowed) {
      expect(command.basedOn, `${command.id} says which feature it does the job of`).toBeDefined();
      expect(reference, `${command.id}: ${command.basedOn}`).toContain(command.basedOn!);
      // The new name is not the old one, unless it is a word every application uses.
      if (!UNIVERSAL.has(command.basedOn!)) {
        expect(command.label.replace(/…$/, "").toLowerCase()).not.toBe(command.basedOn!.toLowerCase());
      }
    }
    // A GrapiX addition borrows nothing.
    for (const command of allCommands().filter((c) => c.evidence === "grapix")) expect(command.basedOn).toBeUndefined();
  });
});

describe("every item is a real action or an honest promise", () => {
  it("is sound: no duplicate ids or shortcuts, one action or a plan row, never both", () => {
    expect(menuProblems()).toEqual([]);
  });

  it("only clicks controls the Editor page has", () => {
    for (const command of allCommands()) {
      if (command.invoke !== undefined) expect(page, `${command.id} clicks #${command.invoke}`).toContain(`id="${command.invoke}"`);
      if (command.focusPanel !== undefined) expect(page, `${command.id} focuses ${command.focusPanel}`).toContain(`data-panel="${command.focusPanel}"`);
      if (command.createKind !== undefined) expect(["rect", "ellipse", "text"]).toContain(command.createKind);
    }
  });

  it("points every unbuilt item at a row the plan has", () => {
    const unbuilt = allCommands().filter((c) => actionOf(c) === "unbuilt");
    expect(unbuilt.length).toBeGreaterThan(0);
    for (const command of unbuilt) {
      expect(plan, `${command.id} waits for row ${command.row}`).toContain(`| \`${command.row}\` |`);
      expect(menuTitle(command)).toContain(`plan row ${command.row}`);
    }
  });

  it("shows a shortcut only where the Editor handles one", () => {
    const withKeys = allCommands().filter((c) => c.shortcut !== undefined).map((c) => c.id);
    // Undo and Redo (11.37), the two saves (11.30) and the timeline's keys (11.31): each is decided by the one
    // table in `command-registry.ts`, whose own test holds that this list and the table are the same.
    expect(withKeys.sort()).toEqual([
      "edit.centre",
      "edit.hand",
      "edit.join",
      "edit.move",
      "edit.path",
      "edit.pen",
      "edit.pointer",
      "edit.redo",
      "edit.resize",
      "edit.rotate",
      "edit.undo",
      "edit.vertex-add",
      "edit.vertex-convert",
      "edit.vertex-delete",
      "edit.zoom",
      "file.next-version",
      "file.save",
      "layout.fit",
      "layout.zoom-100",
      "layout.zoom-in",
      "layout.zoom-out",
      "motion.copy-keys",
      "motion.delete-keys",
      "motion.easy-ease",
      "motion.easy-ease-in",
      "motion.easy-ease-out",
      "motion.paste-keys",
      "motion.play",
    ]);
  });

  it("lists the panels the page really has, and keeps what GrapiX adds", () => {
    const panels = commandsOf(APP_MENUS.find((m) => m.id === "panels")!.items).filter((c) => c.focusPanel !== undefined);
    expect(panels.map((c) => c.label)).toEqual(["Scenes", "Objects", "Materials", "Properties", "Timeline", "Effects", "Live preview"]);
    const own = allCommands().filter((c) => c.evidence === "grapix").map((c) => c.id);
    for (const id of ["file.new-scene", "file.close-project", "edit.duplicate", "layout.reset"]) expect(own).toContain(id);
  });

  it("keeps New project, Open project and the project picker in the menu only, not in the Scene panel", () => {
    // They were duplicates of File > New project, File > Open project and Recent projects.
    for (const id of ["project-select", "project-create", "project-open"]) expect(page).not.toContain(`id="${id}"`);
    const natives = allCommands().map((c) => c.native);
    expect(natives).toContain("new-project");
    expect(natives).toContain("open-project");
  });

  it("does not leave the old static menus in the page", () => {
    expect(page).not.toContain('class="app-menu"');
    expect(page).not.toContain("window-panel-menu");
  });
});
