# GrapiX Editor and Playout Master Workspace

> **V1 authority note (2026-07-29):** [`architecture.md`](architecture.md) is
> authoritative for the three-product boundary, persistent Engine Host,
> protocol-v3 connections, native Render View extensions and recovery. Any
> older statement below that places the renderer inside Playout or retains the
> protocol-v2 daemon as the target runtime is superseded.

Status: **Approved target; Editor/Playout/Shared migration phases 1-3 are implemented**

Source request:
`C:\Users\CG\.codex\attachments\83635fce-2420-4452-a0dc-51906b4b1a61\pasted-text.txt`

This document is the durable implementation handoff for separating Editor and
Playout while keeping the Render Engine independently runnable and preserving
the native Program-renderer boundary.

## Locked product boundary

The repository becomes one master workspace:

```text
GrapiX/
├── Editor/
├── Playout/
├── Shared/
├── services/
│   ├── render-engine/
│   └── render-daemon/       # render-core library (no binary)
└── package.json
```

- **Editor** is the authoring product. It creates scenes, materials, assets,
  fonts, animation, data bindings, transitions and automation definitions.
- **Playout** is the operator product. It receives published, immutable scene
  versions; manages the Scene Manager and take lists; owns Preview/Program control;
  and controls the native Render Engine and output adapters through protocol v3.
- **Shared** owns schemas, protocol types and reusable packages. Shared packages
  must never depend on Editor or Playout applications.
- Editor must not become the authority for on-air Program state.
- Playout must continue operating from previously published scenes if Editor is
  closed, disconnected or restarted.
- The standalone native Rust/wgpu Render Engine remains authoritative for Program rendering,
  frame timing, prepared resources and output state.

## Target repository layout

The sketch below was the original request. The **as-built** layout differs in
three deliberate ways, recorded here so the divergences are decisions rather than
drift: `Shared/` kept its existing package names instead of being renamed to the
sketch's schema-oriented ones, `tools/migration/` was never created because no
migration script outlived its move, and the output adapters stayed in the engine.

```text
GrapiX/
├── Editor/
│   ├── apps/
│   │   ├── desktop-tauri/          primary shell: project service + ensured engine
│   │   ├── desktop-electron/       temporary fallback
│   │   └── editor-web/
│   ├── services/
│   │   └── project-api/
│   └── package.json
├── Playout/
│   ├── apps/
│   │   ├── desktop-tauri/          ensured engine + owned control service
│   │   └── playout-web/
│   ├── services/
│   │   └── playout-control/
│   ├── tools/
│   └── package.json
├── Shared/                         13 contract packages; see Shared/README.md
│   ├── shared-types/               scene, animation, font, rundown, transition schemas
│   ├── scene-model/  stage-model/  surface-model/  tile-system/
│   ├── animation-engine/  asset-manager/  output-contracts/  renderer-contracts/
│   ├── shader-library/  render-shaders/
│   ├── render-protocol/            protocol v3 client and contracts
│   └── grapix-sdk/                 scene automation authoring contracts
├── services/
│   ├── render-engine/              persistent Host/worker and outputs
│   └── render-daemon/              render-core library; v2 binary deleted
├── tools/
│   ├── architecture/               boundary and structure guards
│   └── certification/
├── docs/
└── package.json
```

Ownership, which is the part that is fixed:

- `Shared/shared-types` owns the scene, animation, font, rundown and transition
  schemas the sketch split across `scene-schema`, `rundown-schema`,
  `transition-types` and `package-format`. One package, because they share types
  and a split would have meant either duplication or a dependency chain between
  four packages that always change together.
- `Shared/render-protocol` supplies the protocol-v3 engine client and contracts.
  The sketch's `protocol-types` is this.
- `Shared/render-shaders` supplies shared GPU contracts.
- `Shared/grapix-sdk` supplies scene automation authoring contracts.
- `common-utils` was never created: nothing needed a home that did not already
  have one, and an empty utility package attracts everything that does not fit.
- `Editor/services/project-api` owns Editor project/publish operations.
- `services/render-engine` is independently deployable and owns Program/output.
- `services/render-daemon` stays in the renderer domain as the private
  render-core dependency. Its protocol-v2 binary was deleted on 2026-07-29 —
  nothing launched it, no test exercised it, and a renderer able to bind a port
  and drive its own outputs is a way to put unverified pixels on air.
- Neither product has a `tests/` directory. Tests live beside the code they
  cover, in each package.

The root remains an npm workspace/orchestrator and provides commands that can
build, test and run Editor, Playout, Shared packages and certification suites
independently.

## Runtime ownership

```text
Editor
  ├─ authoring state and undo/redo
  ├─ project/source asset storage
  ├─ validation and package publishing
  └─ Editor Render View client
          │
          │ durable local package publication
          ▼
Playout
  ├─ published scene library
  ├─ Scene Manager, take lists and operator data
  ├─ cue/Preview/Program state machine
  ├─ timecode and automation runtime
  ├─ control API
  └─ Playout Render View client

Editor and Playout
          │ authenticated persistent protocol v3
          ▼
Render Engine
  ├─ persistent Engine Host
  ├─ native Rust/wgpu Render Worker
  ├─ Editor and Playout Render View extensions
  ├─ Program channel and frame clock
  └─ NDI / recording / future SDI
```

Editor and Playout may each use Tauri 2 as their desktop supervisor, but they
are separate applications, have separate persistence roots and must be
independently runnable.

## Editor-to-Playout publish plane

Publishing is a durable transfer, not a transient renderer patch.

The recommended split is:

- HTTP(S) upload for the versioned `.gfxpkg` scene package and large assets.
- Persistent authenticated WebSocket for connection state, publish progress,
  acknowledgement, library updates and operator/control events.
- Renderer protocol v3 is the shared Editor/Playout-to-Engine control boundary.
  Protocol v2 remains migration-only code and is not a target runtime fallback.

Every connection must support:

- automatic reconnect with bounded backoff;
- heartbeat/keep-alive and health state;
- request ID, sequence number and acknowledgement;
- idempotency key and duplicate-message rejection;
- scene ID plus monotonic scene version/revision;
- explicit error codes and retryability;
- local-network operation by default;
- authenticated TLS-capable remote operation;
- multiple named Playout endpoints without broadcasting accidentally.

### Publish to Playout

Editor gains a **Publish to Playout** action:

1. Validate the source scene and current revision.
2. Run package/capability preflight.
3. Build a strict `.gfxpkg` containing scene definitions, fonts, images,
   videos, shaders, materials, animations, scripts, bindings, masks, effects,
   transitions and every required local asset.
4. Compute and verify file/package checksums.
5. Select one or more configured Playout endpoints.
6. Upload with progress and cancellation.
7. Playout stores the package in a staging area and revalidates it.
8. Playout atomically promotes the scene version into its library.
9. Playout returns success, warning or failure with structured diagnostics.
10. Editor records the endpoint, published version, time and acknowledgement.

Publishing a newer revision updates the library version; it must not mutate an
already online prepared version in place. Playout decides when the newer
version is safe to load or replace.

## Published scene library

Playout stores all accepted scenes and templates with:

- unique scene ID;
- scene and template name;
- monotonic version/revision;
- thumbnail;
- duration and rational frame rate;
- default transition;
- tags and category;
- last-updated and published time;
- source Editor/endpoint identity;
- package checksum;
- published, validation and asset-readiness status;
- required renderer capabilities and estimated memory.

Operators search or filter the Scene Manager and either take a scene straight to
air by its Take ID or add it to a Take List. Missing or incompatible assets must
be visible before Cue or Take.

## Scene Manager

> **Superseded 2026-07-29.** The rundown-and-segments model described here
> originally is gone. Playout now follows Ross XPression's Sequencer; see
> [`architecture.md`](architecture.md), "Operator model".

The primary operator surface. Every published scene, grouped by category, each
carrying a numeric **Take ID**:

- Take IDs start at 101 and are assigned on first publish;
- they are **stable across republishes**, so a rehearsed number does not move
  under an operator when a designer publishes a new version mid-show;
- a freed number is reused rather than the counter climbing forever, because
  operators memorise these;
- typing a Take ID takes that scene to air with no list involved.

A recall always resolves to the **newest** published version. A take list entry
may pin an older one.

## Take List

An ordered running order, for a scripted show. Optional: the Scene Manager stands
alone.

Each entry stores:

- unique entry ID — not the scene's Take ID, which is a different thing;
- published scene ID and version, with a `pinned` or `latest` version policy;
- editable entry name;
- layer;
- transition in/out with duration and delay;
- custom instance data, which overrides the published scene without changing it;
- notes, operator colour and completion flag.

The list carries a persisted **cursor**: the entry Take In will act on next.
Continue advances it, and it clears at the end rather than wrapping — a running
order that silently looped would re-air the top of the show.

Runtime status is owned by Playout and reported separately from the saved
document: per-target state, what is on Preview and Program, and
validation/missing-asset/error status. A direct Scene Manager recall is reported
under `scene:take-<id>` rather than borrowing an entry id, so the Take List never
highlights a row that is not what is on air.

Supported actions: add, remove, reorder, rename, pin/unpin a version, Cue,
Take In, Take Out, Continue, and recall by Take ID from keyboard or API.

A take list **autosaves and has no revision number**. It is operator working
state; the immutable versioned artifacts are the published scenes it points at.

What was deliberately dropped with the rundown: segments (grouping belongs to the
Scene Manager's category), per-item page numbers (superseded by the Take ID) and
document revision history (autosave replaces it).

## Preview and Program

Playout exposes independent native Preview and Program channels.

Preview supports scene load, animation play, timeline scrub, pause/resume,
transition tests, instance-data edits, safe areas, transparency and font/asset
readiness checks.

Program represents the live output and has strict priority. A Preview or UI
restart must not interrupt Program.

Visible operator states:

```text
NOT_LOADED
LOADING
LOADED
CUED
IN_PREVIEW
TAKING_ONLINE
ONLINE
CONTINUING
TAKING_OFFLINE
OFFLINE
MISSING_ASSET
DISCONNECTED
ERROR
```

## Transition and layer state model

Transition logic covers:

- In, Out, Continue, Replace and scene-to-scene transitions;
- layer transitions, duration, delay and markers;
- automatic Out before the next item;
- direct replacement while online;
- persistent graphics;
- foreground/background and fullscreen/overlay coordination;
- conflict prevention and explicit failure.

Before executing an action, Playout resolves whether an online graphic should
remain online, update data, continue, transition out, be replaced, share a
layer or move to another layer.

Example layers/channels include Background, Fullscreen, Lower Third, Scorebug,
Overlay, Bugs, Alerts and Foreground. Each layer declares whether it is
exclusive or composable. Exclusive-layer conflicts are rejected or resolved
through an explicit operator-approved replacement rule.

The transition runtime extends the existing T0/T1/T2 plan:

- T0 cut remains the first supported operation.
- T1 mix/dip/wipe/push uses outgoing and incoming protected scenes plus dual
  render targets.
- T2 custom transitions require a validated, bounded shader manifest.

## Timecode and automation

Playout owns timecode, not the Editor tab.

Sources:

- manual timecode;
- system clock;
- countdown/count-up;
- external timecode;
- scheduled and duration-based actions.

Supported rates use rational arithmetic:

- 24000/1001 (23.976)
- 24
- 25
- 30000/1001 (29.97)
- 30
- 50
- 60000/1001 (59.94)
- 60

Automation supports scheduled Cue, Take Online, Take Offline, Continue and next
item. External timecode/authentication adapters remain explicit capability
gates until implemented and certified.

## Operator data and live updates

Take-list entries may override template data without changing the published
source scene. Supported editor types include text, number, image, video,
colour, enum/dropdown, boolean, lists, tables, player/team/score/timer data and
external bindings.

When a scene declares a property live-updatable, Playout sends a typed,
revision-safe patch at a frame boundary without replaying the In animation or
rebuilding unrelated resources.

## Playout control API

The authenticated typed API covers:

- list scenes and take lists;
- load scene, recall by Take ID, open a take list;
- Cue and Preview item;
- Take Online/Offline and Continue;
- pause/resume/stop;
- update data;
- clear layer;
- query output and connection status;
- trigger by item ID or page number;
- start/stop automation.

Shared schemas define requests, acknowledgements, events, errors and status.
Remote commands require authorization, replay protection, rate limiting and
operator-audit entries.

## Reliability requirements

Playout must provide:

- take-list autosave and recovery;
- persistent published-scene and asset caches;
- offline operation from previously validated packages;
- connection recovery and idempotent replay;
- structured logs and operator action history;
- missing-asset and scene validation;
- RAM/VRAM/GPU/output monitoring;
- graceful shutdown;
- bounded renderer restart and safe fallback;
- restoration of the last take list and last known on-air state where safe.

A restart must never blindly replay a Take. Recovery reconciles persisted
intent with renderer/output status and requires operator confirmation when the
state is ambiguous.

## Safe migration plan

Do not perform this as one unverified directory move.

### Phase 0 — Stabilize the current branch — Complete

- Completed on 2026-07-28 in Basic v0.1 commit `a387f5c`.
- Editor/native-renderer/font work passed workspace typechecks/tests, native
  daemon tests (including real GPU smoke), and production builds.
- Current development, build, package and certification commands are recorded
  in `memory.md`.

### Phase 1 — Add the master workspace scaffold — Complete

- Root `Editor`, `Playout` and `Shared` workspace entries are registered.
- Basic v0.1 compatibility commands remain at the root.
- Independent domain commands are available as `dev:editor`, `dev:playout`,
  `build:editor`, `build:playout`, `build:shared`, `test:editor`,
  `test:playout`, and `test:shared`.
- `npm run check:boundaries` enforces Editor ↔ Playout isolation and prevents
  Shared from depending on either application.
- Existing source remains in place intentionally until Phase 2.

### Phase 2 — Mechanical Editor preservation move — Complete

Completed 2026-07-29 with `git mv`, so history follows every file:

| Was | Now |
| --- | --- |
| `Editor/apps/editor-web` | `Editor/apps/editor-web` |
| `Editor/apps/desktop-tauri` | `Editor/apps/desktop-tauri` |
| `Editor/apps/desktop-electron` | `Editor/apps/desktop-electron` |
| `Editor/services/project-api` | `Editor/services/project-api` |

npm package names are unchanged, so nothing that imports `@grapix/api-server` or
`@grapix/editor-web` had to change. What did change is every path that climbs to the
repository root, because each workspace is now one level deeper: tsconfig `extends` and
`paths`, the Tauri config's `frontendDist` and `beforeDevCommand`, the Electron main
process's root resolution, the desktop shell's `workspace_root()` and sidecar staging, and
two Rust test fixtures that read from the project API's test data.

The Tauri build cache had to be cleared: its generated permission files embed absolute
paths, so a stale cache fails the build with a missing-file error that names the *old*
location. Only the generated output was removed, not the 4.5 GB of compiled dependencies.


- Move current source, assets, configs and tests into `Editor` with history.
- Fix workspace paths, Vite/Tauri/Electron config, Rust manifests, scripts,
  assets and CI.
- Do not redesign features during the move.
- Require behavioral parity and all existing tests before continuing.

### What the move actually broke, and how it was caught

Every one of these was a silent failure — nothing refused to compile:

| Fault | How it showed |
| --- | --- |
| The project API's data root walked three levels up from its own file, which used to reach the repository root and now reached `Editor/`. | `GET /api/scenes` returned **zero** scenes while a hundred sat in `data/scenes`. Caught by probing the running API rather than by any test. |
| Two Rust test fixtures read from the project API's test data by relative path. | Two GPU tests failed with `NotFound`. |
| The desktop shell's `workspace_root()` and sidecar staging walked to the repository root. | Would have made the supervisor look for services in the wrong place and start none — no error, just nothing running. |
| The desktop shell's own npm scripts reached the renderer domain by relative path. | `npm run dev:editor` failed with `manifest path does not exist`. |
| The Tauri build cache embeds absolute paths in generated permission files. | Build failed naming the *old* path, which is a confusing way to learn the cache is stale. |

The lesson the plan already stated and this confirmed: a move like this is only done when the
running system has been probed, not when the compiler is happy. Nothing here would have been
found by a typecheck.

### Phase 3 — Extract Shared packages — Complete

Completed 2026-07-29. All fourteen packages moved from `packages/` to `Shared/`, and
`packages/` no longer exists. Package names are unchanged.

`Shared/<name>` is the same depth as `packages/<name>` was, so every `extends` inside a
package stayed valid — the changes were all *references from outside*: two tsconfig path
maps, two Rust `include_str!` calls that compile the WGSL sources into the renderer, one test
fixture path, and the workspace globs. The `include_str!` pair is worth noting because a
mistake there is a build failure rather than a silent one, which is the good kind.

Shared builds, typechecks and tests all thirteen contract packages with test suites
(**445 tests**), and `check:boundaries` enforces that none of them depends on Editor or
Playout.


- Move schemas/protocols/shaders/SDK/package-format modules into `Shared`.
- Keep package names and compatibility exports during migration.
- Enforce Shared → no application dependency.

### Phase 4 — Create the Playout foundation — In progress

- **Implemented:** independent React/Vite operator shell, persistent control
  service and visible renderer connection status.
- **Implemented:** immutable monotonic published scene versions plus atomic
  take-list persistence and autosave.
- **Implemented:** Playout-owned renderer protocol client with Cue-to-Preview
  and cut-to-Program state transitions.
- **Implemented:** one `dev:playout` supervisor for the web UI, control service
  and the render engine.
- **Implemented 2026-07-29:** the dedicated Playout Tauri 2 desktop shell at
  `Playout/apps/desktop-tauri` (`@grapix/playout-desktop`). It supervises the render engine
  on 4400 and the control service on 4300, **adopts** either if it is already running rather
  than replacing it, and on window close stops only what it started — an adopted engine may
  be on air, and closing an operator window must never take a show off air. It deliberately
  does not start the protocol v2 daemon: two renderers competing for one GPU is the opposite
  of holding a frame deadline.
- **Deliberately not done — the native daemon stays at `services/`.** The original sketch put
  it under Playout, which predates the engine separation. The same crate is now the engine's
  core library (`grapix-render-core`), so moving it into Playout would put the engine's core
  inside the Playout product and break "keep the engine deployable independently" — a newer
  and stronger constraint than the sketch it contradicts. `services/` therefore holds the
  renderer domain: `render-daemon` (the render-core library; its v2 binary was deleted
  2026-07-29) and `render-engine`. Playout consumes the engine as a *running process over a
  protocol*, never as source, which is exactly the boundary the split was for.
- Audited 2026-07-29: `Playout/apps/playout-web`, `Playout/apps/desktop-tauri`,
  `Playout/services/playout-control` and `Playout/tools` all exist with real source.
  `Playout/output/{ndi,decklink,aja}` does not exist, and on present evidence should not:
  the output adapters live in `services/render-engine/src/outputs.rs`, because the engine
  owns Program and its outputs, and Playout controls them over protocol v3 rather than
  hosting them. That is a deliberate divergence from the original sketch.
- **Remaining:** package upload/promotion, take-list editing depth, output
  configuration, offline reconciliation and the later transition/automation
  phases.

### Phase 4a — Retire protocol v2 from both applications — Complete

Completed 2026-07-29. The migration left two runtimes wired in parallel, which the
architecture forbids: "Editor and Playout must not launch, package or fall back to the v2
server." What was removed, and why each one mattered:

| Removed | Why |
| --- | --- |
| `Shared/renderer-protocol` (the whole package) | The v2 TypeScript client. With no consumer left it was a live path back to a retired runtime. |
| `Editor/apps/editor-web/src/rendering/RendererClient.ts` | Dead: zero importers. The Editor already talks v3 through `engineClient`. |
| `Editor/services/project-api/src/renderDaemon.ts` and every `/api/render-daemon/*` route | The Editor was issuing Take and output configure/start/stop — a flat violation of invariant 4. Preview and warm verbs went with it; their correct home is the Editor Render View over v3 (M2). |
| The Editor project service's automation `execute` path | Editor now evaluates automation and returns the plan; executing it is an operator action. |
| The Editor desktop shell's daemon sidecar, watchdog, Program restore and output restart | An authoring window owned Program recovery and could stop the renderer on close, breaking invariants 3, 4 and 5. It now *ensures* the engine and never stops it. |
| `Playout/services/playout-control/src/rendererClient.ts` and the runtime fallback | Playout preferred the engine and fell back to v2. A fallback rendering different pixels through a different output configuration is not a safety net. |
| `activeRenderer` on `PlayoutRuntimeStatus` | There is one renderer; a field naming which one carried an operation was reporting a choice that no longer exists. |
| `tools/certification/run-soak.mjs`, `run-local-e2e.mjs` | Both certified the v2 path, and the e2e harness still pointed at the pre-migration `services/api-server/dist`. See the honest gap recorded in `architecture-review-compliance.md`. |

`npm run check:boundaries` now fails on any dependency or import of a retired package, so
this cannot quietly come back.

### Phase 4b — Replace the rundown with the XPression operator model — Complete

Completed 2026-07-29. The operator surface is now Ross XPression's Sequencer: a **Scene
Manager** keyed by Take ID, plus an optional ordered **Take List**. See
[`architecture.md`](architecture.md), "Operator model", for the contract.

| Was | Now |
| --- | --- |
| `PlayoutRundownDocument`, `PlayoutRundownItem`, `PlayoutRundownSegment` | `PlayoutTakeList`, `PlayoutTakeEntry` |
| `PlayoutItemState`, `PLAYOUT_ITEM_STATES` | `PlayoutTakeState`, `PLAYOUT_TAKE_STATES` |
| `previewItemId` / `programItemId` / `itemStates` | `previewRef` / `programRef` / `takeStates` |
| `/api/playout/rundowns*` | `/api/playout/take-lists*` |
| `POST /control/:action` with `rundownId` + `itemId` | `POST /control/:action` with a Take ID **or** a take-list entry |
| `data/playout/rundowns/` | `data/playout/take-lists/` |
| `run-publish-rundown-e2e.mjs` | `run-publish-takelist-e2e.mjs` (`npm run certify:publish-takelist`) |

Decisions worth keeping:

- **Take IDs are stable across republishes.** Assigned on first publish from 101 and reused
  when freed, because operators memorise them. A rehearsed number that moved when a designer
  republished mid-show would be a way to air the wrong graphic.
- **A direct recall is not a fake take-list entry.** It is tracked under `scene:take-<id>`, so
  the Take List cannot highlight a row that is not what is on air.
- **An ambiguous command is refused.** Naming both a Take ID and an entry returns 400 rather
  than resolving to whichever field the code reads first.
- **The cursor clears at the end of the list** instead of wrapping. A running order that
  silently looped would re-air the top of the show.
- **A take list has no revision counter.** It autosaves; the versioned immutable artifacts are
  the published scenes it points at.
- **`RundownDocument` in `Shared/shared-types` was left alone.** That is the Editor's
  authoring-time sequencing and automation model consumed by `@grapix/sdk` — a different
  concept from an operator running order, and XPression Designer has its equivalent.

Two operator verbs that were dead buttons are now implemented: **Take Out** clears Program
through the engine, and **Continue** advances the take-list cursor.

### Phase 5 — Implement Publish to Playout

- Endpoint management, authentication and discovery.
- Package upload, progress, validation, atomic promotion and version update.
- Reconnect/idempotency/duplicate-message tests.

### Phase 6 — Operator Preview/Program

- Scene Cue/Preview/Take controls.
- Continuous native Preview independent of Program.
- Layer/channel conflict model and operator statuses.

### Phase 7 — Sequencing and automation

- Take-list cursor, Take ID recall, timecode, instance data and live updates.
- T1 transitions, Continue/Replace/Out logic and control API.

### Phase 8 — Reliability and certification

- crash/restart/offline recovery tests;
- 80-scene production take list;
- long soak, device loss and output loss;
- NDI and later DeckLink/AJA hardware certification.

## Required verification

The migration is accepted only when:

- Editor builds/runs with no feature loss after the move;
- Editor and Playout build/run independently;
- Shared contracts compile once and are consumed by both;
- publishing survives reconnect and duplicate delivery;
- an older published version remains usable after a newer publish;
- take-list add/remove/reorder/autosave/restore tests pass;
- Preview and Program state are independent;
- layer conflicts and transition state are deterministic;
- Program survives Editor disconnect/reload;
- Playout restores its last take list and safely reconciles on-air state;
- output/certification gates remain honest.

## Handoff rule

Future agents, including Claude, must read this document together with
[`architecture.md`](architecture.md), [`local-v1-system-design.md`](local-v1-system-design.md)
and `memory.md` before moving folders or changing a product boundary.

Phases 0–3 and 4a are complete; Phase 4 is partly done. The next implementation
step is **milestone M2** in `local-v1-system-design.md` — engine-side role
enforcement, scene domain keying and the native Editor Render View — not feature
redesign and not another repository-wide move. Any move is gated on
`npm run check:boundaries`, a full `npm run typecheck`, and `npm test`, and on
probing the running system: every fault the Phase 2 and Phase 3 moves caused was
silent, and none would have been caught by a typecheck.
