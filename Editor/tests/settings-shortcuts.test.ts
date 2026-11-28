// Plan row 11.81 (Figma E4): the Shortcuts page's rules, drawn from the Editor's one key table.
import { describe, expect, it } from "vitest";

import { SHORTCUTS, commandById, type Shortcut } from "../src/command-registry";
import { clashingKeys, filterShortcuts, formatChord, shortcutRows, shortcutSummary } from "../src/settings-shortcuts";

const labelOf = (command: string) => commandById(command)?.label;
const real = shortcutRows(SHORTCUTS, labelOf);
const chord = (key: string, ctrl = false, shift = false) => ({ key, ctrl, shift });

describe("how a key is written", () => {
  it("is the same words the menus show, for every key the table gives a label", () => {
    const labelled = SHORTCUTS.filter((entry) => entry.label !== undefined);
    expect(labelled.length).toBeGreaterThan(20);
    for (const entry of labelled) expect(formatChord(entry.chord), entry.command).toBe(entry.label);
  });

  it("writes Space, function keys, named keys and punctuation", () => {
    expect(formatChord(chord(" "))).toBe("Space");
    expect(formatChord(chord("f9", false, true))).toBe("Shift F9");
    expect(formatChord(chord("f12", true))).toBe("Ctrl F12");
    expect(formatChord(chord("backspace"))).toBe("Backspace");
    expect(formatChord(chord("delete"))).toBe("Delete");
    expect(formatChord(chord("+", true, true))).toBe("Ctrl Shift +");
    expect(formatChord(chord("s", true, true))).toBe("Ctrl Shift S");
  });
});

describe("the rows", () => {
  it("are one per command, in the order the table first names it, with every key of a command together", () => {
    const commands = [...new Set(SHORTCUTS.map((entry) => entry.command))];
    expect(real.map((row) => row.command)).toEqual(commands);
    const keysOf = (command: string) => real.find((row) => row.command === command)?.keys;
    expect(keysOf("edit.redo")).toEqual(["Ctrl Shift Z", "Ctrl Y"]);
    expect(keysOf("edit.pen")).toEqual(["G", "P"]);
    expect(keysOf("motion.delete-keys")).toEqual(["Delete", "Backspace"]);
    expect(keysOf("layout.zoom-in")).toEqual(["Ctrl =", "Ctrl Shift +"]);
    expect(keysOf("file.save")).toEqual(["Ctrl S"]);
  });

  it("carry what the menu calls the command, and the id itself when the menu has no word for it", () => {
    expect(real.find((row) => row.command === "file.save")?.label).toBe(commandById("file.save")?.label);
    const rows = shortcutRows([{ chord: chord("q"), command: "made.up" } as Shortcut], labelOf);
    expect(rows).toEqual([{ command: "made.up", label: "made.up", keys: ["Q"], clashesWith: [], changed: false }]);
  });

  it("show no clash in the Editor's own table: a second command on a key would be ignored by the Editor", () => {
    expect(clashingKeys(SHORTCUTS).size).toBe(0);
    expect(real.every((row) => row.clashesWith.length === 0)).toBe(true);
  });
});

describe("a clash", () => {
  const twice: Shortcut[] = [
    { chord: chord("k", true), command: "edit.search" },
    { chord: chord("k", true), command: "other.thing" },
    { chord: chord("j", true), command: "edit.join" },
    { chord: chord("j", true), command: "edit.join" },
  ];

  it("is two different commands on one key, named on both rows", () => {
    expect([...clashingKeys(twice)]).toEqual([["Ctrl K", ["edit.search", "other.thing"]]]);
    const rows = shortcutRows(twice, () => undefined);
    expect(rows.find((row) => row.command === "edit.search")?.clashesWith).toEqual(["other.thing"]);
    expect(rows.find((row) => row.command === "other.thing")?.clashesWith).toEqual(["edit.search"]);
  });

  it("is not one command listed twice on the same key", () => {
    const rows = shortcutRows(twice, () => undefined);
    expect(rows.find((row) => row.command === "edit.join")).toEqual({ command: "edit.join", label: "edit.join", keys: ["Ctrl J"], clashesWith: [], changed: false });
  });

  it("is said in the summary by name, with what the Editor does about it", () => {
    const rows = shortcutRows(twice, (command) => ({ "edit.search": "Search everything", "other.thing": "Other" })[command]);
    const line = shortcutSummary(rows, rows.length);
    expect(line).toContain("2 commands share a key with another: Search everything, Other.");
    expect(line).toContain("runs the first and ignores the rest");
  });
});

describe("search", () => {
  const ids = (query: string) => filterShortcuts(real, query).map((row) => row.command);

  it("shows everything for a blank search", () => {
    expect(filterShortcuts(real, "")).toHaveLength(real.length);
    expect(filterShortcuts(real, "   ")).toHaveLength(real.length);
  });

  it("finds a command by its words or its id", () => {
    expect(ids("save")).toContain("file.save");
    expect(ids("edit.pen")).toEqual(["edit.pen"]);
    expect(ids("PEN")).toContain("edit.pen");
  });

  it("finds a key as typed: 'ctrl s' and 'ctrl+s' are Ctrl S and not Ctrl Shift S", () => {
    expect(ids("ctrl s")).toEqual(["file.save"]);
    expect(ids("ctrl+s")).toEqual(["file.save"]);
    expect(ids("Ctrl Shift S")).toEqual(["file.next-version"]);
    expect(ids("space")).toContain("motion.play");
  });

  it("takes a chord in either order, and a modifier alone or a bare key as ordinary words", () => {
    expect(ids("s ctrl")).toEqual(["file.save"]);
    expect(ids("shift ctrl s")).toEqual(["file.next-version"]);
    const withCtrl = real.filter((row) => row.keys.some((key) => key.startsWith("Ctrl"))).map((row) => row.command);
    expect(withCtrl.length).toBeGreaterThan(5);
    expect(ids("ctrl")).toEqual(withCtrl);
    expect(ids("f9")).toEqual(["motion.easy-ease", "motion.easy-ease-in", "motion.easy-ease-out"]);
  });

  it("finds a command by any one of its keys", () => {
    expect(ids("backspace")).toEqual(["motion.delete-keys"]);
    expect(ids("ctrl y")).toEqual(["edit.redo"]);
  });

  it("needs every word, and says nothing matches when nothing does", () => {
    expect(ids("redo ctrl")).toEqual(["edit.redo"]);
    expect(ids("zzzz")).toEqual([]);
  });
});

describe("the sentence under the table", () => {
  it("counts the commands and the keys, and says there is no clash when there is none", () => {
    const keys = SHORTCUTS.length;
    expect(shortcutSummary(real, real.length)).toBe(`${real.length} commands, ${keys} keys. No two commands share a key.`);
  });

  it("counts what a search shows against all of them", () => {
    expect(shortcutSummary(real, 3)).toBe(`3 of ${real.length} commands shown. No two commands share a key.`);
  });
});
