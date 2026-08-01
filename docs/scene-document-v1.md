# SceneDocument v1 contract

`SceneDocument.version` is frozen at the literal value `1`. It is the durable
authoring and interchange contract shared by the editor, project service,
package builder, and native renderer.

## Compatibility rules

- A v1 change may add an optional field when every reader has a deterministic
  default and old documents retain their previous visual meaning.
- A required field, renamed field, removed field, changed unit, changed
  coordinate system, or changed semantic meaning requires a new document
  version and an explicit migration.
- Runtime-only state does not belong in the document. Preview/Program
  selection, warm-cache state, GPU handles, decoder handles, frame counters,
  and editor viewport navigation remain process state.
- Binary media is referenced through asset metadata; it is not embedded in
  scene JSON.
- `updatedAt` is the current v1 renderer revision. A future content revision or
  hash may replace it only through an explicit protocol/schema change.

## Read and migration boundary

All document entry points must normalize optional v1 fields before use. The
current normalization boundary is `normalizeMaterialSceneDocument`; editor
load paths additionally apply their editor defaults. New optional fields must
be added to this boundary with an idempotent default.

Unknown document versions must be rejected rather than coerced. When v2 is
introduced, migrations will be explicit pure functions:

```text
raw JSON -> identify version -> migrate one version at a time -> normalize -> validate -> use
```

Saving always writes the current version. Migration must never mutate the
source object and must preserve unknown asset files.

## Contract verification

- TypeScript fixtures are authored against the real `SceneDocument` type.
- `Shared/shared-types` emits the fixtures used by Rust tests.
- `services/render-daemon/tests/scene_contract.rs` proves the native DTO can
  read the shared fixture.
- Visual or semantic renderer changes require parity fixtures in addition to
  successful JSON parsing.

The renderer transport has its own independent version in
`@grapix/render-protocol` (protocol v3); changing one version does not
automatically change the other.
