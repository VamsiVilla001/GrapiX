//! Native media lifecycle and bounded decoded-frame queue.
//!
//! This module owns the production invariants independently of any eventual
//! FFmpeg/Media Foundation decoder binding: decoders are scarce, preroll is
//! mandatory, queues are bounded, and selection follows the renderer clock.

use std::collections::{HashMap, VecDeque};

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum MediaLifecycle {
    Closed,
    Opening,
    Preroll,
    Ready,
    Playing,
    Paused,
    Draining,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndOfFilePolicy {
    Hold,
    Loop,
    Transparent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DroppedFramePolicy {
    LatestAtOrBeforeClock,
}

#[derive(Debug, Clone)]
pub struct DecodedVideoFrame {
    pub presentation_time_nanos: u64,
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum MediaError {
    #[error("invalid media transition {from:?} -> {to:?}")]
    InvalidTransition {
        from: MediaLifecycle,
        to: MediaLifecycle,
    },
    #[error("media stream {0:?} is already registered")]
    DuplicateStream(String),
    #[error("media stream {0:?} is not registered")]
    UnknownStream(String),
    #[error("decoder limit {limit} reached")]
    DecoderLimit { limit: usize },
    #[error("decoded frame has invalid BGRA byte length")]
    InvalidFrame,
}

pub struct MediaStream {
    lifecycle: MediaLifecycle,
    frames: VecDeque<DecodedVideoFrame>,
    queue_capacity: usize,
    pub eof_policy: EndOfFilePolicy,
    pub dropped_frame_policy: DroppedFramePolicy,
}

impl MediaStream {
    pub fn new(queue_capacity: usize) -> Self {
        Self {
            lifecycle: MediaLifecycle::Closed,
            frames: VecDeque::with_capacity(queue_capacity.max(1)),
            queue_capacity: queue_capacity.max(1),
            eof_policy: EndOfFilePolicy::Hold,
            dropped_frame_policy: DroppedFramePolicy::LatestAtOrBeforeClock,
        }
    }

    pub fn lifecycle(&self) -> MediaLifecycle {
        self.lifecycle
    }

    pub fn transition(&mut self, next: MediaLifecycle) -> Result<(), MediaError> {
        use MediaLifecycle::*;
        let valid = matches!(
            (self.lifecycle, next),
            (Closed, Opening)
                | (Opening, Preroll)
                | (Opening, Failed)
                | (Preroll, Ready)
                | (Preroll, Failed)
                | (Ready, Playing)
                | (Ready, Draining)
                | (Playing, Paused)
                | (Playing, Draining)
                | (Playing, Failed)
                | (Paused, Playing)
                | (Paused, Draining)
                | (Paused, Failed)
                | (Draining, Closed)
                | (Failed, Closed)
        );
        if !valid {
            return Err(MediaError::InvalidTransition {
                from: self.lifecycle,
                to: next,
            });
        }
        self.lifecycle = next;
        if next == MediaLifecycle::Closed {
            self.frames.clear();
        }
        Ok(())
    }

    pub fn push_decoded(&mut self, frame: DecodedVideoFrame) -> Result<(), MediaError> {
        let expected = frame.width as usize * frame.height as usize * 4;
        if frame.bgra.len() != expected {
            return Err(MediaError::InvalidFrame);
        }
        while self.frames.len() >= self.queue_capacity {
            self.frames.pop_front();
        }
        self.frames.push_back(frame);
        Ok(())
    }

    /// Select latest frame at-or-before the authoritative renderer timestamp,
    /// dropping obsolete frames and retaining one held frame for pause/slowdown.
    pub fn select_for_clock(&mut self, renderer_time_nanos: u64) -> Option<&DecodedVideoFrame> {
        while self.frames.len() > 1
            && self.frames.get(1)?.presentation_time_nanos <= renderer_time_nanos
        {
            self.frames.pop_front();
        }
        self.frames
            .front()
            .filter(|frame| frame.presentation_time_nanos <= renderer_time_nanos)
    }

    pub fn queued_frames(&self) -> usize {
        self.frames.len()
    }
}

pub struct MediaManager {
    streams: HashMap<String, MediaStream>,
    max_decoders: usize,
}

impl MediaManager {
    pub fn new(max_decoders: usize) -> Self {
        Self {
            streams: HashMap::new(),
            max_decoders,
        }
    }

    pub fn register(&mut self, asset_id: &str, queue_capacity: usize) -> Result<(), MediaError> {
        if self.streams.contains_key(asset_id) {
            return Err(MediaError::DuplicateStream(asset_id.to_string()));
        }
        if self.streams.len() >= self.max_decoders {
            return Err(MediaError::DecoderLimit {
                limit: self.max_decoders,
            });
        }
        self.streams
            .insert(asset_id.to_string(), MediaStream::new(queue_capacity));
        Ok(())
    }

    pub fn stream_mut(&mut self, asset_id: &str) -> Result<&mut MediaStream, MediaError> {
        self.streams
            .get_mut(asset_id)
            .ok_or_else(|| MediaError::UnknownStream(asset_id.to_string()))
    }

    pub fn release(&mut self, asset_id: &str) {
        self.streams.remove(asset_id);
    }

    pub fn set_max_decoders(&mut self, max_decoders: usize) {
        self.max_decoders = max_decoders;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(pts: u64) -> DecodedVideoFrame {
        DecodedVideoFrame {
            presentation_time_nanos: pts,
            width: 1,
            height: 1,
            bgra: vec![0, 0, 0, 255],
        }
    }

    #[test]
    fn enforces_preroll_before_playback() {
        let mut stream = MediaStream::new(3);
        assert!(stream.transition(MediaLifecycle::Playing).is_err());
        stream.transition(MediaLifecycle::Opening).unwrap();
        stream.transition(MediaLifecycle::Preroll).unwrap();
        stream.push_decoded(frame(0)).unwrap();
        stream.transition(MediaLifecycle::Ready).unwrap();
        stream.transition(MediaLifecycle::Playing).unwrap();
        assert_eq!(stream.lifecycle(), MediaLifecycle::Playing);
    }

    #[test]
    fn bounded_queue_keeps_latest_and_follows_renderer_clock() {
        let mut stream = MediaStream::new(3);
        for pts in [0, 10, 20, 30] {
            stream.push_decoded(frame(pts)).unwrap();
        }
        assert_eq!(stream.queued_frames(), 3);
        assert_eq!(
            stream.select_for_clock(25).unwrap().presentation_time_nanos,
            20
        );
        assert_eq!(stream.queued_frames(), 2);
    }

    #[test]
    fn manager_enforces_decoder_budget() {
        let mut manager = MediaManager::new(1);
        manager.register("video_a", 3).unwrap();
        assert_eq!(
            manager.register("video_b", 3),
            Err(MediaError::DecoderLimit { limit: 1 })
        );
        manager.release("video_a");
        manager.register("video_b", 3).unwrap();
    }
}
