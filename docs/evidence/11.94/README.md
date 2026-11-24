# 11.94 and 2.29: saved workspaces and the store behind them (23 Nov 2026)

Named workspaces for the Editor (and, with row 12.12, Playout): the one that ships (Design), the author's
saved ones, a session copy that follows each change, and a last-good copy, kept in files by a Rust store.
Not on screen yet: the page still draws its four-region layout from local storage. The selector and the
Layout menu that use this are row 11.96, and drawing the tree is 11.95. Both rows stay `active`.

## Design, with Jev and Laya

Six questions with a hand verdict (`tools/store_decision_input.json`, answers in `jev-laya-store.json`;
Laya `laya-multilingual`, max_len 8192, not truncated). They are a second opinion on design only: on
23 Nov they were measured unable to verify correctness (`docs/evidence/workspace-manager/README.md`).

| Question | Hand verdict | Jev | Laya |
|---|---|---|---|
| Where files live | B: saved copies roam; session, last good and the one in use stay on this computer | **B, 1.00** | **A (everything roams), 0.79** |
| What the Rust store checks | A: the envelope only; the dock rules stay in the page | A, 0.96 | A, 0.74 |
| Save on a shipped workspace | A: the author's own copy beside it; Reset to shipped removes it | A, 0.66 | B, 0.52 |
| A file that does not read | A: set aside, fall back, tell the person | A, 1.00 | A, 0.69 |
| Writing the session copy half a second after the last change | yes | 0.92 | 0.98 |
| Copying the dock rules into Rust would be waste | yes | 0.86 | 0.95 |

The hand verdict stands where they differ: window positions in a session copy belong to one computer, and
on the shipped save both were near a coin flip.

## What was built

- **`Shared/workspace-store` (gx-workspace-store), row 2.29.** Per application, saved copies under the
  roaming data folder and session copies, last-good copies and the workspace in use under this computer's
  folder. An id must be a safe Windows file name. A document must be a JSON object with a whole
  `schemaVersion` and a matching `workspaceId`, at most 1 MiB. A write copies the readable file it replaces
  to `.bak`, then replaces it atomically. A file that does not read is set aside as `.corrupt-<ms>` and never
  copied over the backup. A newer build's file is never written over, deleted or set aside. Two new refusals:
  `workspaceInvalid` and `workspaceNewer` (the conformance audit drives both).
- **Editor shell:** `cmd_workspace_get/put/delete/list/active/set_active/order/set_order` (`workspaces.rs`,
  tested on a scratch store).
- **Page (pure):**
  - `workspace-presets.ts`: every step (switch, change, save, save as, duplicate, reset to saved, reset
    to shipped, rename, delete, reorder, mark good), reading what was stored with its fallbacks (the copy
    from the save before, then last good, then saved or shipped), and export and import as a checked file.
  - `session-saver.ts`: the half-second pause, one write per run of changes, a failed write kept and
    reported, never counted as saved.
  - `workspace-persistence.ts`: to and from the store, writing saved copies first and removals last.
  - `workspace-catalog.ts`: Design, which ships, is the current arrangement migrated.

## Checks

- **Tests:** 25 store tests (Rust), 4 shell tests, and 221 dock and workspace tests on the page (8 files).
  A test holds the layout version equal in Rust and TypeScript.
- **Code review** (`code-review`, high, on the six new files): **10 findings, all fixed with a test.**
  1. A newer session copy made Save skip every write for that workspace, silently.
  2. A newer order or active index was set aside and then written over.
  3. A copy recovered from a fallback was never written back, so a recovered workspace vanished at the
     next start. Now `repairs` are written back.
  4. A deleted workspace's failed write could come back on close.
  5. Closing could report failure without trying the newest change.
  6. A saved file that read but broke a rule could have its id reused and be written over.
  7. A write over a damaged file copied the damage over the good backup.
  8. The roaming order lost the places of workspaces this build did not load.
  9. A wrong warning for a session copy that breaks a rule.
  10. A copy's name could pass the 60-character limit.
- **Not run this round, to finish quickly (user, 23 Nov):** mutants and a real-window check. There is
  nothing on screen to check until 11.95 and 11.96.

The four refusal messages Jev scored low in the dock review were reworded:
- A file that is not a layout: "this file is not a GrapiX layout".
- A part of an unknown kind: "a group of tabs or a split".
- A panel type registered twice: now says to give one another type name.
- A divider moved by something that is not a number: now says the pointer position.
