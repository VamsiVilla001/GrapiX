// One list of commands behind every menu item, toolbar button, keyboard shortcut and agent action (plan row 11.31).
//
// The menu model (`app-menu.ts`) names every command, with its label and the one action it runs. This module adds
// the two things the menu model does not know:
//
//   - **Whether a command can run now, and if not, why.** `unavailable()` answers from a plain description of the
//     page's state (`CommandContext`). A greyed menu item, a refused shortcut and an unavailable agent action all use
//     that one answer, so they give the same reason in the same words.
//   - **Which key press is which command.** `SHORTCUTS` is the only table of chords. A key press is decided by
//     `decideKey()`, which never takes a key from a text field and never runs a command the registry says cannot run.
//
// No command is reachable by a shortcut alone: every chord below names a command that has a menu item, and the menu's
// shortcut label is written from this table (a test holds both ways).
//
// Nothing here touches the document. A command that changes it dispatches an editor command (11.36) from the page
// code the menu already points to; `CHANGES_DOCUMENT` names which ones, so a test can hold the list.

import type { Unavailable } from "./agent-surface";
import { ARRANGE_COMMANDS, type ArrangeCommand } from "./arrange";
import { allCommands, actionOf, type MenuCommand } from "./app-menu";

/** What the page knows that decides whether a command can run. Plain values, so the answer is testable without a page. */
export interface CommandContext {
  /** A scene is open in the active session. */
  readonly sceneOpen: boolean;
  /** A project is open. */
  readonly projectOpen: boolean;
  /** How many objects are selected. */
  readonly selectionCount: number;
  /** The active session has a change to undo, or one to redo. */
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** An edit is still being sent; a second would race it. */
  readonly busy: boolean;
  /** A motion preset is chosen in the timeline's preset list. */
  readonly presetChosen: boolean;
  /** How many keyframes are selected on the timeline, and how many are copied. */
  readonly selectedKeyCount: number;
  readonly copiedKeyCount: number;
  /** Why a line-up or spread cannot run on the current selection, in the words the arrange commands use. */
  readonly arrangeRefusal: (command: ArrangeCommand) => string | undefined;
}

/** A context with nothing open and nothing selected. Tests and the page start from it. */
export const EMPTY_CONTEXT: CommandContext = {
  sceneOpen: false,
  projectOpen: false,
  selectionCount: 0,
  canUndo: false,
  canRedo: false,
  busy: false,
  presetChosen: false,
  selectedKeyCount: 0,
  copiedKeyCount: 0,
  arrangeRefusal: () => undefined,
};

type Rule = (context: CommandContext) => Unavailable | undefined;

const needScene: Rule = (c) => (c.sceneOpen ? undefined : "no scene is open");
const needProject: Rule = (c) => (c.projectOpen ? undefined : "no project is open");
const needSelection: Rule = (c) => (c.selectionCount > 0 ? undefined : "select an object first");
const needOneObject: Rule = (c) => (c.selectionCount === 1 ? undefined : c.selectionCount === 0 ? "select an object first" : "select one object to rename");
const needKeys: Rule = (c) => (c.selectedKeyCount > 0 ? undefined : "select a key on the timeline first");
const needCopiedKeys: Rule = (c) => (c.copiedKeyCount > 0 ? undefined : "no keys are copied");
/** The reason a command is refused while an edit is still being sent. A key press is silent about it (a second press
 *  of Ctrl+Z a moment later is not an error), the menu says it. */
export const BUSY_REASON = "an edit is still being applied";
const needIdle: Rule = (c) => (c.busy ? BUSY_REASON : undefined);
const needObjectForPreset: Rule = (c) => (c.selectionCount > 0 ? undefined : "select an object to apply a preset to");
const needPreset: Rule = (c) => (c.presetChosen ? undefined : "choose a preset first");
const all =
  (...rules: readonly Rule[]): Rule =>
  (context) => {
    for (const rule of rules) {
      const reason = rule(context);
      if (reason !== undefined) return reason;
    }
    return undefined;
  };

/** What each command needs, by the menu command id. A command with no entry can always run. */
const RULES: Record<string, Rule> = {
  "file.save": all(needScene, needIdle),
  "file.save-as": needProject,
  "file.save-scene-file": needScene,
  "file.next-version": all(needScene, needIdle),
  "file.close-project": needProject,
  "file.playout.send": needScene,
  "edit.move": needScene,
  "edit.rotate": needScene,
  "edit.resize": needScene,
  "edit.centre": needScene,
  "edit.pen": all(needScene, needIdle),
  "edit.path": needScene,
  "edit.vertex-add": needScene,
  "edit.vertex-delete": needScene,
  "edit.vertex-convert": needScene,
  "edit.hand": needScene,
  "edit.zoom": needScene,
  "layout.fit": needScene,
  "layout.zoom-in": needScene,
  "layout.zoom-out": needScene,
  "layout.zoom-100": needScene,
  "edit.undo": all(needIdle, (c) => (c.canUndo ? undefined : "there is nothing to undo")),
  "edit.redo": all(needIdle, (c) => (c.canRedo ? undefined : "there is nothing to redo")),
  "edit.duplicate": all(needScene, needSelection, needIdle),
  "edit.rename": all(needScene, needOneObject, needIdle),
  "edit.delete": all(needScene, needSelection, needIdle),
  "edit.join": all(needScene, needSelection, needIdle),
  "edit.copy-svg": all(needScene, needOneObject, needIdle),
  "edit.add-object.rect": all(needScene, needIdle),
  "edit.add-object.ellipse": all(needScene, needIdle),
  "edit.add-object.text": all(needScene, needIdle),
  "motion.controls": needScene,
  "motion.curves": needScene,
  "motion.preset-in": all(needScene, needObjectForPreset, needPreset, needIdle),
  "motion.preset-out": all(needScene, needObjectForPreset, needPreset, needIdle),
  "motion.play-phase": needScene,
  "motion.jump-hold": needScene,
  "motion.play": needScene,
  "motion.add-key": all(needScene, needSelection, needIdle),
  "motion.easy-ease": all(needScene, needKeys, needIdle),
  "motion.easy-ease-in": all(needScene, needKeys, needIdle),
  "motion.easy-ease-out": all(needScene, needKeys, needIdle),
  "motion.delete-keys": all(needScene, needKeys, needIdle),
  "motion.copy-keys": all(needScene, needKeys),
  "motion.paste-keys": all(needScene, needCopiedKeys, needIdle),
};

for (const command of ARRANGE_COMMANDS) {
  RULES[`edit.line-up.${command.replace(/^line-/, "")}`] = all(needScene, needIdle, (c) => c.arrangeRefusal(command));
}

/** The commands that change the open document. Each sends an editor command (11.36) from the page code its menu item
 *  points to; the boundary guard (11.36) fails a build that mutates by any other path. */
export const CHANGES_DOCUMENT: ReadonlySet<string> = new Set([
  "edit.undo",
  "edit.redo",
  "edit.duplicate",
  "edit.rename",
  "edit.delete",
  "edit.join",
  "edit.copy-svg",
  "edit.add-object.rect",
  "edit.add-object.ellipse",
  "edit.add-object.text",
  "edit.line-up.left",
  "edit.line-up.centre",
  "edit.line-up.right",
  "edit.line-up.top",
  "edit.line-up.middle",
  "edit.line-up.bottom",
  "edit.line-up.spread-across",
  "edit.line-up.spread-down",
  "motion.preset-in",
  "motion.preset-out",
  "motion.add-key",
  "motion.easy-ease",
  "motion.easy-ease-in",
  "motion.easy-ease-out",
  "motion.delete-keys",
  "motion.paste-keys",
]);

/** The menu command with this id, if the menu has one. */
export function commandById(id: string): MenuCommand | undefined {
  return allCommands().find((command) => command.id === id);
}

/** Why a command cannot run now, or `undefined` when it can. A command still waiting for its plan row says so. */
export function unavailable(id: string, context: CommandContext): Unavailable | undefined {
  const command = commandById(id);
  if (command === undefined) return `there is no command ${id}`;
  if (actionOf(command) === "unbuilt") return `not built yet (plan row ${command.row})`;
  return RULES[id]?.(context);
}

/** The Activity line for a command that was asked for and cannot run. The menu, a shortcut and an agent all say this. */
export function refusalLine(id: string, reason: Unavailable): string {
  const label = commandById(id)?.label ?? id;
  return `${label.replace(/…$/, "")}: ${reason}`;
}

/** Every command as an action an agent can be offered, with its reason when it cannot run. */
export function commandActions(context: CommandContext): readonly { name: string; label: string; unavailable?: Unavailable }[] {
  return allCommands().map((command) => {
    const reason = unavailable(command.id, context);
    return reason === undefined
      ? { name: command.id, label: command.label }
      : { name: command.id, label: command.label, unavailable: reason };
  });
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** A key and the modifiers it needs. `key` is lower case (`event.key.toLowerCase()`); Space is " ". */
export interface Chord {
  readonly key: string;
  readonly ctrl: boolean;
  readonly shift: boolean;
}

export interface Shortcut {
  readonly chord: Chord;
  readonly command: string;
  /** The label the menu shows for it. Aliases (a second key for one command) have none. */
  readonly label?: string;
  /** The key has other jobs too (copy, paste, Delete, Backspace). When the command cannot run the key is left alone
   *  and nothing is said. */
  readonly quiet?: true;
  /** A held key repeats the command (undo and redo step on while the keys are held); any other key is one press. */
  readonly repeats?: true;
  /** The chord works with a text field in focus (Ctrl K opens the search from anywhere). Every other chord leaves a text field alone. */
  readonly fromFields?: true;
}

const ctrl = (key: string, shift = false): Chord => ({ key, ctrl: true, shift });
const plain = (key: string, shift = false): Chord => ({ key, ctrl: false, shift });

/** The only table of chords. The menu's shortcut labels are written from it. */
export const SHORTCUTS: readonly Shortcut[] = [
  { chord: ctrl("k"), command: "edit.search", label: "Ctrl K", fromFields: true },
  { chord: ctrl("s"), command: "file.save", label: "Ctrl S" },
  { chord: ctrl("s", true), command: "file.next-version", label: "Ctrl Shift S" },
  { chord: ctrl("z"), command: "edit.undo", label: "Ctrl Z", repeats: true },
  { chord: ctrl("z", true), command: "edit.redo", label: "Ctrl Shift Z", repeats: true },
  { chord: ctrl("y"), command: "edit.redo", repeats: true },
  { chord: ctrl("j"), command: "edit.join", label: "Ctrl J", quiet: true },
  { chord: plain(" "), command: "motion.play", label: "Space" },
  { chord: plain("k"), command: "motion.add-key", label: "K", quiet: true },
  { chord: plain("f9"), command: "motion.easy-ease", label: "F9" },
  { chord: plain("f9", true), command: "motion.easy-ease-in", label: "Shift F9" },
  { chord: ctrl("f9", true), command: "motion.easy-ease-out", label: "Ctrl Shift F9" },
  // Letters: with no scene open they have nothing to say, so a refused one is silent.
  { chord: plain("v"), command: "edit.pointer", label: "V", quiet: true },
  { chord: plain("w"), command: "edit.move", label: "W", quiet: true },
  { chord: plain("e"), command: "edit.rotate", label: "E", quiet: true },
  { chord: plain("r"), command: "edit.resize", label: "R", quiet: true },
  { chord: plain("y"), command: "edit.centre", label: "Y", quiet: true },
  { chord: plain("g"), command: "edit.pen", label: "G", quiet: true },
  // The Illustrator key for the Pen, beside After Effects' G (which also goes on through the pen family when pressed again).
  { chord: plain("p"), command: "edit.pen", quiet: true },
  { chord: plain("a"), command: "edit.path", label: "A", quiet: true },
  { chord: plain("="), command: "edit.vertex-add", label: "=", quiet: true },
  { chord: plain("-"), command: "edit.vertex-delete", label: "-", quiet: true },
  { chord: plain("c"), command: "edit.vertex-convert", label: "C", quiet: true },
  { chord: plain("h"), command: "edit.hand", label: "H", quiet: true },
  { chord: plain("z"), command: "edit.zoom", label: "Z", quiet: true },
  // The view: Ctrl 0 fits, Ctrl 1 is actual size, Ctrl = (or Ctrl +) zooms in and Ctrl - out. Held, in and out repeat.
  { chord: ctrl("0"), command: "layout.fit", label: "Ctrl 0" },
  { chord: ctrl("1"), command: "layout.zoom-100", label: "Ctrl 1" },
  { chord: ctrl("="), command: "layout.zoom-in", label: "Ctrl =", repeats: true },
  { chord: ctrl("+", true), command: "layout.zoom-in", repeats: true },
  { chord: ctrl("-"), command: "layout.zoom-out", label: "Ctrl -", repeats: true },
  { chord: plain("delete"), command: "motion.delete-keys", label: "Delete", quiet: true },
  { chord: plain("backspace"), command: "motion.delete-keys", quiet: true },
  { chord: ctrl("c"), command: "motion.copy-keys", label: "Ctrl C", quiet: true },
  { chord: ctrl("v"), command: "motion.paste-keys", label: "Ctrl V", quiet: true },
];

/** The part of a key event the decision needs. */
export interface KeyPress {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly repeat: boolean;
  readonly defaultPrevented: boolean;
}

/** Where the key went. `editing`: a text field, list or text area has focus and the key belongs to it. `control`: a
 *  button, link or slider has focus, which owns Space for itself. */
export interface KeyFocus {
  readonly editing: boolean;
  readonly control: boolean;
}

export type KeyDecision =
  | { readonly kind: "pass" }
  /** `quiet`: the key has other jobs, or the refusal is only that an edit is still being applied: nothing is said. */
  | { readonly kind: "refused"; readonly command: string; readonly reason: Unavailable; readonly quiet: boolean }
  | { readonly kind: "run"; readonly command: string };

/** The shortcut a key press is, if any, in the table given (the person's keys on top of the Editor's own, `effectiveKeys` in keymap.ts) or `SHORTCUTS`. */
export function shortcutFor(press: KeyPress, shortcuts: readonly Shortcut[] = SHORTCUTS): Shortcut | undefined {
  if (press.altKey) return undefined;
  const control = press.ctrlKey || press.metaKey;
  const key = press.key.toLowerCase();
  return shortcuts.find((s) => s.chord.key === key && s.chord.ctrl === control && s.chord.shift === press.shiftKey);
}

/** What to do with a key press: leave it to the page (`pass`), say a command cannot run (`refused`), or run it.
 *
 *  A key never leaves a text field, and Space never leaves a button or slider. A held key is not a second press, except
 *  for undo and redo. A key something else already handled is left alone. The command is never run when the registry
 *  says it cannot. */
export function decideKey(press: KeyPress, focus: KeyFocus, context: CommandContext, shortcuts: readonly Shortcut[] = SHORTCUTS): KeyDecision {
  if (press.defaultPrevented) return { kind: "pass" };
  const shortcut = shortcutFor(press, shortcuts);
  if (shortcut === undefined) return { kind: "pass" };
  if (focus.editing && shortcut.fromFields !== true) return { kind: "pass" };
  if (press.repeat && shortcut.repeats !== true) return { kind: "pass" };
  if (focus.control && shortcut.chord.key === " ") return { kind: "pass" };
  const reason = unavailable(shortcut.command, context);
  return reason === undefined
    ? { kind: "run", command: shortcut.command }
    : { kind: "refused", command: shortcut.command, reason, quiet: shortcut.quiet === true || reason === BUSY_REASON };
}
