//! Intent-based control (ADR-002).
//!
//! The control plane carries *what should happen*, never *when*. The engine
//! resolves intent against its own timebase and answers with the frame it
//! committed to.
//!
//! This module holds the resolution rule as a pure function so the real engine
//! and every mock peer share one implementation. Two copies of this rule would
//! drift, and the drift would be a mock that teaches callers a contract the
//! engine does not honour (invariant 27).

use gx_contracts::{
    ClockSource, Epoch, Locality, RationalRate, ReferenceState, Refusal, Revision, TakeId,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// When a take should happen, expressed as intent.
///
/// Deliberately has no `Now` variant. Playout does not know what "now" is in
/// the engine's timebase, and on a genlocked output it never will.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "at", rename_all = "camelCase")]
pub enum TakeAt {
    /// The next frame boundary the engine can honour. The normal case.
    NextOpportunity,
    /// A specific frame in the engine's timebase, for automation and timecode.
    Frame { frame: u64 },
}

/// Ask for a take. Revision is exact; a mismatch is refused, not coerced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TakeRequest {
    pub take_id: TakeId,
    pub revision: Revision,
    pub at: TakeAt,
}

/// Ask for a cue: prepare a scene without putting it to air.
///
/// Cue carries intent for the same reason take does. A cue that is resolved
/// against the client's clock would prepare against the wrong frame and the
/// error would only show up as a late first frame on air.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CueRequest {
    pub take_id: TakeId,
    pub revision: Revision,
    pub at: TakeAt,
}

/// Clear Program. Also intent-based: the operator asks, the engine says when.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ClearRequest {
    pub at: TakeAt,
}

/// What the engine actually committed to.
///
/// This is the half of the exchange that makes intent-based control honest:
/// the operator sees a frame number the engine chose, not a request they made.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TakeCommitted {
    /// In the engine's timebase.
    pub frame: u64,
    /// Rational, never a float (invariant 12).
    pub timebase: RationalRate,
    pub clock: ClockSource,
}

/// How far ahead intent must arrive for the engine to commit to it.
///
/// ADR-002: latency changes the lead, not correctness. This is the only place
/// transport distance is allowed to influence timing, and it influences *how
/// early a client must ask*, never *what the engine does with the request*.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Lead(pub u64);

impl Lead {
    /// Same machine: one frame is enough to land on the next boundary.
    pub const CO_LOCATED: Self = Self(1);
    /// Over a LAN, allow for scheduling jitter on the way in.
    pub const LAN: Self = Self(3);

    pub fn for_locality(locality: Locality) -> Self {
        match locality {
            Locality::CoLocated => Self::CO_LOCATED,
            Locality::Lan => Self::LAN,
        }
    }
}

/// The engine's own view of time. Only the engine constructs this.
///
/// There is no client-facing constructor and no way to set `current_frame`
/// from a message: that would be a client asserting a time, which invariant 8
/// forbids.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClockState {
    pub current_frame: u64,
    pub timebase: RationalRate,
    pub clock: ClockSource,
    pub reference: ReferenceState,
    pub epoch: Epoch,
}

/// Resolve intent against the engine's timebase.
///
/// The single implementation of ADR-002's resolution rule. `NextOpportunity`
/// becomes the first frame at or beyond the lead; an explicit frame is honoured
/// if it is still reachable and refused by name if it is not.
pub fn resolve_intent(at: TakeAt, now: &ClockState, lead: Lead) -> Result<TakeCommitted, Refusal> {
    let earliest = now.current_frame.saturating_add(lead.0);

    let frame = match at {
        TakeAt::NextOpportunity => earliest,
        TakeAt::Frame { frame } if frame >= earliest => frame,
        // A frame inside the lead, or already gone. Say so rather than firing
        // it late: an automation system needs to know it missed.
        TakeAt::Frame { frame } => {
            return Err(Refusal::FrameNotReachable {
                requested: frame,
                earliest,
            })
        }
    };

    Ok(TakeCommitted {
        frame,
        timebase: now.timebase,
        clock: now.clock,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clock() -> ClockState {
        ClockState {
            current_frame: 1000,
            timebase: RationalRate::P29_97,
            clock: ClockSource::FreeRun,
            reference: ReferenceState::NotPresent,
            epoch: Epoch(1),
        }
    }

    #[test]
    fn take_at_has_no_now_variant() {
        // Compile-time assertion of invariant 8 by exhaustive match: if a
        // `Now` variant is ever added, this stops compiling and whoever added
        // it has to read ADR-002.
        let described = match TakeAt::NextOpportunity {
            TakeAt::NextOpportunity => "next opportunity",
            TakeAt::Frame { .. } => "specific frame",
        };
        assert_eq!(described, "next opportunity");
    }

    #[test]
    fn next_opportunity_commits_at_the_lead() {
        let c = resolve_intent(TakeAt::NextOpportunity, &clock(), Lead::CO_LOCATED).unwrap();
        assert_eq!(c.frame, 1001);

        let c = resolve_intent(TakeAt::NextOpportunity, &clock(), Lead::LAN).unwrap();
        assert_eq!(
            c.frame, 1003,
            "a longer lead moves the commitment, not the rule"
        );
    }

    #[test]
    fn a_reachable_frame_is_honoured_exactly() {
        let c = resolve_intent(TakeAt::Frame { frame: 5000 }, &clock(), Lead::CO_LOCATED).unwrap();
        assert_eq!(c.frame, 5000);
    }

    #[test]
    fn a_past_frame_is_refused_by_name_not_fired_late() {
        let err = resolve_intent(TakeAt::Frame { frame: 900 }, &clock(), Lead::CO_LOCATED)
            .expect_err("a frame that has passed must refuse");
        assert_eq!(
            err,
            Refusal::FrameNotReachable {
                requested: 900,
                earliest: 1001
            }
        );
    }

    #[test]
    fn a_frame_inside_the_lead_is_refused() {
        // 1002 is in the future, but not far enough ahead over a LAN.
        let err = resolve_intent(TakeAt::Frame { frame: 1002 }, &clock(), Lead::LAN)
            .expect_err("a frame inside the lead is not committable");
        assert!(matches!(
            err,
            Refusal::FrameNotReachable { earliest: 1003, .. }
        ));

        // The same request is fine co-located, which is the whole point of
        // making lead a function of locality rather than of correctness.
        assert!(resolve_intent(TakeAt::Frame { frame: 1002 }, &clock(), Lead::CO_LOCATED).is_ok());
    }

    #[test]
    fn the_commitment_reports_the_engines_clock_not_the_callers() {
        let mut c = clock();
        c.clock = ClockSource::Genlocked;
        c.reference = ReferenceState::Locked;
        let committed = resolve_intent(TakeAt::NextOpportunity, &c, Lead::CO_LOCATED).unwrap();
        assert_eq!(committed.clock, ClockSource::Genlocked);
        assert_eq!(committed.timebase, RationalRate::P29_97);
    }

    #[test]
    fn lead_grows_with_distance() {
        assert!(Lead::for_locality(Locality::Lan) > Lead::for_locality(Locality::CoLocated));
    }

    #[test]
    fn resolution_near_the_counter_ceiling_does_not_wrap() {
        let mut c = clock();
        c.current_frame = u64::MAX;
        // Saturating rather than wrapping: a wrap would resolve a take to frame
        // 0 and fire it immediately.
        let committed = resolve_intent(TakeAt::NextOpportunity, &c, Lead::LAN).unwrap();
        assert_eq!(committed.frame, u64::MAX);
    }
}
