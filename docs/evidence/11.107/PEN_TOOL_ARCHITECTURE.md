# Pen tool: architecture, as built (23 Nov 2026)

The Phase 0 mapping the "Advanced Pen Tool" spec asks for (`GrapiX_Advanced_Pen_Tool_Implementation_Spec.md`, section 19), written
against the repository as it is and not against the spec's suggested paths. Rows 11.104 and 11.107; the rows the spec's remaining
items became are 11.110 to 11.116 in the build plan.

## What was already here (so nothing was duplicated)

| Spec asks for | GrapiX already had | Used as is |
|---|---|---|
| One canonical path | `BezierPath { closed, vertices, in_tangents, out_tangents }` in `Shared/contracts/src/scene.rs`, tangents as offsets from their vertex (the spec's section 4 "why handles must be relative") | yes, unchanged |
| Shape and mask owners | `ShapeObject` (path + compound paths) and `Mask { path, mode, feather, expansion, opacity, inverted }` | yes |
| A command layer, one undo step per gesture | `SceneEdit` applied by `apply_edits`, `editScene` batches, one batch = one history step | yes |
| Lock policy | `locked` on objects and groups, refused by name | yes |
| One renderer | the Rust engine draws `BezierPath` (lyon rasteriser, `services/render-engine`); the Editor never draws shapes itself (13.5) | yes |
| kurbo / lyon | `kurbo` and `lyon` are in the workspace's render engine; the contracts crate carries neither | the maths needed here is small and exact, so it is written once in the contracts crate with no new dependency |

## Where each part lives

| Part | File |
|---|---|
| Path maths (the authority) | `Shared/contracts/src/path_geometry.rs` |
| The command | `SceneEdit::EditPath { object_id, target: PathTarget, op: PathOp }` (`command.rs`), applied by `render_edit::edit_path`, which goes through `set_shape_path` / `set_object_masks`, so the box, the drawability check and the refusals are theirs |
| Generated TypeScript and schemas | `Shared/generated-ts` (`PathOp`, `PathTarget`, `HandleSide`, `HandleCoupling`, `EditPath`) |
| The Editor's copy of the maths | `Editor/src/path-geometry.ts`, held to the Rust by `Shared/contracts/fixtures/path-geometry.json` (the Rust test writes it with `GX_WRITE_FIXTURES=1` and fails when it has drifted; the TypeScript test reads it) |
| Pen model (modifiers, resume, close) | `Editor/src/pen-tool.ts` |
| Edit path model (pick, gesture, op, sketch) | `Editor/src/path-edit.ts` |
| Page wiring, overlay | `Editor/web/main.ts` (Pen and "Editing a path" sections), `Editor/src/overlay.ts` (`pathEdit` primitive), ribbon in `index.html`, keys in `command-registry.ts`, menu in `app-menu.ts` |

**Decision: the maths is in two languages on purpose.** The spec's section 10 prefers one Rust kernel called from the editor
(WASM or IPC) and, failing that, a TypeScript adapter "differential-tested against canonical Rust". The page cannot call Rust
for every pointer move (no WASM build of the contracts crate, and an IPC round trip per move is what the spec forbids), so the
page has a TypeScript adapter and the fixture is the differential test: 40 random cubics for nearest distance, bounds, length
and curvature, and 12 whole edits, all computed by Rust and compared in TypeScript. The backend is the authority: it applies the
edit, and the page's copy is only for the preview while a drag is in progress.

## The spec's rules, and where they are kept

- **Exact insert (5.3).** `insert_vertex` splits with De Casteljau and rewrites the two neighbours' handles; the test compares the
  outline before and after (every point of each lies on the other, equal length) for open and closed paths, at three parameters.
  A split within 1e-6 of a vertex is refused ("that is a vertex already").
- **Nearest point (5.4).** The roots of `(B(t) - Q) . B'(t)` are isolated by halving the polynomial's Bernstein form until a piece
  has at most one sign change, then bisected; both ends and every piece's ends are candidates. Tested against a dense sampling for
  200 random cubics and for a loop, a cusp and a single point. (The first version lost a root that sat exactly on a halving point;
  the symmetric loop and the cusp found it, and the Bernstein end signs now decide the bisection.)
- **Bounds (5.5)** from the roots of the derivative; **arc length (5.6)** by adaptive Gauss-Legendre, with `t` at a length;
  **tangent, normal, curvature (5.2)** that never give NaN for a repeated control point.
- **Handles (6).** `Coupling::{None, Smooth, Mirror}`; smooth keeps the other handle opposite with its own length and leaves it alone
  when the dragged one is pulled to nothing. Vertex kind is not stored (the contract has none); it is read from the handles
  (`is_smooth`), so a file from anywhere behaves the same.
- **Segment drag (8.1).** `reshape_segment` with the spec's closed-form shares, so the grabbed point follows the pointer exactly
  (the test moves it by (12, -7) on three segments and compares).
- **Gestures (7).** The pointer moves update a preview in the page only; nothing is sent until the pointer is up, then ONE
  `editPath` edit. Escape drops a drag; with no drag it clears the selection. In the Pen, Escape in the middle of placing takes that
  point back, and otherwise ends the path and keeps what was placed (the spec's rule, which differs from row 11.104's first version).
- **Shift step (3.1, 6).** 15 degrees by default for the Pen and for handles, 45 for moving vertices; the step is a parameter of
  every function that takes Shift (the settings page is 11.116).
- **Pen modifiers (6).** Alt breaks the handle being pulled, Space moves the new point with its handles, a drag from the first point
  sets the closing tangents, a click on an end of the selected open shape carries it on (only for a shape placed where its path says,
  because the Pen's points are canvas points).
- **Hit precedence (6).** handle of a selected vertex, then a vertex, then a curve, then nothing; the pick radius is ten screen
  pixels at any zoom, and the distance is measured on the canvas, so a shape scaled non-uniformly is picked where it is drawn.
- **Invalid input (1, 9).** Non-finite numbers, zero-length curves, an index that is not there, a delete below two (three when
  closed) vertices and a close below three are refused by name and change nothing.

## Not built (the spec items that became rows)

Join and snapping 11.110, Auto Pen and Mask creation policy 11.111, stable ids and topology-preserving animation 11.112, auto-smooth
and Remove Point Keep Shape 11.113, SVG in and out 11.114, performance budget and render parity 11.115, the Shift step setting
11.116. Also not done: a window check of the path tools (the Editor was not launched for this change), and Smart Pen as a single
mode (its double-click shortcuts are in the Edit path tool).

## v2 of the specs (24 Nov 2026)

The v2 Pen and Masking specs share one contract (path resource, path binding, stable ids, stored vertex kind, owned or
linked copies, revision preconditions). That contract is **not** in the scene today: `BezierPath` is embedded in its owner and
addressed by vertex index. The mapping of every spec command to the GrapiX edit that serves it, the requirement-by-requirement
status and the masking gaps are in `SPEC_V2_CONFORMANCE.md`. The structural parts are rows 11.112 (ids, shared path, revision,
keyframes) and 11.113 (stored kind), the masking engine gaps are 3.26 to 3.30, the Editor's missing mask and matte controls are
11.117, and shape-to-mask copy is 11.118.

