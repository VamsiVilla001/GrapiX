//! What the software reference path cannot draw yet, refused by name (3.13).
//!
//! The checks live in `gx_contracts::drawability` so the Editor's validator
//! and this engine give the same answer from one implementation (invariant
//! 27). Preparation runs them again over the bound document, because a data
//! binding can set a value the authored document did not have.

pub use gx_contracts::drawability::refuse_what_the_software_path_cannot_draw;
