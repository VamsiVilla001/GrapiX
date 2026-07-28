# GrapiX Render Daemon

Standalone native Rust service that receives GrapiX `SceneDocument` JSON over
an authenticated local WebSocket, renders it headlessly with `wgpu`, and sends
finished frames to a `VideoOutput` backend (NDI when SDK-enabled,
deterministic raw recording, or null output for development).

The daemon is **optional** in this phase: the editor, Electron app, and API
server work fully without it.

## Running

```bash
# from the repository root (null output available, no NDI SDK needed)
npm run dev:daemon
# equivalently
cargo run --manifest-path services/render-daemon/Cargo.toml

# tests
npm run test:daemon
```

Requires Rust 1.87+ and a GPU (the daemon fails fast at startup if no adapter
is found). `cargo test` skips the GPU smoke test gracefully on machines
without an adapter.

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `GRAPIX_RENDER_DAEMON_HOST` | `127.0.0.1` | WebSocket bind host |
| `GRAPIX_RENDER_DAEMON_PORT` | `4200` | WebSocket bind port |
| `GRAPIX_RENDER_DAEMON_TOKEN` | generated | Shared authentication token override (minimum 32 URL-safe characters) |
| `GRAPIX_RENDER_DAEMON_TOKEN_FILE` | `data/render-daemon.token` | Per-install token file shared with the API bridge |
| `GRAPIX_RENDER_DAEMON_ALLOWED_ORIGINS` | unset | Comma-separated browser Origins allowed to open the WebSocket directly |
| `GRAPIX_RENDER_DAEMON_LOG` | `info` | tracing filter (falls back to `RUST_LOG`) |
| `GRAPIX_RENDER_DAEMON_DUMP_FIRST_FRAME` | unset | Path to write frame 0 as a PPM image for eyeballing output |

On first startup the daemon creates a cryptographically random 256-bit token
under the repository's ignored `data/` directory. The API bridge discovers the
same file automatically and sends the token during the WebSocket handshake.
For split-host deployments, set the same `GRAPIX_RENDER_DAEMON_TOKEN` value in
both processes instead. Browser-originated WebSockets are rejected by default;
explicitly list trusted Origins only when a browser must connect directly.

## WebSocket protocol (v2)

The TypeScript source of truth for client envelopes and replies is
`packages/renderer-protocol`. Rust parsing and contract tests in this service
must change in the same commit as that package.

Connect with the authentication token in the WebSocket query string
(`ws://127.0.0.1:4200?token=...`). After the authenticated handshake, send one
JSON object per text frame. Protocol v2 requires a non-empty `requestId`, a
strictly increasing per-connection `sequence`, Unix `timestampMs`, an explicit
`expectedRendererState`, and explicit scene/channel context (use `null` when it
does not apply). Replies echo the request id and sequence. Duplicate or
out-of-order sequences, state-precondition failures, and scene revision
mismatches are rejected.

Structural scene messages carry full `SceneDocument` replacements. Typed
`scene.patch` messages carry small data/object updates with current and next
revision values. Preparation occurs off the render thread; the render watch
channel observes only the latest revision at a frame boundary.

Client → daemon:

```jsonc
{
  "type": "scene.load",
  "protocolVersion": 2,
  "requestId": "req_1",
  "sequence": 1,
  "timestampMs": 1784950000000,
  "expectedRendererState": "any",
  "sceneId": "lower-third",
  "sceneRevision": "2026-07-25T12:00:00.000Z",
  "channel": null,
  "scene": {
    "id": "lower-third",
    "updatedAt": "2026-07-25T12:00:00.000Z"
    // ...complete SceneDocument
  }
}
{
  "type": "output.configure",
  "protocolVersion": 2,
  "requestId": "req_2",
  "sequence": 2,
  "timestampMs": 1784950000100,
  "expectedRendererState": "any",
  "sceneId": null,
  "sceneRevision": null,
  "channel": null,
  "width": 1920, "height": 1080,
  "frameRateNumerator": 60000, "frameRateDenominator": 1001,
  "scanMode": "p",
  "alphaMode": "premultiplied",
  "colorFormat": "bgra8",
  "colorSpace": "srgb",
  "ndiSourceName": "GrapiX Output",
  "backend": "null"
}
```

Other command types use the same mandatory envelope:
`capabilities.get`, `heartbeat`, `scene.update`, `scene.warm`, `scene.patch`,
`scene.release`, `channel.preview.set`, `channel.take`, `output.start`,
`output.stop`, `resource.profile.set`, and `status`. Scene/channel commands require matching
`sceneId` and `sceneRevision`; Preview uses `channel: "preview"` and Take uses
`channel: "program"`. Protocol v2 implements a deterministic cut only and
rejects other transition names. `output.start` should declare
`expectedRendererState: "configured"`; `output.stop` should declare
`"running"`.

Daemon → client:

- `{ "type": "ack", "requestType": "...", "warnings": [...] }` — success;
  `warnings` lists everything the renderer will NOT draw (unsupported object
  types, rounded corners, bad colors).
- `{ "type": "error", "code": "...", "message": "..." }` — codes:
  `INVALID_JSON`, `PROTOCOL_VERSION_MISMATCH`, `INVALID_ENVELOPE`,
  `STALE_SEQUENCE`, `REVISION_MISMATCH`, `EXPECTED_STATE_MISMATCH`,
  `UNSUPPORTED_MESSAGE`, `INVALID_PAYLOAD`, `INVALID_SCENE`,
  `INVALID_OUTPUT_CONFIG`, `OUTPUT_STATE_ERROR`, `RENDERER_ERROR`.
- `{ "type": "capabilities", "capabilities": ... }` — implemented commands,
  scene versions, transport and feature flags. Flags remain false until the
  corresponding runtime behavior exists.
- `{ "type": "status", ... }` — connected clients, scene id/name/revision +
  warnings, all resident scenes and lifecycle states, Preview/Program ids,
  warm-cache counts/estimates, GPU adapter/backend, output state
  (`idle`/`configured`/`running`), configured format, frames
  rendered/sent/dropped, last/average/p99 render timing and budget
  utilization, detected GPU/driver/limits, native asset-cache tiers and last
  error.
- `{ "type": "event", "eventType": "...", ... }` — server-pushed
  lifecycle/channel/output/resource changes with a global event sequence.

Frame rates are **rational** (`60000/1001` for 59.94), never floats, and must
resolve to a rate from 1 through 240 fps. Formats
like 1080p50, 1080p59.94, 720p50, 720p59.94 validate today; 1080i50/i59.94
are representable but rejected with an explicit error until field rendering
exists. Dimensions validate up to 4320 lines (UHD).

## What renders now

Solid-color **rects and analytic ellipses**, Unicode-shaped **text**, and native,
depth-tested **3D meshes**. Mesh support includes tessellated cube/slab,
sphere, cylinder, and torus primitives plus embedded glTF 2.0/GLB triangle
geometry. Position Z, XYZ rotation, XYZ scale, anchor3d, perspective, face
occlusion, and back/front/double-sided culling are real 3D operations.

Cube/slab faces, cylinder caps/sides, continuous sphere/torus surfaces, and
imported glTF material elements retain independent material slots. The native
mesh shader treats canonical PBR plus legacy solid, basic-lit, image, and
unlit-texture aliases as one light-reactive metallic-roughness surface,
including locally packaged or base64 image assets, opacity, metalness,
roughness, emissive colour/intensity, alpha test, blend mode, texture
filtering/wrap, and UV scale/offset/rotation/pivot/flip. Direct lighting uses a
view-dependent Cook-Torrance GGX BRDF.

Project OTF/TTF/WOFF/WOFF2 bytes are loaded while the scene is prepared and
registered with cosmic-text. Text uses Unicode bidi, script-aware OpenType
shaping, combining-mark/emoji cluster handling, system fallback, wrapping,
alignment, weight, style, rotation, and opacity. The shaped glyph layer is
composited into native Program frames; it never positions individual
characters. Remote CSS is resolved and cached as project font assets by the
API before the daemon sees it.

Everything is decoded while the scene is warmed; the broadcast frame clock
performs no asset file or network I/O. Unsupported object/material states are
reported explicitly and unsafe omissions remain Take blockers. Image objects,
shapes, and lines still require their native paths.

## Shared shaders

The WGSL shader, uniform byte layouts, blend modes, and transform math live in
`packages/render-shaders` and are shared with the future browser WebGPU
preview so the editor and the on-air output cannot drift apart. See
`packages/render-shaders/docs/shader-contract.md`. Contract tests:

- `tests/layout_contract.rs` — Rust structs vs `layouts.json`, byte for byte.
- `tests/scene_contract.rs` — parses the fixture emitted from the TypeScript
- `tests/gpu_smoke.rs` — off-screen pixels for 2D, textured native cube faces,
  and imported glTF material elements.
  `SceneDocument` source of truth
  (`npm run fixtures:emit -w @grapix/shared-types`).

## NDI output

NDI is behind a Cargo feature so the daemon builds and tests without the SDK:

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
(`src/output/mod.rs`); `NullOutput` implements the same trait for development
and CI. If the `ndi` backend is requested from a build without the feature,
the daemon replies with a clear `INVALID_OUTPUT_CONFIG` error.

> Status: the NDI backend is written against the grafton-ndi 1.0 API but has
> not been compiled or run here (no NDI SDK in this environment). Validate on
> a machine with the SDK before on-air use — including NDI's expected alpha
> semantics for BGRA sources (the daemon emits premultiplied alpha).

## Integration with GrapiX

`services/api-server` exposes optional bridge routes (503 when the daemon is
not running):

- `GET  /api/render-daemon/status`
- `GET  /api/render-daemon/capabilities`
- `GET  /api/render-daemon/heartbeat`
- `POST /api/render-daemon/scene` (body: `SceneDocument`)
- `POST /api/render-daemon/scenes/:sceneId/load` (loads a stored scene)
- `POST /api/render-daemon/scenes/:sceneId/warm`
- `POST /api/render-daemon/scenes/:sceneId/preview`
- `POST /api/render-daemon/scenes/:sceneId/take`
- `POST /api/render-daemon/scenes/:sceneId/release`
- `POST /api/render-daemon/resource-profile`
- `POST /api/render-daemon/output/configure` (body: the `output.configure` fields)
- `POST /api/render-daemon/output/start`
- `POST /api/render-daemon/output/stop`
- `PATCH /api/scenes/:sceneId/data-patches` (atomic persistence plus a
  revision-safe daemon patch)

The API accepts browser requests only from `grapix://editor`, the default local
Vite origins, and any comma-separated Origins explicitly added through
`GRAPIX_API_ALLOWED_ORIGINS`. `GRAPIX_EDITOR_URL` is also recognized when it
contains an HTTP(S) development URL. Requests without an Origin header remain
available to same-machine tools. Untrusted Origins are rejected before route
handlers run; this is an execution guard, not merely a CORS response policy.

## Design notes

- **Server, not client**: the daemon hosts the WebSocket server because it is
  the long-lived service; controllers (editor today, sequencer later) come and
  go. A controller disconnect never interrupts rendering — the loop keeps
  producing frames from the last scene, and clients reconnect and resync.
- **Broadcast clock**: the render loop is driven by an integer-math deadline
  schedule derived from the rational frame rate (frame N due at
  `N * 1e9 * den / num` ns), so 59.94 never drifts. Incoming WebSocket traffic
  only updates state; it never paces frames.
- **Threading**: WebSocket handling runs on tokio; rendering runs on a
  dedicated thread (blocking GPU readback is intended there); NDI/network
  sends run on a second thread fed by a bounded 2-slot channel (double
  buffering). When the output stalls, frames drop and are counted — the render
  clock never blocks.
- **Structured logs** via `tracing`; scene documents are never dumped to logs,
  only ids/counts/warnings.

Module layout follows `src/{config,protocol,scene,renderer,output,transport}`,
plus `asset_cache.rs`, `media.rs`, `resource.rs`, `controller.rs` and
`lib.rs` (so integration tests can exercise everything without the binary).

The controller owns one non-evictable Program scene, one non-evictable Preview
selection, and a three-scene warm LRU by default. Full scene preparation
produces WARM residency; Preview and Take are revision-checked state
transitions. Status exposes per-scene lifecycle, last-use order, estimated
prepared bytes and aggregate cache pressure. Preview is currently a prepared
channel selection rather than a second continuous native render output.

## Resource profiles

`EDITOR_PREVIEW`, `PROGRAM_HD` (default), `PROGRAM_UHD`, `LOW_LATENCY`, and
`SAFE_MODE` publish explicit output, warm/prepared/CPU/GPU cache, texture,
decoder, render-target, 3D-complexity, shadow, preview, antialiasing,
background-work, effect and diagnostics limits. The governor enforces the
currently resident resources and exposes the remainder as explicit gates.
Tightening a profile evicts only warm scenes; Program and Preview are
preserved and any remaining over-budget active state is visible in status.

## Deliberate production gates

- Native video lifecycle, bounded frame queues and clock selection exist, but
  no native codec binding is enabled; video publication is blocked.
- glTF/GLB import validation and complexity/VRAM reports exist in the project
  service, but native/editor 3D rendering is not complete.
- DeckLink and AJA are recognized vendor plugin targets and rejected until an
  SDK-backed, hardware-certified build exists.
- The NDI backend is source-complete but remains unverified in this checkout
  without the NDI SDK/hardware.
- `npm run certify:control` validates the exact 80-scene control-plane mix.
  Long soak and hardware records remain separate evidence.
