//! Deterministic raw-BGRA recording output for diagnostics and certification.

use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::PathBuf;

use crate::config::OutputConfig;
use crate::output::{VideoFrame, VideoOutput};

#[derive(Default)]
pub struct RecordingOutput {
    config: Option<OutputConfig>,
    writer: Option<BufWriter<File>>,
    path: Option<PathBuf>,
}

impl VideoOutput for RecordingOutput {
    fn configure(&mut self, config: &OutputConfig) -> anyhow::Result<()> {
        anyhow::ensure!(
            self.writer.is_none(),
            "cannot reconfigure an active recording"
        );
        self.config = Some(config.clone());
        Ok(())
    }

    fn start(&mut self) -> anyhow::Result<()> {
        let config = self
            .config
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("recording started before configure()"))?;
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data/recordings");
        fs::create_dir_all(&root)?;
        let path = root.join(format!("{}.gfxraw", config.recording_name));
        let mut writer = BufWriter::new(File::create(&path)?);
        writeln!(
            writer,
            "GFXRAW1 {} {} {}/{} BGRA8_SRGB_PREMULTIPLIED",
            config.width, config.height, config.frame_rate.numerator, config.frame_rate.denominator
        )?;
        self.path = Some(path.clone());
        self.writer = Some(writer);
        tracing::info!(path = %path.display(), "raw frame recording started");
        Ok(())
    }

    fn send_frame(&mut self, frame: &VideoFrame) -> anyhow::Result<()> {
        let writer = self
            .writer
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("recording received a frame before start()"))?;
        writer.write_all(&frame.frame_index.to_le_bytes())?;
        writer.write_all(&(frame.data.len() as u64).to_le_bytes())?;
        writer.write_all(&frame.data)?;
        Ok(())
    }

    fn stop(&mut self) -> anyhow::Result<()> {
        if let Some(mut writer) = self.writer.take() {
            writer.flush()?;
        }
        tracing::info!(
            path = ?self.path.as_ref().map(|path| path.display().to_string()),
            "raw frame recording stopped"
        );
        Ok(())
    }

    fn name(&self) -> &'static str {
        "recording"
    }
}
