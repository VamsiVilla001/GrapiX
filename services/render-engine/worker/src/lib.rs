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
//! key, not drawn scene content. GPU-accelerated rasterisation and tiling land
//! with the scene contract (M2/M3); the software path (T2) is what runs
//! today.
//!
//! Two rules here are load-bearing and were paid for once already in 1.x:
//! nothing that can be built once may be built per Program frame
//! (invariant 35), and a large stage is never one GPU texture: only tiles
//! become render targets (invariant 37).

pub mod clock;
pub mod engine;
pub mod gpu;
pub mod rasterizer;

pub use clock::ProgramClock;
pub use engine::Engine;
pub use rasterizer::{Frame, SoftwareRasterizer};
