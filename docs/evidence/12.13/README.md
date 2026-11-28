# 12.13 and 12.10: the Playout Stacks panel (Figma P7)

Built 25 Nov 2026 by claude-grapix-f1 (the second Claude session; the UI session, task 115, handed this slice over in a
cross-session message and kept Editor/**). Web layer only: no Rust, no contract, no generated file was touched.
The backend it uses (a layer on `cmd_cue`, `cmd_take`, `cmd_phase`, `cmd_clear`, `expected` on `cmd_clear`, the per-layer
`layers` list in the engine status) was built and verified under task 112 (`docs/evidence/12.10`).

## What the page does now

- **A Stack field in Transport.** A whole number from -99,999 to +99,999, plus and minus buttons, ArrowUp and ArrowDown. Blank,
  a fraction, an exponent, a letter and a number out of range are each refused by name, the field is marked and nothing is sent
  (CUE, TAKE, CLEAR, HOLD, CONTINUE, UPDATE and TAKE OUT all read the field afresh). Stack 0 is sent as no layer, so a command for
  the main stack stays readable by an older receiver.
- **A Stacks table** drawn from the engine's `status.layers`, front to back: the scene on each stack with its revision and the
  frame the engine committed it at, its state (ON AIR, LEAVING, QUEUED; a state this build does not know is shown as the engine
  spelled it), and a scene that is leaving with a replacement queued behind it as one row with a second line. The stack in the
  field is added as an empty row when the engine does not report it. An engine that sends no list (the mock) is read as the scene
  on stack 0 from `program`, and the page says "This engine reports Stack 0 only". An entry that cannot be placed is counted and
  said; a second scene on one stack is marked TWO REPORTED. A click on a row selects its stack in the field.
- **Per-row controls.** Continue is a click. Cue out and Clear are held for one second (the design's "hold 1 s"; the fill is the
  hold; a release, a pointer dragged off the button, a lost focus or a disabled control before the second sends nothing; a key held
  down repeats but sends once). A row's Clear names the page the row showed when the hold began (`expected` take and revision), so
  a stack that changed meanwhile is refused by name (`clearExpectationUnmet`) and nothing is cleared.
- **The Transport's CLEAR** on stack 0 is exactly what it was (no layer, no expected page: the emergency clear is not changed). On
  another stack it names the page the table shows for it (Jev, B).
- **The commit readout** says "stack +60" and, when the engine reports a delayed start (`startFrame`), both frames: the command's,
  and where the new scene starts after the old one's Out.
- **The latest command's result** is written in the Stacks panel as well as in Activity, because Activity is below the fold on a
  short window and a refusal has to be read where the operator is looking (12.20).
- **Not built yet, dimmed, naming their rows:** Clear all stacks (12.14), Hide and solo in the Airview (12.17). P7 also draws
  "Clear a range" and "Call by stack"; no plan row has either, so neither is drawn (see Open).

## Decisions: Jev and Laya, asked before the build

`stacks-input.json` and `jev-laya-stacks.json` (six questions), `stacks2-input.json` and `jev-laya-stacks2.json` (three). Jev chose
the option built in every one (confidences 1.0, 0.91, 0.5, 0.98, 1.0, 0.98; then 0.5, 0.73, 0.97). Laya disagreed on several at 0.02 to
0.17 confidence and is a second opinion, never a vote: its dissent is recorded and not followed. The first Jev call failed on DNS
(`ENOTFOUND api.typesafe.ai`) and was repeated once with the same input; the repeat is the answer kept. One choice is mine and was
not asked: the Transport CLEAR on stack 0 stays unchanged, because changing an existing emergency control is not this slice's to do
(Jev's B in round two is applied to the other stacks only). That asymmetry is named here so the owner can overrule it.

## Verification

All run on 25 Nov 2026 in `agent/worktree`; the scripts are in `tools/`, their output in `harness-results.json` and
`real-window-results.json`, screenshots in `screens/`.

1. **Rules, in plain Node:** `node --test Playout/tests/stacks.test.mjs`: 22 tests (reading and writing a stack, the steppers,
   zero sent as no layer, the table from `layers` and from `program`, what cannot be placed, what a row may be asked to do, the page a
   Clear names, the hold with a fake clock including key repeat, and that the new files use none of the retired names).
2. **Rule mutants:** `tools/mutate.mjs` (on a scratch copy of the tree, never the real files): **23 of 23 caught** (-0 normalisation,
   blank, seven digits, zero written +0, steppers wrapping, zero sent as a layer, table order, selected stack not added, unreadable
   not counted, both "doubled" flags, a leaving scene not clearable, an unknown state offering Continue, a wrapped id, key repeat
   starting a second hold, a release not cancelling the timer, an engine with no list read as queued, an unknown state drawn as ON AIR,
   a half-second hold, an untrimmed field, a status with nothing on air read as no status, a missing status read as a status, a hold
   that fires without reaching its fired state).
3. **The real page, with a bridge stub:** `tools/stacks-harness.mjs` + `tools/stub.js` (a headless Chrome of its own, own profile and
   debug port, page-level input only; the stub emulates the shell and the engine's `clearExpectationUnmet`): **50 of 50 checks**. They
   cover: the rows from the engine list, a leaving scene with its queued replacement, the field (typed, invalid, out of range, plus and
   minus, ArrowUp), every Transport button with an invalid stack sending nothing, TAKE, CUE and OUT carrying the layer and stack 0
   carrying none, both frames after a take on an occupied stack, the Transport CLEAR on 0 / on -50 / on an empty +20, holds of 0.4 s
   (nothing) and 1.25 s (one Clear naming the page), a hold surviving the half-second status reads (same element), a scene replaced
   during a hold (refused by name, not cleared), Space held with key repeat (one command), focus lost during a key hold, the pointer
   taken off the button, sign-out disabling every row control, the lost engine clearing the table, and no script or console error.
4. **Page mutants:** `tools/mutate-page.mjs`: **10 of 10 caught**, and one more (releasing on `lostpointercapture` removed: caught by
   the drag-off check). The first run left **three survivors** that were gaps in the harness, not in the page (an invalid stack was
   only tried through TAKE, the operator was never signed out, focus was never moved during a key hold); the checks were added and
   all three are now caught. A `pointermove` handler I added for the drag-off was shown redundant (Chromium already loses the pointer
   capture, which ends the hold) and was removed rather than kept as code that cannot be shown to matter.
5. **The real Tauri window:** `cargo build --locked -p gx-playout-shell --bin gx-playout -p gx-mock-engine --bin gx-mock-engine`
   with its own `CARGO_TARGET_DIR` on D: and a `TAURI_CONFIG` debug port (live-check note 10); `tools/real-window.mjs` starts
   `gx-mock-engine` on 4400 and the shell, drives the page through DevTools (page-level input only, no OS key or click), and ends
   exactly its two PIDs: **20 of 20 checks**. The page is served by the real shell and attaches to the mock on its own; the operator
   signs in through the real shell; a TAKE on stack 0 goes on air and the row shows it from `program`; a TAKE and a CLEAR on +60
   cross the real IPC, shell and transport and come back as **`layerNotSupported (layer=60, request=take)`**, named, with the stack in
   the line; a row Clear held for 1.3 s is accepted by the shell with its `expected` take and revision and the engine commits it,
   and the table reads stack 0 empty again; Cue out held on a row shows the engine's named answer (`timelinePhaseUnknown`, the mock's
   scene has no Out phase). **The first run found a bug the stub could not:** an engine with no list and nothing on air (the mock at
   rest) was read as "no engine status yet". Fixed (`entriesOf`: a status with no list is read from `program`, even when that is
   null), unit-tested and mutant-checked (items 1 and 2), and the window run again.
6. **Gates that cover these files:** `npm run check:boundaries`, `check:protocol` and `check:web-shared` OK; the whole Node suite
   (`node --test "*/tests/**/*.test.mjs" "services/*/tests/**/*.test.mjs" "Shared/*/tests/**/*.test.mjs"`) passes, the terms ratchet
   (`Shared/web-panels/tests/terms.test.mjs`) unchanged (this slice added no retired name to `Playout/web/index.html`).

**Not verified:** (a) the per-stack list from a real engine. The mock sends no `layers`, so the table, the leaving-and-queued row
and the row Clear against `ClearExpectationUnmet` were exercised against the stub only; a real engine with the layer stack
(task 112) and a published scene on two stacks would close it. (b) The whole `npm run check`: the Rust and Editor suites are mid-edit
by other sessions (task 118 contracts and text shaping; the Editor UI work) and were not run here. (c) No commit was made.

## Open

- **Phase commands name no page.** `PhaseRequest` has no expected page (only Clear has, decision Q8): a Cue out or Continue on a row
  that was replaced during the hold reaches the new scene. A contract question for the owner of 12.10.
- **No plan row** for P7's "Clear a range" (+21 to +59) or its "Call by stack" syntax list; the first is not drawn and the second
  belongs to Cue Control (6.7). The owner decides whether a row is wanted.
- **Cue to this stack / Preload from a row** needs the Playline and the Scene Bank, which this page does not have: a scene is still
  typed (Take id, Revision, hash) and goes to the stack in the field.
- **Overlap transitions** (decision C-5) are not drawn: the panel's note says only what the engine does today (the old scene's Out,
  then the new scene, or a cut).
- The page is the transitional engineering surface. The Figma layout (Playline, Stack controls, Airview) replaces it under the
  Playout screen rows; this slice is the first piece that survives that move (`web/screens/stacks.js` has no DOM).
