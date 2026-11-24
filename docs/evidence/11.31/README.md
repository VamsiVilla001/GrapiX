# 11.31: one command list behind every menu, button and shortcut (23 Nov 2026)

Row 11.31 asks for one list: every user action is one named command with a label, a shortcut, an enabled
state and a refusal reason, and the menu, the keys and the agent all use it. This round builds it for the
menu bar and every key the Editor handles. The row stays `active` (see the end).

## What was built

- **`Editor/src/command-registry.ts` (new, pure).**
  - `unavailable(id, context)`: the one answer to "can this command run now, and if not why". The reasons
    are plain words: no scene is open, no project is open, select an object first, select one object to
    rename, there is nothing to undo or redo, select a key on the timeline first, no keys are copied,
    choose a preset first, an edit is still being applied, and the line-up commands' own words.
  - `SHORTCUTS`: the only table of keys. The menu's shortcut labels are held equal to it by a test.
  - `decideKey(press, focus, context)`: a key never takes a text field's keys; Space stays with a focused
    button or slider; a held key is one press, except undo and redo; a key something else already handled
    is left alone; a command that cannot run is refused with the same words the menu shows. Keys with
    other jobs (Delete, Backspace, Ctrl C, Ctrl V) and a plain "an edit is still being applied" are
    refused silently.
  - `commandActions(context)`: every command as an agent action with its reason (same shape as the
    agent surface's `UiAction`).
  - `CHANGES_DOCUMENT`: the commands that change the open document; each sends an editor command (11.36)
    from the page code its menu item points to.
- **Menu (`app-menu.ts`).** Seven items for keys that had no menu item: Play or pause preview (Space), Ease
  selected keys (F9, Shift F9, Ctrl Shift F9), Delete selected keys, Copy selected keys, Paste keys. The
  rule "no action is reachable by a shortcut alone" is a test, both ways.
- **Page (`main.ts`).** One key handler (`onCommandKey`) replaces four (`onTimelineKeyDown`,
  `onPreviewShortcut`, and the save and undo keys in a general handler); a menu click asks the registry
  first and writes the reason in Activity; an opening menu greys what cannot run with the reason as its
  tooltip; undo and redo keys keep their panel scope; selected text is copied as text, not as keys.
  `saveShortcut` (a second copy of the key logic) is gone.

## Checks

- **Tests:** 41 registry tests (875 web tests and 145 script tests in all).
- **Mutants** (`tools/mutate_registry.py`): **58 of 58 caught.** The first round caught 42 of 49; the seven
  that survived showed gaps (redo using undo's condition, Save as needing a scene, the key-to-menu
  mapping, and four page-wiring details) and were closed with tests.
- **Gate** (before this row's code): fmt, clippy, 8 npm checks, codegen:check, test:ts, Rust workspace 1371
  passed, engine-host 11, conformance 643 passed 0 failed 9 skipped.
- **Code review** (independent reader, correctness only): no crash and no key stolen from a text field,
  button or contenteditable. Eight findings; fixed: (1) the entry and exit preset items were not greyed
  when the page's buttons are disabled (no object, no preset) and said the wrong thing; (2) a held Ctrl Z
  or Ctrl Y no longer stepped through history; (3) the busy state turned from a silent skip into a red
  line on a second press; (4) Delete with no key selected said "select a key" although no key deletes
  objects; (6) the History item was stricter than its button; (7) Ctrl C took text selected elsewhere.
  Not changed: (5) the menu's Undo is unscoped while the key is scoped to the focused panel (as it
  always was); (8) menu states are worked out when a menu opens, and a click is checked again at click
  time, so nothing runs that cannot.
- **Real window** (Editor built with DevTools, the project LiveFinals7, a new scene with three rectangles;
  keys sent to the page, no OS input): with nothing open, Undo, Redo and Delete are greyed with their
  reasons, Ctrl Z and Ctrl S say "Undo: there is nothing to undo" and "Save: no scene is open", and a
  click on Delete says "Delete: no scene is open". With the scene: Delete with no key selected is refused
  by name, Ctrl C with none says nothing, keys typed in the name field change nothing, Space starts and
  stops the preview but not on a focused button, Ctrl Z and Ctrl Shift Z undo and redo and "Redo: there is
  nothing to redo" shows, Delete and Rename with nothing selected say "select an object first", a line-up
  with one object says "Select two or more items to line up.", Ctrl S saves (`LiveFinals7/keys-check`) and
  Ctrl Shift S makes `keys-check_v002`. The window opened before the review fixes; they are held by tests
  and the mutants.

## Still open (why the row stays `active`)

- The toolbar's enabled states are still set by the page code beside each button (undo and redo, project
  buttons); the menu and the keys use the registry, the buttons' clicks are the same actions.
- The editor MCP does not list the registry's commands yet (`commandActions` is ready for it).
- A user-set shortcut and trigger map is row 11.84.
