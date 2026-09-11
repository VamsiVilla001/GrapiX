//! Filesystem primitives shared by every product (build plan 2.1, 2.3, 2.5).
//!
//! These live in one crate because each of them is a rule about *how* the
//! three products touch a disk, and a second implementation of any of them
//! would drift (invariant 27). Nothing here knows what a scene, an asset or a
//! project is: this crate is below the contracts, not beside them.

#![forbid(unsafe_code)]

pub mod atomic;

pub use atomic::{write_atomic, write_atomic_with, AtomicWriteError};
