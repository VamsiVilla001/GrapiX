// Ctrl K: search everything (the new Figma UI, E1; plan rows 11.31 and 11.67).
//
// One box that finds the effects, the commands and the elements, and runs the one chosen. This file is the logic only: what matches, in
// what order, what each result says and why one cannot run. The page draws it and runs the action through the paths it already has
// (the command registry, the effects browser's apply, the selection), so the palette never has a second copy of anything.
//
// Held here:
//  - every effect of the catalogue is findable, ported or not (invariant 86); only what is SHOWN is limited, a handful per group with a
//    line saying how many more;
//  - a result that cannot run is shown dimmed with its reason, never hidden: the menu does the same (an unbuilt item says which row builds it);
//  - what a command was based on in another product (`basedOn`) is never matched or shown;
//  - an empty box lists the commands that can run, so Ctrl K alone is a way in.

import { APP_MENUS, actionOf, allCommands, type Menu, type MenuCommand, type MenuNode } from "./app-menu";
import type { EffectListing } from "../../Shared/generated-ts/src";

export type ResultGroup = "effects" | "commands" | "elements";

export const GROUP_LABEL: Readonly<Record<ResultGroup, string>> = { effects: "Effects", commands: "Commands", elements: "Elements" };

export type SearchAction =
  | { readonly kind: "command"; readonly commandId: string }
  | { readonly kind: "effect"; readonly effectId: string }
  | { readonly kind: "element"; readonly objectId: string };

export interface SearchResult {
  readonly key: string;
  readonly group: ResultGroup;
  readonly label: string;
  /** The right-hand side: the shortcut, where it goes, or what it is. */
  readonly detail: string;
  /** Why it cannot run now; `undefined` when it can. */
  readonly blocked: string | undefined;
  readonly action: SearchAction;
}

export interface ElementSource {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
}

export interface SearchSources {
  /** The menu model; the page passes `APP_MENUS`. */
  readonly menus?: readonly Menu[];
  /** The registry's answer for a command now: a reason, or `undefined` when it can run. */
  readonly commandBlocker: (commandId: string) => string | undefined;
  readonly effects: readonly Pick<EffectListing, "id" | "name" | "category" | "available">[];
  /** The element an effect would be added to, or why there is none. */
  readonly effectTarget: { readonly name?: string; readonly blocker?: string };
  readonly elements: readonly ElementSource[];
}

export interface SearchLimits {
  /** Results shown per group; the rest are counted in `more`. */
  readonly perGroup: number;
}

export const DEFAULT_LIMITS: SearchLimits = { perGroup: 6 };

export interface ResultGroupView {
  readonly group: ResultGroup;
  readonly label: string;
  readonly results: readonly SearchResult[];
  /** How many more matched than are shown. */
  readonly more: number;
}

export interface SearchView {
  readonly groups: readonly ResultGroupView[];
  /** Every result shown, in the order the page lists them: the order the arrow keys walk. */
  readonly flat: readonly SearchResult[];
}

const fold = (text: string): string => text.normalize("NFC").toLowerCase();

/** How well `query` (words, in any order) matches `text`; `undefined` when a word does not match at all. A word at the start of a word of
 *  the text scores most, a word inside one next, and the letters of a word in order (a typo-tolerant "chvrn") least. */
export function score(query: string, text: string): number | undefined {
  const words = fold(query).split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return 0;
  const haystack = fold(text);
  const starts = haystack.split(/[^\p{L}\p{N}]+/u).filter((w) => w !== "");
  let total = 0;
  for (const word of words) {
    if (starts.some((s) => s.startsWith(word))) total += 3;
    else if (haystack.includes(word)) total += 2;
    else {
      let at = 0;
      for (const letter of word) {
        at = haystack.indexOf(letter, at);
        if (at === -1) return undefined;
        at += 1;
      }
      total += 1;
    }
  }
  if (haystack === fold(query).trim()) total += 5;
  return total;
}

/** The menu a command lives in, written as `File › Bring in`, for matching and for the result's detail when it has no shortcut. */
export function menuPaths(menus: readonly Menu[] = APP_MENUS): ReadonlyMap<string, string> {
  const paths = new Map<string, string>();
  const walk = (nodes: readonly MenuNode[], trail: readonly string[]): void => {
    for (const node of nodes) {
      if (node.kind === "command") paths.set(node.id, trail.join(" › "));
      else if (node.kind === "submenu") walk(node.items, [...trail, node.label]);
    }
  };
  for (const menu of menus) walk(menu.items, [menu.label]);
  return paths;
}

function commandResult(command: MenuCommand, path: string, blocker: string | undefined): SearchResult {
  const unbuilt = actionOf(command) === "unbuilt";
  return {
    key: `command/${command.id}`,
    group: "commands",
    label: command.label,
    detail: command.shortcut ?? path,
    blocked: unbuilt ? `Not built yet: plan row ${command.row}` : blocker,
    action: { kind: "command", commandId: command.id },
  };
}

/** The results for `query`, grouped and limited. */
export function search(query: string, sources: SearchSources, limits: SearchLimits = DEFAULT_LIMITS): SearchView {
  const paths = menuPaths(sources.menus ?? APP_MENUS);
  const commands = allCommands(sources.menus ?? APP_MENUS);
  const q = query.trim();

  // The words matched are the name and where it lives; a name typed in full is worth more than any longer name that contains it.
  const scored = <T extends SearchResult>(items: readonly { readonly result: T; readonly text: string }[]): T[] =>
    items
      .map((item, order) => {
        const points = score(q, item.text);
        return { item, order, points: points === undefined ? undefined : points + (fold(item.result.label) === fold(q) ? 10 : 0) };
      })
      .filter((entry): entry is { item: (typeof items)[number]; order: number; points: number } => entry.points !== undefined)
      .sort((a, b) => b.points - a.points || a.order - b.order)
      .map((entry) => entry.item.result);

  let effects: SearchResult[] = [];
  let found: SearchResult[];
  let elements: SearchResult[] = [];
  if (q === "") {
    // An empty box is a way in: the commands that can run now, in menu order.
    found = commands
      .filter((c) => actionOf(c) !== "unbuilt" && sources.commandBlocker(c.id) === undefined)
      .map((c) => commandResult(c, paths.get(c.id) ?? "", undefined));
  } else {
    found = scored(commands.map((c) => ({ result: commandResult(c, paths.get(c.id) ?? "", sources.commandBlocker(c.id)), text: `${c.label} ${paths.get(c.id) ?? ""}` })));
    effects = scored(
      sources.effects.map((e) => ({
        result: {
          key: `effect/${e.id}`,
          group: "effects" as const,
          label: e.name,
          detail: sources.effectTarget.name !== undefined ? `add to ${sources.effectTarget.name}` : (sources.effectTarget.blocker ?? "select an element first"),
          blocked: !e.available ? "Not yet ported to the GrapiX engine" : sources.effectTarget.name === undefined ? (sources.effectTarget.blocker ?? "select an element first") : undefined,
          action: { kind: "effect" as const, effectId: e.id },
        },
        text: `${e.name} ${e.category}`,
      })),
    );
    elements = scored(
      sources.elements.map((el) => ({
        result: { key: `element/${el.id}`, group: "elements" as const, label: el.name, detail: el.kind, blocked: undefined, action: { kind: "element" as const, objectId: el.id } },
        text: `${el.name} ${el.kind}`,
      })),
    );
  }

  const groups: ResultGroupView[] = (
    [
      ["effects", effects],
      ["commands", found],
      ["elements", elements],
    ] as const
  )
    .filter(([, results]) => results.length > 0)
    .map(([group, results]) => ({ group, label: GROUP_LABEL[group], results: results.slice(0, limits.perGroup), more: Math.max(0, results.length - limits.perGroup) }));
  return { groups, flat: groups.flatMap((g) => g.results) };
}
