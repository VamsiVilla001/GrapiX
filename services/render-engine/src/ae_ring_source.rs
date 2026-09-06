//! The real consumer for `AE-F1`'s adapter-owned frame ring.
//!
//! `AE-F2a` needs one live path from an evaluated After Effects frame to Program, and until this
//! module existed there was none: `AeProgramFrameSource` had a scripted test implementation only,
//! and the adapter's live `checkout … ring …` publish had nothing to deliver to.
//!
//! This module is deliberately small and unfriendly to misuse. It opens the Windows named mapping
//! the adapter created, mirrors `ae-plugin/runtime-adapter/src/frame_ring.h`'s wire layout byte for
//! byte, acquires one read lease, converts the fixed native descriptor into `AeFrameDescriptor`,
//! and releases the slot on every exit. It never reads pixels through a protocol message, never
//! allocates a staging slab per frame, and **never calls an Adobe SDK** — the adapter owns After
//! Effects; the engine owns Program.
//!
//! The layout contract is the C++ source of truth. These `repr(C)` mirrors exist only because the
//! adapter is already live on a licensed host; changing one without the other changes the wire and
//! is a protocol break, not a refactor.

use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};

use windows_sys::Win32::Foundation::{CloseHandle, FALSE};
use windows_sys::Win32::System::Memory::{
    MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, VirtualQuery, FILE_MAP_ALL_ACCESS,
    MEMORY_BASIC_INFORMATION, MEMORY_MAPPED_VIEW_ADDRESS,
};

use crate::ae_ingress::{
    AeFrameSourceError, AeLeasedFrame, AeProgramFrameSource,
};
use crate::protocol::{AeExactTime, AeFrameColorFormat, AeFrameDescriptor, AeFrameStatus};

const FRAME_RING_MAGIC: u32 = 0x4758_4652; // "GXFR"
const FRAME_RING_VERSION: u32 = 1;
const FRAME_RING_ALIGNMENT: usize = 64;
const FRAME_RING_MAX_SLOTS: u32 = 64;

const SLOT_FREE: u32 = 0;
const SLOT_READY: u32 = 2;
const SLOT_READING: u32 = 3;

const FORMAT_BGRA8: u32 = 1;
const FORMAT_RGBA8: u32 = 2;
const FORMAT_ARGB8: u32 = 3;

const ALPHA_PREMULTIPLIED: u32 = 1;
const ALPHA_STRAIGHT: u32 = 2;
const ALPHA_OPAQUE: u32 = 3;

const STATUS_READY: u32 = 1;
const STATUS_LATE: u32 = 2;
const STATUS_MISSED: u32 = 3;

const COLOR_PREMULTIPLIED: &str = "premultiplied";
const COLOR_STRAIGHT: &str = "straight";
const COLOR_OPAQUE: &str = "opaque";

const fn align_up(value: usize, alignment: usize) -> usize {
    (value + alignment - 1) / alignment * alignment
}

const fn slot_size() -> usize {
    align_up(320, FRAME_RING_ALIGNMENT)
}

#[repr(C, align(64))]
#[derive(Clone, Copy)]
struct NativeRingDescriptor {
    ring_generation: u64,
    slot_index: u32,
    frame_id: u64,
    data_revision: u64,
    composition_item_id: i64,
    requested_time_value: [u8; 32],
    requested_time_scale: [u8; 32],
    evaluated_time_value: [u8; 32],
    evaluated_time_scale: [u8; 32],
    presentation_deadline_nanos: u64,
    width: u32,
    height: u32,
    stride: u32,
    color_format: u32,
    alpha_mode: u32,
    color_space: [u8; 32],
    status: u32,
}



#[repr(C, align(64))]
struct NativeRingHeader {
    magic: u32,
    version: u32,
    header_bytes: u32,
    slot_bytes: u32,
    slot_count: u32,
    max_width: u32,
    max_height: u32,
    max_stride: u32,
    configured_color_format: u32,
    reserved: u32,
    generation: u64,
    producer_owner_id: u64,
    consumer_owner_id: u64,
    producer_cursor: u64,
    produced_sequence: u64,
    consumed_sequence: u64,
    free_depth: u64,
    ready_depth: u64,
    ready_high_water: u64,
    producer_drops: u64,
    back_pressure_events: u64,
    consumer_stale_generation_rejects: u64,
    consumer_stale_revision_rejects: u64,
    checksum_faults: u64,
    lease_duration_nanos: u64,
    sequence_gaps: u64,
    allocations_after_configure: u64,
}

#[repr(C, align(64))]
#[derive(Clone, Copy)]
struct NativeRingSlot {
    state: u32,
    index: u32,
    generation: u64,
    producer_owner_id: u64,
    consumer_owner_id: u64,
    write_started_nanos: u64,
    checksum: u64,
    byte_length: u64,
    publish_sequence: u64,
    descriptor: NativeRingDescriptor,
}

const _: () = assert!(size_of::<NativeRingDescriptor>() == 256);

struct AcquiredSlot {
    index: u32,
    generation: u64,
    descriptor: AeFrameDescriptor,
    byte_length: usize,
}

fn atomic_u32(ptr: *mut u32) -> &'static AtomicU32 {
    unsafe { &*(ptr as *const AtomicU32) }
}

fn atomic_u64(ptr: *mut u64) -> &'static AtomicU64 {
    unsafe { &*(ptr as *const AtomicU64) }
}

pub struct MappedAeProgramFrameSource {
    owner_id: u64,
    expected_revision: u64,
    expected_generation: Option<u64>,
    mapping_handle: *mut c_void,
    view: MEMORY_MAPPED_VIEW_ADDRESS,
    mapped_bytes: usize,
    header: *mut NativeRingHeader,
    outstanding: Option<AcquiredSlot>,
}

unsafe impl Send for MappedAeProgramFrameSource {}

impl MappedAeProgramFrameSource {
    /// Open the adapter's session mapping and claim the single consumer owner id.
    ///
    /// The mapping is already pinned by the adapter's own producer handle; this owner claim is a
    /// contract marker, not a memory lifetime. `expected_generation` belongs to the negotiated
    /// session and is checked after acquisition, so a re-created mapping is refused on the frame
    /// boundary rather than silently accepted because the mapping happens to exist.
    pub fn open(
        mapping_name: impl AsRef<Path>,
        owner_id: u64,
        expected_revision: u64,
        expected_generation: Option<u64>,
    ) -> Result<Self, AeFrameSourceError> {
        if owner_id == 0 {
            return Err(AeFrameSourceError {
                slot_index: None,
                detail: "frame ring consumer owner id must be non-zero".to_string(),
            });
        }
        let name = mapping_name.as_ref().to_string_lossy().into_owned();
        let wide: Vec<u16> = std::ffi::OsStr::new(&name)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        let mapping_handle = unsafe { OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, wide.as_ptr()) };
        if mapping_handle.is_null() {
            return Err(AeFrameSourceError {
                slot_index: None,
                detail: format!("frame ring mapping {name} is not available"),
            });
        }
        let view = unsafe { MapViewOfFile(mapping_handle, FILE_MAP_ALL_ACCESS, 0, 0, 0) };
        if view.Value.is_null() {
            unsafe { CloseHandle(mapping_handle) };
            return Err(AeFrameSourceError {
                slot_index: None,
                detail: format!("frame ring mapping {name} could not be mapped"),
            });
        }

        let mut info: MEMORY_BASIC_INFORMATION = unsafe { zeroed() };
        let queried = unsafe {
            VirtualQuery(
                view.Value as *const c_void,
                &mut info,
                size_of::<MEMORY_BASIC_INFORMATION>(),
            )
        };
        if queried == 0 {
            unsafe {
                UnmapViewOfFile(view);
                CloseHandle(mapping_handle);
            }
            return Err(AeFrameSourceError {
                slot_index: None,
                detail: format!("frame ring mapping {name} could not be inspected"),
            });
        }
        let header = view.Value as *mut NativeRingHeader;
        let mapped_bytes = info.RegionSize;
        let header_ref = unsafe { &*header };
        let required_bytes = size_of::<NativeRingHeader>()
            + header_ref.slot_count as usize * header_ref.slot_bytes as usize;
        if mapped_bytes < size_of::<NativeRingHeader>()
            || header_ref.magic != FRAME_RING_MAGIC
            || header_ref.version != FRAME_RING_VERSION
            || header_ref.header_bytes as usize != size_of::<NativeRingHeader>()
            || header_ref.slot_count < 2
            || header_ref.slot_count > FRAME_RING_MAX_SLOTS
            || header_ref.slot_bytes as usize != slot_size() + header_ref.max_stride as usize * header_ref.max_height as usize
            || header_ref.slot_bytes as usize % FRAME_RING_ALIGNMENT != 0
            || mapped_bytes < required_bytes
        {
            let detail = format!(
                "mapped={} magic=0x{:08x} version={} header_bytes={} slot_count={} slot_bytes={} required={}",
                mapped_bytes,
                header_ref.magic,
                header_ref.version,
                header_ref.header_bytes,
                header_ref.slot_count,
                header_ref.slot_bytes,
                required_bytes
            );
            unsafe {
                UnmapViewOfFile(view);
                CloseHandle(mapping_handle);
            }
            return Err(AeFrameSourceError {
                slot_index: None,
                detail: format!("frame ring mapping {name} does not match the AE-F1 wire layout: {detail}"),
            });
        }

        let claimed = atomic_u64(unsafe { &raw mut (*header).consumer_owner_id })
            .compare_exchange(0, owner_id, Ordering::AcqRel, Ordering::Acquire)
            .unwrap_or_else(|seen| seen);
        if claimed != 0 && claimed != owner_id {
            unsafe {
                UnmapViewOfFile(view);
                CloseHandle(mapping_handle);
            }
            return Err(AeFrameSourceError {
                slot_index: None,
                detail: format!("frame ring mapping {name} already has a live consumer"),
            });
        }
        if header_ref.magic != FRAME_RING_MAGIC || atomic_u64(unsafe { &raw mut (*header).consumer_owner_id }).load(Ordering::Acquire) != owner_id {
            unsafe {
                UnmapViewOfFile(view);
                CloseHandle(mapping_handle);
            }
            return Err(AeFrameSourceError {
                slot_index: None,
                detail: format!("frame ring mapping {name} consumer ownership could not be claimed"),
            });
        }

        Ok(Self {
            owner_id,
            expected_revision,
            expected_generation,
            mapping_handle,
            view,
            mapped_bytes,
            header,
            outstanding: None,
        })
    }

    /// Derive the exact local mapping name the adapter uses for a managed runtime session.
    pub fn mapping_name_for_session(session_id: &str) -> String {
        format!(r"Local\GrapiX-AeFrameRing-v1-{session_id}")
    }

    fn slot_ptr(&self, index: u32) -> *mut NativeRingSlot {
        let header = unsafe { &*self.header };
        (self.view.Value as *mut u8)
            .wrapping_add(size_of::<NativeRingHeader>())
            .wrapping_add(index as usize * header.slot_bytes as usize)
            .cast::<NativeRingSlot>()
    }

    fn payload_ptr(&self, slot: *mut NativeRingSlot) -> *const u8 {
        (slot as *const u8).wrapping_add(size_of::<NativeRingSlot>())
    }

    fn close_mapping(&mut self) {
        if !self.view.Value.is_null() {
            unsafe { UnmapViewOfFile(self.view) };
            self.view = MEMORY_MAPPED_VIEW_ADDRESS { Value: std::ptr::null_mut() };
            self.header = std::ptr::null_mut();
        }
        if !self.mapping_handle.is_null() {
            unsafe { CloseHandle(self.mapping_handle) };
            self.mapping_handle = std::ptr::null_mut();
        }
    }

    fn decode_text(field: &[u8; 32], what: &str, slot_index: u32) -> Result<String, AeFrameSourceError> {
        let end = field.iter().position(|byte| *byte == 0).ok_or_else(|| AeFrameSourceError {
            slot_index: Some(slot_index),
            detail: format!("frame ring descriptor {what} is not terminated"),
        })?;
        if end == 0 {
            return Err(AeFrameSourceError {
                slot_index: Some(slot_index),
                detail: format!("frame ring descriptor {what} is empty"),
            });
        }
        std::str::from_utf8(&field[..end])
            .map_err(|_| AeFrameSourceError {
                slot_index: Some(slot_index),
                detail: format!("frame ring descriptor {what} is not UTF-8"),
            })
            .map(ToOwned::to_owned)
    }

    fn decode_time(
        &self,
        value: &[u8; 32],
        scale: &[u8; 32],
        slot_index: u32,
        which: &str,
    ) -> Result<AeExactTime, AeFrameSourceError> {
        let value = Self::decode_text(value, &format!("{which} time value"), slot_index)?;
        let scale = Self::decode_text(scale, &format!("{which} time scale"), slot_index)?;
        if !valid_decimal(&value, false) || !valid_decimal(&scale, true) {
            return Err(AeFrameSourceError {
                slot_index: Some(slot_index),
                detail: format!("frame ring descriptor {which} time is not a decimal rational"),
            });
        }
        Ok(AeExactTime { value, scale })
    }

    /// Take whichever frame is ready, for a consumer whose only job is to free slots.
    ///
    /// `take_ready_frame` is Program's accessor and deliberately refuses a frame other than the one
    /// asked for — presenting an unrequested frame is the failure `AE-F2a` exists to prevent. A drain
    /// has no request to match: it exists so a producer can be measured against a ring that is being
    /// emptied, since a bounded ring with no consumer stops after four frames and measures its own
    /// refusal path instead of the frame path. Returns the frame id and the slot the caller must
    /// release.
    pub fn take_any_ready_frame(&mut self) -> Result<Option<(u64, u32)>, AeFrameSourceError> {
        let Some(slot) = self.acquire(0)? else {
            return Ok(None);
        };
        Ok(Some((slot.descriptor.frame_id, slot.index)))
    }

    fn acquire(&mut self, _frame: u64) -> Result<Option<AcquiredSlot>, AeFrameSourceError> {
        if self.outstanding.is_some() {
            return Err(AeFrameSourceError {
                slot_index: None,
                detail: "frame ring consumer attempted to acquire a second outstanding lease".to_string(),
            });
        }
        let header = unsafe { &*self.header };
        let minimum_mapping = size_of::<NativeRingHeader>() + header.slot_count as usize * header.slot_bytes as usize;
        if self.mapped_bytes < minimum_mapping {
            return Err(AeFrameSourceError {
                slot_index: None,
                detail: "frame ring mapping is smaller than its own advertised slot range".to_string(),
            });
        }
        if header.max_width == 0 || header.max_height == 0 || header.max_stride < header.max_width * 4 {
            return Err(AeFrameSourceError {
                slot_index: None,
                detail: "frame ring header has impossible negotiated geometry".to_string(),
            });
        }
        let slot_count = header.slot_count;
        let mut candidate: Option<(u32, u64)> = None;
        for index in 0..slot_count {
            let slot = self.slot_ptr(index);
            let state = atomic_u32(unsafe { &raw mut (*slot).state }).load(Ordering::Acquire);
            if state != SLOT_READY {
                continue;
            }
            let sequence = atomic_u64(unsafe { &raw mut (*slot).publish_sequence }).load(Ordering::Acquire);
            if candidate.as_ref().is_none_or(|(_, best)| sequence < *best) {
                candidate = Some((index, sequence));
            }
        }
        let Some((slot_index, _sequence)) = candidate else {
            return Ok(None);
        };
        let slot = self.slot_ptr(slot_index);
        let acquired = atomic_u32(unsafe { &raw mut (*slot).state })
            .compare_exchange(SLOT_READY, SLOT_READING, Ordering::AcqRel, Ordering::Acquire)
            .unwrap_or_else(|seen| seen);
        if acquired != SLOT_READY {
            return Ok(None);
        }

        atomic_u64(unsafe { &raw mut (*self.header).ready_depth }).fetch_sub(1, Ordering::Relaxed);
        atomic_u64(unsafe { &raw mut (*slot).consumer_owner_id }).store(self.owner_id, Ordering::Release);

        let release_after_fault = |this: &mut Self, slot: *mut NativeRingSlot| {
            atomic_u64(unsafe { &raw mut (*slot).consumer_owner_id }).store(0, Ordering::Release);
            atomic_u32(unsafe { &raw mut (*slot).state }).store(SLOT_FREE, Ordering::Release);
            atomic_u64(unsafe { &raw mut (*this.header).free_depth }).fetch_add(1, Ordering::Relaxed);
        };

        let generation = atomic_u64(unsafe { &raw mut (*self.header).generation }).load(Ordering::Acquire);
        let slot_generation = atomic_u64(unsafe { &raw mut (*slot).generation }).load(Ordering::Acquire);
        let descriptor = unsafe { (*slot).descriptor };
        let byte_length = atomic_u64(unsafe { &raw mut (*slot).byte_length }).load(Ordering::Acquire) as usize;
        let checksum = atomic_u64(unsafe { &raw mut (*slot).checksum }).load(Ordering::Acquire);
        let payload = self.payload_ptr(slot);

        let fail = |this: &mut Self, counter: fn(&mut Self), code: &str, detail: String| -> AeFrameSourceError {
            counter(this);
            release_after_fault(this, slot);
            AeFrameSourceError {
                slot_index: Some(slot_index),
                detail: format!("{code}: {detail}"),
            }
        };

        if slot_generation != generation || descriptor.ring_generation != generation {
            return Err(fail(self, Self::bump_stale_generation, "STALE_GENERATION", format!(
                "slot generation {slot_generation}, descriptor generation {}, ring generation {generation}",
                descriptor.ring_generation
            )));
        }
        if let Some(expected_generation) = self.expected_generation {
            if generation != expected_generation {
                return Err(fail(self, Self::bump_stale_generation, "STALE_GENERATION", format!(
                    "ring generation {generation} is not negotiated generation {expected_generation}"
                )));
            }
        }
        if descriptor.data_revision != self.expected_revision {
            return Err(fail(self, Self::bump_stale_revision, "STALE_REVISION", format!(
                "descriptor revision {} is not expected {}",
                descriptor.data_revision, self.expected_revision
            )));
        }

        let payload_capacity = header.slot_bytes as usize - size_of::<NativeRingSlot>();
        if byte_length > payload_capacity || checksum != fnv1a(payload, byte_length) {
            return Err(fail(self, Self::bump_checksum_fault, "CHECKSUM_FAULT", format!(
                "slot payload length {byte_length}, capacity {payload_capacity}"
            )));
        }

        let descriptor = self.translate_descriptor(&descriptor, byte_length).map_err(|mut error| {
            error.slot_index = Some(slot_index);
            release_after_fault(self, slot);
            error
        })?;

        let sequence = atomic_u64(unsafe { &raw mut (*slot).publish_sequence }).load(Ordering::Acquire);
        let prior = atomic_u64(unsafe { &raw mut (*self.header).consumed_sequence })
            .swap(sequence, Ordering::Relaxed);
        if prior != 0 && sequence != prior + 1 {
            atomic_u64(unsafe { &raw mut (*self.header).sequence_gaps }).fetch_add(1, Ordering::Relaxed);
        }

        self.outstanding = Some(AcquiredSlot {
            index: slot_index,
            generation,
            descriptor,
            byte_length,
        });
        Ok(self.outstanding.as_ref().map(|slot| AcquiredSlot {
            index: slot.index,
            generation: slot.generation,
            descriptor: slot.descriptor.clone(),
            byte_length: slot.byte_length,
        }))
    }

    fn translate_descriptor(
        &self,
        native: &NativeRingDescriptor,
        byte_length: usize,
    ) -> Result<AeFrameDescriptor, AeFrameSourceError> {
        let slot_index = native.slot_index;
        if native.width == 0 || native.height == 0 || native.stride < native.width * 4 {
            return Err(AeFrameSourceError {
                slot_index: Some(slot_index),
                detail: "frame ring descriptor has impossible geometry".to_string(),
            });
        }
        let header = unsafe { &*self.header };
        if native.width > header.max_width || native.height > header.max_height || native.stride > header.max_stride {
            return Err(AeFrameSourceError {
                slot_index: Some(slot_index),
                detail: "frame ring descriptor exceeds the negotiated geometry".to_string(),
            });
        }
        if native.color_format != header.configured_color_format {
            return Err(AeFrameSourceError {
                slot_index: Some(slot_index),
                detail: "frame ring descriptor format does not match the configured format".to_string(),
            });
        }
        if usize::try_from(native.stride)
            .ok()
            .and_then(|stride| stride.checked_mul(usize::try_from(native.height).ok()?))
            != Some(byte_length)
        {
            return Err(AeFrameSourceError {
                slot_index: Some(slot_index),
                detail: "frame ring descriptor geometry does not match its payload length".to_string(),
            });
        }
        let color_format = match native.color_format {
            FORMAT_BGRA8 => AeFrameColorFormat::Bgra8,
            FORMAT_RGBA8 => AeFrameColorFormat::Rgba8,
            FORMAT_ARGB8 => AeFrameColorFormat::Argb8,
            other => {
                return Err(AeFrameSourceError {
                    slot_index: Some(slot_index),
                    detail: format!("frame ring descriptor has unknown colour format {other}"),
                })
            }
        };
        let alpha_mode = match native.alpha_mode {
            ALPHA_PREMULTIPLIED => COLOR_PREMULTIPLIED,
            ALPHA_STRAIGHT => COLOR_STRAIGHT,
            ALPHA_OPAQUE => COLOR_OPAQUE,
            other => {
                return Err(AeFrameSourceError {
                    slot_index: Some(slot_index),
                    detail: format!("frame ring descriptor has unknown alpha mode {other}"),
                })
            }
        };
        let status = match native.status {
            STATUS_READY => AeFrameStatus::Ready,
            STATUS_LATE => AeFrameStatus::Late,
            STATUS_MISSED => AeFrameStatus::Missed,
            other => {
                return Err(AeFrameSourceError {
                    slot_index: Some(slot_index),
                    detail: format!("frame ring descriptor has unknown status {other}"),
                })
            }
        };
        let color_space = Self::decode_text(&native.color_space, "colour space", slot_index)?;
        Ok(AeFrameDescriptor {
            ring_generation: native.ring_generation,
            slot_index,
            frame_id: native.frame_id,
            data_revision: native.data_revision,
            composition_item_id: native.composition_item_id,
            requested_time: self.decode_time(
                &native.requested_time_value,
                &native.requested_time_scale,
                slot_index,
                "requested",
            )?,
            evaluated_time: self.decode_time(
                &native.evaluated_time_value,
                &native.evaluated_time_scale,
                slot_index,
                "evaluated",
            )?,
            presentation_deadline_nanos: native.presentation_deadline_nanos,
            width: native.width,
            height: native.height,
            stride: native.stride,
            color_format,
            alpha_mode: alpha_mode.to_string(),
            color_space,
            status,
        })
    }

    fn release_outstanding(&mut self, slot_index: u32) {
        let Some(outstanding) = self.outstanding.take() else {
            return;
        };
        if outstanding.index != slot_index {
            self.outstanding = Some(outstanding);
            return;
        }
        let slot = self.slot_ptr(slot_index);
        let consumer = atomic_u64(unsafe { &raw mut (*slot).consumer_owner_id }).load(Ordering::Acquire);
        if consumer == self.owner_id {
            let released = atomic_u32(unsafe { &raw mut (*slot).state })
                .compare_exchange(SLOT_READING, SLOT_FREE, Ordering::AcqRel, Ordering::Acquire)
                .unwrap_or_else(|seen| seen);
            if released == SLOT_READING {
                let start = atomic_u64(unsafe { &raw mut (*slot).write_started_nanos }).load(Ordering::Acquire);
                if start != 0 {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|duration| duration.as_nanos() as u64)
                        .unwrap_or(0);
                    let elapsed = now.saturating_sub(start);
                    atomic_u64(unsafe { &raw mut (*self.header).lease_duration_nanos })
                        .fetch_add(elapsed, Ordering::Relaxed);
                }
                atomic_u64(unsafe { &raw mut (*slot).consumer_owner_id }).store(0, Ordering::Release);
                atomic_u64(unsafe { &raw mut (*self.header).free_depth }).fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    fn bump_stale_generation(&mut self) {
        atomic_u64(unsafe { &raw mut (*self.header).consumer_stale_generation_rejects })
            .fetch_add(1, Ordering::Relaxed);
    }

    fn bump_stale_revision(&mut self) {
        atomic_u64(unsafe { &raw mut (*self.header).consumer_stale_revision_rejects })
            .fetch_add(1, Ordering::Relaxed);
    }

    fn bump_checksum_fault(&mut self) {
        atomic_u64(unsafe { &raw mut (*self.header).checksum_faults }).fetch_add(1, Ordering::Relaxed);
    }
}

impl AeProgramFrameSource for MappedAeProgramFrameSource {
    fn take_ready_frame(
        &mut self,
        frame: u64,
    ) -> Result<Option<AeLeasedFrame<'_>>, AeFrameSourceError> {
        let Some(slot) = self.acquire(frame)? else {
            return Ok(None);
        };
        if slot.descriptor.frame_id != frame {
            let slot_index = slot.index;
            self.release_outstanding(slot_index);
            return Err(AeFrameSourceError {
                slot_index: Some(slot_index),
                detail: format!(
                    "frame ring returned frame {} while Program asked for frame {}",
                    slot.descriptor.frame_id, frame
                ),
            });
        }
        let bytes = unsafe {
            std::slice::from_raw_parts(
                self.payload_ptr(self.slot_ptr(slot.index)),
                slot.byte_length,
            )
        };
        let descriptor = self
            .outstanding
            .as_ref()
            .map(|outstanding| &outstanding.descriptor)
            .expect("acquired slot is outstanding");
        Ok(Some(AeLeasedFrame { descriptor, bytes }))
    }

    fn release_frame(&mut self, slot_index: u32) {
        self.release_outstanding(slot_index);
    }

    /// The mapping's own slot count, validated against the header when the session was opened.
    fn ring_slot_count(&self) -> Option<u32> {
        if self.header.is_null() {
            return None;
        }
        Some(unsafe { &*self.header }.slot_count)
    }
}

impl Drop for MappedAeProgramFrameSource {
    fn drop(&mut self) {
        if let Some(outstanding) = self.outstanding.take() {
            self.release_outstanding(outstanding.index);
        }
        if !self.header.is_null() {
            let consumer = atomic_u64(unsafe { &raw mut (*self.header).consumer_owner_id }).load(Ordering::Acquire);
            if consumer == self.owner_id {
                atomic_u64(unsafe { &raw mut (*self.header).consumer_owner_id }).store(0, Ordering::Release);
            }
        }
        self.close_mapping();
    }
}

fn valid_decimal(value: &str, require_nonzero: bool) -> bool {
    if value.is_empty() {
        return false;
    }
    let digits = value.strip_prefix('-').unwrap_or(value);
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    !require_nonzero || digits.bytes().any(|byte| byte != b'0')
}

fn fnv1a(bytes: *const u8, length: usize) -> u64 {
    let mut value = 1469598103934665603_u64;
    for index in 0..length {
        value ^= unsafe { *bytes.add(index) } as u64;
        value = value.wrapping_mul(1099511628211);
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_layout_matches_the_adapter_wire_contract() {
        assert_eq!(align_of::<NativeRingHeader>(), FRAME_RING_ALIGNMENT);
        assert_eq!(align_of::<NativeRingSlot>(), FRAME_RING_ALIGNMENT);
        assert_eq!(size_of::<NativeRingHeader>() % FRAME_RING_ALIGNMENT, 0);
        assert_eq!(size_of::<NativeRingDescriptor>(), 256);
        assert_eq!(size_of::<NativeRingSlot>(), slot_size());
        assert_eq!(slot_size(), 320);
    }

    #[test]
    fn decimal_validation_matches_the_adapter_contract() {
        assert!(valid_decimal("0", false));
        assert!(valid_decimal("-12", false));
        assert!(!valid_decimal("", false));
        assert!(!valid_decimal("12x", false));
        assert!(!valid_decimal("0", true));
        assert!(valid_decimal("1", true));
        assert!(valid_decimal("-1", true));
    }
}
