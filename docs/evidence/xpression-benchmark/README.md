# Ross XPression menu benchmark: what GrapiX has and what it lacks (23 Nov 2026)

Source: `docs/reference/xpression-menu-bar.md`, the research reference of Ross XPression Studio's menu bar,
which marks what it could not verify. Ross is the benchmark for the basics of a motion graphics
application; AI is left aside. 64 items were matched against the plan rows: every menu entry and panel
the reference shows, plus the XPression workflow it implies (sequencer, as-run log, data links, external
control, MOS, crawl and roll, audio, live video, key and fill, tracking, security, localisation).

## How it was matched

1. **By hand** (the verdict that stands): each item was matched to the plan rows that might cover it,
   with the row's status. Verdicts: **built** (the rows are done or the feature works), **planned** (a row
   covers all of it but it is pending), **partial** (some is built or planned and a named part has no row),
   **missing** (no row, nothing built).
2. **Jev and Laya** were then asked the same typed questions on the same state, without the hand
   verdict: the coverage (those four) and whether the feature is core for a broadcast graphics application
   benchmarked on XPression. Laya is `laya-multilingual` at 8192 tokens, not truncated. Inputs and
   answers: `items.json`, `jev-laya-coverage.json`; tools in `tools/`.

| Coverage agrees with the hand verdict | Jev | Laya |
|---|---|---|
| of 64 items | 32 | 17 |

Laya called 46 of 64 items "missing" and gave "core" a probability above 0.5 for almost
everything, so it is a second opinion and not a vote, as before. Jev agrees with the hand verdict on half
the items; where it differs it mostly says "partial" for something I judged built or planned (it wants
proof that every part works) and "built" for something whose backend exists but whose UI does not
(Export Package, Record Client, PBus); on those the hand verdict stands, for the reasons in the notes
column of `hand-verdicts.json`. Where Jev gave "core" under 0.5 (Human Interface Devices 0.36,
Tessera 0.44, Display project path 0.43, Flush 0.39, Debug 0.39, Record Client 0.30, MOS 0.42) the item is
treated as optional or later, not core.

## The table

| XPression item | Hand | Jev | Laya | Jev core | Laya core | Rows that might cover it | Row that builds it now |
|---|---|---|---|---|---|---|---|
| File > New project | built | missing | planned | 0.86 | 0.81 | 11.43 |  |
| File > Open Project and Open Recent | built | partial | partial | 0.84 | 0.79 | 11.43 |  |
| File > Revert | missing | missing | planned | 0.70 | 0.68 | 11.30, 11.43 | 11.85 |
| File > Import > From Project/File | missing | partial | missing | 0.82 | 0.83 | 7.2, 11.43, 11.64 | 11.85 |
| File > Save, Save As, Increment And Save | partial | partial | missing | 0.88 | 0.85 | 11.30, 11.43 | 11.30 (Save As built 23 Nov) |
| File > Export Package | partial | built | missing | 0.76 | 0.89 | 1.8, 7.6, 7.7 | 11.85 |
| File > Project Server: Publish, Deploy, Setup | partial | partial | missing | 0.85 | 0.96 | 6.1, 7.6, 5.10, 12.2 | 11.57, 11.81 |
| File > Exit | built | missing | missing | 0.77 | 0.91 | - |  |
| File (Sequence) > Take Item List: import and export XML, Insert Take Item | partial | partial | missing | 0.63 | 0.85 | 6.4, 12.3, 11.57 | 6.9 |
| Edit > Undo, Redo | built | built | missing | 0.91 | 0.91 | 11.37 |  |
| Edit > Undo/Redo History | missing | built | missing | 0.83 | 0.92 | 11.37, 11.35 | 11.82 |
| Edit > Select, Move, Rotate, Scale, Pivot tools | partial | partial | missing | 0.90 | 0.91 | 11.7, 11.44 | 11.44 |
| Edit > Object Align | missing | missing | missing | 0.79 | 0.82 | 11.44, 11.45, 11.9 | 11.83 |
| Edit > Human Interface Devices | missing | missing | missing | 0.36 | 0.85 | 11.31 | 6.8 |
| Edit > Scripting | planned | planned | missing | 0.77 | 0.77 | 16.4, 11.55, 16.14, 16.15 | 16.4, 11.55 |
| Edit > OpenMAM Setup and Clip Store Setup | missing | partial | missing | 0.72 | 0.66 | 16.1, 11.52, 11.49 | 16.18 |
| Edit > Keyboard / GPI Mapping | partial | partial | planned | 0.79 | 0.78 | 11.31, 6.6, 11.30 | 11.84, 6.8 |
| Edit > Tessera (camera tracking, virtual studio) | missing | partial | planned | 0.44 | 0.70 | 3.7, 11.48, 16.8 | 16.20 |
| Edit > Hardware Setup | partial | partial | missing | 0.83 | 0.81 | 6.5, 12.7, 15.1, 15.2, 15.4, 15.5 | 11.87 |
| Edit > Preferences | missing | partial | missing | 0.84 | 0.59 | 11.43, 2.4, 2.8 | 11.81, 2.28 |
| Windows > Windows menu, docking layouts | partial | partial | partial | 0.89 | 0.88 | 11.33, 11.5, 11.76, 11.75 | 11.33, 11.76 |
| Projects > Convert Project Mode and project settings | partial | partial | partial | 0.84 | 0.79 | 11.43, 3.15, 1.1 | 7.8, 11.85 |
| Projects > Display project path in Explorer | missing | missing | missing | 0.43 | 0.85 | 11.43 | 11.85 |
| Animation > Animation Controller, Set Keyframe | built | built | missing | 0.90 | 0.72 | 11.20, 11.21, 11.68 |  |
| Animation > Scene Director | partial | partial | missing | 0.88 | 0.25 | 11.25, 11.53, 11.10 | 11.53 |
| Animation > Key Graph Editor | built | partial | missing | 0.88 | 0.72 | 11.11, 11.23, 11.78 |  |
| Display > Project Manager panel | partial | partial | missing | 0.89 | 0.91 | 11.43, 11.52, 11.64 | 11.52 |
| Display > Scene Manager panel | built | partial | missing | 0.90 | 0.91 | 11.64, 11.72 |  |
| Display > Object Manager panel | built | partial | missing | 0.92 | 0.70 | 11.8, 11.45 |  |
| Display > Material Manager panel | built | built | missing | 0.79 | 0.64 | 11.12, 11.50 |  |
| Display > Object Inspector panel | built | built | missing | 0.87 | 0.84 | 11.9, 11.46 |  |
| Display > Widgets panel | planned | planned | missing | 0.70 | 0.86 | 11.56 | 11.56 |
| Display > Stagger Animations | planned | planned | partial | 0.54 | 0.56 | 11.77 | 11.77 |
| Display > Effects panel | built | partial | missing | 0.93 | 0.96 | 11.69, 11.70, 11.79, 3.25 |  |
| Display > Clip Browser | missing | partial | partial | 0.80 | 0.85 | 11.49, 16.1, 11.52 | 11.86, 16.18 |
| Display > Server Channels | missing | missing | missing | 0.69 | 0.72 | 15.2, 15.3, 6.5 | 11.87 |
| Display > PBus Mapping | partial | built | missing | 0.79 | 0.84 | 11.19, 11.26, 11.54 | 6.8 |
| Display > Object Library | planned | partial | missing | 0.84 | 0.90 | 11.47, 11.48, 11.40, 6.1 | 11.47, 11.40 |
| Display > Audio Files | missing | missing | missing | 0.74 | 0.86 | 11.43, 3.25 | 11.86, 16.17 |
| Display > Sequencer List | planned | planned | planned | 0.78 | 0.73 | 6.4, 12.3 | 12.3 |
| Display > Output Monitors | planned | partial | missing | 0.90 | 0.91 | 12.5, 11.65, 3.11 | 12.5 |
| Display > Online Preview | built | partial | missing | 0.86 | 0.83 | 11.65, 3.21, 8.9 |  |
| Display > Take Inspector | planned | missing | missing | 0.76 | 0.93 | 12.3, 12.8, 11.27 | 12.8 |
| Display > Object Toolbar | built | planned | missing | 0.86 | 0.85 | 11.32, 11.7 |  |
| Display > Status Log | built | built | missing | 0.51 | 0.85 | 2.11, 2.27, 11.74 |  |
| Tools > Advanced > Flush | missing | missing | missing | 0.39 | 0.90 | 11.58, 2.27 | 11.58 |
| Tools > Debug > Video Cache Monitor | partial | missing | missing | 0.39 | 0.83 | 11.58, 2.27, 2.14 | 11.58 |
| Tools > Input Grabber | missing | planned | partial | 0.71 | 0.92 | 15.2, 15.4, 11.49 | 16.19 |
| Tools > Record Client | partial | built | missing | 0.30 | 0.92 | 3.10, 14.5 | 11.87 |
| Help > Help Topics | missing | missing | planned | 0.54 | 0.24 | 2.14 | 11.88 |
| Sequence > Sequencer: ordered take items, cue, take, out, run order | planned | partial | missing | 0.88 | 0.91 | 6.4, 12.3, 12.4, 12.8, 12.9 | 12.3, 12.8 |
| Sequence > As-run log | built | partial | missing | 0.76 | 0.69 | 12.11 |  |
| Data > DataLinq: live data from XML, CSV, Excel, databases and web | partial | partial | missing | 0.79 | 0.68 | 11.19, 19.2, 19.4, 19.5, 19.6, 19.8 | X4, parked (19.x) |
| Control > External control protocol (RossTalk), automation, GPI and tally | missing | missing | missing | 0.65 | 0.84 | 6.6, 8.11, 2.23 | 6.7 |
| Integration > MOS newsroom integration | missing | partial | planned | 0.42 | 0.76 | 6.4, 12.3 | 6.9 |
| Objects > Crawl and roll (ticker, credits) | missing | partial | missing | 0.82 | 0.86 | 11.51, 11.55, 12.10 | 11.90, 11.89 |
| Objects > Live video in a scene (camera feeds, picture in picture) | missing | planned | partial | 0.77 | 0.63 | 11.49, 16.1, 15.4 | 16.19 |
| Audio > Audio: sound with graphics, levels, output | missing | missing | planned | 0.61 | 0.82 | 11.43 | 16.17 |
| Outputs > Key and fill video outputs, genlock, multiple channels | planned | partial | missing | 0.86 | 0.93 | 12.5, 12.10, 15.2, 15.4, 15.5 | X2, parked (15.x) |
| Virtual > Camera tracking and virtual studio | missing | partial | missing | 0.57 | 0.74 | 3.7, 16.8 | 16.20 |
| Security > Operator roles and permissions | built | partial | planned | 0.81 | 0.51 | 2.9, 2.15, 5.7 |  |
| Preferences > Localisation and language | missing | built | planned | 0.63 | 0.73 | 11.42, 1.1 | 11.91 |
| Sequence > Template pages for operators (fill fields, constraints) | partial | partial | missing | 0.86 | 0.92 | 11.26, 11.54, 12.8 | 11.54, 12.8 |
| Animation > Scene transitions and transition effects | planned | planned | planned | 0.80 | 0.79 | 16.3, 11.55 | 16.3 |

## What the benchmark found missing, as core modules

Built or planned already (no new row): the project start and save-as flow, scene and object managers,
materials, inspector, effects, keyframes and the speed graph, preview, the rundown engine, the as-run log,
roles and tokens, diagnostics.

**Added as rows on 23 Nov 2026** (19 from the research, plus 11.91), each in the module it builds, with a
done-when taken from the research in `research.md`; all start as pending in `progress.json`:

| Row | Module | What |
|---|---|---|
| 2.28 | B2 Platform | Settings service: user, machine and project scopes |
| 6.7 | B7 Playout services | External control interface: station automation over TCP and HTTP |
| 6.8 | B7 | GPI, tally and control-surface input |
| 6.9 | B7 | Rundown import and export, and a MOS device |
| 7.8 | B7 | Project modes and conversion |
| 11.90 | B10 Text engine | Scrolling text objects: crawl and roll |
| 16.17 | B14 Content depth | Audio: objects, playback, output |
| 16.18 | B14 | Clips: media service, thumbnails, codecs and alpha |
| 16.19 | B14 | Live video input as a layer |
| 16.20 | X5 (later, optional) | Camera tracking and virtual studio |
| 11.81 | F1 Editor workspace | Preferences dialog |
| 11.82 | F1 | Undo and redo history panel |
| 11.83 | F1 | Object align, distribute and snapping |
| 11.84 | F1 | Shortcut and control mapping editor |
| 11.85 | F1 | Project commands: Revert, Increment And Save, Import from project, Reveal, Convert Mode, Export Package |
| 11.88 | F1 | In-app help and About |
| 11.91 | F1 | Interface localisation groundwork |
| 11.86 | F2 Authoring panels | Clip Browser and Audio Files panels |
| 11.89 | F2 | Scrolling text controls in the inspector |
| 11.87 | F6 Playout application | Hardware Setup dialog: outputs, key and fill, audio devices, timecode, GPI, tracking |

**Core but parked, for you to decide:** live data connectors (XPression's DataLinq: XML, CSV, Excel,
databases, web) are the parked Data Server (X4), and key and fill outputs, genlock and the video cards
are parked (X2). Both are core for a real broadcast install; they stay parked until you un-park them.

**Optional or later, left as rows or notes:** Human Interface Devices as hardware (reached through 6.7
and Companion first), Tessera and tracking (16.20, parked), MOS profiles beyond 0 to 2 and newsroom
plug-ins, a Flush and cache monitor (11.58), Record Client (11.87).

## The menu bar (row 11.32)

The Editor's menu bar is now built from the reference: **File, Edit, Windows, Projects, Animation,
Display, Tools, Help**, replacing File, Edit, Layer, Window, Help. See `Editor/src/app-menu.ts` and the
real-window captures in `menu-bar/`. An item with no action is shown disabled and its tooltip names the
row that builds it, so the menu is also the visible to-do list; what moved:

- Layer > New rectangle, ellipse, text and Duplicate moved to **Edit > New Object** and **Edit >
  Duplicate / Rename / Delete** (the reference has no Layer menu; XPression creates objects from the
  Object Toolbar, which Display toggles).
- The old Window list of panels moved to **Display**, which shows and focuses the dockable panels in the
  reference's order; panels XPression has no name for follow under a separator. **Windows** keeps Set main
  viewport as active, Reset layout and the layout rows (11.76).
- Help keeps the diagnostic bundle beside Help Topics (11.88).
- File gained Open Recent (live), Save As, Project Server > Publish, and Exit (refused by name while a
  scene has unsaved work); Close project and New scene stayed under File as GrapiX additions.
- Every item says where it comes from in its tooltip: an XPression screenshot, a guide, an older guide, a
  Ross community post, or a GrapiX addition.
