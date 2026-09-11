#![forbid(unsafe_code)]

//! gx-render-worker
//!
//! Native Rust/wgpu render worker: owns the GPU device, the scene runtime,
//! tiling and Program frame production. This is the only code permitted to
//! rasterize production scene pixels (invariant 2).
//!
//! **Status: Partial.** The engine now produces real Program frames and
//! serves the control plane as a live peer: device tier is negotiated from
//! hardware, the clock is engine-owned (ADR-002), and a committed take drives
//! a rasteriser. What is not here yet is a *scene* renderer — the control
//! plane has no scene-content contract, so Program is a deterministic take
//! key, not drawn scene content. GPU-accelerated scene rasterisation remains
//! later work; tiling already enforces the render-target limit in the
//! software path (T2) that runs today.
//!
//! Two rules here are load-bearing and were paid for once already in 1.x:
//! nothing that can be built once may be built per Program frame
//! (invariant 35), and a large stage is never one GPU texture: only tiles
//! become render targets (invariant 37).

pub mod clock;
pub mod colour_pipeline;
pub mod emission;
pub mod engine;
pub mod gpu;
pub mod metrics;
pub mod mesh;
pub mod output_adapter;
pub mod prepared;
pub mod rasterise;
pub mod rasterizer;
pub mod recovery;
pub mod tiling;
pub mod text;

pub use clock::ProgramClock;
pub use emission::{FrameEmitter, ProgramEmission};
pub use engine::Engine;
pub use metrics::{EnginePerformance, FrameMetrics, FrameSample};
pub use mesh::{ActiveCamera, AssetBytes, PreparedMesh, PreparedMeshes};
pub use prepared::PreparedScene;
pub use rasterizer::{Frame, SoftwareRasterizer};
pub use text::{PreparedGlyph, PreparedTextObject, PreparedTexts};

pub use output_adapter::{
    NullOutputAdapter, OutputAdapter, OutputAdapterError, OutputAdapterRegistry,
    RecordingOutputAdapter, VirtualOutputAdapter,
};
