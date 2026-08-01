# GrapiX

A broadcast graphics platform built as three products, in the same relationship
as Viz Artist / Trio / Engine or Ross XPression Designer / Sequencer / Engine:

| Product | Owns |
| --- | --- |
| **Editor** | Authoring: scenes, materials, assets, fonts, animation, data bindings, validation, and durable **Publish to Playout**. No Program or output authority. |
| **Playout** | Operations: the published scene library, rundowns, segments, timecode, automation, Preview/Program control and output configuration. |
| **Render Engine** | Rendering: the only implementation that rasterizes production scene pixels. Owns all GPU state, the rational frame clock, Program and the outputs. |

`Shared/` holds the contracts all three consume. It is not a fourth product and
may not depend on Editor or Playout.

The canonical architecture is [`docs/architecture.md`](docs/architecture.md);
start at [`docs/README.md`](docs/README.md) for the authority order.

## Start

```bash
npm install
npm run dev            # Editor: desktop shell, project service, ensures an engine
npm run dev:playout    # Playout: operator UI, control service, engine
npm run dev:engine     # the render engine on its own
npm run dev:web        # Editor UI in a browser, for debugging
```

The Editor desktop shell runs the project service and **ensures** a render engine
is running — it adopts one that is already up and never stops it on window close,
because Program outlives an authoring window. Playout's shell behaves the same
way with its own control service.

## Layout

```text
Editor/     apps/{editor-web,desktop-tauri,desktop-electron},
            services/{project-api,editor-mcp}
Playout/    apps/{playout-web,desktop-tauri}, services/playout-control
Shared/     13 contract packages — see Shared/README.md
services/   render-engine (the engine), render-daemon (its render core library)
tools/      architecture guards and certification harnesses
docs/       architecture and detail documents
data/       runtime state: scenes, assets, packages, rundowns, caches (gitignored)
```

`services/render-daemon` is the engine's core library, `grapix-render-core`. The
protocol v2 binary that gave the directory its name was **deleted on 2026-07-29**,
along with its transport, controller, v2 protocol and process config — about 3,250
lines that nothing launched and no test exercised. Port 4200 can no longer be bound
by anything here. Editor and Playout speak protocol v3
(`@grapix/render-protocol`) to the engine and nothing else.

### Local ports

| Port | Service |
| --- | --- |
| 4100 | `Editor/services/project-api` |
| 4150 | `Editor/services/editor-mcp`, when run over HTTP instead of stdio |
| 4300 | `Playout/services/playout-control` |
| 4400–4403 | `services/render-engine` and additional render nodes |
| 5173 / 5174 | editor web / playout web |

## AI clients

`Editor/services/editor-mcp` is a Model Context Protocol server. It gives Claude,
Codex, Gemini, Kimi or any other MCP client the Editor's authoring surface — 53
tools over scenes, objects, materials, assets, fonts, imports, animation, data
bindings, preflight and publish — plus the ingested architecture, contracts and
capability knowledge of this repository.

It is the Editor, and only the Editor: a build-time guard fails if a tool ever
names Cue, Take, Continue, Clear, Program or an output verb. Client
configuration is in
[`Editor/services/editor-mcp/README.md`](Editor/services/editor-mcp/README.md);
`.mcp.json` at the repository root configures Claude Code automatically.

## Commands

```bash
npm run build            # Shared, then Editor, then Playout
npm run typecheck        # every workspace
npm test                 # every workspace's suite
npm run test:engine      # render engine (Rust)
npm run test:core        # render core (Rust, includes a real GPU smoke test)
npm run check:boundaries # Editor/Playout/Shared isolation and retired-package guard
npm run check:engine
```

`check:boundaries` is the structural guard rail: it fails on a cross-domain
manifest dependency, a relative import that climbs into another product, or any
dependency on a retired package. Run it after moving anything.

### Certification

```bash
npm run certify:render-core      # deterministic 80-scene lifecycle gate
# with the engine running (npm run dev:engine):
npm run certify:engine           # real protocol-v3 client against the real engine
npm run certify:ipc              # local IPC transport, with its own engine
npm run certify:parity           # pixel parity; see docs/pixel-parity.md
# with the engine and playout-control running (npm run dev:playout):
npm run certify:playout-engine   # publish, prepare, cue, take, clear over HTTP
npm run certify:publish-takelist # publish -> Scene Manager -> Take List -> air
npm run certify:materials        # shared fixtures + the no-default-features build
```

The engine resolves its whole CLI-over-environment-over-file precedence chain
without needing a GPU:

```bash
cargo run --manifest-path services/render-engine/Cargo.toml -- \
  --config services/render-engine/engine.toml --print-config
```

Hardware and vendor-output certification requires
[`docs/hardware-certification-template.md`](docs/hardware-certification-template.md).
The 8/24-hour soak gate currently has **no harness** — the previous one exercised
the retired protocol v2 path and was removed rather than left to report green
against a runtime that will not ship.

## Status

V1 is local-only and incomplete. What exists, what is partial, and what is a
hardware gate is tracked in
[`docs/architecture-review-compliance.md`](docs/architecture-review-compliance.md)
and in the M1–M4 plan in
[`docs/local-v1-system-design.md`](docs/local-v1-system-design.md). The largest
open item is milestone M2: the Editor still authors through a browser viewport
(PixiJS + Three.js), and only a native Editor Render View can guarantee that
authored pixels match Program.
