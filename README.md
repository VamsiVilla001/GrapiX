# GrapiX

GrapiX is being built as a web-based native broadcast graphics platform:

- Graphics editor
- Sequencer / playout controller
- Real-time renderer

The first milestone is a React + TypeScript editor MVP with a shared scene model. The long-term architecture is hybrid: web UI and shared TypeScript packages feeding a native renderer daemon for NDI, SDI, preview, and recording output.

## Start

```bash
npm install
npm run dev
```

`npm run dev` launches the Tauri 2 desktop workspace. The desktop app loads the
React editor and starts or reuses the local Fastify project service.

The independent Playout operator stack is started separately:

```bash
npm run dev:playout
```

This launches the Playout web operator at `http://127.0.0.1:5174`, its durable
control service at `http://127.0.0.1:4300`, and the native renderer daemon.

For browser-only debugging:

```bash
npm run dev:web
```

## Current Apps

- `apps/desktop-tauri`: Primary GrapiX desktop supervisor.
- `apps/desktop-electron`: Retained desktop fallback during the Tauri migration.
- `apps/editor-web`: React/Vite editor UI loaded by the desktop shell and still available for browser debugging.
- `Playout/apps/playout-web`: independent rundown, scene-library,
  Preview/Program and operator-control UI.

## Current Packages

- `packages/shared-types`: scene, binding, and package model types shared across apps and future services.
- `packages/renderer-protocol`: versioned renderer commands, replies, channels,
  lifecycle vocabulary, and output configuration shared by TypeScript clients.
- `packages/render-shaders`: shared WGSL shaders and layout contract for the render daemon and the future browser WebGPU preview.

Render engine contracts, all pure TypeScript with no DOM or GPU access:

- `packages/stage-model`: the virtual canvas. A logical stage in f64 up to
  50,000 × 50,000, with regions, viewports, cameras, outputs, output mappings,
  render scale, pixel aspect, and physical measurements. Declaring a huge stage
  allocates nothing.
- `packages/surface-model`: physical display surfaces — LED walls, curved LED,
  projection, ribbons, scoreboards, multi-monitor arrays — with bezel
  compensation, warp, and edge blending carried in the data model.
- `packages/tile-system`: tile grid, object-to-tile index, culling, dirty
  tracking, filter overscan, LRU eviction, and provably seam-free compositing.
- `packages/render-protocol`: engine protocol v3, the shared `EngineConnection`
  used by both Editor and Playout, and the multi-engine registry.
- `packages/scene-model`: revision-gated incremental patches with duplicate, gap,
  and conflict detection.
- `packages/animation-engine`: exact rational frame clock, frame-based playback
  with continue and pause points, frame-accurate transitions.
- `packages/asset-manager`, `packages/output-contracts`,
  `packages/renderer-contracts`, `packages/shader-library`.

## Current Services

- `services/api-server`: local Fastify API (scenes, packages, render-daemon bridge).
- `services/render-daemon`: Rust + wgpu broadcast render daemon with NDI output (optional; `npm run dev:daemon`, see its README).
- `services/render-engine`: the standalone, headless-capable, tile-based render
  engine. Independently buildable, configurable and deployable; runs locally, on a
  GPU workstation, on a headless server, or as several render nodes. See
  [its README](services/render-engine/README.md).
- `Playout/services/playout-control`: atomic published-scene/rundown persistence
  and the Playout-owned renderer control state machine.

### Local ports

| Port | Service |
| --- | --- |
| 4100 | `services/api-server` |
| 4200 | `services/render-daemon` (protocol v2) |
| 4300 | `Playout/services/playout-control` |
| 4400–4403 | `services/render-engine` and additional render nodes |
| 5173 / 5174 | editor web / playout web |

The render engine separation — why it exists, what it reuses, and how a
50,000 × 50,000 stage is possible without a 10 GB texture — is documented in
[`docs/render-engine-assessment.md`](docs/render-engine-assessment.md),
[`docs/render-engine-architecture.md`](docs/render-engine-architecture.md), and
[`docs/render-engine-migration.md`](docs/render-engine-migration.md).

The engine listens on `ws://127.0.0.1:4400` and is wired into both applications:
the Editor has a Render Engine panel, and Playout owns a persistent connection so
Program keeps rendering when the Editor closes. Asset synchronisation over the
protocol, incremental scene patches, and preview *streaming* are not implemented
and are refused with an explicit error code rather than silently ignored — see the
phase table in the migration plan.

Architecture boundaries and migration rules are documented in
[`docs/renderer-control-architecture.md`](docs/renderer-control-architecture.md)
and [`docs/scene-document-v1.md`](docs/scene-document-v1.md).
The 35-point broadcast review is tracked without overclaiming in
[`docs/architecture-review-compliance.md`](docs/architecture-review-compliance.md).
Font sources, multi-scene sequencing, transition phases, conditional triggers,
and the JavaScript SDK trust boundary are specified in
[`docs/fonts-sequencing-automation-sdk.md`](docs/fonts-sequencing-automation-sdk.md).

Useful architecture gates:

```bash
npm run typecheck
npm run check:boundaries
npm run test:contracts     # the eleven render-engine contract packages
npm run test:daemon
npm run test:engine        # standalone render engine (Rust)
npm run check:engine
# With the engine running (npm run dev:engine):
npm run certify:engine          # real TS client -> real Rust engine
# With the engine and playout-control running (npm run dev:playout):
npm run certify:playout-engine  # publish, prepare, cue, take, clear via HTTP
npm run certify:publish-rundown  # Editor publish -> scene manager -> rundown -> air
npm run certify:ipc              # local IPC transport, with its own engine
npm run certify:parity           # pixel parity; see docs/pixel-parity.md
npm run certify:control
npm run certify:e2e
# API + daemon must already be running:
npm run certify:soak
```

The render engine is started separately, and `--print-config` resolves the whole
CLI-over-environment-over-file precedence chain without needing a GPU:

```bash
npm run dev:engine
cargo run --manifest-path services/render-engine/Cargo.toml -- \
  --config services/render-engine/engine.toml --print-config
```

The control certification uses the exact reviewed 80-scene group mix.
`certify:e2e` builds on that with an isolated, self-cleaning API-to-native-daemon
control loop. The standalone soak defaults to one minute; set
`GRAPIX_SOAK_MINUTES=480` or `1440` for an 8/24-hour run. Hardware and
vendor-output certification still requires
[`docs/hardware-certification-template.md`](docs/hardware-certification-template.md).

## Material Manager

The dockable Material Manager is the central library for imported render assets,
reusable materials, one-level material instances, WGSL manifests, preview,
assignment, missing-asset relinking, and usage tracing. See
[`docs/material-system.md`](docs/material-system.md) for architecture, alpha and
blend rules, renderer support, extension instructions, and current limitations.
