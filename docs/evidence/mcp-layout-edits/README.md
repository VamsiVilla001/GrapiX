# The MCP edit gaps: size, draw order, blend, anchor, effects, compound paths

16 November 2026. Not a build-plan row: the user's instruction, "fill the gaps
in the MCP edits", after the render-feature edits
(`docs/evidence/mcp-render-edits`) named what an agent still could not set.

## What an agent can now do

Through `scenes.edit` and the Editor alike, typed, atomic in a batch, one undo
entry (`Shared/contracts/src/object_edit.rs`, `render_edit.rs`):

| Edit | Sets | Refuses by name |
| --- | --- | --- |
| `setObjectField` `width`, `height` | the object's box: rect, ellipse, image, text | `objectFieldValueInvalid` (not finite, negative), `objectFieldNotApplicable` (a shape's box follows its path, a line's its points, a group has none) |
| `setObjectField` `zIndex` | draw order within a layer | `objectFieldNotApplicable` (a kind that draws nothing) |
| `setBlendMode` | the layer blend mode of every listed object; left out is `normal` | `objectFieldNotApplicable` (group, layer, marker, camera, light) |
| `setAnchor` | the pivot every listed object rotates and scales about | `objectFieldValueInvalid` (not finite), `objectFieldNotApplicable` |
| `setEffects` | one object's whole effect stack; empty clears | `effectInvalid` (from `validate_effects`, the validator's own check), `objectFieldNotApplicable` |
| `setShapePath` | a shape's path, every additional subpath, and optionally its fill rule | `objectFieldValueInvalid` (at `path` or `compoundPaths[i]`), `objectFieldNotApplicable` (not a shape) |
| `createShape` `compoundPaths` | a compound shape at creation | `objectFieldValueInvalid` at `compoundPaths[i]` |

Each also refuses an unknown object (`sceneObjectUnknown`), an edit that
changes nothing (`objectFieldUnchanged`), and puts the scene back when it
refuses. The new render-side edits run the same drawability check before and
after as the render-feature edits (`refuse_what_cannot_be_drawn`). No new
`Refusal` variant.

## Design, run through Jev and Laya first (`design-jev-laya.json`)

| Question | Jev | Laya | Decided |
| --- | --- | --- | --- |
| width and height | `setObjectField` fields (0.98) | a separate size edit | **fields** |
| draw order | a `zIndex` field (1.0) | a reorder edit | **field** |
| layer membership, 2D material slots, 3D fields | leave out, named (0.98) | leave out, named | leave out |
| the effect stack | replace the list (1.0) | per-effect operations | **replace** |
| compound paths | `setShapePath` plus `createShape` option (1.0) | same | same |
| blend, anchor, effects on a kind that draws nothing | refuse by name (0.62) | store and ignore | **refuse** |
| must the user approve | 0.42 | 0.94 | see below |

By hand: width and height are base fields like x and y, and a batch of two
field edits is already atomic, so a second size edit would be a second copy of
the field machinery; `zIndex` is what the renderer orders by; replacing the
effect list is what both chose for masks; "store and ignore" is a silent
no-op (invariant 18). On approval: the user asked for the gaps to be filled;
what is left out is left out because the engine refuses it today, and is named
below. The splits are reported to the user.

## Code review by Jev and Laya (`review-jev-laya.json`)

| Question | Jev | Laya |
| --- | --- | --- |
| every edit refuses by name and restores | 0.67 | 0.92 |
| the existing check and validators are reused | 0.86 | 0.92 |
| a shape's box is right | 0.95 | 0.91 |
| leaving the three undrawable fields out is right | 0.89 | 0.93 |
| weakest point | no GPU render test (0.43) | no fill-rule edit |
| a defect to fix first | 0.60 | 0.89 |

Laya's weakest point was real: a compound shape had no way to set its fill
rule, so an agent could not cut a hole with even-odd. **Fixed**:
`setShapePath` takes an optional `fillRule`, covered at every level below. Jev's
doubt on "refuses by name" was checked edit by edit; every new edit refuses all
four cases. The one place it does not hold is old: `setObjectField` ignores an
unknown id when another listed id exists (named below). The GPU draws these
features already (3.17, 3.20, 3.22 compare the GPU with the CPU reference); a
scene authored by these edits is an ordinary scene.

## Verified by execution

- `cargo test -p gx-contracts --lib render_edit` (11): refusals for kinds that
  draw nothing, invalid values, no-ops and unknown objects, each leaving the
  scene as it was; an invalid effect refused naming it; compound creation and
  replacement with the box following every subpath; the fill rule alone is a
  change and the same rule again is not.
- `cargo test -p gx-editor-mcp --test layout_edit_surface`: the shipped
  `gx-editor-mcp` binary, a real handshake. One `scenes.edit` batch creates a
  rect, an ellipse, a group and two shapes and sets width, height, `zIndex`, a
  blend mode on two objects, an anchor, an exposure effect, a compound
  `createShape` and a `setShapePath` with two subpaths and even-odd; a second
  process reads every value back; the scene passes `validate.preflight`. Seven
  bad edits come back as named refusals with the stored scene unchanged; a
  misspelt effect parameter (`exposur`) is refused naming it; `tools/list`
  advertises a schema that accepts each new edit and rejects an unknown blend
  mode.
- `cargo test -p gx-render-worker --lib the_layout_edits_draw_what_they_say`:
  the same kind of wire JSON drawn by the CPU reference. Width 300 lights x 250
  and not x 350; the raised red rect is over the blue one; green multiplied
  over red is black; both subpaths of the compound shape are lit and the gap
  between them is not; the replaced path is a filled square; an even-odd ring
  has its hole; one stop of exposure takes sRGB 64 to 90; the quarter turn is
  about the anchor, not the corner.
- Conformance: the witness batch carries all four new edits and the
  `compoundPaths` and `fillRule` options; "every SceneEdit variant executed"
  passes (gate below).
- Mutations, one at a time, restored byte-identical (`mutate_gaps.py`): 11 of
  11 fail named tests (width on a shape, a negative width accepted, a blend
  mode on a group, effects skipping the validator, `setShapePath` or
  `createShape` dropping subpaths, `zIndex` not applied, the anchor cleared at
  dispatch, the blend mode not stored, the box ignoring subpaths, the fill rule
  ignored).
- `npm run check` exit 0 (46 Node, 412 Editor, 900 Rust passed, 0 failed, 38
  ignored; conformance 594/0/9); `cargo clippy --workspace --all-targets -D
  warnings` and `cargo fmt --all` clean.

## Jev and Laya acceptance (`jev-laya-acceptance.json`)

Laya read 2195 tokens, nothing truncated or dropped.

| Question | Jev | Laya |
| --- | --- | --- |
| done-when met by execution | 0.90 | 0.93 |
| evidence names execution | 0.99 | 0.93 |
| silent substitution risk | 0.64 | 0.94 |
| weakest point | none (0.34) | vague record |
| what was not run is named | 0.55 | 0.91 |
| mutations can fail | 0.70 | 0.91 |
| every gap set over the shipped binary | 0.96 | 0.95 |
| refused by name, store unchanged | 0.97 | 0.96 |
| an authored scene draws what the edits say | 0.97 | 0.94 |
| what is left out is named | 0.74 | 0.98 |

They agree the done-when is met. By hand: the record pointed to `memory.md` for
the gate (vague; the numbers are now above) and did not name the GPU render of
an authored scene as not run (now below). The one silent behaviour in reach is
the old `setObjectField` handling of unknown ids, named below. The splits are
reported to the user.

## Not in this slice, by name

- **Layer membership** (`layerId`): the engine refuses any non-empty layer
  today (3.16), so an edit could only be refused.
- **Material slots on 2D objects**: refused by the engine (11.50); meshes, the
  only kind whose slots draw, cannot be created over MCP.
- **rotationX, rotationY, scaleZ, zDepth**: refused by the engine (11.48).
- **`setObjectField` and unknown ids**: it ignores an id that names no object
  when another listed id exists (it refuses only when none does). Older than
  these edits and shared with the Editor; not changed here.
- **Not run: the GPU render of a scene authored by these edits.** The pixel
  checks above are on the CPU reference; the GPU draws each feature (blend
  modes 3.20, effects 3.22, paths, fill rules and anchors 3.16 and 3.17), and
  those rows compare it with the CPU reference.
- **A reorder edit** (move before or after another object): `zIndex` is the
  field; a convenience edit can come later.
- **Animating these values** stays with `11.47`, as for the render features.
