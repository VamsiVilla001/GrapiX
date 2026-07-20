# Material and render-asset architecture

GrapiX has one material system shared by scene editing, browser preview, scene
serialization, and the Rust render daemon. It is a general broadcast workflow
inspired by common production practices; it contains no proprietary interface,
assets, or code.

## Ownership and modules

- `packages/shared-types` owns serializable asset, shader, material, material
  instance, binding, validation, usage, migration, and resolution types.
- `packages/render-shaders` owns WGSL and the byte/blend contract. A browser or
  Rust host must consume these files; it must not maintain a second shader copy.
- `services/api-server` owns imported binary storage and metadata sidecars.
- `apps/editor-web/src/modules/material-manager` owns library UI state,
  importing, the dock panel, preview, inspector, and shader registry.
- `apps/editor-web/src/rendering` resolves a document into preview objects and
  reuses the existing Pixi GPU renderer and texture cache.
- `services/render-daemon` consumes the same scene bindings and shared WGSL.

The old `AssetMaterialPanel` is only a compatibility wrapper around the central
manager. It is not a separate asset database.

## Scene document model and migration

`SceneDocument.assets`, `materials`, `materialInstances`, `shaders`, and
`materialFolders` contain metadata only. Primitive slots contain either the
legacy material ID string or a `PrimitiveMaterialBinding`:

```json
{
  "materialId": "mat_team",
  "instanceId": "matinst_away",
  "overrides": { "opacity": 0.8 }
}
```

Material definitions remain separate from primitives, so editing one material
updates every primitive that references its ID. `normalizeMaterialSceneDocument`
is the v1 migration boundary. It accepts old scenes with string slot bindings
and minimal material fields, then supplies new defaults without changing stable
IDs. The serialized format stays at version 1 because all new root fields are
optional and backwards compatible; a breaking future shape must increment the
version and add an explicit migration.

Large binaries are never stored in scene JSON. Imported assets use a stable ID
derived from SHA-256 content, a project-relative source path, and a content URL.
The API stores files under `data/assets/<kind>/` and rebuildable metadata under
`data/assets/index/`. Generated thumbnails and proxies are extension points and
must be treated as disposable cache data.

## Material resolution

One inheritance level is supported. Resolution order is:

1. shader parameter default;
2. base material parameter or texture slot;
3. material-instance override;
4. primitive binding override.

An instance stores only its override maps and base ID. It never copies the full
base material. An instance whose base does not match its binding produces a
warning and uses the valid base state.

For future dynamic controls, the intended control priority from lowest to
highest is: stored manual value, scene-template value, data source/API value,
timeline animation, Visual Logic/script transaction. A primitive binding
override is part of the stored manual layer. This first version does not yet
route material parameters through the existing timeline or Visual Logic; it
only marks manifest parameters as `animatable` and `bindable` so that integration
can use the existing property system rather than inventing another animator.

## Assignment workflow

Materials can be selected and dragged onto compatible primitives in the canvas
or Scene Manager. The target is cyan when compatible and red with a blocked
drop effect when incompatible. Dropping commits one history entry. The object
inspector filters its material list by primitive compatibility. A material's
context menu also offers **Assign to Selected**. The store accepts a list of
object IDs so an existing or future multi-object selection can use the same
single undoable operation.

Rectangle and image primitives support the first-version `main` slot. The
schema is a named map, so text Face/Outline/Shadow slots and imported model slot
names can be added without a schema replacement. Model slot preservation and a
multi-slot inspector remain future work.

## Asset importing and relinking

The first importer validates PNG, JPEG, WebP, SVG, browser-decodable TIFF, and
WGSL. Image dimensions and a sampled alpha-presence estimate are recorded.
Content hashing provides duplicate detection. Upload and image inspection are
asynchronous, but thumbnail/proxy worker generation is not implemented yet.

At scene load, managed asset IDs are checked against API storage. A missing
source keeps its ID, metadata, material, and primitive binding; it receives a
visible `MISSING` state. **Relink Asset** never guesses a replacement. The scene
ID stays stable while a content-hash storage ID points at the newly imported
bytes; this preserves the previous binary so undo can restore the old
metadata/source. Deletion is refused while usage exists.

Folder import skips unsupported entries and reports the actionable validation
message. Video, image-sequence, font, live input, browser/HTML source, render
texture, nested scene, model, procedural texture, and capture inputs appear as
disabled prepared categories rather than controls that pretend to work.

## Shared WGSL and shader manifests

`packages/render-shaders/manifests/shader-manifest.json` describes the built-in
solid-colour and textured-unlit shaders. The editor validates IDs, entry points,
supported primitives, duplicate slots/parameters, source size, entry-point
presence, and balanced braces before exposing a shader. Imported WGSL is stored
outside the scene and an invalid reload remains inactive, preserving the last
valid material state.

Structural validation is not a GPU compiler or sandbox. Production custom
shader execution is therefore disabled in this version. The planned compiler
worker must impose at least the current 256 KiB source limit, compilation time
and binding-count limits, isolate compilation failures, disallow host filesystem
access, and retain the last valid pipeline. Development file watching and live
line/column diagnostics are not yet implemented.

To add a shader:

1. add one WGSL source under `packages/render-shaders/wgsl`;
2. add its manifest entry and uniform layout contract;
3. register the shared source path in `shaderRegistry.ts`;
4. implement or reuse one host pipeline in both browser WebGPU and Rust wgpu;
5. add manifest, uniform-layout, and failure tests before marking it supported.

## Alpha and colour rules

Image import records detected alpha separately from user interpretation. The
supported interpretations are opaque, straight, and premultiplied. The host
converts straight sRGB samples to linear light and premultiplies RGB by alpha
before composition. Premultiplied sources must not be multiplied twice. Opaque
forces alpha to one. Alpha-test and alpha-mask are represented in the schema but
disabled until both renderers implement the same threshold/mask behavior.

The Rust solid-colour path converts CSS sRGB hex to linear, multiplies by final
opacity, and uploads premultiplied RGBA. The sRGB render target encodes the
result for BGRA readback and NDI. The current browser Pixi path relies on its
texture upload conversion for images and applies material opacity/tint before
composition; the shared textured WGSL defines the authoritative future WebGPU
path. Rec.709 transfer/matrix conversion for NDI image/video textures is not
implemented and must be added to the shared shader contract first.

## Blend modes

Six blend modes are supported by both active hosts (editor preview + render
daemon), implemented as fixed-function GPU blending using Adobe's standard
blend-mode math where it is expressible without a shader compositing pass:
**Normal, Additive (Linear Dodge), Multiply, Screen, Darken, Lighten**. The
exact per-mode colour/alpha equations are the contract in
`packages/render-shaders/layouts.json`; both renderers mirror PixiJS's
premultiplied blend equations so preview and program output match.

- `IMPLEMENTED_BLEND_MODES` in `@grapix/shared-types` is the single source of
  truth for the supported set. The Material Inspector dropdown, the editor's
  render guard, and the resolver's warning check all read from it, so the menu
  can never advertise a mode the renderers do not support.
- The daemon builds one cached fixed-function pipeline per blend id and
  selects by id at draw time (`blend_state_for_id`).
- Darken/Lighten use the GPU Min/Max blend operations, matching PixiJS's
  min/max modes.

Overlay, subtract, alpha mask, and inverse alpha mask remain reserved (they
need a shader compositing pass — overlay in particular is *not* aliased to
screen the way some engines do). The inspector never lists them. If one
arrives from a scene file, both renderers refuse that draw and report a
warning rather than silently falling back to Normal.

> Note on "Adobe's API": Adobe's blend modes are published *math formulas*
> (the PDF/ISO-32000 separable blend functions), not a network service. They
> are implemented natively here in both GPU renderers. Adobe's actual APIs
> (Firefly Services) are for asset generation/editing and remain deferred per
> `docs/render-daemon-architecture.md` — a per-frame network call could never
> meet real-time broadcast timing.

## Renderer and resource lifecycle

The browser resolves bindings before drawing and caches image/video textures by
source. Video elements are also shared by source, so one asset is not decoded
per primitive. Opacity, tint, and the six shared blend modes (normal, add,
multiply, screen, darken, lighten) are applied to rectangles and images.
Preview uses this real scene pipeline on a quad over selectable
checker/light/dark backgrounds.

**Texture coordinates** (the XPression-style panel): UV offset, UV scale, and
UV rotation transform the texture, and the address mode (clamp / repeat /
mirror-repeat) plus filtering (linear / nearest) are real GPU sampler settings.
When a material has a non-identity UV transform the texture is drawn through a
Pixi `TilingSprite` (the primitive designed for UV transforms and wrap); the
default identity case keeps the plain sprite path with its fit-mode sizing, so
existing image rendering is unchanged. UV scale > 1 tiles the texture that many
times across the quad; the address mode controls how the extra copies wrap.
Verified in-app: UV scale 3 + repeat wrap renders an exact 3x3 tile grid, and
UV rotation rotates the tiled pattern. Sampler settings are per-asset in the
editor today (the texture source is shared by URL); true per-material samplers
need a WebGPU bind group and are tracked with the daemon texture work. `tile`
and `nine-slice` fit modes remain unimplemented and are refused with a warning.

The Rust daemon resolves base material, instance, primitive overrides, opacity,
alpha interpretation, and all six shared blend modes for solid rectangles. It
builds one cached fixed-function pipeline per blend id once and switches by the
shared blend ID. It
explicitly warns and skips textured materials because daemon-side image decode,
GPU texture upload, and the shared textured bind group are not implemented yet.

Future pipeline cache keys are shader ID, blend/alpha mode, topology, depth,
cull, texture format, and sample count. Texture caches need reference counts or
equivalent ownership and deferred GPU disposal. Current Pixi and daemon
pipelines already avoid per-frame compilation.

## Adding material and asset support

To add a material type, extend the shared enum and compatibility/default
functions, add a validated shader manifest, expose only relevant parameters,
implement both renderer hosts, and add serialization/resolution/render tests.
Do not enable the type before both active hosts can render it or show an
explicit host limitation.

To add an asset loader, extend descriptor validation, extract metadata in a
worker/background service, persist bytes through the API asset store, generate
rebuildable thumbnails/proxies, define missing/relink behavior, then implement
one shared decode/cache lifecycle. Media playback controls must share a decoder
per asset and synchronize against scene time.

## First-version limitations and roadmap

Implemented: image and WGSL import/storage, reusable solid and textured
materials, duplication/protected deletion, one-level instances, shared updates,
opacity/tint, six shared blend modes (normal/add/multiply/screen/darken/lighten),
texture coordinates (UV offset/scale/rotation, clamp/repeat/mirror wrap,
linear/nearest filtering via a TilingSprite path), real browser preview, rectangle
and image assignment, missing warnings/relink, usage lookup, scene save/load
migration, undo/redo grouping, shared manifests/WGSL, and Rust solid-material
compatibility.

Not implemented: daemon texture decode/rendering, per-material samplers (a
WebGPU bind group; sampler settings are per-asset in the editor today),
tile/nine-slice fit modes, WebGPU-native browser material
pipelines, shader execution/editor/hot reload, video and sequence playback,
thumbnail workers/proxies, folder mutation, material export, copy/paste, full
primitive multi-selection UI, model slot import, PBR/chroma/mask/gradient
pipelines, parameter animation/data binding, nine-slice, live inputs, fonts,
GPU-memory estimates, and cache reference-count disposal. Their schema/UI
extension points are visible but disabled or explicitly labelled.

The sample scene is `samples/material-manager-v1.scene.json`.
