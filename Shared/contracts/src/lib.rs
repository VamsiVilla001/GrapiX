//! Core contract types shared by all four planes.
//!
//! Source of truth for the generated TypeScript (invariant 22). Nothing here
//! may reference a transport, a runtime or a product.

#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Wire protocol version. A mismatch is an error code, never a negotiation.
pub const PROTOCOL_VERSION: u32 = 3;

/// Stable identity of a published scene. Survives every republish.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub struct TakeId(pub String);

impl std::fmt::Display for TakeId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Content address of asset bytes: SHA-256, lowercase hex.
#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub struct ContentHash(pub String);

impl std::fmt::Display for ContentHash {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Publish revision. Exact-match only: a take against a stale revision is
/// refused, never coerced (invariant 17).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub struct Revision(pub u64);

/// Engine incarnation counter. Bumped on every engine start.
///
/// Reconnect reconciles by revision *and* epoch (ADR B.4): a matching revision
/// from a previous epoch means the engine restarted, and a client that ignores
/// the epoch would assume state it no longer has.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub struct Epoch(pub u64);

/// A frame rate as an exact rational. Never a float (invariant 12).
///
/// 29.97 is 30000/1001 and cannot be represented in binary floating point.
/// Accumulating a rounded rate across an 8-hour soak drifts the clock, so this
/// type deliberately offers no `f64` constructor.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct RationalRate {
    pub num: u32,
    pub den: u32,
}

impl RationalRate {
    pub const P25: Self = Self { num: 25, den: 1 };
    pub const P30: Self = Self { num: 30, den: 1 };
    pub const P50: Self = Self { num: 50, den: 1 };
    pub const P60: Self = Self { num: 60, den: 1 };
    /// Exactly 30000/1001.
    pub const P29_97: Self = Self {
        num: 30000,
        den: 1001,
    };
    /// Exactly 60000/1001.
    pub const P59_94: Self = Self {
        num: 60000,
        den: 1001,
    };

    /// Rejects a zero term rather than producing a rate that divides by zero
    /// somewhere further down.
    pub fn new(num: u32, den: u32) -> Result<Self, Refusal> {
        if num == 0 || den == 0 {
            return Err(Refusal::InvalidRate { num, den });
        }
        Ok(Self { num, den })
    }
}

/// Where the engine is relative to its clients. Declared in the capability
/// exchange; selects transport and media encoding (ADR-001, ADR-004).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum Locality {
    /// L0 : same machine.
    CoLocated,
    /// L1: reachable over a LAN.
    Lan,
}

/// Render device capability tier. Only T0 may go to air (invariant 19).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
pub enum DeviceTier {
    /// Hardware GPU. The only tier a live adapter accepts.
    T0,
    /// Hybrid or reduced hardware path.
    T1,
    /// Software rasteriser: SwiftShader, Lavapipe, WARP. CI only, never live.
    T2,
    /// CPU partial. Degraded by construction.
    T3,
}

impl DeviceTier {
    /// The single place tier is allowed to answer this question.
    pub fn live_capable(self) -> bool {
        matches!(self, DeviceTier::T0)
    }
}

/// Where the render node's phase comes from. Reported, never requested.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum ClockSource {
    /// Slaved to an output device's external reference.
    Genlocked,
    /// IP timing. Deferred to the multi-node phase (ADR-002 option C).
    Ptp,
    /// No reference present. Always reported as such (invariant 11).
    FreeRun,
}

/// External reference signal state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum ReferenceState {
    Locked,
    /// A reference input exists but is not locked. Distinct from absent: this
    /// is a fault, that is a configuration.
    Unlocked,
    NotPresent,
}

/// Codecs the media plane may negotiate.
///
/// Lives here rather than in either plane: the control plane offers the set in
/// its capability exchange and the media plane negotiates from it, so putting
/// it in one of them would couple two planes that ADR-001 keeps independent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum MediaCodec {
    /// L0 only: shared memory or handle passing, no encode.
    RawShared,
    /// Bounded JPEG, as 1.x. Adequate for a confidence monitor.
    Jpeg,
    /// Low-latency hardware H.264, for the interactive stream at L1.
    H264,
    /// Where available and measured to help.
    Hevc,
}

/// First-class, named refusals. No silent substitution (invariant 18).
///
/// Every variant names the failing condition. A caller that receives one knows
/// what to fix; an agent that receives one learns the contract, which is the
/// whole argument of the automation plan in ADR Part D, M7.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "refusal", rename_all = "camelCase")]
pub enum Refusal {
    /// The take's revision does not match what is published.
    RevisionMismatch {
        expected: Revision,
        actual: Revision,
    },
    /// Device tier is below T0 and a live adapter was requested.
    TierTooLow { actual: DeviceTier },
    /// Reference is not locked and free-run was not explicitly accepted.
    ReferenceUnlocked { state: ReferenceState },
    /// A blend mode the renderer cannot reproduce exactly. Notably `overlay`,
    /// which aliased to `screen` in 1.x: a silent visual fallback, and an M1
    /// fix.
    UnsupportedBlendMode { mode: String },
    /// A fit mode the renderer cannot reproduce exactly.
    UnsupportedFitMode { mode: String },
    /// A declared asset's bytes have not arrived. A take blocker
    /// (invariant 29).
    AssetMissing { hash: ContentHash },
    /// Protocol version mismatch. Not negotiable.
    ProtocolMismatch { expected: u32, actual: u32 },
    /// A rate with a zero term.
    InvalidRate { num: u32, den: u32 },
    /// Requested on a platform that is not a certification target.
    PlatformNotCertified { platform: String },
    /// No published scene with this id. Distinct from a revision mismatch:
    /// one means "not that version", this means "not at all", and an operator
    /// needs to know which.
    UnknownTake { take_id: TakeId },
    /// A requested frame the engine cannot still honour: it has passed, or it
    /// falls inside the lead the engine needs to commit.
    ///
    /// An automation system asking for a frame that is already gone must be
    /// told so. Firing it late instead is the silent failure this refusal
    /// exists to prevent.
    FrameNotReachable { requested: u64, earliest: u64 },
    /// Two outputs on different references means two engine instances, not one
    /// (invariant 10). Configuring a second clock domain in one engine is
    /// refused rather than resolved by picking a winner.
    MultipleClockDomains {
        existing: ClockSource,
        requested: ClockSource,
    },
    /// The connection has not presented a valid credential.
    ///
    /// One variant rather than separate "no token" and "wrong token" cases:
    /// the distinction tells a caller nothing it can act on, and a server that
    /// answers them differently is answering questions it was not asked.
    Unauthenticated,
    /// The peer could not be reached, or answered nothing in time.
    ///
    /// Emitted by a *client*, never by an engine: it describes the transport
    /// rather than a decision. It is a refusal so that a caller handling
    /// refusals cannot accidentally not handle this.
    TransportFailed { detail: String },
    /// Named, so the gap register stays honest instead of stubbing a feature.
    NotImplemented { what: String },
}

impl std::fmt::Display for Refusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refusal::RevisionMismatch { expected, actual } => {
                write!(
                    f,
                    "revision mismatch: expected {}, got {}",
                    expected.0, actual.0
                )
            }
            Refusal::TierTooLow { actual } => write!(f, "device tier too low: {actual:?}"),
            Refusal::ReferenceUnlocked { state } => write!(f, "reference not locked: {state:?}"),
            Refusal::UnsupportedBlendMode { mode } => write!(f, "unsupported blend mode: {mode}"),
            Refusal::UnsupportedFitMode { mode } => write!(f, "unsupported fit mode: {mode}"),
            Refusal::AssetMissing { hash } => write!(f, "asset missing: {hash}"),
            Refusal::ProtocolMismatch { expected, actual } => {
                write!(f, "protocol mismatch: expected {expected}, got {actual}")
            }
            Refusal::InvalidRate { num, den } => write!(f, "invalid rate: {num}/{den}"),
            Refusal::PlatformNotCertified { platform } => {
                write!(f, "platform not a certification target: {platform}")
            }
            Refusal::UnknownTake { take_id } => write!(f, "unknown take: {take_id}"),
            Refusal::FrameNotReachable {
                requested,
                earliest,
            } => {
                write!(f, "frame {requested} not reachable: earliest is {earliest}")
            }
            Refusal::MultipleClockDomains {
                existing,
                requested,
            } => write!(
                f,
                "clock domain already {existing:?}, refused {requested:?}"
            ),
            Refusal::Unauthenticated => f.write_str("unauthenticated"),
            Refusal::TransportFailed { detail } => write!(f, "transport failed: {detail}"),
            Refusal::NotImplemented { what } => write!(f, "not implemented: {what}"),
        }
    }
}

impl std::error::Error for Refusal {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drop_frame_rates_are_exact() {
        // The reason this type exists: 30000/1001 is not 29.97.
        assert_eq!(RationalRate::P29_97.num, 30000);
        assert_eq!(RationalRate::P29_97.den, 1001);
        let as_float = f64::from(RationalRate::P29_97.num) / f64::from(RationalRate::P29_97.den);
        assert_ne!(as_float, 29.97);
    }

    #[test]
    fn zero_terms_are_refused_not_clamped() {
        assert!(matches!(
            RationalRate::new(30, 0),
            Err(Refusal::InvalidRate { .. })
        ));
        assert!(matches!(
            RationalRate::new(0, 1),
            Err(Refusal::InvalidRate { .. })
        ));
    }

    #[test]
    fn only_t0_is_live_capable() {
        assert!(DeviceTier::T0.live_capable());
        for tier in [DeviceTier::T1, DeviceTier::T2, DeviceTier::T3] {
            assert!(!tier.live_capable(), "{tier:?} must never be live capable");
        }
    }
}
