# 11.82: the change history list (23 Nov 2026)

Edit > Change history… (and the History… button beside Undo and Redo) opens a list of every change
to the open scene, oldest first. A click on a line takes the scene to the state just after that
change. The row stays `active`: the shortcut waits on the command list (11.31) and the shortcut
settings (11.84).

## The one design decision, taken with Jev and Laya

What a click does to Undo and Redo. Three options were put to both with the same state
(`tools/history_decision_input.json`, answers in `jev-laya-history.json`; Laya `laya-multilingual`
at max_len 8192, 689 tokens, not truncated):

- **A, navigation:** a click is the same as that many undos or redos done at once; the later steps
  stay listed, greyed; Undo after a jump goes one further back; the jump is not itself a step.
- **B:** the jump is recorded as its own step that Undo reverts.
- **C:** navigation, but the first Undo after a jump reverts the jump.

| Question | Hand verdict | Jev (jev-1.14.0) | Laya (uncalibrated) |
|---|---|---|---|
| Best option | A | A, 0.96 | A, 0.50 (C 0.43) |
| Does A satisfy the row's "one undoable move"? | yes | 0.77 yes | 0.99 yes |
| Do After Effects and Photoshop users expect Undo to keep going back? | yes | 0.93 | 0.97 |
| May a click re-apply an earlier step a scoped undo had skipped? | yes | 0.94 | 0.98 |
| Would a jump recorded as a step clutter the list? | yes | 0.87 | 0.95 |

All three agree; A is built. Laya is a second opinion, never a vote. **The reading of the row to
note:** "as one undoable move" is built as one atomic move that one click (or Redo) reverses, not
as a move a single Undo reverts.

## What was built

- **Contract:** command `goToHistoryStep { session, step? }` (step left out = the scene as opened),
  the read types `HistoryView` and `HistoryStep`, and the refusal `historyStepUnknown`.
- **Editor service** (`services/editor/src/command.rs`): `Workspace::history` (a read) and the jump.
  Every step up to the one clicked is applied (one a module-scoped undo had skipped too), every
  later step is undone and comes back with Redo in the order it was made. One replay; a replay
  that refuses puts every step back and changes nothing. Going to where the scene already is does
  nothing and does not mark the scene edited. A step dropped by a new edit, or folded in past the
  200-step limit, refuses by name.
- **Shell:** `cmd_session_history`, a read. The jump goes through `cmd_execute` like every change.
- **Page:** `Editor/src/history-list.ts` holds the words. Every kind of edit (46) and every part of
  the app (13) has plain words, held by the compiler against the generated contract types. The
  window is not modal, so it stays open beside the work and follows every edit, undo, redo and
  scene switch.

## Checks

- **Rust:** 7 new tests in `services/editor/src/command.rs` (the list's content, a jump equals the
  same number of undos, Redo order, a skipped step re-applied, the no-op, a stale step, the limit,
  all-or-nothing on a refused replay).
- **Web:** 11 new tests in `Editor/tests/history-list.test.ts`.
- **Mutants:** 28 of 28 killed (15 Rust, 13 web); the script is `tools/mutate_history.py`, and it
  restores each file in a `finally`.
- **Real window** (the `gx-editor` shell and its WebView, driven through DevTools with
  `docs/evidence/11.43/cdp.mjs`; no operating-system key or click was sent; scripts in `tools/live/`):
  - the menu item opens the window, not modal, at the right of the page;
  - with no scene open it says so; a new scene shows "Scene as opened" as the current line;
  - two adds through the toolbar appear as "Add item: rect" and "Add item: ellipse"; an edit the
    engine refused (text with no font) adds no line;
  - a click on step 1 of 3: two lines greyed and marked undone, Redo enabled, the timeline shows
    one layer (`shots/01-back-to-step-1.png`);
  - Undo after the jump goes to the scene as opened; Redo comes forward one step;
  - a click on step 3 goes forward in one move; a click on "Scene as opened" undoes everything;
  - a new edit after going back leaves steps 1 and 4 only;
  - asking for the dropped step 2 is refused: `historyStepUnknown`, "session 1 has no step 2 in
    its change history any more";
  - Close closes it and the toolbar button opens it again.

## Found in the real window and fixed

A click on the line the scene was already on wrote "Went to: …" in Activity although nothing had
changed. That line now does nothing; checked again in a rebuilt window (0 new Activity lines for
the current line, 1 for another line; `shots/02-list-open.png`).

## Not done

- No shortcut opens the list (11.31, 11.84).
- A step's line names the first edit's subject only when it is something the author typed or a
  property; it does not name the object a value was changed on.
- Toolbar gestures are tagged "Scene", because no panel has focus when they are made (11.37's rule).
