//! The control-plane message surface.
//!
//! Note what is absent: no message carries a timestamp, a wall-clock instant
//! or a "now". The timing plane is a cable, not a software transport
//! (ADR-001), and the render node is the sole clock authority (ADR-002). The
//! conformance suite asserts this absence over the serialised form, because a
//! reviewer will not notice a field being added and a test will.

use gx_contracts::auth::{Role, Scope};
use gx_contracts::{DeviceTier, Refusal};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::capability::EngineCapability;
use crate::intent::{
    ClearRequest, CueRequest, PhaseCommitted, PhaseRequest, TakeCommitted, TakeRequest,
};
use crate::render::{RenderRequest, RenderedFrame};
use crate::sequence::{MessageId, Sequence};
use crate::status::{EngineStatus, PerformanceSummary, ReferenceTransition};

// Keep the established import path; contracts owns the shape and its schema.
pub use gx_contracts::mcp::OutputConfig;

/// Everything a client may ask for. Playout may send all of these; the Editor
/// may send none of the Program-affecting ones (invariants 4 and 5), which is
/// enforced by the command surfaces each product exposes rather than by a flag
/// on the message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "request", rename_all = "camelCase")]
pub enum ClientRequest {
    /// Present an opaque gx1 credential. Its format and verification belong to
    /// the transport, which authenticates the connection before forwarding
    /// any request to the engine.
    Authenticate {
        token: String,
    },
    /// Capability exchange, including locality tier (ADR-001 action 2).
    Capability,
    Status,
    Cue(CueRequest),
    Take(TakeRequest),
    Clear(ClearRequest),
    /// Enter a named phase on the scene currently pinned to Program.
    Phase(PhaseRequest),
    ConfigureOutput(OutputConfig),
    /// Request a point-in-time performance snapshot for the graph page.
    Performance,
    /// Render a pinned revision at one of its frames to an image (11.41).
    /// Never touches Program, so it is not a Program-affecting request.
    Render(RenderRequest),
}

impl ClientRequest {
    /// The request's wire name: the `request` tag serde emits for it.
    pub const fn name(&self) -> &'static str {
        match self {
            Self::Authenticate { .. } => "authenticate",
            Self::Capability => "capability",
            Self::Status => "status",
            Self::Cue(_) => "cue",
            Self::Take(_) => "take",
            Self::Clear(_) => "clear",
            Self::Phase(_) => "phase",
            Self::ConfigureOutput(_) => "configureOutput",
            Self::Performance => "performance",
            Self::Render(_) => "render",
        }
    }

    /// The scope this request needs on the control port (5.7), beyond the
    /// Playout role every request but `Authenticate` needs. `None` is a read.
    ///
    /// One exhaustive match, so a new request cannot be added without a scope
    /// decision. `Phase` continues a stop point or plays a scene out: it
    /// changes Program, so it needs the authority a take does.
    pub const fn required_scope(&self) -> Option<Scope> {
        match self {
            Self::Authenticate { .. }
            | Self::Capability
            | Self::Status
            | Self::Performance
            | Self::Render(_) => None,
            Self::Cue(_) => Some(Scope::Cue),
            Self::Take(_) | Self::Phase(_) => Some(Scope::Take),
            Self::Clear(_) => Some(Scope::Clear),
            Self::ConfigureOutput(_) => Some(Scope::ConfigureOutput),
        }
    }

    /// Whether a connection holding `role` and `scopes` may send this request
    /// (5.7). The transport calls this before the engine sees the request.
    pub fn authorise(&self, role: Role, scopes: &[Scope]) -> Result<(), Refusal> {
        let required = self.required_scope();
        let granted = role == Role::Playout && required.is_none_or(|scope| scopes.contains(&scope));
        if granted {
            Ok(())
        } else {
            Err(Refusal::ScopeNotGranted {
                request: self.name().to_owned(),
                required,
                role,
            })
        }
    }
}

/// Everything the engine may answer. A refusal is a reply, not an exception:
/// it travels the same path and is as much a defined outcome as success.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
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
    /// The engine-resolved start of a named Program phase.
    PhaseCommitted(PhaseCommitted),
    OutputConfigured {
        adapter: String,
        live: bool,
    },
    /// Bounded performance snapshot: frame samples, totals, budget ratio.
    Performance(PerformanceSummary),
    /// A headless render's image, named by content hash (11.41).
    Rendered(RenderedFrame),
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
    use gx_contracts::{ContentHash, Revision, TakeId};

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
                token: "gx1.test.0000000000000000000000000000000000000000000000000000000000000000"
                    .into(),
            },
            ClientRequest::Capability,
            ClientRequest::Status,
            ClientRequest::Cue(CueRequest {
                take_id: TakeId("t".into()),
                revision: Revision(1),
                content_hash: Some(ContentHash("a".repeat(64))),
                at: TakeAt::NextOpportunity,
            }),
            ClientRequest::Take(TakeRequest {
                take_id: TakeId("t".into()),
                revision: Revision(1),
                content_hash: Some(ContentHash("a".repeat(64))),
                at: TakeAt::Frame { frame: 42 },
            }),
            ClientRequest::Clear(ClearRequest {
                at: TakeAt::NextOpportunity,
            }),
            ClientRequest::Phase(PhaseRequest {
                phase: "in".into(),
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
