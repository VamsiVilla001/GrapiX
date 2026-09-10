//! gx-render-worker
//!
//! Status: **Planned**. Skeleton only.
//!
//! Native Rust/wgpu render worker: owns the GPU device, the scene runtime,
//! tiling and Program frame production. This is the only code permitted to
//! rasterize production scene pixels (invariant 2).
//!
//! Two rules here are load-bearing and were paid for once already in 1.x:
//! nothing that can be built once may be built per Program frame
//! (invariant 35), and a large stage is never one GPU texture: only tiles
//! become render targets (invariant 37).

pub mod clock;

pub use clock::ProgramClock;

/// Device and tier negotiation, scene evaluation and frame production are
/// still **Planned**. `clock` is the first real part of this crate: ADR-002
/// puts clock authority here, and the clock is testable without a GPU.
pub fn rasterizer_status() -> gx_contracts::Refusal {
    gx_contracts::Refusal::NotImplemented {
        what: "render worker rasterizer".to_string(),
    }
}
