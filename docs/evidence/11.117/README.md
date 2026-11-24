# 11.111, 11.117, 11.118: masks, track mattes and the Pen's mask mode in the Editor (24 Nov 2026)

Built, with unit tests, **not yet checked in a real Editor window** (rows stay `active`).

- `Editor/src/mask-edit.ts` (pure): who can carry a mask, add / remove / reorder (one `setObjectMasks`, one undo step), patch
  mode, invert, opacity, feather x and y, falloff, expansion (refusing what the engine refuses, in the author's words), the
  matte (source by id from any place in the stack, mode, clear; setting it turns the source's eye off in the same batch),
  copy a closed shape's path to a mask and a mask to a shape (independent copies through the canvas).
- `Editor/src/pen-tool.ts`: `penPlan` (Auto: a mask on the one selected non-shape layer, otherwise a shape; Shape; Mask),
  `penMaskEdit` (the drawn points taken through the layer's place, turn, scale and pivot into one appended mask; open path,
  group, zero scale refused by name).
- `Editor/src/path-edit.ts`: `editTarget(.., mask)` and `editPathEdit(.., mask)` point the path tools at a mask (`editPath`
  target `mask`), with the same lock and group rules.
- Page: Masks and track matte section under Properties (`masks-mount`), `Pen: Auto/Shape/Mask` and a line that says what the next
  path will be, `Edit path` / `To shape` / `Copy as mask` buttons.
- Tests: `Editor/tests/mask-edit.test.ts` (28 tests with the page wiring); web suite 1167 passed; typecheck clean.
- Not done: a window check; masks of an object inside a group; drag-to-reorder; a mask boundary and feather overlay on the canvas.

## The real-window checks of 24 Nov 2026 (the DevTools build, page-level input, no OS key or click)

Drivers and screenshots are in `tools/` and `shots/`. What the real window showed:

- **Masks tab** beside Properties and Pivot; **Add mask** put a boundary on the canvas (`.overlay-mask`) and a row in the panel; **mode**
  (all seven), **feather** (a band as wide as the feather, `.overlay-mask-feather`) and **opacity** changed through one edit each and
  read back after the re-render; **Up** and **Remove** reordered and removed; Ctrl Z returned each.
- **Edit path** on a mask put the path tools on it (4 vertex markers, the mask drawn heavier); a drag of the first vertex changed the
  mask's path and Ctrl Z restored it exactly. A snap to the canvas centre showed its guides while the drag was within reach.
- **Pen: Auto** on a selected rectangle drew a mask in one step (3 masks after 3 drawn); **Pen: Shape** drew a shape; an open path as a
  mask was refused with the reason and given back, and a second Escape let it go.
- **G** went Pen, Add, Delete, Convert, Pen; **P** picked the Pen; **Alt-click** swapped a vertex corner to smooth and back.
- **Track matte:** picking the ellipse for the rectangle set it and turned the ellipse's eye off in the same step; its mode, **Clear** and
  **Preserve underlying transparency** worked.
- **Effect Mask Reference:** after applying the Soft glow preset the panel listed `glow` with the layer's mask ids; setting it to
  `mask-1` worked; removing that mask cleared the reference first (no dangling reference reached the engine).
- **Copy as mask** and **To shape** made independent copies; **Copy SVG** put `M0 0 C...` on the clipboard (64 characters for a
  three-vertex path).
- **Join** (Ctrl J) joined two Pen lines into one shape with three vertices and undo returned both; **Alt-click with the Delete Vertex
  tool** took a vertex out keeping the shape ("0.00 px") and kept a real corner, saying "would move the shape by 13.73 pixels, more than
  the 1 allowed".
- **Settings window** listed Pen angle step, pick distance, snap, double click and the keep-shape tolerance.

Not seen in a window: a mask of an object inside a group (held by the engine-resolved fixture instead), the pick-whip (not built), and the
draft view drawing the shapes (13.5).
