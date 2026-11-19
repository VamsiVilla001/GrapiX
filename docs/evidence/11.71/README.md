# 11.71 XPression-informed layout (design) and 11.72 Scene Manager list (first build)

From the user's direction of 18 Nov 2026: borrow the XPression Designer UI knowledge from the `xpression-builder` skill, work out which
modules the Editor can incorporate, and improvise the layout to use the real estate well.

## Sources of the XPression knowledge
`~/.claude/skills/xpression-builder`: `references/ui-driving.md` (window anatomy), `knowledge/ui_layout.json` (positions), its trap list,
the Key Graph Editor notes, and what was seen on the user's screen (Scene Directors, Key Graph Editor, Stagger Animations, Object Manager,
Scene Director, Material Manager and Object Inspector windows, spread over the second monitor). Read only; nothing was clicked in XPression.

## Measured: the Editor on 18 Nov 2026 (3862 x 2122 window, one capture)
| What | Measure |
|---|---|
| Chrome above the workspace (menu 3.3 %, header 3.5 %, tools 2.2 %) | 9 % of the height |
| Workspace row / timeline / Activity strip | 61 % / 22.6 % / 6.2 % (two log lines) |
| Drawn 1920 x 1080 frame | 983 x 553 px in a 1134 x 647 px pane: 26.5 % of the window |
| Right column (20 % of the width) | 13 panels, about 2 x the visible height; Preview 52 % of the visible column; Effects & Presets list shows 1 row |
| Left column (19 %) | Scene Manager 80 % (2 scene cards of about 190 px), Objects 12 %, Assets 5 % |
| Timeline (22.6 %) | toolbars 60 px, ruler 30 px, an empty layers area 120 px (half) |

## Which XPression modules the Editor takes, and which it leaves
| XPression | Editor today | Decision |
|---|---|---|
| Scene Manager: List or Thumbnails, context menu, F2 / F7 / Del | cards only | **11.72 built** (list default, toggle, row menu, keys); Rename, Change ID, Convert Dimensions, Export Scene, Regenerate Thumbnails still to come |
| Object Manager, Font Manager, Object Inspector | Objects, Fonts, Properties panels | exist; become tabs of panel groups (11.73) |
| Material Manager (folders, thumbnails, Filter) | Assets and Materials | exist; grouped in 11.73; a filter box is a later item |
| Scene Director (ruler, counter, several directors) | Timeline with phases | exists |
| Key Graph Editor (TCB, Bezier, Simple Bezier, Linear, Hold; pre / post-infinity) | speed graph (11.68) with Linear, Hold, Bezier, Easy Ease | **11.78** pre / post-infinity |
| Stagger Animations | none | **11.77** |
| Edit Script Events, Edit Visual Logic | none | 16.14 and 16.15 (scripting) |
| Floating panels on the second monitor | none | **11.75** pop-out windows |
| After Effects workspaces and tab groups | none | **11.73** and **11.76** |
| Sequencer, Take, Play, Cue, output settings | Playout, a separate app | **never borrowed**: the Editor cannot reach Program (invariant 4) |

## Jev and Laya (`jev-laya-design.json`, text only)
Jev: tab groups 0.92 (accordion 0.01, keep the stack 0.02, floating only 0.05); Scene Manager list by default 0.91; Activity as one status line 0.92;
pop-out 0.77; workspaces 0.80; one-row timeline toolbar only 0.54; Stagger 0.77; pre / post-infinity 0.74; first to build: the Scene Manager list 0.72.
**Laya disagreed on every choice** (floating only, thumbnails by default, keep the strip, chrome first) and answered 0.90 to 0.95 to every yes/no question,
so it does not discriminate here; Jev led and the disagreement is recorded, not hidden. The one-row timeline toolbar is made conditional because Jev's 0.54 is weak.

## 11.72 as built, and measured in the running Editor
- `Editor/src/scene-manager.ts`: `view: "list"` projects one row per scene with a short status (`rowStatus`: only what is unusual), no preview, the full sentence on the row's description and every action kept, the active scene `selected`.
- `Editor/src/scene-list-nav.ts`: `moveRow` (arrows, Home, End), `rowCommand` (Enter opens, Delete, menu key, Shift+F10), and a Delete that must be pressed twice on the same row within 3 seconds (`createDeleteArm`): no dialog to dismiss by reflex.
- Page: a List toggle in the panel title (remembered per user, default List), a click on a row opens it, a right-click or the menu key shows the row's commands with the same refusals, rows keep keyboard focus across a re-render, and no preview is rendered while the list is on.
- Two scenes: 515 of 647 px of the left column as cards (190 px each) became 44 px (22 px each); Objects and Assets are fully visible. A project of 20 scenes: about 440 px of rows against about 3800 px of cards.
- Captures: `list-1.png` (whole window), `list-2.png` (row hover shows the commands), `list-3.png` (row menu), `list-4-delete-armed.png` (one Delete arms the row: red row, the log says press again within 3 seconds, focus kept). The second Delete was not pressed live.
- Tests: 21 (8 keyboard rules, 13 projection). Mutations N1 to N14, one at a time, restored byte-identical, each failed a named test; N3 first survived as an equivalent mutant (a redundant branch in `moveRow`), which was removed.

## Not done
The default layout is unchanged beyond the Scene Manager, so the three numbers of 11.71 are not met yet (frame 26.5 % against 35 %, right column about 2 x its height, chrome and log 15.5 %). Rows 11.73 to 11.78. The page glue in `Editor/web/main.ts` is type-checked by `npm run typecheck:web` but has no unit test and is checked live.

## An incident during the live check
An earlier attempt sent a click and a Delete while the Editor was not in front; they reached the user's XPression Designer and opened its "Delete selected scene, are you sure?" prompt. It was cancelled with Escape; XPression's log shows no scene deletion after 17:08 and nothing was saved. The rule that follows (prove the foreground window before any input) is in the live-check notes, and the checks above were repeated with an input script that aborts unless the foreground window is `GrapiX Editor`.

## 11.73 tab groups: first build (18 Nov 2026)
- Layout version 3, `TabGroup` in `Editor/src/workspace-layout.ts`; the page draws a tab strip over the showing panel. Right dock: Preview, then Inspector (Properties, Animation, Effect Controls, Text styles, Fonts) and Library (Effects & Presets, Materials) groups. Left dock under Assets: a Delivery group (Take page, Template controls, Data bindings, Publish) in the space the Scene Manager list freed. Jev 0.51 for the left dock (0.31 right as a third group, 0.18 right with Preview folded); Laya picked folding Preview (0.86) and answered 0.98 to the yes/no, so it did not discriminate (`jev-laya-delivery-home.json`). This departs from the 14 Sep 2026 placement of the delivery panels; one drag undoes it.
- Measured (3862 x 2122 window, half-scale): before, the right dock held 13 panel headers at about twice its visible 535 px and scrolled; after, Preview 265 px plus two groups fit with no scroll in the dock, each group scrolling inside itself. Captures: `tabs-1.png` (first groups), `tabs-2.png` (delivery group at left, no right scroll), `tabs-3.png` (the Fonts tab showing).
- Tests: 36 in `tests/workspace-layout.test.ts`; mutations T1 to T19, one at a time, restored byte-identical, each failed a named test. Gate: fmt 0, clippy 0, check 0.
- Not exercised live: arrow keys between tabs, dragging a tab, the Window menu on a hidden tab. Window driving was stopped when the user's XPression raised its own delete prompt in front of the Editor; the guard aborted without sending a key. The Effects & Presets list is short (about three rows) at default sizes: the Effects workspace (11.76) or a smaller Preview is needed.

## 11.79 Effects dropdowns and 11.80 resizable panels (18 Nov 2026)
- 11.79: each Effects & Presets category is a folded bar with its counts, opened by a click, Enter or Space, Expand all or a search (`fx-1-folded.png`). 8 mutations F1 to F8, each caught.
- 11.80: splitters between the stacked panels and groups of the left and right docks; dragging the bar between the Inspector and Library groups made Effects & Presets taller (`fx-2-after-drag.png`), and the sizes survived a relaunch with the dock filled (`fx-3-relaunch-sizes-kept.png`). The live drag found two faults, both fixed: a hidden panel measures zero and the floor-then-normalise pushed it below the minimum (save refused; now `floorFractions`), and flex-grow values adding to less than one left a blank strip (now scaled). 56 layout tests; mutations S1 to S19 and FF1 to FF8, each caught (S17 first survived).
- The After Effects install folder the user shared was read for names and counts only (see the user-memory reference): 228 effect plug-ins, 14 preset folders (Text has 300), ScriptUI Panels and Startup scripts. Nothing from it is copied.
- Not exercised live: keyboard on a splitter, the double-click reset, the left dock's splitters, the drop line, search and Collapse all. The default Effects & Presets area is still short; a stored test split is left in the Editor's layout (Reset layout, or a double-click on a splitter, clears it).
