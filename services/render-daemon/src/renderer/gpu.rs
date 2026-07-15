//! Headless wgpu device initialization. No window, no surface — the daemon
//! renders into off-screen textures only.

use anyhow::Context;

pub struct GpuContext {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub adapter_info: wgpu::AdapterInfo,
}

impl GpuContext {
    pub async fn new() -> anyhow::Result<Self> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());

        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                compatible_surface: None,
                force_fallback_adapter: false,
            })
            .await
            .context("no GPU adapter available for headless rendering")?;

        let adapter_info = adapter.get_info();

        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("grapix-render-daemon"),
                ..Default::default()
            })
            .await
            .context("failed to create wgpu device")?;

        tracing::info!(
            adapter = %adapter_info.name,
            backend = %adapter_info.backend,
            "gpu device ready"
        );

        Ok(Self {
            device,
            queue,
            adapter_info,
        })
    }
}
