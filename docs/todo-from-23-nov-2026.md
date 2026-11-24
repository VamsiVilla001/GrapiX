# Where we are and what is next (written 23 Nov 2026)

The whole discussion so far, grouped, then the to-do list in the order it is being worked. Parked items are last.

## A. What is already done (this long session)

**Effects and rendering**
- Selective Color effect built, with CPU and GPU agreeing on both DX12 and Vulkan (174 of 174 cases).
- Found that two kernels would not compile on DX12 (the compiler FXC refuses some code); both fixed. Hardware tests are now always run on both backends by name.
- Colour depth 8, 16 or 32 bits per project is built and shown in the Editor.

**Projects and files**
- Start screen, New project, Open project, Recent projects (run in the real window).
- **Save as** built: copies the whole project, carries unsaved work into the copy only, leaves the original as it was, refuses by name before copying anything.
- Bug found in the real window and fixed: a new scene was always created at 16 bit, so saving it into a 32-bit project was refused. New scenes now take the open project's settings.

**Engine**
- The recovery journal decision (with Jev and Laya): refuse an old journal by name, and discard it only on purpose with `--discard-recovery`. Built and run on a copy of your real journal. **Your own journal is untouched: your engine still stops on it until you run it with `--discard-recovery`.**
- Engine-host tests no longer read your real journal.

**Benchmark and menus**
- 64 items of the XPression menu reference matched against the plan (by hand, with Jev and Laya as a second opinion). Research on each missing module. 20 new plan rows.
- Menu bar rebuilt, then renamed in plain words so that **no menu, drop-down or panel uses XPression's name**: File, Edit, Project, Motion, Panels, Layout, Utilities, Help. Items not built yet are dimmed and name the plan row that builds them.
- Removed the duplicate Project picker, New project and Open project buttons from the Scenes panel.

**Settings service (row 2.28)**: built, tested (12 tests, 11 mutants killed), exposed to the Editor. The apps will read from it row by row.

## B. Decisions and things waiting on you

1. Run your engine once with `--discard-recovery` (or move `recovery.json` aside) so it starts again.
2. Parked items stay parked until the core list below is done (your decision, 23 Nov).
3. RossTalk: not the base. Notes on how it works are being written (`docs/evidence/xpression-benchmark/rosstalk-notes.md`); a compatible adapter can be added beside TCP, UDP and HTTP later if you want.
4. My test Editor windows are ended after each check. The `recent-projects.json` they made in your data folder is still there; I will delete it when you say so.

## C. To-do list, in the order it is worked

Each line is a plan row (all start `pending`, 313 rows in the plan). Done means verified, then recorded.

**1. Foundations and quick wins in the Editor**
1. `2.28` Settings service. Service built; next the apps use it.
2. `11.81` Settings window (Edit > Settings…).
3. `11.82` Change history list (Edit > Change history…). Built and seen in the real window; only the shortcut is left, and it waits on 11.31 and 11.84.
4. `11.83` Line up, spread and snap. Line up and spread built and seen in the real window; snap and several items about one point wait on the viewport handles (11.44).
5. `11.30` Save in place and next version (existing row the File menu waits on). Moved up on 23 Nov: row 11.31 lists it as a need, so it comes first.
6. `11.31` One command list behind every menu, button and shortcut (existing row; `11.84` needs it). Built 23 Nov for the menu bar and every key (evidence docs/evidence/11.31/); still open: the toolbar's enabled states and the editor MCP listing the commands.
6a. `11.102` Tool ribbon (Select, Move, Rotate, Resize, Pivot, Pen and the line-up buttons), `11.103` Pivot panel and `11.104` Pen tool: built 23 Nov, `active` (evidence docs/evidence/11.102/). `11.105` Hand and Zoom: built 23 Nov, `active` (evidence docs/evidence/11.105/). Next in this group, from the After Effects and EffectCraft check: `11.106` shape tools, `11.107` path editing, `11.108` variable mask feather, `11.109` canvas text tool.
7. `11.84` Shortcut and trigger settings.
8. `11.85` Project commands: go back to last saved, next version, bring in from another project, show folder, change format, pack for sharing.
9. `11.88` Help guide and About inside the app.
10. `11.91` Interface language groundwork.

**2. Remote control and run order (Playout side)**
11. `6.7` Remote control over **TCP, UDP and HTTP** (our own design, same jobs on all three).
12. `6.8` Trigger inputs, on-air signals and control panels.
13. `6.9` Run order exchange: XML and CSV files, and the newsroom link (MOS).
14. `7.8` Project format and conversion.

**3. Content: text, sound, video**
15. `11.90` Moving text objects (sideways ticker, upward credits), then `11.89` its controls.
16. `16.17` Audio: sounds with graphics.
17. `16.18` Media library service, then `11.86` Media library and Sounds panels.
18. `16.19` Live video input as a layer (NDI first).
19. `11.87` Outputs and devices window.

**4. Existing rows the menu is waiting on** (already in the plan, still pending): `11.44` move, rotate, resize on the canvas; `11.52` project files panel; `11.56` clocks and counters; `11.77` offset timing; `11.47` ready-made objects; `11.57` send to other machines; `11.58` console, clear caches, cache watch; `11.68` add key; `11.76` saved layouts; `12.3` run order panel; `12.5` output previews; `12.8` item details.

## D. Parked, last

- `16.20` Tracked camera and virtual studio (optional, later).
- RossTalk-compatible adapter (only if you decide so after the notes).
- X2: video cards, genlock, key and fill outputs, NDI certification, 24-hour hardware gate.
- X4 and X6: the Data Server, live data connectors (XML, CSV, spreadsheets, databases, web) and its app.
- X1 remote engine, X3 AI template factory, X5 generative and spatial content.
- Core in a real broadcast install but parked by decision: live data connectors (X4) and key and fill with genlock (X2). They come straight after section C.

## E. Working rules in force

Record every finished row in the plan, `progress.json`, `progress.html` and the day's log; a partly built row stays `active`; verify before recording; report mistakes as they happen; nothing is committed until you say so; XPression's names are not copied.
