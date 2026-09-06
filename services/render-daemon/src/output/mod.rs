//! Video output abstraction.
//!
//! The renderer never talks to an NDI crate directly; it produces
//! [`VideoFrame`]s and the daemon feeds them to a [`VideoOutput`]
//! implementation. This keeps the renderer decoupled from any one NDI
//! binding and lets development/CI run with [`null::NullOutput`] when the
//! NDI SDK is unavailable.

pub mod null;
pub mod recording;

#[cfg(feature = "ndi")]
pub mod ndi;

use std::sync::mpsc::{self, Receiver, SyncSender, TryRecvError};

use crate::config::{OutputBackend, OutputConfig};

/// A fixed-capacity frame slab returned to its producer when the output thread
/// drops the frame. This is a lease, not a growing per-frame `Vec`.
#[derive(Debug)]
pub struct VideoFrameLease {
    bytes: Option<Box<[u8]>>,
    return_tx: SyncSender<Box<[u8]>>,
}

impl VideoFrameLease {
    pub fn as_slice(&self) -> &[u8] {
        self.bytes.as_deref().expect("frame lease must own bytes")
    }

    pub fn as_mut_slice(&mut self) -> &mut [u8] {
        self.bytes.as_deref_mut().expect("frame lease must own bytes")
    }
}

impl std::ops::Deref for VideoFrameLease {
    type Target = [u8];

    fn deref(&self) -> &Self::Target {
        self.as_slice()
    }
}

impl std::ops::DerefMut for VideoFrameLease {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.as_mut_slice()
    }
}

impl Drop for VideoFrameLease {
    fn drop(&mut self) {
        if let Some(bytes) = self.bytes.take() {
            let _ = self.return_tx.try_send(bytes);
        }
    }
}

/// Preallocates a bounded number of exactly-sized output slabs at configure
/// time. A full pool refuses the next render rather than allocating or growing.
pub struct VideoFramePool {
    free_rx: Receiver<Box<[u8]>>,
    return_tx: SyncSender<Box<[u8]>>,
    byte_length: usize,
}

impl VideoFramePool {
    pub fn new(slot_count: usize, byte_length: usize) -> anyhow::Result<Self> {
        anyhow::ensure!(slot_count > 0, "frame pool needs at least one slot");
        anyhow::ensure!(byte_length > 0, "frame pool byte length must be positive");
        let (return_tx, free_rx) = mpsc::sync_channel(slot_count);
        for _ in 0..slot_count {
            return_tx.send(vec![0_u8; byte_length].into_boxed_slice())
                .map_err(|_| anyhow::anyhow!("frame pool initialization failed"))?;
        }
        Ok(Self { free_rx, return_tx, byte_length })
    }

    pub fn try_acquire(&self) -> Option<VideoFrameLease> {
        match self.free_rx.try_recv() {
            Ok(bytes) => Some(VideoFrameLease { bytes: Some(bytes), return_tx: self.return_tx.clone() }),
            Err(TryRecvError::Empty | TryRecvError::Disconnected) => None,
        }
    }

    pub fn byte_length(&self) -> usize {
        self.byte_length
    }
}

/// One rendered frame holding a lease from the bounded renderer/output pool.
/// The output must not retain it after `send_frame` returns.
#[derive(Debug)]
pub struct VideoFrame {
    pub width: u32,
    pub height: u32,
    pub data: VideoFrameLease,
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
        OutputBackend::Recording => Ok(Box::new(recording::RecordingOutput::default())),
        OutputBackend::Decklink => anyhow::bail!(
            "DeckLink output plugin is unavailable; install and certify the vendor SDK build"
        ),
        OutputBackend::Aja => anyhow::bail!(
            "AJA output plugin is unavailable; install and certify the vendor SDK build"
        ),
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
