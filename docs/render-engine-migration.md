# GrapiX Render Engine — Migration Plan

Companion to [`render-engine-assessment.md`](render-engine-assessment.md) and
[`render-engine-architecture.md`](render-engine-architecture.md).

Every phase is independently buildable. A phase is not complete until Rust
checks, TypeScript checks, tests, and production builds all pass.

---

## Status — 2026-07-28

| Phase | State | Evidence |
| --- | --- | --- |
| A — stage and surface model | **Complete** | 29 + 20 tests |
| B — tile system | **Complete** | 45 tests |
| C — protocol v3 and engine client | **Complete** | 103 tests |
| D — supporting contract packages | **Complete** | 140 tests across six packages |
| E — standalone engine skeleton | **Complete** | 39 config/security tests; CLI verified live |
| F — virtual canvas and tile renderer | **Complete** | 20 + 27 Rust tests, incl. seam proof over 625 tiles |
| G — protocol server and connection | **Complete** | 28 live-socket tests; both e2e gates green |
| H — scene publishing | **Complete** | load, prepare, full-sync, unload over the wire |
| H — asset sync over the wire | **Complete** | 25 store tests + 8 protocol tests + 7 live checks; content addressed, verified, resumable, reference counted |
| I — preview and diagnostics | **Complete** | JPEG previews with a pixel budget, status and diagnostics endpoints |
| I — preview *streaming* | **Complete** | JPEG at a configured cadence, addressed to the subscriber; 8 protocol tests + 6 live checks |
| J — Editor and Playout integration | **Complete** | 18 editor tests; both apps typecheck and build |
| J — outputs (virtual, NDI/SDI declared) | **Complete** | 17 output tests + 11 protocol tests; 32-check playout e2e |
| J — publish to Playout, rundown to air | **Complete** | 21-check publish → rundown → engine → output e2e |
| K — determinism and parity tests | **Complete for native; browser capture is manual** | tile composite proven pixel-identical to single pass; far edge identical to near edge; 20 comparison-core tests. Browser side needs a browser — see `docs/pixel-parity.md` |
| L — NDI/SDI hardware, warp, distributed | **Declared, not certified** | adapters, allowlist and Program clock implemented; no adapter has been run against a device |
| Local IPC transport | **Complete** | named pipe / Unix socket, same reliability rules; 11 Rust + 14 TypeScript tests + 11 live checks |
| Incremental scene patches | **Complete** | revision-gated, atomic, per-object tile invalidation; 18 + 5 tests, cross-language agreement proven live |

Totals: **338** TypeScript contract tests, **114** Rust engine tests, **97** daemon
tests unchanged, **45** editor tests, full workspace typecheck and production build
passing, boundary gate passing.

Live verification on an NVIDIA RTX 3070 Ti (Vulkan, `maxTextureDimension2d` 32768):

- `npm run certify:engine` — **27/27**. The real TypeScript `EngineConnection`
  against the real Rust engine: capability negotiation, a 50,000 x 10,000 stage,
  scene load and prepare across 125 tiles, playout gating, a 960x192 scaled preview
  of the full stage in ~550 ms, refusal of a full-resolution huge preview, and
  duplicate suppression.
- `npm run certify:playout-engine` — **18/18**. Publish, load, prepare, cue, take to
  Program, data update, clear, unload, all through Playout's HTTP API.

What is still missing is narrower than before: asset synchronisation over the
protocol, preview *streaming* (single-shot previews work), and pixel-level
browser/native comparison. Each is refused explicitly rather than silently ignored.

---

## Guiding constraints

1. Do not remove existing GrapiX functionality.
2. Do not replace a working module without a clear reason.
3. Never represent a 50,000 × 50,000 stage as one mandatory GPU texture.
4. Keep output methods out of the renderer core.
5. Keep the engine independently deployable.
6. Keep Editor and Playout usable when the engine is remote.
7. New scene/stage fields are optional and normalise deterministically, per the
   frozen `SceneDocument` v1 rules.
8. TypeScript and Rust contracts change in the same commit.

## Relationship to the existing workspace migration

[`editor-playout-workspace.md`](editor-playout-workspace.md) defines a separate,
already-approved migration that physically moves source into `Editor/`,
`Playout/`, and `Shared/`. Phase 0 and Phase 1 of that plan are complete; Phase 2
(the mechanical Editor move) is gated and **not** performed by this engine work.

Engine work is deliberately additive so the two migrations do not collide: new
packages land under `packages/`, and the new service lands under `services/`,
both of which the workspace plan already accounts for. When the mechanical move
happens, these packages move into `Shared/` and the engine into the Playout
runtime boundary as already specified.

## Phase A — Contracts: stage and surface model

**Deliverable:** `packages/stage-model`, `packages/surface-model`.

- Virtual canvas with f64 logical coordinates, origin, render scale, pixel aspect
  ratio, physical measurements.
- Safe areas, regions, viewports, camera mappings.
- Display surfaces with crop, UV mapping, density, PAR, bezel, warp, edge blend,
  colour profile reference.
- Output targets and output mappings.
- `MAX_LOGICAL_CANVAS_DIMENSION = 50_000`.
- Precision-preserving `toTileLocal` / `toViewportLocal`.
- Deterministic normalisation for absent fields.

**Gate:** unit tests for 50,000-scale coordinates, precision round trips,
validation rejection cases. `npm run typecheck` clean.

## Phase B — Contracts: tile system

**Deliverable:** `packages/tile-system`.

- Tile grid and derived tile identity.
- Tile descriptors with dirty/render/GPU/cache state, last-rendered frame,
  output references.
- Object → tile spatial index with incremental update.
- Selection by viewport, output, preview, export, and dirtiness.
- Filter overscan computation.
- Seam-free composite rectangle derivation.
- LRU eviction against a byte budget.

**Gate:** tests for objects crossing tile boundaries, overscan, culling, dirty
propagation, eviction, and a 50,000 × 50,000 grid.

## Phase C — Contracts: protocol v3 and engine client

**Deliverable:** `packages/render-protocol`.

- v3 envelope and all six message groups.
- Engine state machine and capability descriptor.
- Duplicate suppression, ordering, retry policy, revision-gap detection.
- Transport-agnostic `EngineConnection` used by both Editor and Playout.

**Gate:** serialisation round-trip tests, duplicate/out-of-order/revision-gap
tests, reconnect and resync tests against a fake transport.

## Phase D — Contracts: supporting packages

**Deliverable:** `packages/renderer-contracts`, `packages/output-contracts`,
`packages/scene-model`, `packages/animation-engine`, `packages/asset-manager`,
`packages/shader-library`.

- Renderer interface names from the architecture document.
- Output adapter descriptors with no hard-coded resolutions.
- Incremental patch/revision/conflict engine.
- Rational broadcast frame clock, markers, continue and pause points.
- Asset state machine, content addressing, chunked upload, preparation states.
- Shader metadata and validation over the existing `render-shaders` WGSL.

**Gate:** tests per package; `check:boundaries` still passes.

## Phase E — Standalone engine skeleton

**Deliverable:** `services/render-engine` builds and runs.

- `engine.toml` configuration with env and CLI override precedence.
- `--config`, `--bind`, `--port`, `--headless`, `--engine-id`, `--print-config`.
- Engine identity and state.
- wgpu adapter selection, limit reporting, headless device.
- Capability report.
- Reuses `grapix-render-core` (the existing daemon crate) for scene parsing,
  mesh preparation, text, pipelines, asset cache, media, output adapters.

**Gate:** `cargo check`, `cargo test`, `--print-config` works, `--help` works.
Existing daemon tests still pass unchanged.

## Phase F — Virtual canvas and tile renderer in the engine

**Deliverable:** native tiled rendering.

- Rust stage model mirroring `stage-model`, f64 throughout.
- Tile manager with dirty tracking, residency, and eviction.
- Render graph with a tile pass and a composite pass.
- Region-of-interest rendering.
- Tile texture reuse and background preparation.

**Gate:** tests proving tile bounds, culling, dirty updates, overscan, and that
a stage larger than `maxTextureDimension2d` renders successfully in tiles.

## Phase G — Protocol server and connection

**Deliverable:** engines reachable locally and remotely.

- WebSocket transport with auth, origin/allowlist checks, message-size limits,
  rate limiting.
- IPC transport for local engines.
- Dedupe, ordering, ack, retry on the server side.
- Connection lifecycle and heartbeat/timeout.

**Gate:** integration tests for connect/authenticate/capabilities/heartbeat,
duplicate suppression, and revision-mismatch rejection.

## Phase H — Scene publishing and asset synchronisation

- `LoadScene`, `PrepareScene`, `ValidateScene`, `ApplyScenePatch`,
  `FullSceneSync`, `UnloadScene`.
- Asset register/upload/validate/preload/release with content addressing,
  reference counting, and chunked resumable upload.
- Scene preparation states gate `TakeOnline`; unprepared scenes require an
  explicit operator override.

**Gate:** patch/resync/conflict tests, asset upload and cache tests.

## Phase I — Preview, Program separation, and diagnostics

- Preview provider: scaled stage, viewport, region, surface, tile set. Never the
  full stage at full resolution.
- Program changes only through Playout commands.
- Diagnostics: engine identity/address/state, backend, GPU limits, stage and
  viewport resolution, tile counts, cache size, frame rate, render time, draw
  calls, textures, VRAM estimate, assets, dropped/late frames, latency, scene
  revision, warnings, errors.
- Quality profiles from editor preview through diagnostic mode.

**Gate:** preview budget rejection test, diagnostics snapshot test.

## Phase J — Editor and Playout integration

- Editor: engine client, engine panel, capability warnings, tile/surface/camera
  diagnostic overlays that never appear in Preview or Program.
- Playout: persistent engine connection, health monitoring, full operational
  verb set.
- Renderer preference policy made explicit: WebGL, opt-in WebGPU, Canvas only as
  an emergency fallback.

**Gate:** editor and playout typecheck, build, and existing test suites pass.

## Phase K — Determinism and parity tests

- Preview/Program consistency for the same `(sceneRevision, frame)`.
- Visual comparison harness: browser preview vs native engine on one
  SceneDocument frame.
- Device loss, engine restart, remote failure, primary/backup sync.

**Gate:** parity tolerance documented and enforced.

## Phase L — Later, explicitly out of scope now

- NDI SDK compilation and certification.
- DeckLink / AJA plugins and hardware certification.
- Interlaced field rendering.
- Warp and edge-blend calibration maths.
- Actual distributed rendering orchestration.
- WebRTC preview transport (interface only for now).
- Folding `render-daemon`'s transport and controller into `render-engine` and
  reducing the daemon to a compatibility launcher.

## Verification commands

```bash
# TypeScript
npm run typecheck
npm test -w @grapix/shared-types
npm run check:boundaries

# New packages
npm test -w @grapix/stage-model
npm test -w @grapix/surface-model
npm test -w @grapix/tile-system
npm test -w @grapix/render-protocol
npm test -w @grapix/scene-model
npm test -w @grapix/animation-engine
npm test -w @grapix/asset-manager
npm test -w @grapix/shader-library

# Rust
cargo check  --manifest-path services/render-engine/Cargo.toml
cargo test   --manifest-path services/render-engine/Cargo.toml
cargo test   --manifest-path services/render-daemon/Cargo.toml   # must stay green

# Production build
npm run build
```


## Outputs, and what "on air" means

Two kinds of output exist, and the distinction is never implied by a name:

| Adapter | Live | State here |
| --- | --- | --- |
| `null` | no | discards frames; development and CI |
| `virtual` | no | headless render of the on-air graphic at full Program resolution, retained for inspection, never leaves the machine |
| `recording` | no | byte-exact BGRA capture to disk, bounded frame count |
| `ndi` | **yes** | behind `--features ndi`; reports `hardwareCertified: false` even when the SDK is linked |
| `decklink` | **yes** | declared, not implemented; reports itself unavailable with the reason |
| `aja` | **yes** | declared, not implemented; reports itself unavailable with the reason |

`is_live()` is the discriminator, it is reported per output and per adapter, and the
Playout panel colours a live row red and a headless row grey from that field alone.
An unavailable live adapter refuses to configure rather than accepting frames and
discarding them: an output that silently swallows Program is the worst failure mode,
because the operator sees a healthy row and the audience sees nothing.

`outputs.enabled-adapters` in `engine.toml` is an allowlist. A client cannot
instantiate an adapter the deployment did not sanction, which is what stops a remote
Editor putting something to air. The default set is `null`, `virtual`, `recording` —
none of them live.

### Taking a scene online starts the outputs

`playout.takeOnline` starts every configured output and reports, per output, whether it
is live or headless. Three cases are called out explicitly in the reply:

- at least one live output running → `live on air via …`
- only headless outputs → `nothing from this take reaches air`
- no output at all → `this take is not being rendered anywhere`

The third matters most: on air with no output looks identical to a healthy take in
every other respect. `playout.takeOffline` and `playout.clear` stop the outputs, so a
cleared Program cannot keep pushing its last frame out.

### The Program clock

A `ProgramClock` task renders the on-air scene at the configured rate and feeds every
running output. Deadlines are computed from the frame number with integer arithmetic,
never accumulated, so 59.94 (60000/1001) cannot drift. A render that overruns causes
the clock to jump to the frame that is actually due and count what it skipped, rather
than catching up frame by frame and playing the show in slow motion. It idles at a
250 ms poll when nothing is on air, and it is independent of any client connection:
Program keeps running when the Editor and Playout both disconnect.

Measured on an RTX 3070 Ti, 1920×1080 at 50 fps, debug build: **5.6 ms average per
frame against a 20 ms budget, 50.0 fps sustained**. The first implementation called the
core's `render_single_frame` convenience function, which compiles both shader pipelines
and allocates a render target per call — that cost 482 ms per frame and dropped 9,304
frames in three minutes. `ProgramRenderer` now keeps the pipelines, the render target,
the text renderer, the prepared scene (keyed by revision) and the mesh frame across
frames, and re-prepares only when the scene, its revision, or the stage bounds change.
