# GrapiX — Editor UX and Direction Review

| | |
|---|---|
| **Status** | Review and proposal. Not a plan. `GrapiX-Build-Plan.md` stays the only plan and `progress.html` the only tracker; nothing here changes either until the user approves a decision (mission #5, step #49). |
| **Date** | 16 October 2026 |
| **Baseline** | `agent/shared` at `4e0d547`; revised at `97d110c` after Codex's cross-review (Topic #5, message 126). 3.13 is now done (`1e28f7a`). |
| **Author** | Claude (sections Direction, Authoring, Decisions). Codex owns the companion `GrapiX-Broadcast-Playout-Workflow-Review.md`. |
| **Method** | Source inspection of the plan, tracker, ADRs, `memory.md`, `Editor/web/index.html`, `Editor/web/main.ts`, `Editor/src/*` and `Shared/contracts`. **No Tauri session was run for this review**: every UI claim below is *source-inspected*, not executed. |

Status words follow `docs/README.md` (Implemented, Partial, Planned, External gate). Stage classifications use **Implemented / Partial / Missing / Contradiction**.

The reference workflow is the one broadcast CG systems share. The designer **creates** a scene, **animates** it, **declares the fields** an operator may fill, **previews** it and **publishes** it. The operator then **fills**, **previews**, **cues**, **takes**, **updates or continues**, and **takes out/clears** it, and the system **recovers** from failure. This document covers the designer half and the product direction. The operator half is Codex's document.

---

## Direction

The 15 October direction (`GrapiX-Build-Plan.md:21-46`) is clear: After Effects-style composition authoring, Scene Manager holding independent graphics, XPression/Viz-style playout, and no design-system workflow. Several rows, headers and dependencies still encode the 9 September plan. Each item below gives the evidence and one recommendation: **Amend** the row, **Cut** the dependency, or **Ask** the user.

### D1. The plan header still says "Proposed, 9 September 2026"
- **Evidence:** `GrapiX-Build-Plan.md:10-11` (`Status: Proposed`, `Date: 9 September 2026`); `:3-6` ("Interface work is deferred to Phases 11 and 12"). The 15 October direction sits below it at `:21-46`. About 60 Phase 11 rows are already `done` or `active` in `progress.json`.
- **Recommendation — Amend:** set Status to *In execution*, add "Direction last amended 15 October 2026", and replace the opening paragraph with one sentence stating the product (AE-style authoring + Scene Manager + XPression/Viz-style playout + engine-owned time).

### D2. Phase 9 is a hard gate that the project has not followed
- **Evidence:** `:323` "Must land before Phase 11 begins"; `:713-714` "Starting Phase 11 first means rebuilding it". `progress.json`: P.3 `active`, 9.1–9.7 pending. Yet `11.5` "Layout follows the card sort" (`:357`, needs 9.7) is **done**, though no card sort (9.4) exists. The actual layout source is 11.63's EffectCraft/AE reference (`:416`, done).
- **Why it matters:** governance hard rule 5 (dependencies gate the start) is contradicted by a `done` row. The done-when of 11.5 is not met as written, and LLM-GOVERNANCE treats that as the one failure that matters.
- **Recommendation — Ask:** either (a) supersede Phase 9 as a gate. Re-scope 9.x as *post-hoc validation* of the AE/XPression references: operator interviews (9.3) and timed tasks (9.5) stay valuable, but the card sort (9.4) and the three divergent concepts (9.6) do not. Amend 11.5's done-when to "Layout follows the 11.63 reference; validated by 9.5 timed tasks". Or (b) keep Phase 9 as a gate and reopen 11.5. Recommended: **(a)**.

### D3. Design-system dependencies still gate live rows
The 15 October amendment (`:40-46`) makes design systems historical compatibility, but these rows still *require* it:

| Row | Evidence | Recommendation |
|---|---|---|
| `11.28` Named text styles | `:381` needs **11.14**; done-when "styles resolve design-system tokens rather than duplicating their values" | **Cut** 11.14 from Needs and amend the done-when to "styles are named project presets"; it is already `done`, so record the amendment without changing state |
| `11.40` Token bindings and component registry | `:393` needs **10.4, 11.14** | **Cut** 10.4/11.14. Keep the *component registry with typed slots* (broadcast-relevant: scorebug, lower third) and drop token ingest. Rename to "Component registry and project variables" |
| `11.30` Save model | `:383` "a published design-system version (10.4) is still never edited in place" | **Amend:** delete the clause |
| `17.2` Design system as constraints | `:635` needs **10.4** | **Ask:** cut the row, or re-point it to 11.40's project variables |
| `18.7` Figma variables to tokens | `:666` needs **10.2**; "land as 10.x tokens" | **Amend:** land as 11.40 project variables, keeping provenance |
| `1.6` Motion presets | `:90` needs **1.5** (design-token schema) | **Cut** the edge in the text (1.6 is done; motion presets stand alone) |
| `7.5`, `7.6`, `8.7`, `11.14`, `11.16` | `:293`, `:294` ("design-system version stamped"), `:309`, `:366`, `:368` | **Amend** each to "historical; not required for authoring or publish". `playout-mcp` `BuildArgs.design_system_version` (`services/playout-mcp/src/lib.rs:164`) stays optional and is never required |

### D4. Three different things are called "Scene manager"
- **Evidence:** `11.43` "Scene manager on the command model; explicit save only" (`:396`, pending); `11.64` "Scene Manager: one container, multiple independent graphics" (`:417`, done); `12.2` (Playout) "Scene manager with Take IDs" (`:545`, pending).
- **Recommendation — Amend:** rename 11.43 to "Project settings, explicit save and single-file `.gpx` packaging". It keeps its scene-settings, explicit-save and packaging criteria (Codex correction, Topic #5 #117). Rename 12.2 to "Playout library: published graphics by Take ID". Keep "Scene Manager" for 11.64 only.

### D5. Save model: 11.43 removes the autosave that `done` row 2.6 promises
- **Evidence:** `2.6` "Project store: JSON, backups, autosave ring" (`:112`, **done**); `11.43` "**No autosave:** 2.6's autosave ring is removed … 2.6's row text is updated when this lands" (`:396`); `11.30` adds Ctrl+S / Ctrl+Shift+S versioning (`:383`, pending). Today the File menu has "Save graphic file…" only (`Editor/web/index.html:30`).
- **Why it matters:** AE autosaves to a separate folder and never overwrites the project; XPression saves explicitly. "No autosave at all" loses work on a crash, and "autosave into the project" breaks explicit-save semantics.
- **Recommendation — Ask, with a recommended answer:** keep explicit save as the only writer of the project, and keep 2.6's ring as **crash-recovery snapshots in a separate recovery folder**, offered on next launch and never written into the project. Amend 11.43 accordingly. 2.6 then stays true and needs no downgrade (hard rule 4).

### D6. "ADR-0003" names two different documents, and ADR-0001 has a third scheme
- **Evidence:** `docs/adr/0003-effectcraft-render-core.md` (accepted, render core; cited at `:137`, `:148`); `19.1` "ADR-0003: Data Server boundaries" (`:687`); `docs/adr/0001-distributed-architecture.md:198` "## ADR-003: Contract-first parallel development" (a section inside ADR-0001), also cited by `README.md:89` and `docs/README.md:7`.
- **Recommendation — Amend:** 19.1 becomes **ADR-0004: Data Server boundaries**. Refer to sections inside 0001 as "ADR-0001 §3" in README and docs/README.

### D7. 11.32 "Menu bar and toolbar, XPression style" against the 11.63 After Effects workspace
- **Evidence:** `:385` (pending) specifies XPression-style menus; `:416` 11.63 (done) is the AE/EffectCraft workspace, and the live File/Edit/Layer/Window menus follow AE (`Editor/web/index.html:26-42`). The 15 October direction assigns AE to authoring and XPression/Viz to playout (`:21-26`).
- **Recommendation — Amend:** retitle to "Menu bar and toolbar (After Effects conventions)". Keep its command list, which is tool-neutral, and add AE's **Composition** and **Layer** menus. XPression conventions move to Phase 12.

### D8. The Editor owns a "Take page", but taking is Playout's authority
- **Evidence:** `11.27` "Take-page authoring: fill and save a template instance" (`:380`, done); Editor panel "Take page" (`Editor/web/index.html:224-249`). README: Playout is "the only client that may Cue, Take, Continue, Clear" (`README.md:16`). In XPression the operator fills template links in the Sequencer's take items, and in Viz Trio the operator fills pages built from the scene's Control Objects. Both are *playout-side* surfaces.
- **Recommendation — Amend + Ask:** rename the Editor panel "Test fill" (a designer's preview of declared fields) and keep 11.27's mechanics. Add a Playout row (Codex's document) for the operator fill form generated from 11.26/11.54 fields. **Ask** whether saved "pages" live with the Playout rundown (recommended) or the Editor project.

### D9. README says nothing renders
- **Evidence:** `README.md:5-9` "There is no renderer, no application shell and no output. **Nothing in this repository has produced a frame.**" The pixel gate renders reference scenes (`tools/pixel-gate`), the Tauri Editor ships (11.63/11.64 done), and Program frames are produced by the worker.
- **Recommendation — Amend** (no user decision needed): rewrite the status block to the current Implemented/Partial picture and point to `progress.html`.

### D10. A creatable kind always refuses at publish (light)
- **Evidence:** `Shared/contracts/src/authoring.rs:44-46` makes `light` creatable. Its own comment at `:38-43` says kinds that would refuse "are refused here instead". Since `1e28f7a`, a light refuses at publish (`LightHasNoResponsiveMaterial`) unless a mesh binds a PBR material, and meshes refuse as 11.48. So every created light is unpublishable today.
- **Not included — camera:** an inactive Camera object is inert and accepted. Only the `activeCameraId` mapping refuses (11.48). Camera creation is therefore not a contradiction (Codex correction, Topic #5 #117/#126).
- **Recommendation — Amend (code, small; tracked under 11.48):** remove `light` from `CREATABLE_KINDS` until 11.48 can light a mesh, or keep it creatable and show the refusal reason at creation time. Whether an inactive camera should be offered before 11.48 is a separate design choice, not a refusal fix.

---

## Authoring

Walk of the designer path in the current Editor, compared with After Effects (authoring depth) and the authoring side of XPression and Viz Artist (broadcast template building). Every claim is **source-inspected**; nothing below was run in Tauri for this review.

### A0. Terminology — Contradiction
- **Evidence:** File menu "New scene…" creates a *container* (`index.html:27`, `main.ts:3444-3457`). "New graphic…" creates a `SceneDocument`. The viewer is titled "Composition" (`index.html:100`). The Publish button says "Publish scene" but publishes one graphic (`index.html:321`). The identity field says "Graphic id" (`index.html:52`). Contracts call the graphic a `SceneDocument` and its publish target a Take. Playout 12.2 says "Scene manager".
- **Comparison:** AE: Project → Compositions → Layers. XPression: Project → Scenes → objects; the operator sees Take Items. Viz: Scene → Containers; the operator sees Pages.
- **Proposal — amendment to 11.64 and 11.18:** one glossary used by UI, MCP and docs. The *model* is settled by the user (one container with independent graphics, AE-style composition authoring), but the *words* are not, so naming is put to the user as a decision. Candidate: **Scene Manager** holds a **Project** (the container, the `.aep` analogue) → **Graphic** (a `SceneDocument`) → **Layer**. The viewer is either "Composition" (AE's word) or "Graphic". The operator side uses **Take** (a published graphic revision), **Page** (a filled instance) and **Playout library** (the published catalogue). Under that candidate: "New scene" → "New project" and "Publish scene" → "Publish graphic". **Done when** a test asserts every visible label, MCP tool description and agent-surface node uses only glossary terms (grep-based lint over `index.html`, `agent-surface.ts` and the MCP tool list).

### A1. Create — Partial
- **Implemented:** rect, ellipse, text, line, group, layer from the Layer menu and toolbar (`index.html:36-41`, `:70-73`; `authoring.rs:44-46`). Objects panel with add/duplicate/rename/delete; type-aware Properties; fonts, text styles, materials and assets panels.
- **Missing versus AE/XPression/Viz:** pen/shape paths and masks (11.47, pending, `:400`), image layers (refused as 3.17), precompose/nesting (no row), alignment/distribution, rulers and **title/action-safe guides** (11.44 pending, `:397`; the areas are standardised by SMPTE ST 2046-1, see Sources), and duplicating a graphic as a variant.
- **Proposals:**
  1. **Raise 11.44's safe guides ahead of gizmos** (split the row). *Done when:* the viewer shows toggleable action-safe (93%) and title-safe (90%) guides concentric with the graphic's frame, as SMPTE ST 2046-1 defines them, persisted per user, verified by a Tauri screenshot at 1080p and 2160p.
  2. **Proposed new row (new capability, not a gap in an existing done-when) — Precompose / nested graphic.** AE's core reuse mechanism, and XPression scene groups / Viz merged objects serve the same role. *Done when:* selecting layers and choosing Layer → Precompose creates a child graphic and replaces the selection with one instance layer. Editing the child updates every instance. Instance properties exposed as overrides (AE "Essential Properties") render through the engine, and undo restores both graphics as one entry.

### A2. Animate — Partial (strongest area)
- **Implemented:** inline Properties with diamonds, previous/next, Auto-Key, keying at the playhead (11.21 done; `memory.md` 15 Oct). Dope-sheet timeline with selection-driven tracks, speed graph and easing (11.22/11.23 active). Named phases `in/hold/out/continue/update` (11.25 done), the broadcast equivalent of Viz stop points and XPression scene directors / transition logic.
- **Partial:** stop points and looping hold (11.53 pending); text animators (11.61), effects and layer styles (11.60–11.62) wait on GPU steps 3.19/3.22.
- **Proposal — amend 11.53:** *Done when* includes "a hold phase plays in the Editor preview exactly as Playout will continue it: a Continue at frame *n* of a looping hold resumes at the next phase, shown by an engine render (11.41) of frames before and after". Because that evidence uses 11.41, either add **11.41 to 11.53's Needs** (today 11.22, 11.25, 11.36, 11.38; plan `:406`) or verify the behaviour through the Playout mock instead (Codex, Topic #5 #138).

### A3. Declare operator fields — Partial
- **Implemented:** "Template controls" panel declares typed fields (Text, Number, Color, Boolean, Asset; `Shared/contracts/src/control.rs:20-26`) targeting object properties (11.26 done).
- **Already present:** each `ControlField` carries `fieldId`, `label`, `objectId`, `property`, `kind` and an optional `default` (`Shared/contracts/src/control.rs:63-75`). The existing `default` is the initial and fallback value.
- **Missing:** constraints (range, enum, max length, required; 11.54 pending, `:407`), field grouping/order and help text for the operator form, and a per-field "live-updatable while on air" flag (needed for Update; see Decision Q4). XPression's template links and Viz's Control Objects carry exactly this operator-facing metadata.
- **Proposal — amend 11.54:** add `group`, `order`, `help`, `required` and `liveUpdate: bool` to each field (label and default already exist). *Done when:* the Playout fill form (Codex row) renders groups in order with help text; a required empty field blocks Take by name; a `liveUpdate: false` field is read-only while the graphic is on Program; all round-trip Rust/TS. `liveUpdate` only marks a field *eligible* for Update. It grants no authority: changing Program still needs an operator-scoped Playout command and engine-time intent (invariants 8 and 65; Codex, #117).

### A4. Preview — Partial (the main WYSIWYG risk)
- **Evidence:** the authoring viewer and Scene Manager thumbnails use Three.js (11.6). A "Not drawn by this preview" panel lists what it cannot draw (`index.html:306-313`). Engine-rendered preview 11.57 is pending, and the browser is reduced to overlays only in 13.5 (`:562`, pending). Viewport-equals-Program 13.6 is pending. The 3.15 note records that the Three.js viewport's colour space is unmeasured (`GrapiX-Build-Plan.md:185-190`).
- **Comparison:** XPression and Viz Artist render the authoring viewport with the same engine that plays out, so a designer approves real pixels.
- **Dependency state (`progress.json` at `97d110c`):** **11.41 is ready now**: its Needs 11.38, 3.13 and 5.6 are all `done`. **11.57 is not ready**: 7.6, 8.10 and 11.38 are done, but it still needs **11.41** (pending) and **11.53** (pending, itself waiting on 11.22, active). 13.5 (browser draws overlays only) and 13.6 (viewport byte-equals Program) are separate later gates. Local media transport 5.4 is done; remote media is Phase 14.
- **Proposal — Ask:** start **11.41** next, and take 11.57's *preview monitor* half as soon as 11.41 lands, ahead of 11.31–11.35. Its publish half stays gated on 11.53. *Done when (proposed target, needs Tauri verification):* the Preview panel shows an engine-rendered frame at the playhead for the active graphic within 250 ms of an edit, labelled "Engine", and the Three.js view is labelled "Draft". Parity is not claimed until 13.6.

### A5. Publish handoff — Partial
- **Implemented:** "Publish scene" creates an immutable, content-hashed revision and reports Take ID, revision and hash. It refuses unsaved work by name (`main.ts:3601-3625`, `:3744-3775`; 11.38 done).
- **Contradiction:** the Publish panel exposes a raw **"Asset plane" endpoint** text field (`index.html:317-320`): transport plumbing in a designer surface. At publish the engine runs the shared validator but stops at the **first** refusal, and the Editor receives it as a shell error carrying the refusal code (`ShellError.cause`, `Editor/web/main.ts:204-213`) and prose detail. It gets **no field path and no list** (Codex, #138). So there is no **preflight list before publish**: the designer learns of refusals one at a time, by attempting to publish.
- **Proposals:**
  1. Move the endpoint to Preferences → Connections (or 11.33's Window → Connections). *Done when:* no transport address appears in the default workspace and a missing connection refuses publish by name.
  2. **Amend 11.57:** a pre-publish checklist. **Prerequisite (not yet present):** the Editor host has no pre-publish preflight command today. The shared validator runs at publish, and `ValidatePreflight` is an MCP handler that takes `MaterialSupport` from its caller (Codex correction, #126). The row must first add a host command that returns the shared `StructuredRefusal` list, using the support the connected peer declared. The checklist then lists every refusal with object, path and fix, and clicking one selects the object and focuses the property. *Done when:* against the current engine declaration (`MaterialSupport::none()`), a graphic with a gradient rect fill and a painted group shows `UnsupportedPathGradient` and `ScenePropertyNotDrawable` before Publish, with the same codes and paths the engine returns at publish, and Publish stays disabled until both are cleared.
  3. **Package contents:** state in 11.57's done-when what a published revision carries: graphic, declared fields, fonts and assets by hash, phases. Playout must render the fill form from the package alone, without the Editor project.

### A6. Panel organisation and workspace — Partial
- **Evidence:** right column stacks Scene Manager, Objects, Properties, Fonts, Text styles, Materials, Assets, Take page, Animation, Data bindings, Template controls and Publish. Most are collapsed by default (`main.ts:3213`). The Window menu is generated from them. Layout reset exists; saved layouts and workspace modes (11.33–11.35) are pending.
- **Comparison:** AE separates Project, Composition, Timeline, Effect Controls and Essential Graphics into tabbed docks with named workspaces (Standard, Animation, Essential Graphics).
- **Proposal — amend 11.35:** fix the initial modes to **Design** (Objects, Properties, Assets, Fonts), **Animate** (Timeline expanded, Properties, Speed graph) and **Template** (Template controls, Data bindings, Test fill, Publish checklist). *Done when:* each mode is one command and survives restart. Proposed acceptance target, to be verified in Tauri: no mode needs scrolling to reach its panels at 1440×900.

### A7. Scene Manager / multi-graphic — Implemented (11.64)
- **Implemented:** one saved container, independent graphics with own selection, playhead and undo; search; per-graphic thumbnails labelled partial where needed.
- **Already present:** per-graphic status including saved/unsaved and "Published r*N*" (`Editor/src/scene-manager.ts:23-27`, required by 11.64).
- **Already present — duplicate:** a graphic-level Duplicate action (`Editor/src/scene-manager.ts:37`, `Editor/web/main.ts:3566-3584`) copies the graphic under a new id and name and clears its published revision (`services/editor/src/command.rs:586-608`). That is the variant workflow; the earlier proposal for it is withdrawn (Codex, #138).
- **Remaining gap:** thumbnails are Three.js drafts. That belongs to A4 (11.41/11.57), not to 11.64.

### Stage summary

| Stage | Classification | Main gap | Owning rows |
|---|---|---|---|
| Terminology | Contradiction | scene/graphic/composition mixed | 11.18, 11.64, 12.2 |
| Create | Partial | paths/masks, safe guides, precompose | 11.44, 11.47, new |
| Animate | Partial | stop points, text animators, effects | 11.53, 11.60–11.62 |
| Declare fields | Partial | constraints and operator metadata | 11.54 |
| Preview | Partial | no engine-rendered preview | 11.41, 11.57, 13.5, 13.6 |
| Publish | Partial | no pre-publish checklist; endpoint in UI | 11.57 |
| Workspace | Partial | modes and saved layouts | 11.33–11.35 |
| Scene Manager | Implemented | engine thumbnails (A4) | 11.64 |

---

## Decisions

Joint recommendations from Claude and Codex (Panchayati topics #5 and #7), merged from this document's Asks (C1–C7) and the Playout review's decision inputs (P1–P7, `GrapiX-Broadcast-Playout-Workflow-Review.md`). **The user decides every row.** A recommendation is not a decision, and nothing in the plan or tracker changes until the user answers (step #49). Rows are ordered by how much each answer unblocks.

| Q | Question | Options | Joint recommendation | Affected steps | Done when (if the recommendation is approved) | Evidence |
|---|---|---|---|---|---|---|
| **Q1** | Is Phase 9 (UI research) still a gate before Phase 11? | **A.** Supersede the gate: 9.x becomes post-hoc validation (keep 9.3 operator interviews and 9.5 timed tasks; drop 9.4 card sort and 9.6 concepts), and 11.5's done-when is explicitly amended, not declared met. **B.** Keep the gate and reopen 11.5. | **A** | 9.1–9.7, P.3, 11.5; plan "Why the order" text | The plan states Phase 9 as validation with no Needs edge into Phase 11; 11.5 reads "follows the 11.63 reference; validated by 9.5"; `progress.json` unchanged for every row | D2; plan `:323`, `:357`, `:713-714` |
| **Q2** | Should the engine-rendered preview come before the remaining Editor polish? | **A.** Start 11.41 now (ready: 11.38, 3.13, 5.6 done); take 11.57's preview monitor next, ahead of 11.31–11.35; label the views "Engine" and "Draft". **B.** Keep tracker order. | **A** | 11.41, 11.57, 11.31–11.35, 13.5, 13.6 | The plan notes the priority; 11.57 is split into preview-monitor and publish halves, with the publish half still needing 11.53 | A4; plan `:394`, `:410`; `progress.json` |
| **Q3** | Which save model? | **A.** Explicit save is the only project writer; 2.6's ring becomes crash-recovery snapshots in a separate folder, offered at next launch. **B.** No autosave at all (as 11.43 says; amends done row 2.6). **C.** Autosave into the project. | **A** | 2.6, 11.30, 11.43 | 11.43's text says "recovery snapshots, never written into the project"; 2.6 stays done with unchanged meaning (hard rule 4); 11.30's design-system clause removed | D5; plan `:112`, `:383`, `:396` |
| **Q4** | What may an operator change on air with Update, and what does Continue do? | **A.** Any declared field. **B.** Only fields whose published `liveUpdate` flag is true; **default false**; Continue advances the current revision's named stop point and never reloads. **C.** No on-air field updates. | **B** (eligibility only; authority still comes from operator scope plus engine-frame intent, invariants 8 and 65) | 11.26, 11.53, 11.54, 12.4, 19.8 | 11.54 carries `liveUpdate` (default false) and Update rejects an ineligible field by name with pixels unchanged; 11.53/12.4 define Continue; continuous clocks and scores wait for the Phase 19 data contract | A3 (`:96-99`); Playout review P1 |
| **Q5** | Where do the operator fill form and filled pages live? | **A.** In Playout: rundown entries pinned to revision, hash and field-schema version; the Editor keeps a "Test fill" preview only. **B.** In the Editor project. | **A** | 11.27 (rename and amend), new 12.8 (operator fill form and pages), 12.3 | 11.27 renamed "Test fill" and its done-when amended so saved pages are not an Editor artefact; new pending row 12.8 added with the Playout review's done-when, building the form from package contents alone (A5.3); the library lists published revisions, and once 13.7 applies only approved ones may be cued; the E2E row becomes 12.9 | D8; Playout review P2; `README.md:16` |
| **Q6** | Which words does the product use? | Container/graphic/viewer: **A.** Project → Graphic → Layer, viewer "Composition". **B.** Project → Composition → Layer. Operator side, both options: Take, Page, **Playout library**. Engine side, both options: output channel/layer (never "Layer"). | **A** | 11.18, 11.64, 11.43, 12.2 and all UI labels | A glossary is added to `docs/README.md`; 12.2 is renamed "Playout library"; a later label-lint row checks UI and MCP text against it | A0; D4; Playout review P3 |
| **Q7** | What happens to 17.2 "Design system as constraints"? | **A.** Cut it. **B.** Re-point it to 11.40's project variables. | **B** | 17.2, 11.40 | 17.2 needs 11.40, not 10.4; 11.40 is renamed "Component registry and project variables" with Needs 10.4/11.14 removed | D3; plan `:635`, `:393` |
| **Q8** | What is in the first broadcast release? | **Target segment:** sports/esports first, or newsroom (MOS/NRCS) included. No target market has been recorded yet, so this is the user's choice, not an assumption. Then per item, now or defer: **independent overlay layers on one Program channel** (e.g. bug + lower third); **mirrored-engine failover**; **multiple output channels**; **panels, XPN/AMCP, switcher automation**; **as-run record**. | If sports/esports first: keep **overlay layers with channel/layer targeting on one Program channel in scope**, adding the target fields to Cue/Take/Update/Clear now and refusing other channels by name. **Defer** MOS, failover, multiple channels and panels/protocols/switcher. **Recommended now:** an as-run record type on the existing JSON Lines audit sink (2.10), with UI/export later; operator identity comes from 2.9. | Phase 12, 1.9 intent contract, 2.9, 2.10, 13.7, 14.6, 15.x, 19.x | Deferred items are recorded as named out-of-scope notes with no new rows; pending rows are added for overlay-layer targeting and the as-run record; the target-field refusal test exists | Playout review P4–P7 and its Integration scope; plan `:115-116`, `:277-278`, `:384`, `:564` |

**Agreed by both agents; no user call needed** (the user may still override any of them):
- D1: plan header → "In execution", direction dated 15 October 2026.
- D3, apart from 17.2: cut the design-system Needs from 11.28, 11.40 and 1.6 (text only); amend 18.7 to land as 11.40 project variables; mark 7.5, 7.6's stamp, 8.7, 11.14 and 11.16 as historical compatibility.
- D4: 11.43 → "Project settings, explicit save and single-file `.gpx` packaging"; 12.2 → "Playout library: published graphics by Take ID" (also P3).
- D6: 19.1's ADR becomes ADR-0004; ADR-0001's internal sections are cited as "ADR-0001 §3".
- D7: After Effects conventions govern the Editor, XPression/Viz conventions govern Playout; 11.32 retitled.
- D9: rewrite the README status block from current evidence.
- D10: remove `light` from creatable kinds until 11.48 (camera unchanged).
- Playout review ID fix: operator fill form = 12.8; E2E lower-third acceptance = 12.9 (Needs 12.8).

---

## Sources

- Adobe, *After Effects User Guide*: [Precomposing, nesting, and pre-rendering](https://helpx.adobe.com/after-effects/using/precomposing-nesting-pre-rendering.html); [Essential Properties](https://helpx.adobe.com/after-effects/using/master-properties.html). Accessed 16 October 2026.
- Vizrt, *Viz Artist User Guide*: [Control Object](https://documentation.vizrt.com/viz-artist-guide/3.14/Control_Object.html), [Directors](https://docs.vizrt.com/viz-artist-guide/5.2/Directors.html), [Control Stoppoint](https://docs.vizrt.com/viz-artist-guide/3.12/Control_Stoppoint.html); *Viz Trio User Guide*: [Adding Stop Tags](https://docs.vizrt.com/viz-trio-guide/3.2/Adding_Stop_Tags.html). Accessed 16 October 2026.
- SMPTE, [ST 2046-1:2009 *Safe Areas for 16:9 Television Systems*](https://pub.smpte.org/doc/st2046-1/20091123-pub/st2046-1-2009.pdf): Safe Action Area 93% and Safe Title Area 90% of the production aperture, concentric; see also [RP 2046-2:2009](https://pub.smpte.org/latest/rp2046-2/rp2046-2-2009.pdf). Accessed 16 October 2026.
- Ross Video, [XPression U training](https://www.rossvideo.com/products/graphics-and-virtual/xpression-u/) (template links / object publishing, Scene Director and Transition Logic, Sequencer take items), and the [University of Texas XPression tutorial index](https://cloud.wikis.utexas.edu:443/wiki/spaces/comm/pages/33425422/Ross+XPression+-+CG+Real+Time+Graphics+Tutorials). Accessed 16 October 2026. These are training materials, not a versioned manual; the XPression claims here describe workflow, not measured behaviour.
