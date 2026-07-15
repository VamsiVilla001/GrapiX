//! Null output: swallows frames while keeping full pipeline behavior.
//! Used for development, CI, and environments without the NDI SDK.

use crate::config::OutputConfig;
use crate::output::{VideoFrame, VideoOutput};

#[derive(Debug, Default)]
pub struct NullOutput {
    started: bool,
    frames_received: u64,
}

impl VideoOutput for NullOutput {
    fn configure(&mut self, config: &OutputConfig) -> anyhow::Result<()> {
        tracing::info!(
            width = config.width,
            height = config.height,
            fps = format!(
                "{}/{}",
                config.frame_rate.numerator, config.frame_rate.denominator
            ),
            "null output configured"
        );

        Ok(())
    }

    fn start(&mut self) -> anyhow::Result<()> {
        self.started = true;
        self.frames_received = 0;
        tracing::info!("null output started");

        Ok(())
    }

    fn send_frame(&mut self, frame: &VideoFrame) -> anyhow::Result<()> {
        anyhow::ensure!(self.started, "null output received a frame before start()");

        self.frames_received += 1;

        if self.frames_received == 1 || self.frames_received % 300 == 0 {
            tracing::info!(
                frames = self.frames_received,
                frame_index = frame.frame_index,
                bytes = frame.data.len(),
                "null output consuming frames"
            );
        }

        Ok(())
    }

    fn stop(&mut self) -> anyhow::Result<()> {
        self.started = false;
        tracing::info!(frames = self.frames_received, "null output stopped");

        Ok(())
    }

    fn name(&self) -> &'static str {
        "null"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{OutputConfig, OutputConfigMessage};

    fn test_config() -> OutputConfig {
        OutputConfig::from_message(OutputConfigMessage {
            width: 64,
            height: 36,
            frame_rate_numerator: 50,
            frame_rate_denominator: 1,
            scan_mode: crate::config::ScanMode::Progressive,
            alpha_mode: crate::config::AlphaMode::Premultiplied,
            color_format: crate::config::ColorFormat::Bgra8,
            color_space: crate::config::ColorSpace::Srgb,
            ndi_source_name: "Test".to_string(),
            backend: Some(crate::config::OutputBackend::Null),
        })
        .expect("test config must validate")
    }

    #[test]
    fn accepts_frames_only_after_start() {
        let mut output = NullOutput::default();
        output.configure(&test_config()).unwrap();

        let frame = VideoFrame {
            width: 64,
            height: 36,
            data: vec![0; 64 * 36 * 4],
            frame_index: 0,
        };

        assert!(
            output.send_frame(&frame).is_err(),
            "must reject frames before start"
        );

        output.start().unwrap();
        output.send_frame(&frame).unwrap();
        assert_eq!(output.frames_received, 1);

        output.stop().unwrap();
    }
}
