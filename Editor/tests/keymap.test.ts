// Changing a key (row 11.84): the written form of a key, reading a pressed key, the keys in force with a person's changes on top of the
// Editor's table, and the changes themselves (give, take, remove, reset). The rules are the ones in docs/evidence/11.84/jev-laya-keys.json.

import { describe, expect, it } from "vitest";

import { allCommands } from "../src/app-menu";
import { EMPTY_CONTEXT, SHORTCUTS, decideKey, shortcutFor, type KeyPress, type Shortcut } from "../src/command-registry";
import {
  MOST_KEYS_PER_COMMAND,
  assignKey,
  chordLabel,
  defaultKeys,
  effectiveKeys,
  keyLabel,
  parseChord,
  recordKey,
  removeKey,
  resetKey,
  tidy,
  type Keymap,
} from "../src/keymap";

const known: ReadonlySet<string> = new Set(allCommands().map((command) => command.id));

const press = (key: string, extra: Partial<KeyPress> = {}): KeyPress => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  repeat: false,
  defaultPrevented: false,
  ...extra,
});

describe("a key as the menus write it", () => {
  it("is what the Editor's own table says for every chord that has a label", () => {
    for (const shortcut of SHORTCUTS) {
      if (shortcut.label !== undefined) expect(chordLabel(shortcut.chord), shortcut.command).toBe(shortcut.label);
    }
  });

  it("reads back as the same chord, for every chord in the table", () => {
    for (const { chord, command } of SHORTCUTS) expect(parseChord(chordLabel(chord)), command).toEqual(chord);
  });

  it("names the named keys, the F keys, letters, digits and punctuation", () => {
    expect([" ", "delete", "backspace", "home", "end", "pageup", "pagedown", "arrowleft", "arrowright", "arrowup", "arrowdown"].map(keyLabel)).toEqual([
      "Space", "Delete", "Backspace", "Home", "End", "PageUp", "PageDown", "Left", "Right", "Up", "Down",
    ]);
    expect(["f1", "f9", "f12", "s", "7", "=", "+"].map(keyLabel)).toEqual(["F1", "F9", "F12", "S", "7", "=", "+"]);
    expect(chordLabel({ key: "s", ctrl: true, shift: true })).toBe("Ctrl Shift S");
  });

  it("parses what the contract accepts and refuses what it refuses", () => {
    for (const good of ["S", "Ctrl S", "Ctrl Shift S", "Shift F9", "F12", "Space", "Left", "7", "=", "Ctrl Shift +", "\\", "`"]) {
      expect(parseChord(good), good).toBeDefined();
    }
    for (const bad of ["", "Ctrl ", "Escape", "Enter", "Tab", "Shift Ctrl S", "Alt S", "Ctrl s", "ctrl S", "F13", "F0", "F01", "AB", "!", "Ctrl  S"]) {
      expect(parseChord(bad), bad).toBeUndefined();
    }
  });
});

describe("a key that is pressed to give a command", () => {
  it("waits while only a modifier is down, and Escape cancels", () => {
    for (const key of ["Control", "Shift", "Meta", "Alt", "AltGraph", "CapsLock"]) expect(recordKey(press(key)), key).toEqual({ kind: "wait" });
    expect(recordKey(press("Escape"))).toEqual({ kind: "cancel" });
  });

  it("refuses Enter, Tab and Alt, with the reason", () => {
    expect(recordKey(press("Enter"))).toEqual({ kind: "refused", reason: "Enter cannot be given to a command: dialogs and the focus order use it" });
    expect(recordKey(press("Tab"))).toEqual({ kind: "refused", reason: "Tab cannot be given to a command: dialogs and the focus order use it" });
    expect(recordKey(press("s", { altKey: true }))).toEqual({ kind: "refused", reason: "Alt is not read for keys here: use Ctrl and Shift" });
  });

  it("reads a letter with Ctrl and Shift, taking Meta for Ctrl as the Editor does", () => {
    expect(recordKey(press("S", { ctrlKey: true, shiftKey: true }))).toEqual({ kind: "chord", chord: { key: "s", ctrl: true, shift: true }, label: "Ctrl Shift S" });
    expect(recordKey(press("s", { metaKey: true }))).toMatchObject({ kind: "chord", label: "Ctrl S" });
    expect(recordKey(press("F9", { shiftKey: true }))).toMatchObject({ kind: "chord", label: "Shift F9" });
    expect(recordKey(press(" "))).toMatchObject({ kind: "chord", label: "Space" });
    expect(recordKey(press("ArrowLeft", { ctrlKey: true }))).toMatchObject({ kind: "chord", label: "Ctrl Left" });
    expect(recordKey(press("+", { ctrlKey: true, shiftKey: true }))).toMatchObject({ kind: "chord", label: "Ctrl Shift +" });
  });

  it("says why a shifted digit or symbol, or an unknown key, cannot be used", () => {
    const shifted = recordKey(press("!", { shiftKey: true }));
    expect(shifted).toMatchObject({ kind: "refused" });
    expect((shifted as { reason: string }).reason).toContain("shifted key");
    expect(recordKey(press("F13"))).toEqual({ kind: "refused", reason: "F13 is not a key a command can be given" });
    expect(recordKey(press("Dead"))).toMatchObject({ kind: "refused" });
  });
});

describe("the keys in force", () => {
  it("are the Editor's own table when nothing was changed, command for command", () => {
    const now = effectiveKeys(SHORTCUTS, {}, known);
    expect(now.changed.size).toBe(0);
    expect(now.unknown).toEqual([]);
    expect(now.taken).toEqual([]);
    expect(now.shortcuts).toHaveLength(SHORTCUTS.length);
    for (const original of SHORTCUTS) {
      const same = shortcutFor(press(original.chord.key, { ctrlKey: original.chord.ctrl, shiftKey: original.chord.shift }), now.shortcuts);
      expect(same?.command, chordLabel(original.chord)).toBe(original.command);
    }
    expect(now.keys.get("edit.redo")).toEqual(["Ctrl Shift Z", "Ctrl Y"]);
  });

  it("keep each command's label on its first key for the menu", () => {
    const labels = Object.fromEntries(effectiveKeys(SHORTCUTS, {}, known).shortcuts.filter((s) => s.label !== undefined).map((s) => [s.command, s.label]));
    expect(labels["file.save"]).toBe("Ctrl S");
    expect(labels["edit.redo"]).toBe("Ctrl Shift Z");
    expect(labels["edit.pen"]).toBe("G");
  });

  it("give a changed command its own keys in place of its defaults", () => {
    const now = effectiveKeys(SHORTCUTS, { "file.save": ["F2"] }, known);
    expect(now.changed).toEqual(new Set(["file.save"]));
    expect(shortcutFor(press("F2"), now.shortcuts)?.command).toBe("file.save");
    expect(shortcutFor(press("s", { ctrlKey: true }), now.shortcuts)).toBeUndefined();
    expect(now.keys.get("file.save")).toEqual(["F2"]);
  });

  it("let a changed command have no key", () => {
    const now = effectiveKeys(SHORTCUTS, { "motion.add-key": [] }, known);
    expect(shortcutFor(press("k"), now.shortcuts)).toBeUndefined();
    expect(now.keys.get("motion.add-key")).toEqual([]);
  });

  it("keep the behaviour of a key with its command: quiet, held repeats and working in a text field", () => {
    const now = effectiveKeys(SHORTCUTS, { "edit.undo": ["F5"], "edit.search": ["F6"], "motion.add-key": ["F7"] }, known);
    expect(shortcutFor(press("F5"), now.shortcuts)).toMatchObject({ command: "edit.undo", repeats: true });
    expect(shortcutFor(press("F6"), now.shortcuts)).toMatchObject({ command: "edit.search", fromFields: true });
    expect(shortcutFor(press("F7"), now.shortcuts)).toMatchObject({ command: "motion.add-key", quiet: true });
  });

  it("give a key to a command that had no key", () => {
    const now = effectiveKeys(SHORTCUTS, { "file.open-project": ["Ctrl O"] }, known);
    expect(shortcutFor(press("o", { ctrlKey: true }), now.shortcuts)).toMatchObject({ command: "file.open-project", label: "Ctrl O" });
  });

  it("leave a key with one handler: the changed command that wants a key another holds by default takes it", () => {
    const now = effectiveKeys(SHORTCUTS, { "edit.search": ["Ctrl S"] }, known);
    expect(shortcutFor(press("s", { ctrlKey: true }), now.shortcuts)?.command).toBe("edit.search");
    expect(now.taken).toEqual([{ key: "Ctrl S", from: "file.save", by: "edit.search" }]);
    expect(now.keys.get("file.save")).toEqual([]);
    // Nothing is left with two handlers.
    const seen = new Set<string>();
    for (const shortcut of now.shortcuts) {
      const label = chordLabel(shortcut.chord);
      expect(seen.has(label), label).toBe(false);
      seen.add(label);
    }
  });

  it("leave a key with one handler between two changed commands: the first in the keymap keeps it", () => {
    const now = effectiveKeys(SHORTCUTS, { "file.open-project": ["F4"], "file.new-scene": ["F4"] }, known);
    expect(shortcutFor(press("F4"), now.shortcuts)?.command).toBe("file.open-project");
    expect(now.keys.get("file.new-scene")).toEqual([]);
  });

  it("ignore a command this build does not have, and list it with its keys so it can be removed", () => {
    const now = effectiveKeys(SHORTCUTS, { "future.command": ["F8"] }, known);
    expect(now.unknown).toEqual([{ command: "future.command", keys: ["F8"] }]);
    expect(shortcutFor(press("F8"), now.shortcuts)).toBeUndefined();
  });

  it("ignore a key that cannot be read as a key, and name it", () => {
    const now = effectiveKeys(SHORTCUTS, { "file.save": ["Ctrl s", "F2"] }, known);
    expect(now.unreadable).toEqual([{ command: "file.save", key: "Ctrl s" }]);
    expect(now.keys.get("file.save")).toEqual(["F2"]);
  });

  it("run a command through decideKey exactly as the default table does", () => {
    const now = effectiveKeys(SHORTCUTS, { "edit.undo": ["F5"] }, known);
    const context = { ...EMPTY_CONTEXT, sceneOpen: true, canUndo: true };
    const focus = { editing: false, control: false };
    expect(decideKey(press("F5"), focus, context, now.shortcuts)).toEqual({ kind: "run", command: "edit.undo" });
    expect(decideKey(press("z", { ctrlKey: true }), focus, context, now.shortcuts)).toEqual({ kind: "pass" });
    // Without a table it is the Editor's own.
    expect(decideKey(press("z", { ctrlKey: true }), focus, context)).toEqual({ kind: "run", command: "edit.undo" });
  });
});

describe("giving a command a key", () => {
  const give = (keymap: Keymap, command: string, key: string, mode: "replace" | "add" = "replace", take = false) =>
    assignKey(keymap, SHORTCUTS, known, command, key, { mode, take });

  it("replaces the command's keys with it", () => {
    expect(give({}, "edit.redo", "F3")).toEqual({ kind: "done", keymap: { "edit.redo": ["F3"] } });
  });

  it("adds it beside the keys the command has, the defaults included", () => {
    expect(give({}, "edit.redo", "F3", "add")).toEqual({ kind: "done", keymap: { "edit.redo": ["Ctrl Shift Z", "Ctrl Y", "F3"] } });
    expect(give({ "edit.redo": ["F3"] }, "edit.redo", "F4", "add")).toEqual({ kind: "done", keymap: { "edit.redo": ["F3", "F4"] } });
  });

  it("refuses a key the command already has", () => {
    expect(give({}, "file.save", "Ctrl S")).toEqual({ kind: "refused", reason: "Ctrl S is already its key" });
    expect(give({}, "edit.redo", "Ctrl Y", "add")).toEqual({ kind: "refused", reason: "Ctrl Y is already one of its keys" });
  });

  it("is a clash, naming the command that holds the key, when another command has it", () => {
    expect(give({}, "edit.search", "Ctrl S")).toEqual({ kind: "clash", key: "Ctrl S", holder: "file.save" });
    expect(give({ "file.open-project": ["F4"] }, "file.new-scene", "F4")).toEqual({ kind: "clash", key: "F4", holder: "file.open-project" });
  });

  it("moves the key when it is taken, in one change: the holder loses it, the others of its keys stay", () => {
    expect(give({}, "edit.search", "Ctrl S", "replace", true)).toEqual({
      kind: "done",
      keymap: { "edit.search": ["Ctrl S"], "file.save": [] },
      took: { command: "file.save", key: "Ctrl S" },
    });
    const taken = give({}, "edit.search", "Ctrl Y", "replace", true);
    expect(taken).toMatchObject({ kind: "done", keymap: { "edit.redo": ["Ctrl Shift Z"], "edit.search": ["Ctrl Y"] } });
  });

  it("leaves the keymap with every key held once after a take", () => {
    const result = give({}, "edit.search", "Ctrl S", "replace", true);
    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    const now = effectiveKeys(SHORTCUTS, result.keymap, known);
    expect(now.taken).toEqual([]);
    expect(shortcutFor(press("s", { ctrlKey: true }), now.shortcuts)?.command).toBe("edit.search");
  });

  it("holds a command to four keys", () => {
    expect(MOST_KEYS_PER_COMMAND).toBe(4);
    const four = { "file.open-project": ["F1", "F2", "F3", "F4"] };
    expect(give(four, "file.open-project", "F5", "add")).toEqual({ kind: "refused", reason: "a command has at most 4 keys: remove one first" });
    expect(give(four, "file.open-project", "F5", "replace")).toMatchObject({ kind: "done" });
  });

  it("refuses a key that is not one, and a command this build does not have", () => {
    expect(give({}, "file.save", "Escape")).toEqual({ kind: "refused", reason: "Escape is not a key a command can be given" });
    expect(give({}, "future.command", "F8")).toEqual({ kind: "refused", reason: "future.command is not a command this build has" });
  });

  it("keeps only what differs from the defaults: giving a command back its own keys leaves no entry", () => {
    expect(give({ "edit.redo": ["F3"] }, "edit.redo", "Ctrl Shift Z", "replace")).toEqual({ kind: "done", keymap: { "edit.redo": ["Ctrl Shift Z"] } });
    const result = give({ "edit.redo": ["Ctrl Shift Z"] }, "edit.redo", "Ctrl Y", "add");
    // Ctrl Shift Z and Ctrl Y are its defaults, in order: nothing differs, so nothing is stored.
    expect(result).toEqual({ kind: "done", keymap: {} });
    expect(tidy({ "edit.redo": ["Ctrl Shift Z", "Ctrl Y"], "file.save": ["F2"] }, SHORTCUTS)).toEqual({ "file.save": ["F2"] });
  });
});

describe("taking a key off a command, and putting commands back", () => {
  it("removes one key and keeps the command's others", () => {
    expect(removeKey({}, SHORTCUTS, known, "edit.redo", "Ctrl Y")).toEqual({ "edit.redo": ["Ctrl Shift Z"] });
  });

  it("leaves a command with no key when its last one is removed", () => {
    expect(removeKey({}, SHORTCUTS, known, "file.save", "Ctrl S")).toEqual({ "file.save": [] });
  });

  it("changes nothing for a key the command does not have", () => {
    const keymap = { "file.save": ["F2"] };
    expect(removeKey(keymap, SHORTCUTS, known, "file.save", "Ctrl S")).toBe(keymap);
  });

  it("puts one command back to its defaults and leaves the others", () => {
    expect(resetKey({ "file.save": ["F2"], "edit.redo": ["F3"] }, "file.save")).toEqual({ "edit.redo": ["F3"] });
    const unchanged = { "edit.redo": ["F3"] };
    expect(resetKey(unchanged, "file.save")).toBe(unchanged);
  });

  it("drops the entry of a command this build does not have", () => {
    expect(resetKey({ "future.command": ["F8"], "edit.redo": ["F3"] }, "future.command")).toEqual({ "edit.redo": ["F3"] });
  });

  it("gets back a key another command took when that command is reset", () => {
    const taken = assignKey({}, SHORTCUTS, known, "edit.search", "Ctrl S", { mode: "replace", take: true });
    expect(taken.kind).toBe("done");
    if (taken.kind !== "done") return;
    const after = effectiveKeys(SHORTCUTS, resetKey(taken.keymap, "edit.search"), known);
    // edit.search is back to Ctrl K; file.save still has none, because its own entry says so, until it is reset too.
    expect(after.keys.get("edit.search")).toEqual(["Ctrl K"]);
    expect(after.keys.get("file.save")).toEqual([]);
    expect(effectiveKeys(SHORTCUTS, resetKey(resetKey(taken.keymap, "edit.search"), "file.save"), known).keys.get("file.save")).toEqual(["Ctrl S"]);
  });
});

describe("the Editor's own keys", () => {
  it("are listed once each per command", () => {
    const by = defaultKeys(SHORTCUTS);
    expect(by.get("edit.pen")).toEqual(["G", "P"]);
    expect(by.get("motion.delete-keys")).toEqual(["Delete", "Backspace"]);
    const shortcuts: readonly Shortcut[] = SHORTCUTS;
    expect(shortcuts.length).toBeGreaterThan(30);
  });

  it("are listed once even if a table repeats one", () => {
    const twice: readonly Shortcut[] = [
      { chord: { key: "s", ctrl: true, shift: false }, command: "a.b" },
      { chord: { key: "s", ctrl: true, shift: false }, command: "a.b" },
    ];
    expect(defaultKeys(twice).get("a.b")).toEqual(["Ctrl S"]);
  });
});
