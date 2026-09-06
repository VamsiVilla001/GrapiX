# GrapiX — Technology & Architecture Reference

> What this repository is built from: the languages, runtimes, frameworks, processes and
> protocols, and the rules that decide where a given piece of code is allowed to live.
>
> This is a *technology* map. For the product rules and the non-negotiable invariants read
> [`architecture.md`](architecture.md) first — where the two disagree, that one wins.

Repository version `0.2.0`. Facts below were read from the manifests in this tree, not from
memory; where a value is a version it is the one pinned in the corresponding
`package.json` / `Cargo.toml`.

---

## 1. The three products

GrapiX is one repository holding three products with a deliberate authority split, in the same
relationship as Viz Artist / Trio / Engine or Ross XPression Designer / Sequencer / Engine.

| Product | Directory | Owns | Must never |
| --- | --- | --- | --- |
| **Editor** | `Editor/` | Authoring: scenes, materials, assets, fonts, animation, data bindings, validation, durable publish | Touch Program or output |
| **Playout** | `Playout/` | Operations: published scene library, take lists, timecode, automation, Preview/Program control, output configuration | Mutate authoring content |
| **Render Engine** | `services/render-engine/` | Rendering: the only implementation that rasterizes production pixels, all GPU state, the rational frame clock, Program and the outputs | — |

`Shared/` holds the contracts all three consume. It is **not** a fourth product and may not
depend on Editor or Playout. `npm run check:boundaries` enforces this and is a required gate.

---

## 2. Languages

| Language | Files | Where and why |
| --- | --- | --- |
| **TypeScript** | 437 `.ts`, 48 `.tsx` | Every UI, every Node service, every shared contract. `strict: true` everywhere. |
| **Rust** | 127 `.rs` | The render engine and render core — everything that touches the GPU or the frame clock — plus both Tauri desktop shells. |
| **WGSL** | 5 shaders | GPU shader programs in `Shared/render-shaders/wgsl/`, consumed by wgpu (native) and WebGPU (browser preview). |
| **ExtendScript (ES3 JSX)** | 2 `.jsx` | `Editor/services/adobe-mcp-gateway/jsx/` — the only reader of the proprietary binary `.aep`, run inside After Effects. ES3: no `let`, no arrow functions, JSON polyfilled inline. |
| **JavaScript (ESM `.mjs`)** | 109 | Test files (`node --test`) and build/packaging scripts. Tests run against built `dist/`, never against `src/`. |

### TypeScript configuration (`tsconfig.base.json`)

`target: ES2022` · `module: ESNext` · `moduleResolution: Bundler` · `strict: true` ·
`isolatedModules: true` · `jsx: react-jsx` · `noEmit` at the base (packages opt into emit).

Repository rules that the compiler does not enforce but review does: no `any`, no
`ReturnType<typeof fn>` as a published contract, `import type` for type-only imports, no
dynamic `import()` for a statically known module.

---

## 3. Runtimes

| Runtime | Version | Runs |
| --- | --- | --- |
| **Node.js** | `>=22.12.0` (engines); v22.14.0 in use | All backend services. A private copy is staged into both installers, so an installed GrapiX needs no system Node. |
| **Rust / cargo** | edition 2021, `rust-version = 1.87` | Render engine + render core. Tauri shells target 1.77.2. |
| **Chromium (WebView2)** | via Tauri 2 | The packaged desktop UI on Windows. |
| **Browser** | any modern | The same UI in development on the Vite dev server. |
| **wgpu** | `26` (pinned major) | Native GPU rendering. Pinned deliberately: wgpu majors break APIs and must move together with the browser WebGPU path. |
| **After Effects ExtendScript** | AE 2026 (26.3) verified | Host for the `.aep` exporter. |

---

## 4. Process and port map

Every service binds loopback by default. A non-loopback bind with no configured token refuses
to start — that is a rule, not a warning.

| Port | Process | Language | Transport |
| --- | --- | --- | --- |
| **4100** | `@grapix/api-server` (Editor project service) | TypeScript / Node | HTTP + SSE (Fastify) |
| **4160** | `@grapix/editor-assistant` (AI broker) | TypeScript / Node | HTTP + SSE |
| **4300** | `@grapix/playout-control` | TypeScript / Node | HTTP + SSE |
| **4400** | `grapix-render-engine` | Rust | WebSocket (protocol v3) + IPC |
| **4784** | `@grapix/adobe-mcp-gateway` | TypeScript / Node | WebSocket (`grapix-adobe/1`) + HTTP |
| **5173 / 5174** | `editor-web` / `playout-web` dev servers | Vite | HTTP |
| ~~4200~~ | retired protocol-v2 daemon, deleted 2026-07-29 | — | nothing may bind it |

Program, its frame clock and its outputs continue when Editor, Playout, or both disconnect or
close. That is invariant 5 and it is why the engine is a separate process rather than a thread
inside either application.

---

## 5. Frontend stack

Both UIs (`Editor/apps/editor-web`, `Playout/apps/playout-web`) share one stack:

| Concern | Choice | Version |
| --- | --- | --- |
| UI framework | React | `^18.3.1` |
| State | Zustand | `^4.5.4` (Editor) |
| Build / dev server | Vite | `^8.1.4` + `@vitejs/plugin-react` `^6.0.3` |
| 2D renderer (viewport) | PixiJS | `^8.19.0` |
| 3D layer | three.js | `^0.185.1` |
| Icons | lucide-react | `^0.468.0` |
| Panel layout | react-resizable-panels | `^4.12.1` |
| Desktop bridge | `@tauri-apps/api` | `^2.8.0` |

Styling is one hand-written `styles.css` per app with CSS custom properties as design tokens
(`--bg-panel`, `--accent`, `--danger`, …) — no CSS framework, no CSS-in-JS.

---

## 6. Backend stack

| Concern | Choice |
| --- | --- |
| HTTP server | Fastify `^5.10.0` + `@fastify/cors` `^11.3.0` |
| WebSocket | `ws` `^8.18.0` (Adobe gateway) |
| AI tool protocol | `@modelcontextprotocol/sdk` `^1.30.0` |
| Schema validation | `zod` `^3.25.76` (MCP tool inputs) |
| Image / canvas | `@napi-rs/canvas`, `pngjs`, `jszip` |
| Design import | `ag-psd` (PSD), `pdfjs-dist` (AI/PDF), `fast-xml-parser` (SVG, AEPX) |
| Fonts | `fontkit` |
| Adobe cloud | `@adobe/aio-lib-photoshop-api`, `@adobe/aio-lib-ims` |

### Rust crates (render engine + core)

`wgpu 26` · `tokio 1` · `tokio-tungstenite 0.26` · `glam 0.29` · `bytemuck` · `serde`/`serde_json` ·
`lyon_path` + `lyon_tessellation 1` (vector tessellation) · `cosmic-text 0.14.2` (text shaping) ·
`gltf 1.4` · `image 0.25` · `anyhow` / `thiserror 2` · `sha2` · `toml` · `tracing`.

Optional, feature-gated: `grafton-ndi` behind `--features ndi`. A feature flag makes an
adapter *compilable*, never "certified".

---

## 7. Shared contract packages (`Shared/`)

16 contract packages, all `@grapix/*`, all consumed by two or three products (the
boundary gate reports 17 because it counts the `Shared` workspace root itself):

| Package | Holds |
| --- | --- |
| `shared-types` | `SceneDocument` and every scene type; the animation evaluator; the AE import manifest. Zero runtime dependencies — it is imported by browser and Node alike. |
| `scene-model`, `stage-model`, `surface-model`, `tile-system` | Geometry and stage decomposition |
| `render-protocol` | Engine protocol **v3** envelope and client |
| `renderer-contracts`, `output-contracts` | What a renderer and an output must implement |
| `animation-engine` | Keyframe/channel runtime |
| `asset-manager`, `shader-library`, `render-shaders` | Assets and WGSL |
| `adobe-common-schema` | Adobe gateway protocol, the AE SDK enum tables, the AEPX parser and the AE→scene converter |
| `grapix-adobe-client` | Typed WebSocket client for the gateway |
| `grapix-sdk` | Sequence engine and public SDK surface |
| `service-discovery` | mDNS local-link discovery |

### Parallel implementations — the rule that matters most

Several specifications exist **twice, in two languages**, because the editor previews in
TypeScript and Program renders in Rust, and the two must agree exactly:

| Specification | TypeScript | Rust |
| --- | --- | --- |
| Tile decomposition | `Shared/tile-system` | `services/render-engine/src/tile.rs` |
| Texture fit | `resolveTextureFit` | `resolve_texture_fit` |
| Animation evaluation | `evaluateSceneAtFrame` | `animation.rs` `SceneAnimation` |
| Trim Paths | `trimFlattenedPath` | `trim_flattened_path` |

Change them together. Each pair has tests on both sides whose job is to fail when someone does
not. A scene that animates in the Editor and sits still on air is a silent on-air fault.

---

## 8. Desktop packaging

Two shells exist; **Tauri 2 is the shipping one**.

| Shell | Stack | Status |
| --- | --- | --- |
| `desktop-tauri` | Tauri `2.11.3` + `tauri-build 2.6.3`, Rust, WebView2 | Ships. Produces NSIS `.exe` and WiX `.msi`. |
| `desktop-electron` | Electron `^43.1.1` | Retained alternative shell. |

Each Tauri shell carries a **supervisor** (`src-tauri/src/supervisor.rs`) that starts the
services the app needs, watches their health, and reports state to the status bar. Two rules
it enforces:

- The render engine is *ensured*, never *owned* — an Editor window closing must not take a show
  off air.
- Non-engine services spawn with `CREATE_NO_WINDOW` and piped stdio, so no console windows pop
  up; their output goes to `<data>/logs/<service>.log`. The engine keeps its console.

Installers stage: the service bundles (esbuild single-file `.mjs`), a private Node runtime
(~79.5 MiB), native `node_modules` that cannot be bundled, the MCP knowledge corpus, and the
After Effects ExtendScript exporter.

---

## 9. Build, test and release commands

| Command | Does |
| --- | --- |
| `npm run dev` | Editor with its services |
| `npm run dev:playout` / `dev:engine` / `dev:api` | One process at a time |
| `npm run build` | clean → Shared → Editor → Playout → stage runtime |
| **`npm run ship`** | `build` + both Tauri installers. `ship:editor` / `ship:playout` for one. |
| `npm run typecheck` | Shared + Editor + Playout, including `cargo check` for the shells |
| `npm test` | `test:shared` + `test:editor` + `test:playout` |
| `npm run test:engine` / `test:core` | `cargo test` for the Rust crates |
| `npm run check:boundaries` | Product isolation gate |
| `npm run certify:*` | Ten end-to-end certification harnesses (engine, animation, monitors, IPC, pixel parity, …) |

**Build order is load-bearing.** Within `Editor`, `adobe-mcp-gateway` builds *before*
`api-server`, because the project service imports the gateway's After Effects bridge through
the `./ae-bridge` export subpath and `clean:dist` removes its types first.

Testing uses **`node --test`** (Node's built-in runner) and **`cargo test`**. No Jest, no
Vitest, no Mocha. Node tests import from `dist/`, so a test failure means the built artifact is
wrong, not just the source.

---

## 10. Protocols

| Protocol | Between | Shape |
| --- | --- | --- |
| **Engine protocol v3** | Editor/Playout ↔ render engine | JSON envelopes over WebSocket (4400) or IPC. `ENGINE_PROTOCOL_VERSION = 3`. Replies and events never share a `messageId`; sequence handling runs before deduplication. |
| **`grapix-adobe/1`** | Editor / MCP ↔ Adobe gateway ↔ Photoshop UXP or AE ExtendScript | JSON over WebSocket (4784), `hello` → `tool.call` → `tool.progress`* → `tool.result` / `tool.error`. Mutating tools need explicit per-session operator approval. |
| **HTTP + SSE** | UIs ↔ their services | REST for commands; SSE for diagnostics and progress streams. |
| **mDNS** | Editor ↔ Playout | Local-link discovery, so the two halves find each other without configuration. |
| **MCP** | AI assistant ↔ editor tools | `@modelcontextprotocol/sdk` over stdio. |

---

## 11. Data on disk

Everything is written under one root — `GRAPIX_DATA_ROOT`, defaulting to `data/` in
development and per-user AppData in an installed build, because `C:\Program Files` is
read-only to a standard account.

```text
data/
  scenes/            authored scene documents
  autosaves/scenes/  per-scene ring buffer (default 10, configurable 1–50)
  backups/scenes/    pre-write copies (20 retained)
  packages/          published .gfxpkg, checksum-addressed
  rundowns/          Playout rundowns
  assets/
    index/           content-addressed asset records (sha256)
    after-effects/<Project>/   AE imports: footage, images, image-sequences,
                               audio, video, fonts, proxies, rendered-fallbacks
  images/<scene>/    human-readable imported design images
  logs/              per-service logs from the desktop supervisor
```

Two asset homes on purpose: the content-addressed store deduplicates, and the readable
per-scene folders let a person find and replace the photo they imported.

---

## 12. Cross-cutting design rules

These are the ones that shape code review more than any style guide:

1. **No silent fallback.** A declared-but-unimplemented value must be *reported*, never quietly
   substituted. Six of eight texture-fit modes rendering as `stretch` is the defect this rule
   exists to prevent; blend modes, mask modes and effects all follow it.
2. **The renderer is the only renderer.** Editor and Playout never import renderer internals or
   own Program GPU state.
3. **Publishing is immutable.** A mutable Editor scene can never replace a published Playout
   scene in place; publishing creates a new revision.
4. **Failures explain themselves.** A refusal carries a stable `code`, a one-line `summary`, the
   `cause`, a `remedy`, and the identifiers needed to act — surfaced in the diagnostics console
   in both applications rather than a banner that the next action erases.
5. **Transactional imports.** An import that fails removes every file and scene it created.
6. **Path safety.** Every externally supplied path is sanitised and re-checked under the data
   root *after* joining, because a syntax check alone cannot see a symlink.
7. **No absolute stage coordinates on the GPU.** Subtract the tile origin in `f64`, then narrow
   to `f32`.

---

## 13. Accumulated operational knowledge

`memory.md` at the repository root holds 170 numbered, binding session rules — each one records
something that already went wrong here. Read it before a first change. A sample of the kind of
thing it captures:

- `afterfx -r` silently ignores a script path containing a space: After Effects starts, runs
  nothing, and exits 0.
- Never pin an Adobe version list; enumerate the install directory instead.
- The AE scripting DOM enums are not the SDK's PF constants (`MaskMode.SUBTRACT` is 6814, not 2),
  and inside the binary `.aep` neither applies: transfer modes there are `PF_Xfer` numbers where
  Normal is 2, and text justification is 0-based from `LEFT_JUSTIFY`.
- Pixi's geometry runs headless, so hole detection and curve control points are assertable in a
  plain Node test — prefer that to a screenshot for anything geometric.

---

## 14. Where to read next

| Document | Subject |
| --- | --- |
| [`architecture.md`](architecture.md) | Products, invariants, engine host, protocol v3, recovery, gates |
| [`local-v1-system-design.md`](local-v1-system-design.md) | The design review and the M1–M4 plan |
| [`editor-playout-workspace.md`](editor-playout-workspace.md) | Repository ownership and the migration phase log |
| [`adobe-integration.md`](adobe-integration.md) | Adobe gateway, Photoshop transports, After Effects project import |
| [`render-engine-architecture.md`](render-engine-architecture.md) | Tiling, render graph, output adapters |
| [`scene-document-v1.md`](scene-document-v1.md) | The scene contract itself |
| `memory.md` | The 170 binding session rules |
