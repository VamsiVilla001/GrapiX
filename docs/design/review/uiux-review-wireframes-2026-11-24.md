# GrapiX UI/UX review of the concept wireframes, 24 Nov 2026

- **Target:** `docs/design/wireframes/grapix-wireframes.html` (one page, 18 wireframes in `<section id>`), read against `docs/design/grapix-screens-spec.md`. Concept review, not the running apps.
- **Build:** branch `claude/vibrant-bassi-6cce4b`; no source edited, nothing committed, nothing saved in the repo.
- **Viewport used:** 1300 x 900 emulated, wireframe natural width 1180 x 693 px (`.wf`). 1920 x 1080 is judged by scaling (x1.627), not rendered.
- **Tools run:** built-in browser (`mcp__Claude_Browser__*`) captures of B1-B4, P1, P5 and hand checks via `javascript_tool` (computed contrast, font sizes, clipping, geometry, DOM order) ✓ · `design-review` skill, review mode ✓ · Playwright MCP not run · Chrome DevTools MCP not run · axe-core not run (hand checks only) · Impeccable not run · UI/UX Pro Max not run · Humbleteam Design Review = the `design-review` skill above ✓.
- **Not reviewed and why:** keyboard tab order and screen-reader output (no axe, no AT); web fonts did not load in the pane (document list empty), so Manrope / JetBrains Mono / Anybody metrics are fallback metrics; B5-B11, F1, P2-P4 and P6 were judged from the rendered DOM and source, not from individual screenshots. The wireframes are low fidelity, so styling is not judged, only placement, workflow, hierarchy and safety.

## 1. Summary

The concept is coherent and the Playout side already gets the big safety ideas right (Preview in blue with the word "local only", Program in the take colour with "ON AIR", a non-dismissable free-run band on every Playout screen, no take controls anywhere in the Editor). The three lowest scores are **B9 Formats 59**, **P4 Calling takes 64** and **B6 Publish 65** (F1, a planned idea, is also 65). The single most important fix is **U-01**: P1 puts a "Take this live" button inside the Preview block, which contradicts the page's own rule that only the controls under the on-air monitor act on air; remove it and keep one TAKE.

| Severity | Count |
|---|---|
| S0 Blocker | 0 |
| S1 Critical | 2 |
| S2 Major | 14 |
| S3 Minor | 10 |
| S4 Polish | 2 |

Measured facts used throughout (1180 px wireframe; multiply by 1.627 for 1920):

| Measure | Value |
|---|---|
| `--ink` on `--panel` / `--raised` | 15.40 / 13.94 : 1 (pass) |
| `--ink3` on `--panel` / `--raised` | 5.54 / 5.02 : 1 (pass) |
| `--ink4` on `--bg` / `--panel` / `--raised` | 3.48 / 3.26 / 2.95 : 1 (fail below 4.5) |
| `--ember`, `--info`, `--warn`, `--ok` on `--panel` | 6.75, 6.89, 7.97, 6.72 : 1 (pass) |
| `--danger` on `--raised` | 4.83 : 1 (pass, thin) |
| TAKE label `#1B0C10` on `--take` `#F15A29` | 5.63 : 1 (pass) |
| Text nodes in the 18 wireframes | 1,368; 324 (24 %) are 6 to 8.9 px; 43 use `--ink4` (all `.hint`) |
| Font sizes in `.wf` | 6, 7, 8, 8.5, 9, 9.5, 10 (757 nodes), 11, 12, 13 px |
| `.btns b` height | 19 px (28 px for the TX row), all above the 24 px target only at 1920 (31 / 46 px) |
| P1 TAKE button | 72 x 28 px; Preview and Program screens 292 x 186 px each |
| P1 gap TAKE OUT to CLEAR | 4 px (6.5 px at 1920) |
| `document.compatMode` | `BackCompat` (quirks), `lang` empty, no `meta charset`, no viewport meta, no `<main>` |
| Clipped single-line text | B6 destinations row, B8 Request field |

## 2. Scorecard

Rubric from `docs/design/uiux-review/checklist.md`; design-review = 0-4 band from the `design-review` skill.

| Wireframe | Task fit /20 | Hierarchy /15 | Layout /15 | Consistency /15 | A11y /15 | Type /10 | States /10 | **Total /100** | design-review /4 |
|---|---|---|---|---|---|---|---|---|---|
| B1 Start | 16 | 11 | 11 | 12 | 9 | 6 | 7 | **72** | 3 |
| B2 Make | 14 | 10 | 10 | 11 | 8 | 6 | 7 | **66** | 2 |
| B3 Moments | 16 | 12 | 11 | 12 | 9 | 6 | 7 | **73** | 3 |
| B4 Data | 16 | 12 | 11 | 12 | 9 | 6 | 8 | **74** | 3 |
| B5 Look | 15 | 11 | 11 | 11 | 8 | 6 | 6 | **68** | 2 |
| B6 Publish | 13 | 10 | 11 | 12 | 8 | 6 | 5 | **65** | 2 |
| B7 Search | 15 | 11 | 11 | 12 | 9 | 6 | 6 | **70** | 3 |
| B8 Ask | 14 | 10 | 10 | 11 | 8 | 6 | 7 | **66** | 2 |
| B9 Formats | 11 | 9 | 9 | 11 | 7 | 6 | 6 | **59** | 2 |
| B10 Library | 15 | 11 | 11 | 12 | 9 | 6 | 7 | **71** | 3 |
| B11 Connections | 14 | 11 | 11 | 12 | 9 | 6 | 7 | **70** | 3 |
| F1 Requests (planned) | 12 | 10 | 11 | 11 | 8 | 6 | 7 | **65** | 2 |
| P1 Sequence | 15 | 10 | 11 | 11 | 8 | 7 | 6 | **68** | 2 |
| P2 Scenes and take details | 15 | 11 | 11 | 12 | 8 | 7 | 7 | **71** | 3 |
| P3 Scene data | 16 | 12 | 11 | 12 | 9 | 7 | 7 | **74** | 3 |
| P4 Calling takes | 12 | 10 | 11 | 11 | 8 | 7 | 5 | **64** | 2 |
| P5 Virtual output | 14 | 10 | 10 | 12 | 9 | 7 | 6 | **68** | 2 |
| P6 Monitoring | 15 | 11 | 10 | 12 | 8 | 8 | 8 | **72** | 3 |

Page-level (not a wireframe): accessibility of the page itself 58 / 100 (quirks mode, no `lang`, `role="img"` wireframes, 3.26 : 1 hints). Sub-scores in the page-level row are not rubric-scored.

### Per-wireframe design-review (job, score, issues that apply, fix first)

| Wireframe | Job | Score | Issues (max 6) | Fix first |
|---|---|---|---|---|
| B1 | Pick a type, open a working graphic | 3/4 | U-25, U-16, U-13 | U-25: show which type card is chosen |
| B2 | Build the graphic on one screen | 2/4 | U-10, U-09, U-19, U-16, U-13, U-08 | U-10: card title and selected part disagree |
| B3 | Set motion per moment | 3/4 | U-09, U-19, U-16 | U-09 |
| B4 | Bind fields, prove with the cast | 3/4 | U-09, U-16 | U-09 |
| B5 | Pick colours, fonts, looks | 2/4 | U-26, U-09, U-16 | U-26 |
| B6 | Check and publish per destination | 2/4 | U-12, U-18, U-13, U-09 | U-12 |
| B7 | Ctrl K search | 3/4 | U-27, U-13 | U-27 |
| B8 | AI proposes, designer accepts | 2/4 | U-17, U-18, U-13 | U-17 |
| B9 | Lay out per format | 2/4 | U-11, U-10, U-09 | U-11 |
| B10 | See packages and readers | 3/4 | U-13, U-28, U-18 | U-13 |
| B11 | Show the connections | 3/4 | U-18, U-17 | U-18 |
| F1 | Planned Prism requests | 2/4 | U-18 | mark as planned at the section header, not only in the rail |
| P1 | Build and run the sequence | 2/4 | U-01, U-03, U-04, U-05, U-07, U-23 | U-01 |
| P2 | Scene library and call syntax | 3/4 | U-14, U-08, U-24 | U-14 |
| P3 | All fields in the show | 3/4 | U-24, U-23 | U-24 |
| P4 | Let other systems call takes | 2/4 | U-02, U-24, U-13 | U-02 |
| P5 | Watch Program on the PC | 2/4 | U-06, U-14 | U-06 |
| P6 | Say which device is in trouble | 3/4 | U-24, U-14 | U-14 |

## 3. Issues (ordered by severity, then reach)

Each Before is observable, each After is shippable in under an hour (HTML/CSS in the wireframe page, or a one-line design change), each Why carries one citation. Nothing below changes behaviour that exists in the app: these are wireframe and design changes.

| ID | Sev | Where | Before (finding) | Evidence | Impact | After | Why |
|---|---|---|---|---|---|---|---|
| U-01 | S1 | P1 (and spec) | A button "Take this live" (class `pri`) sits in the Preview block next to Play / Pause / Stop / Loop, while TAKE is a second live-sending button in the row below. P1 note 5 says "Only the controls under the on-air monitor can act on air" and the Preview hint says it has "no connection to what is on air". | `MONS()` in the page script; `#p1 .btns b` measured: "Take this live" 74 x 19 at y 8947, TAKE 72 x 28 at y 9002; two take paths | An operator can send to air from the box labelled "local only"; Preview and Program are no longer cleanly separate | Delete `<b class="pri">Take this live</b>` from the Preview `.btns`; keep Play, Pause, Stop, Loop and add a neutral "Cue to preview"; keep one TAKE. Reword P1 note 5 and the spec line ("Take this live sends...") to "TAKE sends the exact version and data previewed". | Nielsen heuristic #5 - Error prevention: remove the second, mislocated live action |
| U-02 | S1 | P4 "Try it" | The primary (ember) button is "Send" with `TAKE 1003` pre-filled; the safe choice "Send to preview only" is the secondary button. | `test` panel items: `[!Send|Send to preview only]`, `=Send::TAKE 1003` | A test tool defaults to putting take 1003 on air | `[!Send to preview|x Send live...]`; default command `CUE 1003`; the live send is a danger button that needs a second press ("Confirm TAKE 1003 live"). | Nielsen heuristic #5 - Error prevention: the default must be the harmless action |
| U-03 | S2 | P1 | The on-air row (1002) is the quietest row: only a small chip; the cued row (1003) has the full ember tint and 2 px edge. Pencil icons (✎) sit on every Take ID and name, including the on-air take. | `SEQ()`; `.row.sel` applied to index 2; ✎ appended to all six rows | The state that matters most (on air) is least visible; an on-air take looks editable | `.row.air{background:#2A140C;box-shadow:inset 3px 0 0 var(--take)}` on the on-air row, selection neutral (U-04); no ✎ on on-air and played rows, show a lock glyph and the tooltip "locked while on air". | Nielsen heuristic #1 - Visibility of system status |
| U-04 | S2 | P1-P3, all Playout | `--ember` `#F58138` (selection, Take ID text, primary buttons, active tab) and `--take` `#F15A29` (TAKE, ON AIR, Program border) are near-identical oranges. | `:root` tokens; `.row.sel`, `.btns b.pri`, `.bar .ws .mt.on` | On-air orange is diluted by ordinary selection and Take IDs; checklist says brand ember is for on-air only in Playout | Scope: `.wf.po{--ember:#9AA6B8;--ember-tint:#1F2530}` for selection and primary, Take ID `color:var(--ink)`, keep `--take` only for TAKE, ON AIR and the Program frame; add class `po` in `render()` for Playout. | WCAG 2.2 SC 1.4.1 (use of colour): the colour must not be the only cue, and one hue must keep one meaning |
| U-05 | S2 | P1 | TAKE OUT and CLEAR are adjacent red buttons 4 px apart, neither armed. Air actions are split over three groups (TX row under both monitors, buttons under Program, Take-this-live under Preview); TAKE sits centred under the join of Preview and Program. | `#p1 .btns b` gap TAKE OUT to CLEAR 4 px; `TX()` | A mis-click on CLEAR (cuts everything) is one pixel row from TAKE OUT | One transport strip under the Program column: CUE, TAKE, TAKE NEXT, CONTINUE, HOLD, UPDATE; TAKE OUT and CLEAR in their own group with `margin-left:16px`, CLEAR armed by press-and-hold or a confirm chip. | Nielsen heuristic #5 - Error prevention |
| U-06 | S2 | P5 | The detached Program window has the same 1 px `--line2` border and `--panel` title bar as any panel; "Program" appears only as 9.5 px grey text in its title bar. The "Shows" row looks like an editable field. | `#p5 .viewer > div` styles; `.status` 9.5 px | When moved to a second monitor it can be mistaken for Preview or a design view; the page's own claim "never Preview" is not shown on the window itself | `border:2px solid var(--take)`; title bar `background:var(--take);color:#1B0C10;font:700 11px var(--f-ui)` with "PROGRAM"; render "Shows" as plain text, not `.fld`. | Nielsen heuristic #4 - Consistency and standards (Program = take colour everywhere) |
| U-07 | S2 | P1 notes, spec | P1 note 2 says dropping a scene creates a take "with the next free Take ID", and the drop row says "becomes take 1007"; the spec, the Names table and P2 say the operator types the Take ID by hand. | `SEQ(true)` drop row; notes[1]; spec "Take ID" | Two models of one ID; auto numbers can collide with IDs other systems already use | Drop creates the row with the Take ID cell empty and focused ("Type a Take ID"), TAKE and CUE disabled until it is unique; suggest-next as a ghost value only. | Nielsen heuristic #2 - Match between system and the real world (an address the operator owns) |
| U-08 | S2 | B1-B9, spec | Scene ID appears only in B10 (read-only) and in Playout; no Editor wireframe shows or sets it. The spec says it is "set in the scene manager"; P1 note 1 says "set in the scene list" (a Playout panel). | grep of `s-0` in the script: B10, P1, P2 only | Designer never sees the ID that Playout depends on; the page contradicts the spec on where it is set | Add `=Scene ID::s-021` to the B2 card header (or the top status bar next to the graphic name), editable in the Editor only; change P1 note 1 and the Names description to "set in the Editor; read-only in Playout". | Nielsen heuristic #4 - Consistency and standards |
| U-09 | S2 | B2-B9 | `RAIL(step)` ignores its argument, so the rail is byte-identical on every screen: no current step is marked, chips look like status labels not buttons, step 4 Test has no screen of its own. | `RAIL=(step)=>...`; `sameRail:true` for B2 and B4 | The designer cannot tell where they are in Look > Motion > Data > Test > Publish, nor that chips navigate | Use `step`: `.st.cur{box-shadow:0 0 0 1px var(--ink);color:var(--ink)}` plus `aria-current="step"`; make chips `<button>`; map "4 Test" to the Cast strip focus. | Nielsen heuristic #1 - Visibility of system status |
| U-10 | S2 | B2, B3, B7, B8 | Selected part is "Name plate (box)" but the card is titled "Name" and shows text-only fields (Font, Value, Case). B9's card says "Name · 9:16" while the selected row is again Name plate. | `#b2 .row.sel` = "Name plate box"; card tab "Name"; same in `#b9` | The central screen of the design contradicts its own selection | Select the "Name" row in `PARTS` (change `*Name plate::box` / `-Name::...` marker) so card and selection agree, or give the Name plate its own box card (Fill, Size). | Nielsen heuristic #4 - Consistency and standards |
| U-11 | S2 | B9 | The stage tab strip (16:9, 9:16, 1:1) implies one format at a time, but all three render side by side; the 9:16 frame is 82 x 146 px (133 x 238 at 1920). It is not possible to design in. Moments say "Moments · 9:16" without saying whether motion is per format. | `#b9` `view` html; widths 260 / 82 / 146 px | The core task of the screen (adjust one format) has no usable canvas | Tabs choose one format shown at normal stage size; other formats as 60 px thumbnails in a strip under the tab bar; add "Shared across formats: moments" or "Per format: moments" to the card. | Nielsen heuristic #6 - Recognition rather than recall |
| U-12 | S2 | B6 | "Publish to Playout" is the primary and looks enabled while checks show 1 warn and 1 stale (bad). No disabled, refused or success state is drawn though note 3 promises them. One row is clipped (`white-space:nowrap`). | `#b6 .row` clipped: "Claude, ChatGPT and other models can find..." | Dead end at the end of the designer's journey: no way to see what a failed or successful publish looks like | Disable it with its reason ("Data is stale: fix 1"), or relabel "Publish anyway..." with a confirm; add a second state strip: delivered / refused (named) / waiting approval; `.row{white-space:normal}` for that row. | Nielsen heuristic #9 - Help users recognise, diagnose and recover from errors |
| U-13 | S2 | all | Same thing, different words: **Publish** (menu, button) vs **Send** (spec's six menus, B1 "ready to send", B7 "Send to Playout...", B8 "Send to Playout"); **v4** (B10) vs **r4** (Playout) vs "version 4 (draft)"; **graphic** vs **scene**; **Scoreboard** (B1) vs **Scorebug**; button **TAKE OUT** vs command `OUT`; P4 allows "take, out, continue" but not CLEAR or HOLD. The Names table holds 11 terms; none of these. | menu array in `bars()`; `TERMS` | Names are working titles that the page itself says must come from one table; the table is missing the most-used words | Add Publish/Send, Version/Revision, Graphic/Scene, Package, Cue, Take out, Clear, Hold, Program, Preview, Destination, Format to `TERMS`; use one of v / r everywhere; make P4's allow list match the buttons. | Nielsen heuristic #4 - Consistency and standards |
| U-14 | S2 | P1-P6 | `PBAR(tab)` offers four tabs (Sequence, Scene data, Calling takes, Output); P2 highlights "Sequence", P5 and P6 both highlight "Output". The scene list (P2) and Monitoring (P6) have no entry; no signed-out / held-transport state is drawn. | `PBAR('Sequence')` in P2; `PBAR('Output')` in P5 and P6 | An operator cannot navigate to two of six screens from the nav shown | Tabs: Sequence, Scenes, Scene data, Calling, Output, Monitor; P2 uses "Scenes"; add one signed-out variant of the P1 band (`HELD: sign in to enable transport`). | Nielsen heuristic #1 - Visibility of system status |
| U-15 | S2 | page | Quirks mode (`BackCompat`), `<title>` before any doctype, `lang` empty, no `meta charset`, no viewport meta, no `<main>`; nav and header present, no skip link. | `document.compatMode`, `documentElement.lang`, `querySelectorAll('main')` = 0 | Language of page is undefined for AT; box model and sizing differ in quirks mode, so measured layouts are not reliable | Prepend `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`, wrap `.wrap` content in `<main>`. | WCAG 2.2 SC 3.1.1 (language of page) |
| U-16 | S2 | all (43 nodes) | Every `.hint` and secondary text uses `--ink4` at 8.5 to 10 px italic: 3.26 : 1 on `--panel`, 2.95 : 1 on `--raised`. | computed contrast table above | Hints (the explanatory text of each panel) fail the minimum | `:root{--ink4:#8C877F}` (or `.hint{color:var(--ink3)}`); raises it to 5.0 : 1 or better on `--panel`. | WCAG 2.2 SC 1.4.3 (contrast minimum) |
| U-17 | S3 | B8 | The "Request" field is one line and clips; "Accept selected" has no selection affordance (no checkbox on the four proposed rows); the AI panel replaces the selected-part card, and a red "never" row ("Take, cue or clear on air") lists a control the Editor does not have. | `#b8` `=Request::` clipped; items `*`/`-` rows only | Accepting 4 changes at once with no per-row choice contradicts "you decide, part by part" | Textarea (2 lines, `white-space:normal`); leading checkbox per proposed row; replace the red row with one sentence "The Editor has no on-air controls." | Nielsen heuristic #3 - User control and freedom |
| U-18 | S3 | B6, B10, B11, F1 | The planned, not-to-be-built Prism idea occupies a whole column (B11, 1/3 of the screen), a row in B6, a row in B10, and a full wireframe (F1) placed between B11 and B7. | `#b11` grid `1fr 1fr 1fr`; `#f1` | The "now" story is diluted by a non-feature; reviewers assess what does not exist | Keep Prism on F1 only; remove it from B6, B10, B11 (leave a one-line "Prism: planned" footnote); give F1 its own "Idea" section after P6. | Nielsen heuristic #8 - Aesthetic and minimalist design |
| U-19 | S3 | B2 | The selected-part card repeats Motion (Appears, Changes, Leaves with styles) that the Moments strip below shows again; the same problem ("record 17 overflows") is stated in the rail chip, the Cast strip warning, B4 Checks and B6 Checks. "Stays: Soft glow" (a Look) conflicts with B3 "Stays is not animation". | `CARD`; `moments()`; `RAIL()`; `cast()` | More to scan; two components for one job | Remove the Motion block from the card, replace by one row `Motion  4 moments ▸` that focuses the strip; keep one warning surface per screen (Cast strip) and make the rail show counts only. | Nielsen heuristic #8 - Aesthetic and minimalist design |
| U-20 | S3 | page | TOC order differs from page order: the page runs names, map, flows, prism, menus, playout, B1...B11, F1, P1...P6; the TOC runs B1-B5, Workflows, Prism, B6, B9-B11, F1, B7, B8. Look (step 1) comes after Data in B1-B5 and the page opens with an interactive Names table before the idea. | `order` vs `toc` arrays (see Measured) | The designer's story cannot be followed top to bottom | Generate the TOC from the DOM order; order wireframes B1 Start, B2 Make, B5 Look, B3 Moments, B4 Data, B6 Publish, B7, B8, B9, B10, B11; move Names below the idea. | Nielsen heuristic #4 - Consistency and standards |
| U-21 | S3 | page | `.wf` is a fixed 1180 px, not scaled; 10 px text is 16 px at 1920, 33 % larger than the SKWAD 12 px UI; 24 % of text is under 9 px at 1180. The CSS comment says "scaled copy". | `.wf{width:1180px}`; font-size histogram | Density and legibility at real 1920 are not testable; wide 1180 box scrolls on small screens | Add a second render of B2 and P1 at true 1920 x 1080 with SKWAD sizes (12 / 11 / 10 px) and use `zoom:calc(100cqw / 1180px)` on `.wfbox` for scaling. | WCAG 2.2 SC 1.4.4 (resize text) |
| U-22 | S3 | page | All 18 wireframes are `role="img"` with a one-line aria-label; the ~1,370 text nodes inside are not exposed. The numbered notes are the only text alternative and are not linked. | `.wf[role=img]` x 18; `.wf a,button,input` = 0 | Screen-reader users get 18 images and a list of notes | `role="figure"`, `aria-labelledby` the heading, `aria-describedby` the notes `<ol id>`; add `tabindex="0"` to `.wfbox` and `.tablebox` so scroll boxes are keyboard reachable. | WCAG 2.2 SC 1.1.1 (non-text content) |
| U-23 | S3 | P1, P3 | The take with "2 fields empty" (1006) shows no disabled TAKE; P3 says "empty required fields are flagged before the take is allowed" but P1 shows nothing; a linked value (Team, Logo) has no "pending Update" marker. | `SEQ()` row 1006; `TX()` | A refusal condition is described but not drawn | When take 1006 is selected, TAKE shows disabled with "2 fields empty" beneath; add a `.st.warn` "update pending" chip on linked rows whose source changed. | Nielsen heuristic #9 - Help users recognise, diagnose and recover from errors |
| U-24 | S3 | P2, P3, P4, P6 | P3's "Only take 1003" tab duplicates P1's Scene data panel; P3 column "Published" holds shown / hidden (an operator choice, not a designer publication); P4 lists listeners, hosts and tokens (settings) and repeats P2's "Call this take"; P6 chips read "0 · 0" with late and missed explained only in the header. | `#p3` columns; `#p4` `lis` items; `#p6` outs rows | Two places per job | Delete the P3 "Only take 1003" tab; rename column "Shown to operator"; move listeners and hosts into Settings, leaving "Ways in" read-only; chips "late 0 / missed 0". | Nielsen heuristic #8 - Aesthetic and minimalist design |
| U-25 | S3 | B1 | No type card looks selected but "Open Lower third" is the primary; the top bar shows 13 empty tool squares and a "Publish..." button before any graphic is open. | `#b1` cards all alike; `bars()` | Controls are shown before they can work | Selected card gets the selection style; in B1 hide the tool squares and render Publish disabled. | Nielsen heuristic #6 - Recognition rather than recall |
| U-26 | S3 | B5 | Event look lists colours as text ("Ink #F3EDE4") without a swatch; Looks thumbnails are the words "preview thumbnail"; no part is selected on the stage though Looks apply to "Name plate". | `#b5` items | The screen's job (choose colours and finishes) has no visual choice | `<span class="tool" style="background:#F3EDE4">` swatch per colour, 48 x 27 px thumbnail boxes, select the Name plate on the stage. | Apple Human Interface Guidelines - Color: show the colour, not only its name |
| U-27 | S4 | B7 | Search box contains "chev"; results include "Send to Playout...", "Check graphic" and "How to use house motions", which do not match. | `#b7` extra | Mock implies unrelated ranking | Keep only chevron results, or empty the query to show recents. | Nielsen heuristic #4 - Consistency and standards |
| U-28 | S4 | B1, B10, P1, P2 | Mock data disagrees: "Lower third - 3 casters" is v9 in B10 and r2 in P2; "Bumper in" is r2 in B1 and v6 in B10; F1 stage shows a commentator lower third for a highlight. | B1, B10, P2 rows | Reviewers chase false conflicts | Align the sample rows once in a shared `SAMPLE` constant. | Nielsen heuristic #4 - Consistency and standards |

Evidence note: the 18-section structure, the grid areas, `RAIL`, `PBAR`, `MONS`, `TX`, `SEQ` and `render()` are in `docs/design/wireframes/grapix-wireframes.html` (script block, around lines 297-491); screenshots were taken in the built-in browser pane and are not saved.

### Issue count by wireframe (a review cap of six per module is met)

B2: U-10, U-09, U-19, U-16, U-13, U-08. P1: U-01, U-03, U-04, U-05, U-07, U-23. P4: U-02, U-24, U-13, U-16. B9: U-11, U-10, U-09, U-16. B6: U-12, U-18, U-13, U-09. Other screens carry one to three.

## 4. Cross-screen story

**Designer, Start > Make > Moments > Data > Publish.** Follows, with three breaks: (1) no step is marked current (U-09), so the journey has no "you are here"; (2) the page shows Look after Data while the journey is Look first (U-20); (3) it ends at B6 with no result state (U-12), and "4 Test" never gets a screen. Start > Make has no dead end (the primary "Open Lower third" opens B2). Moments > Data is reachable through the rail only if the chips navigate, which the wireframe does not say.

**Operator from P1-P4 alone.** Can add scenes (drag), name takes, type data, preview and take, and wire other systems. Gaps: the scene library (P2) has no entry in the nav (U-14); no signed-out held-transport state; the Take ID rule is ambiguous (U-07); the Take-this-live duplicate (U-01); empty required fields are described but not drawn (U-23). P5 and P6 are fine as extras.

**Scene ID and Take ID.** Scene ID s-021 is shown consistently in B10, P1, P2 and the Names table, but absent from the Editor build screens and described as "set in the scene list" (Playout) rather than the Editor (U-08). Take ID is consistently Playout-only, orange, 1001-1006, typed by hand in P2 and P4, but auto-numbered in P1's drop row (U-07).

**Contradictions with the spec.** (a) Spec: six menus "File, Edit, Graphic, Send, View, Help"; page: "Publish" (U-13). (b) Spec and page both say "Take this live" sends the previewed data, but the page's own note and the invariant that Preview is fully separate forbid a take control in Preview (U-01). (c) Spec: Scene ID set in the scene manager; page: scene list (U-08). (d) Spec says F1 and B10-B11 mention Prism as "planned" and only Playout and MCP exist today; B11, B6 and B10 still draw Prism (U-18). (e) The Editor spec invariant: no take, cue or clear. The Editor wireframes respect it; B8 and B11 spell those words in a deny list only, acceptable but see U-17.

## 5. Unnecessary complexity

| What | Where | Proposal | Saves |
|---|---|---|---|
| Selected-part card shows Look, Motion and Data (13 rows, 3 section labels) while the Moments strip shows the same motion | B2, B3, B7, B8 | Keep the card for Look and Data; Motion becomes one row that focuses the strip | About 4 rows and one duplicate component per screen |
| Journey rail with a "Fix next issue" button and 5 chips on 8 screens, with no current step | B2-B9 | Keep as a slim stepper (status + current), drop the button because the Cast strip already flags and jumps | One primary button per screen (two ember primaries on B2) |
| The same warning stated four times | B2 rail, B2 Cast, B4 Checks, B6 Checks | One surface per screen | 3 repeats |
| Prism, a planned idea, drawn on four screens | B6, B10, B11, F1 | F1 only | A column and two rows |
| Take-this-live plus TAKE | P1 | One TAKE | One live control, one note |
| P3 "Only take 1003" tab | P3 | Delete, P1 panel already does it | One tab |
| Listener, host and token settings | P4 | Move to Settings | One panel |
| "Call this take" syntax | P2 and P4 | Keep the generic list in P4; P2 shows one "Copy command" | One list |
| 13 unlabelled tool squares in the top bar of every Editor screen | B1-B9, F1 | Label four (Select, Move, Text, Pen) or drop in wireframes | Noise |
| Names table first on the page | top of page | Move below "The idea" | One scroll screen |

## 6. Before-and-after plan (approvable batches)

Batch letters are independent.

### Batch A: Playout safety (U-01, U-02, U-03, U-04, U-05, U-07)
| | Before | After |
|---|---|---|
| Design | P1: Take-this-live under Preview; adjacent TAKE OUT / CLEAR; on-air row quiet; ember on selection. P4: live Send is primary. | One TAKE; transport under Program; CLEAR separated and armed; on-air row in take colour; selection neutral (`.po` scope); Take ID typed, not auto; P4 default is Send to preview. |
| Files | `docs/design/wireframes/grapix-wireframes.html` (`MONS`, `TX`, `SEQ`, `PBAR`, `render`, CSS); `docs/design/grapix-screens-spec.md` ("Take this live") | |
| Behaviour kept | Free-run band, Preview blue / Program take colour, Take ID unique and typed, Preview separate from Program, no Editor controls | |
| Re-test | Re-render P1, P2, P4; check contrast of the new selection colour and that no live action exists in the Preview block (`#p1 .scr.cue` siblings) | |

### Batch B: Journey integrity (U-09, U-10, U-11, U-12, U-14)
| | Before | After |
|---|---|---|
| Design | Rail without current step; card vs selection mismatch; three-up formats; Publish without result; P2 and P6 without nav | Rail uses `step`; select the Name row; one format large; publish result strip; Playout tabs (Sequence, Scenes, Scene data, Calling, Output, Monitor) |
| Files | wireframe page (`RAIL`, `PARTS`, `CARD`, `WF` B9 and B6, `PBAR`) | |
| Behaviour kept | Four moments, six menus, Ctrl K, fields on the part | |
| Re-test | Re-render B2, B6, B9, P2, P5, P6 | |

### Batch C: Names and IDs (U-08, U-13, U-28)
| | Before | After |
|---|---|---|
| Design | Publish vs Send, v vs r, graphic vs scene, Scene ID absent in the Editor | One terms table with all names; Scene ID in the B2 card header and B10; shared sample data |
| Files | wireframe page (`TERMS`, labels), spec ("IDs and names") | |
| Behaviour kept | Terms table demo and `localStorage` key | |
| Re-test | Rename each term in the Names table and confirm every screen follows | |

### Batch D: Page accessibility and scale (U-15, U-16, U-20, U-21, U-22)
| | Before | After |
|---|---|---|
| Design | Quirks mode, no lang, hints 3.26 : 1, role=img, TOC order, fixed 1180 | Doctype, lang, `--ink4:#8C877F`, `role=figure` with described notes, generated TOC, scaled wireframes plus a true-1920 render of B2 and P1 |
| Files | wireframe page head, CSS tokens, script | |
| Behaviour kept | Dark-only look, Names table | |
| Re-test | `compatMode === 'CSS1Compat'`, contrast table, keyboard Tab through the page | |

### Batch E: Complexity (U-17, U-18, U-19, U-23, U-24, U-25, U-26, U-27)
| | Before | After |
|---|---|---|
| Design | Prism on four screens, duplicated card / strip, P3 duplicate tab, clipped inputs | See section 5 |
| Files | wireframe page | |
| Behaviour kept | Invariants 4, 5 and 7; MCP read / propose / approval limits | |
| Re-test | Re-render B2, B6, B8, B11, P3, P4 | |

## 7. Approval

> Which items do you approve? Reply with IDs (for example "approve batch A" or "approve U-01, U-02, U-10"). The wireframe page, the spec and every other file stay unchanged until you do.
