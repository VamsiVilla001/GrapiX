# GrapiX

GrapiX is a **middle layer** between finished designs and live air:

```text
Figma / PSD / Illustrator  ->  import  ->  rig + bind  ->  publish  ->  playout
```

Artwork is authored in design tools. GrapiX imports it faithfully, adds the things no design
tool can express (auto-fit text, data-repeat containers, media inputs, clocks, variants),
binds it to live data, and plays it out. GrapiX owns the renderer and the output.

The architecture and the decisions behind it are in
[docs/middle-layer-arch.md](docs/middle-layer-arch.md) — read that first.

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

GrapiX opens on a **profile picker**. A profile owns the workspace layout and the
credentials the importers need (currently a Figma personal access token), and is extended
as new phases land. Nothing renders until a profile is launched.

The Figma token is held by the local API service and is never sent to the editor window —
the UI only ever sees a `present` flag and the last four characters.

## Current Apps

- `apps/desktop-electron`: Primary GrapiX desktop workspace.
- `apps/editor-web`: React/Vite editor UI loaded by Electron and still available for browser debugging.
- `apps/figma-plugin`: "Send to GrapiX" Figma plugin — the high-fidelity import path.

## Current Packages

- `packages/design-ir`: DesignIR — the faithful "as designed" tree every importer produces, plus the design-token grammar.
- `packages/importers`: Figma (plugin payload + REST fallback), PSD and Illustrator importers.
- `packages/shared-types`: scene, binding, package and profile types shared across apps and services.

## Design Import

| Source | Path | Notes |
| --- | --- | --- |
| Figma | `apps/figma-plugin` (preferred) | Real vector paths and per-run text styling. Needs no token. |
| Figma | REST fallback | Needs a token on the profile. Outlined geometry, reconstructed text runs. |
| Photoshop | `.psd` / `.psb` upload | Layer tree, bounds, text, solid fills. Raster pixels not yet extracted. |
| Illustrator | `.ai` / `.pdf` upload | Reads the embedded PDF stream. Save with "Create PDF Compatible File". |

Both Figma front-ends emit the same payload and share one mapper, so they cannot drift.
Every importer records what it had to approximate as a reviewable warning — fidelity loss
is never silent.

### Installing the Figma plugin

```bash
npm run build:plugin
```

Then in Figma: **Plugins → Development → Import plugin from manifest…** and pick
`apps/figma-plugin/manifest.json`. The plugin posts to the local API on `127.0.0.1:4100`,
so leave the desktop app running.

## Tests

```bash
npm test
```

Importer tests run against committed fixtures in `packages/importers/test-fixtures`,
regenerated with `node packages/importers/scripts/make-fixtures.mjs`.
