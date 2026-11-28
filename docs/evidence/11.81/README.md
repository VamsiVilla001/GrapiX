# 11.81: the Settings window as the Figma E4 screen (nav, General, Shortcuts)

Built 25 Nov 2026 by claude-grapix-f1, offered by the UI session (task 115), whose build order calls this slice B15 ("E4 Settings,
General and Shortcuts"). New files only; the hand-off into `Editor/web/{main.ts,index.html}` is one patch, `settings-window.patch`, that
the UI session applies (its files, mid-edit by it). Nothing is committed.

## What it is

- **A left nav** (`src/settings-pages.ts`): General and Shortcuts, built; AI and MCP access, listed, dimmed, and when chosen it says what it
  waits for and which row builds it (8.14). The Figma nav's Colour and output and Help and diagnostics pages, and the spec's nine other
  sections, are not drawn: nothing owns them yet, and the owner decides which become rows.
- **General** is the Editor's own twenty settings in their two sections (Yours, This computer), unchanged in behaviour. The view only
  gives `renderSettings` an element to draw into (`settingsWindow.general`); the paragraph that explains the two sections moves into it.
  The two reset buttons belong to General and are hidden on the other pages (`onShow`).
- **Shortcuts** (`src/settings-shortcuts.ts`, `src/settings-window-view.ts`): a read-only table drawn from the one key table the Editor reads
  (`SHORTCUTS`, `commandById`), one row per command with all its keys together (Redo: Ctrl Shift Z and Ctrl Y; Pen: G and P; Delete keys:
  Delete and Backspace), a search box (a typed chord such as "ctrl s", "ctrl+s" or "s ctrl" means that exact key; anything else needs every
  word in the label, the id or a key), a CLASH chip that names the other command when two commands share a key (the Editor runs the first
  and ignores the rest; its own table has none), a count line, and "Changing a key waits for row 11.84, so nothing here can be edited yet".
  The only control on the page is the search.
- **The AI and MCP access page draws no role table.** The Figma screen names three roles (Reader, Designer assistant, Reviewer) against
  Read, Propose, Preview, Request publish and Cue/Clear, a token with an expiry, an audit log and Create token / View audit log buttons.
  The contracts have product roles Editor, Playout and Engine and the closed authorities Author, Cue, Take, Clear, ConfigureOutput, Stop and
  Report (`Shared/contracts/src/auth.rs`); there is no such role, no command that creates a token or gives it an expiry, and no command in
  the Editor shell that reads an audit log. The UI session's screen map records this as an owner question (C-17). Drawing the table would
  state permissions the backend does not enforce, so the page says what is decided (access is by role and credential, never by the name
  of the AI provider; no role can cue, take out, clear or change what is on air, only Playout does that) and what is not.

## Decisions: Jev and Laya, asked before the build

`settings-e4-input.json`, `jev-laya-settings-e4.json` (four questions). Jev chose: nav A (0.5), Shortcuts A (0.94), AI page A (0.43; C 0.38),
and General B (0.37: 0.58 against A 0.41). Laya chose A, B, A, A at 0.01 to 0.2 confidence (a second opinion, never a vote). **One
disagreement was decided by me and is open to the owner:** Jev's low-confidence B for General (split the twenty settings across the nav
pages by topic) cannot go with its own choice for the nav (only General and Shortcuts live): there is no page for the Pen settings or the
cache folder to go to. General keeps all twenty in their two sections. Laya's Shortcuts B (editable now) is not followed: the settings
contract has no keymap setting, so editing would have to invent one (row 11.84).

## Verification (25 Nov 2026, `agent/worktree`)

1. **Unit tests, vitest:** 40 new tests (pages 6, shortcuts 16, window view 18), including that the labels the menus show equal what
   `formatChord` writes from the same table for every labelled key, that the Editor's own table has no clash, that a clash is named on both
   rows and in the summary, the search rules, the tab list's keyboard behaviour (arrows, Home, End, wrap, focus), the dimmed waiting page,
   and that nothing on the Shortcuts or AI page except the search can be pressed. The whole Editor suite passes: 99 files, 1,513 tests.
2. **Strict typecheck** of the six new files against `tsconfig.base.json` (exit 0), and of a copy of `main.ts` with the patch applied under
   `typecheck:web`'s flags (exit 0; the live file passes the same command). `npm run check:boundaries` OK.
3. **Mutants:** `tools/mutate-editor.mjs`, in place on the three new source files with a backup and a byte-for-byte restore check:
   **38 of 38 caught** (key naming, clash rules, search rules, summary, page list, tab state, tab order, keyboard, onShow, dimming,
   tooltips, the grid class, the search listener, the empty message, chip title and tone, ARIA ties, Home, focus).
4. **A real browser, with the real stylesheets, the real `SHORTCUTS` and the real field specs:** `tools/harness.mjs` (esbuild bundle of
   `tools/entry.ts` and the real modules; own headless Chrome, own profile and port, page-level input only): **25 of 25 checks**
   (`real-browser-results.json`, `screens/`). It found two defects the fake-DOM tests could not: the host element never got the grid class
   (the nav stacked above the page), and the dialog scrolled as a whole so Close fell below the fold once a page was long. Both fixed (the
   view adds the class itself and has a test; the CSS makes the dialog a flex column where only the page area scrolls, and gives the
   window a fixed height so the dialog is the same size on every page, which a check now holds). At 1000 by 700 the dialog stays inside
   the window and Close stays on screen.

**Not verified:** the patched dialog inside the real Editor window. That needs `Editor/web/main.ts` changed and rebuilt, which is the UI
session's file; the scratch page replicates the dialog markup exactly as the patch leaves it. The whole `npm run check` (Rust suites are
mid-edit by other sessions). No commit.

## The hand-off

`settings-window.patch` (generated by `tools/make-handoff.mjs` from copies of the live files; `git apply --check` passes on the working
tree): three edits in `main.ts` (the imports; the window created once on `ui.settingsBody` with `onShow`, plus `settingsLead()`; `renderSettings`
drawing into `settingsWindow.general`), and in `index.html` the lead paragraph removed and `settings-window.css` linked after `style.css`.
`settingsWindow.show("shortcuts")` opens it on that page for the future Edit > Shortcuts and triggers menu item (11.84).

## Open

- **The roles of the AI page** (owner, C-17), and whether Colour and output and Help and diagnostics (and the spec's other sections)
  become rows.
- **Changing a key** (11.84): needs a keymap setting in the settings contract, a decision on user-set keys against the registry's
  fixed table, and a clash rule when a user key meets a built-in one. The page's CLASH chip is ready for it.
- The nav's name is "Shortcuts" as in Figma; the spec calls the section "Shortcuts and triggers" (triggers are 6.8).
