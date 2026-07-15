//! Scene ingestion: `SceneDocument` JSON -> renderer-ready state.

mod document;

pub use document::{prepare_scene, PreparedRect, PreparedScene, SceneError};
