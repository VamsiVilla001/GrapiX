//! Playout's Tauri 2 shell (build plan 11.1).
//!
//! **This file is where invariants 4 and 5 are enforced from the other
//! side.** Playout is the only client allowed to cue, take, clear Program or
//! configure outputs, and it owns no authoring content: the surface below has
//! no command that creates, edits or publishes a scene. The two shells are
//! deliberately disjoint, and neither enforces the split with a flag that
//! could be set wrongly.
//!
//! **ADR-002 is kept here by construction.** No command accepts a time. The
//! only scheduling a caller can express is [`TakeAt::NextOpportunity`] or a
//! frame number, and every reply carries the frame the *engine* committed to,
//! so the operator sees the engine's decision rather than their own request
//! (invariants 8 and 9).
//!
//! Severity is not computed here either. `clock_summary` decides once, on the
//! shared side, and the web layer maps that severity to a required prominence
//! (`Playout/src/clock-display.ts`). A second severity rule in this file is
//! exactly how free-run would come to be rendered quietly on one surface and
//! loudly on another (invariant 11).

#![forbid(unsafe_code)]

use std::net::SocketAddr;
use std::sync::Mutex;

use gx_contracts::Refusal;
use gx_contracts::{Revision, TakeId};
use gx_control_plane::intent::{
    ClearRequest, CueRequest, PhaseCommitted, PhaseRequest, TakeAt, TakeCommitted, TakeRequest,
};
use gx_control_plane::message::{ClientRequest, EngineReply, OutputConfig};
use gx_control_plane::peer::EnginePeer;
use gx_control_plane::status::{clock_summary, ClockSummary, EngineStatus};
use gx_control_transport::{Client, Token};
use serde::{Deserialize, Serialize};

/// The control-plane endpoint Playout connects to by default.
pub const DEFAULT_CONTROL_ENDPOINT: &str = "127.0.0.1:4400";

/// Everything the Playout shell can fail at, named.
///
/// `Refused` is kept apart from the transport failures on purpose: an engine
/// that declined a take and an engine that could not be reached are different
/// problems, and an operator can only act differently on them if the answer
/// says which it was (invariant 17).
#[derive(Debug, Serialize)]
#[serde(tag = "error", rename_all = "camelCase")]
pub enum PlayoutError {
    /// The endpoint text is not a socket address.
    InvalidEndpoint { endpoint: String },
    /// The supplied credential is not a well-formed token.
    InvalidToken { detail: String },
    /// No connection to the engine. Nothing was decided.
    Unreachable { endpoint: String, detail: String },
    /// Not connected yet. The web layer must connect before commanding.
    NotConnected,
    /// The engine answered, and its answer was a named refusal.
    Refused { refusal: Refusal, detail: String },
    /// A reply arrived that does not belong to the request that was sent.
    UnexpectedReply { detail: String },
}

impl std::fmt::Display for PlayoutError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidEndpoint { endpoint } => {
                write!(f, "{endpoint} is not a host:port address")
            }
            Self::InvalidToken { detail } => write!(f, "credential rejected: {detail}"),
            Self::Unreachable { endpoint, detail } => {
                write!(f, "cannot reach the engine at {endpoint}: {detail}")
            }
            Self::NotConnected => f.write_str("not connected to an engine"),
            Self::Refused { detail, .. } => write!(f, "engine refused: {detail}"),
            Self::UnexpectedReply { detail } => write!(f, "unexpected reply: {detail}"),
        }
    }
}

impl std::error::Error for PlayoutError {}

impl PlayoutError {
    fn refused(refusal: Refusal) -> Self {
        Self::Refused {
            detail: refusal.to_string(),
            refusal,
        }
    }
}

/// The live connection, or nothing.
///
/// Held in a `Mutex` because Tauri commands run on a thread pool and the
/// control plane is ordered: serialising requests here is what keeps the
/// sequence numbers the transport assigns monotonic per connection.
#[derive(Default)]
pub struct Connection(Mutex<Option<Client>>);

/// What the operator surface needs after every command.
///
/// Status and the derived clock summary travel together so the indicator can
/// never be a stale view of a fresh status — one round trip, one consistent
/// pair.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperatorView {
    pub status: EngineStatus,
    pub clock: ClockSummary,
}

impl OperatorView {
    fn of(status: EngineStatus) -> Self {
        Self {
            clock: clock_summary(&status),
            status,
        }
    }
}

/// Connect, and report what the engine says about itself immediately.
///
/// The first status is part of connecting rather than a second call: a
/// connected Playout that has not yet asked about the clock would be showing
/// an operator a blank reference indicator, which invariant 11 forbids.
pub fn connect(
    state: &Connection,
    endpoint: &str,
    token: Option<String>,
) -> Result<OperatorView, PlayoutError> {
    let address: SocketAddr = endpoint.parse().map_err(|_| PlayoutError::InvalidEndpoint {
        endpoint: endpoint.to_owned(),
    })?;
    let client = match token {
        Some(secret) => {
            let token = Token::parse(secret).map_err(|refusal| PlayoutError::InvalidToken {
                detail: refusal.to_string(),
            })?;
            Client::connect_with_token(address, token)
        }
        None => Client::connect(address),
    }
    .map_err(|error| PlayoutError::Unreachable {
        endpoint: endpoint.to_owned(),
        detail: error.to_string(),
    })?;

    let mut held = state.0.lock().expect("connection mutex poisoned");
    *held = Some(client);
    let client = held.as_mut().expect("just stored");
    read_status(client)
}

fn read_status(client: &mut Client) -> Result<OperatorView, PlayoutError> {
    match client.handle(ClientRequest::Status) {
        EngineReply::Status(status) => Ok(OperatorView::of(status)),
        EngineReply::Refused(refusal) => Err(PlayoutError::refused(refusal)),
        other => Err(PlayoutError::UnexpectedReply {
            detail: format!("expected status, got {other:?}"),
        }),
    }
}

fn with_client<T>(
    state: &Connection,
    action: impl FnOnce(&mut Client) -> Result<T, PlayoutError>,
) -> Result<T, PlayoutError> {
    let mut held = state.0.lock().expect("connection mutex poisoned");
    let client = held.as_mut().ok_or(PlayoutError::NotConnected)?;
    action(client)
}

/// Current status and the clock indicator derived from it.
pub fn status(state: &Connection) -> Result<OperatorView, PlayoutError> {
    with_client(state, read_status)
}

fn committed(reply: EngineReply, expected: &'static str) -> Result<TakeCommitted, PlayoutError> {
    match reply {
        EngineReply::Cued(c) | EngineReply::Taken(c) | EngineReply::Cleared(c) => Ok(c),
        EngineReply::Refused(refusal) => Err(PlayoutError::refused(refusal)),
        other => Err(PlayoutError::UnexpectedReply {
            detail: format!("expected {expected}, got {other:?}"),
        }),
    }
}

/// Cue a published revision. Prepares without going to air.
pub fn cue(
    state: &Connection,
    take_id: TakeId,
    revision: Revision,
    at: TakeAt,
) -> Result<TakeCommitted, PlayoutError> {
    with_client(state, |client| {
        committed(
            client.handle(ClientRequest::Cue(CueRequest {
                take_id,
                revision,
                at,
            })),
            "a cue commitment",
        )
    })
}

/// Take a published revision to Program.
pub fn take(
    state: &Connection,
    take_id: TakeId,
    revision: Revision,
    at: TakeAt,
) -> Result<TakeCommitted, PlayoutError> {
    with_client(state, |client| {
        committed(
            client.handle(ClientRequest::Take(TakeRequest {
                take_id,
                revision,
                at,
            })),
            "a take commitment",
        )
    })
}

/// Clear Program.
pub fn clear(state: &Connection, at: TakeAt) -> Result<TakeCommitted, PlayoutError> {
    with_client(state, |client| {
        committed(
            client.handle(ClientRequest::Clear(ClearRequest { at })),
            "a clear commitment",
        )
    })
}
/// Enter one authored phase on the scene currently pinned to Program.
pub fn phase(
    state: &Connection,
    phase: String,
    at: TakeAt,
) -> Result<PhaseCommitted, PlayoutError> {
    with_client(state, |client| {
        match client.handle(ClientRequest::Phase(PhaseRequest { phase, at })) {
            EngineReply::PhaseCommitted(committed) => Ok(committed),
            EngineReply::Refused(refusal) => Err(PlayoutError::refused(refusal)),
            other => Err(PlayoutError::UnexpectedReply {
                detail: format!("expected a phase commitment, got {other:?}"),
            }),
        }
    })
}


/// What an output configuration actually became.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputState {
    pub adapter: String,
    pub live: bool,
}

/// Configure an output.
///
/// `live` and `accept_free_run` are passed through untouched. Whether the
/// output may actually be live is the engine's decision under ADR-005, and it
/// refuses by name when the conditions are not met — this shell does not
/// pre-judge it, because a client that guessed would eventually guess
/// differently from the engine (invariant 20).
pub fn configure_output(
    state: &Connection,
    adapter: String,
    live: bool,
    accept_free_run: bool,
) -> Result<OutputState, PlayoutError> {
    with_client(state, |client| {
        match client.handle(ClientRequest::ConfigureOutput(OutputConfig {
            adapter,
            live,
            accept_free_run,
        })) {
            EngineReply::OutputConfigured { adapter, live } => Ok(OutputState { adapter, live }),
            EngineReply::Refused(refusal) => Err(PlayoutError::refused(refusal)),
            other => Err(PlayoutError::UnexpectedReply {
                detail: format!("expected an output configuration, got {other:?}"),
            }),
        }
    })
}

// ---------------------------------------------------------------------------
// The Tauri command surface.
//
// Every command Playout has. There is no way to author or publish from here.
// ---------------------------------------------------------------------------

#[tauri::command]
fn cmd_connect(
    state: tauri::State<'_, Connection>,
    endpoint: String,
    token: Option<String>,
) -> Result<OperatorView, PlayoutError> {
    connect(&state, &endpoint, token)
}

#[tauri::command]
fn cmd_status(state: tauri::State<'_, Connection>) -> Result<OperatorView, PlayoutError> {
    status(&state)
}

#[tauri::command]
fn cmd_cue(
    state: tauri::State<'_, Connection>,
    take_id: String,
    revision: u64,
    frame: Option<u64>,
) -> Result<TakeCommitted, PlayoutError> {
    cue(&state, TakeId(take_id), Revision(revision), scheduled(frame))
}

#[tauri::command]
fn cmd_take(
    state: tauri::State<'_, Connection>,
    take_id: String,
    revision: u64,
    frame: Option<u64>,
) -> Result<TakeCommitted, PlayoutError> {
    take(&state, TakeId(take_id), Revision(revision), scheduled(frame))
}

#[tauri::command]
fn cmd_clear(
    state: tauri::State<'_, Connection>,
    frame: Option<u64>,
) -> Result<TakeCommitted, PlayoutError> {
    clear(&state, scheduled(frame))
}
#[tauri::command]
fn cmd_phase(
    state: tauri::State<'_, Connection>,
    phase: String,
    frame: Option<u64>,
) -> Result<PhaseCommitted, PlayoutError> {
    self::phase(&state, phase, scheduled(frame))
}


#[tauri::command]
fn cmd_configure_output(
    state: tauri::State<'_, Connection>,
    adapter: String,
    live: bool,
    accept_free_run: bool,
) -> Result<OutputState, PlayoutError> {
    configure_output(&state, adapter, live, accept_free_run)
}

#[tauri::command]
fn cmd_default_endpoint() -> &'static str {
    DEFAULT_CONTROL_ENDPOINT
}

/// The only scheduling this shell can express.
///
/// An absent frame is `NextOpportunity`, never "now": there is no `Now` to
/// send, and this function is the single place the web layer's optional frame
/// becomes engine intent.
fn scheduled(frame: Option<u64>) -> TakeAt {
    match frame {
        Some(frame) => TakeAt::Frame { frame },
        None => TakeAt::NextOpportunity,
    }
}

/// Build and run the Playout window.
pub fn run() {
    tauri::Builder::default()
        .manage(Connection::default())
        .invoke_handler(tauri::generate_handler![
            cmd_connect,
            cmd_status,
            cmd_cue,
            cmd_take,
            cmd_clear,
            cmd_phase,
            cmd_configure_output,
            cmd_default_endpoint,
        ])
        .run(tauri::generate_context!())
        .expect("the Playout shell failed to start");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_absent_frame_is_next_opportunity_never_now() {
        assert_eq!(scheduled(None), TakeAt::NextOpportunity);
        assert_eq!(scheduled(Some(120)), TakeAt::Frame { frame: 120 });
    }

    #[test]
    fn commanding_before_connecting_is_refused_rather_than_queued() {
        let state = Connection::default();
        // A command with nowhere to go must say so. Silently queuing it would
        // mean an operator pressing take and getting no answer at all.
        let error = take(&state, TakeId("demo".into()), Revision(1), TakeAt::NextOpportunity)
            .expect_err("no connection means no take");
        assert!(matches!(error, PlayoutError::NotConnected));
    }

    #[test]
    fn an_unparseable_endpoint_is_refused_before_any_socket_opens() {
        let state = Connection::default();
        let error =
            connect(&state, "not-an-address", None).expect_err("a malformed endpoint cannot dial");
        assert!(matches!(error, PlayoutError::InvalidEndpoint { .. }));
    }
}
