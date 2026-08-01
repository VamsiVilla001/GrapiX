# GrapiX Shared workspace

The ownership root for application-neutral GrapiX contracts. Every package here
is consumed by Editor, Playout, the render engine, or all three, and none of them
may depend on an application. The root `npm run check:boundaries` gate enforces
that direction, in both manifests and relative imports.

| Package | Owns |
| --- | --- |
| `shared-types` | `SceneDocument`, objects, materials, fonts, timeline, rundown, transition and package schemas |
| `scene-model` | scene separation rules, revisions, revision-gated incremental patches |
| `stage-model` | the virtual canvas: logical stage in f64, regions, viewports, cameras, f64→f32 narrowing |
| `surface-model` | physical display surfaces and their output mapping |
| `tile-system` | tile grid, object-to-tile index, culling, dirty tracking, overscan |
| `animation-engine` | rational broadcast frame clock and frame evaluation |
| `asset-manager` | asset state machine, content addressing, upload |
| `output-contracts` | output adapter descriptors and formats |
| `renderer-contracts` | `RendererBackend`, render graph, scene runtime interfaces |
| `shader-library` | metadata and validation over `render-shaders` |
| `render-shaders` | WGSL sources and the uniform byte-layout contract |
| `render-protocol` | engine protocol **v3** and the shared `EngineConnection` client |
| `grapix-sdk` (`@grapix/sdk`) | scene automation and sequencing authoring contracts |

Protocol v2's TypeScript client has been removed. `render-protocol` is the only
way an application talks to a render engine; see `docs/architecture.md`.

## Commands

```bash
npm run build:shared   # ordered build — later packages consume earlier declarations
npm run test:shared    # every package's test suite
```

The build order in `Shared/package.json` is load-bearing: `tsc` needs each
dependency's emitted declarations before the packages that import them.
