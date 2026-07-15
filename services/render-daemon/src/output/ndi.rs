//! NDI output backend, compiled only with `--features ndi`.
//!
//! Written against grafton-ndi 1.0.0 (Rust bindings for the NDI 6 SDK).
//! Building this module requires the NDI SDK and an LLVM toolchain installed
//! locally — see the crate README for setup. It is intentionally NOT part of
//! the default feature set so the daemon builds and tests in environments
//! without the SDK.
//!
//! CAUTION: this backend has not been compiled or run in an environment
//! without the NDI SDK available to this repository's CI; validate on a
//! machine with the SDK before relying on it on air. In particular, confirm
//! NDI's expected alpha semantics for BGRA sources against the SDK
//! documentation (the daemon produces premultiplied alpha; see
//! packages/render-shaders/docs/shader-contract.md).

use grafton_ndi::{PixelFormat, Sender, SenderOptions, VideoFrame as NdiVideoFrame, NDI};

use crate::config::OutputConfig;
use crate::output::{VideoFrame, VideoOutput};

pub struct NdiOutput {
    ndi: NDI,
    sender: Option<Sender>,
    config: Option<OutputConfig>,
}

impl NdiOutput {
    pub fn new() -> anyhow::Result<Self> {
        Ok(Self {
            ndi: NDI::new()?,
            sender: None,
            config: None,
        })
    }
}

impl VideoOutput for NdiOutput {
    fn configure(&mut self, config: &OutputConfig) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.sender.is_none(),
            "cannot reconfigure NDI output while running"
        );
        self.config = Some(config.clone());

        Ok(())
    }

    fn start(&mut self) -> anyhow::Result<()> {
        let config = self
            .config
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("NDI output started before configure()"))?;

        let options = SenderOptions::builder(&config.ndi_source_name)
            .clock_video(true)
            .build();

        self.sender = Some(Sender::new(&self.ndi, &options)?);
        tracing::info!(source = %config.ndi_source_name, "ndi sender started");

        Ok(())
    }

    fn send_frame(&mut self, frame: &VideoFrame) -> anyhow::Result<()> {
        let config = self
            .config
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("NDI output has no configuration"))?;
        let sender = self
            .sender
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("NDI output received a frame before start()"))?;

        let mut ndi_frame = NdiVideoFrame::builder()
            .resolution(frame.width as i32, frame.height as i32)
            .pixel_format(PixelFormat::BGRA)
            .frame_rate(
                config.frame_rate.numerator as i32,
                config.frame_rate.denominator as i32,
            )
            .build()?;

        ndi_frame.data_mut().copy_from_slice(&frame.data);
        sender.send_video(&ndi_frame);

        Ok(())
    }

    fn stop(&mut self) -> anyhow::Result<()> {
        self.sender = None;
        tracing::info!("ndi sender stopped");

        Ok(())
    }

    fn name(&self) -> &'static str {
        "ndi"
    }
}
