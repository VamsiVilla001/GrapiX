// The Shortcuts page of the Settings window (plan row 11.81, Figma E4; changing a key is row 11.84): what the Editor's keys are,
// drawn from the one table the Editor itself reads (`SHORTCUTS` in command-registry.ts), never from a copy.
//
// Pure: no DOM, no shell. A command may have more than one key (Redo has Ctrl Shift Z and Ctrl Y, the Pen has G and P, Delete keys has
// Delete and Backspace), so the page lists a command once with all its keys. Two different commands on one key is a clash; the Editor
// takes the first and ignores the second (`shortcutFor` uses `find`), so a clash is a defect the page says out loud.

import type { Shortcut } from "./command-registry";
import { chordLabel } from "./keymap";

/** How a chord is written: modifiers first, then the key; the same words the menus show ("Ctrl Shift S", "Space", "F9"). One definition, in keymap.ts. */
export const formatChord = chordLabel;

export interface ShortcutRow {
  /** The command's id, as the registry names it. */
  readonly command: string;
  /** What the menu calls it; the id itself when the menu has no label for it, so an unlabelled command is shown, not hidden. */
  readonly label: string;
  /** Every key that runs it, once each, in the order the registry lists them. */
  readonly keys: readonly string[];
  /** The other commands that share one of its keys. Empty is the normal case. */
  readonly clashesWith: readonly string[];
  /** The person changed this command's keys (they are not the Editor's own). */
  readonly changed: boolean;
}

/** The keys that more than one command claims: each key written out, with the commands that claim it. */
export function clashingKeys(shortcuts: readonly Shortcut[]): ReadonlyMap<string, readonly string[]> {
  const claims = new Map<string, string[]>();
  for (const { chord, command } of shortcuts) {
    const key = formatChord(chord);
    const list = claims.get(key) ?? [];
    if (!list.includes(command)) list.push(command);
    claims.set(key, list);
  }
  return new Map([...claims].filter(([, commands]) => commands.length > 1));
}

/** The page's rows: one per command, in the order the registry first mentions it. With `commands` (every command that can be given a key, in the
 *  menus' order) a row is made for each of them, with no keys for one that has none, and the changed ones are marked. */
export function shortcutRows(
  shortcuts: readonly Shortcut[],
  labelOf: (command: string) => string | undefined,
  options: { readonly commands?: readonly string[]; readonly changed?: ReadonlySet<string> } = {},
): ShortcutRow[] {
  const clashes = clashingKeys(shortcuts);
  const byCommand = new Map<string, { keys: string[]; others: Set<string> }>();
  for (const command of options.commands ?? []) byCommand.set(command, { keys: [], others: new Set<string>() });
  for (const { chord, command } of shortcuts) {
    const entry = byCommand.get(command) ?? { keys: [], others: new Set<string>() };
    const key = formatChord(chord);
    if (!entry.keys.includes(key)) entry.keys.push(key);
    for (const other of clashes.get(key) ?? []) if (other !== command) entry.others.add(other);
    byCommand.set(command, entry);
  }
  return [...byCommand].map(([command, { keys, others }]) => ({
    command,
    label: labelOf(command) ?? command,
    keys,
    clashesWith: [...others],
    changed: options.changed?.has(command) ?? false,
  }));
}

/** Which rows the page lists: every command, only the ones with a key, or only the ones the person changed. */
export type ShowFilter = "all" | "keyed" | "changed";

export const SHOW_FILTERS: readonly { readonly id: ShowFilter; readonly label: string }[] = [
  { id: "all", label: "All commands" },
  { id: "keyed", label: "With a key" },
  { id: "changed", label: "Changed by you" },
];

export function showRows(rows: readonly ShortcutRow[], show: ShowFilter): ShortcutRow[] {
  return rows.filter((row) => (show === "all" ? true : show === "keyed" ? row.keys.length > 0 : row.changed));
}

const MODIFIERS: ReadonlySet<string> = new Set(["ctrl", "shift"]);

/** Rows that match a search. Blank shows everything. A typed chord (a modifier and a key, such as "ctrl s", "ctrl+s" or "s ctrl") means
 *  that exact key: Ctrl S, not Ctrl Shift S. Anything else needs every word to appear in the label, the id or a key. */
export function filterShortcuts(rows: readonly ShortcutRow[], query: string): ShortcutRow[] {
  const text = query.trim().toLowerCase();
  if (text === "") return [...rows];
  const words = text.split(/[\s+]+/).filter((word) => word !== "");
  const keyWords = new Set(rows.flatMap((row) => row.keys.flatMap((key) => key.toLowerCase().split(" "))));
  const typedChord = words.every((word) => keyWords.has(word)) && words.some((word) => MODIFIERS.has(word)) && words.some((word) => !MODIFIERS.has(word));
  if (typedChord) {
    const wanted = [...new Set(words)].sort().join(" ");
    return rows.filter((row) => row.keys.some((key) => key.toLowerCase().split(" ").sort().join(" ") === wanted));
  }
  return rows.filter((row) => {
    const haystack = `${row.label} ${row.command} ${row.keys.join(" ")}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** The sentence under the table: how many commands and keys, and any clash said by name. */
export function shortcutSummary(rows: readonly ShortcutRow[], shown: number): string {
  const keys = rows.reduce((sum, row) => sum + row.keys.length, 0);
  const clashing = rows.filter((row) => row.clashesWith.length > 0);
  const changed = rows.filter((row) => row.changed).length;
  const count = shown === rows.length ? `${rows.length} commands, ${keys} keys.` : `${shown} of ${rows.length} commands shown.`;
  const mine = changed === 0 ? "" : ` ${changed} changed by you.`;
  return clashing.length === 0
    ? `${count}${mine} No two commands share a key.`
    : `${count}${mine} ${clashing.length} commands share a key with another: ${clashing.map((row) => row.label).join(", ")}. The Editor runs the first and ignores the rest.`;
}
