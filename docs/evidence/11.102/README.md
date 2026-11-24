# 11.102, 11.103, 11.104: the tool ribbon, the Pivot panel and the Pen tool (23 Nov 2026)

The user pointed out that the Editor's tool strip lacked what a graphics application has: Move, Rotate, Scale and
Pivot tools and the align buttons, and then asked for the Pen tool, a check of EffectCraft and After Effects for the
tools they have (pen, feather and others), and an anchor point mover inside the application. All three rows stay
`active` (see the end).

## What was missing

The viewport had the Select tool and the three create tools. Move, Rotate, Resize and Centre point were greyed menu
items waiting for 11.44 (3D gizmos, rulers); the line up and spread commands built for 11.83 were in the Edit menu only.
Nothing dragged an object in the viewport.

## What EffectCraft and After Effects have (read-only)

- **EffectCraft** (`crates/ui-egui/src/state.rs`, 30 tools): Selection, Hand, Zoom, Rotate, Pan Behind (the pivot), five
  shape tools, Pen with Add, Delete and Convert Vertex, Mask Feather, two Type tools, Brush, Clone, Eraser, Roto Brush
  and Puppet pins. `crates/path/src/feather.rs` is variable-width mask feather: feather points on the path with a signed
  radius and a tension, interpolated along the path. Its `ShapePath` has a keyframable `feather` list.
- **After Effects 2026** (install, names only): the Tool Palette plugin, cursor images for Pen, Pen Add, Pen Close, Feather,
  Feather Add and Delete, Hand, Zoom, Pan Behind, Rotate, Horizontal and Vertical Type, Starch (puppet). No shortcut
  list in the install; the keys are from general knowledge and match EffectCraft's table.
- **GrapiX before**: `BezierPath`, `createShape`, `setShapePath`, `setObjectMasks`, a uniform mask feather (0 to 250), a
  `setAnchor` edit that the engine draws with. No per-vertex feather, no Hand or Zoom.
- Recorded as rows: 11.105 Hand and Zoom, 11.106 shape tools, 11.107 path editing, 11.108 variable mask feather, 11.109
  canvas text tool.

## A mistake corrected

I first said the Pivot tool needed a contract change. It does not: `setAnchor` exists and the engine uses the anchor, so
the tool was built in the page (the plan row and a test that said otherwise were rewritten).

## The three anchor point repositories

The user gave `JoeMighty/AE-Toolkit`, `evefalcao/EF_Manipulate-Anchor-Point` and `ivg-design/AE` to check. They were read
through web fetch (nothing cloned) and none of their code is used.

| Repository | Licence | What it does |
|---|---|---|
| AE-Toolkit `AnchorManager.jsx` | MIT (badge; LICENSE file 404) | 3x3 grid; the point is the layer's `sourceRectAtTime` box; position moved through `toComp`/`fromComp` |
| EF Manipulate Anchor Point | **README says CC BY-SA 4.0, LICENSE.md is CC BY-NC-SA 4.0**: non-commercial, share-alike | 3x3 grid plus X/Y/Z offset; mask vertices as the bounds when masks exist; optional null, parent and expression |
| ivg-design/AE (Reseterator, Originator, Rectangulator) | MIT (README; LICENSE file 404) | reset anchor to 0 without compensating (shifts the picture); recentre path vertices; a 9-point anchor popup |

The panel is built from the arithmetic of the engine's transform, T(x, y)·R·S·T(-anchor): a point q of the object lands
on the canvas at (x, y) + R·S·(q - anchor), so moving the pivot to q' without moving the picture moves (x, y) by
R·S·(q' - anchor). A test checks, for many rotations, scales and pivots, that every point of the object lands where it
did. From the screenshot the user sent of "AC Anchor Point Mover", the panel is an arrow grid with a target in the
middle and an "If keyframed" choice (insert a keyframe at the playhead, or modify the existing keyframes).

## What was built

- **The ribbon** (`index.html`, `app-menu.ts`, `command-registry.ts`): Select (V), Move (W), Rotate (E), Resize (R), Pivot
  (Y), Pen (G), the three create buttons and eight line up and spread buttons. Every button is a command of the 11.31
  registry: it dims with its reason as the tooltip, a refused click says the same words in Activity, and the menu
  item and the key do the same job. The new icons are drawn for GrapiX (not Phosphor's) on the same grid.
- **`transform-tools.ts`** (Move, Rotate, Scale, Pivot): pure drag arithmetic; one drag is one batch and one undo step;
  the picture follows the pointer while it is dragged and Escape drops the drag; Shift keeps an axis or the 15 degree
  grid; a drag can turn past a half turn; the middle is read from the object as drawn at the playhead; refused by name
  for a locked object or group, keys on what the tool changes, a group above that is turned, a start on the middle, a
  scale of 0. The Pivot drag sends one `setAnchor` and the position fields, so no point of the object moves.
- **`anchor-point.ts` and the Pivot panel** (`pivot-panel.ts`, `index.html`): the nine places, offset, selection scope,
  typed pivot, nudge, reset, keep in place, and "If keyframed" (insert a key at the playhead from the object as drawn
  there, or move every key of the position by the same distance, refused by name when the turn or scale has keys).
  Requests are queued so a typed Y straight after a typed X is planned from the document the X made.
- **`pen-tool.ts`**: corner and smooth points, Shift 45 degrees, closing on the first point, Enter or double click for
  an open path, Backspace, Escape; one `createShape` batch (an open path also clears its fill and gets a white stroke of 6
  with round ends, on the id the engine will give); the path is given back if refused; never finished in another scene.
- **Overlay**: a pivot marker while the Pivot tool is in use, the Pen's sketch (points, handles, the segment the pointer
  would add, the first point lit when a click would close), a shape's box taken from its path, thin lines can be picked.

## Checks

- **Tests:** 1035 web tests in the whole suite and 145 script tests, all passing; typecheck, check:boundaries and the
  other checks pass.
- **Mutants:** `tools/mutate_tools.py` (57 of 57 for the drag tools, run before the second round of changes) and
  `docs/evidence/11.103/tools/mutate_pivot_pen.py` (**111 of 111** over the pivot arithmetic and plan, the panel's view,
  the Pen, the Pivot drag, the overlay and the page wiring). The first round caught 90 of 98; the 8 survivors showed real
  gaps in the tests (a selection offset, a differing y, a click exactly at the closing distance, the wording of a refusal,
  the pen's overlay, the keyed choice, selecting the new shape, the closing distance).
- **Code review, twice** (independent, read-only). The second found 9 real problems, all fixed: a double click that closes a
  path left a stray point and logged a false error; keys on the turn or scale gave the wrong compensation; the path was never
  reset when the scene changed; Delete and Escape were swallowed with no path; a straight line could not be picked; a
  refused shape lost the path; two quick typed values could use a stale scene; the selection scope ignored animation; a
  shared predicted id (the engine's busy guard stops it).
- **Real window** (a DevTools build, page-level pointer input): the panel's nine places (centre put the pivot at 100, 60
  and moved the position to 960, 540, undo restored it), the Pivot tool (dragging 60 right and 40 down moved the pivot by
  that and the position with it), the Pen (closed a shape on its first point, finished a curved line with Enter, Backspace
  took a point back, Escape dropped the path, one point left and a tool change made nothing), a double click on the first point
  made one shape and no stray point, Escape with the Pen and no path cleared the selection, a straight line was picked
  2 px off. The "If keyframed" modes are held by tests, not seen in the window.

## Still open (why the rows stay `active`)

- **11.102:** Hand and Zoom (11.105). **11.103:** the editor MCP does not list the panel's actions.
- **11.104:** the draft view does not draw shapes (it names them and waits for the engine preview, 13.5), so a drawn shape
  appears in the Engine preview; editing a path afterwards is 11.107.
- A first launch of a fresh profile through File > Recent left the dock layout unapplied until a reload (the page waits for
  the Start window). That was my script's route, not the product's.
