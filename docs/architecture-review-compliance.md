# Real-time broadcast architecture compliance

Source review: `C:\Users\CG\Downloads\GrapiX_Real_Time_Broadcast_Architecture_Review.md`
(2,015 lines, 35 numbered sections).

This is the acceptance ledger for the migration. A section is **complete** only
when its required behavior exists and has proportionate verification. Design
documentation or an interface alone is not counted as runtime completion.

Status meanings:

- **Complete** — implemented and verified in the repository.
- **Partial** — useful implementation exists, but one or more reviewed
  production requirements remain.
- **Pending** — no production implementation yet.
- **External gate** — implementation can be prepared locally, but completion
  requires named hardware, SDK, media, or soak execution.

| § | Review pointer | Acceptance gate | Status | Evidence / remaining work |
|---:|---|---|---|---|
| 1 | Executive decision | Editor is retained while Program output is isolated in a native process. | Partial | Tauri supervises an isolated Rust/wgpu Program daemon. Native real-3D mesh output now exists; text, general 2D image, and media coverage remain below the production target. |
| 2 | Scope | The 70–80 scene, video, 3D, AE, live-data, output, reliability, and hardware concerns have explicit tests or gates. | Partial | All areas now have implementation, a harness, or an explicit external gate. Full decoder/output/hardware execution remains. |
| 3 | Current architecture | Repository documentation reflects the actual Tauri/React/Fastify/Rust layout. | Complete | `README.md`, `docs/rendering-engine.md`, and `docs/renderer-control-architecture.md`. |
| 4 | Suitability score | Web preview is never represented as certified Program output. | Complete | `ScenePreviewRenderer` and `RendererClient` are separate contracts. Documentation states current limitations. |
| 5 | Scene count/lifecycle | Implement UNLOADED, METADATA_ONLY, LOADING, WARM, PREVIEW, PROGRAM, EVICTABLE, FAILED; 1 Program, 1 Preview, bounded warm LRU. | Partial | All states are modeled; Program/Preview are protected and the warm LRU is bounded/tested across the 80-scene harness. Transient metadata/loading/failed states are not yet observable during asynchronous preparation. |
| 6 | In-editor renderer risk | UI stalls/crashes cannot interrupt Program. | Partial | Daemon survives controller disconnect; Tauri watches API/frames/output and restarts/restores independently. Certified recovery timing/process-priority evidence remains. |
| 7 | Target architecture | Supervisor, editor, project service, contracts, asset pipeline, native daemon, and output plugins have enforced boundaries. | Partial | Boundaries now exist for every module, including native asset/media managers, real-3D warm preparation/rendering, and output trait. Vendor media/output implementations remain gated. |
| 8 | Module responsibilities | Each module owns only the reviewed state and work. | Partial | Editor/project/daemon/supervisor ownership is enforced; asset/media lifecycle lives in native modules. Decoder/proxy/model workers remain validation-stage rather than full workers. |
| 9 | Repository structure | Dependency direction is explicit and shared contracts do not depend on applications. | Partial | `packages/renderer-protocol`, `packages/shared-types`, and `packages/render-shaders` exist. Asset/media/output contract packages remain to be extracted. |
| 10 | Communication protocol | REST for project operations; renderer transport has capabilities, version, request ID, sequence, timestamp, scene/revision, expected state, acknowledgements, events, and stale rejection. | Partial | Protocol v2 implements the complete safety envelope, capabilities, heartbeat, acknowledgements, server-pushed events and stale/revision/state rejection. WebSocket remains the transport instead of named-pipe/gRPC. |
| 11 | Scene state ownership | Frontend owns editor state; backend owns persisted revisions; daemon owns loaded resources, Preview, Program, playback, and output. | Partial | Project service assigns atomic monotonic revisions; daemon owns loaded resources/channels/output. Native playback commands/clock sampling remain. |
| 12 | Renderer design | Native Rust/wgpu renderer, shared shader rules, adapter seam, explicit unsupported-feature errors. | Partial | Headless wgpu renders rects/ellipses plus depth-tested, textured primitive and imported glTF meshes with shared WGSL and pixel smoke tests. Native text, general 2D images/shapes, video, and effects remain explicit gaps. |
| 13 | Preview/Program separation | Independent Preview and Program state with Program priority and optional stronger isolation. | Partial | Runtime owns independent channel selections and never evicts Program/Preview. Only Program has a continuous native render/output loop today. |
| 14 | Frame timing/thread rules | Render thread performs no I/O, parsing, decode, allocation spikes, shader compilation, or network output. | Partial | Dedicated render and output threads plus bounded frame channel exist. Scene preparation is off render thread; instrumentation and allocation audit remain. |
| 15 | Performance targets | Deadlines, headroom, startup, warm, Take, dropped-frame, RAM and VRAM targets are measured. | Partial | Daemon reports last/average/p99 render time and budget utilization; 80-scene cached warm/Take targets are asserted. RAM/VRAM and certified long-run evidence remain. |
| 16 | Asset manager/cache | SHA-256 dedupe, references, CPU/GPU cache tiers, estimates, and LRU eviction are central and shared across scenes. | Partial | Project storage and native cache deduplicate by SHA-256, track aliases/scene priorities/tier bytes/budgets and protect referenced Program assets. Mesh/model/image bytes are decoded during warm and kept in prepared scenes; promotion accounting and shared cross-scene GPU texture residency remain. |
| 17 | Video architecture | Decoder lifecycle CLOSED→PROBED→READY→PREROLL→PLAYING→PAUSED→DRAINING, worker decode, frame queues, formats, hardware decode, pre-roll and sync. | Partial | Native lifecycle, decoder budget, bounded latest-frame queue and renderer-clock selection exist; API probe reports certification requirements. Native codec/hardware decode is deliberately unavailable and blocks publish/Take. |
| 18 | 3D architecture | glTF/GLB import processing, runtime limits, editor preview, daemon meshes/cameras/lights and parity. | Partial | Editor and native Program both render real depth-tested primitives and embedded glTF/GLB triangle geometry with XYZ transforms, authored PBR base materials, per-face/per-material-element overrides, textures, UV controls, directional/point/spot authored lights, and pixel verification. Native active-camera consumption, hierarchy/timeline-resolved light transforms, animation/skinning, shadows, LOD and hardware parity certification remain. |
| 19 | After Effects import | No runtime `.aep`; Lottie, alpha video, image sequence, and structured conversion paths produce import reports. | Partial | `.aep` is explicitly rejected; Lottie layers/paths/text/images/effects/expressions and alpha-media paths produce the required compatibility report. Full structured conversion/export tooling remains. |
| 20 | Material architecture | One material/binding truth shared by inspector, manager, preview, package and daemon with readiness states. | Partial | Central material/face-slot model now drives editor and native 3D solid-unlit, textured-unlit, Basic Lit and PBR surfaces with all-face/per-face assignment, sampler/UV parameters, light classification and shared blend IDs. Custom shaders, video materials, opaque sampled-alpha parity, transparent native depth ordering, and the native 2D sprite/text paths remain. |
| 21 | Package format | Strict versioned `.gfxpkg` with manifest, scene, materials, assets, bindings, metadata, checksums, dependencies, capabilities and preflight. | Complete | `.gfxpkg` v2 embeds local assets plus optional `fonts.json`/`automation.json`, declares renderer/features/fonts/shaders/codecs/memory/fallbacks, writes SHA-256 for every file, reopens/verifies final ZIP bytes, and rejects tampering in tests. |
| 22 | Backend storage | Atomic temp+rename writes, revisions, backups/recovery, hashes, logs; optional SQLite metadata. | Complete | Scene/package/asset writes are temp+fsync+rename, revisions monotonic, prior scenes backed up with explicit recovery, hashes/reference indexes maintained, and operator actions logged. SQLite is optional in the review. |
| 23 | Reliability/crash recovery | Supervisor monitors heartbeat/frame/API/output, restarts daemon, restores Program, and activates safe fallback with structured logs. | Partial | Tauri watchdog monitors the correctly unwrapped daemon reply, bounds restarts, restores Program/output and exposes fallback/GPU/certification status. Crash-injection/on-air fallback timing remains uncertified. |
| 24 | Data updates | Small typed patches update data/object properties without full scene reload; patches are revision/sequence safe and batched at frame boundaries. | Partial | `scene.patch` is typed, revision/sequence safe, rate-limited and uses the watch channel’s latest-value/frame-boundary behavior. Conditional scene/rundown triggers can now emit the same typed data actions. Preparation still rebuilds the prepared scene instead of updating only affected bindings. |
| 25 | Resource controls | EDITOR_PREVIEW, PROGRAM_HD, PROGRAM_UHD and SAFE_MODE govern resolution, cache, effects, decoder and GPU budgets while preserving Program. | Partial | Five profiles govern output, prepared/CPU/GPU cache, texture, decoder, 3D, render-target, shadow/effect/diagnostic and background-work limits; active channels are protected. Live RAM/VRAM enforcement remains. |
| 26 | Keep current architecture | React, TypeScript, npm workspaces, shared scene/material/package direction and Fastify service remain. | Complete | Preserved by the migration. |
| 27 | Required production changes | All compulsory separation, protocol, native Program, lazy/warm scenes, asset lifecycle, recovery, thread, output, video/3D and certification requirements are complete. | Partial | First three foundations exist; remaining rows in this ledger are the production gate. |
| 28 | Migration plan | Phases 0–10 have implementation and verification evidence in dependency order. | Partial | Contracts and preview extraction are mostly complete; native daemon prototype exists; later phases remain. |
| 29 | Production test package | Deterministic 80-scene project and automated load/warm/take/data/video/restart/long-run tests meet pass criteria. | Partial | Exact 20/15/10/10/10/5/5/5 scene mix and warm/Preview/Take tests run in Rust; the isolated API↔daemon E2E gate passed 80 scene loads, live patches, Takes, and null output with zero dropped frames. The runner supports 8/24-hour duration. Video/restart/device-loss passes remain external/incomplete. |
| 30 | Hardware certification | Named HD Basic/Advanced/UHD/3D tiers are tested with published measurements and limitations. | External gate | Profiles/harness can be built locally; certification requires representative machines and output hardware. |
| 31 | Security/operational safety | Localhost defaults, authenticated remote access, file validation, traversal protection, command/schema/size limits, redacted logs and signed-release planning. | Partial | Remote binding requires a token; constant-time auth, Origin controls, import magic/type/size validation, safe IDs/paths, strict package hashes, patch limits, operator audit and read-only show mode exist. Scene scripts are checksummed, statically restricted, permission-scoped SDK modules and are not evaluated in the API/editor/daemon. The runtime npm audit is clear. Release signing and the isolated script/converter sandbox remain. |
| 32 | Final recommendation | Approved target is the repository’s governing architecture and no unsupported path is called production-ready. | Complete | Architecture documents and this acceptance ledger enforce the decision. |
| 33 | Immediate actions | All ten actions are completed or superseded by verified implementation. | Partial | Contracts/adapter, daemon, heartbeats/events, lifecycle/cache/reference accounting, performance telemetry and 80-scene control harness exist. Production renderer/decoder/output coverage and hardware runs remain. |
| 34 | Repository evidence | Evidence list is updated as the architecture changes. | Complete | This ledger links the new contract, adapter, Tauri and daemon areas absent from the older review snapshot. |
| 35 | Review limitation | Hardware certification is never claimed without executing performance, soak and output tests. | Complete | Hardware-dependent rows remain explicitly gated. |

## Requested extension coverage

- **Editor / Playout master workspace:** the approved target separates the
  authoring Editor from the operator-facing Playout application under one root
  workspace, with schemas/protocols under Shared. Playout owns published scene
  versions, rundowns, segments, timecode, Preview/Program control and the
  native/output runtime; Editor owns source projects and durable
  **Publish to Playout**. The verified Basic v0.1 checkpoint and Phase 1
  workspace/boundary scaffold are implemented; the physical Editor move,
  Playout application, and publishing runtime remain phased work governed by
  [`editor-playout-workspace.md`](editor-playout-workspace.md).
- **Font Manager:** packaged OTF/TTF/WOFF/WOFF2 faces, HTTPS CSS links, and
  normalized Adobe Fonts project links are modeled, imported, previewed,
  preflighted, and packaged. Native Program text rendering remains a capability
  gate.
- **Multiple sequencers/timelines:** atomically revisioned rundowns contain
  multiple sequences, tracks, scene cues, per-sequence timing, prewarm windows,
  transitions, variables, and trigger rules.
- **Transitions:** cut is executable now; mix/dip/wipe/push/custom are explicit
  persisted definitions with a documented dual-render-target implementation
  and certification scope. Unsupported native execution returns `deferred`.
- **Conditional scene behavior:** bounded declarative condition trees evaluate
  event, scene-data, and rundown-variable operands with ordered,
  cooldown/once-safe typed actions.
- **Scene scripts and JavaScript SDK:** per-scene checksummed script references
  and `@grapix/sdk` are implemented. Arbitrary source execution remains disabled
  until the isolated worker passes escape, timeout, memory, and action-flood
  certification.

## Required completion order

1. Renderer protocol safety and capability negotiation.
2. Daemon scene lifecycle, Preview/Program channels and warm LRU.
3. Desktop watchdog, restart recovery and fallback.
4. Atomic/revisioned storage plus central asset/cache accounting.
5. Typed patch/data update path and resource profiles.
6. Video, 3D/glTF, AE conversion and complete material/package capability paths.
7. Output validation, 80-scene benchmark, soak tests and hardware certification.

The final audit must turn every **Partial** or **Pending** row into **Complete**,
except §30 and hardware-dependent parts of §35, which require real certification
evidence rather than code alone.

## Current automated evidence

- Shared scene/material/animation/font/automation contracts: 32 tests.
- Editor material renderer classification/opacity/fallback contract: 4 tests.
- GrapiX JavaScript SDK and sequence engine: 3 tests.
- Renderer protocol v2: 6 TypeScript contract tests plus Rust protocol tests.
- Project service: 10 font/script/rundown/importer/package integrity tests.
- Native daemon: 91 tests across unit, real GPU smoke, shader-layout,
  scene-contract and the 3-test 80-scene certification suite.
- Tauri supervisor: 2 unit tests.
- Root production build and TypeScript/Tauri typecheck pass.
- Isolated API↔Rust-daemon E2E: 80 scenes, a conditional rundown action, live
  patches, Takes, null output, more than 100 rendered frames and 0 dropped
  frames in the short control runs.
- Runtime npm dependency audit: 0 known vulnerabilities.

Use `npm run certify:control` for the deterministic 80-scene lifecycle gate and
`npm run certify:e2e` for the isolated short API↔daemon gate.
`npm run certify:soak` runs against an already supervised stack and defaults to
one minute; set `GRAPIX_SOAK_MINUTES=480` or `1440` for the reviewed 8/24-hour
run. None of these commands by itself certifies NDI, a decoder, a vendor output
card, or a hardware tier; use `docs/hardware-certification-template.md` for
those runs.
