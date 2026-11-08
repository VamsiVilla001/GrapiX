//! L0 frame delivery through one shared mapping.
//!
//! The producer and consumer borrow the same anonymous mapping.  A pair of
//! buffers gives publication an inactive target: a reader holds a read lock on
//! its frame while the producer writes the other buffer.  When both choices
//! are unavailable, publication drops immediately instead of waiting.  This
//! makes invariant 13 and invariant 14 structural properties of the transport.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, RwLock, TryLockError};

use gx_contracts::Refusal;
use memmap2::{MmapMut, MmapOptions};

use crate::DropCounters;

const BUFFER_COUNT: usize = 2;
const NO_FRAME: u64 = 0;

/// Owns a local shared-memory latest-frame slot and creates its two endpoints.
#[derive(Clone)]
pub struct LocalMediaTransport {
    shared: Arc<SharedFrameSlot>,
}

/// The endpoint that writes Program frames into the shared mapping.
#[derive(Clone)]
pub struct LocalMediaProducer {
    shared: Arc<SharedFrameSlot>,
}

/// The endpoint that borrows published Program frames from the shared mapping.
#[derive(Clone)]
pub struct LocalMediaConsumer {
    shared: Arc<SharedFrameSlot>,
}

/// The result of one non-blocking publication attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishDisposition {
    /// The frame became the latest frame available to the consumer.
    Published { generation: u64 },
    /// A consumer retained the target buffer, so this frame was discarded.
    Dropped,
}

/// A direct, immutable view of one frame in the producer's mapping.
pub struct SharedFrame<'a> {
    bytes: &'a [u8],
    generation: u64,
}

impl<'a> SharedFrame<'a> {
    /// Bytes in the shared mapping.  This is a borrow, never a per-frame copy.
    pub fn bytes(&self) -> &'a [u8] {
        self.bytes
    }

    /// Monotonically increasing publication generation.
    pub fn generation(&self) -> u64 {
        self.generation
    }
}

impl LocalMediaTransport {
    /// Establishes the two-buffer L0 mapping for frames up to `frame_capacity` bytes.
    pub fn establish(frame_capacity: usize) -> Result<Self, Refusal> {
        if frame_capacity == 0 {
            return Err(media_unavailable(
                "shared-media mapping capacity must be greater than zero".into(),
            ));
        }

        let first = map_buffer(frame_capacity)?;
        let second = map_buffer(frame_capacity)?;
        Ok(Self {
            shared: Arc::new(SharedFrameSlot {
                buffers: [first, second],
                capacity: frame_capacity,
                published: AtomicU64::new(NO_FRAME),
                next_generation: AtomicU64::new(0),
                consumed_generation: AtomicU64::new(NO_FRAME),
                drops: AtomicDropCounters::default(),
            }),
        })
    }

    pub fn producer(&self) -> LocalMediaProducer {
        LocalMediaProducer {
            shared: Arc::clone(&self.shared),
        }
    }

    pub fn consumer(&self) -> LocalMediaConsumer {
        LocalMediaConsumer {
            shared: Arc::clone(&self.shared),
        }
    }
}

impl LocalMediaProducer {
    /// Writes one frame directly into the inactive shared buffer and publishes it.
    ///
    /// `write` receives the mapping itself, so a renderer can produce pixels in
    /// their final storage rather than producing a temporary frame and copying it.
    /// A held consumer view causes an immediate drop; waiting would let media
    /// influence Program cadence, which invariant 14 forbids.
    pub fn publish_with(
        &self,
        frame_len: usize,
        write: impl FnOnce(&mut [u8]),
    ) -> Result<PublishDisposition, Refusal> {
        if frame_len > self.shared.capacity {
            return Err(media_unavailable(format!(
                "frame length {frame_len} exceeds the {}-byte shared-media mapping",
                self.shared.capacity
            )));
        }

        let current = self.shared.published.load(Ordering::Acquire);
        let target = match current {
            NO_FRAME => 0,
            state => 1 - state_index(state),
        };
        let mut buffer = match self.shared.buffers[target].bytes.try_write() {
            Ok(buffer) => buffer,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            // A stalled reader owns the only buffer that is safe to replace.
            // Dropping this frame is preferable to blocking Program (invariants
            // 13 and 14), and the cause remains visible to operators.
            Err(TryLockError::WouldBlock) => {
                self.shared
                    .drops
                    .consumer_busy
                    .fetch_add(1, Ordering::Relaxed);
                return Ok(PublishDisposition::Dropped);
            }
        };

        write(&mut buffer[..frame_len]);
        self.shared.buffers[target]
            .len
            .store(frame_len, Ordering::Relaxed);

        let generation = self.shared.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
        let state = encode_state(generation, target);
        // The release store makes both pixel writes and the declared length
        // visible before a reader accepts this generation.
        self.shared.published.store(state, Ordering::Release);

        if current != NO_FRAME
            && self.shared.consumed_generation.load(Ordering::Acquire) != state_generation(current)
        {
            self.shared
                .drops
                .consumer_busy
                .fetch_add(1, Ordering::Relaxed);
        }

        Ok(PublishDisposition::Published { generation })
    }

    pub fn drops(&self) -> DropCounters {
        self.shared.drops.snapshot()
    }
}

impl LocalMediaConsumer {
    /// Borrows the newest complete frame for `read`, without copying its bytes.
    ///
    /// Publication is checked both before and after taking the read lock.  If a
    /// writer changed generations between those operations, this call retries
    /// instead of allowing a view that could straddle two frames.  Once the
    /// lock is held, a writer can only drop, never mutate these bytes.
    pub fn with_latest<T>(&self, read: impl FnOnce(SharedFrame<'_>) -> T) -> Option<T> {
        let mut read = Some(read);
        for _ in 0..BUFFER_COUNT {
            let before = self.shared.published.load(Ordering::Acquire);
            if before == NO_FRAME {
                return None;
            }
            let index = state_index(before);
            let buffer = recover_read(&self.shared.buffers[index].bytes);
            if self.shared.published.load(Ordering::Acquire) != before {
                drop(buffer);
                continue;
            }

            let length = self.shared.buffers[index].len.load(Ordering::Relaxed);
            self.shared
                .consumed_generation
                .store(state_generation(before), Ordering::Release);
            let frame = SharedFrame {
                bytes: &buffer[..length],
                generation: state_generation(before),
            };
            return Some(read.take().expect("the reader closure is used once")(frame));
        }
        None
    }

    pub fn drops(&self) -> DropCounters {
        self.shared.drops.snapshot()
    }
}

struct SharedFrameSlot {
    buffers: [MappedBuffer; BUFFER_COUNT],
    capacity: usize,
    published: AtomicU64,
    next_generation: AtomicU64,
    consumed_generation: AtomicU64,
    drops: AtomicDropCounters,
}

struct MappedBuffer {
    bytes: RwLock<MmapMut>,
    len: AtomicUsize,
}

#[derive(Default)]
struct AtomicDropCounters {
    consumer_busy: AtomicU64,
    encoder_saturated: AtomicU64,
    transport_full: AtomicU64,
}

impl AtomicDropCounters {
    fn snapshot(&self) -> DropCounters {
        DropCounters {
            consumer_busy: self.consumer_busy.load(Ordering::Relaxed),
            encoder_saturated: self.encoder_saturated.load(Ordering::Relaxed),
            transport_full: self.transport_full.load(Ordering::Relaxed),
        }
    }
}

fn map_buffer(frame_capacity: usize) -> Result<MappedBuffer, Refusal> {
    MmapOptions::new()
        .len(frame_capacity)
        .map_anon()
        .map(|bytes| MappedBuffer {
            bytes: RwLock::new(bytes),
            len: AtomicUsize::new(0),
        })
        .map_err(|error| {
            media_unavailable(format!(
                "could not establish a {frame_capacity}-byte shared-media mapping: {error}"
            ))
        })
}

fn recover_read(mapping: &RwLock<MmapMut>) -> std::sync::RwLockReadGuard<'_, MmapMut> {
    // A producer callback panic never publishes its partial frame.  Recovering
    // this lock therefore preserves the last released generation instead of
    // turning a local callback failure into a silent stale-frame substitution.
    mapping
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn media_unavailable(detail: String) -> Refusal {
    Refusal::MediaTransportUnavailable { detail }
}

fn encode_state(generation: u64, index: usize) -> u64 {
    (generation << 1) | index as u64
}

fn state_generation(state: u64) -> u64 {
    state >> 1
}

fn state_index(state: u64) -> usize {
    (state & 1) as usize
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::sync::{Arc, Barrier};
    use std::thread;
    use std::time::Duration;

    use super::*;

    #[test]
    fn consumer_borrows_the_producers_mapping_without_a_frame_copy() {
        let transport = LocalMediaTransport::establish(16).expect("the local mapping establishes");
        let producer = transport.producer();
        let consumer = transport.consumer();
        let producer_address = AtomicUsize::new(0);

        assert_eq!(
            producer
                .publish_with(4, |bytes| {
                    producer_address.store(bytes.as_ptr() as usize, Ordering::Relaxed);
                    bytes.copy_from_slice(&[1, 2, 3, 4]);
                })
                .expect("the frame fits the mapping"),
            PublishDisposition::Published { generation: 1 }
        );
        let observed = consumer.with_latest(|frame| {
            assert_eq!(
                frame.bytes().as_ptr() as usize,
                producer_address.load(Ordering::Relaxed)
            );
            assert_eq!(frame.bytes(), [1, 2, 3, 4]);
            frame.generation()
        });
        assert_eq!(observed, Some(1));
    }

    #[test]
    fn a_stalled_consumer_drops_frames_without_blocking_the_producer() {
        let transport = LocalMediaTransport::establish(8).expect("the local mapping establishes");
        let producer = transport.producer();
        let consumer = transport.consumer();
        producer
            .publish_with(8, |bytes| bytes.fill(1))
            .expect("the first frame fits");

        let reader_entered = Arc::new(Barrier::new(2));
        let reader_release = Arc::new(Barrier::new(2));
        let reader_entered_clone = Arc::clone(&reader_entered);
        let reader_release_clone = Arc::clone(&reader_release);
        let reader = thread::spawn(move || {
            consumer.with_latest(|_| {
                reader_entered_clone.wait();
                reader_release_clone.wait();
            });
        });
        reader_entered.wait();

        let (sent, received) = mpsc::channel();
        let publishing = thread::spawn(move || {
            let first = producer.publish_with(8, |bytes| bytes.fill(2));
            let second = producer.publish_with(8, |bytes| bytes.fill(3));
            sent.send((first, second))
                .expect("test receiver remains available");
        });
        let (first, second) = received
            .recv_timeout(Duration::from_secs(1))
            .expect("a held consumer must not make publication wait");
        assert!(matches!(first, Ok(PublishDisposition::Published { .. })));
        assert_eq!(second, Ok(PublishDisposition::Dropped));
        reader_release.wait();
        publishing.join().expect("producer thread did not panic");
        reader.join().expect("consumer thread did not panic");
        assert_eq!(transport.producer().drops().consumer_busy, 1);
    }

    #[test]
    fn concurrent_publication_never_exposes_a_torn_frame() {
        const FRAME_LEN: usize = 16 * 1024;
        const WRITES: usize = 2_000;

        let transport = Arc::new(
            LocalMediaTransport::establish(FRAME_LEN).expect("the local mapping establishes"),
        );
        let producer = transport.producer();
        let consumer = transport.consumer();
        producer
            .publish_with(FRAME_LEN, |bytes| bytes.fill(0x11))
            .expect("the initial frame fits");

        let done = Arc::new(AtomicBool::new(false));
        let saw_frame = Arc::new(AtomicUsize::new(0));
        let producer_done = Arc::clone(&done);
        let publisher = thread::spawn(move || {
            for value in 0..WRITES {
                let fill = if value % 2 == 0 { 0x55 } else { 0xaa };
                let _ = producer.publish_with(FRAME_LEN, |bytes| bytes.fill(fill));
            }
            producer_done.store(true, Ordering::Release);
        });

        while !done.load(Ordering::Acquire) {
            if let Some(()) = consumer.with_latest(|frame| {
                let bytes = frame.bytes();
                assert!(
                    bytes.iter().all(|byte| *byte == bytes[0]),
                    "a frame mixed two generations"
                );
                saw_frame.fetch_add(1, Ordering::Relaxed);
            }) {}
        }
        publisher.join().expect("publisher thread did not panic");
        for _ in 0..32 {
            let _ = consumer.with_latest(|frame| {
                let bytes = frame.bytes();
                assert!(
                    bytes.iter().all(|byte| *byte == bytes[0]),
                    "a frame mixed two generations"
                );
                saw_frame.fetch_add(1, Ordering::Relaxed);
            });
        }
        assert!(
            saw_frame.load(Ordering::Relaxed) > 0,
            "the consumer observed no frames"
        );
    }

    #[test]
    fn an_unmappable_slot_refuses_by_name() {
        assert!(matches!(
            LocalMediaTransport::establish(0),
            Err(Refusal::MediaTransportUnavailable { detail }) if detail.contains("capacity")
        ));
    }
}
