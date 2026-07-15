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

`npm run dev` launches the Electron desktop workspace. The desktop app builds and loads the current React editor, GPU renderer, docked modules, Object Library, and local Fastify API.

For browser-only debugging:

```bash
npm run dev:web
```

## Current Apps

- `apps/desktop-electron`: Primary GrapiX desktop workspace.
- `apps/editor-web`: React/Vite editor UI loaded by Electron and still available for browser debugging.

## Current Packages

- `packages/shared-types`: scene, binding, and package model types shared across apps and future services.
- `packages/render-shaders`: shared WGSL shaders and layout contract for the render daemon and the future browser WebGPU preview.

## Current Services

- `services/api-server`: local Fastify API (scenes, packages, render-daemon bridge).
- `services/render-daemon`: Rust + wgpu broadcast render daemon with NDI output (optional; `npm run dev:daemon`, see its README).

## Material Manager

The dockable Material Manager is the central library for imported render assets,
reusable materials, one-level material instances, WGSL manifests, preview,
assignment, missing-asset relinking, and usage tracing. See
[`docs/material-system.md`](docs/material-system.md) for architecture, alpha and
blend rules, renderer support, extension instructions, and current limitations.
