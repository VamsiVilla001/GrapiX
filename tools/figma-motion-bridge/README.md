# GrapiX Motion Bridge

A Figma plugin that exports Motion timelines as `grapix-figma-motion.json` for the Editor's
**Import Design File** dialog.

## Why it exists

The Figma REST API cannot see a Motion timeline. It returns a node's prototype *interactions* —
what happens on a trigger, over how long, to which destination — which is a transition, not a
timeline. It never says "this layer's x went 0 → 120 with these keys".

Per-property tracks live only in the document model, on `node.animations`, which is reachable only
from inside Figma. So a plugin is the only route, and this is it.

Without a manifest GrapiX can still import prototype transitions and Smart Animate (choose
**Design + prototype motion** in the dialog); those are derived from the REST document by diffing
the two frames of a transition. The manifest is what brings across motion an author *keyframed*.

## Build and install

```bash
node tools/figma-motion-bridge/scripts/build.mjs
```

Then in Figma: **Plugins → Development → Import plugin from manifest…** and choose
`tools/figma-motion-bridge/manifest.json`.

The build inlines the converter from `@grapix/shared-types` because a plugin sandbox has no module
loader. That is deliberate rather than incidental: the bundled conversion is the same code
`Shared/shared-types/tests/figma-motion-bridge.test.mjs` covers, so it cannot drift from what the
importer expects. Rebuild after changing `Shared/shared-types/src/figmaMotionBridge.ts`.

## Use

1. Run the plugin. It lists every top-level frame, component and component set across **all**
   pages, with the number of animated layers in each — a broadcast file keeps lower thirds on one
   page and bugs on another, and an export covering only the open page would look like a plugin
   that lost half the motion.
2. Frames that animate are pre-selected. Frames that do not stay selectable, because a frame can be
   the destination of a Smart Animate transition without carrying tracks of its own.
3. **Export motion** downloads `grapix-figma-motion.json`.
4. In GrapiX: **Import Design File → Figma link**, set motion to **Full motion manifest**, and
   choose the file.

The frame ids in the manifest must match the nodes you import. If you import one frame and the
manifest covers three, the import report names the unmatched nodes rather than failing — the remedy
is to import the other frames, and it needs to say which.

## What crosses the bridge, and what cannot

GrapiX animates the channels in `ANIMATABLE_PROPERTIES`, which the render engine's `animation.rs`
samples every Program frame. Of what a Motion timeline can carry, that means:

| Figma field | GrapiX | Note |
| --- | --- | --- |
| `TRANSLATION_X` / `_Y` / `_XY` | `x`, `y` | Offsets from the layer's design position. `_XY` splits into two tracks. |
| `ROTATION` | `rotation` | Degrees about Z, the same convention the static import uses. |
| `SCALE_X` / `_Y` / `_XY` | `scaleX`, `scaleY` | Multipliers, so absolute rather than offsets. |
| `OPACITY` | `opacity` | 0→1 in both. The 0-100 Alpha in the object table is display only. |
| everything else | — | Reported, never authored. |

"Everything else" is the specification, not an omission: `WIDTH`, `HEIGHT`, the corner radii,
stroke and border weights, auto-layout spacing and grid gaps have no GrapiX animation channel, so
writing them somewhere plausible would author a scene that previews one way and airs another.
`PATH_TRIM_START` / `PATH_TRIM_END` look mappable — GrapiX does have trim paths — but they are not
an animation channel and `animation.rs` excludes path geometry deliberately, so a trim track can
only be reported. Each unsupported track is carried through with its original data and named in the
import report, so an author can see what their design contained and what GrapiX did with it.

Easing is reproduced exactly or sampled and *said* to be sampled. The seven polynomial presets and
a `CUSTOM_CUBIC_BEZIER` map onto GrapiX curves exactly. Springs do not: Figma Motion states a
normalized `bounce` and publishes no inverse of `physicalSpringToNormalized`, so a spring is baked
into keyframes that trace it — bounded to 48 keys so the result is still editable — and reported as
an approximation. Substituting the nearest preset for a spring would render different pixels with
nothing to show for it.

An easing bound to a variable resolves to no curve, because its value lives in a mode the export
cannot pick. The track still crosses; only the curve is absent.

## Privacy

`networkAccess` is `none`. The plugin reads the open document and hands the author a file. It never
contacts a server, so a motion export cannot become a way for an unreleased design to leave the
machine.
