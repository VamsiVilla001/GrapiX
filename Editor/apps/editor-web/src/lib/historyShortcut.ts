/**
 * What a key press means for scene history.
 *
 * Pure on purpose: the routing rules are the part worth pinning, and they are the part that goes
 * wrong. Keeping them out of a React handler means the whole table is asserted headlessly in
 * `tests/history-shortcut.test.ts` rather than by pressing keys in a browser.
 */

export type HistoryIntent = "undo" | "redo" | null;

/**
 * True when the event came from somewhere that owns its own undo.
 *
 * A text field, a number field and a `contentEditable` region all have the browser's own text undo,
 * and it is the right one: an author correcting a typo in an object name means "take back that
 * character", not "take back the last change to the scene". Stealing Ctrl+Z there would make typing
 * feel broken and would silently revert a scene edit the author had finished with.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target && typeof target === "object" && "tagName" in target)) return false;
  const element = target as HTMLElement;
  if (element.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName);
}

/**
 * Map a keyboard event onto a history intent.
 *
 * `Ctrl+Z` undoes and `Ctrl+Shift+Z` redoes, which is the cross-platform pair; `Ctrl+Y` is accepted
 * as well because Windows authors reach for it and refusing it silently is worse than supporting two
 * spellings of one command. `Meta` is treated as `Ctrl` so the same code serves macOS.
 *
 * Returns `null` for anything else, including a bare `Z`, `Alt` combinations reserved elsewhere, and
 * any press that came from a text-entry target.
 */
export function resolveHistoryIntent(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  target?: EventTarget | null;
}): HistoryIntent {
  if (!(event.ctrlKey || event.metaKey)) return null;
  // Alt is a modifier other features claim (the assistant and the console are on Ctrl+Alt), so a
  // press carrying it is not ours.
  if (event.altKey) return null;
  if (isTextEntryTarget(event.target ?? null)) return null;

  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  if (key === "y" && !event.shiftKey) return "redo";
  return null;
}

/**
 * How a history step should be described in a menu, a tooltip or an announcement.
 *
 * The scope is named because there is one history for the document and a keystroke may take back a
 * change made in another panel. Saying so — "Undo Material Manager · Rename material" — is what
 * keeps a single shared history honest; a silent revert of someone else's edit is how an author
 * loses trust in the key.
 */
export function describeHistoryStep(
  verb: "Undo" | "Redo",
  step: { label?: string; scope?: string } | undefined,
  scopeLabels: Readonly<Record<string, string>> = {}
): string {
  if (!step) return `Nothing to ${verb.toLowerCase()}`;
  const scope = step.scope ? scopeLabels[step.scope] ?? step.scope : undefined;
  if (step.label && scope) return `${verb} ${scope} · ${step.label}`;
  if (step.label) return `${verb} ${step.label}`;
  if (scope) return `${verb} change in ${scope}`;
  return verb;
}
