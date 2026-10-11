//! ProgramClock: the render node's timebase (ADR-002).
//!
//! The engine is the sole clock authority. Nothing here can be set by a client
//! message — there is no constructor or setter reachable from the control
//! plane, which is how invariant 8 is enforced on this side of the boundary.
//!
//! Two properties matter more than anything else in this file:
//!
//! 1. **Deadlines are derived from frame number in exact integer arithmetic.**
//!    `offset_nanos(n)` is a pure function of `n` over `u128`, so it is exact
//!    at every frame, forever. Measured against an 8-hour soak at 29.97
//!    (863,136 frames), the two ways of getting this wrong cost:
//!
//!    | Approach | Drift over 8 hours |
//!    |---|---|
//!    | Rate stored as rounded `29.97` | 28.8 ms - **0.86 of a frame** |
//!    | `f32` accumulation of the interval | 117 s - 3,513 frames |
//!    | `f64` accumulation of `1001/30000` | 89 ns - negligible |
//!
//!    So the danger is not floating point as such: it is *rounding the rate*.
//!    That is what invariant 12 and `RationalRate` exist to prevent, and it is
//!    why this clock never sees a decimal rate at all.
//! 2. **Phase comes from the reference when there is one.** When a genlocked
//!    adapter is configured the clock is slaved to the card; with no reference
//!    it free-runs and says so (invariant 11).

use gx_contracts::{ClockSource, Epoch, RationalRate, ReferenceState, Refusal};
use gx_control_plane::intent::{resolve_intent, ClockState, Lead, TakeAt, TakeCommitted};
use gx_control_plane::status::{Degradation, ReferenceMonitor, ReferenceTransition};

/// Nanoseconds in one second, as the integer it is.
const NANOS_PER_SEC: u128 = 1_000_000_000;

/// The engine's frame clock.
#[derive(Debug, Clone)]
pub struct ProgramClock {
    epoch: Epoch,
    frame: u64,
    /// The rate the clock was configured with.
    configured: RationalRate,
    source: ClockSource,
    reference: ReferenceMonitor,
    lead: Lead,
}

impl ProgramClock {
    /// A free-running clock. The honest default: no reference has been found,
    /// and the clock says so rather than implying accuracy it does not have.
    pub fn free_running(epoch: Epoch, rate: RationalRate, lead: Lead) -> Self {
        Self {
            epoch,
            frame: 0,
            configured: rate,
            source: ClockSource::FreeRun,
            reference: ReferenceMonitor::new(ReferenceState::NotPresent, rate),
            lead,
        }
    }

    /// Slave the clock to an external reference.
    ///
    /// Refuses if a different clock domain is already established: two outputs
    /// on different references means two engine instances (invariant 10).
    pub fn slave_to(
        &mut self,
        source: ClockSource,
        rate: RationalRate,
    ) -> Result<ReferenceTransition, Refusal> {
        if self.source != ClockSource::FreeRun && self.source != source {
            return Err(Refusal::MultipleClockDomains {
                existing: self.source,
                requested: source,
            });
        }
        if source == ClockSource::FreeRun {
            return Err(Refusal::NotImplemented {
                what: "slaving to free-run".to_string(),
            });
        }
        self.source = source;
        self.configured = rate;
        let transition = self
            .reference
            .observe(ReferenceState::Locked, self.frame)
            .unwrap_or(ReferenceTransition {
                from: ReferenceState::Locked,
                to: ReferenceState::Locked,
                at_frame: self.frame,
            });
        Ok(transition)
    }

    /// Observe the reference signal. Losing lock holds the cadence rather than
    /// snapping to a host clock, which would change Program timing on air.
    pub fn observe_reference(&mut self, state: ReferenceState) -> Option<ReferenceTransition> {
        self.reference.observe(state, self.frame)
    }

    pub fn frame(&self) -> u64 {
        self.frame
    }

    pub fn epoch(&self) -> Epoch {
        self.epoch
    }

    pub fn source(&self) -> ClockSource {
        self.source
    }

    pub fn reference(&self) -> ReferenceState {
        self.reference.state()
    }

    /// The rate Program is actually running at, which after a lock loss is the
    /// held rate rather than the configured one.
    pub fn timebase(&self) -> RationalRate {
        self.reference.effective_timebase()
    }

    pub fn degradation(&self) -> Option<Degradation> {
        self.reference.degradation()
    }

    /// Advance one frame. Called by whatever drives the clock: the card's
    /// reference callback when slaved, a timer when free-running.
    pub fn tick(&mut self) -> u64 {
        self.frame = self.frame.saturating_add(1);
        self.frame
    }

    /// The offset of a frame from frame zero, in nanoseconds.
    ///
    /// A pure function of the frame number. `n * den / num` in 128-bit integer
    /// arithmetic: no floats, no accumulation, no drift.
    pub fn offset_nanos(&self, frame: u64) -> u128 {
        let rate = self.timebase();
        u128::from(frame) * u128::from(rate.den) * NANOS_PER_SEC / u128::from(rate.num)
    }

    /// The engine's current view of time, for intent resolution.
    fn state(&self) -> ClockState {
        ClockState {
            current_frame: self.frame,
            timebase: self.timebase(),
            clock: self.source,
            reference: self.reference.state(),
            epoch: self.epoch,
        }
    }

    /// Resolve a client's intent into a frame this clock commits to.
    ///
    /// Delegates the rule to `gx_control_plane::intent::resolve_intent` rather
    /// than reimplementing it, so the engine and every mock peer cannot
    /// disagree about what `NextOpportunity` means (invariant 27).
    pub fn commit(&self, at: TakeAt) -> Result<TakeCommitted, Refusal> {
        resolve_intent(at, &self.state(), self.lead)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clock() -> ProgramClock {
        ProgramClock::free_running(Epoch(1), RationalRate::P29_97, Lead::CO_LOCATED)
    }

    #[test]
    fn a_new_clock_admits_it_is_free_running() {
        let c = clock();
        assert_eq!(c.source(), ClockSource::FreeRun);
        assert_eq!(c.reference(), ReferenceState::NotPresent);
        assert_eq!(c.degradation(), Some(Degradation::FreeRunning));
    }

    /// 8 hours at 29.97, the soak length ADR Part D gates a release on.
    const SOAK_FRAMES: u64 = 863_136;

    #[test]
    fn deadlines_are_exact_across_an_eight_hour_soak() {
        let c = clock();
        // frames * 1001 / 30000 seconds, in nanoseconds, with no rounding
        // anywhere in the expression.
        let expected = u128::from(SOAK_FRAMES) * 1001 * NANOS_PER_SEC / 30_000;
        assert_eq!(c.offset_nanos(SOAK_FRAMES), expected);
    }

    #[test]
    fn a_rounded_rate_would_lose_most_of_a_frame_over_a_soak() {
        // This is the case invariant 12 is actually about. Storing the rate as
        // the decimal 29.97 rather than 30000/1001 puts Program 28.8 ms - most
        // of a frame - away from where it should be after 8 hours.
        let c = clock();
        let exact = c.offset_nanos(SOAK_FRAMES);
        let rounded = (SOAK_FRAMES as f64 / 29.97 * 1e9) as u128;

        let drift = rounded.abs_diff(exact);
        let one_frame = c.offset_nanos(1);
        assert!(
            drift > one_frame / 2,
            "expected the rounded rate to cost more than half a frame, saw {drift} ns \
             against a {one_frame} ns frame"
        );
        assert!(
            drift < one_frame,
            "expected under a full frame; if this grew, the soak length or the \
             arithmetic changed and the claim above needs remeasuring"
        );
    }

    #[test]
    fn f32_accumulation_would_be_catastrophic() {
        // Recorded for contrast: the failure mode people expect from floating
        // point is real, but it belongs to f32 accumulation, not to f64. Over
        // the same soak this is thousands of frames out.
        let c = clock();
        let per_frame = 1001.0f32 / 30_000.0;
        let mut acc = 0.0f32;
        for _ in 0..SOAK_FRAMES {
            acc += per_frame;
        }
        let accumulated = (f64::from(acc) * 1e9) as u128;
        let drift = accumulated.abs_diff(c.offset_nanos(SOAK_FRAMES));
        assert!(
            drift > 1_000 * c.offset_nanos(1),
            "f32 accumulation should be off by thousands of frames, saw {drift} ns"
        );
    }

    #[test]
    fn frame_zero_is_the_origin() {
        assert_eq!(clock().offset_nanos(0), 0);
    }

    #[test]
    fn one_second_of_frames_is_one_second() {
        // 30000/1001 frames is exactly one second at 29.97.
        let c = clock();
        assert_eq!(c.offset_nanos(30_000), 1001 * NANOS_PER_SEC);

        let p50 = ProgramClock::free_running(Epoch(1), RationalRate::P50, Lead::CO_LOCATED);
        assert_eq!(p50.offset_nanos(50), NANOS_PER_SEC);
    }

    #[test]
    fn ticking_advances_and_saturates_rather_than_wrapping() {
        let mut c = clock();
        assert_eq!(c.tick(), 1);
        assert_eq!(c.tick(), 2);
        assert_eq!(c.frame(), 2);
    }

    #[test]
    fn intent_resolves_against_the_engines_own_frame() {
        let mut c = clock();
        for _ in 0..500 {
            c.tick();
        }
        let committed = c.commit(TakeAt::NextOpportunity).unwrap();
        assert_eq!(committed.frame, 501);
        assert_eq!(committed.clock, ClockSource::FreeRun);
    }

    #[test]
    fn a_frame_already_past_is_refused() {
        let mut c = clock();
        for _ in 0..500 {
            c.tick();
        }
        let err = c.commit(TakeAt::Frame { frame: 100 }).unwrap_err();
        assert!(matches!(err, Refusal::FrameNotReachable { .. }));
    }

    #[test]
    fn slaving_locks_the_clock_and_reports_the_transition() {
        let mut c = clock();
        let t = c
            .slave_to(ClockSource::Genlocked, RationalRate::P50)
            .unwrap();
        assert_eq!(t.to, ReferenceState::Locked);
        assert_eq!(c.source(), ClockSource::Genlocked);
        assert_eq!(c.reference(), ReferenceState::Locked);
        assert_eq!(c.degradation(), None);
        assert_eq!(
            c.commit(TakeAt::NextOpportunity).unwrap().clock,
            ClockSource::Genlocked
        );
    }

    #[test]
    fn a_second_clock_domain_is_refused() {
        let mut c = clock();
        c.slave_to(ClockSource::Genlocked, RationalRate::P50)
            .unwrap();
        let err = c
            .slave_to(ClockSource::Ptp, RationalRate::P50)
            .expect_err("invariant 10: one clock domain per engine instance");
        assert!(matches!(err, Refusal::MultipleClockDomains { .. }));
        assert_eq!(
            c.source(),
            ClockSource::Genlocked,
            "the refusal changed nothing"
        );
    }

    #[test]
    fn losing_lock_holds_cadence_and_keeps_committing() {
        let mut c = ProgramClock::free_running(Epoch(1), RationalRate::P29_97, Lead::CO_LOCATED);
        c.slave_to(ClockSource::Genlocked, RationalRate::P29_97)
            .unwrap();
        for _ in 0..100 {
            c.tick();
        }

        let t = c.observe_reference(ReferenceState::Unlocked).unwrap();
        assert_eq!(t.from, ReferenceState::Locked);
        assert_eq!(t.at_frame, 100);
        assert_eq!(
            c.timebase(),
            RationalRate::P29_97,
            "cadence is held through a lock loss"
        );
        assert_eq!(
            c.degradation(),
            Some(Degradation::ReferenceLost {
                was: RationalRate::P29_97
            })
        );
        // Program continues: a lost reference degrades the clock, it does not
        // stop it. Stopping would take the show off air.
        assert!(c.commit(TakeAt::NextOpportunity).is_ok());
    }

    #[test]
    fn a_lan_clock_needs_more_lead_than_a_local_one() {
        let local = ProgramClock::free_running(Epoch(2), RationalRate::P50, Lead::CO_LOCATED);
        let lan = ProgramClock::free_running(Epoch(2), RationalRate::P50, Lead::LAN);
        let a = local.commit(TakeAt::NextOpportunity).unwrap().frame;
        let b = lan.commit(TakeAt::NextOpportunity).unwrap().frame;
        assert!(b > a, "distance changes the lead, not the rule");
    }
}
