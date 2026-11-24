# Pen and Masking specs v2: what changed, what is built, what became rows (24 Nov 2026)

The user attached `GrapiX_Pen_Tool_Shared_Path_Engine_Spec_v2.md`, `GrapiX_Masking_Track_Matte_Spec_v2.md`
and a zip of the same two files (byte-identical, checked by SHA-256). The two documents are one contract:
one path model and one command list in both, track mattes independent of paths.

## What v2 changes compared with the first Pen spec

1. **A shared contract** at the top of both files: `VectorPath` (value), `PathResource` (id, revision, keyframes),
   `PathBinding` (owned or linked), `LayerMask`, `TrackMatte`, and the command names `path.*`, `mask.*`, `matte.*`.
2. **Stable ids** for every anchor and contour, a stored anchor kind (`corner`, `smooth`, `symmetric`, `auto`).
3. **Shape to mask is a copy** by default; linking is explicit; undo returns both.
4. **Open paths do not clip** a layer until closed.
5. **The masking spec** (35 methods, 7 mask modes, track mattes, effect masks, stencil, tracking, roto) and the
   section 23 acceptance checks.

The spec says to adapt to the code that exists and not to rename working types. So nothing was rebuilt.

## How the shared commands map onto GrapiX (no second path model, no second history)

| Spec command | GrapiX today | Gap |
|---|---|---|
| `path.resource.create`, `shape.path.bind` | `setShapePath` (a shape owns its `BezierPath`) | no shared resource, no revision on a path (row 11.112) |
| `path.anchor.insert / move / delete / convert`, `path.handle.set`, `path.contour.setClosed` | `editPath` (edit 46): ops `insertVertex`, `moveVertices`, `deleteVertices`, `convertVertex`, `setHandle`, `setClosed`, `reshapeSegment`, `reversePath`, `setFirstVertex`, on a shape subpath or a mask | vertices are addressed by index, not by id (11.112) |
| `path.contour.join` | not built | row 11.110 |
| `path.geometry.keyframe` | not built; path vertices are not animatable | row 11.112 |
| `mask.create`, `mask.property.set`, `mask.reorder` | `setObjectMasks` (the whole list, in order) | no mask ids; no Editor control at all (11.117) |
| `matte.set`, `matte.clear` | `setTrackMatte` (source by id, mode alpha, alphaInverted, luma, lumaInverted) | audit (3.30) |
| `expectedRevision` | `ifRevision` on the stored-scene write | per-path revision (11.112) |

## Pen spec v2: requirement by requirement

| Spec | Status | Where |
|---|---|---|
| 1 one canonical path | done: `BezierPath` is the only model; `path_geometry.rs` is the one kernel | `Shared/contracts/src/path_geometry.rs` |
| 2 exact insert (De Casteljau) | done, tested both languages, split at the ends refused ("that is a vertex already") | `insert_vertex`, fixture `path-geometry.json` |
| 3 pro interaction | done: click, drag, Shift (15 default), Alt, Space, close, resume, marquee, add, delete, convert | `Editor/src/pen-tool.ts`, `path-edit.ts` |
| 4 undo: one gesture is one step | done: one `editPath` per gesture, page previews only | `sendPathOp` |
| 5 renderer is the authority; overlays are not exported | done: overlay only; engine unchanged | `overlay.ts` |
| 6 animated paths, stable ids | **not built**, row 11.112 | |
| 7 safe on bad numbers | done: finite checks, tiny curves, zero handles, no NaN in tangent or curvature | `path_geometry.rs` tests |
| 5.1 to 5.2 evaluation, derivatives, curvature | done | |
| 5.3 split | done | |
| 5.4 nearest point, no fixed sampling | done: roots of the degree-five polynomial, Descartes isolation, bisection, ends compared; checked against a dense reference | `nearest_on_cubic` |
| 5.5 exact bounds | done from the derivative roots (`cubic_bounds`, `path_bounds`); a bound of a transformed path is not computed in the target space yet (the page transforms points before picking) | `path_geometry.rs` |
| 5.6 arc length and inverse | arc length done (adaptive Gauss-Legendre, `arc_length`, `path_length`); the inverse (length to t) exists in the TypeScript twin only (`tAtLength`), Rust gets it with trim paths in 11.115 | |
| 5.7 straight test by chord deviation | done in the TypeScript twin (`isStraight`); not in Rust | |
| 6 handle table: corner, smooth, symmetric, auto | **partly**: corner and smooth work; symmetric is not distinguishable because the kind is inferred, not stored; auto not built. Rows 11.113 stores the kind | |
| 6 Shift, Alt, Space; first point closing tangents; resume | done | `pen-tool.ts` |
| 6 Alt-click a vertex to convert | not built, put in 11.116 | |
| 6 hit precedence | done: handle of a selected vertex, vertex, curve; the first/last endpoint of the open path in progress is the Pen's own click rule | `pickPath` |
| 7 Escape: drag only; otherwise end the path and keep it | done | `penKey`, `pathKey` |
| 7 pointer cancel, tool switch | done: cancel goes through `finishOverlayPointer(.., true)`; switching tool drops the gesture | `dropPathState` |
| 8.1 segment drag | done, closed form, refuses a grab at an end vertex | `reshape_segment` (UI gesture on a curve drag) |
| 8.2 auto-smooth, 8.3 remove point keep shape | not built, row 11.113 | |
| 9 four coordinate spaces; positions w=1, handles w=0 | done: handles are offsets, picked through anchor, scale and rotation | `toCanvas`, `toObjectSpace` |
| 9 snapping | not built, row 11.110 | |
| 9 3D layers | a shape has no 3D rotation in this contract (only meshes do), so nothing to refuse; checked in `viewport.ts` | |
| 10 tessellation, caches, dirty regions | the engine's (3.x); not touched | |
| 10 lock policy | done: a locked shape or a locked group refuses by name | `editTarget` |
| 11 shape appearance, trim | engine (3.19); not touched | |
| 12 pen creates shape or mask by context | not built, row 11.111 | |
| 12 shape to mask by copy | not built, row 11.118 | |
| 13 animated topology, first vertex, reverse | the maths for `reverse_path` and `set_first_vertex` is done and tested; the animated part is 11.112 | |
| 14 SVG in and out | not built, row 11.114 | |
| 15 command API for MCP | `editPath` is in the generated schema and the MCP trace; conformance CONFORMANT | |
| 16 performance budget | not measured, row 11.115 | |
| 17 geometry tests | done (18 Rust and the TypeScript twin, 132 mutants) | `path-geometry.test.ts` |
| 17 interaction tests | done at unit level; **no real-window check yet** | |
| 23 cross-module checks | see the next section | |

## Section 23 checks

| Scenario | Today |
|---|---|
| Closed shape, copied mask | curves would be equal (same type), but there is no copy command yet (11.118) |
| Linked path between two owners | not possible (11.112) |
| Point added to an animated mask | not possible, paths are not animatable (11.112) |
| Open path on a layer: no clipping | **done in the engine**: an open mask path is refused by name when it is set |
| Two handles moved: one undo item | done for the path tools (one `editPath`) |
| Video as a luma matte, no path anywhere | works: the matte code reads pixels only |
| Delete a matte source | the validator refuses the scene by name (`TrackMatteInvalid`: source not in the scene); the spec wants a warning and a pass-through instead, which is part of 3.30 |
| Reorder layers after a matte | the source is an id, so reordering cannot change it; a test of it is part of 3.30 |
| Zoom or pan changes nothing persisted | done: edits are in object space |
| 4K export uses the same pipeline | the engine's; 11.115 compares |

## Masking spec v2 against what exists (3.19 is the engine side, done on 15 Nov 2026)

| Spec | Today | Row |
|---|---|---|
| Mask modes None, Add, Subtract, Intersect, Difference | done on GPU and CPU | 3.19 |
| Lighten, Darken, and the first-mask rule | **missing** | 3.26 |
| Difference formula differs (`a+c-2ac` here, `abs(a-c)` in the spec) | **decision recorded**, not changed | 3.26 |
| Invert, opacity, expansion | done | 3.19 |
| Feather: one amount, Gaussian, sigma = feather/2, in object pixels | done; x and y and a falloff missing | 3.27 |
| Variable feather points | pending | 11.108 |
| Open mask path clips nothing | done (refused) | 3.19 |
| Track mattes: alpha, alpha inverted, luma, luma inverted, by source id | done; self, missing, non-drawing and chained sources are refused by name (so no cycle can form); time, warning and shared matte to audit | 3.30 |
| A matte source is never drawn (spec: its own visibility decides) | **question for the user** | 3.30 |
| Effect mask references, Preserve Underlying Transparency | missing | 3.28 |
| Stencil, Silhouette | missing | 3.29 |
| Editor controls for masks and mattes | **none exist** | 11.117 |
| Rectangle, ellipse, rounded, polygon and star masks | the shape generators are 11.106; mask creation is 11.111 | 11.106, 11.111 |
| Mask tracking, auto-trace | parked | 16.21 |
| Roto brush, segmentation worker | parked, optional, local | 16.22 |
| Refine matte, keyers, Set Matte, mask motion blur | parked | 16.23 |

## What was reworked now

Nothing in the code. Every Pen behaviour of the spec that is built was checked against v2's text and none
conflicts; the places where v2 asks for more (ids, stored kind, shared resource, revision, copy) are
contract changes, and a contract change that touches saved scenes is a row with its own gate, not a side
effect of re-reading a document. Plan: 11.111, 11.112, 11.113 and 11.116 rewritten; 11.117, 11.118,
3.26 to 3.30 and 16.21 to 16.23 added (10 rows, all pending).
