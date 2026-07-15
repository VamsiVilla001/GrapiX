# Render Daemon Architecture

Status: scaffold landed 2026-07-15. This document explains the architecture
decisions behind `services/render-daemon` and the shared-shader strategy in
`packages/render-shaders`.

## Where it fits

```text
Web Editor (React, PixiJS preview today / WebGPU preview later)
        -> Shared Scene / Timeline / Binding Model  (packages/shared-types)
        -> Local WebSocket (protocol v1, full SceneDocument replacement)
        -> Rust Render Daemon (wgpu, headless)      (services/render-daemon)
        -> VideoOutput trait -> NDI | null          (feature-gated backend)
```

The daemon is the first concrete step toward the native renderer in
`docs/architecture.md`. It is optional during this phase: nothing in the
editor, Electron shell, or API server depends on it running.

## The shared-shader decision

**Problem**: if the browser preview and the broadcast renderer are two
independent implementations that merely read the same JSON, they drift —
different blending, different color math, different rounding of transforms.
"Preview doesn't match program" is a chronic failure mode of this product
category.

**Decision**: one shader layer, two hosts. `packages/render-shaders` owns:

1. the WGSL source (consumed verbatim by wgpu today and browser WebGPU later),
2. uniform byte layouts (`layouts.json`, machine-readable),
3. blend-mode ids and equations,
4. colour-space and alpha rules (sRGB hex -> linear-light, premultiplied),
5. the transform composition formulas (projection, top-left rotation pivot).

Enforcement is by test, not convention: the daemon's
`tests/layout_contract.rs` asserts its `#[repr(C)]` uniform structs match
`layouts.json` byte for byte, and the browser renderer must run the
equivalent assertion against the same file when it lands. WGSL was chosen as
the shared language because wgpu consumes it natively on the Rust side and it
is *the* shader language of browser WebGPU — no transpilation step to drift.

Known accepted deviation (documented in the contract): `layerId` ordering
uses byte-wise comparison in Rust vs `localeCompare` in today's editor;
identical for the ASCII ids GrapiX generates.

## Scene-type alignment (TypeScript <-> Rust)

The repository has no JSON Schema for `SceneDocument` and no schema
generation from TypeScript, so options 1 and 2 (generate Rust from schema /
schema from TS) are unavailable without new tooling. The scaffold implements
**option 3: a versioned Rust DTO layer with contract tests and fixtures**:

- `packages/shared-types/src/fixtures.ts` — fixture object, compile-time
  checked against the real `SceneDocument` type (the TS side of the contract).
- `npm run fixtures:emit -w @grapix/shared-types` — serializes it to
  `packages/shared-types/fixtures/scene-document.v1.json` (committed).
- `services/render-daemon/tests/scene_contract.rs` — parses that JSON with the
  daemon's serde DTOs (the Rust side of the contract).

Drift path: a `SceneDocument` change breaks the fixture's compile or, after
re-emitting, breaks the Rust test — never silently misreads scenes at
runtime. Typed Rust DTOs cover the material, instance, and primitive binding
fields consumed by the v1 solid-rectangle renderer. `serde_json::Value` remains
at extension boundaries such as parameter maps and document sections the v1
renderer does not consume (timeline details and asset payload metadata).

If the scene model grows significantly, revisit generating a JSON Schema from
the TypeScript source and deriving the Rust types from it.

## Protocol

Versioned JSON over an authenticated local WebSocket; daemon is the server (it
is the long-lived process; controllers reconnect). A per-install 256-bit token
is generated in the ignored `data/` directory and shared automatically with
the API bridge. Browser Origins are denied unless explicitly allowlisted. v1 uses **full-scene
replacement** on `scene.load`/`scene.update` — the repo defines no renderer
patch format, and inventing one before the sequencer exists would be
speculation. `RendererPatch` in shared-types is the obvious candidate for a
future `scene.patch` message.

## Broadcast formats

Output configuration is explicit: width, height, rational frame rate
(numerator/denominator — 59.94 is `60000/1001`, never a float), scan mode,
alpha mode, colour format, colour space, NDI source name. v1 renders
progressive/premultiplied/bgra8/sRGB only; everything else is **validated and
rejected with explicit errors**, not coerced. The render loop's frame clock
uses integer math on rational rates from 1 through 240 fps so fractional rates
never drift. Its wait is interruptible, so stop and shutdown do not wait out a
frame interval.

## Performance shape (v1)

- Render thread paced by the frame clock; scene updates arrive via a `watch`
  channel and are picked up at the next frame — WebSocket frequency never
  paces rendering.
- Bounded 2-slot channel to the output thread = double buffering; output
  stalls drop frames (counted in status) rather than blocking the clock.
- GPU readback is synchronous on the render thread by design at this stage;
  moving to a ring of staging buffers with async mapping is the known next
  step if readback becomes the bottleneck.
- Genlock/reference sync is out of scope for the scaffold and tracked as
  future work.

## Future work: MCP / Figma / Adobe (LAST priority)

Deliberately not implemented now; recorded so the order is agreed:

1. **GrapiX exposes its own MCP server** so external AI agents (Claude, Codex,
   etc.) can operate the editor: create scene objects, import assets, bind
   data paths. This is the prerequisite for everything below.
2. **GrapiX consumes Figma's official Dev Mode MCP server** for design
   inspection and import (layer trees, tokens, layout into the Object
   Library).
3. **GrapiX may consume Adobe Firefly Services MCP** (Firefly / Photoshop /
   Lightroom APIs) for asset generation and editing.
4. **Imported assets are normal GrapiX assets**: whatever an agent imports or
   generates must land in the Asset Library and flow through the same
   material and render pipeline as hand-imported media — no side channel to
   the renderer.

These are last in line behind: text/image/video rendering in the daemon,
the browser WebGPU preview consuming `packages/render-shaders`, timeline
playback, and NDI validation on an SDK machine.
