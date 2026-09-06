# After Effects project fixtures

These three `.aep` files were saved by After Effects itself and are vendored from
[`boltframe/aftereffects-aep-parser`](https://github.com/boltframe/aftereffects-aep-parser)
(`data/`), which is MIT licensed. They are the only After-Effects-authored projects in this
repository, and they are what makes `tests/ae-aep-native.test.mjs` evidence rather than opinion:
the values it asserts are the ones that project's own Go test suite asserts, so a wrong byte
offset in `src/ae/aepParser.ts` fails against a number After Effects wrote.

| File | What it isolates |
| --- | --- |
| `Item-01.aep` | The item tree: nested folders, two compositions with different geometry and frame rates (351×856 at 21 fps, 452×639 at 29.97), solids, and a placeholder for missing footage. |
| `Layer-01.aep` | Seventeen layers, each turning on exactly one switch — collapse/continuously-rasterize, effects, motion blur, locked, shy, adjustment, 3D, solo, guide, frame-blending mode, the three quality levels and both sampling modes. |
| `Property-01.aep` | A text layer (its document lives in the `btdk` COS payload) and a layer carrying all seven expression-control effects. |

Do not regenerate or "correct" these files, and do not relax an expectation in the test to make it
pass: the numbers are ground truth from the application. What they do **not** contain is a keyframe
or a mask — the reference projects only exercise metadata — which is why those two layouts are
pinned by synthetic chunk trees built inside the test instead.

## Testing against a real project

The three files above are tiny and metadata-only by design. A large, real project — with real
keyframes, masks, expressions and a deep item tree — is where a decode that is subtly wrong at
scale shows itself, but such a project is too big and not ours to vendor.

`tests/ae-aep-real-project.test.mjs` handles that with a **presence-guarded** test: point
`GRAPIX_AEP_FIXTURE` at any `.aep` and it runs; leave it unset and it skips, so CI and a fresh
clone stay green.

```
GRAPIX_AEP_FIXTURE="C:/path/to/Project.aep" npm test -w @grapix/adobe-common-schema
```

It asserts two kinds of thing: **invariants** true of any correct parse (parses without throwing,
no unrecognised degradation warning, every keyframe time finite, every stream carries keyframes or
an expression, every mask has a vertex array), and a **census tripwire** pinned to one specific
project — checked only when that project is the one loaded, identified by size and shape.

To see what the parser made of a project without running the suite, use the inspector:

```
node tools/ae/inspect-aep.mjs "C:/path/to/Project.aep"
```
