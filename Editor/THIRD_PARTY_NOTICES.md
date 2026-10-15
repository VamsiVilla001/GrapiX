# Editor UI references and assets

The timeline label palette in `src/timeline/layers.ts` is adapted from
EffectCraft's `crates/color/src/lib.rs`, copyright 2026 ArtCraft Team and
EffectCraft contributors. Used under the MIT licence in `EFFECTCRAFT-LICENSE`.

Properties interaction references: EffectCraft's `ui-egui` Properties transform
rows (`panels/properties.rs`) and `engine` property commands (`commands/prop.rs`):
inline evaluated values, key diamonds, and previous/next key navigation.
GrapiX implements these gestures through its own shared Rust command model.

The local toolbar and transport SVGs are unmodified Phosphor regular icons
from `@phosphor-icons/core` 2.1.1. Their MIT licence is retained in
`web/icons/LICENSE`. No Adobe artwork or application binaries are distributed.
