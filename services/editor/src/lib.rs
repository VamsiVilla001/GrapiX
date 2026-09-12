//! The headless Editor service (build plan 7.1, 7.2, 7.3).
//!
//! Import, validation and publish work before a designer sees a window. That
//! ordering is deliberate: a pipeline that only exists behind a UI can only be
//! tested through one, and the things that go wrong in import — a substitution
//! nobody noticed, a source that was not kept — are exactly the things a
//! screenshot does not reveal.
//!
//! **What this crate may not depend on.** Not `gx-render-worker`: invariant 3
//! forbids the Editor importing renderer internals. The rules it shares with
//! the engine arrive through `gx_contracts::validate` instead, which is the
//! whole reason 7.4 moved them there. If something here appears to need the
//! worker, the design is wrong rather than the invariant.

#![forbid(unsafe_code)]

pub mod fidelity;
pub mod import;
pub mod project;

pub use fidelity::{FidelityRecord, FidelityVerdict};
pub use import::{import_svg, ImportOutcome};
pub use project::{EditorError, Projects};
