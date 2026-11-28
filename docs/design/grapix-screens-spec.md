# GrapiX screens in Figma: status, spec and resume ledger

Figma file: <https://www.figma.com/design/gyGkmEFX4oAuknNNI4dq9k/GrapiX> (team "vamsi.villa's team",
Starter plan). Written 24 Nov 2026.

## Assets and the import manager, 24 Nov 2026 (owner; design pointers, nothing built)

- **No separate material manager.** Parts are solids, shapes, masks (pen tool), text and images;
  colour is a property of the part. Shared colours live in the event look. An image's source is a
  fixed file or a data **field** (for example a team logo), preloaded by the engine before take.
  Plan row 11.12 (material manager with slots) and 11.50 (lit material) would need a decision.
- **Assets belong to the project, not to a scene.** Files are linked from disk while working and
  copied into each scene's package on publish (stored by fingerprint, sent once). The user organises
  them in **folders they create and name** (virtual folders inside the project, nestable,
  drag to move; an "Import folder" option can create matching folders from a disk folder). Folders
  are organisation only and do not change publishing. "This scene", "Unused" and "Missing" are
  filters, not folders. Import goes into the selected folder; dropping on the stage also places
  the file in the open scene. Replacing a file marks the scenes that use it as out of date.
- **Pointer, to build later:** the MCP connection (any AI model) must have **read and write access
  to arrange and organise these folders** (list, create, rename, move, and move assets between
  folders), under the same scopes and audit log as other MCP tools. Example tool names are not
  chosen yet.
- **Decided (owner):** virtual folders plus an "Import folder" option. Wireframe B13 shows it.
  Still open: an event-level library above projects.

## Decisions of 24 Nov 2026, second half (owner)

- **Layers:** -99,999 to +99,999, default 0 (set per scene in the Editor, changeable in Playout);
  plus toward the front, minus toward the back; higher sits in front. A take on an occupied layer
  replaces it. **Transition logic** (owner's term, kept): out then in (old scene plays its exit, then
  the new one enters), overlap (both, with an offset, negative starts the new one early), or cut;
  cut if the old scene has no exit. Engine computes in whole frames, preloads the new scene, swaps on
  one frame boundary and reports the committed frame. "Depends on what came before" is deferred.
  Open: set per layer, per take, or both. (This supersedes the earlier 1 to 99,999 range.)
- **Preview and virtual output are two things.** Preview sits in the Playout layout at 360 or 480
  lines (by resource use, lowers itself under load). The virtual output is a pop-up window at the
  full output resolution (1080p or 4K) showing only what is sent to it, independent of the live output
  (DeckLink, NDI). The load governor slows Preview first, then the virtual output, never live.
- **TAKE:** one control only, under the on-air monitor. Take out and Clear are separated and armed.
  Name and Take ID of an on-air take are locked. The command console defaults to the safe action.
- **Scene logic:** each scene has its own timelines and its own sandbox (runs only while the scene is
  loaded or on air; time budget; keeps last good values on error; reaches its own scene only), in
  JavaScript or nodes on one shared vocabulary of actions and events. Per-frame logic is a pure
  calculation; event logic asks the engine to act. Show-level rules across scenes and layers live in
  Playout (P8). Node-RED may feed data and commands from outside through the API or MCP, and flows
  are intended to be portable into a scene; embedding Node-RED itself is not decided (its function
  node is not a security boundary). First version: JavaScript, Nodes right after (to confirm).
- Wireframes now: 21 (B1 to B12, F1, P1 to P8). The UX review's safety and names/IDs batches are
  applied; its batches B (partly: the rail now marks the current step), D and E are not.

## Layers, 24 Nov 2026 (owner)

Layering is a core Playout module. Each take plays on a **layer** number from 1 to 99,999 (plus and
minus controls or typed); different layers play together, foreground and background, and each layer
is taken, taken out and cleared individually. A scene carries a default layer set in the Editor;
Playout can override it per take. Wireframe P7 and a Layer column in P1. Open: do higher numbers
sit in front; does a take on an occupied layer replace it (old one plays its Leaves first). This
answers the earlier question of what Take does to what is already on air: it is decided per layer.

## IDs and names, 24 Nov 2026 (owner)

- **Scene ID**: needed in the Editor and in Playout; set in the scene manager and the same in both.
- **Take ID**: needed only in Playout; the operator types it by hand; unique in the show; used by other systems to call a take.
- **Names are working titles.** Several echo Expression's vocabulary, so the real nomenclature comes
  later. Rule for the app and designs: **every user-visible name comes from one terms table** (key to
  display name), read by menus, panels, buttons, messages, docs and the MCP tool descriptions, so a
  rename is one edit. This fits the interface-language groundwork (plan row 11.91). The wireframe page
  demonstrates it: its "Names" table renames terms across every screen live. Figma text for the
  screens should be created from the same list when the screens are built.

## Destinations and the Prism idea, 24 Nov 2026 (owner)

**Now:** the only readers of a published graphic are the **Editor and Playout**, plus **AI models
over MCP** (Claude, ChatGPT, any other). Earlier mentions of other SKWAD apps, a clips app or a
stats API were my inventions and are removed. **Planned, not to be built yet:** a module for
**Prism** (automatic highlights): a requirement arrives, a Figma frame is designed, GrapiX animates
it and binds the data, the animated data-linked file goes to Prism, which packages it for the end
customer; social-media posts follow the same route. Open questions: who renders the final file,
and what data Prism supplies per highlight. Wireframes: B6, B10, B11 and F1 (planned) in
`docs/design/wireframes/grapix-wireframes.html`.

## Playout, 24 Nov 2026 (owner, in plain words)

Live on air is **Playout**, not the Editor. Its centre is the **sequence**: an ordered list of
takes; each take is a scene with a **Take ID** (permanent, callable over TCP, UDP, HTTP or a
custom protocol) and an editable name and description. Scenes are dragged from the **scene list**.
A **scene data list** shows only the fields the designer published; values are typed by hand or
linked to a data source. **Preview** is a local player (play, pause, stop, loop) on its own
renderer with no connection to Program; "TAKE" sends the exact version and data
previewed. A **virtual output window** shows Program on the PC. Wireframes P1 to P6 in
`docs/design/wireframes/grapix-wireframes.html`.

## Scope widened, 24 Nov 2026 (owner)

The Editor is the **design studio** and is never live. It may feel like a design tool but must not
copy After Effects or EffectCraft. A graphic is also published to **other SKWAD applications**
(for example a 9:16 reel overlay designed from a Figma frame, a picture-in-picture frame, a stats
card rendered on request) over MCP, REST, files or a share link. The wireframes now add
formats (B9), a publish step with destinations (B6), a package library (B10) and connections
(B11), and eight workflows. Core idea: one immutable numbered **package** (parts, moments, field
schema, formats, assets, fingerprint) read by any destination; Playout is one destination and the
only one that can put Program on air (invariants 4, 5, 7).

## Direction change, 24 Nov 2026 (supersedes the EffectCraft / After Effects layouts below)

The owner said: do not copy After Effects or EffectCraft's layout; find a new, easy, broadcast-based
approach. The wireframes (`docs/design/wireframes/grapix-wireframes.html`, B1 to B8 plus Playout P1 to P4) now organise the
Editor around the graphic's journey: Look, Motion (moments: appears, stays, changes, leaves), Data
(fields set on the part), Test (the cast of real records), Send. One screen, a card for the
selected part with Look, Motion and Data stacked, a Moments strip, a Cast strip, a journey rail,
six menus (File, Edit, Graphic, Send, View, Help) and Ctrl K search. The previous After Effects-style
set (W1 to W13, modules as toggles) is in git history at `ec6edbf`. The Figma components built so far
(tokens, icons, base controls) are still valid; the Editor/Toolbar and ModuleToggle components
belong to the superseded layout and will be replaced when the B-series screens are built.

## Status (24 Nov 2026, after the file moved to a paid team)

The first draft (screens E01 to E03 on a custom top bar and ribbon) was **deleted** on 24 Nov: it
followed the current GrapiX layout, not the EffectCraft model the owner chose. Also deleted: the
old `Editor/TopBar`, `Editor/ToolRibbon`, and a parallel-window experiment (`PaneBar`, `LinkToggle`,
split / window / link / pin icons, an "Open" tab state). The owner's rule is that Design, Animation
and Data panels are used **at once, not in pop-out windows**, so modules are multi-select toggles
(see `grapix-modules-are-toggles` in memory and `docs/design/review/`).

| In the Figma file now | Where |
|---|---|
| SKWAD variables (32 colours, 18 space / radius / size), 14 text styles, 2 effect styles | Local variables and styles `sk/*` |
| 37 icons from `Editor/web/icons` | Page "Foundations & Components" |
| Button, IconButton, Tab (3 states), Chip, Input, Select, FieldRow, PanelHeader, ListRow, MenuBarItem, MenuItem, Toggle, Checkbox, Slider, Keyframe, Logo/Editor, Logo/Playout, Editor/MenuBar, Editor/ActivityBar (status bar) | same page |
| **ModuleToggle** (Off / On) and **Editor/Toolbar** (9 Layout variants: Default, Animation, Effects, Data, Text, Publish, Diagnostics, Design + Animation + Data, Small Screen) | same page |
| Screens | none yet; page "GrapiX UI", section "Editor UI" is empty and sized 6400 x 7600 |

Next: Editor screens W1 to W12 and Playout P1 to P4 from `docs/design/wireframes/grapix-wireframes.html`,
built from these components. Playout needs its own toolbar and panel components.

## Snapshot findings from the current app (earlier captures, 18 to 23 Nov)

Taken from `docs/evidence/11.43`, `11.67`, `11.71`, `11.83`, `11.117` screenshots in
`agent/shared`. These are the "before" for the review agent's first run, not a full review.

| # | Module | Finding | Severity (proposed) |
|---|---|---|---|
| 1 | Top bar | At about 1440 px the scene id / name fields and eight buttons wrap; "SCENE ID" and "NAME" overlap the button stack (`11.117/shots/m7-masks-tab.png`) | S1 |
| 2 | Top bar / Scenes | New, Open, Save appear in the top bar, the Scenes panel and the File menu | S2 |
| 3 | Preview | Engine-unreachable shows a raw OS error with error code as the main text | S2 |
| 4 | Timeline | Keys, Presets and Phases share one crowded toolbar that scrolls sideways at 1440 | S2 |
| 5 | Inspector tabs | Seven tabs wrap to two lines (Properties … Fonts) in a 360 px dock | S3 |
| 6 | Start dialog | Recent list shows raw folder names ("AS 1792220578291") and full paths as equal weight | S3 |
| 7 | Playout bar | Operator, endpoint and token inputs compete with Connect, Status and Telemetry in one bar; the window crops TAKE row buttons at 1253 px | S2 |
| 8 | Ribbon | Pen mode label sentence ("The Pen will draw a mask on rect.") sits inside the ribbon and pushes tools | S3 |

## Remaining screens (spec to build once Figma calls are available)

Same grid: three columns, 1920 × 1080, 160 px gutters, label above each.

| Code | Screen | Content |
|---|---|---|
| E04 | Effects workspace | Effects & Presets browser (categories, "Engine / CPU only / Not yet" chips, engine-ready filter), viewport with glow and shadow, Effect Controls stack (Drop shadow, Glow, Selective colour, Gaussian blur) with keyable values, Layer styles toggles (Photoshop / Figma parity), compact effect-value timeline |
| E05 | Data and bindings | Sources (REST OAuth2, CSV, Google Sheet, WebSocket, JSON) with freshness chips and schema; viewport with bound-field outlines and a record switcher; bindings table (object, property, field, transform, preview, status: overflow and stale flagged); Template controls (operator-editable fields with type, required, rule) and the operator form preview; publish blocked by validation |
| E06 | Assets, materials and fonts | Project files tree (Footage, Images, Fonts, Materials, Sounds), thumbnail grid, Material manager (slots, dynamic material rules, preload before take), Fonts (bundled, licence state), import queue for Figma frames / PSD / SVG with layer mapping |
| E07 | Masks and pen | Pen active in the ribbon, Bézier path with vertices and handles in the viewport, Masks panel (add / subtract / intersect, feather, expansion, track matte) |
| E08 | Publish to Playout | Dialog: preflight checklist (fonts, materials, overflow, missing slot), engine target and locality (localPath / chunkedUpload), revision and content hash, notes; banner "Publishing never puts anything on air" |
| E09 | Settings | Left sections (General, Project defaults, Viewport, Timeline, Import, Fonts, Cache, Shortcuts and triggers, Remote control, AI agents and MCP, Language); Shortcuts table with search and conflict chips |
| E10 | Menus and command palette | File menu open with "Bring in ▸" submenu and a dimmed item with its plan-row tooltip; Ctrl K palette searching every command id |
| E11 | Help and diagnostics | Help guide (searchable), About (version, build, engine, licences), diagnostic bundle export (all modules / editor only) |
| E12 | Agent (MCP) panel | Requests, per-layer proposed diff with Accept / Reject, scope chips ("can edit scene and keys; never Program"), audit trail; ghost overlay of the proposed change in the viewport |
| E13 | Scripts and extensions | AE scripts and ScriptUI panels list, run with console output, plug-in compatibility state |
| E14 | Workspace and layout | Panel drag with dock drop zones, floating panel, "Save this layout…" dialog, My layouts |
| E15 | States sheet | Engine unavailable, unsaved changes, refusal in Activity, empty object list, locked-object refusal |
| P01 | Playout operator | Run order (status: next, cued, on air), Preview and Program monitors (Program in brand ember), transport CUE / TAKE / CONTINUE / HOLD / UPDATE / TAKE OUT / CLEAR, item details, output strip with late / missed counters |
| P02 | Template control | Control cards per template (scorebug score ±, clock start / stop, L3 quick text), on / off take toggles, Stream Deck mapping hint |
| P03 | Monitoring and telemetry | Per GPU / CPU / adapter / output graphs, late and missed frames never coalesced, load governor state, reference lock, degradations |
| P04 | Outputs and devices | DeckLink channels, mode, fill and key, genlock, NDI name, live and free-run flags, configure with confirm; locked during show |
| P05 | Safety states | Free-run warning band, critical engine-lost band, signed-out held transport, hash-mismatch take refusal |
| P06 | Remote control and triggers | TCP / UDP / HTTP listeners, GPI mappings, MOS link state, run-order import (XML, CSV) |
| R | Research & Flows page | Module map, workflows A to H, research matrix below, before / after pairs for findings 1 to 8 |
| F | Foundations sheet | Colour swatches, type ramp, spacing scale, component index |

## Research notes behind the layouts

From `docs/research/market-scan-2026-11-18.md` (features by vendor) plus these UX sources:

- After Effects: panels dock, tab and float; Effect Controls is the comfortable place for effect
  values; workspaces are saved arrangements ([Adobe](https://helpx.adobe.com/en/after-effects/using/workspaces-panels-viewers.html)).
- Viz Artist: Stops halt a director until continue, Tags mark time without halting; the stage tree
  and dopesheet sit side by side ([Event Editor](https://docs.vizrt.com/viz-artist-guide/5.2/Event_Editor.html),
  [Stage](https://docs.vizrt.com/viz-artist-guide/5.2/The_Stage_for_Animation.html)). Adopted as the
  phase band with named stop and continue points.
- Singular.live uno: one control app per template showing only that template's controls, with
  Stream Deck integration ([uno overview](https://support.singular.live/hc/en-us/articles/4407694777485)).
  Adopted for P02 template control cards.
- XPression: menu inventory in `docs/reference/xpression-menu-bar.md`; Scene Directors for
  transition logic.

## Editor UI v2, 26 Nov 2026

What stays on screen and what is called on demand, with the updated screens and their node ids: `docs/design/ui-visibility-2026-11-26.md` (section 94:7118 on page GrapiX UI; MenuBar now eight menus, the ribbon's step chips hidden).

## Resume ledger (Figma node ids, 24 Nov 2026)

```json
{
  "fileKey": "gyGkmEFX4oAuknNNI4dq9k",
  "pages": { "screens": "0:1", "foundations": "10:4", "research": "10:5" },
  "section": { "editorUI": "7:2" },
  "collections": { "colour": "VariableCollectionId:9:2", "space": "VariableCollectionId:9:35" },
  "components": {
    "Button": "11:26", "IconButton": "11:39", "Tab": "11:46", "Chip": "11:59", "Input": "11:68",
    "Select": "11:69", "FieldRow": "11:75", "PanelHeader": "11:79", "ListRow": "11:98",
    "MenuBarItem": "11:105", "MenuItem": "11:115", "Toggle": "11:120", "Checkbox": "11:125",
    "Slider": "11:126", "Keyframe": "11:133", "LogoEditor": "13:20", "LogoPlayout": "13:27",
    "EditorMenuBar": "13:28", "EditorActivityBar": "13:505", "ModuleToggle": "28:2125",
    "EditorToolbar": "28:3224", "iconsHolder": "10:6"
  },
  "screens": {
    "B1 Start": "56:3342", "B2 Editor main screen": "78:6599", "B3 Timeline": "67:4965", "B3c Graph": "71:5135",
    "B3d Properties": "73:5216", "B4 Data": "54:2574", "B5 Style": "57:3217", "B6 Publish": "56:2933",
    "B9 Formats": "57:3568", "B12 Logic": "55:2554", "B13 Library": "55:3018", "B14 Figma import": "84:6847",
    "E1 Search": "59:3531", "E2 Layouts": "59:3832", "E3 Ask": "59:4129", "E4 Settings": "59:4425",
    "S1 Empty graphic": "59:4760", "S2 Font missing": "59:5032",
    "C1 Add element": "81:6088", "C2 Chart selected": "81:6419", "C3 Chart data": "82:5785", "C4 Effects shortcut": "82:6227", "C5 Plugin manager": "82:6550",
    "D1 Sources": "37:463", "D2 Add a source": "38:597", "D3 Adapter editor": "38:772",
    "P1 Playout sequence": "78:6902", "P3 Inputs": "50:1135", "P4 Cue Control": "51:1456", "P5 Airview": "51:1129", "P6 Monitoring": "83:6606",
    "P7 Stacks": "50:750", "P8 Play Rules": "52:1497", "P9 Outputs": "83:6266", "P10 Show files": "83:7054", "PD Diagnostics": "52:1852",
    "PS1 Engine lost": "53:1895", "PS2 Empty show": "53:2198"
  },
  "grid": "idx = number - 1; x = 160 + (idx % 3) * 2080; y = 260 + floor(idx / 3) * 1400 (inside section 7:2)",
  "layout": "EffectCraft default: MenuBar 28, Toolbar 40, body, ActivityBar 28 (1080 total); left 300 / viewer / right 300; Timeline 300-330 high under left + viewer"
}
```
