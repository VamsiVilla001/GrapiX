//! GPU device negotiation (ADR Part C: wgpu 30.0.1, moved from 26 on
//! 7 November 2026 by the user's decision; invariant 19).
//!
//! This is the *only* place the render worker learns what hardware it is
//! running on, and therefore the only place a device tier is decided. Every
//! other module asks for the tier; none of them sniffs an adapter name, which
//! is invariant 20: the tier is a negotiated fact, never an inference.
//!
//! The rule that matters here is the same one the contracts encode: a device
//! that cannot go to air is discovered and reported, never silently downgraded
//! *to*. If there is no real GPU, this module says so; authored Program
//! refuses at that tier. Explicit CPU reference/headless renders remain
//! available, and every capability exchange reports the negotiated tier.

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
    info: wgpu::AdapterInfo,
    device: wgpu::Device,
    queue: wgpu::Queue,
    max_texture_dimension_2d: u32,
}

/// Negotiate a device and the tier it supports.
///
/// Never fails: a machine with no usable GPU is a *tier*, not an error. The
/// caller runs whatever rasteriser the tier permits and reports the tier in
/// every capability exchange, so a control room learns the truth before it
/// tries to go live.
pub fn negotiate() -> Gpu {
    negotiate_backends(wgpu::Backends::PRIMARY | wgpu::Backends::GL)
}

#[cfg(test)]
pub(crate) fn negotiate_for_test(backends: wgpu::Backends) -> Gpu { negotiate_backends(backends) }

fn negotiate_backends(backends: wgpu::Backends) -> Gpu {
    // wgpu 30 has no `Default` for the descriptor; this is the same set of
    // defaults without a display handle (the worker is headless).
    // Choose FXC explicitly for the compositor's baseline WGSL. `Auto`
    // changes compiler according to DLL availability. A future drawing backend
    // requiring DXC must ship and select it explicitly, never fall back.
    let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
    descriptor.backend_options.dx12.shader_compiler = wgpu::Dx12Compiler::Fxc;
    descriptor.backends = backends;
    let instance = wgpu::Instance::new(descriptor);

    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        compatible_surface: None,
        apply_limit_buckets: false,
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
        experimental_features: wgpu::ExperimentalFeatures::disabled(),
        memory_hints: wgpu::MemoryHints::Performance,
        trace: wgpu::Trace::Off,
    }))
    .expect("a hardware adapter that negotiated must open a device");

    let max_texture_dimension_2d = device.limits().max_texture_dimension_2d;
    Gpu {
        inner: Some(GpuInner {
            info,
            device,
            queue,
            max_texture_dimension_2d,
        }),
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
    pub(crate) fn diagnostic_description(&self) -> Option<String> {
        self.inner.as_ref().map(|gpu| format!("{} ({:?})", gpu.info.name, gpu.info.backend))
    }

    #[cfg(test)]
    pub(crate) fn without_hardware(tier: DeviceTier) -> Self {
        assert!(!tier.live_capable());
        Self { inner: None, tier }
    }
    /// Internal device access for prepared GPU backends. A CPU adapter never
    /// receives these handles and cannot silently become a compositor.
    pub(crate) fn device_queue(&self) -> Option<(&wgpu::Device, &wgpu::Queue)> {
        self.inner.as_ref().map(|gpu| (&gpu.device, &gpu.queue))
    }

    /// The negotiated tier. The single answer every tier question gets.
    pub fn tier(&self) -> DeviceTier {
        self.tier
    }

    /// Whether a real GPU is present, as opposed to a software fallback.
    pub fn has_hardware(&self) -> bool {
        self.inner.is_some()
    }

    /// The maximum 2D texture dimension the negotiated device actually
    /// granted. A software/non-hardware tier has no GPU texture limit and
    /// returns `None`; it must not pretend that a guessed default is a device
    /// capability.
    pub fn max_texture_dimension_2d(&self) -> Option<u32> {
        self.inner.as_ref().map(|gpu| gpu.max_texture_dimension_2d)
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
