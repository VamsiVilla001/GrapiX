//! Capability exchange, extended for locality and clock (ADR-001 action 2,
//! ADR-002 action 2).
//!
//! Locality is *declared*, not probed. The engine knows whether its clients
//! reached it over a pipe or a socket; a client guessing would get it wrong
//! exactly when it matters, which is during the L0 to L1 move.

use gx_contracts::{ClockSource, DeviceTier, Epoch, Locality, MediaCodec, ReferenceState, Refusal};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// What the engine tells a connecting client about itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct EngineCapability {
    /// Fixed constant. A mismatch is an error code, not a negotiation.
    pub protocol: u32,
    /// Engine incarnation. A client that reconnects and sees a new epoch must
    /// assume none of its previous state survived.
    pub epoch: Epoch,
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

/// Reject a protocol mismatch by name rather than attempting to negotiate.
///
/// ADR-001 makes the control plane loss-intolerant and ordered; a version
/// negotiation would mean two peers with different ideas of what a sequence
/// number means, which is worse than refusing to connect.
pub fn check_protocol(offered: u32) -> Result<(), Refusal> {
    if offered == gx_contracts::PROTOCOL_VERSION {
        Ok(())
    } else {
        Err(Refusal::ProtocolMismatch {
            expected: gx_contracts::PROTOCOL_VERSION,
            actual: offered,
        })
    }
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
) -> Result<(), Refusal> {
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

/// Refuse a second clock domain in one engine instance (invariant 10).
///
/// Two outputs on different references means two engine instances. Resolving
/// this by picking a winner would silently put one output out of phase.
pub fn check_clock_domain(existing: ClockSource, requested: ClockSource) -> Result<(), Refusal> {
    if existing == requested {
        Ok(())
    } else {
        Err(Refusal::MultipleClockDomains {
            existing,
            requested,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_protocol_mismatch_is_refused_not_negotiated() {
        assert!(check_protocol(gx_contracts::PROTOCOL_VERSION).is_ok());
        let err = check_protocol(2).expect_err("an older protocol must refuse");
        assert_eq!(
            err,
            Refusal::ProtocolMismatch {
                expected: 3,
                actual: 2
            }
        );
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

    #[test]
    fn tier_is_checked_before_platform() {
        // Both conditions fail here. The refusal names the tier, because a
        // machine that cannot render live is the more fundamental problem and
        // an operator should fix that first.
        let err = live_allowed(DeviceTier::T3, ReferenceState::Locked, false, false).unwrap_err();
        assert!(matches!(err, Refusal::TierTooLow { .. }));
    }

    #[test]
    fn a_second_clock_domain_is_refused() {
        assert!(check_clock_domain(ClockSource::Genlocked, ClockSource::Genlocked).is_ok());
        let err = check_clock_domain(ClockSource::Genlocked, ClockSource::Ptp)
            .expect_err("two references in one engine must refuse");
        assert_eq!(
            err,
            Refusal::MultipleClockDomains {
                existing: ClockSource::Genlocked,
                requested: ClockSource::Ptp
            }
        );
    }
}
