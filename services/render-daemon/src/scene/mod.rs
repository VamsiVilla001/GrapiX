//! Scene ingestion: `SceneDocument` JSON -> renderer-ready state.

mod diagnostics;
mod document;
mod lifecycle;
mod mesh_prepare;

pub use diagnostics::{DiagnosticSeverity, DiagnosticSink, SceneDiagnostic};
pub use document::{
    prepare_scene, PreparedGradient, PreparedLight, PreparedLightKind, PreparedRect, PreparedScene,
    SceneError, MAX_PREPARED_LIGHTS,
};
pub use lifecycle::{
    estimate_prepared_scene_bytes, SceneLifecycle, SceneLifecycleStatus, SceneRegistry,
    SceneRegistryError, DEFAULT_MAX_PREPARED_CACHE_BYTES, DEFAULT_MAX_WARM_SCENES,
};
pub use mesh_prepare::{
    PreparedCullMode, PreparedFilterMode, PreparedMesh, PreparedMeshMaterial, PreparedMeshSurface,
    PreparedMeshVertex, PreparedTexture, PreparedWrapMode,
};
