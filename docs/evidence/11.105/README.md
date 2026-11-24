# 11.105: Hand and Zoom (23 Nov 2026)

Pan and zoom for the viewport, from the gap found with the tool ribbon (11.102): EffectCraft and After Effects both have Hand
and Zoom, and the Editor had neither. The Pen (11.104) needs them for precise work. The row stays `active` (see the end).

## How it works

The view is a **camera over the picture**: a zoom (1 is "fit to the pane") and a pan in screen pixels, applied as ONE CSS
transform on the viewport surface, which holds the backdrop, the canvas, the engine's picture and the selection overlay.
Every tool maps the pointer through the overlay's own box (`getBoundingClientRect`), so each one stays true at any zoom and
pan without a single change to the tools. The view is the Editor's, not the scene's: nothing reaches a command, a project or an
undo step (a test holds that the view's code never calls `runEdits`, `runCommand` or the shell).

- **Wheel:** zooms where the pointer is (the point of the picture under it stays under it). Shift moves the view across. A
  trackpad pinch arrives as a Ctrl wheel and zooms the same way. A line or a page of wheel is turned into pixels first.
- **Hand (H):** dragging moves the view. **The middle mouse button** does the same with any tool.
- **Zoom (Z):** a click zooms in where it is made, Alt-click zooms out.
- **Fit, Zoom in, Zoom out, Actual size:** buttons in the viewer footer (the old "Fit" was a label that did nothing), Layout menu
  items, and the keys Ctrl 0, Ctrl = (or Ctrl +), Ctrl - and Ctrl 1. Held, Zoom in and out repeat. The readout beside them is
  the picture's size on screen as a percent of its own size (100% is one canvas pixel to one screen pixel).
- **Space stays the play key.** It is not the temporary hand as in After Effects, because a Space press already runs the
  preview and a hold cannot be told from a press until it is over; the middle button is the temporary hand.
- A margin of the picture (48 px) always stays inside the pane, so it cannot be pushed out of reach; zoom is held between a
  tenth of Fit and 32 times it; another scene starts at Fit.
- **Markers keep one size on screen.** The overlay model takes the size of a screen pixel in canvas pixels (`unit`), so handles,
  the Pen's points and handle ends and the pivot marker do not grow when zoomed in or shrink when zoomed out.
- A Pen path in progress waits while Hand or Zoom is chosen (they only move the view) and carries on when the Pen is chosen
  again; choosing an editing tool still finishes it.
- Every control is a command of the 11.31 registry: it dims with its reason, the menu item and the key do the same job.

## Checks

- **Tests:** 1081 web tests and 149 script tests, all passing (a new node test reads the stylesheet, since Vitest does not load
  CSS); typecheck and the other checks pass.
- **Mutants** (`tools/mutate_view.py`): **75 of 75 caught.** The first round caught 66; the 9 survivors showed real gaps: the point
  a percent zoom is about, the percent readout's rounding, the zoom step, the pen's and the pivot marker's size at a zoom, and
  three details of the pan (where it starts from, that the pointer is captured, that the grab cursor lets go).
- **Real window** (a DevTools build, page-level pointer and wheel input): a wheel turn zoomed to 157 percent with the point under
  the pointer moving 0.1 px; a selection handle stayed 10 px on screen; a 30 screen pixel Move drag at that zoom moved the object by
  98.07 canvas pixels, exactly 30 divided by the scale; the Hand tool moved the view by the drag (60, 25) with the grab cursor and a
  `panning` flag that cleared on release; the middle button panned in both directions with the Select tool; a 700 pixel drag
  stopped at the pan limit (620.6 and 223.0 against computed limits of 620.5 and 222.9); the Fit button, the Zoom tool in and out,
  Actual size (100%), Ctrl 0, Ctrl =, Ctrl - (twice) and H all did what they say.
- **Not done:** the independent code review was started and then stopped by the user before it reported, so this row has none.

## Still open (why the row stays `active`)

- Rulers, margins and guides (11.44) do not exist yet, so there is nothing for the view to keep true beyond the tools and the overlay.
- A drag with the Zoom tool to zoom into an area.
- The draft view does not draw shapes (it waits for the engine preview, 13.5): zooming in on a Pen shape shows its outline and handles
  in the overlay, and the shape itself in the Engine preview.
- A picture zoomed past the size it was drawn at is scaled, not redrawn (the draft canvas is not re-rendered at the zoom).
