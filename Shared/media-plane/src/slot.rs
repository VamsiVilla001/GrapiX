//! "Drop, never queue" as a data structure (ADR-001, invariant 13).
//!
//! The media plane's loss tolerance is not a policy applied at the edges; it
//! is the shape of the buffer. A single slot cannot queue, so no amount of
//! consumer slowness can turn into producer backpressure, and invariant 14 —
//! no media path may influence Program cadence — holds by construction rather
//! than by review.

use crate::DropCounters;

/// Why a frame was discarded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropCause {
    /// The consumer had not taken the previous frame.
    ConsumerBusy,
    /// The encoder had no capacity.
    EncoderSaturated,
    /// Transport backpressure.
    TransportFull,
}

/// Holds at most one frame, overwriting whatever is unread.
///
/// The newest frame is always the useful one: a confidence monitor showing a
/// frame from two seconds ago is worse than one that skipped to the present.
#[derive(Debug, Clone, Default)]
pub struct LatestFrameSlot<T> {
    slot: Option<T>,
    drops: DropCounters,
}

impl<T> LatestFrameSlot<T> {
    pub fn new() -> Self {
        Self {
            slot: None,
            drops: DropCounters::default(),
        }
    }

    /// Offer a frame. Always accepted; if one was already waiting, that older
    /// frame is dropped and counted.
    ///
    /// There is deliberately no `try_publish` that fails: a producer that can
    /// fail to publish is a producer that can be made to wait.
    pub fn publish(&mut self, frame: T, cause_if_dropping: DropCause) {
        if self.slot.is_some() {
            self.count(cause_if_dropping);
        }
        self.slot = Some(frame);
    }

    /// Take the waiting frame, if any. Leaves the slot empty.
    pub fn take(&mut self) -> Option<T> {
        self.slot.take()
    }

    /// Record a drop that happened elsewhere in the chain, before the slot.
    pub fn count(&mut self, cause: DropCause) {
        match cause {
            DropCause::ConsumerBusy => self.drops.consumer_busy += 1,
            DropCause::EncoderSaturated => self.drops.encoder_saturated += 1,
            DropCause::TransportFull => self.drops.transport_full += 1,
        }
    }

    pub fn drops(&self) -> DropCounters {
        self.drops
    }

    pub fn is_empty(&self) -> bool {
        self.slot.is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_slow_consumer_loses_intermediate_frames_and_keeps_the_newest() {
        let mut slot: LatestFrameSlot<u32> = LatestFrameSlot::new();
        for frame in 1..=5 {
            slot.publish(frame, DropCause::ConsumerBusy);
        }
        assert_eq!(
            slot.take(),
            Some(5),
            "the consumer must receive the present, not a backlog"
        );
        assert_eq!(slot.drops().consumer_busy, 4);
        assert_eq!(slot.drops().total(), 4);
    }

    #[test]
    fn publishing_never_fails_so_a_producer_can_never_be_blocked() {
        // Invariant 14 by construction: publish returns unit. There is no
        // error path a producer could wait on, so media cannot push back on
        // the render clock.
        let mut slot: LatestFrameSlot<u32> = LatestFrameSlot::new();
        for frame in 0..10_000 {
            slot.publish(frame, DropCause::TransportFull);
        }
        assert_eq!(slot.take(), Some(9_999));
        assert_eq!(slot.drops().transport_full, 9_999);
    }

    #[test]
    fn an_empty_slot_yields_nothing_rather_than_a_stale_frame() {
        let mut slot: LatestFrameSlot<u32> = LatestFrameSlot::new();
        assert_eq!(slot.take(), None);
        slot.publish(1, DropCause::ConsumerBusy);
        assert_eq!(slot.take(), Some(1));
        assert_eq!(
            slot.take(),
            None,
            "a frame is delivered once; repeating it would present stale pixels as fresh"
        );
        assert_eq!(slot.drops().total(), 0, "keeping up is not a drop");
    }

    #[test]
    fn drops_are_attributed_to_the_stage_that_caused_them() {
        let mut slot: LatestFrameSlot<u32> = LatestFrameSlot::new();
        slot.count(DropCause::EncoderSaturated);
        slot.count(DropCause::EncoderSaturated);
        slot.count(DropCause::TransportFull);
        let d = slot.drops();
        assert_eq!(d.encoder_saturated, 2);
        assert_eq!(d.transport_full, 1);
        assert_eq!(d.consumer_busy, 0);
        // Observability wants cause, not just a total: an encoder problem and a
        // network problem need different fixes (ADR B.5).
        assert_eq!(d.total(), 3);
    }
}
