//! The control-plane client.
//!
//! Implements `EnginePeer`, so conformance can exercise the real transport
//! without knowing whether the stream is TCP or local IPC.

use crate::Token;
use std::io::{self, Read, Write};
use std::net::SocketAddr;
use std::path::Path;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use gx_contracts::{Epoch, Refusal};
use gx_control_plane::bind::{connect_endpoint, ControlReadHalf, ControlWriteHalf, Endpoint};
use gx_control_plane::capability::EngineCapability;
use gx_control_plane::framing::{decode_body, decode_length, encode, LENGTH_PREFIX};
use gx_control_plane::message::{ClientRequest, EngineEvent, EngineReply, Envelope, MAIN_LAYER};
use gx_control_plane::peer::{EnginePeer, Handled};
use gx_control_plane::sequence::{MessageId, Sequence};
use gx_control_plane::status::ProgramState;

pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reconciliation {
    pub previous_epoch: Epoch,
    pub current_epoch: Epoch,
    pub program: Option<ProgramState>,
}
impl Reconciliation {
    pub fn engine_restarted(&self) -> bool {
        self.previous_epoch != self.current_epoch
    }
}

/// A connected control-plane client. The request writer and reader half share
/// one stream but are split before the exchange, so a blocked read can never
/// prevent the next acknowledged request from being written.
pub struct Client {
    endpoint: Endpoint,
    token: Option<Token>,
    writer: ControlWriteHalf,
    capability: EngineCapability,
    replies: Receiver<EngineReply>,
    events: Arc<Mutex<Vec<EngineEvent>>>,
    seq: Sequence,
    request_count: u64,
    /// The signed-in operator (2.15): sent with every Program command, and with nothing else.
    operator: Option<String>,
    /// Where on Program this client aims its commands (12.10); none is the main layer.
    target: Option<gx_control_plane::message::OutputTarget>,
}

impl Drop for Client {
    /// A client that goes away ends its connection. Its reader thread holds
    /// the other half of the same socket, so without this the connection
    /// stayed open, with a thread waiting at each end, until the process
    /// exited: the engine never saw (or logged, 2.12) the client leave.
    fn drop(&mut self) {
        self.writer.close();
    }
}

impl Client {
    /// Connect over TCP, retaining the established API.
    pub fn connect(addr: SocketAddr) -> io::Result<Self> {
        Self::connect_with(Endpoint::Tcp(addr), None)
    }
    pub fn connect_with_token(addr: SocketAddr, token: Token) -> io::Result<Self> {
        Self::connect_with(Endpoint::Tcp(addr), Some(token))
    }

    /// Connect over named-pipe IPC on Windows or a Unix-domain socket on Unix.
    pub fn connect_local(path: impl AsRef<Path>) -> io::Result<Self> {
        Self::connect_with(Endpoint::Local(path.as_ref().to_path_buf()), None)
    }
    pub fn connect_local_with_token(path: impl AsRef<Path>, token: Token) -> io::Result<Self> {
        Self::connect_with(Endpoint::Local(path.as_ref().to_path_buf()), Some(token))
    }
    pub fn connect_endpoint(endpoint: Endpoint) -> io::Result<Self> {
        Self::connect_with(endpoint, None)
    }

    /// Authenticate and stop: no capability exchange. For conformance, which
    /// must see how the transport answers each request for a credential that
    /// may not even read the capability (5.7). Products use
    /// [`Self::connect_with_token`].
    pub fn authenticate_only(addr: SocketAddr, token: Token) -> io::Result<Self> {
        Self::open(Endpoint::Tcp(addr), Some(token), false)
    }

    fn connect_with(endpoint: Endpoint, token: Option<Token>) -> io::Result<Self> {
        Self::open(endpoint, token, true)
    }

    fn open(endpoint: Endpoint, token: Option<Token>, exchange: bool) -> io::Result<Self> {
        let stream = connect_endpoint(&endpoint)?;
        stream.set_low_latency()?;
        let (reader, writer) = stream.split()?;
        let (tx, replies) = mpsc::channel();
        let events = Arc::new(Mutex::new(Vec::new()));
        {
            let events = Arc::clone(&events);
            thread::spawn(move || read_loop(reader, tx, events));
        }
        let mut client = Self {
            endpoint,
            token: token.clone(),
            writer,
            capability: placeholder_capability(),
            replies,
            events,
            seq: Sequence(0),
            request_count: 0,
            operator: None,
            target: None,
        };
        if let Some(token) = token {
            match client.request(ClientRequest::Authenticate {
                token: token.as_str().to_owned(),
            }) {
                Ok(EngineReply::Authenticated) => {}
                Ok(EngineReply::Refused(refusal)) => {
                    return Err(io::Error::new(kind_for(&refusal), refusal.to_string()))
                }
                Ok(other) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("expected an authentication reply, got {other:?}"),
                    ))
                }
                Err(refusal) => {
                    return Err(io::Error::new(kind_for(&refusal), refusal.to_string()))
                }
            }
        }
        if !exchange {
            return Ok(client);
        }
        match client.request(ClientRequest::capability()) {
            Ok(EngineReply::Capability(capability)) => {
                // 2.20: an engine that speaks another protocol is refused here, by
                // name, whatever it says about us. The engine's own check covers
                // the other direction.
                if capability.protocol != gx_contracts::PROTOCOL_VERSION {
                    let mismatch = Refusal::ProtocolMismatch {
                        expected: gx_contracts::PROTOCOL_VERSION,
                        actual: capability.protocol,
                    };
                    return Err(io::Error::new(kind_for(&mismatch), mismatch.to_string()));
                }
                client.capability = capability
            }
            Ok(EngineReply::Refused(refusal)) => {
                return Err(io::Error::new(kind_for(&refusal), refusal.to_string()))
            }
            Ok(other) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("expected a capability reply on connect, got {other:?}"),
                ))
            }
            Err(refusal) => return Err(io::Error::new(kind_for(&refusal), refusal.to_string())),
        }
        Ok(client)
    }

    /// Redial the same endpoint. A local retry remains local; falling back to
    /// loopback TCP would silently change the caller's security boundary.
    pub fn reconnect(&mut self) -> Result<Reconciliation, Refusal> {
        let previous_epoch = self.capability.epoch;
        let fresh =
            Self::connect_with(self.endpoint.clone(), self.token.clone()).map_err(|error| {
                Refusal::TransportFailed {
                    detail: error.to_string(),
                }
            })?;
        // The person is still signed in: a redial is the same operator on a new socket (2.15).
        let operator = self.operator.take();
        let target = self.target.take();
        *self = fresh;
        self.operator = operator;
        self.target = target;
        let program = match self.request(ClientRequest::Status)? {
            EngineReply::Status(status) => status.program,
            EngineReply::Refused(refusal) => return Err(refusal),
            other => {
                return Err(Refusal::TransportFailed {
                    detail: format!("expected status after reconnect, got {other:?}"),
                })
            }
        };
        Ok(Reconciliation {
            previous_epoch,
            current_epoch: self.capability.epoch,
            program,
        })
    }

    /// Who is operating this client (2.15). Every Program command sent from now on names them;
    /// `None` signs out, and the engine then refuses a Program command by name
    /// (`OperatorRequired`).
    pub fn set_operator(&mut self, operator: Option<&gx_contracts::auth::OperatorName>) {
        self.operator = operator.map(|name| name.as_str().to_owned());
    }

    /// The operator this client is sending Program commands for.
    pub fn operator(&self) -> Option<&str> {
        self.operator.as_deref()
    }

    /// Aim every targeted command (cue, take, clear, phase) from now on at `target`, a channel
    /// and a layer on it (12.10); `None` is the Program channel's main layer.
    pub fn set_target(&mut self, target: Option<gx_control_plane::message::OutputTarget>) {
        self.target = target;
    }

    /// For tests that must send a name the rules refuse, as a raw peer could.
    #[doc(hidden)]
    pub fn set_operator_unchecked_for_test(&mut self, operator: Option<String>) {
        self.operator = operator;
    }

    #[doc(hidden)]
    pub fn replace_token_for_test(&mut self, token: Token) {
        self.token = Some(token);
    }

    /// Send exactly one sequenced request and wait for its acknowledgement.
    pub fn request(&mut self, request: ClientRequest) -> Result<EngineReply, Refusal> {
        self.seq = self.seq.next();
        self.request_count += 1;
        let operator = operator_for(&request, self.operator.as_deref());
        let target = request.is_targeted().then(|| self.target.clone()).flatten();
        let envelope = Envelope::new(
            // 2.13: a request made inside a correlation scope carries its id.
            MessageId::request(self.request_count, gx_telemetry::corr::current().as_deref()),
            self.seq,
            request,
        )
        .with_operator(operator)
        .with_target(target);
        let frame = encode(&envelope).map_err(|error| Refusal::TransportFailed {
            detail: error.to_string(),
        })?;
        self.writer
            .write_all(&frame)
            .and_then(|()| self.writer.flush())
            .map_err(|error| Refusal::TransportFailed {
                detail: error.to_string(),
            })?;
        match self.replies.recv_timeout(REQUEST_TIMEOUT) {
            Ok(reply) => Ok(reply),
            Err(RecvTimeoutError::Timeout) => Err(Refusal::TransportFailed {
                detail: format!("no reply within {REQUEST_TIMEOUT:?}"),
            }),
            Err(RecvTimeoutError::Disconnected) => Err(Refusal::TransportFailed {
                detail: "connection closed by the engine".to_string(),
            }),
        }
    }
}

/// 2.15: only a Program command names the operator; a read, an authentication or a stop
/// carries none, so the name is on the wire exactly where it is judged and recorded.
fn operator_for(request: &ClientRequest, operator: Option<&str>) -> Option<String> {
    request
        .is_program_command()
        .then(|| operator.map(str::to_owned))
        .flatten()
}

impl EnginePeer for Client {
    fn capability(&self) -> EngineCapability {
        self.capability.clone()
    }
    fn handle(&mut self, request: ClientRequest) -> EngineReply {
        match self.request(request) {
            Ok(reply) => reply,
            Err(refusal) => EngineReply::Refused(refusal),
        }
    }
    /// Send one request aimed at `layer` of the Program channel (12.10), without changing the target this client keeps for the
    /// requests that follow. Layer zero is sent with no target at all, the form every receiver reads, so a main-layer command
    /// stays readable by a receiver older than numeric layers; any other layer travels as an explicit numeric target.
    fn handle_on_layer(&mut self, request: ClientRequest, layer: i32) -> Handled {
        let kept = self.target.take();
        self.target = (layer != MAIN_LAYER).then(|| gx_control_plane::message::OutputTarget::program(layer));
        let reply = self.handle(request);
        self.target = kept;
        Handled::Reply(reply)
    }
    fn drain_events(&mut self) -> Vec<EngineEvent> {
        let mut held = self.events.lock().expect("event mutex poisoned");
        std::mem::take(&mut *held)
    }
}

/// Read frames until connection close, routing replies by their `reply.` prefix
/// rather than enumerating kinds (invariant 34).
fn read_loop(
    mut stream: ControlReadHalf,
    replies: mpsc::Sender<EngineReply>,
    events: Arc<Mutex<Vec<EngineEvent>>>,
) {
    loop {
        let mut prefix = [0u8; LENGTH_PREFIX];
        if stream.read_exact(&mut prefix).is_err() {
            return;
        }
        let Ok(length) = decode_length(prefix) else {
            return;
        };
        let mut body = vec![0u8; length];
        if stream.read_exact(&mut body).is_err() {
            return;
        }
        let Ok(envelope) = decode_body::<Envelope<serde_json::Value>>(&body) else {
            return;
        };
        if envelope.id.is_reply() {
            match serde_json::from_value::<EngineReply>(envelope.payload) {
                Ok(reply) => {
                    if replies.send(reply).is_err() {
                        return;
                    }
                }
                Err(_) => return,
            }
        } else if let Ok(event) = serde_json::from_value::<EngineEvent>(envelope.payload) {
            events.lock().expect("event mutex poisoned").push(event);
        }
    }
}

fn kind_for(refusal: &Refusal) -> io::ErrorKind {
    match refusal {
        Refusal::Unauthenticated => io::ErrorKind::PermissionDenied,
        Refusal::TransportFailed { .. } => io::ErrorKind::ConnectionAborted,
        Refusal::ProtocolMismatch { .. } => io::ErrorKind::InvalidData,
        _ => io::ErrorKind::ConnectionRefused,
    }
}
fn placeholder_capability() -> EngineCapability {
    use gx_contracts::{ClockSource, DeviceTier, Locality, ReferenceState};
    EngineCapability {
        protocol: 0,
        epoch: Epoch(0),
        locality: Locality::CoLocated,
        device_tier: DeviceTier::T3,
        clock: ClockSource::FreeRun,
        reference: ReferenceState::NotPresent,
        live_allowed: false,
        media: Vec::new(),
        material: gx_contracts::material::MaterialSupport::none(),
    }
}

#[cfg(test)]
mod operator_tests {
    use gx_control_plane::intent::{ClearRequest, TakeAt};
    use gx_control_plane::message::ClientRequest;

    use super::operator_for;

    #[test]
    fn the_operator_rides_a_program_command_and_nothing_else() {
        let clear = ClientRequest::Clear(ClearRequest {
            at: TakeAt::NextOpportunity,
            expected: None,
        });
        assert_eq!(operator_for(&clear, Some("Ada")), Some("Ada".to_owned()));
        assert_eq!(operator_for(&clear, None), None);
        for request in [
            ClientRequest::Status,
            ClientRequest::Performance,
            ClientRequest::Stop,
            ClientRequest::capability(),
            ClientRequest::Authenticate { token: "x".into() },
        ] {
            assert_eq!(
                operator_for(&request, Some("Ada")),
                None,
                "{}",
                request.name()
            );
        }
    }
}
