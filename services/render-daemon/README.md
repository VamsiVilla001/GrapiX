# GrapiX Render Core (`grapix-render-core`)

The native Rust/wgpu crate that parses `SceneDocument` JSON, prepares meshes,
materials, textures and shaped text, renders headlessly with `wgpu`, and sends
finished frames to a `VideoOutput` backend (NDI when SDK-enabled, deterministic
raw recording, or null output for development).

## Status: library only, binary removed

This crate is consumed by `services/render-engine` under the alias
`grapix-render-core`. That is its whole role: roughly ten thousand lines of tested scene
parsing, mesh preparation, text shaping, pipeline caching and output adapters, reused
without moving a file.

The `grapix-render-daemon` binary that spoke **protocol v2 on port 4200 is gone** (removed
2026-07-29), along with its `transport`, `controller`, v2 `protocol`, `resource` table,
`asset_cache` and `media` modules — about 3,250 lines. Nothing launched it: no package
script, no desktop shell, no service. An earlier note here claimed the binary was kept so
the crate's integration tests could drive the render core end to end without the engine.
That was not true — `tests/` imports only `scene` and `renderer`, never the transport or the
controller — so the binary was dead weight that could still bind a port and drive its own
outputs.

That mattered beyond tidiness: a second renderer able to take a port and transmit is a way
to put unverified pixels on air (`docs/architecture.md`, invariants 1 and 7). Port 4200 is
now unbindable by anything in this repository.

Do not add one back. Editor and Playout speak protocol v3
(`@grapix/render-protocol`) to the engine on 4400, and a second renderer competing for one
GPU is the opposite of holding a frame deadline.

## Running its tests

```bash
npm run test:core          # cargo test, whole crate
npm run certify:materials  # shared-types fixtures + the no-default-features build
npm run certify:render-core # the 80-scene control-plane certification test
```

Requires Rust 1.87+. `cargo test` skips the GPU smoke test gracefully on
machines without an adapter.

### Environment variables

None. This crate is a library; it reads no environment. The `GRAPIX_RENDER_DAEMON_*`
variables — bind host, port 4200, auth token, allowed origins, log filter — went with the
binary. The engine configures itself from `services/render-engine/engine.toml`.

## What renders now

Solid-color **rects and analytic ellipses**, Unicode-shaped **text**, and native,
depth-tested **3D meshes**. Mesh support includes tessellated cube/slab, sphere,
cylinder and torus primitives plus embedded glTF 2.0/GLB triangle geometry.
Position Z, XYZ rotation, XYZ scale, anchor3d, perspective, face occlusion and
back/front/double-sided culling are real 3D operations.

Cube/slab faces, cylinder caps/sides, continuous sphere/torus surfaces and
imported glTF material elements retain independent material slots. The native
mesh shader treats canonical PBR plus legacy solid, basic-lit, image and
unlit-texture aliases as one light-reactive metallic-roughness surface, including
locally packaged or base64 image assets, opacity, metalness, roughness, emissive
colour/intensity, alpha test, blend mode, texture filtering/wrap, and UV
scale/offset/rotation/pivot/flip. Direct lighting uses a view-dependent
Cook-Torrance GGX BRDF.

Project OTF/TTF/WOFF/WOFF2 bytes are loaded while the scene is prepared and
registered with cosmic-text. Text uses Unicode bidi, script-aware OpenType
shaping, combining-mark/emoji cluster handling, system fallback, wrapping,
alignment, weight, style, rotation and opacity. The shaped glyph layer is
composited into native Program frames; it never positions individual characters.
Remote CSS is resolved and cached as project font assets by the Editor project
service before this crate sees it.

Everything is decoded while the scene is warmed; the broadcast frame clock
performs no asset file or network I/O. Unsupported object/material states are
reported explicitly and unsafe omissions remain Take blockers. Image objects,
shapes and lines still require their native paths.

## Shared shaders

The WGSL shader, uniform byte layouts, blend modes and transform math live in
`Shared/render-shaders` and are shared with the browser WebGPU preview so
authoring and on-air output cannot drift apart. See
`Shared/render-shaders/docs/shader-contract.md`. Contract tests:

- `tests/layout_contract.rs` — Rust structs vs `layouts.json`, byte for byte.
- `tests/scene_contract.rs` — parses the fixture emitted from the TypeScript
  `SceneDocument` source of truth (`npm run fixtures:emit -w @grapix/shared-types`).
- `tests/gpu_smoke.rs` — off-screen pixels for 2D, textured native cube faces and
  imported glTF material elements.

## NDI output

NDI is behind a Cargo feature so the crate builds and tests without the SDK:

```bash
cargo build --features ndi --manifest-path services/render-daemon/Cargo.toml
```

Requirements (per grafton-ndi 1.0):

1. Install the **NDI SDK 6.x** from <https://ndi.video/for-developers/ndi-sdk/>.
2. If installed to a non-standard location, set `NDI_SDK_DIR` to the SDK root.
3. An LLVM/Clang toolchain must be available (bindgen FFI generation).
4. Do **not** commit SDK files or binaries to this repository; the SDK is
   proprietary and every developer installs it locally.

The renderer is decoupled from the NDI crate through the `VideoOutput` trait
(`src/output/mod.rs`); `NullOutput` implements the same trait for development and
CI. If the `ndi` backend is requested from a build without the feature, the
result is a clear `INVALID_OUTPUT_CONFIG` error.

> Status: the NDI backend is written against the grafton-ndi 1.0 API but has not
> been compiled or run here (no NDI SDK in this environment). Validate on a
> machine with the SDK before on-air use — including NDI's expected alpha
> semantics for BGRA sources (this crate emits premultiplied alpha).

## Design notes

- **Broadcast clock**: the render loop is driven by an integer-math deadline
  schedule derived from the rational frame rate (frame N due at
  `N * 1e9 * den / num` ns), so 59.94 never drifts. Incoming traffic only updates
  state; it never paces frames.
- **Threading**: transport handling runs on tokio; rendering runs on a dedicated
  thread (blocking GPU readback is intended there); NDI/network sends run on a
  second thread fed by a bounded 2-slot channel (double buffering). When the
  output stalls, frames drop and are counted — the render clock never blocks.
- **Structured logs** via `tracing`; scene documents are never dumped to logs,
  only ids/counts/warnings.

Module layout follows `src/{config,protocol,scene,renderer,output,transport}`,
plus `asset_cache.rs`, `media.rs`, `resource.rs`, `controller.rs` and `lib.rs`
(so integration tests can exercise everything without the binary).

The controller owns one non-evictable Program scene, one non-evictable Preview
selection, and a three-scene warm LRU by default. Full scene preparation produces
WARM residency; Preview and Take are revision-checked state transitions. Status
exposes per-scene lifecycle, last-use order, estimated prepared bytes and
aggregate cache pressure.

## Resource profiles

`EDITOR_PREVIEW`, `PROGRAM_HD` (default), `PROGRAM_UHD`, `LOW_LATENCY` and
`SAFE_MODE` publish explicit output, warm/prepared/CPU/GPU cache, texture,
decoder, render-target, 3D-complexity, shadow, preview, antialiasing,
background-work, effect and diagnostics limits. The governor enforces the
currently resident resources and exposes the remainder as explicit gates.
Tightening a profile evicts only warm scenes; Program and Preview are preserved
and any remaining over-budget active state is visible in status.

## Deliberate production gates

- Native video lifecycle, bounded frame queues and clock selection exist, but no
  native codec binding is enabled; video publication is blocked.
- glTF/GLB import validation and complexity/VRAM reports exist in the project
  service, but native/editor 3D rendering is not complete.
- DeckLink and AJA are recognized vendor plugin targets and rejected until an
  SDK-backed, hardware-certified build exists.
- The NDI backend is source-complete but remains unverified in this checkout
  without the NDI SDK/hardware.
- `npm run certify:render-core` validates the exact 80-scene control-plane mix.
  Long soak and hardware records remain separate evidence.
