# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read before editing

1. **`memory.md`** (repository root) — the authoritative session state. Its
   "Rules for the next session" section (~68 numbered rules) is binding: each rule
   exists because the failure it describes actually happened. Read it before any
   non-trivial change.
2. **`docs/README.md`** — the document authority order. When two docs disagree, the
   higher one wins: `docs/architecture.md` > `docs/local-v1-system-design.md` >
   `docs/editor-playout-workspace.md` > detail documents.
3. `docs/architecture.md` §"Non-negotiable invariants" — eight invariants that
   constrain almost every change in this repository.

## Commands

```bash
npm install
npm run build             # clean dist, then Shared -> Editor -> Playout, then stage runtime
npm run typecheck         # every workspace (there is no ESLint; typecheck is the lint gate)
npm test                  # every workspace's suite
npm run check:boundaries  # structural guard — run after touching any manifest or moving any file
```

Dev:

```bash
npm run dev            # Editor desktop shell: project-api + ensured engine
npm run dev:playout    # Playout: engine + control service + operator UI
npm run dev:engine     # render engine alone (Rust)
npm run dev:web        # Editor UI in a browser
npm run dev:mcp        # editor-mcp, watching sources
npm run dev:adobe      # Adobe bridge gateway (:4784)
```

Rust:

```bash
npm run test:engine       # cargo test, services/render-engine
npm run test:core         # cargo test, services/render-daemon (includes a real GPU smoke test)
npm run check:engine      # cargo check --all-targets
```

### Running a single test

TypeScript packages run `node --test` over **built** `.mjs` tests that import from
`dist/`, so the package must be built first:

```bash
npm run build -w @grapix/shared-types
node --test Shared/shared-types/tests/material-system.test.mjs
```

`editor-web` is the exception — its tests are TypeScript run through tsx directly:

```bash
npx tsx --test Editor/apps/editor-web/tests/bezier-editing.test.ts
```

Rust single test: `cargo test --manifest-path services/render-engine/Cargo.toml <test_name>`.

### Certification harnesses

`certify:render-core` and `certify:materials` are self-contained. The rest need a
running system — `certify:engine`/`certify:ipc`/`certify:parity` need the engine
(`npm run dev:engine`); `certify:playout-engine`, `certify:publish-takelist`,
`certify:monitors`, `certify:take-animation` need `npm run dev:playout`. See the
full list in `README.md`. Harnesses share one engine and a running GrapiX window
already holds monitor streams, so assert on deltas and find your own stream by id
(memory.md rule 61).

The 8/24-hour soak gate has **no harness**. Do not mark it met.

## Architecture

Three products plus a contracts root. The relationship is Viz Artist / Trio /
Engine, or XPression Designer / Sequencer / Engine.

| Path | Product | Owns |
| --- | --- | --- |
| `Editor/` | Editor | Authoring: scenes, materials, assets, fonts, animation, data bindings, validation, **Publish to Playout**. No Program or output authority. |
| `Playout/` | Playout | Operations: published scene library, Take List, timecode, automation, Preview/Program, output configuration. |
| `services/render-engine` | Render Engine | The **only** implementation that rasterizes production pixels. Owns GPU state, the rational frame clock, Program and outputs. |
| `services/render-daemon` | — | `grapix-render-core`, the engine's core library (the protocol-v2 binary that named the directory was deleted 2026-07-29). |
| `Shared/` | — | 15 contract packages consumed by all three. **Not** a fourth product; may not depend on Editor or Playout. |

npm workspaces; each product root (`Editor/`, `Playout/`, `Shared/`) is itself a
workspace whose `build`/`typecheck`/`verify` scripts fan out to leaves in a
**load-bearing order** — `tsc` needs each dependency's emitted declarations first.
Add a new Shared package to `Shared/package.json`'s three chains in the right place.

### Ports

4100 project-api · 4150 editor-mcp over HTTP · 4160 editor-assistant · 4300
playout-control · 4400–4403 engine and render nodes · 4784 Adobe gateway ·
5173/5174 editor/playout web. **4200 is retired** (the deleted v2 daemon) — put
nothing there, and do not reuse any of the others.

### The authority split is enforced by structure, not by comments

- Editor's engine wrapper has no `takeOnline`; Playout's has no content mutation.
  The command surfaces enforce the split **by omission** — keep it that way.
- `assertEditorAuthority` (`Editor/services/editor-mcp/src/server.ts`) fails the
  build if any MCP tool names Cue, Take, Continue, Clear, Program or an output verb.
- The engine rejects operator verbs from an Editor role rather than trusting a UI
  to omit the button.
- Neither desktop shell may stop the render engine — including one it started
  itself. Both shells **ensure** an engine (start if absent, adopt if present,
  never stop on window close), because Program outlives an authoring or operator
  window. Each has a unit test asserting this; do not "fix" that test.
- Editor evaluates automation and returns the plan; it never executes it. If a
  feature seems to need a Take or output route in Editor, it belongs in Playout.

### Parallel implementations that must change together

Changing one side and not the other is the recurring bug class here:

| TypeScript | Rust |
| --- | --- |
| `Shared/tile-system` | `services/render-engine/src/tile.rs` |
| `evaluateSceneAtFrame` in `Shared/shared-types` | `services/render-engine/src/animation.rs` |
| `@grapix/render-protocol` (v3) | `services/render-engine/src/protocol.rs` |

Both test suites in each pair exist to catch the divergence.

### Coordinates and precision

Never represent a large stage as one GPU texture — only tiles become render
targets. Never hand absolute stage coordinates to the GPU: subtract the tile or
viewport origin **in f64**, then narrow to f32. `Shared/stage-model` and the
engine's `stage.rs` both enforce this; do not add a bypassing path.

### Performance rules with a history

Nothing that can be built once may be built per Program frame — pipelines, render
target, prepared scene and mesh frame live in `ProgramRenderer`; building them per
frame cost 482 ms/frame. A preview whose scaled output fits one texture must use
the single-pass path. Never fix an animation bug by re-preparing the scene per frame.

## Conventions

- **Do not describe unimplemented capability in the present tense.** Every doc uses
  **Implemented / Partial / Planned / External gate**; readers rely on that vocabulary.
  Never claim NDI/DeckLink/AJA/video/hardware readiness without an execution record
  (`docs/hardware-certification-template.md`).
- A detail document that contradicts `docs/architecture.md` is a bug in the detail
  document — fix it there rather than weakening the invariant.
- Paths in prose are checked by nothing. When a directory moves, grep the whole
  `docs/` tree; two previous moves left silent stale paths.
- Report unsupported native features explicitly. Only the cut transition is
  implemented — refuse anything else rather than substituting a cut. Asset sync,
  incremental patches and renderer restart are refused with an explicit code; keep
  them refused rather than stubbed.
- No silent fallbacks: a fallback that renders different pixels is not a safety net.
  An unknown monitor `view` or channel is refused, never defaulted.
- Publishing is additive — every publish is a new version, take-list entries pin the
  version they were built against. Take IDs start at 101 and are stable across
  republishes because operators memorise them.
- Update `memory.md` when architecture, module ownership, status or major verified
  work changes.

For rendering or UI changes, the expected verification is: targeted tests, full
`npm run typecheck`, a production build, **and** live verification against the
running app — every fault the previous repository moves caused was silent.

## Current status

V1 is local-only and incomplete. The largest open item is **milestone M2**
(`docs/local-v1-system-design.md`): the Editor still authors through a browser
viewport (PixiJS + Three.js, `docs/rendering-engine.md` — explicitly temporary),
and only a native Editor Render View can guarantee authored pixels match Program.
The workspace migration phases 0–3 and 4a are complete; the next step is M2, not
another move.

## MCP

`.mcp.json` registers `grapix-editor` from `Editor/services/editor-mcp/dist/index.js`,
so the server must be built (`npm run build:editor`, or `npm run dev:mcp`) before
its tools work. Read the `grapix://primer` resource before the first scene edit:
several scene enums accept values the renderers do not implement, so an authored
scene can validate cleanly and render as something else. Run
`grapix_editor_analyze_scene` before publishing.
