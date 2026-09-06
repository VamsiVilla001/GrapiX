# AE Runtime Container — Phase Plan

> Execution breakdown of [`direct-aep-import-plan.md`](direct-aep-import-plan.md) (*After Effects Runtime
> Container and Live Broadcast Control Plan*, §§1–42). Seven tracks in eight milestones. Each phase
> states what it changes, what it must not change, how it is proven, and what it unblocks.
>
> Effort is **working days for one engineer** and it is a shape, not a commitment. Where a phase
> touches a paired TypeScript/Rust contract, the estimate covers both sides — they land in one commit
> or not at all (memory rule 7).
>
> **Status, 2026-08-18.** Plan authored 2026-08-11 as a council phase plan. Landed since: `L0`
> (conditional go), `AE-A0`, `AE-A1`, `AE-A2`, `AE-CD0`, `AE-CD1`, `AE-F0`, `AE-F1`, `PL1` (complete —
> composition-clock gap closed) and `CB0` (definition of done met; two gate strings inherited by `CB1`).
>
> Partial, each with an exact remainder rather than a vague one:
> - `AE-A3` — the declared surface is complete as **nine project/property operations plus `HEALTH`
>   and `SHUTDOWN`, and two events**, and project lifecycle is closed by cutover: in-process
>   `OPEN_PROJECT`/`CLOSE_PROJECT` are removed at protocol major 2, the supervisor replaces the
>   process instead, and the licensed host proved a project change across two PIDs with After
>   Effects' own `AEGP_GetProjectPath` as the evidence. The fingerprint capability table (`AE-A4`),
>   `controlled-dom` and footage replacement (`AE-CD3`) keep the phase open.
> - `AE-CD2` — the rollback **sequence** is measured by an independent harness; the live injected trigger
>   on the licensed host is all that is owed.
> - `AE-F2a`/`AE-F2b` — ingress, the twelve named refusals, the non-local topology refusal and the
>   clock's request point are implemented, and the live gate passed: one real After Effects frame
>   reached a `RecordingSink` byte-identically. `AE-F2b` then made the lead a bounded **depth**, added
>   the asymmetric pressure/lateness policy, revision supersession and the `aeProgram` counter surface.
>   Both are scripted-verified and the pipeline is verified against the real clock; no live After
>   Effects run has yet exercised the deep lead, which is `AE-F3`'s soak.
> - `BO0a` — three of four controls proven, the rest behind external gates.
>
> Each landed phase carries its status and evidence on its own card; a phase without one is not started.
> **Not started:** `CB1`–`CB5`, `AE-A4`, `AE-CD3`, `AE-CD4`, `PL2`–`PL4`, and every `BO` phase beyond
> the `BO0a` subsets. No output or certification track exists. `AE-F3` is not started, but the throughput
> work its gate needed is done, measured, bounded and **adopted**: the frame path went from **21.3 fps
> (0.71× of 29.97)** to **83.98 fps (2.80× of 29.97, 1.40× of 59.94)** at 1920×1080, over a new
> `RENDER_FRAME` protocol operation, with the swept 45 ms / 16-op idle budget now the compiled default
> (adapter `a24f2b1b…`, re-certified behaviour-neutral). The ceiling is the render itself — **~11.3 ms per
> frame, ~88 fps** — so 59.94 cannot be tuned past ~1.48×. Its gate remains blocked by
> `PL3`/`PL4`/`AE-CD3`/`AE-CD4`, an unprovisioned licensed plugin, and now a drifted `LOWER_THIRD` fixture
> whose baseline reference no longer matches — see its card.

---

## 1. Council decision on the ordering

**No-go for the plan's own §36 P0→P9 sequence.** It spends P1–P8 building and operating an unattended
After Effects runtime and defers the legal/licensing review to P9, which reverses an irreversible
dependency. It also distributes §37's "first POC" across P1–P5, P8 and P9, so the POC either cannot be
first or it bypasses its own gates.

**Conditional go** for the revised ordering below:

1. answer the licensing question **before** engineering effort;
2. run the two existential proofs — resident supervised AE control, and non-capture RGBA with a
   settled alpha contract — as early, time-boxed, killable spikes;
3. only then build manifests, verbs, operator surfaces, outputs, cache and certification.

Two words are used precisely. **Publishable/on-air admissible** describes a container GrapiX will let
Playout cue and take; Program, Take and output authority stay with Playout and the render engine, never
Editor. **Preview** means the container's own inspected/preview state, never AE UI operation.

---

## 2. Seats and verdicts

| Seat | Verdict |
| --- | --- |
| Adapter (§6, §26, §31, §32) | The existing bridge cannot be promoted. `aeBridge.ts` launches `afterfx.exe -r`, runs one staged JSX, and waits for AE to exit. A resident adapter is a new native component and its viability is unproven. |
| Frame bridge (§13–§14, §24) | The vendored SDK does contain a frame-checkout route and a working sample, but nothing in this repository has executed it. Alpha ownership must be settled before transport exists. |
| Container/control/data (§5, §7–§10, §18–§21) | Reuse the existing GrapiX data/binding grammar; declare controls explicitly with GrapiX-stable ids; never bind by layer name. |
| Playout (§11–§12, §23, §25, §30) | Cues come only from a declared marker namespace, mapped through exact rational time. Playout keeps sole ownership of every verb. |
| Output/certification (§15, §33–§35) | Route AE frames through the one existing output owner. NDI is feature-gated and self-reports uncertified; DeckLink and AJA are declared and unavailable. Nothing is certified without a recorded transmission. |
| Cutover/boundary (§16–§17, §27–§29, §40–§41) | Remove the false direct-import fidelity claims first, then move code into `runtime/`, `ae-plugin/`, `static-inspector/`, `output/`. Delete the invented AEPX parser rather than relocate it. |
| Adversarial chair | Licensing first; two-part viability POC second; split the oversized phases; replace six subjective gates; acquire vendor/host inputs before the phases that depend on them. |

### Council round 2 — 2026-08-17: what is next

Convened after `PL1` closed, with all seven seats reading the corrected status above. **Verdict: finish
`AE-A3` next (5 seats of 7), and run `CB0` beside it rather than after it (6 seats of 7).** The Adapter
and Cutover seats ranked `CB0` first; every other seat ranked it second while insisting it not be
deferred. Nobody ranked `PL2` first despite it being fully unblocked, on the grounds that its 7–10 days
would be spent designing a control plane before `AE-F2` reveals the completion, revision and deadline
facts it must expose.

| Seat | Next | Beside it |
| --- | --- | --- |
| Adapter | `CB0` (bounded preemption), then `AE-A3` | — |
| Frame bridge | `AE-A3`, then `AE-F2` | `PL2`, `CB0` |
| Container/control/data | `AE-A3` | `CB0`; then `AE-CD3`+`AE-CD4` concurrently |
| Playout | `AE-A3` | `PL2` only with a separate owner |
| Output/certification | `AE-A3` | `CB0`, `PL2`; order long-lead hardware now |
| Cutover/boundary | `CB0`, then `AE-A3` | — |
| Adversarial chair | `AE-A3` completion only | `CB0`; then a **split** `AE-F2a` |

**Four constraints the round produced, which change how the work is done:**

1. **`OPEN_PROJECT` must not become another idle-hook dispatch case.** `AE-A0` finding F2 recorded that
   `AEGP_OpenProjectFromPath` called from the idle hook returned `A_Err_NONE`, opened the project, and
   then no idle callback ever fired again (`memory.md` F2). Pipe requests are still dispatched
   synchronously from that same idle hook, so adding the lifecycle operations naively wedges the
   runtime. Project lifecycle needs its own execution route, and channel silence must be a state the
   supervisor detects. **Resolved 2026-08-18 by removing the operations, not routing them:** the
   execution route is a supervisor-owned process restart (`AE-A3`'s cutover note), so there is no
   idle-hook lifecycle dispatch left to wedge.
2. **`AE-CD2`'s named gap is a real blocker, not a missing test.** Its rollback path has never been
   *triggered* live, and `AE-CD2` gates both `AE-F2` and `PL3`. The gap's own stated remedy is "a second
   writable kind from `AE-A3`'s wider matrix" — so finishing `AE-A3` is also what makes closing
   `AE-CD2` possible. Sequence them together.
3. **`AE-F2` should be split before it starts.** `ProgramClock` currently sleeps to a target's deadline
   and only then renders, so it has no earlier request point at all. `AE-F2a` proves one live
   checkout → ring → Program frame; `AE-F2b` adds lead-time scheduling, late/missed/backpressure policy
   and counters. `RENDER_READY`/`RENDER_FAILED` must carry correlation (request id, session id,
   composition item id, exact composition-scale time, revision, frame id, deadline) and must stay
   events, never replies sharing a `messageId` (memory rule 24).
4. **Long-lead acquisition starts now, in parallel with everything.** The approved licensed third-party
   plugin (BO0a criterion 15), the NDI runtime plus a confirmed second receiver host, and a DeckLink
   card with driver, SDK, two SDI paths, reference/genlock and a booked mixer/keyer window. `AJA` is not
   a substitute; it is expressly unavailable.

**Plan defects the round found in the plan itself.** `AE-CD0` declares **Blocked by CB0**, yet `AE-CD0`
is recorded as landed while the entire `CB` track was never started — the dependency was bypassed, not
satisfied, so `CB0`'s inventory owes `AE-CD0` a retrospective pass. Separately, `AE-A1`, `AE-A2`,
`AE-CD0` and `AE-CD1` are counted as landed but carry **no status card**, which contradicts this
document's own rule that "a phase without one is not started"; their evidence currently lives only in
`memory.md`. Both are documentation faults to repair, not licence to re-open the phases.

---

## 3. Ground truth this plan builds on

Verified in this repository today:

- `vendor/adobe/sdk/ae25.6_61.64bit.AfterEffectsSDK/` and `vendor/adobe/AfterEffectsSDK_25.6_61_win/`
  are present. `Examples/Headers/AE_GeneralPlug.h` declares `AEGP_RenderAndCheckoutFrame`,
  `AEGP_GetReceiptWorld`, `AEGP_CheckinFrame`, `AEGP_RenderAndCheckoutLayerFrame_Async`,
  `AEGP_RegisterIdleHook`, `AEGP_RegisterDeathHook`, `AEGP_GetUniqueStreamID`, and
  `AEGP_SetStreamValue` — the last carrying the comment *"only legal to call when
  AEGP_GetStreamNumKFs==0 or NO_DATA"*. `Examples/AEGP/Grabba/Grabba.cpp` renders a frame, takes its
  world, and checks the receipt back in; `HistoGrid_UI_Handler.cpp` does the same. The header also
  marks the synchronous call on the UI thread as deprecated behaviour.
- **Pinned toolchain, decided 2026-08-17.** Host **After Effects 2026 (26.3)**, SDK
  **25.6_61** (`vendor/adobe/sdk/ae25.6_61.64bit.AfterEffectsSDK`), compiler **MSVC 14.44**. The SDK is
  deliberately one minor behind the host because **no 26.x SDK is published on the Adobe developer
  portal yet**; this is a recorded choice, not an accident, and L0's "pinned SDK toolchain" requirement
  is satisfied by this triple. It is the exact combination `AE-A0` built and ran, and `adapter.cpp`
  compiles clean against it. AEGP is version-tolerant across this gap, but the pairing is a
  **re-validation trigger**: when a 26.x SDK ships, re-run `AE-A0` and `AE-F0` before adopting it, and
  treat any struct or suite-version difference as a contract change rather than a drop-in upgrade.
- The only AE control path in the product is one-shot:
  `Editor/services/adobe-mcp-gateway/src/aeBridge.ts` (`findAfterEffects`, `exportProjectManifest`,
  space-free staging) plus `jsx/grapix-ae-export.jsx`, a read-only project walk.
- Supervision precedents: `Playout/services/playout-control/src/engineSupervisor.ts`,
  `Playout/apps/desktop-tauri/src-tauri/src/supervisor.rs`,
  `Editor/apps/desktop-tauri/src-tauri/src/supervisor.rs`.
- Engine seams: `services/render-engine/src/{transport.rs,ipc.rs,program.rs,preview.rs,outputs.rs,recovery.rs,capabilities.rs}`.
  `ipc.rs` is a same-user pipe with 4-byte big-endian length + UTF-8 JSON. `preview.rs` already has
  `PreviewView::{Fill,Key}`. `program.rs` schedules absolute deadlines and drops late ticks.
- Output reality: NDI exists only under `--features ndi` with a 3–4 slab `NdiFramePool`;
  `decklink`/`aja` construct `UnavailableLiveSink`; `hardware_certified` is deliberately false.
  `services/render-daemon/src/config.rs` accepts only `ColorFormat::Bgra8`, premultiplied alpha and
  sRGB, and rejects straight alpha (`StraightAlphaUnsupported`) and interlace (`InterlacedUnsupported`).
- Authorization: project API authenticates every non-public route but its AE import routes never call
  `requirePermission`; `Shared/auth-contract/src/types.ts` gives `editor` `scene.write`/`asset.write`
  and withholds `scene.write` from `playout-operator`.
- Certification harnesses live in `tools/certification/` with `docs/hardware-certification-template.md`.

Not verified by anything in this repository: that a resident adapter loads, that the checkout route
runs on a licensed host, that any output device has transmitted, or that the licence permits driving AE
as an unattended broadcast renderer.

---

## 4. Milestone map

| Milestone | Phases | Theme | External prerequisite | Effort |
| --- | --- | --- | --- | --- |
| **M0** | L0 | **Licensing kill gate** | signed legal determination; third-party plugin terms | 3–5 d + external wait |
| **M1** | CB0 · CB1 · CB2 | Truthful vocabulary, module boundaries, static inspector | none | 12–19 d |
| **M2** | AE-A0 → AE-F0 | **Existential proofs** (killable spikes, serial) | licensed pinned AE build; pinned SDK toolchain; Windows host; independently exported reference frames | 12–18 d |
| **M3** | AE-A1 · AE-A2 · AE-A3 · AE-F1 | Restricted runtime: IPC, supervisor, control surface, frame ring | same host, retained | 28–43 d |
| **M4** | AE-CD0 · AE-CD1 · AE-CD2 · AE-A4 · PL1 · PL2 | Container, declared controls, revisions, control certification, cue map, control plane | real fixture projects | 38–56 d |
| **M5** | AE-F2 · PL3 · PL4 · AE-CD3 · AE-CD4 · BO0a · BO1 · AE-F3 · BO2 | **The §37/§38 POC in full**, ending at the 30-minute NDI alpha gate | POC fixture, fonts, one approved plugin, NDI runtime + second LAN host | 58–86 d |
| **M6** | CB3 · CB4 · CB5 | Install/licensing diagnostics, measured classes, dependency-signature cache | reference host | 14–21 d |
| **M7** | BO0b · BO3 · BO4 · BO5 · L1 | Full corpus, SDI Fill+Key, classification, certification truth source, release closure | DeckLink card/SDK/driver, mixer/keyer, reference source | 31–47 d |

**Implementation total 196–295 engineer-days**, which is exactly the sum of the phase cards in §§6–12,
plus **15–29 hands-on certification days** and external waiting for licensing, hardware and lab access.
No reserve is hidden in the roll-up: if a phase needs more, its own card gets the days.

That is materially larger than the coarse §36 sketch would suggest. The difference is not padding: it
is the security boundary, the certification truth layer, the repository cutover and the honest
per-device evidence that §36's ten bullet lists compress into single lines.

### Dependency graph

```text
L0 ── licensing kill gate ────────────────────────────────────────────────────────────┐
 │                                                                                    │ (blocks release)
 ├─► CB0 ─► CB1 ─► CB2            (cutover, boundaries, static inspector)             │
 │                                                                                    │
 ├─► AE-A0 ─► AE-F0 ──► AE-A1 ─► AE-A2 ─► AE-A3 ─► AE-A4 ────────────┐                │
 │   (serial: F0 needs A0's host-callback model)   │                  │                │
 │        └────────────────► AE-F1 ◄───────────────┘                  │                │
 │                            │                                       │                │
 │   AE-CD0 ─► AE-CD1 ─► AE-CD2 ─┬─► BO0a ──┐                          │                │
 │   AE-CD0 ─► PL1 ─► PL2 ───────┤          ▼                          ▼                │
 │                               └──────► AE-F2 ─┬─► BO1 ─┐        PL3 ─┤                │
 │                                               │        ├─► PL4 ─► AE-F3 ─► BO2 ─┐    │
 │                                               └────────┘                        │    │
 │   AE-CD3 · AE-CD4 ──────────────────────────────────────────────────────────────┤    │
 │                                                        POC acceptance join ─────┘    │
 │                                                                                 │    │
 │   CB3 ─► CB4 ─► CB5 ─┐                                                          │    │
 │   BO0b ──────────────┼─► BO4 ─┐                                                 │    │
 └──────────────────────┴─► BO3 ─┴─► BO5 ◄─────────────────────────────────────────┴──► L1
```

Edges worth stating in words, because the box drawing flattens them:

- `AE-A0 → AE-F0` is **serial**, not parallel: the checkout experiment needs A0's proven host-callback
  and thread model. Only a shared minimal-host bootstrap could split them, and none is planned.
- `AE-F1` is blocked by **both** `AE-F0` and `AE-A1`; once `AE-A1` lands it runs beside `AE-A2`–`AE-A4`.
- `BO0a` is blocked by `AE-A2`, `AE-A3`, `AE-CD1`, `AE-CD2` and `AE-F0`, because its runner starts the
  managed runtime and applies declared controls through the production path. It then feeds `AE-F2`, `BO1`
  and `BO2`. `BO0b` feeds `BO4` and `BO5`.
- `AE-F2 → BO1`, and `PL3` plus `BO1` both feed `PL4`. `BO1` therefore runs beside `PL3`, not beside `PL4`.
- **POC acceptance is a join, not a single phase:** the §38 criteria are satisfied only by `BO2` together
  with `AE-CD3` (media replacement) and `AE-CD4` (expression-control and dependency preflight). `PL3`
  does not depend on either — its own card does not list them and must not be read as if it did.
- `CB4 → CB5 → BO4` is an order, not a set.
- `BO2` and `BO3` do **not** gate `BO4`: classification runs on virtual/recording output. The three join
  at `BO5`, which needs all of `BO0b`, `BO2`, `BO3`, `BO4` and `AE-A4`.
- `AE-A4 → PL3` and `AE-A4 → BO5`. Nothing downstream of `BO5` unblocks `AE-A4`; placing it after `BO5`
  would be a cycle.

**AE-F2 and every release claim need both existential proofs**, and neither can be skipped by declaring
the other sufficient.

### Critical path

```text
L0 → AE-A0 → AE-F0 → AE-A1 → AE-A2 → AE-A3 → AE-A4 → AE-CD1 → AE-CD2 → BO0a → AE-F2 → max(PL3, BO1) → PL4 → AE-F3 → BO2 → max(BO3, BO4) → BO5 → L1
```

`AE-F1` runs beside `AE-A2`–`AE-A4`; `AE-CD3`/`AE-CD4` run beside `PL3`/`PL4` and join `BO2` at POC
acceptance; `BO0b` must land before `BO4`/`BO5`.

`CB0`–`CB2`, `AE-CD0` and `PL1` sit off the critical path and should be run beside it — they are cheap,
they need no licence and no hardware, and `CB0` removes false product claims that are currently shipping.

### Concurrency

- **Immediately after L0:** the cutover track (`CB0`→`CB2`) runs beside the existential spikes, as does
  fixture *authoring* for `BO0a` (its capture step waits for `AE-F0`).
- **After AE-A0:** `AE-A1`'s protocol and codec work overlaps native packaging; `AE-CD0` and `PL1` need
  no SDK at all.
- **After AE-A3:** `AE-CD1`/`AE-CD2`, `PL1`/`PL2` and `AE-A4` proceed while `AE-F1` builds the data plane.
- **Inside M5:** `BO1` runs beside `PL3`; `AE-CD3` and `AE-CD4` run beside `PL3`/`PL4` and are POC
  acceptance prerequisites, which is why they are no longer deferred past the POC.
- **After the POC:** `BO3` (SDI) runs in the lab while `CB3`–`CB5`, `BO0b` and `BO4` run on the reference
  host. `BO3` must not block `BO4`.
- **Deliberately not parallel:** extra property classes, broad plugin claims, static/dynamic splitting
  and complex rundown behaviour all wait for the M5 POC.

### Cheap risk reducers to pull forward

1. Acquire and fingerprint the environment — licensed pinned AE build, matching SDK, approved plugin,
   dedicated Windows host — before M2, not during it.
2. Build the alpha fixture and comparison harness in `BO0a`: opaque, zero-alpha, hard edge, antialiased
   edge, 50% gradient, coloured translucent shadow, premultiplied-black edge — with independently
   exported AE references, not references captured through the path under test.
3. Write the persistent-control harness (open/discover/mutate/close, including deliberate AE death)
   during `AE-A0` so its result is a record, not an anecdote.
4. Check NDI receiver availability early — an `outputs.rs` code path is not readiness.
5. Order the SDI card and book the mixer during M3, so vendor lead time never becomes the critical path.

---

## 5. Kill gates

| Gate | Point | Decision if it fails |
| --- | --- | --- |
| **K0 — licence** | L0, before any engineering | Stop or rescope. Do not build an unattended AE runtime whose deployment may not be permitted. |
| **K1 — resident control** | AE-A0 exit | Stop the runtime-container path. Do not answer it by polling `afterfx -r`, exposing remote JSX/eval, or treating a panel as an unattended controller. |
| **K2 — non-capture RGBA** | AE-F0 exit | Stop before AE-F1/AE-F2. Screen, window or Composition-panel capture, and raw frames over JSON/WebSocket, are not substitutes. |
| **K3 — identity** | AE-A3 exit | If control identity cannot survive rename/duplicate/restart without name guessing, do not ship name-based rebinding. |
| **K4 — atomic revisions** | AE-CD2 exit | If a batch cannot be acknowledged as one revision, do not claim revisioned updates and do not integrate frames or Playout. |
| **K5 — classification/hardware** | BO2/BO3/BO4 | Rescope the affected template to cache-required or pre-render-only, or narrow the supported profile. Never release an unmeasured template as deterministic live output. |

---

## 6. Track L — licensing and product permission

### L0 · Licensing and deployment permission

**Effort** 3–5 d of work plus external wait · **Blocked by** nothing · **Unblocks** everything

**Intent.** Get a written answer to the one question that can make all downstream engineering
worthless, before that engineering starts.

**Status, 2026-08-11: CLOSED for V1.** The determination is recorded in §9 of
[`ae-runtime-licensing-decision-request.md`](ae-runtime-licensing-decision-request.md): **conditional go**
for development, testing and internal operation on the owner's own licensed After Effects installation —
the slice Adobe Developer Terms §4.1(A)(1) grants in terms — with V5 refused, V4 deferred, and V2/V3
conditional on their own seat and a named interactive user. Seven conditions bind engineering from now
(§9.2): named-user interactive session, no SDK material in the repository or any package, no copyleft in
the adapter binary, no model training on AE output, no Adobe mark in a customer-facing name, no external
distribution before L1, and audit-ready records. External distribution (Q2/Q3), V4, and product naming
(Q6) stay blocked at **L1**, where K0 still applies. **AE-A0 and AE-F0 may start.**

**Work**

- Obtain a **signed legal/compliance determination** — not an internal engineering note — identifying the
  governing Adobe licence and SDK distribution terms, naming an authorized approver, and describing the
  exact unattended deployment being asked about: a GrapiX-launched or attached licensed AE instance
  driven by a GrapiX AEGP adapter, rendering frames for broadcast output on an operator workstation.
- It must answer all four: is that deployment permitted; may a GrapiX adapter built against the SDK be
  shipped; which SDK components may and may not be redistributed; and what applies to third-party
  plugins when GrapiX drives the host. Where counsel says vendor confirmation is required, obtain it.
- Record the exact AE licence/entitlement class assumed and whether a render-engine-style installation
  is in scope.
- Write the outcome into the plan as a dated **go / conditional-go / no-go** decision with its
  conditions enumerated.

**Must not change.** GrapiX never packages, redistributes, spoofs or licenses After Effects or any
third-party plugin, whatever the answer is.

**Exit gate.** A **signed** legal/compliance determination — carrying its approver's name and authority,
the governing Adobe licence and SDK distribution terms it relies on, and the exact deployment it
describes — answering all four questions, with a dated go / conditional-go / no-go recorded against it and
every qualification named. An unsigned memo, a summary of a conversation, or an engineering opinion does
not satisfy this gate.

**Definition of done.** A reviewer can point at the sentence that permits — or forbids — the runtime
mode, rather than an assumption.

### L1 · Release closure

**Effort** 3–5 d · **Blocked by** BO5, AE-A4 · **Unblocks** release

**Work.** Final commercial/legal review against the *as-built* system: deployment shape, adapter
distribution, plugin handling, wording of the supported matrix, and the AE-installation requirement in
user-facing copy.

**Exit gate.** Sign-off references the exact published matrix from BO5 and the certification records
behind it; any excluded configuration is named.

---

## 7. Track CB — cutover, boundary, static inspector

### CB0 · Truthful mode vocabulary and cutover inventory

**Effort** 3–5 d · **Blocked by** L0 (decision only) · **Unblocks** CB1, CB2, CB3, every AE surface

**Intent.** Stop shipping the claim that a parser imports an AE project with usable fidelity, and
establish two non-interchangeable modes: **AE Runtime Mode** (the installed AE renders) and **GrapiX
Native Mode** (the wgpu renderer, explicit conversion, compatibility-reported).

**Work**

- Rewrite the AE rows in `docs/README.md` and the project-import sections of `docs/adobe-integration.md`
  as historical/static-inspection plus the planned runtime boundary; add the §27 renderer sentence.
- Replace `memory.md`'s direct-import status lines and the 2026-08-11 council resolution that required
  deleting every bridge path — keeping the evidence lessons (rules 152–155, 167–170) and reclassifying
  the reader as **AEP Static Inspector**.
- **Hide the AE authoring command rather than rename it into a promise.** Remove the
  Import-After-Effects entry point from `MenuBar.tsx` and retire `ImportAfterEffectsDialog.tsx`'s
  import flow; static inspection remains reachable and truthful. A "Create AE Runtime Container…"
  command appears only behind a runtime-capability flag once AE-CD0 and AE-A2 exist (CB3 owns its
  admission diagnostic). Replace `importAeProjectOnApi` and its `source: "native" | "bridge"` switch in
  `lib/apiClient.ts`.
- Delete the false dialog copy at `ImportAfterEffectsDialog.tsx:129-170`, the inert pixel-exact
  preference, the automatic-rollback promise, and any claim that browser `.aep` upload works today.
  **This retires the false claim only**; a real upload/attachment surface arrives with the runtime.
- Check in the migration inventory as assertions owned by the UI/API tests, not as prose.

**Must not change.** Do not describe the unbuilt adapter, frame bridge, NDI, SDI or certification as
implemented. Editor gains no Take/Program authority.

**Exit gate.** Scoped grep returns zero occurrences of `AEP native (default`, `AEPX direct`,
`aepx-direct`, `Import After Effects Project`, `source: "native" | "bridge"`,
`/api/import/after-effects/aepx`, `/api/import/after-effects/project`; the two mode statements appear in
all three documents. A UI test asserts that **no AE container-creation command is reachable** at this
phase, and the same test flips to asserting its presence only once the CB3 admission diagnostic and
AE-CD0/AE-A2 exist.

**Gate scope, clarified 2026-08-17.** The grep excludes historical plan text, fixtures, **and
`memory.md`'s preserved evidence lessons** (rules 152–155, 167–170). Rule 155 contains the literal
string `AEPX direct` while recording *why* that path was deleted, and this phase's own Work list
requires keeping those lessons. The gate exists to remove claims **a user can read**; an internal
engineering lesson naming a retired path is the opposite of a false claim, and deleting it to satisfy a
grep would destroy the evidence that stopped the path being rebuilt. Excluded by preservation, recorded
here rather than silently.

**Definition of done.** Every AE claim a user can read maps to something that exists.

**Status, 2026-08-17: the definition of done is met; two gate strings pass to CB1.** The
Import-After-Effects command is gone from `MenuBar.tsx`, the dialog's import flow is retired, and the
path-based `/api/import/after-effects/project` route, `importAeProjectOnApi` and its
`source: "native" | "bridge"` switch are removed. `POST /api/import/after-effects` survives as the AEP
Static Inspector and now reports, for an `.aep`, that it "performs static inspection only; it makes no
renderability, fidelity, or scene-conversion determination". The two mode statements are established in
the three documents, and the migration inventory is checked in as a UI assertion that no AE
container-creation command is reachable — written to flip once CB3 and AE-CD0/AE-A2 exist.

**The inert preference is gone end to end.** `preferEditability` was accepted by the dialog, the API
client, the project-api route and `aeImportService`, threaded into `sceneConverter`'s signature — and
read by nothing, which `memory.md` had already recorded as a finding while the UI still promised that
turning it off "favours visual accuracy, baking more layers to rendered fallbacks". A parameter nothing
reads is worse than no parameter: it is removed at every layer, not relabelled.

**Scoped gate result.** Zero occurrences across `editor-web`, `project-api`, `Shared/*/src`, `README.md`,
`Editor/README.md`, `docs/README.md` and `docs/adobe-integration.md`. The literal strings `AEPX direct`
and `aepx-direct` **do** still appear in `Shared/adobe-common-schema/src/ae/aepxParser.ts` and the
`AeManifest.producer` union in `Shared/shared-types/src/index.ts`. Those are internal code, not a claim a
user can read, and they are precisely what **CB1**'s own exit gate removes ("grep finds no public
`aep-native`/`parseAepxToManifest`/`aepx-direct`") by deleting the invented AEPX parser rather than
relocating it. Recorded as CB1's inheritance rather than reported as a clean zero.

**Two test faults the removal exposed, both fixed.** `ae-native-route.test.mjs` was green against a
**stale `dist/`** and only failed once `project-api` was rebuilt — it drove the retired route, so it is
retargeted at the retained inspector and now asserts what matters: an `.aep` is refused for conversion,
reports inspection-only, and **creates no scene and no asset directory** (which is also CB1's exit gate).
`importers.test.mjs` asserted the old `/cannot execute|forbidden/` wording and now pins the truthful
message plus empty `convertedItems`/`importedItems`.

### CB1 · Module boundaries

**Effort** 5–8 d · **Blocked by** CB0 · **Unblocks** CB2, CB3

**Work.** Perform the §41 moves against real paths: `runtime/` (supervisor, IPC, control manifest, data
binding, playout, frame bridge, diagnostics), `ae-plugin/` (runtime adapter, frame provider, project
control), `static-inspector/` (`rifx`, `cos`, `aepParser`, evidence), `output/` unchanged as the single
output owner. Keep the legacy one-shot exporter as `static-export.ts`; keep `sceneConverter.ts` behind an
explicit Native Mode research boundary. Mechanical Rust output moves preserve protocol behaviour
byte-for-byte.

**Must not change.** `services/render-engine/src/output/` remains the only production output owner; no
Editor service or AE adapter opens an output; no TypeScript/Rust protocol change is split across commits.

**Exit gate.** Grep returns zero old import specifiers for `@grapix/adobe-mcp-gateway/ae-bridge`,
`src/aeBridge`, and `src/ae/{rifx,cos,aepParser,sceneConverter,aepxParser}`; each has exactly one new
owner. A boundary check proves `ae-plugin/` cannot import engine output internals and the Editor runtime
service cannot acquire a Take/output capability.

### CB2 · AEP Static Inspector

**Effort** 4–6 d · **Blocked by** CB0, CB1 · **Unblocks** safe indexing, Native Mode research

**Work.** Rename `parseAepToManifest` to an inspection API returning digest, proven metadata, warnings,
evidence level and parser limits; rename producer `aep-native` → `aep-static-inspector`. Retain the
bounded RIFX behaviour, field provenance, the three AE-authored fixtures and the synthetic
keyframe/mask tests with their weaker-evidence labels. Remove the two scene-creating import routes and
their `runAeImport()` calls; expose at most a permission-checked inspection endpoint that states
*"static inspection — not a renderability or fidelity determination."* **Delete** `aepxParser.ts`, its
fixture, its test and its route, and drop `fast-xml-parser` if nothing else uses it.

**Must not change.** Do not delete parser fixtures or RIFX bounds behaviour merely because they no
longer feed a runtime; do not revive AEPX by extending the invented grammar.

**Exit gate.** The moved corpus passes unchanged; an inspection call creates no scene, asset directory
or Program request; grep finds no public `aep-native`/`parseAepxToManifest`/`aepx-direct`.

### CB3 · Installation, licensing and mode diagnostics

**Effort** 4–6 d · **Blocked by** CB0, CB1, AE-A2, AE-A4 · **Unblocks** container admission

**Work.** Return an environment diagnostic before container creation: selected `afterfx.exe` identity,
AE build, host OS, adapter/runtime identity, project digest, dependency state, support/certification
status. Status vocabulary distinguishes `not-installed`, `unsupported-build`,
`license/activation-unavailable`, `adapter-unavailable`, `dependency-mismatch`,
`uncertified-environment`, `healthy-but-not-certified` — never a single `AE_NOT_AVAILABLE`. Reuse the
existing `%ProgramFiles%\Adobe\Adobe After Effects *` / `GRAPIX_AE_EXECUTABLE` discovery as a candidate
mechanism only.

**Exit gate.** Overridden executable, supported install, absent install and deliberately unsupported
profile each produce a distinct stable code plus the exact selected build; container creation is refused
without a supported healthy environment.

### CB4 · Measured runtime classification

**Effort** 4–6 d · **Blocked by** AE-F2, PL1, PL2, CB3 · **Unblocks** CB5, PL3 readiness, BO4

**Work.** Record `targetRate`, p50/p95/p99/max render ms, dropped frames, cache-hit rate and exactly the
§16 ratings `realtime | realtime-with-cache | preload-required | offline-only`, each stamped with
measurement window, environment identity, project digest and container id. Timings come from AE-F2
ingress against the PL1 rational deadline — never from a UI repaint or a legacy export. A tail beyond
budget cannot advertise `realtime`; `preload-required` cannot take until readiness is satisfied;
`offline-only` is refused for live Program.

**Must not change.** Native prepared-scene/asset cache hits must not appear as AE render cache hits; no
last-good frame is presented as fresh.

**Exit gate.** A repeatable reference-host run emits the full profile from real ingress timestamps, and
an injected over-budget stream downgrades the rating; a CUE attempt visibly refuses `offline-only` and
unmet `preload-required`.

### CB5 · Dependency-signature cache and pre-render

**Effort** 6–9 d · **Blocked by** CB4, AE-F3, AE-A4, PL3 · **Unblocks** PL4, cached certification

**Work.** Cache keys carry the whole §17.4 closure: project digest, composition, AE build/runtime
profile, plugin/effect versions, fonts, media digests, every dynamic value affecting those pixels, and
colour/output profile — canonically serialized and hashed. Four typed, non-interchangeable classes:
static pre-render, repeated-value state cache, media preload, and `certified-static-split` (which needs
an explicit record naming the split boundary and declaring it visually safe). Any signature change makes
an entry ineligible before CUE; ineligible entries never increment hit telemetry and never supply
Program pixels. Bound warm/eviction through the existing admission precedent rather than a hidden disk
cache.

**Exit gate.** Identical signature → measured hit; changing each field in turn → miss/ineligible before
CUE, uncounted in the hit rate; a full-static artifact reproduces its measured baseline; a
dependency-sensitive split is refused by name.

---

## 8. Track AE-A — runtime adapter

### AE-A0 · Resident adapter kill experiment

**Effort** 6–9 d · **Blocked by** L0; licensed pinned AE build matching the vendored SDK · **Unblocks** AE-A1, AE-A2, AE-F0

**Intent.** Prove or kill the one thing the existing bridge cannot answer: that a GrapiX-owned licensed
AE process can load a resident adapter, exchange a bounded command while it stays open, and perform
supported control work with no panel click and no remote script endpoint. Deliberately one composition
and two static controls.

**Status, 2026-08-11: the premise holds — K1 is not triggered.** Built and run on this machine against
**After Effects 2026 (26.3)** with the vendored 25.6_61 SDK and MSVC 14.44. `GrapiXRuntimeAdapter.aex`
(59,904 bytes, `EntryPointFunc` exported, PiPL in `.rsrc`) loads, stays resident, and executed 26 bounded
commands with no UI interaction: `list` returned Comp 01 and all seventeen fixture layers by name, `probe`
reported `keyframes 0 / setStreamValueLegal true`, and `set 0 16 opacity 42.5` read back **42.5** on a
fresh stream reference. 20/20 repeat commands passed. The authored fixture's SHA-256 is unchanged.
Evidence: [`ae-plugin/runtime-adapter/certification/AE-A0-result.json`](../ae-plugin/runtime-adapter/certification/AE-A0-result.json).

Nine findings worth carrying into other phases — labelled F1–F9 *for this document*; the result record
keeps its own ids and covers host mechanics this list skips. **F1** After Effects queues modal dialogs
across startup and its idle loop does not run
until they are answered, so the adapter *loads* while no command can reach it — "loaded" is not "ready".
They cannot be answered the way a person would: they are `#32770` shells containing one
`DroverLord - Window Class` pane, UI Automation exposes **zero** controls inside them, their window text
is usually **empty** (the heading is painted in the client area), some are **never painted at all** while
After Effects still blocks on them, and synthetic keystrokes are ignored. Found by *window class* and
answered with `WM_CLOSE` per handle, they clear — and `WM_CLOSE` takes each one's non-destructive default:
after clearing a chain containing Crash Repair Options, whose neighbours are "Start in Safe Mode" and
"Manage Plugins", the adapter still loaded and answered. That evidence is the only thing that licenses
doing it. **AE-A2** owns this. **F2** `AEGP_OpenProjectFromPath` from the idle hook returned success and
then idle callbacks stopped — project lifecycle does not belong on the idle path (**AE-A1/AE-A3**).
**F3** the idle hook is not a scheduler — input to **AE-F0/AE-F2**. **F4** `AEGP_GetUniqueStreamID`
returned 0 for transform streams, so **AE-A3** cannot rest stable identity on it. **F5** force-killing
After Effects invalidates its plugin cache and arms the crash dialog, so the *next* unattended start
inherits a modal chain: the graceful quit is not a nicety, it is what keeps unattended operation working.
**F6** `AEGP_NewProject` discards a dirty project with **no save prompt at all** and, unlike F2's call,
leaves the idle channel alive — that is the clean-shutdown primitive, because a save prompt cannot be
answered (no named controls, and `WM_CLOSE` on it means Cancel). **F7** the death hook fires on a
graceful quit and never on a kill, so an orderly shutdown is observable from inside. **F8** the file
channel carries **no process identity** — a second After Effects with this adapter installed answers on
the same channel — so every reply now stamps `hostPid`, and ownership is a claim written at launch.
**F9** a fully commandable After Effects can have **no editor window at all** (`MainWindowHandle == 0`),
which is why readiness is a command round-trip and never a window title.

**Lifecycle, 2026-08-12.** Graceful quit implemented and proven: `dirty` → `discard` → `WM_CLOSE` on the
editor → death hook → exit in ~3 s, no prompt, fixture SHA-256 unchanged. Ownership proven both ways: an
attached process (no claim, or a pid that does not match it) allows reads and property writes and
**refuses** `discard` and `quit`; an owned process allows the full lifecycle. A start from a host with
five modals queued reached a commandable channel in **12 s**.

**29 of 30** launch → commandable channel → property write → graceful shutdown cycles passed, with zero
stalls and zero restarts, across 30 distinct After Effects processes at a 71 s median. All 30 wrote
`opacity 42.5` and read back `42.500000`, and the fixture ended byte-identical. Cycle 12 failed on the
quit — the project was clean and the channel live, but AE did not exit inside the window, so the harness
killed it; cycle 13 then passed in 85 s, consistent with the kill arming the crash dialog and the clearing
loop absorbing it. So **one `WM_CLOSE` is not always enough**, and the stop path needs a bounded retry that
re-asserts the close before escalating, because its fallback is the kill that taxes the next start. That is
finding F14, and it belongs to this track's supervisor phase rather than to this card.

**Work**

- Create `ae-plugin/runtime-adapter/` built against `vendor/adobe/sdk/ae25.6_61.64bit.AfterEffectsSDK`;
  keep it out of `Editor/services/adobe-mcp-gateway/`. Register an AEGP idle hook and death hook
  (`AEGP_RegisterIdleHook`, `AEGP_RegisterDeathHook`), accept one locally provisioned test command, and
  report a result plus native error code.
- On one real lower-third project prove: adapter ready; project open/identity; list one named
  comp/layer; read and set one **unkeyframed** numeric or colour stream; read it back. Every suite call
  executes on the documented host callback/idle path, never on the socket worker — the header marks
  synchronous UI-thread rendering deprecated, and `AEGP_SetStreamValue` is legal only at
  `AEGP_GetStreamNumKFs == 0` or `NO_DATA`.
- Record, not assume: plugin auto-load location for that build; whether launch leaves AE resident
  without `-r`; callback/thread affinity and idle latency; behaviour while a project opens; ownership
  and clean termination; which suite versions acquire; whether the chosen stream is writable at all.
- Run the old `exportProjectManifest` once as a naming reference only. Do not reuse its `-r` launcher,
  staged bootstrap, `$.evalFile`, timeout, cleanup, or `AeManifest` as a control channel.
- Write `ae-plugin/runtime-adapter/certification/AE-A0-result.json`: AE build, SDK hash, adapter hash,
  host CPU/GPU/driver/OS, suite acquisition, every command with latency and result, failure logs.

**Must not change.** The legacy exporter stays one-shot static inspection. No JSX text, script path,
shell command, network-supplied project path, panel dependency, frame readback, Preview, Take or output
appears here. A successful load is not a claim that AE is headless, that every property is controllable,
or that macOS is supported.

**Exit gate.** On the pinned licensed Windows host a runnable harness launches or attaches, receives
readiness with PID and build, opens the project, lists the comp/layer, changes and reads back the
property, and detaches cleanly with no manual AE interaction — repeated for **30 cycles**, each with an
outcome record; every failure has a native diagnostic rather than a hang or a false ready.

**Definition of done.** A reviewer can reproduce resident native AE control on the pinned host, or use
the failure record to stop this architecture before a production adapter exists.

### AE-A1 · Authenticated local IPC and refusal contract

**Effort** 5–8 d · **Blocked by** AE-A0 · **Unblocks** AE-A2, AE-A3, AE-CD1, AE-F1

**Intent.** Freeze a small versioned local protocol *before* features multiply, and make the security
boundary part of the first control landing rather than a later hardening phase.

**Work**

- Add `Shared/adobe-common-schema/src/aeRuntimeProtocol.ts` — do not extend the gateway's `protocol.ts`
  `tool.call` model. Define protocol major/minor, `HELLO`/capability negotiation, session id, request
  id, sequence/idempotency key, deadline, expected project digest, typed result/error, structured event,
  adapter fingerprint.
- Implement the transport in `ae-plugin/runtime-adapter/` and a client codec in
  `Playout/services/playout-control/src/aeRuntimeClient.ts`, modelled on `render-engine/src/ipc.rs`:
  same-user Windows named pipe, 4-byte big-endian bounded UTF-8 JSON, oversize length refused before
  allocation, plus a per-launch high-entropy token passed through protected launch configuration — never
  a URL, query or log.
- Keep the verb enum **closed**: handshake/health/shutdown, project lifecycle, list/read/set declared
  controls, controlled data revision, set rational time, render readiness/failure. There is no `eval`,
  JSX payload, shell command, script path, filesystem path or plugin install.
- Map a validated caller capability to a narrow adapter capability; never forward user credentials into
  AE. Enforce `requirePermission` at the API edge and audit every mutation with the §26 fields.

**Must not change.** No public TCP/WebSocket listener; the 4784 gateway is not repurposed as the runtime
pipe; a local pipe is never treated as implicit authorization; no frame bytes here.

**Exit gate.** Codec/interop fixtures exercise both `HELLO` directions and every envelope field;
incompatible majors and missing capabilities refuse before work starts. A negative suite attempts
`eval`, JSX text, script path, shell command, raw filesystem path, wrong token, stale digest,
malformed/oversize length, duplicate request and expired deadline — each refused with its documented
code, none reaching an AE call. A remote connection attempt finds no listener.

### AE-A2 · Playout-owned runtime supervisor

**Effort** 7–11 d · **Blocked by** AE-A1 · **Unblocks** AE-A3, AE-CD0 execution, AE-F0 integration, PL track

**Intent.** Make AE a managed runtime with truthful lifecycle state, owned by the Playout-side service,
so closing Editor can never create Take/Program authority.

**Work**

- Add `aeRuntimeSupervisor.ts`, `aeRuntimeState.ts`, `aeRuntimeDiagnostics.ts` under
  `Playout/services/playout-control/src/`: launch/attach policy, per-runtime secret, project load,
  health ping with deadline, PID/exit observation, reconnect, bounded restart/backoff, explicit
  stop/detach, persisted crash state.
- Expose `starting | loading | ready | degraded | failed | stopped` plus PID, owned-vs-attached, AE
  build, adapter/runtime hashes, project digest, active composition, last successful command/revision,
  last readiness/failure event, latency samples, crash count and remedy. `lastFrameId` stays
  nullable/unsupported until the frame track proves it.
- Reuse lifecycle mechanics — not ownership — from the two existing supervisors: state snapshots, grace
  windows, owned-vs-adopted distinction, per-user data root, append-only crash logs.

**Measured constraints from AE-A0's harness** (`ae-plugin/runtime-adapter/supervise.sh`,
`ae-window.ps1` — the spike shape this phase productionises):

- Startup queues modal dialogs and AE's idle loop does not run until they are answered, so a loaded
  adapter is not a reachable one. They must be found by **window class** (`#32770`), never by title: their
  window text is usually empty, and some are never painted while AE still blocks on them. `WM_CLOSE` per
  handle answers each one's non-destructive default — verified by the adapter still loading after a chain
  containing Crash Repair Options was cleared. Nothing else reaches them: no automatable controls, no
  synthetic keystrokes.
- Provisioning outranks clearing. A force-kill invalidates AE's plugin cache and arms the crash dialog, so
  every kill costs the *next* start a modal chain; a host with broken third-party plugins (a Resolume DXV
  install here) raises a load-failure modal on every cold scan. The supervisor's kill path must therefore
  be a last resort with the consequence recorded, and host provisioning is a documented prerequisite.
- The graceful stop is `dirty` → `discard` (`AEGP_NewProject`, no prompt, idle channel survives) →
  `WM_CLOSE` on the editor → death hook → exit. A save prompt is unanswerable, so it must never be
  reached. The death hook fires only on this path, never on a kill.
- Ownership cannot come from the channel: it is a file pair with no process identity, and any AE with the
  adapter installed answers on it. Every reply stamps `hostPid`; the claim written at launch records the
  pid the adapter itself reported. A process that does not match the claim is **attached** — reads and
  property writes allowed, `discard` and `quit` refused, because it may hold an operator's unsaved work.
- `ready` is a command round-trip and nothing else. Neither a PID, nor a window title, nor the adapter's
  own load marker qualifies: a fully commandable AE here had `MainWindowHandle == 0`, and the load marker
  lives in the reply slot, so the first successful command overwrites it.
- A stalled start is detectable without waiting out a budget: the process stays alive and `Responding`
  while its CPU counter freezes and no reply arrives.

**Must not change.** `engineSupervisor.ts` remains the one long-lived engine connection; this supervisor
never touches Program, clock, Preview, NDI, SDI or recovery policy. An attached AE process is never
killed unless policy identifies it as GrapiX-owned. A PID or open pipe is not `ready`.

**Exit gate.** On the real host: launch → authenticated ready with PID/build → deliberate adapter loss →
degraded → controlled restart or explicit failed, with operator-visible diagnostics and preserved crash
evidence. Harness tests cover owned launch, allowed attach, rejected attach, startup timeout, process
exit, pipe loss, stale health, backoff exhaustion, stop and adoption-without-kill. Closing an Editor
process cannot start, stop, take or restart the runtime.

### AE-A3 · Declared discovery and constrained control

**Effort** 9–14 d · **Blocked by** AE-A2, AE-CD0 · **Unblocks** AE-CD1–AE-CD4, AE-F0 integration, PL1–PL3

**Work**

- Implement typed adapter commands: `LIST_PROJECT_ITEMS`, `LIST_COMPOSITIONS`, `LIST_LAYERS`,
  `LIST_PROPERTIES`, `READ_PROPERTY`, `SET_PROPERTY`, `READ_PROPERTY_METADATA`, `LIST_EFFECTS`,
  `SET_TIME`, plus `HEALTH` and `SHUTDOWN`. Every result carries operation id, native identity,
  project digest, rational time where applicable, the surface that executed it (`aegp-sdk` or
  `controlled-dom`), and a structured failure code. `RENDER_READY`/`RENDER_FAILED` are events, not
  operations, and project lifecycle is **not an adapter command at all** — both corrections are
  recorded in the status notes below.
- Default to AEGP suites validated against the pinned build: project/item/comp/layer enumeration,
  stable ids, and stream metadata/read/write via `AEGP_StreamSuite6` including
  `AEGP_GetUniqueStreamID`, `AEGP_GetNewStreamValue` and the documented `AEGP_SetStreamValue`
  restriction. Acquired suite versions are part of capability negotiation.
- Do **not** presume the native surface can do source-text replacement, expression introspection,
  expression-control updates or footage replacement. Probe each. Only where the native proof is
  insufficient may a separately packaged `controlled-dom/` implementation be added: one compiled,
  allowlisted function per verb, typed values, project-relative asset handles, never caller script text
  — and its results say `controlled-dom`.
- A panel, if ever built, is development/designer setup only: not loaded by the runtime path, carrying
  no token, never the way a mutation is issued.
- Implement rational `SET_TIME` plus control-channel `RENDER_READY`/`RENDER_FAILED`. **No pixels here.**
- Publish a capability table keyed by adapter/AE fingerprint: supported kinds, read-only reasons,
  keyframe/expression restrictions, surface, source-replacement availability, effect inventory.

**Must not change.** No property becomes writable merely because it was discovered. Text stays data,
never expression source. No cue/take verb, binding UI or Program authority appears in this phase.

**Exit gate.** Discovery returns a stable descriptor tree; restart/reopen reproduces the same identities
or explicitly reports a digest/rebind mismatch. Capability probes label read/write behaviour for one
numeric/colour, one text, one expression/effect, one footage candidate and one unsafe keyed control;
unsupported cases refuse with structured reasons. A Playout harness sets an exact rational time and
receives readiness or failure with no frame payload involved.

**Status, 2026-08-13: partial — the declared surface now carries text, colour and exact time.** Six of
the thirteen declared operations were admitted by the pipe but had no dispatch handler, so they answered
`OPERATION_UNSUPPORTED`: that single gap was what blocked BO0a's control proof and PL1's live proof at
once. Now implemented: `SET_TIME` (see PL1 for the time-scale finding it produced), `LIST_EFFECTS`, and a
declared canonical property table covering `ADBE Opacity`, `ADBE Rotate Z`,
`ADBE Text Properties/ADBE Text Document` and `ADBE Effect Parade/ADBE Fill/ADBE Fill-0002`, with the
transform-group spellings resolving to the same targets. `READ_PROPERTY`, `SET_PROPERTY`,
`LIST_PROPERTIES`, `READ_PROPERTY_METADATA` and one member of an atomic revision all route through that
one table, so nothing is writable that discovery did not declare.

Live on AE 26.3 with `lower-third.aep`: a single revision moved two text members and one colour member
together (`042 → 137`, `MAYA RIVERA → GRAPIX LIVE`, `#0557FF → #1E90FF`) with every value read back; a
batch whose colour member was malformed refused `INVALID_PAYLOAD` and left all three untouched, so the
valid member did not land either. `PLAYER_NAME`, `SCORE` and `TEAM_COLOR` pass through the production
`AeControlService` path in `certify:ae-runtime-fixtures`. Evidence:
[`AE-A3-declared-surface.json`](../ae-plugin/runtime-adapter/certification/AE-A3-declared-surface.json).

**Control-safety result, 2026-08-18.** The remaining declared-control refusal cases were executed on
licensed AE 26.3 against a clean adapter-authored `LOWER_THIRD`. Native metadata reported
`PLAYER_IMAGE` opacity as `writable:false`, `readOnlyReason:"keyframed"`, and its rotation as
`writable:false`, `readOnlyReason:"expression-enabled"`; both attempted `SET_PROPERTY` calls refused
`PROPERTY_READ_ONLY` and exact before/after reads were unchanged. The same discovery records
`surface:"aegp-sdk"` and a canonical structural fingerprint for every listed stream. `LIST_EFFECTS`
identified the native Fill effect, while an attempted `REPLACE_FOOTAGE` request refused
`OPERATION_UNSUPPORTED` rather than entering an undeclared source-replacement path. The fixture-only
authoring commands that create the keyed and expression-enabled states are not runtime operations.
These results are recorded in the same `AE-A3-declared-surface.json` evidence.

**Two findings worth carrying.** First, **asking After Effects for a stream a layer cannot have wedges
the idle hook** — source text on a solid, or a Fill colour on a layer with no effects. AE stays alive and
`Responding` with a flat CPU counter while no callback ever completes again, which is finding F2's
signature; the graceful quit then refuses because ownership cannot be proven, and only a kill clears it,
which taxes the next start (measured here: 12 s and four dialog batches after a kill against 6 s and one
after a graceful quit). Every kind is therefore gated on a cheap total query — `AEGP_GetLayerObjectType`
for text, an effect walk for colour — *before* any stream is acquired. Second, a multi-segment canonical
path must be echoed as real segments: collapsing it into one `/`-joined `matchName` made every
two-segment declared control unmatchable and reported as `CONTROL_TARGET_STALE`, because the control
service compares segment by segment.

**The four remaining operations, 2026-08-17 — and a contract defect they exposed.** `RENDER_READY` and
`RENDER_FAILED` were declared **twice**: once in `AeRuntimeOperation` (a client→adapter request with a
`requestId`) and once in `AeRuntimeEvent` (an adapter→client push with none). One name meant two
incompatible things — a client asking After Effects whether a render is ready, and the adapter reporting
that it is. Only the second is meaningful, so they are now **events only**, removed from the operation
union and from the pipe's inbound admission, where they refuse `OPERATION_UNSUPPORTED` like any other
non-protocol name. Together with the lifecycle removal below this leaves the declared surface at
**nine project/property operations plus `HEALTH` and `SHUTDOWN`, and two events** — not the thirteen
operations this card originally listed; the list at the top is corrected by both.

A latent bug sat under this: `AeRuntimeClient.acceptBytes` handed every decoded frame to the next
reply waiter, and `call()` requires the next frame to be a result matching its outstanding
`requestId`/`sequence`/`operation`. A single pushed event would therefore have failed an unrelated call
with `MALFORMED_FRAME` and desynchronised the pipe — events could not be delivered at all. The client
now demultiplexes on `kind`, so an event never satisfies a reply waiter; it drops and counts
foreign-session events, isolates throwing listeners, bounds pre-subscription buffering with a dropped
count, and tracks event-sequence gaps. Events carry an independent sequence and no `requestId`
(memory rule 24), written through the same serialised pipe writer as results.

`OPEN_PROJECT`/`CLOSE_PROJECT` **were** implemented asynchronously — reply `{lifecycleRequestId,
state:"accepted"}`, act on a later idle callback, emit `PROJECT_LOADED`/`PROJECT_CLOSED` only once
another callback proved the host survived — because finding F2 measured `AEGP_OpenProjectFromPath`
returning `A_Err_NONE` and then silencing every later idle callback. That design converted an
undetectable hang into a detected `LIFECYCLE_SILENT` degraded state; it never made the call safe.
It has since been **removed** in favour of supervisor-owned restarts — see the cutover below. The
detection machinery it justified is gone with it, because there is no longer an in-process
lifecycle acceptance to go silent on.

Verified: `adapter.cpp`, `runtime_pipe.cpp` and `frame_ring.cpp` compile clean against the pinned
25.6_61 SDK with MSVC 14.44 (only the two pre-existing `getenv` C4996 warnings); 12 targeted Node tests
cover the demux, ordering, foreign-session drops, listener isolation, bounded buffering, lifecycle
correlation and the silent-lifecycle path. Render-event **serialisers** exist with no caller: emitting
one belongs to the evaluation path in `AE-F2`, and nothing fabricates a render event today.

**Live lifecycle result, 2026-08-18.** Against licensed AE 26.3 with the installed adapter,
`OPEN_PROJECT` returned `{lifecycleRequestId:"lifecycle-1", state:"accepted"}`, the host then stopped
responding before `PROJECT_LOADED`, and the production `AeRuntimeSupervisor` changed from `ready` to
`degraded` with `AeRuntimeLifecycleSilentError` / `LIFECYCLE_SILENT` and the documented remedy. This
executes the intended detection contract; it does **not** make project lifecycle safe on the idle path.
Evidence: [`AE-A3-lifecycle-silence.json`](../ae-plugin/runtime-adapter/certification/AE-A3-lifecycle-silence.json).

**Lifecycle cutover, executed on the licensed host 2026-08-18.** In-process project lifecycle is
**gone**, not wrapped: `OPEN_PROJECT` and `CLOSE_PROJECT` are removed from `AeRuntimeOperation`, from
the pipe's inbound admission, and from the adapter, along with the `project.lifecycle` capability,
the `PROJECT_LOADED`/`PROJECT_CLOSED` events, `AeLifecycleAcceptedResult`,
`AeProjectLifecycleDetail` and `AeRuntimeLifecycleSilentError`. Runtime protocol major is **2**;
an adapter still speaking major 1 is refused at HELLO rather than half-supported.

Project changes are now a supervisor-owned process replacement. `AeRuntimeSupervisor.restartWithProject`
hashes the target `.aep` against its declared digest, terminates the owned host, launches a fresh
After Effects with that project, and proves the result from **After Effects' own answer**:
`HEALTH` carries `projectPath` from `AEGP_GetProjectPath`, and readiness is not declared until that
path matches the requested one. A launch that answers with a different project is treated as
still-loading until the deadline, then refused — the declared digest alone is never accepted as
proof that the intended project is open.

**Live result.** Against licensed AE 26.3 with adapter
`7155d7ef1f5be5cb902241a3629777e27372c5ab09d70c17b8d6160f3f3929bb` — the fingerprint the adapter
itself reported, matching the installed file — `lower-third.aep` came up owned/ready as pid 45752
with After Effects reporting that exact path; `OPEN_PROJECT` and `CLOSE_PROJECT` each refused
`OPERATION_UNSUPPORTED` **and the host stayed commandable afterwards**, which is the measured
difference from the wedge above; the change to `bo0a-alpha-edges.aep` came up as pid **49392** —
a different process — with After Effects reporting the replacement path and enumerating all seven
BO0a compositions; shutdown reached `stopped` with `crashCount 0` and no recorded error. Evidence:
[`AE-A3-restart-lifecycle.json`](../ae-plugin/runtime-adapter/certification/AE-A3-restart-lifecycle.json).

**What the cutover does not claim.** `AEGP_OpenProjectFromPath` is still unsafe; it is unreachable,
not fixed. The supervisor does **not** clear After Effects' startup modals — the live run used the
`ae-window.ps1` clearing loop beside it, and an unattended supervisor on a host that queues a crash
dialog will still time out with its documented remedy. Termination is `SIGTERM`/`TerminateProcess`,
which arms AE's crash-repair dialog and taxes the next start (memory rule: 12 s and four dialog
batches after a kill against 6 s and one after a graceful quit); a graceful in-protocol quit has no
AEGP call behind it and is not part of this cutover.

**Still open.** The declared property safety/refusal slice is executed, including keyed,
expression-enabled and footage-replacement refusals, and project lifecycle is now closed by
replacement rather than by making the SDK call safe. Actual footage/source replacement is
deliberately absent and belongs to AE-CD3; expression-control authoring belongs to AE-CD4. No
`controlled-dom` surface or capability table keyed by fingerprint (AE-A4) exists yet, so this phase
is still not closed.

### AE-A4 · Runtime fingerprint and control certification

**Effort** 6–10 d + certification window · **Blocked by** AE-A2, AE-A3 · **Unblocks** PL3, BO5, release

Nothing downstream of `BO5` blocks this phase. It runs beside `AE-F1`/`AE-CD*` in M4 and must complete
before `PL3`, because `PL3` may not expose a verb against an uncertified runtime.

**Work.** Define a normalized `AeRuntimeFingerprint` (AE build and executable identity, OS, CPU, GPU and
driver, adapter hash, runtime and protocol versions, acquired suites, project digest, fixture plugin
ids, locale and relevant colour settings; secrets and arbitrary paths excluded). Block readiness/cue
eligibility on a fingerprint mismatch, unavailable declared capability, unsupported protocol, missing
plugin or digest mismatch — with remediation, never best-effort fallback. Keep the control corpus and
expected command traces under `ae-plugin/runtime-adapter/certification/`, separate from the static
parser fixtures. Mark each matrix row `certified`, `failed` or `not-run`; never infer a row from a
nearby AE version or machine.

**Must not change.** The three authored `.aep` fixtures remain Static Inspector evidence. No row implies
every AE release, OS, plugin, real-time performance, alpha fidelity, NDI or SDI readiness.

**Exit gate.** Each declared Windows row produces a recorded fingerprint and one of the three outcomes;
deliberate adapter-build, digest, plugin and AE-build mismatches each block or degrade visibly. At least
one known-good and one deliberately incompatible row run on real hosts, and untested hosts display as
uncertified.

---

## 9. Track AE-F — frame bridge

### AE-F0 · Pinned pixel-world checkout and alpha contract

**Effort** 6–9 d · **Blocked by** L0, AE-A0 (resident host callback model); pinned SDK and licensed host · **Unblocks** AE-F1

**Intent.** Prove or disprove a native, non-capture route from the pinned runtime to real composition
pixels, and settle alpha ownership **before** any transport exists.

**Status, 2026-08-12: the route exists and the alpha contract is settled.** `AEGP_RenderAndCheckoutFrame`
→ `AEGP_GetReceiptWorld` → `AEGP_GetBaseAddr8/16/32` → `AEGP_CheckinFrame` runs on the adapter's own hook
thread (`onHookThread` true on every call, `AEGP_CheckinFrame` returned 0 every time). All three world
types are real and unpadded: 8/16/32-bit at 4/8/16 bytes per pixel, `rowBytes` exactly `width × bpp`.
Frame→time uses `AEGP_GetCompFrameDuration` as an exact rational, so 30000/1001 material cannot drift.

**Alpha, measured rather than assumed.** The repository's `.aep` files are *parser* fixtures whose layers
carry no renderable source — every frame renders uniformly transparent, which fits every alpha hypothesis
equally well. So the adapter gained a `fixture` verb that authors `AlphaProbe` (640×360: opaque red
quadrant, 50 %-opacity green quadrant, empty bottom half) and saves it, letting `aerender` produce the
reference from the same file. Result: AE's world is natively **ARGB**; `AEGP_MatteMode_PREMUL_BLACK`
yields the 50 % quadrant as `A 128 / G 128` with **zero** pixels carrying colour above alpha, and mapped
ARGB→RGBA it is **byte-for-byte identical** to the Render Queue TIFF — 921,600 bytes, zero differing
bytes. `AEGP_MatteMode_STRAIGHT` yields `A 128 / G 255` and differs on exactly 57,600 bytes, worst delta
127, so the comparison is sensitive enough for the identical result to carry weight. After Effects' own
"TIFF Sequence with Alpha" is therefore **premultiplied** while declaring `ExtraSamples = unspecified`.

Four findings, two of which would have shipped bugs. **C1** `AEGP_NewFromItem` inherits the Composition
panel's downsample factor — the first checkout returned 480×270 for a 1920×1080 comp — so resolution and
quality are now stated on every request, never inherited. **C4** requesting a non-native channel order
corrupts repeat checkouts: with `BGRA` requested, five identical checkouts of one unchanged frame
alternated BGRA, ARGB, BGRA, ARGB, BGRA, the flip following the *call count* rather than the request,
while `ARGB` was stable across five. A runtime asking for BGRA gets correct pixels on odd calls and
channel-swapped pixels on even ones, so GrapiX must request ARGB and swizzle itself — and **AE-F1's ring
descriptor must carry the layout observed, never the layout requested**. **C2** a frame index far past the
composition's end is not refused (frame 99999 of 3600 returned a full frame), so range checking belongs to
the caller. **C3** stride must come from the world type; a hardcoded 4 bytes reported a correct 16-bit row
as half padding.

Evidence: [`certification/AE-F0-checkout.json`](../ae-plugin/runtime-adapter/certification/AE-F0-checkout.json)
and [`certification/AE-F0-references.json`](../ae-plugin/runtime-adapter/certification/AE-F0-references.json).
Still open: 16/32-bit reference agreement, the cancel path, deadline behaviour on frames that cost real
time, and the wider edge corpus (antialiased and gradient edges, coloured translucent shadow) which is
**BO0a**'s.

**Work**

- Implement the checkout in `ae-plugin/runtime-adapter/` against the vendored SDK's
  `AEGP_RenderAndCheckoutFrame` → `AEGP_GetReceiptWorld` → `AEGP_CheckinFrame` sequence, following the
  `Examples/AEGP/Grabba/Grabba.cpp` pattern, off the UI thread (the header marks the synchronous UI-thread
  call deprecated). Release the receipt on every success, error and cancellation path.
- Record and assert per checkout: width, height, rowbytes/stride, channel order, bit depth, alpha
  representation, colour profile evidence, source time, and callback/thread affinity. Determine whether
  the world stays valid after callback return, and which thread may copy and release it.
- **Settle the conversion boundary here.** The consumer contract is BGRA8, premultiplied, sRGB, because
  `render-daemon/src/config.rs` rejects straight alpha outright. A straight-alpha checkout is either
  converted by an explicitly tested rule — including the RGB value at `A = 0`, rounding and colour
  handling — or refused as `ae-frame-format-unsupported`. It is never relabelled premultiplied.
- **Break the oracle circularity.** References must not be captured through the path under test, or a
  channel-swizzle or premultiplication defect blesses its own baseline. Produce them independently from
  the After Effects Render Queue as a PNG or TIFF sequence with pinned export settings — composition,
  frame numbers, bit depth, alpha mode, colour management — and record each file's SHA-256. That export
  is diagnostic evidence only and never becomes a production capture route. Store the expected bytes with
  AE/SDK build, composition, exact time, conversion chain, checksums and the numeric tolerance below.

**Must not change.** No desktop, window, OBS, screenshot or Composition-panel route enters production
code. No claim that every project, plugin, colour space or precision is supported.

**Exit gate.** On the licensed host an adapter probe checks out first/middle/last animation frames and
releases each under leak instrumentation. Against the independently exported references, after the
recorded conversion: an identity conversion must be **byte-for-byte equal**; a declared premultiply or
colour conversion must be within **≤ 1 LSB per channel** on partial-alpha pixels and **exactly equal** on
fully opaque and fully transparent pixels. Any other tolerance is a phase failure, not a manifest entry —
"finite" is not a threshold. A negative run proves an unsupported alpha mode, bit depth, colour space or
lifetime condition is refused with a structured reason rather than guessed or replaced by capture.

**Definition of done.** A reviewer can reproduce a native pinned-SDK checkout of real AE pixels and
account for every byte's format, owner, lifetime and release, with no capture involved.

### AE-F1 · Bounded shared-memory ring and descriptor

**Effort** 7–10 d · **Blocked by** AE-F0, AE-A1 · **Unblocks** AE-F2

**Work**

- Add a versioned `AeFrameDescriptor` to `Shared/render-protocol/src/messages.ts` for **metadata only**:
  ring generation, slot index, frame id, data revision, composition id, exact rational requested and
  evaluated time, presentation deadline, width, height, stride, colour format, alpha mode, colour space,
  ready/late/missed status. Change the Rust twin (`render-engine/src/protocol.rs` and its engine seam)
  in the same commit.
- Implement an adapter-owned shared-memory ring: fixed header plus fixed slots negotiated at session
  setup; slot states `FREE → WRITING → READY → READING → FREE` with acquire/release atomics; generation
  and owner ids so a stale mapping or ABA slot reuse cannot be accepted; one responsible process per
  transition; crash invalidates the generation and reclaims only when the peer is known gone.
- Fix slot count and maximum dimensions/stride at configure time, map once, validate byte length and
  alignment, and reject a format change until the ring is drained. A full ring never overwrites a
  ready/reading slot and never allocates: it returns structured back-pressure.
- Publish ring metrics distinct from `NdiFramePool`'s: free/ready depth, high-water, producer drops,
  consumer stale-generation/revision rejects, checksum faults, lease duration, sequence gaps.
- Reconcile the format contract: `EngineOutputFormat` and its Rust twin `outputs.rs::OutputFormat` both
  lack an explicit colour format; add it in the same protocol change, aligned with
  `Shared/output-contracts` and the stricter daemon config. Give the Rust handoff
  (`render-daemon/src/output/mod.rs::VideoFrame`) either a lifetime-bound lease or an explicit bounded
  copy into preallocated storage.

**Must not change.** No raw pixels in `ipc.rs`, `transport.rs`, protocol v3, audit logs or browser
payloads. The NDI pool stays egress-only. A `READY` descriptor is not current merely because its frame
id is larger.

**Exit gate.** A two-process test drives the maximum configured frame through every slot for **100,000
cycles**, verifying per-slot checksums, descriptor identity and exactly-once reclamation. Pausing the
consumer until every slot is `READY` yields zero allocations, zero in-use overwrite, bounded rejected
requests and explicit back-pressure telemetry, then resumes without reconnect. Stale-generation,
wrong-length and stale-revision descriptors are refused before the Program handoff.

**Status, 2026-08-13: implemented and locally verified.** `AeFrameDescriptor` and the explicit
`bgra8`/`rgba8`/`argb8` format contract now land together in TypeScript and Rust; old output
documents default to `bgra8`, while NDI validation refuses every layout or alpha mode other than
premultiplied `bgra8`. The adapter builds an aligned Windows mapping with a fixed header, fixed
slots, acquire/release state transitions, owner/generation checks, FNV-1a slot checksums and
bounded back-pressure. Its independent two-process harness passed 100,000 maximum-frame cycles
through all four slots: checksum faults 0, overwrites 0, allocations after configure 0, eight
intentional rejected requests, high-water depth 4, and explicit stale-generation, wrong-length and
stale-revision refusals; it resumed after the filled-ring pause without reconnecting. This evidence
does not claim NDI, DeckLink, AJA, video or hardware readiness. Program ingress, clocked
evaluation and any AE evaluation call remain explicitly **AE-F2** work.

### AE-F2 · Playout-clocked evaluation and Program ingress

**Effort** 8–12 d · **Blocked by** AE-F0, AE-F1, AE-A3, AE-CD1, AE-CD2, PL1 · **Unblocks** PL3, PL4, BO1, CB4

**Work**

- Extend `program.rs::ProgramClock` so its absolute deadlines issue exactly one AE evaluation request
  per due Program frame, ahead of presentation. Keep skip-late semantics: never queue historical renders
  or replay AE time in slow motion.
- Add an engine-side AE ingress module that consumes only descriptor plus slot lease, validating
  session/ring generation, requested time, composition id, data revision, dimensions/stride and the
  negotiated tuple before forwarding or releasing. It knows no Adobe SDK call.
- Change `engine.rs::render_program_frame` at the Program source seam so an AE frame reaches every
  running output without GrapiX recreating the composition; the non-AE scene path is untouched. Copy
  only into preallocated storage — never an unbounded per-frame `Vec`.
- Make egress agreement fail closed against `validate_ndi_format` and the daemon config; expose an
  explicit conversion/rejection status instead of passing straight alpha into a pool that assumes
  premultiplied bytes.
- Emit `requested`, `ready-before-deadline`, `late`, `missed`, `ring-backpressured`, `stale-revision`,
  `rejected-format` counters keyed by frame id and revision; hand PL4 the facts and none of the policy.

**Must not change.** Editor still cannot take, alter Program, schedule output or select a policy. No
late frame is queued to catch up; no stale frame is relabelled as meeting the current frame or revision.

**Exit gate.** A deterministic harness drives Program at `60000/1001` with a scripted producer and
proves each presented descriptor's target time, frame id and revision equal the request, while
out-of-order, duplicate, stale-revision and wrong-format frames are refused. An injected late completion
and an unreturned request are counted and surfaced without blocking the next deadline. A virtual or
recording run of a known transparent animation byte-verifies the pixels — proving ingress, not NDI.

**Topology decided 2026-08-17 — both, but they are two different seams.** The owner asked for the same
host *and* a separate render host. Answering that requires separating two questions the phrase conflates.

*Where GrapiX rasterizes and outputs* is **already host-agnostic and implemented.** `config.rs` takes
`--bind`, `--headless`, `--engine-id`, forces a token on any non-loopback bind (rule 21), warns without
TLS and supports a client allowlist; `remote-production-v2.md` lists headless remote engine mode as
implemented substrate. A separate GrapiX Render Engine host therefore needs **no new work in this
phase** — it is configuration, as `config.rs` says in its own header comment.

*Where After Effects runs relative to the engine* is **same host only, and stays that way through
`AE-F3`.** Two independent reasons, either sufficient:

1. **Licensing.** L0 §9 approves **V1 only** — an attended operator workstation on the owner's own
   licensed installation. A dedicated on-prem AE machine is **V2: conditional**, requiring its own
   licensed seat and a *named interactive user* with no service account, because Business PST §4 bans
   generic-user deployment. The render-engine install is **V3: a research variant only** — permitted as
   an install topology by Software PST §2.2, but whether an AEGP can host the frame path there is
   unproven. §9.4's scope discipline is explicit: a second render machine at scale stays blocked at L1
   under kill gate K0. Building for it now would spend the phase on an unapproved deployment.
2. **Arithmetic.** `AE-F1`'s ring is a Windows shared-memory mapping — same-host by construction, and it
   moves zero bytes over a link because it hands over a mapping offset. Crossing hosts means a real
   frame transport: 1920×1080 BGRA8 at `60000/1001` is 8,294,400 bytes per frame, **497 MB/s ≈ 3.98
   Gbit/s**; 16-bit doubles it to 7.95; 2160p59.94 is **15.91 Gbit/s**. That is 10GbE with no headroom,
   or 25GbE+ for UHD. Compressing it to fit would violate invariant 7 — a fallback may not silently
   produce visually different pixels. The control channel is same-host by construction too: the runtime
   pipe is a local same-user named pipe.

So the AE↔engine frame path is **not** a configuration flag; a remote-AE variant is a phase of its own
with a licence gate in front of it. What this phase owes it is a seam, not an implementation: the ingress
already "consumes only descriptor plus slot lease" and "knows no Adobe SDK call", and that boundary is
kept deliberately transport-shaped so a future transport is an addition rather than a rewrite.
`AE-F2a` must **refuse a non-local AE session with a named code** rather than leave the unapproved
topology reachable by accident or silently undefined.

**Split, per the adversarial chair.** `AE-F2` is not started as an 8–12 day monolith.

| Phase | Scope | Effort |
| --- | --- | --- |
| **AE-F2a** | One live frame, end to end: `ProgramClock` request → AE checkout → ring descriptor + lease → engine ingress validation → `RecordingSink`/virtual output byte comparison. Same-host only, with the non-local refusal above. Deterministic core testable against the existing two-process ring harness and a fake producer; phase completion still needs the licensed host. | 3–4 d |
| **AE-F2b** | Bounded lead-time scheduling ahead of the presentation deadline, the in-flight set that stops a timer wakeup issuing a second request, late/missed/backpressure/stale-revision policy, and the operational counters. **Landed 2026-08-18** — see the status note below. | 5–8 d |

`ProgramClock` today sleeps until a target's deadline and only then renders, so it has **no earlier
request point at all** — creating one is `AE-F2a`'s first real change, and it must preserve the existing
skip-late invariant rather than queue historical frames.

**Status, 2026-08-17 — `AE-F2a` implemented, scripted-verified, live gate open.**

`src/ae_ingress.rs` is the new ingress: it consumes **descriptor plus slot lease only**, makes no Adobe
SDK call, and refuses with twelve named codes — `AE_SESSION_NOT_LOCAL`, `AE_STALE_RING_GENERATION`,
`AE_COMPOSITION_MISMATCH`, `AE_FRAME_UNREQUESTED`, `AE_FRAME_DUPLICATE`, `AE_FRAME_OUT_OF_ORDER`,
`AE_FRAME_HISTORICAL`, `AE_FRAME_NOT_READY`, `AE_TIME_MISMATCH`, `AE_STALE_REVISION`,
`AE_REJECTED_FORMAT`, `AE_IMPOSSIBLE_GEOMETRY`. Locality is validated **first**, so an unapproved
topology is refused before any of its other fields are trusted. `AeProgramSource::new` additionally
refuses a composition clock that cannot carry the Program rate — structurally, at install, because that
failure condemns every frame rather than one (the same `PL1` argument that moved the rate check out of the
per-cue path). Exact-time equality is cross-multiplied, so `800/23976` and `100/2997` are one instant.

**The clock now has two stages.** It reads `has_ae_program_source()` inside its *existing* status lock,
so the non-AE path keeps exactly its previous single-sleep shape and pays nothing for this phase. With an
AE source it sleeps to `deadline − request_lead_nanos(rate)`, issues at most one request for `next` **only
while still before the deadline**, then sleeps to the **unchanged** absolute deadline. The lead is taken
*out of* the existing wait rather than added to the schedule, so a late request can never push
presentation later. `request_lead_nanos` is one frame period capped at 50 ms: one period is the largest
lead that cannot overlap the previous frame's request, and pipelining two frames is deliberately
`AE-F2b`'s question rather than something acquired here by accident. Skipped frames call
`abandon_ae_program_requests_before(target)` — counted missed, never queued. (`AE-F2b` answered that
question: the wakeup stayed at one period and the *window* deepened to three frames, because one period
is shorter than a checkout.)

**Two things the tests found, both real.**

1. **A truncated deadline lags by exactly one frame, and the clock's `max` is load-bearing.** The first
   test asserted `frame_at(deadline_nanos(f)) == f` and failed for **1,333 of the first 2,000 frames** at
   `60000/1001`: frame 1's exact deadline is 16,683,333.33 ns, `deadline_nanos` truncates to
   16,683,333, and `frame_at` of that is 0.99999998 → 0. Both functions round down. So `due` may lag by
   one and can never lead, `frame_at(deadline + 1)` is always the frame itself, and `target = next.max(due)`
   is what absorbs it. The assertion was replaced with those invariants rather than the round-trip, which
   was never true.
2. **`AE_FRAME_HISTORICAL` must be decided before the request lookup.** A frame the clock abandoned has no
   outstanding request, so the original ordering answered `AE_FRAME_UNREQUESTED` — "nobody asked for
   this" — about a frame that *was* asked for and merely arrived too late. Historical is now checked
   first. Its counter was also corrected: `abandon_before` owns the `missed` count, so a late arrival for
   an abandoned frame does **not** count a second miss. Otherwise the totals would claim more dropped
   frames than the clock dropped, and `CB4`'s classification and `PL4`'s policy would inherit the
   inflation.

**Verified, all scripted.** 96 lib tests (27 ingress cases covering every refusal, the counter totals
asserted as a whole struct, and a double-count guard) plus 9 integration tests in
`tests/ae_program_ingress.rs`: a 100-frame sweep where every presented descriptor's frame, evaluated time
and revision equal the request with `requested == ready_before_deadline == 100`; out-of-order, duplicate,
stale-revision and wrong-format refusals; an injected late completion counted without blocking the next
deadline; an unreturned request counted missed and its late arrival refused historical; a non-local
session unable to present at all; and a known premultiplied BGRA8 pattern round-tripped **byte-for-byte**
through `RecordingSink` — proving ingress, not NDI.

**The seam and the ring wiring landed, 2026-08-17.** Two pieces that were open are now written.

*Engine output seam.* `render_program_frame` takes a single early branch to `render_ae_program_frame`
when an AE source is installed, so the scene/GPU path below it is byte-for-byte the path it always was.
Staging is **one preallocated slab** reused across frames — a per-frame `Vec` at 59.94 would be sixty
~8 MB allocations a second, which is precisely what the card's "never an unbounded per-frame `Vec`"
forbids — replaced only when the negotiated geometry changes, and that replacement is counted. Egress
**fails closed**: every running output is checked against `validate_ndi_format`, `Bgra8`, premultiplied
alpha, sRGB, matching dimensions and a tight stride before a byte moves; a disagreement refuses with
`AE_REJECTED_FORMAT` and delivers nothing rather than pushing straight alpha into a pool that assumes
premultiplied bytes. **The lease is returned on every path** — accept, refuse and source error — because
the ring is a bounded resource and a leaked lease starves it.

*Adapter ring wiring.* `AE-F1` proved the ring but nothing in `adapter.cpp` referenced it: the evaluated
frame had no route in. `checkout` now takes an opt-in
`ring <renderRequestId> <dataRevision> <frameId> <presentationDeadlineNanos>`, lazily creating a
four-slot session-derived producer mapping, swizzling the **observed** ARGB8 premultiplied world into
BGRA8 in the lease, preserving AE's row stride, publishing the descriptor and emitting a correlated
`RENDER_READY`/`RENDER_FAILED`. Back-pressure is a reportable outcome, never an overwrite; every failed
lease is cancelled; `AEGP_CheckinFrame` still runs on every path. 16/32-bit worlds and any alpha mode
other than premultiplied are **refused, not relabelled** — finding C4 is why the descriptor reports the
layout observed and never the layout requested.

`build.sh` was also fixed: it never learned about `revision_apply.cpp` after `AE-CD2` factored the
rollback sequencing out, so the documented build failed to link with `LNK2019` on
`apply_revision_with_rollback`. It now compiles and links all four translation units and produces
`GrapiXRuntimeAdapter.aex` (254,464 bytes, SHA-256 `d9a3e2fceea2c0bbb397cc8346a12613a1746a77a0cb056268ea0ba4e440b942`).

**Verified:** 348 engine tests pass, including 14 in `tests/ae_program_ingress.rs` — an accepted frame
reaches a `RecordingSink` **byte-identically**, a format disagreement writes nothing, the lease is
returned on accept/refuse/error, and the staging slab does not reallocate across identical geometry. The
ring harness still passes 100,000 cycles with zero checksum faults, zero overwrites and zero allocations
after configure.

**The live gate passed on 2026-08-18.** The adapter was installed into AE 2026 through an administrator
prompt; the managed runtime fingerprint reported `faultInjection: null`; odd and even `BGRA` checkouts
returned **different pixel hashes** (`FBEAF731...`, `8121A2AD...`) while the stable `ARGB` request
reproduced the second hash exactly, so finding C4 remains true. A managed `LOWER_THIRD` frame 1 was then
evaluated at `800/23976`, published into
`Local\GrapiX-AeFrameRing-v1-ae-f2a-live-20260818`, and consumed by a new live Windows ring consumer in
`services/render-engine/src/ae_ring_source.rs` through `render_program_frame` into a running
`RecordingSink`. Evidence: [`AE-F2a-live-frame.json`](../ae-plugin/runtime-adapter/certification/AE-F2a-live-frame.json).

Two README runbook defects were found by execution and fixed in the evidence rather than assumed: ring
checkout requires all three optional render arguments, and the selector is a composition index, not a
name. The live path also exposed one genuine contract mismatch — the adapter publishes `sRGB`, while the
engine originally required exact `srgb`; egress now accepts `sRGB`/`srgb` case-insensitively.

**What remains open is narrower, and it is not this gate.** The live proof used `RecordingSink`, not NDI,
so hardware output readiness is unchanged. The live integration test is ignored by default because it
requires a managed AE runtime with a published ring frame.

**Status, 2026-08-18 — `AE-F2b` implemented and scripted-verified.**

**The lead is now a depth, not a longer sleep.** `AE-F2a` requested one frame period ahead and said
plainly that one period is the largest lead that cannot overlap the previous frame's request. That lead
cannot work: a period at `60000/1001` is 16.68 ms and `AE-F0` measured a checkout in the **tens of
milliseconds**, so a single-frame lead makes every frame late by construction. `src/ae_schedule.rs`
derives a depth from the target lead — 50 ms over a 16.68 ms period is **three frames** — and the clock's
wakeup is unchanged: it still wakes one period early, and each wakeup asks for every frame inside the
window, so a frame is requested three periods before its own deadline.

Depth is bounded twice, and both bounds are physical: `MAX_PIPELINE_DEPTH` of eight, and the ring's own
slot count, which `MappedAeProgramFrameSource` now reports so the engine can bound frames in flight to
`slots - 1` — one slot belongs to the publish in progress. A two-slot ring therefore yields a
single-frame pipeline, immediately rather than after the first back-pressure event.

**The policy is deliberately asymmetric, because pressure and lateness are opposite signals.**
Back-pressure or a genuinely full in-flight set means the pipeline is too *deep* for the ring, so the
depth drops one step. Late or missed frames mean it is too *shallow*; depth is already at its configured
maximum, so the only response is to stop the recovery streak — **never** to shrink, which would make a
late pipeline later. Recovery is one step per clean second against one step per pressure event, so a
pipeline settles a step shallow rather than oscillating.

**A data revision now supersedes work in flight.** With a real pipeline a `SET_PROPERTY`/revision change
lands while several frames are outstanding, all rendered against data that no longer applies. Those
requests are **rewritten, not dropped**: the frame stays outstanding at the new revision, so the render
already under way arrives against it and refuses `AE_STALE_REVISION`. Dropping them would have answered
`AE_FRAME_UNREQUESTED` about a frame that *was* requested — the same misdiagnosis `AE-F2a` removed from
the historical path.

**A defect the smoke test found, which no unit test would have.** Driving the real `ProgramClock`
against a producer that never delivers showed the clock abandoned outstanding requests **only when it
skipped frames**. A stalled After Effects with an otherwise punctual clock therefore never skipped, never
abandoned, and left the in-flight set full of requests that could never be presented: Program stopped
asking for frames permanently, and stayed stopped after the producer recovered. `issue_window` now drains
requests below the frame being presented first — they are misses, and ingress would refuse their renders
as historical anyway. That also sharpens the saturation signal: a full ring now means "full of work still
wanted", which is the only reading that should shrink the depth.

**Counters, for `PL4` and `CB4`.** `in_flight_saturated`, `revision_superseded`, `lead_depth_reduced` and
`lead_depth_restored` join the `AE-F2` set, and status grows an `aeProgram` block carrying the counters
**plus the depth in force, the configured depth and the ring capacity** — the counters alone cannot say
that a pipeline has settled a step shallow, which is exactly the state an operator's policy needs to see.
The block is absent entirely without an AE source, so a non-AE engine's status keeps its shape.

**Verified, all scripted.** 108 lib tests (10 new in `ae_schedule.rs` covering the depth arithmetic,
both bounds, the window's refusal to wrap at `u64::MAX`, and each policy transition) and 25 in
`tests/ae_program_ingress.rs`, including a 100-tick sweep proving each frame is asked for **once** and
exactly `depth - 1` ticks early with zero spurious saturation, the drain under a stalled producer, the
capacity guard, the revision supersession and its refusal, and one test that runs the **real
`ProgramClock`** for 200 ms to prove the wiring and the bound. The asymmetry claim was mutation-checked:
making lateness shrink the depth fails `late_frames_never_shrink_the_lead_depth`.

**Still open.** No live AE run exercised the pipeline: the deep-lead behaviour is proven against scripted
producers and the real clock, not against After Effects, and `AE-F3`'s 30-minute soak is where a real
completion-latency distribution meets it. Back-pressure is reported by the engine surface
(`note_ae_program_backpressure`) but nothing in the ring consumer calls it yet — the adapter reports a
refused publish on its own channel, and joining those is `AE-F3`'s wiring, not a claim this phase makes.

### AE-F3 · Frame-path POC soak

**Effort** 4–6 d + a 30-minute soak · **Blocked by** AE-F2, PL3, PL4, AE-CD3, AE-CD4 · **Unblocks** BO2, CB5

**Work.** Run §37's `LOWER_THIRD` at one pinned 1920×1080 rate (29.97 or 59.94, recorded exactly) and
exercise the §38 criteria the frame path can prove: CUE → TAKE(IN) → live `SCORE` revision → **declared
`PLAYER_IMAGE` replacement from a validated project asset (criterion 6)** → **`TEAM_COLOR` driving the
project's existing AE expression/effect through its declared control (criterion 7)** → OUT, with the
approved third-party plugin present and rendering in the fixture (**criterion 15**). Collect descriptors,
revisions, ring metrics and Program counters. Use virtual output or the deterministic `RecordingSink` for
evidence. Compare named reference frames before and after each mutation, including a soft-alpha region.
Inject one starvation event and verify the operator-visible result.

**Must not change.** No capture, no manual AE playback, no hidden raw-frame WebSocket. Nothing here
certifies NDI, DeckLink, AJA or any hardware profile. GrapiX does not translate the plugin — it must
render inside AE or the fixture fails.

**Exit gate.** Thirty consecutive minutes at the pinned rate through checkout → ring → Program →
virtual/recording, with frame counts, revision stamps and telemetry retained; every drop has an explicit
reason and there are zero unreported failures. Reference comparison passes at TAKE, after the `SCORE`
revision, after the image replacement, after the colour change, and at OUT — with the plugin's
contribution present in every compared frame. The starvation test stays bounded, becomes
operator-visible, and recovers without mapping growth or corruption.

**Status, 2026-08-18 — not started, and the rate in its own exit gate is now measured as unreachable.**
The soak was attempted and stopped at the first honest obstacle. Five things block it, four of them
phases and one of them arithmetic.

*Blocked by unstarted phases.* `PL3` (verb state machine — CUE/TAKE(IN)/OUT), `PL4` (the
operator-visible starvation result), `AE-CD3` (criterion 6's declared `PLAYER_IMAGE` replacement) and
`AE-CD4` (criterion 7's expression-control binding) have no status on their cards. Criterion 15 needs an
**approved licensed third-party plugin**, which `BO0a` still records as unprovisioned. So four of the six
§38 criteria in the Work above cannot be exercised at all, and `BO0a` already corrected the fixture truth
that `PLAYER_IMAGE` is an internal solid source rather than replaceable footage.

*Blocked by a missing request path, which is this track's own debt.* Nothing forwards an engine frame
request to After Effects. `request_ae_program_frames` is called by the Program clock and by tests, and
its result is discarded; the only way to make AE evaluate a frame is the **legacy file command channel**
(`send.sh checkout … ring …`). The runtime protocol has no render operation at all — `RENDER_READY` and
`RENDER_FAILED` are events with no request that causes them. This is memory rule 268 exactly: a live gate
needs a live consumer, and here the producer trigger is a test harness.

**Measured on the licensed host, 2026-08-18** (probe:
[`AE-F3-frame-path-probe.json`](../ae-plugin/runtime-adapter/certification/AE-F3-frame-path-probe.json),
[`AE-F3-ring-backpressure-probe.json`](../ae-plugin/runtime-adapter/certification/AE-F3-ring-backpressure-probe.json);
runner `tools/certification/ae-runtime-fixtures/ae-frame-path-probe.mjs`):

| Measurement | Value | Against a 29.97 gate |
| --- | --- | --- |
| Checkout round trip, 1920×1080, p50 | **46.5 ms** | 33.4 ms budget — over by 39% |
| Same, p95 / p99 / max over 300 frames | 50.2 / 64.3 / 79.3 ms | — |
| Sustained rate, steady frames only | **~21 fps** | **0.70× real time** |
| Ring-mode round trip, p50 | **81.7 ms** | **~12 fps, 0.41× real time** |
| Stalls over 300 frames | 2 exceeded a 5 s deadline | a 30-minute gate allows none unexplained |
| Payload written per frame | 8,294,400 B, unconditionally | **447 GB** for 30 minutes at 29.97 |

**The 46 ms is dispatch cadence, not rendering.** The same probe measured an *unknown verb* — no render,
no pixels, no file — at a p50 of 46.7 ms, indistinguishable from a full 1920×1080 checkout. The adapter
services **one command per idle callback**, and AE's idle callback is what sets that ~46 ms period, so
the frame path's ceiling is ~21 Hz regardless of what the command does. `AE-F2b`'s three-frame lead
cannot recover this: a deeper pipeline hides latency, and this is a throughput limit. AE's own render is
*fast* — `renderMs` reported 0 for every frame, because it is a `GetTickCount` delta and the render
finishes inside one 15.6 ms tick.

**Two live facts worth keeping.** The four-slot ring behaved exactly as `AE-F1` specified under a real
producer with no consumer attached: **4 published, then every later publish refused as back-pressure** —
no overwrite, no corruption, no mapping growth. And the checkout verb writes its full payload to disk
*before* the ring publish, unconditionally: 2.5 GB accumulated in 24 seconds of probing. The file and the
alpha statistics exist for `AE-F0`/`BO0a` one-shot comparison evidence and have no place in a soak.

**What this phase now owes, before the soak is attempted again.** A render request on the runtime
protocol and something that forwards the clock's requests to it; a ring-only checkout that skips the
payload file and the alpha statistics; more than one operation serviced per idle callback, or a different
trigger than the polled idle hook, since ~21 Hz is below every broadcast rate this project targets; and a
characterised answer for the multi-second stalls. Until the ceiling is above the pinned rate, "thirty
consecutive minutes at the pinned rate" is not a test that can pass, and pinning 29.97 rather than 59.94
does not rescue it.

**Throughput work, 2026-08-18 — the dispatch ceiling is lifted 8×, and it was two bugs, not one.**

*Both limits were structural, and the second one was invisible.* The reader loop enqueued a request and
then **waited for that request's completion before reading the next frame**, so only one operation could
ever be in flight no matter how many a client sent; and the idle hook serviced exactly one queued
request per callback. Either alone caps the protocol at one operation per callback.

*The callback period is now measured, not inferred.* `HEALTH` reports `idleTicks`,
`idleElapsedMicros`, `idleMaxGapMicros` and the batch bounds, from a `QueryPerformanceCounter` clock
because `GetTickCount`'s 15.6 ms tick is coarser than a frame budget — the same coarseness that makes
the adapter's `renderMs` report 0. Measured mean period: **46.9 ms**, stable across every run.

*Fixed.* The reader now enqueues and keeps reading; the idle hook drains a batch bounded twice, by
count (8) and by a wall-clock budget (24 ms), whichever trips first; leftover work waits for the next
callback. `GRAPIX_AE_IDLE_MAX_OPS` and `GRAPIX_AE_IDLE_BUDGET_MS` override both, so a sweep can be
measured without rebuilding the adapter mid-series and changing its hash.

| Client pipelining depth | Operations/second | p50 latency | Operations per callback |
| --- | --- | --- | --- |
| 1 | **21.3** | 46.3 ms | 1.00 |
| 4 | 85.3 | 47.0 ms | 3.92 |
| 8 | **170.6** | 47.0 ms | 7.84 |
| 16 | 170.7 | 93.0 ms | 7.69 |

Depth 1 reproduces the old ceiling **exactly** — 21.3 ops/s against the 21 fps the frame path measured,
which is the cross-check that the frame-path ceiling really was dispatch. Depth 8 is 8× that. Depth 16
adds only latency: throughput is flat and p50 doubles, because the per-callback bound is now the binding
constraint and the extra depth simply waits a second callback. Evidence:
[`AE-F3-dispatch-serial.json`](../ae-plugin/runtime-adapter/certification/AE-F3-dispatch-serial.json),
[`AE-F3-dispatch-batched.json`](../ae-plugin/runtime-adapter/certification/AE-F3-dispatch-batched.json);
runner `tools/certification/ae-runtime-fixtures/ae-pipe-throughput-probe.mjs`.

**A freeze this work caused, found, and fixed — worth more than the speedup.** Writing a reply from AE's
idle hook while the reader thread sat in a blocking `ReadFile` froze After Effects for **900 seconds**.
The pipe handle is *synchronous*, and Windows serialises I/O on a synchronous file object: the write
queued behind a read that could only complete once the client received that very reply. The measured
`idleMaxGapMicros` of 899,992,220 is that deadlock, and the counters added to `HEALTH`
(`pipeAccepted`/`pipeServiced`/`pipePending`) are what attributed it — they showed the request accepted
**and serviced**, so the loss was in the write, not the work. Now exactly one thread performs pipe I/O:
`write_serialized` queues an envelope, the connection thread flushes the queue, and it polls for input
with `PeekNamedPipe` instead of parking in a read. **This also removes a latent freeze that predates
this phase**: `emit_event` — `RENDER_READY`/`RENDER_FAILED` — was already written from the idle hook and
would have hit the same deadlock whenever the reader was idle in a read.

**What the 8× does and does not buy.** It lifts *dispatch*, proven with `HEALTH`. A 1080p render is
~15 ms, so the 24 ms budget admits one or two renders per 46.9 ms callback — roughly 21–42 fps — and
59.94 needs about three, i.e. a ~45 ms budget against a 46.9 ms callback, which is close to a full duty
cycle on AE's own thread. Whether that is acceptable is a measurement this phase still owes, and it
needs the protocol render request to make it, because the legacy file channel carries one command at a
time and cannot pipeline at all. Also still owed: the payload write and per-pixel alpha statistics must
become opt-in, and a ring consumer must drain slots or the producer back-pressures after four frames.

**`RENDER_FRAME` lands, and the frame path now exceeds 29.97 with headroom, 2026-08-18.**

*The request exists.* `RENDER_FRAME` is on the runtime protocol at major 2, so `RENDER_READY` and
`RENDER_FAILED` finally answer a request rather than being events nothing could cause. It addresses the
composition by **stable item id** (an index moves when a project is reordered and names repeat across a
fixture corpus), carries the instant as an **exact rational** validated against that composition's own
frame duration — off-frame is refused `TIME_NOT_REPRESENTABLE`, cross-multiplied so `800/23976` and
`100/2997` are one instant — and it **writes no payload file and computes no alpha statistics**. It shares
`do_checkout`'s proven implementation rather than duplicating it: one `write_payload` parameter and an
`id:` selector, so the ring publish, the observed-layout rule (`AE-F0` C4) and the refusal of any world
that is not 8-bit premultiplied ARGB stay in one place.

*The consumer exists.* `services/render-engine/src/bin/ae-ring-drain.rs` opens the mapping, releases
every ready frame and reports rate, sequence gaps and errors. Without it a four-slot ring refuses after
four frames and any rate measured is the refusal path, not the frame path — which is exactly what the
first run of this probe measured before the drain worked.

| Client pipelining depth | Frames/second at 1920×1080 | Against 29.97 | Against 59.94 | p50 | Frames per callback | Ring back-pressure |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 21.3 | 0.71× | 0.36× | 46.8 ms | 0.99 | 0 |
| **4** | **63.6** | **2.12×** | **1.06×** | 57.5 ms | 2.94 | 0 |
| 8 | 63.6 | 2.12× | 1.06× | 129.8 ms | 2.94 | 0 |

Every frame published: **300 of 300 at every depth, zero back-pressure**. Depth 1 reproduces the old
ceiling exactly for the third time. Depth 4 is the knee — depth 8 adds only queueing latency, so four
frames in flight is the right pipeline depth, one more than `AE-F2b`'s ring-capacity bound of three.

**Per-frame render cost, finally visible.** 2.94 frames per 46.9 ms callback is **~8 ms per 1920×1080
frame** — a number the adapter could never report, because `renderMs` is a `GetTickCount` delta and 8 ms
rounds to 0 on a 15.6 ms tick. The **24 ms callback budget is now the limiter**, not AE: three renders
fill it. Raising it is the next lever and it is a deliberate trade against AE's own thread occupancy —
`GRAPIX_AE_IDLE_BUDGET_MS` exists for exactly that sweep, and the arithmetic says ~45 ms would buy ~110
fps at the cost of a near-full duty cycle.

**The payload opt-out, verified by side effect.** 900 renders through `RENDER_FRAME` left the adapter's
state directory at **864 KB**. Twenty-four seconds of the legacy `checkout` path wrote **2.5 GB**.

**Two findings from the measurement itself.** A **debug** build of the consumer was the bottleneck at
first — 33 of 300 frames published — because verifying an 8.29 MB FNV checksum per frame unoptimised
costs more than the render; the release build drained 300 of 300. Measure a consumer in release or
measure the compiler. And a consumer killed rather than stopped **strands its owner claim** on the
mapping until the session ends, which is the single-consumer guard working as designed but worth knowing
before it looks like a bug.

**Where this leaves the soak.** At the default budget the frame path sustains 29.97 at 2.12× and 59.94 at
1.06× — so a pinned 29.97 soak is arithmetically possible; the sweep below lifts 59.94 to 1.41× and finds
the ceiling that stops it there. What still blocks `AE-F3`'s gate is
unchanged and not throughput: `PL3`, `PL4`, `AE-CD3` and `AE-CD4` are unstarted, criterion 15's licensed
plugin is unprovisioned, and nothing yet joins the engine's `request_ae_program_frames` to this new
operation — the probe is a harness, not the production requester. The multi-second stalls seen through
the legacy channel have not recurred over 900 protocol renders, but they are not explained either.

**The budget sweep, 2026-08-18: 59.94 gains headroom, and then the render itself stops it.**

Sweeping `GRAPIX_AE_IDLE_BUDGET_MS` and `GRAPIX_AE_IDLE_MAX_OPS` — env, not compile-time, precisely so
the adapter hash (`b5e6c79c…`) stays identical across the whole series. Every point is 1920×1080
`LOWER_THIRD`, every frame published into the ring and drained.

| Budget / max ops | Frames per callback | Callback period | fps | ×29.97 | ×59.94 | p50 | Worst gap |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 24 ms / 8 (default) | 2.94 | 46.9 ms | 63.6 | 2.12× | 1.06× | 57.5 ms | — |
| **45 ms / 16** | **5.02** | **59.6 ms** | **84.6** | **2.82×** | **1.41×** | 81 ms | 91.9 ms |
| 200 ms / 32 | 20.0 | 226.6 ms | 88.6 | 2.96× | 1.48× | 184–357 ms | 236.7 ms |

**The answer is yes, with a ceiling: 1.06× → 1.41× of 59.94, and no budget beats ~1.48×.** The sweep
exposes why, and it corrects an earlier estimate on this card. Callback period behaves as
`max(AE's own ~47 ms idle cadence, batch × per-frame cost)`. Below the floor, batching is free — it
recovers idle time AE was going to spend sleeping. Above it, **the batch *becomes* the clock**, and
throughput converges on `1 / per-frame cost` no matter how large the budget is.

**So the real per-frame cost is ~11.3 ms, not the ~8 ms this card previously inferred** — that figure
divided by a period which still contained AE's idle floor. Taken from the marginal slope between points
(`(226.6 − 59.6) / (20.0 − 5.02)`), it puts the frame path's hard ceiling on this host at **~88 fps**.

**45 ms / 16 is the operating point.** It captures **95%** of the asymptote (84.6 of 88.6) at a 59.6 ms
callback period. The 200 ms point buys the last 5% for a **3.8× worse period** and 2–4× worse latency:
After Effects still reports `Responding=True` under sustained load, but that flag only proves the absence
of a hang — a 226 ms callback occupancy means any UI interaction stutters at ~4 Hz. Throughput bought by
making the host unusable is not throughput a broadcast operator can accept.

**Two consequences worth stating.** First, **59.94 with real headroom is not reachable by tuning** — it
needs a cheaper frame (smaller raster, fewer effects) or parallel AE instances, because 11.3 ms per frame
against a 16.68 ms period leaves 1.48×, full stop. Second, at 84.6 fps the **four-slot ring became the
next constraint**: 31 of 1200 frames back-pressured (2.6%), because four slots is 47 ms of buffer at that
rate and the drain polls at 500 µs. A soak demanding zero unreported failures needs more slots or a
consumer that blocks rather than polls.

**Superseded by the adoption below.** These points were measured through environment overrides so this
binary's hash held across the whole series; the pass that follows made 45 ms / 16 the compiled default.
Sweep evidence:
[`AE-F3-budget-45ms.json`](../ae-plugin/runtime-adapter/certification/AE-F3-budget-45ms.json).

**Adopted as the default, and re-certified, 2026-08-18.** `kDefaultIdleServiceBudgetMicros` is now
45 000 µs and `kDefaultMaxRequestsPerIdleCallback` is 16, with the sweep table written into the source as
the justification. New adapter hash **`a24f2b1b…`** (was `b5e6c79c…`). Both stay env-overridable.

*The default landed, proven not assumed.* `HEALTH` reports `idleBudgetMicros: 45000` and
`idleMaxOpsPerCallback: 16` with **no environment override present**.

*Behaviour-neutral except for throughput,* re-run live against the new binary:

| Re-run | Result |
| --- | --- |
| Declared surface (`AE-A3`) | `setTime` quantised → `TIME_NOT_REPRESENTABLE`, `800/23976` exact round trip, `0/30000` accepted, negative → `INVALID_PAYLOAD`, footage replacement → `OPERATION_UNSUPPORTED` |
| Revision (`AE-CD2`) | revision 1, two targets applied together (71/62), `rolledBack: false`, bad member refused, both restored |
| Discovery | `SET_PROPERTY` accepted, bad payload → `INVALID_PAYLOAD`, value restored |
| Edge corpus, all 7 cases | **`premul diff=0`** — the premultiplied pixel path is byte-identical |
| Throughput at the new default | **83.98 fps**, 2.80× of 29.97, **1.40× of 59.94**, 4.98 frames per 59.5 ms callback, 1184/1200 published |

`AE-A3-declared-surface.json` and `AE-CD2-revision.json` were regenerated from the certified binary;
`AE-F3-recert-default.json` is the throughput record. The 83.98 fps default reproduces the 84.6 fps
environment-override point within 0.7%, so adoption cost nothing.

**Blocked, and not by this change: the `LOWER_THIRD` pixel comparison.** `compare-lower-third.mjs` refused
on `fixture digest mismatch` — the pinned `.aep` had drifted (`903406290b…` → `5415da2500…`, mtime during
this session) and no pristine copy exists on disk or in git, because the fixtures directory is untracked.
Re-pinning the current bytes was tried and **reverted**, because it fails the check that matters: frame 0
differs from its recorded reference by **221 745 pixels at max channel delta 255** against a zero
tolerance. The cause is visible in the evidence — the live `SCORE` control now reads **100** where the
authored baseline recorded **042**, so control values have been persisted away from the authored state.
The only writer of that file is the adapter's `fixture` verb via `AEGP_SaveProjectToPath`;
`supervise.sh quit` never saves and `ae-window.ps1` sends only `WM_CLOSE`, which on a save prompt means
Cancel — so the write came through an authoring path, not the supervisor.

Repair is therefore re-authoring the fixture **and** re-recording its baseline reference frame, which is a
separate decision from this pass. The drifted file is kept at `.tmp-fixture-backup/`. What still passed
meanwhile: the composition clock (`800/23976`), `PLAYER_NAME`, `SCORE`, `TEAM_COLOR` and the dependency
live-report — three of four controls, exactly the standing `BO0a` status.

**One harness bug fixed on the way.** The cue-map check compared `JSON.stringify(resolvedCues)` against
the pinned array, making **key order** a contract: the resolver emits `compositionTime` last, the pinned
array carries it third, and every value was identical — `cueMap.digest` matched exactly. It now compares a
recursively key-sorted canonical form, so a new field on a resolved cue can no longer fail certification
for a cosmetic reason while the authoritative digest agrees.

**Acceptance pass on the shipped build, 2026-08-18.** Re-run end to end against the installed
`a24f2b1b` adapter after building both desktop applications (engine sidecars hash `c06bc9f0` inside both
bundles; the packaged Editor launches, supervises the engine and opens 4400). Lifecycle reports the
adopted default (45 000 µs / 16); the frame path gives **21.32 fps at depth 1 and 88.70 fps at depth 8**
(2.96× of 29.97, **1.48× of 59.94**, 300/300 published, zero back-pressure, `payloadWritten: false`);
declared surface, revision and discovery reproduce every recorded acceptance and refusal; the alpha edge
corpus passes 7/7 at `premul diff=0`. Across three sessions the envelope is **84–89 fps**, converging on
the ~88 fps asymptote.

**One thing this pass settles about the damaged fixture.** After 600 `RENDER_FRAME`s, property writes,
`SET_TIME`, two data revisions and two clean quits, `lower-third.aep` is **byte-identical, with an
unchanged mtime**. No runtime path persists to disk, so the `fixture` authoring verb is the only remaining
writer — the property and render paths are cleared by measurement rather than by reading the code.

**The engine now asks. `request_ae_program_frames` reaches `RENDER_FRAME`, 2026-08-18.**

The schedule had been a ledger nobody posted: `AE-F2b` computed exactly which frames Program needed and
how long each had, `program.rs` logged the answer, and the only code that ever asked After Effects to
render was a harness driving the legacy file channel by hand. `services/render-engine/src/ae_runtime_client.rs`
closes it.

*Shape.* A Windows named-pipe client for `\\.\pipe\grapix-ae-runtime-<session>` with the `hello`
handshake, and one I/O thread that **pipelines** - requests written as they arrive, replies matched by
`requestId` afterwards. Serialising here would have handed back the whole dispatch fix (21.3 fps against
88.7). Two invariants hold it in place: `submit` is a channel send, because a request that waits for
After Effects has already missed the deadline it was scheduling for; and the thread never touches the
engine mutex, so ring back-pressure returns as `feedback` that the clock drains on a tick it already
holds the lock for, leaving `AE-F2b`'s lead-depth policy in charge.

*Wired at the source, not at the caller.* `Engine::send_ae_program_requests` is the single place a
scheduled frame becomes wire traffic, so the lead window, a single frame, **and** the re-requests a data
revision invalidates are all carried - not just the one path the clock happens to call.

*Proven live, end to end.* The `AE-F2a` gate no longer has its frame pushed in from outside. It connects
the engine's own requester, asks for frame 1, and the frame comes back: one real After Effects render
reaching `RecordingSink` byte-identically, `1920×1080×4` bytes, `ready_before_deadline: 1`. Nothing
external drives After Effects in that test any more.

**Two faults the live run found that no fake would have.**

1. **`DUPLICATE_REQUEST`.** The first idempotency key was `frame-<n>-rev-<r>`, which reads as correct and
   is wrong: the adapter remembers accepted keys for the life of the After Effects session, so a
   *restarted engine* asking for frame 1 again is deduplicated and the frame is never rendered. Keys are
   now scoped by a per-run id. At-most-once *within* a run remains the schedule's guarantee.
2. **`INVALID_PAYLOAD`.** The adapter's own parsers are asymmetric - `frameId` is read with
   `runtime_payload_integer` and `presentationDeadlineNanos` with `runtime_payload_string` - so the frame
   id must cross bare and the deadline quoted. Sending both quoted, which looked more consistent, is
   refused.

*And one measurement the wiring made visible.* The gate previously asserted punctuality with **one**
frame period of lead. That is arithmetically impossible now that the engine really waits for After
Effects: the idle callback's own period is ~46.9 ms against 33.4 ms at 29.97. The test asks four periods
ahead - `AE-F3`'s measured knee - and is punctual there.

**Verification.** 10 unit tests on the envelope, payload, identity and framing; 7 integration tests
against a real named-pipe server standing where the adapter would (handshake, pipelined sequence
`1..8`, replies counted apart from events, ring refusal reported as back-pressure rather than a render
failure, bounded queue dropping rather than hoarding stale frames, and a missing adapter refused instead
of a half-live requester); plus the live gate. Engine lib tests 108 → 118.

**Who installs the requester — answered by the `LOAD` verb below.** When this section was written the
live gate and the drain binary were the only things that constructed a requester; attaching a container
is `PL3`'s work, and its `LOAD` half now exists.

**`PL3` · the container `LOAD` verb: a running engine attaches the frame path itself, 2026-08-18.**

The requester existed and nothing in a running engine installed it — only the live gate and the drain
binary did, which is a mechanism with no owner. `ae.container.load` / `ae.container.unload` are now on the
engine protocol, and they perform the only sequence the adapter permits:

1. install ingress with the negotiated geometry and the composition's own clock;
2. connect the requester, so scheduled frames have somewhere to go;
3. ask for **one warm-up frame** — the adapter creates its ring mapping lazily, on first publish, so
   there is nothing to open until a frame has been requested;
4. open that mapping as the frame source, bounded by a deadline.

**Success therefore means attached *and proven*, not configured.** A failure at any step detaches
everything before returning: a Program that believes it has an AE source and silently never asks for a
frame is the fault this whole track exists to remove, and a half-installed container is exactly that.

*Authority.* Playout-only on the role matrix — attaching a container is an operations act, never
authoring, and the Editor link holds no session token. Classified `OutputManage` in
`permission_for_request`: it decides where Program's pixels may come from, so it is output management
rather than `PlayoutProgram`, which would imply putting something on air. The engine's unclassified-verb
guard caught this during development and refused the verb until it was classified — the authority hole it
exists to prevent, working.

*The session token* arrives in the payload because Playout launched the host and owns it, and is never
echoed into the ack, the audit record or a log line. The live test asserts the ack does not contain it.

**Proven live.** One `ae.container.load` against a licensed host: `ringSlots: 4` (which only exists
because the warm-up frame was really published), `stride: 7680`, `warmUpRequested: true`, then
`render_program_frame` delivered a real 1920×1080×4 After Effects frame into `RecordingSink`, and
`ae.container.unload` released the pipe and the ring consumer. Nothing in that test installs ingress,
opens a ring, or connects a requester by hand.

**Verification.** Five new tests: the verbs parse and group for audit (including that adding them did not
displace `output.configure` in the parse table — it did, once); Playout-only authority; the payload
contract, including a composition clock that cannot carry the engine's Program rate; a load that cannot
reach the adapter leaving **nothing** attached; and an unload that is honest rather than an error when
nothing was attached. Plus the live gate. `ae_program_ingress` 26 → 30 tests, 2 ignored live.

**Operational note.** The two live gates each claim the ring's single consumer slot, so the ignored set
must run with `--test-threads=1`; both `#[ignore]` reasons say so.

**What `PL3` still owes.** This is the `LOAD` half only. The verb state machine — `CUE`, `TAKE`,
`CONTINUE`, `CLEAR`, Preview/Program isolation, the rundown and the discriminated AE-container record in
Playout's target model with its digests, revisions and audit identity — is not started. Playout also does
not yet *call* this verb: its controller has no AE-container target, so the caller today is a test.

---

## 10. Track AE-CD — container, controls, data

### AE-CD0 · Managed container sidecar

**Effort** 4–6 d · **Blocked by** CB0 · **Unblocks** AE-CD1, PL2

**Work.** Add `Shared/ae-runtime-contract/src/container.ts` for `AeRuntimeContainer`, profile, selected
compositions, status, project URI/digest, cache policy and schema version, with a root-relative
`projectUri` — never a client absolute path. Extend `project-api/src/storage.ts` with an allowlisted
AE-project-root resolver plus per-container locks, and persist
`.grapix/ae-runtime/<container-id>/container.json` beside the `.aep`, which stays authoritative and is
SHA-256 hashed. Guard the create/read/update/list routes with `requirePermission(..., "scene.write")`.

**Must not change.** The `.aep` is never rewritten, embedded or converted; no caller submits an
arbitrary path, script or property write.

**Exit gate.** A fixture container survives an API restart with identical id, root-relative URI, digest
and composition ids; traversal and changed-digest sources return typed refusals
(`PROJECT_DIGEST_MISMATCH`) without creating an external sidecar.

### AE-CD1 · Declared controls and stable targets

**Effort** 7–10 d · **Blocked by** AE-CD0, AE-A3 · **Unblocks** AE-CD2–AE-CD4, AE-F2, PL2

**Work.** Add `AeDynamicControl`, `AeLayerRef`, canonical property segments, validation, update policy
and lifecycle (`active | stale | rebind-required | disabled`), with persistent UUID control ids. Map
adapter descriptors to AE composition/item/layer identity plus canonical match-name path and ordinal;
keep a structural fingerprint for diagnosis only and **never** fall back to display names. Add authoring
control routes guarded by `scene.write`, and centralize write validation — declared target, `writable`,
authorized caller, valid value, allowed policy — returning `CONTROL_UNDECLARED`, `CONTROL_READ_ONLY`,
`CONTROL_VALIDATION_FAILED` or `CONTROL_TARGET_STALE` before dispatch. Register a dedicated controls
panel; do not put AE controls in `PropertiesSidebar.tsx`, which is scene-object binding UI.

**Exit gate.** On a real fixture a declared text control survives layer rename plus GrapiX and AE
restart under the same control id; duplicating the layer does not hijack the original binding; an
authenticated undeclared, read-only or out-of-policy write is rejected with the adapter observing no set
call.

### AE-CD2 · Revisioned atomic application and audit

**Effort** 8–12 d · **Blocked by** AE-CD1, AE-A3 · **Unblocks** AE-F2, PL3

**Status, 2026-08-13: implemented, with one named gap.** `APPLY_DATA_REVISION` is a closed-protocol
operation the adapter applies in three phases — parse and range-check, resolve and prove every member
writable while capturing its prior value, then write inside one undo group — so a mid-batch failure
restores every already-written member. `AeDataRevisionTracker` persists the accepted revision per
container and writes it only after the adapter reports the whole batch applied, so a crash re-offers the
same revision rather than skipping one. `AuditLog.reserve` claims `members + 1` records before dispatch
and refuses the revision when the sink cannot promise them.

Live on AE 26.3 with `lower-third.aep`: layers 21 and 20 moved `100 → 71` and `100 → 62` in **one**
call with both values read back; a batch whose second member was out of range refused `INVALID_PAYLOAD`
and a batch naming a non-existent layer refused `TARGET_NOT_FOUND`, each leaving **both** layers at
`71/62` — so a bad member costs no AE mutation at all, including for the members that were valid. The
fixture was restored to `100/100` and discarded on shutdown. Evidence:
[`ae-plugin/runtime-adapter/certification/AE-CD2-revision.json`](../ae-plugin/runtime-adapter/certification/AE-CD2-revision.json).

**The gap.** The C++ rollback path is implemented and its refusal is handled end to end, but it has not
been *triggered* live: phase 2 rejects keyframed and expression-driven streams up front, so a validated
numeric stream has no available way to fail `AEGP_SetStreamValue` mid-batch on this fixture. Forcing it
needs either a stream class that validates and then refuses, or a second writable kind from AE-A3's
wider matrix. Until then "rollback works" is a code claim, not a measured one.

**Gap addressed 2026-08-17 — the sequence is measured; the live trigger is still owed.** The gap named
two remedies, and investigating them produced a third answer: **no validated member on this fixture can
fail its write, because phase 2 is deliberately thorough.** Every kind is gated on a cheap total query —
`AEGP_GetLayerObjectType` for text, an effect walk for colour — before a stream is ever acquired. That is
a property worth keeping, not a hole to open, so hunting for a stream class that validates and then
refuses was the wrong shape of answer.

Instead the sequencing was **factored out of After Effects** into `src/revision_apply.{h,cpp}`
(`apply_revision_with_rollback`), which `runtime_apply_data_revision` now calls with two AE-aware
lambdas. The write/rollback order is pure bookkeeping and needs no SDK, so
`revision_rollback_harness.cpp` drives the *same code production runs* under injected faults with no AE
present — the `AE-F1` ring harness pattern. Ten cases pass, including a 1,000-batch sweep with the
failure index moved across the batch (4,500 write and 3,500 restore calls observed): writes run forward;
already-written members restore in **reverse and exactly once**; the member that failed and those never
reached are never restored; a failing restore **does not abandon the remaining restores**, because
stopping would widen the mixed state rather than limit it; the original write's failure code survives the
rollback's own report; and any restore failure degrades the outcome away from a clean rollback. The
harness is falsifying, not decorative — reversing the restore order on purpose fails six of its ten cases
and exits non-zero.

**A mixed state now has a name.** Rule 238 already refused to report a failed restore as a clean
rollback, degrading it to `AE_ERROR` — correct, but it left the worst outcome wearing the same code as
any routine refusal, and it captured the restore's own error code into a local and threw it away. The new
`REVISION_ROLLBACK_FAILED` travels from the adapter through `AeRuntimeErrorCode` and
`AeDataRevisionRefusalCode` to an operator message that says the project holds a mixed state and that no
retry is safe until a human inspects it. The accepted revision still does not advance. This refines rule
238 rather than reversing it.

**The live trigger, and how it stays honest.** `GRAPIX_AE_RUNTIME_FAULT_INJECT_REVISION_WRITE=<index>`
forces the Nth write of the next revision to fail — once, then disarms — so the restore path runs against
**real** AE values with a real read-back, and only the *cause* is synthetic. Because an adapter that can
be told to fail is a liability, an armed adapter reports `faultInjection` in its HELLO fingerprint, and
`compare-lower-third.mjs` now refuses to record evidence when that field is non-null **or absent** — an
adapter predating the field is unknown, and equally not evidence. An injected run measures the recovery
path; it never certifies the product.

**Still owed.** Everything above is compiled and, for the harness, executed — but no injected revision
has yet run on the licensed AE 26.3 host. Until it has, "AE restores real values" remains a design claim.
That single experiment is what closes this gap, and it now has an exact procedure instead of a search.

Two smaller findings. `data.revision` had to join the adapter's advertised capability set or a client
negotiating it is refused `CAPABILITY_MISSING` before any request — capability lists are two-sided, and
adding a protocol operation without adding its capability yields a HELLO that fails for the exact
clients the operation was added for. And `runtime_property_target_json` wrote `sourceItemId: 0` for a
layer with no footage source while `LIST_LAYERS` rendered the same fact as `null`; both now say `null`,
which is what the contract types.

**Work.** Reuse — do not fork — `SceneDocument.dataContext`, `BindingMap`, `resolveDataPath()`,
`applyBindings()` and the `propertySource.ts` precedence diagnostics; add generic `controlId + dataPath`
bindings. Add a durable `DataRevisionTracker` with base revision, idempotency key, retry
acknowledgement, gap/conflict refusal and monotonic commit only after validation — modelled on, not
overloaded onto, the scene revision tracker. Implement one apply service that resolves the full
snapshot, validates every binding first, issues one `APPLY_DATA_REVISION`, then persists the accepted
revision. Extend the audit contract with closed `ae-runtime.*` actions carrying
container/composition/revision, reserving audit capacity before dispatch and failing closed if a
required record cannot be accepted.

**Must not change.** No revision partially mutates AE or advances on failure; audit carries no raw
context, credentials, media or expression source; no verb authority is added.

**Exit gate.** A multi-control snapshot produces exactly one accepted revision, and an idempotent retry
neither re-applies nor increments. A bad, read-only or undeclared member rejects the whole batch before
any AE mutation. After flush, audit holds one record per changed control with actor, source and accepted
revision — and rejected attempts are recorded too.

### AE-CD3 · Cost classes, preload and safe media replacement

**Effort** 6–9 d · **Blocked by** AE-CD1, AE-A3 · **Unblocks** POC image replacement, BO4

**Work.** Add `updateClass: "fast" | "preload-required" | "structural-forbidden"` with reasons. Fast is
only adapter-proven text/numeric/colour/boolean/transform, selected effect and expression inputs, and
declared image replacement. Structure, layer, renderer, resolution, effect topology, font and expression
rewrites are forbidden. Large media requires a preload readiness token with expiry. Build eligibility on
the existing stored-asset reads and asset validation, extended by a real media probe — today's
`inspectMediaImport()` reports unknown alpha/colour and no dimensions and cannot establish
compatibility. Resolve asset id → project store → adapter-scoped handle with checksum; never a client
URL or path. On adapter failure, restore the prior binding and audit it.

**Exit gate.** A real fixture replacement receives a validated project-store handle, not a caller path;
invalid or un-preloaded replacements make no adapter call; a forced failure restores the previous
binding and writes a failure record.

### AE-CD4 · Authoring methods and dependency preflight

**Effort** 5–8 d · **Blocked by** AE-CD1, AE-A3 · **Unblocks** PL4, authoring guidance

**Work.** Support §10 Method A (declare a supported discovered property) and Method B (bind existing AE
Slider/Color/Checkbox/Point/Dropdown expression controls), binding only safe inputs — never expression
source or dependents. Add read-only dependency types: expression presence and enabled state, input
refs, AE/runtime/profile digests, renderer, plugins/effects and versions, fonts and substitution,
missing media, reported colour/output mismatch. Wire a load-time preflight report through the API, and
persist its timestamp/fingerprint in the sidecar.

**Must not change.** GrapiX never rewrites or evaluates expressions; AE owns font shaping and colour
management; plugin and font installation stay outside runtime control; dependencies are never silently
disabled.

**Exit gate.** Method B updates a Slider/Color control while the authored expression bytes are verified
unchanged; missing font, plugin and media plus a renderer/colour mismatch appear by name in a read-only
report with no repair route and no certification claim.

---

## 11. Track PL — playout and operator surface

### PL1 · Declared cues and exact time

**Effort** 6–8 d · **Blocked by** AE-A3, AE-CD1 · **Unblocks** PL3, AE-F2, PL4

**Work.** Add persisted AE cue types beside `RationalFrameRate`/`SceneTimelineMarker`, with `AeExactTime`
as a non-negative rational carrying no float. Define the marker grammar in a new
`Shared/animation-engine/src/aeCueMap.ts`: accept only complete, unique declared `GRAPIX:` markers —
`CUE`, `IN`, `HOLD`, named/numbered `CONTINUE`, optional `UPDATE`, `OUT`, `END` — and reject duplicate
roles, non-monotonic times, an `OUT` without a later `END`, and any cue that cannot map exactly to a
Program frame. Fix the mapping once: for AE time `n/d` and rate `p/q`, `F = n·p/(d·q)` must be an exact
non-negative integer and its deadline is `F·10^9·q/p`, in integer arithmetic. Use
`Shared/animation-engine/src/clock.ts` as the TypeScript reference and mirror it in
`render-engine/src/stage.rs::FrameRate::deadline_nanos`, landing both sides together. Resolve cues at
the Playout boundary into adapter `SET_TIME` requests carrying container id, composition, project digest,
cue-map digest, exact time, Program frame/rate and deadline.

**Must not change.** Native marker playback and published-scene take behaviour stay byte-for-byte
compatible. A marker-free or invalid project is never promoted into a guessed state machine, and
arbitrary marker text never becomes control state.

**Exit gate.** A fixture at `60000/1001` resolves CUE → IN → HOLD → CONTINUE:1 → OUT → END to identical
TypeScript and Rust rational frame/deadline vectors; a test adapter records the same `SET_TIME` values;
an off-frame marker is refused before CUE. Vectors also cover 25 and `30000/1001` and a one-hour
absolute-deadline run.

**Status, 2026-08-13: Implemented and code-level proven.** `aeCueMap` rejects malformed, incomplete,
duplicate, non-monotonic and off-frame declarations; the shared JSON fixture is consumed by both Node
and Rust and proves CUE → IN → HOLD → CONTINUE:1 → OUT → END at `60000/1001`, plus 25,
`30000/1001`, and the 59.94 one-hour absolute deadline. `clock.ts` now delegates to the shared bigint
reference, correcting the measured `Math.round` divergence (33,333 of the first 100,000 frames at
`60000/1001`). Targeted Node tests prove the digest-pinned `SET_TIME` payload through the supervisor,
and `cargo test -p grapix-render-engine stage` passes.

**Live `SET_TIME`, 2026-08-13 — and the finding it produced.** The adapter now implements `SET_TIME`
via `AEGP_SetItemCurrentTime` and reads the instant back, and the round trip immediately refuted the
assumption underneath it: asking `LOWER_THIRD` for `1001/30000` returned `800/23976`, because AE holds
time in the *item's own* scale and this composition's scale is `23976` — exactly `29.97`, not
`30000/1001`. Cross-multiplied the two differ (`1001×23976 = 23999976` against `800×30000 =
24000000`), so the requested instant is not representable and the adapter now refuses it as
`TIME_NOT_REPRESENTABLE` rather than parking a cue on a neighbouring frame. The same frame stated in
the composition's own scale (`800/23976`) is accepted with an exact round trip, `0/30000` is accepted,
and a negative time refuses as `INVALID_PAYLOAD`. Evidence:
[`ae-plugin/runtime-adapter/certification/AE-A3-declared-surface.json`](../ae-plugin/runtime-adapter/certification/AE-A3-declared-surface.json).

**Gap closed, 2026-08-17 — cue resolution states cues in the composition's scale.** Of the two routes
the second was taken. Re-authoring the fixture would have made one fixture pass and left every real
`29.97` composition to fail at air time, and the project file is authoritative (§5): GrapiX must read
the composition's clock, not assert it.

`Shared/shared-types/src/aeTime.ts` gained the composition clock as an exact rational —
`AeCompositionClock {frameDuration, timeScale}`, taken from `AEGP_GetCompFrameDuration` and never from
`AEGP_GetCompFramerate`, which is an `A_FpLong` that cannot distinguish `2997/100` from `30000/1001`.
The reconciliation is `reconcileAeCompositionClock`: a composition's exact rate is
`timeScale/frameDuration`, and it must equal the declared Program rate. That proof collapses the whole
problem, because once the two are the same rational `timeScale = k·numerator` and
`frameDuration = k·denominator`, so Program frame `F` sits at exactly `F·frameDuration` in the
composition's scale — an integer for every `F`. A rate the scale cannot carry therefore condemns
*every* cue, not one of them, so it is refused once at load instead of per cue at air time.

`resolveAeCueMap(markers, rate, clock?)` reconciles first and then carries `compositionTime` on every
cue; `AeRuntimeComposition` now *requires* the clock, and `AeCueService` proves the recorded clock
against the container's composition, refuses `RATE_NOT_IN_COMPOSITION_SCALE` **before** any adapter
call, and sends the composition-scale instant while retaining the declared one for audit. The refusal
now precedes AE mutation rather than being discovered from AE's read-back. The cue-map digest covers
the clock, so a composition re-authored at another scale invalidates every recorded pin instead of
resolving identically against a different clock. `render-engine/src/stage.rs` mirrors the arithmetic
and both sides consume the same vectors in
`Shared/animation-engine/fixtures/ae-cue-vectors.json` (`compositionClocks`, `compositionRefusals`,
`compositionScaleRestatements`), which reproduce the measured round trip exactly: `1001/30000` refuses,
`800/23976` is composition frame 1, `0/30000` restates to `0/23976`.

The pinned fixture stopped asserting a rate nobody measured. `lower-third.json` now records the
measured clock `800/23976` and its true rate `2997/100`; its markers are restated at composition-frame
instants (`0, 800, …, 4800` in scale `23976`) and its cue-map digest is
`f69ad7e1abf6e1f9b67c445a89a32a832df4c43f635ed61d5998742883412824`. Resolutions that supply no clock
keep their previous canonical form and digest, so every existing pin is unaffected.

**The adapter now reports the clock, compiled not executed.** `runtime_list_compositions` emitted only
`AEGP_GetCompFramerate`, an `A_FpLong`, so the composition's own scale never reached TypeScript and the
manifest's measured value was the sole source. It now also emits
`clock: {frameDuration, timeScale}` from `AEGP_GetCompFrameDuration`, omitting the field rather than
fabricating one when a composition reports no usable duration, and
`AeRuntimeCompositionDescriptor.clock` carries it on the wire — the field has a producer, so it is a
contract rather than speculative surface. `frameRate` stays on the descriptor but is marked diagnostic
only. Verified by compiling `adapter.cpp` against the vendored SDK
(`vendor/adobe/sdk/ae25.6_61.64bit.AfterEffectsSDK`) with MSVC 14.44: clean, with two pre-existing
`getenv` warnings unrelated to the change.

**Still gated.** Compilation is not execution. Reading a live composition's clock through this path
needs the licensed AE 26.3 host and the installed `.aex`, which is not available here, so no claim is
made that a live `LIST_COMPOSITIONS` has returned the rational — that remains an external gate on the
fixture, and `compare-lower-third.mjs` records an explicit unverified line rather than passing silently
when the field is absent. The adapter also still leaves the composition parked at the quantised instant
when it refuses `TIME_NOT_REPRESENTABLE`, which the GrapiX path no longer reaches now that the rate is
refused earlier, but remains true of the adapter in isolation.

### PL2 · Container control plane, authority, quotas, audit

**Effort** 7–10 d · **Blocked by** AE-A2, AE-CD0, AE-CD1 · **Unblocks** PL3, PL4

**Work.** Implement the §30 surface as Playout-owned routes with explicit permission checks, per-user and
per-container quotas, deadlines and audit on every mutation. Editor may author container metadata and
controls under `scene.write`; it never receives a verb or a direct adapter channel. Remote clients reach
a GrapiX service only — never the pipe.

**Must not change.** Existing `/api/playout/*` routes, the global authentication hook and the role split
keep their behaviour; no import route becomes an unguarded control route.

**Exit gate.** An integration run exercises every route with editor, operator and admin tokens: only the
listed permissions succeed; quota and digest failures are stable 4xx; every attempted mutation has an
audit record; the fake adapter receives only allowlisted, deadline-bearing local commands.

### PL3 · Verb state machine, rundown, Preview/Program isolation

**Effort** 10–14 d · **Blocked by** PL1, PL2, AE-A4, AE-CD2, AE-F2 · **Unblocks** PL4, POC acceptance

**Work.** Extend the Playout runtime's target model with a discriminated AE-container record holding
container id, project and cue-map digests, selected composition, current/applied/taken revisions,
preview state, Program state, last exact frame and audit identity. Implement the transitions: `LOAD`
validates a healthy runtime, digests, dependencies, manifest and quota; `CUE` atomically applies the next
complete revision, parks Preview at the declared cue and returns `cued` only after adapter readiness;
`TAKE` requires that cued snapshot and the declared IN; `UPDATE` requires a complete monotonic revision
and reports its effective frame, refusing stale or reordered revisions; `CONTINUE`/`GOTO` accept only
declared cue ids — never a raw frame; `OUT` does not clear Program until the declared END; `STOP`,
`RESET`, `UNLOAD` have explicit off-air preconditions, with forced unload an audited exception. Carry
data and take preconditions plus idempotency keys into the existing recovery journal, and keep
`ProgramClock` as frame authority. Choose an explicit Preview topology — isolated composition/state, a
second AE instance, or cached preview — and refuse the profile if isolation is unproven. Extend the
Playout status types and web UI to show independent Preview and Program state, active and next continue
cue, and disabled commands with reasons.

**Must not change.** Native direct-recall and take-list semantics, the engine's Preview/Program
separation, and "no unprepared scene goes on air" all hold. Monitor-only code cannot issue a command.

**Exit gate.** A repeatable fixture completes CUE(rev 7) → TAKE(IN, rev 7) → UPDATE(rev 8 effective at a
recorded frame) → HOLD → CONTINUE:1 → OUT → END at 25 and `60000/1001`, asserting adapter command order,
one complete revision per effective frame, and take audit data; Preview operations leave the Program
frame and revision unchanged; Program clears only after END; `GOTO` to an undeclared marker or raw frame
is rejected. Uses the AE-F2 test ingress and virtual output only — no hardware claim.

### PL4 · Safe failure and recovery policy

**Effort** 8–12 d · **Blocked by** PL3, AE-A2, AE-F2, BO1 · **Unblocks** BO3 device-loss closure, release

**Work.** Add a persisted per-rundown/per-output policy — `hold-last-good`, `clear-transparent`,
`take-offline`, `pre-render-fallback` — validated at CUE: hold requires a verified retained frame,
fallback requires a pinned validated package, and a missing prerequisite blocks CUE rather than silently
choosing another policy. Consume AE-F2 completion telemetry at the Program boundary through a bounded
counter/event path and surface it on the existing output-health route. Define exact reactions: before
TAKE, crash/timeout/dependency loss refuses and leaves Program untouched; on air, a crash, the configured
consecutive deadline miss, or an invalid returned frame moves container and output to `degraded`, records
the event, applies only the configured policy, and raises an operator banner naming container,
composition, requested and delivered frame, revision, applied policy and remedy. Map device loss to an
explicit affected-output state — never "healthy because control is up". Use the recovery journal and gate:
replay only off-air, stay output-inhibited through restore, require a fresh validated off-air frame, and
never auto-retake.

**Must not change.** Absolute deadlines with dropped rather than queued late frames; output inhibited
until a validated first frame; virtual output is never described as broadcast output; no fallback
renderer and no capture.

**Exit gate.** An automated run completes the full cycle then injects an on-air crash and deadline misses
under each configured policy; the virtual sink records hold, transparent, offline and validated-fallback
exactly as configured; diagnostics and audit name the requested and delivered frames and the revision;
recovery cannot emit a live frame before first-frame validation. Physical device loss stays a separate
BO3 gate.

---

## 12. Track BO — output and certification

### BO0a · POC fixture, alpha vectors and evidence schema

**Effort** 4–6 d · **Blocked by** AE-A2, AE-A3, AE-CD1, AE-CD2, AE-F0 · **Unblocks** AE-F2, BO1, BO2

**Intent.** Give the POC exactly the evidence it needs, and no more — but that includes everything §38
asks for. The remaining §33 breadth is BO0b and must not gate the deliberately narrow lower-third path.

**Work.** Create the versioned fixture root `tools/certification/ae-runtime-fixtures/` and the manifest
schema: `.aep` SHA-256, AE build, plugin set, fonts, media digests, selected composition, declared
controls and accepted values, cue map, expected dependency report, exact rational rate and resolution,
source alpha mode, expected fill/key behaviour, expected failure outcome, and the numeric comparison
tolerances. Author the §37 `LOWER_THIRD` fixture so it carries **all** of the POC's declared controls —
text, number, a replaceable `PLAYER_IMAGE` footage layer, a `TEAM_COLOR` control wired to the project's
own expression/effect — and **the one approved, licensed third-party plugin**, because §38 criterion 15 is
part of the POC and cannot wait for BO0b. Add the alpha vector subset — opaque, zero alpha, hard edge,
antialiased edge, 50% gradient, coloured translucent shadow, premultiplied-black edge — with references
exported independently per AE-F0, never captured through the path under test. Add the runner and
`certify:ae-runtime-fixtures` that starts the managed runtime, applies only declared controls through the
production path, and compares named frames at the manifest tolerance.

**Alpha-vector subset, 2026-08-12 — complete.** `tools/certification/ae-runtime-fixtures/v1/`
contains the pinned 461,271-byte `bo0a-alpha-edges.aep` at SHA-256
`1cdfb5f808c0104bcd22fadc6c28639d868782d3405a5bd60ce870c882739a06`, a local JSON Schema,
the versioned manifest and seven independently exported Render Queue reference manifests.
`npm run certify:ae-runtime-fixtures` re-exported all seven references through `aerender.exe`,
then ran fourteen named adapter checkouts — `premul-black` and `straight` for each composition.
Every premultiplied ARGB checkout, swizzled to RGBA, matched its reference at **zero differing
pixels and zero channel tolerance**. The four partial-alpha cases made the oracle sensitive:
straight alpha differed on 890 antialiased-edge pixels, 140,000 gradient pixels, 64,818
coloured-shadow pixels and 61,838 premultiplied-black-edge pixels. The gradient contains 132,868
partial pixels, 252 distinct alpha values and 464 pixels at `A = 128`; the premultiplied results
carry no colour above alpha and no colour at zero alpha. AE authored, saved and reopened all seven
compositions without imported media, fonts or effects; the fixture has no external dependencies.

**Status, 2026-08-13: incomplete, with the fixture truth corrected and three of four controls proven.**
Live AE 26.3 inspection through the authenticated production runtime found `LOWER_THIRD` item 1 at
1920×1080 with `SCORE` layer 21, `PLAYER_NAME` 20, `PLAYER_IMAGE` 19/source 18 and `TEAM_COLOR`
17/source 16; the pinned `lower-third.aep` remains SHA-256
`903406290b24405d3b1ff1bbd5a6c9999dc3e1e66c53989647d5eb695a06439c`. Two manifest claims were wrong and
are corrected: the source ids (18 and 16, not 4 and 2), and `PLAYER_IMAGE`, which is an internal solid
source and **not** replaceable footage. The runner independently exports and compares the named
baseline reference, reports every row, and preserves the seven alpha comparisons at zero differing
pixels and zero channel tolerance.

`PLAYER_NAME`, `SCORE` and `TEAM_COLOR` now **pass through the production `AeControlService` path**
after AE-A3's declared surface was widened to carry `ADBE Text Properties/ADBE Text Document` and
`ADBE Effect Parade/ADBE Fill/ADBE Fill-0002`, and live dependency equality passes now that
`LIST_EFFECTS` answers. `PLAYER_IMAGE` remains `not-run`: it declares `ADBE Layer Source`, which is
footage replacement owned by AE-CD3, and the fixture layer is a solid, so there is no replaceable
footage to drive. The declared-controls revision row is consequently `not-run` too — one undeliverable
member correctly refuses the whole batch — while an atomic revision over the three deliverable controls
is proven live in
[`AE-A3-declared-surface.json`](../ae-plugin/runtime-adapter/certification/AE-A3-declared-surface.json).

**Still open, and named in the manifest rather than implied:** the approved licensed third-party plugin
(criterion 15), unobtainable in this session; AE-CD3 footage replacement; authored composition markers,
so the exact-time cue map stays declared-not-authored; AE-F2 ingress; and the AE-F3 soak. The runner
records each as an explicit `not-run` row that is visually distinct from a pass, and exits non-zero
only on a failed declared comparison — so a run with nothing to compare can never read as green.

This completes the alpha-vector subset and the reachable part of the `LOWER_THIRD` control proof. BO0a's
full gate stays open on the five gates above.

**Must not change.** The three binary parser fixtures are never relabelled as runtime coverage; a
fixture's existence is not a support claim.

**Exit gate.** The runner executes the POC fixture and the alpha subset on the pinned build with every
comparison reported and each tolerance taken from the manifest; a reviewer can reproduce the fixture from
digest and manifest alone.

### BO0b · Full §33 certification corpus

**Effort** 6–8 d · **Blocked by** BO0a, AE-CD3, AE-CD4, AE-F3 · **Unblocks** BO4, BO5

**Work.** Author the remaining §33 cases: repeated scoreboard updates, sponsor visibility, multiple
precomps, masks/mattes/blends, additional expression controls, text animators, 3D camera/light, built-in
effects, **further** approved third-party-plugin coverage beyond the POC's one, heavy transition, exact
29.97/59.94 timing, and the crash / missing-media / missing-font / missing-plugin negatives — each with
the BO0a manifest schema and independently exported references.

**Must not change.** No render, export or capture overwrites a checked-in reference without manifest
review; a negative fixture keeps its declared visible failure as the expected result.

**Exit gate.** Every positive fixture runs with all comparisons reported; every negative fixture reaches
its declared visible failure; each fixture's manifest names its own tolerances and evidence.

### BO1 · Canonical alpha and frame normalization

**Effort** 6–9 d · **Blocked by** BO0a, AE-F0, AE-F2 · **Unblocks** BO2, BO3, PL4

**Work.** Make one canonical premultiplied BGRA8 sRGB Program frame the only thing outputs see, with the
AE-F0 conversion or refusal applied at ingress and its status visible. Extend the output format contract
and its Rust twin with the explicit colour format in one commit. Prove fill and key derive from the same
frame.

**Exit gate.** A virtual/recording certification pushes the BO0a alpha vectors through the same
`OutputInstance` path live outputs use and byte-compares canonical BGRA plus the key plane; a transparent
AE fixture matches its references and the status names the source alpha mode and normalization result —
failing if `StraightAlphaUnsupported` is bypassed instead of normalized. Extended engine output tests
prove malformed/missing alpha metadata and non-premultiplied NDI configurations are refused.

### BO2 · NDI alpha output certification

**Effort** 7–10 d + 30-minute soak + the 8-hour hardware soak · **Blocked by** BO0a, BO1, AE-F3, PL3, PL4, AE-CD3, AE-CD4 · **Unblocks** BO5, release (and enriches BO4's continuity fields)

**Work.** Keep `NdiSink`/`NdiWorker`/`NdiFramePool` the sole sender; add runtime discovery and refusal
for a missing NDI redistributable rather than starting a sink that cannot transmit. Preserve the
configured source name, rational rate and the 3–4 slab cap; carry frame-sequence metadata only where the
pinned API can, reporting anything it cannot as unavailable. Add a finite reconnect policy and surface
every retry, receiver-count change, terminal failure, pool pressure, accepted/sent/dropped frame and
queue latency on output health, while Program continues on absolute deadlines. Add a receiver capture
verifier and `certify:output-hardware -- ndi`.

**Must not change.** No Mercury Transmit, AE-side or Editor NDI path. `hardware_certified` never becomes
true because `--features ndi` compiled or a sender started. Interlace stays refused.


**Acquisition specification, 2026-08-18 — receiver host not yet confirmed.**

- Pin one exact NDI 6.x SDK/runtime build on both hosts. The sender build additionally needs the SDK
  headers plus LLVM/Clang because the pinned `grafton-ndi 1.0.0` binding generates its FFI at build time.
  Record the SDK/runtime file versions and digests; a working Studio Monitor is not a substitute for the
  redistributable that the engine actually loads.
- The receiver must be a **second physical LAN host**, not a VM or second process on the sender. The
  vendor's [Windows minimum](https://docs.ndi.video/all/using-ndi/ndi-tools/ndi-tools-for-windows) is
  Windows 10 x64, SSE4-capable Intel/AMD CPU, GPU/APU, 6 GB RAM and wired 1 Gb/s LAN. Pin the same runtime
  as the sender, use [NDI Tools](https://ndi.video/tools/) only for discovery/visual smoke, and run the
  GrapiX receiver verifier for pixel, cadence and accounting evidence.
- Keep sender, receiver and switch on a known wired 1 Gb/s-or-better path with no Wi-Fi segment. Before
  the gate, record both host fingerprints, NIC/driver/link speed, switch path, IPs, firewall profile,
  runtime/tool versions and source identity, then book both the uninterrupted 30-minute POC window and
  the later 8-hour certification window.
- Verify frames while receiving; do not dump the full raw stream. At the fixture's 1920×1080,
  2997/100 profile, uncompressed BGRA is about 249 MB/s and about 448 GB for 30 minutes. Persist counters,
  timestamps, hashes and bounded mismatch samples instead.

The present sender workstation has NDI 6 Tools and Studio Monitor **6.0.1.0** plus an app-local
`Processing.NDI.Lib.x64.dll` 6.0.1.0. It has no default-path NDI 6 SDK install and that DLL is not on
`PATH`. This is useful for diagnostics but does not satisfy the pinned build/runtime pair or the second
host requirement.

**Exit gate**, with every threshold living in the BO0a manifest so the number is reviewable rather than
argued:

- A second LAN host receives the live output from the POC fixture for **30 uninterrupted minutes** at the
  recorded profile.
- **Accounting:** sent, received, dropped, duplicated and late frames reconcile exactly; the taxonomy is
  enumerated (`sender-drop`, `pool-pressure`, `receiver-drop`, `network-loss`, `reconnect`) and every
  non-zero bucket has a named cause.
- **Cadence:** receiver-side inter-frame interval within **±1 frame period** of the nominal, and p99
  jitter within **±25%** of one frame period, measured from receiver timestamps.
- **Alpha:** captured frames match the BO0a vectors at the AE-F0 tolerance — exact on fully opaque and
  fully transparent pixels, ≤ 1 LSB per channel elsewhere.
- **Reconnect:** at least **3** induced receiver disconnect/reconnect cycles, each recovering with the
  same source identity and no unreported failure.
- **Bounds:** sender RSS and VRAM high-water within the recorded ceiling for the profile; unexplained
  growth fails the gate.
- Flipping `hardware_certified` additionally needs the template's **8-hour** soak with reconnect and
  output-loss injection, recorded per host/runtime/receiver. A build without the feature refuses live
  transmission.
- **POC acceptance join:** the same run signs off §38 end to end — the declared image replacement
  (criterion 6), the expression-driven colour (criterion 7) and the approved plugin rendering inside AE
  (criterion 15) are all present in the transmitted frames, and the crash/frame-timeout policy proven in
  PL4 is exercised once during the soak. `AE-CD3` and `AE-CD4` are therefore prerequisites of this gate,
  not of `PL3`.

### BO3 · First SDI Fill + Key adapter

**Effort** 10–15 d + vendor/hardware window · **Blocked by** BO0a, BO1, AE-F3, PL3, PL4 · **Unblocks** PL4 device closure, BO5

**Work.** Add a `decklink` feature and adapter selected from `create_sink`, with bindings built from an
environment-provided SDK — no vendor headers or binaries in the repository. Replace
`UnavailableLiveSink` only in an enabled build, enumerating devices and progressive modes and refusing
unsupported configurations with the supported list; AJA stays unavailable. Derive fill and key from the
same canonical frame and index, with explicit per-profile key polarity and range tested against the BO0a
vectors before hardware. Keep exactly one clock master — internal absolute deadlines, or the card's
scheduled playback while genlocked — and refuse two. Report card removal, schedule failure, dropped
completion, reference-lock change, paired stop and re-enumeration on output health, and integrate the
output-inhibited restore rule.

**Must not change.** SDI is GrapiX-owned output, not Mercury Transmit or an Editor authority. Both wires
come from the same frame and timing. No interlace, AJA, genlock, timecode or keyer claim without a device
test.

**Acquisition specification, 2026-08-18 — hardware and mixer window not yet booked.**

- **Inventory before purchase:** Windows retains non-present device records for a DeckLink 8K Pro and a
  DeckLink Mini Recorder 4K, plus Desktop Video 12.5; no Blackmagic device is currently present. Locate
  the 8K Pro before ordering anything. If it is available and healthy, its four bidirectional SDI
  channels and reference input satisfy this gate; the Mini Recorder is capture-only and cannot.
- **Fallback card:** if the recorded 8K Pro is unavailable, procure one
  [DeckLink Duo 2](https://www.blackmagicdesign.com/products/decklink/techspecs/W-DLK-31)
  (vendor list $579). Its four independent bidirectional 3G-SDI channels, Tri-Sync/Black Burst input,
  1080p29.97/59.94 support and PCIe Gen 2 x4 interface match the HD Fill+Key gate without buying 4K/8K
  capacity the plan does not use.
- **Host fit:** the present ASUS ROG STRIX Z590-E / i7-10700K host reports `PCIEX16_2` and
  `PCIEX16_3` available. An 8K Pro needs the CPU-attached `PCIEX16_2` at x8 and will reduce the RTX 3070
  Ti to x8. A Duo 2 can use `PCIEX16_3` at **x4**, not its default x2; the
  [board specification](https://rog.asus.com/motherboards/rog-strix/rog-strix-z590-e-gaming-wifi-model/spec/)
  says this disables SATA ports 5/6. Verify those ports are unused and check chassis/GPU clearance
  before installation.
- **Software:** replace Desktop Video 12.5 with a vendor-current driver and download its compatible
  Desktop Video SDK from the support page. Pin the tested driver/firmware/SDK versions and digests, and
  keep all vendor binaries and headers out of the repository.
- **Downstream keyer:** book or procure a switcher with two free 3G-SDI inputs selectable as external
  linear fill/key, at least two routable clean-feed outputs for simultaneous wire capture, a Program
  output, 1080p29.97 and a Tri-Sync/Black Burst reference input. An
  [ATEM 1 M/E Constellation HD](https://www.blackmagicdesign.com/products/atemconstellation/techspecs/W-APS-25)
  is the minimum named candidate: ten standards-converted 3G-SDI inputs, six routable outputs, five
  linear/luma keyers and reference input (vendor list $1,195). An existing facility switcher is
  preferable if both the setup day and uninterrupted 8-hour run can be booked.
- **Reference and cabling:** procure or book a Tri-Sync generator for the exact test rate; the
  Blackmagic Mini Converter Sync Generator is a sufficient named candidate (six reference outputs,
  vendor list $265). Budget six equal-length, impedance-matched 75 Ω BNC paths — Fill, Key, two
  simultaneous clean-feed returns, and reference to card plus switcher — plus two spares and proper
  termination. Record cable type/length, generator, switcher and capture path in the evidence.
- **Acceptance setup:** install the card, select its required x8 or x4 link width in BIOS, verify
  firmware/driver enumeration and reference lock in Desktop Video Utility, then run a
  scheduled-playback/capture smoke at 1080p29.97 before adapter work depends on it. Treat device removal
  as a supported Windows device-disable/removal event; never pull a PCIe card from a powered non-hot-plug
  slot.

The fallback card, switcher and reference generator total **$2,039 USD** at current official list prices
before cables, tax and shipping; reuse of the recorded 8K Pro lowers that to **$1,460 USD**. Renting or
booking the switcher and generator is valid. The selected DeckLink card, tested driver and SDK are
development dependencies and must remain available on the reference host.

**Exit gate**, measured from capture rather than observed on a monitor:

- A real mixer/keyer receives the pair from the alpha stress fixture, and a capture of both wires shows
  fill/key **skew of zero lines** — the two wires carry the same frame index — with any sub-line offset
  within the card's documented output tolerance and recorded.
- Key polarity and range match the configured profile, verified against the BO0a vectors; there is no
  fill-only condition at any point in the run.
- The device reports reference lock where the card supports it, and exactly one clock master is active.
- Pulling the device during transmission puts **both** paths in the defined safe state within the
  configured deadline, reports the fault, and then recovers without an engine restart.
- The per-device **8-hour** record from the hardware template is complete, including drop counts and the
  card/driver/SDK/mode/format/rate identity.

### BO4 · Performance harness, R1/R2/R3, on-air admission

**Effort** 8–12 d · **Blocked by** BO0b, BO1, AE-F2, PL3, CB4, CB5 · **Unblocks** BO5, release

`BO2` and `BO3` do not gate this phase: classification runs on virtual or recording output. Their
continuity evidence joins the record at `BO5`.

**Work.** Add a bounded performance collector fed by the Program render path, clock, output instances and
runtime health, recording load, first frame, cue, update-to-frame, render p50/p95/p99/max, CPU/RAM/GPU/VRAM,
queue latency, drops/duplicates and long-run continuity without a growing per-frame history. Add a runner
that repeats the corpus at each declared resolution and rational rate on a fingerprinted host with fixed
cold and warm runs, emitting immutable JSON and failing if any fixture digest, environment tuple or host
fingerprint changes mid-series. Implement the classes as code: **R1** requires mean ≤ 70% and p99 ≤ 90% of
the exact frame budget with zero unexplained drops; **R2** requires the same post-warm limits plus the
declared cache signature; **R3** is everything else and is a hard refusal for live Program, with no
operator override. Bind R2 admission to the CB5 signature so a miss or changed dependency removes it.

**Must not change.** No class is granted from a GPU model, a build, one frame or an uncaptured preview; a
class never becomes `hardwareCertified`.

**Exit gate.** **3 cold and 3 warm runs** per fixture, resolution and rational rate on the fingerprinted
host produce the **same class every time** — a single differing run is a variance failure, and the fixture
is R3/unclassified until the variance is explained. All measurements are retained. A live attempt admits
R1, admits R2 only after the signed preload condition, and refuses R3 before Program starts. If no
qualifying R2 fixture exists the report says so rather than claiming R2 verified.

### BO5 · Profile matrix and certification truth source

**Effort** 4–7 d for the mechanism · **Blocked by** BO0b, BO2, BO3, BO4, AE-A4 · **Unblocks** L1

**Work.** Extend the hardware certification template with a machine-readable profile matrix: package hash;
AE build, plugin set and runtime build; OS build; CPU, RAM, GPU/VRAM/driver; storage and AE cache; output
card/driver/SDK; receiver/mixer/reference topology; resolution, rational rate and scan; colour, alpha
polarity and range; corpus digest; R class; evidence ids; exclusions; reviewer and retest conditions. Add
a local-only record loader that matches a record against the actual adapter, device, driver, mode, format,
rate and fingerprints before reporting certified — remote configuration can never create a record. Replace
static certification reporting with profile-aware status keeping `available`, `configured`,
`transmitting`, `uncertified` and `certified` distinguishable. Record Mercury Transmit only as an optional
monitoring observation, never in Program routing.

**Exit gate.** Every mismatch case stays uncertified with a reason; the initial matrix has the reference
host's R rows, an NDI row only after BO2's receiver evidence and a DeckLink row only after BO3's mixer
evidence, with AJA and untested variants listed unavailable rather than blank. A reviewer can answer "what
exactly is safe?" and "why is this other host not?" from the status plus its record.

---

## 13. Mapping to the plan's §36 phases

| §36 | Becomes | Note |
| --- | --- | --- |
| — | **L0** | New. Licensing precedes engineering; §36 deferred it to P9. |
| P0 | CB0, CB1, CB2, plus the contract freeze inside AE-A1/AE-F0/BO0a | Split: vocabulary, boundaries and inspector re-scope are three landings. |
| P1 | AE-A0, AE-A1, AE-A2, AE-A3, AE-A4 | Split, and the security boundary moves into AE-A1 rather than P8. |
| P2 | AE-CD0, AE-CD1, AE-CD2 | Split by persistence, identity and revision/audit. |
| P3 | PL1, PL2, PL3 | Split: cue/time contract, control plane, then verbs and UI. The operator surface stays hidden until the POC passes. |
| P4 | AE-F0, AE-F1 | Alpha ownership and an independent reference oracle settled in AE-F0, before transport. |
| P5 | AE-F2, PL4, AE-CD3, AE-CD4, BO0a, BO1, AE-F3, BO2 | §37/§38 needs image replacement, expression controls, dependency preflight, crash/timeout policy and NDI alpha — so all of them are in the POC milestone, not after it. |
| P6 | BO3 | Unchanged in intent; the gate becomes a capture measurement. |
| P7 | CB4, CB5, BO4 | Split: measurement, cache signature, classification and admission. |
| P8 | BO0b, PL4 hardening, BO5 inputs | The policy work moved forward into P5's replacement; what remains is the full corpus and per-device closure. |
| P9 | BO5, L1 | Split: profile matrix as the truth source, then legal/release closure. AE-A4 moved forward to M4 because PL3 depends on it. |

### Gates rewritten because the original was unfalsifiable

| §36 wording | Replacement |
| --- | --- |
| "within the defined comparison tolerance" (P4) | AE-F0: independently exported references with pinned settings and checksums, byte equality for an identity conversion, ≤ 1 LSB per channel for a declared conversion, exact on fully opaque and fully transparent pixels, plus slot reuse and handle release. |
| "target format… no unreported output failure… correct alpha" (P5) | BO2: named sender/receiver pair, resolution and rational rate, 30-minute duration, reconciled frame accounting with an enumerated failure taxonomy, ±1 frame-period cadence with p99 jitter ≤ ±25%, the alpha threshold above, ≥ 3 reconnect cycles, and RSS/VRAM ceilings. |
| "stable synchronized Fill + Key" (P6) | BO3: named card, driver, keyer and reference setup, zero-line fill/key skew measured from a capture of both wires, verified polarity and range, a device-loss test with a deadline, and the 8-hour record. |
| "repeatable performance classification" (P7) | BO4: host fingerprint, corpus revision, 3 cold and 3 warm runs per fixture/resolution/rate with an identical class every time, and the explicit 70%/90% frame-budget rules. |
| "defined operator-visible behaviour" (P8) | PL4: an injected-fault → visible-state → output-policy → audit-event matrix, with first-frame validation before any live frame returns. |
| "certified workflow" (P9) | L1/BO5: a version-pinned release fixture and rundown replayed with no AE UI interaction, against a matching runtime-validated profile record. |

---

## 14. External prerequisites register

Acquire each **before** the phase that needs it; a missing input is a stop, not an improvisation.

| Input | Needed by |
| --- | --- |
| **Signed** legal/compliance determination naming the approver, the governing Adobe licence and SDK distribution terms, and the exact unattended deployment — plus third-party plugin terms | L0 (blocks all) |
| Licensed pinned AE build matching the vendored 25.6 SDK, on a dedicated Windows host | AE-A0, then AE-F0, and everything after |
| Adobe SDK build toolchain and permission to load a development AEGP component | AE-A0 |
| Independently exported AE reference frames (Render Queue PNG/TIFF sequence, pinned settings, checksums) — never captured through the path under test | AE-F0, BO0a, BO0b |
| Real fixture projects: rename/duplicate, expression controls, replaceable media, missing media/font/plugin, alpha/codec/dimension edge cases | AE-A3, AE-CD1–AE-CD4, BO0a, BO0b |
| One approved, licensed third-party plugin (POC criterion 15) — further plugin breadth only later | BO0a, then BO0b |
| A real media-probe capability (dimensions, codec, alpha, colour) | AE-CD3 |
| NDI runtime plus a second LAN host that can capture and verify alpha and cadence | BO2 |
| DeckLink card, driver, SDK under vendor terms, two SDI paths, downstream mixer/keyer, reference/genlock source | BO3 |
| Fingerprinted reference host (CPU, RAM, GPU/VRAM/driver, storage, AE cache) | CB4, BO4 |
| macOS host and its matching AE build/SDK | only before any macOS claim |

---

## 15. Unsupported until executed

State these plainly wherever the product speaks:

- No resident AE control, frame checkout, alpha behaviour, timing or crash recovery is proven by this
  plan. The vendored SDK shows the route exists; nothing here has run it.
- NDI is feature-gated and self-reports uncertified. No source, alpha path, reconnect behaviour, cadence
  or endurance is certified until BO2's receiver has verified frames for a recorded profile.
- DeckLink and AJA are declared and unavailable. There is no SDI Fill+Key, genlock, device recovery,
  interlace or keyer support until BO3's physical evidence exists, and it applies to that device only.
- Virtual and recording outputs prove local path behaviour only; they never prove a frame reached air.
  Mercury Transmit is never Program-output proof.
- No host has an R1/R2/R3 class until BO4 repeats the corpus on it, and an R class never certifies
  hardware.
- Every profile other than non-live virtual/recording displays as uncertified until BO5 validates an
  exact matching record at runtime.
