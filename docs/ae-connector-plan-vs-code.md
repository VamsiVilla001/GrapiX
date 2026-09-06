# GrapiX AE Connector — Plan vs. Code

**What this is.** A section-by-section comparison of the revised *GrapiX AE Connector*
architecture plan against the After Effects code that exists in this repository today. It is an
**analysis snapshot** (2026-08-26) — no code was changed to produce it. Source plan: the revised
AE Connector plan supplied by the user (referenced here by its own section numbers, e.g. "plan §17").

**Where it sits.** A comparison ledger, subordinate to the authority docs in
[`README.md`](README.md). It describes *what is built vs. planned* for the AE connector; it does
not set product boundaries. On any conflict, `architecture.md` and
`ae-runtime-container-phase-plan.md` win.

**Status legend.**

| Mark | Meaning |
| --- | --- |
| **Built** | Implemented; where noted, tested or certified. |
| **Partial** | The mechanism exists at one layer (protocol / runtime / adapter) but is incomplete, or is not surfaced where the plan wants it (typically: exists in the runtime, absent from the Editor). |
| **Missing** | Planned by the document, not implemented. |
| **Divergent** | Implemented, but differently than the plan specifies. |

---

## 1. Bottom line

The plan describes an AE Connector in eight phases. GrapiX has already built the **hard back
half** — the Playout → After Effects → Render Engine → Program runtime — and it is certified
against real After Effects 2026 (26.3). What is largely **absent is the front half**: the
Editor-side *design-time connector* (browse the live project, expose controls visually, preview)
and the entire **portable publish package**.

> **Phases 7–8: built and certified. Phases 1–5: exist at the protocol / runtime / adapter layer
> but are not wired into the Editor. Phase 6: not built.**

There is also one **strategic divergence**: the plan says GrapiX should not depend on parsing the
`.aep` binary (plan §7, §32); GrapiX still has a binary parser, but only powering a static
inspector — the runtime already reads a *live* AE through the adapter, which is what the plan wants.

### At a glance

| Plan phase (§33) | Status | One-line reason |
| --- | --- | --- |
| **P1 — Connection** | Built (runtime), not in Editor | Supervisor + named pipe + adapter + comp/layer list + heartbeat exist; driven from Playout, not an Editor "connect" flow |
| **P2 — Property reading** | Partial | Property list/read/metadata verbs exist; **keyframe read has no verb**; not surfaced in Editor |
| **P3 — Live editing** | Built at protocol, not in Editor | `SET_PROPERTY` / `APPLY_DATA_REVISION` / `SET_TIME`+`RENDER_FRAME` exist; the Editor never calls them |
| **P4 — Control builder** | Model built, UX missing | `AeDynamicControl` is complete; the Editor panel declares controls via `prompt()`, no project browser |
| **P5 — Animation mapping** | Built, vocabulary differs | `aeCueMap` is marker-driven (CUE/IN/HOLD/CONTINUE/UPDATE/OUT/END); **no "LOOP" role** |
| **P6 — Publish** | Missing | No `.aep` copy, asset collection, or `manifest/controls/animations/dependencies.json` package |
| **P7 — Playout runtime** | Built & certified | Full supervisor lifecycle, live data, cue/take/out, health, recovery |
| **P8 — Render integration** | Built & certified | The exact `ae_schedule → ae_runtime_client → ae_ring_source → ae_ingress` chain the plan names |

---

## 2. The AE/AEP code that exists today

| Area | Files | Role |
| --- | --- | --- |
| Runtime contract | `Shared/ae-runtime-contract/` (`container.ts`, `revision.ts`) | Container model, declared controls, data revisions |
| Wire protocol | `Shared/adobe-common-schema/src/aeRuntimeProtocol.ts` | v2.0 named-pipe protocol: verbs + events |
| Cue / animation | `Shared/animation-engine/src/aeCueMap.ts`, `Playout/services/playout-control/src/aeCueService.ts` | Marker-based cue mapping |
| Rational time | `Shared/shared-types/src/aeTime.ts` | Exact rational composition clock |
| AE adapter (C++) | `ae-plugin/runtime-adapter/src/` (`adapter`, `runtime_pipe`, `frame_ring`, `revision_apply`) | The `.aex` resident inside AE |
| Playout runtime | `Playout/services/playout-control/src/ae*.ts` (supervisor, client, control, cue, revision, container store, data-revision tracker) | Runs the container live |
| Render engine (Rust) | `services/render-engine/src/ae_{schedule,runtime_client,ring_source,ingress}.rs` (+ `bin/ae-ring-drain.rs`) | Frame scheduling → Program admission |
| `.aep` binary parser | `Shared/adobe-common-schema/src/ae/` (`rifx`, `cos`, `aepParser`, `aepxParser`) | Static structure read from bytes |
| Static inspector route | `Editor/services/project-api/src/importers/aeImporter.ts` → `POST /api/import/after-effects` | Reports project structure; not a fidelity/import claim |
| Adobe live bridge | `Editor/services/adobe-mcp-gateway/src/aeBridge.ts`, `Editor/apps/editor-web/src/store/adobeStore.ts` | Live AE via the MCP gateway (ws :4784) |
| Editor AE UI | `Editor/apps/editor-web/src/components/AeControlsPanel.tsx`, container CRUD `POST/GET/PATCH /api/ae-runtime/containers` | Minimal control declaration |
| Certification | `ae-plugin/runtime-adapter/certification/`, `tools/certification/ae-runtime-fixtures/` | AE-A0/F0/F2a/F3/CD2, pixel parity |

Two independent AE integrations share the name "AE": the **`.aep` static inspector** (read a file's
structure) and the **AE runtime container** (drive a live AE). They meet at one seam — a container's
`profile` / `compositions` / candidate `controls` all have to come from reading a project — which is
exactly where the connector's design-time half would plug in.

---

## 3. Phase by phase

### Phase 1 — Connection

**Plan asks (§3.2, §33):** AE process detection, local IPC / named pipe, an AE adapter, project
information, composition list, layer list, basic heartbeat. Target: *GrapiX can connect to an open
After Effects project.*

**In code — Built at the runtime layer, not surfaced in the Editor:**
- Process launch/attach/detection: `AeRuntimeSupervisor` (`Playout/services/playout-control/src/aeRuntimeSupervisor.ts`) spawns `afterfx.exe` (ownership `owned`) or attaches to a running instance (`attached`), writing an `ae-runtime-claim.json`.
- IPC: authenticated same-user Windows named pipe `\\.\pipe\grapix-ae-runtime-<session>`, protocol v2.0 (`aeRuntimeProtocol.ts`), 4-byte length-prefixed frames capped at 256 KB, `hello` handshake with an adapter/plugin fingerprint.
- Adapter: `GrapiXRuntimeAdapter.aex` (`ae-plugin/runtime-adapter/`), an AEGP plugin with idle + death hooks and a closed verb set.
- Comp/layer list: protocol verbs `LIST_PROJECT_ITEMS`, `LIST_COMPOSITIONS`, `LIST_LAYERS`.
- Heartbeat: `HEALTH` verb + the supervisor's health poll (2 s).

**Status: Built (runtime) · not wired in Editor.** The connection is owned by **Playout**, not by
an Editor "connect to the open project" action. Nothing in `Editor/apps/editor-web` calls the list
verbs.

**Gap to the plan:** the plan frames connection as a *design-time* Editor capability
(§3.2 diagram: `GrapiX Editor → AE Connector Service → Named Pipe → AE Adapter`). Today there is no
Editor-facing connector service that opens this channel during authoring.

---

### Phase 2 — Property reading

**Plan asks (§7):** property tree, text values, transform values, keyframe information, footage
references, asset paths. Target: *GrapiX can inspect the important parts of an AE project.*

**In code — Partial:**
- Properties: `LIST_PROPERTIES`, `READ_PROPERTY`, `READ_PROPERTY_METADATA`, `LIST_EFFECTS`.
- Footage / asset paths: `LIST_PROJECT_ITEMS`.
- Property targeting model: `AeDynamicControlTarget` (`compositionItemId` → `layerId` → `propertyPath[]` of `{matchName, ordinal}`), i.e. addressing by AE `matchName`, not display name.

**Status: Partial.**
- **Keyframe *inspection* is a confirmed gap.** `aeRuntimeProtocol.ts` contains **zero** occurrences
  of "keyframe": there is no verb to read keyframe times, values or interpolation. The adapter does
  touch the SDK's `AEGP_KeyframeSuite5`, but only to **count** keys
  (`AEGP_GetStreamNumKFs`) as a *writability gate* — the SDK permits `AEGP_SetStreamValue` only when
  a stream has no keyframes, so the adapter checks rather than guesses
  (`ae-plugin/runtime-adapter/src/adapter.cpp`, ~L380, L700, L751, L798). The only `AEGP_InsertKeyframe`
  call is inside the `fixture-control` test verb (`KEYFRAME_OPACITY`), which is fixture authoring, not
  project inspection. So a *count* is reachable; the keyframe **data** the plan wants (plan §7:
  timeline display, cue points, in/loop/out detection) is not.
- All reads exist at the protocol/adapter layer but are **not surfaced in the Editor** (no property tree UI).

---

### Phase 3 — Live editing

**Plan asks (§16):** change text, number, image, transform, color; preview updates. Target:
*Changing a GrapiX control immediately updates AE.*

**In code — Built at protocol/runtime, not in Editor authoring:**
- Write: `SET_PROPERTY`, and the transactional `APPLY_DATA_REVISION` (all-or-nothing, monotonic; `Shared/ae-runtime-contract/src/revision.ts`).
- Time / preview: `SET_TIME` + `RENDER_FRAME` (evaluate one frame into the ring).
- Runtime write service: `Playout/services/playout-control/src/aeControlService.ts` with refusal codes.

**Status: Built (protocol) · not in Editor.** Live editing works from the **Playout** runtime path.
The Editor's `AeControlsPanel` only *declares* controls; it does not drive live value changes or a
preview during authoring (plan §21 preview flow is absent from the Editor).

---

### Phase 4 — Control builder

**Plan asks (§5, §6):** expose a property; control type; friendly name; default; validation;
grouping; stable control IDs. Target: *Designer can build a clean operator interface from AE
properties.*

**In code — Model built, builder UX missing:**
- Model: `AeDynamicControl` — `controlId` (persistent identity), `displayName`, `kind`
  (`text/number/boolean/color/point2d/point3d/image/video/enum`), `writable`, `updatePolicy`
  (`immediate/next-frame/on-take/on-cue`), `target`, `constraints`, and a `validation` block
  (`valid/stale/rebind-required/disabled`). Allowlist model: undeclared AE properties are
  unreachable.
- Bindings: `AeControlBinding` (control → data path).
- Persistence: controls live inside the container (`AeRuntimeContainer.controls`).

**Status: Partial (model complete, UX minimal).** `AeControlsPanel.tsx` collects targets via
`prompt()` (composition item id, layer id, name) rather than from a live project browser. There is
no "select a property → Expose to Playout" flow (plan §4), no type/default/grouping editor.

**Divergences:** the plan's control **types** are a superset of the model's `kind`s — e.g.
`Integer` vs `Decimal` (model has one `number`), plus `Dropdown/Slider/Time-frame/Trigger/
Data-bound` (partly covered by `enum` + `updatePolicy`, partly not). Later list/repeating-row types
(plan §6) are unmodelled.

---

### Phase 5 — Animation mapping

**Plan asks (§8):** IN / LOOP / OUT regions; CUE / TAKE / CONTINUE / RESET; marker-based actions.
Target: *Playout can control animations without understanding AE keyframes.*

**In code — Built, vocabulary differs:**
- `Shared/animation-engine/src/aeCueMap.ts`: roles **CUE / IN / HOLD / CONTINUE / UPDATE / OUT /
  END**, resolved from `GRAPIX:`-prefixed AE **markers** against the exact composition clock, with
  ordering/duplication refusal codes.
- `Playout/services/playout-control/src/aeCueService.ts` drives it at runtime.

**Status: Built (marker-based).**

**Divergences:**
- **No `LOOP` role — confirmed.** `aeCueMap.ts` contains no occurrence of `LOOP`/`loop`; the closest
  role is `HOLD`. The plan's IN/LOOP/OUT frame-region model differs from the marker-role model.
  Whether `HOLD` + `CONTINUE` is operationally equivalent to the plan's `LOOP` is a product question,
  not a code one.
- Authoring is **markers placed in AE**, not IN/LOOP/OUT regions defined in GrapiX. Matches the
  plan's intent ("Playout should not understand keyframes", plan §8) but not its authoring shape.

---

### Phase 6 — Publish

**Plan asks (§10–13):** on `PUBLISH TO PLAYOUT`, create a self-contained versioned package —
copy the `.aep`, collect required footage/assets, relink paths, write
`manifest.json` / `controls.json` / `animations.json` / `dependencies.json`, a thumbnail, and
`v001/` versioning. Target: *One portable package contains everything required for Playout.*

**In code — Missing.**
- No AE package builder exists. A repository-wide search for `dependencies.json` / `animations.json`
  / `controls.json` / asset collection / `Published/vNNN` in the AE context returns nothing.
- The existing publisher (`Editor/services/project-api/src/packageBuilder.ts`, the `.gfxpkg` path)
  is **scene-only** — it has zero AE / `.aep` / `AeRuntime` references.
- Today a container is persisted as **config** (`.grapix/ae-runtime/<id>/container.json`) pointing at
  an on-disk `.aep` by `projectUri` + `projectDigest`. That is not a portable, asset-collecting,
  versioned package.

**Status: Missing.** This is the single largest gap, and the one that most blocks the plan's
end-to-end flow: without it, Playout consumes a container config that references the designer's
`.aep` location rather than a self-contained package (which the plan explicitly forbids in §14, §32).

---

### Phase 7 — Playout runtime

**Plan asks (§15, §29–30):** `AeRuntimeSupervisor` — start/detect AE, attach connector, open
project, heartbeat, recover from failure, restart; live data; cue / take / out; runtime health.
Target: *Playout can independently run a published AE graphic.*

**In code — Built & certified:**
- `AeRuntimeSupervisor`: spawn/attach, project-load timeout (30 s), health poll (2 s), command
  deadline (1.5 s), bounded restart budget (5), graceful stop via `WM_CLOSE` with retry.
- Live data: `APPLY_DATA_REVISION` + `aeControlService` + `aeRevisionService` /
  `aeDataRevisionTracker` (persisted accepted revision, rollback on partial failure).
- Cue/take/out: `aeCueService` + `aeCueMap`.
- Health/recovery: `HEALTH`, `RUNTIME_READY` / `RUNTIME_DEGRADED` events; supervisor restart.
- Routes: `/api/playout/ae-runtime`, `/api/playout/ae-runtime/containers/:id/controls`, `.../revision`.

**Status: Built & certified** (AE-A0 resident lifecycle 29/30 cycles; AE-CD2 revision rollback).

**Caveat (matches the plan's §30):** for broadcast safety the Render Engine keeps Program state while
AE recovers — this is enforced in `ae_ingress.rs` (a late/mismatched frame is refused, never
presented as current), aligning with plan §30.

---

### Phase 8 — Render engine integration

**Plan asks (§17):** `AE Runtime → ae_schedule → ae_runtime_client → ae_ring_source → ae_ingress →
Render Engine → Program`. Target: *AE graphics become part of the normal broadcast pipeline.*

**In code — Built & certified:** the exact chain the plan names.
- `ae_schedule.rs` — bounded lead-depth scheduling (depth bounded by ring slots and
  `MAX_PIPELINE_DEPTH = 8`).
- `ae_runtime_client.rs` — the engine's named-pipe client; pipelines `RENDER_FRAME` (AE-F3 measured
  21.3 → 88.7 fps).
- `ae_ring_source.rs` — consumes the adapter's Windows shared-memory frame ring (pixels never cross
  the protocol).
- `ae_ingress.rs` — Program admission by exact `{frameId, revision, instant, pixel tuple}`.

**Status: Built & certified** (AE-F2a live frame to Program; AE-F3 pipelining; BO0a pixel parity).

---

## 4. Cross-cutting gaps

| Plan area | Status | Note |
| --- | --- | --- |
| **Editor design-time connector** (§3.2, §4, §21, §26) | Missing | No live project browser, no "Expose to Playout" UX, no in-Editor preview. The verbs exist; nothing in `editor-web` calls them. |
| **Project-sync events** (§18) | Missing | Protocol events are only `RUNTIME_READY/DEGRADED`, `RENDER_READY/FAILED`. No `PROJECT_CHANGED`, `LAYER_ADDED`, `SELECTION_CHANGED`, etc. |
| **Broken-control relink** (§19–20) | Partial | `validation.status` has `"rebind-required"`, but there is no relink flow or UI. |
| **Granular REST API** (§26) | Divergent | `/api/ae/connect`, `/project`, `/compositions`, `/layers`… do not exist. Reality: the gateway WS + `/api/ae-runtime/containers` CRUD (which takes a **pre-built** request; it does not inspect live AE). |
| **Stable IDs** (§19) | Built | `AeDynamicControl.controlId` is a persistent identity, targeting by AE `matchName` rather than display name — matches the plan's intent. |
| **Heartbeat / status** (§29) | Built | `HEALTH` + supervisor status. |
| **Recovery** (§30) | Built | Supervisor restart + engine holds Program during recovery. |

---

## 5. Divergences (built, but differently than the plan)

- **`.aep` binary parsing.** Plan §7 / §32 say do not depend on it. GrapiX keeps a binary parser,
  but only for the static inspector (`/api/import/after-effects`); the runtime reads live AE via the
  adapter (aligned). The `.aep` → GrapiX-scene converter that most contradicted the plan was removed
  on 2026-08-26. Net: a mild, shrinking divergence.
- **Control authoring.** Plan: browse the live project → expose a property. Code: assemble a
  `CreateAeRuntimeContainerRequest` and POST it; controls entered by `prompt()`.
- **Module names.** Plan's `AeConnectorServer / AeProcessManager / AeProjectLoader /
  AeCommandRouter / AeHealthMonitor` (§27) map onto existing `AeRuntimeSupervisor / AeRuntimeClient /
  aeControlService / aeCueService` — same responsibilities, different names.
- **Cue vocabulary.** `CUE/IN/HOLD/CONTINUE/UPDATE/OUT/END` vs the plan's IN/LOOP/OUT + CUE/TAKE/
  CONTINUE/OUT/STOP/RESET.
- **Package shape.** No AE portable package exists at all (see Phase 6).

---

## 6. MVP readiness (plan §34)

| MVP item | Status | Where |
| --- | --- | --- |
| Connect to running AE | Partial | Playout supervisor attaches; no Editor connect |
| Detect open project | Partial | Supervisor; identity by `projectDigest` |
| List compositions | Built · not in Editor | `LIST_COMPOSITIONS` |
| List layers | Built · not in Editor | `LIST_LAYERS` |
| Read text layers | Built · not in Editor | `READ_PROPERTY` |
| Change text | Built · not in Editor authoring | `SET_PROPERTY` / `APPLY_DATA_REVISION` |
| Read footage | Partial | `LIST_PROJECT_ITEMS` |
| Replace image | Partial | `SET_PROPERTY` on source; no Editor UX |
| Read basic keyframes | Missing (confirmed) | No keyframe verb; adapter only *counts* keys as a write gate |
| Expose controls | Partial | Model complete; UX minimal |
| Save `controls.json` | Missing | Controls live in `container.json`, not a `controls.json` package file |
| Publish AEP + assets | Missing | Phase 6 |
| Load package in Playout | Missing | No package; Playout loads container config |
| Open project in AE | Built | Supervisor / adapter |
| Send text/image values | Built | `APPLY_DATA_REVISION` + `aeControlService` |
| Cue | Built | `aeCueService` / `aeCueMap` |
| Take | Built | `aeCueService` |
| Out | Built | `aeCueService` |

**Reading:** the MVP's runtime half is essentially present; the authoring half (Editor inspect →
expose → save `controls.json` → **publish AEP + assets** → load that package in Playout) is what is
missing.

---

## 7. If this plan is pursued — the shortest path to close the gap

Not a commitment; a note on sequencing implied by the analysis above.

1. **Phase 6 (publish package) is the keystone.** It is fully missing and it is what makes Playout
   independent of the designer's `.aep` location (plan §14, §32). Everything downstream already
   exists to consume a container; the package is the missing portable form.
2. **The Editor design-time connector (Phases 1–4 in the Editor)** is mostly *surfacing work*: the
   protocol verbs, adapter, and control model already exist. What is missing is an Editor connector
   service that opens the pipe during authoring and a project-browser UI that calls
   `LIST_COMPOSITIONS/LAYERS/PROPERTIES` and turns a selected property into an `AeDynamicControl`.
3. **Keyframe read (Phase 2) and project-sync events (§18)** are genuinely new protocol surface, not
   just wiring — scope them explicitly before promising the plan's inspection/timeline features.

Both items originally flagged as unconfirmed have since been checked against the source and are
recorded above as confirmed: **no keyframe-inspection verb exists** (the adapter only counts keys as
a write gate), and **no `LOOP` role exists** (`HOLD` is the nearest). Neither is a wiring gap — both
are new protocol surface.
