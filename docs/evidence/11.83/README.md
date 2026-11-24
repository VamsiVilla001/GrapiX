# 11.83: line up and spread, first slice (23 Nov 2026)

Edit > Line up and spread lines up the selected items by their left edges, centres across, right
edges, top edges, middles down or bottom edges, and spreads three or more items so the gaps between
them are equal across or down. One click is one batch of position changes, so one undo step, and it
shows in the change history (11.82). The row stays `active`: snap to the grid, guides and other
items, and moving or turning several items about one shared point, wait on the viewport handles
(11.44). The menu carries "Snap to grid and guides" dimmed, naming 11.83.

## The design decisions, taken with Jev and Laya

Four questions with a hand verdict, put to both with the same state
(`tools/arrange_decision_input.json`, answers in `jev-laya-arrange.json`; Laya `laya-multilingual`
at max_len 8192, 735 tokens, not truncated). Laya is uncalibrated: a second opinion, never a vote.

| Question | Hand verdict | Jev (jev-1.14.0) | Laya |
|---|---|---|---|
| Line up to what? | D (the selection, and a separate set for the canvas) | A (the selection), 0.77 (D 0.22) | A, 0.58 (D 0.26) |
| A locked item in the selection | A (refuse all, name them) | A, 0.91 | A, 0.52 |
| Items in different groups | A (refuse) | A, 0.96 | A, 0.56 |
| What spread means | A (equal gaps) | A, 0.87 | A, 0.79 |
| Would silently skipping a locked item surprise a designer? | yes | 0.79 | 0.92 |
| Is refusing mixed groups acceptable for a first release? | yes | 0.81 | 0.95 |

**One place where I changed my mind.** I had leaned to D. Both classifiers chose A, and the row's
text asks for the selected items only, so the canvas set was removed (it had been written and
tested; the code and its tests were deleted, not left unused). Lining items up to the canvas is
left for later, with the group question it needs: an item inside a group lives in the group's own
space, which the page cannot read as a whole yet.

## What was built

- `Editor/src/arrange.ts`: a pure function from the document and the selection to one batch of
  `setObjectField` edits for `x` and `y`, or a refusal in words. It uses the box each item has on
  the canvas, after scale and rotation (`objectOverlayBounds`), and moves the item's own `x` or `y`
  by the difference. It sends nothing for an item already in place or for a move that is only
  floating-point noise, and tidies the numbers it sends to six decimals.
- Refused by name, with nothing sent: too few items (two to line up, three to spread); a group,
  layer, light, camera or marker (no box of its own); a locked item (named); items from different
  groups, or inside and outside a group; and "Nothing to move: they are already lined up".
- Spread orders by centre, keeps the two outermost items where they are, and gives the ones
  between equal gaps between edges.
- The menu: `Edit > Line up and spread`, 8 actions and the dimmed snap line. The page tags the batch
  as the Composition's, so the history list names it so.
- No Rust: the edits are the ones the Properties panel already sends.

## Checks

- **Web:** 21 new tests in `Editor/tests/arrange.test.ts`: every edge and centre, the box after
  scale and rotation, spread across and down, ordering by centre (including a wide item that starts
  early but sits late), items of different sizes, floating-point noise, every refusal, the words,
  the menu entries and the page's call.
- **Mutants:** 25 of 25 killed (the script is `tools/mutate_arrange.py`). The first run left two
  alive: the rounding of sent numbers, and ordering by left edge instead of by centre. Each now has
  a test that kills it.
- **Real window** (the `gx-editor` shell and its WebView, driven through DevTools with
  `docs/evidence/11.43/cdp.mjs`; no operating-system key or click was sent; scripts in `tools/live/`):
  three 200 by 120 rectangles at (100, 100), (400, 250) and (900, 40), chosen with Ctrl+click in the
  Objects panel:
  - **Line up left edges:** rectangles 2 and 3 go to x 100 and rectangle 1 stays; Activity says
    "Line up left edges: 2 items moved"; one new line in the history, "Change value (2 times): x".
  - **One Undo** puts all three back (the line is greyed in the history).
  - **Spread evenly across:** the middle one goes to x 500 (gap 200 each side); the outer two stay.
  - **Line up bottom edges:** all three at y 250; the same call again says "Nothing to move: they
    are already lined up" and changes nothing.
  - **Refused:** one item selected ("Select two or more items to line up."); one locked item
    ("rect" is locked. Unlock it first; nothing was moved.) with every position unchanged.
  - `shots/01-menu-and-history.png`: the submenu with the history list beside it.

## Not done

- Snap (grid, guides, edges and centres of other items, with a hold key), and several items moved,
  resized or turned about one shared point: they need the viewport's handles (11.44).
- Lining up to the canvas, and lining up items from different groups.
- Items in a group are lined up in the group's own space, which is exactly right only when the group
  is not turned or scaled; the page does not say so.
- Moving the pivot or resizing is not part of it: only `x` and `y` change.
- No shortcut (11.31, 11.84).
