//! protocol v3, the control plane.
//!
//! Small, ordered, acknowledged, sequenced. Zero loss tolerance.
//!
//! The rule that shapes this crate: it carries **intent, never time**
//! (invariant 8). There is no message meaning "now", and adding one would be
//! an architecture change rather than a feature, because it would move clock
//! authority off the render node and put network jitter into Program cadence.

#![forbid(unsafe_code)]

use gx_contracts::{
    ClockSource, DeviceTier, Locality, MediaCodec, RationalRate, ReferenceState, Revision, TakeId,
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

/// Capability exchange, extended for locality and clock (ADR-002 action 2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EngineCapability {
    /// Fixed constant. A mismatch is an error code, not a negotiation.
    pub protocol: u32,
    pub locality: Locality,
    pub device_tier: DeviceTier,
    pub clock: ClockSource,
    pub reference: ReferenceState,
    /// Derived from ADR-005. Never set by hand, never inferred from an adapter
    /// name (invariant 20).
    pub live_allowed: bool,
    /// Offered, in preference order.
    pub media: Vec<MediaCodec>,
}

/// Whether a live adapter may be configured, and if not, precisely why.
///
/// ADR-005: all three conditions must hold. This function is the only place
/// that decision is made, so it cannot drift between engine, API and UI
/// (invariant 20).
pub fn live_allowed(
    tier: DeviceTier,
    reference: ReferenceState,
    platform_certified: bool,
    operator_accepted_free_run: bool,
) -> Result<(), gx_contracts::Refusal> {
    use gx_contracts::Refusal;

    if !tier.live_capable() {
        return Err(Refusal::TierTooLow { actual: tier });
    }
    if !platform_certified {
        return Err(Refusal::PlatformNotCertified {
            platform: std::env::consts::OS.to_string(),
        });
    }
    match reference {
        ReferenceState::Locked => Ok(()),
        // Free-run is permitted only when an operator has been told. The flag
        // is named for what it asserts, so a caller cannot pass it by accident.
        ReferenceState::Unlocked | ReferenceState::NotPresent if operator_accepted_free_run => {
            Ok(())
        }
        state => Err(Refusal::ReferenceUnlocked { state }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gx_contracts::Refusal;

    #[test]
    fn take_at_has_no_now_variant() {
        // Compile-time assertion of invariant 8 by exhaustive match: if a
        // `Now` variant is ever added, this stops compiling and whoever added
        // it has to read ADR-002.
        let at = TakeAt::NextOpportunity;
        let described = match at {
            TakeAt::NextOpportunity => "next opportunity",
            TakeAt::Frame { .. } => "specific frame",
        };
        assert_eq!(described, "next opportunity");
    }

    #[test]
    fn live_is_refused_below_t0() {
        let err = live_allowed(DeviceTier::T2, ReferenceState::Locked, true, false)
            .expect_err("T2 must never be allowed live");
        assert!(matches!(
            err,
            Refusal::TierTooLow {
                actual: DeviceTier::T2
            }
        ));
    }

    #[test]
    fn live_is_refused_when_reference_unlocked() {
        let err = live_allowed(DeviceTier::T0, ReferenceState::Unlocked, true, false)
            .expect_err("unlocked reference must refuse");
        assert!(matches!(
            err,
            Refusal::ReferenceUnlocked {
                state: ReferenceState::Unlocked
            }
        ));
    }

    #[test]
    fn free_run_is_allowed_only_when_an_operator_accepted_it() {
        assert!(live_allowed(DeviceTier::T0, ReferenceState::NotPresent, true, true).is_ok());
        assert!(live_allowed(DeviceTier::T0, ReferenceState::NotPresent, true, false).is_err());
    }

    #[test]
    fn uncertified_platform_is_refused_by_name() {
        let err = live_allowed(DeviceTier::T0, ReferenceState::Locked, false, false)
            .expect_err("uncertified platform must refuse");
        assert!(matches!(err, Refusal::PlatformNotCertified { .. }));
    }
}
