//! protocol v3, the control plane.
//!
//! Small, ordered, acknowledged, sequenced. Zero loss tolerance.
//!
//! The rule that shapes this crate: it carries **intent, never time**
//! (invariant 8). There is no message meaning "now", and adding one would be
//! an architecture change rather than a feature, because it would move clock
//! authority off the render node and put network jitter into Program cadence.
//!
//! | Module | Concern |
//! |---|---|
//! | [`capability`] | Capability exchange, protocol and live gating, clock domain |
//! | [`intent`] | Cue, take and clear as intent; resolution to a committed frame |
//! | [`message`] | The message surface and its envelope |
//! | [`peer`] | What a valid peer does; the conformance target |
//! | [`sequence`] | Ordering, deduplication and reply identity |
//! | [`status`] | Reported engine state, reference lock, operator summary |

#![forbid(unsafe_code)]

pub mod capability;
pub mod intent;
pub mod message;
pub mod peer;
pub mod sequence;
pub mod status;

pub use capability::{check_clock_domain, check_protocol, live_allowed, EngineCapability};
pub use intent::{
    resolve_intent, ClearRequest, ClockState, CueRequest, Lead, TakeAt, TakeCommitted, TakeRequest,
};
pub use message::{ClientRequest, EngineEvent, EngineReply, Envelope, OutputConfig};
pub use peer::{EnginePeer, FaultInjection};
pub use sequence::{
    check_kind, Admission, KindConflict, MessageId, MessageKind, Sequence, SequenceTracker,
    REPLY_PREFIX,
};
pub use status::{
    clock_summary, ClockSummary, Degradation, EngineStatus, ProgramState, ReferenceMonitor,
    ReferenceTransition, Severity,
};
