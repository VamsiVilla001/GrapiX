# The render features through the Editor MCP

16 November 2026. Not a build-plan row: the user's instruction, "write each
module MCP accessible", answered with the option "render features via the
Editor MCP". 3.17 to 3.19 made gradients, strokes, masks, clip groups, track
mattes and trim draw, but `scenes.edit` could set only ten object fields, so an
MCP agent could use none of them. `11.47` keeps the Editor's own tools for them.

## What an agent can now do

Eight typed `SceneEdit`s, in one batch, atomic, one undo entry, through
`scenes.edit` and the Editor alike (`Shared/contracts/src/render_edit.rs`):

| Edit | Sets | Refuses by name |
| --- | --- | --- |
| `setObjectMasks` | an object's whole mask list; empty clears | `maskInvalid` (with the mask's index) |
| `setClipChild` | a group's clip child; absent clears | `clipGroupInvalid`, `objectFieldNotApplicable` (not a group) |
| `setTrackMatte` | an object's matte source and mode; absent clears | `trackMatteInvalid`, including at another layer this edit would break |
| `setTrim` | a shape's start, end and offset (all three replace) | `shapeTrimInvalid`, `objectFieldNotApplicable` (not a shape) |
| `setPaint` | fill or stroke of every listed object; absent clears | `gradientNotDrawable`, `objectFieldNotApplicable`, `objectFieldValueInvalid` |
| `setStroke` | stroke width and style of every listed object | `objectFieldValueInvalid` (width, miter limit, dashes), `scenePropertyNotDrawable` (a scaled stroke) |
| `createShape` | a new shape from a bezier path | `objectFieldValueInvalid`, `vectorTessellationFailed`, `sceneObjectNameEmpty` |
| `setGroupChildren` | a group's ordered children | `sceneHierarchyInvalid` (`missingChild`, `selfReference`, `multipleParents`, `cycle`), `clipGroupInvalid` if the clip child is dropped |

Every edit also refuses an unknown object (`sceneObjectUnknown`), an edit that
changes nothing (`objectFieldUnchanged`), and puts the scene back as it was
when it refuses. No new `Refusal` variant: each uses the existing names.

`createShape` and `setGroupChildren` are prerequisites, found while writing the
test. `scenes.import` yields only empty groups and turns every path into a
rectangle, and the object catalogue refuses `shape` as not creatable without a
path, so without these two an agent could not build a clip group or a trimmed
shape at all.

## One rule, not two

An edit does not re-implement what the engine can draw. It applies the change to
a copy and runs `drawability_refusals` on the scene before and after
(`refuse_what_cannot_be_drawn`). It refuses on any refusal at the fields it
edited, and on any refusal the scene did not have before. That is how
`setTrackMatte` on an object that is another layer's matte source refuses at
that other layer, which the edit never named. Two value rules lived only in the
engine or the validator; they are now shared, not copied:

- `StrokeStyle::problem()` (miter limit, dash entries, dash length): called by
  `setStroke` and by the engine's stroke preparation (`rasterise/lyon.rs`). Before
  this, the Editor accepted a stroke style the engine then refused at publish.
- `trim_value_valid()`: called by `setTrim` and by the validator.
- `HierarchyDiagnosticCode::problem()`: the validator's and `setGroupChildren`'s
  names for a broken hierarchy.

## Design, run through Jev and Laya first (`design-jev-laya.json`)

| Question | Jev | Laya | Decided |
| --- | --- | --- | --- |
| typed edits or one generic path edit | typed (1.0) | typed | typed |
| replace the mask list or per-mask ops | replace (1.0) | replace | replace |
| reuse `drawability_refusals` or re-write checks | reuse (1.0) | reuse | reuse |
| where the stroke style checks live | one shared function (0.96) | engine only | **shared function** |
| a shape's fill and stroke switch | follow the paint (0.44) | follow the paint | follow the paint |
| a paint on a kind that does not draw it | refuse by name (0.72) | store and ignore | **refuse by name** |
| must the user approve | 0.47 | 0.82 | see below |

They split on two questions and on whether the user must approve. By hand:
`engine only` leaves the Editor laxer than the engine, the failure `drawability.rs`
and invariant 27 exist to prevent, and `store and ignore` is invariant 18
(a silent no-op), while `SetObjectField` already refuses an inapplicable kind
by name. On "must the user approve", the scope (which features, through which
surface) was the user's choice; the rest follows from the command model. This
disagreement is reported to the user.

## Verified by execution

- `cargo test -p gx-contracts --lib render_edit`: 8 tests. Each edit's success,
  no-op, every named refusal, restore on refusal, the cross-object refusal, a
  fault the edit leaves in place, and a clip child cleared.
- `cargo test -p gx-editor-mcp --test render_edit_surface`: the real
  `gx-editor-mcp` binary, a real handshake. One `scenes.edit` batch of 12 edits
  builds a clip group (a shape and an ellipse, the shape as the clip child), a
  mask, a track matte, a trim window, a gradient, and a round dashed stroke; a
  second process reads the stored scene back with every field set; the scene
  passes `validate.preflight`. Nine bad edits each come back as a JSON-RPC
  error whose `data.code.refusal` is the named code, and the stored scene is
  equal to what it was before each one. A bad edit after a good one in one
  batch keeps neither. A misspelt key (`begin` for `start`) is refused naming
  it. `tools/list` advertises a schema that accepts each new edit.
- `cargo test -p gx-render-worker --lib a_scene_authored_by_edits`: the same
  wire JSON, applied by `apply_edits` to an empty scene and drawn by the CPU
  reference. The mask keeps the card's left half (alpha 255 and 0); only the
  overlap of the clip child and its sibling is lit and the clip child is
  never drawn; the alpha matte lets the plate through only where its source
  overlaps and the source is never drawn; the trimmed stroke lights 95 to 105
  pixels where the untrimmed one lights 190 to 210.
- Conformance: the witness batch now carries all eight, and "every SceneEdit
  variant executed without reaching the engine" passes.
- `npm run check` exit 0 (46 Node, 412 Editor, 875 Rust passed, 0 failed, 37 ignored; conformance 591/0/9), `cargo fmt --all` and `cargo clippy --workspace --all-targets -D warnings` clean; hardware worker suite (`cargo test -p gx-render-worker --lib -- --include-ignored --test-threads=1`) 191/0/0, which includes the stroke and dash tests behind the engine's now-shared `StrokeStyle::problem()`.

The GPU path for each feature is the 3.17 to 3.19 evidence; a scene authored by
these edits is an ordinary `SceneDocument`.

## Jev and Laya acceptance (`jev-laya-acceptance.json`)

Run on this record before the final gate. Laya read it whole: 2773 tokens, nothing
truncated or dropped.

| Question | Jev | Laya |
| --- | --- | --- |
| done-when met by execution | 0.90 | 0.95 |
| evidence names execution | 0.97 | 0.94 |
| silent substitution risk | 0.23 | 0.96 |
| weakest point | none (0.51) | unexecuted clause |
| what was not run is named | 0.50 | 0.95 |
| mutations can fail | 0.54 | 0.92 |
| every feature set through the shipped binary | 0.88 | 0.94 |
| refused by name on the wire, store unchanged | 0.97 | 0.96 |
| one rule, not two | 0.96 | 0.91 |
| an authored scene draws what the edits say | 0.97 | 0.94 |

They split on the silent-substitution risk and on the weakest point, as they did
on 3.19, and neither gives a reason. By hand, clause by clause against the
done-when: each of masks, clip groups, track mattes, trim, fills, gradients and
strokes is set through the shipped binary and read back from the store. That
check found one real gap, which is closed: the read-back asserted a matte's
source but not its mode (luma), and a stroke's dash but not its join and cap.
It now asserts both. Everything the edits do not cover is listed under "Not in
this slice" below. The disagreement is reported to the user.

## Mutations

One exact replacement each, run alone against the tests named, each file
restored byte-identical (`mutate_mcp.py` in the session scratchpad). Two
survived the first run, and the tests were strengthened until they failed:
N2 (the "fault left in place" test changed the bad mask's feather, so the
refusal looked new) and N13 (clearing a clip child was never checked).

| # | Mutation | Failing |
| --- | --- | --- |
| N1 | an edit ignores a refusal that was not there before | `a_track_matte_names_a_drawing_source_without_a_matte_of_its_own` |
| N2 | an edit ignores a refusal at the field it edited | `an_edit_does_not_hide_a_fault_it_leaves_in_place` |
| N3 | a refused edit leaves its change in the scene | the matte, mask and create-shape tests |
| N4 | trim values are not checked | `trim_is_a_shape_only_window_in_its_domain` |
| N5 | a shape's fill switch does not follow its paint | `paint_sets_the_slot_and_a_shapes_flag_follows_it` |
| N6 | the miter limit is not checked | `stroke_width_and_style_refuse_what_the_engine_would` |
| N7 | group children skip the hierarchy check | `a_shape_is_created_from_a_path_and_a_group_takes_children` |
| N8 | a paint is accepted on a kind that does not draw it | `paint_sets_the_slot_and_a_shapes_flag_follows_it` |
| N9 | a one-vertex shape path is accepted | `a_shape_is_created_from_a_path_and_a_group_takes_children` |
| N10 | `setTrim` swaps start and end | the shipped-binary wire test |
| N11 | `setTrim` is dropped at dispatch | `a_scene_authored_by_edits_draws_what_the_edits_say` |
| N12 | the engine stops checking a stroke style | `a_stroke_style_that_cannot_be_drawn_as_written_is_refused_by_name` |
| N13 | a clip child is not cleared when `None` | `a_clip_child_must_be_a_drawing_child_of_the_group` |

## Not in this slice, by name

- **Object width and height have no edit.** `ObjectField` carries ten fields
  (opacity, x, y, rotation, scale X and Y, text, font, size, radius). A rect
  created over MCP is 200 by 120 and can be scaled but not resized. Not new, but
  it limits what an agent can lay out.
- **A created group is centred in the canvas like any object** (its children are
  placed from it), so an agent places it with `setObjectField` x and y.
- **No edit for effects, blend mode, material, anchor, z-order, layer
  membership or compound paths.** Those render (3.22, 1.3) but still have no
  edit.
- **Not yet an Editor tool.** The Editor's panels, pen tool and canvas gestures
  for these stay with `11.47`.
- **Animation of these properties** (animated trim, mask paths) stays with
  `11.47`; the edits set static values, as the contract carries them.
- **The Program (Playout) side has no shipped MCP binary** (8.14's transport
  half covered the Editor only). Not touched here.
