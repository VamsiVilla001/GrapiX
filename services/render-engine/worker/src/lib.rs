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
//! GPU scene compositor. 3.16 maps SceneDocument order into cached source
//! textures, prepares resources per revision, and produces real Preview and
//! Program frames through GPU affine/opacity/source-over passes. Authored
//! Program refuses on T2/T3. CPU vector/glyph source preparation bridges the
//! pending GPU drawing steps 3.17/3.18; the CPU full-frame path remains the
//! headless/pixel reference. Identifier-only control fixtures are explicit
//! diagnostic frames and carry no authored scene content.
//!
//! Two rules here are load-bearing and were paid for once already in 1.x:
//! nothing that can be built once may be built per Program frame
//! (invariant 35), and a large stage is never one GPU texture: only tiles
//! become render targets (invariant 37).

pub mod blend;
pub mod clock;
pub mod colour_pipeline;
pub mod compositor;
pub mod emission;
pub mod engine;
pub mod gpu;
pub mod headless;
pub mod metrics;
pub mod mesh;
pub mod output_adapter;
pub mod prepared;
pub mod rasterise;
pub mod rasterizer;
pub mod recovery;
pub mod render_work;
pub mod support;
pub mod tiling;
pub mod text;

pub use clock::ProgramClock;
pub use emission::{FrameEmitter, ProgramEmission};
pub use engine::Engine;
pub use metrics::{EnginePerformance, FrameMetrics, FrameSample};
pub use mesh::{ActiveCamera, AssetBytes, PreparedMesh, PreparedMeshes};
pub use prepared::PreparedScene;
pub use headless::{RenderedImage, RenderedImages};
pub use rasterizer::{Frame, SoftwareRasterizer};
pub use text::{PreparedGlyph, PreparedTextObject, PreparedTexts};

pub use output_adapter::{
    NullOutputAdapter, OutputAdapter, OutputAdapterError, OutputAdapterRegistry,
    RecordingOutputAdapter, VirtualOutputAdapter,
};
