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

/// Placeholder so the crate has a compiled surface and the workspace builds.
/// Replaced by the real device/tier negotiation in M2.
pub fn planned() -> gx_contracts::Refusal {
    gx_contracts::Refusal::NotImplemented {
        what: "render worker".to_string(),
    }
}
