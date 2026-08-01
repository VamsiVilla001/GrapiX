# GrapiX Local V1 Architecture

Status: **Approved target, implementation incomplete**
Last reviewed: **2026-07-29**

This document is the canonical product and runtime architecture for GrapiX V1.
V1 is local-only. Remote Editor-to-Playout workflows, remote render nodes,
multi-machine failover, TLS deployment and distributed rendering are V2.

## Product model

GrapiX has exactly three product-level applications:

```text
GrapiX
├── Editor
│   ├── authoring UI and project state
│   ├── scene, material, font, script and timeline tools
│   ├── Editor Render View client
│   └── durable Publish to Playout
├── Playout
│   ├── Scene Manager: the published scene library, keyed by Take ID
│   ├── Take List: an ordered running order with a cursor
│   ├── automation, timecode and operator data
│   ├── Playout Render View client
│   └── Preview, Program and output control
└── Render Engine
    ├── persistent Engine Host
    ├── native Rust/wgpu Render Worker
    ├── Render View extensions
    ├── Program frame clock and outputs
    └── durable recovery journal and asset cache
```

`Shared/` contains schemas, protocol clients, shaders and SDK contracts. It is
not a fourth application and cannot depend on Editor or Playout.

## Non-negotiable invariants

1. The Render Engine is the only implementation that evaluates and rasterizes
   production scene pixels.
2. Editor and Playout never import renderer internals or own Program GPU state.
3. Editor owns mutable authoring content. It cannot change Program or outputs.
4. Playout owns published scene operations and is the only client allowed to
   Cue, Take, Continue, Clear Program or configure outputs.
5. Program, its frame clock and its outputs continue if Editor, Playout or both
   disconnect or close.
6. A mutable Editor scene can never replace a published Playout scene in place.
7. A fallback may not silently produce visually different pixels.
8. A process or transport can fail; GrapiX guarantees automatic detection,
   indefinite reconnect, verified recovery and explicit degraded state rather
   than claiming an impossible unbreakable connection.

## Local V1 runtime

```text
Editor UI ── Editor Engine Session ─────┐
                                       │ authenticated protocol v3
Playout UI ─ Playout Control Service ──┼── ws://127.0.0.1:4400
                                       │
                         ┌─────────────▼─────────────┐
                         │ Persistent Engine Host    │
                         │ single instance / watchdog│
                         └─────────────┬─────────────┘
                                       │ supervises
                         ┌─────────────▼─────────────┐
                         │ Native Render Worker      │
                         │ shared scene/GPU runtime  │
                         ├───────────────────────────┤
                         │ Editor Render View        │
                         │ Playout Render View       │
                         │ Program + Outputs         │
                         └───────────────────────────┘
```

The Engine Host belongs to the Render Engine product. Either application may
ensure that it is running, but neither application owns it or terminates it on
window close. The host uses a machine-wide single-instance lock, supervises the
GPU worker and restarts it with bounded exponential backoff.

Both applications use the same `@grapix/render-protocol` v3 connection
implementation. Connections start with the application, not with a panel.
Heartbeat timeout, sequence tracking, duplicate protection, resynchronisation
and reconnect run for the lifetime of the application.

The V1 transport is authenticated loopback WebSocket. A per-installation token
is read by native services and injected into the client in memory. It is not
stored in browser local storage. IPC remains supported infrastructure but is
not the V1 application path.

## Render View extensions

A Render View is a specialised view of the main native renderer, not a second
scene renderer embedded in React.

### Editor Render View

- Renders mutable authoring scenes in a private Editor preview context.
- Supplies colour/alpha frames plus picking, bounds and camera metadata.
- Uses adaptive resolution and latest-frame-wins backpressure during editing.
- The browser draws rulers, guides, selections, gizmos and interaction overlays.
- It has no Program or output authority.

### Playout Render View

- Renders the operational Preview channel and Program confidence monitor.
- Uses immutable published scene revisions and Playout runtime instance data.
- Shows output, frame-clock, asset-readiness and recovery status.
- It may be configured as a local warm standby worker only after the standby
  certification gate described below.

**Implemented 2026-07-29 for the confidence monitors.** `playout-control` holds the
engine's `preview.streamStart` stream per channel and view, and republishes it to the
operator UI as `multipart/x-mixed-replace` MJPEG at
`GET /api/playout/monitor/{preview,program}?view={fill,key}`. Streams are refcounted, so N
operator viewers cost one engine stream and an unattended station renders nothing. The
operator UI paints frames over the metadata slate rather than replacing it, so a gap
reveals the slate instead of a blank monitor. Certified by `npm run certify:monitors`.

**Fill and key, not an alpha channel.** Broadcast carries transparency as a separate
greyscale key signal because SDI has no alpha; the downstream keyer recombines fill and
key. Operators verify a graphic by looking at the key as a greyscale picture — white
opaque, black transparent, grey for feathered shadows and anti-aliased edges. The key is
therefore a **render mode** in `preview.rs`, not a transport concern: it is an ordinary
greyscale image, so JPEG carries it exactly and no alpha-capable codec is involved
anywhere. An alpha codec would have delivered a design-tool checkerboard no operator uses
while adding a PNG deflate per frame and a transcode. Streams remain JPEG-only for the same
reason.

The monitor renders the **stage**, so a stage larger than the scene canvas letterboxes the
scene — correct for a stage monitor, and worth knowing before configuring a video-wall
stage.

**Animation playhead (2026-07-29).** The Program clock advances the on-air scene's playhead
and `engine.getStatus` reports it per scene as `frame`. Preview streams render that frame, so
the clock keeping its counter private was why monitors showed a still picture while the
renderer animated correctly. The playhead advances whenever a scene is on air rather than only
when an output transmits, because an operator confirms a graphic before any output exists; it
advances by elapsed frames so a dropped frame does not turn into slow motion. A take rewinds
to frame 0; a cue does not rewind a scene already on Program, since Preview and Program may
name the same loaded scene and share one playhead. Certified by
`npm run certify:take-animation`.

### Program extension

- Is global and controlled only by an authenticated Playout role.
- Owns the rational broadcast frame clock and output adapters.
- Has first priority for GPU memory, scheduling and asset residency.

Render priorities are: Program, Playout Preview/prepared scenes, Editor active
view, background thumbnails and exports.

## Scene and channel isolation

Every loaded scene is addressed by:

```ts
interface SceneRef {
  projectId: string;
  domain: "authoring" | "published";
  sceneId: string;
  revision: number;
}
```

Authoring scenes are mutable and private to an Editor session. Published scenes
are immutable, checksum-verified package revisions owned by Playout. Program
accepts only `domain: "published"`.

Preview is not a single global scene:

- Editor preview contexts are private to each Editor instance.
- Playout Preview is an operational channel shared by Playout clients.
- Program is a single global channel.
- Auxiliary channels are named and Playout-owned.

The engine stores the authenticated client identity, role, project and instance
for each connection and enforces permissions server-side. Omitting a dangerous
verb from a UI wrapper is not considered authorization.

## Operator model

Playout follows Ross XPression's Sequencer, not a newsroom rundown. There are two
surfaces, and the first one is sufficient on its own:

**Scene Manager** — every published scene, grouped by category, each carrying a
numeric **Take ID**. An operator types a Take ID and that scene goes to air. No
list, no cursor, no preparation ceremony. This is the primary surface.

**Take List** — an ordered list of takes for a scripted show. Each entry
references a published scene and version, with its own layer, transition and
instance data. A persisted cursor marks what Take In will act on next, and
Continue advances it. A take list is operator working state: it autosaves and
carries no revision number, because the immutable versioned artifacts are the
published scenes it points at.

Take IDs are assigned on first publish, start at 101, and are **stable across
republishes**. An operator who rehearsed "take 104" must still get that scene
after a designer publishes a new version mid-show.

A command names either a Take ID or a take-list entry, never both. The engine and
the control service refuse an ambiguous command rather than resolving it to
whichever field they happen to read first.

What this model deliberately does not have, and why:

| Removed | Replaced by |
| --- | --- |
| Rundown segments | The Scene Manager's category, which is where grouping belongs |
| Per-item page numbers | The scene's own Take ID |
| Rundown document revisions | Autosave; a take list is not a publication |

`RundownDocument` in `Shared/shared-types` is unrelated: it is the Editor's
authoring-time sequencing and automation model, consumed by `@grapix/sdk`. The
operator model above replaced `PlayoutRundownDocument` only.

## Rendering and frame delivery

The native renderer is authoritative for Editor, Playout Preview and Program.
The production Editor path does not use PixiJS or Three.js to rasterize scene
content. Browser rendering is limited to UI and interaction overlays.

Local Render View frames use a binary alpha-preserving payload:

```ts
interface RenderViewFrameHeader {
  viewId: string;
  scene: SceneRef;
  frameNumber: number;
  stateRevision: number;
  width: number;
  height: number;
  stride: number;
  pixelFormat: "bgra8" | "rgba8";
  payloadLength: number;
}
```

Editor interaction patches are coalesced to at most one patch batch per browser
animation frame. The engine may reduce Render View resolution while the pointer
is moving and must restore the requested resolution after interaction settles.
JPEG remains suitable for thumbnails and diagnostics, not the main
alpha-sensitive authoring viewport.

## Failure and backup model

Render View extensions improve isolation and recovery, but they are not
automatically safe Program backups merely because they reuse render-core.

| Failure | Required V1 behavior |
| --- | --- |
| Editor or Editor Render View closes | Program and Playout Preview continue. Reopening Editor creates/resumes its private view. |
| Playout UI closes | Program, outputs and Engine Host continue. Reopening Playout reconciles engine state before enabling controls. |
| Render View session fails | Restart only that view. Display its cached last-good frame with a visible `RECOVERING` state. |
| Protocol connection fails | Reconnect indefinitely, authenticate, compare state revisions, full-sync gaps and resubscribe views. |
| Primary Render Worker crashes | Engine Host restarts it, restores a verified Program snapshot and resumes outputs only after a valid first frame. |
| GPU device is lost | Recreate the device and pipelines, then use the same verified restore path. A second process on the same failed GPU is not a hardware backup. |
| Machine or GPU hardware fails | Local V1 cannot maintain Program. Multi-machine or second-GPU failover is V2. |

Cached last-good Render View frames maintain operator context while recovery is
in progress. They are never transmitted as fresh Program frames.

### Optional local Playout standby

A separate Playout Render View worker may be promoted to Program only when all
of these conditions are true:

1. It runs in a separate process and uses the same native render-core version.
2. Its published package checksums and accepted command-journal offset exactly
   match the primary.
3. It passes capability, asset, output and first-frame readiness checks.
4. The Engine Host transfers a monotonically increasing output lease/fencing
   token so only one worker can drive outputs.
5. The deployment has passed the additional VRAM, GPU scheduling, soak and
   output-device certification gates.

This option covers a render-process failure. It does not cover failure of the
shared GPU, driver, operating system or machine. It is disabled by default in
V1 until certified. The Editor Render View is never eligible for Program
promotion because it holds mutable authoring state and lacks Playout authority.

## Durable Program recovery

The engine atomically journals every accepted Program, output and runtime-data
mutation and periodically checkpoints animation position. A recovery snapshot
contains:

- engine epoch and monotonic state revision;
- immutable published `SceneRef` and package checksum;
- resolved runtime instance data;
- current frame, animation state and last completed transition boundary;
- output configuration and output lease;
- asset and shader compatibility fingerprints.

After restart the worker validates the snapshot and assets, restores the last
fully committed Program state without replaying a Take, renders a first frame
off-air and then resumes outputs. A crash during a transition restores the last
committed side of the transition. If validation is ambiguous, outputs remain
safe and Playout requires operator confirmation.

## Publishing and data flow

V1 publishing is local and durable:

1. Editor validates the mutable scene and dependencies.
2. Editor builds a versioned, checksum-addressed `.gfxpkg`.
3. The local Playout service stages and independently validates the package.
4. Playout atomically promotes the immutable published revision.
5. Playout loads/prepares that revision in the engine.
6. Program commands reference the exact published revision and runtime instance.

Publishing never patches an already online Program instance in place.

## Repository ownership

```text
Editor/                         Editor application and project service
Playout/                        Playout application and control service
Shared/                         contracts, protocol, shaders and SDK
services/render-engine/         Engine Host/worker and protocol v3
services/render-daemon/         render-core library (no binary since 2026-07-29)
tools/architecture/             structural guards run in CI and before any move
tools/certification/            engine, publish, IPC and pixel-parity harnesses
docs/                           this document and its subordinates
data/                           runtime state only; never source
```

The protocol-v2 daemon executable is not part of the target runtime. Its crate
remains as the private render-core dependency, but Editor and Playout must not
launch, package or fall back to the v2 server. As of 2026-07-29 none does, no
TypeScript client for it exists, and `npm run check:boundaries` fails the build
if a dependency on one reappears.

## V1 acceptance gates

- Editor and Playout connect automatically and recover without manual action.
- Closing either or both applications does not stop Program or outputs.
- Editor, Playout Preview and Program produce pixel-parity for the same
  `SceneRef`, frame and data, including materials, fonts, lights, cameras, 3D
  meshes and alpha.
- Editor-role Program/output commands are rejected by the engine.
- Authoring and published scenes with the same scene ID cannot collide.
- Worker kill causes verified restart and Program restoration.
- Corrupt recovery state holds outputs safe with an actionable diagnostic.
- No packaged application launches or connects to protocol v2. Since 2026-07-29 it
  cannot: the v2 daemon binary and its transport are deleted, so nothing in the
  repository can bind port 4200 or render outside the engine.
- A nightly eight-hour local Program/connection soak passes.
- Release hardware completes a 24-hour GPU/output certification run.

## V2 boundary

V2 adds remote Editor-to-Playout publishing, remote render nodes, TLS/mTLS,
discovery, primary/backup machines, output-device fencing across machines,
distributed tile rendering and venue-network security. V1 contracts retain
stable engine, project, scene, state-revision and output-lease identifiers so
V2 does not require a scene or protocol rewrite.

## Governing detail

- [`local-v1-system-design.md`](local-v1-system-design.md) records the design
  review, trade-offs and implementation plan.
- [`render-engine-architecture.md`](render-engine-architecture.md) contains
  renderer, tile, surface and frame-clock detail. Where it describes product
  deployment or client rendering, this document is authoritative for V1.
- [`scene-document-v1.md`](scene-document-v1.md) remains the durable scene
  compatibility contract.
