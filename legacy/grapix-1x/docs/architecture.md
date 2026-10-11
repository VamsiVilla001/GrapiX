# GrapiX Architecture

GrapiX follows a hybrid broadcast graphics architecture.

```text
Web Editor + Sequencer
        -> Shared Scene / Timeline / Binding Model
        -> Published Scene Package
        -> Native Render Daemon
        -> NDI / SDI / Preview Output
```

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

## Monorepo Shape

```text
apps/
  editor-web/

packages/
  shared-types/

docs/
  architecture.md
  project-memory.md
```

The fuller target from the architecture note includes future `sequencer-web`, `desktop-shell`, backend services, native render daemon, output plugins, and asset pipeline tools.
