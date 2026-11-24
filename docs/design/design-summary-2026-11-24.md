# GrapiX design summary, 24 Nov 2026

What we discussed, what is decided, what is only proposed, what is still open, and how the UI should
be organised before the Figma screens start. All names are **working titles** (several echo
Expression), kept in one terms table so a rename is one edit.

Related files: `docs/design/wireframes/grapix-wireframes.html` (22 wireframes),
`docs/design/prototype/grapix-prototype.html`, `docs/design/grapix-screens-spec.md`,
`docs/design/review/` (UX review plus Jev and Laya), `docs/design/research/` (Visual Logic and
transition logic reports).

---

## 1. The product in one paragraph

Two applications. **Editor**: the design studio, never live; designs broadcast graphics (scenes) for
live shows. **Playout**: the live operator application whose centre is a **sequence of takes**; only
Playout can put anything on air. A third part, the render engine, draws all production pixels. Today the
Editor's designs are read by **Playout** and by **AI models over MCP** (Claude, ChatGPT, any other).
A planned module (idea only, not to be built yet) would feed **Prism** (automatic highlights) with
overlays designed in Figma, animated and data-bound in GrapiX, then delivered to Prism and on to the
end customer; social-media posts would follow the same route.

The Editor must feel like a design tool but **must not copy After Effects, EffectCraft or XPression**:
new layout, new words.

## 2. Decided

### Editor
- Organised around the **graphic's journey**: Look, Motion, Data, Test, Publish.
- One main screen: parts list, stage, **one card for the selected part** (Look, Motion and Data stacked),
  a **Moments strip** (Appears, Stays, Changes, Leaves), a **Cast strip** (real records to test with),
  a **journey rail** that marks the current step and has "Fix next issue".
- Menus: File, Edit, Graphic, Publish, View, Help, plus **Ctrl K search**.
- A graphic has **formats** (16:9 now; 9:16, 1:1 planned) sharing parts and look, with per-format layout.
- **Publish** makes a numbered, unchangeable package; destinations now: Playout and AI models (MCP).
- **Figma stays an input**, kept linked (import a frame as parts; pull changes later).

### Playout
- Centre is the **sequence**; each entry is a **take** (a scene played). Names and descriptions editable.
- **Scene ID**: needed in Editor and Playout, set in the scene list, same in both.
- **Take ID**: Playout only, **typed by the operator**, unique in the show, how other systems (TCP, UDP,
  HTTP, custom protocols) call a take. The next free number is only a suggestion. Locked while on air.
- Scenes are **dragged from the scene list** into the sequence.
- **Scene data**: only fields the designer published; typed by hand or linked to a data source.
- **Preview**: in the layout, 360 or 480 lines (by resource use, lowers itself under load), play, pause,
  stop, loop, completely separate from air.
- **Virtual output**: a pop-up window at the **full output resolution** (1080p or 4K) that shows only what
  is sent to it, to check the true look locally; independent of the live output (DeckLink, NDI). Both can
  be active; neither blocks the other. Load governor slows Preview first, then the virtual output, never live.
- **TAKE** is one control, under the on-air monitor. TAKE OUT is hold-to-confirm and CLEAR is armed, both
  separated from CONTINUE and HOLD. The command console defaults to the safe action.
- **Layers**: -99,999 to +99,999, default 0 (set per scene in the Editor, changeable in Playout);
  plus is front, minus is back; each layer is taken, taken out and cleared on its own; different layers
  play together; **a take on an occupied layer replaces it**.
- **Transition logic** (owner's term): out then in, overlap (with an offset that may be negative) or cut;
  a cut if the old scene has no exit motion; frame-exact; "depends on what came before" deferred.
- **Show rules** (P8): small when-then rules across scenes and layers, only in Playout.

### Logic and data
- Each scene has its **own timelines and its own sandbox**; runs only while loaded or on air; time budget;
  keeps last good values on error; reaches its own scene only. **JavaScript** and a **node view** share
  one set of actions and events. Per-frame logic is a pure calculation; event logic asks the engine to act.
- **Instances, not 16 directors**: a component (for example a team row) with its own named timelines, a
  repeater placing N instances from data, each with its own playhead and fields. Instances are created at
  load, up to a set maximum; no new elements on air.
- The scene is **always on air**; **booleans in the data trigger timelines** (in and out), auto-out built
  into the scene. Linked fields marked "auto" update on air by themselves.
- Data arrives through a **WebSocket data link in Playout** (never inside a scene), read with a small
  sandboxed JavaScript adapter and a JSON path picker; a recorded-feed simulator for testing.
- **Node-RED** may feed data and commands from outside through the API or MCP; flows are meant to be
  portable into a scene. Logic inside the scene comes first.
- **Real HTML elements are not used**; the scene is a DOM-like tree owned by the GPU engine.
- **The scene sandbox is a mini IDE** (Editor, Logic panel, Level 2): code editor with scene-aware autocomplete and
  error marks, a **sandbox console** (the scene environment's own console: logs, errors, commands against a test copy),
  live data inspector with a JSON path picker, feed simulator (replay recorded sessions, send test events),
  budget meter, snippets, node view toggle. Edits to a live scene are not allowed: publish a new version.
- **Two different consoles:** the **sandbox console** belongs to a scene's script environment; the **application
  diagnostics console** in Playout is the app-level log (engine, connections, data links, commands, refusals).
  Feed trigger shapes (pulse, counter, event ID, level) come from the external game APIs and WebSocket endpoints,
  so the data link supports all of them and the mapping is chosen per feed after capturing sample messages.
  A sandbox script error on a scene that is on air also appears as one plain line (scene name, Take ID, warning chip)
  in Playout's diagnostics console; nothing else from the sandbox is shown in Playout.

### Assets, library and layout
- **No separate material manager.** Parts are solids, shapes, masks (pen), text and images; colour is a
  property; images can come from a **field** (for example a team logo).
- **Assets belong to the project**, organised in **virtual folders you create and name**, plus an
  **"Import folder"** option that creates matching folders from a disk folder. Files are linked while
  working and copied into each package on publish (stored by fingerprint).
- **Library per project** (BMPS has its own, FFWS its own): colours (primary, secondary, misc), layer
  styles, text styles, fonts, logos, backgrounds, other assets, in **one panel merged with the asset
  manager**. Packages pin the exact items they used.
- **MCP** has read and write access to arrange and organise the folders and the library (pointer, to build later).
- **Library is built by hand, Photoshop-style; no Adobe dependency.** The Adobe Creative Cloud Libraries API and
  Photoshop file formats (`.ase`, `.asl`, `.pat`) are dropped for now. Item types created manually: colours
  (primary, secondary, misc), **layer styles** (drop shadow, stroke, glow, inner shadow, gradient overlay,
  each with its own settings), **patterns** (tileable image or vector with scale and rotation),
  **backgrounds** (image or video loops), vector (SVG) and PNG assets, fonts, text styles and motion styles.
- **Layouts**: modules are resizable; people can hide or undock modules and **save named layouts** in a
  layout file, switched from a **dropdown on the top ribbon** (examples: design; animation plus design;
  data linking only).

### Names and IDs
- All visible names come from **one terms table**; rename in one place. (The wireframe page has a live
  rename table.)

## 3. Proposed by me, awaiting your confirmation
- Docking: **lightweight** (outline while dragging, tab groups), hidden panels stop drawing.
- Playout layouts can hide panels but **never** TAKE, the on-air monitor or the layer controls.
- Scene logic first version: **JavaScript first, Nodes right after** on one shared vocabulary.
- Per-frame scripts on air only after the engine can enforce the cost limit; event logic first.
- Triggers: per-scene **armed / frozen** switch, manual fire and reset, stale-feed warning, a log.
- Show rules may take or clear only as the operator allows; automatic takes are an armed choice.
- **Start from another project's library** copies its colours, styles and logos into a new project
  (offered; you have not answered).
- **AI transition logic**: ML only ranks and seeds suggestions; a simulator checks them; the designer
  approves; the engine plays only the compiled table, no model live, cut as fallback.

## 4. Still open
1. ~~Pulse or counter~~: answered, the feeds come from external game APIs, so all trigger kinds are supported.
2. Is the **transition** set per layer, per take, or both? (Research proposes: take overrides pair, pair
   overrides layer default.)
3. Is the **Scene ID** made automatically, can it be edited later, and what happens to takes if it changes?
4. Layout storage: per person, in the project, or a shared folder? Docking style as above.
5. Which **workflows** come first after live on-air, and what are the first destinations?
6. **Prism**: who makes the final file (GrapiX render or Prism plays the package), and what data Prism
   supplies per highlight.
7. AI models: same limits for all (read, propose, ask to publish) or per model?
8. Which control systems call takes first, over which protocol? (Command words are examples.)
9. Plan rows to revisit: **11.12** material manager with slots and **11.50** lit material.
10. Optional: UX review batches D (page accessibility) and E (complexity cuts) not applied.

## 5. Research results

**Visual Logic and Vizrt** (`docs/design/research/visual-logic-research.md`; XPression block list could not be
fetched, a local PDF text pass on your guide would settle it): XPression has a per-scene graph evaluated
every frame; block families are logic and compare, math, string, selectors, date and time, DataLinq and
generated per-object property blocks; triggering a Scene Director from a Boolean is unreliable and users
work around it; no edge, pulse or event-ID block or script block was found. Vizrt has no single graph;
logic is split across data plug-ins, scripts and control fields, with an explicit "do once on change".
Takeaways: state the evaluation order against timelines; make **level, edge, counter, pulse and keyed
event** first-class triggers; generate property ports from one schema; a native list repeater; preview
runs the same evaluator as playout; loop protection and debounce; a script block with persistent state.

**Transition logic** (`docs/design/research/transition-logic-notes.md`): XPression, Viz, Singular,
CasparCG documentation is thin on timing and interrupts. Proposed model: commit frame
`C = max(next boundary, now + preroll)`; out then in starts the new scene at `C + out length`; overlap at
`max(C, out end + offset)`; three interrupt policies; five layer states (empty, entering, held, leaving,
replaced), never two held; complementary easing; critically damped spring; squeeze-back scaling that
keeps aspect ratio; one shared calculation for Editor and engine, in whole frames.

## 6. UI priority model (real estate)

Levels: **P1** always visible. **P2** hidden at first, opens on demand (slim tab or slide-out; keeps a
small status chip so a warning inside it is never lost). **P3** reached through search or a menu only.

| App | P1 (always) | P2 (on demand) | P3 (search or menu) |
|---|---|---|---|
| Editor | stage, parts list, selected-part card, journey rail, Moments strip, Cast strip, Publish, undo/redo | Logic (script, nodes, triggers), Library and assets, Looks gallery, Formats, Moments detail and curves | Settings, shortcuts, connections, diagnostics, help, bring-in tools |
| Playout | sequence, on-air monitor, TAKE, armed Take out and Clear, layer summary, Preview, scene data of the selected take | scene list (collapses after building), layer detail (P7), show rules (P8), calling takes (P4), virtual output window, monitoring detail | outputs and devices setup, settings, diagnostics |

Rules: Playout's controls that act on air can never drop below P1; hidden panels stop drawing and
updating; panel sizes are proportions; layouts are files you name and switch from the ribbon; warnings
from hidden panels surface as chips.

## 7. What exists today
- **Figma** (`gyGkmEFX4oAuknNNI4dq9k`, now in a paid team): SKWAD variables, text and effect styles, 37 icons,
  about 18 base components (Button, IconButton, Tab, Chip, Input, Select, FieldRow, ListRow, menus,
  toggles, slider, keyframe, logos, menu bar, status bar, ModuleToggle, a toolbar from the older layout).
  **No screens yet.**
- **Wireframes**: 22. **Prototype**: clickable Editor and Playout flows (old single-take flow, not updated).
- **UX review**: 28 issues; safety and names/IDs batches applied.
- **Jev and Laya**: two runs recorded in `docs/design/review/`.
- No app code changed; no tool installed.

## 8. Proposed plan for the Figma screens (needs your approval)
1. **Fix the components first** (one pass): replace the old toolbar and module toggle with the new
   Editor ribbon (menus, Ctrl K, layout dropdown, engine chip, Publish); add panel-header, slim-tab,
   status-chip, stepper (journey rail), moments card, cast chip, take row, layer row, monitor frame,
   TAKE button states, armed button, library swatch and asset card.
2. **Screens in priority order**: Editor Make (B2), Playout Sequence (P1), Playout Layers (P7), Editor
   Moments (B3), Editor Data (B4), Editor Logic (B12), Editor Assets and Library (B13), Playout Scene
   data (P3), Playout Virtual output (P5), Publish (B6), Start (B1), then the rest.
3. Each screen is built from instances of the components, with tokens bound, and shows the **P1 layout
   with P2 panels closed**, plus one frame per key P2 opened state.
4. Check each with a screenshot, then the review agent and Jev and Laya on the result.

---

## 9. Figma progress (24 Nov 2026, later)

File `gyGkmEFX4oAuknNNI4dq9k` (moved to a paid team). Old first-draft toolbar and module toggle removed.

- **New components** (page "Foundations & Components"): Editor/Ribbon `30:606` (tools, Ctrl K search, Layout dropdown, engine chip,
  Publish), Playout/Bar `30:686`, Playout/Band `30:715` (Warning, Critical), Step `30:732` (journey rail: Done, Attention,
  Blocked, Todo, Current on/off), SlimTab `30:740` (closed P2 panel; Alert dot), CastChip `30:747`, MomentCard `30:760`,
  TakeRow `32:189` (Ready, Played, OnAir, Cued, Next, NeedsData x Selected; on-air loud, selection neutral, locked label),
  LayerRow `32:234`, TakeButton `32:239`, MonitorFrame `32:287` (Preview, OnAir, Virtual). MenuBar `13:28` now has the six menus.
- **Screens built:** B2 Editor main screen `34:218` (section "Editor UI") and P1 Playout sequence `33:3` (section "Playout UI"),
  both showing the P1 layout with P2 panels closed in the "More" bar.
- **Next screens** in priority order: P7 Layers, B3 Moments, B4 Data, B12 Logic (IDE), B13 Assets and Library, P3 Scene data,
  P5 Virtual output, B6 Publish, B1 Start, then the rest. Also one frame per key P2 opened state.
- Defaults assumed until you say otherwise: transition set per layer with an optional per-take override; Scene ID automatic
  from 1 and editable (takes reference the scene by an internal key); layouts stored in the application root folder; lightweight
  docking; no library copy between projects.

### Editor main screen cleanup (owner's review, 24 Nov 2026)
Playout screen approved as is. Editor B2 cleaned: kept the repeated overflow warning as is (item 1 declined);
journey steps moved into the ribbon (rail row removed); the selected-part card shows grouped sections with fewer rows and
"More"; Moments cards are one compact row; the status line merged into the "More" bar; parts panel narrower with no hint and
a larger composition (62%); single-tab panel headers are now small headers. Components changed: Editor/Ribbon, MomentCard.

## 10. Data Source Manager (owner, 24 Nov 2026)

A **fourth application**, beside Editor, Playout and MCP: the one place where outside data is connected (WebSocket, SSE,
HTTP/HTTPS polling, webhooks, TCP/UDP/serial, MQTT, SQL databases, Excel, Google Sheets, CSV/TXT, JSON/XML files, manual tables,
recorded feeds). It holds credentials, runs a sandboxed JavaScript **adapter** per source (its own mini IDE and console), maps
fields and events, records and simulates feeds, shows health and staleness, and serves named fields/events to Editor, Playout
and AI models. Editor still works without it for simple local sources (CSV or typed table); live feeds need it. Playout keeps
the last good values and shows "source lost" if the manager goes down. **Proposal, needs the owner's approval:** invariant 1
("exactly three applications") must change; `docs/invariants.md` is not edited from this side session.
Research: `docs/design/research/data-sources-research.md` (DataLinq sources, other products, source catalogue; "Wizard" could not be
identified, owner to supply a URL or vendor). Figma: section "Data Source Manager UI" with D1 Sources `37:463`, D2 Add a source,
D3 Adapter editor; components DSM/Bar `36:582`, SourceRow `36:661`, TypeTile `36:672`.
