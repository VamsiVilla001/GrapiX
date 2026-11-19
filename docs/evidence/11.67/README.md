# 11.67 compact, clean UI and UX pass (18 Nov 2026): first slice

Reviewers: Jev and Laya take **text only**, so they could not look at the screenshots in this folder. They were given measured facts
(`jev-laya-ux.json`). Their confidence was low and Laya disagreed on all three; nothing here is a strong verdict.

| Question | Jev | Laya | Done |
|---|---|---|---|
| Where Help lives | in the page (0.18) | native | **Left as it is** (native Help in both apps). Open decision for the user: the native row is about 30 px for one word. |
| Density | compact 28 px (0.43) | keep | Playout setup controls 28 px, transport unchanged; the Editor was already at or under 28 px, left alone |
| Label case | capitals only for states and the transport (0.49) | all capitals | Applied in Playout: sentence case 12 px labels; CUE, CLEAR, TAKE, HOLD, CONTINUE, UPDATE, TAKE OUT and state chips stay capitals |

Also done: 66 hard-coded colours in the Editor and 17 in Playout replaced by SKWAD tokens (`#df4dc4`, the canvas guide colour, and the
alpha overlays kept on purpose); the Editor's selected tool, active tab, selected rows and playhead are ember instead of blue;
Playout's header reads `GrapiX Playout` (Anybody 800), not `GRAPIX PLAYOUT`; a second in-page Help menu I had added to the Editor
was removed (two Help menus in one window); the Scene Manager's `Project` label is no longer clipped.

Screenshots: `gx-editor.png`, `gx-playout.png` (captured from the running windows).
