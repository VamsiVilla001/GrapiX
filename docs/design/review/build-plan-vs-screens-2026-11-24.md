# Build plan versus Figma screens, 24 Nov 2026

Question (owner): "Check with the GrapiX build plan and list out if we missed any screens, or if the build plan missed anything."

Read in full or in the parts that carry rows: `agent/worktree/GrapiX-Build-Plan.md` (694 lines; header, decisions, B7 to B9, B12, X4 to X6, F1 to F7, standing notes; the other backend modules by row title only), `docs/invariants.md` (85 rules), `docs/priority-list-18-nov.md`, `docs/proposals/*` (3 files), `docs/README.md` glossary lines 60 to 75, and our design docs (summary, both plans, external-review verification, UX review, research headings and the data-source, charts and look sections that the plans cite). Nothing was edited except this file. No code run, no Figma call made: the screen list is the owner's list in the task, not re-checked against the file.

Citation form: `Pn` is a plan line number in `GrapiX-Build-Plan.md`; a backticked id is a plan row. `INV n` is `docs/invariants.md`. `SUM` is `design-summary-2026-11-24.md`; `EXT` is `review/external-review-verification-2026-11-24.md`; `UX` is `review/uiux-review-wireframes-2026-11-24.md`; `TL` and `CH` are the timeline and charts plans.

**Naming clash to fix first.** The plan's modules are B1 to B14 (backend), F1 to F7 (frontend), X1 to X6 (parked) (P47 to P59). Our Figma screens are also called B1 to B13 (Editor), P1 to P8 (Playout) and F1 (Prism). "B3" means the Backend Render core in the plan and the Timeline screen in Figma; "F1" is the Editor workspace in the plan and Prism in Figma. In this file, Figma screens are written "screen B3" and plan modules "module B3". Suggest renaming one set (for example screens "E-B3" or "ED3") before the plan cites screens.

---

## 1. Module to screen map

Coverage: **Covered** (a screen shows it), **Partly** (the screen exists but a state or sub-feature is not drawn), **Missing** (user-facing and nothing drawn), **N/A** (backend only, no screen needed). Rows below are the user-facing ones; backend-only rows are summarised per module.

### Frontend modules F1 to F7

| Plan row(s) | What | Screen | Cover | Note |
|---|---|---|---|---|
| `0.14`, `11.67` (P400, P419) | SKWAD identity, compact dark UI, named empty/disconnected/refused states | all | Partly | `11.67` lists "panels' empty, disconnected and refused states" as still open; only S1, S2, PS1, PS2 draw some |
| `11.1`, `11.2`, `11.3`, `12.1` | Shell, WebGPU probe, DPI, Playout shell | none | N/A | no design needed except the 100/125/150/200 % check |
| `11.5`, `11.63`, `11.71` (P405, P416, P420) | Dockable workspace, AE/EffectCraft presentation, real-estate numbers | B2 | Partly | `11.63` says "compared with the EffectCraft workspace reference"; SUM L24 says do not copy AE/EffectCraft. See gap G-9 |
| `11.30`, `11.43` (P408, P414) | Save, Save as next version, project settings, New/Open project, recent list | B1 Start, E4 | Partly | B1 draws blank/import; no Save As, Save-version, unsaved-mark, crash-recovery offer, project settings (size, rate, colour depth) screen |
| `11.31`, `11.84` (P409, P430) | Command registry, shortcut settings | E1 Search, E4 | Partly | Ctrl K has a screen; no Shortcuts and triggers screen (`11.84`) |
| `11.32` (P410) | Menu bar, eight menus | B2 ribbon | Partly | Plan menus: File, Edit, Project, Motion, Panels, Layout, Utilities, Help. Figma ribbon: six menus (File, Edit, Graphic, Publish, View, Help) plus Ctrl K (SUM L34). Owner to choose; see G-10 |
| `11.33`, `11.35`, `11.76`, `11.92` to `11.101` (P411, P413, P425, P434 to P443) | Panels menu, named layouts, tab groups, floating, pop-out, workspace selector | E2 Layouts | Partly | E2 exists. Not built: Panels menu open state, floating group, pop-out, "Bring floating panels back", Manage workspaces (`11.96`), drop-zone overlay (`11.95`) |
| `11.34`, `11.75`, `11.101` | Pop-out windows, monitor changes | none | Missing | Later |
| `11.44`, `11.83`, `11.102` to `11.116` (P415, P429, P444 to P458) | Viewport gizmos, rulers, safe guides, line up, tool ribbon, Pivot, Pen, shapes, path edit | B2 stage | Partly | Tools exist in the app. Figma B2 draws a stage and ribbon only: no rulers/guides, pen/path editing state, snap guide, pivot panel |
| `11.82`, `11.85`, `11.88`, `11.91` (P428, P431 to P433) | Change history, project commands (Go back, Pack for sharing), Help guide/About, language | none | Missing | Help guide and About, Change history list: not drawn |
| `11.81` (P427) | Settings window | E4 | Covered | E4 also draws "AI access by role" (EXT X-6: provider names vs credential scope) |
| `11.117`, `11.118`, `3.19` (P459, P460) | Masks and track mattes in the Editor | B3 Matte column | Partly | Matte drawn as a column (None, Alpha); plan has Alpha, Luma, Invert, Clear and a Masks panel with 7 modes, feather, expansion (`11.117`). Mask list panel not drawn |
| `11.8`, `11.45` (P468, P479) | Object manager: hierarchy, visibility, lock, parent | B2 parts list | Partly | Flat list; the tree with eye and lock is "not built" (owner list; EXT section 3) |
| `11.9`, `11.46`, `11.100` (P469, P480, P442) | Inspector per type, scrub fields, pinned Properties | B2 card, B3d | Covered | B3d draws text and shape properties with diamonds. Plan `11.46` still says "stopwatch beside the diamond"; design is diamond only (G-6) |
| `11.12`, `11.50` | Material manager, lit material | none | N/A by design | SUM L86 says no material manager; plan still builds `11.12` (G-12) |
| `11.13`, `11.28`, `11.51` | Fonts, text styles, text engine depth | B13, B3d, S2 | Covered | S2 font missing |
| `11.19`, `11.26`, `11.27`, `11.54` (P475 to P476, P296 to P305) | Data binding, declared fields, Test fill, constraints, `liveUpdate` | B4, P3 | Covered | B4 includes test records (this is `11.27`) |
| `11.29`, `11.64`, `11.72` (P417, P421, P478) | Scene Manager, many graphics, dense list, row menu, Change ID, thumbnails | B10 (old wireframe), B2 | Missing in Figma | Scene library (owner's B10) not built; scene tabs, split view not built |
| `11.52`, `11.86`, `11.15`, `11.40` | Asset manager, media library, preset browser, project variables | B13 | Partly | B13 covers assets and library. Media library with thumbnails/in-out (`11.86`) and Sounds panel not drawn; virtual folders (design) vs on-disk folders (`11.43`), see G-13 |
| `11.10`, `11.21`, `11.22`, `11.23`, `11.68`, `11.77`, `11.78` (P505 to P513) | Timeline, diamonds, Auto-key, easing, speed graph, stagger, infinity | B3, B3c, B3d | Covered, with gaps | Speed graph "tab only, not drawn" (TL open item 4); stagger and infinity (pre/post repeat) controls not shown; multi-key handle edit not shown |
| `11.25`, `11.53` (P295, P304) | Named phases, stop points, looping hold | B3 | Partly | TL decision: no default phase bands. Plan builds phases and stop points as timeline spans; B3 shows Markers but not Continue/stop-point or loop-hold states (EXT X-1, TL open item 3) |
| `11.69`, `11.70`, `11.79`, `11.62`, `11.60`, `11.61` (P522 to P525) | Effects & Presets, Effect Controls, collapsible categories, layer styles, text animators | B5, C4 | Covered | All 306 effects with "usable" marks need a state screen for "not ported" refusals |
| `11.17`, `18.10`, `7.2` (P533, P535) | Import UI with tier and substitution report; Figma import: paste link, pick frames, coverage report | B1 (entry only) | **Missing** | No import report or frame picker screen. Highest-priority editor gap |
| `16.15`, `16.14` (P534, P355) | ScriptUI panels, .jsx run | none | Missing | Later; Logic IDE (B12) is a different thing (G-4) |
| `11.55`, `16.4`, `11.58` (P352 to P353, P482) | Logic, sandbox, console | B12 | Partly | B12 has JS in sandbox with console. Plan rows are backend-only; no frontend row for the Logic panel (G-4). Node view not drawn |
| `11.56` (P354) | Widgets: clock, countdown, counter, round timer | C1 | Covered | Backend row only; C1 is the UI |
| `11.57`, `7.6`, `7.7`, `11.42` (P544) | Publish, preflight, lint, hash publish | B6 | Partly | U-12: no refused/blocked/success state drawn. Refusal-class lint findings block publish (`11.42`): no blocked state |
| `11.65`, `13.5` (P563, P564) | Engine preview monitor, Engine/Draft labels, "unavailable" state | B2 chip | Partly | "Engine unavailable / Out of date / Declined" states not drawn |
| `2.27` (P543) | Live telemetry in Help (Playout) | PD | Covered | |
| `12.2` (P546) | Playout library by Take ID | P1 left list, Scene Bank (not built) | Partly | Scene Bank detail not built |
| `12.3` (P547) | Take list and rundown | P1 Playline, P7 | Covered | Show open/save, XML/CSV (`6.9`) not built |
| `12.4` (P548) | Transport: cue, take, continue, out, clear | P1, P4 | Covered | Execution-status line (sent, committed frame N, refused) not drawn (EXT 2g) |
| `12.5` (P549) | Confidence monitors, fill and key | P1, P5 | Partly | P5 Airview draws the virtual output; fill/key tabs and stale-frame state not drawn; Monitoring (P6) not built |
| `12.6`, `12.7`, `11.87` (P550, P551, P555) | Status, free-run, output configuration, outputs and devices | PD, PS1 | Partly | No output configuration or "Outputs and devices" screen (SUM P2 level: setup) |
| `12.8` (P552) | Operator fill form and pages | P3 Inputs | Covered | |
| `12.9` (P553) | End-to-end lower-third acceptance | n/a | N/A | |
| `12.10`, `12.11` (P256, P257) | Overlay layers, as-run record | P7 Stacks | Partly | As-run viewer/export UI not drawn ("UI and export follow later", P257) |
| `12.12` (P554) | Playout workspaces | none | Missing | Layout manager screen not built |
| `6.7`, `6.8` (P258, P259) | Remote control: TCP, UDP, HTTP, triggers | P4 Cue Control | Covered | Settings for control address and credential live in Editor settings only (`11.81`), no Playout settings screen |
| `6.9` (P260) | Run order XML/CSV, MOS | none | Missing | Later for MOS; XML/CSV is a backup, should have a File menu state |
| `2.15` (P145) | Named operator login | none | Missing | Sign-in screen and "held transport / signed-out" state absent (UX U-14) |
| `13.7`, `8.14` (P282, line 369) | Propose, approval queue, Admin approves | E3 Ask (propose only) | Missing | No approval-queue screen anywhere; the plan row is backend-only |

### Backend modules (screens only where noted)

| Module | Screen need | Cover |
|---|---|---|
| B1 contracts, B2 platform, B3 render core, B4 pixel gate, B5 effects engine, B6 transport, B10 libraries, B13 parity, B14 content depth | None, except diagnostics bundle menu item (`2.14`) | N/A |
| B7 `6.1` to `6.6`, `7.1` to `7.7` | Library, rundown, outputs behind P1/P3 and B6; `7.8` Project format has no screen | Partly |
| B8 MCP (`8.1` to `8.16`) | E3 Ask for propose; E4 for access by role; no screen for MCP client/permission list (owner's B11 Connections), Playout agent advisories (`8.16`), diff accept per layer (`8.15`) | Partly |
| B9 `11.20` to `11.54` | Phases, stop points, fields have timeline/inputs screens above; project variables and component registry (`11.40`) have no screen | Partly |
| B11 `7.2`, `18.x`, `11.59`, `16.5` | Import UI (F5) not drawn; re-import "update in place" (`18.9`) with deleted-node report not drawn | Missing |
| B12 `16.4`, `11.55`, `11.56`, `16.14`, `16.16` | B12 Logic, C1 widgets; plug-in manager (`16.16`) not drawn | Partly |
| X4, X6 `19.1` to `19.10`, `19.3`, `19.7` | Data Hub D1 to D3 designed; plan parks them (P625, P659) | Covered by design, parked in plan (G-1) |
| X1 to X3, X5 | None (hardware, remote engine, factory, generative) | N/A |

---

## 2. Screens we missed (ranked)

"Needs" = plan rows that cannot be accepted without the screen.

### Must have for release 1 (sports and esports, one Program channel, P71, P539)

| # | Screen or state | Plan rows that need it | Why release-critical |
|---|---|---|---|
| S-1 | **Figma import: paste link, frame picker, coverage and substitution report, "update in place" result** (Editor) | `18.10`, `11.17`, `7.2`, `18.9`, `18.2` | Figma is the main input (SUM L38). `18.10` done-when: "see the coverage and substitution report before confirming". B1 only has the entry card |
| S-2 | **Outputs and devices / output configuration** (Playout) | `12.7`, `6.5`, `11.87`, `12.6` | Refused live adapter must "name the failing condition" (P551); needed before any air. SUM P2 table lists "outputs and devices setup" |
| S-3 | **Playout Monitoring (P6): Preview/Program with fill and key, stale-frame labels, late/missed** | `12.5`, `12.6`, `2.27`, `12.12` | INV 11 free-run unmissable; INV 36 reachability vs readiness; P6 is on the owner's "not built" list |
| S-4 | **Playout show open/save, recent shows, rundown XML/CSV** | `6.4`, `6.9`, `12.3`, `12.9` | "reload and confirm the same revision" is the plan's own test; no screen for the act of saving or opening a show |
| S-5 | **Playout sign-in and signed-out/held state** | `2.15`, INV 84, `12.11` | A command without a signed-in operator is refused by name (P145); the refusal has no screen. UX U-14 also lists "no signed-out / held-transport state" |
| S-6 | **Refusal, blocked and success states** for TAKE (empty required field, stale data, missing font/asset, revision mismatch) and for Publish (blocked by lint, success with Take ID/revision) | `12.4`, `12.9`, `11.42`, `7.7`, `11.57`, `11.54` | UX U-12 and U-23: promised in notes, not drawn. Named refusal is INV 17 |
| S-7 | **Scene library / Scene Manager list with Scene ID, rename, Change ID, thumbnail, status** (owner's B10) | `11.64`, `11.72`, `12.2` | Scene ID is set here (UX U-08); `11.72` lists Rename (F2) and Change ID (F7) |
| S-8 | **Element tree: visibility, lock, parent, group** | `11.8`, `11.45`, `11.117` (matte source list) | Contract has `visible`, `locked`, hierarchy (EXT section 3); B2 shows a flat list |
| S-9 | **Editor save states**: unsaved mark, Save As next version, crash-recovery offer on launch, project settings (size, rate, depth) | `11.30`, `11.43`, `2.6`, `7.8` | Explicit save is the only writer (decision Q3, P71); the user sees these on every session |

### Should have

| # | Screen or state | Plan rows | Note |
|---|---|---|---|
| S-10 | Scene Bank detail (Playout library): published revisions, hashes, readiness | `12.2`, `11.38` | In owner's not-built list |
| S-11 | Approval queue (Admin approves, lint result, render preview) | `13.7`, `8.14`, `8.15` | Plan has the backend; no UI row at all (G-5). Needed before AI "propose" is useful |
| S-12 | MCP clients and permissions by credential scope (owner's B11 Connections) | `8.11`, `8.13`, `8.14`, `2.9`, INV 65, 85 | E4 shows AI access by role; a connections list with revoke is not drawn |
| S-13 | Layout manager (Playout) and Panels menu open state | `12.12`, `11.94`, `11.96`, `11.33` | |
| S-14 | Chart phases: Appears, Changes (rank swap), Leaves, tween bound to a timeline value; Playout Inputs with a chart data field | charts plan section 6; new rows needed (G-2) | Two of the five CH section 6 screens still unbuilt |
| S-15 | Timeline completions: speed graph tab, Continue/stop-point markers and looping hold, stagger, pre/post-infinity, multi-key handles | `11.53`, `11.68`, `11.77`, `11.78`, `11.25` | TL open items 3 and 4 |
| S-16 | Motion path and position path handles on the stage; masks list panel; pen/edit-path state | `11.104`, `11.107`, `11.117`, `11.112` | In the app; position path handles on the owner's list |
| S-17 | Scene tabs and split view | `11.64`, `11.100` | Not release-critical (EXT section 13 item 9) |
| S-18 | Data Hub extras: recorder and simulator (Replay Lab), per-source health and staleness board, credentials, field mapping | `19.4` to `19.6`, plus new rows (G-1) | D1 to D3 exist; the simulator is in SUM L218 but is not in D1 to D3 (not verified from the renders) |
| S-19 | Transition editor: out-then-in, overlap with offset (may be negative), cut; per-layer default and per-take override | `16.3`, `11.55`, `12.10` | P7 Stacks may show it; not confirmed in the render list given to me |
| S-20 | Execution-status line on P1 and P4 (sent, committed at frame N, refused: reason) | `12.4`, `12.11`, `6.7` | EXT section 2(g), INV 13, 48, 49 |
| S-21 | Emergency graphic and one-key armed clear | none (G-14) | EXT X-11 |
| S-22 | Shortcuts and triggers settings; Help guide and About | `11.84`, `11.88` | |

### Later

| # | Screen | Plan rows |
|---|---|---|
| S-23 | Playout MCP/agent advisory panel | `8.16` |
| S-24 | Prism (F1), social posts | none, idea only (SUM L20) |
| S-25 | Media library and Sounds panels | `11.86`, `16.17`, `16.18` |
| S-26 | ScriptUI panel host, plug-in manager | `16.15`, `16.16` |
| S-27 | Floating groups, pop-outs, monitor change recovery | `11.99`, `11.101`, `11.75` |
| S-28 | Playout permissions and roles management | `2.9`, `5.7` |
| S-29 | Formats beyond 16:9 (B9 exists; only 16:9 is release 1 in SUM L36) | gap G-3 |

---

## 3. What the build plan missed or contradicts

Format: topic | what the plan says (quote or "none") | gap | suggested row (not added to the plan).

**G-1. Data Hub as a fourth application (S1 for decisions).**
- Plan: P625 "A DataLinq-class standalone application that holds many data sources and serves both the Editor and Playout"; `19.3` "Its own Tauri 2 executable, installable separately from Editor and Playout" (P659). Both parked (P623, P653).
- INV 1: "There are exactly three applications: Editor, Playout, Render Engine." The plan already contradicts INV 1 in `19.3`, independent of our design (EXT X-12).
- Our design (SUM section 10) adds more than the plan's X4: per-source sandboxed JavaScript adapter with its own mini IDE and console, WebSocket, SSE, webhooks, TCP/UDP/serial, MQTT, recorded-feed simulator (P631 `19.4` lists CSV, Excel, JSON, XML, HTTP poll, WebSocket, RSS, manual tables; `19.5` SQL and Sheets; none of SSE, webhook, TCP/UDP/serial, MQTT, adapter script, simulator). Plan also says the Data Server serves values at take (`19.8`), design says "Playout keeps last good values and shows 'source lost'" (matches `19.6`).
- Suggested rows: (a) amend INV 1 or restate as "three applications plus an optional Data Hub service that never touches Program" (owner approval; not edited here); (b) `19.4b` "Adapter sandbox: per-source JS on rquickjs under 16.4's rules, with console, sample capture and JSON path picker"; (c) `19.4c` "Live transports: SSE, webhook, TCP/UDP, serial, MQTT"; (d) `19.11` "Recorded feed capture and replay, deterministic". Move X4/X6 out of "parked" or state the release-1 workaround (Editor local CSV/typed table, per `19.7` and `11.19`).

**G-2. Charts and widgets.**
- Plan: widgets only: `11.56` "Widgets: clock, countdown, counter, round timer" (P354); grep of the plan for "chart" returns nothing. Charts are in `CH` section 5 as a proposal (5 rows) not in the plan.
- Suggested rows: the five `CH` section 5 rows, plus (6) "Chart phases: Appears, Changes (tween from drawn value), Leaves; updates never stack; tween bindable to a timeline value" and (7) "Chart element conformance: 17 edge cases as test records". The plan should say Chart.js is not used (invariants 8, 62, 66; `16.4` P352).

**G-3. Formats (16:9, 9:16, 1:1) sharing parts.**
- Plan: `7.8` "Project format and conversion": "Changing the format makes a new project from the old one" (P261). That is a project-level copy, not per-graphic formats with shared parts and per-format layout (SUM L36). Screen B9 draws it.
- Suggested row: `11.119` "Graphic formats: one graphic, several frame sizes, shared parts and look, per-format layout; Playout and the package pick the format by name; a missing format refuses by name". Release 1 may ship 16:9 only (SUM L36).

**G-4. Logic panel, node view, sandbox console in the Editor.**
- Plan: `16.4` sandbox, `11.55` logic, `11.56` widgets, all BE (P352 to P354); `11.58` "Console and debugger" is generic (P482); no frontend row for a Logic panel or code editor with autocomplete, live data inspector, feed simulator, budget meter, node view (SUM L74 to L77).
- Plan also says "Per-scene JavaScript runs only inside 16.4's deterministic sandbox" (P85): consistent. Design adds "Edits to a live scene are not allowed" and "A sandbox script error on a scene on air appears as one line in Playout's diagnostics": no plan row.
- Suggested rows: `11.120` "Logic panel (Editor): script editor, console, data inspector, budget meter, snippets"; `11.121` "Node view over the same actions and events (after the script view)"; `12.13` "Playout diagnostics shows a scene-script error as one line (scene name, Take ID, chip)".

**G-5. Approval queue UI and AI proposal diff.**
- Plan: `8.14` "Propose: submit a changeset to Playout's approval queue (13.7)" (P282); `13.7` is BE (line 369); `8.15` "the diff the designer accepts per layer" is listed as Left (P283). No frontend row for the queue, the per-layer accept diff, or the Admin approve action.
- Suggested rows: `11.122` "Approval queue panel: changeset, headless render (`11.41`), lint result (`11.42`), Admin approve/reject, record"; `11.123` "Proposal diff: accept or reject per layer or field".

**G-6. Keyframe diamond only; no template animations; no default phase bands.**
- Plan: `11.46` "Each animatable property carries an After Effects-style stopwatch beside 11.21's current-frame diamond, with no separate Animation tab" (P480); `11.23` "Fade, Slide, Scale and Pop use the existing preset library" (P509); `11.70` "GrapiX's own broadcast set (in, out and emphasis motion)" (P524); `11.25` "named in, hold, out, continue and update phases as frame spans" (P295); `11.76` workspaces "Author, Animate, Effects, Review" (P425).
- Decision (TL): "no template animations... no default phase bands"; diamond is the only toggle (commit 2f8dd95: "keyframe diamond toggle replaces the stopwatch"); motion is keyframes plus markers.
- Reconcile: phases remain a contract concept (INV 8, `phases.rs`; Playout Continue needs named stop points) but the author makes them with markers, not a preset gallery. Suggested row amendments: `11.46` remove stopwatch wording; `11.23` demote starter presets to optional, off by default; `11.70` motion presets become "saved keyframe sets the designer makes" (also matches `11.15` "Library grows from real designer work"); new `11.25b` "Markers become phase and stop-point spans (Continue, loop-hold) with no default bands".

**G-7. Per-field live update and live linked fields.**
- Plan: `11.54` "Each field also carries `liveUpdate`, default false: Update on air accepts only eligible fields" (P305). `19.8` resolves values "At cue/take" (P634).
- Design: "Linked fields marked 'auto' update on air by themselves" (SUM L68) and TAKE "sends the exact version and data that were checked" (EXT X-9). Playout review: plan "does not define an on-air delta/update cadence" (workflow review, live data row). No plan row.
- Suggested row: `19.8b` "Opted-in live fields: typed delta with source revision and sequence, engine frame-numbered intent, staleness policy per field (hold, refuse, warn); as-run record per update (`12.11`); replay reproduces values". Reword the TAKE guarantee as three layers (EXT X-9).

**G-8. Scene ID, Take ID and the Take/Page glossary.**
- Plan: `6.1` "Published library store; stable Take IDs: IDs stable across republish" (P245); `8.10` "Publish returns Take ID and revision" (P278); `12.2` "published graphics by Take ID" (P546); glossary (`docs/README.md` L69): "Take: a published, immutable, hash-pinned revision... addressed by Take ID"; `11.72` lists "Change ID (F7)" from XPression (P421).
- Design: **Take ID is Playout-only, typed by the operator, unique in the show, locked on air; Scene ID is Editor and Playout, set in the scene list** (SUM L41 to L43); a take is a sequence entry. That reverses the plan's meaning: in the plan a Take ID is created by publish.
- The plan has no rule for Scene ID (auto from 1, editable, takes reference the internal key; open question 3, SUM L124; defaults assumed L206).
- Suggested rows: `1.14` "Identifiers contract: internal scene key (never typed), Scene ID (label, editable, Editor and Playout), Take ID (Playout, operator typed, show-unique, locked on air); every reference uses internal key plus content hash"; change `6.1`, `8.10`, `12.2` wording to "Scene ID and revision" and move Take ID to `12.3`; add a glossary entry for "sequence entry" (the current glossary uses "Take" for revision). Needs owner decision first.

**G-9. Names: Cue, Preload, Stack, Playline, Airview, Element, Style, Phase, Scene Bank, Inputs, Data Hub.**
- Plan glossary (`docs/README.md` L60 to L75; lint `11.66`, P418): Project, Graphic, Layer, Composition, Take, Page, Playout library, Test fill, "Output channel / output layer. Never called a Layer alone". `11.66` "a test fails on 'New scene', 'Publish scene' or any term outside the glossary". `11.32` bans XPression's own names (P410).
- Collisions (EXT section 4.2): Stack vs the glossary's "output layer" and the Effect Controls "stack" (`11.69`, P523); Scene Bank vs Scene Manager and "Playout library" (glossary L64 and L70); Phase vs engine `PhaseKind` (aligns if five kinds are shown); Style vs library layer/text/motion styles; Element vs Layer; Airview "must not read as on air" (UX U-06); Cue: the plan uses "Cue" for the preload command (`6.2` "Cue, take, continue, out, clear", INV 9), so P4 "Cue Control" (calling takes from outside) reuses a word the plan means as preparing a scene. grep of the plan for "preload" returns nothing: the plan has no word for the prepared state.
- Suggested row: `11.66b` "Terms table is one file (`docs/design` TERMS) read by the lint; the glossary in `docs/README.md` is updated from it after the owner approves names". Until then `11.66` will fail every Figma label.

**G-10. Panels menu and layouts (decision: modules are toggles plus saved layouts).**
- Plan: ✓ largely covered: `11.33` "The Panels menu lists every Editor panel and shows, focuses or hides it" (P411); `11.96` Panels menu ticks open panels (P438); `11.76` named workspaces.
- Contradiction: `11.35` "Workspace modes: Design, Animate and Data binding, each a saved layout" (P413) reads as modes; decision is combined toggles. Not a real conflict (they are layouts); wording only. Playout: `12.12` says the strip with on-air state "cannot be closed" (P554), matches SUM L111 (TAKE never hidden).
- Gap: SUM L160 puts P2 panels as "slim tab or slide-out with a status chip so a warning inside is never lost"; plan has no slim-tab chip row. Suggested row `11.97b`: "Hidden panels keep an alert chip for warnings and stop drawing and updating".

**G-11. Timeline and Graph as first-class; text and shape keyframing; parent/child; matte; blend.**
- Plan: Timeline `11.10`, `11.22`; graph `11.68`, `11.11`; parent `11.45`; mattes `3.19` and `11.117` (Alpha and Luma, Invert, Clear: resolves TL open item 1); 27 or 38 blend modes: `3.20` "27 Photoshop and the After Effects modes" (P185) vs TL "38 (EffectCraft)". Path keyframes `11.112` (P454). Text animators `11.61`.
- Gap: base text properties (font size, tracking, leading, fill) as keyframable channels is not stated; `11.61` covers per-glyph animators only. B3d draws keyframe diamonds on character properties. Not verified in code.
- Gap: spatial motion path handles for Position (TL open item 2): `11.112` is vertex-level path keys, not position motion paths.
- Suggested rows: `11.46b` "Text and shape properties keyframable: font size, tracking, leading, baseline, fill, stroke, corner radius, dash, trim; font family holds"; `11.68b` "Spatial interpolation and position path handles on the stage". Confirm `3.20` count matches the 38 modes in TL.

**G-12. Layouts, material manager and design-system leftovers.**
- Plan keeps `11.12` "Material manager" (P470), `11.14`, `11.16` as historical; SUM L86: "No separate material manager". `11.50` lit material stays.
- Suggested: mark `11.12` historical or fold into `11.52` (summary open item 9).

**G-13. Library and assets: virtual folders.**
- Plan `11.43`: assets in on-disk `Assets/Images`, `Videos`, `Audio`, `Models`, `Fonts`, "each one folder deep (a Figma frame's name, say)" (P414). Design: per-project virtual folders you create and name, "Import folder" creating matching folders, one merged Library and asset panel with colours, layer styles, patterns, backgrounds, motion styles (SUM L88 to L99).
- Gaps: no row for virtual folders, nested library, colour/pattern/background/layer-style library items, or "Start from another project's library" (open). `11.60` layer styles are scene properties, not library items. MCP organising folders (SUM L94) has no tool row.
- Suggested rows: `11.52b` "Library: named virtual folders, colours (primary, secondary, misc), patterns, backgrounds, layer-style and text-style items, one panel merged with assets; packages pin the exact items used"; `8.4b` "MCP: arrange folders and library items".

**G-14. Playout production gaps not in the plan.**
- Plan: P539 "Named out of scope, no rows yet: MOS and NRCS newsroom integration, mirrored-engine failover, multiple output channels, programmable control panels, XPN and AMCP adapters, switcher automation, GPI/GPO and tally." (6.9 later brought MOS in; 6.7/6.8 control and panels exist.)
- Missing (EXT X-11, section 2g): emergency graphic and fallback take with armed one-key clear (no row); groups in the sequence; bulk suggest of Take IDs. `12.10` slice 1 refuses another layer ("`LayerNotSupported`", P256) while design has layers -99,999 to +99,999, take on an occupied layer replaces it, independent take-out and clear per layer (SUM L52 to L54).
- Suggested rows: `12.13` "Layer model: range, default 0, replace-on-occupied, per-layer take out and clear, set in the Editor per scene, changeable in Playout"; `12.14` "Emergency take and armed clear (explicit, audited, never an automatic substitution, INV 18)"; `12.15` "Bulk Take ID suggest with preview diff (operator confirms)".

**G-15. Show rules (Play Rules, P8) and transition logic.**
- Plan: "Logic: conditional triggers, scene transitions, per-scene JS modules" `11.55` is per scene (P353); `6.6` "Automation trigger evaluation; execution explicitly deferred" (P250); `16.3` "Transitions beyond cut, dual-target" (P381).
- Design: cross-scene when-then rules, Playout only, armed by the operator; scenes never talk to each other (EXT N-8); transition model with commit frame, out-then-in and overlap, five layer states (SUM L147 to L151, `transition-logic-notes.md`).
- Suggested rows: `6.10` "Show rules: Playout-only when-then rules across scenes and layers; an automatic take is an armed choice; log and frame-exact"; `16.3b` "Transition model: whole-frame commit C, out-then-in, overlap with negative offset, interrupt policies, per-layer default with per-take override".

**G-16. Accessibility and keyboard operation.**
- Plan: keyboard appears in rows: `11.21` ("accessible labels and keyboard operation" P495), `11.31`, `11.72`, `11.79`, `11.80`, `11.95` keyboard moves. No row for contrast, screen-reader roles, focus order, or Playout keyboard model. "accessib" in the plan: only `11.64` "accessible/agent projections" and F3 notes. UX U-15, U-16, U-22: 3.26:1 hint contrast, quirks mode, roles. Playout has no command registry (`11.31` is Editor only, workflow review row on control panels).
- Suggested rows: `11.124` "Accessibility baseline both apps: WCAG 2.2 AA contrast at the SKWAD tokens, roles and names on dock tabs and dividers, visible focus, no keyboard trap, Escape rules, 100 to 200 % scaling"; `12.16` "Playout command registry and keyboard model: TAKE by key, hold-to-confirm by key, focus order, never in text fields".

**G-17. Error, empty and stale states.**
- Plan: `11.67` open: "panels' empty, disconnected and refused states" (P419); `11.65` "named unavailable state, never a stale frame presented as current" (P563); `19.6` staleness; `8.16` advisories.
- Gap: no list of states per screen as a requirement, no row that tests each. Suggested row: `11.67b` "State matrix: every panel and screen has empty, loading, stale, refused, disconnected and unavailable states, each drawn and tested; a stale value is never shown as current".

**G-18. Performance budgets in the UI.**
- Plan: `3.23` 2160p50 (P187), `3.24` governor (order: Preview, headless renders, thumbnails, asset preparation), `11.10` flat node count, `11.65` 250 ms, `11.115` 2 ms hover.
- Design: Preview 360 or 480 lines that lowers itself under load, virtual output (Airview) slowed second, "never live" (SUM L46 to L50); scene script time budget; repeater maximum; chart tween.
- Gap: Airview is not in `3.24`'s order; no row for the virtual output window at all (`12.5` "Confidence monitors... Native-resolution tier", P549, is a hardware monitor). Suggested rows: `12.17` "Virtual output window at full output resolution, independent of live outputs; fed from the same engine frame, never blocks Program"; `3.24b` "Governor order: Preview, then virtual output, then headless, never live; each shift logged".

**G-19. Frames not milliseconds; five phases.**
- Plan: INV 12 rational rates; `11.63` "one integer playhead". Our B3 and the review show ms (EXT X-7). No plan row; suggested: note in `11.63`/`11.25`: "durations stored and shown in frames, ms as a rounded display".

**G-20. Airview and Prism, Node-RED.**
- Plan: no Prism row (correct; idea only). No Node-RED row: "may feed data and commands through the API or MCP" (SUM L72) is covered by `6.7`/MCP, no action needed.

**G-21. Contradiction: ADR-0004 used twice (not verified).**
- Plan `19.1` "ADR-0004: Data Server boundaries" (P629) and `12.11` "Amended by user decision, 16 Nov 2026 (ADR-0004)" (P257), with invariants header "ADR-001 and ADR-004" for transport (INV L36). Could not open the ADRs; check whether ADR-0004 means as-run/transport or Data Server.

---

## 4. Top 10 actions

1. **Resolve the Data Hub question**: owner approves amending INV 1 (or demotes Data Hub to a service); then add the adapter, live-transport and simulator rows (G-1). Unblock `19.1` ADR.
2. **Draw the Figma import screen** (paste link, frame picker, coverage and substitution report) (S-1). The plan's own `18.10` done-when needs it.
3. **Decide the ID rule**: Scene ID (editable label) vs Take ID (Playout, operator) vs the plan's Take = published revision; then rewrite `6.1`, `8.10`, `12.2` and the glossary (G-8).
4. **Draw Playout Monitoring, Outputs and devices, show open/save and sign-in** (S-2 to S-5). They are the operator's day-one screens.
5. **Draw the refusal and blocked states** for TAKE, Publish and the engine preview (S-6, G-17), then add the state-matrix row.
6. **Approve a names table and make `11.66` read it** (G-9); otherwise the glossary lint fails every label. Settle Airview, Stack, Cue/Preload, and rename screen ids so B/F do not clash with plan modules.
7. **Add the missing frontend rows**: Logic panel, approval queue and AI diff, chart rows, formats, virtual folders (G-2 to G-5, G-13).
8. **Reconcile motion rows with the "keyframes only" decision**: `11.46` stopwatch, `11.23` starter presets, `11.70` motion presets, `11.25` default phases (G-6); add text/shape keyframing and position path rows (G-11).
9. **Add layer model, emergency clear, show rules and transition model rows** for Playout (G-14, G-15), and the live-field delta row (G-7).
10. **Add accessibility, keyboard and performance-budget rows** for both apps, including the virtual output (G-16, G-18); fix the Editor 6-menu Figma vs 8-menu plan (`11.32`) by owner decision.

## 5. What I could not verify

- The Figma file itself and the screens' contents: I used the owner's screen list and the design docs. Items marked "may" (transition editor on P7, Data Hub simulator) need a look at the renders in `docs/design/wireframes/figma/`.
- Plan backend modules B1 to B6, B10, B11 (except titles), B13, B14: read by row title only, so a backend row that implies a screen may have been missed.
- `docs/design/grapix-screens-spec.md`, `uiux-review/` playbook and the full research files were not read end to end (headings and cited sections only).
- Whether `3.20`'s mode count equals the 38 modes in TL; whether base text properties are keyframable in the app; the two meanings of ADR-0004.
- The plan header's 293-step count was not recounted.
