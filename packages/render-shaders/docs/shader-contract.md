# GrapiX Shader Contract v1

This package is the single source of truth for everything that must be
pixel-identical between the two GrapiX renderers:

- `services/render-daemon` — Rust + `wgpu`, produces broadcast output frames.
- The browser WebGPU preview (future) — described in `docs/rendering-engine.md`.

The reason this package exists: if the editor preview and the on-air output are
implemented as two independent renderers that merely read the same scene JSON,
they will drift visually. Sharing the shader source, uniform byte layouts,
blend definitions, and transform math removes the largest sources of drift.

## What is shared

1. **`SceneDocument` JSON** — defined in `@grapix/shared-types`; this package
   does not redefine it and no second scene format may be introduced.
2. **WGSL shader source** — `wgsl/*.wgsl`, consumed verbatim by both renderers.
3. **Uniform byte layouts** — `layouts.json` is machine-readable; the Rust
   daemon has a unit test asserting its `#[repr(C)]` structs match these sizes
   and offsets exactly. The browser renderer must add the equivalent check
   (e.g. asserting its `ArrayBuffer` writer offsets against `layouts.json`).
4. **Blend-mode definitions** — ids and equations in `layouts.json`.
5. **Colour-space and alpha handling** — rules below.
6. **Transform and coordinate math** — formulas below.

## Coordinate system

- Scene space is the editor's space: origin at the **top-left** of the canvas,
  x right, y **down**, units are scene pixels (`SceneDocument.canvas`).
- Scene space maps to WebGPU clip space with:

  ```
  clip_x = 2 * scene_x / canvas_width  - 1
  clip_y = 1 - 2 * scene_y / canvas_height
  ```

  As a column-major mat4 (columns listed left to right):

  ```
  [ 2/w   0    0   0 ]   column 0
  [ 0    -2/h  0   0 ]   column 1
  [ 0     0    1   0 ]   column 2
  [ -1    1    0   1 ]   column 3
  ```

- The projection uses the **scene canvas** dimensions, not the output
  resolution. The viewport is the full render target, so a 1920x1080 scene
  rendered to a 1280x720 target scales automatically.

## Object transform

For every quad (object) the model transform is composed CPU-side and uploaded
as one `mat4x4<f32>`:

```
transform = projection * translate(x, y) * rotate_z(radians(rotation)) * scale(width, height)
```

- Matrices are **column-major** and multiply **column vectors** (`M * v`),
  matching WGSL, glam (Rust), and gl-matrix/wgpu-matrix (JS) defaults.
- `rotation` is stored in **degrees** in `SceneDocument` and converted to
  radians. With y-down coordinates a positive angle appears clockwise
  on screen — this matches the editor (PixiJS).
- Rotation pivots on the object's **top-left corner** (its `x, y` position),
  because the editor uses PixiJS's default pivot. If the editor ever moves to
  center pivots, both renderers and this document change together.
- The shader consumes a unit quad in `[0,1]^2`; `scale(width, height)` sizes it.

## Colour pipeline

- Scene colors are CSS hex strings (`#rgb`, `#rrggbb`, `#rrggbbaa`) in sRGB.
- CPU side per color: decode hex → sRGB floats → **linear-light** floats
  (IEC 61966-2-1 formula) → multiply RGB by final alpha (**premultiply**).
  Final alpha = hex alpha × object `opacity`.
- Shaders work entirely in linear light.
- Render targets use an `-srgb` texture format (`bgra8unorm-srgb`), so the
  hardware re-encodes linear → sRGB bytes on store. Readback bytes are
  therefore sRGB-encoded BGRA, suitable for BGRA video output.
- Colour space of record is sRGB in v1. Rec.709 transfer/matrix handling for
  broadcast pipelines is future work and must be added to this contract first.

## Alpha and blending

- Everything is **premultiplied** from uniform upload onward.
- Six blend modes are implemented as fixed-function GPU blending, using
  Adobe's standard blend-mode math where it is expressible without a shader
  compositing pass. Both renderers mirror PixiJS's premultiplied blend
  equations so preview and program match. The `layouts.json` `blendModes`
  table is the authoritative per-mode contract; the daemon builds one cached
  pipeline per id and the editor maps the id to the equivalent PixiJS mode.

  | id | name | colour | alpha |
  | --- | --- | --- | --- |
  | 0 | normal | `src·ONE + dst·(1−srcA)` | `src·ONE + dst·(1−srcA)` |
  | 1 | multiply | `src·dst + dst·(1−srcA)` | `src·ONE + dst·(1−srcA)` |
  | 2 | screen | `src·ONE + dst·(1−src)` | `src·ONE + dst·(1−srcA)` |
  | 3 | add | `src·ONE + dst·ONE` | `src·ONE + dst·ONE` |
  | 4 | darken | `MIN(src, dst)` | `MIN(src, dst)` |
  | 5 | lighten | `MAX(src, dst)` | `MAX(src, dst)` |

  Source colour is already premultiplied. darken/lighten use the GPU Min/Max
  blend operations (the hardware ignores the factors for Min/Max), matching
  PixiJS's "min"/"max" modes. Exact Adobe *separable* darken/lighten over
  partial transparency, and overlay/subtract/soft-light etc., require a shader
  compositing pass and are **not implemented** — renderers refuse any blend
  mode outside this table with a warning rather than approximating it. There
  is no silent fallback to normal.
- The editor mapping: normal→normal, add→add, multiply→multiply,
  screen→screen, darken→min, lighten→max (PixiJS blend-mode names).
- The frame is cleared to transparent black `(0,0,0,0)`; the scene canvas
  background is drawn as an ordinary full-canvas quad, matching the editor
  (which also draws the background as scene content).

## Uniform layout rules

- WGSL uniform structs follow WGSL alignment rules; to keep the Rust
  `#[repr(C)]` mirror trivially compatible:
  - use only `mat4x4<f32>` and `vec4<f32>` fields (no `vec3`, which has
    padding pitfalls),
  - keep struct size a multiple of 16 bytes,
  - add explicit reserved fields instead of relying on implicit padding.
- `layouts.json` records size and per-field offsets. Both renderers must
  validate against it in tests. The Rust check lives at
  `services/render-daemon/tests/layout_contract.rs`.
- Dynamic-offset uniform binding is an implementation detail of each renderer
  (the daemon rounds the stride up to the device's
  `min_uniform_buffer_offset_alignment`); the *contents* of each 96-byte slot
  are what this contract fixes.

## Render order

Objects sort by `layerId`, then `zDepth`, then `zIndex` — the same rule as
`apps/editor-web/src/rendering/sceneMaterial.ts`.

Known deviation: the editor compares `layerId` with JavaScript
`localeCompare`; the daemon uses plain byte-order comparison. These agree for
the ASCII ids GrapiX generates. If layer ids ever carry non-ASCII text, the
editor should switch to a byte-order comparison so both sides match.

## How each side consumes this package

- **Rust daemon**: `include_str!("../../../packages/render-shaders/wgsl/composite_quad.wgsl")`
  — the shader is compiled into the binary; `layouts.json` is read by tests.
- **Browser (future)**: import the WGSL with Vite raw imports, e.g.
  `import compositeQuad from "@grapix/render-shaders/wgsl/composite_quad.wgsl?raw"`,
  and validate buffer-writer offsets against
  `@grapix/render-shaders/layouts.json` in a unit test.

## Changing the contract

Any change to a `.wgsl` file, `layouts.json`, or the rules in this document is
a contract change: update the Rust structs + tests in the daemon and the
browser writer in the same commit, and bump `contractVersion` in
`layouts.json` when the byte layout changes.
