# GrapiX Render Daemon

Standalone Rust service that receives GrapiX `SceneDocument` JSON over a local
WebSocket, renders it headlessly with `wgpu`, and sends finished frames to a
video output backend (NDI, or a null output for development). It is the
scaffold for the production on-air renderer described in
`docs/architecture.md`.

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

## WebSocket protocol (v1)

Connect with the authentication token in the WebSocket query string
(`ws://127.0.0.1:4200?token=...`). After the authenticated handshake, send one
JSON object per text frame; every message carries `protocolVersion: 1`.
`requestId` is optional and echoed in the reply so clients can correlate.
Scene messages carry **full `SceneDocument` replacements** — the repository
defines no renderer patch format beyond full documents, so v1 does not invent
one (`scene.update` exists as a distinct type so patching can be added later
without breaking `scene.load`).

Client → daemon:

```jsonc
{ "type": "scene.load",   "protocolVersion": 1, "requestId": "req_1", "scene": { /* SceneDocument */ } }
{ "type": "scene.update", "protocolVersion": 1, "scene": { /* SceneDocument */ } }
{
  "type": "output.configure", "protocolVersion": 1,
  "width": 1920, "height": 1080,
  "frameRateNumerator": 60000, "frameRateDenominator": 1001,
  "scanMode": "p",                  // "p" | "i" — interlaced is validated and rejected in v1
  "alphaMode": "premultiplied",     // "straight" is validated and rejected in v1
  "colorFormat": "bgra8",
  "colorSpace": "srgb",
  "ndiSourceName": "GrapiX Output",
  "backend": "null"                 // optional; defaults to "ndi" when compiled with the feature, else "null"
}
{ "type": "output.start", "protocolVersion": 1 }
{ "type": "output.stop",  "protocolVersion": 1 }
{ "type": "status",       "protocolVersion": 1 }
```

Daemon → client:

- `{ "type": "ack", "requestType": "...", "warnings": [...] }` — success;
  `warnings` lists everything the renderer will NOT draw (unsupported object
  types, rounded corners, bad colors).
- `{ "type": "error", "code": "...", "message": "..." }` — codes:
  `INVALID_JSON`, `PROTOCOL_VERSION_MISMATCH`, `UNSUPPORTED_MESSAGE`,
  `INVALID_PAYLOAD`, `INVALID_SCENE`, `INVALID_OUTPUT_CONFIG`,
  `OUTPUT_STATE_ERROR`, `RENDERER_ERROR`.
- `{ "type": "status", ... }` — connected clients, scene id/name/revision +
  warnings, GPU adapter/backend, output state (`idle`/`configured`/`running`),
  configured format, frames rendered/sent/dropped, last render time, last error.

Frame rates are **rational** (`60000/1001` for 59.94), never floats, and must
resolve to a rate from 1 through 240 fps. Formats
like 1080p50, 1080p59.94, 720p50, 720p59.94 validate today; 1080i50/i59.94
are representable but rejected with an explicit error until field rendering
exists. Dimensions validate up to 4320 lines (UHD).

## What renders in v1

Solid-color **rects only** (position, size, rotation, opacity, hex fills
including `#rrggbbaa`). Rects resolve stable material IDs, one-level material
instances, primitive overrides, and Normal/Add blend state before compositing
over the scene canvas background in the editor's render order (`layerId`,
`zDepth`, `zIndex`). Unsupported material/alpha/blend states are skipped with a
warning rather than silently approximated. Every other object
type — text, image, ellipse, line, mesh, etc. — is counted and reported in
`warnings`; the daemon never pretends to render what it cannot. Rounded
rect corners draw sharp, with a warning.

The pipeline (offscreen BGRA8-sRGB target, premultiplied alpha, linear-light
shading, shared WGSL) is dimensioned for the full roadmap: images, text,
video, masks, nested transforms, and effects. Textured material decoding and
upload are explicitly not implemented yet.

## Shared shaders

The WGSL shader, uniform byte layouts, blend modes, and transform math live in
`packages/render-shaders` and are shared with the future browser WebGPU
preview so the editor and the on-air output cannot drift apart. See
`packages/render-shaders/docs/shader-contract.md`. Contract tests:

- `tests/layout_contract.rs` — Rust structs vs `layouts.json`, byte for byte.
- `tests/scene_contract.rs` — parses the fixture emitted from the TypeScript
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
- `POST /api/render-daemon/scene` (body: `SceneDocument`)
- `POST /api/render-daemon/scenes/:sceneId/load` (loads a stored scene)
- `POST /api/render-daemon/output/configure` (body: the `output.configure` fields)
- `POST /api/render-daemon/output/start`
- `POST /api/render-daemon/output/stop`

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

Module layout follows the standard `src/{config,protocol,scene,renderer,output,transport}`
split, plus `controller.rs` (output state machine + thread lifecycle) and
`lib.rs` (so integration tests can exercise everything without the binary).
