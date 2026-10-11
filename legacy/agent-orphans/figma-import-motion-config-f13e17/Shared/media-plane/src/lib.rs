//! The media plane: Preview and Program confidence frames back to both UIs.
//!
//! High loss tolerance. **Drop, never queue** (invariant 13). No media path
//! may influence Program cadence (invariant 14).

#![forbid(unsafe_code)]

pub mod slot;
pub use slot::{DropCause, LatestFrameSlot};

use gx_contracts::{Locality, MediaCodec};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// What the consumer needs, which is not the same as what it is.
///
/// A designer dragging a handle and an operator watching a confidence monitor
/// have different requirements from the same pixels (ADR-004).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum ConsumerRole {
    /// Editor viewport. Latency dominates; resolution is negotiable.
    Interactive,
    /// Confidence monitor. Bounded and observational.
    Observational,
}

/// The negotiated shape of one media stream.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MediaProfile {
    pub codec: MediaCodec,
    /// Whether the stream may reduce resolution to hold latency.
    pub adaptive_resolution: bool,
}

/// Negotiate encoding from locality tier and consumer role (ADR-004).
///
/// One function, so the L0/L1 table in the ADR has exactly one implementation
/// and the relocation in M4 is a deployment change rather than a code change
/// (invariant 16).
pub fn negotiate(locality: Locality, role: ConsumerRole) -> MediaProfile {
    match (locality, role) {
        // Co-located and interactive: no encode at all.
        (Locality::CoLocated, ConsumerRole::Interactive) => MediaProfile {
            codec: MediaCodec::RawShared,
            adaptive_resolution: false,
        },
        // Co-located confidence monitor: JPEG, as 1.x. Nearly free.
        (Locality::CoLocated, ConsumerRole::Observational) => MediaProfile {
            codec: MediaCodec::Jpeg,
            adaptive_resolution: false,
        },
        // Over a LAN, an interactive stream degrades resolution before it
        // degrades latency (invariant 15).
        (Locality::Lan, ConsumerRole::Interactive) => MediaProfile {
            codec: MediaCodec::H264,
            adaptive_resolution: true,
        },
        // Over a LAN, a confidence monitor stays bounded and resolution-tiered.
        (Locality::Lan, ConsumerRole::Observational) => MediaProfile {
            codec: MediaCodec::Jpeg,
            adaptive_resolution: true,
        },
    }
}

/// Frames discarded because the consumer could not keep up, counted by cause.
///
/// Counted rather than buffered: a queue here would eventually push back on
/// the render clock, which invariant 14 forbids.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DropCounters {
    /// Consumer was still handling the previous frame.
    pub consumer_busy: u64,
    /// Encoder had no capacity.
    pub encoder_saturated: u64,
    /// Transport backpressure.
    pub transport_full: u64,
}

impl DropCounters {
    pub fn total(&self) -> u64 {
        self.consumer_busy + self.encoder_saturated + self.transport_full
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn co_located_interactive_does_not_encode() {
        let p = negotiate(Locality::CoLocated, ConsumerRole::Interactive);
        assert_eq!(p.codec, MediaCodec::RawShared);
    }

    #[test]
    fn lan_interactive_adapts_resolution() {
        let p = negotiate(Locality::Lan, ConsumerRole::Interactive);
        assert!(
            p.adaptive_resolution,
            "invariant 15: resolution gives way before latency does"
        );
    }

    #[test]
    fn every_combination_is_negotiable() {
        for locality in [Locality::CoLocated, Locality::Lan] {
            for role in [ConsumerRole::Interactive, ConsumerRole::Observational] {
                let _ = negotiate(locality, role);
            }
        }
    }

    #[test]
    fn drops_are_counted_by_cause() {
        let c = DropCounters {
            consumer_busy: 2,
            encoder_saturated: 3,
            transport_full: 5,
        };
        assert_eq!(c.total(), 10);
    }
}
