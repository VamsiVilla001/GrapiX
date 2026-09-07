# GrapiX Middle-Layer Architecture

Status: **accepted direction**, not yet implemented.
Supersedes the "RTG clone" direction in [architecture.md](architecture.md) and the renderer plan in
[rendering-engine.md](rendering-engine.md). Everything in this document is the contract the rest of
the build hangs off; disagreements with older docs resolve in favour of this one.

---

## 1. Positioning

GrapiX is **not** a design tool. It is the layer between a finished design and live air.

```text
Figma / PSD / AI / Rive          <- artwork is authored elsewhere
        -> Ingest                <- faithful import, stable node identity
        -> DesignIR              <- immutable "as designed" tree
        -> Rig                   <- timeline, broadcast objects, states  (GrapiX owns this)
        -> Bind                  <- schema, live data, preflight
        -> Compile               <- versioned ScenePackage
        -> Render + Playout      <- GrapiX owns the renderer and the output
        -> NDI / SDI / HTML / Preview
```

The wedge is **design-to-air turnaround and live data reliability**, not drawing tools. We do not
compete on canvas ergonomics with Figma, and we do not compete on operator muscle memory with
XPression or Viz. We compete on: import fidelity, surviving design changes, binding correctness,
and a renderer an operator will trust on a live show.

### Decisions already taken

- **GrapiX owns the playout renderer.** We are not a plugin that compiles into someone else's
  playout engine. This is the expensive path and it is deliberate: the renderer is the product.
- **Figma is the priority ingest path**, but PSD, Illustrator and Rive are all in scope. Figma is
  first because it has stable node IDs, which is the good case to design the identity model against.

---

## 2. Non-goals

Explicitly out of scope for this architecture. Adding any of these needs a new decision, not an
incremental commit.

- Creating original artwork in GrapiX. No shape tools, no pen tool, no typography design.
- A 3D scene graph. No meshes, lights or cameras until an ingest source actually produces them.
- Auth, cloud sync, multi-tenant hosting, distributed render nodes.
- An LLM anywhere on the frame-accurate playout path (see section 11).

---

## 3. Three models, not one

The current `SceneDocument` in `packages/shared-types/src/index.ts` does three incompatible jobs at
once: it is the import result, the editor's mutable rig state, and the renderer's input. That is why
it cannot absorb a real Figma import. Split it.

| Model | Mutability | Owner | Purpose |
|---|---|---|---|
| `DesignIR` | immutable, replaced only by re-import | Ingest | Faithful "as designed" tree from a source file |
| `SceneRig` | mutable, authored in GrapiX | Editor | Timeline, bindings, broadcast objects, states - references DesignIR by ID |
| `ScenePackage` | immutable, built | Compiler | Flattened, renderer-facing, versioned, no editor or import concepts |

The separation is what makes re-import survivable (section 5.3) and lets the renderer stay dumb and
fast (section 8). It is the single most important structural decision in this document.

### 3.1 DesignIR

Source-agnostic but lossless-enough. Driven by the *union* of what Figma/PSD/AI/Rive express - not
by Figma's model alone.

```ts
interface DesignIR {
  designId: string;
  source: DesignSource;            // figma | psd | ai | rive | svg
  sourceRevision: string;          // Figma version id, PSD file hash, etc.
  importedAt: string;
  importerVersion: string;         // for reproducible re-import
  root: DesignNode;
  assets: DesignAsset[];           // rasters, fonts, embedded media
  fonts: FontRequirement[];        // family, weight, style, glyph coverage needed
  warnings: ImportWarning[];       // unsupported features, downgrades, approximations
}

interface DesignNode {
  nodeId: string;                  // GrapiX-stable; see section 5.3
  sourceNodeId?: string;           // native id when the source has one (Figma)
  sourcePath: string;              // human-readable layer path, for the re-link UI
  name: string;
  kind: DesignNodeKind;
  transform: Matrix2D;             // full affine, not x/y/rotation
  size: Size;
  clipsContent: boolean;
  blendMode: BlendMode;
  opacity: number;
  visible: boolean;
  masks?: MaskRef[];
  effects: Effect[];               // shadow, inner shadow, layer blur, background blur
  fills: Paint[];                  // solid | linear | radial | angular | diamond | image | video
  strokes: Stroke[];               // per-stroke weight, align, cap, join, dash
  geometry?: VectorGeometry;       // path data, fill rule, corner radii/smoothing
  text?: TextContent;              // run list + layout, see below
  tokens: DesignToken[];           // parsed from the layer name; see section 5.4
  children: DesignNode[];
}
```

Notes that are load-bearing:

- **Transform is a matrix.** The current model's `x/y/rotation/width/height` cannot represent a
  skewed or non-uniformly-scaled Figma group. Do not flatten to scalars.
- **`fills` and `strokes` are arrays of paints, not a `fill: string`.** Multi-fill and multi-stroke
  are ordinary in real broadcast art.
- **`text` is a run list**, not a string: `{ runs: TextRun[]; layout: TextLayout }`, where a run
  carries family/weight/size/tracking/case/colour/baseline-shift. Per-character styling appears in
  practically every scorebug.
- **`warnings` is not optional.** Every approximation the importer makes must be reportable in the
  UI. Silent fidelity loss is how operators stop trusting the tool.

### 3.2 SceneRig

Everything GrapiX authors. It never contains geometry - only references and additions.

```ts
interface SceneRig {
  sceneId: string;
  name: string;
  numericId: string;               // padded operator-facing id, e.g. "001"
  videoProfile: VideoProfile;      // width, height, fps, scan mode, timebase
  designRef: { designId: string; sourceRevision: string };

  overrides: Record<NodeId, NodeOverride>;   // rig-time property changes on imported nodes
  broadcastObjects: BroadcastObject[];       // section 4.2 - objects no design tool can express
  timeline: Timeline;                        // section 6
  states: SceneState[];                      // in / out / update / idle variants
  schema: DataSchema;                        // section 7
  bindings: Binding[];                       // section 7
  orphans: OrphanRecord[];                   // rig entries whose node vanished on re-import
}
```

`orphans` is deliberately part of the persisted model. A re-import that cannot resolve a node must
degrade to a repairable state, never to data loss.

### 3.3 ScenePackage

The compiler output and the only thing the renderer ever sees. Flattened draw list, resolved
z-order, resolved fonts, resolved media, precomputed animation curves. No names, no layer paths, no
editor metadata beyond what preflight and diagnostics need.

Rules:

- Deterministic: the same `(DesignIR, SceneRig, compilerVersion)` always produces a byte-identical
  package.
- Self-contained: every asset either embedded or content-addressed with a resolvable locator.
- Versioned: `packageFormatVersion` gates renderer compatibility explicitly.
- Frame-resolvable in constant time, with **no allocation on the per-frame path**.

`.gfxpkg` remains the on-disk container. Its current contents
(`manifest` / `scene` / `materials` / `bindings` / `timeline` plus assets) survive; `scene.json`
becomes the compiled draw list rather than the editor document.

---

## 4. Primitives

The premise "we import designs so we don't need primitives" is wrong, and correcting it is the point
of this section. **Authoring tools go away; primitives grow.** We now have to *receive* arbitrary
third-party artwork, which is a larger and messier vocabulary than one we would design ourselves -
plus a set of broadcast objects no design tool has any concept of.

### 4.1 Imported primitives (from DesignIR)

Frame/group, vector path, rectangle-with-corner-smoothing, ellipse, line/polyline, text (run list),
image, boolean group, mask group. Each carries the full paint/stroke/effect/blend vocabulary in
section 3.1.

### 4.2 Broadcast primitives (GrapiX-authored, no design-tool equivalent)

These are the reason GrapiX exists. None of them can come out of Figma.

| Object | Why it must be native |
|---|---|
| **Auto-fit text** | Shrink-to-fit, condense-to-fit, scroll-on-overflow. The single most-used behaviour in broadcast, and unrepresentable in any design tool. |
| **Repeat container** | Renders *n* rows from an array: standings, results, tickers, leaderboards. Design gives you one row; data gives you 18. |
| **Media input** | Live source, clip, still sequence; fill+key pairs; loop/hold/cue behaviour. |
| **Conditional variant** | Home/away, sponsor rotation, language, tier. One design, many resolved forms. |
| **Clock / timer / counter** | Count up/down, game clock, time of day, freeze/resume, drift-corrected against the frame clock. |
| **Control null** | An empty transform parent used purely for rigging. Imported trees have no rig intent; you add it. |
| **Safe-area guide** | Title-safe / action-safe overlay. Editor-only, never rendered to air. |

### 4.3 What dies from the current model

- `SceneObjectType`'s `mesh`, `light` and `camera` members and their placeholder rendering - no
  ingest source produces them. Re-add when one does.
- The `SceneProperty` string-union enum. Animatable and bindable properties become typed paths
  against the node model, not a closed 12-value list.
- Object Library creation entries (`+ Quad`, `+ Sphere`, `+ Text`). The Object Library becomes a
  palette of **broadcast objects** from section 4.2 only.
- `BaseSceneObject`'s flat `fill` / `stroke` / `strokeWidth` / `x` / `y` / `rotation` scalars.
- SVG-generated template thumbnails. Thumbnails must come from the real renderer or they lie to
  operators about what will go to air.

### 4.4 What survives

- The dockable workspace shell. It is decent and orthogonal to this change.
- `services/api-server` as a service shape (Fastify, in-process from Electron, local `data/` store).
- The `.gfxpkg` publish concept and a CLI-able compile step.
- **Material readiness and publish preflight** (`MaterialReadinessState`, the preflight checks).
  This is genuinely good and rare: proving every asset resolves *before* Take is a real broadcast
  feature most tools do badly. Keep the concept, re-home it onto the compiler and the take engine.

---

## 5. Ingest

### 5.1 Sources and priority

1. **Figma - via plugin, not the REST API.** The plugin gets vector networks, real text metrics,
   `exportAsync`, and - critically - a place for designers to author binding tokens in context. The
   REST API loses geometry fidelity and text layout and fights fills, masks, effects and font
   fallback. REST arrives later as the headless/automation path, sharing the same DesignIR target.
2. **PSD.** Layered parse (`ag-psd` class of library). Expect pain in the text engine data and layer
   effects; expect raster, not vector.
3. **Illustrator.** PDF-backed; normalise via its vector content, not via a flat SVG export.
4. **Rive.** Ingest `.riv` as one *source format* only. Note `.riv` has no official writer - the
   format documentation targets readers - so this path is read-only and cannot round-trip. See
   section 8.3 for why Rive must not define our scene model.

SVG is a fallback front door, never the primary path: it flattens hierarchy, loses text as text, and
destroys node identity, which is the moat.

### 5.2 Importer contract

Every importer is a pure function `(sourceFile, options) -> { DesignIR, ImportWarning[] }`, runnable
headlessly and unit-testable against committed fixture files. Importers may never reach into
`SceneRig`. Fixtures: a real lower-third and a real scorebug, checked in, asserted per importer.

### 5.3 Node identity and re-import - the hard problem

This is the feature that decides whether the product lives. A designer *will* change the artwork
after the rig is built. If the rig and bindings do not survive that, every design tweak destroys a
day of work, and that is what kills tools in this category.

Identity strategy is **per source**, because the sources are uneven:

| Source | Primary key | Fallback |
|---|---|---|
| Figma | native node id (stable across edits) | name + tree path + geometry hash |
| PSD | layer path + name | content hash + bounds |
| Illustrator | name | ordinal position + bounds + content hash |
| Rive | component / artboard name | ordinal position |

Re-import is a **reconciliation**, never a replacement:

1. Import the new file into a fresh `DesignIR`.
2. Match new nodes to old `nodeId`s using the source's strategy, then fuzzy fallbacks.
3. Carry forward `overrides`, `bindings`, timeline tracks and `broadcastObjects` for matched nodes.
4. Report added, removed, moved and re-typed nodes as a **reviewable diff**, not a silent apply.
5. Unmatched rig entries become `orphans` - preserved, never dropped.
6. Provide a **manual re-link UI**. Auto-match will fail; without this screen a renamed layer group
   silently orphans hours of rigging. This screen is unglamorous and non-optional.

### 5.4 Binding tokens in the design file

The highest-leverage, lowest-cost feature in the whole product. Let designers declare intent in the
layer name so import becomes a contract instead of guesswork:

```text
Score Home {{home.score}}          -> bind text to home.score
Scorer Name {{scorer.name}} @fit   -> bind + auto-fit text
Standings Row @repeat(table.rows)  -> repeat container over an array
Sponsor #sponsor_slot              -> named slot for runtime asset injection
Sponsor Alt @variant(sponsor=alt)  -> conditional variant
Clock @clock(game)                 -> bind to the game clock source
```

Tokens parse into `DesignNode.tokens` at import and auto-generate `bindings` and `broadcastObjects`.
The LLM layer-mapper (section 11) becomes a **fallback for legacy artwork**, not the primary path.
An LLM guessing at `Rectangle 47 copy 3` is strictly worse than a designer typing `{{home.score}}`.

Token grammar lives in `packages/design-tokens` and is shared by the Figma plugin (for authoring
hints and validation) and every importer.

---

## 6. Rig and timeline

- **Frame-indexed, never wall-clock.** Time is an integer frame against the scene's `VideoProfile`
  timebase. No `requestAnimationFrame` deltas anywhere in evaluation.
- Tracks target typed property paths on DesignIR nodes or broadcast objects.
- Curve model: keyframes with bezier easing, plus hold. Per-property, not per-object.
- **States** are named frame ranges with entry/exit semantics: `IN`, `OUT`, `UPDATE`, `IDLE`, plus
  user states. The take engine drives states; the timeline does not loop on its own.
- Evaluation is a pure function `(ScenePackage, frame, dataSnapshot) -> DrawList`. No hidden state,
  so the same frame always renders identically - required for both diffing and offline render.

Rive's state-machine model is deliberately *not* adopted. Our timeline plus explicit states maps
onto rundown/take semantics, which is what operators actually drive.

---

## 7. Binding and data

- `DataSchema` is explicit and versioned: typed fields, arrays, optionality, sample data. A scene
  without a schema cannot be published.
- Bindings map `schemaPath -> (nodeId, propertyPath)` with a transform chain (format, case, round,
  truncate, map, fallback).
- **Fallbacks are mandatory** on every binding. An unresolved binding at air time must render a
  defined value, never empty and never last-frame garbage.
- Sources: manual JSON, REST poll, WebSocket push, file watch. Sport and data-provider adapters are
  built on the same interface, never special-cased.
- Preflight (extending the existing material-readiness work) blocks publish and blocks Take on:
  missing assets, missing fonts, unbound `{{...}}` tokens, schema/binding mismatch, fallback-only
  bindings (warning), and unresolved orphans.

---

## 8. Renderer

We own it. That makes the following non-negotiable from day one rather than phase 4.

### 8.1 Process boundary and wire protocol

Editor and render engine are **separate processes**, specified now even while the render engine is
still the temporary web renderer. Doing this now forces the IR to be serialisable and
renderer-facing instead of React-state-shaped; retrofitting it later is how these projects ossify.

```text
load(packageRef)                 -> ack | error       // preload all media, report readiness
patch(values, applyAt: frame)    -> ack               // atomic at a frame boundary
state(sceneId, state, applyAt)   -> ack               // IN / OUT / UPDATE / custom
cue(sceneId) / take(...) / clear(channel, layer)
tick -> { frame, fps, dropped, drawCalls, textures, vramEstimate }
```

### 8.2 Frame semantics

- **Double-buffered scene state.** A take or patch is staged and swapped at a frame boundary. It is
  never possible to render a half-applied update. This is the difference between a demo and a tool
  someone will put on air.
- Premultiplied alpha end to end.
- Colour space is explicit: artwork authored in sRGB, output Rec.709 (and BT.2020 later). Getting
  this wrong is measurable on air and brutal to fix afterwards.
- Interlaced output renders fields, not frames, when `scanMode` is `"i"`.
- Genlock/reference is a renderer input, not an afterthought.

### 8.3 Rive Renderer as the vector core

`rive-app/rive-runtime` is MIT-licensed and includes the GPU renderer with Metal, Vulkan, D3D11,
D3D12 and OpenGL/WebGL backends. The intended use here is **as a library, not as a format**: drive
`rive::Renderer` (`drawPath` / `drawImage`) and the Factory interface from our own `ScenePackage`,
with no `.riv` involved.

Why: a competitive GPU vector rasteriser with clean antialiasing, feathering and clipping at 1080p50
is a multi-year specialist effort. Taking theirs spends our years on the parts that make broadcast
money - compositor, media decode, colour, alpha, output.

What it does **not** give us, and we must still build: compositor and layer model, video decode and
sync, colour management, interlacing, alpha over SDI, NDI/SDI output, media lifecycle and texture
eviction.

Risks accepted: C++ against a fast-moving, internally-facing API and their build system; and it is a
2D vector renderer, so any future 3D need is a separate decision.

Rive must not define our scene model. Note also that Rive markets broadcast and live events
directly, so depending on `.riv` as *the* scene format would make our platform owner our competitor.

### 8.4 One renderer, two surfaces

The trap is two renderers. The moment editor preview and air preview are different code, we get
permanent "it looked different in the editor" bugs and operators stop trusting the tool.

Therefore `apps/editor-web/src/rendering/GpuSceneRenderer.ts` is hereby **temporary scaffolding for
layout, hit-testing and selection only**. It gets no new features. Every feature added there is a
feature implemented twice and reconciled forever. Pixel preview moves to the real renderer as soon
as the spike lands.

### 8.5 Output

Order: offscreen/preview surface, then HTML/browser source (covers streaming and esports early),
then NDI, then SDI with key and fill. Each output is an adapter behind one surface interface.

---

## 9. Playout

Rundown/sequencer over channels and layers, driven by the take engine: `cue`, `take in`, `update`,
`take out`, `clear`. Data overrides per rundown item. Frame-boundary atomicity per section 8.2.
Operator-facing numeric scene IDs are preserved from the current UI.

---

## 10. Control surfaces

- **GrapiX MCP server** exposing `import_design`, `reconcile_import`, `propose_bindings`,
  `list_templates`, `preflight`, `cue`, `take`, `clear`. Note the direction of the protocol: MCP
  servers *expose tools to hosts*. Any host (Claude, an IDE, our own app) drives GrapiX. An MCP
  server does not "talk to all LLMs".
- **LLM provider gateway** - a separate concern from MCP, used only when GrapiX itself calls a model.
  Adapter per provider; no provider types in shared packages.
- REST plus WebSocket for machine control; Stream Deck / Companion and GPI later, over the same
  take-engine commands.

---

## 11. Where AI is allowed

Allowed, at prep time only:

- Mapping imported layers to schema bindings (fallback for untokenised legacy art).
- Proposing a rig - states, auto-fit candidates, repeat containers - from a static design.
- Shaping and describing a data source.
- Natural-language rundown authoring, which produces a **reviewable** rundown.

Forbidden:

- Any model call on the frame-accurate playout path.
- Any model call inside take, patch, or frame evaluation.
- Any model output applied to air without an explicit human confirm step.

Model at prep time, deterministic at air time. AI on air is one hallucination away from a dead show.

---

## 12. Phase plan

Phase 0 and Phase 1 run **in parallel**. Phase 1 is the highest-risk item in the entire programme
and it constrains the IR, so it cannot be sequenced late.

| Phase | Work | Exit criterion |
|---|---|---|
| **0** | Freeze feature work on the current editor. Write the three model specs and the renderer wire protocol as types plus docs. | `packages/scene-ir` compiles; protocol reviewed |
| **1** | **Rive-renderer spike.** One animated vector scene from a hand-written `ScenePackage`, D3D11 or Vulkan, offscreen surface, then NDI out. | 1080p50, alpha correct, zero per-frame allocation |
| **2** | Figma plugin importer to DesignIR, incl. token grammar, identity, reconcile diff and re-link UI. Fixtures: real lower-third plus real scorebug. | Re-import after a design change preserves the rig |
| **3** | Rig layer: timeline, states, and the section 4.2 broadcast objects. | Auto-fit text and a repeat container drive from data |
| **4** | Bindings, schema, live data, preflight gating publish and take. | Preflight blocks a knowingly-broken take |
| **5** | Compiler to `ScenePackage` / `.gfxpkg`; renderer consumes it; editor preview switches to the real renderer. | Editor preview and air output are pixel-identical |
| **6** | Rundown, take engine, channels and layers, frame-boundary atomicity. | A scripted show runs clean for an hour |
| **7** | PSD, Illustrator and `.riv` importers onto the same DesignIR. | The same fixtures pass per source |
| **8** | MCP server, REST/WS control, Stream Deck. | An external host can cue and take |

Rationale for the ordering: if the Phase 1 spike fails, we have changed strategy for the price of a
spike. If we build the IR and the editor first and *then* discover it, we rewrite everything.

---

## 13. Open questions

- Does the editor embed the native renderer via a shared offscreen surface, a native Node module, or
  a streamed preview? Decided by the Phase 1 spike.
- 3D: does any real ingest source ever produce it, or is 2.5D layer depth sufficient? Deferred until
  a customer scene requires it.
- Font licensing and embedding in `.gfxpkg` - legally load-bearing, needs a real answer before any
  package leaves a machine.
- Does the Figma plugin write tokens back into the file (two-way), or only read them?
- `packageFormatVersion` compatibility policy across renderer versions in a live facility.

---

## 14. Relationship to existing docs

- [architecture.md](architecture.md) - superseded. Its "base objects first" build target is replaced
  by sections 4 and 5.
- [rendering-engine.md](rendering-engine.md) - partially superseded. The swappable-renderer boundary
  it argues for is correct and retained; its PixiJS feature roadmap is replaced by section 8.
- [project-memory.md](project-memory.md) - historical build log. Retained as history; product
  direction now resolves against this document.

---

## 15. References

- [Rive Renderer - now open source and available on all platforms](https://rive.app/blog/rive-renderer-now-open-source-and-available-on-all-platforms)
- [rive-app/rive-runtime](https://github.com/rive-app/rive-runtime) - low-level C++ runtime and renderer, MIT
- [.riv file format](https://rive.app/docs/runtimes/advanced-topic/format) - reader-oriented; no official writer
- [Choosing a renderer](https://rive.app/docs/runtimes/choose-a-renderer)
- [Rive for Broadcast and Live Events](https://rive.app/use-cases/broadcast)
- [Copy and paste from Figma to Rive](https://rive.app/blog/copy-and-paste-from-figma-to-rive)
