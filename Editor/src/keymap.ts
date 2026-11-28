// Changing a key (plan row 11.84): the person's keymap on top of the Editor's own table of chords.
//
// Asked of Jev and Laya before it was written (docs/evidence/11.84/jev-laya-keys.json). The rules they chose, and this file keeps:
//   - the keymap is the user setting `shortcuts`: a command id to the keys that command has now. Present means those keys REPLACE the
//     command's defaults entirely (so the page shows exactly the keys it has), an empty list means no key, absent means the defaults;
//   - a key has one handler. Giving a key another command holds is refused by name, and "Take it" moves it in one change;
//   - Escape, Enter and Tab cannot be given to a command (dialogs and the focus order use them), and Alt is not read;
//   - a command id this build does not have is ignored for key handling and kept, so it can be seen and removed.
//
// Pure: no DOM, no shell. The contract (`Shared/contracts/src/settings.rs`, `check_chord`) checks the same grammar when the setting is
// saved; a key that fails it here is treated as unreadable, never as a different key.

import type { Chord, KeyPress, Shortcut } from "./command-registry";

/** The settings value: only the commands the person changed. */
export type Keymap = Readonly<Record<string, readonly string[]>>;

/** Most keys one command may have (the contract's limit). */
export const MOST_KEYS_PER_COMMAND = 4;

/** The keys a chord may end in, by the name the menus show and the lower-case `KeyboardEvent.key` the Editor matches. */
const NAMED_KEYS: readonly (readonly [label: string, key: string])[] = [
  ["Space", " "],
  ["Delete", "delete"],
  ["Backspace", "backspace"],
  ["Home", "home"],
  ["End", "end"],
  ["PageUp", "pageup"],
  ["PageDown", "pagedown"],
  ["Left", "arrowleft"],
  ["Right", "arrowright"],
  ["Up", "arrowup"],
  ["Down", "arrowdown"],
];
const PUNCTUATION = "=-+[],./;'`\\";

/** The key's name as the menus write it: `S`, `7`, `F9`, `Space`, `Left`, `=`. */
export function keyLabel(key: string): string {
  const named = NAMED_KEYS.find(([, name]) => name === key);
  if (named !== undefined) return named[0];
  return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
}

/** A chord as the menus write it, modifiers first: `Ctrl Shift S`. */
export function chordLabel(chord: Chord): string {
  return [chord.ctrl ? "Ctrl" : "", chord.shift ? "Shift" : "", keyLabel(chord.key)].filter((part) => part !== "").join(" ");
}

/** The chord a written key is, or undefined when it is not one the Editor can use (the same grammar the contract checks). */
export function parseChord(label: string): Chord | undefined {
  const words = label.split(" ");
  const name = words.pop() ?? "";
  let ctrl = false;
  let shift = false;
  const modifiers = [...words];
  if (modifiers[0] === "Ctrl") {
    ctrl = true;
    modifiers.shift();
  }
  if (modifiers[0] === "Shift") {
    shift = true;
    modifiers.shift();
  }
  if (modifiers.length > 0 || name === "") return undefined;
  const named = NAMED_KEYS.find(([text]) => text === name);
  let key: string | undefined = named?.[1];
  if (key === undefined && /^F([1-9]|1[0-2])$/.test(name)) key = name.toLowerCase();
  if (key === undefined && name.length === 1 && (/^[A-Z0-9]$/.test(name) || PUNCTUATION.includes(name))) key = name.toLowerCase();
  return key === undefined ? undefined : { key, ctrl, shift };
}

/** What a key press means while a key is being recorded. */
export type Recorded =
  | { readonly kind: "wait" }
  | { readonly kind: "cancel" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "chord"; readonly chord: Chord; readonly label: string };

const MODIFIER_KEYS: ReadonlySet<string> = new Set(["control", "shift", "meta", "alt", "altgraph", "capslock", "os"]);

/** Read the key a person pressed to give a command: a modifier alone waits for the key, Escape cancels, and what cannot be a key says why. */
export function recordKey(press: Pick<KeyPress, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): Recorded {
  const lower = press.key.toLowerCase();
  if (MODIFIER_KEYS.has(lower)) return { kind: "wait" };
  if (lower === "escape") return { kind: "cancel" };
  if (lower === "enter" || lower === "tab") {
    return { kind: "refused", reason: `${press.key === "Enter" ? "Enter" : "Tab"} cannot be given to a command: dialogs and the focus order use it` };
  }
  if (press.altKey) return { kind: "refused", reason: "Alt is not read for keys here: use Ctrl and Shift" };
  const chord: Chord = { key: lower, ctrl: press.ctrlKey || press.metaKey, shift: press.shiftKey };
  const label = chordLabel(chord);
  if (parseChord(label) === undefined) {
    const shifted = press.shiftKey && lower.length === 1 && !/^[a-z]$/.test(lower);
    return {
      kind: "refused",
      reason: shifted
        ? `${press.key} is a shifted key, and the Editor cannot tell it from the key itself: use a letter, a digit or an F key`
        : `${press.key.length === 1 ? press.key : label} is not a key a command can be given`,
    };
  }
  return { kind: "chord", chord, label };
}

/** The keys the Editor's own table gives each command, in the order the table lists them. */
export function defaultKeys(defaults: readonly Shortcut[]): ReadonlyMap<string, readonly string[]> {
  const by = new Map<string, string[]>();
  for (const { command, chord } of defaults) {
    const list = by.get(command) ?? [];
    const label = chordLabel(chord);
    if (!list.includes(label)) list.push(label);
    by.set(command, list);
  }
  return by;
}

export interface EffectiveKeys {
  /** The table the Editor handles keys by: defaults, with the person's changes applied. */
  readonly shortcuts: readonly Shortcut[];
  /** Each command's keys now, written out, for every known command that has any (a changed command with none is listed with an empty list). */
  readonly keys: ReadonlyMap<string, readonly string[]>;
  /** Commands the person changed. */
  readonly changed: ReadonlySet<string>;
  /** Keymap entries for commands this build does not have: ignored here, and listed so they can be removed. */
  readonly unknown: readonly { readonly command: string; readonly keys: readonly string[] }[];
  /** Keys in the keymap that could not be read as keys (a hand-edited or newer file): ignored. */
  readonly unreadable: readonly { readonly command: string; readonly key: string }[];
  /** Default keys that a changed command took, so the command that had them no longer does. */
  readonly taken: readonly { readonly key: string; readonly from: string; readonly by: string }[];
}

/** The keys in force: the Editor's table, with every changed command's keys in place of its own and no key left with two handlers. */
export function effectiveKeys(defaults: readonly Shortcut[], keymap: Keymap, known: ReadonlySet<string>): EffectiveKeys {
  const defaultsBy = defaultKeys(defaults);
  const flagsOf = (command: string): Pick<Shortcut, "quiet" | "repeats" | "fromFields"> => {
    const first = defaults.find((shortcut) => shortcut.command === command);
    return first === undefined
      ? {}
      : { ...(first.quiet === true ? { quiet: true as const } : {}), ...(first.repeats === true ? { repeats: true as const } : {}), ...(first.fromFields === true ? { fromFields: true as const } : {}) };
  };
  const unknown: { command: string; keys: readonly string[] }[] = [];
  const unreadable: { command: string; key: string }[] = [];
  const changed = new Set<string>();
  const overridden = new Map<string, Chord[]>();
  for (const [command, labels] of Object.entries(keymap)) {
    if (!known.has(command) && !defaultsBy.has(command)) {
      unknown.push({ command, keys: labels });
      continue;
    }
    const chords: Chord[] = [];
    for (const label of labels) {
      const chord = parseChord(label);
      if (chord === undefined) unreadable.push({ command, key: label });
      else if (!chords.some((other) => chordLabel(other) === label)) chords.push(chord);
    }
    overridden.set(command, chords);
    changed.add(command);
  }
  // A key has one handler: where two changed commands hold one key, the first in the keymap's order keeps it.
  const claimed = new Map<string, string>();
  for (const [command, chords] of overridden) {
    overridden.set(
      command,
      chords.filter((chord) => {
        const label = chordLabel(chord);
        if (claimed.has(label)) return false;
        claimed.set(label, command);
        return true;
      }),
    );
  }

  const shortcuts: Shortcut[] = [];
  const taken: { key: string; from: string; by: string }[] = [];
  const keys = new Map<string, readonly string[]>();
  const order = [...defaultsBy.keys(), ...[...overridden.keys()].filter((command) => !defaultsBy.has(command))];
  for (const command of order) {
    const own = overridden.get(command);
    if (own !== undefined) {
      own.forEach((chord, index) => shortcuts.push({ chord, command, ...(index === 0 ? { label: chordLabel(chord) } : {}), ...flagsOf(command) }));
      keys.set(command, own.map(chordLabel));
      continue;
    }
    const kept: Shortcut[] = [];
    for (const shortcut of defaults.filter((candidate) => candidate.command === command)) {
      const by = claimed.get(chordLabel(shortcut.chord));
      if (by === undefined) kept.push(shortcut);
      else taken.push({ key: chordLabel(shortcut.chord), from: command, by });
    }
    // The menu shows the first key left; a default's label belonged to its first key, which may have been taken.
    kept.forEach((shortcut, index) => {
      const { label: _label, ...rest } = shortcut;
      shortcuts.push(index === 0 ? { ...rest, label: chordLabel(shortcut.chord) } : rest);
    });
    keys.set(command, kept.map((shortcut) => chordLabel(shortcut.chord)));
  }
  return { shortcuts, keys, changed, unknown, unreadable, taken };
}

/** What asking for a key came to. */
export type Assigned =
  | { readonly kind: "done"; readonly keymap: Keymap; readonly took?: { readonly command: string; readonly key: string } }
  | { readonly kind: "clash"; readonly key: string; readonly holder: string }
  | { readonly kind: "refused"; readonly reason: string };

/** Drop entries that say what the defaults already say, so the keymap holds only what was really changed. */
export function tidy(keymap: Keymap, defaults: readonly Shortcut[]): Keymap {
  const defaultsBy = defaultKeys(defaults);
  return Object.fromEntries(
    Object.entries(keymap).filter(([command, keys]) => {
      const own = defaultsBy.get(command) ?? [];
      return !(keys.length === own.length && keys.every((key, index) => key === own[index]));
    }),
  );
}

/** Give a command a key: `replace` makes it the command's only key, `add` puts it beside the ones it has. A key another command holds is a clash
 *  unless `take` is set, which removes it from that command in the same change. */
export function assignKey(
  keymap: Keymap,
  defaults: readonly Shortcut[],
  known: ReadonlySet<string>,
  command: string,
  key: string,
  options: { readonly mode: "replace" | "add"; readonly take?: boolean },
): Assigned {
  if (parseChord(key) === undefined) return { kind: "refused", reason: `${key} is not a key a command can be given` };
  if (!known.has(command) && !defaultKeys(defaults).has(command)) return { kind: "refused", reason: `${command} is not a command this build has` };
  const now = effectiveKeys(defaults, keymap, known);
  const own = now.keys.get(command) ?? [];
  if (own.includes(key)) return { kind: "refused", reason: `${key} is already ${own.length === 1 ? "its key" : "one of its keys"}` };
  const next: Record<string, readonly string[]> = { ...keymap };
  let holder: string | undefined;
  for (const [other, keys] of now.keys) if (other !== command && keys.includes(key)) holder = other;
  let took: { command: string; key: string } | undefined;
  if (holder !== undefined) {
    if (options.take !== true) return { kind: "clash", key, holder };
    next[holder] = (now.keys.get(holder) ?? []).filter((candidate) => candidate !== key);
    took = { command: holder, key };
  }
  const keep = options.mode === "add" ? own : [];
  const result = [...keep, key];
  if (result.length > MOST_KEYS_PER_COMMAND) {
    return { kind: "refused", reason: `a command has at most ${MOST_KEYS_PER_COMMAND} keys: remove one first` };
  }
  next[command] = result;
  return { kind: "done", keymap: tidy(next, defaults), ...(took === undefined ? {} : { took }) };
}

/** Take one key off a command. The command keeps its other keys, and with none left it has no key. */
export function removeKey(keymap: Keymap, defaults: readonly Shortcut[], known: ReadonlySet<string>, command: string, key: string): Keymap {
  const own = effectiveKeys(defaults, keymap, known).keys.get(command) ?? keymap[command] ?? [];
  if (!own.includes(key)) return keymap;
  return tidy({ ...keymap, [command]: own.filter((candidate) => candidate !== key) }, defaults);
}

/** Put one command back to its default keys, or drop the entry of a command this build does not have. */
export function resetKey(keymap: Keymap, command: string): Keymap {
  if (!(command in keymap)) return keymap;
  return Object.fromEntries(Object.entries(keymap).filter(([name]) => name !== command));
}
