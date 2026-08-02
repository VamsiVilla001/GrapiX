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

#[cfg(feature = "ndi")]
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, OnceLock,
    },
    thread::{self, JoinHandle},
    time::Duration,
};

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

/// NDI's source label is an operator-facing network identifier, not arbitrary
/// text. Keep the wire limit here so every NDI construction path enforces it.
pub const NDI_SOURCE_NAME_MAX_CHARS: usize = 64;
pub const DEFAULT_NDI_FRAME_POOL_SLOTS: u8 = 4;

/// Validated NDI-only `output.configure.options`.
///
/// `frame_pool_slots` is supplied by deployment configuration, never by the
/// client, so an output request cannot inflate the fixed render-tick pool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NdiOptions {
    pub source_name: String,
    pub groups: Option<String>,
    pub frame_pool_slots: u8,
}

impl NdiOptions {
    fn from_json(
        options: &serde_json::Value,
        frame_pool_slots: u8,
        require_source_name: bool,
    ) -> Result<Self, String> {
        let source_name = match options.get("sourceName") {
            Some(serde_json::Value::String(value)) => value.clone(),
            Some(_) => return Err("NDI option sourceName must be a string".to_string()),
            None if require_source_name => {
                return Err("NDI option sourceName is required".to_string());
            }
            None => "GrapiX Program".to_string(),
        };
        validate_ndi_source_name(&source_name)?;

        let groups = match options.get("groups") {
            Some(serde_json::Value::String(value)) if value.chars().any(char::is_control) => {
                return Err("NDI option groups must not contain control characters".to_string());
            }
            Some(serde_json::Value::String(value)) => Some(value.clone()),
            Some(_) => return Err("NDI option groups must be a string".to_string()),
            None => None,
        };

        Ok(Self {
            source_name,
            groups,
            frame_pool_slots: frame_pool_slots.clamp(3, 4),
        })
    }
}

pub fn validate_ndi_source_name(source_name: &str) -> Result<(), String> {
    if source_name.trim().is_empty() {
        return Err("NDI option sourceName must not be empty".to_string());
    }
    if source_name.chars().count() > NDI_SOURCE_NAME_MAX_CHARS {
        return Err(format!(
            "NDI option sourceName must be at most {NDI_SOURCE_NAME_MAX_CHARS} characters"
        ));
    }
    if source_name.chars().any(char::is_control) {
        return Err("NDI option sourceName must not contain control characters".to_string());
    }
    Ok(())
}

/// Reject malformed NDI options before replacing any configured output.
pub fn validate_ndi_options(options: &serde_json::Value) -> Result<(), String> {
    NdiOptions::from_json(options, DEFAULT_NDI_FRAME_POOL_SLOTS, true).map(|_| ())
}

/// NDI v1 is deliberately narrow: progressive BGRA8 data is supplied by the
/// Program renderer, while this contract validates its alpha, colour tag, and
/// rational rate before any resources are reserved.
pub fn validate_ndi_format(format: &OutputFormat) -> Result<(), String> {
    if format.alpha_mode != OutputAlphaMode::Premultiplied {
        return Err("NDI v1 requires premultiplied BGRA8 alpha".to_string());
    }
    if !matches!(format.color_space.as_str(), "rec709" | "srgb") {
        return Err("NDI v1 requires an explicit rec709 or srgb colorSpace".to_string());
    }
    if format.frame_rate.numerator == 0 || format.frame_rate.denominator == 0 {
        return Err("NDI v1 requires a positive rational frameRate".to_string());
    }
    Ok(())
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

    /// Returns one terminal failure reported by work that runs outside the Program
    /// tick. The Engine consumes it before admitting the next frame and publishes
    /// the existing output-health event after moving the instance to `error`.
    fn take_async_error(&mut self) -> Option<String> {
        None
    }
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
            "windowed virtual output stays on this machine; no frames leave this machine"
                .to_string(),
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

/// NDI pools have a fixed, preconfigured maximum to eliminate heap activity on
/// the Program render tick. Operators may select three or four slabs.
#[cfg(feature = "ndi")]
pub const NDI_MAX_FRAME_POOL_SLOTS: usize = 4;

/// Metadata that travels with a preallocated NDI slab. It is `Copy`, avoiding
/// any tick-time string, vector, or descriptor allocation.
#[cfg(feature = "ndi")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NdiFrameMetadata {
    pub frame_index: u64,
    pub deadline_ns: u64,
    pub width: u32,
    pub height: u32,
    pub stride: u32,
}

/// Off-tick snapshot of fixed-pool pressure.
#[cfg(feature = "ndi")]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct NdiFramePoolStats {
    pub readback_complete: u64,
    pub enqueued: u64,
    pub dropped_pool_exhausted: u64,
    pub dropped_ready_ring_full: u64,
    pub dropped_readback: u64,
    pub free_depth: usize,
    pub ready_depth: usize,
    pub pool_high_water: usize,
}

#[cfg(feature = "ndi")]
struct NdiRingCell {
    sequence: std::sync::atomic::AtomicUsize,
    value: std::cell::UnsafeCell<usize>,
}

#[cfg(feature = "ndi")]
impl NdiRingCell {
    fn new(sequence: usize) -> Self {
        Self {
            sequence: std::sync::atomic::AtomicUsize::new(sequence),
            value: std::cell::UnsafeCell::new(0),
        }
    }
}

// A cell is written by the sole producer before release publication and read by
// the sole consumer only after acquire observation.
#[cfg(feature = "ndi")]
unsafe impl Send for NdiRingCell {}
#[cfg(feature = "ndi")]
unsafe impl Sync for NdiRingCell {}

/// A fixed-capacity lock-free SPSC index ring. Unlike a one-empty-slot ring it
/// retains all four slots through per-cell sequence publication.
#[cfg(feature = "ndi")]
struct SpscIndexRing<const CAPACITY: usize> {
    cells: [NdiRingCell; CAPACITY],
    enqueue: std::sync::atomic::AtomicUsize,
    dequeue: std::sync::atomic::AtomicUsize,
}

#[cfg(feature = "ndi")]
impl<const CAPACITY: usize> SpscIndexRing<CAPACITY> {
    fn new() -> Self {
        assert!(CAPACITY.is_power_of_two() && CAPACITY > 0);
        Self {
            cells: std::array::from_fn(NdiRingCell::new),
            enqueue: std::sync::atomic::AtomicUsize::new(0),
            dequeue: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    fn try_push(&self, index: usize) -> bool {
        use std::sync::atomic::Ordering;
        let position = self.enqueue.load(Ordering::Relaxed);
        let cell = &self.cells[position & (CAPACITY - 1)];
        if cell.sequence.load(Ordering::Acquire) != position {
            return false;
        }
        // SAFETY: sole producer owns this sequence cell.
        unsafe { *cell.value.get() = index };
        cell.sequence
            .store(position.wrapping_add(1), Ordering::Release);
        self.enqueue
            .store(position.wrapping_add(1), Ordering::Relaxed);
        true
    }

    fn try_pop(&self) -> Option<usize> {
        use std::sync::atomic::Ordering;
        let position = self.dequeue.load(Ordering::Relaxed);
        let cell = &self.cells[position & (CAPACITY - 1)];
        if cell.sequence.load(Ordering::Acquire) != position.wrapping_add(1) {
            return None;
        }
        // SAFETY: sole consumer observed producer release publication.
        let index = unsafe { *cell.value.get() };
        cell.sequence
            .store(position.wrapping_add(CAPACITY), Ordering::Release);
        self.dequeue
            .store(position.wrapping_add(1), Ordering::Relaxed);
        Some(index)
    }

    fn len(&self) -> usize {
        use std::sync::atomic::Ordering;
        self.enqueue
            .load(Ordering::Acquire)
            .wrapping_sub(self.dequeue.load(Ordering::Acquire))
    }
}

#[cfg(feature = "ndi")]
struct NdiFrameSlot {
    bytes: std::cell::UnsafeCell<Box<[u8]>>,
    metadata: std::cell::UnsafeCell<NdiFrameMetadata>,
}

#[cfg(feature = "ndi")]
impl NdiFrameSlot {
    fn new(byte_len: usize, width: u32, height: u32, stride: u32) -> Self {
        Self {
            bytes: std::cell::UnsafeCell::new(vec![0; byte_len].into_boxed_slice()),
            metadata: std::cell::UnsafeCell::new(NdiFrameMetadata {
                frame_index: 0,
                deadline_ns: 0,
                width,
                height,
                stride,
            }),
        }
    }
}

#[cfg(feature = "ndi")]
unsafe impl Send for NdiFrameSlot {}
#[cfg(feature = "ndi")]
unsafe impl Sync for NdiFrameSlot {}

/// Persistent per-slot wgpu readback resources. `configure_gpu_readback_staging`
/// is called off tick and no GPU resource is constructed from a Program frame.
#[cfg(feature = "ndi")]
pub struct NdiGpuReadbackStaging {
    buffers: Box<[wgpu::Buffer]>,
}

#[cfg(feature = "ndi")]
impl NdiGpuReadbackStaging {
    pub fn buffer(&self, slot: usize) -> Option<&wgpu::Buffer> {
        self.buffers.get(slot)
    }
}

/// Fixed BGRA8 premultiplied CPU slabs and lock-free Program/worker handoff.
///
/// Program consumes `free_ring` and produces `ready_ring`; the NDI worker consumes
/// `ready_ring` and produces `free_ring`. No `Vec` grows, mutex is acquired, or
/// NDI call is made by any API used on Program.
#[cfg(feature = "ndi")]
pub struct NdiFramePool {
    slots: Box<[NdiFrameSlot]>,
    free_ring: SpscIndexRing<NDI_MAX_FRAME_POOL_SLOTS>,
    ready_ring: SpscIndexRing<NDI_MAX_FRAME_POOL_SLOTS>,
    // Program's failed-readback return slot. `usize::MAX` means empty; atomics
    // keep off-tick status reads race-free without making free_ring multi-producer.
    render_reclaim: std::sync::atomic::AtomicUsize,
    width: u32,
    height: u32,
    stride: u32,
    byte_len: usize,
    staging: Option<NdiGpuReadbackStaging>,
    readback_complete: std::sync::atomic::AtomicU64,
    enqueued: std::sync::atomic::AtomicU64,
    dropped_pool_exhausted: std::sync::atomic::AtomicU64,
    dropped_ready_ring_full: std::sync::atomic::AtomicU64,
    dropped_readback: std::sync::atomic::AtomicU64,
    pool_high_water: std::sync::atomic::AtomicUsize,
}

#[cfg(feature = "ndi")]
unsafe impl Send for NdiFramePool {}
#[cfg(feature = "ndi")]
unsafe impl Sync for NdiFramePool {}

#[cfg(feature = "ndi")]
impl NdiFramePool {
    pub fn new(width: u32, height: u32, slot_count: usize) -> Result<Self, &'static str> {
        if !(3..=NDI_MAX_FRAME_POOL_SLOTS).contains(&slot_count) {
            return Err("NDI frame pool requires three or four slabs");
        }
        let stride = width.checked_mul(4).ok_or("NDI frame stride overflow")?;
        let byte_len = (stride as usize)
            .checked_mul(height as usize)
            .ok_or("NDI frame slab size overflow")?;
        let slots = (0..slot_count)
            .map(|_| NdiFrameSlot::new(byte_len, width, height, stride))
            .collect::<Vec<_>>()
            .into_boxed_slice();
        let free_ring = SpscIndexRing::new();
        for index in 0..slot_count {
            let initialized = free_ring.try_push(index);
            debug_assert!(initialized);
        }
        Ok(Self {
            slots,
            free_ring,
            ready_ring: SpscIndexRing::new(),
            render_reclaim: std::sync::atomic::AtomicUsize::new(usize::MAX),
            width,
            height,
            stride,
            byte_len,
            staging: None,
            readback_complete: std::sync::atomic::AtomicU64::new(0),
            enqueued: std::sync::atomic::AtomicU64::new(0),
            dropped_pool_exhausted: std::sync::atomic::AtomicU64::new(0),
            dropped_ready_ring_full: std::sync::atomic::AtomicU64::new(0),
            dropped_readback: std::sync::atomic::AtomicU64::new(0),
            pool_high_water: std::sync::atomic::AtomicUsize::new(0),
        })
    }

    pub fn configure_gpu_readback_staging(&mut self, device: &wgpu::Device) {
        self.staging = Some(NdiGpuReadbackStaging {
            buffers: (0..self.slots.len())
                .map(|_| {
                    device.create_buffer(&wgpu::BufferDescriptor {
                        label: Some("GrapiX NDI readback staging"),
                        size: self.byte_len as u64,
                        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                        mapped_at_creation: false,
                    })
                })
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        });
    }

    pub fn gpu_readback_staging(&self, slot: usize) -> Option<&wgpu::Buffer> {
        self.staging.as_ref()?.buffer(slot)
    }

    /// Program's one non-blocking acquisition for this output tick.
    pub fn try_acquire_for_readback(&self) -> Option<NdiReadbackLease<'_>> {
        use std::sync::atomic::Ordering;

        let reclaimed = self.render_reclaim.swap(usize::MAX, Ordering::Relaxed);
        let index = (reclaimed != usize::MAX)
            .then_some(reclaimed)
            .or_else(|| self.free_ring.try_pop());
        let Some(index) = index else {
            self.dropped_pool_exhausted.fetch_add(1, Ordering::Relaxed);
            return None;
        };
        self.note_pool_use();
        Some(NdiReadbackLease {
            pool: self,
            index,
            _not_send: std::marker::PhantomData,
        })
    }

    /// Worker-only dequeue of a completed immutable slab.
    pub fn try_dequeue_for_send(&self) -> Option<NdiReadyFrame<'_>> {
        self.ready_ring.try_pop().map(|index| NdiReadyFrame {
            pool: self,
            index,
            returned: false,
            _not_send: std::marker::PhantomData,
        })
    }

    pub fn stats(&self) -> NdiFramePoolStats {
        use std::sync::atomic::Ordering;
        NdiFramePoolStats {
            readback_complete: self.readback_complete.load(Ordering::Relaxed),
            enqueued: self.enqueued.load(Ordering::Relaxed),
            dropped_pool_exhausted: self.dropped_pool_exhausted.load(Ordering::Relaxed),
            dropped_ready_ring_full: self.dropped_ready_ring_full.load(Ordering::Relaxed),
            dropped_readback: self.dropped_readback.load(Ordering::Relaxed),
            free_depth: self.free_ring.len()
                + usize::from(self.render_reclaim.load(Ordering::Relaxed) != usize::MAX),
            ready_depth: self.ready_ring.len(),
            pool_high_water: self.pool_high_water.load(Ordering::Relaxed),
        }
    }

    fn publish_ready(&self, index: usize, metadata: NdiFrameMetadata) -> bool {
        // SAFETY: Program exclusively owns the slab until ready publication.
        unsafe { *self.slots[index].metadata.get() = metadata };
        self.readback_complete
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        if self.ready_ring.try_push(index) {
            self.enqueued
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            true
        } else {
            self.dropped_ready_ring_full
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            self.reclaim_on_render(index);
            false
        }
    }

    fn reclaim_after_readback_failure(&self, index: usize) {
        self.dropped_readback
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        self.reclaim_on_render(index);
    }

    fn reclaim_on_render(&self, index: usize) {
        // Program owns at most one lease. A second return would be an ownership bug,
        // not normal backpressure.
        let returned = self.render_reclaim.compare_exchange(
            usize::MAX,
            index,
            std::sync::atomic::Ordering::Relaxed,
            std::sync::atomic::Ordering::Relaxed,
        );
        debug_assert_eq!(returned, Ok(usize::MAX));
    }

    fn return_from_worker(&self, index: usize) {
        let returned = self.free_ring.try_push(index);
        debug_assert!(returned);
    }

    fn note_pool_use(&self) {
        use std::sync::atomic::Ordering;
        let used = self
            .slots
            .len()
            .saturating_sub(self.free_ring.len())
            .saturating_sub(usize::from(
                self.render_reclaim.load(Ordering::Relaxed) != usize::MAX,
            ));
        let mut high_water = self.pool_high_water.load(Ordering::Relaxed);
        while used > high_water {
            match self.pool_high_water.compare_exchange_weak(
                high_water,
                used,
                Ordering::Relaxed,
                Ordering::Relaxed,
            ) {
                Ok(_) => break,
                Err(current) => high_water = current,
            }
        }
    }
}

/// Program-owned slab lease; it is either published to ready_ring or reclaimed.
#[cfg(feature = "ndi")]
pub struct NdiReadbackLease<'a> {
    pool: &'a NdiFramePool,
    index: usize,
    // A Program lease is thread-affine: only its render thread may mutate a slab.
    _not_send: std::marker::PhantomData<std::rc::Rc<()>>,
}

#[cfg(feature = "ndi")]
impl NdiReadbackLease<'_> {
    pub fn slot_index(&self) -> usize {
        self.index
    }

    pub fn slab_mut(&mut self) -> &mut [u8] {
        // SAFETY: worker cannot access this slab until complete release-publishes it.
        unsafe { &mut *self.pool.slots[self.index].bytes.get() }
    }

    pub fn complete(self, frame_index: u64, deadline_ns: u64) -> bool {
        self.pool.publish_ready(
            self.index,
            NdiFrameMetadata {
                frame_index,
                deadline_ns,
                width: self.pool.width,
                height: self.pool.height,
                stride: self.pool.stride,
            },
        )
    }

    pub fn cancel(self) {
        self.pool.reclaim_after_readback_failure(self.index);
    }
}

/// Worker-owned immutable slab. Release or Drop returns its index to free_ring
/// after the NDI binding no longer retains the byte pointer.
#[cfg(feature = "ndi")]
pub struct NdiReadyFrame<'a> {
    pool: &'a NdiFramePool,
    index: usize,
    returned: bool,
    // A ready lease is owned by one NDI worker until it returns its slot.
    _not_send: std::marker::PhantomData<std::rc::Rc<()>>,
}

#[cfg(feature = "ndi")]
impl NdiReadyFrame<'_> {
    pub fn slot_index(&self) -> usize {
        self.index
    }

    pub fn bytes(&self) -> &[u8] {
        // SAFETY: ready-ring acquire makes Program's slab write visible.
        unsafe { &*self.pool.slots[self.index].bytes.get() }
    }

    pub fn metadata(&self) -> NdiFrameMetadata {
        // SAFETY: metadata remains immutable until this lease returns the slot.
        unsafe { *self.pool.slots[self.index].metadata.get() }
    }

    pub fn release(mut self) {
        self.returned = true;
        self.pool.return_from_worker(self.index);
    }
}

#[cfg(feature = "ndi")]
impl Drop for NdiReadyFrame<'_> {
    fn drop(&mut self) {
        if !self.returned {
            self.pool.return_from_worker(self.index);
        }
    }
}

#[cfg(feature = "ndi")]
struct NdiWorker {
    accepting: Arc<AtomicBool>,
    terminal_error: Arc<OnceLock<String>>,
    thread: Option<JoinHandle<()>>,
}

#[cfg(feature = "ndi")]
impl NdiWorker {
    fn start(
        pool: Arc<NdiFramePool>,
        options: &NdiOptions,
        format: &OutputFormat,
    ) -> Result<Self, String> {
        let accepting = Arc::new(AtomicBool::new(true));
        let terminal_error = Arc::new(OnceLock::new());
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let worker_accepting = Arc::clone(&accepting);
        let worker_error = Arc::clone(&terminal_error);
        let source_name = options.source_name.clone();
        let groups = options.groups.clone();
        let width = i32::try_from(format.width).map_err(|_| "NDI width exceeds SDK range")?;
        let height = i32::try_from(format.height).map_err(|_| "NDI height exceeds SDK range")?;
        let rate_numerator = i32::try_from(format.frame_rate.numerator)
            .map_err(|_| "NDI frame-rate numerator exceeds SDK range")?;
        let rate_denominator = i32::try_from(format.frame_rate.denominator)
            .map_err(|_| "NDI frame-rate denominator exceeds SDK range")?;
        let aspect_ratio = format.width as f32 / format.height as f32;
        let thread = thread::Builder::new()
            .name("grapix-ndi-transmit".to_string())
            .spawn(move || {
                use grafton_ndi::{
                    PixelFormat, ScanType, Sender, SenderOptions, VideoFrame as NdiVideoFrame, NDI,
                };

                let startup = (|| -> Result<(Sender, NdiVideoFrame), String> {
                    let ndi = NDI::new()
                        .map_err(|error| format!("NDI initialization failed: {error}"))?;
                    let builder = SenderOptions::builder(source_name)
                        .clock_video(true)
                        .clock_audio(false);
                    let sender_options = match groups {
                        Some(groups) => builder.groups(groups).build(),
                        None => builder.build(),
                    };
                    let sender = Sender::new(&ndi, &sender_options)
                        .map_err(|error| format!("NDI sender creation failed: {error}"))?;
                    let frame = NdiVideoFrame::builder()
                        .resolution(width, height)
                        .pixel_format(PixelFormat::BGRA)
                        .frame_rate(rate_numerator, rate_denominator)
                        .aspect_ratio(aspect_ratio)
                        .scan_type(ScanType::Progressive)
                        .build()
                        .map_err(|error| format!("NDI frame construction failed: {error}"))?;
                    Ok((sender, frame))
                })();
                let (sender, mut ndi_frame) = match startup {
                    Ok(value) => {
                        let _ = started_tx.send(Ok(()));
                        value
                    }
                    Err(error) => {
                        let _ = worker_error.set(error.clone());
                        worker_accepting.store(false, Ordering::Release);
                        let _ = started_tx.send(Err(error));
                        return;
                    }
                };
                let mut health_interval = 0_u16;
                while worker_accepting.load(Ordering::Acquire) {
                    let Some(ready) = pool.try_dequeue_for_send() else {
                        thread::yield_now();
                        continue;
                    };
                    if ready.bytes().len() != ndi_frame.data().len() {
                        let _ = worker_error
                            .set("NDI pool slab length does not match SDK frame".to_string());
                        worker_accepting.store(false, Ordering::Release);
                        break;
                    }
                    ndi_frame.data_mut().copy_from_slice(ready.bytes());
                    // grafton-ndi documents this call as synchronously copying bytes.
                    sender.send_video(&ndi_frame);
                    drop(ready);
                    health_interval = health_interval.wrapping_add(1);
                    if health_interval == 0 && sender.connection_count(Duration::ZERO).is_err() {
                        let _ = worker_error.set("NDI network health query failed".to_string());
                        worker_accepting.store(false, Ordering::Release);
                    }
                }
                while let Some(ready) = pool.try_dequeue_for_send() {
                    drop(ready);
                }
            })
            .map_err(|error| format!("could not start NDI transmission worker: {error}"))?;
        match started_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                accepting,
                terminal_error,
                thread: Some(thread),
            }),
            Ok(Err(error)) => {
                let _ = thread.join();
                Err(error)
            }
            Err(error) => {
                let _ = thread.join();
                Err(format!("NDI worker stopped during startup: {error}"))
            }
        }
    }

    fn take_error(&self) -> Option<String> {
        self.terminal_error.get().cloned()
    }

    fn stop(&mut self) {
        self.accepting.store(false, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[cfg(feature = "ndi")]
impl Drop for NdiWorker {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The Engine-owned NDI worker is the only owner of the sender. Program only
/// acquires a bounded slab and publishes its index for that worker.
#[cfg(feature = "ndi")]
pub struct NdiSink {
    options: NdiOptions,
    format: OutputFormat,
    pool: Option<Arc<NdiFramePool>>,
    worker: Option<NdiWorker>,
}

#[cfg(feature = "ndi")]
impl NdiSink {
    pub fn new(options: NdiOptions) -> Self {
        Self {
            options,
            format: OutputFormat::default(),
            pool: None,
            worker: None,
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
        false
    }

    fn configure(&mut self, format: &OutputFormat) -> Result<Vec<String>, String> {
        if self.worker.is_some() {
            return Err(
                "cannot reconfigure NDI while its transmission worker is running".to_string(),
            );
        }
        validate_ndi_format(format)?;
        let pool = NdiFramePool::new(
            format.width,
            format.height,
            usize::from(self.options.frame_pool_slots),
        )
        .map_err(str::to_string)?;
        self.format = format.clone();
        self.pool = Some(Arc::new(pool));
        Ok(vec![format!(
            "NDI source \"{}\" has not been certified against a network; do not rely on it for a live show",
            self.options.source_name
        )])
    }

    fn start(&mut self) -> Result<(), String> {
        if self.worker.is_some() {
            return Err("NDI transmission worker is already running".to_string());
        }
        let pool = Arc::clone(
            self.pool
                .as_ref()
                .ok_or_else(|| "NDI must be configured before starting".to_string())?,
        );
        self.worker = Some(NdiWorker::start(pool, &self.options, &self.format)?);
        Ok(())
    }

    fn stop(&mut self) {
        if let Some(mut worker) = self.worker.take() {
            worker.stop();
        }
    }

    fn send(&mut self, frame: &VideoFrame) -> Result<bool, String> {
        let worker = self
            .worker
            .as_ref()
            .ok_or_else(|| "NDI received a frame before start".to_string())?;
        if let Some(error) = worker.take_error() {
            return Err(error);
        }
        if frame.width != self.format.width || frame.height != self.format.height {
            return Err("NDI frame dimensions do not match configured output format".to_string());
        }
        let pool = self
            .pool
            .as_ref()
            .expect("configured NDI always owns a fixed frame pool");
        let Some(mut lease) = pool.try_acquire_for_readback() else {
            return Ok(false);
        };
        let slab = lease.slab_mut();
        if slab.len() != frame.data.len() {
            let expected_len = slab.len();
            lease.cancel();
            return Err(format!(
                "NDI frame byte length {} does not match configured slab length {expected_len}",
                frame.data.len()
            ));
        }
        slab.copy_from_slice(&frame.data);
        Ok(lease.complete(frame.frame_index, 0))
    }

    fn take_async_error(&mut self) -> Option<String> {
        self.worker.as_ref().and_then(NdiWorker::take_error)
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

    pub fn is_error(&self) -> bool {
        self.state == OutputState::Error
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

        if let Some(error) = self.sink.take_async_error() {
            self.last_error = Some(error);
            self.state = OutputState::Error;
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
    create_sink_with_ndi_pool_slots(
        adapter_id,
        cache_directory,
        options,
        DEFAULT_NDI_FRAME_POOL_SLOTS,
    )
}

/// Build a sink using the deployment-selected fixed NDI pool size.
pub fn create_sink_with_ndi_pool_slots(
    adapter_id: &str,
    cache_directory: &PathBuf,
    options: &serde_json::Value,
    ndi_frame_pool_slots: u8,
) -> Result<Box<dyn OutputSink>, String> {
    #[cfg(not(feature = "ndi"))]
    let _ = ndi_frame_pool_slots;
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
        "ndi" => Ok(Box::new(NdiSink::new(NdiOptions::from_json(
            options,
            ndi_frame_pool_slots,
            false,
        )?))),

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
