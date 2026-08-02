//! Retired compatibility boundary for the former daemon-owned NDI sender.
//!
//! Program pixels, the dynamically loaded NDI SDK, and its transmission worker
//! are exclusively owned by `grapix-render-engine::outputs::NdiSink`. The render
//! core cannot re-export that type because the Engine depends on this crate, so
//! this compatibility type deliberately refuses all lifecycle operations instead
//! of ever becoming a second sender path.

use crate::config::OutputConfig;
use crate::output::{VideoFrame, VideoOutput};

pub struct NdiOutput;

impl NdiOutput {
    pub fn new() -> anyhow::Result<Self> {
        anyhow::bail!(
            "NDI transmission moved to grapix-render-engine; configure the Engine-owned output instead"
        )
    }
}

impl VideoOutput for NdiOutput {
    fn configure(&mut self, _config: &OutputConfig) -> anyhow::Result<()> {
        anyhow::bail!(
            "NDI transmission moved to grapix-render-engine; the render core cannot own an NDI sender"
        )
    }

    fn start(&mut self) -> anyhow::Result<()> {
        anyhow::bail!("NDI transmission moved to grapix-render-engine")
    }

    fn send_frame(&mut self, _frame: &VideoFrame) -> anyhow::Result<()> {
        anyhow::bail!("NDI transmission moved to grapix-render-engine")
    }

    fn stop(&mut self) -> anyhow::Result<()> {
        Ok(())
    }

    fn name(&self) -> &'static str {
        "ndi-retired"
    }
}
