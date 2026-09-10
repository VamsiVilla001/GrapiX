//! GPU device negotiation (ADR Part C: wgpu 26; invariant 19).
//!
//! This is the *only* place the render worker learns what hardware it is
//! running on, and therefore the only place a device tier is decided. Every
//! other module asks for the tier; none of them sniffs an adapter name, which
//! is invariant 20: the tier is a negotiated fact, never an inference.
//!
//! The rule that matters here is the same one the contracts encode: a device
//! that cannot go to air is discovered and reported, never silently downgraded
//! *to*. If there is no real GPU, this module says so and the worker runs the
//! software rasteriser at a sub-T0 tier — degraded by construction, and
//! reported as such on every capability exchange.

use gx_contracts::DeviceTier;

/// The negotiated render device.
pub struct Gpu {
    /// `Some` only on a real GPU. A software adapter leaves this `None` even
    /// though wgpu handed back a device, because a CPU rasteriser must never
    /// be mistaken for hardware.
    inner: Option<GpuInner>,
    tier: DeviceTier,
}

struct GpuInner {
    #[allow(dead_code)]
    device: wgpu::Device,
    #[allow(dead_code)]
    queue: wgpu::Queue,
}

/// Negotiate a device and the tier it supports.
///
/// Never fails: a machine with no usable GPU is a *tier*, not an error. The
/// caller runs whatever rasteriser the tier permits and reports the tier in
/// every capability exchange, so a control room learns the truth before it
/// tries to go live.
pub fn negotiate() -> Gpu {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: wgpu::Backends::PRIMARY | wgpu::Backends::GL,
        ..Default::default()
    });

    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        compatible_surface: None,
    }))
    .ok();

    let Some(adapter) = adapter else {
        return Gpu {
            inner: None,
            tier: DeviceTier::T3,
        };
    };

    let info = adapter.get_info();
    let tier = tier_for(info.device_type);

    // On a sub-T0 device there is no point opening a device the worker will
    // refuse to treat as hardware. The software path is honest about being
    // software; a wrapped CPU adapter is not.
    if !tier.live_capable() {
        return Gpu { inner: None, tier };
    }

    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("grapix-render"),
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::default(),
        memory_hints: wgpu::MemoryHints::Performance,
        trace: wgpu::Trace::Off,
    }))
    .expect("a hardware adapter that negotiated must open a device");

    Gpu {
        inner: Some(GpuInner { device, queue }),
        tier,
    }
}

/// Map a wgpu device type onto the contract tier (ADR Part C).
///
/// Hardware GPU is T0, the only tier that may go to air. A CPU/software
/// adapter (SwiftShader, Lavapipe, WARP) is T2: CI and no-GPU environments,
/// never live. Anything we cannot classify is T3, the safest claim.
fn tier_for(device_type: wgpu::DeviceType) -> DeviceTier {
    match device_type {
        wgpu::DeviceType::DiscreteGpu | wgpu::DeviceType::IntegratedGpu => DeviceTier::T0,
        wgpu::DeviceType::Cpu => DeviceTier::T2,
        wgpu::DeviceType::VirtualGpu | wgpu::DeviceType::Other => DeviceTier::T3,
    }
}

impl Gpu {
    /// The negotiated tier. The single answer every tier question gets.
    pub fn tier(&self) -> DeviceTier {
        self.tier
    }

    /// Whether a real GPU is present, as opposed to a software fallback.
    pub fn has_hardware(&self) -> bool {
        self.inner.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_adapters_are_never_live_capable() {
        // The mapping is the whole point of invariant 19: a software device
        // must land on a tier that can never reach air.
        assert!(!tier_for(wgpu::DeviceType::Cpu).live_capable());
        assert!(tier_for(wgpu::DeviceType::DiscreteGpu).live_capable());
        assert!(tier_for(wgpu::DeviceType::IntegratedGpu).live_capable());
    }
}
