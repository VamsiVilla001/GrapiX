//! Program and Preview frame emission without consumer backpressure.
//!
//! Rendering owns the cadence; confidence and Program consumers only observe
//! its latest result. Two [`gx_media_plane::LatestFrameSlot`]s make that rule a
//! data-structure property: a stalled consumer replaces an unread frame and
//! increments a reasoned drop counter instead of delaying the clock.

use std::sync::Arc;

use gx_media_plane::{DropCause, DropCounters, LatestFrameSlot};

use crate::metrics::FrameSample;
use crate::rasterizer::Frame;

/// The rendered Program pixels and their one graph-consumed performance sample.
#[derive(Debug, Clone)]
pub struct ProgramEmission {
    /// Shared by Program, Preview and adapters without copying pixel bytes.
    pub frame: Arc<Frame>,
    /// Measurements from this exact render and its bounded slots.
    pub sample: FrameSample,
}

/// Emits Program and Preview through independent one-frame slots.
impl Default for FrameEmitter {
    fn default() -> Self {
        Self {
            preview: LatestFrameSlot::new(),
            program: LatestFrameSlot::new(),
        }
    }
}

#[derive(Debug)]
pub struct FrameEmitter {
    preview: LatestFrameSlot<Arc<Frame>>,
    program: LatestFrameSlot<Arc<Frame>>,
}

impl FrameEmitter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Publish one preview frame and its corresponding Program frame.
    ///
    /// They are distinct allocations because preview is sRGB while Program is
    /// Rec.709. There is no waiting operation: a preview stall can only
    /// overwrite its previous frame and cannot prevent Program publication.
    pub fn emit(&mut self, preview: Arc<Frame>, program: Arc<Frame>) {
        self.preview.publish(preview, DropCause::ConsumerBusy);
        self.program.publish(program, DropCause::ConsumerBusy);
    }

    /// Take the freshest preview frame. It never reaches a live adapter.
    pub fn take_preview(&mut self) -> Option<Arc<Frame>> {
        self.preview.take()
    }

    /// Take the freshest Program frame for a non-adapter consumer.
    pub fn take_program(&mut self) -> Option<Arc<Frame>> {
        self.program.take()
    }

    /// Cause-specific drops from the preview slot.
    pub fn preview_drops(&self) -> DropCounters {
        self.preview.drops()
    }

    /// Cause-specific drops from the Program slot.
    pub fn program_drops(&self) -> DropCounters {
        self.program.drops()
    }

    /// Total drops in both media slots for the common graph sample.
    pub fn total_drops(&self) -> u64 {
        let preview = self.preview_drops();
        let program = self.program_drops();
        preview.consumer_busy
            + preview.encoder_saturated
            + preview.transport_full
            + program.consumer_busy
            + program.encoder_saturated
            + program.transport_full
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(byte: u8) -> Arc<Frame> {
        Arc::new(Frame {
            width: 1,
            height: 1,
            pixels: vec![byte, byte, byte, byte],
        })
    }

    #[test]
    fn a_stalled_preview_drops_its_old_frame_without_blocking_program() {
        let mut emitter = FrameEmitter::new();
        emitter.emit(frame(17), frame(7));
        let _program_consumer = emitter.take_program().unwrap();

        emitter.emit(frame(18), frame(8));

        assert_eq!(emitter.preview_drops().consumer_busy, 1);
        assert_eq!(emitter.program_drops().consumer_busy, 0);
        assert_eq!(emitter.take_program().unwrap().pixels, [8, 8, 8, 8]);
        assert_eq!(emitter.take_preview().unwrap().pixels, [18, 18, 18, 18]);
    }
}
