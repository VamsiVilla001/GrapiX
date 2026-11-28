# What stays on screen, and what is called on demand (26 Nov 2026)

The owner asked, before anything is removed from the Editor: compare the running Editor with the Figma screens, decide which tools
and panels stay visible and which are hidden until called (click, hover, shortcut, menu), update the Figma screens to match, and only
then change the Editor. Nothing has been removed from the Editor yet.

**Compared:** the running Editor (Design layout: 7 panels at the left, the viewport, 11 panels at the right, a three-group timeline
toolbar, about 20 toolbar buttons, a multi-line Activity log) against Figma B1 Start, B2 Editor main, B3 Timeline, B3d Properties and
B13 Library (file `gyGkmEFX4oAuknNNI4dq9k`).

**Rule:** what is used in nearly every session of building, animating and sending a graphic stays visible; everything else is one
click, hover or shortcut away. Nothing that works is deleted: it moves to where it is called.

**Asked first** (`docs/evidence/figma-ui/visibility-input.json`, answers `jev-laya-visibility.json`, no truncation): Jev chose A on all
six questions (confidence 1.0 each). Laya chose to keep everything visible (B or C) on all six, at confidences 0.04 to 0.21: it is
uncalibrated and a second opinion, but it was consistent, so it is flagged to the owner rather than buried.

## Always visible

| What | Detail |
|---|---|
| Menu bar and context line | eight menus (owner, 24 Nov); scene, Scene ID, format at the right |
| Core tools | Select, Move, Rotate, Scale, Pivot, Pen; Rectangle, Ellipse, Text |
| Search, Layout, engine chip | Undo, Redo, Publish… |
| Elements | + Box, + Text, + Image and the list |
| Scene tabs | the open graphics, with + to open another |
| Composition header | name (click: Composition popover), DRAFT, size and fps |
| Viewport footer | Fit, zoom %, time, Authoring preview; a warning chip when something is not drawn |
| Properties, one list | element card at its top; keyframe card while keys are selected; a diamond on every animatable row |
| Timeline | strip that opens to the full timeline, one bar: transport, + Add key, easing, Hold, Stagger, Zoom to fit, Auto-key |
| Status bar | Logic, Library, latest message, frame render time |

## On demand, and how it is called

| What | How it is called |
|---|---|
| Path tools (Pen mode, Edit path, Add, Delete, Convert vertex) | a context bar shown only while the Pen or path editing is active; shortcuts kept |
| Hand, Zoom | shortcut (H, Z, Space-drag) and tooltip |
| Scenes list | File > Open, the Start screen, + on the scene tabs |
| Scene ID, Rate, View, backdrop, Guides | click the composition name: Composition popover; also the View menu |
| Preview transport, playback settings | transport in the timeline bar; settings in a popover on the timecode |
| Engine detail | hover the engine chip |
| Not drawn by this preview | the footer warning chip opens the list |
| Pivot, Masks, Effect Controls | Properties sections that appear when the element has them; added from the Add row |
| Animation panel | replaced by the diamonds on Properties rows and Auto-key |
| Text styles, Fonts, Effects & Presets, Materials, Assets | tabs of the Library screen (status bar); effects also by shortcut |
| Take page, Template controls, bindings | the Data block of Properties and the Data screen |
| Activity log | click the status-bar message: full history |
| Timeline presets, phases, Stagger settings | Motion menu and key right-click; Stagger settings in a popover on its button |
| Snap, Markers | not drawn until they are features (Jev, 24 Nov) |

## Figma, as updated on 26 Nov 2026

- Shared components, so every screen follows: `Editor/MenuBar` (13:28) now has the eight menus; in `Editor/Ribbon` (30:606) the
  journey step chips and Fix next issue (35:486) and their separator (35:503) are hidden, not deleted (owner, 24 Nov).
- New section **Editor UI v2 · what stays, what is on demand (26 Nov)** (94:7118), below Editor screens:
  - V0 What stays, what is on demand (94:7119): this decision as a board.
  - B2v2 Editor main · the visible set (94:7120): + on the scene tabs, a ▾ on the composition name, the footer not-drawn chip.
  - B2v2 Pen active · path tools on demand (94:7253): Pen shown active, the floating path-tools context bar (94:9062).
  - B2v2 On demand (94:7386): Composition popover (94:9077), engine hover card (94:9108), Not drawn list (94:9123), Activity history (94:9127).
  - B3v2 Timeline · one bar with Stagger (94:7519): Snap and Markers hidden, Stagger button and its popover (94:9135), the open blend menu of the old state closed.
  - B3d v2 Properties · one list (94:7924): Text animator and the parent's Shape section folded to headers, Pivot, Masks and Effects sections and an Add row, the Case dropdown open with Small caps dimmed and its reason (95:7590).

## Built in the Editor, 26 Nov 2026 (after the owner reviewed Figma: "Figma looks fine, go ahead")

- **Toolbar** (`Editor/src/toolbar-context.ts`): the path tools and the Pen's note are one group shown only while the Pen or a path tool
  is in use; Hand and Zoom only while each is the tool (keys H and Z); line up and spread only with two or more elements selected
  (the narrow-window rule that hid it is gone: the ribbon has room now).
- **Viewport**: the header is the composition name (a button that opens the Composition popover: name, Scene ID, file name, View,
  backdrop, Guides, Rate), DRAFT, size and fps; the view note is DRAFT's tooltip. The footer is Fit, zoom %, time, the not-drawn chip
  (opens the list) and Authoring preview; zoom in and out are Ctrl = and Ctrl -. Popovers: `Editor/src/popover.ts` (one open at a time,
  Escape and a press outside close them).
- **Docks** (`Editor/src/dock-on-demand.ts`; no layout data changed, every panel keeps its place): Pivot shows with the Pivot tool,
  Masks when the selection has masks or the Pen is about to draw one, Effect Controls when the selection has effects; Preview, Not drawn,
  Text styles, Fonts, Effects & Presets, Materials and the Scenes list wait until opened (Panels menu, Library tabs); going back to
  Properties puts them away. The timeline's KEYFRAME bar has Prev, Play (Pause while playing) and Next.
- **Timeline row** (asked first: `docs/evidence/figma-ui/jev-laya-timeline-row.json`; Jev: Easing in its own popover 0.62, Stagger
  caret 0.94, Presets and Phases as popovers 0.97; Laya differed at confidences 0.01 to 0.32): the Keys / Presets / Phases row is gone
  from the screen. Stagger's settings open from the caret after Stagger (Stagger still runs at once); Easing…, Motion presets… and
  Phases… are popovers opened from the Motion menu and the timeline's right-click (which also has Stagger settings…). Every control
  kept its id; the Motion menu's Apply entry / exit preset and Play this phase still work.
- **Text choices as dropdowns** (Figma B3d v2): Case, Align, Vertical align, Box and Fit are fields showing the value; the list opens
  on a click, an option the engine cannot draw is dimmed with its reason under it (Small caps: row 11.51), and Escape or a press
  outside closes it. The options are the same `choose` actions, so agents read the same thing.
- Seen in a real window on 26 Nov: the caret, Motion > Motion presets…, the right-click's four items, Escape and outside presses; a
  text's Case list and Set Case to Uppercase. Mutants 8 of 8 (`docs/evidence/figma-ui/mutation-log-timeline-choices.txt`).
- **Properties, one list** (asked first: `docs/evidence/figma-ui/jev-laya-properties-sections.json`; Jev A on all three at 1.0, 0.83
  and 0.77; Laya differed at 0.02 to 0.13): while Properties is shown, Pivot, Masks and Effect Controls stand under it as sections in
  one scrolling column when the tool or selection calls for them, their tabs not drawn (`sectionsUnder` in `dock-on-demand.ts`); a
  stored layout that moved one of them out of the group keeps it where the person put it. An Add row at the foot of Properties
  (`Editor/src/properties-add.ts`): + Effect opens Effects & Presets, + Mask puts the Pen in mask mode, Pivot picks the Pivot tool,
  dimmed with the reason until something is selected. The Animation panel waits until opened (Motion > Motion controls); Auto-key
  is a toggle at the right of the KEYFRAME bar that presses the panel's own checkbox. Seen in a real window; mutants 8 of 8
  (`docs/evidence/figma-ui/mutation-log-properties-sections.txt`).
- **Status bar**: the Activity log is now one 26 px line: Library (opens Effects & Presets), the newest message coloured as its
  entry (click it, or Panels > Activity log, for the full history in a popover above the bar), and the engine's last frame time
  (`Editor/src/status-bar.ts`). Logic is not drawn until it is a feature (the Snap and Markers rule). Seen in a real window; mutants
  5 of 5 (`docs/evidence/figma-ui/mutation-log-status-bar.txt`).
- **Colour** (row 11.132, frontend, on codex's colour keys): Fill and Stroke rows in Properties with picker, diamond and arrows; colour
  tracks in the timeline; the Draft view draws the in-between colour. Detail in `docs/log/2026-11-26.md`.
- **Scene tabs and engine chip**: the tabs end in a + that opens the Scenes list; the engine chip stays one word and its detail (the
  status, what the engine said, the last frame's draw time) is a card on hover or keyboard focus (`engineHoverLines`,
  `Editor/src/engine-preview.ts`). Seen in a real window; mutants 5 of 5 (`docs/evidence/figma-ui/mutation-log-engine-hover.txt`).
- **Library screen** (B13): the status bar's Library, Panels > Library, and Escape or Close. A strip of seven tabs (Assets, Colours,
  Layer styles, Text styles, Fonts, Effects & Presets, Materials) over one full-size body: the panel a tab names is brought out of
  its dock while the screen is open and put back where it stood (folded, if it was) when it closes; a panel only the screen opened
  goes back to being put away (`Editor/src/library-screen.ts`). Nothing is rebuilt, so every control in each panel is the same one.
  Seen in a real window: all seven tabs, Escape, the menu item and Close; mutants 7 of 7
  (`docs/evidence/figma-ui/mutation-log-library-screen.txt`).
- **Data screen** (B4) and the Properties Data block: the element card's Data block has an Open Data button, the status bar has Data
  beside Library, and Panels > Data opens the same screen: four tabs (Data, Template controls, Take page, Publish) over one body, the
  same movement as the Library screen, the panels put back on close. Opening one screen closes the other. Seen in a real window; mutants
  4 of 4 (`docs/evidence/figma-ui/mutation-log-data-screen.txt`).
- **Figma v2 brought in line with the build, 26 Nov 2026** (after the owner asked to cross-check, and to add what a broadcast graphic
  needs, cleanly): in the five v2 frames the status bar reads Data and Library (Logic is not drawn until it is a feature) and the
  card's Data block ends in Open Data; the Stagger popover (94:9135) keeps its settings and loses its own run button, which the
  Stagger button replaces; two frames are new below the others in the section: B13v2 Library screen (103:7555, the seven tabs
  Assets, Colours, Layer styles, Text styles, Fonts, Effects & Presets, Materials) and B4v2 Data screen (103:7849, Data active).
  What a broadcast graphic needs was already drawn in v2 and stays: the Data block's Auto-fit and Hide when empty with the overflow
  warning, Max lines and Overflow, the "text · field" tags, and the Scene ID with "1080p50" in the context line. Those are build gaps,
  not design gaps: see the cross-check in `docs/log/2026-11-26.md`.
- Every row of the visibility decision is now built. Open: the Logic button (not drawn until it is a feature) and Snap and Markers
  (same rule).
