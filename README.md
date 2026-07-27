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

For browser-only debugging:

```bash
npm run dev:web
```

## Current Apps

- `apps/desktop-tauri`: Primary GrapiX desktop supervisor.
- `apps/desktop-electron`: Retained desktop fallback during the Tauri migration.
- `apps/editor-web`: React/Vite editor UI loaded by the desktop shell and still available for browser debugging.

## Current Packages

- `packages/shared-types`: scene, binding, and package model types shared across apps and future services.
- `packages/renderer-protocol`: versioned renderer commands, replies, channels,
  lifecycle vocabulary, and output configuration shared by TypeScript clients.
- `packages/render-shaders`: shared WGSL shaders and layout contract for the render daemon and the future browser WebGPU preview.

## Current Services

- `services/api-server`: local Fastify API (scenes, packages, render-daemon bridge).
- `services/render-daemon`: Rust + wgpu broadcast render daemon with NDI output (optional; `npm run dev:daemon`, see its README).

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
npm run test:daemon
npm run certify:control
npm run certify:e2e
# API + daemon must already be running:
npm run certify:soak
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
