//! The control-plane message surface.
//!
//! Note what is absent: no message carries a timestamp, a wall-clock instant
//! or a "now". The timing plane is a cable, not a software transport
//! (ADR-001), and the render node is the sole clock authority (ADR-002). The
//! conformance suite asserts this absence over the serialised form, because a
//! reviewer will not notice a field being added and a test will.

use gx_contracts::{DeviceTier, Refusal};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::auth::Token;
use crate::capability::EngineCapability;
use crate::intent::{ClearRequest, CueRequest, TakeCommitted, TakeRequest};
use crate::sequence::{MessageId, Sequence};
use crate::status::{EngineStatus, ReferenceTransition};

/// Output configuration. Live output is gated by ADR-005, evaluated in
/// `crate::capability::live_allowed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct OutputConfig {
    /// Adapter name. Never used to decide whether the output is live
    /// (invariant 20) - it names a device, nothing more.
    pub adapter: String,
    /// Whether this output is intended to reach an audience.
    pub live: bool,
    /// Set only when an operator has been told the reference is not locked.
    pub accept_free_run: bool,
}

/// Everything a client may ask for. Playout may send all of these; the Editor
/// may send none of the Program-affecting ones (invariants 4 and 5), which is
/// enforced by the command surfaces each product exposes rather than by a flag
/// on the message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "request", rename_all = "camelCase")]
pub enum ClientRequest {
    /// Present a credential. Required before anything else on a connection
    /// the engine has been configured to protect; harmless on one it has not.
    Authenticate {
        token: Token,
    },
    /// Capability exchange, including locality tier (ADR-001 action 2).
    Capability,
    Status,
    Cue(CueRequest),
    Take(TakeRequest),
    Clear(ClearRequest),
    ConfigureOutput(OutputConfig),
}

/// Everything the engine may answer. A refusal is a reply, not an exception:
/// it travels the same path and is as much a defined outcome as success.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "reply", rename_all = "camelCase")]
pub enum EngineReply {
    /// The credential was accepted. Carries nothing: there is no session to
    /// hand back, because the connection *is* the session.
    Authenticated,
    Capability(EngineCapability),
    Status(EngineStatus),
    /// The frame the engine committed the cue to.
    Cued(TakeCommitted),
    /// The frame the engine committed the take to.
    Taken(TakeCommitted),
    Cleared(TakeCommitted),
    OutputConfigured {
        adapter: String,
        live: bool,
    },
    Refused(Refusal),
}

/// Unsolicited engine events. Never share an id with a reply (invariant 33).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "event", rename_all = "camelCase")]
pub enum EngineEvent {
    ReferenceChanged(ReferenceTransition),
    DeviceTierChanged {
        from: DeviceTier,
        to: DeviceTier,
    },
    /// Program advanced past a committed frame. Observational: a client must
    /// not use this to derive time (invariant 8).
    Committed(TakeCommitted),
}

/// What travels on the control plane, with the identity and ordering the plane
/// guarantees.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Envelope<T> {
    pub id: MessageId,
    pub seq: Sequence,
    pub payload: T,
}

impl<T> Envelope<T> {
    pub fn new(id: MessageId, seq: Sequence, payload: T) -> Self {
        Self { id, seq, payload }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::intent::TakeAt;
    use gx_contracts::{Revision, TakeId};

    /// Field names the control plane must never contain. Checked over the
    /// serialised form of every request, because that is what a peer sees.
    const FORBIDDEN: &[&str] = &[
        "timestamp",
        "wallClock",
        "wall_clock",
        "now",
        "atTime",
        "at_time",
        "deadline",
        "millis",
        "nanos",
    ];

    fn every_request() -> Vec<ClientRequest> {
        vec![
            ClientRequest::Authenticate {
                token: Token("0123456789abcdef0123456789abcdef".into()),
            },
            ClientRequest::Capability,
            ClientRequest::Status,
            ClientRequest::Cue(CueRequest {
                take_id: TakeId("t".into()),
                revision: Revision(1),
                at: TakeAt::NextOpportunity,
            }),
            ClientRequest::Take(TakeRequest {
                take_id: TakeId("t".into()),
                revision: Revision(1),
                at: TakeAt::Frame { frame: 42 },
            }),
            ClientRequest::Clear(ClearRequest {
                at: TakeAt::NextOpportunity,
            }),
            ClientRequest::ConfigureOutput(OutputConfig {
                adapter: "null".into(),
                live: false,
                accept_free_run: false,
            }),
        ]
    }

    #[test]
    fn no_client_request_carries_a_time() {
        // Invariant 8, asserted structurally. If someone adds a timestamp to a
        // request, this fails and they have to read ADR-002 to justify it.
        for request in every_request() {
            let json = serde_json::to_string(&request).unwrap();
            for forbidden in FORBIDDEN {
                assert!(
                    !json.contains(forbidden),
                    "{request:?} carries {forbidden:?}: the control plane conveys intent, never time"
                );
            }
        }
    }

    #[test]
    fn an_envelope_round_trips() {
        let e = Envelope::new(
            MessageId("take.1".into()),
            Sequence(7),
            ClientRequest::Clear(ClearRequest {
                at: TakeAt::NextOpportunity,
            }),
        );
        let json = serde_json::to_string(&e).unwrap();
        let back: Envelope<ClientRequest> = serde_json::from_str(&json).unwrap();
        assert_eq!(e, back);
    }

    #[test]
    fn a_refusal_is_an_ordinary_reply() {
        let reply = EngineReply::Refused(Refusal::TierTooLow {
            actual: DeviceTier::T2,
        });
        let json = serde_json::to_string(&reply).unwrap();
        let back: EngineReply = serde_json::from_str(&json).unwrap();
        assert_eq!(reply, back);
        assert!(
            json.contains("refused"),
            "a refusal is tagged like any reply"
        );
    }
}
