# 11.30: Save in place and Save as next version (23 Nov 2026)

File > Save and Ctrl+S write the open scene where it already lives and never make a version. File >
Save as next version and Ctrl+Shift+S are the only way to make one: the next numbered copy, beside
the current one. Neither key fires while a text field has focus. The row stays `active`: a saved
motion preset still goes into the project's library by its own dialog, not by Ctrl+S, and the real
window was not tried with a scene that has never been saved anywhere (a project scene is stored the
moment it is made).

## The design decisions, taken with Jev and Laya

Four questions with a hand verdict, put to both with the same state
(`tools/version_decision_input.json`, answers in `jev-laya-version.json`; Laya `laya-multilingual` at
max_len 8192, 787 tokens, not truncated). Laya is uncalibrated: a second opinion, never a vote.

| Question | Hand verdict | Jev (jev-1.14.0) | Laya |
|---|---|---|---|
| What is "next version"? | A: write the current document with its unsaved edits as the new version; the old one stays as last saved | A, 0.99 | A, 0.45 |
| The undo history afterwards | fresh | **fresh, 0.94** | **keep, 0.98** |
| Ctrl+Shift+S on a scene never saved | refuse | first save, 0.65 | first save, 0.64 |
| How the number is chosen | after the current one, then the next free | after, 0.71 | after, 0.90 |
| Is a fresh history acceptable for a designer? | yes | 0.60 | 0.98 |
| Must the old version stay as last saved? | yes | 0.95 | 0.99 |

**The two places they and I differ.** On the history, Jev and Laya disagree with each other. I took a
fresh history: replaying old steps over a changed id and name risks bringing the old name back, and
both agree a fresh history is acceptable. A scene saved to a file keeps its history, because its
document does not change. On a scene never saved, both leaned (weakly) to a first save where I had
leaned to refusing, so the page treats Ctrl+Shift+S there as a first save; the Rust command still
refuses it by name (`sessionUnbound`) for any other caller.

## What was built

- **Contract:** `SaveTarget::NextVersion` (generated types and schemas regenerated).
- **Editor service** (`services/editor/src/command.rs`): a stored scene is written, with its
  unsaved edits, as a new stored scene under the next free id (`strap` gives `strap_v002`,
  `strap_v003` gives `strap_v004`; a number taken is passed over; a gap below the current number is
  not filled), named the same way (`Strap v002`), unpublished (no revision), under the project's scene
  lock so two versions cannot be given one number. Only after the write succeeds does the session
  change: it belongs to the new scene, starts a fresh history, is not unsaved, and no longer points
  at the old version's file. A scene saved to a file is written beside it as the next numbered file
  and keeps its history. The old version is never written.
- **Page:** `Editor/src/save-model.ts` (pure: which key is which save, where a plain save goes, when a
  version is a first save) and the two functions in `Editor/web/main.ts`. The keys go through the
  same guard as undo, so they do nothing while a text field has focus. The File menu shows both
  keys.

## Checks

- **Rust:** 7 new tests in `services/editor/src/command.rs` (the splitting of numbers, the choice of
  the next id, a stored scene with unsaved edits and the old one byte-identical, a fresh history and
  numbering on from the version, a number taken, a scene saved to a file, a never-saved scene and a
  failed write, and a stale file path).
- **Web:** 9 new tests in `Editor/tests/save-model.test.ts`, and the menu test now allows the two
  keys.
- **Mutants:** 35 run (`tools/mutate_version.py`). 31 killed at first; of the 4 survivors, 3 got a
  test that kills them (the new version carrying the old revision, the old file path being kept, and a
  version suffix with a `+` sign being read as a number). The fourth, reading the scene list before
  taking the lock, cannot be told apart by any single-threaded test: it matters only when two
  versions are saved at the same moment, which the lock exists to make safe. It is left, and said.
- **Real window** (the `gx-editor` shell and its WebView, through DevTools; no operating-system key
  or click; scripts in `tools/live/`): in project `LiveFinals7`, Ctrl+Shift+S made `version-check_v002`
  with its id and name shown in the header; Ctrl+S wrote in place and made no new scene; with one more
  edit Ctrl+Shift+S made `_v003`, again `_v004`; each stored scene holds its own objects (0, 2, 3, 3,
  and 5 after File > Save as next version and File > Save), the first scene is still empty, and the
  history list says "No changes yet" after a version; with focus in the scene name field neither key
  did anything; File > Save as next version and File > Save did the same as the keys.
  `shots/01-after-versions.png`.

## Not done

- A motion preset saved into the project's library by Ctrl+S (it has its own dialog).
- The real window with a scene saved nowhere: tested only by the unit tests of the model and the
  Rust refusal.
- No setting yet to choose how the number is written (`_v002`).
