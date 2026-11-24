# Verification of the external design review, 24 Nov 2026

Target: `D:\Downloads_Chrome\GrapiX_Editor_Playout_Design_Review.md` (250 lines, "concept wireframes v2"), read in full.
Checked against: `docs/design/` (summary, spec, `wireframes/grapix-wireframes.html`, research, review) and the real tree
`agent/worktree` (`docs/invariants.md`, `AGENTS.md`, `docs/adr`, `docs/reference/xpression-menu-bar.md`, `docs/proposals`,
`GrapiX-Build-Plan.md`, `Editor/src`, `Shared/contracts`). No code run, no app captured, no web access, nothing installed, secrets not read.
Playbook used: `.claude/agents/grapix-uiux-reviewer.md`, `docs/design/uiux-review/{README,checklist,report-template}.md`
(evidence rule: every verdict cites a file and line or section; scoring rubric adapted in section 12). Verdicts: C = Confirmed, P = Partly confirmed, D = Disputed, NV = Not verifiable.
Severity S0 to S4 as in `checklist.md`.

## Executive summary (12 lines)

1. **Disputed: "Moments replace the timeline" is a misreading of B3's own text, not of our decision.** B3 says "Keyframes exist, one level down" and "Fine-tune opens keyframes and the speed curve" (wireframes L359 area, B3 notes). The real Editor already ships a full timeline (`Editor/src/timeline/*`, plan 11.22/11.23). The valid residue: nothing says what happens to a hand-edited curve when a preset is re-applied.
2. **Conflict: two rename sets.** Ours (Stack, Playline, Scene Bank, Inputs, Airview, Element, Style, Phase, Play Rules, Data Hub, Replay Lab) vs theirs (Objects, Canvas, Effects, Brand Kit, Motion, Data Lab, Output Layer, Show Logic, DataHub, GrapiX Assist). Only 5 names coincide. Section 4 lists 14 collisions; neither set is safe as is.
3. **Disputed: "Motion" for Moments.** The shipped Editor already has a Motion menu (`Editor/src/app-menu.ts:248`), plus the Motion step and "Motion Builder": four meanings of one word.
4. **Disputed: "Show Logic".** Scene logic (B12, Editor) and show rules (P8, Playout) are deliberately separate ("Scenes never talk to each other", P8 note). One shared word hides that rule.
5. **Disputed: the ecosystem diagram.** DataHub feeds only the Editor (plan 19.8: Playout reads the Data Server at take); Playout is drawn straight to outputs, bypassing the Render Engine that owns Program (invariants 2, 5, 6). DataHub as a runtime needs invariant 1 changed ("exactly three applications"), which our own summary section 10 already flags.
6. **Disputed: "workspaces Design/Animation/Effects/Data/Logic" as the answer.** Owner decision: modules are toggles plus named saved layouts, not exclusive workspaces (summary section 2, Layouts; plan 11.94 to 11.101). The review's own sentence ("saved arrangements, not modes") agrees with us; its table row "No dedicated workspaces: Critical" does not describe the plan. The wireframe page does not draw the Layout dropdown, which is the real gap.
7. **Confirmed (we should change): AI permissions "role-based, not provider-based".** Our B11 lists Claude, ChatGPT, "Other model" with different rights; invariants 65 and 85 grant by credential scope. Fix B11.
8. **Confirmed (we should change): our wireframes' Moments omit Continue**, and the engine has five phases (In, Hold, Out, Continue, Update: `Shared/contracts/src/phases.rs:37`). The review's Enter/Hold/Update/Exit omits it too; "Hold" and "Update" match the engine, "Appears/Stays/Changes/Leaves" do not.
9. **Partly confirmed: Playout production list.** Of 8 items, 3 are already planned (playlist import/export 6.9, Stream Deck via Companion 6.8, ack and dedup invariants 13, 48, 49, 6.7), 2 are explicitly out of scope for release 1 (multiple outputs, mirrored failover: plan L539, Q8), 3 are missing (groups, bulk IDs, emergency graphics and fallback scenes).
10. **Review quality: 55 / 100.** Good instincts on timeline parity, per-field live updates, provider-neutral AI, Take/Preview/Program kept. Weak on accuracy about our design, no evidence citations, internally inconsistent on renaming, and silent on accessibility, performance, error states and TAKE/CLEAR safety.
11. **Jev and Laya** (section 11): they agree on 5 of 10 questions; where they split, Jev is the signal on timeline, scene ID and logic order, and I keep my evidence verdict on inspector and live fields. Where a model disagrees with the owner's decisions (workspaces as fixed modes, Laya nodes-first), I keep my verdict.
12. **Adopt/reject list in section 13** (14 items, each tied to a wireframe screen id).

## 1. The document's ratings and internal contradictions

Ratings (doc L15 to L25): seven /10 scores. **The document itself says they are "subjective design-review ratings, not measured usability or performance results"** (L15), and its scope note (L250) says engine performance, accessibility, network reliability and live behaviour were not validated. They are opinions; none can be audited. Two of them rest on the misreading in (a): "Professional animation controls 5.5" assumes the timeline is missing; "Editor experience 7.0" assumes the card cannot expand (b).

| # | Internal contradiction or inconsistency | Where in the review | Severity |
|---|---|---|---|
| I-1 | Says "Uniqueness should come from the product's features, not from renaming every standard design term" (L89), then renames 12 of 17 rows, including Stage to Canvas, Moments to Motion, Test records to Data Lab, Show rules to Show Logic, Virtual output to AirView | L89 vs table L93 to L111 | S2 |
| I-2 | "Motion" is the new name of Moments, of the Motion Builder, of a menu and (implicitly) of the journey step | L102, L58, L124 | S2 |
| I-3 | "Data Lab" is the Test records screen (L101) but section 7 describes it as the property-to-field binding experience plus validation plus replay (L179). A screen, a step and a menu all called Data | L101, L179, L124 | S3 |
| I-4 | Decision table says the Inspector is "a good starting point" (L31) but the table calls the card change "High" and rates Editor 7.0; no new evidence between them | L31, L35, L22 | S4 |
| I-5 | Playout rated 8.5 and "the strongest part" (L145) yet the handoff asks to "prioritise production-level Playout controls" (L246) and lists eight additions as requirements (L158 to L166), while the same review lists external control, output support as "open questions... not approved requirements" (L224 to L230). The additions are not marked open | L145, L158, L224, L246 | S2 |
| I-6 | Section 2 table: "No dedicated workspaces: Critical". Section 5: "Workspaces are saved arrangements of panels, not separate modes". The workspace names (Design, Animation, Effects, Data, Logic) are module names, i.e. they read as modes | L37, L139, L136 | S3 |
| I-7 | Lists "Keep the existing central terminology-table concept, with stable internal identifiers" (L113) and then renames Look to Effects while "Event look" becomes Brand Kit, so "Look" is removed in two places without saying where Look (journey step 1, card section) goes | L99, L113 | S3 |
| I-8 | Diagram: Playout to Output with no engine between them, but the text says the live path "depends on the real-time rendering engine" (L203) | L200, L203 | S2 |
| I-9 | Says wireframe lacks workspaces while praising "Retain command search (Ctrl+K), the shared command registry and configurable shortcuts" (L139): all three already exist in our B7 and plan 11.31 | L37, L139 | S4 |

## 2. Per-claim verdicts: the nine required topics

### (a) Moments vs Motion Builder + Timeline on one animation model

| Claim in review | Verdict | Evidence |
|---|---|---|
| "Moments replacing the default timeline"; Moments "should not replace the timeline" (L36, L49) | **D (misstates our decision)** | B3 purpose: "Choose how each part appears, changes and leaves. Keyframes exist, one level down." (wireframes B3 entry). B3 note 4: "Fine-tune opens keyframes and the speed curve for the one value that needs it". Summary section 2 / question 2 in the page: "Keyframes and curves stay one click away under Fine-tune. Right default?". The real Editor has the dope sheet, speed graph and phase bands (`Editor/src/timeline/{phases,speed-graph,key-edit}.ts`; proposals A2 "strongest area"). The title "Moments: motion without a timeline" and the P1 table "Instead of: A keyframe timeline (still there under Fine-tune)" invite the misreading, so the review is half our fault. |
| Fine-tune is "a small secondary panel that is difficult to access" (L73) | **P** | B3 note 4: "in a panel that slides over the strip", one click, per value. A first-class Timeline tab or the timeline in a saved layout is not drawn in any B screen, so the review is right that the wireframes do not show a full timeline view. The app does (11.22/11.23). |
| Both views must share one model; a preset yields editable keyframes (L85) | **C, and a gap in our docs** | Rust is source of truth (inv 22) and `TimelinePhase` is a label over existing frames/channels (`phases.rs:1-20`), so one model exists in the contract. B3 does not state that a style generates keyframes, nor what "Apply to all parts" does to a hand-edited curve. Silent overwrite would also breach invariant 18's spirit (no silent substitution). |
| Hold, looping and Update "must retain their runtime meaning" (L85) | **C** | `PhaseKind::Hold`: "Idle loop after `in` completes. Interruptible at any frame"; `Update`: "How a bound value changes on air without a full re-take" (`phases.rs:37-48`). B3 note 3: "Stays is not animation: it is the hold... Continue and Take out act on". Conflict inside our own B2: the card says "Stays: Soft glow" (U-19). |
| Frame-exact engine | **C, with a gap neither document sees** | Invariants 8, 9, 12 (engine sole clock; `Frame(n)`; rational rates). Transition notes: whole frames, one shared calculation. But both B3 and the review show durations in **ms** (400 ms, 200 ms, 360 ms). At 59.94 fps 400 ms is not a whole frame count. UI should store and show frames, offer ms as a convenience that rounds visibly. (S2, missed by both.) |
| Rename Appears/Stays/Changes/Leaves to Enter/Hold/Update/Exit | **P** | Better than ours for Hold and Update (engine words) but the engine's In/Out are not Enter/Exit, and **Continue** (staged build on the Continue command) is missing from both. B3 shows "Stop point hold" under Stays instead. |

### (b) Single selected-part card vs expandable Inspector

| Claim | Verdict | Evidence |
|---|---|---|
| Single card "oversimplifies" (L35, L9) | **P** | B2 `CARD` has three sections (Look 5 rows, Motion 3, Data 3) with **[More...]** under Look; B2 note 3: "Everything else is under More: stroke, shadow, gradient, opacity, letter spacing, line height, case, fallback font, direction, number format. Rarer settings are found by search. The full inventory... docs/design/research/look-properties-research.md". So the card is already expandable by section. What is missing: a categorised, searchable "all properties" list and pin/lock (plan 11.100 pinned Properties; 11.35 modes). |
| "Expandable Inspector with property categories" | **Adopt with change** | The real Editor already has `inspector.ts` and a Properties panel with tabs; the spec flags seven tabs wrapping at 360 px (UX issue 5 in spec table). So the card must stay compact by default; More opens categories with search. Do not copy a seven-tab Inspector. |
| Rename card to Inspector | **P** | Fine but no collision-free gain; the app's shipped word is "Properties". |

### (c) Workspaces and ten menus vs six menus + Ctrl K + saved named layouts

| Claim | Verdict | Evidence |
|---|---|---|
| "No dedicated workspaces" in the proposal (L37) | **P** | B2 prose says "there are no workspaces to switch" (page L183) and menu note: "Panels still dock, tab and float" (page L253). But the summary decided **named saved layouts**, "switched from a dropdown on the top ribbon" (summary L100 to L103), Figma Editor/Ribbon has a Layout dropdown (summary L195), and plan rows 11.92 to 11.101 build the dock tree, saved workspaces, selector, floating groups (11.94, 11.96 describe selector and Layout menu). Gap: the wireframe `bars()` draws no Layout dropdown. |
| Fixed workspaces Design / Animation / Effects / Data / Logic | **D** | Owner decision 24 Nov: Design, Animation and Data panels needed at once, "NOT one module at a time" (`jev-laya-ui-decisions-2026-11-24.json` input; memory note "Modules are toggles"). Plan 11.35 and 11.76 already ship named layouts (Author, Animate, Effects, Review) that are *arrangements*, not restrictions. Naming layouts after modules is harmless as long as they remain layouts. |
| Six menus insufficient (L119) | **P** | Six menus plus Ctrl K is wireframe "Decision 5", not final (page decisions list). The **shipped Editor has eight**: File, Edit, Project, Motion, Panels, Layout, Utilities, Help (`Editor/src/app-menu.ts:135,179,240,248,271,300,317,339`), built to `docs/reference/xpression-menu-bar.md` (XPression has eight: File Edit Windows Projects Animation Display Tools Help, ref L36). So the real tension is wireframe (6) vs app (8), not wireframe vs review (10). |
| The review's 10-menu list (File Edit Scene Object Motion Effects Data View Window Help) | **P / NV on source** | It is almost the leftover constant `MENU_EDITOR=['File','Edit','Scene','Layer','Effect','Motion','Data','View','Window','Help']` still in the wireframe script (page L302, unused) plus the unused workspace map `ON` (L303: Default, Animation, Effects, Data, Text, Publish, Diagnostics) from the superseded layout (commit `2dcdc9d` replaced it). Likely source of the review's lists; cannot be proven. |
| Window menu: docking, floating, multi-monitor, save/switch/reset (L139) | **C** | Plan 11.95 to 11.101: five drop zones, floating groups, pop-outs and monitor changes, Layout isolation 11.97, Playout workspaces 12.12 (strip outside docking that cannot be closed). Owner earlier said not pop-out windows for the *module* question; pop-outs remain optional in 11.101. |
| Publish "easily accessible in the main toolbar" | **C** | B-screens `bars()` draw "Publish..." in the top bar; Figma Ribbon has Publish. |

### (d) Rename tables: see section 4 (full conflict analysis).

### (e) Scene ID rule

| Item | Review (L216) | Ours | Verdict |
|---|---|---|---|
| Identifier model | Auto-generated immutable internal ID + editable display identifier; references use the immutable one | Summary L204 to L206 (assumed default, **not confirmed by owner**): "Scene ID automatic from 1 and editable (takes reference the scene by an internal key)". Page decision 9 still asks "is it automatic, can it be edited, what happens to takes if it changes" | **P. Functionally the same model.** Ours has the internal key but names the editable thing "Scene ID" and the key nameless. Difference is vocabulary: the review makes the display ID explicitly a label. |
| What the contracts say | n/a | `SceneDocument.id: String` plus `name` (`Shared/contracts/src/scene.rs:1796-1799`); no display-ID field. Plan 6.1 "IDs stable across republish". Invariant 30/61: rundown items pin version and content hash. Invariant 74: duplicate ids keep the first. ADR-0001 B.2 carries `take_id` | No invariant states whether an id is editable. Needed: a contract note that Playout references scene by internal id + content hash, never by the editable label. **P** |
| Take ID | operator-editable before air; unique | Summary L42: typed by operator, unique, locked on air; Jev/Laya safety run suggested next free number as a suggestion only | **C** (identical) |
| Risk the review misses | none | An editable Scene ID shown in both apps, and another system calling Take ID, means a third identifier (internal key) must never appear as a command argument; and uniqueness scope (project? show?) is undefined | S3 |

### (f) Live field updates, Program isolation, immutable versions

| Claim | Verdict | Evidence |
|---|---|---|
| Live updates configurable per field (L221) | **C (already decided)** | Plan 11.54: each field carries `liveUpdate`, default false; Update on air accepts only eligible fields and refuses an ineligible one by name; "eligibility grants no authority" (decision Q4, plan L71). Page decision 11: "linked value changes only when the operator presses Update, unless auto-update is allowed per field". P3 note: per-field choice. |
| Do not force a preview of each score change; distinguish package version, checked initial snapshot, runtime updates (L171) | **P: valid refinement of our text** | Our page rule "TAKE sends the exact version and data that were checked... and the engine refuses if they no longer match" (page L277) covers the initial take. It does not say how auto-update fields fit; as written, a live score change would trip that refusal. Wording needs the three-layer distinction. Plan 19.8: values resolved at cue/take, committed frame records the data revision; per-update records need 12.11 as-run. |
| Program isolated from Editor and Preview; preview failure cannot alter Program (L173) | **C** | Invariants 3, 4, 5, 6, 14, 18, 40; Preview on its own renderer (P1 note 4, P6 note 1); governor "slows Preview first... never live" (summary L50). |
| Immutable published versions | **C** | Invariants 7, 30, 61. B10: "nothing changes under a reader until it moves". |
| "Only authorised Playout commands change live output" | **C** | Invariants 5, 65, 84 (operator name on every Program command), 85. |

### (g) Playout production requirements (L158 to L166)

| Item | In wireframes? | Invariants / plan | Status | In release 1? |
|---|---|---|---|---|
| Multiple output channels and render engines | No. P6 Monitoring lists outputs; P7 layers are on one output | Inv 10 (two references = two engine instances); plan 12.10: only Program channel accepted, others refused by name; plan L539 and Q8: "First release... one Program channel", multiple output channels out of scope; Codex P5 recommends defer | **Parked** | No. Keep the `channel` field in contracts. |
| Groups and subgroups in the sequence | No (P1 is a flat list) | No row (6.4 is persistence and cursor) | **Missing** | Defer. Not a safety item. NV whether operators need it for esports. |
| Playlist import/export | No on P1 | Plan 6.9: XML and CSV save/load of the run order (backup), MOS levels 1 to 3 later | **Planned (not drawn)** | XML/CSV yes (it is also the backup); MOS no |
| Bulk Take ID and layer assignment | No | None | **Missing** | Adopt with change: bulk *suggest* with preview diff and uniqueness check; Take ID must stay operator-confirmed (our decision, U-07). |
| Engine failover and reconnection | Reconnect: commit `55e18b8` "reconnect to the engine by itself". Failover: no | Inv 6, 36, 48, 57, 58; ADR-0001 L434 "local standby before remote failover"; plan L539 puts **mirrored failover out of scope**; 14.6 roles; 15.11 device-loss tests | Reconnect **built/planned**; mirrored failover **parked** | Reconnect yes; mirrored failover no |
| Emergency graphics and fallback scenes | No | None in invariants or plan. Related: P7 "Clear all armed, asks twice"; inv 18 forbids silent substitution, so a fallback must be an explicit operator or armed action | **Missing** | Decide before release 1: a pinned "emergency" take plus a one-key clear is cheap and operators expect it. Adopt with change (explicit, never automatic substitution). |
| Configurable keyboard and Stream Deck | Mentioned (B7 note, menus note) not drawn on P | Plan 6.8 Stream Deck via Bitfocus Companion over 6.7; 11.31 command registry (Editor only; Playout has none, Codex L28 review) | **Planned** | Command IDs and permissions yes; devices later (Codex P6) |
| Command acknowledgement, dedup, execution status | P4 note 2: refusal names its reason; no per-command status strip | Inv 13 (control plane ordered, acknowledged), 48, 49 (duplicate acknowledged never re-executed), 33; plan 6.7 coded replies, 8.12 idempotency keys, 12.11 as-run | **Built in contract, not drawn** | Yes. Draw an execution-status line (sent, committed at frame N, refused: reason) on P1/P4. |

### (h) "JavaScript first, Nodes later" vs our earlier decision

| Claim | Verdict | Evidence |
|---|---|---|
| Decision table L219 | **C: same as ours, presented as new** | Summary L111: "JavaScript first, Nodes right after on one shared vocabulary" (listed under "proposed by me, awaiting confirmation"); spec L40 "First version: JavaScript, Nodes right after (to confirm)"; B12 note 1: "Timelines, Script and Nodes are three views of the same scene logic. The first version can ship Script, with Nodes right after". Plan 16.4: deterministic per-scene JS on rquickjs. |
| Shared actions/events vocabulary | **C** | `research/visual-logic-research.md` section 7.3 (lines 237 to 242) defines one vocabulary for Nodes, scripts, API, MCP; invariant 62 (no wall clock or network in scripts). |
| "Later" for nodes | **P** | We said "right after", with Nodes-from-the-start still an owner choice (page decision 14). The review adds nothing about per-frame purity, sandbox budget or Stays; ours covers those (B12 note 2). |
| User's timeline/EffectCraft answer | **NV here** | The owner's EffectCraft answer is in memory/plan 16.x, not in `docs/design/*`; what is recorded is that each scene has "its own timelines and its own sandbox" (summary L56). |

### (i) "Editor controls schema, Playout controls values"

| Claim | Verdict | Evidence |
|---|---|---|
| Editor owns the field schema; Playout owns values | **C** | Plan 11.26/11.54: fields declared in the Editor, schema part of the published revision; Playout owns operator fill (plan Q5, 12.8). P3 note 1: "The designer decides which fields are published. Here the operator sees only those, can type values, link them, and can hide ones they do not need". |
| Playout may not add or change fields | **P** | Our page decision 10 still asks "Should the operator also be able to publish extra fields, or only the designer?". "Hide" is an operator choice; "published" column in P3 mixes designer publication with operator visibility (U-24). The review's rule answers decision 10 and should be adopted. |

## 3. Other checks requested

| Claim | Verdict | Evidence |
|---|---|---|
| **Brand Kit** vs our per-project Library | **P** | Summary L88 to L99: Library per project (BMPS own, FFWS own): colours (primary, secondary, misc), layer styles, text styles, fonts, logos, backgrounds, patterns, motion styles, in one panel merged with the asset manager; "Start from another project's library" still unanswered. B5 uses "Event look" (colours, fonts, logos). A Brand Kit is a subset; renaming Event look to Brand Kit would hide patterns, layer styles and motion styles. Keep "Library" (container) and use "Brand" only if a subset view is wanted. "Brand Kit" is used by other products; trademark clearance not checked (NV; the review itself says names are not cleared, L113). |
| Multiple scene tabs and split view (L41) | **P** | Real app: Scene Manager holds independent graphics with own selection, playhead, undo (plan 11.64, proposals A7); 11.100 adds more than one viewport and pinned Properties. Wireframes show one stage. Valid for wireframes B2, not a new plan item. |
| Hierarchical object tree with visibility, lock, parenting (L38) | **C, already in the contract** | `ObjectBase.visible`, `.locked` (`scene.rs:213-215`); hierarchy resolved from roots (inv 74); `Editor/src/object-manager.ts` header "hierarchy, visibility, lock, alpha, transforms" and refuses a visibility toggle hidden by a parent. B2 `PARTS` shows a flat list with "A part can be a group" only: a wireframe gap. |
| Workspaces Design/Animation/Effects/Data/Logic vs toggles | **D** | See (c). |
| Ecosystem diagram vs "exactly three applications" | **D (partly)** | Invariant 1: **Editor, Playout, Render Engine**; Shared is contracts, not a runtime. The diagram draws six boxes: Design Sources, DataHub, AI/MCP, Editor, Playout, Render Engine, Prism. Design Sources, AI/MCP and Prism are not applications (inputs/readers). **DataHub as a runtime breaches invariant 1 unless amended**; our summary section 10 says the same ("invariant 1 must change; not edited from this side session") and plan 19.3 already lists a standalone Data Server app, so the plan and invariant disagree independently of the review. The diagram also misses DataHub to Playout (plan 19.8) and draws Playout to Output with no engine (inv 2, 5, 6). |
| "Render Engine: File rendering" branch | **P** | Invariant 2: the engine is the only rasteriser, so an offline file branch must be the same engine, as the review's text says (L203). The plan has no offline file-render row (searched: none found), so it is new scope, correctly marked conceptual. |
| Prism: define package contracts now, implement later | **C** | Summary L20, F1 marked "planned, idea only"; B6 note 1 "package already holds room for other formats". Open questions 6 and 7 unanswered. Our UX review U-18 already asks to keep Prism on F1 only. |
| Start from graphic types alongside blank | **C** | B1 has six cards including Blank. |
| Transition: per-layer default with per-take override | **C (same default)** | Summary L204; research proposes "take overrides pair, pair overrides layer default"; still open Q4 in summary. |
| AI permissions role-based, not provider | **C, and we contradict ourselves** | B11 lists clients "Claude: read + propose; ChatGPT: read only; Other model: ask first" (page B11). Invariants 65, 85 and plan 2.9 scope by credential. Summary open question 7 asks the same. |
| Preserve broadcast terms Scene ID, Take ID, Preview, Program, Take | **C** | Our own TERMS table does not rename them; Take/Take ID/Calling takes were held because CUED already means preloaded (page L520 comment). |
| Retain Take out, Hold, Continue, Clear; positive and negative layers | **C** | P1, P7 notes (layers -99,999 to +99,999; Clear armed). |

## 4. The rename conflict (item d)

### 4.1 The two sets side by side

| Concept | Our TERMS table now | User's pasted proposal (PROPOSED, page L-script) | External review | Same in both new sets? |
|---|---|---|---|---|
| Layer (Playout slot) | Layer | **Stack** | **Output Layer** | No: conflict |
| Sequence | Sequence | Playline | Playline | **Yes** |
| Scene list | Scene list | Scene Bank | Scene Bank | **Yes** |
| Scene data | Scene data | Inputs | Inputs | **Yes** |
| Virtual output | Virtual output | Airview | AirView | **Yes** (case) |
| Part | Part | **Element** | **Objects** | No |
| Look | Look | **Style** | **Effects**; Event look to **Brand Kit** | No |
| Moment | Moment | **Phase** | **Motion** (stages Enter, Hold, Update, Exit) | No |
| Show rules | Show rules | **Play Rules** | **Show Logic** | No |
| Data Source Manager | Data Source Manager | Data Hub | DataHub | **Yes** (spacing) |
| Recorder and simulator | Recorder and simulator | Replay Lab | Replay Lab | **Yes** |
| Stage | Stage | not changed | **Canvas** | No |
| Selected-part card | card | not changed | **Inspector** | No |
| Fine-tune | Fine-tune | not changed | **Timeline** | No |
| Test records | Test records ("Cast" removed) | not changed | **Data Lab** | No |
| Ask | Ask | not changed | **GrapiX Assist** | No |
| Take, Take ID, Calling takes | Take... | Cue, Cue ID, Cue Control (**HELD**: CUED = preloaded) | **Keep** Take, Take ID, Preview, Program | Both effectively keep |

### 4.2 Collisions

| # | Collision | Evidence | Hits |
|---|---|---|---|
| N-1 | **Layer / Stack / Output Layer.** The Editor's Layer is "an object row in a Graphic's timeline. Not an output layer"; "Output channel / output layer... Never called a Layer alone" (`docs/README.md:68,73`, user decision Q6, lint 11.66). | Review's "Output Layer" is already the repo glossary term; our "Stack" departs from it (and "stack" is also the Effect Controls stack and P7's "front to back" list) | Ours: medium. Theirs: low |
| N-2 | **Style** (ours) overlaps existing styles: Library "layer styles", "text styles", "motion styles" (summary L96 to L99), and B3 note 2 "A style is a named, tested motion". Rename Look to Style makes "style" mean finish, motion preset, text and layer style | summary, B3 | Ours: **high** |
| N-3 | **Look** is overloaded already: journey step 1, card section, finishes gallery (B5 "Looks"), Event look. The review is right here (L89). Its fix (Effects + Brand Kit) removes the first three meanings but leaves step 1 and card section unnamed | B2 map table, B5 | Both |
| N-4 | **Effects**: the engine's effect catalogue (322 looks, "engine-ready" chips, plan 3.22/3.25, `effects-panel.ts`, `effect_catalog.rs`) and the Effects menu/workspace/Effects gallery would be one word for the library, a menu and a mode. Plan 11.60 layer styles and 11.61 text animators are not "effects" in the engine sense. Fine for the catalogue, loose as the name of the whole Look step | plan, code | Theirs: medium |
| N-5 | **Motion**: shipped Editor menu "Motion" (`app-menu.ts:248`: controls, curves, add key, preset in/out), journey step 2 "Motion", card section "Motion", the review's "Motion Builder" and Moments renamed "Motion" | code, B2 | Theirs: **high** |
| N-6 | **Phase** (ours): engine `PhaseKind` In/Hold/Out/Continue/Update, timeline phase bands (11.25), "Play this phase" menu item, invariant 84 ("Cue, take, clear, a phase and an output change travel with the operator"). Moment to Phase would *align* the UI with the engine, but only if the five engine kinds are shown, not four Moments | `phases.rs`, `phases.ts`, inv 84 | Ours: medium (and an opportunity) |
| N-7 | **Data Lab / Data step / Data menu / Data panel.** Test records screen, binding screen and menu share "Data". "Lab" is also in Replay Lab (a Playout tool) so two "Labs" do unlike jobs. Our removal of "Cast" for "Test records" is plain and unambiguous; Data Lab hides *test* (journey step 4) inside a *data* word. **Conflicts.** | B4, review L101/L179 | Theirs: medium |
| N-8 | **Show Logic vs scene Logic** (B12 "Logic" panel; "Logic" workspace in review). Scenes never talk to each other; cross-scene rules are Playout-only (P8 note 1). One word hides that boundary | B12/P8 notes | Theirs: **high** |
| N-9 | **Canvas vs Stage vs Composition.** The shipped viewer is "Composition" (glossary decision Q6, plan 11.66 lint); wireframes say Stage. Canvas adds a third and echoes the HTML canvas element | `docs/README.md:67` | Theirs: medium |
| N-10 | **Scene Bank vs Scene Manager vs Playout library.** Glossary: Scene Manager is the Editor module only; Playout's catalogue is "Playout library" (decided, 12.2). Both new sets use Scene Bank for the Playout list, so both depart from the owner's glossary | `docs/README.md:64,70` | Both |
| N-11 | **Take vs Page vs take row.** Glossary: Take = published immutable revision; Page = operator-filled instance in the rundown. The wireframes use "take" for a sequence entry with a Take ID. Existing inconsistency independent of either set | glossary vs P1 | Neither (S2, pre-existing) |
| N-12 | **Airview / AirView** says "air": risk of reading it as the on-air feed. The virtual output is local, never on air; U-06 already flagged confusion between that window and Preview/Program | review U-06, P5 | Both: **high for safety** |
| N-13 | **GrapiX Assist vs Ask.** B8 is MCP clients proposing edits, with no built-in model; "Assist" suggests a bundled assistant and a place to type prompts to a vendor; naming a product feature after the provider-neutral door is OK but implies in-product intelligence | B8, B11 | Theirs: low |
| N-14 | **Inputs** (Scene data) vs plan items for live video inputs/key and fill ("Inputs" in `xpression-benchmark` live video row); **Element** vs "real HTML elements are not used" tree language; **Objects** vs MCP `objects_hierarchy` (a match, good) | not verified in detail | Low, NV |

Also: a mixed set is likely. "Play" now prefixes Playline, Playout, Play Rules (ours); "Data" prefixes four things (theirs).

### 4.3 Which set is safer

| Criterion | Ours | Theirs | Safer |
|---|---|---|---|
| Air-critical words (Take, Take ID, Preview, Program) | Held, same | Kept explicitly | Equal. Both keep them |
| Matches existing glossary / code | Departs from glossary (Layer, Scene Bank); adds N-2 | Matches glossary for Output Layer; Objects matches MCP/contract wording; departs at Canvas, Scene Bank | **Theirs, slightly** |
| New collisions introduced | Style (high), Phase (medium) | Motion (high), Show Logic (high), Data Lab (medium), Canvas | **Ours, slightly fewer high ones** |
| Owner direction ("new words, don't copy AE/XPression", summary L24) | Follows | Mostly keeps standard words | **Ours** |
| Safety of misreading under show pressure | Airview risk | AirView risk, Show Logic hides P8 boundary | Equal |

Recommendation: neither set wholesale. Keep Take, Take ID, Preview, Program. Use **Output Layer** (glossary). Use engine words for the motion stages where they exist (Hold, Update, In/Out, plus Continue) before inventing new ones. Reject Show Logic (keep Play Rules or "Show rules"), reject Motion as a rename of Moments, reject Style as a rename of Look, hold Canvas. Settle Airview with the safety constraint "must not read as on air" (for example "Local view"; a name decision for the owner, not mine).

Test records vs Data Lab: they **do conflict** in function (the review's Data Lab covers more than test records, N-7). "Test records" (we dropped "Cast") is clearer. Reject Data Lab as the name of the Test step; consider it for the whole B4 screen only if Test keeps its own name.

## 5. Ecosystem and Prism statements

| Statement | Verdict | Evidence |
|---|---|---|
| Editor "Design · Motion · Logic" box | **P** | Editor also owns Data binding, Test, Publish, Library; naming modules on the box implies modes (see (c)). |
| Package from Editor to Playout, Render Engine, Prism | **P** | Playout reads packages; the engine does not read from the package branch independently of Playout (inv 5). Prism is a future reader (B10 note 2). |
| "Keep publishing immutable" | **C** | Inv 7, 30. |
| Package contents: scenes, animation, assets, formats, field schema, integrity metadata | **C** | B10 "Contains": fields, fingerprint sha-256, formats; inv 31, 79 (`.gpxpkg` manifest). |
| Prism "do not implement yet" | **C** | Summary L20. |

## 6. Strengths the review is right about (where we should change)

1. Per-field live updates, provider-neutral AI roles, Take/Take ID/Preview/Program kept, Scene ID display vs internal, schema vs values.
2. Timeline as a first-class view for pro users and the "preset becomes editable keyframes, curves never silently overwritten" rule.
3. Hierarchy tree in Parts (visibility, lock, parent), scene tabs.
4. Retain journey as optional guidance, not a wizard: our rail now marks the current step; "optional" should be stated.

## 7. What the review missed

| Area | Evidence of the gap | Severity |
|---|---|---|
| **Accessibility** | Our UX review measured: hints 3.26:1 (fail), 24% of text under 9 px, quirks mode, no `lang`, `role=img` wireframes (U-15, U-16, U-21, U-22). Review scope note admits accessibility was not validated (L250) | S2 |
| **Performance budgets** | Load governor order (Preview, then virtual output, never live; summary L50), 360/480-line Preview, sandbox time budget, repeater maximum, "no media path may influence Program cadence" (inv 14). The review says "engine performance... not validated" and sets no budgets | S2 |
| **Empty, error, stale, loading states** | U-12 (no failed/success publish state), U-23 (take with empty fields not drawn), data-stale chips, "source lost" (summary L219) | S2 |
| **Keyboard-first operation** | Playout is used under show pressure; shortcuts, Ctrl K exist, but no TAKE keyboard model, focus order, or hold-to-confirm by key | S2 |
| **Safety of TAKE / CLEAR** | U-01, U-02, U-05 (applied): one TAKE, TAKE OUT hold-to-confirm, CLEAR armed and 4 px from TAKE OUT before the fix; inv 11 free-run unmissable; inv 84 operator named; lock Take ID on air | S1: the review rates Playout 8.5 without checking any of this |
| **Frames vs milliseconds** | See (a). | S2 |
| **Operator identity, as-run, roles** | Inv 84, plan 12.11, 2.15 | S3 |
| **Localisation / non-Latin text** | Plan 11.91; B4 test record 44 (non-Latin) | S4 |
| **The wireframes' real defects** (selected-part mismatch U-10, three-up format canvas U-11, rail without current step U-09) | `uiux-review-wireframes-2026-11-24.md` section 3 | S2 |

## 8. Gaps and contradictions ranked (S0 to S4)

| ID | Sev | Finding | Source |
|---|---|---|---|
| X-1 | S1 | Moments lack Continue; engine has five phases; both name sets omit it. A designer cannot author a staged build from the Moments view | `phases.rs:37-48`, B3 |
| X-2 | S1 | AIR naming (Airview/AirView) risks reading the local virtual output as on air | U-06, P5 |
| X-3 | S1 | Review rates Playout 8.5 with no check of TAKE/CLEAR safety, a11y, error states | review L145, L250 |
| X-4 | S2 | Ecosystem diagram contradicts invariants 1, 2, 5, 6 (DataHub app, engine bypass) | diagram L191-201 |
| X-5 | S2 | Rename set collisions N-5, N-8 (Motion, Show Logic), N-2 (Style), N-10 | section 4 |
| X-6 | S2 | B11 provider-named permissions | B11 vs inv 65, 85 |
| X-7 | S2 | ms in UI vs frame-exact engine | inv 8, 9, 12 |
| X-8 | S2 | No rule for re-applying a preset over hand-edited curves | B3 |
| X-9 | S2 | "TAKE sends exact checked data, engine refuses on mismatch" conflicts with per-field live updates | page L277 vs 11.54 |
| X-10 | S2 | Layout dropdown, scene tabs, hierarchy tree absent from B2 while decided in summary/plan | summary L100; plan 11.96 |
| X-11 | S2 | Emergency/fallback graphics, groups, bulk IDs missing everywhere | section 2(g) |
| X-12 | S3 | Plan (19.3 standalone app) and invariant 1 disagree about a fourth application | plan 19.3, inv 1 |
| X-13 | S3 | Take (glossary: revision) vs take (sequence entry) vs Page | `docs/README.md:69,71` |
| X-14 | S3 | Review's 10-menu list resembles an unused superseded constant in our page; shipped app has 8 menus | `app-menu.ts`, page L302 |
| X-15 | S4 | Review has no citations at all; ratings are opinion | L15 |

## 9. Claim-by-claim index (all sections of the review)

| Review section | Claim | Verdict |
|---|---|---|
| 1 | Product direction strong; separation of Editor, Playout, data, AI good | C (inv 4, 5, 65) |
| 1 | 7 ratings | NV (self-declared opinion) |
| 2 | Three-panel layout good start | C |
| 2 | Expandable Inspector | P (2b) |
| 2 | Keep a full timeline | P (2a) |
| 2 | Customisable workspaces with saved layouts | P (2c) |
| 2 | Hierarchical tree, visibility, lock, parenting | C (contract) / wireframe gap |
| 2 | "Looks gallery" to separate effect library and effect controls | P: B5 has "All looks (322)" behind one click and Effect Controls exist in the app (plan 3.22); separation in wireframe not drawn |
| 2 | Five-step rail to collapsible validation bar | P: our U-09/U-19 already propose slim stepper; "optional, not wizard" adopted |
| 2 | Multiple scene tabs, split view | P |
| 3 | Rename Appears/Stays/Changes/Leaves | P (2a, 4) |
| 3.1 | Motion Builder with stagger, presets, easing | C: B3 style list, Stagger, Easing, Apply to all |
| 3.2 | Timeline: keyframes, curves, markers, masks | C in app (11.22, 11.47), not drawn in B |
| 3.3 | Shared engine; no silent overwrite | C, gap |
| 4 | Names too generic; Look ambiguous | C (N-3) |
| 4 | Table of 17 renames | D / P (section 4) |
| 4 | Keep terms table, stable internal ids | C (page TERMS L525, rule: one table) |
| 5 | Six menus insufficient | P |
| 5 | 10-menu structure | P/NV (2c) |
| 5 | Workspaces | D as modes, C as layouts |
| 5 | Ctrl K, shared registry, shortcuts | C |
| 6 | Playout strongest | P: strong on structure; unverified on safety (U-01..U-05 existed) |
| 6 | Retain table (Scene/Take ID, Preview/Program, layers, immutability, TCP/UDP/HTTP, preview governor) | C |
| 6 | Additional requirements (8) | section 2(g) |
| 6 | Live data carve-out | P (valid refinement) |
| 6 | Program isolated | C |
| 7 | Data Lab strongest; binding manager, transforms, fallbacks, stale handling, replay, stress | P: B4 and data-sources research cover sources, staleness (plan 19.6, 19.2), recorded feeds; no central binding table by design ("No bindings table", B4 note 1). Stress tests: B4 overflow checks cover text only |
| 7 | AI proposal and approval; roles | C / B11 gap |
| 8 | Ecosystem diagram | D (partly) |
| 8 | Package contents, immutable | C |
| 9 | 12 decisions | C for 8, P for Inspector, workspaces, and Moments/timeline; Scene ID P |
| 9 | Open questions (Prism, protocols, output support) | C, match ours (summary section 4, items 6 and 8) |
| 10 | Positioning: not a simplified AE/XPression | C: plan L63; owner direction "not copy" |
| 11 | Handoff: update terminology consistently | C |

## 10. Check of "wireframe baseline"

The review calls the baseline "wireframes v2" with B1 to B13, P1 to P8, F1 (L11), which matches our 22 screens. The page file in the working tree is uncommitted-modified (`M docs/design/wireframes/grapix-wireframes.html` at session start), so the review may have read a slightly different revision; counts match. Not verifiable which.

## 11. Jev and Laya (`docs/design/review/jev-laya-external-review-2026-11-24.json`)

Model confidences, not versions; second opinions, not verifiers. Laya = laya-multilingual, max_len 8192, not truncated (4,749 input tokens). Laya's confidences are near flat; its "answer confidence" is shown.

| # | Question | Jev | Laya | Agree? | Effect on my verdict |
|---|---|---|---|---|---|
| 1 | Timeline vs Moments | **B** (1.00): full timeline beside Moments, one keyframe set | C 0.39 (B 0.34): undecided | Split | None. Matches my P: both views over one model. Laya's pick (timeline only) is not supported (0.39) and contradicts the owner's Moments decision. |
| 2 | Inspector | **B** 0.70 (0.85 on B) | **A** 0.62 | Split | None. Neither decides it. My evidence: the card already has Look/Motion/Data with More; add a searchable All properties under More. |
| 3 | Menus | B (about ten) 0.82 | B 0.69 | Agree | **Does not change** my P. They were asked A (six) vs B (ten) without the shipped eight menus or the XPression reference. A more discoverable menu set is plausible; the exact ten-menu list is not evidenced. |
| 4 | Workspaces | B (fixed named workspaces) 0.84 | B 0.62 | Agree | **I keep D.** Both chose "fixed named workspaces that designers switch between"; the owner's recorded requirement is that Design, Animation and Data panels are used at once (`jev-laya-ui-decisions` input; summary L100). Named saved layouts (plan 11.94) satisfy "saved arrangement" without restricting tools. The question's option B text ("each a saved panel arrangement") overlapped with that, which probably tilted the answer. |
| 5 | Scene ID | **B** 0.96 | A 0.50 | Split | None on the verdict (P, functionally equal). Jev supports adopting the clearer vocabulary (display ID as label, internal id referenced). Laya is a coin toss. |
| 6 | Live fields | **B** 1.00 | A 0.74 | Split | **I keep C** (already plan 11.54, decision Q4, `liveUpdate` default false). Laya's A (all fields live once verified) contradicts a recorded owner decision and invariant 18's intent. |
| 7 | Logic order | **A** (JS first) 1.00 | B (nodes first) 0.41 | Split | None. Matches C: summary L111, B12. Laya weak. |
| 8 | Schema vs values | A 1.00 | A 0.79 | Agree | None: C. |
| 9 | Take words | A (keep) 1.00 | A 0.95 | Agree | None: C. Supports holding Cue/Cue ID. |
| 10 | Naming principle | B (keep standard, rename signature features) 1.00 | B 0.61 | Agree | **Cuts against both rename sets**, including ours (Stack, Phase, Style). I keep the split rule: keep air-critical terms; rename design terms only where collision-free (section 4.3). The owner's "new words" direction (summary L24) is a product choice the models were not given. |

Agreement: questions 3, 4, 8, 9, 10 (5 of 10). Splits: 1, 2, 5, 6, 7. Where Jev is confident and Laya near 0.5 (1, 5, 7) both are consistent with my verdicts. On 2 and 6 I decided by repository evidence; on 4 the two models agree with each other against the owner's recorded decision, so I disregard them.

## 12. Score of the external review (as a module, /100)

Rubric adapted from `checklist.md` (task fit, hierarchy, consistency, accessibility, states) to a review document:

| Area | Max | Score | Reason |
|---|---|---|---|
| Accuracy about our design and invariants | 20 | 11 | Misreads Moments as replacing the timeline, workspaces as absent, misses that card has More, uses a superseded menu list, diagram contradicts invariants 1, 2, 5, 6. Gets 8 of 12 decisions right or equal to ours |
| Evidence and citations | 15 | 4 | Zero file or line citations; ratings self-declared opinion |
| Internal consistency | 15 | 9 | Section 1 table I-1 to I-9; the rename principle contradicts its own table |
| Coverage of the job (designer and operator) | 20 | 11 | Strong on Playout feature list, timeline parity, AI roles; silent on accessibility, performance, states, keyboard, TAKE/CLEAR safety, frame units |
| Actionability | 15 | 12 | Clear decision table, handoff, priorities; useful phrases (config per field, display vs internal id) |
| Respect for constraints (invariants, plan, owner decisions) | 15 | 8 | Keeps Editor/Playout split and immutability; adds DataHub and render branch, workspace modes and a long rename list against owner direction |
| **Total** | **100** | **55** | Poor (under 60) |


## 13. What I would change in the wireframes

| # | Change | Screen | Tag | Reason |
|---|---|---|---|---|
| 1 | Add a first-class **Timeline** view (a layout preset, not a mode) and state in B3 that a style writes ordinary keyframes; add a rule for re-applying a preset over edited curves (ask, merge or keep custom, never silent) | B3, B2 | **Adopt with change** | Review is right on parity; we already have Fine-tune and the app timeline (11.22). Keeps Moments as the front. |
| 2 | Show the five engine phases: In, Hold, Out, Continue, Update. Keep friendly labels but add Continue and drop "Stays: Soft glow" from the card | B3, B2 card, B9 | **Adopt** (X-1, U-19) | Contract `PhaseKind`; the review's Hold/Update match |
| 3 | Show durations in frames with ms as a derived display | B3 | **Adopt** (not in review) | Invariants 8, 9, 12 |
| 4 | Keep the single card; add under More a searchable All properties list by category; add pin | B2 | **Adopt with change** | Card already has More; avoid seven tabs |
| 5 | Draw the Layout dropdown and saved layouts in the top bar and rename the page text "no workspaces to switch" to "no mode locks a tool" | B2 (bars) | **Adopt with change** | Summary L100; plan 11.96; reject exclusive workspaces |
| 6 | Reconcile menus with the shipped eight (File, Edit, Project, Motion, Panels, Layout, Utilities, Help) or decide on a new set deliberately; do not adopt the 10-menu list; keep Ctrl K | B7, menus section | **Adopt with change** | Owner decision; XPression reference; real app |
| 7 | Remove the unused `MENU_EDITOR` and `ON` constants from the page script | page script | **Adopt** | Source of confusion (X-14) |
| 8 | Parts becomes a tree with visibility, lock, group/parent | B2 | **Adopt** | Contract has visible, locked, parent (inv 74) |
| 9 | Scene tabs, and a second viewport for compare | B2 | **Adopt with change** (later) | Plan 11.64, 11.100; not release-critical |
| 10 | B11 client list by role/credential scope, not by model name | B11, B8 | **Adopt** | Inv 65, 85 |
| 11 | Scene ID text: internal key plus editable label; Take ID unchanged; P3 field rules: operator hides but cannot add fields | B2 card header, B10, P2, P3 | **Adopt** | Same model, clearer wording; answers page decisions 9 and 10 |
| 12 | Reword the TAKE guarantee into three layers: package version, checked initial data, permitted live updates (per-field `liveUpdate`); draw the per-field flag in P3 | P1 note 5, P3 | **Adopt** | Fixes X-9 |
| 13 | Playout: draw an execution-status line (sent, committed frame, refused reason), XML/CSV import and export of the sequence, and an emergency take with armed clear; park groups and mirrored failover | P1, P4, P7 | **Adopt with change** | Items exist in contracts or plan 6.9; emergency must be an explicit action (inv 18) |
| 14 | Names: keep Take, Take ID, Preview, Program; adopt Output Layer; **reject** Motion for Moments, Show Logic, Style for Look, Data Lab for Test; hold Canvas and Airview pending the "must not read as on air" rule; update the diagram text if shared with owner: no DataHub app until invariant 1 is amended | Names table, B5, B12, P7, P8, P5 | **Reject (parts) / Adopt (parts)** | Section 4 |
