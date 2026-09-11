//! The font subsystem, ported from 1.x (ADR-0002 A.4: carried forward
//! unchanged — port, don't redesign). 1.x was TypeScript with `fontkit`; the
//! 2.0 port is Rust with `ttf-parser`, per invariant 22's Rust-source-of-truth
//! rule. Behaviour is the contract; the module names follow the 1.x files so
//! the correspondence is auditable:
//!
//! - `metadata` ← `fonts/fontMetadata.ts` (inspect bytes: family, weight, style)
//! - `css` ← `fonts/cssFontParser.ts` (inert `@font-face`/`@import` parsing)
//! - `manager` ← `fontManager.ts` (definition construction, identity)
//! - `cssgen` ← `buildFontCss`/`buildFontFamilyStack` in shared-types
//! - `validate` ← `validateFontDefinition` in shared-types
//!
//! Networking deliberately absent: downloading remote fonts is an Editor
//! service concern (2.8's full port includes the resolver); everything here
//! is pure, so the validator and the engine apply the same rules.

pub mod css;
pub mod cssgen;
pub mod manager;
pub mod metadata;
pub mod validate;
