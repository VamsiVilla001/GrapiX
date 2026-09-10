//! What a valid control-plane peer does.
//!
//! The conformance suite (ADR-001 action 3) is written against these traits,
//! not against any implementation, so the same suite runs against a mock now
//! and against a real engine later. ADR-001 requires the suite to pass at L1
//! as it does at L0; that is only possible if it never reaches past the
//! protocol.

use crate::capability::EngineCapability;
use crate::message::{ClientRequest, EngineEvent, EngineReply};
use crate::status::EngineStatus;
use gx_contracts::ReferenceState;

/// A peer that answers control-plane requests.
///
/// Deliberately narrow: request in, reply out, plus a way to collect events.
/// Nothing here exposes a clock, because a client cannot be given one
/// (invariant 8) - a conformance test learns the engine's frame by asking for
/// status, exactly as a real client must.
pub trait EnginePeer {
    /// The capability exchange, including locality (ADR-001 action 2).
    fn capability(&self) -> EngineCapability;

    /// Handle one request. A refusal is a reply, not an error return: it
    /// travels the same path a success does.
    fn handle(&mut self, request: ClientRequest) -> EngineReply;

    /// Collect events emitted since the last drain.
    fn drain_events(&mut self) -> Vec<EngineEvent>;

    /// Convenience: current status via the protocol, as a client would.
    fn status(&mut self) -> Option<EngineStatus> {
        match self.handle(ClientRequest::Status) {
            EngineReply::Status(s) => Some(s),
            _ => None,
        }
    }
}

/// Optional: a peer that can be driven into specific states for testing.
///
/// A real engine cannot implement this - nothing can make a genlock generator
/// drop lock on request - so conformance tests that need it report **SKIP, not
/// PASS**, when it is absent (invariant 43). Reporting PASS would claim
/// coverage of exactly the failure paths that were never exercised.
pub trait FaultInjection {
    /// Advance the peer's frame counter by `frames`.
    fn advance(&mut self, frames: u64);

    /// Force the reference signal into a state.
    fn set_reference(&mut self, state: ReferenceState);
}
