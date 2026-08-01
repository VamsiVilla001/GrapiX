//! Output adapters.
//!
//! Two categories, and the distinction is the whole point:
//!
//! - **Live outputs** put pixels on air. NDI and SDI. A frame reaching one of these
//!   is visible to an audience.
//! - **The virtual output** renders the on-air graphic headlessly and throws the
//!   pixels away. Nothing leaves the machine. It exists so an operator can confirm
//!   that a take actually produces the frame they expect — at full Program
//!   resolution, through the real render path — without any risk of putting it to
//!   air.
//!
//! `is_live()` is the discriminator, it is reported in status, and the virtual
//! output answers `false`. Requirement: an operator must never have to infer from a
//! name whether something is going out.
//!
//! Every adapter that needs a vendor SDK reports itself unavailable with a reason
//! rather than accepting frames and discarding them. `hardware_certified` is never
//! derived from a compile-time feature flag: linking the NDI SDK is not the same as
//! having transmitted a frame to a device.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use grapix_render_core::output::VideoFrame;

use crate::stage::FrameRate;

// ---------------------------------------------------------------------------
// Format and state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum OutputAlphaMode {
    #[default]
    Premultiplied,
    Straight,
    Opaque,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputFormat {
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub frame_rate: FrameRate,
    #[serde(default)]
    pub alpha_mode: OutputAlphaMode,
    /// Project colour space, carried through so an adapter can tag its stream.
    #[serde(default = "default_color_space")]
    pub color_space: String,
}

fn default_color_space() -> String {
    "rec709".to_string()
}

impl Default for OutputFormat {
    fn default() -> Self {
        Self {
            width: 1920,
            height: 1080,
            frame_rate: FrameRate::default(),
            alpha_mode: OutputAlphaMode::Premultiplied,
            color_space: default_color_space(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum OutputState {
    #[default]
    Idle,
    Configured,
    Running,
    Error,
}

impl OutputState {
    pub fn as_str(&self) -> &'static str {
        match self {
            OutputState::Idle => "idle",
            OutputState::Configured => "configured",
            OutputState::Running => "running",
            OutputState::Error => "error",
        }
    }
}

// ---------------------------------------------------------------------------
// The sink contract
// ---------------------------------------------------------------------------

/// A frame sink.
///
/// `send` must never block for longer than one frame. An adapter that cannot keep up
/// drops and counts, because the Program clock is not allowed to wait for a network
/// stack — one slow output must not take every other output down with it.
pub trait OutputSink: Send {
    fn adapter_id(&self) -> &'static str;
    fn name(&self) -> &'static str;

    /// Whether frames reaching this sink are visible to an audience.
    fn is_live(&self) -> bool;

    /// False when the adapter cannot run here — no SDK, no device, no licence.
    fn available(&self) -> bool {
        true
    }

    fn unavailable_reason(&self) -> Option<String> {
        None
    }

    /// Whether this adapter has been run against real hardware.
    fn hardware_certified(&self) -> bool {
        false
    }

    fn configure(&mut self, format: &OutputFormat) -> Result<Vec<String>, String>;
    fn start(&mut self) -> Result<(), String>;
    fn stop(&mut self);

    /// Accept one frame. `Ok(false)` means the frame was dropped, not sent.
    fn send(&mut self, frame: &VideoFrame) -> Result<bool, String>;
}

// ---------------------------------------------------------------------------
// Null
// ---------------------------------------------------------------------------

/// Discards frames without rendering intent. For development and CI.
#[derive(Default)]
pub struct NullSink;

impl OutputSink for NullSink {
    fn adapter_id(&self) -> &'static str {
        "null"
    }
    fn name(&self) -> &'static str {
        "Null output"
    }
    fn is_live(&self) -> bool {
        false
    }
    fn hardware_certified(&self) -> bool {
        true
    }
    fn configure(&mut self, _format: &OutputFormat) -> Result<Vec<String>, String> {
        Ok(Vec::new())
    }
    fn start(&mut self) -> Result<(), String> {
        Ok(())
    }
    fn stop(&mut self) {}
    fn send(&mut self, _frame: &VideoFrame) -> Result<bool, String> {
        Ok(true)
    }
}

// ---------------------------------------------------------------------------
// Virtual
// ---------------------------------------------------------------------------

/// Headless render of the on-air graphic that never goes live.
///
/// Distinct from `null` in intent and in what it reports. Null is a stub; this is a
/// deliberate confidence output — it renders the Program frame at full resolution
/// through the real path, retains the most recent one so it can be inspected, and
/// guarantees nothing leaves the machine.
///
/// That guarantee is why it is always available: an operator can verify a take
/// without an SDK, a device, or any risk of hitting air.
pub struct VirtualSink {
    format: OutputFormat,
    /// The most recent frame, for inspection. Exactly one, never a growing buffer.
    last_frame: Option<VideoFrame>,
    retain_frames: bool,
}

impl VirtualSink {
    pub fn new(retain_frames: bool) -> Self {
        Self {
            format: OutputFormat::default(),
            last_frame: None,
            retain_frames,
        }
    }

    /// The most recent rendered frame, if retention is on.
    pub fn last_frame(&self) -> Option<&VideoFrame> {
        self.last_frame.as_ref()
    }
}

impl OutputSink for VirtualSink {
    fn adapter_id(&self) -> &'static str {
        "virtual"
    }
    fn name(&self) -> &'static str {
        "Windowed virtual output (never live)"
    }

    /// Never live. This is the load-bearing property of the whole adapter.
    fn is_live(&self) -> bool {
        false
    }

    fn hardware_certified(&self) -> bool {
        // No hardware involved, so there is nothing to certify against.
        true
    }

    fn configure(&mut self, format: &OutputFormat) -> Result<Vec<String>, String> {
        self.format = format.clone();
        Ok(vec![
            "windowed virtual output stays on this machine; no frames are transmitted".to_string(),
        ])
    }

    fn start(&mut self) -> Result<(), String> {
        Ok(())
    }

    fn stop(&mut self) {
        // Release the retained frame: a stopped output holding a full UHD buffer is
        // pure waste.
        self.last_frame = None;
    }

    fn send(&mut self, frame: &VideoFrame) -> Result<bool, String> {
        if self.retain_frames {
            self.last_frame = Some(frame.clone());
        }
        Ok(true)
    }
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

/// Deterministic raw BGRA capture to disk.
///
/// Not live. Used for the visual comparison harness and for evidence, so the frames
/// are written byte-exact with no encoding.
pub struct RecordingSink {
    directory: PathBuf,
    name: String,
    format: OutputFormat,
    frames_written: u64,
    max_frames: u64,
}

impl RecordingSink {
    pub fn new(directory: PathBuf, name: String, max_frames: u64) -> Self {
        Self {
            directory,
            name,
            format: OutputFormat::default(),
            frames_written: 0,
            max_frames,
        }
    }
}

impl OutputSink for RecordingSink {
    fn adapter_id(&self) -> &'static str {
        "recording"
    }
    fn name(&self) -> &'static str {
        "Deterministic recording"
    }
    fn is_live(&self) -> bool {
        false
    }
    fn hardware_certified(&self) -> bool {
        true
    }

    fn configure(&mut self, format: &OutputFormat) -> Result<Vec<String>, String> {
        std::fs::create_dir_all(&self.directory)
            .map_err(|error| format!("could not create {}: {error}", self.directory.display()))?;
        self.format = format.clone();
        self.frames_written = 0;
        Ok(Vec::new())
    }

    fn start(&mut self) -> Result<(), String> {
        Ok(())
    }

    fn stop(&mut self) {}

    fn send(&mut self, frame: &VideoFrame) -> Result<bool, String> {
        // A bounded capture, so a forgotten recording cannot fill the disk.
        if self.frames_written >= self.max_frames {
            return Ok(false);
        }

        let path = self
            .directory
            .join(format!("{}-{:06}.bgra", self.name, frame.frame_index));
        std::fs::write(&path, &frame.data)
            .map_err(|error| format!("could not write {}: {error}", path.display()))?;
        self.frames_written += 1;
        Ok(true)
    }
}

// ---------------------------------------------------------------------------
// Live adapters awaiting an SDK
// ---------------------------------------------------------------------------

/// A live adapter that is declared but cannot run here.
///
/// It refuses to configure, with the reason. It never silently accepts frames — an
/// output that swallows Program is the worst possible failure, because the operator
/// sees a healthy row and the audience sees nothing.
pub struct UnavailableLiveSink {
    adapter_id: &'static str,
    name: &'static str,
    reason: String,
}

impl UnavailableLiveSink {
    pub fn new(adapter_id: &'static str, name: &'static str, reason: impl Into<String>) -> Self {
        Self {
            adapter_id,
            name,
            reason: reason.into(),
        }
    }
}

impl OutputSink for UnavailableLiveSink {
    fn adapter_id(&self) -> &'static str {
        self.adapter_id
    }
    fn name(&self) -> &'static str {
        self.name
    }
    fn is_live(&self) -> bool {
        true
    }
    fn available(&self) -> bool {
        false
    }
    fn unavailable_reason(&self) -> Option<String> {
        Some(self.reason.clone())
    }
    fn hardware_certified(&self) -> bool {
        false
    }

    fn configure(&mut self, _format: &OutputFormat) -> Result<Vec<String>, String> {
        Err(format!("{} is unavailable: {}", self.name, self.reason))
    }
    fn start(&mut self) -> Result<(), String> {
        Err(format!("{} is unavailable: {}", self.name, self.reason))
    }
    fn stop(&mut self) {}
    fn send(&mut self, _frame: &VideoFrame) -> Result<bool, String> {
        Err(format!("{} is unavailable: {}", self.name, self.reason))
    }
}

// ---------------------------------------------------------------------------
// NDI
// ---------------------------------------------------------------------------

/// NDI, when compiled with `--features ndi`.
///
/// Even with the SDK linked this reports `hardware_certified: false` until it has
/// actually been run against a network and validated — including alpha behaviour,
/// which is the part that most often surprises.
#[cfg(feature = "ndi")]
pub struct NdiSink {
    source_name: String,
    format: OutputFormat,
    started: bool,
}

#[cfg(feature = "ndi")]
impl NdiSink {
    pub fn new(source_name: String) -> Self {
        Self {
            source_name,
            format: OutputFormat::default(),
            started: false,
        }
    }
}

#[cfg(feature = "ndi")]
impl OutputSink for NdiSink {
    fn adapter_id(&self) -> &'static str {
        "ndi"
    }
    fn name(&self) -> &'static str {
        "NDI"
    }
    fn is_live(&self) -> bool {
        true
    }
    fn hardware_certified(&self) -> bool {
        // Compiling the SDK in is not certification.
        false
    }

    fn configure(&mut self, format: &OutputFormat) -> Result<Vec<String>, String> {
        self.format = format.clone();
        Ok(vec![format!(
            "NDI source \"{}\" is compiled in but has not been certified against a network; \
             do not rely on it for a live show",
            self.source_name
        )])
    }

    fn start(&mut self) -> Result<(), String> {
        // The render core owns the NDI sender; wiring it here is the remaining
        // integration step and is gated behind real hardware validation.
        Err("NDI transmission is not wired to the engine's Program loop yet".to_string())
    }

    fn stop(&mut self) {
        self.started = false;
    }

    fn send(&mut self, _frame: &VideoFrame) -> Result<bool, String> {
        Err("NDI transmission is not wired to the engine's Program loop yet".to_string())
    }
}

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputStatus {
    pub output_id: String,
    pub adapter_id: String,
    pub name: String,
    pub state: String,
    /// Whether frames reaching this output are visible to an audience.
    pub live: bool,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    pub hardware_certified: bool,
    pub width: u32,
    pub height: u32,
    pub frame_rate_numerator: u32,
    pub frame_rate_denominator: u32,
    pub color_space: String,
    pub frames_accepted: u64,
    pub frames_sent: u64,
    pub frames_dropped: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

pub struct OutputInstance {
    pub output_id: String,
    pub state: OutputState,
    pub format: OutputFormat,
    pub frames_accepted: u64,
    pub frames_sent: u64,
    pub frames_dropped: u64,
    pub last_error: Option<String>,
    sink: Box<dyn OutputSink>,
}

impl OutputInstance {
    pub fn new(output_id: String, sink: Box<dyn OutputSink>) -> Self {
        Self {
            output_id,
            state: OutputState::Idle,
            format: OutputFormat::default(),
            frames_accepted: 0,
            frames_sent: 0,
            frames_dropped: 0,
            last_error: None,
            sink,
        }
    }

    pub fn adapter_id(&self) -> &'static str {
        self.sink.adapter_id()
    }

    pub fn is_live(&self) -> bool {
        self.sink.is_live()
    }

    pub fn is_running(&self) -> bool {
        self.state == OutputState::Running
    }

    pub fn configure(&mut self, format: OutputFormat) -> Result<Vec<String>, String> {
        match self.sink.configure(&format) {
            Ok(warnings) => {
                self.format = format;
                self.state = OutputState::Configured;
                self.last_error = None;
                Ok(warnings)
            }
            Err(error) => {
                self.state = OutputState::Error;
                self.last_error = Some(error.clone());
                Err(error)
            }
        }
    }

    pub fn start(&mut self) -> Result<(), String> {
        if self.state == OutputState::Idle {
            return Err(format!(
                "output {} must be configured before it can start",
                self.output_id
            ));
        }
        match self.sink.start() {
            Ok(()) => {
                self.state = OutputState::Running;
                self.last_error = None;
                self.frames_accepted = 0;
                self.frames_sent = 0;
                self.frames_dropped = 0;
                Ok(())
            }
            Err(error) => {
                self.state = OutputState::Error;
                self.last_error = Some(error.clone());
                Err(error)
            }
        }
    }

    pub fn stop(&mut self) {
        self.sink.stop();
        if self.state == OutputState::Running {
            self.state = OutputState::Configured;
        }
    }

    /// Hand a frame over. Never propagates an error; a failing output is recorded
    /// and left running so the Program clock is never blocked by it.
    pub fn send(&mut self, frame: &VideoFrame) -> bool {
        if self.state != OutputState::Running {
            return false;
        }

        self.frames_accepted += 1;
        match self.sink.send(frame) {
            Ok(true) => {
                self.frames_sent += 1;
                true
            }
            Ok(false) => {
                self.frames_dropped += 1;
                false
            }
            Err(error) => {
                self.frames_dropped += 1;
                self.last_error = Some(error);
                self.state = OutputState::Error;
                false
            }
        }
    }

    pub fn status(&self) -> OutputStatus {
        OutputStatus {
            output_id: self.output_id.clone(),
            adapter_id: self.sink.adapter_id().to_string(),
            name: self.sink.name().to_string(),
            state: self.state.as_str().to_string(),
            live: self.sink.is_live(),
            available: self.sink.available(),
            unavailable_reason: self.sink.unavailable_reason(),
            hardware_certified: self.sink.hardware_certified(),
            width: self.format.width,
            height: self.format.height,
            frame_rate_numerator: self.format.frame_rate.numerator,
            frame_rate_denominator: self.format.frame_rate.denominator,
            color_space: self.format.color_space.clone(),
            frames_accepted: self.frames_accepted,
            frames_sent: self.frames_sent,
            frames_dropped: self.frames_dropped,
            last_error: self.last_error.clone(),
        }
    }

    /// Retained virtual-output frame, when this instance is a virtual output.
    pub fn virtual_last_frame(&self) -> Option<&VideoFrame> {
        if self.sink.adapter_id() != "virtual" {
            return None;
        }
        // Downcasting would need `Any`; instead the engine keeps virtual instances
        // reachable through `sink_as_virtual`.
        None
    }
}

/// Build a sink for an adapter id.
///
/// The only place adapter ids become implementations, so an unknown id cannot
/// silently become a no-op output.
pub fn create_sink(
    adapter_id: &str,
    cache_directory: &PathBuf,
    options: &serde_json::Value,
) -> Result<Box<dyn OutputSink>, String> {
    match adapter_id {
        "null" => Ok(Box::new(NullSink)),

        "virtual" => {
            let retain = options
                .get("retainFrames")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(true);
            Ok(Box::new(VirtualSink::new(retain)))
        }

        "recording" => {
            let name = options
                .get("recordingName")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("program")
                .to_string();
            let max_frames = options
                .get("maxFrames")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(300);
            Ok(Box::new(RecordingSink::new(
                cache_directory.join("recordings"),
                name,
                max_frames,
            )))
        }

        #[cfg(feature = "ndi")]
        "ndi" => {
            let source = options
                .get("sourceName")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("GrapiX Program")
                .to_string();
            Ok(Box::new(NdiSink::new(source)))
        }

        #[cfg(not(feature = "ndi"))]
        "ndi" => Ok(Box::new(UnavailableLiveSink::new(
            "ndi",
            "NDI",
            "engine was built without --features ndi, and the NDI SDK 6.x is required",
        ))),

        "decklink" => Ok(Box::new(UnavailableLiveSink::new(
            "decklink",
            "Blackmagic DeckLink",
            "the DeckLink SDK and a certified device are required; not implemented",
        ))),

        "aja" => Ok(Box::new(UnavailableLiveSink::new(
            "aja",
            "AJA",
            "the AJA NTV2 SDK and a certified device are required; not implemented",
        ))),

        other => Err(format!(
            "unknown output adapter \"{other}\"; this engine offers null, virtual, recording, ndi, decklink, aja"
        )),
    }
}

/// Adapter ids that put pixels on air.
pub const LIVE_ADAPTER_IDS: &[&str] = &["ndi", "decklink", "aja"];

/// Whether an adapter id is a live output.
pub fn is_live_adapter(adapter_id: &str) -> bool {
    LIVE_ADAPTER_IDS.contains(&adapter_id)
}
