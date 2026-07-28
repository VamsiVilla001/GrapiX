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

### Phase 0 — Stabilize the current branch

- Finish and verify current uncommitted Editor/native-renderer/font work.
- Update architecture status.
- Create a recoverable commit before moving paths.
- Record current development, build, package and certification commands.

### Phase 1 — Add the master workspace scaffold

- Add root `Editor`, `Playout` and `Shared` workspace entries.
- Keep compatibility scripts at the root.
- Add dependency-boundary checks.

### Phase 2 — Mechanical Editor preservation move

- Move current source, assets, configs and tests into `Editor` with history.
- Fix workspace paths, Vite/Tauri/Electron config, Rust manifests, scripts,
  assets and CI.
- Do not redesign features during the move.
- Require behavioral parity and all existing tests before continuing.

### Phase 3 — Extract Shared packages

- Move schemas/protocols/shaders/SDK/package-format modules into `Shared`.
- Keep package names and compatibility exports during migration.
- Enforce Shared → no application dependency.

### Phase 4 — Create the Playout foundation

- Add Playout Tauri/web shell, persistent storage and connection status.
- Implement published scene library, rundown/segment persistence and autosave.
- Move the native render daemon under Playout runtime ownership.

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
or creating the Playout application. The next implementation step is Phase 0,
not an immediate unverified repository-wide move.
