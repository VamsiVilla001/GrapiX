//! Engine status reporting, including reference lock (ADR-002 action 2).
//!
//! Status is *reported*, never requested. Nothing a client sends can set any
//! field here.
//!
//! The reference-lock behaviour follows ADR-002's revisit note: on losing lock
//! mid-show, hold the last good cadence, report degraded, and refuse new live
//! configuration. Holding cadence matters because the alternative — snapping to
//! a host clock — changes Program timing on air.

use gx_contracts::{
    ClockSource, DeviceTier, Epoch, RationalRate, ReferenceState, Refusal, Revision, TakeId,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Why the engine is not in a fully healthy state.
///
/// Enumerated rather than a free-text message: an operator display has to be
/// able to decide severity, and a string cannot be matched on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "degradation", rename_all = "camelCase")]
pub enum Degradation {
    /// Reference was locked and is not any more. Cadence is being held at the
    /// last good rate.
    ReferenceLost { was: RationalRate },
    /// Running without any reference at all. Not a fault, but never hidden
    /// (invariant 11).
    FreeRunning,
    /// The render device dropped below T0. Live adapters refuse.
    DeviceBelowT0 { actual: DeviceTier },
}

impl Degradation {
    /// Whether this state must block new live output configuration.
    pub fn blocks_live_configuration(self) -> bool {
        match self {
            // ADR-002: refuse new live configuration while unlocked.
            Degradation::ReferenceLost { .. } => true,
            Degradation::DeviceBelowT0 { .. } => true,
            // Free-run is permitted, but only knowingly: the operator gate is
            // in `live_allowed`, not here.
            Degradation::FreeRunning => false,
        }
    }
}

/// What is currently on Program, if anything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProgramState {
    pub take_id: TakeId,
    pub revision: Revision,
    /// The frame the engine committed this take to.
    pub committed_frame: u64,
}

/// The engine's reported state. The single source for every operator display.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub epoch: Epoch,
    pub current_frame: u64,
    pub timebase: RationalRate,
    pub clock: ClockSource,
    pub reference: ReferenceState,
    pub device_tier: DeviceTier,
    /// Derived from ADR-005 conditions. Never inferred from an adapter name
    /// (invariant 20).
    pub live_allowed: bool,
    pub program: Option<ProgramState>,
    /// Empty means healthy. Order is not significant.
    pub degradations: Vec<Degradation>,
}

impl EngineStatus {
    pub fn is_healthy(&self) -> bool {
        self.degradations.is_empty()
    }

    /// Whether a new live output may be configured right now.
    pub fn may_configure_live(&self) -> bool {
        self.live_allowed
            && !self
                .degradations
                .iter()
                .any(|d| d.blocks_live_configuration())
    }
}

/// How urgently the operator must be told. Drives presentation, so that
/// free-run cannot be rendered as quiet grey text (invariant 11).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub enum Severity {
    /// Locked and healthy.
    Nominal,
    /// Running, but in a state the operator must be aware of.
    Warning,
    /// Something that was working has stopped working.
    Critical,
}

/// The operator-facing summary of clock state.
///
/// Returned as a struct with a severity rather than a formatted string, so the
/// UI cannot accidentally present a `Critical` state with `Nominal` styling.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ClockSummary {
    pub severity: Severity,
    /// Short, unambiguous label. Never abbreviated to something an operator
    /// has to decode mid-show.
    pub label: String,
    pub timebase: RationalRate,
    /// True when Program cadence is not derived from an external reference.
    pub free_running: bool,
}

/// Summarise clock state for an operator display (ADR-002 action 3).
///
/// This is the engine-side half of "surface free-run vs locked, unmissably":
/// it decides severity and wording once, so Editor, Playout and any future
/// surface cannot disagree about how alarming a state is.
pub fn clock_summary(status: &EngineStatus) -> ClockSummary {
    let lost = status.degradations.iter().find_map(|d| match d {
        Degradation::ReferenceLost { was } => Some(*was),
        _ => None,
    });

    if let Some(was) = lost {
        return ClockSummary {
            severity: Severity::Critical,
            label: "REFERENCE LOST - holding last cadence".to_string(),
            timebase: was,
            free_running: true,
        };
    }

    match (status.clock, status.reference) {
        (ClockSource::Genlocked, ReferenceState::Locked) => ClockSummary {
            severity: Severity::Nominal,
            label: "Genlocked".to_string(),
            timebase: status.timebase,
            free_running: false,
        },
        (ClockSource::Ptp, ReferenceState::Locked) => ClockSummary {
            severity: Severity::Nominal,
            label: "PTP locked".to_string(),
            timebase: status.timebase,
            free_running: false,
        },
        // Anything else is not locked to an external reference, whatever the
        // configured source claims.
        _ => ClockSummary {
            severity: Severity::Warning,
            label: "FREE RUN - no external reference".to_string(),
            timebase: status.timebase,
            free_running: true,
        },
    }
}

/// A reference state change, reported as an event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceTransition {
    pub from: ReferenceState,
    pub to: ReferenceState,
    /// The frame at which the change was observed, in the engine's timebase.
    pub at_frame: u64,
}

/// Watches reference state and applies ADR-002's lock-loss policy.
///
/// Holds the cadence that was in use when lock was lost. Snapping to a host
/// clock instead would change Program timing on air, which is the failure this
/// exists to prevent.
#[derive(Debug, Clone)]
pub struct ReferenceMonitor {
    state: ReferenceState,
    /// The rate to hold if lock is lost.
    good_timebase: RationalRate,
    lost_from: Option<RationalRate>,
}

impl ReferenceMonitor {
    pub fn new(state: ReferenceState, timebase: RationalRate) -> Self {
        Self {
            state,
            good_timebase: timebase,
            lost_from: None,
        }
    }

    pub fn state(&self) -> ReferenceState {
        self.state
    }

    /// The cadence Program should run at: the held rate after a loss, and the
    /// live rate otherwise.
    pub fn effective_timebase(&self) -> RationalRate {
        self.lost_from.unwrap_or(self.good_timebase)
    }

    pub fn degradation(&self) -> Option<Degradation> {
        match (self.lost_from, self.state) {
            (Some(was), _) => Some(Degradation::ReferenceLost { was }),
            (None, ReferenceState::Locked) => None,
            (None, _) => Some(Degradation::FreeRunning),
        }
    }

    /// Refuse new live configuration while degraded by a lost reference.
    pub fn check_live_configuration(&self) -> Result<(), Refusal> {
        match self.degradation() {
            Some(d) if d.blocks_live_configuration() => {
                Err(Refusal::ReferenceUnlocked { state: self.state })
            }
            _ => Ok(()),
        }
    }

    /// Observe a new reference state, returning the transition if it changed.
    pub fn observe(
        &mut self,
        new_state: ReferenceState,
        at_frame: u64,
    ) -> Option<ReferenceTransition> {
        if new_state == self.state {
            return None;
        }
        let from = self.state;

        // Losing lock: pin the cadence in use at that moment.
        if from == ReferenceState::Locked && new_state != ReferenceState::Locked {
            self.lost_from = Some(self.good_timebase);
        }
        // Regaining lock clears the hold: the reference is authoritative again.
        if new_state == ReferenceState::Locked {
            self.lost_from = None;
        }

        self.state = new_state;
        Some(ReferenceTransition {
            from,
            to: new_state,
            at_frame,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(clock: ClockSource, reference: ReferenceState) -> EngineStatus {
        EngineStatus {
            epoch: Epoch(1),
            current_frame: 100,
            timebase: RationalRate::P50,
            clock,
            reference,
            device_tier: DeviceTier::T0,
            live_allowed: true,
            program: None,
            degradations: Vec::new(),
        }
    }

    #[test]
    fn genlocked_and_locked_is_nominal() {
        let s = clock_summary(&status(ClockSource::Genlocked, ReferenceState::Locked));
        assert_eq!(s.severity, Severity::Nominal);
        assert!(!s.free_running);
    }

    #[test]
    fn free_run_is_never_nominal() {
        // Invariant 11: free-run is reported as free-run, and it cannot be
        // presented as a healthy state.
        for (clock, reference) in [
            (ClockSource::FreeRun, ReferenceState::NotPresent),
            (ClockSource::FreeRun, ReferenceState::Unlocked),
            (ClockSource::Genlocked, ReferenceState::Unlocked),
            (ClockSource::Genlocked, ReferenceState::NotPresent),
        ] {
            let s = clock_summary(&status(clock, reference));
            assert_ne!(
                s.severity,
                Severity::Nominal,
                "{clock:?}/{reference:?} must not read as nominal"
            );
            assert!(s.free_running, "{clock:?}/{reference:?} is not locked");
            assert!(
                s.label.contains("FREE RUN"),
                "the label must say so plainly, got {:?}",
                s.label
            );
        }
    }

    #[test]
    fn a_configured_source_does_not_override_an_unlocked_reference() {
        // Claiming Genlocked while the reference is absent must not present as
        // locked. The reference decides, not the configuration.
        let s = clock_summary(&status(ClockSource::Genlocked, ReferenceState::NotPresent));
        assert_eq!(s.severity, Severity::Warning);
    }

    #[test]
    fn losing_lock_holds_the_previous_cadence() {
        let mut m = ReferenceMonitor::new(ReferenceState::Locked, RationalRate::P29_97);
        assert_eq!(m.effective_timebase(), RationalRate::P29_97);
        assert_eq!(m.degradation(), None);

        let t = m.observe(ReferenceState::Unlocked, 4242).unwrap();
        assert_eq!(t.from, ReferenceState::Locked);
        assert_eq!(t.to, ReferenceState::Unlocked);
        assert_eq!(t.at_frame, 4242);
        assert_eq!(
            m.effective_timebase(),
            RationalRate::P29_97,
            "cadence is held, not snapped to a host clock"
        );
        assert_eq!(
            m.degradation(),
            Some(Degradation::ReferenceLost {
                was: RationalRate::P29_97
            })
        );
    }

    #[test]
    fn a_lost_reference_refuses_new_live_configuration() {
        let mut m = ReferenceMonitor::new(ReferenceState::Locked, RationalRate::P50);
        m.observe(ReferenceState::Unlocked, 1);
        let err = m
            .check_live_configuration()
            .expect_err("new live configuration must be refused while unlocked");
        assert!(matches!(err, Refusal::ReferenceUnlocked { .. }));
    }

    #[test]
    fn regaining_lock_clears_the_hold() {
        let mut m = ReferenceMonitor::new(ReferenceState::Locked, RationalRate::P50);
        m.observe(ReferenceState::Unlocked, 10);
        m.observe(ReferenceState::Locked, 20);
        assert_eq!(m.degradation(), None);
        assert!(m.check_live_configuration().is_ok());
    }

    #[test]
    fn an_unchanged_state_reports_no_transition() {
        let mut m = ReferenceMonitor::new(ReferenceState::Locked, RationalRate::P50);
        assert!(m.observe(ReferenceState::Locked, 5).is_none());
    }

    #[test]
    fn lost_lock_reads_as_critical_and_says_it_is_holding() {
        let mut s = status(ClockSource::Genlocked, ReferenceState::Unlocked);
        s.degradations.push(Degradation::ReferenceLost {
            was: RationalRate::P29_97,
        });
        let summary = clock_summary(&s);
        assert_eq!(summary.severity, Severity::Critical);
        assert_eq!(summary.timebase, RationalRate::P29_97);
        assert!(summary.label.contains("REFERENCE LOST"));
    }

    #[test]
    fn degraded_status_blocks_live_configuration_even_when_live_is_allowed() {
        let mut s = status(ClockSource::Genlocked, ReferenceState::Locked);
        assert!(s.may_configure_live());
        s.degradations.push(Degradation::DeviceBelowT0 {
            actual: DeviceTier::T2,
        });
        assert!(!s.may_configure_live());
        assert!(!s.is_healthy());
    }

    #[test]
    fn free_running_alone_does_not_block_configuration() {
        // The operator gate for free-run lives in `live_allowed`, not here.
        // Blocking in both places would make a knowing free-run impossible.
        let mut s = status(ClockSource::FreeRun, ReferenceState::NotPresent);
        s.degradations.push(Degradation::FreeRunning);
        assert!(s.may_configure_live());
    }
}
