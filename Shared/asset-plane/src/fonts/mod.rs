//! The font subsystem, ported from 1.x (ADR-0002 A.4: carried forward
//! unchanged — port, don't redesign). 1.x was TypeScript with `fontkit`; the
//! 2.0 port is Rust with `ttf-parser`, per invariant 22's Rust-source-of-truth
//! rule. Behaviour is the contract; the module names follow the 1.x files so
//! the correspondence is auditable:
//!
//! - `metadata` ← `fonts/fontMetadata.ts` (inspect bytes: family, weight, style, licence)
//! - `container` ← the 1.x WOFF/WOFF2 handling (decode transport wrappers to sfnt)
//! - `css` ← `fonts/cssFontParser.ts` (inert `@font-face`/`@import` parsing)
//! - `manager` ← `fontManager.ts` (definition construction, identity)
//! - `ingest` ← the 1.x `/api/fonts/import` route (batch file ingest)
//! - `link` ← `fonts/remoteFontResolver.ts` (download a font link into the project)
//! - `cssgen` ← `buildFontCss`/`buildFontFamilyStack` in shared-types
//! - `validate` ← `validateFontDefinition` in shared-types
//!
//! Networking is confined to `link`, behind the `FontFetcher` trait; every
//! other module is pure, so the validator and the engine apply the same rules.
//! Ingest prepares a scene batch and caches verified bytes; it never edits a
//! scene — that is one Editor command (invariant 60).

pub mod container;
pub mod css;
pub mod cssgen;
pub mod ingest;
pub mod link;
pub mod manager;
pub mod metadata;
pub mod validate;
