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
use gx_control_plane::message::{ClientRequest, EngineEvent, EngineReply, Envelope};
use gx_control_plane::peer::EnginePeer;
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
        match client.request(ClientRequest::Capability) {
            Ok(EngineReply::Capability(capability)) => client.capability = capability,
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
        *self = fresh;
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

    #[doc(hidden)]
    pub fn replace_token_for_test(&mut self, token: Token) {
        self.token = Some(token);
    }

    /// Send exactly one sequenced request and wait for its acknowledgement.
    pub fn request(&mut self, request: ClientRequest) -> Result<EngineReply, Refusal> {
        self.seq = self.seq.next();
        self.request_count += 1;
        let envelope = Envelope::new(
            MessageId(format!("req.{}", self.request_count)),
            self.seq,
            request,
        );
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
