//! Output adapters turn Program frames into named destinations.
//!
//! A destination is selected explicitly rather than being guessed from a
//! device name. That prevents a misspelled live-output request from becoming a
//! silent no-op, while the adapter boundary keeps output I/O out of rendering.
//! Preview does not enter this module: only Program may drive an adapter that
//! has been configured as live (invariants 19–20).

use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use gx_contracts::Refusal;

use crate::rasterizer::Frame;

/// A destination for already output-encoded Program frames.
///
/// The `Arc` lets the Program media slot and several outputs observe one frame
/// without duplicating its pixel buffer. Implementations that retain a frame
/// keep the same allocation; only a durable recording must write the bytes.
pub trait OutputAdapter: fmt::Debug + Send {
    /// Stable identifier used by [`OutputAdapterRegistry`].
    fn id(&self) -> &'static str;

    /// Deliver one Program frame. A delivery failure is named and returned;
    /// it is never converted into a black frame or an implicit discard.
    fn emit(&mut self, frame_number: u64, frame: Arc<Frame>) -> Result<(), OutputAdapterError>;
}

/// Failure while a Program frame is reaching a configured output.
#[derive(Debug)]
pub enum OutputAdapterError {
    /// A GPU frame failed; preserve the named cause and never substitute CPU
    /// pixels or a black success frame.
    Render { cause: Refusal },
    /// The recording directory could not be created before an atomic write.
    CreateRecordingDirectory {
        path: PathBuf,
        source: std::io::Error,
    },
    /// A recording frame could not be durably replaced.
    WriteRecordingFrame {
        path: PathBuf,
        source: gx_fs::AtomicWriteError,
    },
}

impl fmt::Display for OutputAdapterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Render { cause } => write!(f, "Program render refused: {cause}"),
            Self::CreateRecordingDirectory { path, source } => {
                write!(
                    f,
                    "could not create recording directory {}: {source}",
                    path.display()
                )
            }
            Self::WriteRecordingFrame { path, source } => {
                write!(
                    f,
                    "could not write recording frame {}: {source}",
                    path.display()
                )
            }
        }
    }
}

impl std::error::Error for OutputAdapterError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Render { .. } => None,
            Self::CreateRecordingDirectory { source, .. } => Some(source),
            Self::WriteRecordingFrame { source, .. } => Some(source),
        }
    }
}

/// Test and intentionally-disconnected output: it accepts Program but retains
/// no bytes.
#[derive(Debug, Default)]
pub struct NullOutputAdapter;

impl OutputAdapter for NullOutputAdapter {
    fn id(&self) -> &'static str {
        "null"
    }

    fn emit(&mut self, _frame_number: u64, _frame: Arc<Frame>) -> Result<(), OutputAdapterError> {
        Ok(())
    }
}

/// In-memory output for consumers that need to inspect the most recent frame.
#[derive(Debug, Default)]
pub struct VirtualOutputAdapter {
    latest: Option<Arc<Frame>>,
}

impl VirtualOutputAdapter {
    /// Take the latest Program frame, leaving this target empty.
    pub fn take_frame(&mut self) -> Option<Arc<Frame>> {
        self.latest.take()
    }

    /// Inspect the latest Program frame without consuming it.
    pub fn latest_frame(&self) -> Option<&Arc<Frame>> {
        self.latest.as_ref()
    }
}

impl OutputAdapter for VirtualOutputAdapter {
    fn id(&self) -> &'static str {
        "virtual"
    }

    fn emit(&mut self, _frame_number: u64, frame: Arc<Frame>) -> Result<(), OutputAdapterError> {
        self.latest = Some(frame);
        Ok(())
    }
}

/// Durable frame recorder. Each raw RGBA frame replaces a frame-numbered file
/// atomically, so a reader sees either a complete old frame or a complete new
/// frame, never a truncated recording.
#[derive(Debug)]
pub struct RecordingOutputAdapter {
    directory: PathBuf,
}

impl RecordingOutputAdapter {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
        }
    }

    /// The directory holding the raw, frame-numbered RGBA recordings.
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    fn frame_path(&self, frame_number: u64) -> PathBuf {
        self.directory.join(format!("{frame_number:020}.rgba"))
    }
}

impl OutputAdapter for RecordingOutputAdapter {
    fn id(&self) -> &'static str {
        "recording"
    }

    fn emit(&mut self, frame_number: u64, frame: Arc<Frame>) -> Result<(), OutputAdapterError> {
        std::fs::create_dir_all(&self.directory).map_err(|source| {
            OutputAdapterError::CreateRecordingDirectory {
                path: self.directory.clone(),
                source,
            }
        })?;
        let path = self.frame_path(frame_number);
        gx_fs::write_atomic(&path, &frame.pixels)
            .map_err(|source| OutputAdapterError::WriteRecordingFrame { path, source })
    }
}

/// The installed outputs and their stable identifiers.
///
/// Construction registers the three built-in adapters. Selection is separate
/// from registration so an unknown identifier produces a useful contract
/// refusal containing every offered id.
#[derive(Debug)]
pub struct OutputAdapterRegistry {
    adapters: HashMap<String, Box<dyn OutputAdapter>>,
}

impl OutputAdapterRegistry {
    /// Register the standard null, virtual and recording destinations.
    pub fn standard(recording_directory: impl Into<PathBuf>) -> Self {
        let mut registry = Self {
            adapters: HashMap::new(),
        };
        registry.register(NullOutputAdapter);
        registry.register(VirtualOutputAdapter::default());
        registry.register(RecordingOutputAdapter::new(recording_directory));
        registry
    }

    /// Add an adapter. The adapter's own stable id is the only registry key.
    pub fn register<A: OutputAdapter + 'static>(&mut self, adapter: A) {
        self.adapters
            .insert(adapter.id().to_owned(), Box::new(adapter));
    }

    /// Identifiers an operator may request, in stable order.
    pub fn offered_ids(&self) -> Vec<String> {
        let mut offered: Vec<_> = self.adapters.keys().cloned().collect();
        offered.sort();
        offered
    }

    /// Refuse an adapter unknown to this engine, naming both request and set.
    pub fn ensure_known(&self, requested: &str) -> Result<(), Refusal> {
        if self.adapters.contains_key(requested) {
            Ok(())
        } else {
            Err(Refusal::UnknownOutputAdapter {
                requested: requested.to_owned(),
                offered: self.offered_ids(),
            })
        }
    }

    /// Deliver Program to a configured adapter.
    pub fn emit(
        &mut self,
        id: &str,
        frame_number: u64,
        frame: Arc<Frame>,
    ) -> Result<(), OutputAdapterError> {
        self.adapters
            .get_mut(id)
            .expect("configured output adapter must be registered")
            .emit(frame_number, frame)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::*;

    fn frame() -> Arc<Frame> {
        Arc::new(Frame {
            width: 1,
            height: 1,
            pixels: vec![1, 2, 3, 4],
        })
    }

    #[test]
    fn virtual_adapter_keeps_the_latest_frame_for_a_test_consumer() {
        let mut adapter = VirtualOutputAdapter::default();
        let expected = frame();

        adapter.emit(8, Arc::clone(&expected)).unwrap();

        assert!(Arc::ptr_eq(adapter.latest_frame().unwrap(), &expected));
        assert!(Arc::ptr_eq(&adapter.take_frame().unwrap(), &expected));
        assert!(adapter.take_frame().is_none());
    }

    #[test]
    fn recording_adapter_writes_raw_frame_bytes_atomically() {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let directory = std::env::temp_dir().join(format!(
            "gx-render-worker-output-adapter-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let mut adapter = RecordingOutputAdapter::new(&directory);

        adapter.emit(12, frame()).unwrap();

        let bytes = std::fs::read(directory.join("00000000000000000012.rgba")).unwrap();
        assert_eq!(bytes, [1, 2, 3, 4]);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn unknown_adapter_refusal_names_the_requested_and_offered_ids() {
        let registry = OutputAdapterRegistry::standard("recording");

        assert_eq!(
            registry.ensure_known("decklink"),
            Err(Refusal::UnknownOutputAdapter {
                requested: "decklink".to_owned(),
                offered: vec![
                    "null".to_owned(),
                    "recording".to_owned(),
                    "virtual".to_owned()
                ],
            })
        );
    }
}
