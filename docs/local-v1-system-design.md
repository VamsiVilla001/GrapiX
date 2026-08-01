# GrapiX Local V1 System Design Review

Status: **Recommended architecture; implementation blockers remain**  
Owner: **GrapiX**  
Last updated: **2026-07-29**

## 1. Abstract

The three-product split—Editor, Playout and Render Engine—is the correct
architecture for a professional broadcast graphics system. The native Render
Engine must remain the only production scene rasterizer, while Editor and
Playout consume specialised Render View extensions for authoring and
operational monitoring.

Render View extensions are valuable because they share render-core, materials,
lighting, fonts, 3D and animation evaluation. They become a stale design if they
are implemented as independent browser or application renderers. They may
provide cached-frame continuity and view-level recovery. Only a separately
isolated, fully synchronised and output-fenced Playout standby worker may be
promoted to Program after the primary renderer crashes.

## 2. Goals and non-goals

### Goals

- One native source of rendered scene pixels across Editor, Preview and Program.
- Program continues when Editor and Playout disconnect or close.
- Automatic reconnect, state reconciliation and verified worker recovery.
- Strict Editor/Playout role enforcement and authoring/published scene isolation.
- Local V1 operation through authenticated loopback protocol v3.
- An extension boundary that can add certified standby rendering without
  redesigning scenes, materials or the control protocol.

### Non-goals

- Claiming that a network or process can literally never disconnect.
- Allowing Editor or an unverified mini renderer to drive Program outputs.
- Remote publishing, remote engines, multi-machine failover or distributed
  rendering in V1.
- Silently falling back to PixiJS, Three.js or protocol v2.
- Treating a second process on the same GPU as protection from GPU or machine
  hardware failure.

## 3. Current-state findings

The repository contains a strong foundation:

- standalone Rust/wgpu `services/render-engine`;
- protocol v3 with heartbeat, sequence, dedupe and reconnect primitives;
- a shared TypeScript `EngineConnection`;
- independent Program clock, preview streaming and output adapters;
- shared scene, stage, tile, animation, asset and renderer contracts.

The architecture is not yet implemented end to end. Four of the nine findings were
closed by the 2026-07-29 restructure; the rest are the remaining release blockers.

| # | Finding | State |
| ---: | --- | --- |
| 1 | Editor's production canvas still uses PixiJS/Three.js. | **Open** — milestone M2. The largest remaining item. |
| 2 | Editor's engine connection is created inside `RenderEnginePanel` and dies when that panel unmounts. | **Open** — milestone M1. |
| 3 | Editor desktop packages and supervises the protocol-v2 daemon. | **Closed** — the shell stages and ensures `grapix-render-engine`, and never stops it. |
| 4 | Playout retains a protocol-v2 runtime fallback. | **Closed** — `NativeRendererClient` and the whole v2 TypeScript client are deleted; a missing engine is reported, not worked around. |
| 5 | A Playout desktop instance can stop an engine process it started. | **Closed** — neither shell stops the engine on close, whoever started it. Asserted by a unit test in each shell. |
| 6 | Client role is logged during Hello but not retained and enforced as an engine-side authorization boundary. | **Open** — milestone M2. The Editor no longer *issues* Program or output commands, but the engine still would not refuse them. |
| 7 | Engine scenes and Preview are keyed globally, so Editor and Playout can collide on scene ID or Preview selection. | **Open** — milestone M2. |
| 8 | Engine identity is persisted, but loaded scenes, Program state and outputs are not durably restored after restart. | **Open** — milestone M3, and the reason the Editor shell's Program-restore code was deleted rather than moved. |
| 9 | Documentation mixes local V1 with remote/distributed V2 and contains pre-migration repository paths. | **Closed** — authority order is stated in `docs/README.md`, three superseded documents were deleted, and the stale `packages/`, `apps/` and `services/api-server` paths are gone. |

These are release blockers, not reasons to replace the underlying engine work.

### Also closed, though not on the original list

- The Editor project service issued `take`, `output.configure`, `output.start` and
  `output.stop` through its daemon bridge — invariant 4 violated in the Editor's
  own HTTP surface, not merely in a UI. The bridge is gone.
- `npm run check:boundaries` now inspects every package manifest in each domain,
  not just the domain root, and fails on any dependency or import of a retired
  package. The old check would not have noticed
  `Editor/apps/editor-web` depending on `@grapix/playout-control`.
- The 8/24-hour soak harness drove the retired v2 path and was deleted. The gate
  is now openly unmet rather than reporting green against a runtime that will not
  ship.

## 4. Proposed architecture

### Product boundaries

- **Editor:** mutable authoring state, undo/redo, tools, project assets,
  validation, package building and an Editor Render View client.
- **Playout:** immutable published packages, rundown and automation state,
  operational Preview, Program commands, output configuration and a Playout
  Render View client.
- **Render Engine:** persistent host, native workers, GPU resources, render
  graph, view sessions, Program clock, outputs, caches and recovery journal.

### Render View extension contract

Each Render View is a native engine session defined by:

```ts
interface RenderViewDescriptor {
  viewId: string;
  ownerInstanceId: string;
  role: "editor-view" | "playout-view" | "program";
  scene: SceneRef;
  viewport: StageViewport;
  targetFps: number;
  maxPixels: number;
  pixelFormat: "bgra8" | "rgba8";
  alphaMode: "straight" | "premultiplied";
  priority: "program" | "playout-preview" | "editor-active" | "background";
}
```

All views use the same native scene adapter, render graph, shader library,
material system, text shaping, asset cache and animation evaluator. The
extension changes viewport, cadence, quality budget, metadata and authority;
it does not fork rendering semantics.

### Backup eligibility

- Editor Render View: private authoring preview only; never Program eligible.
- Playout Render View: operational preview and confidence monitoring; may become
  a Program standby only as a separate certified worker.
- Program worker: primary output owner, protected by an Engine Host lease.

Promotion requires exact journal position, matching package/assets, successful
first-frame validation and a fenced output lease. Without all four, the
standby remains a monitor and outputs stay safe.

## 5. Lifecycle and recovery

1. Editor or Playout asks the local Engine Host to ensure the single engine
   instance is running.
2. Each application establishes its own authenticated persistent protocol-v3
   session.
3. Hello binds client ID, application instance, role and project to the
   connection.
4. The engine returns capabilities, engine epoch and monotonic state revision.
5. The client reconciles its scene/package revisions before enabling mutation.
6. Render Views are created or resumed and stream alpha-preserving binary frames.
7. Every accepted Program mutation is durably journalled before outputs change.
8. On connection loss, clients reconnect indefinitely and resubscribe.
9. On worker crash, the host restarts the worker and restores the verified
   Program snapshot.
10. If a certified standby exists, the host may transfer the output lease after
    readiness and journal checks; otherwise the restarted primary resumes.

## 6. Contracts and consistency

Required public additions:

- `ClientSessionIdentity` binds client, instance, role and project.
- `SceneRef` separates authoring from immutable published revisions.
- `PreviewContextId` prevents Editor and Playout Preview collisions.
- `stateRevision` and `engineEpoch` support deterministic reconciliation.
- `RenderViewDescriptor` and `RenderViewFrameHeader` define view creation and
  binary frame delivery.
- `OutputLease { leaseId, generation, ownerWorkerId, expiresAt }` fences Program
  output ownership.
- `ProgramRecoverySnapshot` records the last verified published state.

Mutable commands carry message ID, request ID, sequence, state revision and
idempotency semantics. A revision gap causes full reconciliation, never
best-effort patch application.

## 7. Security

- Bind V1 to `127.0.0.1` only.
- Require a per-installation token stored with native filesystem permissions.
- Inject credentials into web clients in memory; never persist them in browser
  local storage.
- Enforce role and project permissions inside the engine.
- Restrict assets to configured roots and content-addressed package storage.
- Validate shaders and package checksums before preparation or recovery.
- Audit every Program/output mutation and standby promotion.

## 8. Operational readiness

Required signals:

- connection state and reconnect duration per client;
- Program frame deadline misses and output drops;
- Render View latency, dropped/stale frames and adaptive resolution;
- engine epoch/state revision and reconciliation failures;
- worker restarts, device-loss recoveries and snapshot validation;
- standby journal lag, readiness and output-lease owner;
- CPU, RAM, VRAM, asset-cache pressure and render-pass timing.

Program alerts take precedence over Editor/Preview degradation. Under pressure
the engine reduces or suspends background and Editor views before affecting
Program.

## 9. Alternatives considered

### Independent mini renderers embedded in both applications

Rejected as the production design. They duplicate GPU state and caches, couple
rendering to UI lifecycles and recreate material, font, 3D and animation parity
drift. They are not reliable Program backups when the applications may be
closed.

### Browser renderer plus native confidence preview

Rejected as the target. It preserves two rendering implementations and makes
the Editor unable to guarantee that authored pixels match Program.

### Render View extensions inside one worker only

Accepted for the default V1 view architecture, but insufficient for
process-crash backup because all views share the same failure domain.

### Separate certified Playout standby worker

Accepted as an optional local reliability tier. It covers a worker-process
failure but consumes additional GPU/VRAM and does not cover shared
GPU/driver/machine failure.

### OS service as the engine lifecycle owner

Deferred. A persistent Engine Host provides a simpler V1 lifecycle and avoids
Windows service-session GPU complications.

## 10. Decision

Proceed with the three-product architecture and add Render View extensions as
native engine sessions. Do not implement application-owned renderers as
automatic Program backups.

The V1 default recovery path is Engine Host restart plus verified Program
restore. Render Views retain cached last-good frames for operator continuity.
Add the separately isolated, output-fenced Playout standby only after its
resource and hardware certification passes.

## 11. Implementation plan

### M1 — Canonical contracts and lifecycle

- Make the architecture documents authoritative for local V1.
- Add client identity, scene domain, view and state-revision contracts.
- Introduce the persistent single-instance Engine Host.
- Move Editor connection ownership to application scope.

Exit: both applications auto-connect; closing either does not stop the engine.

### M2 — Authority, isolation and native views

- Enforce engine-side role permissions.
- Key scenes by project/domain/scene/revision.
- Split private Editor views from Playout Preview and Program.
- Integrate the native Editor Render View and binary alpha frames.

Exit: pixel parity passes for materials, fonts, lights, cameras, 3D and alpha.

### M3 — Single runtime and verified recovery

- Remove protocol-v2 sidecars and runtime fallback.
- Add Program journal, atomic snapshot and first-frame restore.
- Add crash, device-loss and corrupt-state recovery tests.

Exit: worker kill restores verified Program; unsafe state holds outputs safe.

### M4 — Optional local standby certification

- Run Playout View as a separate standby-capable worker.
- Replicate the accepted Program journal.
- Implement output lease fencing and promotion.
- Measure GPU/VRAM cost and complete soak/output testing.

Exit: standby promotion is deterministic, single-owner and certified. If the
gate fails, V1 ships with host restart recovery and standby remains disabled.

## 12. Acceptance tests

- Close Editor, Playout and both while Program frame counters continue.
- Break both client sockets and verify automatic reconnect/resync.
- Attempt Take/output commands from an Editor role and verify refusal.
- Load equal scene IDs in authoring and published domains without collision.
- Compare Editor, Playout Preview and Program pixels for the same revision/frame.
- Kill individual Render Views without disturbing Program.
- Kill the primary worker and verify host restart and Program recovery.
- Corrupt a snapshot or asset and verify safe output hold.
- Attempt two output owners and verify fencing rejects the stale lease.
- Run an eight-hour nightly local soak and 24-hour release hardware soak.

## 13. Open constraints

- A same-machine standby cannot survive complete GPU, driver, OS or machine
  failure; that requires the remote/multi-node V2 architecture.
- Warm standby mode remains disabled until GPU memory and output hardware
  certification demonstrate that it cannot threaten Program deadlines.
