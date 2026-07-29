# GrapiX Editor and Playout Master Workspace

Status: **Approved target architecture; physical workspace migration is not yet implemented**

Source request:
`C:\Users\CG\.codex\attachments\83635fce-2420-4452-a0dc-51906b4b1a61\pasted-text.txt`

This document is the durable implementation handoff for splitting GrapiX into
two independently runnable products without losing the existing editor or
weakening the native Program-renderer boundary.

## Locked product boundary

The repository becomes one master workspace:

```text
GrapiX/
├── Editor/
├── Playout/
├── Shared/
└── package.json
```

- **Editor** is the authoring product. It creates scenes, materials, assets,
  fonts, animation, data bindings, transitions and automation definitions.
- **Playout** is the operator product. It receives published, immutable scene
  versions; manages scene libraries and rundowns; owns Preview/Program control;
  and drives the native renderer and output adapters.
- **Shared** owns schemas, protocol types and reusable packages. Shared packages
  must never depend on Editor or Playout applications.
- Editor must not become the authority for on-air Program state.
- Playout must continue operating from previously published scenes if Editor is
  closed, disconnected or restarted.
- The native Rust/wgpu daemon remains authoritative for Program rendering,
  frame timing, prepared resources and output state.

## Target repository layout

Exact internal names may evolve, but these ownership boundaries are fixed:

```text
GrapiX/
├── Editor/
│   ├── apps/
│   │   ├── desktop-tauri/
│   │   ├── desktop-electron/       # temporary fallback
│   │   └── editor-web/
│   ├── services/
│   │   └── project-api/
│   ├── tests/
│   └── package.json
├── Playout/
│   ├── apps/
│   │   ├── desktop-tauri/
│   │   └── playout-web/
│   ├── services/
│   │   ├── playout-control/
│   │   └── render-daemon/
│   ├── output/
│   │   ├── ndi/
│   │   ├── decklink/
│   │   └── aja/
│   ├── tests/
│   └── package.json
├── Shared/
│   ├── scene-schema/
│   ├── protocol-types/
│   ├── rundown-schema/
│   ├── transition-types/
│   ├── package-format/
│   ├── render-shaders/
│   ├── grapix-sdk/
│   └── common-utils/
├── tools/
│   ├── migration/
│   └── certification/
├── docs/
└── package.json
```

Current packages map into this target rather than being rewritten:

- `packages/shared-types` supplies the initial Shared scene, animation, font,
  rundown and transition schemas.
- `packages/renderer-protocol` supplies the renderer-control protocol.
- `packages/render-shaders` supplies shared GPU contracts.
- `packages/grapix-sdk` supplies scene automation authoring contracts.
- `services/api-server` becomes the Editor project/publish service.
- `services/render-daemon` moves under Playout ownership after the mechanical
  Editor-preservation move is verified.

The root remains an npm workspace/orchestrator and provides commands that can
build, test and run Editor, Playout, Shared packages and certification suites
independently.

## Runtime ownership

```text
Editor
  ├─ authoring state and undo/redo
  ├─ project/source asset storage
  ├─ validation and package publishing
  └─ authoring Preview
          │
          │ publish package + durable acknowledgement
          ▼
Playout
  ├─ published scene library
  ├─ rundowns, segments and operator data
  ├─ cue/Preview/Program state machine
  ├─ timecode and automation runtime
  ├─ control API
  └─ native Rust/wgpu renderer
          ├─ Preview channel
          ├─ Program channel
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
- Existing renderer protocol v2 remains the Playout-to-daemon control boundary.

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

Operators can search/filter the library and add a published scene version to a
rundown. Missing or incompatible assets must be visible before Cue or Take.

## Rundown document

The existing `RundownDocument`/`SequenceDocument` contracts are the starting
point. The shared schema must add the operator concepts below while keeping
runtime-only state out of the saved document.

Each rundown item stores:

- unique item ID;
- published scene/template ID and pinned or follow-latest version policy;
- editable item name;
- page/recall number;
- start/end timecode and duration;
- layer, channel and output destination;
- transition type/duration/delay;
- custom instance data;
- notes and operator colour;
- cue/automation policy.

Runtime status is owned by Playout and includes:

- online/offline availability;
- loaded, cued, Preview and Program state;
- current transition/playback state;
- validation/missing-asset/error status.

Supported actions:

- add, remove, duplicate, rename, reorder and drag/drop;
- copy/paste, update, refresh and replace scene;
- Cue, Preview, Take Online, Take Offline;
- Continue, Pause, Resume, Stop and Clear;
- recall/trigger by item ID or page number;
- keyboard, API and automation triggering.

Rundowns use a strict versioned JSON schema with atomic save, autosave,
revision history, restore, import/export, search/filter, locking, completion
marking and archive.

## Segment grouping

Items may be grouped into named segments such as Opening, Match 1, First Half,
Break, Awards and Closing.

Segments support:

- name, colour, notes and optional start time;
- expand/collapse;
- drag/drop reordering;
- duplicate and lock;
- clear and take-all-offline;
- save as a reusable rundown block.

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

Rundown instances may override template data without changing the published
source scene. Supported editor types include text, number, image, video,
colour, enum/dropdown, boolean, lists, tables, player/team/score/timer data and
external bindings.

When a scene declares a property live-updatable, Playout sends a typed,
revision-safe patch at a frame boundary without replaying the In animation or
rebuilding unrelated resources.

## Playout control API

The authenticated typed API covers:

- list scenes and rundowns;
- load scene and open rundown;
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

- rundown autosave and revision recovery;
- persistent published-scene and asset caches;
- offline operation from previously validated packages;
- connection recovery and idempotent replay;
- structured logs and operator action history;
- missing-asset and scene validation;
- RAM/VRAM/GPU/output monitoring;
- graceful shutdown;
- bounded renderer restart and safe fallback;
- restoration of the last rundown and last known on-air state where safe.

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
| `apps/editor-web` | `Editor/apps/editor-web` |
| `apps/desktop-tauri` | `Editor/apps/desktop-tauri` |
| `apps/desktop-electron` | `Editor/apps/desktop-electron` |
| `services/api-server` | `Editor/services/project-api` |

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
  rundown/segment persistence and autosave.
- **Implemented:** Playout-owned renderer protocol client with Cue-to-Preview
  and cut-to-Program state transitions.
- **Implemented:** one `dev:playout` supervisor for the web UI, control service
  and existing native daemon.
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
  renderer domain: `render-daemon` (the core plus the v2 binary) and `render-engine`. Playout
  consumes both as *running processes over a protocol*, never as source, which is exactly the
  boundary the split was for.
- Audited 2026-07-29: `Playout/apps/playout-web`, `Playout/services/playout-control` and
  `Playout/tools` exist with real source. `Playout/apps/desktop-tauri` does not exist yet.
  `Playout/output/{ndi,decklink,aja}` does not exist either, and on present evidence should
  not: the output adapters live in `services/render-engine/src/outputs.rs`, because the
  engine owns Program and its outputs, and Playout controls them over protocol v3 rather
  than hosting them. That is a deliberate divergence from the original sketch.
- **Remaining:** package upload/promotion, rundown editing depth, output
  configuration, offline reconciliation and the later transition/automation
  phases.

### Phase 5 — Implement Publish to Playout

- Endpoint management, authentication and discovery.
- Package upload, progress, validation, atomic promotion and version update.
- Reconnect/idempotency/duplicate-message tests.

### Phase 6 — Operator Preview/Program

- Scene Cue/Preview/Take controls.
- Continuous native Preview independent of Program.
- Layer/channel conflict model and operator statuses.

### Phase 7 — Sequencing and automation

- Rundown cursor, page recall, timecode, instance data and live updates.
- T1 transitions, Continue/Replace/Out logic and control API.

### Phase 8 — Reliability and certification

- crash/restart/offline recovery tests;
- 80-scene production rundown;
- long soak, device loss and output loss;
- NDI and later DeckLink/AJA hardware certification.

## Required verification

The migration is accepted only when:

- Editor builds/runs with no feature loss after the move;
- Editor and Playout build/run independently;
- Shared contracts compile once and are consumed by both;
- publishing survives reconnect and duplicate delivery;
- an older published version remains usable after a newer publish;
- rundown add/remove/reorder/segment/autosave/restore tests pass;
- Preview and Program state are independent;
- layer conflicts and transition state are deterministic;
- Program survives Editor disconnect/reload;
- Playout restores its last rundown and safely reconciles on-air state;
- output/certification gates remain honest.

## Handoff rule

Future agents, including Claude, must read this document together with
`memory.md` and `docs/architecture-review-compliance.md` before moving folders
or creating the Playout application. Phase 0 and Phase 1 are complete. The next
implementation step is the gated Phase 2 mechanical Editor preservation move,
not feature redesign or an unverified repository-wide move.
