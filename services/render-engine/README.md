# GrapiX Render Engine

The standalone, headless-capable, tile-based real-time broadcast graphics renderer.

In GrapiX terms this is the engine tier: the Editor authors, Playout operates, and
this renders. The same separation as Viz Artist / Viz Trio / Viz Engine, or
XPression Designer / Sequencer / Engine.

```bash
grapix-render-engine --config engine.toml
```

## What makes it independent

No React, no Electron, no PixiJS, no DOM. The Editor and Playout reach it only
through the versioned protocol in `src/protocol.rs` (mirrored by
`packages/render-protocol`), never by touching a renderer object.

One binary covers every deployment mode, because mode is configuration rather than
a code path:

| Mode | How |
| --- | --- |
| Local embedded | `--ipc '\\.\pipe\grapix-render-engine'` |
| Local external process | `--port 4400` |
| Remote network engine | `--bind 0.0.0.0 --token-file …` |
| Dedicated GPU workstation | `--preferred-gpu RTX --preferred-backend vulkan` |
| Headless server | `--bind 0.0.0.0 --headless true` |
| Several render nodes | one `--engine-id` and `--port` per node |

## How a 50,000 × 50,000 stage is possible

It is never a framebuffer.

`src/stage.rs` holds a *logical* coordinate space in `f64`. `src/tile.rs`
decomposes it into rectangles small enough to be real GPU render targets. Only
tiles become framebuffers, and only when a viewport, output, preview, or export
actually needs one.

A stage-sized RGBA8 image would be **10 GB** and three times over the maximum
texture dimension of typical hardware. The engine reports that number at startup
and never allocates it. At 2048² a 50,000² stage is 25 × 25 = 625 tiles; at 512² it
is 9,604, which is why tile selection is index-driven rather than a scan.

### The precision rule

> Never hand absolute stage coordinates to the GPU. Subtract the tile origin in
> `f64` first, and only then narrow to `f32`.

At 50,000 the `f64` spacing is about 7.3 × 10⁻¹² — twelve orders of magnitude finer
than a pixel. The `f32` spacing there is 0.0039 px, which is visible jitter before
any transform chain compounds it. After rebasing onto a tile origin the magnitude
is under 2048, where `f32` steps in units of 2⁻¹⁴.

`stage::f32_error` and `stage::local_f32_error` exist so the improvement is
asserted by tests rather than assumed — see
`tests/stage_precision.rs::rebasing_onto_a_tile_origin_recovers_precision_the_gpu_would_lose`,
which requires at least a 32× improvement.

### Why tiles have no seams

Two facts, both enforced in `src/tile.rs`:

1. **Every tile draws every object it overlaps**, using the same world transform
   and differing only by which origin was subtracted. An object crossing a
   boundary therefore lands on the same world position in both tiles.
2. **Only the inner rectangle is composited.** A tile renders at `bounds +
   overscan` so filters have neighbouring pixels to sample, and the composite reads
   back only `bounds`. The overscan ring is sampled and discarded.

`tile::verify_seamless_coverage` turns "seamless" from a claim into an assertion:
the composite rectangles must tile the target exactly, with no gap and no overlap.
`tests/tile_system.rs` runs it over a full 625-tile 50,000² stage.

Overscan is not free. A 1024 tile with 32 units of overscan is 1088 × 1088, about
13% more memory, and `tile_byte_estimate` accounts for it.

### When *not* to tile

Tiling exists to work around the texture limit, so a preview whose scaled output
fits in one texture is rendered as a **single rebased pass**. A 960 × 192 operator
preview of a 50,000-wide stage is nowhere near the limit; splitting it into 125 tile
passes meant 125 pipeline builds and readbacks to produce a thumbnail, which took
about a minute. One pass takes ~550 ms. `preview::render_preview` chooses between
the two on the scaled output size, and both paths apply the same `f64` rebase.

## What is reused rather than rebuilt

`grapix_render_core` is the existing `services/render-daemon` crate, depended on by
path under an alias. That reuses roughly ten thousand lines of tested scene
parsing, mesh preparation, text shaping, pipeline caching, asset caching, media
lifecycle, resource profiles, and output adapters — with its 97-test suite intact.

This engine adds only what is genuinely new: the virtual canvas, tiling, the render
graph, protocol v3, configuration, capability reporting, preview generation,
diagnostics, and security.

### How tile rendering reuses the core pipeline

`src/render.rs` rebases the scene **document** into tile-local coordinates in `f64`
and sets its canvas to the tile's padded render bounds. The core's `prepare_scene`
then sees an ordinary scene that happens to be tile-sized, and `render_single_frame`
draws it with the same quad pipeline, mesh pipeline, and text compositor Program
output uses.

Rebasing at the document level rather than at the uniform level is deliberate:
`PreparedScene` stores positions as `f32`, so a 49,999-unit coordinate would
already have lost precision by the time it reached a transform. Subtracting the
tile origin while the numbers are still `f64` JSON is the only place the precision
rule can actually be enforced.

The cost is a `prepare_scene` per tile rather than per scene, cached by
`(tile, revision)`. A static scene prepares each tile once and then renders nothing
at all. A per-pass uniform offset would avoid the re-prepare entirely and is the
obvious optimisation, but it needs the core's shaders to accept an `f64`-derived
origin, which is a shader-contract change.

## Ports

The engine defaults to **4400**, and its local-discovery range is 4400–4403. That
avoids the ports already in use by a full local GrapiX run, so everything can be
started together:

| Port | Service |
| --- | --- |
| 4100 | `services/api-server` |
| 4200 | `services/render-daemon` (protocol v2) |
| 4300 | `Playout/services/playout-control` |
| **4400–4403** | **render engine, and additional render nodes** |
| 5173 / 5174 | editor web / playout web |

A test in `packages/render-protocol` asserts the range stays clear of the others.

## Configuration

`engine.toml`, with this precedence:

> **CLI argument > environment variable > TOML file > built-in default**

Confirm what a deployment actually produced — no GPU required:

```bash
grapix-render-engine --config engine.toml --print-config
```

Every key is optional and takes a documented default. See `engine.toml` for the
annotated reference and deployment examples.

An unknown CLI flag is a hard error, so a typo in a deployment script cannot
silently start an engine with the wrong port.

## Security

For remote deployment (`src/security.rs`):

- Bearer auth tokens, compared in constant time.
- TLS-ready transport. TLS is terminated at a reverse proxy today.
- Project-scoped permissions and a client allowlist.
- **File-path restriction.** A remote client supplies a *relative*,
  traversal-free path resolved inside a configured root — re-checked after
  canonicalisation, because a symlink defeats any amount of string analysis.
- Message and upload size limits, and token-bucket rate limiting.
- An append-only audit log recording every state-changing command and every
  operator override of a safety gate.

Two rules nothing may weaken: a remote client can never name an arbitrary
filesystem path, and can never cause arbitrary shader or OS code to execute.

**A non-loopback bind with no configured token refuses to start.** Silently
exposing an unauthenticated renderer to a venue network is the one mistake no
default may permit.

## Honesty rules

These are load-bearing, not stylistic. An operator has to be able to trust what
the engine reports at air time.

- An output adapter without its SDK reports `available: false` with a reason. It
  never accepts frames and discards them.
- `hardware_certified` is never set from a compile-time feature flag. Compiling the
  NDI SDK in is not the same as having run it against a device. Only the null and
  recording adapters are certified.
- Surface warp, edge blending, and bezel compensation are carried in the data model
  and reported as `CALIBRATION_NOT_IMPLEMENTED`. The renderer does not pretend to
  apply them.
- Only the cut transition is implemented. Anything else is refused rather than
  silently substituted with a cut.
- Video formats are reported as an empty list because there is no native decode.
  Declaring formats we cannot decode would make the Editor's pre-publish check
  useless.

## Commands

```bash
# From the repository root
npm run check:engine     # cargo check --all-targets
npm run test:engine      # cargo test
npm run dev:engine       # cargo run -- --config services/render-engine/engine.toml

# Directly
cargo test   --manifest-path services/render-engine/Cargo.toml
cargo build  --manifest-path services/render-engine/Cargo.toml --release
cargo build  --manifest-path services/render-engine/Cargo.toml --features ndi

# The existing daemon must stay green; the engine depends on it.
cargo test --manifest-path services/render-daemon/Cargo.toml
```

## Test coverage

| File | Tests | Covers |
| --- | --- | --- |
| `tests/stage_precision.rs` | 20 | 50,000² canvas, `f32` rebasing, origin anchors, the arena stage, capability validation, exact rational frame rates |
| `tests/tile_system.rs` | 27 | grid partition, edge clipping, culling, dirty tracking, overscan growth, LRU eviction, output pinning, seam-free composite over 625 tiles |
| `tests/config_and_security.rs` | 39 | precedence chain, clamping, remote-bind refusal, path restriction, rate limiting, dedupe, sequence ordering, audit log |

## Status

The engine listens, renders, and serves both applications.

Implemented and tested: virtual canvas, tile system, configuration, capability
reporting, security primitives, the protocol v3 WebSocket server, stage and scene
loading, preparation gating, the full playout verb set, JPEG previews with a pixel
budget, status and diagnostics, tile rendering over the reused core pipeline, and
CPU compositing.

Verified live on an NVIDIA RTX 3070 Ti (Vulkan, max texture 32768):

```bash
npm run dev:engine              # then, in another shell:
npm run certify:engine          # 27/27 — real TS client against this engine
npm run certify:playout-engine  # 18/18 — publish/prepare/cue/take via Playout HTTP
```

Not implemented, and **refused with an explicit error code** rather than
acknowledged and ignored — see
[`docs/render-engine-migration.md`](../../docs/render-engine-migration.md):

| Message | Refusal |
| --- | --- |
| `asset.*` | `CAPABILITY_UNSUPPORTED` — put assets under a configured asset root |
| `scene.applyPatch` | `RESYNC_REQUIRED` — use `scene.fullSync` |
| `preview.streamStart` / `streamStop` / `setViewport` | `CAPABILITY_UNSUPPORTED` — use `preview.request` |
| `engine.restartRenderer` | `CAPABILITY_UNSUPPORTED` — restart the process |

Also outstanding: the IPC transport (WebSocket works today), browser-versus-native
pixel comparison, and phase L — NDI/DeckLink/AJA, interlaced output, warp and
edge-blend maths, and distributed orchestration.
