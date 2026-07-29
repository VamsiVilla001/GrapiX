# GrapiX Architecture

GrapiX follows a hybrid broadcast graphics architecture with two independent
product applications inside one master workspace.

```text
Editor
  -> Shared Scene / Timeline / Binding / Protocol Model
  -> Versioned Published Scene Package
  -> Playout
       -> Rundown / Preview / Program control
       -> Native Rust/wgpu Render Daemon
       -> NDI / Recording / future SDI
```

## Approved Editor / Playout workspace

The approved target is:

```text
GrapiX/
├── Editor/
├── Playout/
├── Shared/
└── package.json
```

- Editor owns authoring, project/source assets, validation and publishing.
- Playout owns published scene versions, scene library, rundowns, segments,
  timecode, automation, operator data, Preview/Program control and output.
- Shared owns scene, protocol, package, rundown, transition, shader and SDK
  contracts and cannot depend on either application.
- The native daemon is authoritative for Program rendering and remains alive
  independently of Editor.
- Editor and Playout must be independently buildable and runnable.

This is an approved target, not a completed physical migration. The complete
ownership model, publishing protocol, rundown/transition scope and safe phased
migration are specified in
[`editor-playout-workspace.md`](editor-playout-workspace.md).

## First Build Target

The first working target is now ingestion-first, then the Web Editor MVP:

- Import PNG/JPG/SVG/font source assets.
- Store source media in an Asset Library.
- Create render-ready Materials from assets.
- Assign Materials to scene object Material Slots.
- Resolve dynamic materials from JSON data.
- Show material readiness before playout.

- Create text, image, and shape objects.
- Manipulate canvas objects.
- Edit object properties.
- Bind properties to external data paths.
- Preview bound data.
- Save and load scene JSON.

## Current repository shape

```text
Editor/                    # v0.2 compatibility/ownership workspace
Playout/                   # v0.2 compatibility/ownership workspace
Shared/                    # v0.2 compatibility/ownership workspace

apps/
  desktop-tauri/
  desktop-electron/
  editor-web/

packages/
  shared-types/
  renderer-protocol/
  render-shaders/
  grapix-sdk/

services/
  api-server/
  render-daemon/

docs/
  architecture.md
  editor-playout-workspace.md
```

Basic v0.1 was stabilized and committed at `a387f5c`. Migration Phase 1 is now
implemented: the three target ownership roots are registered npm workspaces,
root compatibility commands remain available, each domain has independent
build/verification entry points, and `npm run check:boundaries` enforces the
initial dependency direction.

The existing source layout remains in place until the Phase 2 mechanical Editor
move. Folder movement must preserve history and must not be mixed with feature
redesign.

## Communication planes

- REST/HTTP(S) handles project operations and durable `.gfxpkg` publication.
- Persistent authenticated WebSocket handles connection health, publish
  progress, acknowledgements, library events and Playout control events.
- Renderer protocol v2 controls the long-lived native daemon.
- Every mutable command uses versions, request/sequence IDs, acknowledgements
  and duplicate protection.

## Governing documents

- [`editor-playout-workspace.md`](editor-playout-workspace.md) — Editor/Playout
  master workspace and operator-product target.
- [`architecture-review-compliance.md`](architecture-review-compliance.md) —
  35-point production-readiness ledger.
- [`renderer-control-architecture.md`](renderer-control-architecture.md) —
  native renderer control/process boundary.
- [`scene-document-v1.md`](scene-document-v1.md) — durable scene compatibility.
