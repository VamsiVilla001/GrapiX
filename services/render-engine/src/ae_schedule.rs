//! Bounded lead-time scheduling for After Effects Program frames.
//!
//! `AE-F2b`. `AE-F2a` gave the Program clock a request point one frame period ahead of presentation
//! and deliberately stopped there: one period is the largest lead that cannot overlap the previous
//! frame's request, and pipelining was left as this phase's question rather than acquired by accident.
//!
//! ## Why one period is not enough
//!
//! At `60000/1001` a frame period is 16.68 ms. `AE-F0` measured a real checkout in the **tens of
//! milliseconds**. A frame requested one period before its deadline therefore cannot be ready by it:
//! with a single-frame lead the honest outcome is that every frame is late, which is a correct
//! measurement of a schedule that cannot work rather than a bug in ingress. Covering a 50 ms
//! completion at 59.94 needs three frames in flight, so the lead is a *depth*, not a longer sleep —
//! the clock keeps waking one period early, and each wakeup asks for the frame that is `depth` periods
//! out.
//!
//! ## What bounds it
//!
//! Depth is bounded twice, and both bounds are physical rather than tuning:
//!
//! 1. **The ring.** `AE-F1`'s mapping has a fixed slot count and the consumer holds one lease at a
//!    time. Requesting more frames than the ring can hold guarantees back-pressure, and a
//!    back-pressured publish burns the slot the frame that *is* due needs.
//! 2. **`MAX_PIPELINE_DEPTH`.** A deeper pipeline means more work in flight that a data change
//!    invalidates and more frames to abandon on a skip. Eight is already four times the depth a
//!    50 ms completion needs at 59.94.
//!
//! ## The policy, and its asymmetry
//!
//! Pressure and lateness are **not** the same signal and must not share a response:
//!
//! - **Back-pressure or a saturated in-flight set** means the pipeline is too *deep* for the ring, so
//!   the depth shrinks by one. Growing here would deepen the queue that is already overflowing.
//! - **Late or missed frames** mean the pipeline is too *shallow*, or After Effects is simply slower
//!   than the schedule. Depth is already at its configured maximum, so there is nothing to grow into:
//!   the response is to stop the healthy streak, which prevents a reduced depth being restored while
//!   frames are still arriving late. It must never shrink — that would make a late pipeline later.
//!
//! Recovery is deliberately slow relative to reduction: one step down per pressure event, one step up
//! per second of clean frames. A pipeline that oscillates between depths presents worse than one that
//! settles a step shallow.
//!
//! Nothing here decides what an operator sees. Hold, black and alarm belong to `PL4`; this module
//! decides only how far ahead to ask, and reports what it did.

use crate::stage::FrameRate;

/// Hard ceiling on frames in flight, independent of ring size.
pub const MAX_PIPELINE_DEPTH: usize = 8;

/// Lead the pipeline aims to cover, from `AE-F0`'s measured checkout cost in tens of milliseconds.
pub const TARGET_LEAD_NANOS: u64 = 50_000_000;

/// Frames in flight the engine assumes when the ring's real slot count is not yet known.
///
/// The adapter creates a four-slot ring and the consumer holds one lease at a time, so three is the
/// depth that cannot collide with the slot being published into.
pub const DEFAULT_RING_CAPACITY: usize = 3;

/// Clean frames required before a reduced depth is restored by one step: one second at 59.94.
const RECOVERY_STREAK: u32 = 60;

/// The frames a tick should ask for, in ascending order, without allocating.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AeRequestWindow {
    frames: [u64; MAX_PIPELINE_DEPTH],
    len: usize,
}

impl AeRequestWindow {
    pub fn iter(&self) -> impl Iterator<Item = u64> + '_ {
        self.frames[..self.len].iter().copied()
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }
}

/// How depth changed, so the caller can count it exactly once.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AeDepthChange {
    Unchanged,
    Reduced { from: usize, to: usize },
    Restored { from: usize, to: usize },
}

/// Bounded lead-time scheduling state for one installed AE Program source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AeFramePipeline {
    configured_depth: usize,
    effective_depth: usize,
    capacity: usize,
    healthy_streak: u32,
}

impl AeFramePipeline {
    /// Derive the pipeline from the Program rate and the ring's usable capacity.
    pub fn new(rate: FrameRate, capacity: usize) -> Self {
        let capacity = capacity.clamp(1, MAX_PIPELINE_DEPTH);
        let depth = depth_for(rate, TARGET_LEAD_NANOS).min(capacity);
        Self {
            configured_depth: depth,
            effective_depth: depth,
            capacity,
            healthy_streak: 0,
        }
    }

    pub fn effective_depth(&self) -> usize {
        self.effective_depth
    }

    pub fn configured_depth(&self) -> usize {
        self.configured_depth
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Re-bound the pipeline once the ring's real slot count is known.
    ///
    /// A capacity smaller than the current depth takes effect immediately: the ring is the physical
    /// limit, and honouring it later would mean deliberately over-requesting until the first
    /// back-pressure event taught us what the mapping already said.
    pub fn set_capacity(&mut self, capacity: usize) {
        self.capacity = capacity.clamp(1, MAX_PIPELINE_DEPTH);
        self.configured_depth = self.configured_depth.min(self.capacity);
        self.effective_depth = self.effective_depth.min(self.capacity);
    }

    /// The frames this tick should ask for: `next` and everything inside the current depth.
    ///
    /// Requests already outstanding are filtered by the ledger rather than here, so this stays a pure
    /// function of the schedule and the ledger keeps its single authority over what is in flight.
    pub fn window(&self, next: u64) -> AeRequestWindow {
        let mut frames = [0u64; MAX_PIPELINE_DEPTH];
        let mut len = 0;
        while len < self.effective_depth {
            match next.checked_add(len as u64) {
                Some(frame) => {
                    frames[len] = frame;
                    len += 1;
                }
                // A Program that has run to `u64::MAX` frames has other problems, but the window must
                // not wrap and ask for frame zero again.
                None => break,
            }
        }
        AeRequestWindow { frames, len }
    }

    /// Back-pressure or a saturated in-flight set: the pipeline is too deep for the ring.
    pub fn note_pressure(&mut self) -> AeDepthChange {
        self.healthy_streak = 0;
        if self.effective_depth <= 1 {
            return AeDepthChange::Unchanged;
        }
        let from = self.effective_depth;
        self.effective_depth -= 1;
        AeDepthChange::Reduced { from, to: self.effective_depth }
    }

    /// A frame presented before its deadline. Long enough runs of these restore one step of depth.
    pub fn note_healthy_frame(&mut self) -> AeDepthChange {
        if self.effective_depth >= self.configured_depth {
            self.healthy_streak = 0;
            return AeDepthChange::Unchanged;
        }
        self.healthy_streak += 1;
        if self.healthy_streak < RECOVERY_STREAK {
            return AeDepthChange::Unchanged;
        }
        self.healthy_streak = 0;
        let from = self.effective_depth;
        self.effective_depth += 1;
        AeDepthChange::Restored { from, to: self.effective_depth }
    }

    /// A late or missed frame. Never shrinks: a shallower pipeline would arrive later still.
    pub fn note_unhealthy_frame(&mut self) {
        self.healthy_streak = 0;
    }
}

/// Frames of lead needed to cover `target_lead_nanos`, at least one and never past the ceiling.
fn depth_for(rate: FrameRate, target_lead_nanos: u64) -> usize {
    let period = rate.frame_duration_nanos();
    if period == 0 {
        return 1;
    }
    let depth = target_lead_nanos.div_ceil(period).max(1);
    usize::try_from(depth).unwrap_or(MAX_PIPELINE_DEPTH).min(MAX_PIPELINE_DEPTH)
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE_5994: FrameRate = FrameRate { numerator: 60_000, denominator: 1_001 };

    #[test]
    fn depth_covers_the_measured_checkout_cost_at_broadcast_rates() {
        // 50 ms of lead over a 16.683 ms period is three frames, which is what the four-slot ring
        // can hold while one slot is being published into.
        assert_eq!(depth_for(RATE_5994, TARGET_LEAD_NANOS), 3);
        assert_eq!(depth_for(FrameRate { numerator: 50, denominator: 1 }, TARGET_LEAD_NANOS), 3);
        assert_eq!(
            depth_for(FrameRate { numerator: 30_000, denominator: 1_001 }, TARGET_LEAD_NANOS),
            2
        );
        // One frame per second already exceeds the target lead by itself.
        assert_eq!(depth_for(FrameRate { numerator: 1, denominator: 1 }, TARGET_LEAD_NANOS), 1);
    }

    #[test]
    fn depth_never_exceeds_the_ceiling_or_falls_below_one() {
        // 240 fps needs 12 frames to cover 50 ms; the ceiling holds it at eight.
        assert_eq!(depth_for(FrameRate { numerator: 240, denominator: 1 }, TARGET_LEAD_NANOS), 8);
        assert_eq!(depth_for(RATE_5994, 0), 1);
        // A zero rate has no period to divide by and must not panic or return zero.
        assert_eq!(depth_for(FrameRate { numerator: 0, denominator: 1 }, TARGET_LEAD_NANOS), 1);
    }

    #[test]
    fn capacity_bounds_depth_below_what_the_rate_asks_for() {
        let pipeline = AeFramePipeline::new(RATE_5994, 2);
        assert_eq!(pipeline.configured_depth(), 2, "the ring is the binding limit");
        assert_eq!(pipeline.effective_depth(), 2);

        let pipeline = AeFramePipeline::new(RATE_5994, DEFAULT_RING_CAPACITY);
        assert_eq!(pipeline.configured_depth(), 3);

        // A capacity of zero would stall Program entirely; one frame in flight is the floor.
        assert_eq!(AeFramePipeline::new(RATE_5994, 0).capacity(), 1);
        assert_eq!(AeFramePipeline::new(RATE_5994, 999).capacity(), MAX_PIPELINE_DEPTH);
    }

    #[test]
    fn a_smaller_ring_capacity_applies_immediately() {
        let mut pipeline = AeFramePipeline::new(RATE_5994, DEFAULT_RING_CAPACITY);
        assert_eq!(pipeline.effective_depth(), 3);

        pipeline.set_capacity(2);
        assert_eq!(pipeline.effective_depth(), 2);
        assert_eq!(pipeline.configured_depth(), 2, "depth cannot be restored past the ring");
    }

    #[test]
    fn the_window_is_the_next_frame_and_everything_inside_the_depth() {
        let pipeline = AeFramePipeline::new(RATE_5994, DEFAULT_RING_CAPACITY);
        let window = pipeline.window(41);

        assert_eq!(window.len(), 3);
        assert_eq!(window.iter().collect::<Vec<_>>(), vec![41, 42, 43]);
    }

    #[test]
    fn the_window_never_wraps_past_the_end_of_the_frame_space() {
        let pipeline = AeFramePipeline::new(RATE_5994, DEFAULT_RING_CAPACITY);
        let window = pipeline.window(u64::MAX - 1);

        assert_eq!(
            window.iter().collect::<Vec<_>>(),
            vec![u64::MAX - 1, u64::MAX],
            "the window must stop rather than wrap to frame zero"
        );
    }

    #[test]
    fn pressure_shrinks_depth_one_step_at_a_time_and_stops_at_one() {
        let mut pipeline = AeFramePipeline::new(RATE_5994, DEFAULT_RING_CAPACITY);

        assert_eq!(pipeline.note_pressure(), AeDepthChange::Reduced { from: 3, to: 2 });
        assert_eq!(pipeline.note_pressure(), AeDepthChange::Reduced { from: 2, to: 1 });
        assert_eq!(
            pipeline.note_pressure(),
            AeDepthChange::Unchanged,
            "a pipeline of one is the floor: Program still has to ask for the frame it needs"
        );
        assert_eq!(pipeline.effective_depth(), 1);
    }

    #[test]
    fn a_clean_second_restores_exactly_one_step() {
        let mut pipeline = AeFramePipeline::new(RATE_5994, DEFAULT_RING_CAPACITY);
        pipeline.note_pressure();
        assert_eq!(pipeline.effective_depth(), 2);

        for frame in 1..RECOVERY_STREAK {
            assert_eq!(
                pipeline.note_healthy_frame(),
                AeDepthChange::Unchanged,
                "frame {frame} must not restore depth before the streak completes"
            );
        }
        assert_eq!(pipeline.note_healthy_frame(), AeDepthChange::Restored { from: 2, to: 3 });
        assert_eq!(pipeline.effective_depth(), 3);
    }

    #[test]
    fn recovery_stops_at_the_configured_depth() {
        let mut pipeline = AeFramePipeline::new(RATE_5994, DEFAULT_RING_CAPACITY);
        for _ in 0..(RECOVERY_STREAK * 4) {
            assert_eq!(pipeline.note_healthy_frame(), AeDepthChange::Unchanged);
        }
        assert_eq!(pipeline.effective_depth(), pipeline.configured_depth());
    }

    /// The asymmetry, asserted: lateness must not shrink a pipeline that is already too shallow.
    #[test]
    fn lateness_resets_recovery_without_shrinking_depth() {
        let mut pipeline = AeFramePipeline::new(RATE_5994, DEFAULT_RING_CAPACITY);
        pipeline.note_pressure();
        assert_eq!(pipeline.effective_depth(), 2);

        for _ in 0..(RECOVERY_STREAK - 1) {
            pipeline.note_healthy_frame();
        }
        pipeline.note_unhealthy_frame();
        assert_eq!(pipeline.effective_depth(), 2, "a late frame must never shrink the pipeline");

        // The streak restarted, so the frame that would have completed it no longer does.
        assert_eq!(pipeline.note_healthy_frame(), AeDepthChange::Unchanged);
        for _ in 0..(RECOVERY_STREAK - 2) {
            pipeline.note_healthy_frame();
        }
        assert_eq!(pipeline.note_healthy_frame(), AeDepthChange::Restored { from: 2, to: 3 });
    }
}
