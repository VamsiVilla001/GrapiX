# 11.112 and 11.113: animated paths, vertex ids, vertex kinds, auto handles, linked paths (24 Nov 2026)

What this folder holds and what it proves. The plan rows (`GrapiX-Build-Plan.md` 11.112, 11.113), `progress.json`, `progress.html` and
`docs/log/2026-11-24.md` carry the status; this is the evidence.

## Decisions (Jev and Laya, `tools/decide.py`, same typed questions to both; Laya is uncalibrated, so a second opinion and not a vote)

| Decision | Input | Jev (jev-1.14.0) | Laya (laya-multilingual, max_len 8192, not truncated) | Taken |
|---|---|---|---|---|
| How a path animates | `tools/d1_animated_paths.json` | A, 0.91; hold on topology change yes; GPU may refuse by name until redraw is built yes; ids stored on the path yes | C (no path animation) | **A**: a path channel whose keys are whole paths with stable vertex ids. Laya's C contradicts both specs; it agreed on the yes/no questions. |
| How a vertex kind is stored | `tools/d2_vertex_kind.json` | A, 1.0; one derivation function yes; materialise before a hand edit yes | B (keep inferring) | **A**: an optional `vertexKinds` list and `autoTension`, handles of `auto` vertices derived by one function. Laya's B contradicts the spec's "stored kind". |
| How a path is shared | `tools/d3_shared_path.json` | A, 1.0; stale edit refused yes (0.96); a copy stays independent yes (0.97); old scenes unchanged yes (0.83) | B (no sharing); the three yes/no answers agree with Jev | **A**: path links with a revision (see below). Laya's B contradicts 11.112 and 11.118, which require a linked copy. |

Jev's numbers are confidences, not versions. Raw answers: `jev-*.json`, `jev-laya-*.json`.

## What was built

**Contract (Rust, `Shared/contracts`)**
- `BezierPath` gains `vertexIds`, `vertexKinds` (`corner`, `smooth`, `symmetric`, `auto`) and `autoTension`, all optional and absent from
  an old scene's JSON.
- `path_geometry`: every operation keeps ids and kinds (insert gives the new vertex one id, delete keeps the others', reverse and first
  vertex turn them); `setVertexKind`, `setAutoTension`; `derive_auto_handles` (centripetal Catmull-Rom, tension 0..1) and `effective`, the one
  place an `auto` vertex's handles come from (bounds, length, nearest point and every renderer read the drawn path); an edit that reads a
  handle writes the touched `auto` vertices out first (`materialise_at`), so a hand edit is never lost to re-derivation.
- `path_anim`: `PathChannel`/`PathKey`, `evaluate_path_channel` (blend by vertex id, the easing of the key left; **hold** the earlier key and say
  why when the neighbours differ in open/closed, count or ids; held flat before the first and after the last key), `apply_path_channels`,
  `validate_path_channels`.
- Scene edits: `editPath` with a `frame` (a geometry edit sets the key there and starts the channel; an edit of which vertices there are
  lands in every key, an inserted vertex taking the same new id in each, so the shape at each key is unchanged), `setPathKey`,
  `removePathKey`, `movePathKey`.

**Renderers**
- CPU reference: the animated path is evaluated per frame, `PreparedPaths` re-prepared, and the layer sources of animated objects with effects
  or masks drawn again.
- GPU compositor: the layer source of an animated path is sized to the union of every key's drawn bounds (grown by how far a control polygon
  passes its curve, since a blend stays inside the polygons) and drawn again into the same texture each frame by Vello GPU; mask weights of
  effects that reference an animated mask are drawn again with it. The refusal by name for an animated path is gone.

**Editor**
- The TypeScript twin (`path-geometry.ts`, `path-anim.ts`), held to Rust by the shared fixture `Shared/contracts/fixtures/path-geometry.json`.
- The playhead shows each path where its channel has it; edits of an animated path carry the frame; **Key path** / **Remove path key** /
  **Key path edits** in the object panel; vertex kind buttons and the Auto tension slider; path keys are tracks on the timeline that move,
  delete and ease with the path edits; the Pen makes paths with ids and kinds from the start; History names the new edits.

## Verification (numbers are in `docs/log/2026-11-24.md`)

- Rust contract tests: ids and kinds through every operation, auto handles (spacing, tension, ends, no overshoot on uneven spacing), writing out
  before an edit, exact split at every key, hold on a changed topology, validation by name, the edits and their refusals, the shared fixture.
- CPU reference: pixels at frames 0, 10, 20 and 500; a changed topology holds; an auto vertex draws as the same handles written out.
- GPU: `gpu_engine_draws_animated_paths_each_frame_within_one_code_of_the_cpu_reference` on DX12 and on Vulkan, sRGB and linear: an animated
  stroked and filled shape, an animated reference mask driving an effect's weights, a still clip mask, and frames scrubbed backwards and
  repeated.
- Editor: the fixture, the playhead, the frame on edits, kinds, the timeline, the page wiring.

## Linked paths

`PathLink {id, revision, users}` in `SceneDocument.pathLinks` (absent from the JSON of a scene with none). Every user keeps its inline path, which is what every renderer
reads, and the validator holds all users of a link to the same numbers, so a link costs the renderers nothing. A shape is a user by its subpath, a mask by its id (the edit gives
a mask one), so reordering or adding masks keeps the link; removing the mask, or deleting the object, ends it (a link with fewer than two users is dropped). `editPath` on a
linked path writes every user and raises the revision; with `baseRevision` set to an older one it is refused by name. `setShapePath` or `setObjectMasks` that would make two users
differ is refused by the validator. Duplicating an object copies no link. A linked path cannot animate: linking an animated path and animating a linked one are refused by name.

## 3.27 and 11.113 on the way

- A feather that reaches past the layer's box: the mask is worked out over the layer grown by the feather's reach and cropped (`mask_pad`, CPU `mask_alpha`, GPU `apply_masks`
  with a padded window and a cropping last pass). Tests: `a_feather_reaches_past_the_layer_and_does_not_dim_its_edge`, `gpu_feather_past_the_layer_does_not_dim_its_edge`.
- An auto vertex's stored handles are cleared; the shape comes from `effective`.

## Results

contracts 342 tests; Editor 76 files, 1,228 tests, typecheck clean; GPU hardware suite 38 of 38 on DX12 and on Vulkan. Workspace run: see `docs/log/2026-11-23.md`.

## Cost of the per-frame redraw (measured 24 Nov 2026, DEBUG test build, RTX 3070 Ti, DX12)

`gpu_engine_draws_animated_paths_each_frame_within_one_code_of_the_cpu_reference` prints it: with two animated sources (a filled and stroked shape of 388 x 219, a masked rect with an effect's mask weights), a settled frame (a blocking readback) took 28.2 ms (sRGB) and 26.9 ms (linear) moving, 26.3 and 25.6 ms for the same frame again, and 13.0 and 12.9 ms with the path channels taken off. So the redraw costs about 13 ms a frame here. Not measured: a release build, a long scene. The redraw makes its drawing buffers anew every frame; pooling them is the first thing a release measurement would ask for.

