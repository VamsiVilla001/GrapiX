//! Video output abstraction.
//!
//! The renderer never talks to an NDI crate directly; it produces
//! [`VideoFrame`]s and the daemon feeds them to a [`VideoOutput`]
//! implementation. This keeps the renderer decoupled from any one NDI
//! binding and lets development/CI run with [`null::NullOutput`] when the
//! NDI SDK is unavailable.

pub mod null;

#[cfg(feature = "ndi")]
pub mod ndi;

use crate::config::{OutputBackend, OutputConfig};

/// One rendered frame: tightly packed BGRA (width * 4 bytes per row),
/// sRGB-encoded bytes, premultiplied alpha — per the shader contract.
#[derive(Debug, Clone)]
pub struct VideoFrame {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
    pub frame_index: u64,
}

pub trait VideoOutput: Send {
    fn configure(&mut self, config: &OutputConfig) -> anyhow::Result<()>;
    fn start(&mut self) -> anyhow::Result<()>;
    fn send_frame(&mut self, frame: &VideoFrame) -> anyhow::Result<()>;
    fn stop(&mut self) -> anyhow::Result<()>;
    /// Backend name for logs and status reports.
    fn name(&self) -> &'static str;
}

/// Instantiate the backend selected by the validated config.
pub fn create_output(config: &OutputConfig) -> anyhow::Result<Box<dyn VideoOutput>> {
    match config.backend {
        OutputBackend::Null => Ok(Box::new(null::NullOutput::default())),
        OutputBackend::Ndi => {
            #[cfg(feature = "ndi")]
            {
                Ok(Box::new(ndi::NdiOutput::new()?))
            }
            #[cfg(not(feature = "ndi"))]
            {
                // Config validation already rejects this; guard again so the
                // invariant lives next to the dispatch.
                anyhow::bail!(
                    "NDI backend requested but the daemon was compiled without the `ndi` feature"
                )
            }
        }
    }
}
