// The one command list (11.31): what can run now and why not, which key is which command, and that no command is
// reachable by a shortcut alone.
import { describe, expect, it } from "vitest";
import { ARRANGE_COMMANDS } from "../src/arrange";
import page from "../web/main.ts?raw";
import { actionOf, allCommands } from "../src/app-menu";
import {
  BUSY_REASON,
  CHANGES_DOCUMENT,
  EMPTY_CONTEXT,
  SHORTCUTS,
  commandActions,
  commandById,
  decideKey,
  refusalLine,
  shortcutFor,
  unavailable,
  type CommandContext,
  type KeyFocus,
  type KeyPress,
} from "../src/command-registry";

const open: CommandContext = {
  ...EMPTY_CONTEXT,
  sceneOpen: true,
  projectOpen: true,
  selectionCount: 2,
  canUndo: true,
  canRedo: true,
  selectedKeyCount: 1,
  copiedKeyCount: 1,
  presetChosen: true,
};

const press = (key: string, more: Partial<KeyPress> = {}): KeyPress => ({
  key,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  repeat: false,
  defaultPrevented: false,
  ...more,
});
const nowhere: KeyFocus = { editing: false, control: false };

describe("whether a command can run", () => {
  it("says why when nothing is open", () => {
    expect(unavailable("file.save", EMPTY_CONTEXT)).toBe("no scene is open");
    expect(unavailable("file.close-project", EMPTY_CONTEXT)).toBe("no project is open");
    expect(unavailable("edit.delete", EMPTY_CONTEXT)).toBe("no scene is open");
    expect(unavailable("edit.undo", EMPTY_CONTEXT)).toBe("there is nothing to undo");
    expect(unavailable("edit.redo", EMPTY_CONTEXT)).toBe("there is nothing to redo");
  });

  it("can run when what it needs is there", () => {
    for (const id of ["file.save", "file.next-version", "edit.undo", "edit.redo", "edit.delete", "motion.delete-keys", "motion.paste-keys"]) {
      expect(unavailable(id, open), id).toBeUndefined();
    }
  });

  it("applies a preset only to a selected object with a preset chosen, in the page's own words", () => {
    for (const id of ["motion.preset-in", "motion.preset-out"]) {
      expect(unavailable(id, open), id).toBeUndefined();
      expect(unavailable(id, { ...open, selectionCount: 0 }), id).toBe("select an object to apply a preset to");
      expect(unavailable(id, { ...open, presetChosen: false }), id).toBe("choose a preset first");
      expect(unavailable(id, { ...open, selectionCount: 0, presetChosen: false }), id).toBe("select an object to apply a preset to");
    }
  });

  it("opens the change history with no scene, as its button does", () => {
    expect(unavailable("edit.history", EMPTY_CONTEXT)).toBeUndefined();
  });

  it("undoes only with something to undo and redoes only with something to redo", () => {
    expect(unavailable("edit.undo", { ...open, canUndo: true, canRedo: false })).toBeUndefined();
    expect(unavailable("edit.redo", { ...open, canUndo: true, canRedo: false })).toBe("there is nothing to redo");
    expect(unavailable("edit.undo", { ...open, canUndo: false, canRedo: true })).toBe("there is nothing to undo");
    expect(unavailable("edit.redo", { ...open, canUndo: false, canRedo: true })).toBeUndefined();
  });

  it("saves a copy of the project with a project open, scene or not, and not without one", () => {
    expect(unavailable("file.save-as", { ...EMPTY_CONTEXT, projectOpen: true })).toBeUndefined();
    expect(unavailable("file.close-project", { ...EMPTY_CONTEXT, projectOpen: true })).toBeUndefined();
    expect(unavailable("file.save-as", { ...EMPTY_CONTEXT, sceneOpen: true })).toBe("no project is open");
    expect(unavailable("file.save", { ...EMPTY_CONTEXT, projectOpen: true })).toBe("no scene is open");
  });

  it("needs a selected object to duplicate, rename or delete, and says to select one", () => {
    const none = { ...open, selectionCount: 0 };
    for (const id of ["edit.duplicate", "edit.rename", "edit.delete"]) expect(unavailable(id, none), id).toBe("select an object first");
  });

  it("renames one object at a time and says so when there are several", () => {
    expect(unavailable("edit.rename", { ...open, selectionCount: 2 })).toBe("select one object to rename");
    expect(unavailable("edit.rename", { ...open, selectionCount: 1 })).toBeUndefined();
    expect(unavailable("edit.duplicate", { ...open, selectionCount: 2 })).toBeUndefined();
  });

  it("needs selected keys for the key commands and copied keys to paste", () => {
    const none = { ...open, selectedKeyCount: 0, copiedKeyCount: 0 };
    for (const id of ["motion.easy-ease", "motion.easy-ease-in", "motion.easy-ease-out", "motion.delete-keys", "motion.copy-keys"]) {
      expect(unavailable(id, none), id).toBe("select a key on the timeline first");
    }
    expect(unavailable("motion.paste-keys", none)).toBe("no keys are copied");
  });

  it("refuses an edit while another is still being applied", () => {
    const busy = { ...open, busy: true };
    for (const id of ["file.save", "file.next-version", "edit.undo", "edit.redo", "edit.delete", "motion.easy-ease", "motion.paste-keys"]) {
      expect(unavailable(id, busy), id).toBe("an edit is still being applied");
    }
  });

  it("uses the arrange commands' own words for a line-up that cannot run", () => {
    const context: CommandContext = { ...open, arrangeRefusal: () => "select at least two objects" };
    expect(unavailable("edit.line-up.left", context)).toBe("select at least two objects");
    expect(unavailable("edit.line-up.spread-down", context)).toBe("select at least two objects");
    expect(unavailable("edit.line-up.left", open)).toBeUndefined();
  });

  it("covers every line-up and spread command", () => {
    for (const command of ARRANGE_COMMANDS) {
      const id = `edit.line-up.${command.replace(/^line-/, "")}`;
      expect(commandById(id), id).toBeDefined();
      expect(unavailable(id, EMPTY_CONTEXT), id).toBe("no scene is open");
    }
  });

  it("says a command that waits for its plan row is not built, and names the row", () => {
    expect(unavailable("edit.scripts", open)).toBe("not built yet (plan row 16.4)");
  });

  it("refuses an id that is not a command, by name", () => {
    expect(unavailable("edit.nothing", open)).toBe("there is no command edit.nothing");
  });

  it("gives every built command a reason that is words, or none", () => {
    for (const command of allCommands()) {
      const reason = unavailable(command.id, EMPTY_CONTEXT);
      if (reason !== undefined) expect(reason.length, command.id).toBeGreaterThan(5);
    }
  });

  it("writes one Activity line for a refusal, the same for the menu and a key", () => {
    expect(refusalLine("edit.delete", "select an object first")).toBe("Delete: select an object first");
    expect(refusalLine("file.save-as", "no project is open")).toBe("Save as: no project is open");
  });
});

describe("the agent's view of the commands", () => {
  it("offers every menu command with its reason when it cannot run", () => {
    const actions = commandActions(EMPTY_CONTEXT);
    expect(actions.map((a) => a.name)).toEqual(allCommands().map((c) => c.id));
    const save = actions.find((a) => a.name === "file.save");
    expect(save?.unavailable).toBe("no scene is open");
    const open_ = commandActions(open).find((a) => a.name === "file.save");
    expect(open_).toEqual({ name: "file.save", label: "Save" });
  });
});

describe("which key is which command", () => {
  it("never has one chord for two commands", () => {
    const seen = new Map<string, string>();
    for (const s of SHORTCUTS) {
      const chord = `${s.chord.ctrl ? "ctrl+" : ""}${s.chord.shift ? "shift+" : ""}${s.chord.key}`;
      expect(seen.get(chord), `${chord} is used twice`).toBeUndefined();
      seen.set(chord, s.command);
    }
  });

  it("reaches no command that the menu does not have", () => {
    for (const s of SHORTCUTS) {
      const command = commandById(s.command);
      expect(command, `${s.command} has a menu item`).toBeDefined();
      expect(actionOf(command!), `${s.command} is built`).not.toBe("unbuilt");
    }
  });

  it("writes each menu shortcut from the table, and every menu shortcut is in the table", () => {
    const labelled = new Map(SHORTCUTS.filter((s) => s.label !== undefined).map((s) => [s.command, s.label]));
    for (const command of allCommands()) {
      expect(command.shortcut, command.id).toBe(labelled.get(command.id));
    }
    for (const [id] of labelled) expect(commandById(id)?.shortcut, id).toBeDefined();
  });

  it("runs each key command through the menu action that does that job and no other", () => {
    const natives: Record<string, string> = {
      "motion.easy-ease": "easy-ease",
      "motion.easy-ease-in": "easy-ease-in",
      "motion.easy-ease-out": "easy-ease-out",
      "motion.delete-keys": "delete-keys",
      "motion.copy-keys": "copy-keys",
      "motion.paste-keys": "paste-keys",
      "file.save": "save",
      "file.next-version": "save-next-version",
    };
    for (const [id, native] of Object.entries(natives)) expect(commandById(id)?.native, id).toBe(native);
    expect(commandById("motion.play")?.invoke).toBe("preview-play");
    expect(commandById("edit.undo")?.invoke).toBe("undo");
    expect(commandById("edit.redo")?.invoke).toBe("redo");
  });

  it("matches a press by key and modifiers, ignoring case, and treats Cmd as Ctrl", () => {
    expect(shortcutFor(press("S", { ctrlKey: true }))?.command).toBe("file.save");
    expect(shortcutFor(press("s", { metaKey: true, shiftKey: true }))?.command).toBe("file.next-version");
    expect(shortcutFor(press("z", { ctrlKey: true }))?.command).toBe("edit.undo");
    expect(shortcutFor(press("Z", { ctrlKey: true, shiftKey: true }))?.command).toBe("edit.redo");
    expect(shortcutFor(press("y", { ctrlKey: true }))?.command).toBe("edit.redo");
    expect(shortcutFor(press(" "))?.command).toBe("motion.play");
    expect(shortcutFor(press("F9", { shiftKey: true }))?.command).toBe("motion.easy-ease-in");
    expect(shortcutFor(press("F9", { ctrlKey: true, shiftKey: true }))?.command).toBe("motion.easy-ease-out");
    expect(shortcutFor(press("Backspace"))?.command).toBe("motion.delete-keys");
  });

  it("does not match with Alt held, or with the wrong modifiers", () => {
    expect(shortcutFor(press("s", { ctrlKey: true, altKey: true }))).toBeUndefined();
    expect(shortcutFor(press("s"))).toBeUndefined();
    expect(shortcutFor(press(" ", { ctrlKey: true }))).toBeUndefined();
    expect(shortcutFor(press("x", { ctrlKey: true }))).toBeUndefined();
  });
});

describe("what a key press does", () => {
  it("runs the command when it can run", () => {
    expect(decideKey(press("s", { ctrlKey: true }), nowhere, open)).toEqual({ kind: "run", command: "file.save" });
    expect(decideKey(press(" "), nowhere, open)).toEqual({ kind: "run", command: "motion.play" });
  });

  it("selects the Pen with G (After Effects) and with P (Illustrator), and the path tool with A (11.116)", () => {
    expect(decideKey(press("g"), nowhere, open)).toEqual({ kind: "run", command: "edit.pen" });
    expect(decideKey(press("p"), nowhere, open)).toEqual({ kind: "run", command: "edit.pen" });
    expect(decideKey(press("a"), nowhere, open)).toEqual({ kind: "run", command: "edit.path" });
    expect(decideKey(press("v"), nowhere, open)).toEqual({ kind: "run", command: "edit.pointer" });
    // Typing a P in a text field is typing.
    expect(decideKey(press("p"), { editing: true, control: false }, open)).toEqual({ kind: "pass" });
  });

  it("gives the same reason as the menu when it cannot run, and runs the keys that always can", () => {
    for (const s of SHORTCUTS) {
      const decision = decideKey(
        press(s.chord.key, { ctrlKey: s.chord.ctrl, shiftKey: s.chord.shift }),
        nowhere,
        EMPTY_CONTEXT,
      );
      const reason = unavailable(s.command, EMPTY_CONTEXT);
      if (reason === undefined) {
        // The Select tool can be chosen with nothing open.
        expect(decision, `${s.command} with nothing open`).toEqual({ kind: "run", command: s.command });
      } else {
        expect(decision.kind, `${s.command} with nothing open`).toBe("refused");
        if (decision.kind === "refused") {
          expect(decision.command).toBe(s.command);
          expect(decision.reason, s.command).toBe(reason);
        }
      }
    }
    expect(unavailable("edit.pointer", EMPTY_CONTEXT)).toBeUndefined();
    for (const id of ["edit.move", "edit.rotate", "edit.resize"]) expect(unavailable(id, EMPTY_CONTEXT), id).toBe("no scene is open");
  });

  it("never takes a key from a text field", () => {
    const typing: KeyFocus = { editing: true, control: false };
    for (const s of SHORTCUTS) {
      const decision = decideKey(press(s.chord.key, { ctrlKey: s.chord.ctrl, shiftKey: s.chord.shift }), typing, open);
      expect(decision, s.command).toEqual({ kind: "pass" });
    }
  });

  it("leaves Space to a focused button or slider, but not the other keys", () => {
    const onButton: KeyFocus = { editing: false, control: true };
    expect(decideKey(press(" "), onButton, open)).toEqual({ kind: "pass" });
    expect(decideKey(press("Delete"), onButton, open)).toEqual({ kind: "run", command: "motion.delete-keys" });
    expect(decideKey(press("s", { ctrlKey: true }), onButton, open)).toEqual({ kind: "run", command: "file.save" });
  });

  it("is quiet about the keys that have other jobs, and says why for the rest", () => {
    const none = { ...open, selectedKeyCount: 0, copiedKeyCount: 0 };
    expect(decideKey(press("c", { ctrlKey: true }), nowhere, none)).toMatchObject({ kind: "refused", quiet: true });
    expect(decideKey(press("v", { ctrlKey: true }), nowhere, none)).toMatchObject({ kind: "refused", quiet: true });
    expect(decideKey(press("Backspace"), nowhere, none)).toMatchObject({ kind: "refused", quiet: true });
    expect(decideKey(press("Delete"), nowhere, none)).toMatchObject({ kind: "refused", quiet: true });
    expect(decideKey(press("F9"), nowhere, none)).toMatchObject({ kind: "refused", quiet: false, reason: "select a key on the timeline first" });
    expect(decideKey(press("s", { ctrlKey: true }), nowhere, EMPTY_CONTEXT)).toMatchObject({ kind: "refused", quiet: false });
  });

  it("does not repeat on a held key, except undo and redo, and leaves a key something else already handled", () => {
    expect(decideKey(press("s", { ctrlKey: true, repeat: true }), nowhere, open)).toEqual({ kind: "pass" });
    expect(decideKey(press(" ", { repeat: true }), nowhere, open)).toEqual({ kind: "pass" });
    expect(decideKey(press("z", { ctrlKey: true, repeat: true }), nowhere, open)).toEqual({ kind: "run", command: "edit.undo" });
    expect(decideKey(press("z", { ctrlKey: true, shiftKey: true, repeat: true }), nowhere, open)).toEqual({ kind: "run", command: "edit.redo" });
    expect(decideKey(press("y", { ctrlKey: true, repeat: true }), nowhere, open)).toEqual({ kind: "run", command: "edit.redo" });
    expect(decideKey(press("s", { ctrlKey: true, defaultPrevented: true }), nowhere, open)).toEqual({ kind: "pass" });
  });

  it("is silent about the tool letters with no scene open, since they have nothing to say", () => {
    for (const letter of ["w", "e", "r"]) {
      expect(decideKey(press(letter), nowhere, EMPTY_CONTEXT), letter).toMatchObject({ kind: "refused", reason: "no scene is open", quiet: true });
    }
    expect(decideKey(press("w"), nowhere, open)).toEqual({ kind: "run", command: "edit.move" });
    expect(decideKey(press("v"), nowhere, EMPTY_CONTEXT)).toEqual({ kind: "run", command: "edit.pointer" });
  });

  it("is silent when a key is refused only because an edit is still being applied", () => {
    const busy = { ...open, busy: true };
    expect(decideKey(press("z", { ctrlKey: true }), nowhere, busy)).toEqual({ kind: "refused", command: "edit.undo", reason: BUSY_REASON, quiet: true });
    expect(decideKey(press("s", { ctrlKey: true }), nowhere, busy)).toMatchObject({ kind: "refused", reason: BUSY_REASON, quiet: true });
    // The menu still says it.
    expect(unavailable("edit.undo", busy)).toBe(BUSY_REASON);
  });

  it("passes a key that is not a command", () => {
    expect(decideKey(press("q"), nowhere, open)).toEqual({ kind: "pass" });
    expect(decideKey(press("Tab"), nowhere, open)).toEqual({ kind: "pass" });
  });
});

describe("commands that change the document", () => {
  it("are all real, built commands", () => {
    for (const id of CHANGES_DOCUMENT) {
      const command = commandById(id);
      expect(command, id).toBeDefined();
      expect(actionOf(command!), id).not.toBe("unbuilt");
    }
  });

  it("include every key command that edits the timeline and none that only reads", () => {
    for (const id of ["motion.easy-ease", "motion.easy-ease-in", "motion.easy-ease-out", "motion.delete-keys", "motion.paste-keys"]) {
      expect(CHANGES_DOCUMENT.has(id), id).toBe(true);
    }
    for (const id of ["motion.copy-keys", "motion.play", "file.save", "edit.history"]) expect(CHANGES_DOCUMENT.has(id), id).toBe(false);
  });
});

describe("the page uses the one list", () => {
  it("decides every key through the registry and keeps no other handler for the shortcuts", () => {
    expect(page).toContain('document.addEventListener("keydown", onCommandKey)');
    expect(page).toContain("decideKey(event, keyFocus(event), commandContext())");
    for (const gone of ["saveShortcut(", "onTimelineKeyDown", "onPreviewShortcut", 'event.key === "F9"']) {
      expect(page, `${gone} is gone: the table decides`).not.toContain(gone);
    }
  });

  it("asks the registry before a menu item runs, and says the reason in Activity", () => {
    expect(page).toContain("commandUnavailable(itemId, commandContext())");
    expect(page).toContain("log(refusalLine(itemId, refusal)");
    expect(page).toContain("showMenuStates(menu)");
  });

  it("has an action for every native item the menu names, so none is a dead click", () => {
    for (const command of allCommands()) {
      if (command.native === undefined || command.native.startsWith("arrange-")) continue;
      expect(page, `${command.id} runs "${command.native}"`).toContain(`case "${command.native}":`);
    }
  });

  it("copies selected text as text, not as keys", () => {
    expect(page).toMatch(/event\.key\.toLowerCase\(\) === "c" && \(window\.getSelection\(\)\?\.toString\(\) \?\? ""\) !== ""\) return;/);
  });

  it("says a refused key in Activity unless it is quiet, and takes Ctrl+S from the browser", () => {
    expect(page).toMatch(/if \(decision\.quiet\) return;[\s\S]*?log\(refusalLine\(decision\.command, decision\.reason\), "bad"\);/);
    expect(page).toMatch(/if \(event\.ctrlKey \|\| event\.metaKey\) event\.preventDefault\(\);/);
  });

  it("stops a menu click that the registry refuses and writes the reason", () => {
    expect(page).toMatch(/if \(itemId !== undefined && refusal !== undefined\) \{\s*log\(refusalLine\(itemId, refusal\), "bad"\);[\s\S]*?return;/);
  });

  it("does each key edit the way its name says", () => {
    expect(page).toMatch(/case "easy-ease":\s*easeKeys\("both"\);/);
    expect(page).toMatch(/case "easy-ease-in":\s*easeKeys\("in"\);/);
    expect(page).toMatch(/case "easy-ease-out":\s*easeKeys\("out"\);/);
    expect(page).toMatch(/function deleteKeys\(\): void \{[\s\S]*?planDelete\(\[\.\.\.selectedKeys\]\)[\s\S]*?setKeySelection\(\[\]\);/);
    expect(page).toMatch(/function pasteKeys\(\): void \{[\s\S]*?planPaste\([\s\S]*?keyClipboard, currentFrame\)/);
    expect(page).toMatch(/function copyKeys\(\): void \{[\s\S]*?keyClipboard = planCopy\(/);
  });

  it("keeps undo and redo scoped to the panel that has focus, as the keys always were", () => {
    expect(page).toContain('void (id === "edit.undo" ? undo(focusedPanelModule()) : redo(focusedPanelModule()))');
  });
});

