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
