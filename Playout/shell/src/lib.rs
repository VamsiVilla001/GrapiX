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

// PlayoutError carries the structured refusal it reports (see its doc).
#![allow(clippy::result_large_err)]
#![forbid(unsafe_code)]

use std::net::SocketAddr;
use std::sync::Mutex;

use gx_contracts::Refusal;
use gx_contracts::{ContentHash, Revision, TakeId};
use gx_control_plane::intent::{
    ClearRequest, CueRequest, PhaseCommitted, PhaseRequest, TakeAt, TakeCommitted, TakeRequest,
};
use gx_control_plane::message::{ClientRequest, EngineReply, OutputConfig};
use gx_control_plane::peer::EnginePeer;
use gx_control_plane::status::{clock_summary, ClockSummary, EngineStatus, PerformanceSummary};
use gx_control_transport::{Client, Token};
use serde::{Deserialize, Serialize};

/// The control-plane endpoint Playout connects to by default.
pub const DEFAULT_CONTROL_ENDPOINT: &str = gx_contracts::endpoints::DEFAULT_CONTROL_ENDPOINT;

/// Everything the Playout shell can fail at, named.
///
/// `Refused` is kept apart from the transport failures on purpose: an engine
/// that declined a take and an engine that could not be reached are different
/// problems, and an operator can only act differently on them if the answer
/// says which it was (invariant 17).
#[derive(Debug, Serialize)]
#[serde(tag = "error", rename_all = "camelCase")]
// Every command returns one of these to the operator UI, and a refusal carries
// its structured cause; the size is the point, so the large-Err lint is
// allowed on each command below rather than boxing the cause.
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
    let token_supplied = token.is_some();
    let result = connect_unlogged(state, endpoint, token);
    match &result {
        Ok(view) => tracing::info!(
            event = "operator.connect",
            epoch = view.status.epoch.0,
            frame = view.status.current_frame,
            result = "connected",
            endpoint,
            token_supplied,
            tier = ?view.status.device_tier,
            clock = ?view.status.clock,
            reference = ?view.status.reference,
        ),
        Err(error) => tracing::info!(
            event = "operator.connect",
            result = "failed",
            detail = %error,
            endpoint,
            token_supplied,
        ),
    }
    result
}

fn connect_unlogged(
    state: &Connection,
    endpoint: &str,
    token: Option<String>,
) -> Result<OperatorView, PlayoutError> {
    let address: SocketAddr = endpoint
        .parse()
        .map_err(|_| PlayoutError::InvalidEndpoint {
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

/// 2.12: one operator command and what came of it, at info. The take, its
/// revision and pinned hash, and when it was asked for; the frame the engine
/// committed, or the refusal code and the reason. Never the credential.
fn record(
    event: &'static str,
    take_id: Option<&TakeId>,
    revision: Option<Revision>,
    content_hash: Option<&ContentHash>,
    at: Option<&TakeAt>,
    outcome: Result<Option<u64>, &PlayoutError>,
) {
    let take_id = take_id.map(|t| t.0.as_str());
    let revision = revision.map(|r| r.0);
    let content_hash = content_hash.map(|h| h.0.as_str());
    let at = at.map(|at| format!("{at:?}"));
    match outcome {
        Ok(frame) => tracing::info!(
            event,
            frame,
            result = "committed",
            take_id,
            revision,
            content_hash,
            at = at.as_deref(),
        ),
        Err(error) => {
            let refusal = match error {
                PlayoutError::Refused { refusal, .. } => Some(refusal.code_name()),
                _ => None,
            };
            tracing::info!(
                event,
                result = if refusal.is_some() { "refused" } else { "failed" },
                refusal,
                detail = %error,
                take_id,
                revision,
                content_hash,
                at = at.as_deref(),
            );
        }
    }
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
    let result = with_client(state, read_status);
    // A poll: debug, so the default info log is not filled by the status bar.
    tracing::debug!(event = "operator.status", ok = result.is_ok());
    result
}

/// 2.27: the engine's live telemetry: the frame series and, per component, its
/// state and series, with the findings the engine decided (`telemetry::assess`).
/// A read, polled by the Help telemetry panel; it is debug-logged like status so
/// a panel left open does not fill the log.
pub fn performance(state: &Connection) -> Result<PerformanceSummary, PlayoutError> {
    let result = with_client(state, |client| {
        match client.handle(ClientRequest::Performance) {
            EngineReply::Performance(summary) => Ok(summary),
            EngineReply::Refused(refusal) => Err(PlayoutError::refused(refusal)),
            other => Err(PlayoutError::UnexpectedReply {
                detail: format!("expected performance, got {other:?}"),
            }),
        }
    });
    tracing::debug!(event = "operator.performance", ok = result.is_ok());
    result
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

/// Cue a published revision. Prepares without going to air. The content hash
/// is the operator's pin; a missing one is sent as missing and refused by the
/// engine by name (invariant 61).
pub fn cue(
    state: &Connection,
    take_id: TakeId,
    revision: Revision,
    content_hash: Option<ContentHash>,
    at: TakeAt,
) -> Result<TakeCommitted, PlayoutError> {
    let note = (take_id.clone(), content_hash.clone(), at);
    let result = with_client(state, |client| {
        committed(
            client.handle(ClientRequest::Cue(CueRequest {
                take_id,
                revision,
                content_hash,
                at,
            })),
            "a cue commitment",
        )
    });
    record(
        "operator.cue",
        Some(&note.0),
        Some(revision),
        note.1.as_ref(),
        Some(&note.2),
        result.as_ref().map(|c| Some(c.frame)),
    );
    result
}

/// Take a published revision to Program, pinned as `cue` is.
pub fn take(
    state: &Connection,
    take_id: TakeId,
    revision: Revision,
    content_hash: Option<ContentHash>,
    at: TakeAt,
) -> Result<TakeCommitted, PlayoutError> {
    let note = (take_id.clone(), content_hash.clone(), at);
    let result = with_client(state, |client| {
        committed(
            client.handle(ClientRequest::Take(TakeRequest {
                take_id,
                revision,
                content_hash,
                at,
            })),
            "a take commitment",
        )
    });
    record(
        "operator.take",
        Some(&note.0),
        Some(revision),
        note.1.as_ref(),
        Some(&note.2),
        result.as_ref().map(|c| Some(c.frame)),
    );
    result
}

/// Clear Program.
pub fn clear(state: &Connection, at: TakeAt) -> Result<TakeCommitted, PlayoutError> {
    let result = with_client(state, |client| {
        committed(
            client.handle(ClientRequest::Clear(ClearRequest { at })),
            "a clear commitment",
        )
    });
    record(
        "operator.clear",
        None,
        None,
        None,
        Some(&at),
        result.as_ref().map(|c| Some(c.frame)),
    );
    result
}
/// Enter one authored phase on the scene currently pinned to Program.
pub fn phase(
    state: &Connection,
    phase: String,
    at: TakeAt,
) -> Result<PhaseCommitted, PlayoutError> {
    let name = phase.clone();
    let result = with_client(state, |client| {
        match client.handle(ClientRequest::Phase(PhaseRequest { phase, at })) {
            EngineReply::PhaseCommitted(committed) => Ok(committed),
            EngineReply::Refused(refusal) => Err(PlayoutError::refused(refusal)),
            other => Err(PlayoutError::UnexpectedReply {
                detail: format!("expected a phase commitment, got {other:?}"),
            }),
        }
    });
    match &result {
        Ok(committed) => tracing::info!(
            event = "operator.phase",
            frame = committed.committed.frame,
            result = "committed",
            phase = name.as_str(),
            at = ?at,
        ),
        Err(error) => tracing::info!(
            event = "operator.phase",
            result = "refused",
            refusal = match error {
                PlayoutError::Refused { refusal, .. } => Some(refusal.code_name()),
                _ => None,
            },
            detail = %error,
            phase = name.as_str(),
            at = ?at,
        ),
    }
    result
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
    let requested = (adapter.clone(), live, accept_free_run);
    let result = with_client(state, |client| {
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
    });
    match &result {
        Ok(state) => tracing::info!(
            event = "operator.configure_output",
            result = "configured",
            adapter = state.adapter.as_str(),
            live = state.live,
            requested_live = requested.1,
            accept_free_run = requested.2,
        ),
        Err(error) => tracing::info!(
            event = "operator.configure_output",
            result = "refused",
            refusal = match error {
                PlayoutError::Refused { refusal, .. } => Some(refusal.code_name()),
                _ => None,
            },
            detail = %error,
            adapter = requested.0.as_str(),
            requested_live = requested.1,
            accept_free_run = requested.2,
        ),
    }
    result
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
fn cmd_performance(
    state: tauri::State<'_, Connection>,
) -> Result<PerformanceSummary, PlayoutError> {
    performance(&state)
}

#[tauri::command]
fn cmd_cue(
    state: tauri::State<'_, Connection>,
    take_id: String,
    revision: u64,
    content_hash: Option<String>,
    frame: Option<u64>,
) -> Result<TakeCommitted, PlayoutError> {
    cue(
        &state,
        TakeId(take_id),
        Revision(revision),
        content_hash.map(ContentHash),
        scheduled(frame),
    )
}

#[tauri::command]
fn cmd_take(
    state: tauri::State<'_, Connection>,
    take_id: String,
    revision: u64,
    content_hash: Option<String>,
    frame: Option<u64>,
) -> Result<TakeCommitted, PlayoutError> {
    take(
        &state,
        TakeId(take_id),
        Revision(revision),
        content_hash.map(ContentHash),
        scheduled(frame),
    )
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

/// 2.13: the front end's own record of what it did and what went wrong in it,
/// written to this shell's log. Only what `gx_telemetry::ui` accepts is written;
/// an entry of another kind, or with another field, is refused.
#[tauri::command]
fn cmd_log(entry: gx_telemetry::ui::UiEntry) -> Result<(), String> {
    gx_telemetry::ui::record(entry).map_err(|refusal| refusal.to_string())
}

/// Build and run the Playout window.
pub fn run() {
    // 2.12: Playout's log, from here until the window closes.
    let mut log = gx_telemetry::sink::init_process_logging("playout", "shell");
    tracing::info!(event = "playout.start", version = env!("CARGO_PKG_VERSION"));
    let built = gx_shell_log::with_diagnostics_menu(tauri::Builder::default(), "playout")
        .manage(Connection::default())
        // 2.13: each command runs inside the scope of its call's correlation id.
        .invoke_handler(gx_shell_log::scoped(tauri::generate_handler![
            cmd_log,
            cmd_connect,
            cmd_status,
            cmd_performance,
            cmd_cue,
            cmd_take,
            cmd_clear,
            cmd_phase,
            cmd_configure_output,
            cmd_default_endpoint,
        ]))
        .build(tauri::generate_context!());
    let app = match built {
        Ok(app) => app,
        Err(error) => {
            tracing::error!(event = "playout.failed", detail = %error);
            stopped(&mut log, "the shell failed to start");
            panic!("the Playout shell failed to start: {error}");
        }
    };
    app.run(move |_app, event| {
        if let tauri::RunEvent::Exit = event {
            stopped(&mut log, "the window closed");
        }
    });
}

/// Playout's last record, then its log written out (2.12). Called when the
/// window has closed: the event loop does not return to `run`, so nothing
/// after it would be reached.
fn stopped(log: &mut Option<gx_telemetry::sink::LogGuard>, reason: &str) {
    tracing::info!(event = "playout.stop", reason);
    if let Some(guard) = log.take() {
        let _ = guard.finish();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2.12: closing the window leaves `playout.stop` and then the sink's own
    /// `log.stop` as the file's last two records.
    #[test]
    fn closing_writes_a_stop_record_and_ends_the_log() {
        use tracing_subscriber::layer::SubscriberExt;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("gx-playout-stop-{}-{nanos}", std::process::id()));
        let guard =
            gx_telemetry::sink::start(gx_telemetry::sink::LogConfig::new("playout", "shell", &dir))
                .unwrap();
        let subscriber = tracing_subscriber::registry().with(guard.layer());
        let mut log = Some(guard);
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(event = "playout.start");
            stopped(&mut log, "the window closed");
        });
        assert!(log.is_none(), "the log is finished, not left to a drop");
        let mut events = Vec::new();
        for entry in std::fs::read_dir(dir.join("playout")).unwrap().flatten() {
            for line in std::fs::read_to_string(entry.path()).unwrap().lines() {
                let record: serde_json::Value = serde_json::from_str(line).unwrap();
                events.push((
                    record["event"].as_str().unwrap().to_owned(),
                    record["fields"]["reason"].as_str().map(str::to_owned),
                ));
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
        let last: Vec<_> = events.iter().rev().take(2).rev().cloned().collect();
        assert_eq!(
            last,
            vec![
                (
                    "playout.stop".to_owned(),
                    Some("the window closed".to_owned())
                ),
                ("log.stop".to_owned(), None),
            ],
            "{events:?}"
        );
    }

    // --- 2.12: the operator's commands are on record -------------------------

    fn logged(label: &str, body: impl FnOnce()) -> Vec<serde_json::Value> {
        use tracing_subscriber::layer::SubscriberExt;
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "gx-playout-log-{label}-{}-{nanos}",
            std::process::id()
        ));
        let guard =
            gx_telemetry::sink::start(gx_telemetry::sink::LogConfig::new("playout", "shell", &dir))
                .unwrap();
        let subscriber = tracing_subscriber::registry().with(guard.layer());
        tracing::subscriber::with_default(subscriber, body);
        guard.finish().unwrap();
        let mut records = Vec::new();
        for entry in std::fs::read_dir(dir.join("playout")).unwrap().flatten() {
            for line in std::fs::read_to_string(entry.path()).unwrap().lines() {
                records.push(serde_json::from_str(line).unwrap());
            }
        }
        let _ = std::fs::remove_dir_all(dir);
        records
    }

    fn event<'a>(
        records: &'a [serde_json::Value],
        name: &str,
        result: &str,
    ) -> &'a serde_json::Value {
        records
            .iter()
            .find(|r| r["event"] == name && r["fields"]["result"] == result)
            .unwrap_or_else(|| panic!("no {name} {result} in {records:#?}"))
    }

    #[test]
    fn a_command_before_connecting_and_a_bad_endpoint_are_on_record_without_the_token() {
        let records = logged("unconnected", || {
            let state = Connection::default();
            let _ = take(
                &state,
                TakeId("lower-third".into()),
                Revision(3),
                Some(ContentHash("b".repeat(64))),
                TakeAt::NextOpportunity,
            );
            let _ = connect(&state, "not an address", None);
            let _ = connect(&state, "127.0.0.1:1", Some("gx1.not-a-real-secret".into()));
        });
        let take = event(&records, "operator.take", "failed");
        assert_eq!(take["fields"]["take_id"], "lower-third");
        assert_eq!(take["fields"]["revision"], 3);
        assert_eq!(take["fields"]["content_hash"], "b".repeat(64));
        assert!(take["fields"]["detail"]
            .as_str()
            .unwrap()
            .contains("not connected"));
        let failed: Vec<_> = records
            .iter()
            .filter(|r| r["event"] == "operator.connect" && r["fields"]["result"] == "failed")
            .collect();
        assert_eq!(failed.len(), 2, "{records:#?}");
        assert_eq!(failed[1]["fields"]["token_supplied"], true);
        let text = records.iter().map(|r| r.to_string()).collect::<String>();
        assert!(
            !text.contains("not-a-real-secret"),
            "the token reached the log"
        );
    }

    #[test]
    fn a_take_committed_and_refused_through_a_real_transport_is_on_record() {
        let mut engine = gx_mock_engine::MockEngine::new();
        engine.publish(
            TakeId("scorebug".into()),
            Revision(2),
            ContentHash("c".repeat(64)),
        );
        let server =
            gx_control_transport::Server::bind("127.0.0.1:0".parse().unwrap(), None, engine)
                .unwrap();
        let address = server.local_addr().unwrap();
        std::thread::spawn(move || server.serve());
        let records = logged("committed", || {
            let state = Connection::default();
            connect(&state, &address.to_string(), None).expect("connected");
            take(
                &state,
                TakeId("scorebug".into()),
                Revision(2),
                Some(ContentHash("c".repeat(64))),
                TakeAt::NextOpportunity,
            )
            .expect("taken");
            let _ = take(
                &state,
                TakeId("scorebug".into()),
                Revision(9),
                Some(ContentHash("c".repeat(64))),
                TakeAt::NextOpportunity,
            );
            let _ = status(&state);
            clear(&state, TakeAt::NextOpportunity).expect("cleared");
        });
        let connected = event(&records, "operator.connect", "connected");
        assert!(connected["epoch"].as_u64().is_some(), "{connected}");
        assert_eq!(connected["fields"]["token_supplied"], false);
        let taken = event(&records, "operator.take", "committed");
        assert_eq!(taken["fields"]["take_id"], "scorebug");
        assert!(
            taken["frame"].as_u64().is_some(),
            "the committed frame: {taken}"
        );
        let refused = event(&records, "operator.take", "refused");
        assert_eq!(refused["fields"]["revision"], 9);
        assert!(refused["refusal"].as_str().is_some(), "{refused}");
        let cleared = event(&records, "operator.clear", "committed");
        assert!(cleared["frame"].as_u64().is_some());
        let poll = records
            .iter()
            .find(|r| r["event"] == "operator.status")
            .expect("the poll is recorded");
        assert_eq!(poll["level"], "debug");
    }

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
        let error = take(
            &state,
            TakeId("demo".into()),
            Revision(1),
            None,
            TakeAt::NextOpportunity,
        )
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
